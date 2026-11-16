// @ts-nocheck
// Supabase Edge Function: market-intelligence  (JWT required; Ultra members and admins)
// Deterministic technical analysis (no OpenAI) on candles from the market-data function: EMA 9/20/50/100/200, RSI 14, MACD, ATR 14, VWAP (only with real volume),
// swing structure (BOS / CHoCH), support / resistance zones, calculated liquidity observations, volatility, momentum, session and a multi-timeframe ladder.
//   POST { symbol, timeframe, variant? }  ->  the analysis object from engine.mjs   (variant "etf" for NAS100 gives the QQQ ETF proxy instead of the NQ futures)
// It calls market-data with the member's own token, so the same Ultra gate, shared cache and quota guard apply. Nothing here changes any data.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { analyse, LADDER } from "./engine.mjs";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const hits = new Map();         // 20 analyses a minute per member
const limited = (id) => { const now = Date.now(), a = (hits.get(id) || []).filter((t) => now - t < 60_000); a.push(now); hits.set(id, a); if (hits.size > 2000) hits.clear(); return a.length > 20; };

async function feed(symbol, timeframe, variant, auth) {
  try {
    const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 40_000);
    const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/market-data`, { method: "POST", signal: ctl.signal, headers: { "Content-Type": "application/json", Authorization: auth, apikey: Deno.env.get("SUPABASE_ANON_KEY") || "" }, body: JSON.stringify({ action: "candles", symbol, timeframe, limit: 260, variant }) });
    clearTimeout(to);
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !j.ok) return { error: (j && j.error) || "http_" + r.status };
    return { candles: j.candles, meta: j.meta, instrument: j.instrument };
  } catch (_) { return { error: "timeout_or_network" }; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = Deno.env.get("SUPABASE_URL"), anon = Deno.env.get("SUPABASE_ANON_KEY"), service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const auth = req.headers.get("Authorization") ?? "";
    const uc = createClient(url, anon, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await uc.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
    const db = createClient(url, service, { auth: { persistSession: false } });
    const { data: p } = await db.from("profiles").select("is_admin,ultra_until").eq("id", user.id).maybeSingle();
    if (!(p && (p.is_admin === true || (p.ultra_until && new Date(p.ultra_until) > new Date())))) return json({ error: "ultra_required" }, 403);
    const b = await req.json().catch(() => ({})), symbol = String(b.symbol || "").toUpperCase(), timeframe = String(b.timeframe || "M15").toUpperCase(), variant = b.variant === "etf" ? "etf" : "futures";
    if (!symbol || !/^[A-Z0-9]{2,10}$/.test(symbol)) return json({ error: "bad_symbol" }, 400);
    if (!LADDER[timeframe]) return json({ error: "unknown_timeframe", timeframes: Object.keys(LADDER) }, 400);
    if (limited(user.id)) return json({ error: "slow_down" }, 429);
    const tfs = [timeframe, ...LADDER[timeframe]], got = await Promise.all(tfs.map((tf) => feed(symbol, tf, variant, auth)));
    const feeds = {}; tfs.forEach((tf, i) => { feeds[tf] = got[i]; });
    // an unknown symbol / auth problem is the same for every timeframe: report it plainly instead of an empty analysis
    const first = feeds[timeframe]; if (first.error === "unknown_symbol") return json({ error: "unknown_symbol" }, 400); if (first.error === "ultra_required" || first.error === "unauthorized") return json({ error: first.error }, first.error === "unauthorized" ? 401 : 403);
    const instrument = first.instrument || got.find((g) => g.instrument)?.instrument || null;
    return json(analyse({ symbol, timeframe, instrument, feeds, now: Date.now() }));
  } catch (e) {
    console.error("market-intelligence:", String(e?.message ?? e));
    return json({ error: "server_error" }, 500);
  }
});
