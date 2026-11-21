// Supabase Edge Function: khqrpay-webhook  (deploy with verify_jwt = false: KHQRPay signs its requests, it sends no Supabase JWT)
// Receives KHQRPay events (payment.completed / scanned / expired / failed).
//   1. Reads the RAW body and verifies X-KHQRPay-Signature before anything parses it (lib.mjs).
//   2. Ignores test events and payments that are not ours, with a 2xx.
//   3. Calls khqrpay_handle_event() (supabase/sql/khqrpay.sql): de-duplicates on the event id and, in the same transaction,
//      marks the order paid and extends the plan, only for payment.completed. Answers within 10 seconds; the Telegram
//      "payment received" message is sent asynchronously by the existing database trigger (pay-notify via pg_net).
// Secrets: KHQRPAY_WEBHOOK_SECRET (the endpoint's whsec_... signing secret, used whole), PLAN_DAYS (default 30).
import { createClient } from "jsr:@supabase/supabase-js@2";
import { handleWebhook } from "./lib.mjs";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const DAYS = Number(env("PLAN_DAYS", "30"));
const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const store = {
  async handleEvent(eventId: string, type: string, payment: unknown) {
    const { data, error } = await db.rpc("khqrpay_handle_event", { p_event_id: eventId, p_type: type, p_payment: payment, p_days: DAYS });
    if (error) throw new Error(error.message);
    return data as { result: string };
  },
};

Deno.serve(async (req) => {
  if (req.method !== "POST") return reply(405, { error: "method_not_allowed" });
  try {
    const rawBody = await req.text();   // raw text first: the signature covers these exact bytes
    const out = await handleWebhook({
      rawBody,
      header: req.headers.get("x-khqrpay-signature"),
      secret: env("KHQRPAY_WEBHOOK_SECRET"),
      store,
      log: (...a: unknown[]) => console.log("khqrpay-webhook", ...a),
    });
    return reply(out.status, out.body);
  } catch (e) {
    console.error("khqrpay-webhook error", String((e as Error)?.message ?? e));
    return reply(500, { error: "server_error" });   // not 2xx: KHQRPay retries (live endpoints), and the event id was rolled back
  }
});
