// Vercel serverless function: real M5 candles for the AI Signal Analysis panel.
// Provider 1: Twelve Data (spot XAU/USD) when TWELVEDATA_API_KEY is set in Vercel → Settings → Environment Variables.
// Provider 2 (fallback): Yahoo Finance COMEX gold futures (GC=F) — futures trade a few dollars above spot.
// Nothing is generated here: if both providers fail, the endpoint returns an error and the page shows "no data".
const SYMBOLS = {
  XAUUSD: {td: 'XAU/USD', yahoo: 'GC=F', yahooName: 'COMEX Gold futures (GC=F)'},
  XAGUSD: {td: 'XAG/USD', yahoo: 'SI=F', yahooName: 'COMEX Silver futures (SI=F)'},
  EURUSD: {td: 'EUR/USD', yahoo: 'EURUSD=X', yahooName: 'EUR/USD spot (Yahoo)'},
  GBPUSD: {td: 'GBP/USD', yahoo: 'GBPUSD=X', yahooName: 'GBP/USD spot (Yahoo)'},
  USDJPY: {td: 'USD/JPY', yahoo: 'JPY=X',    yahooName: 'USD/JPY spot (Yahoo)'},
  NQ:     {td: null,      yahoo: 'NQ=F',     yahooName: 'Nasdaq 100 E-mini futures (NQ=F)'},
  OIL:    {td: null,      yahoo: 'CL=F',     yahooName: 'WTI crude futures (CL=F)'},
};

// ?tf=1 (scalping v3, M1) · 5 (M5) · 15 (intraday) · 60 (swing)
const TF = {
  1:  {step: 60,   td: '1min',  yi: '1m',  yr: '5d',  keep: 2000},
  5:  {step: 300,  td: '5min',  yi: '5m',  yr: '5d',  keep: 1000},
  15: {step: 900,  td: '15min', yi: '15m', yr: '30d', keep: 1500},
  60: {step: 3600, td: '1h',    yi: '60m', yr: '1y',  keep: 2400},
};
async function fromTwelveData(sym, key, tf) {
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym.td)}&interval=${tf.td}&outputsize=${tf.keep}&timezone=UTC&order=ASC&apikey=${key}`;
  const r = await fetch(url, {headers: {'User-Agent': 'arom-trade/1.0'}});
  const j = await r.json();
  if (!r.ok || j.status === 'error' || !Array.isArray(j.values)) throw new Error('twelvedata: ' + (j.message || r.status));
  const candles = j.values.map(v => ({
    t: Math.floor(Date.parse(v.datetime.replace(' ', 'T') + 'Z') / 1000),
    o: +v.open, h: +v.high, l: +v.low, c: +v.close,
  })).filter(x => isFinite(x.t) && isFinite(x.c));
  return {source: 'Twelve Data · ' + sym.td + ' spot', delayed: false, candles};
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
    if ([o, h, l, c].every(v => v != null && isFinite(v))) candles.push({t, o, h, l, c});
  });
  return {source: 'Yahoo Finance · ' + sym.yahooName, delayed: true, candles};
}

module.exports = async (req, res) => {
  const key = String((req.query && req.query.symbol) || 'XAUUSD').toUpperCase();
  const sym = SYMBOLS[key];
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (!sym) return res.status(400).json({error: 'unsupported symbol'});
  const tfKey = String((req.query && req.query.tf) || '5'), tf = TF[tfKey];
  if (!tf) return res.status(400).json({error: 'unsupported tf (1, 5, 15 or 60)'});
  // cache until just after the next 5-minute candle closes, so every visitor shares one upstream call per candle
  const now = Math.floor(Date.now() / 1000), next = Math.ceil((now + 1) / tf.step) * tf.step + 20;
  const errors = [];
  const tdKey = process.env.TWELVEDATA_API_KEY;
  const providers = tdKey && sym.td ? [() => fromTwelveData(sym, tdKey, tf), () => fromYahoo(sym, tf)] : [() => fromYahoo(sym, tf)];
  for (const p of providers) {
    try {
      const out = await p();
      // keep only whole 5-minute candles (Yahoo appends a live partial bar stamped with its last tick time)
      out.candles = out.candles.filter(c => c.t % tf.step === 0);
      // drop the candle that is still forming
      const last = out.candles[out.candles.length - 1];
      if (last && last.t + tf.step > now) out.candles.pop();
      out.candles = out.candles.slice(-tf.keep);
      if (out.candles.length < 300) throw new Error('not enough candles (' + out.candles.length + ')');
      res.setHeader('Cache-Control', `public, s-maxage=${Math.max(30, Math.min(next - now, 900))}, stale-while-revalidate=60`);
      return res.status(200).json({symbol: key, tf: +tfKey, ...out, fetchedAt: now});
    } catch (e) { errors.push(String(e.message || e)); }
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.status(502).json({error: 'no market data', details: errors});
};
