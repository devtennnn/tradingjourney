// Supabase Edge Function: "khqr"
// Generates a dynamic KHQR for the DEVTEN Premium plan and verifies payment through the Bakong Open API.
//
// Deploy: run ./set-secrets.sh (sets BAKONG_TOKEN and deploys). Only BAKONG_TOKEN is secret; the merchant
// details below are public (they are printed inside every QR) and are used as defaults when no secret overrides them.
// Optional secrets: PLAN_PRICE (default 2.5), PLAN_PRICE_ELITE (default 14.99), PLAN_DAYS (default 30), QR_TTL_MIN (default 15),
//   BAKONG_ACCOUNT_TYPE (individual | merchant), BAKONG_MERCHANT_ID, BAKONG_ACQUIRING_BANK,
//   BAKONG_API_URL (default https://api-bakong.nbc.gov.kh; use https://sit-api-bakong.nbc.gov.kh to test, or the URL of a relay in Cambodia)
//   BAKONG_RELAY_KEY (shared secret sent as header x-relay-key to that relay; see setup/bakong-relay/)
//
// WHY A RELAY: Bakong's Open API answers calls from outside Cambodia with an empty HTTP 403 before it even looks at the token.
// Supabase Edge Functions run in Singapore / Seoul / etc., so every payment check is refused ("geo_blocked"). Until the check runs
// from a Cambodian IP (relay), payments are confirmed by an admin (claim_payment / admin_approve_payment in the database).
//
// Requests (POST, user JWT required):  { action: "create" }  |  { action: "check", id: "<payment id>" }  |  { action: "recover" }
//   { action: "diag" }  (admins only)  |  { action: "quote", plan, promo }  (exact price with a promo code)
//   create also accepts { plan, promo }: the discount is calculated HERE with the database rules (promo_quote_internal), never taken from the browser.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

// ===== KHQR payload builder (inlined so this works pasted into the Supabase Dashboard editor) =====
// KHQR (Bakong) dynamic payload builder — EMV merchant-presented QR with CRC16/CCITT-FALSE.
// Pure functions, no dependencies, so it runs in Deno (Edge Function) and Node (tests).

const tlv = (tag: string, val: string): string => tag + String(val.length).padStart(2, "0") + val;

/** CRC16-CCITT (poly 0x1021, init 0xFFFF) as 4 uppercase hex chars. */
function crc16(str: string): string {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

interface KhqrInput {
  accountId: string;              // Bakong account, e.g. "devten@aclb"
  accountType?: "individual" | "merchant";
  merchantId?: string;            // merchant accounts only
  acquiringBank?: string;         // merchant accounts only
  merchantName: string;           // max 25 chars
  merchantCity: string;           // max 15 chars
  amount: number;
  currency: "USD" | "KHR";
  billNumber: string;             // max 25 chars, unique per payment
  storeLabel?: string;
  terminalLabel?: string;
  createdMs: number;
  expiresMs: number;
}

/** Build a DYNAMIC KHQR string (point of initiation "12") with an expiry timestamp. */
function buildKHQR(o: KhqrInput): string {
  const isKhr = o.currency === "KHR";
  const amount = isKhr ? String(Math.round(o.amount)) : Number(o.amount).toFixed(2);
  let s = tlv("00", "01") + tlv("01", "12");

  if (o.accountType === "merchant") {
    s += tlv("30", tlv("00", o.accountId) + tlv("01", o.merchantId || "") + tlv("02", o.acquiringBank || ""));
  } else {
    s += tlv("29", tlv("00", o.accountId));
  }

  s += tlv("52", "5999");
  s += tlv("53", isKhr ? "116" : "840");
  s += tlv("54", amount);
  s += tlv("58", "KH");
  s += tlv("59", o.merchantName.slice(0, 25));
  s += tlv("60", o.merchantCity.slice(0, 15));

  let extra = tlv("01", o.billNumber.slice(0, 25));
  if (o.storeLabel) extra += tlv("03", o.storeLabel.slice(0, 25));
  if (o.terminalLabel) extra += tlv("07", o.terminalLabel.slice(0, 25));
  s += tlv("62", extra);

  s += tlv("99", tlv("00", String(o.createdMs)) + tlv("01", String(o.expiresMs)));

  s += "6304";
  return s + crc16(s);
}

/** Parse top-level TLV pairs (used by tests / debugging). */
function parseTLV(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i + 4 <= s.length) {
    const tag = s.slice(i, i + 2);
    const len = parseInt(s.slice(i + 2, i + 4), 10);
    if (Number.isNaN(len)) throw new Error("bad TLV length at " + i);
    out[tag] = s.slice(i + 4, i + 4 + len);
    i += 4 + len;
  }
  return out;
}

/** True when the trailing CRC matches the payload. */
function verifyCRC(payload: string): boolean {
  return payload.slice(-4) === crc16(payload.slice(0, -4));
}

// ===== Edge Function =====

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// DEVTEN merchant defaults (ABA Bank KHQR merchant account)
const DEFAULTS = {
  BAKONG_ACCOUNT_TYPE: "merchant",
  BAKONG_ACCOUNT_ID: "abaakhppxxx@abaa",
  BAKONG_MERCHANT_ID: "125102422022315",
  BAKONG_ACQUIRING_BANK: "ABA Bank",
  MERCHANT_NAME: "DEVTEN by C.LIM",
  MERCHANT_CITY: "PHNOM PENH",
} as const;
const cfg = (k: keyof typeof DEFAULTS) => env(k, DEFAULTS[k]);

// Plans: Premium = chart uploads. Elite = chart uploads + Market News Analysis + Signal Provider.
const PLANS: Record<string, { price: number; col: string; label: string }> = {
  premium: { price: Number(env("PLAN_PRICE", "2.5")), col: "premium_until", label: "Premium" },
  elite:   { price: Number(env("PLAN_PRICE_ELITE", "14.99")), col: "elite_until", label: "Elite" },
};
const planOf = (v: unknown) => (v === "elite" ? "elite" : "premium");
const DAYS = Number(env("PLAN_DAYS", "30"));
const TTL_MS = Number(env("QR_TTL_MIN", "15")) * 60_000;
const CURRENCY = "USD" as const;
const BAKONG_DEFAULT = "https://api-bakong.nbc.gov.kh";
const BAKONG_API = env("BAKONG_API_URL", BAKONG_DEFAULT);

// Pure-JS MD5 (Supabase's WebCrypto does not support "MD5"). Returns lowercase hex of the UTF-8 bytes of s.
function md5hex(s: string): string {
  const msg = new TextEncoder().encode(s);
  const K = new Uint32Array(64), R = [7,12,17,22,5,9,14,20,4,11,16,23,6,10,15,21];
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
  const n = msg.length, padded = new Uint8Array(((n + 8) >> 6 << 6) + 64);
  padded.set(msg); padded[n] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, (n << 3) >>> 0, true);
  dv.setUint32(padded.length - 4, Math.floor(n / 536870912), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let off = 0; off < padded.length; off += 64) {
    const M = new Uint32Array(16);
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      const r = R[(i >> 4) * 4 + (i % 4)];
      B = (B + ((F << r) | (F >>> (32 - r)))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16), ov = new DataView(out.buffer);
  ov.setUint32(0, a0, true); ov.setUint32(4, b0, true); ov.setUint32(8, c0, true); ov.setUint32(12, d0, true);
  return [...out].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const billNumber = () =>
  "DT" + Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[b % 32]).join("");

/** Why a Bakong call produced no answer. "" = Bakong answered (found or not found). */
type Blocked = "" | "no_token" | "geo_blocked" | "rejected" | "unreachable";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = env("SUPABASE_URL"), anon = env("SUPABASE_ANON_KEY"), service = env("SUPABASE_SERVICE_ROLE_KEY");
    const userClient = createClient(url, anon, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
    const admin = createClient(url, service);
    const body = await req.json().catch(() => ({}));

    const publicRow = (p: any) => ({
      id: p.id, plan: p.plan ?? "premium", payload: p.payload, amount: Number(p.amount), currency: p.currency,
      merchant: cfg("MERCHANT_NAME"), expires_at: p.expires_at,
      list_price: p.list_price != null ? Number(p.list_price) : Number(p.amount), discount: Number(p.discount ?? 0), promo_code: p.promo_code ?? null,
    });

    /** Promo check with the database rules. Fails CLOSED: if the check cannot run, no discount is given. */
    const promoQuote = async (plan: string, code: string) => {
      const { data, error } = await admin.rpc("promo_quote_internal", { p_user: user.id, p_code: code, p_plan: plan, p_price: PLANS[plan].price });
      if (error || !data) { console.error("promo quote failed", error && error.message); return { ok: false, error: "unavailable" } as any; }
      return data as any;
    };

    /* ---------- quote: exact price for a plan, with an optional promo code ---------- */
    if (body.action === "quote") {
      const plan = planOf(body.plan), P = PLANS[plan], code = String(body.promo ?? "").trim();
      if (!code) return json({ ok: true, plan, list_price: P.price, discount: 0, final: P.price, promo: null });
      const q = await promoQuote(plan, code);
      if (!q.ok) return json({ ok: false, error: q.error, plan: q.plan ?? null, list_price: P.price });
      return json({ ok: true, plan, list_price: P.price, discount: Number(q.discount), final: Number(q.final), promo: { code: q.code, kind: q.kind, value: Number(q.value) } });
    }

    /* ---------- create ---------- */
    if (body.action === "create") {
      const plan = planOf(body.plan), P = PLANS[plan], promo = String(body.promo ?? "").trim();
      let quote: any = null;
      if (promo) {
        quote = await promoQuote(plan, promo);
        if (!quote.ok) return json({ error: "promo_" + quote.error, plan: quote.plan ?? null });
      }
      const price = quote ? Number(quote.final) : P.price;
      const { data: open } = await admin.from("payments").select("*")
        .eq("user_id", user.id).eq("status", "pending").eq("plan", plan).gt("expires_at", new Date().toISOString())
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      // reopen the user's open QR only when it used the same promo (or none): otherwise the amount would be wrong
      if (open && (open.promo_code ?? null) === (quote ? quote.code : null)) return json(publicRow(open));

      const created = Date.now(), expires = created + TTL_MS, bill = billNumber();
      const payload = buildKHQR({
        accountId: cfg("BAKONG_ACCOUNT_ID"),
        accountType: cfg("BAKONG_ACCOUNT_TYPE") as "individual" | "merchant",
        merchantId: cfg("BAKONG_MERCHANT_ID"),
        acquiringBank: cfg("BAKONG_ACQUIRING_BANK"),
        merchantName: cfg("MERCHANT_NAME"),
        merchantCity: cfg("MERCHANT_CITY"),
        amount: price, currency: CURRENCY, billNumber: bill, storeLabel: P.label,
        createdMs: created, expiresMs: expires,
      });
      const md5 = await md5hex(payload);
      if (quote) {
        // the database re-checks the limits under a lock and refuses if the price changed, so two buyers cannot both take the last use
        const { data, error } = await admin.rpc("create_payment_row", {
          p_user: user.id, p_bill: bill, p_md5: md5, p_payload: payload, p_plan: plan, p_list_price: P.price, p_amount: price,
          p_currency: CURRENCY, p_expires: new Date(expires).toISOString(), p_code: quote.code,
        });
        if (error) { const m = String(error.message || ""); return json({ error: /^promo_[a-z_]+$/.test(m) ? m : "promo_unavailable" }); }
        return json(publicRow(data));
      }
      const row = {
        user_id: user.id, bill_number: bill, md5, payload, list_price: P.price, discount: 0,
        plan, amount: price, currency: CURRENCY, status: "pending", expires_at: new Date(expires).toISOString(),
      };
      const { data, error } = await admin.from("payments").insert(row).select().single();
      if (error) return json({ error: error.message }, 500);
      return json(publicRow(data));
    }

    /* ---------- shared helpers: Bakong lookup + atomic settle ---------- */
    const untilFor = async (col: string) =>
      ((await admin.from("profiles").select(col).eq("id", user.id).maybeSingle()).data as any)?.[col] ?? null;
    const bakongToken = () => env("BAKONG_TOKEN").trim().replace(/^["']|["']$/g, "").replace(/^Bearer\s+/i, "");

    /** Ask Bakong about one MD5. Never throws. */
    const bakongLookup = async (md5: string) => {
      const token = bakongToken();
      if (!token) return { tx: null, blocked: "no_token" as Blocked, http: 0, raw: null as unknown };
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${token}` };
        if (env("BAKONG_RELAY_KEY")) headers["x-relay-key"] = env("BAKONG_RELAY_KEY");
        const res = await fetch(`${BAKONG_API}/v1/check_transaction_by_md5`, { method: "POST", headers, body: JSON.stringify({ md5 }) });
        const text = await res.text();
        let j: any = null;
        try { j = JSON.parse(text); } catch { j = null; }
        // Outside Cambodia Bakong refuses with an empty / non-JSON 403 BEFORE it looks at the token. A bad token gets a JSON answer.
        let blocked: Blocked = "";
        if (!j && (res.status === 403 || res.status === 451)) blocked = "geo_blocked";
        else if (res.status >= 500 || (!j && !res.ok)) blocked = "unreachable";          // server error, or a non-JSON error page
        else if (res.status === 401 || res.status === 403 || (j && j.responseCode === 401)) blocked = "rejected";
        else if (j && j.responseCode === undefined && !res.ok) blocked = "unreachable";   // the relay's own JSON error (wrong path / bad request), not an answer from Bakong
        if (blocked) console.error("Bakong not usable:", blocked, "http", res.status, "body", text.slice(0, 200));
        return { tx: j && j.responseCode === 0 ? j.data : null, blocked, http: res.status, raw: j ?? text.slice(0, 200) };
      } catch (e) {
        console.error("Bakong request failed", String(e));
        return { tx: null, blocked: "unreachable" as Blocked, http: 0, raw: String(e) as unknown };
      }
    };

    /** Check one payment row against Bakong; if truly paid, mark it paid and extend the plan exactly once. */
    const settle = async (p: any) => {
      const plan = planOf(p.plan), col = PLANS[plan].col;
      if (p.status === "paid") { const u = await untilFor(col); return { status: "paid", plan, until: u, premium_until: u }; }
      const waiting = (bk: string) => ({ status: p.status === "claimed" ? "claimed" : "pending", bakong: bk });
      const { tx, blocked } = await bakongLookup(p.md5);
      if (!tx) {
        if (p.status === "claimed") return waiting(blocked || "ok");          // user said "I paid": an admin decides
        if (new Date(p.expires_at) < new Date()) {
          await admin.from("payments").update({ status: "expired" }).eq("id", p.id).eq("status", "pending");
          return { status: "expired", bakong: blocked || "ok" };
        }
        return waiting(blocked || "ok");
      }
      // Never trust a bare "found": confirm amount and currency match what we asked for.
      const paidOk = Number(tx.amount) >= Number(p.amount) - 0.001 &&
        String(tx.currency ?? p.currency).toUpperCase() === p.currency;
      if (!paidOk) return waiting("amount_mismatch");
      if (tx.toAccountId && String(tx.toAccountId) !== cfg("BAKONG_ACCOUNT_ID")) {
        console.error("Paid to unexpected account", tx.toAccountId);
        return waiting("wrong_account");
      }
      // Claim atomically so two concurrent checks cannot extend the plan twice.
      const { data: claimed } = await admin.from("payments")
        .update({ status: "paid", paid_at: new Date().toISOString(), bakong_hash: tx.hash ?? null })
        .eq("id", p.id).in("status", ["pending", "expired", "claimed"]).select().maybeSingle();
      if (claimed) {
        const cur = await untilFor(col);
        const base = cur && new Date(cur) > new Date() ? new Date(cur) : new Date();
        const next = new Date(base.getTime() + DAYS * 86_400_000).toISOString();
        await admin.from("profiles").update({ [col]: next }).eq("id", user.id);
      }
      const u = await untilFor(col);
      return { status: "paid", plan, until: u, premium_until: u };
    };

    /* ---------- check ---------- */
    if (body.action === "check") {
      const { data: p } = await admin.from("payments").select("*").eq("id", body.id).eq("user_id", user.id).maybeSingle();
      if (!p) return json({ error: "payment not found" }, 404);
      return json(await settle(p));
    }

    /* ---------- recover: re-check this user's unpaid QR codes from the last 3 days (e.g. paid while Bakong was unreachable) ---------- */
    if (body.action === "recover") {
      const since = new Date(Date.now() - 3 * 86_400_000).toISOString();
      const { data: rows } = await admin.from("payments").select("*")
        .eq("user_id", user.id).in("status", ["pending", "expired", "claimed"]).gt("created_at", since)
        .order("created_at", { ascending: false }).limit(10);
      let last: any = { status: "none" }, anyClaimed = false;
      for (const p of rows ?? []) {
        const r = await settle(p);
        if (r.status === "paid") return json(r);
        if (r.status === "claimed") anyClaimed = true;
        last = r;
      }
      // unpaid QR codes the user can point to with "I paid this one" (bank could not confirm them, admin will)
      const unpaid = (rows ?? []).filter((p: any) => p.status !== "claimed")
        .map((p: any) => ({ id: p.id, bill: p.bill_number, plan: p.plan ?? "premium", amount: Number(p.amount), currency: p.currency, created_at: p.created_at }));
      return json({ status: anyClaimed ? "claimed" : "none", bakong: last.bakong, unpaid });
    }

    /* ---------- diag: self-test for admins (reveals no secrets) ---------- */
    if (body.action === "diag") {
      const { data: prof } = await admin.from("profiles").select("is_admin").eq("id", user.id).maybeSingle();
      if (!(prof as any)?.is_admin) return json({ error: "forbidden" }, 403);
      const probe = await bakongLookup("0".repeat(32));
      let egress: Record<string, string> | null = null;      // where this function reaches the internet from (country decides whether Bakong answers)
      try {
        const t = await (await fetch("https://www.cloudflare.com/cdn-cgi/trace")).text();
        const m = Object.fromEntries(t.trim().split("\n").map((l) => l.split("=")));
        egress = { ip: m.ip, country: m.loc, colo: m.colo };
      } catch (_) { /* optional */ }
      const viaRelay = BAKONG_API !== BAKONG_DEFAULT;
      const relayKeyBad = viaRelay && probe.blocked === "rejected" && !!probe.raw && typeof probe.raw === "object" && (probe.raw as any).error === "bad relay key";
      const verdict = relayKeyBad
        ? "The relay refused BAKONG_RELAY_KEY: it must be exactly the RELAY_KEY stored on the relay server (/etc/bakong-relay.env)."
        : viaRelay && probe.blocked === "geo_blocked"
        ? "The relay answered, but Bakong still refuses the relay's server. Check that the VPS really has a Cambodian IP address (the installer prints its country)."
        : viaRelay && probe.blocked === "unreachable"
        ? "The relay could not be used: check BAKONG_API_URL, that the relay is running (systemctl status bakong-relay) and that ports 80 and 443 are open."
        : probe.blocked === "geo_blocked"
        ? "Bakong refuses this server's location (empty 403). Put a relay in Cambodia (BAKONG_API_URL + BAKONG_RELAY_KEY) or confirm payments by hand in the Admin panel."
        : probe.blocked === "rejected" ? "Bakong answered but rejected the token: renew BAKONG_TOKEN."
        : probe.blocked === "no_token" ? "BAKONG_TOKEN is not set."
        : probe.blocked === "unreachable" ? "Bakong could not be reached (network error / 5xx)."
        : "OK: Bakong answered, automatic confirmation works.";
      return json({
        ok: probe.blocked === "", verdict, blocked: probe.blocked || null,
        tokenSet: !!bakongToken(), tokenLength: bakongToken().length, tokenLooksLikeJwt: bakongToken().split(".").length === 3,
        api: BAKONG_API, viaRelay, relayKeySet: !!env("BAKONG_RELAY_KEY"),
        egress, bakongHttpStatus: probe.http, bakongReply: probe.raw, account: cfg("BAKONG_ACCOUNT_ID"),
      });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
