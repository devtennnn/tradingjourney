// @ts-nocheck
// Supabase Edge Function: ib-notify  (deploy with verify_jwt = FALSE; called by the ib_profiles trigger, protected by the cron key)
// When an IB partner sends the profile form, or the admin approves / asks for changes / hides it, the partner gets:
//   1) an EMAIL (Resend, secret RESEND_API_KEY; sender MAIL_FROM, default "AROM TRADE <no-reply@aromx.trade>"; the domain must be verified in Resend)
//   2) a Telegram message, if they connected Telegram (table telegram_links)
// and on a new submission YOU get a Telegram note (ai_bot_config.pay_chat_id) so you can review it.
//   POST ?key=<ai_bot_config.cron_secret>   body: { "user_id": "<uuid>", "event": "submitted" | "approved" | "rejected" | "hidden" }
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const SITE = (Deno.env.get("SITE_URL") || "https://aromx.trade").replace(/\/$/, "");

// bilingual texts per event: [title, body] in English and Khmer
const T = {
  submitted: {
    en: ["We received your IB profile", "Thank you. Our team is reviewing your profile now. A review usually takes <b>4 to 12 hours</b>. We will email you as soon as it is approved and listed on AROM TRADE."],
    km: ["យើងបានទទួល Profile IB របស់អ្នកហើយ", "សូមអរគុណ។ ក្រុមការងាររបស់យើងកំពុងពិនិត្យ Profile របស់អ្នក។ ការពិនិត្យជាធម្មតាចំណាយពេល <b>4 ទៅ 12 ម៉ោង</b>។ យើងនឹងផ្ញើ Email ទៅអ្នកភ្លាមៗ ពេល Profile ត្រូវបានអនុម័ត ហើយបង្ហាញនៅលើ AROM TRADE។"],
  },
  approved: {
    en: ["Your IB profile is approved and live", "Good news: the admin approved your profile. Your broker, referral link and rebate are now listed in the IB partners directory. Share your promo codes with your community."],
    km: ["Profile IB របស់អ្នកត្រូវបានអនុម័ត ហើយកំពុងបង្ហាញ", "ដំណឹងល្អ៖ Admin បានអនុម័ត Profile របស់អ្នក។ Broker, referral link និង Rebate របស់អ្នកកំពុងបង្ហាញក្នុងបញ្ជីដៃគូ IB ហើយ។ សូមចែករំលែកលេខកូដបញ្ចុះតម្លៃទៅសហគមន៍របស់អ្នក។"],
  },
  rejected: {
    en: ["Your IB profile needs changes", "The admin checked your profile and it needs a few changes before it can be listed. Open your dashboard, read the admin note, fix the details and send it again."],
    km: ["Profile IB របស់អ្នកត្រូវកែប្រែ", "Admin បានពិនិត្យ Profile របស់អ្នក ហើយត្រូវកែប្រែបន្តិច មុនពេលបង្ហាញ។ សូមបើក Dashboard អានកំណត់ចំណាំពី Admin កែព័ត៌មាន ហើយផ្ញើម្តងទៀត។"],
  },
  hidden: {
    en: ["Your IB listing is hidden", "The admin has hidden your listing from the IB partners directory. Open your dashboard to read the note, or contact the admin in the AROM TRADE Telegram group."],
    km: ["ការបង្ហាញ IB របស់អ្នកត្រូវបានលាក់", "Admin បានលាក់ការបង្ហាញរបស់អ្នកពីបញ្ជីដៃគូ IB។ សូមបើក Dashboard ដើម្បីអានកំណត់ចំណាំ ឬទាក់ទង Admin ក្នុងក្រុម Telegram របស់ AROM TRADE។"],
  },
};

function emailHtml(ev, prof, note) {
  const t = T[ev], btn = (txt) => `<a href="${SITE}/ib#ibDash" style="display:inline-block;background:#2bf08a;color:#03150b;text-decoration:none;font-weight:800;padding:12px 22px;border-radius:12px">${txt}</a>`;
  const noteHtml = note ? `<p style="margin:14px 0;padding:12px 14px;border-left:3px solid #2bf08a;background:#0f1b2e;color:#cfe;border-radius:8px"><b>Admin note / កំណត់ចំណាំពី Admin:</b><br>${esc(note)}</p>` : "";
  const block = (lang) => `<h2 style="margin:0 0 10px;font-size:20px;color:#fff">${t[lang][0]}</h2><p style="margin:0 0 12px;font-size:15px;line-height:1.65;color:#c4cede">${t[lang][1]}</p>`;
  return `<!doctype html><html><body style="margin:0;background:#000412;font-family:Inter,Arial,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:28px 18px">
  <div style="font-weight:900;letter-spacing:1px;color:#fff;font-size:18px;margin-bottom:18px">AROM <span style="color:#2bf08a">TRADE</span> · IB Partner</div>
  <div style="background:#08111f;border:1px solid #1b2a40;border-radius:18px;padding:24px">
    ${prof?.broker_name ? `<p style="margin:0 0 14px;color:#8af7c2;font-size:13px">${esc(prof.broker_name)} · ${esc(prof.ib_name || "")}</p>` : ""}
    ${block("en")}${noteHtml}
    <p style="margin:16px 0 22px">${btn("Open my IB dashboard")}</p>
    <hr style="border:0;border-top:1px solid #1b2a40;margin:6px 0 20px">
    ${block("km")}
    <p style="margin:16px 0 0">${btn("បើក Dashboard IB")}</p>
  </div>
  <p style="color:#6b7a90;font-size:12px;line-height:1.6;margin-top:18px">You get this email because you joined the AROM TRADE IB & Community Partner program. Trading carries risk. Not financial advice. / មិនមែនជាដំបូន្មានហិរញ្ញវត្ថុទេ។</p>
</div></body></html>`;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const { data: cfgRows, error: ce } = await db.from("ai_bot_config").select("key,value");
  if (ce) return json({ error: ce.message }, 500);
  const c = Object.fromEntries((cfgRows || []).map((r) => [r.key, r.value]));
  if (!c.cron_secret || url.searchParams.get("key") !== c.cron_secret) return json({ error: "unauthorized" }, 401);

  let body = {}; try { body = await req.json(); } catch { /* empty */ }
  const uid = String(body.user_id || ""), ev = String(body.event || "");
  if (!uid || !T[ev]) return json({ error: "bad request" }, 400);

  const { data: prof } = await db.from("ib_profiles").select("ib_name,broker_name,ref_link,status,admin_note").eq("user_id", uid).maybeSingle();
  if (!prof) return json({ error: "profile not found" }, 404);
  const note = ev === "submitted" ? "" : prof.admin_note || "";
  let email = ""; try { email = (await db.auth.admin.getUserById(uid)).data.user?.email || ""; } catch { /* optional */ }
  const out = { email: "skipped", user_tg: "skipped (not connected)", admin_tg: "skipped" };

  // 1) email
  const key = Deno.env.get("RESEND_API_KEY") || "";
  if (!key) out.email = "skipped (RESEND_API_KEY not set)";
  else if (!email) out.email = "skipped (no email)";
  else {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ from: Deno.env.get("MAIL_FROM") || "AROM TRADE <no-reply@aromx.trade>", to: [email], subject: "AROM TRADE · " + T[ev].en[0], html: emailHtml(ev, prof, note) }),
    });
    const j = await r.json().catch(() => ({}));
    out.email = r.ok ? "sent" : "failed: " + (j.message || r.status);
    if (!r.ok) console.error("ib-notify email:", j.message || r.status);
  }

  // 2) Telegram (partner, if connected) and a review note for the admin on a new submission
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
  const tg = async (chat_id, text, button) => {
    if (!token) return false;
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id, parse_mode: "HTML", disable_web_page_preview: true, text, ...(button ? { reply_markup: { inline_keyboard: [[button]] } } : {}) }) });
    const j = await r.json().catch(() => ({})); if (!j.ok) console.error("ib-notify telegram:", j.description || r.status); return !!j.ok;
  };
  const plain = (s) => s.replace(/<\/?b>/g, "");
  const { data: link } = await db.from("telegram_links").select("chat_id").eq("user_id", uid).maybeSingle();
  if (link?.chat_id) {
    const t = T[ev], n = note ? `\n\n📝 ${esc(note)}` : "";
    out.user_tg = (await tg(link.chat_id, `<b>${t.en[0]}</b>\n${plain(t.en[1])}${n}\n\n<b>${t.km[0]}</b>\n${plain(t.km[1])}`, { text: "Open IB dashboard", url: SITE + "/ib" })) ? "sent" : "failed";
  }
  const chat = (c.pay_chat_id || "").trim();
  if (ev === "submitted" && chat) {
    out.admin_tg = (await tg(chat, `🤝 <b>IB profile to review</b>\n${esc(prof.broker_name)} · ${esc(prof.ib_name)}\n${esc(prof.ref_link)}\n\nOpen Admin → IB program to approve (target: 4 to 12 hours).`, { text: "Open Admin", url: SITE + "/" })) ? "sent" : "failed";
  }
  return json({ ok: true, ...out });
});
