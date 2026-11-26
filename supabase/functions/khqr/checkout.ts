// Shared checkout through KHQRPay (https://khqrpay.dev), used by the khqr function (website) and tg-webhook (Telegram bot).
// One payments row + one KHQRPay payment per checkout attempt: reference_id = bill number = Idempotency-Key.
// The order turns paid only when the signed payment.completed webhook reaches khqrpay-webhook.
// Secrets: KHQRPAY_SECRET_KEY (kp_test_... / kp_live_...), PLAN_PRICE, PLAN_PRICE_ELITE, PLAN_PRICE_ULTRA, COURSE_PRICE.

const env = (k: string, d = "") => Deno.env.get(k) ?? d;

// Plans: Premium = chart uploads. Elite = chart uploads + Market News Analysis + Signal Provider. Ultra = Elite + Premium (top tier).
export const PLANS: Record<string, { price: number; col: string; label: string }> = {
  premium: { price: Number(env("PLAN_PRICE", "2.5")), col: "premium_until", label: "Premium" },
  elite:   { price: Number(env("PLAN_PRICE_ELITE", "14.99")), col: "elite_until", label: "Elite" },
  ultra:   { price: Number(env("PLAN_PRICE_ULTRA", "49.99")), col: "ultra_until", label: "Ultra" },
  // AROM Academy course: one payment, lifetime access. The database trigger payments_course_paid sets course_until when the row turns paid.
  course:  { price: Number(env("COURSE_PRICE", "19.99")), col: "course_until", label: "Academy" },
  // IB & Community Partner: 30 days of IB status + 30 days of Elite + three 5 % codes (database: ib_activate when the row turns paid)
  ib:      { price: Number(env("PLAN_PRICE_IB", "19.99")), col: "ib_until", label: "IB Partner" },
};
export const planOf = (v: unknown) => (v === "course" ? "course" : v === "ib" ? "ib" : v === "ultra" ? "ultra" : v === "elite" ? "elite" : "premium");
export const CURRENCY = "USD" as const;

/* ---------- KHQRPay API ---------- */
const KP_BASE = "https://khqrpay.dev";   // always this exact origin: www. answers 308 and many clients drop Authorization on redirects
export const kpKey = () => env("KHQRPAY_SECRET_KEY").trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type KpResult = { ok: true; status: number; data: any } | { ok: false; status: number; code: string; retryAfter: number };

export async function kpRequest(method: "GET" | "POST", path: string, body?: unknown, idempotencyKey?: string): Promise<KpResult> {
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
async function kpCreate(bill: string, amount: number, plan: string, via: string): Promise<KpResult> {
  const body = { amount: amount.toFixed(2), currency: CURRENCY, reference_id: bill, metadata: { plan, via } };
  let r = await kpRequest("POST", "/v1/payments", body, bill);
  if (!r.ok && [0, 500, 502, 503].includes(r.status) && r.retryAfter <= 3) {
    await sleep(Math.max(500, r.retryAfter * 1000));
    r = await kpRequest("POST", "/v1/payments", body, bill);
  }
  return r;
}

/** What the buyer is told about a failed create (codes the website already knows, or a generic one). */
function createError(r: Extract<KpResult, { ok: false }>) {
  if (r.status === 429) return { error: "busy", retry_after: r.retryAfter || 60 };   // never sleep inside the request: the buyer retries
  if (["quota_exceeded", "payment_link_disabled", "payment_link_not_found", "account_blocked", "api_key_blocked", "unauthorized"].includes(r.code))
    return { error: "unavailable" };
  return { error: "create_failed" };
}

const billNumber = () =>
  "DT" + Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[b % 32]).join("");

/** Promo check with the database rules. Fails CLOSED: if the check cannot run, no discount is given. */
export async function promoQuote(admin: any, userId: string, plan: string, code: string) {
  // The user's own open QR with this promo already holds a use: show its price instead of "already used".
  const { data: mineOpen } = await admin.from("payments").select("promo_code,discount,amount")
    .eq("user_id", userId).eq("plan", plan).eq("status", "pending").gt("expires_at", new Date().toISOString())
    .eq("promo_code", code.trim().toUpperCase()).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (mineOpen) {
    const { data: pc } = await admin.from("promo_codes").select("code,kind,value,plan").eq("code", mineOpen.promo_code).maybeSingle();
    return { ok: true, code: mineOpen.promo_code, kind: pc?.kind, value: pc?.value, plan: pc?.plan, list_price: PLANS[plan].price, discount: Number(mineOpen.discount ?? 0), final: Number(mineOpen.amount) } as any;
  }
  const { data, error } = await admin.rpc("promo_quote_internal", { p_user: userId, p_code: code, p_plan: plan, p_price: PLANS[plan].price });
  if (error || !data) { console.error("promo quote failed", error && error.message); return { ok: false, error: "unavailable" } as any; }
  return data as any;
}

export type Checkout =
  | { ok: true; row: any; amount: number; currency: string; checkoutUrl: string | null; reused: boolean }
  | { ok: false; error: string; plan?: string | null; retry_after?: number };

/**
 * Create (or reopen) the checkout for one user and plan.
 *   admin   Supabase client with the service role
 *   via     "web" or "telegram" (sent to KHQRPay as metadata)
 */
export async function createCheckout(admin: any, userId: string, planIn: unknown, promoIn: unknown, via: string): Promise<Checkout> {
  if (!kpKey()) { console.error("KHQRPAY_SECRET_KEY is not set"); return { ok: false, error: "unavailable" }; }
  const plan = planOf(planIn), P = PLANS[plan], promo = String(promoIn ?? "").trim();
  if (plan === "course") {   // lifetime access: never sell it twice
    const { data: pr } = await admin.from("profiles").select("course_until").eq("id", userId).maybeSingle();
    if (pr?.course_until && new Date(pr.course_until) > new Date()) return { ok: false, error: "already_owned", plan };
  }
  // Reopen the user's open QR for the same plan and promo: closing the window must not start a second payment.
  const want = promo ? promo.toUpperCase() : null;
  let oq = admin.from("payments").select("*").eq("user_id", userId).eq("provider", "khqrpay").eq("status", "pending").eq("plan", plan)
    .not("kp_payment_id", "is", null).gt("expires_at", new Date(Date.now() + 20_000).toISOString());
  oq = want ? oq.eq("promo_code", want) : oq.is("promo_code", null);
  const { data: open } = await oq.order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (open) return { ok: true, row: open, amount: Number(open.amount), currency: open.currency, checkoutUrl: null, reused: true };

  let quote: any = null;
  if (promo) {
    quote = await promoQuote(admin, userId, plan, promo);
    if (!quote.ok) return { ok: false, error: "promo_" + quote.error, plan: quote.plan ?? null };
  }
  const price = quote ? Number(quote.final) : P.price;

  // 1. Our order row first. With a promo the database re-checks the limits under a lock, so two buyers cannot both take the last use.
  const bill = billNumber(), holdUntil = new Date(Date.now() + 5 * 60_000).toISOString();
  let row: any = null;
  if (quote) {
    const { data, error } = await admin.rpc("create_payment_row", {
      p_user: userId, p_bill: bill, p_md5: "kp:" + bill, p_payload: "", p_plan: plan, p_list_price: P.price, p_amount: price,
      p_currency: CURRENCY, p_expires: holdUntil, p_code: quote.code,
    });
    if (error) { const m = String(error.message || ""); return { ok: false, error: /^promo_[a-z_]+$/.test(m) ? m : "promo_unavailable" }; }
    row = data;
    await admin.from("payments").update({ provider: "khqrpay" }).eq("id", row.id);
  } else {
    const { data, error } = await admin.from("payments").insert({
      user_id: userId, bill_number: bill, md5: "kp:" + bill, payload: "", list_price: P.price, discount: 0,
      plan, amount: price, currency: CURRENCY, status: "pending", expires_at: holdUntil, provider: "khqrpay",
    }).select().single();
    if (error) { console.error("payment row insert failed", error.message); return { ok: false, error: "create_failed" }; }
    row = data;
  }

  // 2. The KHQRPay payment for it
  const r = await kpCreate(bill, price, plan, via);
  if (!r.ok) {
    await admin.from("payments").update({ status: "expired" }).eq("id", row.id).eq("status", "pending");   // frees a promo reservation
    return { ok: false, ...createError(r) };
  }
  const kp = r.data;
  if (kp.currency !== CURRENCY || Number(kp.amount) !== Number(price.toFixed(2))) {
    // the ABA link is expected to be USD: if it was reconnected in another currency the QR asks for a different amount
    console.error("KHQRPay amount differs from the order", { bill, asked: price, payer: kp.amount, currency: kp.currency, rate: kp.conversion_rate });
  }
  const { data: saved, error: se } = await admin.from("payments").update({
    kp_payment_id: kp.id, kp_livemode: !!kp.livemode, payload: kp.qr_string, expires_at: kp.expires_at,
  }).eq("id", row.id).select().single();
  if (se) { console.error("payment row update failed", se.message); return { ok: false, error: "create_failed" }; }
  return { ok: true, row: saved, amount: Number(kp.amount), currency: kp.currency, checkoutUrl: kp.checkout_url ?? null, reused: false };
}
