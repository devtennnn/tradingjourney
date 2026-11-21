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

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// Plans: Premium = chart uploads. Elite = chart uploads + Market News Analysis + Signal Provider. Ultra = Elite + Premium (top tier).
const PLANS: Record<string, { price: number; col: string; label: string }> = {
  premium: { price: Number(env("PLAN_PRICE", "2.5")), col: "premium_until", label: "Premium" },
  elite:   { price: Number(env("PLAN_PRICE_ELITE", "14.99")), col: "elite_until", label: "Elite" },
  ultra:   { price: Number(env("PLAN_PRICE_ULTRA", "49.99")), col: "ultra_until", label: "Ultra" },
  // AROM Academy course: one payment, lifetime access. The database trigger payments_course_paid sets course_until when the row turns paid.
  course:  { price: Number(env("COURSE_PRICE", "19.99")), col: "course_until", label: "Academy" },
};
const planOf = (v: unknown) => (v === "course" ? "course" : v === "ultra" ? "ultra" : v === "elite" ? "elite" : "premium");
const CURRENCY = "USD" as const;
const MERCHANT = env("MERCHANT_NAME", "AROM TRADE");
const RECOVER_DAYS = 3;

/* ---------- KHQRPay API ---------- */
const KP_BASE = "https://khqrpay.dev";   // always this exact origin: www. answers 308 and many clients drop Authorization on redirects
const kpKey = () => env("KHQRPAY_SECRET_KEY").trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type KpResult = { ok: true; status: number; data: any } | { ok: false; status: number; code: string; retryAfter: number };

async function kpRequest(method: "GET" | "POST", path: string, body?: unknown, idempotencyKey?: string): Promise<KpResult> {
  const headers: Record<string, string> = { Authorization: `Bearer ${kpKey()}`, Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  let res: Response;
  try {
    res = await fetch(KP_BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(15000) });
  } catch (e) {
    console.error("KHQRPay request failed", method, path, String((e as Error)?.message ?? e));
    return { ok: false, status: 0, code: "network_error", retryAfter: 0 };
  }
  const retryAfter = Number(res.headers.get("retry-after") ?? 0) || 0;
  let j: any = null;
  try { j = await res.json(); } catch { j = null; }
  if (res.ok) return { ok: true, status: res.status, data: j };
  const code = j && typeof j.error === "string" ? j.error : `http_${res.status}`;   // branch on the code only, never on the message
  console.error("KHQRPay error", method, path, res.status, code);
  return { ok: false, status: res.status, code, retryAfter };
}

/** POST /v1/payments for one checkout attempt. A 500 / 502 / 503 is retried once with the SAME Idempotency-Key. */
async function kpCreate(bill: string, amount: number, plan: string): Promise<KpResult> {
  const body = { amount: amount.toFixed(2), currency: CURRENCY, reference_id: bill, metadata: { plan } };
  let r = await kpRequest("POST", "/v1/payments", body, bill);
  if (!r.ok && [0, 500, 502, 503].includes(r.status) && r.retryAfter <= 3) {
    await sleep(Math.max(500, r.retryAfter * 1000));
    r = await kpRequest("POST", "/v1/payments", body, bill);
  }
  return r;
}

/** What the browser is told about a failed create (codes it already knows, or a generic one). */
function createError(r: Extract<KpResult, { ok: false }>) {
  if (r.status === 429) return { error: "busy", retry_after: r.retryAfter || 60 };   // never sleep inside the request: the buyer retries
  if (r.code === "quota_exceeded" || r.code === "payment_link_disabled" || r.code === "payment_link_not_found" || r.code === "account_blocked" || r.code === "api_key_blocked" || r.code === "unauthorized")
    return { error: "unavailable" };
  return { error: "create_failed" };
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
      id: p.id, plan: p.plan ?? "premium", payload: p.payload, bill: p.bill_number, checkout_url: null, amount: Number(p.amount), currency: p.currency,
      merchant: MERCHANT, expires_at: p.expires_at,
      list_price: p.list_price != null ? Number(p.list_price) : Number(p.amount), discount: Number(p.discount ?? 0), promo_code: p.promo_code ?? null,
    });
    const untilFor = async (col: string) =>
      ((await admin.from("profiles").select(col).eq("id", user.id).maybeSingle()).data as any)?.[col] ?? null;

    /** Promo check with the database rules. Fails CLOSED: if the check cannot run, no discount is given. */
    const promoQuote = async (plan: string, code: string) => {
      // The user's own open QR with this promo already holds a use: show its price instead of "already used".
      const { data: mineOpen } = await admin.from("payments").select("promo_code,discount,amount")
        .eq("user_id", user.id).eq("plan", plan).eq("status", "pending").gt("expires_at", new Date().toISOString())
        .eq("promo_code", code.trim().toUpperCase()).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (mineOpen) {
        const { data: pc } = await admin.from("promo_codes").select("code,kind,value,plan").eq("code", mineOpen.promo_code).maybeSingle();
        return { ok: true, code: mineOpen.promo_code, kind: pc?.kind, value: pc?.value, plan: pc?.plan, list_price: PLANS[plan].price, discount: Number(mineOpen.discount ?? 0), final: Number(mineOpen.amount) } as any;
      }
      const { data, error } = await admin.rpc("promo_quote_internal", { p_user: user.id, p_code: code, p_plan: plan, p_price: PLANS[plan].price });
      if (error || !data) { console.error("promo quote failed", error && error.message); return { ok: false, error: "unavailable" } as any; }
      return data as any;
    };

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
      if (!kpKey()) { console.error("KHQRPAY_SECRET_KEY is not set"); return json({ error: "unavailable" }); }
      const plan = planOf(body.plan), P = PLANS[plan], promo = String(body.promo ?? "").trim();
      if (plan === "course") {   // lifetime access: never sell it twice
        const { data: pr } = await admin.from("profiles").select("course_until").eq("id", user.id).maybeSingle();
        if ((pr as any)?.course_until && new Date((pr as any).course_until) > new Date()) return json({ error: "already_owned", plan });
      }
      // Reopen the user's open QR for the same plan and promo: closing the window must not start a second payment.
      const want = promo ? promo.toUpperCase() : null;
      let oq = admin.from("payments").select("*").eq("user_id", user.id).eq("provider", "khqrpay").eq("status", "pending").eq("plan", plan)
        .not("kp_payment_id", "is", null).gt("expires_at", new Date(Date.now() + 20_000).toISOString());
      oq = want ? oq.eq("promo_code", want) : oq.is("promo_code", null);
      const { data: open } = await oq.order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (open) return json(publicRow(open));

      let quote: any = null;
      if (promo) {
        quote = await promoQuote(plan, promo);
        if (!quote.ok) return json({ error: "promo_" + quote.error, plan: quote.plan ?? null });
      }
      const price = quote ? Number(quote.final) : P.price;

      // 1. Our order row first (reference_id = bill number = this checkout attempt's Idempotency-Key). With a promo the
      //    database re-checks the limits under a lock, so two buyers cannot both take the last use.
      const bill = billNumber(), holdUntil = new Date(Date.now() + 5 * 60_000).toISOString();
      let row: any = null;
      if (quote) {
        const { data, error } = await admin.rpc("create_payment_row", {
          p_user: user.id, p_bill: bill, p_md5: "kp:" + bill, p_payload: "", p_plan: plan, p_list_price: P.price, p_amount: price,
          p_currency: CURRENCY, p_expires: holdUntil, p_code: quote.code,
        });
        if (error) { const m = String(error.message || ""); return json({ error: /^promo_[a-z_]+$/.test(m) ? m : "promo_unavailable" }); }
        row = data;
        await admin.from("payments").update({ provider: "khqrpay" }).eq("id", row.id);
      } else {
        const { data, error } = await admin.from("payments").insert({
          user_id: user.id, bill_number: bill, md5: "kp:" + bill, payload: "", list_price: P.price, discount: 0,
          plan, amount: price, currency: CURRENCY, status: "pending", expires_at: holdUntil, provider: "khqrpay",
        }).select().single();
        if (error) { console.error("payment row insert failed", error.message); return json({ error: "create_failed" }); }
        row = data;
      }

      // 2. The KHQRPay payment for it
      const r = await kpCreate(bill, price, plan);
      if (!r.ok) {
        await admin.from("payments").update({ status: "expired" }).eq("id", row.id).eq("status", "pending");   // frees a promo reservation
        return json(createError(r));
      }
      const kp = r.data;
      if (kp.currency !== CURRENCY || Number(kp.amount) !== Number(price.toFixed(2))) {
        // the ABA link is expected to be USD: if it was reconnected in another currency the QR asks for a different amount
        console.error("KHQRPay amount differs from the order", { bill, asked: price, payer: kp.amount, currency: kp.currency, rate: kp.conversion_rate });
      }
      const { data: saved, error: se } = await admin.from("payments").update({
        kp_payment_id: kp.id, kp_livemode: !!kp.livemode, payload: kp.qr_string, expires_at: kp.expires_at,
      }).eq("id", row.id).select().single();
      if (se) { console.error("payment row update failed", se.message); return json({ error: "create_failed" }); }
      return json({ ...publicRow(saved), amount: Number(kp.amount), currency: kp.currency });
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
