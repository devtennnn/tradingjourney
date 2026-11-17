// @ts-nocheck
// Supabase Edge Function: integration-admin  (JWT required; ADMINS ONLY)
// The admin dashboard "Integrations" tab. It shows the state of the OpenAI and market-data integrations without ever returning a secret value.
//   POST { action: "overview" }                       -> providers, quota, AI usage and estimated cost, cache, warnings, which secrets are set (booleans only)
//   POST { action: "test_openai" }                    -> asks OpenAI for its model list (no tokens used) and records the result
//   POST { action: "test_market_data" }               -> one EURUSD quote through market-data (uses at most one provider call)
//   POST { action: "clear_cache", scope, confirm }    -> scope: "market" | "reports" | "briefings" | "all"; confirm must be true; written to the audit log
// Optional settings: OPENAI_PRICE_IN_PER_M, OPENAI_PRICE_OUT_PER_M (cost estimate), AI_COST_ALERT_USD (default 5 per 24 h), MARKET_QUOTA_RESERVE.
import { createClient } from "jsr:@supabase/supabase-js@2";
import OpenAI from "npm:openai@5.23.2";
import { prices, summariseUsage, buildWarnings } from "./lib.mjs";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const env = (k, d = "") => Deno.env.get(k) || d;
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const hits = new Map(); const limited = (id) => { const now = Date.now(), a = (hits.get(id) || []).filter((t) => now - t < 60_000); a.push(now); hits.set(id, a); return a.length > 30; };
const health = async (provider, ok, err) => {
  try {
    const { data: h } = await db.from("integration_health").select("*").eq("provider", provider).maybeSingle();
    const cur = h || { provider, calls_today: 0, errors_today: 0, calls_total: 0, errors_total: 0 }, d = new Date().toISOString().slice(0, 10), same = cur.calls_day === d;
    const row = { ...cur, calls_day: d, calls_today: (same ? cur.calls_today : 0) + 1, errors_today: (same ? cur.errors_today : 0) + (ok ? 0 : 1), calls_total: (cur.calls_total || 0) + 1, errors_total: (cur.errors_total || 0) + (ok ? 0 : 1), status: ok ? "ok" : "error", updated_at: new Date().toISOString() };
    if (ok) row.last_success_at = new Date().toISOString(); else { row.last_error = String(err || "").slice(0, 200); row.last_error_at = new Date().toISOString(); }
    await db.from("integration_health").upsert(row, { onConflict: "provider" });
  } catch (_) { /* best effort */ }
};
const SECRETS = ["SIFTINGIO_API_KEY", "OPENAI_API_KEY", "OPENAI_MODEL", "MARKETAUX_API_KEY"];

async function overview() {
  const now = Date.now(), model = env("OPENAI_MODEL"), pr = prices(model, env("OPENAI_PRICE_IN_PER_M"), env("OPENAI_PRICE_OUT_PER_M"));
  const [{ data: prov }, usageR, cacheR, repR] = await Promise.all([
    db.from("integration_health").select("*"),
    db.from("ai_usage_log").select("user_id,kind,input_tokens,output_tokens,ok,created_at").gte("created_at", new Date(now - 30 * 86400e3).toISOString()).order("created_at", { ascending: false }).limit(20000),
    db.from("market_cache").select("key,fetched_at").limit(5000),
    db.from("ai_reports").select("kind,generated_at").order("generated_at", { ascending: false }).limit(2000),
  ]);
  const providers = (prov || []).map((p) => ({ provider: p.provider, status: p.status, calls_today: p.calls_today, errors_today: p.errors_today, calls_total: p.calls_total, errors_total: p.errors_total, last_success_at: p.last_success_at, last_error: p.last_error, last_error_at: p.last_error_at, updated_at: p.updated_at }));
  const sift = (prov || []).find((p) => p.provider === "siftingio"), reserve = Math.max(0, parseInt(env("MARKET_QUOTA_RESERVE"), 10) || 800);
  let quota = null;
  if (sift && sift.quota_remaining != null) {
    const d = new Date(), dim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(), left = Math.max(1, dim - d.getUTCDate() + 1);
    quota = { limit: sift.quota_limit, remaining: sift.quota_remaining, reserve, days_left: left, per_day: Math.max(0, Math.floor((sift.quota_remaining - reserve) / left)), used_today: sift.calls_day === d.toISOString().slice(0, 10) ? sift.calls_today : 0, rate_limit_per_second: sift.rate_limit };
  }
  const usage = summariseUsage(usageR.data || [], now, pr); usage.truncated = (usageR.data || []).length >= 20000;
  // names for the top users (admins may see them)
  const ids = usage.top_users_24h.map((u) => u.user_id); let names = {};
  if (ids.length) { const { data: pf } = await db.from("profiles").select("id,username,email").in("id", ids); names = Object.fromEntries((pf || []).map((x) => [x.id, x.username ? "@" + x.username : x.email || x.id.slice(0, 8)])); }
  usage.top_users_24h = usage.top_users_24h.map((u) => ({ user: names[u.user_id] || u.user_id.slice(0, 8), requests: u.requests }));
  const rows = cacheR.data || [], pre = (p) => rows.filter((r) => r.key.startsWith(p)), newest = (a) => a.map((r) => r.fetched_at).sort().pop() || null, oldest = (a) => a.map((r) => r.fetched_at).sort()[0] || null;
  const market = rows.filter((r) => /^(c|q):/.test(r.key)), cache = { market_entries: market.length, news_entries: pre("news:").length, newest_market_at: newest(market), oldest_market_at: oldest(market), reports: {} };
  for (const r of repR.data || []) { const b = (cache.reports[r.kind] = cache.reports[r.kind] || { count: 0, newest_at: r.generated_at }); b.count++; }
  const secrets = Object.fromEntries(SECRETS.map((k) => [k, !!env(k)]));
  const costAlert = Number(env("AI_COST_ALERT_USD", "5")); 
  const warnings = buildWarnings({ now, secrets, model, providers, quota, usage, cache, costAlert: Number.isFinite(costAlert) ? costAlert : null });
  return { ok: true, generated_at: new Date(now).toISOString(), providers, quota, usage, price_note: pr.note, cache, configured: { ...secrets, OPENAI_MODEL: undefined }, model: model || null,
    settings: { AI_DAILY_USAGE_LIMIT: parseInt(env("AI_DAILY_USAGE_LIMIT"), 10) || 40, MARKET_QUOTA_RESERVE: reserve, BRIEFING_SYMBOLS: env("BRIEFING_SYMBOLS") || "default list", AI_COST_ALERT_USD: costAlert }, warnings };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = Deno.env.get("SUPABASE_URL"), anon = Deno.env.get("SUPABASE_ANON_KEY"), auth = req.headers.get("Authorization") ?? "";
    const uc = createClient(url, anon, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await uc.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
    const { data: p } = await db.from("profiles").select("is_admin").eq("id", user.id).maybeSingle();
    if (!(p && p.is_admin === true)) return json({ error: "admin_only" }, 403);
    if (limited(user.id)) return json({ error: "slow_down" }, 429);
    const b = await req.json().catch(() => ({})), action = String(b.action || "");
    if (action === "overview") return json(await overview());
    if (action === "test_openai") {
      if (!env("OPENAI_API_KEY")) return json({ ok: false, error: "not_configured", missing: "OPENAI_API_KEY" });
      const t0 = Date.now();
      try { const c = new OpenAI({ apiKey: env("OPENAI_API_KEY"), timeout: 20000, maxRetries: 0 }); let n = 0, has = false; for await (const m of c.models.list()) { n++; if (m.id === env("OPENAI_MODEL")) has = true; if (n >= 400) break; }
        await health("openai", true); return json({ ok: true, ms: Date.now() - t0, models_visible: n, configured_model: env("OPENAI_MODEL") || null, configured_model_available: env("OPENAI_MODEL") ? has : null, tokens_used: 0 });
      } catch (e) { const code = e instanceof OpenAI.AuthenticationError || e instanceof OpenAI.PermissionDeniedError ? "key_rejected" : e instanceof OpenAI.RateLimitError ? "rate_limited" : "unreachable"; await health("openai", false, code); return json({ ok: false, error: code, ms: Date.now() - t0 }); }
    }
    if (action === "test_market_data") {
      const t0 = Date.now();
      try { const r = await fetch(`${url}/functions/v1/market-data`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: auth, apikey: anon }, body: JSON.stringify({ action: "quote", symbol: "EURUSD" }) }); const j = await r.json().catch(() => null);
        if (!r.ok || !j || !j.ok) return json({ ok: false, error: (j && j.error) || "http_" + r.status, ms: Date.now() - t0 });
        return json({ ok: true, ms: Date.now() - t0, from_cache: !!j.meta.from_cache, price: j.quote.price, quote_time: j.quote.timestamp, stale: !!j.quote.is_stale, source: j.quote.source });
      } catch (_) { return json({ ok: false, error: "unreachable", ms: Date.now() - t0 }); }
    }
    if (action === "clear_cache") {
      const scope = String(b.scope || ""); if (!["market", "reports", "briefings", "all"].includes(scope)) return json({ error: "bad_scope" }, 400);
      if (b.confirm !== true) return json({ error: "confirm_required" }, 400);
      let n = 0;
      if (scope === "market" || scope === "all") { const r = await db.from("market_cache").delete().or("key.like.c:%,key.like.q:%").select("key"); n += (r.data || []).length; }
      if (scope === "all") { const r = await db.from("market_cache").delete().like("key", "news:%").select("key"); n += (r.data || []).length; }
      if (scope === "reports" || scope === "all") { const r = await db.from("ai_reports").delete().neq("id", 0).select("id"); n += (r.data || []).length; }
      if (scope === "briefings") { const r = await db.from("ai_reports").delete().like("kind", "briefing%").select("id"); n += (r.data || []).length; }
      await db.from("audit_log").insert({ user_id: user.id, actor_id: user.id, action: "integration_cache_cleared", detail: { scope, rows_removed: n } });
      return json({ ok: true, scope, rows_removed: n });
    }
    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    console.error("integration-admin:", String(e?.message ?? e));
    return json({ error: "server_error" }, 500);
  }
});
