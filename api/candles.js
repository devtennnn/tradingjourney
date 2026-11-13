// Vercel serverless function: real M5 candles for the AI Signal Analysis panel.
// Provider 1: Twelve Data (spot XAU/USD) when TWELVEDATA_API_KEY is set in Vercel → Settings → Environment Variables.
// Provider 2 (fallback): Yahoo Finance COMEX gold futures (GC=F) — futures trade a few dollars above spot.
// Nothing is generated here: if both providers fail, the endpoint returns an error and the page shows "no data".
const SYMBOLS = {
  XAUUSD: {td: 'XAU/USD', yahoo: 'GC=F', yahooName: 'COMEX Gold futures (GC=F)'},
  XAGUSD: {td: 'XAG/USD', yahoo: 'SI=F', yahooName: 'COMEX Silver futures (SI=F)'},
};

async function fromTwelveData(sym, key) {
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym.td)}&interval=5min&outputsize=1000&timezone=UTC&order=ASC&apikey=${key}`;
  const r = await fetch(url, {headers: {'User-Agent': 'arom-trade/1.0'}});
  const j = await r.json();
  if (!r.ok || j.status === 'error' || !Array.isArray(j.values)) throw new Error('twelvedata: ' + (j.message || r.status));
  const candles = j.values.map(v => ({
    t: Math.floor(Date.parse(v.datetime.replace(' ', 'T') + 'Z') / 1000),
    o: +v.open, h: +v.high, l: +v.low, c: +v.close,
  })).filter(x => isFinite(x.t) && isFinite(x.c));
  return {source: 'Twelve Data · ' + sym.td + ' spot', delayed: false, candles};
}

async function fromYahoo(sym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym.yahoo)}?interval=5m&range=5d&includePrePost=true`;
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
  // cache until just after the next 5-minute candle closes, so every visitor shares one upstream call per candle
  const now = Math.floor(Date.now() / 1000), next = Math.ceil((now + 1) / 300) * 300 + 20;
  const errors = [];
  const tdKey = process.env.TWELVEDATA_API_KEY;
  const providers = tdKey ? [() => fromTwelveData(sym, tdKey), () => fromYahoo(sym)] : [() => fromYahoo(sym)];
  for (const p of providers) {
    try {
      const out = await p();
      // keep only whole 5-minute candles (Yahoo appends a live partial bar stamped with its last tick time)
      out.candles = out.candles.filter(c => c.t % 300 === 0);
      // drop the candle that is still forming
      const last = out.candles[out.candles.length - 1];
      if (last && last.t + 300 > now) out.candles.pop();
      if (out.candles.length < 300) throw new Error('not enough candles (' + out.candles.length + ')');
      res.setHeader('Cache-Control', `public, s-maxage=${Math.max(30, next - now)}, stale-while-revalidate=60`);
      return res.status(200).json({symbol: key, ...out, fetchedAt: now});
    } catch (e) { errors.push(String(e.message || e)); }
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.status(502).json({error: 'no market data', details: errors});
};
