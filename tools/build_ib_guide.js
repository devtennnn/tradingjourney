// Run: node tools/build_ib_guide.js  (needs the local server on 127.0.0.1:8766 serving this repo, and Playwright). Writes downloads/ib-partner-guide-{en,km}.pdf
// Builds downloads/ib-partner-guide-{en,km}.pdf from the same texts the /ib page uses (T in index.html)
const { chromium } = require('playwright'); const fs = require('fs');
const OUT = '/home/user/tradingjourney/downloads/';
const logo = fs.readFileSync('/home/user/tradingjourney/logo/arom-app-icon.svg', 'utf8');
const X = { // texts only the guide needs
 en: {doc:'IB & Community Partner Guide', sub:'Rules and how to apply', price:'$19.99', per:'per 30 days · KHQR · no auto-renew', what:'What you get', team:'Support team', how:'How to apply', rules:'Rules', review:'Review and notices',
  rv:['After you send your profile, the admin checks it. A review usually takes <b>4 to 12 hours</b>.','Your listing is <b>not shown</b> until the admin approves it. Every later edit goes back to review.','You get a <b>Telegram message</b> when your profile is received, approved, needs changes or is hidden. Connect Telegram from your IB dashboard.'],
  codes:'Promo codes in detail', cd:['3 codes at 5 % are created automatically after payment.','Each member can use a code once. Codes work on Premium, Elite and Ultra.','Codes cannot be used on your own account, on the IB plan or on the course.','Codes stay valid while your IB plan is active. Renewing extends them, no extra codes are added.','10 % or 15 % codes: one open request at a time, granted only by the admin.'],
  need:'What to prepare', nd:['Broker name and broker logo (PNG, WebP or JPEG, max 100 KB)','Your name and your photo (max 100 KB)','Your referral link (must start with https://)','Rebate per lot in USD and an optional note','A description of at least 80 characters','Your Telegram contact (optional)'],
  contact:'Questions?', ct:'Contact the admin in the AROM TRADE Telegram group: aromx.trade/group', site:'Apply at aromx.trade/ib', nfa:'Not financial advice. Trading carries risk.', page:'Page'},
 km: {doc:'មគ្គុទ្ទេសក៍ដៃគូ IB និងសហគមន៍', sub:'ច្បាប់ និងរបៀបស្នើសុំ', price:'$19.99', per:'ក្នុង 30 ថ្ងៃ · KHQR · មិនកាត់លុយដោយស្វ័យប្រវត្តិ', what:'អ្វីដែលអ្នកទទួលបាន', team:'ក្រុមការងារគាំទ្រ', how:'របៀបស្នើសុំ', rules:'ច្បាប់', review:'ការពិនិត្យ និងការជូនដំណឹង',
  rv:['ក្រោយអ្នកផ្ញើ Profile, Admin នឹងពិនិត្យ។ ការពិនិត្យជាធម្មតាចំណាយពេល <b>4 ទៅ 12 ម៉ោង</b>។','ការបង្ហាញរបស់អ្នក <b>មិនចេញទេ</b> រហូតដល់ Admin អនុម័ត។ រាល់ការកែប្រែក្រោយមក ត្រឡប់ទៅពិនិត្យម្តងទៀត។','អ្នកនឹងទទួលបាន <b>សារ Telegram</b> ពេល Profile ត្រូវបានទទួល អនុម័ត ត្រូវកែ ឬត្រូវលាក់។ សូមភ្ជាប់ Telegram ពី Dashboard IB។'],
  codes:'លម្អិតអំពីលេខកូដបញ្ចុះតម្លៃ', cd:['លេខកូដ 5 % ចំនួន 3 បង្កើតដោយស្វ័យប្រវត្តិ ក្រោយការបង់ប្រាក់។','សមាជិកម្នាក់ប្រើលេខកូដបានម្តង។ ប្រើបានលើ Premium, Elite និង Ultra។','មិនអាចប្រើលើគណនីផ្ទាល់ខ្លួន លើគម្រោង IB ឬលើវគ្គសិក្សាបានទេ។','លេខកូដមានសុពលភាពពេលគម្រោង IB សកម្ម។ ការបន្តពន្យារសុពលភាព ដោយមិនបន្ថែមលេខកូដថ្មីទេ។','លេខកូដ 10 % ឬ 15 %៖ ស្នើបានម្តងមួយ ហើយផ្តល់ឲ្យតែពេល Admin អនុម័ត។'],
  need:'អ្វីដែលត្រូវរៀបចំ', nd:['ឈ្មោះ Broker និង Logo Broker (PNG, WebP ឬ JPEG មិនលើស 100 KB)','ឈ្មោះ និងរូបរបស់អ្នក (មិនលើស 100 KB)','Referral link របស់អ្នក (ត្រូវចាប់ផ្តើមដោយ https://)','Rebate ក្នុងមួយ lot (USD) និងកំណត់ចំណាំ (មិនបង្ខំ)','ការពិពណ៌នាយ៉ាងតិច 80 តួអក្សរ','ទំនាក់ទំនង Telegram (មិនបង្ខំ)'],
  contact:'មានសំណួរ?', ct:'សូមទាក់ទង Admin ក្នុងក្រុម Telegram របស់ AROM TRADE៖ aromx.trade/group', site:'ស្នើសុំនៅ aromx.trade/ib', nfa:'មិនមែនជាដំបូន្មានហិរញ្ញវត្ថុទេ។ ការជួញដូរមានហានិភ័យ។', page:'ទំព័រ'},
};
const css = `@page{size:A4;margin:0}*{box-sizing:border-box}body{margin:0;font-family:Inter,'Kantumruy Pro',sans-serif;color:#0b1424;-webkit-print-color-adjust:exact;print-color-adjust:exact}
body.km{font-family:'Kantumruy Pro',Inter,sans-serif;line-height:1.7}
.pg{width:210mm;height:297mm;padding:14mm 15mm 16mm;position:relative;page-break-after:always;overflow:hidden}
.cover{background:#000412;color:#fff;display:flex;flex-direction:column;justify-content:space-between}
.cover:before{content:"";position:absolute;width:150mm;height:150mm;right:-50mm;top:-50mm;border-radius:50%;background:radial-gradient(circle,rgba(43,240,138,.35),transparent 65%)}
.cover:after{content:"";position:absolute;width:130mm;height:130mm;left:-60mm;bottom:-60mm;border-radius:50%;background:radial-gradient(circle,rgba(56,140,255,.28),transparent 65%)}
.brand{display:flex;align-items:center;gap:12px;font:900 20px/1 Inter;letter-spacing:2px;position:relative;z-index:1}.brand svg{width:44px;height:44px}.brand span{color:#2bf08a}
.cover h1{font-size:44px;line-height:1.15;margin:0 0 14px;letter-spacing:-.5px;position:relative;z-index:1}.km .cover h1{font-size:38px;line-height:1.45}
.cover .sub{font-size:20px;color:#8af7c2;margin:0;position:relative;z-index:1}
.pill{display:inline-block;border:1px solid rgba(43,240,138,.5);color:#2bf08a;border-radius:99px;padding:7px 14px;font:800 11px/1 Inter;letter-spacing:2px;margin-bottom:20px}
.pricebox{position:relative;z-index:1;border:1px solid rgba(255,255,255,.15);border-radius:18px;padding:20px 22px;background:rgba(255,255,255,.04)}
.pricebox>b{font:900 52px/1 Inter;color:#8af7c2}.pricebox span{display:block;color:#b8c4d6;margin-top:8px;font-size:14px}
.grid4{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:16px}.grid4 div{border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:12px 14px;font-size:13px;color:#dfe7f2}
.grid4 div b{display:block;color:#fff;font-size:14.5px;margin-bottom:3px}
.foot{position:relative;z-index:1;display:flex;justify-content:space-between;font-size:12px;color:#8592a6}
h2{font-size:26px;margin:0 0 12px;letter-spacing:-.3px;display:flex;align-items:center;gap:10px}h2:before{content:"";width:6px;height:26px;border-radius:3px;background:#2bf08a}
.km h2{font-size:23px}
.sec{margin-bottom:20px}
.card{border:1px solid #dbe3ee;border-radius:14px;padding:12px 14px;margin-bottom:9px;font-size:13.5px;line-height:1.6;color:#3d4b60;background:#f7fafc}
.card b,.card strong{color:#0b1424}.card>b:first-child{display:block;font-size:16px;margin-bottom:2px}
.steps{counter-reset:s}.steps .card{position:relative;padding-left:56px;counter-increment:s}.steps .card:before{content:counter(s);position:absolute;left:14px;top:12px;width:30px;height:30px;border-radius:50%;background:#2bf08a;color:#03150b;font:900 15px/30px Inter;text-align:center}
.rules{counter-reset:r}.rules .card{position:relative;padding-left:56px;counter-increment:r}.rules .card:before{content:"0" counter(r);position:absolute;left:14px;top:13px;font:900 15px/1 Inter;color:#13a85a}
ul.ck{list-style:none;padding:0;margin:0;display:grid;gap:7px}ul.ck li{position:relative;padding-left:26px;font-size:13.5px;line-height:1.55;color:#3d4b60}ul.ck li:before{content:"✓";position:absolute;left:0;top:0;width:18px;height:18px;border-radius:50%;background:#dff9ec;color:#13a85a;font:900 11px/18px Inter;text-align:center}
.hl{border-radius:16px;padding:14px 16px;background:#062014;color:#d6ffe9;font-size:14px;line-height:1.6}.hl b{color:#2bf08a}
.team{display:grid;grid-template-columns:repeat(3,1fr);gap:9px}.team .card{text-align:left;margin:0}
.two{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.pf{position:absolute;left:16mm;right:16mm;bottom:9mm;display:flex;justify-content:space-between;font-size:10.5px;color:#8592a6;border-top:1px solid #e3e9f1;padding-top:6px}`;
(async () => { const b = await chromium.launch();
 for (const L of ['en', 'km']) {
  const p = await b.newPage();
  await p.goto('http://127.0.0.1:8766/' + (L === 'km' ? 'km/ib' : 'ib'), { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(800);
  const keys = ['ibIntro','ibG1','ibG1p','ibG2','ibG2p','ibG3','ibG3p','ibG4','ibG4p','ibTeam1','ibTeam2','ibTeam3','ibS1','ibS2','ibS3','ibS4','ibS5','ibR1','ibR2','ibR3','ibR4','ibR5','ibR6','ibDirDisc','ibTeamSub'];
  const t = await p.evaluate(([L, keys]) => { S.lang = L; return Object.fromEntries(keys.map(k => [k, t(k)])); }, [L, keys]);
  await p.close();
  const x = X[L], date = new Date().toISOString().slice(0, 10);
  const pf = n => `<div class="pf"><span>AROM TRADE · ${x.doc}</span><span>${x.page} ${n} / 4 · aromx.trade/ib</span></div>`;
  const html = `<!doctype html><html lang="${L}"><head><meta charset="utf-8"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&family=Kantumruy+Pro:wght@400;600;700&display=block" rel="stylesheet"><style>${css}</style></head><body class="${L}">
<div class="pg cover">
  <div class="brand">${logo}<div>AROM <span>TRADE</span></div></div>
  <div><div class="pill">PARTNER PROGRAM</div><h1>${x.doc}</h1><p class="sub">${x.sub}</p>
    <p style="position:relative;z-index:1;color:#c4cede;font-size:15px;line-height:1.7;max-width:150mm;margin-top:18px">${t.ibIntro}</p></div>
  <div class="pricebox"><b>${x.price}</b><span>${x.per}</span>
    <div class="grid4"><div><b>${t.ibG1}</b></div><div><b>${t.ibG2}</b></div><div><b>${t.ibG3}</b></div><div><b>${t.ibG4}</b></div></div></div>
  <div class="foot"><span>${x.site}</span><span>${date}</span></div>
</div>
<div class="pg">
  <div class="sec"><h2>${x.what}</h2>
    <div class="two"><div class="card"><b>${t.ibG1}</b>${t.ibG1p}</div><div class="card"><b>${t.ibG2}</b>${t.ibG2p}</div><div class="card"><b>${t.ibG3}</b>${t.ibG3p}</div><div class="card"><b>${t.ibG4}</b>${t.ibG4p}</div></div></div>
  <div class="sec"><h2>${x.team}</h2><p style="margin:-4px 0 10px;color:#3d4b60;font-size:13.5px">${t.ibTeamSub}</p>
    <div class="team"><div class="card">${t.ibTeam1}</div><div class="card">${t.ibTeam2}</div><div class="card">${t.ibTeam3}</div></div></div>
  ${pf(2)}
</div>
<div class="pg">
  <div class="sec steps"><h2>${x.how}</h2>${[t.ibS1,t.ibS2,t.ibS3,t.ibS4,t.ibS5].map(s => `<div class="card">${s.replace(/<\/b>/, '</b>')}</div>`).join('')}</div>
  <div class="sec"><h2>${x.review}</h2><div class="hl">${x.rv.join('<br>')}</div></div>
  <div style="height:14px"></div>
  <div class="hl" style="background:#f1f5f9;color:#3d4b60"><b style="color:#0b1424">${x.contact}</b> ${x.ct}<br><small>${t.ibDirDisc}</small></div>
  ${pf(3)}
</div>
<div class="pg">
  <div class="sec rules"><h2>${x.rules}</h2>${[t.ibR1,t.ibR2,t.ibR3,t.ibR4,t.ibR5,t.ibR6].map(s => `<div class="card">${s}</div>`).join('')}</div>
  <div class="two"><div class="sec"><h2>${x.need}</h2><ul class="ck">${x.nd.map(s => `<li>${s}</li>`).join('')}</ul></div>
    <div class="sec"><h2>${x.codes}</h2><ul class="ck">${x.cd.map(s => `<li>${s}</li>`).join('')}</ul></div></div>
  ${pf(4)}
</div></body></html>`;
  const q = await b.newPage(); await q.setContent(html, { waitUntil: 'networkidle' }); await q.evaluate(() => document.fonts.ready);
  const over = await q.evaluate(() => [...document.querySelectorAll('.pg')].map(g => g.scrollHeight > g.clientHeight + 1));
  console.log(L, 'overflow per page', over);
  await q.pdf({ path: OUT + `ib-partner-guide-${L}.pdf`, format: 'A4', printBackground: true, preferCSSPageSize: true });
  await q.screenshot({ path: `pdf_${L}.png`, fullPage: true }); await q.close();
 }
 await b.close(); })();
