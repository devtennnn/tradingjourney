// @ts-nocheck
// Supabase Edge Function: bt-feed (admin research, ?key=<ai_bot_config.cron_secret>)
// Same AROM engine, same rules, same period, two data feeds: Twelve Data XAU/USD spot vs Binance PAXGUSDT (gold token).
// GET ?key=..&mode=scalp|intraday|swing&days=30&spread=0.4&src=both
// Returns statistics only (no candles). PAXG bars outside gold market hours are dropped so both feeds see the same sessions.
// R per trade (spread excluded first): SL -1 · TP1 only +rr1/2 · TP2+ (rr1+rr2)/2 · expired 0; then spread/risk is subtracted.
import AiEng from "./engine.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
const TF = { scalp: { bn: "1m", td: "1min", step: 60, site: 1 }, intraday: { bn: "15m", td: "15min", step: 900, site: 15 }, swing: { bn: "1h", td: "1h", step: 3600, site: 60 } };
const NY = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", hourCycle: "h23" });
const openHr = new Map();   // per UTC hour (formatToParts is slow; tens of thousands of candles)
const goldOpen = (t) => { const k = Math.floor(t / 3600); let v = openHr.get(k); if (v !== undefined) return v;
  const p = NY.formatToParts(new Date(k * 3600000)), wd = p.find((x) => x.type === "weekday").value, h = +p.find((x) => x.type === "hour").value;
  v = !(wd === "Sat" || (wd === "Fri" && h >= 17) || (wd === "Sun" && h < 18) || h === 17); openHr.set(k, v); return v; };   // same rule as /api/candles

const SYM = { XAUUSD: { td: "XAU/USD", bn: "PAXGUSDT", spread: 0.4, closes: true }, BTCUSD: { td: "BTC/USD", bn: "BTCUSDT", spread: 15, closes: false } };
async function binance(iv, from, to, bnSym = "PAXGUSDT") {
  const out = []; let end = to * 1000;
  for (let k = 0; k < 80 && end > from * 1000; k++) {
    const r = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${bnSym}&interval=${iv}&limit=1000&endTime=${end}`);
    const a = await r.json(); if (!Array.isArray(a) || !a.length) break;
    for (const x of a) out.push({ t: Math.floor(x[0] / 1000), o: +x[1], h: +x[2], l: +x[3], c: +x[4] });
    end = a[0][0] - 1;
  }
  const m = new Map(); for (const b of out) if (b.t >= from && b.t < to) m.set(b.t, b);
  return [...m.values()].sort((a, b) => a.t - b.t);
}
async function twelve(iv, from, to, key, tdSym = "XAU/USD") {
  const out = []; let end = null, calls = 0, err = null;
  for (let k = 0; k < 12; k++) {
    const u = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(tdSym)}&interval=${iv}&outputsize=5000&timezone=UTC&order=ASC${end ? "&end_date=" + encodeURIComponent(end) : ""}&apikey=${key}`;
    let j = await (await fetch(u)).json(); calls++;
    if (!Array.isArray(j.values) && /minute/i.test(j.message || "")) { await new Promise((r) => setTimeout(r, 62000)); j = await (await fetch(u)).json(); calls++; }   // per-minute credit limit: wait once
    if (!Array.isArray(j.values) || !j.values.length) { err = j.message || null; break; }
    const bars = j.values.map((v) => ({ t: Math.floor(Date.parse(v.datetime.replace(" ", "T") + "Z") / 1000), o: +v.open, h: +v.high, l: +v.low, c: +v.close }));
    out.push(...bars);
    if (bars[0].t <= from) break;
    end = new Date((bars[0].t - 60) * 1000).toISOString().slice(0, 19).replace("T", " ");
  }
  const m = new Map(); for (const b of out) if (b.t >= from && b.t < to) m.set(b.t, b);
  return { bars: [...m.values()].sort((a, b) => a.t - b.t), calls, err };
}
async function site(tf) {   // fallback without a Twelve Data key: what /api/candles keeps (M1 ~2000 bars)
  const j = await (await fetch(`https://aromx.trade/api/candles?symbol=XAUUSD&tf=${tf}`, { headers: { "User-Agent": "arom-bt" } })).json();
  return { bars: j.candles || [], src: j.source };
}
function run(bars, mode, spread, warm, sym = "XAUUSD", ovr = null) {
  if (ovr) { AiEng.MODES.__v = { ...AiEng.MODES[mode], ...ovr, key: "__v" }; mode = "__v"; }   // research knobs, e.g. {"xNeed":3}
  const M = AiEng.MODES[mode], P = AiEng.prep(bars, null, mode, sym), sig = AiEng.scan(P), rr = M.rr, rows = [];
  for (const s of sig) {
    if (s.t < warm) continue;
    const r = s.out.res; if (r === "open" || /\+$/.test(r)) continue;
    const hits = r === "sl" || r === "expired" ? 0 : +r.slice(2, 3);
    let R = r === "sl" ? -1 : r === "expired" ? 0 : hits >= 2 ? (rr[0] + rr[1]) / 2 : rr[0] / 2;
    R -= spread / s.risk;
    rows.push({ t: s.t, side: s.side, R, res: r, riskUsd: s.risk });
  }
  const n = rows.length, sum = rows.reduce((a, x) => a + x.R, 0), wins = rows.filter((x) => x.R > 0).length;
  const sd = n > 1 ? Math.sqrt(rows.reduce((a, x) => a + (x.R - sum / n) ** 2, 0) / (n - 1)) : 0;
  const half = (k) => { const h = rows.filter((_, i) => (k ? i >= n / 2 : i < n / 2)); const s2 = h.reduce((a, x) => a + x.R, 0); return { n: h.length, avg: h.length ? +(s2 / h.length).toFixed(3) : null }; };
  let peak = 0, cum = 0, dd = 0; for (const x of rows) { cum += x.R; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
  const cnt = (f) => rows.filter(f).length;
  return { bars: bars.length, signals: n, avgR: n ? +(sum / n).toFixed(3) : null, ci95: n > 1 ? [+(sum / n - 1.96 * sd / Math.sqrt(n)).toFixed(3), +(sum / n + 1.96 * sd / Math.sqrt(n)).toFixed(3)] : null,
    sumR: +sum.toFixed(2), winRate: n ? +(wins / n).toFixed(3) : null, maxDD: +dd.toFixed(2), halves: [half(0), half(1)],
    results: { sl: cnt((x) => x.res === "sl"), tp1: cnt((x) => x.res === "tp1"), tp2plus: cnt((x) => /^tp[23]$/.test(x.res)), expired: cnt((x) => x.res === "expired") },
    medianRiskUsd: n ? +rows.map((x) => x.riskUsd).sort((a, b) => a - b)[Math.floor(n / 2)].toFixed(2) : null, times: rows.map((x) => x.t) };
}
function feedQ(bars) { const q = AiEng.feedQuality(bars, 3000); return { openGap: q.gap, n: q.n }; }

Deno.serve(async (req) => {
  const u = new URL(req.url);
  const { data: k } = await db.from("ai_bot_config").select("value").eq("key", "cron_secret").maybeSingle();
  if (!k || u.searchParams.get("key") !== k.value) return json({ error: "unauthorized" }, 401);
  const mode = u.searchParams.get("mode") || "scalp", MM = AiEng.MODES[mode];   // any engine mode; its entry timeframe picks the feed interval
  const tf = MM && ({ 60: TF.scalp, 900: TF.intraday, 3600: TF.swing })[MM.base]; if (!tf) return json({ error: "mode" }, 400);
  const sym = SYM[(u.searchParams.get("sym") || "XAUUSD").toUpperCase()] ? (u.searchParams.get("sym") || "XAUUSD").toUpperCase() : "XAUUSD", S = SYM[sym];
  let ovr = null; try { ovr = u.searchParams.get("ovr") ? JSON.parse(u.searchParams.get("ovr")) : null; } catch (_) { return json({ error: "ovr is not JSON" }, 400); }
  const days = Math.min(+(u.searchParams.get("days") || 30), 400), spread = +(u.searchParams.get("spread") || S.spread);
  const tdKey = Deno.env.get("TWELVEDATA_API_KEY") || "";
  const to = Math.floor(Date.now() / 1000 / tf.step) * tf.step, from = to - days * 86400;
  try {
    let td, tdNote;
    if (tdKey) { const r = await twelve(tf.td, from, to, tdKey, S.td); td = r.bars; tdNote = { source: "Twelve Data API", calls: r.calls, error: r.err }; }
    else { const r = await site(tf.site); td = r.bars; tdNote = { source: "aromx.trade/api/candles (no TWELVEDATA_API_KEY in Supabase: short history)", feed: r.src }; }
    if (!td.length) return json({ error: "no Twelve Data bars", tdNote }, 502);
    // clean=1: drop Twelve Data candles while the gold market is closed (its XAU/USD feed keeps printing tiny weekend candles)
    const clean = u.searchParams.get("clean") === "1", tdRaw = td.length;
    if (clean && S.closes) td = td.filter((b) => goldOpen(b.t) && goldOpen(b.t + tf.step - 1));
    tdNote.clean = clean; tdNote.droppedClosed = tdRaw - td.length;
    const start = td[0].t, end = td[td.length - 1].t + tf.step;
    const pxAll = await binance(tf.bn, start, end, S.bn), px = S.closes ? pxAll.filter((b) => goldOpen(b.t) && goldOpen(b.t + tf.step - 1)) : pxAll;
    const warm = start + Math.min(3 * 86400, (end - start) * 0.1);   // both feeds start indicators at the same place; signals counted after warm-up
    // one feed per request keeps each run inside the Edge Function CPU limit: src=td | paxg (default td)
    const which = u.searchParams.get("src") === "paxg" ? "paxg" : "td";
    const R = run(which === "td" ? td : px, mode, spread, warm, sym, ovr);
    const times = R.times; delete R.times;
    // average gap between the two feeds' closes on matching candles (PAXG premium / discount to spot)
    const mp = new Map(px.map((b) => [b.t, b.c])); let g = 0, gn = 0; for (const b of td) { const c = mp.get(b.t); if (c) { g += (c - b.c) / b.c; gn++; } }
    return json({ mode, sym, ovr, days: +((end - start) / 86400).toFixed(1), from: new Date(start * 1000).toISOString(), to: new Date(end * 1000).toISOString(), spread, tdNote,
      src: which, result: { ...R, feed: feedQ(which === "td" ? td : px) }, signalTimes: times,
      paxgVsSpot: { premiumPct: gn ? +(100 * g / gn).toFixed(3) : null, matchedBars: gn, paxgBars: px.length, droppedClosedHours: pxAll.length - px.length } });
  } catch (e) { return json({ error: String(e.message || e) }, 500); }
});
