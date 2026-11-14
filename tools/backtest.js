#!/usr/bin/env node
/* AROM Scalping v3 · backtest + learner
   Replays the REAL engine (extracted from index.html, so there is one source of truth) over M1 candles,
   measures every A+ signal in R (after spread), then finds which setup features win or lose.
   It uses a walk-forward split: rules are learned on the older 60% and only trusted if they also help the newer 40%.

   Usage:
     node tools/backtest.js --csv data/xauusd_m1.csv --symbol XAUUSD --spread 0.30
     TWELVEDATA_API_KEY=... node tools/backtest.js --td XAU/USD --symbol XAUUSD --days 20 --spread 0.30
   CSV columns: time,open,high,low,close  (time = unix seconds or ISO UTC; header optional)
   Options: --spread <price units per trade, default 0>  --split <train share, default 0.6>  --out tools/edge-rules.json  --json */
const fs = require('fs'), path = require('path');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true); };
const MODE = String(arg('mode', 'scalp')), SYMBOL = String(arg('symbol', 'XAUUSD')).toUpperCase(), SPREAD = +arg('spread', 0), SPLIT = +arg('split', 0.6);

/* ---- load the live engine out of index.html ---- */
function loadEngine() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const a = html.indexOf('const AiEng = (() => {'), b = html.indexOf('\n})();', a);
  if (a < 0 || b < 0) throw new Error('AiEng block not found in index.html');
  return new Function(html.slice(a, b + 6) + '\nreturn AiEng;')();
}

/* ---- candles ---- */
function readCsv(file) {
  const out = [];
  for (const ln of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const p = ln.split(/[,;\t]/); if (p.length < 5) continue;
    const t = /^\d+(\.\d+)?$/.test(p[0].trim()) ? Math.floor(+p[0]) : Math.floor(Date.parse(p[0].trim().replace(' ', 'T') + (/[zZ+]/.test(p[0]) ? '' : 'Z')) / 1000);
    const [o, h, l, c] = p.slice(1, 5).map(Number);
    if (isFinite(t) && [o, h, l, c].every(isFinite)) out.push({ t: t - (t % 60), o, h, l, c });
  }
  return out.sort((x, y) => x.t - y.t);
}
async function fetchTwelve(symbol, days) {
  const key = process.env.TWELVEDATA_API_KEY; if (!key) throw new Error('set TWELVEDATA_API_KEY');
  let end = new Date().toISOString().slice(0, 19).replace('T', ' '), all = [];
  const stop = Date.now() / 1000 - days * 86400;
  while (true) {
    const u = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=1min&outputsize=5000&timezone=UTC&order=DESC&end_date=${encodeURIComponent(end)}${key === 'proxy-injected' ? '' : '&apikey=' + key}`;   // proxy-injected: the sandbox proxy adds the key as a header
    const j = await (await fetch(u)).json();
    if (j.status === 'error' || !Array.isArray(j.values) || !j.values.length) { if (all.length) break; throw new Error('twelvedata: ' + (j.message || 'no data')); }
    const rows = j.values.map(v => ({ t: Math.floor(Date.parse(v.datetime.replace(' ', 'T') + 'Z') / 1000), o: +v.open, h: +v.high, l: +v.low, c: +v.close }));
    all = all.concat(rows); const oldest = rows[rows.length - 1].t;
    if (oldest <= stop || rows.length < 5000) break;
    end = new Date((oldest - 60) * 1000).toISOString().slice(0, 19).replace('T', ' ');
    await new Promise(r => setTimeout(r, 8000));            // free-plan rate limit
  }
  return all.filter(x => x.t >= stop).sort((x, y) => x.t - y.t);
}

/* ---- trade outcome in R: 50% off at TP1 (1R), stop to entry, rest to TP2 (2R); same-candle SL+TP counts as SL ---- */
function outcome(m, i, s) {
  const L = s.side === 'BUY', risk = Math.abs(s.entry - s.sl); let be = false, res = 'expired', raw = 0;
  for (let k = i + 1; k <= Math.min(m.length - 1, i + s.maxBars); k++) {
    const b = m[k], stop = be ? s.entry : s.sl, slHit = L ? b.l <= stop : b.h >= stop;
    if (slHit) { raw = be ? 0.5 : -1; res = be ? 'be' : 'sl'; break; }
    if (!be && (L ? b.h >= s.tp1 : b.l <= s.tp1)) { be = true; if (L ? b.h >= s.tp2 : b.l <= s.tp2) { raw = 1.5; res = 'tp2'; break; } continue; }
    if (be && (L ? b.h >= s.tp2 : b.l <= s.tp2)) { raw = 1.5; res = 'tp2'; break; }
  }
  if (res === 'expired') { const last = m[Math.min(m.length - 1, i + s.maxBars)].c, mv = (L ? last - s.entry : s.entry - last) / risk; raw = be ? 0.5 * 1 + 0.5 * Math.max(mv, 0) : Math.max(Math.min(mv, 1), -1); }
  return { res, R: raw - SPREAD / risk };
}

/* ---- statistics ---- */
const wilson = (w, n, z = 1.64) => { if (!n) return [0, 1]; const p = w / n, d = 1 + z * z / n, c = p + z * z / (2 * n), e = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); return [(c - e) / d, (c + e) / d]; };
const stat = rows => { const n = rows.length, w = rows.filter(r => r.R > 0).length, sum = rows.reduce((a, r) => a + r.R, 0), sd = Math.sqrt(rows.reduce((a, r) => a + (r.R - sum / (n || 1)) ** 2, 0) / Math.max(1, n - 1));
  return { n, win: n ? w / n : 0, avgR: n ? sum / n : 0, totR: sum, se: n > 1 ? sd / Math.sqrt(n) : 1 }; };
const bin = (v, edges, labels) => { for (let i = 0; i < edges.length; i++) if (v < edges[i]) return labels[i]; return labels[edges.length]; };
const FEATURES = {
  side: r => r.side,
  trigger: r => r.trigger,
  lvl: r => r.feat.lvl,
  conf: r => 'conf' + r.feat.conf,
  session: r => { const h = r.feat.hr; return h < 7 ? 'asia 00-07' : h < 13 ? 'london 07-13' : h < 17 ? 'ny-overlap 13-17' : h < 21 ? 'ny-late 17-21' : 'rollover 21-24'; },
  riskA: r => bin(r.feat.riskA, [.5, .8, 1.1], ['risk<0.5', 'risk.5-.8', 'risk.8-1.1', 'risk>1.1']),
  trend: r => bin(r.feat.str, [.6, 1.2, 2.2], ['trend<.6', 'trend.6-1.2', 'trend1.2-2.2', 'trend>2.2']),
  slope: r => bin(r.feat.slope, [.15, .35], ['slope<.15', 'slope.15-.35', 'slope>.35']),
  volR: r => bin(r.feat.volR, [.2, .3], ['M1vol<.2', 'M1vol.2-.3', 'M1vol>.3']),
  body: r => bin(r.feat.body, [.5, .75], ['body<.5', 'body.5-.75', 'body>.75']),
  dEma: r => bin(r.feat.dEma, [.8, 1.8], ['nearEMA', 'midEMA', 'farEMA']),
  room: r => r.feat.roomR == null ? 'room open' : bin(r.feat.roomR, [3, 5], ['room2-3R', 'room3-5R', 'room>5R']),
};
const f = (x, d = 2) => (x >= 0 ? '+' : '') + x.toFixed(d);
function table(rows, title) {
  console.log('\n' + title);
  for (const [name, fn] of Object.entries(FEATURES)) {
    const g = {}; rows.forEach(r => (g[fn(r)] = g[fn(r)] || []).push(r));
    for (const [k, v] of Object.entries(g).sort()) { const s = stat(v), lb = wilson(v.filter(r => r.R > 0).length, v.length)[0];
      console.log(`  ${name.padEnd(8)} ${k.padEnd(18)} n=${String(s.n).padStart(4)}  win ${(s.win * 100).toFixed(0).padStart(3)}% (≥${(lb * 100).toFixed(0)}%)  avg ${f(s.avgR)}R  total ${f(s.totR, 1)}R`); }
  }
}

/* ---- learn: block feature buckets that lose money with statistical confidence ---- */
function learn(rows, minN = 20) {
  const rules = [];
  for (const [name, fn] of Object.entries(FEATURES)) {
    const g = {}; rows.forEach(r => (g[fn(r)] = g[fn(r)] || []).push(r));
    for (const [k, v] of Object.entries(g)) { const s = stat(v);
      if (s.n >= minN && s.avgR + 1.28 * s.se < 0) rules.push({ feature: name, bucket: k, n: s.n, avgR: +s.avgR.toFixed(3) }); }   // upper 90% bound still negative
  }
  return rules;
}
const blocked = (r, rules) => rules.some(x => FEATURES[x.feature](r) === x.bucket);

(async () => {
  const AiEng = loadEngine();
  let m1;
  if (arg('csv')) m1 = readCsv(arg('csv')); else if (arg('td')) m1 = await fetchTwelve(arg('td'), +arg('days', 20)); else { console.error('give --csv <file> or --td <XAU/USD>'); process.exit(1); }
  if (arg('save')) { fs.mkdirSync(path.dirname(arg('save')), { recursive: true }); fs.writeFileSync(arg('save'), m1.map(x => [x.t, x.o, x.h, x.l, x.c].join(',')).join('\n')); }
  if (m1.length < 1500) throw new Error('need at least ~1500 M1 candles, got ' + m1.length);
  console.log(`${SYMBOL}: ${m1.length} M1 candles · ${new Date(m1[0].t * 1000).toISOString().slice(0, 16)} → ${new Date(m1[m1.length - 1].t * 1000).toISOString().slice(0, 16)} · spread ${SPREAD}`);

  const P = AiEng.prep(m1, null, MODE, SYMBOL), rows = []; let last = -99;
  for (let i = 120; i < m1.length - 1; i++) {
    const ev = AiEng.evalAt(P, i, () => true);               // news history is unknown offline: assume clear
    if (!ev.signal || i - last <= 10) continue; last = i;
    rows.push({ t: ev.signal.t, side: ev.signal.side, trigger: ev.signal.trigger, feat: ev.signal.feat, ...outcome(m1, i, { ...ev.signal }) });
  }
  if (!rows.length) { console.log('No A+ signals in this data.'); return; }
  const all = stat(rows), BE = 0;
  console.log(`\nALL A+ signals: n=${all.n} · win ${(all.win * 100).toFixed(1)}% · avg ${f(all.avgR)}R · total ${f(all.totR, 1)}R · results ${JSON.stringify(rows.reduce((a, r) => (a[r.res] = (a[r.res] || 0) + 1, a), {}))}`);
  if (arg('json')) { console.log(JSON.stringify(rows)); }

  const cut = Math.floor(rows.length * SPLIT), train = rows.slice(0, cut), test = rows.slice(cut);
  table(train, `TRAIN (older ${Math.round(SPLIT * 100)}%, n=${train.length})`);
  const rules = learn(train), tb = test.filter(r => blocked(r, rules)), tk = test.filter(r => !blocked(r, rules));
  console.log(`\nLEARNED BLOCK RULES (${rules.length}):`); rules.forEach(r => console.log(`  block ${r.feature} = ${r.bucket}   (train n=${r.n}, avg ${f(r.avgR)}R)`));
  const a = stat(test), b = stat(tk), c = stat(tb);
  console.log(`\nWALK-FORWARD on unseen TEST data (n=${test.length}):`);
  console.log(`  without rules: avg ${f(a.avgR)}R  total ${f(a.totR, 1)}R`);
  console.log(`  with rules:    avg ${f(b.avgR)}R  total ${f(b.totR, 1)}R  (kept ${b.n}, skipped ${c.n} that averaged ${f(c.avgR)}R)`);
  const holds = rules.length && b.n >= 15 && b.avgR > a.avgR && b.avgR > 0 && c.avgR < 0;   // must keep a real sample AND be profitable, not just block everything
  console.log(holds ? '  ✓ rules improved unseen data' : '  ✗ rules did NOT clearly help unseen data (blocked almost everything, or still not profitable) — do not deploy them');
  if (arg('out') && holds) { fs.writeFileSync(arg('out'), JSON.stringify({ symbol: SYMBOL, learned: new Date().toISOString(), trades: rows.length, rules }, null, 2)); console.log('  wrote ' + arg('out')); }
  console.log('\nExpectancy (avg R after spread) is what matters, not win-rate. Fewer than ~100 trades is mostly noise: re-run as the tracker fills up.');
})().catch(e => { console.error('error:', e.message); process.exit(1); });
