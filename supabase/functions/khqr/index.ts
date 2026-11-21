// Supabase Edge Function: "khqr" — checkout for the Premium / Elite / Ultra plans and the Academy course, through KHQRPay
// (https://khqrpay.dev): we create a payment, the buyer scans the KHQR with any Cambodian banking app, the money goes to our ABA account.
//
// Actions (the browser calls them with the user's Supabase session):
//   quote   exact price for a plan, with an optional promo code (rules in the database)
//   create  one KHQRPay payment per checkout attempt; returns the KHQR string (payload) and expires_at for the QR modal
//   check   the order's status FROM OUR DATABASE. The order turns paid only when the signed payment.completed webhook
//           reaches khqrpay-webhook. The browser never decides that a payment is paid, and this function never polls KHQRPay
//           (the daily read budget is for webhooks + support, not polling).
//   recover the user's unpaid QRs of the last 3 days, so they can tell the admin "I paid this one" (claim_payment)
//   diag    admins: which key mode is set and the plan usage (GET /v1/usage). Reveals no secret.
//
// Secrets (Supabase → Edge Functions → Secrets, never in the browser):
//   KHQRPAY_SECRET_KEY  kp_test_... while building, kp_live_... in production
//   PLAN_PRICE (2.5), PLAN_PRICE_ELITE (14.99), PLAN_PRICE_ULTRA (49.99), COURSE_PRICE (19.99), PLAN_DAYS (30), MERCHANT_NAME (shown under the QR)
// The ABA payment link connected in KHQRPay is in USD, so the payer pays exactly the USD price (no conversion).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { PLANS, planOf, kpKey, kpRequest, promoQuote as promoQuoteFor, createCheckout } from "./checkout.ts";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const MERCHANT = env("MERCHANT_NAME", "AROM TRADE");
const RECOVER_DAYS = 3;

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
      id: p.id, plan: p.plan ?? "premium", payload: p.payload, bill: p.bill_number, checkout_url: null, amount: Number(p.amount), currency: p.currency,
      merchant: MERCHANT, expires_at: p.expires_at,
      list_price: p.list_price != null ? Number(p.list_price) : Number(p.amount), discount: Number(p.discount ?? 0), promo_code: p.promo_code ?? null,
    });
    const untilFor = async (col: string) =>
      ((await admin.from("profiles").select(col).eq("id", user.id).maybeSingle()).data as any)?.[col] ?? null;

    const promoQuote = (plan: string, code: string) => promoQuoteFor(admin, user.id, plan, code);

    /* ---------- quote ---------- */
    if (body.action === "quote") {
      const plan = planOf(body.plan), P = PLANS[plan], code = String(body.promo ?? "").trim();
      if (!code) return json({ ok: true, plan, list_price: P.price, discount: 0, final: P.price, promo: null });
      const q = await promoQuote(plan, code);
      if (!q.ok) return json({ ok: false, error: q.error, plan: q.plan ?? null, list_price: P.price });
      return json({ ok: true, plan, list_price: P.price, discount: Number(q.discount), final: Number(q.final), promo: { code: q.code, kind: q.kind, value: Number(q.value) } });
    }

    /* ---------- create ---------- */
    if (body.action === "create") {
      const c = await createCheckout(admin, user.id, body.plan, body.promo, "web");
      if (!c.ok) { const { ok: _ok, ...err } = c; return json(err); }
      return json({ ...publicRow(c.row), amount: c.amount, currency: c.currency });
    }

    /* ---------- check: our database only ---------- */
    if (body.action === "check") {
      const { data: p } = await admin.from("payments").select("*").eq("id", body.id).eq("user_id", user.id).maybeSingle();
      if (!p) return json({ error: "payment not found" }, 404);
      const plan = planOf(p.plan);
      if (p.status === "paid") { const u = await untilFor(PLANS[plan].col); return json({ status: "paid", plan, until: u, premium_until: u }); }
      // past its deadline with no webhook yet: show it as expired (a late payment still turns it paid through the webhook)
      const status = p.status === "pending" && new Date(p.expires_at).getTime() < Date.now() ? "expired" : p.status;
      // monitoring gap: KHQRPay could not watch the bank for a while, so an approval may never be reported. Not "unpaid": the buyer can claim it.
      return json({ status, plan, gap: !!p.monitoring_gap });
    }

    /* ---------- recover ---------- */
    if (body.action === "recover") {
      const since = new Date(Date.now() - RECOVER_DAYS * 86_400_000).toISOString();
      const { data: rows } = await admin.from("payments").select("*")
        .eq("user_id", user.id).in("status", ["pending", "expired", "claimed", "paid"]).gt("created_at", since)
        .order("created_at", { ascending: false }).limit(10);
      const recentPaid = (rows ?? []).find((p: any) => p.status === "paid" && Date.now() - new Date(p.paid_at || p.created_at).getTime() < 86_400_000);
      if (recentPaid) { const plan = planOf(recentPaid.plan), u = await untilFor(PLANS[plan].col); return json({ status: "paid", plan, until: u, premium_until: u }); }
      const open = (rows ?? []).filter((p: any) => p.status !== "paid" && p.payload);
      const unpaid = open.filter((p: any) => p.status !== "claimed")
        .map((p: any) => ({ id: p.id, bill: p.bill_number, plan: p.plan ?? "premium", amount: Number(p.amount), currency: p.currency, created_at: p.created_at }));
      return json({ status: open.some((p: any) => p.status === "claimed") ? "claimed" : "none", unpaid });
    }

    /* ---------- diag: admins only ---------- */
    if (body.action === "diag") {
      const { data: prof } = await admin.from("profiles").select("is_admin").eq("id", user.id).maybeSingle();
      if (!(prof as any)?.is_admin) return json({ error: "forbidden" }, 403);
      const key = kpKey(), mode = key.startsWith("kp_live_") ? "live" : key.startsWith("kp_test_") ? "test" : key ? "unknown" : "not set";
      const usage = key ? await kpRequest("GET", "/v1/usage") : null;
      const ok = !!usage && usage.ok;
      const verdict = !key ? "KHQRPAY_SECRET_KEY is not set: checkout is off."
        : !ok ? `KHQRPay refused the key or could not be reached (${(usage as any).code}).`
        : mode === "test" ? "OK, TEST mode: payments are simulated and never reach the bank, and the webhook does not unlock plans for them."
        : "OK: live payments through KHQRPay.";
      return json({
        ok, provider: "khqrpay", verdict, mode, webhookSecretSet: !!env("KHQRPAY_WEBHOOK_SECRET").trim(),
        webhook: `${url}/functions/v1/khqrpay-webhook`, usage: ok ? (usage as any).data : null,
      });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    console.error("khqr error", String((e as Error)?.message ?? e));
    return json({ error: "server error" }, 500);
  }
});
