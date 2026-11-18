// AROM Broker Sync: pure helpers (no network, no Deno APIs) so they can be unit-tested in Node.
// The AROM Sync EA (MT5 / MT4) posts this account's balance, open positions and closed trades. Nothing here can place or change a trade.

export const MAX_POSITIONS = 300, MAX_DEALS = 500, MAX_ACCOUNTS = 3;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const int = (v) => { const n = Math.trunc(Number(v)); return Number.isFinite(n) ? n : null; };
const clip = (s, n) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, n);
const side = (v) => { const s = String(v || "").toUpperCase(); return s === "BUY" || s === "0" ? "BUY" : s === "SELL" || s === "1" ? "SELL" : null; };
const symbol = (v) => clip(v, 24).toUpperCase().replace(/[^A-Z0-9._#\-+!]/g, "");

/** Turns an EA payload into clean rows, or an error code. Numbers are coerced, strings clipped, junk rows dropped. */
export function parsePayload(b) {
  if (!b || typeof b !== "object" || !b.account || typeof b.account !== "object") return { error: "bad_payload" };
  const a = b.account, login = clip(a.login, 24);
  if (!/^\d{1,20}$/.test(login)) return { error: "bad_payload" };
  const account = {
    login, server: clip(a.server, 80), company: clip(a.company, 80), currency: clip(a.currency, 8).toUpperCase(),
    leverage: int(a.leverage), balance: num(a.balance), equity: num(a.equity), margin: num(a.margin), free_margin: num(a.free_margin),
    floating: num(a.profit), platform: String(a.platform || "").toLowerCase() === "mt4" ? "mt4" : "mt5", ea_version: clip(b.v, 12),
  };
  if (account.balance == null || account.equity == null) return { error: "bad_payload" };
  const positions = (Array.isArray(b.positions) ? b.positions : []).slice(0, MAX_POSITIONS).map((p) => ({
    ticket: int(p.ticket), symbol: symbol(p.symbol), side: side(p.type), volume: num(p.volume), open_price: num(p.open_price), open_time: int(p.open_time),
    sl: num(p.sl) || null, tp: num(p.tp) || null, price: num(p.price), profit: num(p.profit), swap: num(p.swap),
  })).filter((p) => p.ticket != null && p.symbol && p.side);
  const deals = (Array.isArray(b.deals) ? b.deals : []).slice(0, MAX_DEALS).map((d) => {
    const profit = num(d.profit) || 0, commission = num(d.commission) || 0, swap = num(d.swap) || 0;
    return { position_id: int(d.position_id), symbol: symbol(d.symbol), side: side(d.type), volume: num(d.volume), open_time: int(d.open_time), close_time: int(d.close_time),
      open_price: num(d.open_price), close_price: num(d.close_price), sl: num(d.sl) || null, tp: num(d.tp) || null, profit, commission, swap,
      net: Math.round((profit + commission + swap) * 100) / 100, comment: clip(d.comment, 60) };
  }).filter((d) => d.position_id != null && d.symbol && d.side && d.close_time > 0);
  return { account, positions, deals };
}

/** Trading session from the OPEN time (UTC hours), using the journal's own session names. */
export function sessionOf(tSec) {
  if (!tSec) return "Other";
  const h = new Date(tSec * 1000).getUTCHours();
  return h >= 7 && h < 12 ? "London" : h >= 12 && h < 16 ? "New York AM" : h >= 16 && h < 21 ? "New York PM" : h >= 23 || h < 7 ? "Asia" : "Other";
}
/** Journal date (Cambodia, UTC+7) of the close, YYYY-MM-DD. */
export const dayICT = (tSec) => new Date((tSec + 7 * 3600) * 1000).toISOString().slice(0, 10);

/** One closed broker trade -> one row of the member's journal (public.trades). */
export function journalRow(d, userId, accountLabel, platform) {
  const res = d.net > 0.004 ? "Win" : d.net < -0.004 ? "Loss" : "Breakeven";
  const fmt = (v) => (v == null ? "—" : String(+Number(v).toFixed(5)));
  return {
    user_id: userId, date: dayICT(d.close_time), account: accountLabel, symbol: d.symbol, session: sessionOf(d.open_time), direction: d.side === "BUY" ? "Buy" : "Sell",
    setup: "Broker sync", result: res, pl: d.net, risk: null, rmultiple: null, grade: "B",
    levels: `Entry ${fmt(d.open_price)} · Exit ${fmt(d.close_price)}${d.sl ? " · SL " + fmt(d.sl) : ""}${d.tp ? " · TP " + fmt(d.tp) : ""} · ${fmt(d.volume)} lots`,
    review: `Imported from ${platform.toUpperCase()} · position #${d.position_id}${d.comment ? " · " + d.comment : ""}. Profit ${d.profit}, commission ${d.commission}, swap ${d.swap}.`,
  };
}

/** Performance from closed trades (net = profit + commission + swap). */
export function stats(deals) {
  const n = deals.length, nets = deals.map((d) => Number(d.net) || 0), wins = nets.filter((x) => x > 0.004), losses = nets.filter((x) => x < -0.004);
  const sum = (a) => a.reduce((x, y) => x + y, 0), gp = sum(wins), gl = -sum(losses), r2 = (v) => Math.round(v * 100) / 100;
  const bySym = {};
  for (const d of deals) { const k = d.symbol, x = bySym[k] || (bySym[k] = { symbol: k, trades: 0, wins: 0, net: 0 }); x.trades++; if (d.net > 0.004) x.wins++; x.net = r2(x.net + (Number(d.net) || 0)); }
  let streak = 0, worst = 0; for (const x of nets) { if (x < -0.004) { streak++; worst = Math.max(worst, streak); } else if (x > 0.004) streak = 0; }
  return {
    trades: n, wins: wins.length, losses: losses.length, win_rate: n ? r2(100 * wins.length / n) : null, net: r2(sum(nets)),
    profit_factor: gl > 0 ? r2(gp / gl) : (gp > 0 ? null : 0), avg_win: wins.length ? r2(gp / wins.length) : null, avg_loss: losses.length ? r2(-gl / losses.length) : null,
    best: n ? r2(Math.max(...nets)) : null, worst: n ? r2(Math.min(...nets)) : null, max_loss_streak: worst,
    by_symbol: Object.values(bySym).sort((a, b) => b.trades - a.trades).slice(0, 12),
  };
}

/** New sync code: shown to the member once; only its SHA-256 is stored. */
export function newToken(bytes) { return "arom_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""); }
export async function hashToken(t) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(t)));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}
export const validToken = (t) => /^arom_[0-9a-f]{40}$/.test(String(t || ""));

// ---- MetaApi (phone-only members: cloud MT terminal logged in with the INVESTOR password, which can only read) ----
export const MA_MAX = 1;   // MetaApi bills per connected account, so one phone-only account per member
const sec = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? Math.floor(t / 1000) : null; };
const maSide = (t) => /BUY/.test(String(t || "")) ? "BUY" : /SELL/.test(String(t || "")) ? "SELL" : null;

/** Checks the phone-only connect form. Returns clean fields or an error code. The password is passed through, never stored. */
export function maForm(b) {
  const login = clip(b && b.login, 24), server = clip(b && b.server, 80), password = String((b && b.password) || "");
  const platform = String((b && b.platform) || "").toLowerCase() === "mt4" ? "mt4" : "mt5";
  if (!/^\d{3,20}$/.test(login)) return { error: "bad_login" };
  if (server.length < 3 || !/^[\w .\-()#&]+$/.test(server)) return { error: "bad_server" };
  if (password.length < 4 || password.length > 64 || /[\u0000-\u001f]/.test(password)) return { error: "bad_password" };
  return { login, server, password, platform, label: clip(b && b.label, 30) || platform.toUpperCase() + " " + login };
}

/**
 * MetaApi REST answers -> the same payload the EA sends, so parsePayload / ingest stay one code path.
 * info: account-information · positions: positions · deals: history-deals (a closed trade = all deals of one positionId).
 */
export function maPayload(info, positions, deals, acc) {
  const open = new Set((positions || []).map((p) => String(p.id)));
  const by = {};
  for (const d of deals || []) {
    if (!d || d.positionId == null || !maSide(d.type)) continue;            // skips balance / credit rows
    const k = String(d.positionId); (by[k] || (by[k] = [])).push(d);
  }
  const closed = [];
  for (const [id, ds] of Object.entries(by)) {
    if (open.has(id)) continue;                                              // still open (partly closed): wait for the final close
    const ins = ds.filter((d) => /IN$/.test(String(d.entryType || "")) && !/INOUT/.test(String(d.entryType))), outs = ds.filter((d) => /OUT|OUT_BY|INOUT/.test(String(d.entryType || "")));
    if (!outs.length) continue;
    const first = ins[0] || ds[0], vol = outs.reduce((s, d) => s + (+d.volume || 0), 0) || +first.volume || 0;
    const sum = (k) => ds.reduce((s, d) => s + (+d[k] || 0), 0);
    const last = outs.reduce((a, d) => (Date.parse(d.time) > Date.parse(a.time) ? d : a));
    closed.push({ position_id: id, symbol: first.symbol || last.symbol, type: maSide(first.type) || (maSide(last.type) === "BUY" ? "SELL" : "BUY"), volume: vol,
      open_time: sec(first.time), close_time: sec(last.time), open_price: first.price,
      close_price: outs.reduce((s, d) => s + (+d.price || 0) * (+d.volume || 0), 0) / (outs.reduce((s, d) => s + (+d.volume || 0), 0) || 1),
      sl: first.stopLoss ?? last.stopLoss, tp: first.takeProfit ?? last.takeProfit, profit: sum("profit"), commission: sum("commission"), swap: sum("swap"), comment: first.comment || "" });
  }
  closed.sort((a, b) => a.close_time - b.close_time);
  const i = info || {};
  return {
    v: "metaapi",
    account: { platform: i.platform || acc.platform, login: String(i.login ?? acc.login), server: i.server || acc.server, company: i.broker || "", currency: i.currency,
      leverage: i.leverage, balance: i.balance, equity: i.equity, margin: i.margin, free_margin: i.freeMargin, profit: (i.equity ?? 0) - (i.balance ?? 0) },
    positions: (positions || []).map((p) => ({ ticket: p.id, symbol: p.symbol, type: maSide(p.type), volume: p.volume, open_price: p.openPrice, open_time: sec(p.time),
      sl: p.stopLoss, tp: p.takeProfit, price: p.currentPrice, profit: p.profit ?? p.unrealizedProfit, swap: p.swap })),
    deals: closed,
  };
}

/** MetaApi account state -> what the member sees. */
export function maStatus(st) {
  const s = String((st && st.state) || ""), c = String((st && st.connectionStatus) || "");
  if (s === "DEPLOYED" && c === "CONNECTED") return "live";
  if (s === "DEPLOY_FAILED") return "failed";
  if (s === "DEPLOYED" && c === "DISCONNECTED_FROM_BROKER") return "broker";
  if (s === "UNDEPLOYED" || s === "UNDEPLOYING") return "paused";
  return "connecting";
}
