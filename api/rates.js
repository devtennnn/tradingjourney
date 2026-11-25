// Vercel Serverless Function: GET /api/rates
// One call for the /rates page: precious metals (gold, silver, platinum in USD per troy ounce, COMEX / NYMEX front-month futures from Yahoo Finance),
// exchange rates against the US dollar (open.er-api.com, updated daily) and pump fuel prices (api/_lib/fuel.json, edited by hand: no public source).
// Every part fails on its own: the page shows what it got and says so for the rest. Cached 2 minutes on the CDN.
const METALS = [{id: 'gold', y: 'GC=F'}, {id: 'silver', y: 'SI=F'}, {id: 'platinum', y: 'PL=F'}];
const CCY = ['KHR', 'THB', 'VND', 'CNY', 'JPY', 'EUR', 'GBP', 'SGD', 'AUD', 'KRW', 'MYR'];
const OZ_G = 31.1034768;

async function metal(m) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(m.y)}?interval=15m&range=1d&includePrePost=true`,
    {headers: {'User-Agent': 'Mozilla/5.0 (compatible; arom-trade/1.0)', Accept: 'application/json'}, signal: AbortSignal.timeout(8000)});
  if (!r.ok) throw new Error(m.y + ' ' + r.status);
  const j = await r.json(), res = j && j.chart && j.chart.result && j.chart.result[0];
  if (!res || !res.meta) throw new Error(m.y + ' empty');
  const closes = ((res.indicators && res.indicators.quote && res.indicators.quote[0].close) || []).filter(v => v != null && isFinite(v));
  const price = isFinite(res.meta.regularMarketPrice) ? res.meta.regularMarketPrice : closes[closes.length - 1];
  const prev = isFinite(res.meta.chartPreviousClose) ? res.meta.chartPreviousClose : null;
  if (!isFinite(price)) throw new Error(m.y + ' no price');
  const step = Math.max(1, Math.floor(closes.length / 36));
  return {id: m.id, usdOz: +price.toFixed(2), usdG: +(price / OZ_G).toFixed(2), prev: prev == null ? null : +prev.toFixed(2),
    chg: prev ? +((price / prev - 1) * 100).toFixed(2) : null, spark: closes.filter((_, i) => i % step === 0).slice(-36).map(v => +v.toFixed(2)),
    t: res.meta.regularMarketTime || null};
}

async function fx() {
  const r = await fetch('https://open.er-api.com/v6/latest/USD', {headers: {Accept: 'application/json'}, signal: AbortSignal.timeout(8000)});
  if (!r.ok) throw new Error('fx ' + r.status);
  const j = await r.json();
  if (!j || j.result !== 'success' || !j.rates || !isFinite(j.rates.KHR)) throw new Error('fx empty');
  const rates = {USD: 1}; CCY.forEach(c => { if (isFinite(j.rates[c])) rates[c] = j.rates[c]; });
  return {base: 'USD', rates, updated: j.time_last_update_utc || null};
}

function fuel() {
  try { const j = require('./_lib/fuel.json'); return {updated: j.updated, unit: j.unit, items: j.items}; }
  catch (e) { return null; }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=600');
  const [m, f] = await Promise.allSettled([Promise.allSettled(METALS.map(metal)), fx()]);
  const metals = m.status === 'fulfilled' ? m.value.filter(x => x.status === 'fulfilled').map(x => x.value) : [];
  res.status(200).json({ok: true, metals, fx: f.status === 'fulfilled' ? f.value : null, fuel: fuel(), now: Math.floor(Date.now() / 1000),
    source: {metals: 'COMEX / NYMEX front-month futures (Yahoo Finance), delayed up to ~10 minutes', fx: 'open.er-api.com'}});
};
