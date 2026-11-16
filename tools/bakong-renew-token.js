#!/usr/bin/env node
/* Renew your Bakong Open API token and see when it expires.
   Run it from a computer with a CAMBODIAN internet connection: Bakong refuses these calls from other countries (an empty 403).
   Needs Node 18 or newer. No packages to install.

     node bakong-renew-token.js you@example.com            renew the token for that registered email
     node bakong-renew-token.js you@example.com --sit      use the test (SIT) server instead of production
     node bakong-renew-token.js --check <token>            only test a token you already have (and show its expiry)
     BAKONG_EMAIL=you@example.com node bakong-renew-token.js

   Then paste the token into: Anajak dashboard -> Settings (Bakong token). Never post it in chat or commit it to git.
   Bakong allows about 100 renewals a day: run it once, not in a loop. */
'use strict';

const args = process.argv.slice(2);
const flag = (f) => { const i = args.indexOf(f); if (i < 0) return null; args.splice(i, 1); return true; };
const sit = flag('--sit');
const ci = args.indexOf('--check'); let checkTok = null; if (ci >= 0) { checkTok = args[ci + 1] || ''; args.splice(ci, 2); }
const urlI = args.indexOf('--url'); let urlArg = null; if (urlI >= 0) { urlArg = args[urlI + 1] || ''; args.splice(urlI, 2); }
const email = (args[0] || process.env.BAKONG_EMAIL || '').trim();
const BASE = (urlArg || (sit ? 'https://sit-api-bakong.nbc.gov.kh' : 'https://api-bakong.nbc.gov.kh')).replace(/\/$/, '');

const say = (s = '') => console.log(s);
function expiryOf(token) {
  try {
    const p = JSON.parse(Buffer.from(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return p.exp ? new Date(p.exp * 1000) : null;
  } catch (_) { return null; }
}
function showExpiry(token) {
  const exp = expiryOf(token);
  if (!exp) { say('Expiry: could not read it from the token.'); return; }
  const days = Math.round((exp - Date.now()) / 86400000);
  say('Expires: ' + exp.toISOString().replace('T', ' ').slice(0, 16) + ' UTC  (' + (days >= 0 ? 'in ' + days + ' days' : 'EXPIRED ' + -days + ' days ago') + ')');
  if (days >= 0 && days <= 7) say('Heads up: renew again before then, or payments will stop.');
}
async function call(path, body, token) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + path, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
  return { res, json, text };
}
function explain(res, json, text) {
  if (!json && (res.status === 403 || res.status === 451)) {
    say('Bakong refused this connection (HTTP ' + res.status + ', empty answer). It only answers from Cambodia.');
    say('Run this on a computer or phone hotspot that is really connected to a Cambodian network (turn off any VPN).');
  } else if (json) {
    say('Bakong answered: ' + (json.responseMessage || (json.status && json.status.message) || JSON.stringify(json)) + '  (HTTP ' + res.status + ')');
  } else say('Unexpected answer (HTTP ' + res.status + '): ' + text.slice(0, 160));
}

(async () => {
  say('Bakong server: ' + BASE + (sit ? '  (test / SIT)' : ''));
  if (checkTok !== null) {
    const tok = checkTok.replace(/^Bearer\s+/i, '').trim();
    if (!tok) { say('Give the token after --check.'); process.exit(2); }
    showExpiry(tok);
    const { res, json, text } = await call('/v1/check_transaction_by_md5', { md5: '0'.repeat(32) }, tok);
    if (res.status === 401 || (json && json.responseCode === 401)) { say('RESULT: Bakong REJECTS this token. Renew it (run again with your email).'); process.exit(1); }
    if (json && (json.responseCode === 0 || json.responseCode === 1)) { say('RESULT: Bakong accepts this token (it answered normally for a made-up payment).'); return; }
    explain(res, json, text); process.exit(1);
  }
  if (!email || !email.includes('@')) {
    say('Usage:  node bakong-renew-token.js you@example.com    (the email you registered with Bakong Open API)');
    process.exit(2);
  }
  say('Renewing the token for ' + email + ' ...');
  const { res, json, text } = await call('/v1/renew_token', { email });
  const token = json && json.responseCode === 0 && json.data && json.data.token;
  if (!token) { explain(res, json, text); say(); say('No new token was issued. Nothing was changed.'); process.exit(1); }
  say();
  showExpiry(token);
  say();
  say('YOUR NEW TOKEN (copy everything between the lines):');
  say('-----------------------------------------------');
  say(token);
  say('-----------------------------------------------');
  say();
  say('Next: paste it into Anajak dashboard -> Settings (Bakong token), save, then make a new test payment.');
  say('To double-check it first:  node bakong-renew-token.js --check <token>');
})().catch((e) => { console.error('Could not reach Bakong:', e && e.message ? e.message : e); process.exit(1); });
