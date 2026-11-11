// Supabase Edge Function: "khqr"
// Generates a dynamic KHQR for the DEVTEN Premium plan and verifies payment through the Bakong Open API.
//
// Deploy: run ./set-secrets.sh (sets BAKONG_TOKEN and deploys). Only BAKONG_TOKEN is secret; the merchant
// details below are public (they are printed inside every QR) and are used as defaults when no secret overrides them.
// Optional secrets: PLAN_PRICE (default 2.5), PLAN_DAYS (default 30), QR_TTL_MIN (default 15),
//   BAKONG_ACCOUNT_TYPE (individual | merchant), BAKONG_MERCHANT_ID, BAKONG_ACQUIRING_BANK,
//   BAKONG_API_URL (default https://api-bakong.nbc.gov.kh; use https://sit-api-bakong.nbc.gov.kh to test)
//
// Requests (POST, user JWT required):  { action: "create" }  |  { action: "check", id: "<payment id>" }

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

const PRICE = Number(env("PLAN_PRICE", "2.5"));
const DAYS = Number(env("PLAN_DAYS", "30"));
const TTL_MS = Number(env("QR_TTL_MIN", "15")) * 60_000;
const CURRENCY = "USD" as const;
const BAKONG_API = env("BAKONG_API_URL", "https://api-bakong.nbc.gov.kh");

async function md5hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("MD5", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const billNumber = () =>
  "DT" + Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[b % 32]).join("");

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
      id: p.id, payload: p.payload, amount: Number(p.amount), currency: p.currency,
      merchant: cfg("MERCHANT_NAME"), expires_at: p.expires_at,
    });

    /* ---------- create ---------- */
    if (body.action === "create") {
      const { data: open } = await admin.from("payments").select("*")
        .eq("user_id", user.id).eq("status", "pending").gt("expires_at", new Date().toISOString())
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (open) return json(publicRow(open));

      const created = Date.now(), expires = created + TTL_MS, bill = billNumber();
      const payload = buildKHQR({
        accountId: cfg("BAKONG_ACCOUNT_ID"),
        accountType: cfg("BAKONG_ACCOUNT_TYPE") as "individual" | "merchant",
        merchantId: cfg("BAKONG_MERCHANT_ID"),
        acquiringBank: cfg("BAKONG_ACQUIRING_BANK"),
        merchantName: cfg("MERCHANT_NAME"),
        merchantCity: cfg("MERCHANT_CITY"),
        amount: PRICE, currency: CURRENCY, billNumber: bill, storeLabel: "Premium",
        createdMs: created, expiresMs: expires,
      });
      const row = {
        user_id: user.id, bill_number: bill, md5: await md5hex(payload), payload,
        amount: PRICE, currency: CURRENCY, status: "pending", expires_at: new Date(expires).toISOString(),
      };
      const { data, error } = await admin.from("payments").insert(row).select().single();
      if (error) return json({ error: error.message }, 500);
      return json(publicRow(data));
    }

    /* ---------- check ---------- */
    if (body.action === "check") {
      const { data: p } = await admin.from("payments").select("*").eq("id", body.id).eq("user_id", user.id).maybeSingle();
      if (!p) return json({ error: "payment not found" }, 404);

      const premiumUntil = async () =>
        (await admin.from("profiles").select("premium_until").eq("id", user.id).maybeSingle()).data?.premium_until ?? null;
      if (p.status === "paid") return json({ status: "paid", premium_until: await premiumUntil() });

      // Ask Bakong whether a transaction with this QR's MD5 exists.
      const res = await fetch(`${BAKONG_API}/v1/check_transaction_by_md5`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${env("BAKONG_TOKEN")}` },
        body: JSON.stringify({ md5: p.md5 }),
      });
      const j = await res.json().catch(() => null);
      if (res.status === 401 || res.status === 403 || (j && j.responseCode === 401)) {
        // Token invalid/expired, or Bakong refuses this server's IP (non-Cambodian). Visible in: supabase functions logs khqr
        console.error("Bakong auth/geo rejection", res.status, JSON.stringify(j));
      }
      const tx = j && j.responseCode === 0 ? j.data : null;

      if (!tx) {
        if (new Date(p.expires_at) < new Date()) {
          await admin.from("payments").update({ status: "expired" }).eq("id", p.id).eq("status", "pending");
          return json({ status: "expired" });
        }
        return json({ status: "pending" });
      }

      // Never trust a bare "found": confirm the amount and currency match what we asked for.
      const paidOk = Number(tx.amount) >= Number(p.amount) - 0.001 &&
        String(tx.currency ?? p.currency).toUpperCase() === p.currency;
      if (!paidOk) return json({ status: "pending" });
      // If Bakong tells us who was paid, it must be our account (defence in depth; the MD5 is already unique to our QR).
      if (tx.toAccountId && ![cfg("BAKONG_ACCOUNT_ID")].includes(String(tx.toAccountId))) {
        console.error("Paid to unexpected account", tx.toAccountId);
        return json({ status: "pending" });
      }

      // Claim atomically so two concurrent checks cannot extend Premium twice.
      const { data: claimed } = await admin.from("payments")
        .update({ status: "paid", paid_at: new Date().toISOString(), bakong_hash: tx.hash ?? null })
        .eq("id", p.id).in("status", ["pending", "expired"]).select().maybeSingle();

      if (claimed) {
        const cur = await premiumUntil();
        const base = cur && new Date(cur) > new Date() ? new Date(cur) : new Date();
        const next = new Date(base.getTime() + DAYS * 86_400_000).toISOString();
        await admin.from("profiles").upsert({ id: user.id, premium_until: next });
      }
      return json({ status: "paid", premium_until: await premiumUntil() });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
