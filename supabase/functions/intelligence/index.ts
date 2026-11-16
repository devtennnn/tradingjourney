// @ts-nocheck
// Supabase Edge Function: intelligence  (JWT required)
// AROM Intelligence runs HERE, not in the browser, so the gate is real: only Ultra members (and admins) get an answer.
//   POST { symbol, style }  ->  the full analysis from engine.js   (403 {error:"ultra_required"} for everyone else, 401 when signed out)
// The engine (engine.js, same file the tests run) is never shipped to the browser. Candles and the economic calendar come from the site's
// own public feeds (SITE_URL, default https://aromx.trade): /api/candles and /api/market-news.
import { createClient } from "jsr:@supabase/supabase-js@2";
import "./engine.js";                       // sets globalThis.AromIntel

const E = (globalThis as any).AromIntel;
const SITE = (Deno.env.get("SITE_URL") || "https://aromx.trade").replace(/\/$/, "");
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const SYMS = ["XAUUSD", "BTCUSD", "XAGUSD", "EURUSD", "GBPUSD", "USDJPY", "NQ", "OIL"], STYLES = ["scalp", "intraday", "swing"];

async function getJSON(url, ms = 12000) {
  const c = new AbortController(), id = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(url, { signal: c.signal, headers: { "User-Agent": "arom-intelligence/1.0" } }); const j = await r.json().catch(() => null); if (!r.ok || !j) throw new Error((j && j.error) || "HTTP " + r.status); return j; }
  finally { clearTimeout(id); }
}
// short cache so many Ultra members looking at the same market share one set of upstream calls
const feed = new Map();            // symbol -> { at, tf, status, source, delayed }
let calendar = { at: 0, events: null };
async function candles(sym) {
  const hit = feed.get(sym); if (hit && Date.now() - hit.at < 45_000) return hit;
  const tf = {}, status = {}; let source = "", delayed = false;
  await Promise.all([["60", "h1"], ["15", "m15"], ["5", "m5"], ["1", "m1"]].map(([k, name]) =>
    getJSON(`${SITE}/api/candles?symbol=${sym}&tf=${k}`).then((j) => { tf[name] = j.candles; status[k] = "ok " + j.candles.length; source = j.source || source; delayed = delayed || !!j.delayed; }).catch((e) => { status[k] = "failed"; })));
  const out = { at: Date.now(), tf, status, source, delayed }; feed.set(sym, out); if (feed.size > 40) feed.clear(); return out;
}
async function news() {
  if (calendar.events && Date.now() - calendar.at < 300_000) return calendar.events;
  const parts = await Promise.all(["this", "next"].map((w) => getJSON(`${SITE}/api/market-news?week=${w}`, 10000).then((j) => j.events || []).catch(() => null)));
  const ev = parts.every((x) => x == null) ? null : [].concat(parts[0] || [], parts[1] || []);
  calendar = { at: Date.now(), events: ev }; return ev;
}
const hits = new Map();            // user -> timestamps (40 requests per minute each)
const limited = (id) => { const now = Date.now(), a = (hits.get(id) || []).filter((t) => now - t < 60_000); a.push(now); hits.set(id, a); if (hits.size > 2000) hits.clear(); return a.length > 40; };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = Deno.env.get("SUPABASE_URL"), anon = Deno.env.get("SUPABASE_ANON_KEY"), service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const userClient = createClient(url, anon, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
    const db = createClient(url, service, { auth: { persistSession: false } });
    const { data: p } = await db.from("profiles").select("is_admin,ultra_until").eq("id", user.id).maybeSingle();
    const ultra = !!p && (p.is_admin === true || (!!p.ultra_until && new Date(p.ultra_until) > new Date()));
    if (!ultra) return json({ error: "ultra_required" }, 403);
    if (limited(user.id)) return json({ error: "slow_down" }, 429);
    const body = await req.json().catch(() => ({}));
    const symbol = String(body.symbol || "XAUUSD").toUpperCase(), style = String(body.style || "intraday");
    if (!SYMS.includes(symbol) || !STYLES.includes(style)) return json({ error: "bad_request" }, 400);
    const [f, ev] = await Promise.all([candles(symbol), news()]);
    const out = E.analyze({ symbol, style, tf: f.tf, news: ev, now: Date.now() });
    out.meta = { status: f.status, source: f.source, delayed: f.delayed, calendar: ev != null, at: Date.now() };
    return json(out);
  } catch (e) {
    console.error("intelligence:", String(e?.message ?? e));
    return json({ error: "server_error" }, 500);
  }
});
