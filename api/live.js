// Vercel serverless function: GET /api/live?symbol=XAUUSD[&debug=1]
// Real-time feed for the AI terminal: the last ~2 hours of 1-minute candles from Yahoo Finance,
// used by the page to build the candle that is still forming (5m / 15m) and the live price.
// Cached 2 s on the CDN (the page polls every 2 s) so every viewer shares one upstream call. Nothing is generated here.
//
// Gold and silver have two Yahoo feeds: COMEX futures (GC=F / SI=F, can run ~10 minutes behind and trade at a premium to spot)
// and spot (XAUUSD=X / XAGUSD=X, the same kind of price the broker and the candles show). Both are fetched and the FRESHER one is used,
// as long as it is sane (within 3 % of the other). If the spot feed is empty, stale or odd, the futures feed is used exactly as before.
const SYMBOLS = {XAUUSD: 'GC=F', XAGUSD: 'SI=F', EURUSD: 'EURUSD=X', GBPUSD: 'GBPUSD=X', USDJPY: 'JPY=X', NQ: 'NQ=F', OIL: 'CL=F', BTCUSD: 'BTC-USD'};
const SPOT = {XAUUSD: 'XAUUSD=X', XAGUSD: 'XAGUSD=X'};
// Real spot gold / silver (Yahoo has no spot feed: XAUUSD=X is 404). gold-api.com is a free, key-less public price API: unofficial, no uptime guarantee,
// so it is used for the headline PRICE only, checked against futures, and dropped silently if it is stale, odd or down.
const GOLDAPI = {XAUUSD: 'XAU', XAGUSD: 'XAG'};
const UA = {'User-Agent': 'Mozilla/5.0 (compatible; arom-trade/1.0)', Accept: 'application/json'};
// Gold / silver: the Yahoo futures feed runs ~9-10 minutes late (measured 19 Nov: 562 s), so the forming candle on the terminal showed old prices.
// For these the 1-minute candles now come from our own /api/candles?tf=1 (Twelve Data spot, the same feed the signals use, real-time and
// CDN-cached, so this costs no extra Twelve Data credits), and the live price from gold-api.com spot when it is fresh and agrees.
// If that is unavailable, the old Yahoo logic below runs unchanged.
const TD_M1 = {XAUUSD: true, XAGUSD: true};
const SITE_ORIGIN = (process.env.SITE_ORIGIN || 'https://aromx.trade').replace(/\/+$/, '');

async function tdM1(origin, key, now) {
  const r = await fetch(`${origin}/api/candles?symbol=${key}&tf=1`, {headers: UA, signal: AbortSignal.timeout(4000)});
  if (!r.ok) throw new Error('candles ' + r.status);
  const j = await r.json();
  if (!/^Twelve Data/.test(j.source || '') || !Array.isArray(j.candles) || !j.candles.length) throw new Error('candles not Twelve Data');
  const m1 = j.candles.slice(-130).map(b => ({t: b.t, o: b.o, h: b.h, l: b.l, c: b.c})), last = m1[m1.length - 1], time = last.t + 60;
  if (now - time > 240) throw new Error('candles stale (' + (now - time) + ' s)');
  return {symbol: j.source.replace(/^Twelve Data · /, ''), source: j.source, price: last.c, time, lag: Math.max(0, now - time), m1, bars: m1.length};
}
/** live price for the Twelve Data feed: the spot API tick when it is fresher than the last closed candle and within 0.5 % of it */
function tdPrice(td, spot) {
  if (spot && spot.lag <= 90 && spot.time > td.time && Math.abs(spot.price - td.price) / td.price <= 0.005) return {price: spot.price, time: spot.time, lag: spot.lag};
  return {price: td.price, time: td.time, lag: td.lag};
}

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

async function goldApi(code, now) {
  const r = await fetch('https://api.gold-api.com/price/' + code, {headers: UA, signal: AbortSignal.timeout(3500)});
  if (!r.ok) throw new Error('gold-api ' + r.status);
  const j = await r.json(), price = Number(j.price), t = Date.parse(j.updatedAt);
  if (!isFinite(price) || price <= 0 || !isFinite(t)) throw new Error('gold-api bad data');
  const time = Math.floor(t / 1000);
  return {price, time, lag: Math.max(0, now - time), source: 'gold-api.com'};
}
/** spot is shown only if fresh (under 3 minutes) and within 1.5 % of the futures price (a normal futures premium is about 0.1-0.5 %) */
function spotOk(spot, fut) {
  if (!spot) return null;
  if (spot.lag > 180) return null;
  if (fut && Math.abs(spot.price - fut.price) / fut.price > 0.015) return null;
  return spot;
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
  if (TD_M1[key]) {
    // fixed origin: never build a server-side URL from a request header (this response is shared through the CDN cache)
    const [tdR, gaR] = await Promise.allSettled([tdM1(SITE_ORIGIN, key, now), goldApi(GOLDAPI[key], now)]);
    if (tdR.status === 'fulfilled') {
      const td = tdR.value, sp = gaR.status === 'fulfilled' ? gaR.value : null, p = tdPrice(td, sp);
      const body = {symbol: key, source: td.source, kind: 'spot', price: p.price, time: p.time, lag: p.lag, m1: td.m1, at: now};
      if (sp && sp.lag <= 180 && Math.abs(sp.price - td.price) / td.price <= 0.015) body.spot = sp;
      res.setHeader('Cache-Control', 'public, s-maxage=2, stale-while-revalidate=4');
      if (debug) { res.setHeader('Cache-Control', 'no-store'); body.m1 = undefined; body.bars = td.bars; body.why = 'Twelve Data 1-minute spot candles' + (p.price === td.price ? '' : ' + spot tick'); body.spot_api = sp; body.errors = gaR.status === 'rejected' ? ['gold-api: ' + gaR.reason.message] : []; }
      return res.status(200).json(body);
    }
    if (debug) res.setHeader('X-Live-Fallback', String(tdR.reason && tdR.reason.message || 'td failed').slice(0, 120));
  }
  try {
    const [futR, spotR, gaR] = await Promise.allSettled([yahoo(y, now), SPOT[key] ? yahoo(SPOT[key], now) : Promise.reject(new Error('no spot feed')), GOLDAPI[key] ? goldApi(GOLDAPI[key], now) : Promise.reject(new Error('no spot api'))]);
    const fut = futR.status === 'fulfilled' ? futR.value : null, spot = spotR.status === 'fulfilled' ? spotR.value : null;
    const pick = choose(fut, spot);
    if (!pick) throw new Error(futR.reason && futR.reason.message || 'no feed');
    const u = pick.use, spotUsed = u === spot && !!SPOT[key];
    res.setHeader('Cache-Control', 'public, s-maxage=2, stale-while-revalidate=4');
    const realSpot = spotOk(gaR.status === 'fulfilled' ? gaR.value : null, fut);
    const body = {symbol: key, source: 'Yahoo Finance · ' + u.symbol, kind: spotUsed ? 'spot' : (SPOT[key] ? 'futures' : 'market'), price: u.price, time: u.time, lag: u.lag, m1: u.m1, at: now};
    if (realSpot) body.spot = realSpot;   // the page shows this as the headline price; candles stay on the feed above
    if (debug) { res.setHeader('Cache-Control', 'no-store'); body.m1 = undefined; body.feeds = [fut && {name: 'futures', symbol: fut.symbol, price: fut.price, lag: fut.lag, bars: fut.bars}, spot && {name: 'spot', symbol: spot.symbol, price: spot.price, lag: spot.lag, bars: spot.bars}].filter(Boolean); body.chosen = u.symbol; body.why = pick.why; body.spot_api = gaR.status === 'fulfilled' ? gaR.value : null; body.errors = [gaR.status === 'rejected' && GOLDAPI[key] && 'gold-api: ' + gaR.reason.message, futR.status === 'rejected' && 'futures: ' + futR.reason.message, spotR.status === 'rejected' && SPOT[key] && 'spot: ' + spotR.reason.message].filter(Boolean); }
    return res.status(200).json(body);
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({error: String(e.message || e)});
  }
};
module.exports.choose = choose;
module.exports.spotOk = spotOk;
module.exports.tdPrice = tdPrice;
