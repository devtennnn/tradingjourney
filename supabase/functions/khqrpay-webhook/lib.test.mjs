// Tests for the KHQRPay webhook. Run: node --test supabase/functions/khqrpay-webhook/lib.test.mjs
// The store below mirrors khqrpay_handle_event() (supabase/sql/khqrpay.sql) in memory; khqrpay.test.sql checks the SQL itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { handleWebhook, verifySignature, parseSignature } from "./lib.mjs";

const SECRET = "whsec_test-Secret_with-dash_and_underscore";
const NOW = 1_795_000_000;
const sign = (body, t = NOW, secret = SECRET) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;

function memoryStore() {
  const events = new Set(), orders = new Map(), calls = [];
  orders.set("DTORDER1", { status: "pending", amount: "14.99", currency: "USD", plan: "elite", kp: null, extended: 0 });
  return {
    orders, calls,
    async handleEvent(id, type, p) {
      calls.push(id);
      if (events.has(id)) return { result: "duplicate" };
      events.add(id);
      const o = orders.get(p.reference_id);
      if (!o) return { result: "ignored_unknown_reference" };
      if (o.kp && o.kp !== p.id) return { result: "ignored_payment_mismatch" };
      o.kp = p.id;
      if (type === "payment.completed") {
        if ((p.requested_currency ?? p.currency) !== o.currency || Number(p.requested_amount ?? p.amount).toFixed(2) !== Number(o.amount).toFixed(2)) return { result: "amount_mismatch" };
        if (o.status === "paid") return { result: "already_paid" };
        o.status = "paid"; o.extended++;
        return { result: p.late ? "paid_late" : "paid" };
      }
      if (type === "payment.expired" || type === "payment.failed") { if (o.status === "pending") { o.status = "expired"; return { result: "expired" }; } return { result: "unchanged" }; }
      return { result: "scanned" };
    },
  };
}
const event = (type, extra = {}, payment = {}) => JSON.stringify({
  id: "evt_" + Math.random().toString(36).slice(2), type, livemode: true, created: "2026-11-21T10:00:00Z",
  data: { payment: { id: "pay_abc", status: type === "payment.completed" ? "paid" : "expired", amount: "14.99", currency: "USD",
    requested_amount: "14.99", requested_currency: "USD", settlement_amount: "14.99", settlement_currency: "USD", conversion_rate: null,
    reference_id: "DTORDER1", metadata: {}, approved_at: null, ...payment } }, ...extra });
const deliver = (store, body, header = sign(body), secret = SECRET, nowS = NOW) => handleWebhook({ rawBody: body, header, secret, store, nowS });

test("valid signature: payment.completed marks the order paid once", async () => {
  const s = memoryStore(), body = event("payment.completed");
  const r = await deliver(s, body);
  assert.equal(r.status, 200); assert.equal(r.body.result, "paid");
  assert.equal(s.orders.get("DTORDER1").status, "paid"); assert.equal(s.orders.get("DTORDER1").extended, 1);
});

test("signing secret with whsec_ prefix, - and _ is used whole as UTF-8 text", async () => {
  const body = event("payment.scanned");
  assert.equal((await verifySignature({ rawBody: body, header: sign(body), secret: SECRET, nowS: NOW })).ok, true);
  const stripped = SECRET.replace(/^whsec_/, "");
  assert.equal((await verifySignature({ rawBody: body, header: sign(body, NOW, stripped), secret: SECRET, nowS: NOW })).ok, false);
});

test("tampered body is rejected with 400 and nothing is stored", async () => {
  const s = memoryStore(), body = event("payment.completed"), header = sign(body);
  const r = await deliver(s, body.replace('"14.99"', '"0.01"'), header);
  assert.equal(r.status, 400); assert.equal(r.body.error, "bad_signature"); assert.equal(s.calls.length, 0);
});

test("missing signature header gets 400, not a crash", async () => {
  const s = memoryStore(), body = event("payment.completed");
  for (const h of [null, undefined, ""]) {
    const r = await handleWebhook({ rawBody: body, header: h, secret: SECRET, store: s, nowS: NOW });
    assert.equal(r.status, 400); assert.equal(r.body.error, "missing_signature");
  }
  assert.equal(s.calls.length, 0);
});

test("malformed signature headers get 400", async () => {
  const s = memoryStore(), body = event("payment.completed");
  for (const h of ["garbage", "t=abc,v1=00", `t=${NOW}`, "v1=" + "a".repeat(64), `t=${NOW},v1=zz`, `t=${NOW},v1=${"a".repeat(63)}`, "=,=", `t=${NOW},v1`, "x".repeat(5000)]) {
    const r = await deliver(s, body, h);
    assert.equal(r.status, 400, h.slice(0, 30)); assert.equal(r.body.error, "malformed_signature");
  }
  assert.equal(parseSignature(`t=${NOW},v1=${"A".repeat(64)}`).v1[0], "a".repeat(64));
  assert.equal(s.calls.length, 0);
});

test("unset or empty signing secret refuses every event, even one signed with an empty key", async () => {
  const s = memoryStore(), body = event("payment.completed"), emptySigned = sign(body, NOW, "");
  for (const secret of [undefined, null, "", "   "]) {
    const r = await handleWebhook({ rawBody: body, header: emptySigned, secret, store: s, nowS: NOW });
    assert.notEqual(r.status, 200); assert.equal(r.body.error, "webhook_secret_not_configured");
  }
  assert.equal(s.calls.length, 0);
});

test("timestamp more than 5 minutes old is rejected", async () => {
  const s = memoryStore(), body = event("payment.completed"), t = NOW - 301;
  const r = await deliver(s, body, sign(body, t));
  assert.equal(r.status, 400); assert.equal(r.body.error, "timestamp_out_of_range");
  assert.equal((await deliver(s, body, sign(body, NOW - 299))).status, 200);   // just inside the window still works
});

test("timestamp more than 5 minutes ahead is rejected", async () => {
  const s = memoryStore(), body = event("payment.completed");
  const r = await deliver(s, body, sign(body, NOW + 301));
  assert.equal(r.status, 400); assert.equal(r.body.error, "timestamp_out_of_range"); assert.equal(s.calls.length, 0);
});

test("duplicate event (same id, fresh signature) is answered 2xx and fulfils only once", async () => {
  const s = memoryStore(), body = event("payment.completed");
  const a = await deliver(s, body, sign(body, NOW));
  const b = await deliver(s, body, sign(body, NOW + 60), SECRET, NOW + 60);   // a retry / resend is signed afresh
  assert.equal(a.body.result, "paid"); assert.equal(b.status, 200); assert.equal(b.body.result, "duplicate");
  assert.equal(s.orders.get("DTORDER1").extended, 1);
});

test("two different events for the same payment are not de-duplicated by payment id", async () => {
  const s = memoryStore();
  await deliver(s, event("payment.scanned"));
  const r = await deliver(s, event("payment.completed"));
  assert.equal(r.body.result, "paid");
});

test("test events (livemode false, or test: true) get 2xx and fulfil nothing", async () => {
  const s = memoryStore();
  for (const extra of [{ livemode: false }, { livemode: false, test: true }, { test: true }]) {
    const body = event("payment.completed", extra);
    const r = await deliver(s, body);
    assert.equal(r.status, 200); assert.equal(r.body.ignored, "test_event");
  }
  assert.equal(s.calls.length, 0); assert.equal(s.orders.get("DTORDER1").status, "pending");
});

test("payment-link payments (reference_id link:...) get 2xx and are ignored", async () => {
  const s = memoryStore(), r = await deliver(s, event("payment.completed", {}, { reference_id: "link:abc123" }));
  assert.equal(r.status, 200); assert.equal(r.body.ignored, "not_our_order"); assert.equal(s.calls.length, 0);
});

test("late payment: payment.completed with late=true after payment.expired is honoured", async () => {
  const s = memoryStore();
  const e = await deliver(s, event("payment.expired"));
  assert.equal(e.body.result, "expired"); assert.equal(s.orders.get("DTORDER1").status, "expired");
  const c = await deliver(s, event("payment.completed", {}, { late: true }));
  assert.equal(c.status, 200); assert.equal(c.body.result, "paid_late");
  assert.equal(s.orders.get("DTORDER1").status, "paid"); assert.equal(s.orders.get("DTORDER1").extended, 1);
});

test("payment.expired arriving after payment.completed leaves the order paid", async () => {
  const s = memoryStore();
  await deliver(s, event("payment.completed", {}, { late: true }));
  const e = await deliver(s, event("payment.expired"));
  assert.equal(e.status, 200); assert.equal(e.body.result, "unchanged");
  assert.equal(s.orders.get("DTORDER1").status, "paid"); assert.equal(s.orders.get("DTORDER1").extended, 1);
});

test("a completed event whose requested amount differs from the order is not fulfilled", async () => {
  const s = memoryStore(), r = await deliver(s, event("payment.completed", {}, { requested_amount: "2.50", amount: "2.50" }));
  assert.equal(r.status, 200); assert.equal(r.body.result, "amount_mismatch"); assert.equal(s.orders.get("DTORDER1").status, "pending");
});

test("a database error is not acknowledged (5xx path), so the event is retried", async () => {
  const s = { async handleEvent() { throw new Error("db down"); } };
  await assert.rejects(() => deliver(s, event("payment.completed")), /db down/);
});

test("invalid JSON with a valid signature gets 400", async () => {
  const s = memoryStore(), body = "{not json";
  const r = await deliver(s, body);
  assert.equal(r.status, 400); assert.equal(r.body.error, "invalid_json");
});
