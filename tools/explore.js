#!/usr/bin/env node
/* Strategy experiments: runs engine VARIANTS (small source patches applied in memory, live engine untouched)
   over cached M1 candles and compares exit models + how far price runs in your favour (MFE) before the stop.
   Usage: node tools/explore.js data/xauusd_m1.csv [spread] */
const fs = require('fs'), path = require('path');
const FILE = process.argv[2], SPREAD = +(process.argv[3] || 0.3);
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const a0 = html.indexOf('const AiEng = (() => {'), SRC = html.slice(a0, html.indexOf('\n})();', a0) + 6);
const m1 = fs.readFileSync(FILE, 'utf8').split('\n').map(l => l.split(',').map(Number)).filter(r => r.length >= 5 && isFinite(r[0])).map(([t, o, h, l, c]) => ({ t, o, h, l, c })).sort((x, y) => x.t - y.t);

const MOM_B = "else if(body >= .55 * rng && b.c > p.h) trig = 'momentum';", MOM_S = "else if(body >= .55 * rng && b.c < p.l) trig = 'momentum';";
const VARIANTS = {
  'base (live)': [],
  'no momentum trigger': [[MOM_B, ''], [MOM_S, '']],
  'conf = 3 (all level types)': [["conf >= 2 ? 'A+'", "conf >= 3 ? 'A+'"]],
  'stop +0.3 ATR (not 0.1)': [['base - .1 * A5', 'base - .3 * A5'], ['base + .1 * A5', 'base + .3 * A5']],
  'risk >= 0.5 ATR': [['risk >= .3 * A5', 'risk >= .5 * A5']],
  'no momentum + stop +0.3': [[MOM_B, ''], [MOM_S, ''], ['base - .1 * A5', 'base - .3 * A5'], ['base + .1 * A5', 'base + .3 * A5']],
};
function engine(patches) {
  let s = SRC; for (const [x, y] of patches) { if (!s.includes(x)) throw new Error('patch not found: ' + x); s = s.split(x).join(y); }
  return new Function(s + '\nreturn AiEng;')();
}
// path of one trade: first-stop index, and max favourable move (R) before it
function walk(m, i, s) {
  const L = s.side === 'BUY', risk = Math.abs(s.entry - s.sl); let mfe = 0, stopK = null;
  const T = [1, 1.5, 2, 3], hit = {}; // first bar index where each target is reached
  for (let k = i + 1; k <= Math.min(m.length - 1, i + s.maxBars); k++) {
    const b = m[k]; if (L ? b.l <= s.sl : b.h >= s.sl) { stopK = k; }
    const fav = (L ? b.h - s.entry : s.entry - b.h * 0 - b.l) / risk; // L: high; S: entry-low
    const f = L ? (b.h - s.entry) / risk : (s.entry - b.l) / risk;
    if (stopK == null || stopK > k) { /* before/at stop candle: same-candle counts as stop, so only credit earlier candles */ }
    if (stopK !== k) { mfe = Math.max(mfe, f); for (const t of T) if (hit[t] == null && f >= t) hit[t] = k; }
    if (stopK != null) break;
  }
  const end = Math.min(m.length - 1, i + s.maxBars), last = m[end].c, mv = (L ? last - s.entry : s.entry - last) / risk;
  return { risk, mfe, stopK, hit, mv };
}
const full = (w, T) => { const win = w.hit[T] != null; return win ? T : w.stopK != null ? -1 : Math.max(-1, Math.min(T, w.mv)); };
const split = w => { const t1 = w.hit[1], t2 = w.hit[2]; if (t1 == null) return w.stopK != null ? -1 : Math.max(-1, Math.min(1, w.mv)); // stopped before TP1
  if (t2 != null) return 1.5;   // (stop-to-entry after TP1 assumed; if price hit entry before TP2 it is +0.5, approximated by checking stop bar)
  return w.stopK != null ? 0.5 : 0.5 + 0.5 * Math.max(0, Math.min(1, w.mv)); };
const med = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const f = (x, d = 2) => (x >= 0 ? '+' : '') + x.toFixed(d);

console.log(`${m1.length} M1 candles · spread ${SPREAD}\n`);
console.log('variant'.padEnd(30), 'n'.padStart(4), 'medMFE'.padStart(7), '≥1R%'.padStart(6), ' split  1R-full  1.5R   2R    3R   (avg R after spread)');
const MIR = [];
for (const [name, patches] of Object.entries(VARIANTS)) {
  const E = engine(patches), P = E.prep(m1, null, 'scalp', process.argv[4] || 'XAUUSD'), W = []; let last = -99;
  for (let i = 120; i < m1.length - 1; i++) { const ev = E.evalAt(P, i, () => true); if (!ev.signal || i - last <= 10) continue; last = i; W.push(walk(m1, i, ev.signal)); if (name === 'base (live)') { const g = ev.signal, R = Math.abs(g.entry - g.sl), up = g.side === 'BUY'; MIR.push(walk(m1, i, { ...g, side: up ? 'SELL' : 'BUY', sl: g.entry + (up ? R : -R) })); } }
  if (!W.length) { console.log(name.padEnd(30), '   0'); continue; }
  const cost = w => SPREAD / w.risk, avg = fn => W.reduce((a, w) => a + fn(w) - cost(w), 0) / W.length;
  console.log(name.padEnd(30), String(W.length).padStart(4), f(med(W.map(w => w.mfe))).padStart(7), (100 * W.filter(w => w.hit[1] != null).length / W.length).toFixed(0).padStart(5) + '%',
    f(avg(split)).padStart(7), f(avg(w => full(w, 1))).padStart(7), f(avg(w => full(w, 1.5))).padStart(6), f(avg(w => full(w, 2))).padStart(6), f(avg(w => full(w, 3))).padStart(6));
}

// Diagnostic: the SAME entries traded in the OPPOSITE direction with the same risk (random-ish baseline is ~45% reaching 1R before a 1R stop)
const cm = w => SPREAD / w.risk, am = fn => MIR.reduce((a, w) => a + fn(w) - cm(w), 0) / MIR.length;
console.log('\nmirror (opposite direction, same times)'.padEnd(31), String(MIR.length).padStart(4), f(med(MIR.map(w => w.mfe))).padStart(7), (100 * MIR.filter(w => w.hit[1] != null).length / MIR.length).toFixed(0).padStart(5) + '%', f(am(split)).padStart(7), f(am(w => full(w, 1))).padStart(7), f(am(w => full(w, 1.5))).padStart(6), f(am(w => full(w, 2))).padStart(6), f(am(w => full(w, 3))).padStart(6));
