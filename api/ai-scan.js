// Vercel Serverless Function: GET /api/ai-scan?key=CRON_SECRET
// Runs the same A+ scalping engine as the AI Desk on the latest CLOSED M5 candle and, when a setup is A+,
// posts it to your Telegram channel. Later runs follow each signal and reply with TP / SL / expiry updates.
//
// Called every 5 minutes by Supabase pg_cron (see premium/ai-telegram-setup.sql).
// Environment variables (Vercel → Settings → Environment Variables):
//   TELEGRAM_BOT_TOKEN          token from @BotFather
//   TELEGRAM_CHAT_ID            @yourchannel  or  -100xxxxxxxxxx
//   CRON_SECRET                 any long random text; the scheduler must send it as ?key=
//   SUPABASE_URL                https://xxxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY   service_role key (server only — never put it in index.html)
//   AI_SYMBOLS                  optional, default "XAUUSD" (e.g. "XAUUSD,XAGUSD")
//   SITE_URL                    optional, default https://truetradejourney.vercel.app
// Extra: ?key=...&test=1 sends a test message so you can check the bot can post in the channel.
const AiEng = require('./_lib/engine.js');

const SITE = (process.env.SITE_URL || 'https://truetradejourney.vercel.app').replace(/\/$/, '');
const SB = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SBK = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const TG = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT = process.env.TELEGRAM_CHAT_ID || '';

const ict = new Intl.DateTimeFormat('en-GB', {timeZone: 'Asia/Phnom_Penh', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false});
const hm = new Intl.DateTimeFormat('en-GB', {timeZone: 'Asia/Phnom_Penh', hour: '2-digit', minute: '2-digit', hour12: false});
const fx = (v, sym) => Number(v).toFixed(sym === 'XAGUSD' ? 3 : 2);
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const TRIG = {engulf: 'Engulfing', pin: 'Pin bar', momentum: 'Momentum close'};

async function sb(path, opt = {}) {
  const r = await fetch(SB + '/rest/v1/' + path, {
    ...opt,
    headers: {apikey: SBK, Authorization: 'Bearer ' + SBK, 'Content-Type': 'application/json', ...(opt.headers || {})},
  });
  const txt = await r.text();
  if (!r.ok) throw new Error('supabase ' + r.status + ': ' + txt.slice(0, 200));
  return txt ? JSON.parse(txt) : null;
}

async function tg(text, replyTo) {
  const r = await fetch(`https://api.telegram.org/bot${TG}/sendMessage`, {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({chat_id: CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true,
      ...(replyTo ? {reply_parameters: {message_id: Number(replyTo), allow_sending_without_reply: true}} : {})}),
  });
  const j = await r.json();
  if (!j.ok) throw new Error('telegram: ' + (j.description || r.status));
  return j.result.message_id;
}

async function candles(sym) {
  // through our own cached endpoint, so the website and the bot share one upstream call per candle
  const r = await fetch(`${SITE}/api/candles?symbol=${sym}`, {headers: {'User-Agent': 'arom-ai-scan'}});
  const j = await r.json();
  if (!r.ok || !Array.isArray(j.candles)) throw new Error('candles: ' + (j.error || r.status));
  return j;
}

async function newsFn() {
  try {
    const r = await fetch(`${SITE}/api/news?week=this`);
    if (!r.ok) return () => null;
    const ev = (await r.json()).filter(e => String(e.impact) === 'High').map(e => Date.parse(e.date)).filter(isFinite);
    return tSec => !ev.some(ms => Math.abs(ms - tSec * 1000) <= 30 * 60000);
  } catch (e) { return () => null; }      // unknown news = the news check fails = no A+ (safe side)
}

function signalText(sym, s, ev, src) {
  const buy = s.side === 'BUY';
  return [
    `${buy ? '🟢' : '🔴'} <b>A+ ${s.side} · ${sym}</b>  <i>(M5 scalp)</i>`,
    '',
    `<b>Entry:</b> <code>${fx(s.entry, sym)}</code>`,
    `<b>SL:</b> <code>${fx(s.sl, sym)}</code>`,
    `<b>TP1:</b> <code>${fx(s.tp1, sym)}</code>  (1R)`,
    `<b>TP2:</b> <code>${fx(s.tp2, sym)}</code>  (2R)`,
    `<b>TP3:</b> <code>${fx(s.tp3, sym)}</code>  (3R)`,
    '',
    `Trigger: ${esc(TRIG[s.trigger] || s.trigger)} · Risk ${fx(s.risk, sym)}`,
    `M15 trend ${buy ? 'up' : 'down'} · checks ${ev.checks.filter(c => c.pass).length}/11 ✅`,
    `🕒 ${ict.format(new Date(s.t * 1000))} ICT · valid until ${hm.format(new Date(s.validUntil * 1000))}`,
    `↪ Move SL to entry after TP1`,
    '',
    `<a href="${SITE}/analysis#aiPanel">AROM TRADE · AI Desk</a>`,
    `<i>Data: ${esc(src)}. Algorithmic analysis, not financial advice. Trade at your own risk.</i>`,
  ].join('\n');
}

const UPDATE = {
  1: '✅ <b>TP1 hit</b> (+1R) — move SL to entry',
  2: '✅✅ <b>TP2 hit</b> (+2R)',
  3: '🏆 <b>TP3 hit</b> (+3R) — target complete',
};

module.exports = async (req, res) => {
  const q = req.query || {};
  if (!process.env.CRON_SECRET || q.key !== process.env.CRON_SECRET) return res.status(401).json({error: 'unauthorized'});
  const missing = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].filter(k => !process.env[k]);
  if (missing.length) return res.status(500).json({error: 'missing env: ' + missing.join(', ')});
  res.setHeader('Cache-Control', 'no-store');

  if (q.test) {
    try {
      const id = await tg(`🤖 <b>AROM TRADE AI bot connected</b>\nA+ scalping signals will be posted here automatically.\n<a href="${SITE}/analysis">Open AI Desk</a>`);
      return res.status(200).json({ok: true, message_id: id});
    } catch (e) { return res.status(500).json({error: String(e.message || e)}); }
  }

  const symbols = String(process.env.AI_SYMBOLS || 'XAUUSD').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  const news = await newsFn();
  const report = [];
  for (const sym of symbols) {
    const out = {symbol: sym, posted: null, updates: []};
    try {
      const data = await candles(sym), m5 = data.candles, P = AiEng.prep(m5), n = m5.length - 1;
      out.lastCandle = ict.format(new Date((m5[n].t + 300) * 1000));

      // 1) follow-up on signals still running
      const open = await sb(`ai_signals?symbol=eq.${sym}&status=eq.open&select=*&order=t.asc`);
      for (const row of open) {
        const i = m5.findIndex(b => b.t + 300 === Number(row.t));
        if (i < 0) { if (Date.now() / 1000 - row.t > 86400) await sb(`ai_signals?id=eq.${row.id}`, {method: 'PATCH', body: JSON.stringify({status: 'closed', result: 'unknown'})}); continue; }
        const sim = AiEng.simulate(m5, i, {side: row.side, sl: +row.sl, tp1: +row.tp1, tp2: +row.tp2, tp3: +row.tp3});
        const r = sim.res, hits = r === 'open' || r === 'sl' || r === 'expired' ? 0 : +r.slice(2, 3);
        const closed = !(r === 'open' || r.endsWith('+'));
        const msgs = [];
        for (let k = (row.hits || 0) + 1; k <= hits; k++) msgs.push(UPDATE[k]);
        if (closed && r === 'sl') msgs.push('❌ <b>SL hit</b> (−1R)');
        else if (closed && r === 'expired') msgs.push('⏱ <b>Expired</b> — no TP or SL within 4 hours');
        else if (closed && hits > 0 && hits < 3) msgs.push(`⏹ <b>Closed</b> — price returned to the stop after TP${hits}`);
        for (const m of msgs) { try { await tg(`${m}\n${sym} ${row.side} @ ${fx(row.entry, sym)}`, row.tg_message_id); } catch (e) {} }
        if (msgs.length || closed) {
          await sb(`ai_signals?id=eq.${row.id}`, {method: 'PATCH', body: JSON.stringify({hits, status: closed ? 'closed' : 'open', result: closed ? r : null, updated_at: new Date().toISOString()})});
          out.updates.push({t: row.t, result: r});
        }
      }

      // 2) new A+ on the last two closed candles (covers one missed run); the unique key stops duplicates
      for (const i of [n - 1, n]) {
        const ev = AiEng.evalAt(P, i, news);
        if (!ev.signal) continue;
        const s = ev.signal;
        if (Date.now() / 1000 > s.validUntil) continue;            // too late to act on
        const ins = await sb('ai_signals?on_conflict=symbol,t', {
          method: 'POST', headers: {Prefer: 'resolution=ignore-duplicates,return=representation'},
          body: JSON.stringify({symbol: sym, t: s.t, side: s.side, entry: s.entry, sl: s.sl, tp1: s.tp1, tp2: s.tp2, tp3: s.tp3, risk: s.risk, trigger: s.trigger, source: data.source}),
        });
        if (!ins || !ins.length) continue;                          // already posted
        const mid = await tg(signalText(sym, s, ev, data.source));
        await sb(`ai_signals?id=eq.${ins[0].id}`, {method: 'PATCH', body: JSON.stringify({tg_message_id: mid})});
        out.posted = {side: s.side, entry: s.entry, t: s.t};
      }
      const last = AiEng.evalAt(P, n, news);
      out.grade = last.grade; out.bias = last.side;
    } catch (e) { out.error = String(e.message || e); }
    report.push(out);
  }
  return res.status(200).json({ok: true, at: new Date().toISOString(), report});
};
