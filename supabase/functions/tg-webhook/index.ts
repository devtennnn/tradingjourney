// @ts-nocheck
// Supabase Edge Function: tg-webhook  (deploy with verify_jwt = FALSE; Telegram calls it)
// The AROM TRADE bot, private chats only:
//   /start <code>  links this Telegram chat to the account that created the code (see tg-link)
//   /plans, /buy   plan list with buttons; a button creates a KHQRPay checkout (shared with the website: ../khqr/checkout.ts)
//                  and sends the KHQR as a picture, a "pay" button (KHQRPay's checkout page) and a "check payment" button
//   /profile       the linked account: name, plans and end dates, Academy, bonus signals
//   /stop          unlinks the chat.   /help  the command list.
// The plan unlocks only when the signed payment.completed webhook reaches khqrpay-webhook; the buyer then gets the usual
// "payment successful" message from pay-notify. Nothing here marks a payment paid.
// Security: Telegram sends X-Telegram-Bot-Api-Secret-Token, the value we registered with setWebhook; anything else is refused.
// Registration (once, and again after this update so Telegram also sends button presses):
//   https://<project>.supabase.co/functions/v1/tg-webhook?setup=1&key=<ai_bot_config.cron_secret>
import { createClient } from "jsr:@supabase/supabase-js@2";
import QRCode from "npm:qrcode@1.5.4";
import { PLANS, planOf, kpRequest, createCheckout } from "../khqr/checkout.ts";

const db = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
const SITE = (Deno.env.get("SITE_URL") || "https://aromx.trade").replace(/\/$/, "");
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const money = (n) => "$" + Number(n).toFixed(2);
const ict = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Phnom_Penh", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
async function sha256hex(s) { const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join(""); }
const secretFor = async (cron) => (await sha256hex("tg-webhook:" + cron)).slice(0, 48);
function safeEqual(a, b) { const x = new TextEncoder().encode(String(a)), y = new TextEncoder().encode(String(b)); let d = x.length ^ y.length; for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0); return d === 0; }
async function cronSecret() { const { data } = await db.from("ai_bot_config").select("value").eq("key", "cron_secret").maybeSingle(); return data?.value || ""; }

async function tg(method, body) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) console.error("tg-webhook", method, j.description || r.status);
    return j;
  } catch (e) { console.error("tg-webhook", method, String(e)); return {}; }
}
const say = (chat, text, extra = {}) => tg("sendMessage", { chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });

const LABEL = { premium: "Premium", elite: "Elite", ultra: "Ultra", course: "Academy" };
const ABOUT = {
  premium: "Chart uploads in your journal · ផ្ទុករូបក្រាហ្វ",
  elite: "Signals + Market News Analysis · សញ្ញា + វិភាគព័ត៌មាន",
  ultra: "Everything in Elite + Premium, AI desk · គ្រប់យ៉ាង",
  course: "AROM Academy course, lifetime · វគ្គសិក្សា មួយជីវិត",
};
const NOT_LINKED = "🔗 <b>Connect your account first</b>\nOpen <b>Profile → Telegram</b> on the website and press <b>Connect Telegram</b>, then come back here.\n\n" +
  "🔗 <b>សូមភ្ជាប់គណនីជាមុនសិន</b>\nបើក <b>Profile → Telegram</b> លើគេហទំព័រ ហើយចុច <b>Connect Telegram</b> រួចត្រឡប់មកទីនេះវិញ។";
const HELP = "🤖 <b>AROM TRADE bot</b>\n/plans — buy or renew a plan · ទិញ ឬបន្តគម្រោង\n/profile — your account · គណនីរបស់អ្នក\n/stop — disconnect this chat · ផ្តាច់\n/help — this list · ជំនួយ";
const linkBtn = { reply_markup: { inline_keyboard: [[{ text: "🌐 Open AROM TRADE", url: SITE + "/profile" }]] } };

async function linkedUser(chat) {
  const { data } = await db.from("telegram_links").select("user_id").eq("chat_id", chat).maybeSingle();
  return data?.user_id || null;
}

async function sendPlans(chat) {
  const row = (p) => ({ text: `${LABEL[p]} · ${money(PLANS[p].price)}`, callback_data: "buy:" + p });
  const lines = ["premium", "elite", "ultra", "course"].map((p) => `<b>${LABEL[p]}</b> · ${money(PLANS[p].price)}${p === "course" ? "" : " / 30 days"}\n<i>${esc(ABOUT[p])}</i>`);
  await say(chat, "💎 <b>Choose a plan · ជ្រើសរើសគម្រោង</b>\n\n" + lines.join("\n\n") +
    "\n\nPay with any Cambodian banking app (KHQR). Promo codes: use the website.\nបង់តាមកម្មវិធីធនាគារណាមួយ (KHQR)។ លេខកូដបញ្ចុះតម្លៃ: សូមប្រើគេហទំព័រ។",
    { reply_markup: { inline_keyboard: [[row("premium"), row("elite")], [row("ultra"), row("course")]] } });
}

async function qrPng(text) {
  const buf = await QRCode.toBuffer(String(text), { errorCorrectionLevel: "H", margin: 4, width: 720, color: { dark: "#000000", light: "#ffffff" } });
  return new Uint8Array(buf);
}

async function buy(chat, userId, planIn) {
  const plan = planOf(planIn);
  const c = await createCheckout(db, userId, plan, "", "telegram");
  if (!c.ok) {
    const msg = c.error === "already_owned" ? "🎓 You already own the Academy course. · អ្នកមានវគ្គសិក្សានេះរួចហើយ។ " + SITE + "/course"
      : c.error === "busy" ? "⏳ Busy right now, please try again in a minute. · រវល់បន្តិច សូមសាកម្តងទៀតក្នុងមួយនាទី។"
      : "⚠️ Payment is unavailable right now. Please try again later or use the website. · ការទូទាត់មិនទាន់អាចធ្វើបានទេ សូមសាកម្តងទៀត ឬប្រើគេហទំព័រ។";
    await say(chat, msg);
    return;
  }
  const row = c.row;
  let checkoutUrl = c.checkoutUrl;
  if (!checkoutUrl && row.kp_payment_id) {   // reopened QR: ask KHQRPay for its payment page once
    const r = await kpRequest("GET", "/v1/payments/" + encodeURIComponent(row.kp_payment_id));
    if (r.ok) checkoutUrl = r.data?.checkout_url || null;
  }
  const mins = Math.max(1, Math.round((new Date(row.expires_at).getTime() - Date.now()) / 60000));
  const caption = [
    `🧾 <b>${LABEL[plan]} · ${money(c.amount)}</b>${plan === "course" ? " · lifetime" : " · 30 days"}`,
    `Bill <code>${esc(row.bill_number)}</code> · valid ~${mins} min (until ${esc(ict.format(new Date(row.expires_at)))} ICT)`,
    "",
    "Scan this KHQR with any Cambodian banking app (ABA, ACLEDA, Wing…), or tap <b>Pay</b>. On this same phone: save the picture and open it from your bank app's scan screen.",
    "ស្កេន KHQR នេះជាមួយកម្មវិធីធនាគារណាមួយ ឬចុច <b>Pay</b>។ បើប្រើទូរស័ព្ទតែមួយ: រក្សាទុករូបភាព ហើយបើកវាពីផ្ទាំងស្កេនក្នុងកម្មវិធីធនាគារ។",
    "",
    "Your plan turns on by itself after payment. · គម្រោងនឹងបើកដោយស្វ័យប្រវត្តិ ក្រោយបង់ប្រាក់។",
  ].join("\n");
  const buttons = [];
  if (checkoutUrl && /^https:\/\//.test(checkoutUrl)) buttons.push([{ text: "💳 Pay · បង់ប្រាក់", url: checkoutUrl }]);
  buttons.push([{ text: "🔄 Check payment · ពិនិត្យ", callback_data: "chk:" + row.id }]);
  try {
    const form = new FormData();
    form.append("chat_id", String(chat));
    form.append("caption", caption);
    form.append("parse_mode", "HTML");
    form.append("reply_markup", JSON.stringify({ inline_keyboard: buttons }));
    form.append("photo", new Blob([await qrPng(row.payload)], { type: "image/png" }), "khqr-" + row.bill_number + ".png");
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, { method: "POST", body: form });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(j.description || "sendPhoto " + r.status);
  } catch (e) {
    console.error("tg-webhook qr photo:", String(e?.message ?? e));   // fall back to text + buttons
    await say(chat, caption, { reply_markup: { inline_keyboard: buttons } });
  }
}

async function check(chat, userId, paymentId) {
  const { data: p } = await db.from("payments").select("id,plan,status,expires_at,monitoring_gap,bill_number").eq("id", paymentId).eq("user_id", userId).maybeSingle();
  if (!p) { await say(chat, "Payment not found. · រកមិនឃើញការទូទាត់។"); return; }
  const plan = planOf(p.plan);
  if (p.status === "paid") {
    const { data: pr } = await db.from("profiles").select(PLANS[plan].col).eq("id", userId).maybeSingle();
    const until = pr?.[PLANS[plan].col];
    await say(chat, `✅ <b>Paid · ${LABEL[plan]}</b>` + (plan !== "course" && until ? `\nActive until <b>${esc(ict.format(new Date(until)))}</b> ICT · សកម្មរហូតដល់ថ្ងៃនោះ` : "\nបានបង់រួច។"));
    return;
  }
  if (p.monitoring_gap) { await say(chat, "⚠️ We could not confirm this payment automatically. If you paid, tap <b>I paid</b> on the website (Pricing → Already paid?) and the admin will check it.\nបើអ្នកបានបង់ សូមចុច <b>I paid</b> លើគេហទំព័រ ហើយ admin នឹងពិនិត្យ។"); return; }
  if (p.status === "claimed") { await say(chat, "🕒 You said you paid: the admin is checking it. · admin កំពុងពិនិត្យ។"); return; }
  if (p.status === "rejected") { await say(chat, "❌ This payment was not found by the admin. · admin រកមិនឃើញការទូទាត់នេះ។"); return; }
  const left = new Date(p.expires_at).getTime() - Date.now();
  if (p.status === "expired" || left <= 0) {
    await say(chat, "⌛ This QR has expired. If you already paid, it can still arrive within the hour. Otherwise send /plans for a new one.\nQR ផុតកំណត់ហើយ។ បើបានបង់រួច វាអាចនៅតែមកដល់ក្នុងរយៈពេលមួយម៉ោង។ បើមិនទាន់ សូមផ្ញើ /plans ដើម្បីបង្កើតថ្មី។");
    return;
  }
  await say(chat, `⏳ Waiting for payment · កំពុងរង់ចាំការទូទាត់ (${Math.ceil(left / 60000)} min left)`, { reply_markup: { inline_keyboard: [[{ text: "🔄 Check again · ពិនិត្យម្តងទៀត", callback_data: "chk:" + p.id }]] } });
}

async function profile(chat, userId) {
  const { data: pr } = await db.from("profiles").select("username,display_name,premium_until,elite_until,ultra_until,course_until,bonus_signals,is_admin").eq("id", userId).maybeSingle();
  let email = ""; try { email = (await db.auth.admin.getUserById(userId)).data.user?.email || ""; } catch { /* optional */ }
  const { count: trades } = await db.from("trades").select("id", { count: "exact", head: true }).eq("user_id", userId);
  const now = Date.now(), on = (d) => d && new Date(d).getTime() > now;
  const plans = [["ultra", pr?.ultra_until], ["elite", pr?.elite_until], ["premium", pr?.premium_until]]
    .map(([k, d]) => on(d) ? `• <b>${LABEL[k]}</b> until ${esc(ict.format(new Date(d)))} ICT` : null).filter(Boolean);
  const name = pr?.display_name || pr?.username || "Trader";
  await say(chat, [
    `👤 <b>${esc(name)}</b>${pr?.username ? " · @" + esc(pr.username) : ""}`,
    email ? `✉️ ${esc(email)}` : "",
    "",
    "<b>Plans · គម្រោង</b>",
    pr?.is_admin ? "• <b>Admin</b> (all features)" : plans.length ? plans.join("\n") : "• Free · ឥតគិតថ្លៃ",
    `• <b>Academy</b>: ${on(pr?.course_until) ? "owned · មាន" : "not owned · មិនទាន់មាន"}`,
    "",
    `📒 Trades in journal · ការជួញដូរ: <b>${trades ?? 0}</b>`,
    `🎁 Bonus signals · សញ្ញាបន្ថែម: <b>${pr?.bonus_signals ?? 0}</b>`,
  ].filter((l) => l !== null).join("\n").replace(/\n{3,}/g, "\n\n"), {
    reply_markup: { inline_keyboard: [[{ text: "💎 Buy / renew · ទិញ", callback_data: "plans" }], [{ text: "🌐 Open profile", url: SITE + "/profile" }]] },
  });
}

Deno.serve(async (req) => {
  const url = new URL(req.url), cron = await cronSecret();
  if (!cron || !TOKEN) return json({ error: "not configured" }, 503);

  if (url.searchParams.get("setup") === "1") {   // register this function as the bot's webhook + its command menu (admin)
    if (!safeEqual(url.searchParams.get("key") || "", cron)) return json({ error: "unauthorized" }, 401);
    const hook = `${Deno.env.get("SUPABASE_URL")}/functions/v1/tg-webhook`;
    const j = await tg("setWebhook", { url: hook, secret_token: await secretFor(cron), allowed_updates: ["message", "callback_query"], drop_pending_updates: true });
    await tg("setMyCommands", { commands: [
      { command: "plans", description: "Buy or renew a plan · ទិញគម្រោង" },
      { command: "profile", description: "Your account · គណនីរបស់អ្នក" },
      { command: "help", description: "Commands · ជំនួយ" },
      { command: "stop", description: "Disconnect this chat · ផ្តាច់" },
    ] });
    return json({ ok: !!j.ok, telegram: j.description || "ok", webhook: hook }, j.ok ? 200 : 502);
  }

  if (req.method !== "POST") return json({ ok: true });
  if (!safeEqual(req.headers.get("x-telegram-bot-api-secret-token") || "", await secretFor(cron))) return json({ error: "forbidden" }, 403);
  let up; try { up = await req.json(); } catch { return json({ ok: true }); }

  try {
    /* ---------- button presses ---------- */
    const cq = up?.callback_query;
    if (cq) {
      const chat = cq.message?.chat?.id, data = String(cq.data || "");
      await tg("answerCallbackQuery", { callback_query_id: cq.id });
      if (!chat || cq.message?.chat?.type !== "private" || cq.from?.id !== chat) return json({ ok: true });
      const userId = await linkedUser(chat);
      if (!userId) { await say(chat, NOT_LINKED, linkBtn); return json({ ok: true }); }
      if (data === "plans") await sendPlans(chat);
      else if (/^buy:(premium|elite|ultra|course)$/.test(data)) await buy(chat, userId, data.slice(4));
      else if (/^chk:[0-9a-f-]{36}$/.test(data)) await check(chat, userId, data.slice(4));
      return json({ ok: true });
    }

    /* ---------- messages ---------- */
    const m = up?.message;
    if (!m || m.chat?.type !== "private" || typeof m.text !== "string") return json({ ok: true });
    const chat = m.chat.id, text = m.text.trim();

    if (/^\/start\b/i.test(text)) {
      const code = (text.split(/\s+/)[1] || "").toLowerCase();
      if (!/^[a-z2-9]{18}$/.test(code)) {
        if (await linkedUser(chat)) { await say(chat, HELP); return json({ ok: true }); }
        await say(chat, "👋 <b>AROM TRADE</b>\nTo buy plans and get payment confirmations here, open <b>Profile → Telegram</b> on the website and press <b>Connect Telegram</b>.\n\nដើម្បីទិញគម្រោង និងទទួលសារបញ្ជាក់ការទូទាត់នៅទីនេះ សូមបើក <b>Profile → Telegram</b> លើគេហទំព័រ ហើយចុច <b>Connect Telegram</b>។", linkBtn);
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
      await say(chat, "✅ <b>Telegram connected</b>\nYou will get your AROM TRADE payment confirmations here, and you can buy plans with /plans.\n\n✅ <b>បានភ្ជាប់ Telegram</b>\nអ្នកនឹងទទួលសារបញ្ជាក់ការទូទាត់នៅទីនេះ ហើយអាចទិញគម្រោងដោយ /plans។\n\n" + HELP);
      return json({ ok: true });
    }
    if (/^\/stop\b/i.test(text)) {
      await db.from("telegram_links").delete().eq("chat_id", chat);
      await say(chat, "Disconnected. You will no longer get messages here.\n\nបានផ្តាច់។ អ្នកនឹងលែងទទួលសារនៅទីនេះទៀតហើយ។");
      return json({ ok: true });
    }
    if (/^\/(plans|buy|plan|upgrade)\b/i.test(text)) {
      if (!(await linkedUser(chat))) { await say(chat, NOT_LINKED, linkBtn); return json({ ok: true }); }
      await sendPlans(chat);
      return json({ ok: true });
    }
    if (/^\/(profile|me|account)\b/i.test(text)) {
      const userId = await linkedUser(chat);
      if (!userId) { await say(chat, NOT_LINKED, linkBtn); return json({ ok: true }); }
      await profile(chat, userId);
      return json({ ok: true });
    }
    await say(chat, HELP);
    return json({ ok: true });
  } catch (e) {
    console.error("tg-webhook error:", String(e?.message ?? e));
    return json({ ok: true });   // never make Telegram retry a half-handled update
  }
});
