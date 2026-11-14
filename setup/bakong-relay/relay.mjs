// Bakong relay: forwards ONE call (check_transaction_by_md5) from your Supabase function to Bakong.
//
// Why it exists: Bakong's Open API refuses calls from outside Cambodia (empty HTTP 403), and Supabase Edge Functions run in
// Singapore / Seoul. Run this on a server that has a Cambodian IP address (a VPS in Phnom Penh), put HTTPS in front of it
// (Caddy / nginx / a Cloudflare Tunnel), then point the function at it. See README.md.
//
// Safety: not an open proxy. It accepts only POST /v1/check_transaction_by_md5 with a body of exactly {"md5":"<32 hex>"},
// only with your secret in the x-relay-key header, and it never logs or stores the Bakong token (it just passes the header on).
//
//   RELAY_KEY=<24+ random characters>  node relay.mjs        (Node 18+)
import http from 'node:http';
import crypto from 'node:crypto';

const KEY = process.env.RELAY_KEY || '';
const TARGET = (process.env.BAKONG_API_URL || 'https://api-bakong.nbc.gov.kh').replace(/\/$/, '');
const PORT = Number(process.env.PORT || 8787);
export const HOST = process.env.HOST || '127.0.0.1';      // loopback only: the HTTPS reverse proxy (Caddy) is the only thing that talks to it
if (KEY.length < 24) { console.error('Set RELAY_KEY to at least 24 random characters (e.g. `openssl rand -hex 24`).'); process.exit(1); }

const sameKey = (given) => {
  const a = Buffer.from(String(given || '')), b = Buffer.from(KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const send = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(typeof obj === 'string' ? obj : JSON.stringify(obj)); };

export const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
  if (req.method !== 'POST' || req.url !== '/v1/check_transaction_by_md5') return send(res, 404, { error: 'not found' });
  if (!sameKey(req.headers['x-relay-key'])) return send(res, 401, { error: 'bad relay key' });
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 512) return send(res, 413, { error: 'too large' }); }
  let md5; try { md5 = JSON.parse(raw).md5; } catch { return send(res, 400, { error: 'bad json' }); }
  if (typeof md5 !== 'string' || !/^[a-f0-9]{32}$/i.test(md5)) return send(res, 400, { error: 'md5 must be 32 hex characters' });
  try {
    const r = await fetch(TARGET + '/v1/check_transaction_by_md5', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: String(req.headers.authorization || '') },
      body: JSON.stringify({ md5 }),
      signal: AbortSignal.timeout(15000),
    });
    send(res, r.status, await r.text());               // pass Bakong's answer through unchanged (the function classifies it)
  } catch (e) {
    send(res, 502, { error: 'relay could not reach Bakong' });
  }
});

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  server.listen(PORT, HOST, () => console.log(`Bakong relay on ${HOST}:${PORT} -> ${TARGET}`));
}
