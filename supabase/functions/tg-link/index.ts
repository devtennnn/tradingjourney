// @ts-nocheck
// Supabase Edge Function: tg-link  (JWT required: called by the signed-in user from the profile screen)
//   { action: "status" }  -> { linked, tg_username, linked_at, bot }
//   { action: "start" }   -> { url, expires_in }   one-time deep link  https://t.me/<bot>?start=<code>   (valid 15 minutes, one use)
//   { action: "unlink" }  -> { ok }
// The bot username comes from Telegram getMe (TELEGRAM_BOT_TOKEN secret). The link is completed by the function tg-webhook when the user presses Start.
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
let botName = "";
async function bot() {
  if (botName) return botName;
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
  if (!token) return "";
  try { const j = await (await fetch(`https://api.telegram.org/bot${token}/getMe`)).json(); botName = j?.result?.username || ""; } catch { /* retry next time */ }
  return botName;
}
const newCode = () => Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = Deno.env.get("SUPABASE_URL"), anon = Deno.env.get("SUPABASE_ANON_KEY"), service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const userClient = createClient(url, anon, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
    const db = createClient(url, service, { auth: { persistSession: false } });
    const body = await req.json().catch(() => ({}));

    if (body.action === "status") {
      const { data } = await db.from("telegram_links").select("tg_username,linked_at").eq("user_id", user.id).maybeSingle();
      return json({ linked: !!data, tg_username: data?.tg_username ?? null, linked_at: data?.linked_at ?? null, bot: await bot() });
    }
    if (body.action === "start") {
      const b = await bot();
      if (!b) return json({ error: "bot_unavailable" }, 503);
      await db.from("telegram_link_codes").delete().eq("user_id", user.id);                     // one open code per user
      await db.from("telegram_link_codes").delete().lt("expires_at", new Date().toISOString());   // housekeeping
      const code = newCode();
      const { error } = await db.from("telegram_link_codes").insert({ code, user_id: user.id, expires_at: new Date(Date.now() + 15 * 60_000).toISOString() });
      if (error) { console.error("tg-link insert:", error.message); return json({ error: "setup_needed" }, 500); }
      return json({ url: `https://t.me/${b}?start=${code}`, expires_in: 900 });
    }
    if (body.action === "unlink") {
      await db.from("telegram_links").delete().eq("user_id", user.id);
      await db.from("telegram_link_codes").delete().eq("user_id", user.id);
      return json({ ok: true });
    }
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: String(e?.message ?? e) }, 500);
  }
});
