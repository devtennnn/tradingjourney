// Supabase Edge Function: "khqr-webhook"  (deploy with verify_jwt = FALSE: the gateway calls it, not a logged-in user)
//
// Receives the signed "payment confirmed" call from Anajak Pay (KHQRPay) and activates the plan.
//   POST application/json  { req_time, transaction_id, amount, status, hash, ... }
//   hash = sha256(ANAJAK_SECRET + req_time + transaction_id + amount + "SUCCESS")
// transaction_id is OUR bill number (DT...), the one the khqr function put in the checkout URL.
//
// Security: nothing is trusted until the hash matches the secret that only the gateway and this function know; the amount must cover the price
// we asked for; the plan is extended once (atomic status change), so retries and duplicates are harmless.
// GET (the customer's browser is sent here after paying) only shows a plain message: it never activates anything.
//
// Secrets: ANAJAK_SECRET (required), PLAN_DAYS (default 30).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const DAYS = Number(env("PLAN_DAYS", "30"));
const COL: Record<string, string> = { premium: "premium_until", elite: "elite_until" };
const J = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
/** constant-time compare of two hex strings */
function same(a: string, b: string): boolean {
  a = String(a || "").toLowerCase(); b = String(b || "").toLowerCase();
  if (a.length !== b.length || !a.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
/** The amount text is part of the signed string. The gateway may send 2.5, "2.5" or "2.50", so try each way of writing the same number. */
function amountForms(raw: string | null, parsed: unknown): string[] {
  const n = Number(parsed), out = new Set<string>();
  if (raw) out.add(raw);
  if (typeof parsed === "string" && parsed) out.add(parsed);
  if (Number.isFinite(n)) { out.add(String(n)); out.add(n.toFixed(2)); out.add(n.toFixed(4)); }
  return [...out];
}

Deno.serve(async (req) => {
  if (req.method === "GET" || req.method === "HEAD") return new Response("Payment received. Go back to the site: it unlocks by itself within a few seconds.", { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  if (req.method !== "POST") return J({ error: "method not allowed" }, 405);
  try {
    const secret = env("ANAJAK_SECRET").trim();
    if (!secret) { console.error("ANAJAK_SECRET is not set"); return J({ error: "not configured" }, 503); }
    const text = await req.text();
    let body: any;
    try { body = JSON.parse(text); } catch { return J({ error: "bad json" }, 400); }
    const tid = String(body.transaction_id ?? ""), reqTime = String(body.req_time ?? ""), given = String(body.hash ?? "");
    if (!tid || !reqTime || !given) return J({ error: "missing fields" }, 400);

    // the amount exactly as the gateway wrote it in the JSON (before JavaScript turns 2.50 into 2.5)
    const m = text.match(/"amount"\s*:\s*("?)([0-9]+(?:\.[0-9]+)?)\1/);
    let signed = false;
    for (const a of amountForms(m ? m[2] : null, body.amount)) {
      if (same(await sha256hex(secret + reqTime + tid + a + "SUCCESS"), given)) { signed = true; break; }
    }
    if (!signed) { console.error("webhook: bad signature for", tid.slice(0, 40)); return J({ error: "bad signature" }, 401); }

    const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));
    const { data: p } = await admin.from("payments").select("*").eq("bill_number", tid).maybeSingle();
    if (!p) { console.error("webhook: unknown transaction", tid.slice(0, 40)); return J({ error: "unknown transaction" }, 404); }
    if (!/^https:\/\//.test(String(p.payload || ""))) return J({ error: "not a hosted checkout payment" }, 400);
    if (p.status === "paid") return J({ ok: true, already: true });
    if (p.status === "rejected") { console.error("webhook: payment was rejected by an admin", tid); return J({ error: "rejected" }, 409); }

    const paid = Number(body.amount);
    if (!Number.isFinite(paid) || paid < Number(p.amount) - 0.001) {
      console.error("webhook: amount too low", tid, "paid", paid, "needed", p.amount);
      return J({ error: "amount mismatch" }, 422);
    }

    // claim atomically: only one delivery can flip the row, so the plan is extended once
    const { data: claimed } = await admin.from("payments")
      .update({ status: "paid", paid_at: new Date().toISOString(), bakong_hash: String(body.payment_details?.hash ?? body.hash ?? "").slice(0, 120) || null })
      .eq("id", p.id).in("status", ["pending", "expired", "claimed"]).select().maybeSingle();
    if (claimed) {
      const plan = p.plan === "elite" ? "elite" : "premium", col = COL[plan];
      const cur = ((await admin.from("profiles").select(col).eq("id", p.user_id).maybeSingle()).data as any)?.[col] ?? null;
      const base = cur && new Date(cur) > new Date() ? new Date(cur) : new Date();
      const next = new Date(base.getTime() + DAYS * 86_400_000).toISOString();
      const { error } = await admin.from("profiles").update({ [col]: next }).eq("id", p.user_id);
      if (error) {   // undo the claim so the gateway's retry can try again; 5xx makes it retry
        console.error("webhook: could not extend plan", error.message);
        await admin.from("payments").update({ status: p.status, paid_at: null }).eq("id", p.id).eq("status", "paid");
        return J({ error: "activation failed" }, 500);
      }
    }
    return J({ ok: true });
  } catch (e) {
    console.error("webhook error", String((e as Error).message ?? e));
    return J({ error: "server error" }, 500);
  }
});
