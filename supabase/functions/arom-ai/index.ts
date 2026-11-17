// @ts-nocheck
// Supabase Edge Function: arom-ai  (JWT required; Ultra members and admins)
// AROM AI = OpenAI (Responses API, server side only) explaining VERIFIED data. It never fetches prices itself and never invents facts.
//   POST { action: "analyze", symbol, timeframe, lang, variant? }     -> technical analyst report (bias / levels / liquidity from the deterministic engine; the model only writes the explanation)
//   POST { action: "chat", message, conversation_id?, symbol?, lang } -> answer built from approved read-only tools (quote, candles, analysis, economic events, news, the member's OWN journal summary)
//   POST { action: "briefing", kind: "daily"|"session", lang, symbols? }   -> market briefing for the watchlist (engine facts per instrument + AI explanation, cached with its timestamp; admin may pass force: true)
//   POST { action: "journal_review", days: 7|30|90, lang }   -> review of the member's OWN journal (statistics calculated here; the AI explains them; no AI call under 5 trades)
//   POST { action: "conversations" } / { action: "messages", conversation_id } -> the member's own saved chats
// Secrets: OPENAI_API_KEY, OPENAI_MODEL (never hard-coded). Optional: OPENAI_MAX_OUTPUT_TOKENS (3000), OPENAI_REQUEST_TIMEOUT (seconds, 60), AI_DAILY_USAGE_LIMIT (40 OpenAI requests per member per 24 h),
// AI_REPORT_CACHE_S (600), AI_BRIEFING_CACHE_S (daily 10800, session 3600), BRIEFING_SYMBOLS (comma list), OPENAI_BRIEFING_MAX_OUTPUT_TOKENS (6000), MARKETAUX_API_KEY (news headlines), SITE_URL.
import { createClient } from "jsr:@supabase/supabase-js@2";
import OpenAI from "npm:openai@5.23.2";
import { SYSTEM, ANALYST_SCHEMA, CHAT_SCHEMA, compactAnalysis, numbersIn, ungroundedNumbers, toleranceFor, sanitiseAnalyst, analystText, buildReport, fallbackText, CHAT_TOOLS, SYMBOL_RE, TFS, journalStats, JOURNAL_SCHEMA, JOURNAL_RULES, journalReview, sanitiseJournal, journalText, journalFallback, BRIEF_DEFAULT, BRIEF_SCHEMA, compactBrief, unavailableBrief, sanitiseBrief, groundBrief, buildBriefing } from "./lib.mjs";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const env = (k, d = "") => Deno.env.get(k) || d;
const intEnv = (k, d) => { const n = parseInt(env(k), 10); return n > 0 ? n : d; };
const SITE = () => env("SITE_URL", "https://aromx.trade").replace(/\/$/, "");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

// ---- per-member limits ----
const hits = new Map();   // 6 requests a minute per member
const limited = (id) => { const now = Date.now(), a = (hits.get(id) || []).filter((t) => now - t < 60_000); a.push(now); hits.set(id, a); if (hits.size > 2000) hits.clear(); return a.length > 6; };
async function reserve(userId, kind) {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString(), limit = intEnv("AI_DAILY_USAGE_LIMIT", 40);
  const c = await db.from("ai_usage_log").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("ok", true).gte("created_at", since);
  if (c.error) { console.error("arom-ai usage table:", c.error.message); return { error: "setup_needed" }; }
  if ((c.count || 0) >= limit) return { error: "daily_limit", limit };
  const r = await db.from("ai_usage_log").insert({ user_id: userId, kind }).select("id").single();
  if (r.error) return { error: "setup_needed" };
  return { id: r.data.id, remaining: Math.max(0, limit - (c.count || 0) - 1) };
}
const finish = (id, model, usage) => db.from("ai_usage_log").update({ model, input_tokens: usage.input, output_tokens: usage.output }).eq("id", id);
const refund = (id) => db.from("ai_usage_log").delete().eq("id", id);

// ---- integration health (shown to admins by the market-data "health" action) ----
async function health(ok, err) {
  try {
    const { data: h } = await db.from("integration_health").select("*").eq("provider", "openai").maybeSingle();
    const cur = h || { provider: "openai", calls_today: 0, errors_today: 0, calls_total: 0, errors_total: 0 }, d = new Date().toISOString().slice(0, 10), same = cur.calls_day === d;
    const row = { ...cur, calls_day: d, calls_today: (same ? cur.calls_today : 0) + 1, errors_today: (same ? cur.errors_today : 0) + (ok ? 0 : 1), calls_total: (cur.calls_total || 0) + 1, errors_total: (cur.errors_total || 0) + (ok ? 0 : 1), status: ok ? "ok" : "error", updated_at: new Date().toISOString() };
    if (ok) row.last_success_at = new Date().toISOString(); else { row.last_error = String(err || "").slice(0, 200); row.last_error_at = new Date().toISOString(); }
    await db.from("integration_health").upsert(row, { onConflict: "provider" });
  } catch (_) { /* best effort */ }
}

// ---- calls to the other AROM functions with the member's own token ----
async function fn(name, body, auth, ms = 45_000) {
  try {
    const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), ms);
    const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/${name}`, { method: "POST", signal: ctl.signal, headers: { "Content-Type": "application/json", Authorization: auth, apikey: env("SUPABASE_ANON_KEY") }, body: JSON.stringify(body) });
    clearTimeout(to); const j = await r.json().catch(() => null);
    if (!r.ok || !j) return { error: (j && j.error) || "http_" + r.status };
    return j;
  } catch (_) { return { error: "timeout_or_network" }; }
}

// ---- OpenAI ----
let client = null;
const getClient = () => client || (client = new OpenAI({ apiKey: env("OPENAI_API_KEY"), timeout: intEnv("OPENAI_REQUEST_TIMEOUT", 60) * 1000, maxRetries: 1 }));
const reasoningLike = (m) => /^(o\d|gpt-5)/i.test(m);
/** one Responses API call; returns { text, calls, output, usage, refusal } */
async function ask(params) {
  const model = env("OPENAI_MODEL"), base = { model, store: false, max_output_tokens: intEnv("OPENAI_MAX_OUTPUT_TOKENS", 3000), ...params };
  let resp;
  try { resp = await getClient().responses.create(reasoningLike(model) ? { ...base, include: ["reasoning.encrypted_content"] } : base); }
  catch (e) {
    if (e instanceof OpenAI.BadRequestError && /include|encrypted/i.test(String(e.message))) resp = await getClient().responses.create(base);   // the model does not support the extra include: retry without it
    else throw e;
  }
  const out = resp.output || [], calls = out.filter((x) => x.type === "function_call");
  const msg = out.filter((x) => x.type === "message").flatMap((x) => x.content || []);
  return { text: msg.filter((c) => c.type === "output_text").map((c) => c.text).join(""), refusal: msg.some((c) => c.type === "refusal"), calls, output: out, status: resp.status, usage: { input: resp.usage?.input_tokens || 0, output: resp.usage?.output_tokens || 0 } };
}
function mapError(e) {
  if (e instanceof OpenAI.AuthenticationError || e instanceof OpenAI.PermissionDeniedError) return ["not_configured", 503];
  if (e instanceof OpenAI.RateLimitError) return ["busy", 503];
  if (e instanceof OpenAI.BadRequestError) return ["ai_bad_request", 502];
  return ["ai_failed", 502];
}
const langName = (l) => (l === "km" ? "Khmer (ភាសាខ្មែរ)" : "English");

// ---- approved read-only tools ----
let calendarCache = { at: 0, events: null };
async function calendar() {
  if (calendarCache.events && Date.now() - calendarCache.at < 300_000) return calendarCache.events;
  const parts = await Promise.all(["this", "next"].map(async (w) => { try { const r = await fetch(`${SITE()}/api/market-news?week=${w}`); const j = await r.json(); return r.ok ? j.events || [] : null; } catch { return null; } }));
  if (parts.every((x) => x == null)) return null;
  const seen = new Set(), all = [].concat(parts[0] || [], parts[1] || []).filter((e) => { const k = e.key || `${e.country}|${e.title}|${e.ms}`; if (seen.has(k)) return false; seen.add(k); return true; });   // this week and next week can overlap
  calendarCache = { at: Date.now(), events: all }; return all;
}
const ppTime = (ms) => new Date(ms + 7 * 3600e3).toISOString().slice(0, 16).replace("T", " ") + " (Cambodia, UTC+7)";
async function runTool(name, args, ctx) {
  const sym = String(args.symbol || "").toUpperCase();
  if (["get_market_quote", "get_market_candles", "get_market_analysis", "get_market_news"].includes(name) && !SYMBOL_RE.test(sym)) return { error: "bad_symbol" };
  if (name === "get_market_quote") { const r = await fn("market-data", { action: "quote", symbol: sym }, ctx.auth); return r.ok ? { quote: r.quote, meta: r.meta } : { error: r.error }; }
  if (name === "get_market_candles") {
    const tf = String(args.timeframe || ""), n = Math.min(40, Math.max(5, parseInt(args.limit, 10) || 20)); if (!TFS.includes(tf)) return { error: "bad_timeframe" };
    const r = await fn("market-data", { action: "candles", symbol: sym, timeframe: tf, limit: n }, ctx.auth); if (!r.ok) return { error: r.error };
    return { symbol: r.instrument.symbol, asset_class: r.instrument.asset_class, tracks: r.instrument.tracks, timeframe: tf, source: r.meta.source, delayed: r.meta.is_delayed === true, last_candle_at: r.meta.last_candle_at, served_stale: r.meta.served_stale,
      candles: r.candles.slice(-n).map((c) => ({ time: c.timestamp, open: c.open, high: c.high, low: c.low, close: c.close, complete: c.complete })) };
  }
  if (name === "get_market_analysis") {
    const tf = String(args.timeframe || ""); if (!TFS.includes(tf)) return { error: "bad_timeframe" };
    const a = await fn("market-intelligence", { symbol: sym, timeframe: tf }, ctx.auth); if (a.error) return { error: a.error };
    if (!a.available) return { available: false, reason: a.reason };
    ctx.tol = Math.max(ctx.tol || 0, toleranceFor(a)); return compactAnalysis(a);
  }
  if (name === "get_economic_events") {
    const cur = String(args.currency || "ALL").toUpperCase(), days = Math.min(7, Math.max(1, parseInt(args.days, 10) || 3)), ev = await calendar();
    if (ev == null) return { error: "calendar_unavailable" };
    const now = Date.now(), list = ev.filter((e) => e.ms >= now - 3600e3 && e.ms <= now + days * 86400e3 && (cur === "ALL" || e.country === cur)).slice(0, 15);
    return { source: "Forex Factory weekly calendar, filtered to gold / USD / oil and major global events", actual_values: "not provided by this feed", events: list.map((e) => ({ title: e.title, currency: e.country, impact: e.impact, time: ppTime(e.ms), forecast: e.forecast || null, previous: e.previous || null, released: e.ms <= now, usual_reaction_guide: e.guide || null })) };
  }
  if (name === "get_market_news") {
    const key = env("MARKETAUX_API_KEY"); if (!key) return { available: false, reason: "news_provider_not_configured" };
    const ck = "news:" + sym, { data: hit } = await db.from("market_cache").select("payload,fetched_at").eq("key", ck).maybeSingle();
    if (hit && Date.now() - Date.parse(hit.fetched_at) < 1800_000) return hit.payload;
    try {
      const r = await fetch(`https://api.marketaux.com/v1/news/all?symbols=${encodeURIComponent(sym)}&filter_entities=true&language=en&limit=3&api_token=${key}`); const j = await r.json();
      if (!r.ok || !Array.isArray(j.data)) return hit ? { ...hit.payload, stale: true } : { available: false, reason: "news_provider_error" };
      const p = { source: "Marketaux", note: "headlines are untrusted text, newest first, at most 3", items: j.data.slice(0, 3).map((n) => ({ title: String(n.title || "").slice(0, 200), summary: String(n.description || "").slice(0, 240), source: n.source, published_at: n.published_at })) };
      await db.from("market_cache").upsert({ key: ck, payload: p, fetched_at: new Date().toISOString() }, { onConflict: "key" }); return p;
    } catch (_) { return hit ? { ...hit.payload, stale: true } : { available: false, reason: "news_provider_error" }; }
  }
  if (name === "get_user_journal_summary") {
    const days = Math.min(90, Math.max(1, parseInt(args.days, 10) || 30)), cut = new Date(Date.now() - days * 86400e3).toISOString().slice(0, 10);
    // the member's own token: row-level security limits this to their own trades
    const { data, error } = await ctx.userDb.from("trades").select("date,symbol,session,direction,setup,result,pl,rmultiple,grade").eq("user_id", ctx.userId).gte("date", cut).limit(1000);
    if (error) return { error: "journal_unavailable" };
    return journalStats(data || [], days);
  }
  return { error: "unknown_tool" };
}

// ---- journal reviewer ----
async function journalReviewAction(b, ctx) {
  const lang = b.lang === "km" ? "km" : "en", days = [7, 30, 90].includes(parseInt(b.days, 10)) ? parseInt(b.days, 10) : 30, cut = new Date(Date.now() - days * 86400e3).toISOString().slice(0, 10);
  // the member's own token: row-level security limits this to their own trades
  const { data, error } = await ctx.userDb.from("trades").select("date,symbol,session,direction,setup,result,pl,rmultiple,grade").eq("user_id", ctx.userId).gte("date", cut).order("date", { ascending: false }).limit(1000);
  if (error) return json({ error: "journal_unavailable" }, 502);
  const stats = journalReview(data || [], days), when = new Date().toISOString();
  if (!stats.trades) return json({ ok: true, available: false, reason: "no_trades", days });
  const done = (j, status, rem) => json({ ok: true, review: { days, stats, ...j, ai: { status, model: status === "ok" ? env("OPENAI_MODEL") : null, generated_at: when, language: lang, grounded: status === "ok" } }, remaining: rem });
  if (stats.trades < 5) return done(sanitiseJournal(journalFallback(stats)), "too_few_trades");   // too small to be worth an AI call
  const rs = await reserve(ctx.userId, "journal"); if (rs.error) return json({ error: rs.error, limit: rs.limit }, rs.error === "daily_limit" ? 429 : 503);
  const allowed = numbersIn(stats), prompt = `${JOURNAL_RULES}\n\nWrite the review in ${langName(lang)}.\nStatistics (calculated, last ${days} days):\n${JSON.stringify(stats)}`;
  let usage = { input: 0, output: 0 }, ai = null, bad = [];
  try {
    for (let attempt = 0; attempt < 2 && !ai; attempt++) {
      const r = await ask({ instructions: SYSTEM, input: [{ role: "user", content: attempt ? prompt + `\n\nYour previous text contained numbers that are not in the statistics: ${bad.join(", ")}. Rewrite it using only numbers from the statistics.` : prompt }], text: { format: { type: "json_schema", name: "arom_journal", schema: JOURNAL_SCHEMA, strict: true } } });
      usage = { input: usage.input + r.usage.input, output: usage.output + r.usage.output };
      if (r.refusal) { await refund(rs.id); return json({ error: "refused" }, 502); }
      if (r.status === "incomplete") { await refund(rs.id); await health(false, "incomplete"); return json({ error: "ai_failed" }, 502); }
      let parsed = null; try { parsed = sanitiseJournal(JSON.parse(r.text)); } catch { parsed = null; }
      if (!parsed) { await refund(rs.id); await health(false, "bad_json"); return json({ error: "ai_failed" }, 502); }
      bad = ungroundedNumbers(journalText(parsed), allowed, 0.06); if (!bad.length) ai = parsed;
    }
  } catch (e) { await refund(rs.id); const [code, st] = mapError(e); console.error("arom-ai journal:", e?.status, String(e?.message ?? e).slice(0, 200)); await health(false, code); return json({ error: code }, st); }
  await health(true); await finish(rs.id, env("OPENAI_MODEL"), usage);
  return ai ? done(ai, "ok", rs.remaining) : done(sanitiseJournal(journalFallback(stats)), "rejected_ungrounded", rs.remaining);
}

// ---- analyst ----
async function analyze(b, ctx) {
  const symbol = String(b.symbol || "").toUpperCase(), timeframe = String(b.timeframe || "M15").toUpperCase(), lang = b.lang === "km" ? "km" : "en", variant = b.variant === "etf" ? "etf" : "futures";
  if (!SYMBOL_RE.test(symbol)) return json({ error: "bad_symbol" }, 400); if (!TFS.includes(timeframe)) return json({ error: "unknown_timeframe" }, 400);
  const cacheS = intEnv("AI_REPORT_CACHE_S", 600), { data: cached } = await db.from("ai_reports").select("payload,generated_at").eq("kind", "analyst").eq("symbol", symbol).eq("timeframe", timeframe).eq("lang", lang).eq("variant", variant).order("generated_at", { ascending: false }).limit(1).maybeSingle();
  if (cached && Date.now() - Date.parse(cached.generated_at) < cacheS * 1000) return json({ ok: true, report: { ...cached.payload, ai: { ...cached.payload.ai, from_cache: true, generated_at: cached.generated_at } } });
  const a = await fn("market-intelligence", { symbol, timeframe, variant }, ctx.auth);
  if (a.error === "unknown_symbol") return json({ error: "unknown_symbol" }, 400); if (a.error) return json({ error: a.error === "slow_down" ? "slow_down" : "data_unavailable", detail: a.error }, 502);
  if (!a.available) return json({ ok: true, available: false, symbol, timeframe, reason: a.reason, note: "No analysis is produced when required market data is incomplete." });
  const when = new Date().toISOString();
  if (a.bias == null) { const r = buildReport(a, sanitiseAnalyst(fallbackText(a)), { status: "bias_withheld", generated_at: when, lang }); return json({ ok: true, report: r }); }   // stale or thin data: no AI, no direction
  const rs = await reserve(ctx.userId, "analyst"); if (rs.error) return json({ error: rs.error, limit: rs.limit }, rs.error === "daily_limit" ? 429 : 503);
  const compact = compactAnalysis(a), allowed = numbersIn(compact), tol = toleranceFor(a), prompt = `Write the technical analyst report for ${a.symbol} on ${a.timeframe}. Language: ${langName(lang)}.\nUse ONLY this verified data. Do not change the engine bias (${a.bias}); explain it, the structure, momentum, volatility, calculated liquidity and what would invalidate the reading. Bullish and bearish scenarios must be conditional ("if ... then ...") and use only levels from the data. The invalidation is invalidation_reference.level. Describe distances with price_context (ATR units).\n\nDATA:\n${JSON.stringify(compact)}`;
  let usage = { input: 0, output: 0 }, ai = null, bad = [];
  try {
    for (let attempt = 0; attempt < 2 && !ai; attempt++) {
      const r = await ask({ instructions: SYSTEM, input: [{ role: "user", content: attempt ? prompt + `\n\nYour previous text contained numbers that are not in the data: ${bad.join(", ")}. Rewrite it using only numbers from the data.` : prompt }], text: { format: { type: "json_schema", name: "arom_analyst", schema: ANALYST_SCHEMA, strict: true } } });
      usage = { input: usage.input + r.usage.input, output: usage.output + r.usage.output };
      if (r.refusal) { await refund(rs.id); return json({ error: "refused" }, 502); }
      if (r.status === "incomplete") { await refund(rs.id); await health(false, "incomplete"); return json({ error: "ai_failed" }, 502); }
      let parsed = null; try { parsed = sanitiseAnalyst(JSON.parse(r.text)); } catch { parsed = null; }
      if (!parsed) { await refund(rs.id); await health(false, "bad_json"); return json({ error: "ai_failed" }, 502); }
      bad = ungroundedNumbers(analystText(parsed), allowed, tol); if (!bad.length) ai = parsed;
    }
  } catch (e) { await refund(rs.id); const [code, st] = mapError(e); console.error("arom-ai analyze:", e?.status, String(e?.message ?? e).slice(0, 200)); await health(false, code); return json({ error: code }, st); }
  await health(true); await finish(rs.id, env("OPENAI_MODEL"), usage);
  const status = ai ? "ok" : "rejected_ungrounded", report = buildReport(a, ai || sanitiseAnalyst(fallbackText(a)), { status, model: env("OPENAI_MODEL"), generated_at: when, lang });
  await db.from("ai_reports").insert({ kind: "analyst", symbol, timeframe, lang, variant, payload: report, data_snapshot: { sources: a.sources, last_candle_at: a.last_candle_at, calculated_at: a.calculated_at, engine: a.engine }, model: env("OPENAI_MODEL"), last_candle_at: a.last_candle_at });
  return json({ ok: true, report, remaining: rs.remaining });
}


// ---- market briefing ----
const sessionName = (ms) => { const h = new Date(ms).getUTCHours() + new Date(ms).getUTCMinutes() / 60; return h < 7 ? "Asia" : h < 12 ? "London" : h < 16 ? "London / New York overlap" : h < 21 ? "New York" : "Late New York / rollover"; };
const inflight = new Map();
const transient = (x) => /rate_limited|timeout|provider_error|http_5|http_429|slow_down|network/.test(String((x && (x.error || x.reason)) || ""));
const ladderGap = (x) => !!(x && x.available && x.multi_timeframe && (x.multi_timeframe.ladder || []).some((l) => l.available === false && transient(l)));
async function gatherBrief(syms, auth) {
  // two instruments at a time (each asks for 3 timeframes, and the data provider allows 5 requests a second), then one calm retry pass for transient failures
  const deadline = Date.now() + 75_000, out = new Array(syms.length); let idx = 0;
  const run = (s) => fn("market-intelligence", { symbol: s, timeframe: "H1" }, auth, 45_000);
  const worker = async () => { while (idx < syms.length) { const i = idx++; if (Date.now() > deadline) { out[i] = { error: "timeout" }; continue; } out[i] = await run(syms[i]); } };
  await Promise.all(Array.from({ length: 2 }, worker));
  for (let i = 0; i < syms.length; i++) {
    if ((transient(out[i]) || ladderGap(out[i])) && Date.now() < deadline - 5_000) { await new Promise((r) => setTimeout(r, 1500)); const again = await run(syms[i]); if (again.available || !out[i].available) out[i] = again; }   // the cache keeps what already worked, so only the failed timeframes are fetched again
  }
  return out;
}
async function briefing(b, ctx, admin) {
  const kind = b.kind === "session" ? "session" : "daily", lang = b.lang === "km" ? "km" : "en";
  const custom = Array.isArray(b.symbols) ? [...new Set(b.symbols.map((x) => String(x).toUpperCase()).filter((x) => SYMBOL_RE.test(x)))].slice(0, 12) : [];
  const envList = env("BRIEFING_SYMBOLS").split(",").map((x) => x.trim().toUpperCase()).filter((x) => SYMBOL_RE.test(x)).slice(0, 12);
  const syms = custom.length ? custom : envList.length ? envList : BRIEF_DEFAULT, listKey = syms.join(","), rkind = "briefing_" + kind, cacheS = intEnv("AI_BRIEFING_CACHE_S", kind === "daily" ? 10800 : 3600);
  const { data: cached } = await db.from("ai_reports").select("payload,generated_at").eq("kind", rkind).eq("symbol", listKey).eq("timeframe", "H1").eq("lang", lang).order("generated_at", { ascending: false }).limit(1).maybeSingle();
  if (cached && !(b.force === true && admin) && Date.now() - Date.parse(cached.generated_at) < cacheS * 1000) {
    return json({ ok: true, briefing: { ...cached.payload, generated_at: cached.generated_at, age_seconds: Math.round((Date.now() - Date.parse(cached.generated_at)) / 1000), ai: { ...cached.payload.ai, from_cache: true } } });
  }
  const key = rkind + "|" + listKey + "|" + lang;
  if (inflight.has(key)) { const r = await inflight.get(key); return json(r.body, r.status); }   // the same briefing is already being built on this instance
  const job = (async () => { const res = await buildBrief(kind, lang, syms, listKey, rkind, ctx); return res; })();
  inflight.set(key, job);
  try { const r = await job; return json(r.body, r.status); } finally { inflight.delete(key); }
}
async function buildBrief(kind, lang, syms, listKey, rkind, ctx) {
  const got = await gatherBrief(syms, ctx.auth), cs = syms.map((s, i) => (got[i] && got[i].available ? compactBrief(s, got[i]) : unavailableBrief(s, (got[i] && (got[i].error || got[i].reason)) || "unavailable")));
  const have = cs.filter((c) => c.available);
  if (!have.length) return { status: 200, body: { ok: true, available: false, reason: "no instrument had enough verified data", instruments: cs.map((c) => ({ symbol: c.symbol, reason: c.reason })) } };
  const now = Date.now(), hours = kind === "daily" ? 24 : 8, ev = await calendar();
  const events = ev == null ? null : ev.filter((e) => e.ms >= now - 1800e3 && e.ms <= now + hours * 3600e3).slice(0, 10).map((e) => ({ title: e.title, currency: e.country, impact: e.impact, time: ppTime(e.ms), forecast: e.forecast || null, previous: e.previous || null, released: e.ms <= now, usual_reaction_guide: e.guide || null }));
  const session = { current: sessionName(now), utc: new Date(now).toISOString().slice(0, 16) + "Z", cambodia_time: ppTime(now) };
  const data = { session, window_hours: hours, events: events == null ? "calendar_unavailable" : events, events_note: "the calendar feed has no actual released values; only forecast and previous", instruments: cs };
  const allowedAll = numbersIn(data);
  const rs = await reserve(ctx.userId, "briefing"); if (rs.error) return { status: rs.error === "daily_limit" ? 429 : 503, body: { error: rs.error, limit: rs.limit } };
  const base = `Write the ${kind} market briefing for the AROM TRADE watchlist. Language: ${langName(lang)}. Current session: ${session.current}.\nUse ONLY the data below. Write exactly one entry in "instruments" for every instrument with available=true (symbol must match). If engine_bias is null give no direction. Describe distances with the ATR values given. Copy numbers exactly as they appear in the data. Events: list only events from the data; if there are none, say so in session_context. Do not give causes or news that are not in the data. cross_market_notes may only relate engine biases of the instruments shown. Mention a higher timeframe as unavailable ONLY if it is listed in higher_timeframes_unavailable; otherwise do not claim any timeframe is missing. Use the word \"aligned\" only when alignment is \"aligned\"; for the cross-market notes count engine_bias values (for example \"engine bias is bearish on 6 of 7 instruments\") and do not describe instruments with alignment other than \"aligned\" as aligned. Keep each instrument entry short (about 60 words).\n\nDATA:\n${JSON.stringify(data)}`;
  let usage = { input: 0, output: 0 }, grounded = null, replaced = [], bad = {};
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const prompt = attempt ? base + `\n\nThese parts of your previous briefing contained numbers that are not in the data: ${Object.entries(bad).map(([k, v]) => k + ": " + v.join(", ")).join("; ")}. Rewrite the whole briefing using only numbers from the data.` : base;
      const r = await ask({ instructions: SYSTEM, input: [{ role: "user", content: prompt }], max_output_tokens: intEnv("OPENAI_BRIEFING_MAX_OUTPUT_TOKENS", 6000), text: { format: { type: "json_schema", name: "arom_briefing", schema: BRIEF_SCHEMA, strict: true } } });
      usage = { input: usage.input + r.usage.input, output: usage.output + r.usage.output };
      if (r.refusal) { await refund(rs.id); return { status: 502, body: { error: "refused" } }; }
      if (r.status === "incomplete") { await refund(rs.id); await health(false, "incomplete"); return { status: 502, body: { error: "ai_failed" } }; }
      let parsed = null; try { parsed = sanitiseBrief(JSON.parse(r.text), syms); } catch { parsed = null; }
      if (!parsed) { await refund(rs.id); await health(false, "bad_json"); return { status: 502, body: { error: "ai_failed" } }; }
      const g = groundBrief(parsed, cs, events || []); grounded = g.grounded; replaced = g.replaced; bad = g.bad;
      if (!replaced.length) break;
    }
  } catch (e) { await refund(rs.id); const [code, st] = mapError(e); console.error("arom-ai briefing:", e?.status, String(e?.message ?? e).slice(0, 200)); await health(false, code); return { status: st, body: { error: code } }; }
  await health(true); await finish(rs.id, env("OPENAI_MODEL"), usage);
  const generatedAt = new Date().toISOString(), report = buildBriefing({ kind, lang, cs, grounded, events: events == null ? null : events, session, status: replaced.length ? "partial_fallback" : "ok", model: env("OPENAI_MODEL"), generatedAt, replaced });
  await db.from("ai_reports").insert({ kind: rkind, symbol: listKey, timeframe: "H1", lang, variant: "default", payload: report, data_snapshot: { instruments: cs.map((c) => ({ symbol: c.symbol, available: c.available, last_candle_at: c.last_candle_at || null, freshness: c.freshness || null, reason: c.reason || null })), events: Array.isArray(events) ? events.length : null, session }, model: env("OPENAI_MODEL"), last_candle_at: have.map((c) => c.last_candle_at).sort().pop() });
  return { status: 200, body: { ok: true, briefing: report, remaining: rs.remaining } };
}

// ---- chat ----
async function chat(b, ctx) {
  const message = String(b.message || "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim(), lang = b.lang === "km" ? "km" : "en";
  if (!message) return json({ error: "empty_message" }, 400); if (message.length > 1200) return json({ error: "message_too_long" }, 400);
  let convId = null;
  if (b.conversation_id) { if (!UUID.test(String(b.conversation_id))) return json({ error: "bad_conversation" }, 400); const { data: c } = await db.from("ai_conversations").select("id,user_id").eq("id", b.conversation_id).maybeSingle(); if (!c || c.user_id !== ctx.userId) return json({ error: "conversation_not_found" }, 404); convId = c.id; }
  const rs = await reserve(ctx.userId, "chat"); if (rs.error) return json({ error: rs.error, limit: rs.limit }, rs.error === "daily_limit" ? 429 : 503);
  let history = []; if (convId) { const { data } = await db.from("ai_messages").select("role,content").eq("conversation_id", convId).order("id", { ascending: false }).limit(8); history = (data || []).reverse().map((m) => ({ role: m.role, content: m.content })); }
  const hint = b.symbol && SYMBOL_RE.test(String(b.symbol)) ? ` The member is currently looking at ${String(b.symbol).toUpperCase()}.` : "";
  let input = [...history, { role: "user", content: `${message}\n\n[context: now ${new Date().toISOString()} UTC; answer in ${langName(lang)};${hint} use the tools for any market fact; do not guess]` }];
  const allowed = numbersIn(message), calls = [], tctx = { ...ctx, tol: 0 }; let usage = { input: 0, output: 0 }, final = null, bad = [], retried = false;
  try {
    for (let step = 0; step < 6 && !final; step++) {
      const r = await ask({ instructions: SYSTEM, input, tools: CHAT_TOOLS, text: { format: { type: "json_schema", name: "arom_chat", schema: CHAT_SCHEMA, strict: true } } });
      usage = { input: usage.input + r.usage.input, output: usage.output + r.usage.output };
      if (r.refusal) { await refund(rs.id); return json({ error: "refused" }, 502); }
      if (r.calls.length) {
        input = [...input, ...r.output];
        for (const c of r.calls.slice(0, 4)) {
          let args = {}; try { args = JSON.parse(c.arguments || "{}"); } catch { args = {}; }
          const result = await runTool(c.name, args, tctx); allowed.push(...numbersIn(result)); calls.push({ tool: c.name, args, at: new Date().toISOString(), ok: !result.error });
          input.push({ type: "function_call_output", call_id: c.call_id, output: JSON.stringify(result).slice(0, 24000) });
        }
        continue;
      }
      if (r.status === "incomplete") { await refund(rs.id); await health(false, "incomplete"); return json({ error: "ai_failed" }, 502); }
      let parsed = null; try { parsed = JSON.parse(r.text); } catch { parsed = null; }
      if (!parsed || typeof parsed.answer !== "string") { await refund(rs.id); await health(false, "bad_json"); return json({ error: "ai_failed" }, 502); }
      bad = ungroundedNumbers(parsed.answer, allowed, Math.max(tctx.tol || 0, 1e-6));
      if (bad.length && !retried) { retried = true; input = [...input, ...r.output, { role: "user", content: `Your answer contained numbers that are not in the data you retrieved: ${bad.join(", ")}. Rewrite the answer using only numbers from the tool results, or say the value is not available.` }]; continue; }
      final = parsed;
    }
  } catch (e) { await refund(rs.id); const [code, st] = mapError(e); console.error("arom-ai chat:", e?.status, String(e?.message ?? e).slice(0, 200)); await health(false, code); return json({ error: code }, st); }
  if (!final) { await refund(rs.id); await health(false, "no_final"); return json({ error: "ai_failed" }, 502); }
  await health(true); await finish(rs.id, env("OPENAI_MODEL"), usage);
  const rejected = bad.length > 0, answer = rejected ? "I could not verify every number in my answer against the data I retrieved, so I am not showing it. Please ask again, or ask for a specific symbol and timeframe." : String(final.answer).slice(0, 4000);
  const refs = { tools: calls, data_used: Array.isArray(final.data_used) ? final.data_used.slice(0, 8).map((x) => String(x).slice(0, 200)) : [], caveats: Array.isArray(final.caveats) ? final.caveats.slice(0, 6).map((x) => String(x).slice(0, 300)) : [], status: rejected ? "rejected_ungrounded" : "ok" };
  if (!convId) { const t = await db.from("ai_conversations").insert({ user_id: ctx.userId, title: message.slice(0, 60), symbol: b.symbol && SYMBOL_RE.test(String(b.symbol)) ? String(b.symbol).toUpperCase() : null }).select("id").single(); if (t.error) { console.error("arom-ai conversation:", t.error.message); return json({ error: "setup_needed" }, 503); } convId = t.data.id; }
  await db.from("ai_messages").insert([{ conversation_id: convId, user_id: ctx.userId, role: "user", content: message }, { conversation_id: convId, user_id: ctx.userId, role: "assistant", content: answer, data_refs: refs }]);
  await db.from("ai_conversations").update({ updated_at: new Date().toISOString() }).eq("id", convId);
  return json({ ok: true, conversation_id: convId, answer, caveats: refs.caveats, data_used: refs.data_used, tools_called: calls, ai: { status: refs.status, model: env("OPENAI_MODEL"), language: lang }, remaining: rs.remaining });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = Deno.env.get("SUPABASE_URL"), anon = Deno.env.get("SUPABASE_ANON_KEY"), auth = req.headers.get("Authorization") ?? "";
    const userDb = createClient(url, anon, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await userDb.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
    const { data: p } = await db.from("profiles").select("is_admin,ultra_until").eq("id", user.id).maybeSingle();
    if (!(p && (p.is_admin === true || (p.ultra_until && new Date(p.ultra_until) > new Date())))) return json({ error: "ultra_required" }, 403);
    const b = await req.json().catch(() => ({})), action = String(b.action || ""), ctx = { auth, userId: user.id, userDb };
    if (action === "conversations") { const { data } = await userDb.from("ai_conversations").select("id,title,symbol,updated_at").order("updated_at", { ascending: false }).limit(30); return json({ ok: true, conversations: data || [] }); }
    if (action === "messages") { if (!UUID.test(String(b.conversation_id || ""))) return json({ error: "bad_conversation" }, 400); const { data } = await userDb.from("ai_messages").select("role,content,data_refs,created_at").eq("conversation_id", b.conversation_id).order("id", { ascending: true }).limit(100); return json({ ok: true, messages: data || [] }); }
    if (action === "models") {   // admin helper: which models can this OpenAI key use? (so the OPENAI_MODEL secret can be chosen from a real list)
      if (p.is_admin !== true) return json({ error: "admin_only" }, 403);
      if (!env("OPENAI_API_KEY")) return json({ error: "not_configured", missing: "OPENAI_API_KEY" }, 503);
      try {
        const ids = []; for await (const m of getClient().models.list()) ids.push(m.id);
        const ok = ids.filter((id) => /^(gpt|o\d|chatgpt)/i.test(id) && !/(audio|realtime|tts|transcribe|image|embedding|moderation|search|whisper|dall|instruct|codex)/i.test(id)).sort();
        return json({ ok: true, models: ok, current: env("OPENAI_MODEL") || null });
      } catch (e) { const [code, st] = mapError(e); console.error("arom-ai models:", e?.status, String(e?.message ?? e).slice(0, 200)); return json({ error: code }, st); }
    }
    if (!["analyze", "chat", "briefing", "journal_review"].includes(action)) return json({ error: "unknown_action" }, 400);
    if (!env("OPENAI_API_KEY")) return json({ error: "not_configured", missing: "OPENAI_API_KEY" }, 503);
    if (!env("OPENAI_MODEL")) return json({ error: "not_configured", missing: "OPENAI_MODEL" }, 503);
    if (limited(user.id)) return json({ error: "slow_down" }, 429);
    return action === "analyze" ? await analyze(b, ctx) : action === "journal_review" ? await journalReviewAction(b, ctx) : action === "briefing" ? await briefing(b, ctx, p.is_admin === true) : await chat(b, ctx);
  } catch (e) {
    console.error("arom-ai:", String(e?.message ?? e));
    return json({ error: "server_error" }, 500);
  }
});
