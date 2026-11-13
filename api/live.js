// Vercel serverless function: GET /api/live?symbol=XAUUSD
// Real-time feed for the AI terminal: the last ~2 hours of 1-minute candles from Yahoo Finance,
// used by the page to build the candle that is still forming (5m / 15m) and the live price.
// Cached 4 s on the CDN so every viewer shares one upstream call. Nothing is generated here.
const SYMBOLS = {XAUUSD: 'GC=F', XAGUSD: 'SI=F', EURUSD: 'EURUSD=X', GBPUSD: 'GBPUSD=X', USDJPY: 'JPY=X', NQ: 'NQ=F', OIL: 'CL=F'};

module.exports = async (req, res) => {
  const key = String((req.query && req.query.symbol) || 'XAUUSD').toUpperCase();
  const y = SYMBOLS[key];
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (!y) return res.status(400).json({error: 'unsupported symbol'});
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(y)}?interval=1m&range=1d&includePrePost=true`,
      {headers: {'User-Agent': 'Mozilla/5.0 (compatible; arom-trade/1.0)', Accept: 'application/json'}});
    if (!r.ok) throw new Error('yahoo ' + r.status);
    const j = await r.json(), out = j && j.chart && j.chart.result && j.chart.result[0];
    if (!out || !out.timestamp) throw new Error('yahoo empty');
    const q = out.indicators.quote[0], m1 = [];
    out.timestamp.forEach((t, i) => {
      const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
      if ([o, h, l, c].every(v => v != null && isFinite(v))) m1.push({t: t - (t % 60), o, h, l, c});
    });
    const meta = out.meta || {};
    const price = isFinite(meta.regularMarketPrice) ? meta.regularMarketPrice : (m1.length ? m1[m1.length - 1].c : null);
    if (price == null) throw new Error('no price');
    res.setHeader('Cache-Control', 'public, s-maxage=4, stale-while-revalidate=8');
    return res.status(200).json({symbol: key, source: 'Yahoo Finance · ' + y, price, time: meta.regularMarketTime || null, m1: m1.slice(-130), at: Math.floor(Date.now() / 1000)});
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({error: String(e.message || e)});
  }
};
