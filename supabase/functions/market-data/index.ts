// @ts-nocheck
// Supabase Edge Function: market-data  (JWT required; Ultra members and admins; "health" is admin only)
// The ONE place AROM AI / Market Intelligence read prices from. Provider: SiftingIO (REST). Quota-aware because the free key is 10,000 calls a month,
// 5 requests a second: every answer goes through a shared cache table (market_cache), a monthly budget guard and a burst limiter.
//   POST { action: "quote",   symbol }                       -> { ok, quote, meta }
//   POST { action: "candles", symbol, timeframe, limit? }    -> { ok, instrument, candles, meta }     timeframe: M1 M5 M15 M30 H1 H4 D1  (H4 is built from H1)
//   POST { action: "candles", symbol, timeframe: "D1", history: true, limit? (up to 1000) } -> the same, with up to 1000 daily bars (own cache entry; used by arom-strategy)
//   POST { action: "health" }  (admin)                       -> { ok, providers: [...] }
// Rules: nothing is invented. Missing values stay null. When the quota guard or the provider fails, cached data is returned marked stale, else an error.
// Index symbols are NOT offered by SiftingIO. NAS100 defaults to the NQ futures from the site's own feed (Yahoo, DELAYED, labelled; M1 M5 M15 H1 H4 only); { variant: "etf" } gives the QQQ ETF proxy.
// US30, SPX500 and GER40 resolve to ETF proxies (DIA, SPY, EWG) and the answer says so (asset_class "etf", tracks "US30"). ETF prices are NOT index levels.
// Secret: SIFTINGIO_API_KEY. Optional: MARKET_QUOTA_RESERVE (default 800 calls kept for admin/diagnostics), MARKET_STALE_THRESHOLD (seconds, default 900).
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const BASE = "https://api.sifting.io/v1";
const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

// ---- symbols: internal name -> provider path. Unverified ones fail gracefully with "symbol_not_found".
const FX = ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF", "NZDUSD"];
const SYMBOLS: Record<string, any> = {
  XAUUSD: { cls: "metal", kind: "commodities", id: "XAUUSD", cur: "USD" }, XAGUSD: { cls: "metal", kind: "commodities", id: "XAGUSD", cur: "USD" },
  BTCUSD: { cls: "crypto", kind: "crypto", id: "BTCUSD", cur: "USD" }, ETHUSD: { cls: "crypto", kind: "crypto", id: "ETHUSD", cur: "USD" },
  NAS100: { cls: "etf", kind: "stocks", id: "QQQ", cur: "USD", tracks: "NAS100", fut: { site: "NQ", id: "NQ", name: "Nasdaq 100 E-mini futures (NQ=F)" } }, US30: { cls: "etf", kind: "stocks", id: "DIA", cur: "USD", tracks: "US30" },
  SPX500: { cls: "etf", kind: "stocks", id: "SPY", cur: "USD", tracks: "SPX500" }, GER40: { cls: "etf", kind: "stocks", id: "EWG", cur: "USD", tracks: "GER40" },
};
for (const p of FX) SYMBOLS[p] = { cls: "forex", kind: "forex", id: p, cur: p.slice(3) };
for (const e of (Deno.env.get("MARKET_EQUITIES") || "AAPL,MSFT,NVDA,TSLA,AMZN,GOOGL,META").split(",").map((x) => x.trim().toUpperCase()).filter(Boolean)) SYMBOLS[e] = { cls: "equity", kind: "stocks", id: e, cur: "USD" };

// Index futures come from the site's own feed (/api/candles: Yahoo Finance, delayed up to ~10 min). Only these timeframes exist there; H4 is built from H1, M30 from M15 is not offered.
const SITE_TF = { M1: "1", M5: "5", M15: "15", H1: "60", H4: "60" };
const SITE = () => (Deno.env.get("SITE_URL") || "https://aromx.trade").replace(/\/$/, "");

// ---- timeframes. ttl = how long a cached answer is reused (seconds). H4 is derived from H1.
const TF: Record<string, any> = {
  M1: { iv: "1m", sec: 60, ttl: 60 }, M5: { iv: "5m", sec: 300, ttl: 150 }, M15: { iv: "15m", sec: 900, ttl: 420 }, M30: { iv: "30m", sec: 1800, ttl: 900 },
  H1: { iv: "1h", sec: 3600, ttl: 1800 }, H4: { iv: "1h", sec: 14400, ttl: 1800, derive: true }, D1: { iv: "1d", sec: 86400, ttl: 7200 },
};
const STALE_S = () => Math.max(60, parseInt(Deno.env.get("MARKET_STALE_THRESHOLD") || "900", 10) || 900);
const RESERVE = () => Math.max(0, parseInt(Deno.env.get("MARKET_QUOTA_RESERVE") || "800", 10) || 800);

// ---- pure helpers (also unit-tested) ----
/** unix seconds / ms / µs / ns or ISO text -> epoch ms (null when unreadable) */
export function toMs(t) {
  if (t == null) return null;
  if (typeof t === "string" && !/^\d+(\.\d+)?$/.test(t.trim())) { const d = Date.parse(t); return Number.isFinite(d) ? d : null; }
  const n = Number(t); if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e11 ? n * 1000 : n < 1e14 ? n : n < 1e17 ? Math.round(n / 1e3) : Math.round(n / 1e6);
}
/** validate + normalise raw bars. Drops impossible candles, removes duplicates, sorts oldest first. */
export function normaliseBars(raw, symbol, timeframe, source, nowMs = Date.now()) {
  const sec = TF[timeframe].sec, seen = new Map(); let dropped = 0;
  for (const b of Array.isArray(raw) ? raw : []) {
    const ts = toMs(b.t ?? b.ts ?? b.timestamp ?? b.time), o = num(b.o ?? b.open), h = num(b.h ?? b.high), l = num(b.l ?? b.low), c = num(b.c ?? b.close), v = num(b.v ?? b.volume);
    if (ts == null || o == null || h == null || l == null || c == null || h < Math.max(o, c) || l > Math.min(o, c) || h < l || o <= 0 || c <= 0) { dropped++; continue; }
    if (seen.has(ts)) { dropped++; continue; }
    seen.set(ts, { symbol, timeframe, open: o, high: h, low: l, close: c, volume: v != null && v > 0 ? v : null, timestamp: new Date(ts).toISOString(), source, complete: ts + sec * 1000 <= nowMs });
  }
  return { candles: [...seen.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]), dropped };
}
/** H1 -> H4 on UTC 4-hour boundaries; a bucket is complete once its period has ended, even if the market was only open for part of it */
export function toH4(h1, symbol, source, nowMs = Date.now()) {
  const g = new Map();
  for (const c of h1) { const t = Date.parse(c.timestamp), k = Math.floor(t / 14400000) * 14400000; (g.get(k) || g.set(k, []).get(k)).push(c); }
  return [...g.entries()].sort((a, b) => a[0] - b[0]).map(([k, a]) => ({ symbol, timeframe: "H4", open: a[0].open, high: Math.max(...a.map((x) => x.high)), low: Math.min(...a.map((x) => x.low)), close: a[a.length - 1].close,
    volume: a.every((x) => x.volume != null) ? a.reduce((s, x) => s + x.volume, 0) : null, timestamp: new Date(k).toISOString(), source, complete: k + 14400000 <= nowMs }));   // complete = the 4-hour period has ended (a bucket with fewer than 4 bars is normal for stocks and around market closes)
}
export function normaliseQuote(q, sym, cfg, source, nowMs = Date.now()) {
  const d = q && (q.data || q), bid = num(d.b ?? d.bid), ask = num(d.a ?? d.ask), last = num(d.p ?? d.price ?? d.last), ts = toMs(d.t ?? d.ts ?? d.timestamp);
  const price = bid != null && ask != null && ask >= bid ? Math.round(((bid + ask) / 2) * 1e8) / 1e8 : last;
  const age = ts != null ? Math.max(0, Math.round((nowMs - ts) / 1000)) : null;
  return { symbol: cfg.id, requested: sym, tracks: cfg.tracks ?? null, asset_class: cfg.cls, price, bid, ask, change: null, change_percent: null, currency: cfg.cur, source, timestamp: ts != null ? new Date(ts).toISOString() : null,
    received_at: new Date(nowMs).toISOString(), is_delayed: null, is_stale: age == null ? null : age > STALE_S() };
}

// ---- provider call: serialised (5 requests a second allowed), records quota headers, retries once on 429 ----
let gate = Promise.resolve();
const pace = () => { const p = gate.then(() => new Promise((r) => setTimeout(r, 260))); gate = p; return p; };
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const today = () => new Date().toISOString().slice(0, 10);
async function health(patch, ok, errMsg) {
  try {
    const { data: h } = await db.from("integration_health").select("*").eq("provider", "siftingio").maybeSingle();
    const cur = h || { provider: "siftingio", calls_today: 0, errors_today: 0, calls_total: 0, errors_total: 0 }, d = today(), same = cur.calls_day === d;
    const row = { ...cur, ...patch, calls_day: d, calls_today: (same ? cur.calls_today : 0) + 1, errors_today: (same ? cur.errors_today : 0) + (ok ? 0 : 1), calls_total: (cur.calls_total || 0) + 1, errors_total: (cur.errors_total || 0) + (ok ? 0 : 1), status: ok ? "ok" : "error", updated_at: new Date().toISOString() };
    if (ok) row.last_success_at = new Date().toISOString(); else { row.last_error = String(errMsg || "").slice(0, 200); row.last_error_at = new Date().toISOString(); }
    await db.from("integration_health").upsert(row, { onConflict: "provider" });
  } catch (_) { /* health is best effort */ }
}
async function sift(path, key, attempt = 0) {
  await pace();
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(BASE + path, { headers: { "X-API-Key": key, Accept: "application/json", "User-Agent": "arom-market/1.0" }, signal: ctl.signal });
    const j = await r.json().catch(() => null), h = (n) => num(r.headers.get(n));
    const quota = { quota_limit: h("x-quota-limit"), quota_remaining: h("x-quota-remaining"), rate_limit: h("x-ratelimit-limit") };
    if (r.status === 429 && attempt < 3) { const w = Math.min(6, num(r.headers.get("retry-after")) || attempt + 1); await new Promise((res) => setTimeout(res, w * 1000)); return sift(path, key, attempt + 1); }   // up to 3 retries with a growing pause
    const ok = r.ok && j != null;
    await health(Object.fromEntries(Object.entries(quota).filter(([, v]) => v != null)), ok, ok ? "" : `HTTP ${r.status}`);
    return { status: r.status, j, quota };
  } catch (e) { await health({}, false, e && e.name === "AbortError" ? "timeout" : "network"); return { status: 0, j: null, quota: {} }; }
  finally { clearTimeout(to); }
}

// ---- budget guard: spread what is left of the month over the remaining days, keep a reserve ----
async function allowance() {
  const { data: h } = await db.from("integration_health").select("quota_remaining,calls_today,calls_day").eq("provider", "siftingio").maybeSingle();
  if (!h || h.quota_remaining == null) return { ok: true, remaining: null };
  const now = new Date(), dim = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate(), left = Math.max(1, dim - now.getUTCDate() + 1);
  const usable = h.quota_remaining - RESERVE(), perDay = Math.floor(usable / left), usedToday = h.calls_day === today() ? h.calls_today : 0;
  return { ok: usable > 0 && usedToday < Math.max(perDay, 20), remaining: h.quota_remaining, per_day: Math.max(perDay, 0), used_today: usedToday };
}

// ---- cache ----
async function cacheGet(key) { const { data } = await db.from("market_cache").select("payload,fetched_at").eq("key", key).maybeSingle(); return data || null; }
async function cachePut(key, payload) { await db.from("market_cache").upsert({ key, payload, fetched_at: new Date().toISOString() }, { onConflict: "key" }); }
const ageS = (iso) => Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));

async function getFuturesCandles(sym, tf, limit) {
  const cfg = SYMBOLS[sym], T = TF[tf], ck = `c:fut:${cfg.fut.id}:${tf}`, hit = await cacheGet(ck);
  if (hit && ageS(hit.fetched_at) < T.ttl) return { payload: hit.payload, from_cache: true, stale: false, fetched_at: hit.fetched_at };
  const old = (why) => (hit ? { payload: hit.payload, from_cache: true, stale: true, fetched_at: hit.fetched_at, why } : { error: why });
  if (!SITE_TF[tf]) return { error: "timeframe_unavailable" };
  try {
    const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 15000);
    const r = await fetch(`${SITE()}/api/candles?symbol=${cfg.fut.site}&tf=${SITE_TF[tf]}`, { signal: ctl.signal, headers: { "User-Agent": "arom-market/1.0" } }); clearTimeout(to);
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !Array.isArray(j.candles)) return old("provider_error");
    const raw = j.candles.map((c) => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v })), source = "yahoo_futures";
    let { candles, dropped } = normaliseBars(raw, cfg.fut.id, T.derive ? "H1" : tf, source);
    if (T.derive) candles = toH4(candles, cfg.fut.id, source);
    if (!candles.length) return old("no_data");
    const payload = { candles: candles.slice(-Math.max(limit, 50)), dropped, derived: !!T.derive, truncated: false, source, delayed: true, feed: j.source || null };
    await cachePut(ck, payload);
    return { payload, from_cache: false, stale: false, fetched_at: new Date().toISOString() };
  } catch (_) { return old("provider_error"); }
}
async function getCandles(sym, tf, limit, key, hist = false) {
  const cfg = SYMBOLS[sym], T = TF[tf], ck = `c:${cfg.id}:${tf}${hist ? ":h" : ""}`, hit = await cacheGet(ck);   // hist = long daily history for the strategy lab: its own cache entry so a short request never shrinks it
  if (hit && ageS(hit.fetched_at) < T.ttl) return { payload: hit.payload, from_cache: true, stale: false, fetched_at: hit.fetched_at };
  const al = await allowance(), source = "siftingio";
  const serveOld = (why) => (hit ? { payload: hit.payload, from_cache: true, stale: true, fetched_at: hit.fetched_at, why } : { error: why });
  if (!al.ok) return serveOld("quota_guard");
  // window: enough bars for `limit` plus weekends/closures. The provider returns the OLDEST bars first and stops at `limit`, so the page size must be
  // at least the number of bars the whole window can hold, otherwise the newest bars are cut off. One request = one call.
  const need = Math.min(1000, Math.max(60, limit) * (T.derive ? 4 : 1)), barSec = T.derive ? 3600 : T.sec;
  const factor = cfg.cls === "crypto" ? 1.15 : cfg.cls === "etf" || cfg.cls === "equity" ? 6.5 : 1.8;   // forex/metals ~24x5, stocks ~6.5 h a day
  const cap = 1990;                                                                                         // provider page maximum is 2000
  const span = Math.ceil(Math.min(need * barSec * factor, cap * barSec * 0.99)), pageSize = Math.min(2000, Math.ceil(span / barSec) + 10);
  const end = new Date(), start = new Date(Date.now() - span * 1000);
  const r = await sift(`/hist/${cfg.kind}/${encodeURIComponent(cfg.id)}/bars?start=${start.toISOString()}&end=${end.toISOString()}&interval=${T.iv}&limit=${pageSize}`, key);
  if (r.status === 404) return serveOld("symbol_not_found");
  if (r.status === 401 || r.status === 403) return serveOld("provider_auth");
  if (r.status === 429) return serveOld("rate_limited");
  const raw = r.j && (r.j.data || r.j.bars), arr = Array.isArray(raw) ? raw : raw && Array.isArray(raw.bars) ? raw.bars : null;
  if (r.status !== 200 || !arr) return serveOld("provider_error");
  let { candles, dropped } = normaliseBars(arr, cfg.id, T.derive ? "H1" : tf, source);
  if (T.derive) candles = toH4(candles, cfg.id, source);
  if (!candles.length) return serveOld("no_data");
  const truncated = arr.length >= pageSize;   // the page was full: the newest bars may be missing
  const payload = { candles: candles.slice(-Math.max(limit, 50)), dropped, derived: !!T.derive, truncated, source };
  await cachePut(ck, payload);
  return { payload, from_cache: false, stale: false, fetched_at: new Date().toISOString() };
}
async function getQuote(sym, key) {
  const cfg = SYMBOLS[sym], ck = `q:${cfg.id}`, hit = await cacheGet(ck);
  if (hit && ageS(hit.fetched_at) < 45) return { payload: hit.payload, from_cache: true, stale: false, fetched_at: hit.fetched_at };
  const al = await allowance();
  const old = (why) => (hit ? { payload: hit.payload, from_cache: true, stale: true, fetched_at: hit.fetched_at, why } : { error: why });
  if (!al.ok) return old("quota_guard");
  const r = await sift(`/last/quote/${cfg.kind}/${encodeURIComponent(cfg.id)}`, key);
  if (r.status !== 200 || !r.j) return old(r.status === 404 ? "symbol_not_found" : r.status === 429 ? "rate_limited" : "provider_error");
  const q = normaliseQuote(r.j, sym, cfg, "siftingio");
  if (q.price == null) return old("no_data");
  await cachePut(ck, q);
  return { payload: q, from_cache: false, stale: false, fetched_at: new Date().toISOString() };
}

const hitsMap = new Map();      // 30 requests a minute per member
const limited = (id) => { const now = Date.now(), a = (hitsMap.get(id) || []).filter((t) => now - t < 60_000); a.push(now); hitsMap.set(id, a); if (hitsMap.size > 2000) hitsMap.clear(); return a.length > 30; };

export async function handler(req) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = Deno.env.get("SUPABASE_URL"), anon = Deno.env.get("SUPABASE_ANON_KEY");
    const uc = createClient(url, anon, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: { user } } = await uc.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
    const { data: p } = await db.from("profiles").select("is_admin,ultra_until").eq("id", user.id).maybeSingle();
    const admin = !!p && p.is_admin === true, ultra = admin || (!!p && !!p.ultra_until && new Date(p.ultra_until) > new Date());
    if (!ultra) return json({ error: "ultra_required" }, 403);
    const b = await req.json().catch(() => ({})), action = String(b.action || "");
    if (action === "health") {
      if (!admin) return json({ error: "admin_only" }, 403);
      const { data } = await db.from("integration_health").select("*");
      return json({ ok: true, providers: (data || []).map((h) => ({ ...h, stale_threshold_s: STALE_S(), reserve: RESERVE() })), configured: { siftingio: !!Deno.env.get("SIFTINGIO_API_KEY") } });
    }
    if (limited(user.id)) return json({ error: "slow_down" }, 429);
    const key = Deno.env.get("SIFTINGIO_API_KEY"); if (!key) return json({ error: "not_configured" }, 503);
    const sym = String(b.symbol || "").toUpperCase(); if (!SYMBOLS[sym]) return json({ error: "unknown_symbol", symbols: Object.keys(SYMBOLS) }, 400);
    const cfg = SYMBOLS[sym], fut = !!cfg.fut && String(b.variant || "futures") !== "etf";      // NAS100: futures (default) or the QQQ ETF proxy
    const inst = fut ? { requested: sym, symbol: cfg.fut.id, asset_class: "futures", tracks: null, is_proxy: false, currency: "USD", description: cfg.fut.name, delayed: true }
      : { requested: sym, symbol: cfg.id, asset_class: cfg.cls, tracks: cfg.tracks ?? null, is_proxy: cfg.cls === "etf", currency: cfg.cur };
    if (action === "quote") {
      if (fut) {   // no quote feed for the futures: the price is the last M5 candle close and says so
        const f = await getFuturesCandles(sym, "M5", 60); if (f.error) return json({ error: f.error }, 502);
        const c = f.payload.candles[f.payload.candles.length - 1];
        return json({ ok: true, quote: { symbol: cfg.fut.id, requested: sym, tracks: null, asset_class: "futures", price: c.close, bid: null, ask: null, change: null, change_percent: null, currency: "USD", source: "yahoo_futures", timestamp: c.timestamp, received_at: new Date().toISOString(), is_delayed: true, is_stale: ageS(c.timestamp) > STALE_S(), price_basis: "last_m5_candle_close" }, meta: { from_cache: f.from_cache, fetched_at: f.fetched_at, served_stale: f.stale, reason: f.why ?? null } });
      }
      const r = await getQuote(sym, key); if (r.error) return json({ error: r.error }, r.error === "symbol_not_found" ? 404 : 502);
      const q = { ...r.payload, is_stale: r.stale || r.payload.is_stale || (ageS(r.payload.received_at) > STALE_S()) };
      return json({ ok: true, quote: q, meta: { from_cache: r.from_cache, fetched_at: r.fetched_at, served_stale: r.stale, reason: r.why ?? null } });
    }
    if (action === "candles") {
      const tf = String(b.timeframe || "M15").toUpperCase(); if (!TF[tf]) return json({ error: "unknown_timeframe", timeframes: Object.keys(TF) }, 400);
      const hist = b.history === true && tf === "D1" && !fut;   // opt-in: up to 1000 daily bars (about 3 to 4 years); everything else keeps the 500-bar cap
      const limit = Math.min(hist ? 1000 : 500, Math.max(20, parseInt(b.limit, 10) || 200));
      const r = fut ? await getFuturesCandles(sym, tf, limit) : await getCandles(sym, tf, limit, key, hist); if (r.error) return json({ error: r.error }, r.error === "symbol_not_found" ? 404 : 502);
      const c = r.payload.candles.slice(-limit), last = c[c.length - 1], age = last ? Math.round((Date.now() - Date.parse(last.timestamp)) / 1000) : null;
      return json({ ok: true, instrument: inst, timeframe: tf, candles: c, meta: { from_cache: r.from_cache, fetched_at: r.fetched_at, served_stale: r.stale, reason: r.why ?? null, count: c.length, dropped_invalid: r.payload.dropped, derived: r.payload.derived, truncated: !!r.payload.truncated,
        last_candle_at: last ? last.timestamp : null, last_candle_age_s: age, last_candle_complete: last ? last.complete : null, source: r.payload.source || "siftingio", is_delayed: r.payload.delayed === true ? true : null, enough_for_indicators: c.length >= 200 } });
    }
    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    console.error("market-data:", String(e?.message ?? e));
    return json({ error: "server_error" }, 500);
  }
}
Deno.serve(handler);
