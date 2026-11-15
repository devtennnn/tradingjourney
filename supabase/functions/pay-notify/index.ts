// @ts-nocheck
// Supabase Edge Function: pay-notify  (deploy with verify_jwt = FALSE; it is called by a database trigger and protected by the cron key)
// Posts a private Telegram message to YOU when a payment turns "paid" (Anajak webhook, own KHQR check, or admin approval).
//   POST ?key=<ai_bot_config.cron_secret>   body: { "id": "<payments.id>" }
// Where it goes: ai_bot_config key  pay_chat_id  (your private chat with the bot, or a private admin group). There is NO fallback to the
// public signals channel on purpose: payment details must never reach subscribers. Without pay_chat_id nothing is sent.
// Token: the TELEGRAM_BOT_TOKEN secret (same bot as the signals).
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const money = (n) => "$" + Number(n).toFixed(2);
const ict = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Phnom_Penh", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const maskEmail = (e) => { const [u, d] = String(e || "").split("@"); return u && d ? u.slice(0, 2) + "***@" + d : "—"; };

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const { data: cfgRows, error: ce } = await db.from("ai_bot_config").select("key,value");
  if (ce) return json({ error: ce.message }, 500);
  const c = Object.fromEntries((cfgRows || []).map((r) => [r.key, r.value]));
  if (!c.cron_secret || url.searchParams.get("key") !== c.cron_secret) return json({ error: "unauthorized" }, 401);
  const chat = (c.pay_chat_id || "").trim(), token = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
  if (!chat) return json({ ok: true, skipped: "pay_chat_id is not set in ai_bot_config" });
  if (!token) return json({ error: "TELEGRAM_BOT_TOKEN is not set" }, 500);

  let id = url.searchParams.get("id") || "";
  if (!id && req.method === "POST") { try { id = String((await req.json()).id || ""); } catch { /* ignore */ } }
  if (!id) return json({ error: "missing id" }, 400);
  const { data: p } = await db.from("payments").select("*").eq("id", id).maybeSingle();
  if (!p) return json({ error: "payment not found" }, 404);
  if (p.status !== "paid") return json({ ok: true, skipped: "payment is " + p.status });

  const { data: prof } = await db.from("profiles").select("username,display_name,premium_until,elite_until").eq("id", p.user_id).maybeSingle();
  let email = ""; try { email = (await db.auth.admin.getUserById(p.user_id)).data.user?.email || ""; } catch { /* optional */ }
  const plan = p.plan === "elite" ? "ELITE" : "PREMIUM", until = p.plan === "elite" ? prof?.elite_until : prof?.premium_until;
  const via = p.approved_by ? "admin approval" : /^https:\/\//.test(String(p.payload || "")) ? "Anajak Pay" : "KHQR (Bakong)";
  const who = prof?.username ? "@" + prof.username : prof?.display_name || "user";
  const promo = p.promo_code ? ` · promo <b>${esc(p.promo_code)}</b> (−${money(Number(p.list_price ?? p.amount) - Number(p.amount))})` : "";
  const text = [
    `💰 <b>New payment · ${plan} · ${money(p.amount)}</b>`,
    `👤 ${esc(who)} · ${esc(maskEmail(email))}`,
    `🧾 <code>${esc(p.bill_number)}</code> · via ${via}${promo}`,
    until ? `📅 Plan active until <b>${esc(ict.format(new Date(until)))}</b> ICT` : "",
  ].filter(Boolean).join("\n");

  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) { console.error("pay-notify telegram:", j.description || r.status); return json({ error: "telegram: " + (j.description || r.status) }, 502); }
  return json({ ok: true });
});
