// @ts-nocheck
/* AROM A+ Engine (shared with the website): Scalping v3 · Intraday · Swing */
const AiEng = (() => {
  /* ---------- AROM A+ Engine v2: Scalping · Intraday · Swing ----------
     Same trend-pullback rules on three timeframe stacks. A signal is released only when all 11 checks pass (A+).
     SCALPING  v3 (rebuilt): M5 trend → M1 entry · trendline + breakout/retest + S/R + pullback · TP 1R / 2R · valid 10 min · all sessions
     (M5 = the old M15→M5 scalping rules, kept only for the news panel's quick M5 read)
     INTRADAY  H1 trend  → M15 entry · 1.5R / 3R / 4.5R runner · valid 1 hour · London/NY
     SWING     H4 trend + Daily filter → H1 entry · 2R / 4R / 6R runner · valid 4 hours · any weekday session */
  const MODES = {
    scalp:    {key:'scalp',    base:60,   htf:300,   valid:600,   rr:[1, 2],        session:false, maxBars:60,  eName:'M1',  hName:'M5', v3:true,
               keys:['bias','align','pullback','trigger','session','news','risk','room','sr','tline','retest']},
    m5:       {key:'m5',       base:300,  htf:900,   valid:900,   rr:[1, 2, 3],     session:true,  maxBars:48,  eName:'M5',  hName:'M15'},
    intraday: {key:'intraday', base:900,  htf:3600,  valid:3600,  rr:[1.5, 3, 4.5], session:true,  maxBars:32,  eName:'M15', hName:'H1'},
    swing:    {key:'swing',    base:3600, htf:14400, valid:14400, rr:[2, 4, 6],     session:false, maxBars:120, eName:'H1',  hName:'H4', daily:true},
  };
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

  // Aggregate candles into a higher timeframe. Keeps buckets that have at least minFrac of their candles.
  function agg(bars, step, base, minFrac = 1){ const out = []; let cur = null; const need = Math.max(1, Math.round(step / base * minFrac));
    for(const b of bars){ const k = Math.floor(b.t / step) * step;
      if(!cur || cur.t !== k){ if(cur) out.push(cur); cur = {t:k, o:b.o, h:b.h, l:b.l, c:b.c, n:1}; }
      else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.n++; } }
    if(cur) out.push(cur); return out.filter(x => x.n >= need); }
  const toM15 = m5 => agg(m5, 900, 300, 1);

  function prep(bars, htf, mode){
    const M = MODES[mode] || MODES.m5;
    htf = htf && htf.length ? htf : agg(bars, M.htf, M.base, 1);
    const P = {M, m:bars, m5:bars, htf, m15:htf};
    const c = bars.map(x => x.c), h = bars.map(x => x.h), l = bars.map(x => x.l);
    P.e20 = ema(c, 20); P.e50 = ema(c, 50); P.rsi = rsiF(c); P.atr = atrF(h, l, c);
    const hc = htf.map(x => x.c); P.h50 = ema(hc, 50); P.h200 = ema(hc, 200);
    if(M.daily){ P.d1 = agg(bars, 86400, M.base, 0.75); const dc = P.d1.map(x => x.c); P.dE = ema(dc, P.d1.length >= 60 ? 50 : 20); }
    if(M.v3) prepV3(P);
    return P; }

  /* ---------- Scalping v3 helpers ----------
     Swing points on the M5 trend chart (2 candles each side, known only once the 2 right-hand candles have closed).
     They give S/R zones, the trendline (last two higher lows / lower highs) and breakout levels for the retest. */
  function prepV3(P){
    const H = P.htf, hh = H.map(x => x.h), hl = H.map(x => x.l), hc = H.map(x => x.c), step = P.M.htf;
    P.h20 = ema(hc, 20); P.h50b = ema(hc, 50); P.hAtr = atrF(hh, hl, hc);
    P.sw = [];
    for(let k = 2; k < H.length - 2; k++){ const known = H[k + 2].t + step;
      if(H[k].h > H[k - 1].h && H[k].h > H[k - 2].h && H[k].h >= H[k + 1].h && H[k].h >= H[k + 2].h) P.sw.push({p:H[k].h, t:H[k].t, known, side:'H'});
      if(H[k].l < H[k - 1].l && H[k].l < H[k - 2].l && H[k].l <= H[k + 1].l && H[k].l <= H[k + 2].l) P.sw.push({p:H[k].l, t:H[k].t, known, side:'L'}); }
  }
  function zonesAt(P, closeT, A5){
    const pts = P.sw.filter(s => s.known <= closeT && s.t >= closeT - 86400).sort((a, b) => a.p - b.p), Z = [];
    pts.forEach(pt => { const z = Z[Z.length - 1]; if(z && pt.p - z.lo <= .35 * A5){ z.hi = pt.p; z.n++; } else Z.push({lo:pt.p, hi:pt.p, n:1}); });
    return Z.filter(z => z.n >= 2).map(z => ({lo:z.lo - .1 * A5, hi:z.hi + .1 * A5, n:z.n}));
  }
  function evalV3(P, i, news){
    const M = P.M, m = P.m, b = m[i], closeT = b.t + M.base, A1 = P.atr[i];
    const out = {i, t:closeT, side:null, checks:[], grade:'—', signal:null, mode:M.key, max:M.keys.length};
    let j = -1; for(let k = P.htf.length - 1; k >= 0; k--){ if(P.htf[k].t + M.htf <= closeT){ j = k; break; } }
    if(i < 60 || A1 == null || P.e50[i] == null || j < 55 || P.h50b[j] == null || P.hAtr[j] == null){ out.grade = 'n/a'; return out; }
    const A5 = P.hAtr[j], add = (key, pass, val, core) => out.checks.push({key, pass:!!pass, val, core});
    // 1) M5 trend: close beyond EMA50, EMA20 beyond EMA50, EMA20 rising / falling
    const hc = P.htf[j].c, h20 = P.h20[j], h50 = P.h50b[j], sl20 = h20 - P.h20[j - 3];
    const side = hc > h50 && h20 > h50 && sl20 > 0 ? 'BUY' : hc < h50 && h20 < h50 && sl20 < 0 ? 'SELL' : null;
    out.side = side; add('bias', !!side, side || 'range', true);
    if(!side){ out.grade = 'No setup'; return out; }
    const L = side === 'BUY', e20 = P.e20[i], e50 = P.e50[i];
    // 2) M1 EMA20 / EMA50 agree with the M5 trend
    add('align', L ? e20 > e50 : e20 < e50, null, true);
    // Key levels price can pull back to
    const tol = Math.max(.25 * A1, .08 * A5);
    let ext = L ? Infinity : -Infinity; for(let k = i - 3; k <= i; k++) ext = L ? Math.min(ext, m[k].l) : Math.max(ext, m[k].h);
    const near = lv => L ? ext <= lv + tol && b.c > lv - tol : ext >= lv - tol && b.c < lv + tol;
    //  a) S/R zone on the trend side (support for buys, resistance for sells), 2+ M5 swing touches
    const Z = zonesAt(P, closeT, A5), zone = Z.find(z => L ? ext <= z.hi + tol && ext >= z.lo - tol && b.c > z.lo : ext >= z.lo - tol && ext <= z.hi + tol && b.c < z.hi);
    //  b) trendline through the last two higher lows (buys) / lower highs (sells) on M5, projected to now
    const sw = P.sw.filter(s => s.known <= closeT && s.side === (L ? 'L' : 'H')).slice(-2);
    let tl = null; if(sw.length === 2 && (L ? sw[1].p > sw[0].p : sw[1].p < sw[0].p) && sw[1].t > sw[0].t){ const slope = (sw[1].p - sw[0].p) / (sw[1].t - sw[0].t); tl = sw[1].p + slope * (b.t - sw[1].t); }
    const onTl = tl != null && near(tl);
    //  c) breakout + retest: an M5 swing high (buys) / low (sells) closed through within the last 45 M1 candles, now retested from the other side
    let rt = null;
    const lv = P.sw.filter(s => s.known <= closeT && s.side === (L ? 'H' : 'L') && s.t >= closeT - 43200);
    for(const s_ of lv){ let bk = -1; for(let k = Math.max(1, i - 45); k < i - 1; k++){ if(L ? m[k].c > s_.p && m[k - 1].c <= s_.p : m[k].c < s_.p && m[k - 1].c >= s_.p){ bk = k; break; } }
      if(bk >= 0 && near(s_.p)){ let held = true; for(let k = bk + 1; k <= i; k++) if(L ? m[k].c < s_.p - tol : m[k].c > s_.p + tol){ held = false; break; } if(held){ rt = s_.p; break; } } }
    // 3) Pullback into one of those levels (or the M1 EMA20 inside an S/R zone) — price came back to value
    const level = zone ? (L ? zone.hi : zone.lo) : onTl ? tl : rt;
    add('pullback', !!(zone || onTl || rt != null), zone ? 'SR' : onTl ? 'trendline' : rt != null ? 'retest' : null, true);
    // 4) Rejection candle off the level
    const p = m[i - 1], rng = Math.max(b.h - b.l, 1e-9), body = Math.abs(b.c - b.o);
    let trig = null;
    if(L && b.c > b.o){ if(p.c < p.o && b.c >= p.o && b.o <= p.c) trig = 'engulf'; else if(Math.min(b.o, b.c) - b.l >= 1.5 * body && b.c >= b.l + .6 * rng) trig = 'pin'; else if(body >= .55 * rng && b.c > p.h) trig = 'momentum'; }
    if(!L && b.c < b.o){ if(p.c > p.o && b.c <= p.o && b.o >= p.c) trig = 'engulf'; else if(b.h - Math.max(b.o, b.c) >= 1.5 * body && b.c <= b.h - .6 * rng) trig = 'pin'; else if(body >= .55 * rng && b.c < p.l) trig = 'momentum'; }
    add('trigger', !!trig, trig, true);
    // 5) Session: all sessions, weekdays (market open)
    const wd = new Date(closeT * 1000).getUTCDay(); add('session', wd >= 1 && wd <= 5, 'any', true);
    // 6) News lock
    const nz = news ? news(closeT) : true; add('news', nz === true, nz === null ? 'unknown' : null, true);
    // 7) Stop beyond the zone / swing: SL past the pullback extreme or the level, whichever is further; 0.3–1.5 × M5 ATR
    const base = level != null ? (L ? Math.min(ext, level - tol) : Math.max(ext, level + tol)) : ext;
    const entry = b.c, sl = L ? base - .1 * A5 : base + .1 * A5, risk = Math.abs(entry - sl);
    add('risk', risk >= .3 * A5 && risk <= 1.5 * A5, +(risk / A5).toFixed(2), true);
    // 8) Room: no opposing S/R zone before TP2 (2R)
    const opp = Z.filter(z => L ? z.lo > entry : z.hi < entry).sort((x, y) => L ? x.lo - y.lo : y.hi - x.hi)[0];
    const room = opp ? (L ? opp.lo - entry : entry - opp.hi) / risk : null;
    add('room', !opp || room >= M.rr[1], room == null ? null : +room.toFixed(1), true);
    // Confluence: how many of the three level types line up (need 2 of 3 for A+)
    add('sr', !!zone, zone ? zone.n + '×' : null, false);
    add('tline', onTl, null, false);
    add('retest', rt != null, null, false);
    const core = out.checks.filter(x => x.core), conf = out.checks.filter(x => !x.core && x.pass).length, coreOK = core.every(x => x.pass);
    out.score = out.checks.filter(x => x.pass).length; out.conf = conf;
    out.grade = coreOK && conf >= 2 ? 'A+' : coreOK && conf >= 1 ? 'A' : out.score >= 7 ? 'B' : 'C';
    if(out.grade === 'A+'){
      const R = L ? 1 : -1, dp = entry >= 100 ? 2 : 5, f = x => +x.toFixed(dp);
      out.signal = {side, entry:f(entry), sl:f(sl), tp1:f(entry + R * M.rr[0] * risk), tp2:f(entry + R * M.rr[1] * risk), tp3:null,
        risk:f(risk), t:closeT, validUntil:closeT + M.valid, trigger:trig, mode:M.key, rr:M.rr, maxBars:M.maxBars};
    }
    return out;
  }

  const SESSION = {from:7, to:17};          // UTC hours = 14:00–24:00 Cambodia (London + New York)
  // Evaluate the CLOSED candle at index i. news(tSec) -> true (clear) | false (blocked) | null (unknown)
  function evalAt(P, i, news){
    if(P.M && P.M.v3) return evalV3(P, i, news);
    const M = P.M || MODES.m5, m = P.m, b = m[i], closeT = b.t + M.base, A = P.atr[i];
    const out = {i, t:closeT, side:null, checks:[], grade:'—', signal:null, mode:M.key};
    if(i < 120 || A == null || P.e50[i] == null) { out.grade = 'n/a'; return out; }
    // 1) Higher-timeframe bias from the last HTF candle closed at this time (+ daily filter for swing)
    let j = -1; for(let k = P.htf.length - 1; k >= 0; k--){ if(P.htf[k].t + M.htf <= closeT){ j = k; break; } }
    let side = null;
    if(j >= 3 && P.h200[j] != null){
      const hc = P.htf[j].c, e50 = P.h50[j], e200 = P.h200[j], slope = e50 - P.h50[j - 3];
      if(hc > e50 && e50 > e200 && slope > 0) side = 'BUY';
      else if(hc < e50 && e50 < e200 && slope < 0) side = 'SELL';
    }
    if(side && M.daily && P.d1){ let d = -1; for(let k = P.d1.length - 1; k >= 0; k--){ if(P.d1[k].t + 86400 <= closeT){ d = k; break; } }
      if(d >= 0 && P.dE[d] != null){ const dc = P.d1[d].c; if((side === 'BUY' && dc < P.dE[d]) || (side === 'SELL' && dc > P.dE[d])) side = null; } }
    out.side = side; const L = side !== 'SELL';  // long logic unless SELL
    const add = (key, pass, val, core) => out.checks.push({key, pass:!!pass, val, core});
    add('bias', !!side, side ? side : 'range', true);
    if(!side){ out.grade = 'No setup'; return out; }
    const e20 = P.e20[i], e50 = P.e50[i];
    // 2) Entry-timeframe trend aligned with the bias
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
    // 5) Session: London / New York for scalping & intraday; any weekday session for swing
    const d = new Date(closeT * 1000), hr = d.getUTCHours() + d.getUTCMinutes() / 60, wd = d.getUTCDay();
    add('session', wd >= 1 && wd <= 5 && (!M.session || (hr >= SESSION.from && hr < SESSION.to)), M.session ? null : 'any', true);
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
    // 11) Room to target: nearest swing high/low leaves space for the first target (or price is making new extremes)
    let hiLo = L ? -Infinity : Infinity; for(let k = i - 48; k < i; k++) hiLo = L ? Math.max(hiLo, m[k].h) : Math.min(hiLo, m[k].l);
    const room = L ? hiLo - entry : entry - hiLo;
    add('room', room <= 0 || room >= Math.max(1.5, M.rr[0]) * risk, null, false);

    const core = out.checks.filter(x => x.core), extra = out.checks.filter(x => !x.core);
    const coreOK = core.every(x => x.pass), extraN = extra.filter(x => x.pass).length;
    out.score = out.checks.filter(x => x.pass).length; out.max = out.checks.length;
    out.grade = coreOK && extraN === extra.length ? 'A+' : coreOK && extraN >= 2 ? 'A' : out.score >= 7 ? 'B' : 'C';
    if(out.grade === 'A+'){
      const R = L ? 1 : -1, dp = entry >= 100 ? 2 : 5, f = x => +x.toFixed(dp);
      out.signal = {side, entry:f(entry), sl:f(sl), tp1:f(entry + R * M.rr[0] * risk), tp2:f(entry + R * M.rr[1] * risk), tp3:f(entry + R * M.rr[2] * risk),
        risk:f(risk), t:closeT, validUntil:closeT + M.valid, trigger:trig, mode:M.key, rr:M.rr, maxBars:M.maxBars};
    }
    return out;
  }

  // Walk forward from the signal: highest target reached before the stop (same-candle touch counts as stop).
  function simulate(m, i, s, maxBars){
    maxBars = maxBars || s.maxBars || 48;
    const L = s.side === 'BUY'; let hit = 0, res = 'open', end = null;
    for(let k = i + 1; k < m.length && k <= i + maxBars; k++){
      const b = m[k], slHit = L ? b.l <= s.sl : b.h >= s.sl;
      if(slHit){ res = hit ? 'tp' + hit : 'sl'; end = b.t; break; }
      const lv = [s.tp1, s.tp2, s.tp3].filter(x => x != null && isFinite(x) && x > 0), nT = lv.length; for(let q = hit; q < nT; q++){ if(L ? b.h >= lv[q] : b.l <= lv[q]) hit = q + 1; }
      if(hit === nT){ res = 'tp' + nT; end = b.t; break; }
      if(k === i + maxBars){ res = hit ? 'tp' + hit : 'expired'; end = b.t; }
    }
    if(res === 'open' && hit) res = 'tp' + hit + '+';
    return {res, end};
  }

  // All A+ setups found in the loaded history (news unknown for the past -> session/price rules only)
  function scan(P, news){
    const out = []; let last = -99;
    const gap = P.M && P.M.v3 ? 10 : 6;
    for(let i = 120; i < P.m.length; i++){
      const r = evalAt(P, i, news);
      if(r.signal && i - last > gap){ out.push({i, ...r.signal, out:simulate(P.m, i, r.signal)}); last = i; }
    }
    return out;
  }
  return {prep, evalAt, simulate, scan, toM15, agg, MODES};
})();

export default AiEng;
