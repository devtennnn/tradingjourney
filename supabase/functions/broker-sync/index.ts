// @ts-nocheck
// Supabase Edge Function: broker-sync  (verify_jwt OFF: the EA has no Supabase session; both callers are checked here)
// Ultra feature. MT5 / MT4 accounts push their balance, open positions and closed trades through the AROM Sync EA (read-only: it never trades).
//  - EA:   POST with header "X-AROM-Token: arom_..." and JSON { v, account{...}, positions[...], deals[...] }  -> { ok, ack, imported }
//  - Site: POST with the member's JWT { action: "create", label? } -> { ok, token (shown once), account }
//          { action: "list" } -> { ok, accounts[] } · { action: "detail", id } -> { ok, account, positions, deals, stats, equity }
//          { action: "update", id, label?, auto_import? } · { action: "remove", id }
// The plain sync code is never stored (only SHA-256). One code is bound to the first MT login that uses it.
// Closed trades are copied into the member's journal (public.trades) when auto_import is on. Imported journal rows are kept if the account is removed.
// Phone-only members (no PC / VPS for the EA): { action: "connect_metaapi", platform, login, server, password, label? }
//   The INVESTOR (read-only) password goes straight to MetaApi (cloud MT terminal, secret METAAPI_TOKEN) and is never stored or logged here.
//   Cron every 2 min: GET ?run=poll&key=<ai_bot_config.cron_secret> reads each MetaApi account and feeds the same ingest() as the EA.
//   Ultra lapses -> the MetaApi account is undeployed (stops billing); Ultra back -> redeployed. Remove -> deleted at MetaApi.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { parsePayload, journalRow, stats, newToken, hashToken, validToken, MAX_ACCOUNTS, MA_MAX, maForm, maPayload, maStatus } from "./lib.mjs";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-arom-token", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const PUBLIC = "id,label,platform,token_hint,login,server,company,currency,leverage,balance,equity,margin,free_margin,floating,auto_import,ea_version,last_sync_at,created_at,source,ma_state,ma_error";
const isUltra = (p) => !!p && (p.is_admin === true || (!!p.ultra_until && new Date(p.ultra_until) > new Date()));
const clip = (s, n) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, n);

async function fromEA(req, token) {
  if (!validToken(token)) return json({ error: "bad_token" }, 401);
  const raw = await req.text(); if (raw.length > 600_000) return json({ error: "too_large" }, 413);
  let b; try { b = JSON.parse(raw); } catch { return json({ error: "bad_payload" }, 400); }
  const { data: acc } = await db.from("broker_accounts").select("*").eq("token_hash", await hashToken(token)).maybeSingle();
  if (!acc) return json({ error: "unknown_token" }, 401);
  const { data: prof } = await db.from("profiles").select("is_admin,ultra_until").eq("id", acc.user_id).maybeSingle();
  if (!isUltra(prof)) return json({ error: "ultra_required" }, 403);
  if (acc.last_sync_at && Date.now() - Date.parse(acc.last_sync_at) < 15_000) return json({ error: "slow_down", ack: acc.last_deal_at || 0 }, 429);
  const p = parsePayload(b); if (p.error) return json({ error: p.error }, 400);
  if (acc.login && (acc.login !== p.account.login || (acc.server && p.account.server && acc.server !== p.account.server))) return json({ error: "account_mismatch" }, 409);
  return json(await ingest(acc, p));
}

/** One sync (EA or MetaApi): account numbers, open positions, new closed trades (+ journal), equity point. */
async function ingest(acc, p) {
  const a = p.account, now = new Date().toISOString();
  // account + open positions (replaced each sync: the EA always sends the full list)
  await db.from("broker_accounts").update({ login: a.login, server: a.server, company: a.company, currency: a.currency, leverage: a.leverage, balance: a.balance, equity: a.equity,
    margin: a.margin, free_margin: a.free_margin, floating: a.floating, platform: a.platform, ea_version: a.ea_version, last_sync_at: now }).eq("id", acc.id);
  await db.from("broker_positions").delete().eq("account_id", acc.id);
  if (p.positions.length) await db.from("broker_positions").insert(p.positions.map((x) => ({ ...x, account_id: acc.id })));
  // closed trades: only new ones are inserted (position id is unique per account); new ones go to the journal
  let imported = 0, ack = Number(acc.last_deal_at) || 0;
  if (p.deals.length) {
    const { data: fresh } = await db.from("broker_deals").upsert(p.deals.map((d) => ({ ...d, account_id: acc.id })), { onConflict: "account_id,position_id", ignoreDuplicates: true }).select("position_id");
    const ids = new Set((fresh || []).map((r) => Number(r.position_id)));
    if (acc.auto_import && ids.size) {
      const label = acc.label || (a.platform.toUpperCase() + " " + a.login);
      for (const d of p.deals.filter((x) => ids.has(x.position_id))) {
        const { data: tr } = await db.from("trades").insert(journalRow(d, acc.user_id, label, a.platform)).select("id").single();
        if (tr) { imported++; await db.from("broker_deals").update({ trade_id: tr.id }).eq("account_id", acc.id).eq("position_id", d.position_id); }
      }
    }
    ack = Math.max(ack, ...p.deals.map((d) => d.close_time));
    await db.from("broker_accounts").update({ last_deal_at: ack }).eq("id", acc.id);
  }
  // equity curve: at most one point per 10 minutes
  const { data: last } = await db.from("broker_snapshots").select("at").eq("account_id", acc.id).order("at", { ascending: false }).limit(1).maybeSingle();
  if (!last || Date.now() - Date.parse(last.at) > 600_000) await db.from("broker_snapshots").insert({ account_id: acc.id, balance: a.balance, equity: a.equity });
  return { ok: true, ack, imported, positions: p.positions.length };
}

// ---- MetaApi ----
const MA_TOKEN = () => Deno.env.get("METAAPI_TOKEN") || "";
const MA_PROV = "https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai";
const maClient = (region) => `https://mt-client-api-v1.${/^[a-z-]{2,30}$/.test(region || "") ? region : "new-york"}.agiliumtrade.ai`;
async function ma(method, url, body, extra = {}) {
  const r = await fetch(url, { method, headers: { "auth-token": MA_TOKEN(), "Content-Type": "application/json", Accept: "application/json", ...extra }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) });
  const txt = await r.text(); let j = null; try { j = txt ? JSON.parse(txt) : null; } catch { /* not json */ }
  return { status: r.status, ok: r.ok, j, retry: Number(r.headers.get("retry-after")) || 0 };
}
const maErr = (r) => clip((r.j && (r.j.message || r.j.error)) || "MetaApi " + r.status, 160);
async function maCreate(f, name) {
  const tx = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  const body = { name, type: "cloud-g2", login: f.login, password: f.password, server: f.server, platform: f.platform, magic: 0 };
  for (let i = 0; i < 4; i++) {   // 202 = MetaApi is still looking up the broker server: retry with the same transaction id
    const r = await ma("POST", MA_PROV + "/users/current/accounts", body, { "transaction-id": tx });
    if (r.status !== 202) return r;
    await new Promise((ok) => setTimeout(ok, Math.min(8, Math.max(2, r.retry || 3)) * 1000));
  }
  return { status: 202, ok: false, j: { message: "busy" } };
}

async function pollMetaApi() {
  const { data: rows } = await db.from("broker_accounts").select("*").eq("source", "metaapi").not("ma_id", "is", null).limit(100);
  if (!rows || !rows.length) return { ok: true, accounts: 0 };
  if (!MA_TOKEN()) return { ok: false, error: "metaapi_not_configured" };
  let synced = 0;
  for (const acc of rows) {
    try {
      const { data: prof } = await db.from("profiles").select("is_admin,ultra_until").eq("id", acc.user_id).maybeSingle();
      const base = MA_PROV + "/users/current/accounts/" + encodeURIComponent(acc.ma_id);
      if (!isUltra(prof)) {   // Ultra ended: stop the cloud terminal so it stops costing money; data stays visible
        if (acc.ma_state !== "paused") { await ma("POST", base + "/undeploy"); await db.from("broker_accounts").update({ ma_state: "paused" }).eq("id", acc.id); }
        continue;
      }
      const st = await ma("GET", base);
      if (st.status === 404) { await db.from("broker_accounts").update({ ma_state: "failed", ma_error: "MetaApi account not found" }).eq("id", acc.id); continue; }
      if (!st.ok) continue;
      const state = maStatus(st.j);
      if (state === "paused") { await ma("POST", base + "/deploy"); await db.from("broker_accounts").update({ ma_state: "connecting", ma_error: null }).eq("id", acc.id); continue; }
      if (state !== "live") { await db.from("broker_accounts").update({ ma_state: state, ma_region: st.j.region || acc.ma_region, ma_error: state === "connecting" ? null : clip(st.j.connectionStatus || st.j.state, 60) }).eq("id", acc.id); continue; }
      const cl = maClient(st.j.region || acc.ma_region) + "/users/current/accounts/" + encodeURIComponent(acc.ma_id);
      const to = new Date(Date.now() + 3600_000).toISOString(), from = new Date(((Number(acc.last_deal_at) || Math.floor(Date.now() / 1000) - 30 * 86400) - 2 * 86400) * 1000).toISOString();
      const [info, pos, deals] = await Promise.all([ma("GET", cl + "/account-information"), ma("GET", cl + "/positions"), ma("GET", cl + `/history-deals/time/${from}/${to}`)]);
      if (!info.ok || !pos.ok || !deals.ok) { await db.from("broker_accounts").update({ ma_state: "connecting", ma_error: maErr(!info.ok ? info : !pos.ok ? pos : deals) }).eq("id", acc.id); continue; }
      const p = parsePayload(maPayload(info.j, pos.j, Array.isArray(deals.j) ? deals.j : (deals.j && deals.j.deals) || [], acc));
      if (p.error) { await db.from("broker_accounts").update({ ma_error: "unreadable account data" }).eq("id", acc.id); continue; }
      p.account.ea_version = "metaapi";
      await ingest(acc, p);
      await db.from("broker_accounts").update({ ma_state: "live", ma_error: null, ma_region: st.j.region || acc.ma_region }).eq("id", acc.id);
      synced++;
    } catch (e) { console.error("broker-sync poll:", acc.id, String(e?.message ?? e).slice(0, 160)); }
  }
  return { ok: true, accounts: rows.length, synced };
}
async function cronKey() { const { data } = await db.from("ai_bot_config").select("value").eq("key", "cron_secret").maybeSingle(); return (data && data.value) || ""; }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = new URL(req.url);
    if (url.searchParams.get("run") === "poll") {
      const key = await cronKey();
      if (!key || url.searchParams.get("key") !== key) return json({ error: "unauthorized" }, 401);
      return json(await pollMetaApi());
    }
    if (req.method !== "POST") return json({ error: "method" }, 405);
    const token = req.headers.get("x-arom-token");
    if (token) return await fromEA(req, token.trim());
    // ---- website (member JWT) ----
    const uc = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_ANON_KEY"), { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: { user } } = await uc.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
    const { data: prof } = await db.from("profiles").select("is_admin,ultra_until").eq("id", user.id).maybeSingle();
    const b = await req.json().catch(() => ({})), action = String(b.action || "");
    const own = async (id) => { const { data } = await db.from("broker_accounts").select(PUBLIC + ",user_id").eq("id", String(id || "")).maybeSingle(); return data && data.user_id === user.id ? data : null; };
    if (action === "list") {   // allowed after Ultra ends so members can still see / remove what they connected
      const { data } = await db.from("broker_accounts").select(PUBLIC).eq("user_id", user.id).order("created_at");
      return json({ ok: true, ultra: isUltra(prof), metaapi: !!MA_TOKEN(), accounts: data || [] });
    }
    if (action === "remove") {
      const a = await own(b.id); if (!a) return json({ error: "not_found" }, 404);
      if (a.source === "metaapi") {   // delete the cloud terminal first so it stops billing
        const { data: m } = await db.from("broker_accounts").select("ma_id").eq("id", a.id).single();
        if (m && m.ma_id && MA_TOKEN()) { const r = await ma("DELETE", MA_PROV + "/users/current/accounts/" + encodeURIComponent(m.ma_id)); if (!r.ok && r.status !== 404) return json({ error: "metaapi_error" }, 502); }
      }
      await db.from("broker_accounts").delete().eq("id", a.id);
      return json({ ok: true });
    }
    if (!isUltra(prof)) return json({ error: "ultra_required" }, 403);
    if (action === "create") {
      const { count } = await db.from("broker_accounts").select("id", { count: "exact", head: true }).eq("user_id", user.id);
      if ((count || 0) >= MAX_ACCOUNTS) return json({ error: "too_many_accounts", limit: MAX_ACCOUNTS }, 409);
      const token = newToken(crypto.getRandomValues(new Uint8Array(20)));
      const label = clip(b.label, 30) || "MT5";
      const { data, error } = await db.from("broker_accounts").insert({ user_id: user.id, label, token_hash: await hashToken(token), token_hint: token.slice(-4) }).select(PUBLIC).single();
      if (error) return json({ error: "server_error" }, 500);
      return json({ ok: true, token, account: data });
    }
    if (action === "connect_metaapi") {
      if (!MA_TOKEN()) return json({ error: "metaapi_not_configured" }, 503);
      const f = maForm(b); if (f.error) return json({ error: f.error }, 400);
      const { data: mine } = await db.from("broker_accounts").select("source,login,server").eq("user_id", user.id);
      if ((mine || []).length >= MAX_ACCOUNTS) return json({ error: "too_many_accounts", limit: MAX_ACCOUNTS }, 409);
      if ((mine || []).filter((x) => x.source === "metaapi").length >= MA_MAX) return json({ error: "too_many_phone", limit: MA_MAX }, 409);
      if ((mine || []).some((x) => x.login === f.login && x.server === f.server)) return json({ error: "already_connected" }, 409);
      const r = await maCreate(f, "arom-" + user.id.slice(0, 8) + "-" + f.login);
      f.password = "";
      if (!r.ok || !r.j || !r.j.id) {
        const m = maErr(r); console.error("broker-sync connect:", r.status, m);
        return json({ error: /password|credential|auth/i.test(m) ? "bad_password" : /server/i.test(m) ? "bad_server" : r.status === 202 ? "metaapi_busy" : "metaapi_error", detail: m }, r.status >= 500 ? 502 : 400);
      }
      await ma("POST", MA_PROV + "/users/current/accounts/" + encodeURIComponent(r.j.id) + "/deploy");
      const hidden = newToken(crypto.getRandomValues(new Uint8Array(20)));   // never shown: MetaApi accounts sync from our side, not with a code
      const { data, error } = await db.from("broker_accounts").insert({ user_id: user.id, label: f.label, platform: f.platform, login: f.login, server: f.server, token_hash: await hashToken(hidden), token_hint: "cloud",
        source: "metaapi", ma_id: r.j.id, ma_state: "connecting" }).select(PUBLIC).single();
      if (error) { await ma("DELETE", MA_PROV + "/users/current/accounts/" + encodeURIComponent(r.j.id)); return json({ error: "server_error" }, 500); }
      return json({ ok: true, account: data });
    }
    if (action === "update") {
      const a = await own(b.id); if (!a) return json({ error: "not_found" }, 404);
      const patch = {}; if (b.label != null) patch.label = clip(b.label, 30) || a.label; if (typeof b.auto_import === "boolean") patch.auto_import = b.auto_import;
      const { data } = await db.from("broker_accounts").update(patch).eq("id", a.id).select(PUBLIC).single();
      return json({ ok: true, account: data });
    }
    if (action === "detail") {
      const a = await own(b.id); if (!a) return json({ error: "not_found" }, 404);
      const since = Math.floor(Date.now() / 1000) - 90 * 86400;
      const [pos, deals, snaps] = await Promise.all([
        db.from("broker_positions").select("ticket,symbol,side,volume,open_price,open_time,sl,tp,price,profit,swap").eq("account_id", a.id).order("open_time", { ascending: false }),
        db.from("broker_deals").select("position_id,symbol,side,volume,open_time,close_time,open_price,close_price,profit,commission,swap,net").eq("account_id", a.id).gte("close_time", since).order("close_time", { ascending: false }).limit(1000),
        db.from("broker_snapshots").select("at,balance,equity").eq("account_id", a.id).gte("at", new Date(since * 1000).toISOString()).order("at").limit(2000),
      ]);
      const d = deals.data || []; delete a.user_id;
      return json({ ok: true, account: a, positions: pos.data || [], deals: d.slice(0, 50), stats: stats(d), equity: snaps.data || [] });
    }
    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    console.error("broker-sync:", String(e?.message ?? e).slice(0, 200));
    return json({ error: "server_error" }, 500);
  }
});
