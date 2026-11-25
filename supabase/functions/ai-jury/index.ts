// @ts-nocheck
// Supabase Edge Function: ai-jury (SHADOW research, never posts anything)
// Every minute (pg_cron, header x-cron-key) → takes the newest signals that have not been judged yet and asks several language models, through ONE
// OpenAI-compatible gateway (Vercel AI Gateway or OpenRouter), whether to take the trade. The signal's own candles (feat.ctx, saved by ai-telegram at
// signal time) are all they see: no outcome, no future candle. Votes go to public.ai_signal_votes; compare them with the results in ai_jury_report.
// Nothing here changes what members receive. A model only becomes a filter after its "take" signals beat its "skip" signals over enough closed trades.
//
// Secrets (Supabase → Edge Functions → Secrets):  JURY_API_KEY (gateway key)  ·  JURY_BASE_URL (default https://ai-gateway.vercel.sh/v1)
// ai_bot_config keys: jury_on = on|off (default off) · jury_models = comma list of gateway model ids · jury_modes = modes to judge · jury_batch = signals per run (default 4)
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
function safeEqual(a, b) { const x = new TextEncoder().encode(String(a)), y = new TextEncoder().encode(String(b)); let d = x.length ^ y.length; for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0); return d === 0; }
const BASE = (Deno.env.get("JURY_BASE_URL") || "https://ai-gateway.vercel.sh/v1").replace(/\/$/, "");
const KEY = (Deno.env.get("JURY_API_KEY") || "").trim();
const DEFAULT_MODES = "btcx,swing_v2,intraday_v2,swing_brt,scalp,intraday,swing";

const SYSTEM = `You are a strict risk reviewer for a trading-signal service. A rule-based engine produced the trade below. Decide whether a careful trader should TAKE it or SKIP it.
Judge only from the data given: the trade plan, the engine's features, and the last candles up to the signal bar. Do not assume anything about news or the future.
Be sceptical: most setups lose. Say "skip" when the stop is too tight or too wide for the recent range, when price is stretched into a nearby obstacle, when the trend or structure disagrees with the side, or when the candles look like chop.
Answer with ONE JSON object and nothing else: {"verdict":"take"|"skip","confidence":0-100,"reason":"max 25 words","risks":"max 20 words"}`;

function describe(sig) {
  const f = sig.feat || {}, ctx = f.ctx, { ctx: _c, ...feat } = f;
  const bars = ctx && Array.isArray(ctx.bars) ? ctx.bars : [];
  const tf = ctx ? ctx.tf / 60 : "?";
  const lines = bars.map((b) => `${new Date(b[0] * 1000).toISOString().slice(5, 16)} O${b[1]} H${b[2]} L${b[3]} C${b[4]}`).join("\n");
  const rr = (sig.tp1 && sig.risk) ? (Math.abs(sig.tp1 - sig.entry) / sig.risk).toFixed(2) : "?";
  return `Market: ${sig.symbol} · engine mode: ${sig.mode} · timeframe: ${tf} min\nSide: ${sig.side.toUpperCase()} at ${sig.entry} · stop ${sig.sl} (risk ${sig.risk}) · TP1 ${sig.tp1} (${rr}R) · TP2 ${sig.tp2}${sig.tp3 ? " · TP3 " + sig.tp3 : ""}\nTrigger: ${sig.trigger}\nEngine features: ${JSON.stringify(feat).slice(0, 900)}\nLast ${bars.length} candles (UTC, oldest first):\n${lines}`;
}

function parse(txt) {
  const m = String(txt || "").match(/\{[\s\S]*\}/); if (!m) return null;
  try { const j = JSON.parse(m[0]); const v = String(j.verdict || "").toLowerCase(); if (v !== "take" && v !== "skip") return null;
    return { verdict: v, confidence: Math.max(0, Math.min(100, Math.round(Number(j.confidence) || 0))), reason: String(j.reason || "").slice(0, 300), risks: String(j.risks || "").slice(0, 300) }; }
  catch (_) { return null; }
}

async function ask(model, prompt) {
  const t0 = Date.now();
  try {
    const r = await fetch(BASE + "/chat/completions", {
      method: "POST", signal: AbortSignal.timeout(40000),
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, temperature: 0, max_tokens: 1500, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }] }),
    });
    const j = await r.json().catch(() => null), ms = Date.now() - t0;
    if (!r.ok) return { verdict: "error", reason: `http ${r.status} ${String(j?.error?.message || j?.error || "").slice(0, 120)}`, ms };
    const out = parse(j?.choices?.[0]?.message?.content);
    const u = j?.usage || {};
    return out ? { ...out, ms, tokens_in: u.prompt_tokens ?? null, tokens_out: u.completion_tokens ?? null } : { verdict: "error", reason: "unparseable answer", ms };
  } catch (e) { return { verdict: "error", reason: String(e?.message || e).slice(0, 120), ms: Date.now() - t0 }; }
}

Deno.serve(async (req) => {
  const { data: rows } = await db.from("ai_bot_config").select("key,value");
  const cfg = Object.fromEntries((rows || []).map((r) => [r.key, r.value]));
  const key = req.headers.get("x-cron-key") || "";
  if (!cfg.cron_secret || !safeEqual(key, cfg.cron_secret)) return json({ error: "unauthorized" }, 401);
  const url = new URL(req.url);
  if (url.searchParams.get("models") === "1") {   // lists the model ids the gateway offers (to pick exact ids for jury_models)
    const r = await fetch(BASE + "/models", { headers: { Authorization: `Bearer ${KEY}` } }); const j = await r.json().catch(() => null);
    return json({ status: r.status, models: (j?.data || []).map((m) => m.id) });
  }
  if (url.searchParams.get("test") === "1") {   // one invented signal to every model in jury_models: checks the key, the ids and the answer format. Writes nothing.
    const ms = String(cfg.jury_models || "").split(",").map((x) => x.trim()).filter(Boolean);
    const bars = Array.from({ length: 40 }, (_, i) => { const c = 2300 + Math.sin(i / 4) * 6 + i * .3; return [1795500000 + i * 900, +(c - 1).toFixed(2), +(c + 2).toFixed(2), +(c - 2).toFixed(2), +c.toFixed(2)]; });
    const p = describe({ symbol: "XAUUSD", mode: "test", side: "buy", entry: 2312, sl: 2306, tp1: 2321, tp2: 2330, tp3: null, risk: 6, trigger: "engulf", feat: { ctx: { tf: 900, bars } } });
    const res = await Promise.all(ms.map(async (m) => ({ model: m, ...(await ask(m, p)) })));
    return json({ ok: true, test: res });
  }
  if (cfg.jury_on !== "on") return json({ ok: true, skipped: "jury_on is off" });
  if (!KEY) return json({ ok: false, error: "JURY_API_KEY is not set" }, 500);
  const models = String(cfg.jury_models || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!models.length) return json({ ok: false, error: "jury_models is empty" }, 500);
  const modes = String(cfg.jury_modes || DEFAULT_MODES).split(",").map((s) => s.trim()).filter(Boolean);
  const batch = Math.max(1, Math.min(10, Number(cfg.jury_batch) || 4));

  // newest signals of the chosen modes from the last 6 hours that still lack a vote from at least one model
  const since = new Date(Date.now() - 6 * 3600_000).toISOString();
  const { data: sigs } = await db.from("ai_signals").select("*").in("mode", modes).gt("created_at", since).not("feat->ctx", "is", null).order("created_at", { ascending: false }).limit(60);
  const ids = (sigs || []).map((s) => s.id);
  const { data: have } = ids.length ? await db.from("ai_signal_votes").select("signal_id,model").in("signal_id", ids) : { data: [] };
  const done = new Set((have || []).map((v) => v.signal_id + "|" + v.model));
  const todo = [];
  for (const s of sigs || []) { const miss = models.filter((m) => !done.has(s.id + "|" + m)); if (miss.length) todo.push({ s, miss }); if (todo.length >= batch) break; }

  const out = [];
  for (const { s, miss } of todo) {
    const prompt = describe(s);
    const res = await Promise.all(miss.map(async (m) => ({ m, v: await ask(m, prompt) })));
    const ins = res.map(({ m, v }) => ({ signal_id: s.id, model: m, verdict: v.verdict, confidence: v.confidence ?? null, reason: v.reason ?? null, risks: v.risks ?? null, ms: v.ms ?? null, tokens_in: v.tokens_in ?? null, tokens_out: v.tokens_out ?? null }));
    const { error } = await db.from("ai_signal_votes").upsert(ins, { onConflict: "signal_id,model", ignoreDuplicates: true });
    out.push({ id: s.id, mode: s.mode, symbol: s.symbol, votes: res.map(({ m, v }) => m + ":" + v.verdict), err: error?.message });
  }
  return json({ ok: true, judged: out.length, out });
});
