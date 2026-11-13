// @ts-nocheck
// Supabase Edge Function: ai-telegram
// Every 5 minutes (pg_cron) → runs the AROM A+ scalping engine on the latest closed M5 candle →
// posts new A+ signals to the Telegram channel and replies with TP / SL / expiry follow-ups.
// Secrets: TELEGRAM_BOT_TOKEN (Edge Function secret). Chat id + cron key live in public.ai_bot_config (service-role only).
import AiEng from "./engine.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SITE = "https://truetradejourney.vercel.app";
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const ict = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Phnom_Penh", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
const hm = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Phnom_Penh", hour: "2-digit", minute: "2-digit", hour12: false });
const fx = (v, sym) => Number(v).toFixed(sym === "XAGUSD" ? 3 : 2);
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const TRIG = { engulf: "Engulfing", pin: "Pin bar", momentum: "Momentum close" };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

async function config() {
  const { data, error } = await db.from("ai_bot_config").select("key,value");
  if (error) throw new Error("config: " + error.message);
  return Object.fromEntries((data || []).map((r) => [r.key, r.value]));
}
function tgSender(token, chat) {
  return async (text, replyTo) => {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true,
        ...(replyTo ? { reply_parameters: { message_id: Number(replyTo), allow_sending_without_reply: true } } : {}) }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error("telegram: " + (j.description || r.status));
    return j.result.message_id;
  };
}
async function candles(sym) {
  const r = await fetch(`${SITE}/api/candles?symbol=${sym}`, { headers: { "User-Agent": "arom-ai-telegram" } });
  const j = await r.json();
  if (!r.ok || !Array.isArray(j.candles)) throw new Error("candles: " + (j.error || r.status));
  return j;
}
async function newsFn() {
  try {
    const r = await fetch(`${SITE}/api/news?week=this`);
    if (!r.ok) return () => null;
    const ev = (await r.json()).filter((e) => String(e.impact) === "High").map((e) => Date.parse(e.date)).filter(isFinite);
    return (tSec) => !ev.some((ms) => Math.abs(ms - tSec * 1000) <= 30 * 60000);
  } catch (_) { return () => null; }
}
function signalText(sym, s, ev, src) {
  const buy = s.side === "BUY";
  return [
    `${buy ? "🟢" : "🔴"} <b>A+ ${s.side} · ${sym}</b>  <i>(M5 scalp)</i>`, "",
    `<b>Entry:</b> <code>${fx(s.entry, sym)}</code>`,
    `<b>SL:</b> <code>${fx(s.sl, sym)}</code>`,
    `<b>TP1:</b> <code>${fx(s.tp1, sym)}</code>  (1R)`,
    `<b>TP2:</b> <code>${fx(s.tp2, sym)}</code>  (2R)`,
    `<b>TP3:</b> <code>${fx(s.tp3, sym)}</code>  (3R)`, "",
    `Trigger: ${esc(TRIG[s.trigger] || s.trigger)} · Risk ${fx(s.risk, sym)}`,
    `M15 trend ${buy ? "up" : "down"} · checks ${ev.checks.filter((c) => c.pass).length}/11 ✅`,
    `🕒 ${ict.format(new Date(s.t * 1000))} ICT · valid until ${hm.format(new Date(s.validUntil * 1000))}`,
    `↪ Move SL to entry after TP1`, "",
    `<a href="${SITE}/analysis#aiPanel">AROM TRADE · AI Desk</a>`,
    `<i>Data: ${esc(src)}. Algorithmic analysis, not financial advice. Trade at your own risk.</i>`,
  ].join("\n");
}
const UPDATE = { 1: "✅ <b>TP1 hit</b> (+1R) — move SL to entry", 2: "✅✅ <b>TP2 hit</b> (+2R)", 3: "🏆 <b>TP3 hit</b> (+3R) — target complete" };

Deno.serve(async (req) => {
  const url = new URL(req.url);
  let cfg;
  try { cfg = await config(); } catch (e) { return json({ error: String(e.message || e) }, 500); }
  if (!cfg.cron_secret || url.searchParams.get("key") !== cfg.cron_secret) return json({ error: "unauthorized" }, 401);
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
  if (!token || !cfg.chat_id) return json({ error: "missing TELEGRAM_BOT_TOKEN secret or chat_id config" }, 500);
  const tg = tgSender(token, cfg.chat_id);

  if (url.searchParams.get("test")) {
    try {
      const id = await tg(`🤖 <b>AROM TRADE AI bot connected</b>\nA+ scalping signals (XAUUSD, M5) will be posted here automatically during London / New York hours.\n<a href="${SITE}/analysis">Open AI Desk</a>\n<i>Algorithmic analysis, not financial advice.</i>`);
      return json({ ok: true, message_id: id });
    } catch (e) { return json({ error: String(e.message || e) }, 500); }
  }

  const symbols = String(cfg.symbols || "XAUUSD").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const news = await newsFn();
  const report = [];
  for (const sym of symbols) {
    const out = { symbol: sym, posted: null, updates: [] };
    try {
      const data = await candles(sym), m5 = data.candles, P = AiEng.prep(m5), n = m5.length - 1;
      out.lastCandle = ict.format(new Date((m5[n].t + 300) * 1000));
      // 1) follow-ups on running signals
      const { data: open, error: e1 } = await db.from("ai_signals").select("*").eq("symbol", sym).eq("status", "open").order("t");
      if (e1) throw new Error(e1.message);
      for (const row of open || []) {
        const i = m5.findIndex((b) => b.t + 300 === Number(row.t));
        if (i < 0) {
          if (Date.now() / 1000 - row.t > 86400) await db.from("ai_signals").update({ status: "closed", result: "unknown" }).eq("id", row.id);
          continue;
        }
        const sim = AiEng.simulate(m5, i, { side: row.side, sl: +row.sl, tp1: +row.tp1, tp2: +row.tp2, tp3: +row.tp3 });
        const r = sim.res, hits = r === "open" || r === "sl" || r === "expired" ? 0 : +r.slice(2, 3);
        const closed = !(r === "open" || r.endsWith("+"));
        const msgs = [];
        for (let k = (row.hits || 0) + 1; k <= hits; k++) msgs.push(UPDATE[k]);
        if (closed && r === "sl") msgs.push("❌ <b>SL hit</b> (−1R)");
        else if (closed && r === "expired") msgs.push("⏱ <b>Expired</b> — no TP or SL within 4 hours");
        else if (closed && hits > 0 && hits < 3) msgs.push(`⏹ <b>Closed</b> — price returned to the stop after TP${hits}`);
        for (const m of msgs) { try { await tg(`${m}\n${sym} ${row.side} @ ${fx(row.entry, sym)}`, row.tg_message_id); } catch (_) { /* keep going */ } }
        if (msgs.length || closed) {
          await db.from("ai_signals").update({ hits, status: closed ? "closed" : "open", result: closed ? r : null, updated_at: new Date().toISOString() }).eq("id", row.id);
          out.updates.push({ t: row.t, result: r });
        }
      }
      // 2) new A+ on the last two closed candles; unique (symbol,t) prevents double posts
      for (const i of [n - 1, n]) {
        const ev = AiEng.evalAt(P, i, news);
        if (!ev.signal) continue;
        const s = ev.signal;
        if (Date.now() / 1000 > s.validUntil) continue;
        const { data: ins, error: e2 } = await db.from("ai_signals").upsert(
          { symbol: sym, t: s.t, side: s.side, entry: s.entry, sl: s.sl, tp1: s.tp1, tp2: s.tp2, tp3: s.tp3, risk: s.risk, trigger: s.trigger, source: data.source },
          { onConflict: "symbol,t", ignoreDuplicates: true }).select();
        if (e2) throw new Error(e2.message);
        if (!ins || !ins.length) continue;
        const mid = await tg(signalText(sym, s, ev, data.source));
        await db.from("ai_signals").update({ tg_message_id: mid }).eq("id", ins[0].id);
        out.posted = { side: s.side, entry: s.entry, t: s.t };
      }
      const last = AiEng.evalAt(P, n, news);
      out.grade = last.grade; out.bias = last.side;
      out.checks = last.checks.map((c) => c.key + (c.pass ? "✓" : "✗")).join(" ");
    } catch (e) { out.error = String(e.message || e); }
    report.push(out);
  }
  return json({ ok: true, at: new Date().toISOString(), report });
});
