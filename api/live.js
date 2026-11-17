// Vercel serverless function: GET /api/live?symbol=XAUUSD[&debug=1]
// Real-time feed for the AI terminal: the last ~2 hours of 1-minute candles from Yahoo Finance,
// used by the page to build the candle that is still forming (5m / 15m) and the live price.
// Cached 4 s on the CDN so every viewer shares one upstream call. Nothing is generated here.
//
// Gold and silver have two Yahoo feeds: COMEX futures (GC=F / SI=F, can run ~10 minutes behind and trade at a premium to spot)
// and spot (XAUUSD=X / XAGUSD=X, the same kind of price the broker and the candles show). Both are fetched and the FRESHER one is used,
// as long as it is sane (within 3 % of the other). If the spot feed is empty, stale or odd, the futures feed is used exactly as before.
const SYMBOLS = {XAUUSD: 'GC=F', XAGUSD: 'SI=F', EURUSD: 'EURUSD=X', GBPUSD: 'GBPUSD=X', USDJPY: 'JPY=X', NQ: 'NQ=F', OIL: 'CL=F', BTCUSD: 'BTC-USD'};
const SPOT = {XAUUSD: 'XAUUSD=X', XAGUSD: 'XAGUSD=X'};
const UA = {'User-Agent': 'Mozilla/5.0 (compatible; arom-trade/1.0)', Accept: 'application/json'};

async function yahoo(sym, now) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1m&range=1d&includePrePost=true`, {headers: UA});
  if (!r.ok) throw new Error('yahoo ' + r.status);
  const j = await r.json(), out = j && j.chart && j.chart.result && j.chart.result[0];
  if (!out || !out.timestamp) throw new Error('yahoo empty');
  const q = out.indicators.quote[0], m1 = [];
  out.timestamp.forEach((t, i) => {
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
    if ([o, h, l, c].every(v => v != null && isFinite(v))) m1.push({t: t - (t % 60), o, h, l, c});
  });
  const meta = out.meta || {}, lastBar = m1.length ? m1[m1.length - 1] : null;
  const price = isFinite(meta.regularMarketPrice) ? meta.regularMarketPrice : (lastBar ? lastBar.c : null);
  if (price == null) throw new Error('no price');
  // freshness = the newest sign of life: the exchange time Yahoo reports, or the last candle (+60 s because a candle is stamped at its start)
  const time = Math.max(isFinite(meta.regularMarketTime) ? meta.regularMarketTime : 0, lastBar ? lastBar.t + 60 : 0) || null;
  return {symbol: sym, price, time, lag: time ? Math.max(0, now - time) : null, m1: m1.slice(-130), bars: m1.length};
}

/** pick the feed to show: spot if it is clearly fresher than the futures and its price is sane next to the futures; otherwise the futures (the previous behaviour) */
function choose(fut, spot) {
  if (!fut && !spot) return null;
  if (!spot) return {use: fut, why: 'spot feed unavailable'};
  if (!fut) return {use: spot, why: 'futures feed unavailable'};
  if (Math.abs(spot.price - fut.price) / fut.price > 0.03) return {use: fut, why: 'spot price not plausible next to futures'};
  if (spot.lag == null) return {use: fut, why: 'spot feed has no timestamp'};
  if (fut.lag == null || spot.lag + 30 < fut.lag) return {use: spot, why: 'spot feed is fresher'};
  return {use: fut, why: 'futures feed is as fresh as spot'};
}

module.exports = async (req, res) => {
  const key = String((req.query && req.query.symbol) || 'XAUUSD').toUpperCase();
  const y = SYMBOLS[key];
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (!y) return res.status(400).json({error: 'unsupported symbol'});
  const now = Math.floor(Date.now() / 1000), debug = req.query && String(req.query.debug) === '1';
  try {
    const [futR, spotR] = await Promise.allSettled([yahoo(y, now), SPOT[key] ? yahoo(SPOT[key], now) : Promise.reject(new Error('no spot feed'))]);
    const fut = futR.status === 'fulfilled' ? futR.value : null, spot = spotR.status === 'fulfilled' ? spotR.value : null;
    const pick = choose(fut, spot);
    if (!pick) throw new Error(futR.reason && futR.reason.message || 'no feed');
    const u = pick.use, spotUsed = u === spot && !!SPOT[key];
    res.setHeader('Cache-Control', 'public, s-maxage=4, stale-while-revalidate=8');
    const body = {symbol: key, source: 'Yahoo Finance · ' + u.symbol, kind: spotUsed ? 'spot' : (SPOT[key] ? 'futures' : 'market'), price: u.price, time: u.time, lag: u.lag, m1: u.m1, at: now};
    if (debug) { res.setHeader('Cache-Control', 'no-store'); body.m1 = undefined; body.feeds = [fut && {name: 'futures', symbol: fut.symbol, price: fut.price, lag: fut.lag, bars: fut.bars}, spot && {name: 'spot', symbol: spot.symbol, price: spot.price, lag: spot.lag, bars: spot.bars}].filter(Boolean); body.chosen = u.symbol; body.why = pick.why; body.errors = [futR.status === 'rejected' && 'futures: ' + futR.reason.message, spotR.status === 'rejected' && SPOT[key] && 'spot: ' + spotR.reason.message].filter(Boolean); }
    return res.status(200).json(body);
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({error: String(e.message || e)});
  }
};
module.exports.choose = choose;
