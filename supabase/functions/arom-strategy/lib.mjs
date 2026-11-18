// AROM Strategy Lab: pure logic (no network, no Deno APIs) so it can be unit-tested in Node.
// A strategy is a small JSON spec. The AI only turns a member's words into that spec; the numbers come from this deterministic engine on real candles.
// Honest by design: every result is compared with buy and hold AND with random entries that use the same exits, and carries a bootstrap range and warnings.

export const SYMBOLS = ["XAUUSD", "XAGUSD", "BTCUSD", "ETHUSD", "EURUSD", "GBPUSD"];
export const TIMEFRAMES = ["D1"];   // the data feed keeps too little intraday history (about 500 bars) for a 200-bar average to leave anything to test
export const MIN_BARS = 260;            // below this a 200-bar average leaves nothing to test
export const GOOD_TRADES = 30;          // below this no verdict is given

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const int = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? clamp(n, lo, hi) : d; };
const pct = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? clamp(n, lo, hi) : null; };
const clip = (s, n) => String(s ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, n);

/** Turns whatever the model (or a client) sent into a spec the engine can run, or an error. Unknown fields are dropped; numbers are clamped. */
export function validateSpec(raw) {
  if (!raw || typeof raw !== "object") return { error: "bad_spec" };
  const symbol = String(raw.symbol || "").toUpperCase(); if (!SYMBOLS.includes(symbol)) return { error: "unsupported_symbol" };
  const timeframe = String(raw.timeframe || "D1").toUpperCase(); if (!TIMEFRAMES.includes(timeframe)) return { error: "unsupported_timeframe" };
  const e = raw.entry || {}, type = String(e.type || "");
  let entry;
  if (type === "rsi_cross_up") entry = { type, period: int(e.period, 2, 50, 14), level: clamp(Number(e.level) || 40, 5, 95) };
  else if (type === "ma_cross_up") { const fast = int(e.fast, 2, 100, 50), slow = int(e.slow, 5, 300, 200); if (fast >= slow) return { error: "bad_ma_pair" }; entry = { type, fast, slow, ma: e.ma === "sma" ? "sma" : "ema" }; }
  else if (type === "breakout") entry = { type, lookback: int(e.lookback, 5, 250, 100) };
  else if (type === "pullback_reclaim") entry = { type, ma: e.ma === "sma" ? "sma" : "ema", period: int(e.period, 5, 100, 20) };   // closes back above the average after closing below it
  else return { error: "unsupported_entry" };
  let filter = null;
  if (raw.trend_filter && typeof raw.trend_filter === "object" && raw.trend_filter.period) filter = { ma: raw.trend_filter.ma === "sma" ? "sma" : "ema", period: int(raw.trend_filter.period, 5, 300, 200) };
  const x = raw.exit || {}, exit = { stop_pct: pct(x.stop_pct, 0.2, 50), target_pct: pct(x.target_pct, 0.2, 200), signal: null };
  if (x.signal && typeof x.signal === "object") {
    const t = String(x.signal.type || "");
    if (t === "close_below_ma") exit.signal = { type: t, ma: x.signal.ma === "sma" ? "sma" : "ema", period: int(x.signal.period, 5, 300, 50) };
    else if (t === "channel_low") exit.signal = { type: t, lookback: int(x.signal.lookback, 5, 250, 50) };
    else if (t === "ma_cross_down" && entry.type === "ma_cross_up") exit.signal = { type: t };
  }
  if (!exit.stop_pct && !exit.target_pct && !exit.signal) return { error: "no_exit" };   // an entry with no exit is not a strategy
  const costs = { fee_bps: clamp(Number(raw.fee_bps) >= 0 ? Number(raw.fee_bps) : 5, 0, 100), slip_bps: clamp(Number(raw.slip_bps) >= 0 ? Number(raw.slip_bps) : 2, 0, 100) };
  return { spec: { symbol, timeframe, direction: "long", entry, trend_filter: filter, exit, ...costs } };
}

// ---------------- indicators (all arrays line up with the candles; null until enough data) ----------------
export function sma(a, n) { const o = Array(a.length).fill(null); let s = 0; for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= n) s -= a[i - n]; if (i >= n - 1) o[i] = s / n; } return o; }
export function ema(a, n) { const o = Array(a.length).fill(null); if (a.length < n) return o; const k = 2 / (n + 1); let p = 0; for (let i = 0; i < n; i++) p += a[i]; p /= n; o[n - 1] = p; for (let i = n; i < a.length; i++) { p = a[i] * k + p * (1 - k); o[i] = p; } return o; }
export function rsi(a, n) {
  const o = Array(a.length).fill(null); if (a.length <= n) return o; let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = a[i] - a[i - 1]; if (d > 0) g += d; else l -= d; } g /= n; l /= n; o[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = n + 1; i < a.length; i++) { const d = a[i] - a[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
  return o;
}
const maOf = (kind, a, n) => (kind === "sma" ? sma(a, n) : ema(a, n));
const hi = (c, i, n) => { let m = -Infinity; for (let k = i - n; k < i; k++) m = Math.max(m, c[k].h); return m; };
const lo = (c, i, n) => { let m = Infinity; for (let k = i - n; k < i; k++) m = Math.min(m, c[k].l); return m; };

/** Indicator series needed by a spec. */
export function prepare(candles, spec) {
  const close = candles.map((c) => c.c), P = { close };
  const e = spec.entry;
  if (e.type === "rsi_cross_up") P.rsi = rsi(close, e.period);
  if (e.type === "ma_cross_up") { P.fast = maOf(e.ma, close, e.fast); P.slow = maOf(e.ma, close, e.slow); }
  if (e.type === "pullback_reclaim") P.pull = maOf(e.ma, close, e.period);
  if (spec.trend_filter) P.filter = maOf(spec.trend_filter.ma, close, spec.trend_filter.period);
  if (spec.exit.signal && spec.exit.signal.type === "close_below_ma") P.xma = maOf(spec.exit.signal.ma, close, spec.exit.signal.period);
  return P;
}
const need = (spec) => { const e = spec.entry; return Math.max(e.type === "rsi_cross_up" ? e.period + 2 : e.type === "ma_cross_up" ? e.slow + 2 : e.type === "breakout" ? e.lookback + 2 : e.period + 2, spec.trend_filter ? spec.trend_filter.period + 1 : 0, spec.exit.signal && spec.exit.signal.type === "close_below_ma" ? spec.exit.signal.period + 1 : 0, spec.exit.signal && spec.exit.signal.type === "channel_low" ? spec.exit.signal.lookback + 2 : 0); };

/** Does the entry fire on the CLOSE of bar i? (the trade is filled at that close) */
export function entryAt(candles, P, spec, i) {
  const e = spec.entry, c = P.close;
  if (spec.trend_filter) { const f = P.filter[i]; if (f == null || !(c[i] > f)) return false; }
  if (e.type === "rsi_cross_up") return P.rsi[i] != null && P.rsi[i - 1] != null && P.rsi[i - 1] <= e.level && P.rsi[i] > e.level;
  if (e.type === "ma_cross_up") return P.fast[i] != null && P.slow[i] != null && P.fast[i - 1] != null && P.slow[i - 1] != null && P.fast[i - 1] <= P.slow[i - 1] && P.fast[i] > P.slow[i];
  if (e.type === "breakout") return i > e.lookback && c[i] > hi(candles, i, e.lookback) && c[i - 1] <= hi(candles, i - 1, e.lookback);
  if (e.type === "pullback_reclaim") return P.pull[i] != null && P.pull[i - 1] != null && c[i - 1] < P.pull[i - 1] && c[i] > P.pull[i];
  return false;
}
function signalExit(candles, P, spec, i) {
  const s = spec.exit.signal; if (!s) return false;
  if (s.type === "close_below_ma") return P.xma[i] != null && P.close[i] < P.xma[i];
  if (s.type === "channel_low") return i > s.lookback && P.close[i] < lo(candles, i, s.lookback);
  if (s.type === "ma_cross_down") return P.fast[i] != null && P.slow[i] != null && P.fast[i] < P.slow[i];
  return false;
}

/** Walk one trade forward from an entry at the close of bar `i`. Stop is checked before target on the same bar (the pessimistic choice).
 *  Returns { exit, price, r(net return), bars } or null when the trade is still open at the end (then `open` gives the mark-to-market). */
export function walkTrade(candles, P, spec, i, costs) {
  const entry = candles[i].c * (1 + costs.slip), stop = spec.exit.stop_pct ? entry * (1 - spec.exit.stop_pct / 100) : null, tgt = spec.exit.target_pct ? entry * (1 + spec.exit.target_pct / 100) : null;
  const done = (k, px, why) => ({ why, bars: k - i, px, r: (px * (1 - costs.slip)) / entry - 1 - 2 * costs.fee, exitIndex: k });
  for (let k = i + 1; k < candles.length; k++) {
    const b = candles[k];
    if (stop != null && b.l <= stop) return done(k, stop, "stop");
    if (tgt != null && b.h >= tgt) return done(k, tgt, "target");
    if (signalExit(candles, P, spec, k)) return done(k, b.c, "signal");
  }
  const last = candles[candles.length - 1].c; return { why: "open", bars: candles.length - 1 - i, px: last, r: (last * (1 - costs.slip)) / entry - 1 - 2 * costs.fee, open: true, exitIndex: candles.length - 1 };
}

/** The strategy's own trades: one position at a time. */
export function simulate(candles, spec) {
  const P = prepare(candles, spec), costs = { fee: spec.fee_bps / 10000, slip: spec.slip_bps / 10000 }, start = need(spec), trades = [];
  for (let i = start; i < candles.length - 1;) {
    if (entryAt(candles, P, spec, i)) { const t = walkTrade(candles, P, spec, i, costs); trades.push({ ...t, entryIndex: i, entryTime: candles[i].t }); i = t.exitIndex + 1; if (t.open) break; }
    else i++;
  }
  return { trades, P, start, costs };
}

// ---------------- statistics ----------------
function rng(seed) { let s = seed >>> 0; return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296; }
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const quant = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]; };

export function bootstrapMean(a, n = 4000, seed = 7) {
  if (a.length < 2) return null; const r = rng(seed), b = [];
  for (let k = 0; k < n; k++) { let t = 0; for (let j = 0; j < a.length; j++) t += a[Math.floor(r() * a.length)]; b.push(t / a.length); }
  return { lo: quant(b, 0.025), hi: quant(b, 0.975), p_le_zero: b.filter((x) => x <= 0).length / n };
}
/** Same exits, entries at (almost) every bar that passes the trend filter. This is the bar a real entry rule has to clear. */
export function randomBaseline(candles, spec, P, costs, start, step) {
  const pool = [];
  for (let i = start; i < candles.length - 1; i += step) {
    if (spec.trend_filter) { const f = P.filter[i]; if (f == null || !(P.close[i] > f)) continue; }
    const t = walkTrade(candles, P, spec, i, costs); if (!t.open) pool.push(t.r);
  }
  return pool;
}
export function permutationP(pool, n, observedMean, draws = 4000, seed = 13) {
  if (pool.length < 20 || n < 1) return null; const r = rng(seed); let ge = 0;
  for (let k = 0; k < draws; k++) { let t = 0; for (let j = 0; j < n; j++) t += pool[Math.floor(r() * pool.length)]; if (t / n >= observedMean) ge++; }
  return ge / draws;
}
function drawdown(eq) { let pk = -Infinity, dd = 0; for (const v of eq) { pk = Math.max(pk, v); dd = Math.min(dd, v / pk - 1); } return dd; }

/** Opens that sit exactly on the high or low are a sign of a bad feed; the engine does not use opens, but the member should know. */
export function dataQuality(candles) {
  let ext = 0, flat = 0; for (const c of candles) { const r = c.h - c.l; if (r > 0 && (Math.abs(c.o - c.h) < r * 0.01 || Math.abs(c.o - c.l) < r * 0.01)) ext++; if (r === 0) flat++; }
  return { bars: candles.length, opens_at_extreme_pct: +(100 * ext / Math.max(1, candles.length)).toFixed(1), flat_bars: flat };
}

/** Everything the page shows. `candles` = [{t(ms), o,h,l,c}] oldest first. */
export function backtest(candles, spec) {
  if (!Array.isArray(candles) || candles.length < MIN_BARS) return { error: "not_enough_data", bars: Array.isArray(candles) ? candles.length : 0, needed: MIN_BARS };
  const { trades, P, start, costs } = simulate(candles, spec), closed = trades.filter((t) => !t.open), all = trades, rs = closed.map((t) => t.r);
  const barsPerYear = spec.timeframe === "D1" ? (spec.symbol === "BTCUSD" || spec.symbol === "ETHUSD" ? 365 : 252) : spec.timeframe === "H4" ? 6 * (spec.symbol === "BTCUSD" || spec.symbol === "ETHUSD" ? 365 : 252) : 24 * (spec.symbol === "BTCUSD" || spec.symbol === "ETHUSD" ? 365 : 252);
  const years = Math.max(1e-9, (candles.length - start) / barsPerYear);
  // equity curve, bar by bar, marked to market. Costs are charged on the entry bar and the exit bar.
  const eq = new Array(candles.length).fill(1); let e = 1, inMarket = 0;
  const byEntry = new Map(all.map((t) => [t.entryIndex, t])); let cur = null;
  for (let i = start; i < candles.length; i++) {
    if (cur && i > cur.entryIndex) {
      inMarket++; const prev = candles[i - 1].c, last = i === cur.exitIndex, px = last ? cur.px : candles[i].c;
      e *= px / prev; if (last) { e *= (1 - costs.slip) * (1 - costs.fee); cur = null; }
    }
    if (!cur && byEntry.has(i)) { cur = byEntry.get(i); e *= (1 - costs.fee) / (1 + costs.slip); }
    eq[i] = e;
  }
  const equity = eq.slice(start), totalRet = all.reduce((a, t) => a * (1 + t.r), 1) - 1;
  const bh = candles[candles.length - 1].c / candles[start].c - 1, bhEq = candles.slice(start).map((c) => c.c / candles[start].c);
  const wins = rs.filter((x) => x > 0), loss = rs.filter((x) => x <= 0), gp = wins.reduce((a, b) => a + b, 0), gl = -loss.reduce((a, b) => a + b, 0);
  const boot = bootstrapMean(rs), pool = randomBaseline(candles, spec, P, costs, start, spec.timeframe === "D1" ? 2 : 4), pRand = rs.length >= 5 ? permutationP(pool, rs.length, mean(rs)) : null;
  const randAvg = pool.length ? mean(pool) : null, avg = rs.length ? mean(rs) : null, half = Math.floor(rs.length / 2);
  const stats = {
    trades: all.length, closed_trades: rs.length, open_trade: all.some((t) => t.open), wins: wins.length, win_rate: rs.length ? wins.length / rs.length : null,
    total_return: totalRet, cagr: Math.pow(1 + totalRet, 1 / years) - 1, max_drawdown: drawdown(equity), profit_factor: gl > 0 ? gp / gl : (gp > 0 ? null : 0),
    avg_trade: avg, avg_win: wins.length ? mean(wins) : null, avg_loss: loss.length ? mean(loss) : null, avg_bars_held: all.length ? mean(all.map((t) => t.bars)) : null,
    time_in_market: inMarket / Math.max(1, candles.length - start), years: +years.toFixed(2), first: candles[start].t, last: candles[candles.length - 1].t,
    buy_hold_return: bh, buy_hold_cagr: Math.pow(1 + bh, 1 / years) - 1, buy_hold_max_drawdown: drawdown(bhEq),
    first_half_avg: half >= 3 ? mean(rs.slice(0, half)) : null, second_half_avg: rs.length - half >= 3 ? mean(rs.slice(half)) : null,
  };
  const random = { entries: pool.length, avg_trade: randAvg, p_random_as_good: pRand };
  const bootstrap = boot ? { lo: boot.lo, hi: boot.hi, p_le_zero: boot.p_le_zero } : null;
  const dq = dataQuality(candles), warnings = [];
  if (rs.length < GOOD_TRADES) warnings.push("few_trades");
  if (stats.years < 3 && spec.timeframe === "D1") warnings.push("short_history");
  if (spec.timeframe !== "D1") warnings.push("intraday_short_history");
  if (stats.buy_hold_return > 0 && totalRet < stats.buy_hold_return) warnings.push("below_buy_hold");
  if (stats.buy_hold_return > 0.5) warnings.push("strong_uptrend");
  if (dq.opens_at_extreme_pct > 35) warnings.push("opens_unreliable");
  if (stats.open_trade) warnings.push("open_trade");
  warnings.push("in_sample", "fills_at_close_no_gaps");
  return { spec, stats, random, bootstrap, data: dq, verdict: verdict(stats, random, bootstrap, rs.length), warnings, trades: all.slice(-40).map((t) => ({ entry: candles[t.entryIndex].t, exit: candles[t.exitIndex].t, why: t.why, r: t.r, bars: t.bars })), equity: thin(equity, 160), buy_hold: thin(bhEq, 160), generated_at: new Date().toISOString() };
}
const thin = (a, n) => { if (a.length <= n) return a.map((v) => +v.toFixed(4)); const o = []; for (let i = 0; i < n; i++) o.push(+a[Math.round((i * (a.length - 1)) / (n - 1))].toFixed(4)); return o; };

/** One plain word. The rules are deliberately strict: a tiny sample never gets a good word. */
export function verdict(stats, random, boot, n) {
  if (n < 5) return "no_trades_to_judge";
  if (n < GOOD_TRADES) return "too_few_trades";
  const pr = random.p_random_as_good, beats = pr != null && pr < 0.05 && boot && boot.lo > 0;
  if (beats) return stats.buy_hold_return > 0 && stats.total_return < stats.buy_hold_return ? "edge_but_below_buy_hold" : "beats_random";
  if (pr != null && pr >= 0.2) return "no_edge_over_random";
  return "unproven";
}
