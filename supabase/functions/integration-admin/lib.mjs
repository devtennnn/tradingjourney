// integration-admin: pure helpers (usage totals, cost estimate, warnings). No secrets, no network, no database.
const r2 = (x) => Math.round(x * 100) / 100;
const WIN = { "24h": 24 * 3600e3, "7d": 7 * 86400e3, "30d": 30 * 86400e3 };

/** token prices per million: from settings, or the built-in figure for gpt-4.1 only. Anything else stays unknown (no guessed cost). */
export function prices(model, inEnv, outEnv) {
  const a = Number(inEnv), b = Number(outEnv);
  if (Number.isFinite(a) && a > 0 && Number.isFinite(b) && b > 0) return { in: a, out: b, note: "from the OPENAI_PRICE_IN_PER_M / OPENAI_PRICE_OUT_PER_M settings" };
  if (/^gpt-4\.1$/i.test(model || "")) return { in: 2, out: 8, note: "built-in estimate for gpt-4.1 ($2 / $8 per million tokens); check OpenAI's pricing page or set the two price settings" };
  return { in: null, out: null, note: "cost unknown for this model: set OPENAI_PRICE_IN_PER_M and OPENAI_PRICE_OUT_PER_M to see an estimate" };
}
/** rows of ai_usage_log -> totals per window and per kind, distinct users, top users */
export function summariseUsage(rows, now, pr) {
  const out = { windows: {}, by_kind_24h: {}, active_users_24h: 0, top_users_24h: [], truncated: false };
  const cost = (i, o) => (pr.in == null ? null : r2((i * pr.in + o * pr.out) / 1e6));
  for (const [k, ms] of Object.entries(WIN)) {
    const x = rows.filter((r) => r.ok !== false && now - Date.parse(r.created_at) <= ms);
    const tin = x.reduce((s, r) => s + (r.input_tokens || 0), 0), tout = x.reduce((s, r) => s + (r.output_tokens || 0), 0);
    out.windows[k] = { requests: x.length, input_tokens: tin, output_tokens: tout, estimated_cost_usd: cost(tin, tout) };
  }
  const d = rows.filter((r) => r.ok !== false && now - Date.parse(r.created_at) <= WIN["24h"]);
  for (const r of d) { const k = r.kind || "other", b = (out.by_kind_24h[k] = out.by_kind_24h[k] || { requests: 0, input_tokens: 0, output_tokens: 0 }); b.requests++; b.input_tokens += r.input_tokens || 0; b.output_tokens += r.output_tokens || 0; }
  for (const b of Object.values(out.by_kind_24h)) b.estimated_cost_usd = cost(b.input_tokens, b.output_tokens);
  const per = {}; for (const r of d) per[r.user_id] = (per[r.user_id] || 0) + 1;
  out.active_users_24h = Object.keys(per).length;
  out.top_users_24h = Object.entries(per).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([user_id, requests]) => ({ user_id, requests }));
  return out;
}
/** plain-language warnings, most serious first. `c` = collected facts (see index.ts). */
export function buildWarnings(c) {
  const w = [], add = (level, code, text) => w.push({ level, code, text });
  const s = c.secrets;
  if (!s.SIFTINGIO_API_KEY) add("critical", "no_market_key", "SIFTINGIO_API_KEY is not set in Supabase secrets: no market data can be fetched.");
  if (!s.OPENAI_API_KEY) add("critical", "no_openai_key", "OPENAI_API_KEY is not set in Supabase secrets: AROM AI is switched off.");
  if (s.OPENAI_API_KEY && !c.model) add("critical", "no_model", "OPENAI_MODEL is not set: AROM AI cannot choose a model.");
  if (!s.MARKETAUX_API_KEY) add("info", "no_news_key", "MARKETAUX_API_KEY is not set: the news tool answers \"not configured\".");
  for (const p of c.providers) {
    const label = p.provider === "openai" ? "OpenAI" : p.provider === "siftingio" ? "SiftingIO (market data)" : p.provider;
    if (p.status === "error" && p.last_error_at && c.now - Date.parse(p.last_error_at) < 3600e3) add("warning", p.provider + "_error", `${label}: the latest call failed (${p.last_error || "error"}) ${Math.round((c.now - Date.parse(p.last_error_at)) / 60000)} min ago.`);
    if ((p.calls_today || 0) >= 10 && (p.errors_today || 0) / p.calls_today > 0.2) add("warning", p.provider + "_error_rate", `${label}: ${p.errors_today} of ${p.calls_today} calls failed today (${Math.round((p.errors_today / p.calls_today) * 100)} %).`);
    if (p.last_success_at && c.now - Date.parse(p.last_success_at) > 24 * 3600e3 && (p.calls_total || 0) > 0) add("info", p.provider + "_quiet", `${label}: no successful call for ${Math.round((c.now - Date.parse(p.last_success_at)) / 3600e3)} hours.`);
  }
  const q = c.quota;
  if (q && q.remaining != null) {
    if (q.remaining <= q.reserve) add("critical", "quota_reserve", `Market-data quota is at the protected reserve (${q.remaining} calls left, reserve ${q.reserve}): live fetching has stopped and cached data is served as stale.`);
    else if (q.per_day != null && q.used_today >= q.per_day && q.per_day > 0) add("warning", "quota_daily", `Today's market-data budget (${q.per_day} calls) is used up (${q.used_today} calls): further requests use cached data until tomorrow.`);
    else if (q.limit && q.remaining / q.limit < 0.2) add("warning", "quota_low", `Only ${q.remaining} of ${q.limit} market-data calls are left this month.`);
  }
  const u = c.usage && c.usage.windows["24h"];
  if (u && c.costAlert != null && u.estimated_cost_usd != null && u.estimated_cost_usd >= c.costAlert) add("warning", "cost_alert", `Estimated OpenAI cost in the last 24 hours is $${u.estimated_cost_usd} (alert level $${c.costAlert}).`);
  if (c.cache && c.cache.newest_market_at && c.now - Date.parse(c.cache.newest_market_at) > 6 * 3600e3 && (c.providers.find((p) => p.provider === "siftingio") || {}).calls_total > 0) add("info", "cache_old", "No market data has been refreshed for more than 6 hours (nobody has asked for it, or fetching is blocked).");
  const order = { critical: 0, warning: 1, info: 2 };
  return w.sort((a, b) => order[a.level] - order[b.level]);
}
