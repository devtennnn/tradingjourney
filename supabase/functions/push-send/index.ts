// @ts-nocheck
// Supabase Edge Function: push-send — Web Push to phones, iPads and desktops (notification bar, even when the app is closed)
//   GET  ?pub=1                       → VAPID public key for the browser (generated + stored on first call)
//   GET  ?run=tick&key=…  (pg_cron)   → news alerts (30 / 5 min / release) + market alerts (price levels, fast gold moves)
//   POST ?key=…  {kind:"signal",…}    → AI signal / update pushes (called by ai-telegram)
// Subscriptions live in public.push_subs (written only through the push_subscribe RPC). Keys live in public.ai_bot_config.
import * as webpush from "jsr:@negrel/webpush@0.5.0";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SITE = "https://truetradejourney.vercel.app";
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const hm = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Phnom_Penh", hour: "2-digit", minute: "2-digit", hour12: false });
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
const b64u = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const DEF = { sigAi: true, sigWf: true, sigUpd: true, news30: true, news5: true, newsNow: true, newsMed: false, moveOn: true, moveUsd: 10 };
const on = (p, k) => (p && p[k] !== undefined ? !!p[k] : !!DEF[k]);

async function cfgAll() {
  const { data, error } = await db.from("ai_bot_config").select("key,value");
  if (error) throw new Error(error.message);
  return Object.fromEntries((data || []).map((r) => [r.key, r.value]));
}
let APP = null, PUB = null;
async function appServer(c) {
  if (APP) return APP;
  let exported = c.vapid_jwk ? JSON.parse(c.vapid_jwk) : null;
  if (!exported) {   // first run: create the key pair once and keep it (service-role table)
    exported = await webpush.exportVapidKeys(await webpush.generateVapidKeys({ extractable: true }));
    await db.from("ai_bot_config").upsert({ key: "vapid_jwk", value: JSON.stringify(exported) }, { onConflict: "key" });
  }
  const vapidKeys = await webpush.importVapidKeys(exported, { extractable: false });
  APP = await webpush.ApplicationServer.new({ contactInformation: "mailto:alerts@arom.trade", vapidKeys });
  PUB = b64u(await APP.getVapidPublicKeyRaw());
  return APP;
}
async function claim(key, endpoint) {
  const { data } = await db.from("push_sent").upsert({ key, endpoint }, { onConflict: "key,endpoint", ignoreDuplicates: true }).select();
  return !!(data && data.length);
}
async function sendTo(app, sub, payload) {
  try {
    await app.subscribe({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } })
      .pushTextMessage(JSON.stringify(payload), { ttl: 3600, urgency: "high" });
    await db.from("push_subs").update({ last_ok: new Date().toISOString(), fails: 0 }).eq("endpoint", sub.endpoint);
    return true;
  } catch (e) {
    const gone = e && typeof e.isGone === "function" && e.isGone();
    if (gone || (sub.fails || 0) >= 5) await db.from("push_subs").delete().eq("endpoint", sub.endpoint);
    else await db.from("push_subs").update({ fails: (sub.fails || 0) + 1 }).eq("endpoint", sub.endpoint);
    return false;
  }
}
async function subs() {
  const { data } = await db.from("push_subs").select("*");
  return data || [];
}
async function eliteSet(list) {
  const ids = [...new Set(list.map((s) => s.user_id).filter(Boolean))], ok = new Set();
  for (const id of ids) { const { data } = await db.rpc("is_elite", { uid: id }); if (data) ok.add(id); }
  return ok;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === "OPTIONS") return json({});
  let c;
  try { c = await cfgAll(); } catch (e) { return json({ error: String(e.message || e) }, 500); }
  if (url.searchParams.get("pub")) { await appServer(c); return json({ key: PUB }); }
  if (!c.cron_secret || url.searchParams.get("key") !== c.cron_secret) return json({ error: "unauthorized" }, 401);
  const app = await appServer(c), all = await subs(), sent = [];
  if (!all.length) return json({ ok: true, subs: 0 });

  // ---- test push to every device (manual check) ----
  if (url.searchParams.get("test")) {
    for (const s of all) if (await sendTo(app, s, { title: "AROM TRADE", body: "Push notifications are working.", tag: "test", url: "/" })) sent.push("test");
    return json({ ok: true, subs: all.length, sent: sent.length });
  }

  // ---- AI signal pushes (from ai-telegram) ----
  if (req.method === "POST") {
    const m = await req.json().catch(() => ({}));
    const elite = await eliteSet(all);
    for (const s of all) {
      if (!s.user_id || !elite.has(s.user_id)) continue;                       // signals are an Elite feature
      const p = s.prefs || {};
      const want = m.update ? on(p, "sigUpd") : (on(p, "sigWf") || (on(p, "sigAi") && m.symbol === "XAUUSD" && (p.mode || "scalp") === m.mode));
      if (!want || !(await claim(m.key, s.endpoint))) continue;
      if (await sendTo(app, s, { title: m.title, body: m.body, tag: m.key, url: m.url || "/analysis#aiPanel" })) sent.push(m.key);
    }
    return json({ ok: true, sent: sent.length });
  }

  // ---- tick: news + market (every 2 minutes) ----
  const now = Date.now();
  // News (USD): 30 min before, 5 min before, at release
  try {
    const r = await fetch(`${SITE}/api/news?week=this`), ev = r.ok ? await r.json() : [];
    for (const e of ev) {
      const ms = Date.parse(e.date); if (!isFinite(ms) || String(e.country).toUpperCase() !== "USD") continue;
      const d = ms - now, imp = e.impact;
      if (imp !== "High" && imp !== "Medium") continue;
      const win = d <= 31 * 60000 && d > 25 * 60000 ? "news30" : d <= 6 * 60000 && d > 60000 ? "news5" : d <= 60000 && d > -5 * 60000 ? "newsNow" : null;
      if (!win) continue;
      const title = win === "news30" ? `⏰ In 30 min · ${e.title}` : win === "news5" ? `⏰ In 5 min · ${e.title}` : `🔴 Releasing now · ${e.title}`;
      const body = `${imp} USD news at ${hm.format(new Date(ms))} ICT · forecast ${e.forecast || "—"} · previous ${e.previous || "—"}. Expect volatility.`;
      for (const s of all) {
        const p = s.prefs || {};
        if (!on(p, win) || (imp === "Medium" && !on(p, "newsMed"))) continue;
        const k = `${win}|${e.title}|${ms}`;
        if (await claim(k, s.endpoint) && await sendTo(app, s, { title, body, tag: k, url: "/analysis#naPanel" })) sent.push(k);
      }
    }
  } catch (_) { /* news feed down: skip */ }
  // Market: price alerts + fast gold move
  try {
    const r = await fetch(`${SITE}/api/quotes`), j = r.ok ? await r.json() : null, Q = {};
    for (const q of (j && j.quotes) || []) if (!q.error) Q[q.key] = q;
    // keep ~20 minutes of gold prices to measure the 15-minute move
    let ticks = []; try { ticks = JSON.parse(c.xau_ticks || "[]"); } catch (_) { ticks = []; }
    if (Q.XAU) { ticks.push([now, Q.XAU.price]); ticks = ticks.filter(([t]) => now - t <= 20 * 60000); await db.from("ai_bot_config").upsert({ key: "xau_ticks", value: JSON.stringify(ticks) }, { onConflict: "key" }); }
    const old = ticks.find(([t]) => now - t >= 13 * 60000), mv = Q.XAU && old ? Q.XAU.price - old[1] : 0;
    for (const s of all) {
      const p = s.prefs || {};
      for (const a of p.pa || []) {
        const q = Q[a.sym]; if (!q || a.hit) continue;
        if (a.dir === "above" ? q.price >= a.px : q.price <= a.px) {
          const k = `pa|${a.id}|${a.sym}|${a.dir}|${a.px}`;
          if (await claim(k, s.endpoint) && await sendTo(app, s, { title: `${a.sym} ${a.dir} ${a.px}`, body: `${q.name} is now ${q.price.toFixed(q.dp || 2)}.`, tag: k, url: "/" })) sent.push(k);
        }
      }
      if (on(p, "moveOn") && Math.abs(mv) >= (+p.moveUsd || 10)) {
        const k = `mv|${Math.floor(now / 1800000)}`;
        if (await claim(k, s.endpoint) && await sendTo(app, s, { title: `Gold ${mv > 0 ? "up" : "down"} $${Math.abs(mv).toFixed(2)} in 15 min`, body: `XAU ${old[1].toFixed(2)} → ${Q.XAU.price.toFixed(2)}. Fast move: check the news and stick to your plan.`, tag: k, url: "/" })) sent.push(k);
      }
    }
  } catch (_) { /* quotes down: skip */ }
  // forget old dedupe rows
  await db.from("push_sent").delete().lt("sent_at", new Date(now - 3 * 86400000).toISOString());
  return json({ ok: true, subs: all.length, sent });
});
