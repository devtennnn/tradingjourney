// @ts-nocheck
// Supabase Edge Function: launch-claim  (deploy with verify_jwt = FALSE: the member actions check the member's token themselves, the cron actions check the cron key)
// Launch gift: 3 days of Ultra for members who join the Telegram channel AND community. The bot checks membership with Telegram itself (getChatMember),
// so a member cannot fake it. Settings live in public.launch_promo, claims in public.launch_claims (supabase/sql/launch-ultra.sql).
//   Member (signed in):  POST { action: "status" }  -> window, progress (email, Telegram link, channel, community) and the claim if there is one
//                        POST { action: "claim" }   -> checks every rule again on the server, then grants Ultra once per account AND once per Telegram account
//   Cron (every 10 min): GET ?run=watch&key=<ai_bot_config.cron_secret>  -> re-checks active claims; a member who LEFT the channel or community loses the gift
//   Admin once:          GET ?run=diag&key=<cron_secret>  -> shows whether the bot can really see the members of both chats (the bot must be an ADMIN there)
// Secret: TELEGRAM_BOT_TOKEN (the same bot as tg-link / tg-webhook).
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hits = new Map();   // 15 requests a minute per member
const limited = (id) => { const now = Date.now(), a = (hits.get(id) || []).filter((t) => now - t < 60_000); a.push(now); hits.set(id, a); if (hits.size > 3000) hits.clear(); return a.length > 15; };

async function tg(method, params) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}?` + new URLSearchParams(params).toString());
    return await r.json();
  } catch (e) { return { ok: false, description: "network: " + String(e).slice(0, 80) }; }
}
/** 'in' | 'out' (explicit: Telegram says left / kicked) | 'unknown' (Telegram could not tell: bot not admin, chat not found, network ...) */
async function membership(chat, userId) {
  const j = await tg("getChatMember", { chat_id: chat, user_id: String(userId) });
  if (!j.ok) return { state: /user not found|participant_id_invalid/i.test(j.description || "") ? "out_soft" : "unknown", note: String(j.description || "error").slice(0, 120) };
  const st = j.result && j.result.status;
  if (st === "creator" || st === "administrator" || st === "member") return { state: "in", note: st };
  if (st === "restricted") return { state: j.result.is_member ? "in" : "out", note: "restricted" };
  if (st === "left" || st === "kicked") return { state: "out", note: st };
  return { state: "unknown", note: "status " + st };
}
const isIn = (m) => m.state === "in";
const isOut = (m) => m.state === "out" || m.state === "out_soft";
async function say(chat, text) {
  try { await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }) }); }
  catch (e) { console.error("launch-claim say:", String(e).slice(0, 100)); }
}
let botName = "";
async function bot() {
  if (botName) return botName;
  const j = await tg("getMe", {}); botName = (j.result && j.result.username) || ""; return botName;
}
const promoState = (p) => { const n = Date.now(); return !p || !p.enabled ? "disabled" : n < Date.parse(p.opens_at) ? "before" : n > Date.parse(p.closes_at) ? "closed" : "open"; };

async function cronKey() { const { data } = await db.from("ai_bot_config").select("value").eq("key", "cron_secret").maybeSingle(); return data && data.value || ""; }

async function watch() {
  const nowIso = new Date().toISOString();
  await db.from("launch_claims").update({ status: "ended" }).eq("status", "active").lt("granted_until", nowIso);   // the gift ran its 3 days
  const { data: promo } = await db.from("launch_promo").select("*").eq("id", 1).maybeSingle();
  const { data: rows } = await db.from("launch_claims").select("user_id,tg_user_id,granted_until").eq("status", "active").order("last_check_at", { ascending: true, nullsFirst: true }).limit(150);
  const out = { checked: 0, revoked: 0, unknown: 0 };
  for (const c of rows || []) {
    const ch = await membership(promo.channel, c.tg_user_id), co = await membership(promo.community, c.tg_user_id); await sleep(60);
    out.checked++;
    const left = [ch.state === "out" && "channel", co.state === "out" && "community"].filter(Boolean);   // only an EXPLICIT left / kicked counts: a Telegram error never takes a gift away
    if (!left.length) {
      if (ch.state === "unknown" || co.state === "unknown") out.unknown++;
      await db.from("launch_claims").update({ last_check_at: new Date().toISOString(), check_note: `channel ${ch.note}; community ${co.note}`.slice(0, 200) }).eq("user_id", c.user_id);
      continue;
    }
    const { data: r, error } = await db.rpc("launch_revoke", { p_user: c.user_id, p_reason: "left " + left.join(" and ") });
    if (error) { console.error("launch_revoke:", error.message); continue; }
    out.revoked++;
    await db.from("audit_log").insert({ user_id: c.user_id, actor_id: null, action: "launch_revoked", detail: { left, plan_changed: !!(r && r.plan_changed) } });
    const { data: l } = await db.from("telegram_links").select("chat_id").eq("user_id", c.user_id).maybeSingle();
    if (l) await say(l.chat_id, `⚠️ <b>Your free Ultra was removed</b>\nYou left the AROM TRADE Telegram ${left.join(" and ")}. The launch gift needs you to stay in both.\n\n⚠️ <b>Ultra ឥតគិតថ្លៃរបស់អ្នកត្រូវបានដកចេញ</b>\nអ្នកបានចាកចេញពី Telegram ${left.includes("channel") ? "channel" : ""}${left.length === 2 ? " និង " : ""}${left.includes("community") ? "community" : ""} របស់ AROM TRADE។`);
  }
  return out;
}

async function diag() {
  const { data: promo } = await db.from("launch_promo").select("*").eq("id", 1).maybeSingle();
  const me = await tg("getMe", {}), meId = me.result && me.result.id, res = { bot: me.result && me.result.username, chats: {} };
  for (const [k, chat] of [["channel", promo.channel], ["community", promo.community]]) {
    const c = await tg("getChat", { chat_id: chat }), b = meId ? await tg("getChatMember", { chat_id: chat, user_id: String(meId) }) : null;
    const st = b && b.ok ? b.result.status : null;
    res.chats[k] = { chat, found: !!c.ok, title: c.ok ? c.result.title : null, type: c.ok ? c.result.type : null, bot_status: st, bot_is_admin: st === "administrator" || st === "creator",
      problem: !c.ok ? c.description : !b || !b.ok ? (b && b.description) || "cannot read the bot's own status" : st !== "administrator" && st !== "creator" ? "add the bot as an ADMINISTRATOR of this chat so it can see who joined" : null };
  }
  return res;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = new URL(req.url), run = url.searchParams.get("run");
    if (run) {   // cron / admin actions
      const key = await cronKey();
      if (!key || url.searchParams.get("key") !== key) return json({ error: "unauthorized" }, 401);
      if (!TOKEN) return json({ error: "TELEGRAM_BOT_TOKEN missing" }, 503);
      if (run === "watch") return json({ ok: true, ...(await watch()) });
      if (run === "diag") return json({ ok: true, ...(await diag()) });
      return json({ error: "unknown_run" }, 400);
    }
    const supaUrl = Deno.env.get("SUPABASE_URL"), anon = Deno.env.get("SUPABASE_ANON_KEY");
    const uc = createClient(supaUrl, anon, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: { user } } = await uc.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
    if (!TOKEN) return json({ error: "bot_unavailable" }, 503);
    if (limited(user.id)) return json({ error: "slow_down" }, 429);
    const body = await req.json().catch(() => ({})), action = String(body.action || "");
    const { data: promo } = await db.from("launch_promo").select("*").eq("id", 1).maybeSingle();
    if (!promo) return json({ error: "setup_needed" }, 503);
    const state = promoState(promo);
    const { data: claim } = await db.from("launch_claims").select("status,claimed_at,granted_until,days").eq("user_id", user.id).maybeSingle();
    const { data: link } = await db.from("telegram_links").select("chat_id,tg_username").eq("user_id", user.id).maybeSingle();
    const verified = !!user.email_confirmed_at;
    const pub = { state, opens_at: promo.opens_at, closes_at: promo.closes_at, days: promo.days, channel_url: promo.channel_url, community_url: promo.community_url };

    if (action === "status") {
      const out = { ok: true, promo: pub, email_verified: verified, telegram: { linked: !!link, username: link && link.tg_username || null }, claim: claim || null, bot: await bot(), joined: { channel: null, community: null }, check_ok: true };
      if (link && !claim && state !== "disabled") {
        const [ch, co] = [await membership(promo.channel, link.chat_id), await membership(promo.community, link.chat_id)];
        out.joined = { channel: isIn(ch) ? true : isOut(ch) ? false : null, community: isIn(co) ? true : isOut(co) ? false : null };
        out.check_ok = ch.state !== "unknown" && co.state !== "unknown";
      }
      return json(out);
    }
    if (action === "claim") {
      if (state === "disabled") return json({ error: "disabled" }, 403);
      if (state === "before") return json({ error: "not_open", opens_at: promo.opens_at }, 403);
      if (state === "closed") return json({ error: "closed" }, 403);
      if (claim) return json({ error: "already_claimed", claim }, 409);
      if (!verified) return json({ error: "email_unverified" }, 403);
      if (!link) return json({ error: "telegram_not_linked" }, 409);
      const [ch, co] = [await membership(promo.channel, link.chat_id), await membership(promo.community, link.chat_id)];
      if (ch.state === "unknown" || co.state === "unknown") { console.error("launch-claim cannot verify:", ch.note, "|", co.note); return json({ error: "check_failed" }, 503); }
      if (!isIn(ch)) return json({ error: "not_in_channel" }, 409);
      if (!isIn(co)) return json({ error: "not_in_community" }, 409);
      const { data: g, error } = await db.rpc("launch_grant", { p_user: user.id, p_tg: link.chat_id });
      if (error) {
        const m = String(error.message || ""), code = ["disabled", "not_open", "closed", "sold_out", "already_claimed", "telegram_used", "no_profile"].find((c) => m.includes(c));
        if (!code) { console.error("launch_grant:", m.slice(0, 200)); return json({ error: "server_error" }, 500); }
        return json({ error: code }, code === "already_claimed" || code === "telegram_used" ? 409 : 403);
      }
      await db.from("audit_log").insert({ user_id: user.id, actor_id: user.id, action: "launch_claim", detail: { days: g.days, until: g.until, tg_user_id: link.chat_id } });
      await say(link.chat_id, `🎁 <b>Free Ultra activated</b>\n${g.days} days of AROM TRADE Ultra, until <b>${new Date(g.until).toLocaleString("en-GB", { timeZone: "Asia/Phnom_Penh", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false })}</b> (Cambodia time). Stay in the channel and community to keep it.\n\n🎁 <b>បានបើក Ultra ឥតគិតថ្លៃ</b>\n${g.days} ថ្ងៃ។ សូមស្នាក់នៅក្នុង channel និង community ដើម្បីរក្សាវា។`);
      return json({ ok: true, until: g.until, days: g.days });
    }
    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    console.error("launch-claim:", String(e && e.message || e).slice(0, 200));
    return json({ error: "server_error" }, 500);
  }
});
