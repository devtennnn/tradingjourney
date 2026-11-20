// @ts-nocheck
// Supabase Edge Function: mt-price  (public, read-only, verify_jwt off)
// Gold (and other symbols) live price from the AROM price account: one MT5 terminal on MetaApi, read with the investor (read-only) password.
// GET ?symbol=XAUUSD -> { symbol, bid, ask, price, time, lag, candle?: {t,o,h,l,c} (current 1-minute candle), broker }
// GET ?debug=1       -> account state, region and the gold-like symbol names on the account (no prices)
// Secrets: METAAPI_TOKEN (Edge Function secret). Account id: ai_bot_config.mt_price_account (not secret).
// One MetaApi call per symbol per warm instance per second at most (in-memory cache); Vercel /api/live adds a 2 s CDN cache in front.
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const TOKEN = () => (Deno.env.get("METAAPI_TOKEN") || "").trim().replace(/^["']|["']$/g, "");   // tolerate spaces / quotes pasted into the secret
const PROV = "https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai";
const client = (region) => `https://mt-client-api-v1.${/^[a-z-]{2,30}$/.test(region || "") ? region : "london"}.agiliumtrade.ai`;
const ALLOWED = /^(XAU|XAG|GOLD|SILVER)[A-Za-z0-9._#-]{0,14}$/i;   // gold / silver only: each new symbol opens a paid MetaApi subscription
const json = (o, status = 200, cache = "no-store") => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": cache } });

let acct = null, acctAt = 0;            // {id, region, state, connectionStatus, broker}
let hostOk = null;                      // client API host that answered for this account (found by probing)
const cache = new Map();                // symbol -> {at, body}
async function ma(url, ms = 8000) {
  let r;
  try { r = await fetch(url, { headers: { "auth-token": TOKEN(), Accept: "application/json" }, signal: AbortSignal.timeout(ms) }); }
  catch (e) { return { ok: false, status: 0, j: null, t: "timeout / network: " + new URL(url).pathname.split("/").slice(-2).join("/") }; }
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) { /* not json */ }
  return { ok: r.ok, status: r.status, j, t: t.slice(0, 300) };
}
async function account() {
  if (acct && Date.now() - acctAt < 10 * 60_000) return acct;
  const { data } = await db.from("ai_bot_config").select("value").eq("key", "mt_price_account").maybeSingle();
  const id = String((data && data.value) || "").trim();
  if (!/^[0-9a-f-]{20,64}$/i.test(id)) throw new Error("mt_price_account not configured");
  // the account lookup needs the management API; a token limited to market data may not have it, so fall back to the london region
  const r = await ma(`${PROV}/users/current/accounts/${encodeURIComponent(id)}`, 10000);
  acct = r.ok && r.j ? { id, region: r.j.region, state: r.j.state, connectionStatus: r.j.connectionStatus, broker: r.j.server }
    : { id, region: "london", state: "unknown", connectionStatus: "lookup " + r.status + ": " + clip((r.j && r.j.message) || r.t), broker: null };
  acctAt = r.ok ? Date.now() : Date.now() - 9 * 60_000;   // retry a failed lookup after a minute
  return acct;
}
// MetaApi tells each user which domain its client API lives on (the SDK reads this too); try that first, then the plain regional host
async function hosts(region) {
  const out = [];
  const d = await ma(`${PROV}/users/current/servers/mt-client-api`, 8000);
  if (d.ok && d.j && d.j.domain) out.push(`https://${d.j.hostname || "mt-client-api-v1"}.${region}.${d.j.domain}`);
  for (const dom of ["agiliumtrade.ai", "agiliumlabs.cloud"]) for (const r of [region, region + "-a", region + "-b"]) out.push(`https://mt-client-api-v1.${r}.${dom}`);
  return { list: [...new Set(out)], discovery: d.ok ? d.j : { status: d.status, error: clip((d.j && d.j.message) || d.t) } };
}
const clip = (s) => String(s || "").replace(/\s*\([0-9a-f]{32}\)/, "").slice(0, 120);
const sec = (iso) => { const t = Date.parse(iso); return isFinite(t) ? Math.floor(t / 1000) : null; };

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (!TOKEN()) return json({ error: "metaapi_not_configured" }, 503);
  try {
    const a = await account(), path = `/users/current/accounts/${encodeURIComponent(a.id)}`;
    let base = (hostOk || client(a.region)) + path;
    // ?deploy=1&key=<ai_bot_config.cron_secret>: start the cloud MT5 terminal (MetaApi bills while it is deployed). Admin / cron only.
    if (url.searchParams.get("deploy") === "1") {
      const { data: k } = await db.from("ai_bot_config").select("value").eq("key", "cron_secret").maybeSingle();
      if (!k || !k.value || url.searchParams.get("key") !== k.value) return json({ error: "unauthorized" }, 401);
      const r = await fetch(`${PROV}/users/current/accounts/${encodeURIComponent(a.id)}/deploy`, { method: "POST", headers: { "auth-token": TOKEN() }, signal: AbortSignal.timeout(15000) });
      acctAt = 0;
      return json({ deploy_status: r.status, detail: r.ok ? "deploying" : clip(await r.text()) }, r.ok ? 200 : 502);
    }
    if (url.searchParams.get("debug") === "1") {   // diagnostics: admin / cron only (shows account details)
      const { data: k } = await db.from("ai_bot_config").select("value").eq("key", "cron_secret").maybeSingle();
      if (!k || !k.value || url.searchParams.get("key") !== k.value) return json({ error: "unauthorized" }, 401);
      const h = await hosts(a.region || "london"), tried = [];
      let s = null;
      for (const host of h.list) { const r = await ma(`${host}${path}/symbols`, 6000); tried.push({ host, status: r.status }); if (r.ok) { s = r; hostOk = host; break; } s = r; }
      const gold = Array.isArray(s.j) ? s.j.filter((x) => /XAU|GOLD/i.test(String(x))).slice(0, 20) : null;
      const t = TOKEN();
      return json({ token: { length: t.length, jwt_parts: t.split(".").length }, account: { region: a.region, state: a.state, connectionStatus: a.connectionStatus, server: a.broker }, discovery: h.discovery, tried, host: hostOk, symbols_status: s.status, gold_symbols: gold, symbols_error: s.ok ? null : String((s.j && s.j.message) || s.t).slice(0, 400) });
    }
    const sym = String(url.searchParams.get("symbol") || "XAUUSD");
    if (!ALLOWED.test(sym)) return json({ error: "bad symbol" }, 400);
    const hit = cache.get(sym);
    if (hit && Date.now() - hit.at < 1000) return json(hit.body, 200, "public, max-age=1");
    const now = Math.floor(Date.now() / 1000);
    const [p, c] = await Promise.all([
      ma(`${base}/symbols/${encodeURIComponent(sym)}/current-price?keepSubscription=true`),
      ma(`${base}/symbols/${encodeURIComponent(sym)}/current-candles/1m?keepSubscription=true`),
    ]);
    if (!p.ok || !p.j || !isFinite(p.j.bid)) {
      if (p.status === 404 || p.status === 409) acctAt = 0;   // re-read the account next time (redeployed / still connecting)
      return json({ error: "price unavailable", status: p.status, detail: (p.j && (p.j.message || p.j.error)) || p.t }, 502);
    }
    const bid = +p.j.bid, ask = isFinite(p.j.ask) ? +p.j.ask : bid, time = sec(p.j.time) || now;
    const body = { symbol: sym, bid, ask, price: +((bid + ask) / 2).toFixed(5), time, lag: Math.max(0, now - time), broker: a.broker, at: now };
    if (c.ok && c.j && isFinite(c.j.open)) { const t = sec(c.j.time); if (t) body.candle = { t: t - (t % 60), o: +c.j.open, h: +c.j.high, l: +c.j.low, c: +c.j.close }; }
    cache.set(sym, { at: Date.now(), body });
    return json(body, 200, "public, max-age=1");
  } catch (e) { return json({ error: String((e && e.message) || e) }, 502); }
});
