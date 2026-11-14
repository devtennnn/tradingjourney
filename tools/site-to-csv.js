#!/usr/bin/env node
/* Export the candles YOUR LIVE BOT trades on (your own /api/candles) to CSV for tools/backtest.js, explore.js and sweep.js.
   node tools/site-to-csv.js XAUUSD > data/xau_site.csv        (run it on your computer; M1 history is ~2000 candles per call, run it daily and append) */
const sym = (process.argv[2] || 'XAUUSD').toUpperCase(), site = process.env.SITE_URL || 'https://truetradejourney.vercel.app';
fetch(`${site}/api/candles?symbol=${sym}&tf=1`).then(r => r.json()).then(j => {
  if (!Array.isArray(j.candles)) throw new Error(j.error || 'no candles'); console.error(`${j.candles.length} candles · ${j.source}`);
  console.log(j.candles.map(c => [c.t, c.o, c.h, c.l, c.c].join(',')).join('\n'));
}).catch(e => { console.error('error:', e.message); process.exit(1); });
