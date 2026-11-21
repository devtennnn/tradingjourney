// KHQRPay webhook: signature check and event routing. Plain JS with Web Crypto, so it runs in the Supabase Edge
// runtime (Deno) and in Node's test runner (node --test lib.test.mjs).
//
// X-KHQRPay-Signature: "t=<unix seconds>,v1=<hex>"
// v1 = hex HMAC-SHA256 of "<t>.<raw body>", keyed with the endpoint's whole signing secret as UTF-8 text (whsec_ included).

export const TOLERANCE_S = 300;   // reject timestamps more than 5 minutes from now, in either direction

const enc = new TextEncoder();

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time comparison of two strings (the time does not depend on where they first differ). */
export function safeEqual(a, b) {
  const x = enc.encode(String(a)), y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** Parse "t=...,v1=...[,v1=...]". Returns null when malformed. */
export function parseSignature(header) {
  if (typeof header !== "string" || header.length === 0 || header.length > 1000) return null;
  let t = null; const v1 = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 1) return null;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === "t") { if (!/^\d{1,12}$/.test(v)) return null; t = Number(v); }
    else if (k === "v1") { if (!/^[0-9a-fA-F]{64}$/.test(v)) return null; v1.push(v.toLowerCase()); }
  }
  if (t === null || v1.length === 0) return null;
  return { t, v1 };
}

/**
 * Verify one delivery. rawBody must be the exact bytes received, as text, before any JSON parsing.
 * Returns { ok: true } or { ok: false, status, error }.
 */
export async function verifySignature({ rawBody, header, secret, nowS = Math.floor(Date.now() / 1000) }) {
  // HMAC accepts an empty key, so anyone could sign with it: refuse everything until the secret is configured
  if (typeof secret !== "string" || secret.trim() === "") return { ok: false, status: 500, error: "webhook_secret_not_configured" };
  const sig = parseSignature(header);
  if (!sig) return { ok: false, status: 400, error: header ? "malformed_signature" : "missing_signature" };
  if (Math.abs(nowS - sig.t) > TOLERANCE_S) return { ok: false, status: 400, error: "timestamp_out_of_range" };
  const expected = await hmacHex(secret, `${sig.t}.${rawBody}`);
  let match = false;
  for (const v of sig.v1) if (safeEqual(v, expected)) match = true;   // check every v1 without stopping early
  return match ? { ok: true, t: sig.t } : { ok: false, status: 400, error: "bad_signature" };
}

/**
 * Handle one webhook request.
 *   rawBody   the request body as received (string)
 *   header    X-KHQRPay-Signature
 *   secret    the endpoint's signing secret (KHQRPAY_WEBHOOK_SECRET)
 *   store     { handleEvent(eventId, type, payment) } — writes the event and its effect in one database transaction
 *   log       optional logger
 * Returns { status, body } for the HTTP response. Only verified, live, non-test events reach the store.
 */
export async function handleWebhook({ rawBody, header, secret, store, nowS, log = () => {} }) {
  const v = await verifySignature({ rawBody, header, secret, nowS });
  if (!v.ok) { log("rejected", v.error); return { status: v.status, body: { error: v.error } }; }

  let ev;
  try { ev = JSON.parse(rawBody); } catch { return { status: 400, body: { error: "invalid_json" } }; }
  if (!ev || typeof ev !== "object" || typeof ev.id !== "string" || !ev.id || typeof ev.type !== "string") return { status: 400, body: { error: "invalid_event" } };

  // production: test payments and dashboard test events are acknowledged and never fulfilled
  if (ev.livemode !== true || ev.test === true) return { status: 200, body: { received: true, ignored: "test_event" } };

  const payment = ev.data && ev.data.payment;
  if (!payment || typeof payment !== "object" || typeof payment.id !== "string") return { status: 400, body: { error: "invalid_event" } };
  // payment-link payments are not orders from this app
  if (typeof payment.reference_id !== "string" || payment.reference_id.startsWith("link:")) return { status: 200, body: { received: true, ignored: "not_our_order" } };

  const out = await store.handleEvent(ev.id, ev.type, payment);   // throws on a database error: the caller answers 5xx and KHQRPay retries
  log("handled", ev.type, ev.id, out && out.result);
  return { status: 200, body: { received: true, result: out && out.result } };
}
