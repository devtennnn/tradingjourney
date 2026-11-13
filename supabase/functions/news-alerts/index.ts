// @ts-nocheck
// Supabase Edge Function: news-alerts
// Every 5 minutes (pg_cron): reads /api/market-news (Gold / USD / Oil / Big news only) and posts to Telegram:
//   • 07:00 ICT daily briefing (Mon–Fri) with today's market-moving events
//   • ⏰ alert ~30 minutes before each event (events at the same minute are grouped)
//   • 🔴 "releasing now" at the event time
// Deduplicated in public.news_alerts. Chat id + key come from public.ai_bot_config; token is the TELEGRAM_BOT_TOKEN secret.
import { createClient } from "jsr:@supabase/supabase-js@2";

const SITE = "https://truetradejourney.vercel.app";
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const TZ = "Asia/Phnom_Penh";
const hm = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const dayLbl = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "long", day: "numeric", month: "short" });
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
const IMP = { High: "🔴", Medium: "🟠", Low: "⚪" };
const TAGI = { GOLD: "🥇Gold", USD: "💵USD", OIL: "🛢️Oil", BIG: "🌐Big" };
const tagLine = (tags) => tags.map((t) => TAGI[t] || t).join(" · ");
const fp = (e) => [e.forecast ? `F ${esc(e.forecast)}` : "", e.previous ? `P ${esc(e.previous)}` : ""].filter(Boolean).join(" · ");

async function cfg() {
  const { data, error } = await db.from("ai_bot_config").select("key,value");
  if (error) throw new Error(error.message);
  return Object.fromEntries((data || []).map((r) => [r.key, r.value]));
}
async function events() {
  const out = [], seen = new Set();
  for (const w of ["this", "next"]) {
    try {
      const r = await fetch(`${SITE}/api/market-news?week=${w}`);
      if (!r.ok) continue;
      for (const e of (await r.json()).events || []) if (!seen.has(e.key)) { seen.add(e.key); out.push(e); }
    } catch (_) { /* skip */ }
  }
  return out.sort((a, b) => a.ms - b.ms);
}
async function claim(key, kind) {
  const { data, error } = await db.from("news_alerts").upsert({ key, kind }, { onConflict: "key,kind", ignoreDuplicates: true }).select();
  if (error) throw new Error(error.message);
  return !!(data && data.length);
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  let c;
  try { c = await cfg(); } catch (e) { return json({ error: String(e.message || e) }, 500); }
  if (!c.cron_secret || url.searchParams.get("key") !== c.cron_secret) return json({ error: "unauthorized" }, 401);
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
  if (!token || !c.chat_id) return json({ error: "missing token or chat_id" }, 500);
  const chat = c.news_chat_id || c.chat_id;
  const tg = async (text) => {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error("telegram: " + (j.description || r.status));
    return j.result.message_id;
  };

  const ev = await events();
  if (!ev.length) return json({ ok: true, note: "no events from feed" });
  const now = Date.now(), sent = [];
  const force = url.searchParams.get("brief") === "1";

  // 1) Daily briefing after 07:00 ICT, Mon–Fri
  const today = dayKey.format(new Date(now));
  const ictHour = +new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hour12: false }).format(new Date(now));
  const wd = new Date(now + 7 * 3600000).getUTCDay();
  if ((force || (ictHour >= 7 && wd >= 1 && wd <= 5)) && (force || await claim(today, "brief"))) {
    const list = ev.filter((e) => dayKey.format(new Date(e.ms)) === today && e.ms > now - 3600000);
    const lines = list.length ? list.map((e) => `${IMP[e.impact] || "•"} <b>${hm.format(new Date(e.ms))}</b> ${esc(e.country)} ${esc(e.title)}  <i>${tagLine(e.tags)}</i>`) : ["No major Gold / USD / Oil news today — technicals lead."];
    await tg([`📅 <b>Market News Today · ${dayLbl.format(new Date(now))}</b>`, `<i>Gold · USD · Oil · Big news only — Cambodia time</i>`, "", ...lines, "", `<a href="${SITE}/#alertPanel">Live countdowns on AROM TRADE</a>`].join("\n"));
    sent.push("brief");
  }

  // group events by release minute
  const groups = new Map();
  for (const e of ev) { const k = String(e.ms); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e); }
  for (const [ms, g] of groups) {
    const d = +ms - now, key = ms + "|" + g.map((e) => e.country + e.title).join(",");
    // 2) ~30 minutes before
    if (d > 0 && d <= 31 * 60000 && await claim(key, "pre")) {
      const mins = Math.max(1, Math.round(d / 60000));
      await tg([`⏰ <b>In ${mins} min · ${hm.format(new Date(+ms))} ICT</b>`, "",
        ...g.map((e) => `${IMP[e.impact] || "•"} <b>${esc(e.country)} ${esc(e.title)}</b> (${esc(e.impact)})\n   ${tagLine(e.tags)}${fp(e) ? " · " + fp(e) : ""}\n   ↳ ${esc(e.guide)}`),
        "", "<i>Expect volatility · widen stops or wait for the release.</i>"].join("\n"));
      sent.push("pre " + key);
    }
    // 3) at release
    if (d <= 0 && d > -10 * 60000 && await claim(key, "now")) {
      await tg([`🔴 <b>Releasing now · ${hm.format(new Date(+ms))} ICT</b>`,
        ...g.map((e) => `<b>${esc(e.country)} ${esc(e.title)}</b>${fp(e) ? " — " + fp(e) : ""}\n↳ ${esc(e.guide)}`)].join("\n"));
      sent.push("now " + key);
    }
  }
  return json({ ok: true, at: new Date(now).toISOString(), events: ev.length, sent });
});
