/* ---------- AROM A+ Scalping Engine (rule-based) ----------
   Strategy: "Trend-Pullback Scalp" — M15 trend bias, M5 pullback into the EMA20–EMA50 zone,
   price-action trigger, RSI momentum, ATR-based stop, fixed-R targets, London/NY session,
   no high-impact USD news. A signal is only released when EVERY check passes (A+).
   Works on real closed candles only; nothing is simulated or invented. */
const AiEng = (() => {
  const ema = (a, n) => { const k = 2 / (n + 1), o = new Array(a.length); let p = null;
    for(let i = 0; i < a.length; i++){ if(i < n - 1){ o[i] = null; continue; }
      if(p === null){ let s = 0; for(let j = i - n + 1; j <= i; j++) s += a[j]; p = s / n; } else p = a[i] * k + p * (1 - k);
      o[i] = p; } return o; };
  const rsiF = (c, n = 14) => { const o = new Array(c.length).fill(null); let g = 0, l = 0;
    for(let i = 1; i < c.length; i++){ const d = c[i] - c[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
      if(i <= n){ g += up; l += dn; if(i === n){ g /= n; l /= n; o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } continue; }
      g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } return o; };
  const atrF = (h, l, c, n = 14) => { const o = new Array(c.length).fill(null); let a = 0;
    for(let i = 1; i < c.length; i++){ const tr = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
      if(i <= n){ a += tr; if(i === n){ a /= n; o[i] = a; } continue; } a = (a * (n - 1) + tr) / n; o[i] = a; } return o; };
  const median = a => { const s = a.filter(x => x != null).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

  // M5 candles [{t(sec, open time), o,h,l,c}] -> M15 by 15-minute buckets (complete buckets only)
  function toM15(m5){ const out = []; let cur = null;
    for(const b of m5){ const k = Math.floor(b.t / 900) * 900;
      if(!cur || cur.t !== k){ if(cur) out.push(cur); cur = {t:k, o:b.o, h:b.h, l:b.l, c:b.c, n:1}; }
      else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.n++; } }
    if(cur) out.push(cur); return out.filter(x => x.n === 3); }

  function prep(m5, m15){
    m15 = m15 && m15.length ? m15 : toM15(m5);
    const P = {m5, m15};
    const c = m5.map(x => x.c), h = m5.map(x => x.h), l = m5.map(x => x.l);
    P.e20 = ema(c, 20); P.e50 = ema(c, 50); P.rsi = rsiF(c); P.atr = atrF(h, l, c);
    const hc = m15.map(x => x.c); P.h50 = ema(hc, 50); P.h200 = ema(hc, 200);
    return P; }

  const SESSION = {from:7, to:17};          // UTC hours = 14:00–24:00 Cambodia (London + New York overlap)
  // Evaluate the CLOSED M5 candle at index i. news(tSec) -> true (clear) | false (blocked) | null (unknown)
  function evalAt(P, i, news){
    const m = P.m5, b = m[i], closeT = b.t + 300, A = P.atr[i];
    const out = {i, t:closeT, side:null, checks:[], grade:'—', signal:null};
    if(i < 120 || A == null || P.e50[i] == null) { out.grade = 'n/a'; return out; }
    // 1) M15 bias from the last M15 candle closed at this time
    let j = -1; for(let k = P.m15.length - 1; k >= 0; k--){ if(P.m15[k].t + 900 <= closeT){ j = k; break; } }
    let side = null;
    if(j >= 3 && P.h200[j] != null){
      const hc = P.m15[j].c, e50 = P.h50[j], e200 = P.h200[j], slope = e50 - P.h50[j - 3];
      if(hc > e50 && e50 > e200 && slope > 0) side = 'BUY';
      else if(hc < e50 && e50 < e200 && slope < 0) side = 'SELL';
    }
    out.side = side; const L = side !== 'SELL';  // long logic unless SELL
    const add = (key, pass, val, core) => out.checks.push({key, pass:!!pass, val, core});
    add('bias', !!side, side ? side : 'range', true);
    if(!side){ out.grade = 'No setup'; return out; }
    const e20 = P.e20[i], e50 = P.e50[i];
    // 2) M5 trend aligned with M15
    add('align', L ? e20 > e50 : e20 < e50, null, true);
    // 3) Pullback into the EMA20–EMA50 zone during the last 6 candles, without a deep break of EMA50
    let ext = L ? Infinity : -Infinity; for(let k = i - 6; k <= i; k++) ext = L ? Math.min(ext, m[k].l) : Math.max(ext, m[k].h);
    const touched = L ? ext <= e20 + 0.15 * A : ext >= e20 - 0.15 * A;
    const deep = L ? ext < e50 - 0.6 * A : ext > e50 + 0.6 * A;
    add('pullback', touched && !deep, null, true);
    // 4) Price-action trigger on the signal candle
    const p = m[i - 1], rng = Math.max(b.h - b.l, 1e-9), body = Math.abs(b.c - b.o);
    let trig = null;
    if(L && b.c > b.o && b.c > e20){
      if(p.c < p.o && b.c >= p.o && b.o <= p.c) trig = 'engulf';
      else if(Math.min(b.o, b.c) - b.l >= 2 * body && b.c >= b.l + 0.66 * rng) trig = 'pin';
      else if(body >= 0.55 * rng && b.c > p.h) trig = 'momentum';
    }
    if(!L && b.c < b.o && b.c < e20){
      if(p.c > p.o && b.c <= p.o && b.o >= p.c) trig = 'engulf';
      else if(b.h - Math.max(b.o, b.c) >= 2 * body && b.c <= b.h - 0.66 * rng) trig = 'pin';
      else if(body >= 0.55 * rng && b.c < p.l) trig = 'momentum';
    }
    add('trigger', !!trig, trig, true);
    // 5) Session: London / New York only, Mon–Fri
    const d = new Date(closeT * 1000), hr = d.getUTCHours() + d.getUTCMinutes() / 60, wd = d.getUTCDay();
    add('session', wd >= 1 && wd <= 5 && hr >= SESSION.from && hr < SESSION.to, null, true);
    // 6) No high-impact USD news within ±30 min
    const nz = news ? news(closeT) : true;
    add('news', nz === true, nz === null ? 'unknown' : null, true);
    // 7) Risk: stop beyond the pullback extreme (+0.25 ATR); must be between 0.8 and 3 ATR
    const entry = b.c, sl = L ? ext - 0.25 * A : ext + 0.25 * A, risk = Math.abs(entry - sl);
    add('risk', risk >= 0.8 * A && risk <= 3 * A, +(risk / A).toFixed(2), true);
    // 8) RSI momentum in the healthy zone and turning in the trade direction
    const r = P.rsi[i], r1 = P.rsi[i - 1];
    add('rsi', L ? r >= 45 && r <= 70 && r > r1 : r >= 30 && r <= 55 && r < r1, r == null ? null : +r.toFixed(1), false);
    // 9) Structure: pullback low is higher than the earlier swing (lower high for shorts)
    let prev = L ? Infinity : -Infinity; for(let k = i - 30; k <= i - 7; k++) prev = L ? Math.min(prev, m[k].l) : Math.max(prev, m[k].h);
    add('structure', L ? ext > prev : ext < prev, null, false);
    // 10) Volatility: ATR normal (not dead, not a spike)
    const med = median(P.atr.slice(Math.max(0, i - 100), i + 1));
    add('vol', med && A >= 0.8 * med && A <= 2.5 * med, med ? +(A / med).toFixed(2) : null, false);
    // 11) Room to target: nearest swing high/low leaves space for 1.5R (or price is making new extremes)
    let hiLo = L ? -Infinity : Infinity; for(let k = i - 48; k < i; k++) hiLo = L ? Math.max(hiLo, m[k].h) : Math.min(hiLo, m[k].l);
    const room = L ? hiLo - entry : entry - hiLo;
    add('room', room <= 0 || room >= 1.5 * risk, null, false);

    const core = out.checks.filter(x => x.core), extra = out.checks.filter(x => !x.core);
    const coreOK = core.every(x => x.pass), extraN = extra.filter(x => x.pass).length;
    out.score = out.checks.filter(x => x.pass).length; out.max = out.checks.length;
    out.grade = coreOK && extraN === extra.length ? 'A+' : coreOK && extraN >= 2 ? 'A' : out.score >= 7 ? 'B' : 'C';
    if(out.grade === 'A+'){
      const R = L ? 1 : -1, dp = entry >= 100 ? 2 : 5, f = x => +x.toFixed(dp);
      out.signal = {side, entry:f(entry), sl:f(sl), tp1:f(entry + R * risk), tp2:f(entry + 2 * R * risk), tp3:f(entry + 3 * R * risk),
        risk:f(risk), t:closeT, validUntil:closeT + 15 * 60, trigger:trig};
    }
    return out;
  }

  // Walk forward from the signal: highest target reached before the stop (same-candle touch counts as stop).
  function simulate(m5, i, s, maxBars = 48){
    const L = s.side === 'BUY'; let hit = 0, res = 'open', end = null;
    for(let k = i + 1; k < m5.length && k <= i + maxBars; k++){
      const b = m5[k], slHit = L ? b.l <= s.sl : b.h >= s.sl;
      if(slHit){ res = hit ? 'tp' + hit : 'sl'; end = b.t; break; }
      const lv = [s.tp1, s.tp2, s.tp3]; for(let q = hit; q < 3; q++){ if(L ? b.h >= lv[q] : b.l <= lv[q]) hit = q + 1; }
      if(hit === 3){ res = 'tp3'; end = b.t; break; }
      if(k === i + maxBars){ res = hit ? 'tp' + hit : 'expired'; end = b.t; }
    }
    if(res === 'open' && hit) res = 'tp' + hit + '+';
    return {res, end};
  }

  // All A+ setups found in the loaded history (news unknown for the past -> session/price rules only)
  function scan(P, news){
    const out = []; let last = -99;
    for(let i = 120; i < P.m5.length; i++){
      const r = evalAt(P, i, news);
      if(r.signal && i - last > 6){ out.push({i, ...r.signal, out:simulate(P.m5, i, r.signal)}); last = i; }
    }
    return out;
  }
  return {prep, evalAt, simulate, scan, toM15};
})();
if(typeof module !== 'undefined') module.exports = AiEng;
