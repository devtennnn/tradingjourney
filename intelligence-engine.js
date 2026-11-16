/* AROM Intelligence: eight analysis modules + weighted scoring + reasoning.
   Pure JavaScript, no dependencies, runs in the browser (window.AromIntel) and in Node (tests).

   INPUT  AromIntel.analyze({symbol, style, tf:{m1,m5,m15,h1}, news, now})
          candles are [{t (unix s), o, h, l, c, v?}] oldest → newest. h4 and d1 are built here from h1.
   OUTPUT { modules:{...}, parts:[...], composite, decision, plan, reasoning, levels, ... }

   HONESTY: the weights below are an engineering hypothesis (not a proven profitable formula). Modules that lack data
   (e.g. order flow on FX, where there is no real volume) are marked unavailable and left out of the score instead of being guessed.
   Output is analysis, not financial advice. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AromIntel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- configuration (every threshold lives here so it can be tuned and tested) ---------- */
  const WEIGHTS = { structure: 20, liquidity: 15, smc: 20, ema_rsi: 10, fib: 5, orderflow: 10, fundamental: 10, mtf: 10 };
  const CFG = {
    pivotExt: 5, pivotInt: 2, pivotMtf: 3,
    dispBody: 1.5,            // displacement candle: body >= 1.5 ATR
    fvgMin: 0.1,              // smallest FVG = 0.1 ATR
    eqTol: 0.15,              // equal highs/lows within 0.15 ATR
    sweepLookback: 30,
    minCoverage: 0.6,         // share of weight that must have real data
    minScore: 25,             // |composite| below this = no edge → WAIT
    conflictMax: 0.30,        // opposing evidence share above this → WAIT
    gradeA: 60, gradeB: 45,
    minRR: 1.5,
    newsHighMin: 30,          // high-impact event inside 30 min → WAIT
  };
  const LADDER = ['d1', 'h4', 'h1', 'm15', 'm5', 'm1'];
  const STYLES = { swing: 0, intraday: 1, scalp: 2 };          // index of the macro rung in LADDER
  const MTF_W = [0.35, 0.30, 0.20, 0.15];
  const STEP = { m1: 60, m5: 300, m15: 900, h1: 3600, h4: 14400, d1: 86400 };

  const clamp = (x, a = -1, b = 1) => Math.max(a, Math.min(b, x));
  const sgn = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
  const bars = (n) => n + (n === 1 ? ' bar' : ' bars');
  const last = (a) => a[a.length - 1];
  const r2 = (x) => Math.round(x * 100) / 100;
  const fx = (p, ref) => { const d = ref >= 1000 ? 1 : ref >= 100 ? 2 : ref >= 10 ? 3 : 5; return +Number(p).toFixed(d); };

  /* ---------- indicators ---------- */
  function ema(a, n) {
    const k = 2 / (n + 1), o = new Array(a.length).fill(null); let p = null;
    for (let i = 0; i < a.length; i++) {
      if (i < n - 1) continue;
      if (p === null) { let s = 0; for (let j = i - n + 1; j <= i; j++) s += a[j]; p = s / n; } else p = a[i] * k + p * (1 - k);
      o[i] = p;
    }
    return o;
  }
  function rsi(c, n = 14) {
    const o = new Array(c.length).fill(null); let g = 0, l = 0;
    for (let i = 1; i < c.length; i++) {
      const d = c[i] - c[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
      if (i <= n) { g += up; l += dn; if (i === n) { g /= n; l /= n; o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } continue; }
      g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    }
    return o;
  }
  function atr(b, n = 14) {
    const o = new Array(b.length).fill(null); let a = 0;
    for (let i = 1; i < b.length; i++) {
      const tr = Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
      if (i <= n) { a += tr; if (i === n) { a /= n; o[i] = a; } continue; }
      a = (a * (n - 1) + tr) / n; o[i] = a;
    }
    return o;
  }
  /** Aggregate candles to a higher timeframe; a bucket is kept when it has at least `minBars` candles. */
  function agg(bars, step, minBars) {
    const out = []; let cur = null;
    for (const b of bars) {
      const k = Math.floor(b.t / step) * step;
      if (!cur || cur.t !== k) { if (cur) out.push(cur); cur = { t: k, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0, n: 1 }; }
      else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v || 0; cur.n++; }
    }
    if (cur) out.push(cur);
    return out.filter((x) => x.n >= minBars).map(({ n, ...rest }) => rest);
  }

  /* ---------- swing points ---------- */
  /** Pivot = a bar whose high (low) is the highest (lowest) of k bars on each side. Known only k bars later. */
  function pivots(b, k) {
    const hs = [], ls = [];
    for (let i = k; i < b.length - k; i++) {
      let isH = true, isL = true;
      for (let j = 1; j <= k; j++) {
        if (b[i - j].h >= b[i].h || b[i + j].h > b[i].h) isH = false;
        if (b[i - j].l <= b[i].l || b[i + j].l < b[i].l) isL = false;
        if (!isH && !isL) break;
      }
      if (isH) hs.push({ i, p: b[i].h });
      if (isL) ls.push({ i, p: b[i].l });
    }
    return { hs, ls };
  }

  /* ---------- 01 Market structure ---------- */
  /** Walks the candles once. A pivot becomes known k bars after it formed. A CLOSE beyond the last known swing is a break:
      with the trend = BOS, against it = CHoCH. A CHoCH made by a displacement candle (body >= 1.5 ATR) is called MSS. */
  function structure(b, k, A) {
    const { hs, ls } = pivots(b, k);
    const ev = []; let trend = 0, lastH = null, lastL = null, hi = 0, li = 0;
    const labels = [];
    for (let j = 0; j < b.length; j++) {
      while (hi < hs.length && hs[hi].i + k <= j) { lastH = { ...hs[hi], broken: false }; hi++; }
      while (li < ls.length && ls[li].i + k <= j) { lastL = { ...ls[li], broken: false }; li++; }
      const c = b[j].c, a = A[j] || A[j - 1] || (b[j].h - b[j].l) || 1;
      const disp = Math.abs(b[j].c - b[j].o) >= CFG.dispBody * a;
      if (lastH && !lastH.broken && c > lastH.p) {
        lastH.broken = true;
        const type = trend === -1 ? 'CHoCH' : 'BOS';
        ev.push({ type, dir: 1, level: lastH.p, i: j, from: lastH.i, mss: type === 'CHoCH' && disp });
        trend = 1;
      } else if (lastL && !lastL.broken && c < lastL.p) {
        lastL.broken = true;
        const type = trend === 1 ? 'CHoCH' : 'BOS';
        ev.push({ type, dir: -1, level: lastL.p, i: j, from: lastL.i, mss: type === 'CHoCH' && disp });
        trend = -1;
      }
    }
    // HH / HL / LH / LL labels
    const all = hs.map((x) => ({ ...x, t: 'H' })).concat(ls.map((x) => ({ ...x, t: 'L' }))).sort((x, y) => x.i - y.i);
    let ph = null, pl = null;
    for (const p of all) {
      if (p.t === 'H') { labels.push({ i: p.i, p: p.p, label: ph == null ? 'H' : p.p > ph ? 'HH' : p.p < ph ? 'LH' : 'EH' }); ph = p.p; }
      else { labels.push({ i: p.i, p: p.p, label: pl == null ? 'L' : p.p > pl ? 'HL' : p.p < pl ? 'LL' : 'EL' }); pl = p.p; }
    }
    // trend from the last two highs and lows when no break has happened yet
    if (!trend) {
      const h2 = hs.slice(-2), l2 = ls.slice(-2);
      if (h2.length === 2 && l2.length === 2) trend = h2[1].p > h2[0].p && l2[1].p > l2[0].p ? 1 : h2[1].p < h2[0].p && l2[1].p < l2[0].p ? -1 : 0;
    }
    return { trend, events: ev, lastEvent: last(ev) || null, labels: labels.slice(-8), lastHigh: last(hs) || null, lastLow: last(ls) || null, highs: hs, lows: ls, k };
  }

  function moduleStructure(P) {
    const b = P.bars, A = P.atrA;
    const ext = structure(b, CFG.pivotExt, A), int = structure(b, CFG.pivotInt, A);
    const n = b.length - 1; let s = 0.6 * ext.trend + 0.4 * int.trend;
    const e = ext.lastEvent, ie = int.lastEvent, facts = [];
    const age = (ev) => (ev ? n - ev.i : 999);
    if (e && age(e) <= 25) s += 0.25 * e.dir * (e.type === 'CHoCH' ? 1.2 : 1) * (1 - age(e) / 30);
    if (ie && ie.type === 'CHoCH' && age(ie) <= 10 && ie.dir !== ext.trend) facts.push({ k: 'int_choch', dir: ie.dir });
    facts.unshift({ k: 'trend', ext: ext.trend, int: int.trend });
    if (e) facts.push({ k: 'last_break', type: e.type, dir: e.dir, level: e.level, ago: age(e), mss: e.mss });
    return {
      id: 'structure', weight: WEIGHTS.structure, available: true, directional: true, score: clamp(s), tf: P.tfName,
      data: { externalTrend: ext.trend, internalTrend: int.trend, lastBreak: e, lastInternalBreak: ie, labels: ext.labels, swingHigh: ext.lastHigh, swingLow: ext.lastLow, mss: !!(e && e.mss && age(e) <= 25) },
      facts, _ext: ext, _int: int,
    };
  }

  /* ---------- 02 Liquidity ---------- */
  function moduleLiquidity(P, S) {
    const b = P.bars, n = b.length - 1, A = P.atrA, a = A[n] || 1, price = b[n].c;
    const pv = pivots(b, 3), tol = CFG.eqTol * a;
    const unswept = (p, side) => { for (let j = p.i + 1; j <= n; j++) if (side === 'H' ? b[j].h > p.p : b[j].l < p.p) return false; return true; };
    const cluster = (arr, side) => {
      const pool = [];
      const open = arr.filter((p) => unswept(p, side));
      for (const p of open) {
        const m = pool.find((x) => Math.abs(x.p - p.p) <= tol);
        if (m) { m.eq = true; m.n++; m.p = side === 'H' ? Math.max(m.p, p.p) : Math.min(m.p, p.p); m.i = p.i; } else pool.push({ p: p.p, i: p.i, n: 1, eq: false });
      }
      return pool;
    };
    const bsl = cluster(pv.hs, 'H').filter((x) => x.p > price).sort((x, y) => x.p - y.p);
    const ssl = cluster(pv.ls, 'L').filter((x) => x.p < price).sort((x, y) => y.p - x.p);
    // sweeps: a wick takes a swing level that was already known, then the candle closes back inside
    const sweeps = [];
    for (let j = Math.max(10, n - CFG.sweepLookback); j <= n; j++) {
      const range = b[j].h - b[j].l || 1e-9;
      const kh = pv.hs.filter((p) => p.i + 3 <= j - 1 && p.i < j).slice(-6), kl = pv.ls.filter((p) => p.i + 3 <= j - 1 && p.i < j).slice(-6);
      for (const p of kh) {
        if (b[j].h > p.p && b[j].c < p.p && !b.slice(p.i + 1, j).some((x) => x.h > p.p)) {
          const rej = (b[j].h - Math.max(b[j].o, b[j].c)) / range;
          const hunt = b.slice(j + 1, j + 4).some((x) => x.c < b[j].o);
          sweeps.push({ i: j, dir: -1, level: p.p, rejection: r2(rej), stopHunt: hunt || rej > 0.5 });
        }
      }
      for (const p of kl) {
        if (b[j].l < p.p && b[j].c > p.p && !b.slice(p.i + 1, j).some((x) => x.l < p.p)) {
          const rej = (Math.min(b[j].o, b[j].c) - b[j].l) / range;
          const hunt = b.slice(j + 1, j + 4).some((x) => x.c > b[j].o);
          sweeps.push({ i: j, dir: 1, level: p.p, rejection: r2(rej), stopHunt: hunt || rej > 0.5 });
        }
      }
    }
    const lastSweep = last(sweeps) || null;
    let s = 0;
    if (lastSweep) { const age = n - lastSweep.i; s += lastSweep.dir * (1 - age / (CFG.sweepLookback + 1)) * (0.6 + 0.4 * clamp(lastSweep.rejection, 0, 1)); }
    const dUp = bsl.length ? bsl[0].p - price : null, dDn = ssl.length ? price - ssl[0].p : null;
    let draw = 0;
    if (dUp != null && dDn != null) draw = clamp((dDn - dUp) / (dDn + dUp)) * 0.25; else if (dUp != null) draw = 0.1; else if (dDn != null) draw = -0.1;
    s += draw;
    const facts = [];
    if (lastSweep) facts.push({ k: 'sweep', dir: lastSweep.dir, level: lastSweep.level, ago: n - lastSweep.i, hunt: lastSweep.stopHunt, rej: lastSweep.rejection });
    if (bsl[0]) facts.push({ k: 'bsl', level: bsl[0].p, eq: bsl[0].eq });
    if (ssl[0]) facts.push({ k: 'ssl', level: ssl[0].p, eq: ssl[0].eq });
    return {
      id: 'liquidity', weight: WEIGHTS.liquidity, available: true, directional: true, score: clamp(s), tf: P.tfName,
      data: { bsl: bsl.slice(0, 4), ssl: ssl.slice(0, 4), sweeps: sweeps.slice(-5), lastSweep, eqHighs: bsl.filter((x) => x.eq).length, eqLows: ssl.filter((x) => x.eq).length },
      facts,
    };
  }

  /* ---------- 03 ICT / SMC ---------- */
  function moduleSMC(P, S) {
    const b = P.bars, n = b.length - 1, A = P.atrA, a = A[n] || 1, price = b[n].c;
    const from = Math.max(2, n - 150);
    // Fair value gaps (3-candle imbalance), still open (price has not closed through them)
    const fvg = [];
    for (let i = from; i <= n; i++) {
      if (b[i].l > b[i - 2].h && b[i].l - b[i - 2].h >= CFG.fvgMin * (A[i] || a)) fvg.push({ dir: 1, lo: b[i - 2].h, hi: b[i].l, i });
      else if (b[i].h < b[i - 2].l && b[i - 2].l - b[i].h >= CFG.fvgMin * (A[i] || a)) fvg.push({ dir: -1, lo: b[i].h, hi: b[i - 2].l, i });
    }
    const act = [], ifvg = [];
    for (const g of fvg) {
      let closedThrough = -1;
      for (let j = g.i + 1; j <= n; j++) { if (g.dir === 1 ? b[j].c < g.lo : b[j].c > g.hi) { closedThrough = j; break; } }
      if (closedThrough < 0) { const filled = b.slice(g.i + 1).some((x) => (g.dir === 1 ? x.l <= (g.lo + g.hi) / 2 : x.h >= (g.lo + g.hi) / 2)); act.push({ ...g, tested: filled }); }
      else {
        // inversion: a closed-through gap flips and acts the other way until price closes back across it
        const back = b.slice(closedThrough + 1).some((x) => (g.dir === 1 ? x.c > g.hi : x.c < g.lo));
        if (!back && n - closedThrough <= 60) ifvg.push({ dir: -g.dir, lo: g.lo, hi: g.hi, i: closedThrough });
      }
    }
    // displacement = a big, decisive candle
    const disp = [];
    for (let i = Math.max(1, n - 60); i <= n; i++) {
      const body = Math.abs(b[i].c - b[i].o), rg = b[i].h - b[i].l || 1e-9;
      if (body >= CFG.dispBody * (A[i] || a) && body / rg >= 0.65) disp.push({ i, dir: sgn(b[i].c - b[i].o) });
    }
    // order blocks: the last opposite candle before a displacement, never traded through since
    const ob = [];
    for (const d of disp) {
      for (let j = d.i - 1; j >= Math.max(0, d.i - 6); j--) {
        if (sgn(b[j].c - b[j].o) === -d.dir) {
          const z = { dir: d.dir, lo: b[j].l, hi: b[j].h, i: j, dispAt: d.i };
          const dead = b.slice(d.i + 1).some((x) => (d.dir === 1 ? x.c < z.lo : x.c > z.hi));
          if (!dead) ob.push(z);
          break;
        }
      }
    }
    // dealing range from the latest external swing high and low
    const E = S._ext, hh = E.lastHigh, ll = E.lastLow;
    let range = null, pos = null, zone = 'unknown';
    if (hh && ll && hh.p > ll.p) {
      range = { hi: hh.p, lo: ll.p, eq: (hh.p + ll.p) / 2 };
      pos = clamp((price - ll.p) / (hh.p - ll.p), -0.5, 1.5);
      // premium / discount only mean something INSIDE the dealing range; outside it the range has been broken
      zone = pos < 0 ? 'below' : pos > 1 ? 'above' : pos > 0.55 ? 'premium' : pos < 0.45 ? 'discount' : 'equilibrium';
    }
    // score
    const near = (z) => price >= z.lo - 1.5 * a && price <= z.hi + 1.5 * a;
    const sup = act.filter((g) => g.dir === 1 && near(g) && g.hi <= price + 1.5 * a).concat(ob.filter((z) => z.dir === 1 && near(z) && z.hi <= price + 1.5 * a), ifvg.filter((z) => z.dir === 1 && near(z)));
    const res = act.filter((g) => g.dir === -1 && near(g) && g.lo >= price - 1.5 * a).concat(ob.filter((z) => z.dir === -1 && near(z) && z.lo >= price - 1.5 * a), ifvg.filter((z) => z.dir === -1 && near(z)));
    const zoneS = clamp((Math.min(sup.length, 3) - Math.min(res.length, 3)) / 3);
    const ld = last(disp.filter((d) => n - d.i <= 12));
    const dispS = ld ? ld.dir * (1 - (n - ld.i) / 14) : 0;
    const pdS = pos == null || pos < 0 || pos > 1 ? 0 : clamp((0.5 - pos) * 2);
    const s = 0.4 * zoneS + 0.3 * dispS + 0.3 * pdS;
    const facts = [];
    if (range) facts.push({ k: 'pd', zone, pos: r2(pos) });
    if (ld) facts.push({ k: 'disp', dir: ld.dir, ago: n - ld.i });
    if (sup.length || res.length) facts.push({ k: 'zones', sup: sup.length, res: res.length });
    if (ifvg.length) facts.push({ k: 'ifvg', n: ifvg.length });
    return {
      id: 'smc', weight: WEIGHTS.smc, available: true, directional: true, score: clamp(s), tf: P.tfName,
      data: { fvg: act.slice(-6), ifvg: ifvg.slice(-3), orderBlocks: ob.slice(-6), displacement: disp.slice(-4), range, position: pos, zone, support: sup, resistance: res },
      facts,
    };
  }

  /* ---------- 04 Technical indicators (EMA/RSI/ATR) and Fibonacci ---------- */
  function moduleTechnical(P, S) {
    const b = P.bars, n = b.length - 1, c = b.map((x) => x.c);
    const e20 = ema(c, 20), e50 = ema(c, 50), e200 = ema(c, 200), R = rsi(c), A = P.atrA;
    const e = { e20: e20[n], e50: e50[n], e200: e200[n] }, price = c[n];
    const have200 = e.e200 != null;
    let sEma = 0, parts = 0;
    if (e.e20 != null && e.e50 != null) { sEma += (price > e.e20 ? 1 : -1) + (e.e20 > e.e50 ? 1 : -1); parts += 2; }
    if (have200) { sEma += e.e50 > e.e200 ? 1 : -1; sEma += price > e.e200 ? 1 : -1; parts += 2; }
    sEma = parts ? sEma / parts : 0;
    const slope = e50[n] != null && e50[n - 10] != null && A[n] ? clamp((e50[n] - e50[n - 10]) / (A[n] * 3)) : 0;
    let rs = R[n] == null ? 50 : R[n]; const raw = clamp((rs - 50) / 20);
    const rsiS = rs > 75 || rs < 25 ? raw * 0.4 : raw;                    // overstretched: momentum is less reliable
    const emaRsi = 0.5 * sEma + 0.2 * slope + 0.3 * rsiS;
    const a = A[n] || 0, pct = price ? (a / price) * 100 : 0;
    const win = A.slice(-100).filter((x) => x != null), sorted = win.slice().sort((x, y) => x - y);
    const rank = sorted.length ? sorted.findIndex((x) => x >= a) / sorted.length : 0.5;
    const regime = rank > 0.8 ? 'high' : rank < 0.25 ? 'low' : 'normal';
    // Fibonacci on the latest external leg
    const E = S._ext, hh = E.lastHigh, ll = E.lastLow; let fib = null, fibS = 0;
    if (hh && ll) {
      const up = hh.i > ll.i;                                             // latest leg: up (low → high) or down (high → low)
      const hi = hh.p, lo = ll.p, span = hi - lo;
      if (span > 0) {
        const ret = up ? (hi - price) / span : (price - lo) / span;       // 0 = at the leg's end, 1 = fully retraced
        const lv = {}; [0.382, 0.5, 0.618, 0.705, 0.786].forEach((f) => { lv[f] = up ? hi - span * f : lo + span * f; });
        const inOTE = ret >= 0.5 && ret <= 0.79;
        let sc = ret < 0 ? 0.2 : ret < 0.382 ? 0.3 : ret < 0.5 ? 0.5 : inOTE ? 0.9 : ret <= 1 ? -0.2 : -0.8;
        fibS = (up ? 1 : -1) * sc;
        fib = { up, hi, lo, retrace: r2(ret), levels: lv, ote: inOTE };
      }
    }
    const tF = [], facts = [];
    facts.push({ k: 'ema', price, e20: e.e20, e50: e.e50, e200: e.e200, s: r2(sEma) });
    facts.push({ k: 'rsi', v: r2(rs), over: rs > 70 ? 'ob' : rs < 30 ? 'os' : '' });
    facts.push({ k: 'atr', v: a, pct: r2(pct), regime });
    return [{
      id: 'ema_rsi', weight: WEIGHTS.ema_rsi, available: true, directional: true, score: clamp(emaRsi), tf: P.tfName,
      data: { ...e, rsi: rs, atr: a, atrPct: pct, atrRegime: regime, have200 }, facts,
    }, {
      id: 'fib', weight: WEIGHTS.fib, available: !!fib, directional: !!fib, score: clamp(fibS), tf: P.tfName,
      data: fib || {}, facts: fib ? [{ k: 'fib', ...fib }] : [],
    }];
  }

  /* ---------- 05 Order flow (volume based; bid/ask needs a level-2 feed we do not have) ---------- */
  function moduleOrderFlow(P) {
    const b = P.ofBars, n = b ? b.length - 1 : -1;
    const withVol = b ? b.filter((x) => x.v > 0).length / b.length : 0;
    const base = { id: 'orderflow', weight: WEIGHTS.orderflow, directional: true, tf: P.ofName, facts: [], data: { bidAsk: 'unavailable (needs a level-2 order-book feed)' } };
    if (!b || b.length < 40 || withVol < 0.7) return { ...base, available: false, score: 0, data: { ...base.data, reason: 'no real traded volume for this market (spot FX / metals)' } };
    const A = atr(b), a = A[n] || A[n - 1] || 1, price = b[n].c;
    // VWAP anchored to the current UTC day
    const day = Math.floor(b[n].t / 86400); let pv = 0, vv = 0;
    for (let i = n; i >= 0 && Math.floor(b[i].t / 86400) === day; i--) { const tp = (b[i].h + b[i].l + b[i].c) / 3; pv += tp * b[i].v; vv += b[i].v; }
    const vwap = vv ? pv / vv : null;
    // volume profile over the last ~5 days (40 price bins): POC and the 70% value area
    const seg = b.slice(-Math.min(b.length, Math.round((5 * 86400) / (b[1].t - b[0].t || 900))));
    const lo = Math.min(...seg.map((x) => x.l)), hi = Math.max(...seg.map((x) => x.h)), bins = 40, step = (hi - lo) / bins || 1, vol = new Array(bins).fill(0);
    for (const x of seg) { const i0 = clamp(Math.floor((x.l - lo) / step), 0, bins - 1), i1 = clamp(Math.floor((x.h - lo) / step), 0, bins - 1); for (let i = i0; i <= i1; i++) vol[i] += x.v / (i1 - i0 + 1); }
    let poc = 0; vol.forEach((v, i) => { if (v > vol[poc]) poc = i; });
    const total = vol.reduce((s, v) => s + v, 0); let acc = vol[poc], l = poc, h = poc;
    while (acc < total * 0.7 && (l > 0 || h < bins - 1)) { const dn = l > 0 ? vol[l - 1] : -1, up = h < bins - 1 ? vol[h + 1] : -1; if (up >= dn) { h++; acc += vol[h]; } else { l--; acc += vol[l]; } }
    const profile = { poc: lo + (poc + 0.5) * step, val: lo + l * step, vah: lo + (h + 1) * step };
    // estimated delta: volume of up candles minus volume of down candles over the last 20 bars (an estimate, not true bid/ask delta)
    const w = b.slice(-20), delta = w.reduce((s, x) => s + sgn(x.c - x.o) * x.v, 0), vsum = w.reduce((s, x) => s + x.v, 0) || 1;
    // absorption: big volume, small range at a turning point. exhaustion: climactic volume after an extended run.
    const avgV = b.slice(-60, -1).reduce((s, x) => s + x.v, 0) / Math.max(1, Math.min(59, b.length - 1));
    let absorption = null, exhaustion = null;
    for (let i = n; i > n - 4 && i > 0; i--) {
      const x = b[i], rg = x.h - x.l, body = Math.abs(x.c - x.o);
      if (x.v > 1.8 * avgV && rg < 0.8 * a) { const lowerWick = Math.min(x.o, x.c) - x.l, upperWick = x.h - Math.max(x.o, x.c); absorption = { i, dir: lowerWick > upperWick ? 1 : -1, ago: n - i, vol: r2(x.v / avgV) }; break; }
      const run = b[i].c - b[Math.max(0, i - 8)].c;
      if (x.v > 2.2 * avgV && Math.abs(run) > 2.5 * a && body < 0.4 * rg) { exhaustion = { i, dir: -sgn(run), ago: n - i, vol: r2(x.v / avgV) }; break; }
    }
    let s = 0;
    if (vwap) s += 0.3 * clamp((price - vwap) / (1.5 * a));
    s += 0.3 * clamp(delta / vsum * 2);
    s += 0.15 * (price > profile.poc ? 1 : -1) * (price > profile.vah || price < profile.val ? 1 : 0.5);
    if (absorption) s += 0.25 * absorption.dir * (1 - absorption.ago / 5);
    if (exhaustion) s += 0.25 * exhaustion.dir * (1 - exhaustion.ago / 5);
    const facts = [];
    if (vwap) facts.push({ k: 'vwap', v: vwap, side: price > vwap ? 1 : -1 });
    facts.push({ k: 'poc', poc: profile.poc, val: profile.val, vah: profile.vah });
    facts.push({ k: 'delta', dir: sgn(delta), pct: r2((delta / vsum) * 100) });
    if (absorption) facts.push({ k: 'absorption', ...absorption });
    if (exhaustion) facts.push({ k: 'exhaustion', ...exhaustion });
    return { ...base, available: true, score: clamp(s), facts, data: { ...base.data, vwap, profile, deltaEstimate: delta, deltaPct: (delta / vsum) * 100, absorption, exhaustion } };
  }

  /* ---------- 06 Fundamental (economic calendar). Direction is NOT guessed: the feed has no actual-vs-forecast, so this is a risk gate. ---------- */
  const TAGS = { XAUUSD: ['GOLD', 'USD', 'BIG'], XAGUSD: ['GOLD', 'USD', 'BIG'], OIL: ['OIL', 'USD'], EURUSD: ['USD', 'BIG'], GBPUSD: ['USD', 'BIG'], USDJPY: ['USD', 'BIG'], NQ: ['USD', 'BIG'], BTCUSD: ['USD', 'BIG'] };
  function moduleFundamental(news, symbol, now) {
    const base = { id: 'fundamental', weight: WEIGHTS.fundamental, directional: false, score: 0, tf: 'calendar', facts: [] };
    if (!Array.isArray(news)) return { ...base, available: false, data: { reason: 'economic calendar not loaded' } };
    const tags = TAGS[symbol] || ['USD', 'BIG'];
    const ev = news.filter((e) => e.tags && e.tags.some((t) => tags.includes(t))).filter((e) => e.ms > now - 3 * 3600e3).sort((x, y) => x.ms - y.ms);
    const mins = (e) => Math.round((e.ms - now) / 60000);
    const upcoming = ev.filter((e) => e.ms >= now).slice(0, 6), recent = ev.filter((e) => e.ms < now && now - e.ms <= 30 * 60000);
    const hi = upcoming.find((e) => e.impact === 'High');
    let risk = 'clear';
    if ((hi && mins(hi) <= CFG.newsHighMin) || recent.some((e) => e.impact === 'High' && now - e.ms <= 20 * 60000)) risk = 'high';
    else if (upcoming.some((e) => mins(e) <= 120 && e.impact === 'High') || upcoming.some((e) => mins(e) <= 45)) risk = 'elevated';
    const facts = [{ k: 'risk', level: risk }];
    if (upcoming[0]) facts.push({ k: 'next', title: upcoming[0].title, cur: upcoming[0].country, impact: upcoming[0].impact, in: mins(upcoming[0]) });
    return { ...base, available: true, data: { risk, upcoming: upcoming.map((e) => ({ title: e.title, country: e.country, impact: e.impact, ms: e.ms, in: mins(e), guide: e.guide, forecast: e.forecast, previous: e.previous })), recent: recent.map((e) => ({ title: e.title, country: e.country, impact: e.impact, ms: e.ms })), sentiment: 'not connected (no headline feed)' }, facts };
  }

  /* ---------- 07 Multi-timeframe ---------- */
  function trendOf(bars, k) {
    if (!bars || bars.length < 40) return null;
    const A = atr(bars), S = structure(bars, k, A), c = bars.map((x) => x.c), e50 = ema(c, Math.min(50, Math.floor(bars.length / 2))), n = bars.length - 1;
    const emaDir = e50[n] != null ? sgn(c[n] - e50[n]) : 0;
    return { dir: S.trend !== 0 ? S.trend : emaDir, structure: S.trend, ema: emaDir, event: S.lastEvent, S, A };
  }
  function moduleMTF(P, symbol) {
    const names = P.ladder, res = names.map((nm) => ({ tf: nm, t: trendOf(P.tfs[nm], CFG.pivotMtf) }));
    const have = res.filter((r) => r.t);
    const base = { id: 'mtf', weight: WEIGHTS.mtf, directional: true, tf: names.join('/') };
    if (have.length < 2) return { ...base, available: false, score: 0, facts: [], data: { reason: 'not enough timeframes loaded' } };
    let s = 0, wsum = 0;
    res.forEach((r, i) => { if (r.t) { s += MTF_W[i] * r.t.dir; wsum += MTF_W[i]; } });
    s = wsum ? s / wsum : 0;
    const macro = res.slice(0, 2).filter((r) => r.t).map((r) => r.t.dir), setup = res.slice(2).filter((r) => r.t).map((r) => r.t.dir);
    const macroDir = sgn(macro.reduce((x, y) => x + y, 0)), setupDir = sgn(setup.reduce((x, y) => x + y, 0));
    const aligned = res.filter((r) => r.t && r.t.dir === sgn(s) && sgn(s) !== 0).length;
    const facts = [{ k: 'ladder', rungs: res.map((r) => ({ tf: r.tf, dir: r.t ? r.t.dir : null })) }];
    return { ...base, available: true, score: clamp(s), facts, data: { rungs: res.map((r) => ({ tf: r.tf, dir: r.t ? r.t.dir : null, structure: r.t ? r.t.structure : null, lastBreak: r.t && r.t.event ? { type: r.t.event.type, dir: r.t.event.dir } : null })), macroDir, setupDir, aligned, total: have.length, conflict: macroDir !== 0 && setupDir !== 0 && macroDir !== setupDir } };
  }

  /* ---------- 08 AI reasoning: combines the verified outputs, never invents new evidence ---------- */
  function score(parts) {
    const dirParts = parts.filter((p) => p.available && p.directional);
    const wDir = dirParts.reduce((s, p) => s + p.weight, 0);
    const composite = wDir ? (dirParts.reduce((s, p) => s + p.weight * p.score, 0) / wDir) * 100 : 0;
    const coverage = parts.filter((p) => p.available).reduce((s, p) => s + p.weight, 0) / 100;
    return { composite, coverage, wDir, contrib: parts.map((p) => ({ id: p.id, weight: p.weight, available: p.available, directional: p.directional, score: p.score, points: p.available && p.directional && wDir ? (p.weight * p.score / wDir) * 100 : 0 })) };
  }
  function conflicts(parts) {
    const strong = parts.filter((p) => p.available && p.directional && Math.abs(p.score) >= 0.3);
    const bull = strong.filter((p) => p.score > 0), bear = strong.filter((p) => p.score < 0);
    const wb = bull.reduce((s, p) => s + p.weight, 0), we = bear.reduce((s, p) => s + p.weight, 0), tot = wb + we;
    return { bull: bull.map((p) => p.id), bear: bear.map((p) => p.id), share: tot ? Math.min(wb, we) / tot : 0 };
  }
  function buildPlan(dir, P, M) {
    const price = P.bars[P.bars.length - 1].c, a = M.ema_rsi.data.atr || 1;
    const smc = M.smc.data, fib = M.fib.data, liq = M.liquidity.data, st = M.structure.data;
    const zones = [].concat(smc.support, smc.resistance, smc.fvg, smc.orderBlocks).filter((z) => z.dir === dir && (dir === 1 ? z.hi <= price + 0.5 * a && z.hi >= price - 3 * a : z.lo >= price - 0.5 * a && z.lo <= price + 3 * a));
    let entry = price, zoneUsed = null;
    if (zones.length) { zones.sort((x, y) => Math.abs((x.lo + x.hi) / 2 - price) - Math.abs((y.lo + y.hi) / 2 - price)); zoneUsed = zones[0]; entry = dir === 1 ? Math.min(price, zoneUsed.hi) : Math.max(price, zoneUsed.lo); }
    else if (fib && fib.ote && fib.up === (dir === 1)) { entry = price; zoneUsed = { lo: Math.min(fib.levels[0.618], fib.levels[0.786]), hi: Math.max(fib.levels[0.618], fib.levels[0.786]), dir, fib: true }; }
    const swing = dir === 1 ? st.swingLow : st.swingHigh;
    let stop = zoneUsed ? (dir === 1 ? zoneUsed.lo : zoneUsed.hi) : (swing ? swing.p : dir === 1 ? price - 1.5 * a : price + 1.5 * a);
    if (swing && zoneUsed && (dir === 1 ? swing.p < stop && stop - swing.p < 1.5 * a : swing.p > stop && swing.p - stop < 1.5 * a)) stop = swing.p;
    stop = dir === 1 ? stop - 0.25 * a : stop + 0.25 * a;
    const targets = (dir === 1 ? liq.bsl : liq.ssl).map((x) => x.p).filter((p) => (dir === 1 ? p > entry : p < entry));
    const risk = Math.abs(entry - stop);
    if (!risk || risk > 6 * a) return { valid: false, reason: 'stop too wide or undefined' };
    const tp = targets.slice(0, 3);
    if (!tp.length) return { valid: false, reason: 'no liquidity target in the trade direction' };
    const rr = Math.abs(tp[0] - entry) / risk;
    return { valid: rr >= CFG.minRR, dir, entry, entryType: zoneUsed ? (zoneUsed.fib ? 'fib' : 'zone') : 'market', zone: zoneUsed, stop, targets: tp, rr: r2(rr), reason: rr >= CFG.minRR ? '' : 'first target is too close for the risk (RR < ' + CFG.minRR + ')' };
  }
  function decide(parts, M, P) {
    const sc = score(parts), cf = conflicts(parts), waits = [];
    const comp = sc.composite, dir = sgn(comp);
    if (sc.coverage < CFG.minCoverage) waits.push('data');
    if (Math.abs(comp) < CFG.minScore) waits.push('weak');
    if (cf.share > CFG.conflictMax && Math.abs(comp) < 70) waits.push('conflict');
    if (M.fundamental.available && M.fundamental.data.risk === 'high') waits.push('news');
    if (M.mtf.available && M.mtf.data.macroDir !== 0 && dir !== 0 && M.mtf.data.macroDir !== dir) waits.push('htf');
    if (M.ema_rsi.data.atrRegime === 'high' && Math.abs(comp) < 50) waits.push('vol');
    let plan = null;
    if (dir !== 0 && !waits.includes('data')) { plan = buildPlan(dir, P, M); if (!plan.valid && Math.abs(comp) >= CFG.minScore) waits.push('plan'); }
    const action = waits.length || dir === 0 ? 'WAIT' : dir === 1 ? 'LONG' : 'SHORT';
    const grade = action === 'WAIT' ? '' : Math.abs(comp) >= CFG.gradeA && cf.share < 0.15 && (!M.mtf.available || M.mtf.data.conflict === false) ? 'A+' : Math.abs(comp) >= CFG.gradeB ? 'A' : 'B';
    return { action, grade, bias: dir, waits, conflicts: cf, plan, ...sc };
  }

  /* ---------- bilingual explanation (templates only: every sentence is backed by a module output) ---------- */
  const T = {
    trendBull: ['Structure is bullish (higher highs and higher lows).', 'រចនាសម្ព័ន្ធឡើង (កំពូលខ្ពស់ជាង និងបាតខ្ពស់ជាង)។'],
    trendBear: ['Structure is bearish (lower highs and lower lows).', 'រចនាសម្ព័ន្ធចុះ (កំពូលទាបជាង និងបាតទាបជាង)។'],
    trendRange: ['Structure is mixed: no clear trend.', 'រចនាសម្ព័ន្ធច្របូកច្របល់ មិនមាននិន្នាការច្បាស់លាស់។'],
    bos: (d, ago) => [`Recent break of structure ${d > 0 ? 'up' : 'down'} (BOS, ${bars(ago)} ago) confirms the trend.`, `ទើបបំបែករចនាសម្ព័ន្ធ${d > 0 ? 'ឡើង' : 'ចុះ'} (BOS ${ago} ដើមទៀន) បញ្ជាក់និន្នាការ។`],
    choch: (d, ago, mss) => [`Change of character ${d > 0 ? 'up' : 'down'} (CHoCH, ${bars(ago)} ago)${mss ? ' with displacement: market structure shift (MSS)' : ''}: the old trend is being challenged.`, `ការផ្លាស់ប្តូរចរិត${d > 0 ? 'ឡើង' : 'ចុះ'} (CHoCH ${ago} ដើមទៀន)${mss ? ' ជាមួយ displacement៖ MSS' : ''}៖ និន្នាការចាស់កំពុងត្រូវបានប្រជែង។`],
    sweepUp: (lvl) => [`Sell-side liquidity swept at ${lvl} and price rejected: bullish.`, `បានបោសសម្អាតសន្ទនីយភាពផ្នែកលក់នៅ ${lvl} ហើយតម្លៃត្រឡប់ក្រោយ៖ ឡើង។`],
    sweepDown: (lvl) => [`Buy-side liquidity swept at ${lvl} and price rejected: bearish.`, `បានបោសសម្អាតសន្ទនីយភាពផ្នែកទិញនៅ ${lvl} ហើយតម្លៃត្រឡប់ក្រោយ៖ ចុះ។`],
    pdDisc: ['Price is in the discount half of the dealing range (favours longs).', 'តម្លៃនៅផ្នែកបញ្ចុះតម្លៃនៃជួរ (អំណោយផលដល់ការទិញ)។'],
    pdPrem: ['Price is in the premium half of the dealing range (favours shorts).', 'តម្លៃនៅផ្នែកថ្លៃនៃជួរ (អំណោយផលដល់ការលក់)។'],
    zonesUp: (n) => [`${n} unmitigated demand zone(s) (order block / FVG) under price.`, `តំបន់ត្រូវការ ${n} (OB / FVG) នៅក្រោមតម្លៃ។`],
    zonesDn: (n) => [`${n} unmitigated supply zone(s) (order block / FVG) above price.`, `តំបន់ផ្គត់ផ្គង់ ${n} (OB / FVG) នៅលើតម្លៃ។`],
    emaBull: ['Price is above the rising EMAs (20/50/200 aligned up).', 'តម្លៃនៅលើ EMA ដែលកំពុងឡើង (20/50/200 តម្រឹមឡើង)។'],
    emaBear: ['Price is below the falling EMAs (20/50/200 aligned down).', 'តម្លៃនៅក្រោម EMA ដែលកំពុងចុះ (20/50/200 តម្រឹមចុះ)។'],
    rsiOB: (v) => [`RSI ${v}: overbought, momentum is stretched.`, `RSI ${v}៖ ទិញលើស សន្ទុះលាតសន្ធឹង។`],
    rsiOS: (v) => [`RSI ${v}: oversold, momentum is stretched.`, `RSI ${v}៖ លក់លើស សន្ទុះលាតសន្ធឹង។`],
    fibOTE: ['Price is retracing into the 0.5–0.79 Fibonacci zone of the latest leg.', 'តម្លៃកំពុងត្រឡប់ចូលតំបន់ Fibonacci 0.5–0.79 នៃរលកចុងក្រោយ។'],
    vwapUp: ['Price is above the daily VWAP.', 'តម្លៃនៅលើ VWAP ប្រចាំថ្ងៃ។'], vwapDn: ['Price is below the daily VWAP.', 'តម្លៃនៅក្រោម VWAP ប្រចាំថ្ងៃ។'],
    absorb: (d) => [`Volume absorption ${d > 0 ? 'at the lows' : 'at the highs'}.`, `ការស្រូបយកបរិមាណ${d > 0 ? 'នៅបាត' : 'នៅកំពូល'}។`],
    exhaust: ['Climactic volume after an extended move: exhaustion.', 'បរិមាណខ្ពស់ខ្លាំងបន្ទាប់ពីការរុញយូរ៖ អស់កម្លាំង។'],
    mtfAll: (a, t, d) => [`${a} of ${t} timeframes agree on a ${d > 0 ? 'bullish' : 'bearish'} direction.`, `${a} ក្នុងចំណោម ${t} ស៊ុមពេលវេលាឯកភាពទិសដៅ${d > 0 ? 'ឡើង' : 'ចុះ'}។`],
    mtfConf: ['Higher timeframes disagree with the setup timeframes.', 'ស៊ុមពេលវេលាធំមិនស្របនឹងស៊ុមពេលវេលាតូចទេ។'],
    newsHigh: ['High-impact news is due or just released: expect spikes and fake moves.', 'ព័ត៌មានធំជិតចេញ ឬទើបចេញ៖ រំពឹងការឆ្លងកាត់លឿន និងចលនាក្លែងក្លាយ។'],
  };
  const WAITS = {
    data: ['Not enough verified data (some modules unavailable).', 'ទិន្នន័យដែលបានផ្ទៀងផ្ទាត់មិនគ្រប់គ្រាន់។'],
    weak: ['No clear edge: the combined score is too close to zero.', 'មិនមានអត្ថប្រយោជន៍ច្បាស់លាស់៖ ពិន្ទុរួមជិតសូន្យ។'],
    conflict: ['Evidence conflicts: strong modules point in opposite directions.', 'ភស្តុតាងប៉ះទង្គិចគ្នា៖ ម៉ូឌុលសំខាន់ៗបង្ហាញទិសដៅផ្ទុយគ្នា។'],
    news: T.newsHigh,
    htf: ['The signal goes against the higher-timeframe bias.', 'សញ្ញាផ្ទុយនឹងទិសដៅនៃស៊ុមពេលវេលាធំ។'],
    vol: ['Volatility is unusually high while the edge is moderate.', 'ភាពប្រែប្រួលខ្ពស់ខុសធម្មតា ខណៈអត្ថប្រយោជន៍មធ្យម។'],
    plan: ['No valid trade plan (stop too wide, no target, or reward too small).', 'គ្មានផែនការជួញដូរត្រឹមត្រូវ (ឈប់ខាតធំពេក គ្មានគោលដៅ ឬផលចំណេញតូចពេក)។'],
  };
  function reasoning(M, D, P, lang) {
    const i = lang === 'km' ? 1 : 0;
    const pros = [], cons = [], st = M.structure, lq = M.liquidity, sm = M.smc, tc = M.ema_rsi, of = M.orderflow, mt = M.mtf;
    const add = (list, t) => list.push(t[i]);
    const dir = D.bias;
    const tr = st.data.externalTrend;
    add(tr > 0 ? (dir >= 0 ? pros : cons) : tr < 0 ? (dir <= 0 ? pros : cons) : cons, tr > 0 ? T.trendBull : tr < 0 ? T.trendBear : T.trendRange);
    const lb = st.data.lastBreak;
    if (lb && P.bars.length - 1 - lb.i <= 25) { const ago = P.bars.length - 1 - lb.i; add(lb.dir === dir ? pros : cons, lb.type === 'BOS' ? T.bos(lb.dir, ago) : T.choch(lb.dir, ago, lb.mss)); }
    const sw = lq.data.lastSweep; if (sw && P.bars.length - 1 - sw.i <= CFG.sweepLookback) add(sw.dir === dir ? pros : cons, sw.dir > 0 ? T.sweepUp(fx(sw.level, sw.level)) : T.sweepDown(fx(sw.level, sw.level)));
    if (sm.data.zone === 'discount') add(dir >= 0 ? pros : cons, T.pdDisc); else if (sm.data.zone === 'premium') add(dir <= 0 ? pros : cons, T.pdPrem);
    if (sm.data.support.length) add(dir >= 0 ? pros : cons, T.zonesUp(sm.data.support.length)); if (sm.data.resistance.length) add(dir <= 0 ? pros : cons, T.zonesDn(sm.data.resistance.length));
    if (tc.score > 0.35) add(dir >= 0 ? pros : cons, T.emaBull); else if (tc.score < -0.35) add(dir <= 0 ? pros : cons, T.emaBear);
    if (tc.data.rsi > 70) add(dir > 0 ? cons : pros, T.rsiOB(Math.round(tc.data.rsi))); else if (tc.data.rsi < 30) add(dir < 0 ? cons : pros, T.rsiOS(Math.round(tc.data.rsi)));
    if (M.fib.available && M.fib.data.ote) add(M.fib.data.up === (dir >= 0) ? pros : cons, T.fibOTE);
    if (of.available) {
      if (of.data.vwap) add((P.bars[P.bars.length - 1].c > of.data.vwap ? 1 : -1) === dir ? pros : cons, P.bars[P.bars.length - 1].c > of.data.vwap ? T.vwapUp : T.vwapDn);
      if (of.data.absorption) add(of.data.absorption.dir === dir ? pros : cons, T.absorb(of.data.absorption.dir));
      if (of.data.exhaustion) add(of.data.exhaustion.dir === dir ? pros : cons, T.exhaust);
    }
    if (mt.available) { const d = sgn(mt.score); if (d !== 0) add(d === dir ? pros : cons, T.mtfAll(mt.data.aligned, mt.data.total, d)); if (mt.data.conflict) cons.push(T.mtfConf[i]); }
    if (M.fundamental.available && M.fundamental.data.risk !== 'clear') cons.push(T.newsHigh[i]);
    const waits = D.waits.map((w) => WAITS[w][i]);
    const names = { structure: ['Market structure', 'រចនាសម្ព័ន្ធទីផ្សារ'], liquidity: ['Liquidity', 'សន្ទនីយភាព'], smc: ['ICT / SMC', 'ICT / SMC'], ema_rsi: ['EMA / RSI', 'EMA / RSI'], fib: ['Fibonacci', 'Fibonacci'], orderflow: ['Order flow', 'លំហូរបញ្ជា'], fundamental: ['Fundamental', 'មូលដ្ឋាន'], mtf: ['Multi-timeframe', 'ពហុស៊ុមពេល'] };
    const conflictsTxt = D.conflicts.share > 0 ? [(lang === 'km' ? 'ម៉ូឌុលឡើង៖ ' : 'Bullish modules: ') + (D.conflicts.bull.map((x) => names[x][i]).join(', ') || '—') + ' | ' + (lang === 'km' ? 'ម៉ូឌុលចុះ៖ ' : 'Bearish modules: ') + (D.conflicts.bear.map((x) => names[x][i]).join(', ') || '—')] : [];
    const head = D.action === 'WAIT'
      ? (lang === 'km' ? 'រង់ចាំ៖ ភស្តុតាងមិនគ្រប់គ្រាន់ ឬប៉ះទង្គិចគ្នា។' : 'WAIT: the evidence is not strong or clean enough.')
      : (lang === 'km' ? `${D.action === 'LONG' ? 'ទិញ' : 'លក់'} (ថ្នាក់ ${D.grade})៖ ភស្តុតាងភាគច្រើនស្របគ្នា។` : `${D.action} (grade ${D.grade}): most evidence points the same way.`);
    return { headline: head, pros, cons, waits, conflicts: conflictsTxt };
  }

  /* ---------- levels for the chart ---------- */
  function levelsOf(M, D, P) {
    const out = []; const price = P.bars[P.bars.length - 1].c;
    M.liquidity.data.bsl.slice(0, 2).forEach((x) => out.push({ type: 'bsl', price: x.p, label: x.eq ? 'EQH / BSL' : 'BSL' }));
    M.liquidity.data.ssl.slice(0, 2).forEach((x) => out.push({ type: 'ssl', price: x.p, label: x.eq ? 'EQL / SSL' : 'SSL' }));
    M.smc.data.fvg.filter((g) => Math.abs((g.lo + g.hi) / 2 - price) < 6 * (M.ema_rsi.data.atr || 1)).slice(-3).forEach((g) => out.push({ type: 'fvg', dir: g.dir, lo: g.lo, hi: g.hi, label: 'FVG' }));
    M.smc.data.orderBlocks.slice(-3).forEach((z) => out.push({ type: 'ob', dir: z.dir, lo: z.lo, hi: z.hi, label: 'OB' }));
    if (M.smc.data.range) out.push({ type: 'eq', price: M.smc.data.range.eq, label: '50%' });
    if (M.orderflow.available && M.orderflow.data.vwap) out.push({ type: 'vwap', price: M.orderflow.data.vwap, label: 'VWAP' });
    if (D.plan && D.plan.valid) { out.push({ type: 'entry', price: D.plan.entry, label: 'Entry' }, { type: 'stop', price: D.plan.stop, label: 'SL' }); D.plan.targets.forEach((t, i) => out.push({ type: 'tp', price: t, label: 'TP' + (i + 1) })); }
    return out;
  }

  /* ---------- main entry ---------- */
  function analyze(inp) {
    const { symbol = 'XAUUSD', style = 'intraday', tf = {}, news = null, now = Date.now() } = inp;
    const tfs = { m1: tf.m1 || null, m5: tf.m5 || null, m15: tf.m15 || null, h1: tf.h1 || null, h4: null, d1: null };
    if (tfs.h1 && tfs.h1.length) { tfs.h4 = agg(tfs.h1, STEP.h4, 3); tfs.d1 = agg(tfs.h1, STEP.d1, symbol.startsWith('BTC') ? 20 : 15); }
    const off = STYLES[style] != null ? STYLES[style] : 1, ladder = LADDER.slice(off, off + 4);
    const primaryName = ladder[1], primary = tfs[primaryName];
    if (!primary || primary.length < 120) return { error: 'not enough ' + primaryName.toUpperCase() + ' candles (' + (primary ? primary.length : 0) + ')', tfs: Object.fromEntries(Object.entries(tfs).map(([k, v]) => [k, v ? v.length : 0])) };
    const A = atr(primary);
    const ofName = style === 'swing' ? 'h1' : 'm15', ofBars = tfs[ofName] || primary;
    const P = { bars: primary, atrA: A, tfName: primaryName.toUpperCase(), ladder, tfs, ofBars, ofName: ofName.toUpperCase(), symbol };
    const S = moduleStructure(P), L = moduleLiquidity(P, S), K = moduleSMC(P, S), [Te, Fb] = moduleTechnical(P, S);
    const O = moduleOrderFlow(P), F = moduleFundamental(news, symbol, now), Mt = moduleMTF(P, symbol);
    const M = { structure: S, liquidity: L, smc: K, ema_rsi: Te, fib: Fb, orderflow: O, fundamental: F, mtf: Mt };
    const parts = [S, L, K, Te, Fb, O, F, Mt];
    const D = decide(parts, M, P);
    const last = primary[primary.length - 1];
    const clean = (m) => { const { _ext, _int, ...rest } = m; return rest; };
    const out = {
      symbol, style, primary: primaryName.toUpperCase(), ladder: ladder.map((x) => x.toUpperCase()), price: last.c, at: last.t,
      modules: Object.fromEntries(Object.entries(M).map(([k, v]) => [k, clean(v)])),
      composite: D.composite, coverage: D.coverage, decision: { action: D.action, grade: D.grade, bias: D.bias, waits: D.waits, conflicts: D.conflicts }, plan: D.plan, contrib: D.contrib,
      weights: WEIGHTS, bars: primary.slice(-120), atr: Te.data.atr,
    };
    out.reasoning = { en: reasoning(M, D, P, 'en'), km: reasoning(M, D, P, 'km') };
    out.levels = levelsOf(M, D, P);
    return out;
  }

  /** Building blocks exposed for unit tests. */
  function prep(bars, tfName) { return { bars, atrA: atr(bars), tfName: tfName || 'T', ladder: [], tfs: {}, ofBars: bars, ofName: 'T', symbol: 'TEST' }; }
  const _t = { prep, moduleStructure, moduleLiquidity, moduleSMC, moduleTechnical, moduleOrderFlow, moduleFundamental, moduleMTF, decide, buildPlan, trendOf };
  return { analyze, WEIGHTS, CFG, STEP, ema, rsi, atr, agg, pivots, structure, score, conflicts, _t };
});
