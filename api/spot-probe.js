// TEMPORARY diagnostic (to be deleted): which free sources serve spot gold, how fresh. GET /api/spot-probe
const T = (ms) => AbortSignal.timeout(ms);
const UA = {'User-Agent': 'Mozilla/5.0 (compatible; arom-trade/1.0)', Accept: '*/*'};
async function get(name, url, parse) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, {headers: UA, signal: T(7000)}), txt = await r.text();
    let parsed = null; try { parsed = parse ? parse(txt) : null; } catch (e) { parsed = 'parse error: ' + e.message; }
    return {name, status: r.status, ms: Date.now() - t0, parsed, head: txt.slice(0, 220)};
  } catch (e) { return {name, error: String(e.message || e), ms: Date.now() - t0}; }
}
const yh = (sym) => (txt) => { const j = JSON.parse(txt), m = j.chart.result[0].meta; return {price: m.regularMarketPrice, time: m.regularMarketTime, lag: Math.floor(Date.now() / 1000) - m.regularMarketTime, type: m.instrumentType, ex: m.exchangeName}; };
module.exports = async (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  const out = await Promise.all([
    get('yahoo XAU=X', 'https://query1.finance.yahoo.com/v8/finance/chart/XAU=X?interval=1m&range=1d', yh()),
    get('yahoo GLD', 'https://query1.finance.yahoo.com/v8/finance/chart/GLD?interval=1m&range=1d', yh()),
    get('yahoo GC=F (reference)', 'https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=1m&range=1d', yh()),
    get('stooq xauusd', 'https://stooq.com/q/l/?s=xauusd&f=sd2t2ohlcv&h&e=csv', (t) => t.trim().split('\n').slice(0, 2)),
    get('gold-api XAU', 'https://api.gold-api.com/price/XAU', (t) => JSON.parse(t)),
    get('swissquote XAU/USD', 'https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD', (t) => { const j = JSON.parse(t); const p = j[0] && j[0].spreadProfilePrices && j[0].spreadProfilePrices[0]; return {topo: j[0] && j[0].topo, ts: j[0] && j[0].ts, lag: j[0] && j[0].ts ? Math.floor(Date.now() / 1000 - j[0].ts / 1000) : null, bid: p && p.bid, ask: p && p.ask}; }),
    get('binance PAXGUSDT (gold token, not spot)', 'https://api.binance.com/api/v3/ticker/price?symbol=PAXGUSDT', (t) => JSON.parse(t)),
  ]);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({now, results: out});
};
