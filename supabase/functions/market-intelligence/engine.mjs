// AROM Market Intelligence engine: deterministic calculations on VALIDATED candles. No OpenAI, no network, no randomness.
// Input candles: oldest first, { timestamp (ISO), open, high, low, close, volume|null, complete }. Only COMPLETE candles are used (no repainting).
// Everything that cannot be computed is null with a reason; missing data is never turned into a bullish or bearish conclusion.
// Levels / liquidity are CALCULATED from swing highs and lows. They are not order-flow observations and are labelled that way.
export const CONFIG = { version: "1.0", ema: [9, 20, 50, 100, 200], rsi: 14, macd: [12, 26, 9], atr: 14, swingK: 3, zoneTolAtr: 0.5, equalTolAtr: 0.1, sweepLookback: 20, minCandles: 210, minForBias: 60 };
const TFSEC = { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400 };
const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const r6 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e6) / 1e6);
const sgn = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);

// ---------------- indicators (aligned arrays, null until enough history) ----------------
export function ema(v, n) {
  const out = Array(v.length).fill(null); if (v.length < n) return out;
  let e = avg(v.slice(0, n)); out[n - 1] = e; const k = 2 / (n + 1);
  for (let i = n; i < v.length; i++) { e = v[i] * k + e * (1 - k); out[i] = e; }
  return out;
}
export function rsi(c, n = 14) {
  const out = Array(c.length).fill(null); if (c.length <= n) return out;
  let g = 0, l = 0; for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; if (d >= 0) g += d; else l -= d; }
  g /= n; l /= n; out[n] = l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l);
  for (let i = n + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; out[i] = l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l); }
  return out;
}
export function atr(cs, n = 14) {
  const out = Array(cs.length).fill(null); if (cs.length < n) return out;
  const tr = cs.map((b, i) => (i === 0 ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - cs[i - 1].close), Math.abs(b.low - cs[i - 1].close))));
  let a = avg(tr.slice(0, n)); out[n - 1] = a; for (let i = n; i < cs.length; i++) { a = (a * (n - 1) + tr[i]) / n; out[i] = a; }
  return out;
}
export function macd(c, f = 12, s = 26, sig = 9) {
  const ef = ema(c, f), es = ema(c, s), line = c.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
  const first = line.findIndex((x) => x != null), signal = Array(c.length).fill(null), hist = Array(c.length).fill(null);
  if (first >= 0) { const sg = ema(line.slice(first), sig); sg.forEach((x, j) => { if (x != null) { signal[first + j] = x; hist[first + j] = line[first + j] - x; } }); }
  return { line, signal, hist };
}
/** day-anchored VWAP (UTC day of the last candle) from typical price; only when EVERY candle that day has real volume */
export function vwapOfDay(cs) {
  if (!cs.length) return { value: null, reason: "no_candles" };
  const day = cs[cs.length - 1].timestamp.slice(0, 10), d = cs.filter((b) => b.timestamp.slice(0, 10) === day);
  if (d.length < 2) return { value: null, reason: "fewer_than_2_candles_today" };
  if (!d.every((b) => b.volume != null && b.volume > 0)) return { value: null, reason: "no_real_volume" };
  let pv = 0, v = 0; for (const b of d) { pv += ((b.high + b.low + b.close) / 3) * b.volume; v += b.volume; }
  return { value: r6(pv / v), reason: null, candles: d.length };
}

// ---------------- swings, structure, levels ----------------
/** fractal pivots, confirmed only: a pivot needs k candles after it, so none is reported in the last k candles (no look-ahead) */
export function pivots(cs, k = CONFIG.swingK) {
  const hs = [], ls = [];
  for (let i = k; i < cs.length - k; i++) {
    let hi = true, lo = true;
    for (let j = 1; j <= k; j++) { if (!(cs[i].high > cs[i - j].high && cs[i].high >= cs[i + j].high)) hi = false; if (!(cs[i].low < cs[i - j].low && cs[i].low <= cs[i + j].low)) lo = false; }
    if (hi) hs.push({ i, p: cs[i].high, t: cs[i].timestamp }); if (lo) ls.push({ i, p: cs[i].low, t: cs[i].timestamp });
  }
  return { hs, ls };
}
/** BOS (break in the trend direction) and CHoCH (first break against the trend), by CLOSE beyond the latest confirmed swing */
export function structure(cs, k = CONFIG.swingK) {
  const { hs, ls } = pivots(cs, k); let trend = 0, ah = null, al = null; const events = [];
  const byConfirm = new Map(); for (const p of hs) (byConfirm.get(p.i + k) || byConfirm.set(p.i + k, []).get(p.i + k)).push({ ...p, side: "h" }); for (const p of ls) (byConfirm.get(p.i + k) || byConfirm.set(p.i + k, []).get(p.i + k)).push({ ...p, side: "l" });
  for (let i = 0; i < cs.length; i++) {
    for (const p of byConfirm.get(i) || []) { if (p.side === "h") ah = p; else al = p; }
    if (ah && cs[i].close > ah.p) { events.push({ i, t: cs[i].timestamp, dir: 1, type: trend === -1 ? "CHoCH" : "BOS", level: ah.p }); trend = 1; ah = null; }
    else if (al && cs[i].close < al.p) { events.push({ i, t: cs[i].timestamp, dir: -1, type: trend === 1 ? "CHoCH" : "BOS", level: al.p }); trend = -1; al = null; }
  }
  const h2 = hs.slice(-2), l2 = ls.slice(-2), labels = [];
  if (h2.length === 2) labels.push(h2[1].p > h2[0].p ? "HH" : h2[1].p < h2[0].p ? "LH" : "EQH");
  if (l2.length === 2) labels.push(l2[1].p > l2[0].p ? "HL" : l2[1].p < l2[0].p ? "LL" : "EQL");
  const swingTrend = h2.length === 2 && l2.length === 2 ? (h2[1].p > h2[0].p && l2[1].p > l2[0].p ? 1 : h2[1].p < h2[0].p && l2[1].p < l2[0].p ? -1 : 0) : null;
  return { trend, swing_trend: swingTrend, labels, last_break: events.length ? events[events.length - 1] : null, last_swing_high: hs.length ? hs[hs.length - 1] : null, last_swing_low: ls.length ? ls[ls.length - 1] : null, pivots: { hs, ls } };
}
/** clusters of swing highs/lows within `tol` of each other become zones; touches = number of swings in the zone */
export function zones(cs, pv, tol, price) {
  const pts = [...pv.hs.map((p) => ({ ...p, kind: "h" })), ...pv.ls.map((p) => ({ ...p, kind: "l" }))].sort((a, b) => a.p - b.p), groups = [];
  for (const p of pts) { const g = groups[groups.length - 1]; if (g && p.p - g.hi <= tol) { g.hi = p.p; g.pts.push(p); } else groups.push({ lo: p.p, hi: p.p, pts: [p] }); }
  const z = groups.map((g) => ({ lo: r6(g.lo), hi: r6(g.hi), touches: g.pts.length, last_touch: g.pts.reduce((m, p) => (p.t > m ? p.t : m), ""), strength: g.pts.length >= 3 ? "strong" : g.pts.length === 2 ? "medium" : "weak" }));
  const sup = z.filter((x) => x.hi < price).sort((a, b) => b.hi - a.hi).slice(0, 3), res = z.filter((x) => x.lo > price).sort((a, b) => a.lo - b.lo).slice(0, 3), inside = z.filter((x) => x.lo <= price && x.hi >= price);
  return { support: sup, resistance: res, price_inside: inside, methodology: "clusters of confirmed swing highs/lows within " + CONFIG.zoneTolAtr + " ATR (calculated; not order-flow or institutional data)" };
}
export function liquidity(cs, pv, a) {
  const obs = [], tol = CONFIG.equalTolAtr * a, n = cs.length, from = n - CONFIG.sweepLookback;
  const eq = (arr, kind) => { for (let x = arr.length - 1; x >= 1; x--) for (let y = x - 1; y >= Math.max(0, x - 6); y--) { if (Math.abs(arr[x].p - arr[y].p) <= tol) { const lvl = Math.max(arr[x].p, arr[y].p), later = cs.slice(arr[x].i + 1), swept = kind === "h" ? later.some((b) => b.high > lvl + tol) : later.some((b) => b.low < Math.min(arr[x].p, arr[y].p) - tol); obs.push({ type: kind === "h" ? "equal_highs" : "equal_lows", level: r6(kind === "h" ? lvl : Math.min(arr[x].p, arr[y].p)), swept, first: arr[y].t, second: arr[x].t, note: kind === "h" ? "buy-side liquidity may rest above" : "sell-side liquidity may rest below" }); return; } } };
  eq(pv.hs.filter((p) => p.i > n - 120), "h"); eq(pv.ls.filter((p) => p.i > n - 120), "l");
  for (let i = Math.max(1, from); i < n; i++) {
    const prevH = pv.hs.filter((p) => p.i + CONFIG.swingK <= i - 1).slice(-1)[0], prevL = pv.ls.filter((p) => p.i + CONFIG.swingK <= i - 1).slice(-1)[0];
    if (prevH && cs[i].high > prevH.p && cs[i].close < prevH.p) obs.push({ type: "buy_side_sweep", level: r6(prevH.p), at: cs[i].timestamp, note: "wick above the swing high, close back below (calculated)" });
    if (prevL && cs[i].low < prevL.p && cs[i].close > prevL.p) obs.push({ type: "sell_side_sweep", level: r6(prevL.p), at: cs[i].timestamp, note: "wick below the swing low, close back above (calculated)" });
  }
  return { observations: obs.slice(-6), methodology: "calculated from confirmed swing highs/lows and candle closes; not order-flow data" };
}

// ---------------- sessions, freshness ----------------
export function sessionOf(ms, cls) {
  const d = new Date(ms), h = d.getUTCHours() + d.getUTCMinutes() / 60, wd = d.getUTCDay();
  const name = h < 7 ? "Asia" : h < 12 ? "London" : h < 16 ? "London / New York overlap" : h < 21 ? "New York" : "Late New York / rollover";
  let open = true;
  if (cls === "crypto") open = true;
  else if (cls === "equity" || cls === "etf") open = wd >= 1 && wd <= 5 && h >= 14.5 && h < 21;
  else open = !((wd === 5 && h >= 22) || wd === 6 || (wd === 0 && h < 22));
  const pp = new Date(ms + 7 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
  return { name, utc: d.toISOString().slice(0, 16) + "Z", phnom_penh: pp + " (UTC+7)", market_open: open, hours_approximate: cls === "equity" || cls === "etf" ? "US hours shift one hour with daylight saving" : null };
}
export function freshness(tf, last, delayed, cls, now) {
  if (!last) return { status: "no_data", age_s: null };
  const sec = TFSEC[tf], age = Math.max(0, Math.round((now - Date.parse(last.timestamp)) / 1000)), s = sessionOf(now, cls), allow = sec * 2 + 60 + (delayed ? 1500 : 0);
  const status = !s.market_open ? "market_closed" : age <= allow ? (delayed ? "delayed" : "fresh") : "stale";
  return { status, age_s: age, delayed: !!delayed, last_candle_forming: last.complete === false, market_open: s.market_open };
}

// ---------------- one timeframe ----------------
export function analyseTimeframe(tf, candles, opts = {}) {
  const now = opts.now ?? Date.now(), cls = opts.asset_class || "forex", all = Array.isArray(candles) ? candles : [], cs = all.filter((b) => b.complete !== false), forming = all.length && all[all.length - 1].complete === false;
  const n = cs.length, caveats = [], unavailable = [];
  const res = { timeframe: tf, candles_total: all.length, candles_used: n, forming_candle_excluded: !!forming, sufficient: n >= CONFIG.minCandles, last_complete_candle_at: n ? cs[n - 1].timestamp : null, last_candle_at: all.length ? all[all.length - 1].timestamp : null,
    freshness: freshness(tf, all[all.length - 1], opts.delayed, cls, now), unavailable, caveats };
  if (n < CONFIG.minForBias) { res.available = false; res.reason = "needs at least " + CONFIG.minForBias + " complete candles, got " + n; return res; }
  const closes = cs.map((b) => b.close), price = closes[n - 1], A = atr(cs, CONFIG.atr), a = A[n - 1];
  const E = {}; for (const p of CONFIG.ema) { const arr = ema(closes, p); E[p] = arr[n - 1] == null ? null : r6(arr[n - 1]); if (E[p] == null) unavailable.push("ema" + p + " (needs " + p + " candles)"); }
  const R = rsi(closes, CONFIG.rsi), M = macd(closes, ...CONFIG.macd), rv = R[n - 1], mh = M.hist[n - 1], mh3 = M.hist[n - 4];
  const st = structure(cs), pv = st.pivots, Z = zones(cs, pv, CONFIG.zoneTolAtr * a, price), L = liquidity(cs, pv, a), V = vwapOfDay(cs);
  if (V.value == null) unavailable.push("vwap (" + V.reason + ")");
  const aMed = (() => { const x = A.slice(-100).filter((v) => v != null).sort((p, q) => p - q); return x.length ? x[Math.floor(x.length / 2)] : null; })();
  const stack = [9, 20, 50, 100, 200].map((p) => E[p]); const stackOk = stack.every((x) => x != null);
  const emaStack = !stackOk ? null : stack.every((x, i) => i === 0 || stack[i - 1] > x) ? "bullish_stack" : stack.every((x, i) => i === 0 || stack[i - 1] < x) ? "bearish_stack" : "mixed";
  const short = [E[9] != null ? sgn(price - E[9]) : 0, E[20] != null ? sgn(price - E[20]) : 0, E[9] != null && E[20] != null ? sgn(E[9] - E[20]) : 0].reduce((s, x) => s + x, 0);
  const medium = [E[50] != null ? sgn(price - E[50]) : 0, E[50] != null && E[100] != null ? sgn(E[50] - E[100]) : 0, E[200] != null ? sgn(price - E[200]) : 0].reduce((s, x) => s + x, 0);
  const dirName = (v, t) => (v >= t ? "bullish" : v <= -t ? "bearish" : "neutral");
  const mom = rv == null ? null : rv >= 70 ? "overbought" : rv <= 30 ? "oversold" : rv > 55 ? "bullish" : rv < 45 ? "bearish" : "neutral";
  const regime = a != null && aMed ? (a / aMed > 1.3 ? "high" : a / aMed < 0.7 ? "low" : "normal") : null;
  // evidence for the directional lean (each factor is shown; weights are a stated heuristic, not a validated model)
  const ev = [];
  if (st.trend) ev.push({ factor: "structure (last BOS/CHoCH)", direction: st.trend, weight: 2 });
  if (emaStack && emaStack !== "mixed") ev.push({ factor: "EMA 9/20/50/100/200 stack", direction: emaStack === "bullish_stack" ? 1 : -1, weight: 1.5 });
  if (E[50] != null) ev.push({ factor: "price vs EMA50", direction: sgn(price - E[50]), weight: 1 });
  if (mh != null) ev.push({ factor: "MACD histogram", direction: sgn(mh), weight: 0.5 });
  if (rv != null && (rv > 55 || rv < 45)) ev.push({ factor: "RSI 14", direction: rv > 55 ? 1 : -1, weight: 0.5 });
  res.available = true; res.price = r6(price); res.atr = { value: r6(a), percent: r6((a / price) * 100), median_100: r6(aMed), regime };
  res.indicators = { ema: E, ema_stack: emaStack, rsi: R[n - 1] == null ? null : r6(rv), macd: { line: r6(M.line[n - 1]), signal: r6(M.signal[n - 1]), histogram: r6(mh), histogram_3_bars_ago: r6(mh3) }, atr14: r6(a), vwap: V };
  res.trend = { short: dirName(short, 2), medium: dirName(medium, 2), ema_stack: emaStack };
  res.momentum = { rsi_zone: mom, macd: mh == null ? null : mh > 0 ? "above_signal" : "below_signal", macd_histogram_direction: mh == null || mh3 == null ? null : mh > mh3 ? "rising" : mh < mh3 ? "falling" : "flat" };
  res.volatility = res.atr;
  res.structure = { trend: st.trend === 1 ? "bullish" : st.trend === -1 ? "bearish" : "undetermined", swing_labels: st.labels, last_break: st.last_break ? { type: st.last_break.type, direction: st.last_break.dir === 1 ? "bullish" : "bearish", level: r6(st.last_break.level), at: st.last_break.t } : null,
    last_swing_high: st.last_swing_high ? { price: r6(st.last_swing_high.p), at: st.last_swing_high.t } : null, last_swing_low: st.last_swing_low ? { price: r6(st.last_swing_low.p), at: st.last_swing_low.t } : null };
  res.levels = Z; res.liquidity = L; res.session = sessionOf(Date.parse(cs[n - 1].timestamp), cls);
  res.direction = ev.length ? sgn(ev.reduce((s, e) => s + e.direction * e.weight, 0)) : 0; res.evidence = ev;
  if (n < CONFIG.minCandles) caveats.push("fewer than " + CONFIG.minCandles + " complete candles: EMA200 and the long-term reading are unavailable or unreliable");
  if (res.freshness.status === "stale") caveats.push("the last candle is older than expected for an open market: data may be stale");
  if (res.freshness.status === "market_closed") caveats.push("market is closed: indicators describe the last session");
  if (res.freshness.delayed) caveats.push("data source is delayed");
  return res;
}

// ---------------- full analysis: primary timeframe + higher-timeframe ladder ----------------
export const LADDER = { M1: ["M5", "M15", "H1"], M5: ["M15", "H1", "H4"], M15: ["H1", "H4", "D1"], M30: ["H1", "H4", "D1"], H1: ["H4", "D1"], H4: ["D1"], D1: [] };
/** feeds: { M15: { candles, meta, error? }, H1: {...}, ... } as returned by the market-data function */
export function analyse({ symbol, timeframe, instrument, feeds, now = Date.now() }) {
  const cls = (instrument && instrument.asset_class) || "forex", out = { symbol, timeframe, instrument: instrument || null, calculated_at: new Date(now).toISOString(), engine: { name: "arom-market-intelligence", ...CONFIG } };
  const prim = feeds[timeframe]; if (!prim || prim.error || !prim.candles) return { ...out, available: false, bias: null, reason: prim && prim.error ? "data_unavailable: " + prim.error : "no_data" };
  const sources = []; const per = {};
  for (const tf of [timeframe, ...(LADDER[timeframe] || [])]) {
    const f = feeds[tf]; if (!f || f.error || !f.candles) { per[tf] = { timeframe: tf, available: false, reason: f && f.error ? f.error : "not_requested" }; continue; }
    per[tf] = analyseTimeframe(tf, f.candles, { now, asset_class: cls, delayed: f.meta && f.meta.is_delayed === true });
    if (f.meta) sources.push({ timeframe: tf, source: f.meta.source, last_candle_at: f.meta.last_candle_at, fetched_at: f.meta.fetched_at, from_cache: f.meta.from_cache, served_stale: f.meta.served_stale, is_delayed: f.meta.is_delayed, truncated: f.meta.truncated });
  }
  const p = per[timeframe]; out.source = sources.find((s) => s.timeframe === timeframe)?.source || null; out.sources = sources;
  if (!p.available) return { ...out, available: false, bias: null, timeframe_analysis: p, reason: p.reason };
  const ladder = (LADDER[timeframe] || []).map((tf) => per[tf]).map((x) => (x.available ? { timeframe: x.timeframe, direction: x.direction === 1 ? "bullish" : x.direction === -1 ? "bearish" : "neutral", structure: x.structure.trend, trend_medium: x.trend.medium, sufficient: x.sufficient, freshness: x.freshness.status } : { timeframe: x.timeframe, direction: null, available: false, reason: x.reason }));
  const dirs = [{ tf: timeframe, d: p.direction }, ...ladder.filter((x) => x.direction).map((x) => ({ tf: x.timeframe, d: x.direction === "bullish" ? 1 : x.direction === "bearish" ? -1 : 0 }))];
  const pos = dirs.filter((x) => x.d > 0), neg = dirs.filter((x) => x.d < 0), conflicts = pos.length && neg.length ? ["bullish on " + pos.map((x) => x.tf).join(", ") + " but bearish on " + neg.map((x) => x.tf).join(", ")] : [];
  const alignment = dirs.length < 2 ? "single_timeframe" : conflicts.length ? "conflicting" : dirs.every((x) => x.d === dirs[0].d && x.d !== 0) ? "aligned" : "partial";
  const htf = [...ladder].reverse().find((x) => x.direction); const htfDir = htf ? (htf.direction === "bullish" ? 1 : htf.direction === "bearish" ? -1 : 0) : null;
  const ev = [...p.evidence]; if (htfDir) ev.push({ factor: "higher timeframe (" + htf.timeframe + ")", direction: htfDir, weight: 2 });
  const total = ev.reduce((s, e) => s + e.direction * e.weight, 0), max = ev.reduce((s, e) => s + e.weight, 0) || 1, lean = total / max;
  const usable = p.candles_used >= CONFIG.minForBias && p.freshness.status !== "stale" && p.freshness.status !== "no_data";
  const bias = !usable ? null : lean >= 0.35 ? "bullish" : lean <= -0.35 ? "bearish" : "neutral";
  const caveats = [...p.caveats]; if (!usable) caveats.push(p.freshness.status === "stale" ? "bias withheld: data is stale" : "bias withheld: not enough data");
  if (conflicts.length) caveats.push("timeframes conflict: " + conflicts[0]);
  if (out.instrument && out.instrument.is_proxy) caveats.push("prices are for an ETF that tracks " + out.instrument.tracks + ", not the index level");
  if (out.instrument && out.instrument.delayed) caveats.push("price feed is delayed futures data");
  return { ...out, available: true, bias, evidence_score: r6(lean), evidence: ev, confidence: null, confidence_note: "no statistically validated model backs a probability; evidence_score is a transparent heuristic from -1 to +1",
    last_candle_at: p.last_candle_at, last_complete_candle_at: p.last_complete_candle_at, freshness: p.freshness, session: p.session, trend: p.trend, momentum: p.momentum, volatility: p.volatility, structure: p.structure, levels: p.levels, liquidity: p.liquidity, indicators: p.indicators,
    data: { candles_used: p.candles_used, forming_candle_excluded: p.forming_candle_excluded, sufficient_for_ema200: p.sufficient, unavailable: p.unavailable }, multi_timeframe: { alignment, higher_timeframe_bias: htf ? htf.direction : null, ladder, conflicts }, caveats };
}
