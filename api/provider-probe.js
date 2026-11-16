// Vercel serverless function: GET /api/provider-probe[?providers=twelvedata,finnhub,siftingio,alphavantage,marketaux]
// ADMIN ONLY diagnostic. Tests what each market-data / news provider really returns for the AROM TRADE watchlist with the keys
// stored in Vercel (they never leave the server): which symbols work, how fresh the last price/candle is (real-time vs delayed),
// how many candles come back, latency and the error kind (plan/entitlement, rate limit, unknown symbol).
// It uses a few calls per provider (Alpha Vantage free allows only 25 a day, so it gets ~6). No prices are stored or fabricated.
// Auth: send the signed-in admin's Supabase access token:  Authorization: Bearer <access_token>.
const SB_URL = (process.env.SUPABASE_URL || 'https://sksvwikfyrdhgjngekqp.supabase.co').replace(/\/$/, '');
const SB_ANON = process.env.SUPABASE_ANON_KEY || 'sb_publishable_9HxgkobAgQtKb2Jx8dkX-A_DxWy_m6e';

// watchlist: internal symbol -> how each provider names it
const WATCH = [
  { s: 'XAUUSD', cls: 'metal',  td: 'XAU/USD', fh: 'OANDA:XAU_USD', fhk: 'forex',  av: ['XAU', 'USD'], sf: ['commodities', ['XAUUSD', 'XAU', 'GOLD']] },
  { s: 'XAGUSD', cls: 'metal',  td: 'XAG/USD', fh: 'OANDA:XAG_USD', fhk: 'forex',  av: ['XAG', 'USD'], sf: ['commodities', ['XAGUSD', 'XAG', 'SILVER']] },
  { s: 'EURUSD', cls: 'forex',  td: 'EUR/USD', fh: 'OANDA:EUR_USD', fhk: 'forex',  av: ['EUR', 'USD'], sf: ['forex', ['EURUSD']] },
  { s: 'GBPUSD', cls: 'forex',  td: 'GBP/USD', fh: 'OANDA:GBP_USD', fhk: 'forex',  sf: ['forex', ['GBPUSD']] },
  { s: 'USDJPY', cls: 'forex',  td: 'USD/JPY', fh: 'OANDA:USD_JPY', fhk: 'forex',  sf: ['forex', ['USDJPY']] },
  { s: 'AUDUSD', cls: 'forex',  td: 'AUD/USD', fh: 'OANDA:AUD_USD', fhk: 'forex',  sf: ['forex', ['AUDUSD']] },
  { s: 'BTCUSD', cls: 'crypto', td: 'BTC/USD', fh: 'BINANCE:BTCUSDT', fhk: 'crypto', av: ['BTC', 'USD'], sf: ['crypto', ['BTCUSD', 'BTC']] },
  { s: 'ETHUSD', cls: 'crypto', td: 'ETH/USD', fh: 'BINANCE:ETHUSDT', fhk: 'crypto', sf: ['crypto', ['ETHUSD', 'ETH']] },
  { s: 'NAS100', cls: 'index',  td: 'NDX',     fh: '^NDX',  fhk: 'quote', avs: 'QQQ', sf: ['indices', ['NAS100', 'NDX', 'IXIC']] },
  { s: 'US30',   cls: 'index',  td: 'DJI',     fh: '^DJI',  fhk: 'quote', sf: ['indices', ['US30', 'DJI', 'DJIA']] },
  { s: 'SPX500', cls: 'index',  td: 'SPX',     fh: '^GSPC', fhk: 'quote', avs: 'SPY', sf: ['indices', ['SPX500', 'SPX', 'GSPC']] },
  { s: 'GER40',  cls: 'index',  td: 'DAX',     fh: '^GDAXI', fhk: 'quote', sf: ['indices', ['GER40', 'DAX', 'GDAXI']] },
  { s: 'AAPL',   cls: 'equity', td: 'AAPL',    fh: 'AAPL',  fhk: 'quote', avs: 'AAPL', sf: ['stocks', ['AAPL']] },
];
const KEYS = () => ({ twelvedata: process.env.TWELVEDATA_API_KEY, finnhub: process.env.FINNHUB_API_KEY, siftingio: process.env.SIFTINGIO_API_KEY, alphavantage: process.env.ALPHAVANTAGE_API_KEY, marketaux: process.env.MARKETAUX_API_KEY });

const redact = (s) => { let t = String(s == null ? '' : s); for (const k of Object.values(KEYS())) if (k && k.length > 5) t = t.split(k).join('***'); return t.replace(/(apikey|api_token|token)=[^&\s"]+/gi, '$1=***').slice(0, 160); };
const ageSec = (ts) => (ts ? Math.max(0, Math.round((Date.now() - ts) / 1000)) : null);
const fresh = (age) => (age == null ? 'unknown' : age <= 120 ? 'real-time (<2 min)' : age <= 1200 ? 'slightly old (<20 min)' : age <= 3 * 3600 ? 'delayed or market closed (<3 h)' : 'stale (>3 h)');

async function call(url, headers, ms = 12000) {
  const t0 = Date.now(), c = new AbortController(), id = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'arom-probe/1.0', Accept: 'application/json', ...(headers || {}) }, signal: c.signal });
    const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch (_) { /* not JSON */ }
    return { status: r.status, j, ms: Date.now() - t0, text: j ? '' : redact(text) };
  } catch (e) { return { status: 0, j: null, ms: Date.now() - t0, text: e && e.name === 'AbortError' ? 'timeout' : 'network error' }; }
  finally { clearTimeout(id); }
}
/** one result row; never contains keys or raw provider payloads */
const row = (provider, symbol, what, o) => ({ provider, symbol, test: what, ok: !!o.ok, status: o.status ?? null, ms: o.ms ?? null, n: o.n ?? null, last_ts: o.ts ? new Date(o.ts).toISOString() : null, age_s: o.ts ? ageSec(o.ts) : null, freshness: o.ts ? fresh(ageSec(o.ts)) : null, price: o.price ?? null, note: o.note ? redact(o.note) : null });
const errKind = (r, msg) => { const m = String(msg || '').toLowerCase(); if (r.status === 429 || /rate limit|too many|per minute|credits|frequency|25 requests|call frequency/.test(m)) return 'rate limit / quota'; if (r.status === 401 || /invalid.*(key|token)|unauthor|apikey/.test(m)) return 'key rejected'; if (r.status === 402 || r.status === 403 || /plan|premium|upgrade|subscription|access to this resource|not available|entitle/.test(m)) return 'not included in this plan'; if (r.status === 404 || /not found|invalid.*symbol|unknown|no data/.test(m)) return 'symbol not found'; return r.status ? 'http ' + r.status : r.text; };
const sleep = (ms) => new Promise((r) => setTimeout(r, process.env.PROBE_FAST ? 0 : ms));

/* ---------------- providers ---------------- */
async function twelvedata(key, out) {
  for (const w of WATCH) {
    const r = await call(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(w.td)}&interval=5min&outputsize=30&timezone=UTC&order=DESC&apikey=${key}`);
    const v = r.j && Array.isArray(r.j.values) ? r.j.values : null;
    if (v && v.length) { const ts = Date.parse(v[0].datetime.replace(' ', 'T') + 'Z'); out.push(row('twelvedata', w.s, 'M5 candles', { ok: true, status: r.status, ms: r.ms, n: v.length, ts, price: +v[0].close, note: r.j.meta && r.j.meta.exchange ? 'exchange ' + r.j.meta.exchange : '' })); }
    else out.push(row('twelvedata', w.s, 'M5 candles', { ok: false, status: r.status, ms: r.ms, note: errKind(r, r.j && (r.j.message || r.j.status)) + (r.j && r.j.message ? ': ' + r.j.message : '') }));
    await sleep(7800);   // free plan: 8 credits a minute
  }
}
async function finnhub(key, out) {
  const H = { 'X-Finnhub-Token': key }, to = Math.floor(Date.now() / 1000), from = to - 2 * 86400;
  for (const w of WATCH) {
    if (w.fhk === 'quote') {
      const r = await call(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(w.fh)}`, H);
      const ok = r.status === 200 && r.j && r.j.c > 0;
      out.push(row('finnhub', w.s, 'quote', { ok, status: r.status, ms: r.ms, ts: ok && r.j.t ? r.j.t * 1000 : null, price: ok ? r.j.c : null, note: ok ? '' : errKind(r, r.j && r.j.error) }));
    } else {
      const ep = w.fhk === 'crypto' ? 'crypto' : 'forex', r = await call(`https://finnhub.io/api/v1/${ep}/candle?symbol=${encodeURIComponent(w.fh)}&resolution=5&from=${from}&to=${to}`, H);
      const ok = r.status === 200 && r.j && r.j.s === 'ok' && Array.isArray(r.j.t) && r.j.t.length > 0;
      out.push(row('finnhub', w.s, 'M5 candles', { ok, status: r.status, ms: r.ms, n: ok ? r.j.t.length : null, ts: ok ? r.j.t[r.j.t.length - 1] * 1000 : null, price: ok ? r.j.c[r.j.c.length - 1] : null, note: ok ? '' : errKind(r, r.j && (r.j.error || r.j.s)) }));
    }
    await sleep(1100);
  }
}
async function siftingio(key, out) {
  const H = { 'X-API-Key': key }, B = 'https://api.sifting.io/v1', end = new Date(), start = new Date(Date.now() - 2 * 86400e3), iso = (d) => d.toISOString();
  for (const w of WATCH) {
    const [kind, names] = w.sf; let done = false, last = null;
    for (const nm of names) {
      const r = await call(`${B}/hist/${kind}/${encodeURIComponent(nm)}/bars?start=${iso(start)}&end=${iso(end)}&interval=5m`, H);
      const bars = r.j && (r.j.data || r.j.bars); const arr = Array.isArray(bars) ? bars : (bars && Array.isArray(bars.bars) ? bars.bars : null);
      if (r.status === 200 && arr && arr.length) {
        const b = arr[arr.length - 1], t = b.t != null ? b.t : b.ts != null ? b.ts : b.timestamp, ts = typeof t === 'number' ? (t < 1e12 ? t * 1000 : t) : Date.parse(t);
        out.push(row('siftingio', w.s, 'M5 bars', { ok: true, status: 200, ms: r.ms, n: arr.length, ts: Number.isFinite(ts) ? ts : null, price: b.c != null ? b.c : b.close, note: kind + '/' + nm })); done = true; break;
      }
      last = r; if (r.status === 401 || r.status === 429) break;
    }
    if (!done) out.push(row('siftingio', w.s, 'M5 bars', { ok: false, status: last && last.status, ms: last && last.ms, note: errKind(last || { status: 0, text: '' }, last && last.j && (last.j.error || last.j.message)) + ' (tried ' + names.join(', ') + ')' }));
    await sleep(300);
  }
  // live quote shape (one example)
  const q = await call(`${B}/last/quote/forex/EURUSD`, H);
  out.push(row('siftingio', 'EURUSD', 'last quote', { ok: q.status === 200 && !!q.j, status: q.status, ms: q.ms, note: q.status === 200 ? 'fields: ' + Object.keys(q.j.data || q.j).slice(0, 8).join(',') : errKind(q, q.j && q.j.error) }));
}
async function alphavantage(key, out) {
  // free key: 25 calls a day and ~5 a minute, so only a few, well spaced calls
  const tests = [
    ['XAUUSD', 'spot rate', `CURRENCY_EXCHANGE_RATE&from_currency=XAU&to_currency=USD`],
    ['XAGUSD', 'spot rate', `CURRENCY_EXCHANGE_RATE&from_currency=XAG&to_currency=USD`],
    ['EURUSD', 'M5 candles', `FX_INTRADAY&from_symbol=EUR&to_symbol=USD&interval=5min&outputsize=compact`],
    ['BTCUSD', 'spot rate', `CURRENCY_EXCHANGE_RATE&from_currency=BTC&to_currency=USD`],
    ['SPX500', 'M5 candles (SPY ETF proxy, not the index)', `TIME_SERIES_INTRADAY&symbol=SPY&interval=5min&outputsize=compact`],
    ['AAPL', 'M5 candles', `TIME_SERIES_INTRADAY&symbol=AAPL&interval=5min&outputsize=compact`],
  ];
  for (const [sym, what, q] of tests) {
    const r = await call(`https://www.alphavantage.co/query?function=${q}&apikey=${key}`), j = r.j || {};
    const msg = j.Information || j.Note || j['Error Message'] || '';
    const fx = j['Realtime Currency Exchange Rate'], series = Object.keys(j).find((k) => /Time Series/.test(k));
    if (fx) out.push(row('alphavantage', sym, what, { ok: true, status: r.status, ms: r.ms, ts: Date.parse(String(fx['6. Last Refreshed']).replace(' ', 'T') + 'Z'), price: +fx['5. Exchange Rate'] }));
    else if (series) { const ks = Object.keys(j[series]); out.push(row('alphavantage', sym, what, { ok: true, status: r.status, ms: r.ms, n: ks.length, ts: Date.parse(ks[0].replace(' ', 'T') + 'Z'), price: +j[series][ks[0]]['4. close'], note: 'US Eastern timestamps are read as UTC here; compare ages with care' })); }
    else out.push(row('alphavantage', sym, what, { ok: false, status: r.status, ms: r.ms, note: errKind(r, msg || r.text) + (msg ? ': ' + msg : '') }));
    await sleep(13000);
  }
}
async function marketaux(key, out) {
  const r = await call(`https://api.marketaux.com/v1/news/all?symbols=XAUUSD,AAPL&filter_entities=true&language=en&limit=3&api_token=${key}`);
  const d = r.j && Array.isArray(r.j.data) ? r.j.data : null;
  out.push(row('marketaux', 'headlines', 'news', { ok: !!d && r.status === 200, status: r.status, ms: r.ms, n: d ? d.length : null, ts: d && d[0] ? Date.parse(d[0].published_at) : null, note: d ? 'meta: ' + JSON.stringify(r.j.meta || {}).slice(0, 80) : errKind(r, r.j && r.j.error && (r.j.error.message || r.j.error.code)) }));
}
const RUN = { twelvedata, finnhub, siftingio, alphavantage, marketaux };

/* ---------------- admin gate ---------------- */
async function isAdmin(token) {
  if (!token) return false;
  try {
    const u = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SB_ANON, Authorization: 'Bearer ' + token } }); if (!u.ok) return false;
    const id = (await u.json()).id; if (!id) return false;
    const p = await fetch(`${SB_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(id)}&select=is_admin`, { headers: { apikey: SB_ANON, Authorization: 'Bearer ' + token } });
    const rows = await p.json(); return Array.isArray(rows) && rows[0] && rows[0].is_admin === true;
  } catch (_) { return false; }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const auth = String(req.headers.authorization || '');
  if (!(await isAdmin(auth.replace(/^Bearer\s+/i, '')))) return res.status(403).json({ error: 'admin_only' });
  const keys = KEYS(), want = String((req.query && req.query.providers) || Object.keys(RUN).join(',')).split(',').map((x) => x.trim()).filter((x) => RUN[x]);
  const rows = [], configured = {}, skipped = [];
  await Promise.all(want.map(async (p) => {
    configured[p] = !!keys[p];
    if (!keys[p]) { skipped.push(p); return; }
    try { await RUN[p](keys[p], rows); } catch (e) { rows.push(row(p, '-', 'run', { ok: false, note: 'probe error: ' + (e && e.message) })); }
  }));
  // summary: per provider and asset class, how many symbols answered with usable data
  const sum = {};
  for (const r of rows) { const w = WATCH.find((x) => x.s === r.symbol), cls = w ? w.cls : r.symbol; const k = r.provider + '|' + cls; sum[k] = sum[k] || { provider: r.provider, class: cls, ok: 0, total: 0, freshest_s: null, median_ms: [] }; const s = sum[k]; s.total++; if (r.ok) s.ok++; if (r.age_s != null && (s.freshest_s == null || r.age_s < s.freshest_s)) s.freshest_s = r.age_s; if (r.ms != null) s.median_ms.push(r.ms); }
  const summary = Object.values(sum).map((s) => { const m = s.median_ms.sort((a, b) => a - b); return { provider: s.provider, class: s.class, ok: s.ok, total: s.total, freshest_s: s.freshest_s, median_ms: m.length ? m[Math.floor(m.length / 2)] : null }; });
  res.status(200).json({ generated_at: new Date().toISOString(), configured, skipped_no_key: skipped, summary, rows, notes: 'age_s is seconds since the last candle/quote timestamp. Outside market hours (weekend, session close) forex, metals, indices and equities look old even on a real-time plan.' });
};
module.exports._t = { redact, errKind, fresh, WATCH };
