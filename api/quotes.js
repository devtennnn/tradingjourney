// Vercel Serverless Function: GET /api/quotes
// Live Markets strip data: last price, change vs previous close and a small intraday sparkline
// for Gold, Silver, Nasdaq 100, WTI Oil (COMEX/CME/NYMEX front-month futures) and the US Dollar Index.
// Source: Yahoo Finance chart API (futures can be delayed by up to ~10 minutes). Cached 30 s on the CDN.
const SYMBOLS = [
  {key: 'XAU', name: 'Gold',       y: 'GC=F',     dp: 2},
  {key: 'XAG', name: 'Silver',     y: 'SI=F',     dp: 3},
  {key: 'NQ',  name: 'Nasdaq 100', y: 'NQ=F',     dp: 1},
  {key: 'OIL', name: 'WTI Oil',    y: 'CL=F',     dp: 2},
  {key: 'DXY', name: 'US Dollar',  y: 'DX-Y.NYB', dp: 3},
];

async function one(s) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s.y)}?interval=5m&range=1d&includePrePost=true`;
  const r = await fetch(url, {headers: {'User-Agent': 'Mozilla/5.0 (compatible; arom-trade/1.0)', Accept: 'application/json'}});
  if (!r.ok) throw new Error(s.y + ' ' + r.status);
  const j = await r.json(), res = j && j.chart && j.chart.result && j.chart.result[0];
  if (!res || !res.meta) throw new Error(s.y + ' empty');
  const m = res.meta;
  const closes = ((res.indicators && res.indicators.quote && res.indicators.quote[0].close) || []).filter(v => v != null && isFinite(v));
  const price = isFinite(m.regularMarketPrice) ? m.regularMarketPrice : closes[closes.length - 1];
  const prev = isFinite(m.chartPreviousClose) ? m.chartPreviousClose : (isFinite(m.previousClose) ? m.previousClose : null);
  if (!isFinite(price)) throw new Error(s.y + ' no price');
  const step = Math.max(1, Math.floor(closes.length / 40));
  const spark = closes.filter((_, i) => i % step === 0).slice(-40);
  return {key: s.key, name: s.name, symbol: s.y, dp: s.dp, price, prev,
    chg: prev ? price - prev : null, pct: prev ? (price - prev) / prev * 100 : null,
    spark, time: m.regularMarketTime || null};
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const out = await Promise.all(SYMBOLS.map(s => one(s).catch(e => ({key: s.key, name: s.name, error: String(e.message || e)}))));
  const ok = out.filter(x => !x.error).length;
  res.setHeader('Cache-Control', ok ? 'public, s-maxage=30, stale-while-revalidate=60' : 'no-store');
  return res.status(ok ? 200 : 502).json({source: 'Yahoo Finance (futures; may be delayed)', at: Math.floor(Date.now() / 1000), quotes: out});
};
