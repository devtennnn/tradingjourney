#!/usr/bin/env node
/* Liquidity-sweep scalp (experimental entry, independent of the live engine).
   Idea: price spikes through a recent M1 swing high/low (stops get run), then closes back inside = failed break.
   BUY  = candle's low pierces a swing low, close back above it, long lower wick.  SELL = mirror at a swing high.
   SL beyond the sweep extreme. Costs: spread is charged per trade; a trade needs risk >= minRisk x spread.
   Usage: node tools/sweep.js <csv> <spread in price units> [label]   (run several files to check the idea holds on every market) */
const fs = require('fs');
const [FILE, SP, LABEL] = [process.argv[2], +process.argv[3] || 0, process.argv[4] || process.argv[2]];
const m = fs.readFileSync(FILE, 'utf8').split('\n').map(l => l.split(',').map(Number)).filter(r => r.length >= 5 && isFinite(r[0])).map(([t, o, h, l, c]) => ({ t, o, h, l, c })).sort((a, b) => a.t - b.t);

const ema = (a, n) => { const k = 2 / (n + 1), o = []; let p = null; for (let i = 0; i < a.length; i++) { if (i < n - 1) { o.push(null); continue; } p = p === null ? a.slice(i - n + 1, i + 1).reduce((x, y) => x + y) / n : a[i] * k + p * (1 - k); o.push(p); } return o; };
const atr = (b, n = 14) => { const o = []; let a = 0; for (let i = 0; i < b.length; i++) { if (!i) { o.push(null); continue; } const tr = Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c)); if (i <= n) { a += tr; o.push(i === n ? (a /= n) : null); } else { a = (a * (n - 1) + tr) / n; o.push(a); } } return o; };
const A = atr(m);
// M5 trend (closed M5 candles only)
const m5 = []; for (const b of m) { const k = b.t - b.t % 300, c = m5[m5.length - 1]; if (c && c.t === k) { c.h = Math.max(c.h, b.h); c.l = Math.min(c.l, b.l); c.c = b.c; c.n++; } else m5.push({ t: k, h: b.h, l: b.l, c: b.c, n: 1 }); }
const e20 = ema(m5.map(x => x.c), 20), e50 = ema(m5.map(x => x.c), 50);
let q = -1; const trendAt = closeT => { while (q + 1 < m5.length && m5[q + 1].t + 300 <= closeT) q++; if (q < 55 || m5[q].n < 5 || e50[q] == null) return 0; const c = m5[q].c; return c > e50[q] && e20[q] > e50[q] && e20[q] > e20[q - 3] ? 1 : c < e50[q] && e20[q] < e50[q] && e20[q] < e20[q - 3] ? -1 : 0; };

function walk(i, side, entry, sl, maxBars = 60) {
  const L = side === 'BUY', risk = Math.abs(entry - sl); let stopK = null; const hit = {};
  for (let k = i + 1; k <= Math.min(m.length - 1, i + maxBars); k++) {
    if (L ? m[k].l <= sl : m[k].h >= sl) { stopK = k; break; }
    const f = L ? (m[k].h - entry) / risk : (entry - m[k].l) / risk;
    for (const T of [1, 1.5, 2, 3]) if (hit[T] == null && f >= T) hit[T] = k;
  }
  const end = Math.min(m.length - 1, i + maxBars), mv = (L ? m[end].c - entry : entry - m[end].c) / risk;
  return { risk, stopK, hit, mv, t: m[i].t };
}
const full = (w, T) => w.hit[T] != null ? T : w.stopK != null ? -1 : Math.max(-1, Math.min(T, w.mv));
const split = w => w.hit[1] == null ? (w.stopK != null ? -1 : Math.max(-1, Math.min(1, w.mv))) : w.hit[2] != null ? 1.5 : (w.stopK != null ? 0.5 : 0.5 + 0.5 * Math.max(0, Math.min(1, w.mv)));
const PIV = 3, LOOK = 60, MINRISK = 8;

const trades = []; let last = -99;
for (let i = LOOK + PIV; i < m.length - 1; i++) {
  if (A[i] == null || i - last <= 10) continue;
  const b = m[i], rng = Math.max(b.h - b.l, 1e-9); let sw = null, side = null;
  // swing lows/highs known before this candle (pivot needs PIV candles on each side, all before i)
  for (let k = i - LOOK; k <= i - PIV - 1 && !side; k++) {
    const isL = [...Array(PIV)].every((_, d) => m[k].l < m[k - d - 1].l && m[k].l <= m[k + d + 1].l), isH = [...Array(PIV)].every((_, d) => m[k].h > m[k - d - 1].h && m[k].h >= m[k + d + 1].h);
    if (isL && b.l < m[k].l && b.c > m[k].l && Math.min(b.o, b.c) - b.l >= 0.5 * rng && b.c > b.o) { side = 'BUY'; sw = m[k].l; }
    else if (isH && b.h > m[k].h && b.c < m[k].h && b.h - Math.max(b.o, b.c) >= 0.5 * rng && b.c < b.o) { side = 'SELL'; sw = m[k].h; }
  }
  if (!side) continue;
  const sl = side === 'BUY' ? b.l - 0.1 * A[i] : b.h + 0.1 * A[i], risk = Math.abs(b.c - sl);
  if (risk < MINRISK * SP || risk > 3 * A[i]) continue;                   // spread must be a small share of 1R; no giant stops
  last = i; const tr = trendAt(b.t + 60), w = walk(i, side, b.c, sl);
  trades.push({ ...w, side, align: tr === 0 ? 'range' : (tr === 1) === (side === 'BUY') ? 'with-trend' : 'counter' });
}
const f = (x, d = 2) => (x >= 0 ? '+' : '') + x.toFixed(d), avg = (rows, fn) => rows.length ? rows.reduce((a, w) => a + fn(w) - SP / w.risk, 0) / rows.length : NaN;
const row = (name, rows) => { const h = Math.floor(rows.length / 2), a = rows.slice(0, h), b = rows.slice(h);
  console.log(`  ${name.padEnd(12)} n=${String(rows.length).padStart(4)}  reach1R ${(rows.length ? 100 * rows.filter(w => w.hit[1] != null).length / rows.length : 0).toFixed(0).padStart(3)}%  split ${f(avg(rows, split))}  full1.5R ${f(avg(rows, w => full(w, 1.5)))}  full2R ${f(avg(rows, w => full(w, 2)))}   | 1st half ${f(avg(a, split))}  2nd half ${f(avg(b, split))}`); };
console.log(`\n${LABEL}: ${m.length} M1 candles, spread ${SP}, ${trades.length} sweep trades (avg risk ${f(trades.reduce((a, w) => a + w.risk, 0) / (trades.length || 1), 2).slice(1)})`);
row('all', trades); for (const g of ['with-trend', 'counter', 'range']) row(g, trades.filter(w => w.align === g));
