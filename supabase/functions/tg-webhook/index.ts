// @ts-nocheck
// Supabase Edge Function: tg-webhook  (deploy with verify_jwt = FALSE; Telegram calls it)
// Receives the bot's incoming messages. "/start <code>" links that Telegram chat to the account that created the code (see tg-link);
// "/stop" unlinks it. Anything else gets a short hint. Only private chats are handled.
// Security: Telegram sends the header X-Telegram-Bot-Api-Secret-Token that we set when registering the webhook; anything without it is refused.
// One-time registration (open once in a browser, as admin):  https://<project>.supabase.co/functions/v1/tg-webhook?setup=1&key=<ai_bot_config.cron_secret>
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
async function sha256hex(s) { const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join(""); }
const secretFor = async (cron) => (await sha256hex("tg-webhook:" + cron)).slice(0, 48);
async function say(chat, text) {
  try { await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }) }); }
  catch (e) { console.error("tg-webhook send:", String(e)); }
}
async function cronSecret() { const { data } = await db.from("ai_bot_config").select("value").eq("key", "cron_secret").maybeSingle(); return data?.value || ""; }

Deno.serve(async (req) => {
  const url = new URL(req.url), cron = await cronSecret();
  if (!cron || !TOKEN) return json({ error: "not configured" }, 503);

  if (url.searchParams.get("setup") === "1") {   // register this function as the bot's webhook (admin, once)
    if (url.searchParams.get("key") !== cron) return json({ error: "unauthorized" }, 401);
    const hook = `${Deno.env.get("SUPABASE_URL")}/functions/v1/tg-webhook`;
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/setWebhook`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: hook, secret_token: await secretFor(cron), allowed_updates: ["message"], drop_pending_updates: true }) });
    const j = await r.json().catch(() => ({}));
    return json({ ok: !!j.ok, telegram: j.description || "ok", webhook: hook }, j.ok ? 200 : 502);
  }

  if (req.method !== "POST") return json({ ok: true });
  if (req.headers.get("x-telegram-bot-api-secret-token") !== await secretFor(cron)) return json({ error: "forbidden" }, 403);
  let up; try { up = await req.json(); } catch { return json({ ok: true }); }
  const m = up?.message;
  if (!m || m.chat?.type !== "private" || typeof m.text !== "string") return json({ ok: true });
  const chat = m.chat.id, text = m.text.trim();

  if (/^\/start\b/i.test(text)) {
    const code = (text.split(/\s+/)[1] || "").toLowerCase();
    if (!/^[a-z2-9]{18}$/.test(code)) {
      await say(chat, "👋 <b>AROM TRADE</b>\nTo get payment confirmations here, open <b>Profile → Telegram</b> on the website and press <b>Connect Telegram</b>.\n\nដើម្បីទទួលសារបញ្ជាក់ការទូទាត់នៅទីនេះ សូមបើក <b>Profile → Telegram</b> លើគេហទំព័រ ហើយចុច <b>Connect Telegram</b>។");
      return json({ ok: true });
    }
    const { data: c } = await db.from("telegram_link_codes").select("user_id,expires_at").eq("code", code).maybeSingle();
    if (!c || new Date(c.expires_at) < new Date()) {
      await say(chat, "⚠️ This link has expired. Go back to the website and press <b>Connect Telegram</b> again.\n\nតំណនេះផុតកំណត់ហើយ។ សូមត្រឡប់ទៅគេហទំព័រ ហើយចុច <b>Connect Telegram</b> ម្តងទៀត។");
      return json({ ok: true });
    }
    await db.from("telegram_link_codes").delete().eq("code", code);          // single use
    await db.from("telegram_links").delete().eq("chat_id", chat);             // this chat now belongs to this account only
    const { error } = await db.from("telegram_links").upsert({ user_id: c.user_id, chat_id: chat, tg_username: m.from?.username || null, linked_at: new Date().toISOString() });
    if (error) { console.error("tg-webhook link:", error.message); await say(chat, "⚠️ Could not connect right now. Please try again."); return json({ ok: true }); }
    await say(chat, "✅ <b>Telegram connected</b>\nYou will get your AROM TRADE payment confirmations here. Send /stop any time to disconnect.\n\n✅ <b>បានភ្ជាប់ Telegram</b>\nអ្នកនឹងទទួលសារបញ្ជាក់ការទូទាត់ពី AROM TRADE នៅទីនេះ។ ផ្ញើ /stop ដើម្បីផ្តាច់។");
    return json({ ok: true });
  }
  if (/^\/stop\b/i.test(text)) {
    await db.from("telegram_links").delete().eq("chat_id", chat);
    await say(chat, "Disconnected. You will no longer get messages here.\n\nបានផ្តាច់។ អ្នកនឹងលែងទទួលសារនៅទីនេះទៀតហើយ។");
    return json({ ok: true });
  }
  await say(chat, "I only send payment confirmations. Manage this in <b>Profile → Telegram</b> on the website.");
  return json({ ok: true });
});
