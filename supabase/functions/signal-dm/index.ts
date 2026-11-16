// @ts-nocheck
// Supabase Edge Function: signal-dm  (deploy with verify_jwt = FALSE; called by a database trigger, protected by the cron key)
// Private copies of AI signals. Who gets them: members who connected Telegram (Profile → Telegram) AND have an ACTIVE Elite or Ultra plan (admins too).
// Free / Premium members and members whose plan has run out never receive signals. The plan is checked at send time.
//   POST ?key=<ai_bot_config.cron_secret>   body: { id, kind: "new" | "update", old_hits, old_status }   (sent by the trigger on public.ai_signals)
//   new    -> the signal message the channel just got is COPIED to each member (same picture, same caption: Telegram copyMessage)
//   update -> a short text for each follow-up (TP hit / SL / expired / closed), same wording as the channel
// ai_bot_config dm_signals = off switches it off. A member who blocked the bot is unlinked automatically.
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
const SITE = (Deno.env.get("SITE_URL") || "https://aromx.trade").replace(/\/$/, "");
const hm = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Phnom_Penh", hour: "2-digit", minute: "2-digit", hour12: false });
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const DP = { XAGUSD: 3, EURUSD: 5, GBPUSD: 5, USDJPY: 3, NQ: 2, OIL: 2 };
const fx = (v, sym) => Number(v).toFixed(DP[sym] ?? 2);
const NAME = { BTCUSD: "Bitcoin", XAUUSD: "Gold", XAGUSD: "Silver", EURUSD: "Euro", GBPUSD: "Pound", USDJPY: "Yen", NQ: "Nasdaq 100", OIL: "WTI Oil" };
const MLABEL = { scalp: "SCALPING", intraday: "INTRADAY", swing: "SWING", sweep: "SWEEP (experimental)", btcx: "BTC SHADOW" };
const MODE = { scalp: { rr: [1, 2], maxBars: 60, base: 60, valid: 600 }, intraday: { rr: [1.5, 3, 4.5], maxBars: 32, base: 900, valid: 3600 }, swing: { rr: [2, 4, 6], maxBars: 120, base: 3600, valid: 14400 }, m5: { rr: [1, 2, 3], maxBars: 48, base: 300, valid: 900 }, sweep: { rr: [1, 2], maxBars: 60, base: 60, valid: 300 } };
const pl = (n, u) => n + " " + u + (n === 1 ? "" : "s");
const dur = (sec) => sec >= 86400 ? pl(Math.round(sec / 86400), "day") : sec >= 3600 ? pl(Math.round(sec / 3600), "hour") : Math.round(sec / 60) + " min";
const UPD = (k, rr) => ({ 1: `✅ <b>TP1 hit</b> (+${rr[0]}R) — move SL to entry`, 2: rr.length < 3 ? `🏆 <b>TP2 hit</b> (+${rr[1]}R) — target complete` : `✅✅ <b>TP2 hit</b> (+${rr[1]}R)`, 3: `🏆 <b>TP3 hit</b> (+${rr[2]}R) — target complete` })[k];

async function members() {
  const { data: links, error } = await db.from("telegram_links").select("user_id,chat_id");
  if (error || !links || !links.length) return [];
  const ids = links.map((l) => l.user_id);
  let r = await db.from("profiles").select("id,is_admin,elite_until,ultra_until").in("id", ids);
  if (r.error) r = await db.from("profiles").select("id,is_admin,elite_until").in("id", ids);   // Ultra column not created yet
  const now = Date.now(), ok = new Set((r.data || []).filter((p) => p.is_admin === true || (p.elite_until && Date.parse(p.elite_until) > now) || (p.ultra_until && Date.parse(p.ultra_until) > now)).map((p) => p.id));
  return links.filter((l) => ok.has(l.user_id));
}
const post = async (token, method, body) => { const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return await r.json().catch(() => ({})); };
/** sends to every member, 20 at a time (Telegram allows ~30 a second); `fn(chat)` returns the Telegram answer. */
async function fan(chats, fn) {
  let sent = 0, failed = 0, removed = 0;
  const one = async (c) => {
    try {
      const j = await fn(c.chat_id);
      if (j.ok) { sent++; return; }
      failed++;
      if (j.error_code === 403 || /chat not found|bot was blocked|user is deactivated/i.test(j.description || "")) { await db.from("telegram_links").delete().eq("chat_id", c.chat_id); removed++; }
    } catch (_) { failed++; }
  };
  for (let i = 0; i < chats.length; i += 20) { await Promise.all(chats.slice(i, i + 20).map(one)); if (i + 20 < chats.length) await new Promise((res) => setTimeout(res, 1100)); }
  return { sent, failed, removed };
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const { data: cfgRows, error: ce } = await db.from("ai_bot_config").select("key,value");
  if (ce) return json({ error: ce.message }, 500);
  const c = Object.fromEntries((cfgRows || []).map((r) => [r.key, r.value]));
  if (!c.cron_secret || url.searchParams.get("key") !== c.cron_secret) return json({ error: "unauthorized" }, 401);
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
  if (!token || !c.chat_id) return json({ error: "missing TELEGRAM_BOT_TOKEN or chat_id" }, 500);
  if (String(c.dm_signals || "on").toLowerCase() === "off") return json({ ok: true, skipped: "dm_signals off" });

  let b = {}; try { b = await req.json(); } catch (_) { /* ignore */ }
  const id = String(b.id || ""), kind = b.kind === "update" ? "update" : "new";
  if (!id) return json({ error: "missing id" }, 400);
  const { data: row } = await db.from("ai_signals").select("*").eq("id", id).maybeSingle();
  if (!row) return json({ error: "signal not found" }, 404);
  if (!row.tg_message_id) return json({ ok: true, skipped: "never posted to the channel (shadow mode)" });
  const chats = await members();
  if (!chats.length) return json({ ok: true, eligible: 0, sent: 0 });
  const sym = row.symbol, mk = row.mode || "scalp", M = MODE[mk] || MODE.scalp;

  if (kind === "new") {
    const text = [`${row.side === "BUY" ? "🟢" : "🔴"} <b>${row.side} · ${sym}</b> — A+ ${MLABEL[mk] || mk}`, `Entry <code>${fx(row.entry, sym)}</code> · SL <code>${fx(row.sl, sym)}</code>`,
      `TP1 <code>${fx(row.tp1, sym)}</code> · TP2 <code>${fx(row.tp2, sym)}</code>${Number(row.tp3) > 0 ? ` · TP3 <code>${fx(row.tp3, sym)}</code>` : ""}`,
      `⌛ Entry window until <b>${hm.format(new Date((Number(row.t) + M.valid) * 1000))}</b> ICT`, `<a href="${SITE}/analysis#wfPanel">AROM TRADE · Trade Finder</a>`].join("\n");
    const res = await fan(chats, async (chat) => {
      const j = await post(token, "copyMessage", { chat_id: chat, from_chat_id: c.chat_id, message_id: Number(row.tg_message_id) });
      return j.ok || j.error_code === 403 ? j : await post(token, "sendMessage", { chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true });   // copy failed (e.g. message deleted): plain text instead
    });
    return json({ ok: true, kind, eligible: chats.length, ...res });
  }

  // follow-ups: rebuild the same messages the channel got from what changed in the row
  const tag = `${sym} ${row.side} @ ${fx(row.entry, sym)} · ${MLABEL[mk] || mk}`, msgs = [], hits = Number(row.hits || 0), oldHits = Number(b.old_hits || 0);
  for (let k = oldHits + 1; k <= hits; k++) { const m = UPD(k, M.rr); if (m) msgs.push(m); }
  if (row.status === "closed" && b.old_status !== "closed") {
    if (row.result === "sl") msgs.push("❌ <b>SL hit</b> (−1R)");
    else if (row.result === "expired") msgs.push(`⏱ <b>Expired</b> — no TP or SL within ${dur(M.maxBars * M.base)}`);
    else if (hits > 0 && hits < (Number(row.tp3) > 0 ? 3 : 2)) msgs.push(`⏹ <b>Closed</b> — price returned to the stop after TP${hits}`);
  }
  if (!msgs.length) return json({ ok: true, skipped: "nothing to tell" });
  let tot = { sent: 0, failed: 0, removed: 0 };
  for (const x of msgs) {
    const res = await fan(chats, (chat) => post(token, "sendMessage", { chat_id: chat, text: `${x}\n${tag}`, parse_mode: "HTML", disable_web_page_preview: true }));
    tot = { sent: tot.sent + res.sent, failed: tot.failed + res.failed, removed: tot.removed + res.removed };
  }
  return json({ ok: true, kind, messages: msgs.length, eligible: chats.length, ...tot });
});
