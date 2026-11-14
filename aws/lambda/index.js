// AROM TRADE · AWS Lambda entry for the /api/* endpoints (Node.js 20+, Function URL or API Gateway HTTP API).
// Wraps the existing Vercel-style handlers in /api (module.exports = async (req, res) => …) without changing them,
// and keeps a small in-memory cache that follows each response's s-maxage, so Twelve Data / Yahoo are not called
// on every visitor request (Vercel's CDN did this before).
const ROUTES = {
  candles: require('./api/candles.js'),
  live: require('./api/live.js'),
  quotes: require('./api/quotes.js'),
  news: require('./api/news.js'),
  'market-news': require('./api/market-news.js'),
};
const CACHE = new Map();   // url -> {exp, status, headers, body}

function run(handler, query, method) {
  return new Promise((resolve) => {
    const headers = {}; let status = 200, done = false;
    const finish = (body) => { if (done) return; done = true; resolve({ status, headers, body }); };
    const res = {
      setHeader: (k, v) => { headers[k.toLowerCase()] = String(v); return res; },
      getHeader: (k) => headers[k.toLowerCase()],
      status: (c) => { status = c; return res; },
      json: (o) => { headers['content-type'] = headers['content-type'] || 'application/json; charset=utf-8'; finish(JSON.stringify(o)); return res; },
      send: (b) => { finish(typeof b === 'string' ? b : JSON.stringify(b)); return res; },
      end: (b) => { finish(b == null ? '' : String(b)); return res; },
    };
    Promise.resolve(handler({ method, query, headers: {} }, res))
      .catch((e) => { status = 500; headers['content-type'] = 'application/json'; finish(JSON.stringify({ error: String(e && e.message || e) })); });
  });
}

exports.handler = async (event) => {
  const path = event.rawPath || event.path || '/';
  const method = (event.requestContext && event.requestContext.http && event.requestContext.http.method) || event.httpMethod || 'GET';
  const query = event.queryStringParameters || {};
  const name = path.replace(/^\/+|\/+$/g, '').replace(/^api\//, '');
  const handler = ROUTES[name];
  const cors = { 'access-control-allow-origin': '*' };
  if (method === 'OPTIONS') return { statusCode: 204, headers: { ...cors, 'access-control-allow-methods': 'GET,OPTIONS' } };
  if (!handler) return { statusCode: 404, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ error: 'not found' }) };

  const key = name + '?' + new URLSearchParams(query).toString(), now = Date.now(), hit = CACHE.get(key);
  if (hit && hit.exp > now) return { statusCode: hit.status, headers: { ...hit.headers, 'x-arom-cache': 'HIT' }, body: hit.body };

  const out = await run(handler, query, method);
  const cc = out.headers['cache-control'] || '', m = cc.match(/s-maxage=(\d+)/);
  if (out.status === 200 && m && !/no-store/.test(cc)) {
    CACHE.set(key, { exp: now + Number(m[1]) * 1000, status: out.status, headers: out.headers, body: out.body });
    if (CACHE.size > 300) CACHE.delete(CACHE.keys().next().value);
  }
  // browsers/CloudFront: keep the same caching rules Vercel used
  if (m) out.headers['cache-control'] = cc.replace(/s-maxage=(\d+)/, 'max-age=0, s-maxage=$1');
  return { statusCode: out.status, headers: { ...out.headers, 'x-arom-cache': 'MISS' }, body: out.body };
};
