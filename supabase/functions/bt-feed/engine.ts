// @ts-nocheck
// RESEARCH COPY of the A+ engine (bt-feed only): same rules as supabase/functions/ai-telegram/engine.ts, plus optional knobs read from the mode
// (pad, rMin, rMax, xNeed, xMust, trigs, minRiskUsd, confNeed, hours). With no knobs set it behaves exactly like the production engine.

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
    // btcx: SHADOW research mode (BTC only, never posted). Scalping v3 without the momentum trigger and with a 0.3 ATR stop pad.
    // Backtest BTCUSD 20 days, $5 spread: n=52, +0.26R/trade, positive in both halves (+0.25R / +0.32R). One market, small sample: forward-test before trusting.
    btcx:     {key:'btcx',     base:60,   htf:300,   valid:600,   rr:[1, 2],        session:false, maxBars:60,  eName:'M1',  hName:'M5', v3:true, only:/^BTC/, noMom:true, stopPad:.3, shadow:true,
               keys:['bias','align','pullback','trigger','session','news','risk','room','sr','tline','retest']},
    sweep:    {key:'sweep',    base:60,   htf:300,   valid:300,   rr:[1, 2],        session:false, maxBars:60,  eName:'M1',  hName:'M5', sweep:true, only:/^BTC/, minRiskPct:.0005,
               keys:['sweep','session','news','risk']},
    m5:       {key:'m5',       base:300,  htf:900,   valid:900,   rr:[1, 2, 3],     session:true,  maxBars:48,  eName:'M5',  hName:'M15'},
    // one:true = a new intraday signal only when none is running on that symbol (16 Nov: three gold SELLs in 45 minutes on one move, all stopped)
    intraday: {key:'intraday', base:900,  htf:3600,  valid:3600,  rr:[1.5, 3, 4.5], session:true,  maxBars:32,  eName:'M15', hName:'H1', one:true},
    swing:    {key:'swing',    base:3600, htf:14400, valid:14400, rr:[2, 4, 6],     session:false, maxBars:120, eName:'H1',  hName:'H4', daily:true},
    swing_v2:    {key:'swing_v2',    base:3600, htf:14400, valid:14400, rr:[2, 4, 6],     session:false, maxBars:120, eName:'H1',  hName:'H4', daily:true, xNeed:3, trigs:['engulf', 'momentum'], shadow:true, pub:true},
    // swing_v2h = swing_v2 + the pullback must sit in an H4 order block / FVG / IFVG of the trade side (smcHtf). SHADOW research.
    //   Backtest gold H1 (Twelve Data, spread included): swing_v2 signals WITH an H4 zone +0.93R n=137 vs WITHOUT +0.01R n=111 over 2 years;
    //   last year alone +0.86R n=55 vs -0.24R n=54. BTC did not improve (+0.09R vs +0.28R), nor did intraday with H1 zones. Gold first; forward-test before trusting.
    swing_v2h:   {key:'swing_v2h',   base:3600, htf:14400, valid:14400, rr:[2, 4, 6],     session:false, maxBars:120, eName:'H1',  hName:'H4', daily:true, xNeed:3, trigs:['engulf', 'momentum'], smcHtf:true, shadow:true, pub:true},
    // Extra Elite setups, SHADOW research (logged to ai_signals with their result, never posted, on the public symbols). Switch one on for members only after ~30+ signals hold up.
    //   brt = breakout + retest of an HTF swing level in the trend direction · lsr = liquidity sweep reversal at an HTF swing · srb = Asia-range breakout in London / New York
    intraday_brt: {key:'intraday_brt', base:900,  htf:3600,  valid:3600,  rr:[1.5, 3, 4.5], session:true,  maxBars:32,  eName:'M15', hName:'H1', setup:'brt', lvlAge:5 * 86400,  win:24, shadow:true, pub:true, one:true},
    intraday_lsr: {key:'intraday_lsr', base:900,  htf:3600,  valid:3600,  rr:[1.5, 3, 4.5], session:true,  maxBars:32,  eName:'M15', hName:'H1', setup:'lsr', lvlAge:5 * 86400,  shadow:true, pub:true, one:true},
    intraday_srb: {key:'intraday_srb', base:900,  htf:3600,  valid:3600,  rr:[1, 2, 3],     session:true,  maxBars:32,  eName:'M15', hName:'H1', setup:'srb', shadow:true, pub:true, one:true},
    swing_brt:    {key:'swing_brt',    base:3600, htf:14400, valid:14400, rr:[2, 4, 6],     session:false, maxBars:120, eName:'H1',  hName:'H4', daily:true, setup:'brt', lvlAge:20 * 86400, win:24, shadow:true, pub:true, one:true},
    swing_lsr:    {key:'swing_lsr',    base:3600, htf:14400, valid:14400, rr:[2, 4, 6],     session:false, maxBars:120, eName:'H1',  hName:'H4', daily:true, setup:'lsr', lvlAge:20 * 86400, shadow:true, pub:true, one:true},
    // MSNR (Malaysian SNR), SHADOW research: levels from the higher-timeframe LINE chart (closes only). msnr = first touch of a fresh A/V level in the storyline direction · qm = Quasimodo left-shoulder level
    intraday_msnr: {key:'intraday_msnr', base:900,  htf:3600,  valid:3600,  rr:[1.5, 3, 4.5], session:true,  maxBars:32,  eName:'M15', hName:'H1', setup:'msnr', lvlAge:5 * 86400,  shadow:true, pub:true, one:true},
    intraday_qm:   {key:'intraday_qm',   base:900,  htf:3600,  valid:3600,  rr:[1.5, 3, 4.5], session:true,  maxBars:32,  eName:'M15', hName:'H1', setup:'qm',   lvlAge:5 * 86400,  shadow:true, pub:true, one:true},
    swing_msnr:    {key:'swing_msnr',    base:3600, htf:14400, valid:14400, rr:[2, 4, 6],     session:false, maxBars:120, eName:'H1',  hName:'H4', daily:true, setup:'msnr', lvlAge:20 * 86400, shadow:true, pub:true, one:true},
    swing_qm:      {key:'swing_qm',      base:3600, htf:14400, valid:14400, rr:[2, 4, 6],     session:false, maxBars:120, eName:'H1',  hName:'H4', daily:true, setup:'qm',   lvlAge:20 * 86400, shadow:true, pub:true, one:true},
    // Classic chart patterns, SHADOW research: head & shoulders (+ inverse), triple / double top & bottom, ascending / descending / symmetrical triangle,
    // rising / falling wedge, bull / bear flag. Pivots on the entry timeframe. Intraday enters on the first retest of the broken line, swing on the breakout candle.
    // Backtest (after spread): all patterns together about break-even (M15 retest +0.13R n=30 gold / +0.07R n=37 BTC; H1 break −0.08R n=274 gold / −0.07R n=356 BTC).
    // Only candidate: BTC H1 symmetrical triangle breakout +0.39R n=82 (95% 0.03–0.77), but gold lost on the same pattern, so it must prove itself here first.
    intraday_pat:  {key:'intraday_pat',  base:900,  htf:3600,  valid:3600,  rr:[1.5, 3, 4.5], session:true,  maxBars:32,  eName:'M15', hName:'H1', setup:'pat', entry:'retest', patWin:160, patAge:24, shadow:true, pub:true, one:true},
    // SMC (Smart Money Concepts), SHADOW research: in the HTF trend direction, the first return into a fresh zone of that side
    // (bullish order block, bullish FVG, or a bearish FVG that price closed through = bullish IFVG; mirror for sells) and a close back out of it.
    intraday_smc:  {key:'intraday_smc',  base:900,  htf:3600,  valid:3600,  rr:[1.5, 3, 4.5], session:true,  maxBars:32,  eName:'M15', hName:'H1', setup:'smc', zAge:96, shadow:true, pub:true, one:true},
    swing_smc:     {key:'swing_smc',     base:3600, htf:14400, valid:14400, rr:[2, 4, 6],     session:false, maxBars:120, eName:'H1',  hName:'H4', daily:true, setup:'smc', zAge:120, shadow:true, pub:true, one:true},
    // ICT Silver Bullet, SHADOW research (M5 entry): inside the New York 10:00-11:00 or 14:00-15:00 hour (DST handled), price first takes the
    // liquidity of the previous sbLook candles (sell-side for buys, buy-side for sells), then displaces the other way and leaves a fair value gap;
    // the entry is the first return into that gap, stop beyond the sweep extreme. The H1 trend is recorded (feat.withBias), not required (sbBias:true requires it).
    // Backtest 24 Jun - 21 Nov 2026 (150 days, Twelve Data M5, spread included): gold n=49 -0.33R/trade (95% -0.55 to -0.10), with 1R/2R/3R targets and 6 h
    // -0.24R; BTC n=60 -0.00R (95% -0.28 to +0.27). NO EDGE on these rules: kept as a logged shadow mode only, never posted.
    intraday_sb:   {key:'intraday_sb',   base:300,  htf:3600,  valid:900,   rr:[1.5, 3, 4.5], session:false, maxBars:36,  eName:'M5',  hName:'H1', setup:'sb', sbWin:[[600, 660], [840, 900]], sbLook:24, sbPre:6, only:/^(XAUUSD|BTCUSD)$/, shadow:true, pub:true, one:true},
    // ICT liquidity sweep + market structure shift + OTE, SHADOW research (M15): in a killzone (New York 02:00-05:00 London, 07:00-10:00 New York),
    // price takes the low (high) of the last 32 candles, then within 12 candles closes beyond the last swing high (low) = MSS; the entry is the first
    // pullback into the 62-79% retracement (OTE) of the leg from the sweep extreme, stop beyond that extreme.
    intraday_mss:  {key:'intraday_mss',  base:900,  htf:3600,  valid:3600,  rr:[1.5, 3, 4.5], session:false, maxBars:32,  eName:'M15', hName:'H1', setup:'mss', kz:[[120, 300], [420, 600]], liqLook:32, mssWin:12, oteWait:8, only:/^(XAUUSD|BTCUSD)$/, shadow:true, pub:true, one:true},
    // ICT Judas swing (Power of 3), SHADOW research (M15): the Asia range is New York 19:00-00:00; in the London killzone (02:00-05:00 New York) price trades
    // beyond one side of it (the false move) and a candle closes back inside the range: trade the other way, stop beyond the false-move extreme.
    intraday_judas: {key:'intraday_judas', base:900, htf:3600, valid:3600, rr:[1.5, 3, 4.5], session:false, maxBars:32,  eName:'M15', hName:'H1', setup:'judas', only:/^(XAUUSD|BTCUSD)$/, shadow:true, pub:true, one:true},
    swing_pat:     {key:'swing_pat',     base:3600, htf:14400, valid:14400, rr:[2, 4, 6],     session:false, maxBars:120, eName:'H1',  hName:'H4', daily:true, setup:'pat', entry:'break', patWin:160, patAge:24, shadow:true, pub:true, one:true},
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

  // sym (optional): crypto (BTC…) trades 7 days a week, so the weekday check is skipped for it
  function prep(bars, htf, mode, sym){
    const M = MODES[mode] || MODES.m5;
    htf = htf && htf.length ? htf : agg(bars, M.htf, M.base, 1);
    const P = {M, m:bars, m5:bars, htf, m15:htf, allWeek:/^(BTC|ETH)/.test(String(sym || '')), sym:String(sym || '')};
    const c = bars.map(x => x.c), h = bars.map(x => x.h), l = bars.map(x => x.l);
    P.e20 = ema(c, 20); P.e50 = ema(c, 50); P.rsi = rsiF(c); P.atr = atrF(h, l, c);
    const hc = htf.map(x => x.c); P.h50 = ema(hc, 50); P.h200 = ema(hc, 200);
    if(M.daily){ P.d1 = agg(bars, 86400, M.base, 0.75); const dc = P.d1.map(x => x.c); P.dE = ema(dc, P.d1.length >= 60 ? 50 : 20); }
    if(M.v3 || M.sweep || M.setup) prepV3(P);
    if(M.setup === 'msnr' || M.setup === 'qm') prepLine(P);
    if(M.setup === 'pat') prepPat(P);
    if(M.smcHtf && !P.smcH){ P.hAtrS = atrF(htf.map(x => x.h), htf.map(x => x.l), htf.map(x => x.c)); P.smcH = smcZones(htf, P.hAtrS, {life:300}); }
    if(M.setup === 'mss' || M.setup === 'judas'){ P.ny = bars.map(b => nyMin(b.t));
      P.pvH = []; P.pvL = []; for(let j = 3; j < bars.length - 3; j++){ let hi = true, lo = true;
        for(let d = 1; d <= 3; d++){ if(!(bars[j].h > bars[j - d].h && bars[j].h >= bars[j + d].h)) hi = false; if(!(bars[j].l < bars[j - d].l && bars[j].l <= bars[j + d].l)) lo = false; }
        if(hi) P.pvH.push({i:j, p:bars[j].h, known:j + 3}); if(lo) P.pvL.push({i:j, p:bars[j].l, known:j + 3}); } }
    if(M.setup === 'sb'){ P.sbF = smcZones(bars, P.atr, {life:72, minGap:M.fvgMin == null ? .15 : M.fvgMin}).filter(z => z.kind === 'fvg'); P.ny = bars.map(b => nyMin(b.t)); }
    if(M.setup === 'smc') P.smc = smcZones(bars, P.atr, {life:M.zAge * 3});
    else if(!M.v3 && !M.sweep){ P.smc = smcZones(bars, P.atr, {life:400});   // research: tag classic A+ signals with SMC confluence (smcTag)
      const H = htf; P.hAtrS = atrF(H.map(x => x.h), H.map(x => x.l), H.map(x => x.c)); P.smcH = smcZones(H, P.hAtrS, {life:300}); }
    return P; }
  /* ---------- Classic chart patterns (entry timeframe) ----------
     Pivots: a high (low) above (below) the 3 candles on each side; known once the 3 right-hand candles have closed. Consecutive pivots on the same side
     keep the extreme, so the sequence alternates high / low. A pattern is read from the last 3–5 alternating pivots and must still be young (patAge candles). */
  function prepPat(P){
    const m = P.m, k = 3; P.pv = []; P.pe = {};
    for(let i = k; i < m.length - k; i++){
      let hi = true, lo = true;
      for(let j = 1; j <= k; j++){ if(!(m[i].h > m[i - j].h && m[i].h >= m[i + j].h)) hi = false; if(!(m[i].l < m[i - j].l && m[i].l <= m[i + j].l)) lo = false; }
      if(hi) P.pv.push({i, p:m[i].h, side:'H', known:i + k});
      if(lo) P.pv.push({i, p:m[i].l, side:'L', known:i + k});
    }
  }
  function patSeq(P, n){
    const M = P.M, out = [];
    for(const x of P.pv){ if(x.known > n) break; if(x.i < n - M.patWin) continue; const q = out[out.length - 1];
      if(q && q.side === x.side){ if(x.side === 'H' ? x.p >= q.p : x.p <= q.p) out[out.length - 1] = x; } else out.push(x); }
    return out;
  }
  // A pattern whose line is first CLOSED through on candle n -> {side, pat, line(x), stopBase, height} (cached)
  function patEvent(P, n){
    if(n in P.pe) return P.pe[n];
    const M = P.M, m = P.m, A = P.atr[n]; let ev = null;
    if(A && n > 30){
      const seq = patSeq(P, n), c = m[n].c, c1 = m[n - 1].c;
      const last = seq[seq.length - 1];
      if(last && n - last.i <= M.patAge){
        const s5 = seq.slice(-5), s4 = seq.slice(-4), s3 = seq.slice(-3);
        const brk = (L, f) => L ? c > f(n) + 0.05 * A && c1 <= f(n - 1) : c < f(n) - 0.05 * A && c1 >= f(n - 1);
        const quiet = (L, f, from) => { for(let x = from + 1; x < n; x++) if(L ? m[x].c > f(x) : m[x].c < f(x)) return false; return true; };
        const line = (a, b) => x => a.p + (b.p - a.p) * (x - a.i) / (b.i - a.i);
        // head & shoulders (top: H L H L H) / inverse (L H L H L): neckline through the two troughs (peaks)
        if(!ev && s5.length === 5 && s5[4].side === last.side){
          const top = last.side === 'H', [ls, t1, hd, t2, rs] = s5, nk = line(t1, t2), dir = top ? 1 : -1;
          if(dir * (hd.p - Math.max(dir * ls.p, dir * rs.p) * dir) >= 0.5 * A && Math.abs(ls.p - rs.p) <= 1.2 * A
             && dir * (ls.p - nk(ls.i)) >= A && dir * (rs.p - nk(rs.i)) >= A && brk(!top, nk) && quiet(!top, nk, rs.i))
            ev = {side:top ? 'SELL' : 'BUY', pat:top ? 'hs' : 'ihs', line:nk, stopBase:rs.p, height:Math.abs(hd.p - nk(hd.i))};
        }
        // triple top / bottom: three peaks (troughs) within 0.8 ATR, neckline = the lowest trough (highest peak) between them
        if(!ev && s5.length === 5 && s5[4].side === last.side){
          const top = last.side === 'H', pk = [s5[0], s5[2], s5[4]], tr = [s5[1], s5[3]];
          const ps = pk.map(x => x.p), spread = Math.max(...ps) - Math.min(...ps), nkP = top ? Math.min(tr[0].p, tr[1].p) : Math.max(tr[0].p, tr[1].p), nk = () => nkP;
          const ext = top ? Math.max(...ps) : Math.min(...ps);
          if(spread <= 0.8 * A && Math.abs(ext - nkP) >= 1.5 * A && brk(!top, nk) && quiet(!top, nk, s5[4].i))
            ev = {side:top ? 'SELL' : 'BUY', pat:top ? 'ttop' : 'tbot', line:nk, stopBase:ext, height:Math.abs(ext - nkP)};
        }
        // double top / bottom
        if(!ev && s3.length === 3 && s3[2].side === last.side){
          const top = last.side === 'H', [a, t, b] = s3, nkP = t.p, nk = () => nkP, ext = top ? Math.max(a.p, b.p) : Math.min(a.p, b.p);
          if(Math.abs(a.p - b.p) <= 0.5 * A && Math.abs(ext - nkP) >= 1.5 * A && b.i - a.i >= 8 && brk(!top, nk) && quiet(!top, nk, b.i))
            ev = {side:top ? 'SELL' : 'BUY', pat:top ? 'dtop' : 'dbot', line:nk, stopBase:ext, height:Math.abs(ext - nkP)};
        }
        // triangles, wedges, flags: lines through the last two pivot highs and the last two pivot lows
        if(!ev && s4.length === 4){
          const hs = s4.filter(x => x.side === 'H'), ls = s4.filter(x => x.side === 'L'), up = line(hs[0], hs[1]), lo = line(ls[0], ls[1]);
          const st = s4[0].i, span = n - st, w0 = up(st) - lo(st), w1 = up(n) - lo(n);
          let inside = span >= 10 && w0 >= 1.5 * A && w1 > 0.2 * A;
          for(let x = st + 1; inside && x < n; x++) if(m[x].c > up(x) + 0.3 * A || m[x].c < lo(x) - 0.3 * A) inside = false;
          if(inside){
            const du = (up(n) - up(st)) / A, dl = (lo(n) - lo(st)) / A, flat = v => Math.abs(v) < 0.6, conv = w1 < 0.8 * w0;
            let pat = null, dirs = [];
            if(flat(du) && dl >= 0.6){ pat = 'asctri'; dirs = ['BUY']; }
            else if(flat(dl) && du <= -0.6){ pat = 'desctri'; dirs = ['SELL']; }
            else if(du <= -0.6 && dl >= 0.6){ pat = 'symtri'; dirs = ['BUY', 'SELL']; }
            else if(du >= 0.6 && dl >= 0.6 && conv){ pat = 'risewedge'; dirs = ['SELL']; }
            else if(du <= -0.6 && dl <= -0.6 && conv){ pat = 'fallwedge'; dirs = ['BUY']; }
            else if(Math.abs(du - dl) < 0.6 && Math.abs(du) >= 0.6 && st >= 12){
              const pole = (m[st].c - m[st - 12].c) / A;
              if(pole >= 3 && du < 0){ pat = 'bullflag'; dirs = ['BUY']; } else if(pole <= -3 && du > 0){ pat = 'bearflag'; dirs = ['SELL']; }
            }
            for(const d of dirs){ const L = d === 'BUY', f = L ? up : lo;
              if(brk(L, f) && quiet(L, f, s4[3].i)){ const opp = [...s4].reverse().find(x => x.side === (L ? 'L' : 'H'));
                ev = {side:d, pat, line:f, stopBase:opp.p, height:w0}; break; } }
          }
        }
      }
    }
    if(ev) ev.n = n;
    P.pe[n] = ev; return ev;
  }
  // First retest of a line broken in the last 12 candles: price came back within 0.25 ATR (last 3 candles) without closing back through it, and this candle closes away
  function patRetest(P, i){
    const m = P.m, A = P.atr[i], tol = 0.25 * A, b = m[i];
    for(let k = i - 2; k >= Math.max(31, i - 12); k--){
      const ev = patEvent(P, k); if(!ev) continue;
      const L = ev.side === 'BUY', f = ev.line; let held = true, touch = false, ext = L ? Infinity : -Infinity;
      for(let x = k + 1; x <= i; x++){ ext = L ? Math.min(ext, m[x].l) : Math.max(ext, m[x].h);
        if(L ? m[x].c < f(x) - tol : m[x].c > f(x) + tol){ held = false; break; }
        if(x >= i - 3 && (L ? m[x].l <= f(x) + tol : m[x].h >= f(x) - tol)) touch = true; }
      for(let x = k + 1; held && x < i; x++){ const r = patEvent(P, x); if(r) held = false; }   // a newer pattern replaces it
      if(!held || !touch) continue;
      if(L ? b.c > f(i) && b.c > m[i - 1].c : b.c < f(i) && b.c < m[i - 1].c)
        return {...ev, stopBase:L ? Math.min(ext, f(i) - tol) : Math.max(ext, f(i) + tol), brkBars:i - k};
      return null;
    }
    return null;
  }
  /* MSNR line-chart levels on the higher timeframe, from CLOSES only (2 closes each side, known once the 2 right-hand candles have closed).
     A-level = peak of an A shape (resistance), V-level = bottom of a V shape (support). P.legs = alternating A / V turning points (QM structure). */
  function prepLine(P){
    const H = P.htf, step = P.M.htf; P.lv = []; P.legs = [];
    for(let k = 2; k < H.length - 2; k++){ const c = H[k].c, known = H[k + 2].t + step;
      if(c > H[k - 1].c && c > H[k - 2].c && c >= H[k + 1].c && c >= H[k + 2].c) P.lv.push({p:c, t:H[k].t, known, side:'A'});
      else if(c < H[k - 1].c && c < H[k - 2].c && c <= H[k + 1].c && c <= H[k + 2].c) P.lv.push({p:c, t:H[k].t, known, side:'V'}); }
    for(const x of P.lv){ const q = P.legs[P.legs.length - 1];
      if(q && q.side === x.side){ if(x.side === 'A' ? x.p >= q.p : x.p <= q.p) P.legs[P.legs.length - 1] = x; } else P.legs.push(x); }
  }
  // fresh = no entry candle has come within 0.1 ATR of the level since it was known (wick touches count); then candle i is the first touch
  function firstTouch(m, i, base, from, lvl, sup, tol){
    for(let k = i - 1; k >= 0 && m[k].t + base > from; k--) if(sup ? m[k].l <= lvl + tol : m[k].h >= lvl - tol) return false;
    return sup ? m[i].l <= lvl + tol : m[i].h >= lvl - tol;
  }
  // MSNR entry: the first touch is this candle (and it closes back on the right side) or the previous candle (which closed on the level or
  // slightly through it, not more than 0.5 ATR) and this candle closes back on the right side = touch, then reclaim.
  function touchReclaim(m, i, base, from, lvl, sup, A){
    const back = (k) => (sup ? m[k].c > lvl : m[k].c < lvl);
    if(!back(i)) return false;
    if(firstTouch(m, i, base, from, lvl, sup, 0.1 * A)) return true;
    return i > 0 && firstTouch(m, i - 1, base, from, lvl, sup, 0.1 * A) && !back(i - 1) && (sup ? m[i - 1].c >= lvl - 0.5 * A : m[i - 1].c <= lvl + 0.5 * A);
  }

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
    if(M.only && !M.only.test(P.sym)){ out.grade = 'n/a'; return out; }
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
    // Closing-price trigger (v4): uses ONLY the closes of the last candles, never open or wick shape (the gold / forex feeds' opens are unreliable).
    //   reclaim = the candle closes back on the trend side of the pullback level after a close on or beyond it in the last two candles
    //   thrust  = the candle closes beyond the highest (BUY) / lowest (SELL) close of the previous three candles
    // both need the close to move with the trend versus the previous close.
    const p = m[i - 1], c1 = p.c, c2 = m[i - 2].c, c3 = m[i - 3].c, rng = Math.max(b.h - b.l, 1e-9), body = Math.abs(b.c - b.o);   // rng / body are recorded as diagnostics only, not used to decide
    let trig = null;
    if(L && b.c > c1){ if(level != null && b.c >= level && Math.min(c1, c2) <= level + tol) trig = 'reclaim'; else if(!M.noMom && b.c > Math.max(c1, c2, c3)) trig = 'thrust'; }
    if(!L && b.c < c1){ if(level != null && b.c <= level && Math.max(c1, c2) >= level - tol) trig = 'reclaim'; else if(!M.noMom && b.c < Math.min(c1, c2, c3)) trig = 'thrust'; }
    add('trigger', !!trig, trig, true);
    // 5) Session: all sessions, weekdays (market open)
    const wd = new Date(closeT * 1000).getUTCDay(); add('session', P.allWeek || (wd >= 1 && wd <= 5), P.allWeek ? '24/7' : 'any', true);
    // 6) News lock
    const nz = news ? news(closeT) : true; add('news', nz === true, nz === null ? 'unknown' : null, true);
    // 7) Stop beyond the zone / swing: SL past the pullback extreme or the level, whichever is further; 0.3–1.5 × M5 ATR
    const base = level != null ? (L ? Math.min(ext, level - tol) : Math.max(ext, level + tol)) : ext;
    const entry = b.c, sl = L ? base - (M.stopPad || .1) * A5 : base + (M.stopPad || .1) * A5, risk = Math.abs(entry - sl);
    add('risk', risk >= (M.rMin ?? .3) * A5 && risk <= (M.rMax ?? 1.5) * A5 && (!M.minRiskUsd || risk >= M.minRiskUsd), +(risk / A5).toFixed(2), true);
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
    out.grade = coreOK && conf >= (M.confNeed ?? 2) && (!M.hours || M.hours.includes(new Date(closeT * 1000).getUTCHours())) ? 'A+' : coreOK && conf >= 1 ? 'A' : out.score >= 7 ? 'B' : 'C';
    if(out.grade === 'A+'){
      const R = L ? 1 : -1, dp = entry >= 100 ? 2 : 5, f = x => +x.toFixed(dp);
      out.signal = {side, entry:f(entry), sl:f(sl), tp1:f(entry + R * M.rr[0] * risk), tp2:f(entry + R * M.rr[1] * risk), tp3:null,
        risk:f(risk), t:closeT, validUntil:closeT + M.valid, trigger:trig, mode:M.key, rr:M.rr, maxBars:M.maxBars,
        feat:{lvl:zone ? 'SR' : onTl ? 'trendline' : 'retest', conf, zn:zone ? zone.n : 0, hr:new Date(closeT * 1000).getUTCHours(),
          riskA:+(risk / A5).toFixed(2), roomR:room == null ? null : +room.toFixed(1), slope:+(Math.abs(sl20) / A5).toFixed(2), str:+(Math.abs(hc - h50) / A5).toFixed(2),
          volR:+(A1 / A5).toFixed(3), body:+(body / rng).toFixed(2), dEma:+(Math.abs(b.c - e20) / A1).toFixed(2)}};
    }
    return out;
  }

  /* ---------- Liquidity sweep (experimental, BTC only) ----------
     Price spikes through a recent M1 swing high/low, then closes back inside with a long wick = failed break (stops got run).
     Backtest (BTCUSD, 20 days, $5 spread, path-correct exits): n=256, +0.02R/trade = NO PROVEN EDGE. Kept as a research mode, off by default. */
  function evalSweep(P, i, news){
    const M = P.M, m = P.m, b = m[i], closeT = b.t + M.base, A1 = P.atr[i];
    const out = {i, t:closeT, side:null, checks:[], grade:'—', signal:null, mode:M.key, max:M.keys.length};
    if((M.only && !M.only.test(P.sym)) || i < 80 || A1 == null){ out.grade = 'n/a'; return out; }
    const add = (key, pass, val, core) => out.checks.push({key, pass:!!pass, val, core});
    const PIV = 3, LOOK = 60, rng = Math.max(b.h - b.l, 1e-9), body = Math.abs(b.c - b.o);
    let side = null;
    for(let k = i - LOOK; k <= i - PIV - 1 && !side; k++){
      let isL = true, isH = true;
      for(let d = 1; d <= PIV; d++){ if(!(m[k].l < m[k - d].l && m[k].l <= m[k + d].l)) isL = false; if(!(m[k].h > m[k - d].h && m[k].h >= m[k + d].h)) isH = false; }
      if(isL && b.l < m[k].l && b.c > m[k].l && Math.min(b.o, b.c) - b.l >= .5 * rng && b.c > b.o) side = 'BUY';
      else if(isH && b.h > m[k].h && b.c < m[k].h && b.h - Math.max(b.o, b.c) >= .5 * rng && b.c < b.o) side = 'SELL';
    }
    out.side = side; add('sweep', !!side, side ? 'sweep' : null, true);
    if(!side){ out.grade = 'No setup'; return out; }
    const L = side === 'BUY', wd = new Date(closeT * 1000).getUTCDay(); add('session', P.allWeek || (wd >= 1 && wd <= 5), P.allWeek ? '24/7' : 'any', true);
    const nz = news ? news(closeT) : true; add('news', nz === true, nz === null ? 'unknown' : null, true);
    const entry = b.c, sl = L ? b.l - .1 * A1 : b.h + .1 * A1, risk = Math.abs(entry - sl);
    add('risk', risk >= M.minRiskPct * entry && risk <= 3 * A1, +(risk / A1).toFixed(2), true);   // spread must stay a small share of 1R; no giant stops
    // M5 trend context (informational: with-trend sweeps looked better but the sample was small and unstable)
    let j = -1; for(let k = P.htf.length - 1; k >= 0; k--){ if(P.htf[k].t + M.htf <= closeT){ j = k; break; } }
    let align = 0; if(j >= 55 && P.h50b[j] != null){ const hc = P.htf[j].c, h20 = P.h20[j], h50 = P.h50b[j], up = hc > h50 && h20 > h50 && h20 > P.h20[j - 3], dn = hc < h50 && h20 < h50 && h20 < P.h20[j - 3]; align = up ? 1 : dn ? -1 : 0; }
    out.score = out.checks.filter(x => x.pass).length;
    out.grade = out.checks.every(x => x.pass) ? 'A+' : 'C';
    if(out.grade === 'A+'){
      const R = L ? 1 : -1, dp = entry >= 100 ? 2 : 5, f = x => +x.toFixed(dp);
      out.signal = {side, entry:f(entry), sl:f(sl), tp1:f(entry + R * M.rr[0] * risk), tp2:f(entry + R * M.rr[1] * risk), tp3:null,
        risk:f(risk), t:closeT, validUntil:closeT + M.valid, trigger:'sweep', mode:M.key, rr:M.rr, maxBars:M.maxBars,
        feat:{lvl:'sweep', conf:1, zn:0, hr:new Date(closeT * 1000).getUTCHours(), riskA:+(risk / A1).toFixed(2), roomR:null, slope:0, str:0, volR:1, body:+(body / rng).toFixed(2), dEma:0, align}};
    }
    return out;
  }
  /* Feed sanity check (M1 data). Exchange/futures M1 candles open at the previous close; some aggregated spot feeds do not, and then
     wick rules (pin bar, engulfing, sweeps) are unreliable. Measured gap = mean |open - previous close| / mean candle range:
     BTC 0.00; Twelve Data gold 0.29 to 0.42; Twelve Data EURUSD 0.25 to 0.31. bad = gap > 0.15. Calibrated on 3 samples only: warn first, block only when enabled. */
  function feedQuality(bars, n = 300){
    const s = bars.slice(-n); if(s.length < 100) return {ok:true, gap:null, ext:null, n:s.length};
    let gap = 0, rs = 0, ext = 0;
    for(let k = 1; k < s.length; k++){ gap += Math.abs(s[k].o - s[k - 1].c); rs += s[k].h - s[k].l; if(s[k].o === s[k].h || s[k].o === s[k].l) ext++; }
    const g = rs > 0 ? gap / rs : 0, e = ext / (s.length - 1);
    return {ok:!(g > .15), gap:+g.toFixed(2), ext:+e.toFixed(2), n:s.length};
  }

  /* New York clock for the ICT windows: US daylight saving runs from the 2nd Sunday of March 07:00 UTC to the 1st Sunday of November 06:00 UTC.
     nyMin(t) = minutes after New York midnight at unix time t. */
  function usDst(t){ const y = new Date(t * 1000).getUTCFullYear(), m1 = new Date(Date.UTC(y, 2, 1)).getUTCDay(), n1 = new Date(Date.UTC(y, 10, 1)).getUTCDay();
    const start = Date.UTC(y, 2, 1 + (7 - m1) % 7 + 7, 7) / 1000, end = Date.UTC(y, 10, 1 + (7 - n1) % 7, 6) / 1000; return t >= start && t < end; }
  function nyMin(t){ return ((Math.floor(t / 60) + (usDst(t) ? -240 : -300)) % 1440 + 1440) % 1440; }
  const SESSION = {from:7, to:17};          // UTC hours = 14:00–24:00 Cambodia (London + New York)
  // Evaluate the CLOSED candle at index i. news(tSec) -> true (clear) | false (blocked) | null (unknown)
  // Higher-timeframe trend bias at closeT (same rule as Intraday / Swing: HTF close > EMA50 > EMA200 with EMA50 rising; swing also needs the daily close on the right side of its EMA)
  // structure = true (MSNR storyline): only EMA50 vs EMA200 and the EMA50 slope, so a deep pullback to a support level does not switch the story off
  function htfBias(P, closeT, structure){
    const M = P.M; let j = -1; for(let k = P.htf.length - 1; k >= 0; k--){ if(P.htf[k].t + M.htf <= closeT){ j = k; break; } }
    let side = null;
    if(j >= 3 && P.h200[j] != null){ const hc = P.htf[j].c, e50 = P.h50[j], e200 = P.h200[j], slope = e50 - P.h50[j - 3];
      if((structure || hc > e50) && e50 > e200 && slope > 0) side = 'BUY'; else if((structure || hc < e50) && e50 < e200 && slope < 0) side = 'SELL'; }
    if(side && M.daily && P.d1){ let d = -1; for(let k = P.d1.length - 1; k >= 0; k--){ if(P.d1[k].t + 86400 <= closeT){ d = k; break; } }
      if(d >= 0 && P.dE[d] != null){ const dc = P.d1[d].c; if((side === 'BUY' && dc < P.dE[d]) || (side === 'SELL' && dc > P.dE[d])) side = null; } }
    return side;
  }
  /* ---------- Extra setups (shadow research). Closes, highs and lows only, never opens. ----------
     brt: an HTF swing high (buys) / low (sells) in the trend direction was closed through within the last `win` entry candles; price came back to it
          (touch within 0.25 ATR in the last 3 candles) without closing back through; this candle closes away from it and beyond the previous close.
     lsr: this candle trades through an HTF swing low (buys) / high (sells) that is also the extreme of the last 48 entry candles, by at least 0.1 ATR,
          and closes back inside, after the previous close was inside.
          Counter-trend is allowed; the HTF bias is recorded in feat so it can be studied.
     srb: (intraday) the Asia range = 00:00–07:00 UTC; the first close beyond it between 07:00 and 16:00 UTC, stop at the middle of the range.
     msnr: MSNR storyline: the HTF trend sets the side; the first touch of a FRESH line-chart level (V-level for buys, A-level for sells) where this candle closes back on the right side.
     qm:   Quasimodo on the HTF line chart: low, high, lower low, higher high (or the mirror); the first return to the left-shoulder close (QML) with a close back on the right side.
     All: stop beyond the structure, risk 0.5–3 ATR (srb 0.5–4), session (intraday: London / New York), no high-impact USD news within ±30 min. */
  /* ---------- Smart Money Concepts zones (shared by the chart and the smc setup) ----------
     FVG  (fair value gap): candle k-1 and candle k+1 do not overlap. Bullish: low[k+1] > high[k-1], zone = high[k-1]..low[k+1]; bearish mirror.
          Known when candle k+1 closes. Gaps under minGap x ATR are ignored (noise).
     IFVG (inverse FVG): a candle CLOSES through an FVG's far side. From that candle the gap works the other way (bullish FVG -> bearish IFVG).
     OB   (order block): the last opposite-colour candle before a displacement: within 3 candles price closes beyond the high (low) of the 10 candles
          before it and the move from the OB's extreme is at least 1.5 ATR. Zone = that candle's high..low. Known when the displacement candle closes.
     For every zone: touch = first later candle that trades into it, brk = first later candle that CLOSES beyond its far side (the zone is spent).
     Only candles already closed at `known` are used, so a zone never looks into the future. */
  function smcZones(m, A, o){
    o = o || {}; const n = m.length, life = o.life || 400, minG = o.minGap == null ? 0.15 : o.minGap, W = o.obLook || 10, out = [];
    const track = (z, from) => { z.touch = -1; z.brk = -1;
      for(let k = from + 1; k < n && k <= from + life; k++){ const b = m[k];
        if(z.touch < 0 && (z.dir === 'bull' ? b.l <= z.top : b.h >= z.bot)) z.touch = k;
        if(z.dir === 'bull' ? b.c < z.bot : b.c > z.top){ z.brk = k; break; } }
      return z; };
    for(let k = 1; k < n - 1; k++){
      const a = A[k] || A[k + 1]; if(!a) continue; const p = m[k - 1], x = m[k + 1];
      if(x.l - p.h >= minG * a) out.push(track({kind:'fvg', dir:'bull', top:x.l, bot:p.h, i:k - 1, known:k + 1}, k + 1));
      else if(p.l - x.h >= minG * a) out.push(track({kind:'fvg', dir:'bear', top:p.l, bot:x.h, i:k - 1, known:k + 1}, k + 1));
    }
    for(const z of out.slice()) if(z.brk > 0) out.push(track({kind:'ifvg', dir:z.dir === 'bull' ? 'bear' : 'bull', top:z.top, bot:z.bot, i:z.i, known:z.brk}, z.brk));
    for(let k = W; k < n - 1; k++){
      const c = m[k], a = A[k], nx = m[k + 1]; if(!a) continue;
      if(c.c < c.o && nx.c > nx.o){ let hi = -Infinity; for(let q = k - W; q < k; q++) hi = Math.max(hi, m[q].h);
        for(let q = k + 1; q <= Math.min(k + 3, n - 1); q++) if(m[q].c > hi && m[q].c - c.l >= 1.5 * a){ out.push(track({kind:'ob', dir:'bull', top:c.h, bot:c.l, i:k, known:q}, q)); break; } }
      else if(c.c > c.o && nx.c < nx.o){ let lo = Infinity; for(let q = k - W; q < k; q++) lo = Math.min(lo, m[q].l);
        for(let q = k + 1; q <= Math.min(k + 3, n - 1); q++) if(m[q].c < lo && c.h - m[q].c >= 1.5 * a){ out.push(track({kind:'ob', dir:'bear', top:c.h, bot:c.l, i:k, known:q}, q)); break; } }
    }
    return out.sort((a, b) => a.known - b.known);
  }
  // zones still alive after candle `at` (known by then, not closed through yet); newest first
  function smcActive(Z, at){ return Z.filter(z => z.known <= at && (z.brk < 0 || z.brk > at)).sort((a, b) => b.known - a.known); }
  /* Research tag (bt-feed only): which SMC zones of the trade side were alive at candle i and held the pullback extreme `ext`:
     the extreme reached into the zone (within 0.1 ATR of its near edge) without going more than 0.5 ATR past its far side. Returns e.g. 'fvg+ob' or null.
     Result (20 Nov 2026, Twelve Data, spread included; avg R with a zone vs without): swing gold 2y +0.60 n=55 vs +0.23 n=8 · swing BTC +0.24 n=78 vs +0.57 n=12 ·
     swing_v2 gold +0.55 n=205 vs +0.38 n=43 · swing_v2 BTC +0.08 n=264 vs +0.47 n=63 · intraday_v2 gold 1y -0.11 n=244 vs +0.11 n=34 · BTC +0.12 n=304 vs +0.36 n=52.
     80-90 % of A+ pullbacks already sit in such a zone, and the ones that do were NOT better in 5 of 6 tests (all intervals overlap): no SMC filter added to A+. */
  function smcTag(P, i, L, ext, A){
    if(!P.smc) return null; const want = L ? 'bull' : 'bear', got = new Set();
    for(const z of P.smc){ if(z.known > i - 1) break;
      if(z.dir !== want || (z.brk >= 0 && z.brk <= i) || z.known < i - 200) continue;
      if(L ? ext <= z.top + 0.1 * A && ext >= z.bot - 0.5 * A : ext >= z.bot - 0.1 * A && ext <= z.top + 0.5 * A) got.add(z.kind); }
    return got.size ? [...got].sort().join('+') : null;
  }
  /* Stricter research tags (bt-feed only).
     smcTagHtf: zones found on the HIGHER timeframe (H1 for intraday, H4 for swing), known and not closed through by this candle's close time.
     smcTagFresh: entry-timeframe zones whose FIRST touch is part of this pullback (first touch within the last 6 candles). */
  function smcTagHtf(P, closeT, L, ext, A){
    if(!P.smcH) return null; const H = P.htf, st = P.M.htf, want = L ? 'bull' : 'bear', got = new Set();
    for(const z of P.smcH){ if(H[z.known].t + st > closeT) break;
      if(z.dir !== want || (z.brk >= 0 && H[z.brk].t + st <= closeT) || H[z.known].t < closeT - 200 * st) continue;
      if(L ? ext <= z.top + 0.1 * A && ext >= z.bot - 0.5 * A : ext >= z.bot - 0.1 * A && ext <= z.top + 0.5 * A) got.add(z.kind); }
    return got.size ? [...got].sort().join('+') : null;
  }
  function smcTagFresh(P, i, L, ext, A){
    if(!P.smc) return null; const want = L ? 'bull' : 'bear', got = new Set();
    for(const z of P.smc){ if(z.known > i - 1) break;
      if(z.dir !== want || (z.brk >= 0 && z.brk <= i) || z.known < i - 200 || z.touch < i - 6 || z.touch > i) continue;
      if(L ? ext <= z.top + 0.1 * A && ext >= z.bot - 0.5 * A : ext >= z.bot - 0.1 * A && ext <= z.top + 0.5 * A) got.add(z.kind); }
    return got.size ? [...got].sort().join('+') : null;
  }
  function evalSetup(P, i, news){
    const M = P.M, m = P.m, b = m[i], closeT = b.t + M.base, A = P.atr[i];
    const out = {i, t:closeT, side:null, checks:[], grade:'—', signal:null, mode:M.key};
    if(i < 120 || A == null || P.e50[i] == null){ out.grade = 'n/a'; return out; }
    const add = (key, pass, val, core) => out.checks.push({key, pass:!!pass, val, core});
    const bias = htfBias(P, closeT, M.setup === 'msnr'), tol = 0.25 * A, feat = {setup:M.setup, bias:bias || 'range'};
    let side = null, stopBase = null, maxRisk = 3;
    if(M.setup === 'brt' && bias){
      const L = bias === 'BUY', lv = P.sw.filter(s => s.known <= closeT && s.side === (L ? 'H' : 'L') && s.t >= closeT - M.lvlAge).reverse();
      for(const s of lv){
        let bk = -1; for(let k = Math.max(1, i - M.win); k < i; k++){ if(m[k].t + M.base <= s.known) continue; if(L ? m[k].c > s.p && m[k - 1].c <= s.p : m[k].c < s.p && m[k - 1].c >= s.p){ bk = k; break; } }
        if(bk < 0) continue;
        let held = true, ext = L ? Infinity : -Infinity, fresh = false;
        for(let k = bk + 1; k <= i; k++){ ext = L ? Math.min(ext, m[k].l) : Math.max(ext, m[k].h); if(L ? m[k].c < s.p - tol : m[k].c > s.p + tol){ held = false; break; }
          if(k >= i - 3 && (L ? m[k].l <= s.p + tol : m[k].h >= s.p - tol)) fresh = true; }
        if(!held || !fresh) continue;
        if(L ? b.c > s.p && b.c > m[i - 1].c : b.c < s.p && b.c < m[i - 1].c){ side = bias; stopBase = L ? Math.min(ext, s.p - tol) : Math.max(ext, s.p + tol); feat.lvlAgeH = +((closeT - s.t) / 3600).toFixed(1); feat.brkBars = i - bk; break; }
      }
    }
    if(M.setup === 'lsr'){
      const lv = P.sw.filter(s => s.known <= closeT && s.t >= closeT - M.lvlAge).reverse();
      for(const s of lv){
        const L = s.side === 'L';
        // liquidity sits at the obvious extreme: the swing must be the low (buys) / high (sells) of the previous 48 entry candles
        let ex = L ? Infinity : -Infinity; for(let k = Math.max(0, i - 48); k < i; k++) ex = L ? Math.min(ex, m[k].l) : Math.max(ex, m[k].h);
        if(L ? ex < s.p - 0.1 * A : ex > s.p + 0.1 * A) continue;
        if(L ? m[i - 1].c > s.p && b.l < s.p - 0.1 * A && b.c > s.p : m[i - 1].c < s.p && b.h > s.p + 0.1 * A && b.c < s.p){
          side = L ? 'BUY' : 'SELL'; stopBase = L ? b.l : b.h; feat.sweepA = +((L ? s.p - b.l : b.h - s.p) / A).toFixed(2); feat.lvlAgeH = +((closeT - s.t) / 3600).toFixed(1); feat.withBias = bias === side; break; }
      }
    }
    if(M.setup === 'srb'){
      maxRisk = 4;
      const day0 = Math.floor(b.t / 86400) * 86400, hr = (b.t + M.base - day0) / 3600;
      if(hr > 7 && hr <= 16){
        let hi = -Infinity, lo = Infinity, nA = 0, broke = false;
        for(let k = i - 1; k >= 0 && m[k].t >= day0; k--){ if(m[k].t < day0 + 7 * 3600){ hi = Math.max(hi, m[k].h); lo = Math.min(lo, m[k].l); nA++; } }
        if(nA >= 20){
          for(let k = i - 1; k >= 0 && m[k].t >= day0 + 7 * 3600; k--) if(m[k].c > hi || m[k].c < lo) broke = true;   // first break of the day only
          const w = hi - lo;
          if(!broke && w >= 2 * A && w <= 12 * A){
            if(b.c > hi){ side = 'BUY'; stopBase = (hi + lo) / 2; } else if(b.c < lo){ side = 'SELL'; stopBase = (hi + lo) / 2; }
            feat.rangeA = +(w / A).toFixed(2); feat.withBias = !!side && bias === side;
          }
        }
      }
    }
    if(M.setup === 'msnr' && bias){
      const sup = bias === 'BUY', lv = P.lv.filter(s => s.known <= closeT && s.side === (sup ? 'V' : 'A') && s.t >= closeT - M.lvlAge && (sup ? s.p < b.c : s.p > b.c)).reverse();
      for(const s of lv){
        if(touchReclaim(m, i, M.base, s.known, s.p, sup, A)){
          side = bias; stopBase = sup ? Math.min(s.p, b.l, m[i - 1].l) : Math.max(s.p, b.h, m[i - 1].h); feat.lvl = s.side; feat.lvlAgeH = +((closeT - s.t) / 3600).toFixed(1); break; }
      }
    }
    if(M.setup === 'pat'){
      maxRisk = 4;
      const ev = M.entry === 'break' ? patEvent(P, i) : patRetest(P, i);
      if(ev){ side = ev.side; stopBase = ev.stopBase; feat.pat = ev.pat; feat.mmA = +(ev.height / A).toFixed(2); feat.mm = ev.height; feat.withBias = bias === side; if(ev.brkBars) feat.brkBars = ev.brkBars; }
    }
    // smc: first return into a fresh zone of the trend side (formed within zAge candles, not touched before the last 3 candles, not closed through),
    // this candle closes back out of it: above the zone middle and up on the candle and on the previous close (mirror for sells). Stop beyond the zone.
    if(M.setup === 'smc' && bias && P.smc){
      const L = bias === 'BUY', want = L ? 'bull' : 'bear';
      for(const z of P.smc){
        if(z.dir !== want || z.known > i - 1 || z.known < i - M.zAge || (z.brk >= 0 && z.brk <= i) || z.touch < 0 || z.touch > i || z.touch < i - 3) continue;
        const mid = (z.top + z.bot) / 2;
        if(L ? b.c > mid && b.c > b.o && b.c > m[i - 1].c : b.c < mid && b.c < b.o && b.c < m[i - 1].c){
          let ext = L ? z.bot : z.top; for(let k = z.touch; k <= i; k++) ext = L ? Math.min(ext, m[k].l) : Math.max(ext, m[k].h);
          side = bias; stopBase = ext; feat.zone = z.kind; feat.zoneA = +((z.top - z.bot) / A).toFixed(2); feat.zAge = i - z.known; break;
        }
      }
    }
    /* sb (ICT Silver Bullet): this candle is inside a window (New York time). Within the window (or sbPre candles before it) price traded beyond the
       low (buys) / high (sells) of the sbLook candles before that = liquidity taken; after the sweep a fair value gap of the other side formed
       inside the window; this candle is the FIRST return into the gap and closes back on the gap's side (not through its far edge). Stop beyond the sweep extreme. */
    if(M.setup === 'sb' && P.sbF && (!M.only || M.only.test(P.sym))){
      const nm = P.ny[i], win = (M.sbWin || []).find(w => nm >= w[0] && nm < w[1]);
      if(win){
        const ws = b.t - (nm - win[0]) * 60, iw = i - Math.round((b.t - ws) / M.base), from = Math.max(M.sbLook + 1, iw - (M.sbPre || 0));
        for(let q = P.sbF.length - 1; q >= 0; q--){
          const z = P.sbF[q]; if(z.known > i - 1) continue; if(m[z.i + 1].t < ws) break;   // the displacement candle must be inside the window
          if(z.touch !== i || (z.brk >= 0 && z.brk <= i)) continue;
          const L = z.dir === 'bull';
          let liq = L ? Infinity : -Infinity; for(let k = from - M.sbLook; k < from; k++) liq = L ? Math.min(liq, m[k].l) : Math.max(liq, m[k].h);
          let ext = L ? Infinity : -Infinity, swept = false;
          for(let k = from; k <= z.i; k++){ ext = L ? Math.min(ext, m[k].l) : Math.max(ext, m[k].h); if(L ? m[k].l < liq : m[k].h > liq) swept = true; }
          for(let k = z.i + 1; k <= i; k++) ext = L ? Math.min(ext, m[k].l) : Math.max(ext, m[k].h);
          if(!swept || (L ? b.c < z.bot : b.c > z.top)) continue;
          if(M.sbBias && bias !== (L ? 'BUY' : 'SELL')) continue;
          side = L ? 'BUY' : 'SELL'; stopBase = ext; maxRisk = M.maxRiskA || 4;
          feat.win = win[0] / 60; feat.gapA = +((z.top - z.bot) / A).toFixed(2); feat.sweepA = +((L ? liq - ext : ext - liq) / A).toFixed(2); feat.withBias = bias === side; feat.fvgAge = i - z.known;
          break;
        }
      }
    }
    /* mss (ICT sweep + MSS + OTE): sweep candle s in a killzone takes the extreme of the liqLook candles before it; within mssWin candles a candle k closes
       beyond the last swing point formed before k on the other side (market structure shift); this candle i (at most oteWait candles after k) is the FIRST
       to reach the 62% retracement of the leg (sweep extreme -> extreme since k) and closes back above (buys) the 79% level. Stop beyond the sweep extreme. */
    if(M.setup === 'mss' && P.pvH && (!M.only || M.only.test(P.sym))){
      for(let k = i - 1; k >= Math.max(M.liqLook + 2, i - M.oteWait) && !side; k--){
        for(const L of [true, false]){
          const pv = L ? P.pvH : P.pvL; let lvl = null;
          for(let q = pv.length - 1; q >= 0; q--) if(pv[q].known <= k - 1){ lvl = pv[q]; break; }
          if(!lvl || (L ? !(m[k].c > lvl.p && m[k - 1].c <= lvl.p) : !(m[k].c < lvl.p && m[k - 1].c >= lvl.p))) continue;
          let s = -1;
          for(let q = k - 1; q >= Math.max(M.liqLook, k - M.mssWin); q--){
            const kzw = (M.kz || []).find(w => P.ny[q] >= w[0] && P.ny[q] < w[1]); if(!kzw) continue;
            let ex = L ? Infinity : -Infinity; for(let r = q - M.liqLook; r < q; r++) ex = L ? Math.min(ex, m[r].l) : Math.max(ex, m[r].h);
            if(L ? m[q].l < ex : m[q].h > ex){ s = q; feat.win = kzw[0] / 60; break; }
          }
          if(s < 0 || lvl.i < s - 20) continue;
          let lo = Infinity, hiL = -Infinity; for(let q = s; q <= k; q++){ lo = Math.min(lo, m[q].l); hiL = Math.max(hiL, m[q].h); }
          let ext2 = L ? -Infinity : Infinity; for(let q = k; q < i; q++) ext2 = L ? Math.max(ext2, m[q].h) : Math.min(ext2, m[q].l);
          const a0 = L ? lo : hiL, rng = Math.abs(ext2 - a0); if(rng < A) continue;
          const o62 = L ? ext2 - .62 * rng : ext2 + .62 * rng, o79 = L ? ext2 - .79 * rng : ext2 + .79 * rng;
          let early = false; for(let q = k + 1; q < i; q++) if(L ? m[q].l <= o62 : m[q].h >= o62) early = true;
          if(early || (L ? b.l > o62 : b.h < o62) || (L ? b.c < o79 : b.c > o79)) continue;
          side = L ? 'BUY' : 'SELL'; stopBase = a0; maxRisk = 4; feat.legA = +(rng / A).toFixed(2); feat.withBias = bias === side; break;
        }
      }
    }
    /* judas (ICT Power of 3): Asia range = New York 19:00-00:00 (needs 12+ candles). In the London killzone (02:00-05:00 New York) price traded beyond one side
       of it and this candle closes back inside the range (first time today): fade it. Stop beyond the false-move extreme. */
    if(M.setup === 'judas' && P.ny && (!M.only || M.only.test(P.sym))){
      const nm = P.ny[i];
      if(nm >= 120 && nm < 300){
        let hi = -Infinity, lo = Infinity, nA = 0;
        for(let k = i - 1; k >= Math.max(0, i - 48); k--){ const t = P.ny[k]; if(t >= 300 && t < 1140) break; if(t >= 1140){ hi = Math.max(hi, m[k].h); lo = Math.min(lo, m[k].l); nA++; } }   // walk back through London / pre-London to the Asia candles
        if(nA >= 12 && hi - lo >= A){
          let upX = -Infinity, dnX = Infinity, back = false;
          for(let k = i - 1; k >= 0 && P.ny[k] >= 120 && P.ny[k] < 300; k--){ upX = Math.max(upX, m[k].h); dnX = Math.min(dnX, m[k].l); }
          for(let k = i - 1; k >= 1 && P.ny[k] >= 120 && P.ny[k] < 300; k--) if((upX > hi || dnX < lo) && m[k].c <= hi && m[k].c >= lo && (m[k - 1].c > hi || m[k - 1].c < lo)) back = true;
          upX = Math.max(upX, b.h); dnX = Math.min(dnX, b.l);
          if(!back && b.c <= hi && b.c >= lo){
            if(upX > hi && m[i - 1].c > hi && !(dnX < lo)){ side = 'SELL'; stopBase = upX; }
            else if(dnX < lo && m[i - 1].c < lo && !(upX > hi)){ side = 'BUY'; stopBase = dnX; }
            if(side){ maxRisk = 4; feat.rangeA = +((hi - lo) / A).toFixed(2); feat.win = 2; feat.withBias = bias === side; }
          }
        }
      }
    }
    if(M.setup === 'qm'){
      const legs = P.legs.filter(x => x.known <= closeT);
      if(legs.length >= 4){
        const [a, b2, c, d] = legs.slice(-4);
        // bullish QM: V a, A b2, lower V c (breaks a), higher A d (breaks b2) -> buy the return to a.  bearish: mirror -> sell the return to a.
        const bull = a.side === 'V' && c.p < a.p && d.p > b2.p, bear = a.side === 'A' && c.p > a.p && d.p < b2.p;
        if((bull || bear) && d.known >= closeT - M.lvlAge && touchReclaim(m, i, M.base, d.known, a.p, bull, A)){
          side = bull ? 'BUY' : 'SELL'; stopBase = bull ? Math.min(a.p, b.l, m[i - 1].l) : Math.max(a.p, b.h, m[i - 1].h); feat.qml = a.p; feat.withBias = bias === side; feat.lvlAgeH = +((closeT - a.t) / 3600).toFixed(1); }
      }
    }
    out.side = side; const L = side === 'BUY';
    add('bias', (M.setup !== 'brt' && M.setup !== 'msnr' && M.setup !== 'smc') || !!bias, bias || 'range', true);
    add('setup', !!side, side ? M.setup : null, true);
    if(!side){ out.grade = 'No setup'; return out; }
    const d = new Date(closeT * 1000), hr = d.getUTCHours() + d.getUTCMinutes() / 60, wd = d.getUTCDay();
    add('session', (P.allWeek || (wd >= 1 && wd <= 5)) && (!M.session || (hr >= SESSION.from && hr < SESSION.to)), M.session ? null : 'any', true);
    const nz = news ? news(closeT) : true;
    add('news', nz === true, nz === null ? 'unknown' : null, true);
    const pad = M.setup === 'sb' || M.setup === 'mss' || M.setup === 'judas' ? (M.sbPad == null ? 0.1 : M.sbPad) : 0.25, entry = b.c, sl = M.setup === 'srb' ? stopBase : L ? stopBase - pad * A : stopBase + pad * A, risk = Math.abs(entry - sl);
    add('risk', (L ? sl < entry : sl > entry) && risk >= 0.5 * A && risk <= maxRisk * A, +(risk / A).toFixed(2), true);
    out.score = out.checks.filter(x => x.pass).length; out.max = out.checks.length;
    out.grade = out.checks.every(x => x.pass) ? 'A+' : 'C';
    if(out.grade === 'A+'){
      const R = L ? 1 : -1, dp = entry >= 100 ? 2 : 5, f = x => +x.toFixed(dp);
      out.signal = {side, entry:f(entry), sl:f(sl), tp1:f(entry + R * M.rr[0] * risk), tp2:f(entry + R * M.rr[1] * risk), tp3:f(entry + R * M.rr[2] * risk),
        risk:f(risk), t:closeT, validUntil:closeT + M.valid, trigger:M.setup, mode:M.key, rr:M.rr, maxBars:M.maxBars,
        feat:{...feat, riskA:+(risk / A).toFixed(2), hr:d.getUTCHours()}};
    }
    return out;
  }
  function evalAt(P, i, news){
    if(P.M && P.M.setup) return evalSetup(P, i, news);
    if(P.M && P.M.sweep) return evalSweep(P, i, news);
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
    if(trig && M.trigs && !M.trigs.includes(trig)) trig = null;
    add('trigger', !!trig, trig, true);
    // 5) Session: London / New York for scalping & intraday; any weekday session for swing
    const d = new Date(closeT * 1000), hr = d.getUTCHours() + d.getUTCMinutes() / 60, wd = d.getUTCDay();
    add('session', (P.allWeek || (wd >= 1 && wd <= 5)) && (!M.session || (hr >= SESSION.from && hr < SESSION.to)), M.session ? null : 'any', true);
    // 6) No high-impact USD news within ±30 min
    const nz = news ? news(closeT) : true;
    add('news', nz === true, nz === null ? 'unknown' : null, true);
    // 7) Risk: stop beyond the pullback extreme (+0.25 ATR); must be between 0.8 and 3 ATR
    const entry = b.c, sl = L ? ext - (M.pad ?? 0.25) * A : ext + (M.pad ?? 0.25) * A, risk = Math.abs(entry - sl);
    add('risk', risk >= (M.rMin ?? 0.8) * A && risk <= (M.rMax ?? 3) * A, +(risk / A).toFixed(2), true);
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
    if(M.smcHtf){ const zt = smcTagHtf(P, closeT, L, ext, A); add('smc', !!zt, zt, true); }   // core check: required for A+

    const core = out.checks.filter(x => x.core), extra = out.checks.filter(x => !x.core);
    const coreOK = core.every(x => x.pass), extraN = extra.filter(x => x.pass).length;
    out.score = out.checks.filter(x => x.pass).length; out.max = out.checks.length;
    out.grade = coreOK && extraN >= (M.xNeed ?? extra.length) && (!M.xMust || M.xMust.every(k => extra.find(x => x.key === k && x.pass))) ? 'A+' : coreOK && extraN >= 2 ? 'A' : out.score >= 7 ? 'B' : 'C';
    if(out.grade === 'A+'){
      const R = L ? 1 : -1, dp = entry >= 100 ? 2 : 5, f = x => +x.toFixed(dp);
      out.signal = {side, entry:f(entry), sl:f(sl), tp1:f(entry + R * M.rr[0] * risk), tp2:f(entry + R * M.rr[1] * risk), tp3:f(entry + R * M.rr[2] * risk),
        risk:f(risk), t:closeT, validUntil:closeT + M.valid, trigger:trig, mode:M.key, rr:M.rr, maxBars:M.maxBars, feat:{smc:smcTag(P, i, L, ext, A), smcH:smcTagHtf(P, closeT, L, ext, A), smcF:smcTagFresh(P, i, L, ext, A)}};
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
    const gap = P.M && (P.M.v3 || P.M.sweep) ? 10 : 6;
    for(let i = 120; i < P.m.length; i++){
      const r = evalAt(P, i, news);
      if(r.signal && i - last > gap){ out.push({i, ...r.signal, out:simulate(P.m, i, r.signal)}); last = i; }
    }
    return out;
  }
  return {prep, evalAt, simulate, scan, toM15, agg, feedQuality, smcZones, smcActive, nyMin, MODES};
})();

export default AiEng;
