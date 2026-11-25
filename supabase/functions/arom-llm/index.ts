// @ts-nocheck
// Supabase Edge Function: arom-llm (AI Desk → "AROM LLM" tab, Elite / Ultra)
// The member picks a market and timeframe and taps Scan: this function downloads the candles ITSELF (never trusts numbers from the browser),
// computes the indicators, the engine's own read and the nearest order blocks / FVGs / swings, and asks a language model for at most one
// trade plan available now or at a nearby level. The plan is then checked here (stop side and distance, TP side, reward ≥ 1R, entry near
// price) and dropped when it fails. Chat follows up on the last scan. Nothing is published, tracked or counted in the win rate.
//
// Auth: the member's Supabase session (Authorization header). Plan: is_elite() (Elite, Ultra or admin). Quota: ai_bot_config llm_daily per UTC day.
// Secrets: JURY_API_KEY, JURY_BASE_URL (the same OpenRouter key as the AI jury). Model: ai_bot_config llm_model.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import AiEng from "../ai-telegram/engine.ts";

const env = (k, d = "") => Deno.env.get(k) ?? d;
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const SITE = env("SITE_URL", "https://aromx.trade").replace(/\/$/, "");
const BASE = env("JURY_BASE_URL", "https://ai-gateway.vercel.sh/v1").replace(/\/$/, "");
const KEY = env("JURY_API_KEY").trim();
const SYMS = ["XAUUSD", "BTCUSD", "NQ"], TFS = [5, 15, 60];
const MODE_FOR_TF = { 15: "intraday", 60: "swing" };   // the engine's own read where a mode trades this timeframe

/* ---------- indicators ---------- */
const ema = (a, n) => { const k = 2 / (n + 1), o = []; let e = null; a.forEach((v, i) => { e = e == null ? v : v * k + e * (1 - k); o[i] = i >= n - 1 ? e : null; }); return o; };
function atrA(m, n = 14) { const o = new Array(m.length).fill(null); let a = 0; for (let i = 1; i < m.length; i++) { const tr = Math.max(m[i].h - m[i].l, Math.abs(m[i].h - m[i - 1].c), Math.abs(m[i].l - m[i - 1].c)); a = i <= n ? (a * (i - 1) + tr) / i : (a * (n - 1) + tr) / n; if (i >= n) o[i] = a; } return o; }
function rsi(c, n = 14) { let g = 0, l = 0; for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; d > 0 ? g += d : l -= d; } g /= n; l /= n; for (let i = n + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; } return l === 0 ? 100 : 100 - 100 / (1 + g / l); }

function context(sym, tf, m) {
  const n = m.length - 1, px = m[n].c, dp = px >= 100 ? 2 : 5, f = (v) => +(+v).toFixed(dp);
  const c = m.map((b) => b.c), e20 = ema(c, 20), e50 = ema(c, 50), A = atrA(m), a = A[n];
  // swing highs / lows (3-bar fractal) in the last 200 candles: the nearest 3 above and below price
  const hs = [], ls = [];
  for (let k = Math.max(3, n - 200); k <= n - 3; k++) {
    const hi = m[k].h, lo = m[k].l;
    if ([1, 2, 3].every((d) => hi > m[k - d].h && hi >= m[k + d].h)) hs.push(hi);
    if ([1, 2, 3].every((d) => lo < m[k - d].l && lo <= m[k + d].l)) ls.push(lo);
  }
  const above = hs.concat(ls).filter((v) => v > px).sort((x, y) => x - y).slice(0, 3).map(f);
  const below = hs.concat(ls).filter((v) => v < px).sort((x, y) => y - x).slice(0, 3).map(f);
  let zones = [];
  try { zones = AiEng.smcActive(AiEng.smcZones(m, A, { life: 600 }), n).filter((z) => z.kind !== "ifvg")
    .map((z) => ({ kind: z.kind.toUpperCase(), dir: z.dir, lo: f(z.bot), hi: f(z.top), dist_atr: +((z.top < px ? px - z.top : z.bot > px ? z.bot - px : 0) / a).toFixed(1) }))
    .sort((x, y) => x.dist_atr - y.dist_atr).slice(0, 6); } catch (_) { /* zones are optional */ }
  let engine = null;
  const mode = MODE_FOR_TF[tf];
  if (mode) { try { const P = AiEng.prep(m, null, mode, sym), ev = AiEng.evalAt(P, n, null);
    engine = { mode, grade: ev.grade, side: ev.side || null, failing: (ev.checks || []).filter((x) => !x.pass).map((x) => x.key) }; } catch (_) { /* optional */ } }
  const day = m.slice(-Math.round(86400 / (tf * 60)));
  return {
    market: sym, timeframe: tf + "m", time_utc: new Date((m[n].t + tf * 60) * 1000).toISOString().slice(0, 16), price: f(px),
    ema20: f(e20[n]), ema50: f(e50[n]), ema20_slope_atr: +((e20[n] - e20[n - 5]) / a).toFixed(2), rsi14: +rsi(c.slice(-200)).toFixed(1), atr14: f(a),
    day_high: f(Math.max(...day.map((b) => b.h))), day_low: f(Math.min(...day.map((b) => b.l))),
    levels_above: above, levels_below: below, zones, engine,
    candles: m.slice(-60).map((b) => [new Date(b.t * 1000).toISOString().slice(5, 16), f(b.o), f(b.h), f(b.l), f(b.c)]),
  };
}

/* ---------- model ---------- */
const LANG = { en: "English", km: "Khmer (ខ្មែរ)" };
const SCAN_SYS = (lang) => `You are AROM LLM, the market analyst of AROM TRADE. You get one market's data: price, EMA 20/50, RSI, ATR, the day range, swing levels, unfilled order blocks (OB) and fair value gaps (FVG), the rule engine's own read (may be null) and the last 60 candles (UTC, oldest first: time, open, high, low, close).
Find at most ONE trade setup that is available now (market order) or at a nearby level (limit order). Use only the data. Do not invent news.
Rules: the stop goes beyond real structure, between 0.5 and 3 ATR from the entry. TP1 is at least 1R away, at or before the next real level; TP2 is optional. A limit entry must be within 3 ATR of price. If nothing clean exists, set "setup" to null and say what to wait for. Being flat is a valid answer.
Write every text field in ${LANG[lang] || "English"}, but keep trading terms in English (FVG, OB, EMA, RSI, ATR, bullish, bearish, support, resistance, pullback, breakout, R). Keep numbers as plain numbers.
Answer with ONE JSON object and nothing else:
{"bias":"bullish"|"bearish"|"neutral","setup":{"side":"BUY"|"SELL","order":"market"|"limit","entry":0,"sl":0,"tp1":0,"tp2":0,"invalidation":"max 20 words"}|null,"confidence":0-100,"summary":"max 40 words","reasons":["max 3, max 15 words each"],"risks":["max 3, max 15 words each"],"wait_for":"max 25 words"}`;
const CHAT_SYS = (lang) => `You are AROM LLM, the market analyst of AROM TRADE. Answer the member's question about the market data and the last scan below. Be concrete and short (max 150 words), use the numbers given, never promise results, and say clearly when the data cannot answer. You do not place trades. Write in ${LANG[lang] || "English"}, keeping trading terms in English (FVG, OB, EMA, RSI, ATR, bullish, bearish, support, resistance).`;

async function ask(model, messages, max) {
  const tries = [{ extra: { reasoning: { effort: "none" } }, max }, { extra: {}, max: max + 2000 }];
  let last = { ok: false, error: "no attempt" };
  for (const a of tries) {
    try {
      const r = await fetch(BASE + "/chat/completions", { method: "POST", signal: AbortSignal.timeout(45000),
        headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, temperature: 0.2, max_tokens: a.max, ...a.extra, messages }) });
      const j = await r.json().catch(() => null);
      if (!r.ok) { last = { ok: false, error: `http ${r.status}`, detail: String(j?.error?.message || "").slice(0, 160) }; if (r.status === 400 || r.status === 422) continue; return last; }
      const text = j?.choices?.[0]?.message?.content, u = j?.usage || {};
      if (text && String(text).trim()) return { ok: true, text: String(text), tin: u.prompt_tokens ?? null, tout: u.completion_tokens ?? null };
      last = { ok: false, error: "empty answer" };
    } catch (e) { last = { ok: false, error: String(e?.message || e).slice(0, 120) }; }
  }
  return last;
}

/* ---------- the model's plan must pass these checks, or it is dropped ---------- */
function checkPlan(s, ctx) {
  if (!s || typeof s !== "object") return { setup: null, note: null };
  const px = ctx.price, a = ctx.atr14, side = String(s.side || "").toUpperCase(), buy = side === "BUY";
  const [en, sl, t1] = [s.entry, s.sl, s.tp1].map(Number); let t2 = s.tp2 == null || s.tp2 === 0 ? null : Number(s.tp2);
  const bad = (why) => ({ setup: null, note: why });
  if (side !== "BUY" && side !== "SELL") return bad("side");
  if (![en, sl, t1].every(Number.isFinite) || !(a > 0)) return bad("numbers");
  if (buy ? !(sl < en && t1 > en) : !(sl > en && t1 < en)) return bad("levels on the wrong side");
  const risk = Math.abs(en - sl);
  if (risk < 0.3 * a || risk > 4 * a) return bad("stop distance");
  if (Math.abs(en - px) > 3 * a) return bad("entry too far from price");
  const rr1 = Math.abs(t1 - en) / risk; if (rr1 < 1) return bad("reward below 1R");
  if (t2 != null && (!Number.isFinite(t2) || (buy ? t2 <= t1 : t2 >= t1))) t2 = null;
  const order = Math.abs(en - px) <= 0.3 * a ? "market" : "limit";
  const dp = px >= 100 ? 2 : 5, f = (v) => +v.toFixed(dp);
  return { setup: { side, order, entry: f(en), sl: f(sl), tp1: f(t1), tp2: t2 == null ? null : f(t2), rr1: +rr1.toFixed(2), rr2: t2 == null ? null : +(Math.abs(t2 - en) / risk).toFixed(2),
    risk_atr: +(risk / a).toFixed(2), invalidation: String(s.invalidation || "").slice(0, 200) }, note: null };
}
const parseObj = (t) => { const m = String(t || "").match(/\{[\s\S]*\}/); if (!m) return null; try { return JSON.parse(m[0]); } catch (_) { return null; } };
const strs = (a, n, len) => (Array.isArray(a) ? a : []).slice(0, n).map((x) => String(x).slice(0, len));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    // operator self test (cron key header): one real scan on gold 15m, no user, no quota, nothing logged
    if (new URL(req.url).searchParams.get("test") === "1") {
      const adm = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));
      const { data: rs } = await adm.from("ai_bot_config").select("key,value").in("key", ["cron_secret", "llm_model"]);
      const c = Object.fromEntries((rs || []).map((r) => [r.key, r.value])), k = req.headers.get("x-cron-key") || "";
      if (!c.cron_secret || k.length !== c.cron_secret.length || k !== c.cron_secret) return json({ error: "unauthorized" }, 401);
      const cr = await fetch(`${SITE}/api/candles?symbol=XAUUSD&tf=15`, { signal: AbortSignal.timeout(20000) }); const cj = await cr.json().catch(() => null);
      if (!Array.isArray(cj?.candles)) return json({ error: "no_data", status: cr.status });
      const ctx = context("XAUUSD", 15, cj.candles), model = c.llm_model || "deepseek/deepseek-v4.1-flash-1017";
      const r = await ask(model, [{ role: "system", content: SCAN_SYS("km") }, { role: "user", content: JSON.stringify(ctx) }], 900);
      const o = r.ok ? parseObj(r.text) : null;
      return json({ ok: !!o, model, ctx_size: JSON.stringify(ctx).length, engine: ctx.engine, zones: ctx.zones.length, price: ctx.price, atr: ctx.atr14, raw: o ? null : r, plan: o ? checkPlan(o.setup, ctx) : null, answer: o, tokens: [r.tin, r.tout] });
    }
    const url = env("SUPABASE_URL"), userClient = createClient(url, env("SUPABASE_ANON_KEY"), { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
    const admin = createClient(url, env("SUPABASE_SERVICE_ROLE_KEY"));
    const { data: elite } = await admin.rpc("is_elite", { uid: user.id });
    if (!elite) return json({ error: "plan" }, 403);
    const { data: rows } = await admin.from("ai_bot_config").select("key,value").in("key", ["llm_model", "llm_daily"]);
    const cfg = Object.fromEntries((rows || []).map((r) => [r.key, r.value]));
    const limit = Math.max(1, Number(cfg.llm_daily) || 20), model = cfg.llm_model || "deepseek/deepseek-v4.1-flash-1017";
    const body = await req.json().catch(() => ({}));
    const lang = body.lang === "km" ? "km" : "en";

    if (body.action === "quota") { const { data: left } = await admin.rpc("llm_left", { p_user: user.id, p_limit: limit }); return json({ ok: true, left, limit }); }
    if (body.action !== "scan" && body.action !== "chat") return json({ error: "unknown action" }, 400);
    const sym = SYMS.includes(body.sym) ? body.sym : "XAUUSD", tf = TFS.includes(Number(body.tf)) ? Number(body.tf) : 15;
    if (!KEY) return json({ error: "unavailable" }, 503);

    // candles from our own API (the same feed as the chart), downloaded here
    const cr = await fetch(`${SITE}/api/candles?symbol=${sym}&tf=${tf}`, { signal: AbortSignal.timeout(20000) });
    const cj = await cr.json().catch(() => null);
    if (!cr.ok || !Array.isArray(cj?.candles) || cj.candles.length < 120) return json({ error: "no_data" }, 502);
    const ctx = context(sym, tf, cj.candles);

    const { data: left } = await admin.rpc("llm_take", { p_user: user.id, p_limit: limit });
    if (left == null || left < 0) return json({ error: "quota", left: 0, limit }, 429);

    if (body.action === "scan") {
      const r = await ask(model, [{ role: "system", content: SCAN_SYS(lang) }, { role: "user", content: JSON.stringify(ctx) }], 900);
      const o = r.ok ? parseObj(r.text) : null;
      if (!o) { await admin.rpc("llm_refund", { p_user: user.id }); console.error("arom-llm scan failed", r.error, r.detail || ""); return json({ error: "model", left: left + 1, limit }, 502); }
      const chk = checkPlan(o.setup, ctx);
      const out = { bias: ["bullish", "bearish", "neutral"].includes(o.bias) ? o.bias : "neutral", setup: chk.setup, rejected: chk.note,
        confidence: Math.max(0, Math.min(100, Math.round(Number(o.confidence) || 0))), summary: String(o.summary || "").slice(0, 400),
        reasons: strs(o.reasons, 3, 160), risks: strs(o.risks, 3, 160), wait_for: String(o.wait_for || "").slice(0, 240),
        sym, tf, price: ctx.price, atr: ctx.atr14, at: ctx.time_utc, engine: ctx.engine, source: cj.source || null, model };
      await admin.from("llm_log").insert({ user_id: user.id, kind: "scan", sym, tf, model, result: out, tokens_in: r.tin, tokens_out: r.tout });
      return json({ ok: true, left, limit, scan: out });
    }

    // chat: the question, the member's own last scan and a few earlier turns of this conversation
    const q = String(body.q || "").trim().slice(0, 500);
    if (!q) { await admin.rpc("llm_refund", { p_user: user.id }); return json({ error: "empty" }, 400); }
    const hist = (Array.isArray(body.history) ? body.history : []).slice(-6).map((h) => ({ role: h.role === "assistant" ? "assistant" : "user", content: String(h.content || "").slice(0, 1200) }));
    const last = body.last && typeof body.last === "object" ? JSON.stringify(body.last).slice(0, 2500) : "none";
    const r = await ask(model, [{ role: "system", content: CHAT_SYS(lang) }, { role: "user", content: "Market data:\n" + JSON.stringify(ctx) + "\n\nLast scan:\n" + last }, ...hist, { role: "user", content: q }], 500);
    if (!r.ok) { await admin.rpc("llm_refund", { p_user: user.id }); console.error("arom-llm chat failed", r.error, r.detail || ""); return json({ error: "model", left: left + 1, limit }, 502); }
    const answer = r.text.trim().slice(0, 2000);
    await admin.from("llm_log").insert({ user_id: user.id, kind: "chat", sym, tf, model, result: { q, answer }, tokens_in: r.tin, tokens_out: r.tout });
    return json({ ok: true, left, limit, answer });
  } catch (e) {
    console.error("arom-llm error", String(e?.message || e));
    return json({ error: "server" }, 500);
  }
});
