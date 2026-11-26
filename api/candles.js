// Vercel serverless function: real M5 candles for the AI Signal Analysis panel.
// Provider 1: Twelve Data (spot XAU/USD) when TWELVEDATA_API_KEY is set in Vercel → Settings → Environment Variables.
// Provider 2 (fallback): Yahoo Finance COMEX gold futures (GC=F) — futures trade a few dollars above spot.
// Nothing is generated here: if both providers fail, the endpoint returns an error and the page shows "no data".
// Provider 0 (since 26 Nov 2026): Binance public market data (free, real-time, no key) for Bitcoin (BTCUSDT) and gold (XAUT/USDT, Tether Gold,
// shifted to the spot price from gold-api.com so the levels sit where brokers quote). The free Twelve Data plan (800 credits a day) ran out every
// day from 20 Nov once the terminal asked it for 1-minute candles every minute, and everything fell back to Yahoo futures (~$26 above spot, ~10 min late).
const SYMBOLS = {
  XAUUSD: {td: 'XAU/USD', yahoo: 'GC=F', yahooName: 'COMEX Gold futures (GC=F)', bn: 'XAUTUSDT', spot: 'XAU'},
  XAGUSD: {td: 'XAG/USD', yahoo: 'SI=F', yahooName: 'COMEX Silver futures (SI=F)'},
  EURUSD: {td: 'EUR/USD', yahoo: 'EURUSD=X', yahooName: 'EUR/USD spot (Yahoo)'},
  GBPUSD: {td: 'GBP/USD', yahoo: 'GBPUSD=X', yahooName: 'GBP/USD spot (Yahoo)'},
  USDJPY: {td: 'USD/JPY', yahoo: 'JPY=X',    yahooName: 'USD/JPY spot (Yahoo)'},
  NQ:     {td: null,      yahoo: 'NQ=F',     yahooName: 'Nasdaq 100 E-mini futures (NQ=F)'},
  OIL:    {td: null,      yahoo: 'CL=F',     yahooName: 'WTI crude futures (CL=F)'},
  BTCUSD: {td: 'BTC/USD', yahoo: 'BTC-USD',  yahooName: 'Bitcoin (Yahoo BTC-USD)', bn: 'BTCUSDT'},
};

// ?tf=1 (scalping v3, M1) · 5 (M5) · 15 (intraday) · 60 (swing)
const TF = {
  1:  {step: 60,   td: '1min',  yi: '1m',  yr: '5d',  keep: 2000},
  5:  {step: 300,  td: '5min',  yi: '5m',  yr: '5d',  keep: 1000},
  15: {step: 900,  td: '15min', yi: '15m', yr: '30d', keep: 1500},
  60: {step: 3600, td: '1h',    yi: '60m', yr: '1y',  keep: 2400},
};
// Market hours (New York time, so daylight saving is handled): Twelve Data's XAU/USD feed keeps printing tiny candles while gold is closed
// (measured over 100 days of H1: 29 % of the candles, average range $0.26 against $15.42 on a weekday). Those candles drag ATR, EMAs and the
// daily filter down; a 2-year gold backtest of Swing breakout-retest fell from +0.33R to +0.14R per trade with them in. They are removed here.
//   metals / index / oil (CME): closed Fri 17:00 -> Sun 18:00 New York, plus the daily 17:00-18:00 break
//   forex: closed Fri 17:00 -> Sun 17:00 New York      crypto: never closed
const NY = new Intl.DateTimeFormat('en-US', {timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', hourCycle: 'h23'});
const KIND = {XAUUSD: 'cme', XAGUSD: 'cme', NQ: 'cme', OIL: 'cme', EURUSD: 'fx', GBPUSD: 'fx', USDJPY: 'fx', BTCUSD: 'crypto'};
function marketClosed(key, t) {
  const kind = KIND[key]; if (!kind || kind === 'crypto') return false;
  const p = NY.formatToParts(new Date(t * 1000)), wd = p.find(x => x.type === 'weekday').value, h = +p.find(x => x.type === 'hour').value;
  if (wd === 'Sat') return true;
  if (wd === 'Fri' && h >= 17) return true;
  if (wd === 'Sun') return h < (kind === 'fx' ? 17 : 18);
  return kind === 'cme' && h === 17;
}

async function fromTwelveData(sym, key, tf) {
  // always the maximum (same cost per call): after a weekend most of the last 3000 minute candles are closed-market ones and are dropped
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym.td)}&interval=${tf.td}&outputsize=5000&timezone=UTC&order=ASC&apikey=${key}`;
  const r = await fetch(url, {headers: {'User-Agent': 'arom-trade/1.0'}});
  const j = await r.json();
  if (!r.ok || j.status === 'error' || !Array.isArray(j.values)) throw new Error('twelvedata: ' + (j.message || r.status));
  const candles = j.values.map(v => ({
    t: Math.floor(Date.parse(v.datetime.replace(' ', 'T') + 'Z') / 1000),
    o: +v.open, h: +v.high, l: +v.low, c: +v.close, v: +v.volume || 0,
  })).filter(x => isFinite(x.t) && isFinite(x.c));
  return {source: 'Twelve Data · ' + sym.td + ' spot', delayed: false, candles};
}

const BN_IV = {60: '1m', 300: '5m', 900: '15m', 3600: '1h'};
async function fromBinance(sym, tf, want) {
  const iv = BN_IV[tf.step]; if (!iv) throw new Error('binance: no interval');
  let out = [], end = null;
  for (let page = 0; page < 6 && out.length < want; page++) {   // 1000 candles per call, newest first by paging back with endTime
    const url = `https://data-api.binance.vision/api/v3/klines?symbol=${sym.bn}&interval=${iv}&limit=1000` + (end ? `&endTime=${end}` : '');
    const r = await fetch(url, {headers: {'User-Agent': 'arom-trade/1.0'}, signal: AbortSignal.timeout(8000)});
    if (!r.ok) throw new Error('binance: ' + r.status);
    const rows = await r.json(); if (!Array.isArray(rows) || !rows.length) break;
    out = rows.map(k => ({t: Math.floor(k[0] / 1000), o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] || 0})).concat(out);
    end = rows[0][0] - 1; if (rows.length < 1000) break;
  }
  if (!out.length) throw new Error('binance: empty');
  let source = 'Binance · ' + sym.bn.replace('USDT', '/USDT');
  if (sym.spot) {   // gold token -> spot: shift every candle by (spot now - token now). Without a fresh, sane spot tick the token prices are used as they are.
    try {
      const r = await fetch('https://api.gold-api.com/price/' + sym.spot, {signal: AbortSignal.timeout(3500)}); const j = await r.json();
      const spot = Number(j.price), age = Date.now() / 1000 - Date.parse(j.updatedAt) / 1000, last = out[out.length - 1].c, d = spot - last;
      if (isFinite(spot) && age < 180 && Math.abs(d) / last < 0.015) { out = out.map(b => ({...b, o: b.o + d, h: b.h + d, l: b.l + d, c: b.c + d})); source += ' shifted to spot (gold-api.com, ' + (d >= 0 ? '+' : '') + d.toFixed(2) + ')'; }
      else source += ' (not shifted to spot)';
    } catch (e) { source += ' (not shifted to spot)'; }
  }
  return {source, delayed: false, candles: out};
}

async function fromYahoo(sym, tf) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym.yahoo)}?interval=${tf.yi}&range=${tf.yr}&includePrePost=true`;
  const r = await fetch(url, {headers: {'User-Agent': 'Mozilla/5.0 (compatible; arom-trade/1.0)', 'Accept': 'application/json'}});
  if (!r.ok) throw new Error('yahoo: ' + r.status);
  const j = await r.json();
  const res = j && j.chart && j.chart.result && j.chart.result[0];
  if (!res || !res.timestamp) throw new Error('yahoo: empty');
  const q = res.indicators.quote[0], candles = [];
  res.timestamp.forEach((t, i) => {
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
    if ([o, h, l, c].every(v => v != null && isFinite(v))) candles.push({t, o, h, l, c, v: Number(q.volume && q.volume[i]) || 0});
  });
  return {source: 'Yahoo Finance · ' + sym.yahooName, delayed: true, candles};
}

module.exports = async (req, res) => {
  const key = String((req.query && req.query.symbol) || 'XAUUSD').toUpperCase();
  const sym = SYMBOLS[key];
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (!sym) return res.status(400).json({error: 'unsupported symbol'});
  const tfKey = String((req.query && req.query.tf) || '5'), tf = TF[tfKey];
  // full=1 (Replay mode): every candle the provider returned (up to 5000) instead of the recent window; same upstream call, its own CDN cache entry
  const full = String((req.query && req.query.full) || '') === '1';
  if (!tf) return res.status(400).json({error: 'unsupported tf (1, 5, 15 or 60)'});
  // The CDN cache key is the whole URL. Send any other spelling (extra params, other order, lower case) to the one canonical URL,
  // so random query strings cannot skip the cache and spend Twelve Data credits on every request.
  const q = req.query || {}, canon = 'symbol=' + key + ('tf' in q ? '&tf=' + tfKey : '') + (full ? '&full=1' : '');
  const raw = String(req.url || '').split('?')[1] || '';
  if (req.url && raw !== canon) {   // (the AWS Lambda wrapper passes no url and keys its own cache)
    res.setHeader('Cache-Control', 'public, s-maxage=86400');
    res.setHeader('Location', '/api/candles?' + canon);
    return res.status(308).end();
  }
  // cache until just after the next 5-minute candle closes, so every visitor shares one upstream call per candle
  const now = Math.floor(Date.now() / 1000), next = Math.ceil((now + 1) / tf.step) * tf.step + 20;
  const errors = [];
  const tdKey = process.env.TWELVEDATA_API_KEY;
  const providers = (tdKey && sym.td ? [() => fromTwelveData(sym, tdKey, tf), () => fromYahoo(sym, tf)] : [() => fromYahoo(sym, tf)]);
  if (sym.bn) providers.unshift(() => fromBinance(sym, tf, full ? 5000 : tf.keep + 20));
  for (const p of providers) {
    try {
      const out = await p();
      // keep only whole 5-minute candles (Yahoo appends a live partial bar stamped with its last tick time)
      out.candles = out.candles.filter(c => c.t % tf.step === 0 && !marketClosed(key, c.t));
      // drop the candle that is still forming
      const last = out.candles[out.candles.length - 1];
      if (last && last.t + tf.step > now) out.candles.pop();
      if (!full) out.candles = out.candles.slice(-tf.keep);
      if (out.candles.length < 300) throw new Error('not enough candles (' + out.candles.length + ')');
      res.setHeader('Cache-Control', full ? 'public, s-maxage=1800, stale-while-revalidate=600' : `public, s-maxage=${Math.max(30, Math.min(next - now, 900))}, stale-while-revalidate=60`);
      return res.status(200).json({symbol: key, tf: +tfKey, ...out, fetchedAt: now});
    } catch (e) { errors.push(String(e.message || e)); }
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.status(502).json({error: 'no market data', details: errors});
};

module.exports.marketClosed = marketClosed;
