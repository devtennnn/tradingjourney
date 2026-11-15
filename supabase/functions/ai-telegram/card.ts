// @ts-nocheck
// AROM TRADE alert cards: pure functions that return an SVG string (1080 px wide). index.ts turns the SVG into a PNG for Telegram.
// No imports and no I/O here, so it can be tested anywhere. Emoji are drawn as shapes because the renderer has no colour-emoji font.

const W = 1080, M = 56;
const C = { bg1: "#0a1a13", bg2: "#06100b", panel: "#10241b", line: "#23443a", text: "#eaf5ee", muted: "#8fa89a", dim: "#5f7a6c",
  lime: "#b9f25a", lime2: "#e3ffa8", buy: "#2ee6a0", sell: "#ff5d73", amber: "#ffcf70", gold: "#f5c96a", gray: "#9aa7a0" };

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** rough text width (Inter): the renderer cannot measure for us, so layouts keep a safe margin */
const tw = (s, size, k = 0.58) => String(s).length * size * k;
/** word-wrap by estimated width → array of lines */
function wrap(text, size, maxW, k = 0.55) {
  const words = String(text).split(/\s+/).filter(Boolean), lines = []; let cur = "";
  for (const w of words) { const t = cur ? cur + " " + w : w; if (tw(t, size, k) > maxW && cur) { lines.push(cur); cur = w; } else cur = t; }
  if (cur) lines.push(cur); return lines;
}
const T = (x, y, s, o = {}) => `<text x="${x}" y="${y}" font-size="${o.size || 28}" font-weight="${o.w || 600}" fill="${o.fill || C.text}"${o.anchor ? ` text-anchor="${o.anchor}"` : ""}${o.ls ? ` letter-spacing="${o.ls}"` : ""}${o.op ? ` opacity="${o.op}"` : ""}>${esc(s)}</text>`;
const R = (x, y, w, h, o = {}) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${o.rx ?? 0}" fill="${o.fill || "none"}"${o.stroke ? ` stroke="${o.stroke}" stroke-width="${o.sw || 2}"` : ""}${o.op ? ` opacity="${o.op}"` : ""}/>`;

const defs = (accent) => `<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.bg1}"/><stop offset="1" stop-color="${C.bg2}"/></linearGradient>
  <linearGradient id="lime" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#8fc23e"/><stop offset=".55" stop-color="#b9f25a"/><stop offset="1" stop-color="#e3ffa8"/></linearGradient>
  <linearGradient id="win" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${C.buy}" stop-opacity=".55"/><stop offset="1" stop-color="${C.buy}"/></linearGradient>
  <radialGradient id="glow" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="${accent}" stop-opacity=".30"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></radialGradient>
  <pattern id="dots" width="36" height="36" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.6" fill="#ffffff" opacity=".07"/></pattern>
  <mask id="cut"><rect x="0" y="0" width="1000" height="1000" fill="#fff"/><rect x="590" y="618" width="150" height="36" fill="#000"/><rect x="712" y="0" width="300" height="1000" fill="#000"/></mask>
</defs>`;

const bgLayer = (H, accent) => `${R(0, 0, W, H, { fill: "url(#bg)" })}${R(0, 0, W, H, { fill: "url(#dots)" })}
  <circle cx="${W - 90}" cy="90" r="430" fill="url(#glow)"/><circle cx="60" cy="${H - 60}" r="300" fill="url(#glow)" opacity=".5"/>
  ${R(1, 1, W - 2, H - 2, { rx: 0, stroke: C.line, sw: 2 })}`;

/** AROM logo mark (same shape as the site logo) + wordmark + optional right-hand chip */
function header(chip) {
  const logo = `<g transform="translate(${M},50) scale(0.1115) translate(-196,-205)"><g mask="url(#cut)">
    <path d="M 295 240 H 712 V 618 H 604 V 348 H 295 Z" fill="url(#lime)"/>
    <path d="M 658 294 L 327 572 A 79 79 0 0 0 378 708 H 750" fill="none" stroke="url(#lime)" stroke-width="108" stroke-linejoin="round"/></g></g>`;
  const word = T(M + 86, 96, "AROM TRADE", { size: 38, w: 800, fill: C.lime, ls: 4 });
  let c = "";
  if (chip) { const w = Math.max(190, tw(chip, 26, 0.66) + 56); c = `${R(W - M - w, 58, w, 52, { rx: 26, stroke: C.lime, sw: 2, fill: "#b9f25a", op: 0.10 })}${R(W - M - w, 58, w, 52, { rx: 26, stroke: C.lime, sw: 2 })}${T(W - M - w / 2, 93, chip, { size: 26, w: 800, fill: C.lime, anchor: "middle", ls: 2 })}`; }
  return logo + word + c;
}

/* ---- icons (centred on 0,0) ---- */
const icon = {
  check: (col, r = 17) => `<circle r="${r}" fill="${col}"/><path d="M ${-r * .45} ${r * .02} L ${-r * .1} ${r * .38} L ${r * .5} ${-r * .34}" fill="none" stroke="#06100b" stroke-width="${r * .26}" stroke-linecap="round" stroke-linejoin="round"/>`,
  no: (col, r = 17) => `<circle r="${r - 1.5}" fill="none" stroke="${col}" stroke-width="3"/>`,
  warn: (col, r = 17) => `<path d="M 0 ${-r} L ${r} ${r * .8} L ${-r} ${r * .8} Z" fill="${col}"/><path d="M 0 ${-r * .3} V ${r * .26}" stroke="#06100b" stroke-width="3.4" stroke-linecap="round"/><circle cy="${r * .56}" r="2" fill="#06100b"/>`,
  link: (col, r = 17) => `<circle r="${r}" fill="none" stroke="${col}" stroke-width="3"/><path d="M -6 3 L 6 -3 M -2 -6 H 6 V 2" fill="none" stroke="${col}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`,
  up: (col) => `<path d="M 0 -14 L 15 10 H -15 Z" fill="${col}"/>`,
  down: (col) => `<path d="M 0 14 L 15 -10 H -15 Z" fill="${col}"/>`,
  trophy: (col) => `<g fill="none" stroke="${col}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"><path d="M -24 -30 H 24 V -8 C 24 12 12 24 0 24 C -12 24 -24 12 -24 -8 Z" fill="${col}" fill-opacity=".18"/><path d="M -24 -22 H -38 V -12 C -38 -2 -30 4 -22 4"/><path d="M 24 -22 H 38 V -12 C 38 -2 30 4 22 4"/><path d="M 0 24 V 38"/><path d="M -18 42 H 18"/></g>`,
  tick: (col) => `<path d="M -26 2 L -8 20 L 28 -20" fill="none" stroke="${col}" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>`,
  cross: (col) => `<path d="M -22 -22 L 22 22 M 22 -22 L -22 22" fill="none" stroke="${col}" stroke-width="12" stroke-linecap="round"/>`,
  clock: (col) => `<circle r="30" fill="none" stroke="${col}" stroke-width="7"/><path d="M 0 -16 V 0 L 12 8" fill="none" stroke="${col}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>`,
  hourglass: (col) => `<path d="M -20 -30 H 20 M -20 30 H 20 M -16 -30 C -16 -4 16 -4 16 30 M 16 -30 C 16 -4 -16 -4 -16 30" fill="none" stroke="${col}" stroke-width="7" stroke-linecap="round"/>`,
};
const at = (x, y, inner) => `<g transform="translate(${x},${y})">${inner}</g>`;

function sidePill(x, y, side) {
  const buy = side === "BUY", col = buy ? C.buy : C.sell, w = 214;
  return `${R(x, y, w, 70, { rx: 35, fill: col })}${at(x + 46, y + 35, buy ? icon.up("#06100b") : icon.down("#06100b"))}${T(x + 80, y + 48, side, { size: 38, w: 800, fill: "#06100b", ls: 2 })}`;
}

/** R-multiple map: SL … entry … TP1 TP2 TP3 on an equal-R ruler. reached = number of targets hit (0..3). */
function ruler(y, rr, o = {}) {
  const pts = [{ k: "SL", v: -1, col: C.sell }, { k: "ENTRY", v: 0, col: C.text }, ...rr.map((v, i) => ({ k: "TP" + (i + 1), v, col: C.buy }))];
  const x0 = M + 54, x1 = W - M - 54, last = rr[rr.length - 1] || 2, px = (v) => x0 + ((v + 1) / (1 + last)) * (x1 - x0);
  const reached = o.reached || 0, stopped = !!o.stopped;
  let s = T(M, y, "R-MULTIPLE MAP", { size: 22, w: 700, fill: C.dim, ls: 4 });
  const by = y + 70;
  s += R(px(-1), by - 9, px(0) - px(-1), 18, { rx: 9, fill: C.sell, op: stopped ? 0.95 : 0.55 });
  s += R(px(0), by - 9, px(last) - px(0), 18, { rx: 9, fill: C.buy, op: 0.22 });
  if (reached > 0) s += R(px(0), by - 9, px(rr[Math.min(reached, rr.length) - 1]) - px(0), 18, { rx: 9, fill: "url(#win)" });
  for (const p of pts) {
    const hit = p.k.startsWith("TP") && +p.k.slice(2) <= reached, bad = p.k === "SL" && stopped, x = px(p.v);
    s += `<circle cx="${x}" cy="${by}" r="${hit || bad ? 17 : 13}" fill="${hit ? C.buy : bad ? C.sell : C.bg2}" stroke="${p.col}" stroke-width="4"/>`;
    if (hit) s += `<path d="M ${x - 6} ${by} l 4.5 5 l 8.5 -10" fill="none" stroke="#06100b" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>`;
    s += T(x, by - 32, p.k, { size: 23, w: 800, fill: p.col, anchor: "middle", ls: 1 });
    s += T(x, by + 50, p.v === 0 ? "0R" : (p.v > 0 ? "+" : "−") + Math.abs(p.v) + "R", { size: 23, w: 600, fill: C.muted, anchor: "middle" });
  }
  return s;
}

/** rows of level prices */
function levels(y, rows) {
  const h = 92, tot = rows.length * h;
  let s = R(M, y, W - 2 * M, tot, { rx: 28, fill: C.panel, stroke: C.line, sw: 2 });
  rows.forEach((r, i) => {
    const ry = y + i * h, mid = ry + h / 2;
    if (i) s += `<line x1="${M + 30}" y1="${ry}" x2="${W - M - 30}" y2="${ry}" stroke="${C.line}" stroke-width="2"/>`;
    s += R(M + 26, ry + 24, 8, h - 48, { rx: 4, fill: r.col });
    s += T(M + 56, mid - 4, r.label, { size: 28, w: 800, fill: r.col, ls: 1 });
    s += T(M + 56, mid + 28, r.sub, { size: 23, w: 500, fill: C.muted });
    s += T(W - M - 34, mid + 16, r.price, { size: 48, w: 800, fill: r.hit ? C.buy : C.text, anchor: "end" });
  });
  return { svg: s, h: tot };
}

function checklist(y, title, items) {
  const rowH = 47, pad = 74, h = pad + items.length * rowH + 16;
  let s = R(M, y, W - 2 * M, h, { rx: 28, fill: C.panel, stroke: C.line, sw: 2 }) + T(M + 34, y + 50, title, { size: 22, w: 700, fill: C.dim, ls: 4 });
  items.forEach((it, i) => {
    const cy = y + pad + i * rowH + 12, col = it.kind === "ok" ? C.buy : it.kind === "warn" ? C.amber : it.kind === "link" ? C.lime : C.dim;
    s += at(M + 52, cy, (icon[it.kind === "ok" ? "check" : it.kind] || icon.no)(col, 17));
    s += T(M + 88, cy + 10, it.text, { size: 28, w: it.kind === "no" ? 500 : 600, fill: it.kind === "no" ? C.muted : C.text });
  });
  return { svg: s, h };
}

function footer(y, lines, site) {
  let s = `<line x1="${M}" y1="${y}" x2="${W - M}" y2="${y}" stroke="${C.line}" stroke-width="2"/>`, yy = y + 46;
  for (const l of lines) { s += T(M, yy, l, { size: 26, w: 600, fill: C.muted }); yy += 40; }
  s += T(M, yy + 6, site, { size: 26, w: 800, fill: C.lime }); yy += 54;
  return { svg: s, end: yy };
}
const disclaimer = (y, txt) => wrap(txt, 20, W - 2 * M, 0.5).map((l, i) => T(M, y + i * 28, l, { size: 20, w: 400, fill: C.dim })).join("");

const wrapSvg = (H, accent, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Inter">${defs(accent)}${bgLayer(H, accent)}${body}</svg>`;

/** parse the emoji checklist lines (same text as the plain message) into icon rows */
export function itemsFromLines(lines) {
  return lines.map((l) => {
    const t = String(l).replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    const kind = t.startsWith("✅") ? "ok" : t.startsWith("🔗") ? "link" : t.startsWith("⚠") ? "warn" : "no";
    return { kind, text: t.replace(/^(✅|▫️|🔗|⚠️|⚠)\s*/, "") };
  });
}

/* ===================== 1) New A+ signal ===================== */
export function signalCard(d) {
  const buy = d.side === "BUY", accent = buy ? C.buy : C.sell;
  const rows = [{ label: "STOP LOSS", sub: `risk ${d.risk}`, price: d.sl, col: C.sell },
    { label: `TARGET 1 · ${d.rr[0]}R`, sub: "move SL to entry", price: d.tp1, col: C.buy },
    { label: `TARGET 2 · ${d.rr[1]}R`, sub: d.tp3 ? "take profit" : "final target", price: d.tp2, col: C.buy },
    ...(d.tp3 ? [{ label: `TARGET 3 · ${d.rr[2]}R`, sub: "runner", price: d.tp3, col: C.buy }] : [])];
  let y = 190, b = header(d.test ? "SAMPLE · NOT A SIGNAL" : `A+ ${d.mode}`);
  b += sidePill(M, y, d.side) + T(M + 244, y + 50, `${d.hTf} → ${d.eTf}`, { size: 30, w: 700, fill: C.muted });
  b += T(M, y + 190, d.sym, { size: 124, w: 800 }) + T(M, y + 244, `${d.name} · ${d.n}/${d.total} checks`, { size: 32, w: 600, fill: C.muted });
  y += 292;
  b += R(M, y, W - 2 * M, 200, { rx: 30, fill: C.panel, stroke: accent, sw: 3 }) + R(M, y, 14, 200, { rx: 7, fill: accent });
  b += T(M + 44, y + 56, "ENTER NOW NEAR", { size: 24, w: 700, fill: C.dim, ls: 4 }) + T(M + 44, y + 150, d.entry, { size: 96, w: 800 });
  b += at(W - M - 74, y + 84, icon.hourglass(C.amber)) + T(W - M - 130, y + 62, "Entry window until", { size: 24, w: 600, fill: C.muted, anchor: "end" })
    + T(W - M - 130, y + 118, `${d.until} ICT`, { size: 46, w: 800, fill: C.amber, anchor: "end" }) + T(W - M - 130, y + 170, "skip if TP1 already passed", { size: 22, w: 500, fill: C.dim, anchor: "end" });
  y += 236;
  b += ruler(y, d.rr); y += 140 + 14;
  const lv = levels(y, rows); b += lv.svg; y += lv.h + 30;
  const cl = checklist(y, `A+ CHECKLIST · ${d.n}/${d.total}`, d.items); b += cl.svg; y += cl.h + 40;
  const f = footer(y, [`Signal ${d.at} ICT`, `Time stop: exit if no TP or SL within ${d.timeStop}`], d.site); b += f.svg;
  b += disclaimer(f.end + 6, d.disclaimer); const H = f.end + 6 + 28 * Math.ceil(wrap(d.disclaimer, 20, W - 2 * M, 0.5).length) + 44;
  return wrapSvg(H, accent, b);
}

/* ===================== 2) Result / follow-up (TP hit, SL, expired, closed) ===================== */
const KIND = {
  tp: { col: C.buy, ico: "tick" }, win: { col: C.gold, ico: "trophy" }, sl: { col: C.sell, ico: "cross" },
  expired: { col: C.gray, ico: "clock" }, closed: { col: C.amber, ico: "hourglass" }, window: { col: C.amber, ico: "hourglass" },
};
export function resultCard(d) {
  const k = KIND[d.kind] || KIND.tp, buy = d.side === "BUY";
  let y = 190, b = header(d.mode);
  b += R(M, y, W - 2 * M, 250, { rx: 34, fill: C.panel, stroke: k.col, sw: 3 }) + R(M, y, 14, 250, { rx: 7, fill: k.col });
  b += `<circle cx="${M + 130}" cy="${y + 125}" r="76" fill="${k.col}" fill-opacity=".14" stroke="${k.col}" stroke-width="3"/>` + at(M + 130, y + 125, icon[k.ico](k.col));
  b += T(M + 244, y + 118, d.title, { size: d.title.length > 11 ? 70 : 84, w: 800, fill: k.col });
  b += T(M + 244, y + 176, d.sub, { size: 32, w: 600, fill: C.muted });
  if (d.rText) { const w = tw(d.rText, 46, 0.66) + 56; b += `${R(W - M - 40 - w, y + 40, w, 74, { rx: 37, fill: k.col })}${T(W - M - 40 - w / 2, y + 92, d.rText, { size: 46, w: 800, fill: "#06100b", anchor: "middle" })}`; }
  y += 290;
  b += R(M, y, W - 2 * M, 150, { rx: 30, fill: C.panel, stroke: C.line, sw: 2 });
  b += `${R(M + 30, y + 38, 190, 62, { rx: 31, fill: buy ? C.buy : C.sell })}${at(M + 72, y + 69, buy ? icon.up("#06100b") : icon.down("#06100b"))}${T(M + 100, y + 83, d.side, { size: 34, w: 800, fill: "#06100b", ls: 2 })}`;
  b += T(M + 250, y + 78, d.sym, { size: 56, w: 800 }) + T(M + 250, y + 118, `${d.name} · entry ${d.entry}`, { size: 26, w: 600, fill: C.muted });
  b += T(W - M - 34, y + 70, d.modeFull, { size: 24, w: 700, fill: C.lime, anchor: "end", ls: 2 }) + T(W - M - 34, y + 112, d.at + " ICT", { size: 24, w: 500, fill: C.dim, anchor: "end" });
  y += 190;
  if (d.rr && d.rr.length) { b += ruler(y, d.rr, { reached: d.hits || 0, stopped: d.kind === "sl" }); y += 170; }
  if (d.note) { const ls = wrap(d.note, 28, W - 2 * M - 40, 0.54); b += ls.map((l, i) => T(M, y + 30 + i * 40, l, { size: 28, w: 600, fill: C.text })).join(""); y += 30 + ls.length * 40 + 10; }
  const f = footer(y + 10, [], d.site); b += f.svg; const H = f.end + 4;
  return wrapSvg(H, k.col, b);
}

/* ===================== 3) "Get ready" heads-up ===================== */
export function readyCard(d) {
  const accent = C.amber;
  let y = 190, b = header(d.mode);
  b += R(M, y, W - 2 * M, 230, { rx: 34, fill: C.panel, stroke: accent, sw: 3 }) + R(M, y, 14, 230, { rx: 7, fill: accent });
  b += `<circle cx="${M + 130}" cy="${y + 115}" r="76" fill="${accent}" fill-opacity=".14" stroke="${accent}" stroke-width="3"/>` + at(M + 130, y + 115, icon.hourglass(accent));
  b += T(M + 244, y + 104, "GET READY", { size: 84, w: 800, fill: accent }) + T(M + 244, y + 160, `Waiting for the trigger candle on ${d.eTf}`, { size: 30, w: 600, fill: C.muted });
  y += 270;
  b += sidePill(M, y, d.side) + T(M + 244, y + 50, d.sym, { size: 52, w: 800 }) + T(M + 244 + tw(d.sym, 52, 0.7) + 24, y + 50, `${d.name}`, { size: 30, w: 600, fill: C.muted });
  y += 112;
  const cl = checklist(y, "ENTRY TIMER · WAITING FOR TRIGGER", d.items); b += cl.svg; y += cl.h + 30;
  b += T(M, y + 20, `Price ${d.price} is in the pullback zone.`, { size: 28, w: 700 }); y += 44;
  const ls = wrap(d.hint, 26, W - 2 * M, 0.54); b += ls.map((l, i) => T(M, y + 20 + i * 36, l, { size: 26, w: 500, fill: C.muted })).join(""); y += ls.length * 36 + 24;
  b += T(M, y + 24, "Not an entry yet. Don't front-run the trigger.", { size: 26, w: 700, fill: accent }); y += 60;
  const f = footer(y, [`${d.at} ICT`], d.site); b += f.svg;
  return wrapSvg(f.end + 4, accent, b);
}
