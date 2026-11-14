// @ts-nocheck
// Supabase Edge Function: ai-telegram
// Every minute (pg_cron) → runs the AROM A+ engine (Scalping v3 M1 · Intraday M15 · Swing H1) on the latest closed candles →
// posts new A+ signals to the Telegram channel and replies with TP / SL / expiry follow-ups.
// Secrets: TELEGRAM_BOT_TOKEN (Edge Function secret). Chat id + cron key live in public.ai_bot_config (service-role only).
import AiEng from "./engine.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { signalCard, resultCard, readyCard, itemsFromLines } from "./card.ts";

const SITE = "https://truetradejourney.vercel.app";
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const ict = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Phnom_Penh", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
const hm = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Phnom_Penh", hour: "2-digit", minute: "2-digit", hour12: false });
const DP = { XAGUSD: 3, EURUSD: 5, GBPUSD: 5, USDJPY: 3, NQ: 2, OIL: 2 };
const NAME = { BTCUSD: "Bitcoin", XAUUSD: "Gold", XAGUSD: "Silver", EURUSD: "Euro", GBPUSD: "Pound", USDJPY: "Yen", NQ: "Nasdaq 100", OIL: "WTI Oil" };
const fx = (v, sym) => Number(v).toFixed(DP[sym] ?? 2);
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const TRIG = { engulf: "Engulfing", pin: "Pin bar", momentum: "Momentum close" };
const PUSH = Deno.env.get("SUPABASE_URL") + "/functions/v1/push-send";
const plain = (h) => String(h).replace(/<[^>]+>/g, "");
async function push(cfg, m) { try { await fetch(`${PUSH}?key=${encodeURIComponent(cfg.cron_secret)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(m) }); } catch (_) { /* push is best-effort */ } }
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

async function config() {
  const { data, error } = await db.from("ai_bot_config").select("key,value");
  if (error) throw new Error("config: " + error.message);
  return Object.fromEntries((data || []).map((r) => [r.key, r.value]));
}
// ---- image cards: SVG (card.ts) -> PNG (resvg wasm + Inter fonts, fetched once per warm instance) -> Telegram sendPhoto ----
const RESVG = "2.6.2", INTER = "0.2.3";
const CDNS = [(p) => `https://cdn.jsdelivr.net/npm/${p}`, (p) => `https://unpkg.com/${p}`];
async function asset(path) {
  for (const mk of CDNS) { try { const r = await fetch(mk(path)); if (r.ok) return new Uint8Array(await r.arrayBuffer()); } catch (_) { /* try the next CDN */ } }
  throw new Error("asset unavailable: " + path);
}
let rendererP = null;
function loadRenderer() {
  return rendererP ??= (async () => {
    const { initWasm, Resvg } = await import("npm:@resvg/resvg-wasm@2.6.2");
    const [wasm, ...fonts] = await Promise.all([asset(`@resvg/resvg-wasm@${RESVG}/index_bg.wasm`),
      ...["400Regular", "500Medium", "600SemiBold", "700Bold", "800ExtraBold"].map((w) => asset(`@expo-google-fonts/inter@${INTER}/Inter_${w}.ttf`))]);
    await initWasm(wasm);
    return (svg) => new Resvg(svg, { font: { fontBuffers: fonts, defaultFontFamily: "Inter", loadSystemFonts: false }, fitTo: { mode: "width", value: 1080 } }).render().asPng();
  })().catch((e) => { rendererP = null; throw e; });
}
/** tg(text, replyTo, card?)  card = { svg, caption? }. With a card it posts a picture; if anything about the picture fails it posts the plain text instead, so an alert is never lost. */
function tgSender(token, chat, cardsOn = true) {
  const api = (m) => `https://api.telegram.org/bot${token}/${m}`;
  const reply = (replyTo) => (replyTo ? { message_id: Number(replyTo), allow_sending_without_reply: true } : null);
  const sendText = async (text, replyTo) => {
    const r = await fetch(api("sendMessage"), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true, ...(replyTo ? { reply_parameters: reply(replyTo) } : {}) }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error("telegram: " + (j.description || r.status));
    return j.result.message_id;
  };
  const send = async (text, replyTo, card) => {
    if (card && cardsOn) {
      try {
        const png = (await loadRenderer())(card.svg);
        let cap = card.caption ?? text, pm = "HTML";
        if (cap.length > 1000) { cap = plain(cap).slice(0, 990) + "…"; pm = ""; }
        const f = new FormData();
        f.set("chat_id", String(chat)); f.set("photo", new Blob([png], { type: "image/png" }), "alert.png"); f.set("caption", cap);
        if (pm) f.set("parse_mode", pm);
        if (replyTo) f.set("reply_parameters", JSON.stringify(reply(replyTo)));
        const r = await fetch(api("sendPhoto"), { method: "POST", body: f }), j = await r.json();
        if (!j.ok) throw new Error("telegram photo: " + (j.description || r.status));
        send.last = "photo"; return j.result.message_id;
      } catch (e) { console.error("card failed, sending text instead:", String((e && e.message) || e)); send.fail = String((e && e.message) || e); }
    }
    send.last = "text"; return sendText(text, replyTo);
  };
  return send;
}
async function candles(sym, M) {
  const r = await fetch(`${SITE}/api/candles?symbol=${sym}&tf=${M.base / 60}`, { headers: { "User-Agent": "arom-ai-telegram" } });
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
// Entry Timer checklist lines (same rules as Trade Finder → Time the trade on the website)
const MLABEL = { scalp: "SCALPING", intraday: "INTRADAY", swing: "SWING", sweep: "SWEEP (experimental)", btcx: "BTC SHADOW" };
const pl = (n, u) => n + " " + u + (n === 1 ? "" : "s");
const dur = (sec) => sec >= 86400 ? pl(Math.round(sec / 86400), "day") : sec >= 3600 ? pl(Math.round(sec / 3600), "hour") : Math.round(sec / 60) + " min";
function timerLines(ev, buy, s, M) {
  const c = Object.fromEntries(ev.checks.map((x) => [x.key, x]));
  const ok = (k) => (c[k] && c[k].pass ? "✅" : "▫️");
  if (M.sweep) return [
    `${ok("sweep")} Liquidity sweep of a recent M1 swing ${buy ? "low" : "high"}, closed back inside`,
    `${ok("risk")} Stop beyond the sweep extreme`,
    `${ok("news")} No high-impact news ±30 min`,
    `⚠️ Experimental: BTCUSD only, edge not yet proven. Risk small.`,
  ];
  return [
    `${ok("bias")} ${M.hName}${M.daily ? " + Daily" : ""} trend ${buy ? "up" : "down"}`,
    `${ok("align")} ${M.eName} EMA20/50 aligned`,
    M.v3 ? `${ok("pullback")} Pullback into a key level${c.pullback && c.pullback.val ? " (" + ({ SR: "S/R zone", trendline: "trendline", retest: "breakout retest" })[c.pullback.val] + ")" : ""}` : `${ok("pullback")} Pullback into EMA zone`,
    `${ok("trigger")} Trigger: ${esc(TRIG[s?.trigger] || (c.trigger && c.trigger.val) || "waiting")}`,
    `${ok("session")} ${M.v3 ? "Market open (all sessions)" : M.session ? "London / NY session" : "Weekday session"}`,
    `${ok("news")} No high-impact news ±30 min`,
    `${ok("risk")} Stop ${M.v3 ? "beyond the zone, " : "size "}${c.risk && c.risk.val != null ? c.risk.val + (M.v3 ? "× M5 ATR" : "× ATR") : "OK"}`,
    ...(M.v3 ? [`${ok("room")} Room to next zone ≥ 2R`, `🔗 Confluence: ${["sr", "tline", "retest"].filter((k) => c[k] && c[k].pass).map((k) => ({ sr: "S/R zone", tline: "trendline", retest: "breakout + retest" })[k]).join(" + ") || "—"}`] : []),
  ];
}
function signalText(sym, s, ev, src, M) {
  const buy = s.side === "BUY", n = ev.checks.filter((c) => c.pass).length, rr = M.rr;
  return [
    `${buy ? "🟢" : "🔴"} <b>${s.side} · ${sym}</b>  —  A+ ${MLABEL[M.key]} · Time the trade`,
    `<i>${esc(NAME[sym] || sym)} · ${M.hName}${M.daily ? "+D1" : ""} → ${M.eName} · ${n}/${ev.checks.length} checks</i>`, "",
    `⏱ <b>ENTRY TIMER — TRIGGERED</b>`,
    ...timerLines(ev, buy, s, M),
    `➡️ Enter now near <code>${fx(s.entry, sym)}</code>`,
    `⌛ Entry window open until <b>${hm.format(new Date(s.validUntil * 1000))}</b> ICT · skip if price already passed TP1`, "",
    `🎯 <b>EXIT PLANNER</b>`,
    `🛑 SL   <code>${fx(s.sl, sym)}</code>  (risk ${fx(s.risk, sym)})`,
    `1️⃣ TP1 <code>${fx(s.tp1, sym)}</code>  ${rr[0]}R → move SL to entry`,
    `2️⃣ TP2 <code>${fx(s.tp2, sym)}</code>  ${rr[1]}R${s.tp3 ? "" : " → final target"}`,
    ...(s.tp3 ? [`3️⃣ TP3 <code>${fx(s.tp3, sym)}</code>  ${rr[2]}R → runner`] : []),
    `⏳ Time stop: exit if no TP or SL within ${dur(M.maxBars * M.base)}`, "",
    `🕒 Signal ${ict.format(new Date(s.t * 1000))} ICT`,
    `<a href="${SITE}/analysis#wfPanel">AROM TRADE · Trade Finder</a>`,
    `<i>Data: ${esc(src)}. Algorithmic analysis, not financial advice. Risk only what you can afford to lose.</i>`,
  ].join("\n");
}
// "Get ready" heads-up: every core rule passes except the trigger candle
function readyText(sym, ev, last, M) {
  const buy = ev.side === "BUY";
  return [
    `⏳ <b>GET READY · ${sym} ${ev.side}</b>  <i>(${esc(NAME[sym] || sym)} · ${MLABEL[M.key]} ${M.eName})</i>`, "",
    `⏱ <b>ENTRY TIMER — WAITING FOR TRIGGER</b>`,
    ...timerLines(ev, buy, null, M),
    `Price <code>${fx(last.c, sym)}</code> is in the pullback zone. ${M.v3 ? "" : ""}Wait for a ${buy ? "bullish" : "bearish"} engulfing, pin bar or momentum close on ${M.eName}, then the A+ signal posts here.`,
    `<i>Not an entry yet, don't front-run the trigger.</i>`,
  ].join("\n");
}
// ---- card data (same facts as the text messages) ----
const SITE_SHORT = SITE.replace(/^https?:\/\//, "") + "/analysis";
const sideDot = (side) => (side === "BUY" ? "🟢" : "🔴");
function signalCardOf(sym, s, ev, src, M, test = false) {
  const buy = s.side === "BUY", n = ev.checks.filter((c) => c.pass).length;
  const caption = [`${sideDot(s.side)} <b>${s.side} · ${sym}</b> — A+ ${MLABEL[M.key]}${test ? "  <i>(sample card, not a signal)</i>" : ""}`,
    `Entry <code>${fx(s.entry, sym)}</code> · SL <code>${fx(s.sl, sym)}</code>`,
    `TP1 <code>${fx(s.tp1, sym)}</code> · TP2 <code>${fx(s.tp2, sym)}</code>${s.tp3 ? ` · TP3 <code>${fx(s.tp3, sym)}</code>` : ""}`,
    `⌛ Entry window until <b>${hm.format(new Date(s.validUntil * 1000))}</b> ICT`,
    `<a href="${SITE}/analysis#wfPanel">AROM TRADE · Trade Finder</a>`].join("\n");
  return { caption, svg: signalCard({ test, side: s.side, sym, name: NAME[sym] || sym, mode: MLABEL[M.key], hTf: M.hName + (M.daily ? "+D1" : ""), eTf: M.eName, n, total: ev.checks.length,
    entry: fx(s.entry, sym), sl: fx(s.sl, sym), risk: fx(s.risk, sym), tp1: fx(s.tp1, sym), tp2: fx(s.tp2, sym), tp3: s.tp3 ? fx(s.tp3, sym) : null, rr: M.rr,
    until: hm.format(new Date(s.validUntil * 1000)), items: itemsFromLines(timerLines(ev, buy, s, M)), at: ict.format(new Date(s.t * 1000)),
    timeStop: dur(M.maxBars * M.base), site: SITE_SHORT, disclaimer: `Data: ${src}. Algorithmic analysis, not financial advice. Risk only what you can afford to lose.` }) };
}
function readyCardOf(sym, ev, last, M) {
  const buy = ev.side === "BUY";
  return { caption: `⏳ <b>GET READY · ${sym} ${ev.side}</b> (${esc(NAME[sym] || sym)} · ${MLABEL[M.key]} ${M.eName})\nNot an entry yet, don't front-run the trigger.`,
    svg: readyCard({ side: ev.side, sym, name: NAME[sym] || sym, mode: MLABEL[M.key], eTf: M.eName, items: itemsFromLines(timerLines(ev, buy, null, M)), price: fx(last.c, sym),
      hint: `Wait for a ${buy ? "bullish" : "bearish"} engulfing, pin bar or momentum close on ${M.eName}, then the A+ signal posts here.`, at: ict.format(new Date()), site: SITE_SHORT }) };
}
/** follow-up card, chosen from the follow-up text (TP hit / SL / expired / closed) */
function updCardOf(x, sym, row, mk, M, hits) {
  const t = plain(x), rr = M.rr, d = { side: row.side, sym, name: NAME[sym] || sym, mode: MLABEL[mk], modeFull: "A+ " + MLABEL[mk], entry: fx(row.entry, sym), rr, hits, at: ict.format(new Date()), site: SITE_SHORT };
  const tp = /TP(\d) hit \(\+([\d.]+)R\)/.exec(t);
  if (tp) { const k = +tp[1], fin = /target complete/.test(t); Object.assign(d, { kind: fin ? "win" : "tp", title: `TP${k} HIT`, rText: `+${tp[2]}R`, hits: k, sub: k === 1 ? "Move your stop loss to entry" : fin ? "Target complete" : "Runner stays open" }); }
  else if (/^❌/.test(t)) Object.assign(d, { kind: "sl", title: "STOP LOSS", rText: "−1R", hits: 0, sub: "Trade closed at the stop" });
  else if (/^⏱/.test(t)) Object.assign(d, { kind: "expired", title: "EXPIRED", sub: t.replace(/^⏱\s*Expired\s*—\s*/, "").replace(/^./, (c) => c.toUpperCase()) });
  else Object.assign(d, { kind: "closed", title: "CLOSED", sub: `Price returned to the stop after TP${hits}` });
  return { svg: resultCard(d) };
}
function windowCardOf(sym, row, mk, M, until) {
  return { svg: resultCard({ side: row.side, sym, name: NAME[sym] || sym, mode: MLABEL[mk], modeFull: "A+ " + MLABEL[mk], entry: fx(row.entry, sym), kind: "window", title: "WINDOW CLOSED",
    sub: `Entry window ended ${until} ICT`, note: "In the trade? Keep the plan. Not in? Don't chase, wait for the next setup.", at: ict.format(new Date()), site: SITE_SHORT }) };
}
const UPD = (k, rr) => ({ 1: `✅ <b>TP1 hit</b> (+${rr[0]}R) — move SL to entry`, 2: rr.length < 3 ? `🏆 <b>TP2 hit</b> (+${rr[1]}R) — target complete` : `✅✅ <b>TP2 hit</b> (+${rr[1]}R)`, 3: `🏆 <b>TP3 hit</b> (+${rr[2]}R) — target complete` })[k];
const UPDATE = { 1: "✅ <b>TP1 hit</b> (+1R) — move SL to entry", 2: "✅✅ <b>TP2 hit</b> (+2R)", 3: "🏆 <b>TP3 hit</b> (+3R) — target complete" };

Deno.serve(async (req) => {
  const url = new URL(req.url);
  let cfg;
  try { cfg = await config(); } catch (e) { return json({ error: String(e.message || e) }, 500); }
  if (!cfg.cron_secret || url.searchParams.get("key") !== cfg.cron_secret) return json({ error: "unauthorized" }, 401);
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
  if (!token || !cfg.chat_id) return json({ error: "missing TELEGRAM_BOT_TOKEN secret or chat_id config" }, 500);
  const tg = tgSender(token, cfg.chat_id, cfg.cards !== "off");   // ai_bot_config cards = off → plain text only

  if (url.searchParams.get("test") === "card") {   // posts ONE clearly-labelled sample card so you can see the new design in the channel
    try {
      const sym = "BTCUSD", M = AiEng.MODES.scalp, t = Math.floor(Date.now() / 1000);
      const ev = { checks: [{ key: "bias", pass: true }, { key: "align", pass: true }, { key: "pullback", pass: true, val: "SR" }, { key: "trigger", pass: true, val: "engulf" }, { key: "session", pass: true }, { key: "news", pass: true }, { key: "risk", pass: true, val: 0.91 }, { key: "room", pass: true }, { key: "sr", pass: true }, { key: "retest", pass: true }] };
      const s = { side: "SELL", entry: 66461.46, sl: 66602.52, risk: 141.06, tp1: 66320.40, tp2: 66179.35, tp3: 0, t, validUntil: t + 600, trigger: "engulf" };
      const id = await tg("Sample card", null, signalCardOf(sym, s, ev, "sample data", M, true));
      return json({ ok: true, message_id: id, via: tg.last, error: tg.fail || null });
    } catch (e) { return json({ error: String(e.message || e) }, 500); }
  }
  if (url.searchParams.get("test")) {
    try {
      const id = await tg(`🤖 <b>AROM TRADE AI bot connected</b>\nA+ "Time the trade" signals for Gold, Bitcoin and Nasdaq 100 are posted here automatically in 3 strategies: SCALPING (M5→M1), INTRADAY (H1→M15) and SWING (H4+Daily→H1).\n<a href="${SITE}/analysis">Open AI Desk</a>\n<i>Algorithmic analysis, not financial advice.</i>`);
      return json({ ok: true, message_id: id });
    } catch (e) { return json({ error: String(e.message || e) }, 500); }
  }

  const symbols = String(cfg.symbols || "XAUUSD").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  // shadow modes (research, never posted) trade their own symbol list so they never widen what the public modes cover
  const shadowSyms = String(cfg.shadow_symbols || "BTCUSD").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const modes = String(cfg.modes || "scalp,intraday,swing").split(",").map((s) => s.trim()).filter((m) => AiEng.MODES[m]);
  const nowS = Math.floor(Date.now() / 1000), force = url.searchParams.get("all") === "1";
  // cron runs every minute: M1 scalping every run; M5+ modes on the old :01, :06, :11 … cadence, just after their entry candle closes
  const m5slot = (nowS % 300) >= 60 && (nowS % 300) < 120;
  const due = (M) => force || M.base <= 60 || (m5slot && (M.base <= 300 || (nowS % M.base) < 300));
  const news = await newsFn();
  const report = [];
  const { data: openAll } = await db.from("ai_signals").select("*").eq("status", "open");
  for (const sym of new Set([...symbols, ...shadowSyms])) for (const mk of modes) {
    const M = AiEng.MODES[mk];
    if (!(M.shadow ? shadowSyms : symbols).includes(sym)) continue;   // public modes: cfg.symbols · shadow modes: cfg.shadow_symbols
    if (M.only && !M.only.test(sym)) continue;      // e.g. the sweep mode is BTC only
    const open = (openAll || []).filter((r) => r.symbol === sym && (r.mode || "scalp") === mk);
    if (!due(M) && !open.length) continue;
    const out = { symbol: sym, mode: mk, posted: null, updates: [] };
    try {
      const data = await candles(sym, M), m = data.candles, P = AiEng.prep(m, null, mk, sym), n = m.length - 1;
      out.lastCandle = ict.format(new Date((m[n].t + M.base) * 1000));
      // 1) follow-ups on running signals
      for (const row of open) {
        const i = m.findIndex((b) => b.t + M.base === Number(row.t));
        if (i < 0) {
          if (nowS - row.t > M.maxBars * M.base + 86400) await db.from("ai_signals").update({ status: "closed", result: "unknown" }).eq("id", row.id);
          continue;
        }
        const sim = AiEng.simulate(m, i, { side: row.side, sl: +row.sl, tp1: +row.tp1, tp2: +row.tp2, tp3: +row.tp3 }, M.maxBars);
        const r = sim.res, hits = r === "open" || r === "sl" || r === "expired" ? 0 : +r.slice(2, 3);
        const closed = !(r === "open" || r.endsWith("+"));
        const msgs = [], tag = `${sym} ${row.side} @ ${fx(row.entry, sym)} · ${MLABEL[mk]}`;
        if (!M.shadow && !row.window_sent && nowS > Number(row.t) + M.valid && r === "open" && hits === 0) {
          try { await tg(`⌛ <b>Entry window closed</b> (${hm.format(new Date((Number(row.t) + M.valid) * 1000))} ICT)\nIn the trade? Keep the plan. Not in? Don't chase, wait for the next setup.\n${tag}`, row.tg_message_id, windowCardOf(sym, row, mk, M, hm.format(new Date((Number(row.t) + M.valid) * 1000)))); } catch (_) { /* keep going */ }
          await db.from("ai_signals").update({ window_sent: true }).eq("id", row.id);
        }
        for (let k = (row.hits || 0) + 1; k <= hits; k++) msgs.push(UPD(k, M.rr));
        if (closed && r === "sl") msgs.push("❌ <b>SL hit</b> (−1R)");
        else if (closed && r === "expired") msgs.push(`⏱ <b>Expired</b> — no TP or SL within ${dur(M.maxBars * M.base)}`);
        else if (closed && hits > 0 && hits < (Number(row.tp3) > 0 ? 3 : 2)) msgs.push(`⏹ <b>Closed</b> — price returned to the stop after TP${hits}`);
        for (const x of (M.shadow ? [] : msgs)) { try { await tg(`${x}\n${tag}`, row.tg_message_id, updCardOf(x, sym, row, mk, M, hits)); } catch (_) { /* keep going */ }
          await push(cfg, { update: true, key: `upd|${sym}|${mk}|${row.t}|${plain(x).slice(0, 24)}`, symbol: sym, mode: mk, title: `${sym} ${row.side} · ${plain(x).split(" — ")[0]}`, body: tag }); }
        if (msgs.length || closed) {
          // realized R (spread excluded): SL -1 · TP1 then stop at entry +0.5 · TP2 +1.5 (half off at TP1) · expired 0
          const rR = !closed ? null : r === "sl" ? -1 : r === "expired" || r === "unknown" ? 0 : hits >= 2 ? 1.5 : hits === 1 ? 0.5 : 0;
          await db.from("ai_signals").update({ hits, status: closed ? "closed" : "open", result: closed ? r : null, r_result: rR, updated_at: new Date().toISOString() }).eq("id", row.id);
          out.updates.push({ t: row.t, result: r });
        }
      }
      if (!due(M)) { report.push(out); continue; }
      // feed guard: always reported in the run output (feed). Set ai_bot_config feed_guard = on to ALSO stop posting NEW M1 signals when the candles look unreliable
      const q = M.base <= 60 ? AiEng.feedQuality(m) : null;
      out.feed = q;
      if (q && !q.ok && cfg.feed_guard === "on") { out.skipped = "feed quality (candle opens do not match previous closes)"; report.push(out); continue; }
      // 2) new A+ on the last two closed candles; unique (symbol, mode, t) prevents double posts
      for (const i of [n - 1, n]) {
        const ev = AiEng.evalAt(P, i, news);
        if (!ev.signal) continue;
        const s = ev.signal;
        if (nowS > s.validUntil) continue;
        const { data: ins, error: e2 } = await db.from("ai_signals").upsert(
          { symbol: sym, mode: mk, t: s.t, side: s.side, entry: s.entry, sl: s.sl, tp1: s.tp1, tp2: s.tp2, tp3: s.tp3, risk: s.risk, trigger: s.trigger, source: data.source, feat: s.feat || null },
          { onConflict: "symbol,mode,t", ignoreDuplicates: true }).select();
        if (e2) throw new Error(e2.message);
        if (!ins || !ins.length) continue;
        if (M.shadow) { out.shadow = { side: s.side, entry: s.entry, t: s.t }; continue; }   // shadow: logged to ai_signals only, never posted
        const mid = await tg(signalText(sym, s, ev, data.source, M), null, signalCardOf(sym, s, ev, data.source, M));
        await db.from("ai_signals").update({ tg_message_id: mid }).eq("id", ins[0].id);
        out.posted = { side: s.side, entry: s.entry, t: s.t, via: tg.last };
        await push(cfg, { key: `sig|${sym}|${mk}|${s.t}`, symbol: sym, mode: mk, title: `🟢 A+ ${s.side} · ${sym} · ${MLABEL[mk]}`.replace("🟢", s.side === "BUY" ? "🟢" : "🔴"),
          body: `Entry ${fx(s.entry, sym)} · SL ${fx(s.sl, sym)} · TP1 ${fx(s.tp1, sym)} · window until ${hm.format(new Date(s.validUntil * 1000))} ICT` });
      }
      const last = AiEng.evalAt(P, n, news);
      // 3) "Get ready" when every core rule passes except the trigger (once per symbol + mode per slot)
      if (!M.shadow && !last.signal && last.side && !out.posted) {
        const core = last.checks.filter((c) => c.core), miss = core.filter((c) => !c.pass);
        if (miss.length === 1 && miss[0].key === "trigger") {
          const slot = Math.floor(m[n].t / ({ scalp: 7200, intraday: 14400, swing: 43200 })[mk]);
          const { data: ins } = await db.from("ai_ready").upsert({ symbol: sym, mode: mk, slot, side: last.side }, { onConflict: "symbol,mode,slot", ignoreDuplicates: true }).select();
          if (ins && ins.length) { await tg(readyText(sym, last, m[n], M), null, readyCardOf(sym, last, m[n], M)); out.ready = true; }
        }
      }
      out.grade = last.grade; out.bias = last.side;
    } catch (e) { out.error = String(e.message || e); }
    report.push(out);
  }
  return json({ ok: true, at: new Date().toISOString(), report });
});
