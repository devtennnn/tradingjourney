#!/usr/bin/env python3
"""
AROM TRADE page builder.  Run after every edit to index.html:   python3 tools/build_pages.py

index.html is the ONE source for the app. This script writes, from it:
  - index.html, analysis.html, pricing.html, journey.html, news.html, refer.html  (English, one per address)
  - km/<same>.html                                                            (Khmer, served at /km/...)
  - about, methodology, track-record, risk  (+ km/ versions)                  (public trust pages)
  - sitemap.xml                                                               (all of the above, with hreflang pairs)
Each app page gets its own <title>, description, canonical, hreflang, JSON-LD and exactly one <h1>
(the heading of the section that page shows). Khmer pages also have the Khmer text written into the
HTML itself (not only swapped in by JavaScript), so search engines can index it.
Needs python3 and node (node reads the translation table out of index.html).
"""
import datetime, html, json, os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = "https://aromx.trade"
TODAY = datetime.date.today().isoformat()
ESC = lambda s: html.escape(s, quote=True)

# ---------------------------------------------------------------- app pages
# name, path, body data-page, the heading that is this page's <h1>
APP = [
    ("index",    "/",         "main",     'id="heroH1"'),
    ("journey",  "/journey",  "journey",  'id="jrIntroH"'),
    ("news",     "/news",     "news",     'id="nwIntroH"'),
    ("analysis", "/analysis", "analysis", 'id="anH1"'),
    ("pricing",  "/pricing",  "pricing",  'data-i18n-html="prH1"'),
    ("refer",    "/refer",    "refer",    'id="rfH"'),
    ("profile",  "/profile",  "profile",  'id="pfH"'),   # private account page: noindex, not in the sitemap
    ("course",   "/course",   "course",   'id="crH"'),
    ("replay",   "/replay",   "replay",   'id="rpTitle"'),
    ("orderflow", "/orderflow", "orderflow", 'id="ofTitle"'),   # Order flow (Ultra): heatmap, footprint, delta   # Replay mode (Elite / Ultra)   # AROM Academy: outline + free preview public, paid lessons from the database
]
PRIVATE = {"profile"}
HEADINGS = ['id="mtH"', 'id="heroH1"', 'id="jrIntroH"', 'id="nwIntroH"', 'id="anH1"', 'data-i18n-html="prH1"', 'id="rfH"', 'id="pfH"', 'id="crH"', 'id="rpTitle"', 'id="ofTitle"']

META = {
    "en": {
        "index":    ("AROM TRADE — Trading Journal & AI Signals for Gold, BTC and Forex",
                     "Trading journal and AI signals for gold, Bitcoin and forex traders in Cambodia. Log every trade, track your stats and get A+ setups in English or Khmer."),
        "journey":  ("AROM TRADE — Trading Journal · Stats & Performance",
                     "Free trading journal: log trades with screenshots, see win rate, profit factor and R multiples, and sync MT5 / MT4 automatically. English and Khmer."),
        "news":     ("AROM TRADE — USD News Calendar & Alerts",
                     "USD economic calendar with high-impact news alerts for gold and forex traders. Signals pause around big releases. All times in Cambodia time."),
        "analysis": ("AROM TRADE — AI Desk · Signals & Market Analysis",
                     "AI Desk: rule-based signals for gold (XAUUSD), Bitcoin and more, with entry, stop loss and targets, plus a USD news bias. Education, not advice."),
        "pricing":  ("AROM TRADE — Pricing · Free, Premium, Elite & Ultra",
                     "AROM TRADE plans: Free, Premium $2.50, Elite $14.99 and Ultra $49.99 per 30 days. No auto-renew, pay with KHQR. Compare every feature."),
        "refer":    ("AROM TRADE — Refer & Earn",
                     "Invite 15 traders who join and use AROM TRADE and get 30 days of Elite free. Earn bonus signals when your referrals buy a plan."),
        "profile":  ("AROM TRADE — My Profile",
                     "Your AROM TRADE account: name, photo, password, plan and expiry, purchase history, Telegram and notification alerts."),
        "orderflow": ("AROM TRADE — Order Flow · Heatmap, Footprint and Delta",
                      "Live order flow for Bitcoin, and for gold through PAXG: order book heatmap, footprint (bid × ask at every price), big trades, delta and CVD. Ultra."),
        "replay":   ("AROM TRADE — Replay Mode · Practise on Past Candles",
                     "Bar replay for gold, Bitcoin and forex: pick a past date, hide the future and practise trades candle by candle, scored in R. Elite and Ultra."),
        "course":   ("AROM Academy — Gold Trading Course in English and Khmer",
                     "Learn to trade gold with a plan: risk management, market structure, A+ setups, order blocks and FVG, and trading psychology. Short lessons and quizzes. Chapter 1 is free."),
    },
    "km": {
        "index":    ("AROM TRADE — កំណត់ហេតុជួញដូរ និងសញ្ញា AI សម្រាប់មាស BTC និង Forex",
                     "កំណត់ហេតុជួញដូរ និងសញ្ញា AI សម្រាប់អ្នកជួញដូរមាស Bitcoin និង Forex នៅកម្ពុជា។ កត់ត្រាការជួញដូរ មើលស្ថិតិ និងទទួល Setup A+ ជាភាសាខ្មែរ។"),
        "journey":  ("AROM TRADE — កំណត់ហេតុជួញដូរ · ស្ថិតិ និងលទ្ធផល",
                     "កំណត់ហេតុជួញដូរឥតគិតថ្លៃ៖ កត់ត្រាការជួញដូរជាមួយរូបភាព មើលអត្រាឈ្នះ កត្តាចំណេញ និង R ហើយធ្វើសមកាលកម្ម MT5 / MT4 ដោយស្វ័យប្រវត្តិ។"),
        "news":     ("AROM TRADE — ប្រតិទិនព័ត៌មាន USD និងការជូនដំណឹង",
                     "ប្រតិទិនសេដ្ឋកិច្ច USD ជាមួយការជូនដំណឹងព័ត៌មានឥទ្ធិពលខ្ពស់ សម្រាប់អ្នកជួញដូរមាស និង Forex។ សញ្ញាផ្អាកនៅពេលព័ត៌មានធំៗ។ ម៉ោងកម្ពុជា។"),
        "analysis": ("AROM TRADE — AI Desk · សញ្ញា និងការវិភាគទីផ្សារ",
                     "AI Desk៖ សញ្ញាផ្អែកលើច្បាប់សម្រាប់មាស (XAUUSD) Bitcoin និងទីផ្សារផ្សេងទៀត ជាមួយ Entry, Stop Loss និងគោលដៅ។ សម្រាប់ការសិក្សា មិនមែនជាដំបូន្មាន។"),
        "pricing":  ("AROM TRADE — តម្លៃ · Free, Premium, Elite និង Ultra",
                     "គម្រោង AROM TRADE៖ Free, Premium $2.50, Elite $14.99 និង Ultra $49.99 ក្នុង ៣០ ថ្ងៃ។ មិនបន្តដោយស្វ័យប្រវត្តិ បង់តាម KHQR។ ប្រៀបធៀបមុខងារទាំងអស់។"),
        "refer":    ("AROM TRADE — ណែនាំមិត្ត និងទទួលរង្វាន់",
                     "អញ្ជើញអ្នកជួញដូរ ១៥ នាក់ដែលចូលរួម និងប្រើ AROM TRADE ហើយទទួល Elite ឥតគិតថ្លៃ ៣០ ថ្ងៃ។ ទទួលសញ្ញាបន្ថែមនៅពេលមិត្តទិញគម្រោង។"),
        "orderflow": ("AROM TRADE — Order Flow · Heatmap, Footprint និង Delta",
                      "Order flow ផ្ទាល់សម្រាប់ Bitcoin និងមាសតាម PAXG៖ Heatmap នៃ Order book, Footprint (Bid × Ask នៅតម្លៃនីមួយៗ), Trade ធំៗ, Delta និង CVD។ Ultra។"),
        "replay":   ("AROM TRADE — Replay Mode · ហាត់ជួញដូរលើទៀនអតីតកាល",
                     "Bar Replay សម្រាប់មាស Bitcoin និង Forex៖ ជ្រើសថ្ងៃអតីតកាល លាក់អនាគត ហើយហាត់ជួញដូរម្ដងមួយទៀន គណនាជា R។ Elite និង Ultra។"),
        "course":   ("AROM Academy — វគ្គសិក្សាជួញដូរមាស ជាភាសាខ្មែរ",
                     "រៀនជួញដូរមាសដោយមានផែនការ៖ ការគ្រប់គ្រងហានិភ័យ រចនាសម្ព័ន្ធទីផ្សារ Setup A+ Order Block និង FVG ព្រមទាំងចិត្តវិទ្យាជួញដូរ។ មេរៀនខ្លីៗ និង Quiz។ ជំពូកទី 1 ឥតគិតថ្លៃ។"),
        "profile":  ("AROM TRADE — ប្រវត្តិរូបរបស់ខ្ញុំ",
                     "គណនី AROM TRADE របស់អ្នក៖ ឈ្មោះ រូបថត ពាក្យសម្ងាត់ គម្រោង និងថ្ងៃផុតកំណត់ ប្រវត្តិទិញ Telegram និងការជូនដំណឹង។"),
    },
}

def url(path, lang):
    """Public address of a page in a language. English '/', Khmer '/km/'."""
    if lang == "en":
        return SITE + path
    return SITE + "/km" + (path if path != "/" else "/")

def alternates(path):
    return (f'<link rel="alternate" hreflang="en" href="{url(path, "en")}">\n'
            f'<link rel="alternate" hreflang="km" href="{url(path, "km")}">\n'
            f'<link rel="alternate" hreflang="x-default" href="{url(path, "en")}">\n')

def jsonld(obj):
    return '<script type="application/ld+json">' + json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "</script>\n"

ORG = {"@type": "Organization", "@id": SITE + "/#org", "name": "AROM TRADE", "url": SITE + "/",
       "logo": SITE + "/icons/icon-512.png", "email": "info@aromx.trade", "sameAs": ["https://t.me/aromxtrade", "https://t.me/aromxtradecommunity", "https://www.tiktok.com/@aromx.trade"],
       "contactPoint": [{"@type": "ContactPoint", "contactType": "customer support", "email": "info@aromx.trade", "url": "https://t.me/tentennnn0719", "availableLanguage": ["en", "km"]}],
       "description": "Trading journal, rule-based signals and USD news alerts for traders in Cambodia, in English and Khmer."}

def app_jsonld(name, lang):
    inlang = "km" if lang == "km" else "en"
    if name == "index":
        return jsonld({"@context": "https://schema.org", "@graph": [
            ORG,
            {"@type": "WebSite", "@id": SITE + "/#site", "name": "AROM TRADE", "url": SITE + "/", "inLanguage": ["en", "km"], "publisher": {"@id": SITE + "/#org"}},
        ]})
    if name == "pricing":
        def offer(n, price, d):
            return {"@type": "Offer", "name": n, "price": price, "priceCurrency": "USD", "description": d, "url": url("/pricing", lang)}
        return jsonld({"@context": "https://schema.org", "@type": "SoftwareApplication", "name": "AROM TRADE",
                       "applicationCategory": "FinanceApplication", "operatingSystem": "Web, iOS, Android (installable web app)",
                       "url": SITE + "/", "inLanguage": inlang, "publisher": {"@id": SITE + "/#org"},
                       "offers": [offer("Free", "0", "Trading journal and 1 AI signal a day."),
                                  offer("Premium", "2.50", "30 days. Chart uploads and market news analysis. No auto-renew."),
                                  offer("Elite", "14.99", "30 days. The full AI desk and signals. No auto-renew."),
                                  offer("Ultra", "49.99", "30 days. AROM Intelligence, an AI analyst. No auto-renew.")]})
    if name == "course":
        return jsonld({"@context": "https://schema.org", "@type": "Course", "name": "AROM Academy: trade gold with a plan",
                       "description": "Risk management, market structure, A+ setups, smart money concepts (order blocks, FVG) and trading psychology for gold traders. Short lessons with chapter quizzes, in English and Khmer.",
                       "url": url("/course", lang), "inLanguage": ["en", "km"], "provider": {"@id": SITE + "/#org"},
                       "offers": {"@type": "Offer", "category": "Paid", "price": "19.99", "priceCurrency": "USD"},
                       "hasCourseInstance": {"@type": "CourseInstance", "courseMode": "online", "courseWorkload": "PT95M"}})
    return ""

def set_heading(s, attr, tag):
    pat = re.compile(r'<(h1|h2)(\s[^>]*?' + re.escape(attr) + r'[^>]*)>(.*?)</\1>', re.S)
    m = list(pat.finditer(s))
    if len(m) != 1:
        sys.exit(f"heading {attr}: found {len(m)}")
    return pat.sub(lambda x: f"<{tag}{x.group(2)}>{x.group(3)}</{tag}>", s)

def sub1(pat, rep, s, what):
    s2, n = re.subn(pat, rep, s, count=1, flags=re.S)
    if n != 1:
        sys.exit("missing " + what)
    return s2

def head(s, name, path, lang):
    title, desc = META[lang][name]
    s = sub1(r'<html lang="[^"]*"', f'<html lang="{lang}"', s, "html lang")
    s = sub1(r"<title>.*?</title>", f"<title>{ESC(title)}</title>", s, "title")
    s = sub1(r'<meta name="description" content="[^"]*">', f'<meta name="description" content="{ESC(desc)}">', s, "description")
    s = sub1(r'<link rel="canonical" href="[^"]*">', f'<link rel="canonical" href="{url(path, lang)}">', s, "canonical")
    s = sub1(r'<meta property="og:url" content="[^"]*">', f'<meta property="og:url" content="{url(path, lang)}">', s, "og:url")
    s = sub1(r'<meta property="og:title" content="[^"]*">', f'<meta property="og:title" content="{ESC(title)}">', s, "og:title")
    s = sub1(r'<meta property="og:description" content="[^"]*">', f'<meta property="og:description" content="{ESC(desc)}">', s, "og:description")
    s = sub1(r'<meta name="twitter:title" content="[^"]*">', f'<meta name="twitter:title" content="{ESC(title)}">', s, "twitter:title")
    s = sub1(r'<meta name="twitter:description" content="[^"]*">', f'<meta name="twitter:description" content="{ESC(desc)}">', s, "twitter:description")
    block = ('<meta name="robots" content="noindex, nofollow">\n' if name in PRIVATE else "") + alternates(path) + f'<meta property="og:locale" content="{"km_KH" if lang == "km" else "en_US"}">\n' + app_jsonld(name, lang)
    s = sub1(r"<!--seo:head-->.*?<!--/seo:head-->", lambda m: "<!--seo:head-->\n" + block + "<!--/seo:head-->", s, "seo:head marker")
    return s

# ---------------------------------------------------------------- Khmer pre-render
def translations(src):
    js = "const s=require('fs').readFileSync(0,'utf8');const a=s.indexOf('const T = {');const b=s.indexOf('\\n};',a);" \
         "process.stdout.write(JSON.stringify(new Function('return '+s.slice(a+10,b+2))()));"
    return json.loads(subprocess.run(["node", "-e", js], input=src, capture_output=True, text=True, check=True).stdout)

KM_PATHS = ["/journey", "/news", "/refer", "/profile", "/course", "/replay", "/orderflow", "/analysis", "/pricing", "/about", "/methodology", "/track-record", "/risk"]

def markup_only(s, fn):
    """Apply fn to the HTML outside <script> and <style> blocks."""
    out, i = [], 0
    for m in re.finditer(r"<(script|style)\b[^>]*>.*?</\1>", s, re.S):
        out.append(fn(s[i:m.start()])); out.append(m.group(0)); i = m.end()
    out.append(fn(s[i:]))
    return "".join(out)

def khmerize(s, km):
    def text(m):
        k = m.group(3)
        return m.group(1) + (html.escape(km[k], quote=False) if k in km else m.group(4)) + m.group(5)
    def rich(m):
        k, inner = m.group(3), m.group(4)
        if k not in km or ("<" + m.group(2)) in inner:
            return m.group(0)
        return m.group(1) + km[k] + m.group(5)
    def attrs(m):
        tag = m.group(0)
        ph = re.search(r'data-i18n-ph="([^"]+)"', tag)
        if ph and ph.group(1) in km:
            tag = re.sub(r'placeholder="[^"]*"', 'placeholder="' + ESC(km[ph.group(1)]) + '"', tag)
        ti = re.search(r'data-i18n-title="([^"]+)"', tag)
        if ti and ti.group(1) in km:
            v = ESC(km[ti.group(1)])
            tag = re.sub(r'\stitle="[^"]*"', "", tag)
            tag = tag[:-1] + f' title="{v}">' if not tag.endswith("/>") else tag[:-2] + f' title="{v}"/>'
            if "data-i18n-aria" in tag:
                tag = re.sub(r'\saria-label="[^"]*"', "", tag)
                tag = tag[:-1] + f' aria-label="{v}">'
        return tag
    def links(part):
        part = re.sub(r'href="/"', 'href="/km/"', part)
        return re.sub(r'href="(' + "|".join(map(re.escape, KM_PATHS)) + r')([#?"])', r'href="/km\1\2', part)
    def fn(part):
        part = re.sub(r'(<(\w+)\b[^>]*\sdata-i18n="([^"]+)"[^>]*>)([^<]*)(</\2>)', text, part)
        part = re.sub(r'(<(\w+)\b[^>]*\sdata-i18n-html="([^"]+)"[^>]*>)(.*?)(</\2>)', rich, part, flags=re.S)
        part = re.sub(r"<\w+\b[^>]*data-i18n-(?:ph|title)=[^>]*>", attrs, part)
        part = re.sub(r'(<(h1|h2)\b[^>]*\sid="heroH1"[^>]*>)(.*?)(</\2>)', lambda m: m.group(1) + km.get("heroH1", m.group(3)) + m.group(4), part, flags=re.S)  # typed in by JS, no data-i18n
        return links(part)
    return markup_only(s, fn)

# ---------------------------------------------------------------- trust pages
SHELL_CSS = """
:root{--bg:#06080f;--card:#090d18;--line:#141d35;--text:#e9edf3;--muted:#8fa3b8;--lime:#2bf08a}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.65 Inter,"Kantumruy Pro",system-ui,-apple-system,Segoe UI,sans-serif}
html[lang="km"] body{font-family:"Kantumruy Pro",Inter,system-ui,sans-serif;line-height:1.8}
a{color:var(--lime)}
.top{position:sticky;top:0;z-index:5;background:rgba(6,8,15,.92);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
.top .in{max-width:880px;margin:0 auto;padding:12px 16px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:8px;color:var(--text);text-decoration:none;font-weight:800;letter-spacing:.5px}
.brand img{width:28px;height:28px;border-radius:7px}
.top nav{display:flex;gap:14px;flex-wrap:wrap;margin-left:auto;font-size:14px}
.top nav a{color:var(--muted);text-decoration:none}.top nav a:hover,.top nav a[aria-current]{color:var(--text)}
.top .lang{border:1px solid var(--line);border-radius:999px;padding:2px 10px;color:var(--text)!important}
main{max-width:880px;margin:0 auto;padding:36px 16px 56px}
h1{font-size:clamp(30px,5vw,46px);line-height:1.12;letter-spacing:-.02em;margin:0 0 14px}
html[lang="km"] h1{letter-spacing:0;line-height:1.4}
h2{font-size:21px;margin:34px 0 10px;line-height:1.3}
.lead{font-size:18px;color:#c9d1dc;margin:0 0 8px}
p,li{color:#d3dae2}ul{padding-left:20px}li{margin:6px 0}
.card{border:1px solid var(--line);border-radius:16px;background:linear-gradient(150deg,#0e1324,#090d18);padding:16px;margin:18px 0}
.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
.kpi{border:1px solid var(--line);border-radius:12px;background:#080b15;padding:10px 12px;min-width:0}
.kpi small{display:block;color:var(--muted);font-size:12px}.kpi b{font-size:20px;font-variant-numeric:tabular-nums}
table{width:100%;border-collapse:collapse;font-size:14px;margin-top:12px}
th,td{padding:8px 6px;border-bottom:1px solid var(--line);text-align:right;font-variant-numeric:tabular-nums}
th:first-child,td:first-child{text-align:left}th{color:var(--muted);font-size:12px;font-weight:700}
.pos{color:#2ee6a0}.neg{color:#ff5d73}.note{font-size:14px;color:var(--muted)}
.cta{display:inline-block;margin-top:8px;background:var(--lime);color:#000412;font-weight:800;text-decoration:none;border-radius:999px;padding:10px 18px}
footer{border-top:1px solid var(--line);color:var(--muted);font-size:13px}
footer .in{max-width:880px;margin:0 auto;padding:18px 16px;display:flex;gap:8px 18px;flex-wrap:wrap}
footer a{color:var(--muted);text-decoration:none}footer a:hover{color:var(--lime)}
@media(max-width:640px){.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.top nav{margin-left:0;width:100%}}
"""

UI = {
    "en": {"journal": "Journal", "desk": "AI Desk", "pricing": "Pricing", "other": "ខ្មែរ",
           "about": "About", "method": "How signals work", "track": "Track record", "risk": "Risk disclosure",
           "start": "Open AROM TRADE", "edu": "Education only, not financial advice."},
    "km": {"journal": "កំណត់ហេតុ", "desk": "AI Desk", "pricing": "តម្លៃ", "other": "EN",
           "about": "អំពីយើង", "method": "របៀបដែលសញ្ញាដំណើរការ", "track": "លទ្ធផលកន្លងមក", "risk": "ការបង្ហាញហានិភ័យ",
           "start": "បើក AROM TRADE", "edu": "សម្រាប់ការសិក្សាប៉ុណ្ណោះ មិនមែនជាដំបូន្មានហិរញ្ញវត្ថុ។"},
}

def L(path, lang):
    """Site-relative link for a page in a language."""
    return path if lang == "en" else ("/km/" if path == "/" else "/km" + path)

TRUST = {}   # name -> {path, en:{title,desc,body}, km:{...}}

TRUST["about"] = {"path": "/about", "type": "AboutPage",
"en": {"title": "About AROM TRADE · Trading journal and signals for Cambodia", "h1": "About AROM TRADE",
       "desc": "Who AROM TRADE is for, what it does and how it works: a trading journal, rule-based signals and USD news alerts for traders in Cambodia, in English and Khmer.",
       "body": """
<p class="lead">AROM TRADE is a trading journal and signal desk built for traders in Cambodia. It works in English and Khmer, shows every time in Cambodia time (UTC+7) and takes payment with KHQR.</p>
<h2>What we make</h2>
<ul>
<li><b>Trading journal</b>: log trades with screenshots and see your win rate, profit factor, R multiples, best sessions and equity curve. Free.</li>
<li><b>AI Desk</b>: rule-based setups for gold (XAUUSD), Bitcoin and other markets, each with an entry, a stop loss and targets, plus a buy or sell bias from USD news.</li>
<li><b>News and alerts</b>: high-impact US economic releases, with alerts in the app, on your phone and in Telegram.</li>
<li><b>Broker sync</b>: your MT5 or MT4 balance, open positions and closed trades copied into the journal, read-only.</li>
<li><b>AROM Intelligence</b>: market briefings and an AI analyst that explains verified market data (Ultra plan).</li>
</ul>
<h2>How we work</h2>
<ul>
<li>Signals come from fixed rules applied to real market candles, not from opinions. See <a href="{method}">how signals work</a>.</li>
<li>A new strategy runs in shadow mode first: its signals are recorded and scored but not published until about 30 of them show how it behaves.</li>
<li>Every published signal is counted in the public <a href="{track}">track record</a>, losses included.</li>
<li>Nothing on AROM TRADE is financial advice. Please read the <a href="{risk}">risk disclosure</a>.</li>
</ul>
<h2>Your data and your money</h2>
<ul>
<li>Your journal belongs to your account and is kept private in our cloud database.</li>
<li>Broker sync only reads your account. The AROM Sync EA cannot place, change or close a trade, and the phone option uses your read-only investor password, which we never store.</li>
<li>Plans are paid 30 days at a time with KHQR and never renew on their own.</li>
</ul>
<h2>Contact us</h2>
<ul>
<li>Email: <a href="mailto:info@aromx.trade">info@aromx.trade</a></li>
<li>Telegram: <a href="https://t.me/tentennnn0719" rel="noopener">@tentennnn0719</a></li>
<li>Telegram channel (news and updates): <a href="https://t.me/aromxtrade" rel="noopener">@aromxtrade</a></li>
</ul>
<p>We answer in English and Khmer.</p>
<p><a class="cta" href="{home}">{start}</a></p>
"""},
"km": {"title": "អំពី AROM TRADE · កំណត់ហេតុជួញដូរ និងសញ្ញាសម្រាប់កម្ពុជា", "h1": "អំពី AROM TRADE",
       "desc": "AROM TRADE សម្រាប់នរណា ធ្វើអ្វីខ្លះ និងដំណើរការយ៉ាងដូចម្តេច៖ កំណត់ហេតុជួញដូរ សញ្ញាផ្អែកលើច្បាប់ និងការជូនដំណឹងព័ត៌មាន USD សម្រាប់អ្នកជួញដូរនៅកម្ពុជា។",
       "body": """
<p class="lead">AROM TRADE គឺជាកំណត់ហេតុជួញដូរ និងតុសញ្ញាដែលបង្កើតឡើងសម្រាប់អ្នកជួញដូរនៅកម្ពុជា។ វាដំណើរការជាភាសាខ្មែរ និងអង់គ្លេស បង្ហាញម៉ោងទាំងអស់តាមម៉ោងកម្ពុជា (UTC+7) និងទទួលការបង់ប្រាក់តាម KHQR។</p>
<h2>អ្វីដែលយើងផ្តល់ជូន</h2>
<ul>
<li><b>កំណត់ហេតុជួញដូរ</b>៖ កត់ត្រាការជួញដូរជាមួយរូបភាព ហើយមើលអត្រាឈ្នះ កត្តាចំណេញ R វគ្គជួញដូរល្អបំផុត និងខ្សែកោងមូលធន។ ឥតគិតថ្លៃ។</li>
<li><b>AI Desk</b>៖ Setup ផ្អែកលើច្បាប់សម្រាប់មាស (XAUUSD) Bitcoin និងទីផ្សារផ្សេងទៀត ដែលនីមួយៗមាន Entry, Stop Loss និងគោលដៅ ព្រមទាំងទិសដៅទិញ ឬលក់ពីព័ត៌មាន USD។</li>
<li><b>ព័ត៌មាន និងការជូនដំណឹង</b>៖ ព័ត៌មានសេដ្ឋកិច្ចអាមេរិកដែលមានឥទ្ធិពលខ្ពស់ ជាមួយការជូនដំណឹងក្នុងកម្មវិធី លើទូរស័ព្ទ និងក្នុង Telegram។</li>
<li><b>ការភ្ជាប់ឈ្មួញកណ្តាល</b>៖ សមតុល្យ ការជួញដូរកំពុងបើក និងការជួញដូរបានបិទក្នុង MT5 ឬ MT4 ត្រូវបានចម្លងចូលកំណត់ហេតុ ដោយអានតែប៉ុណ្ណោះ។</li>
<li><b>AROM Intelligence</b>៖ សេចក្តីសង្ខេបទីផ្សារ និងអ្នកវិភាគ AI ដែលពន្យល់ទិន្នន័យទីផ្សារដែលបានផ្ទៀងផ្ទាត់ (គម្រោង Ultra)។</li>
</ul>
<h2>របៀបដែលយើងធ្វើការ</h2>
<ul>
<li>សញ្ញាមកពីច្បាប់ថេរដែលអនុវត្តលើទិន្នន័យទីផ្សារពិត មិនមែនមកពីមតិទេ។ សូមមើល <a href="{method}">របៀបដែលសញ្ញាដំណើរការ</a>។</li>
<li>យុទ្ធសាស្ត្រថ្មីដំណើរការក្នុងរបៀប Shadow ជាមុនសិន៖ សញ្ញារបស់វាត្រូវបានកត់ត្រា និងវាយតម្លៃ ប៉ុន្តែមិនត្រូវបានផ្សាយទេ រហូតដល់មានប្រហែល ៣០ សញ្ញាបង្ហាញពីលទ្ធផលរបស់វា។</li>
<li>សញ្ញានីមួយៗដែលបានផ្សាយ ត្រូវបានរាប់ក្នុង <a href="{track}">លទ្ធផលកន្លងមក</a> ជាសាធារណៈ រួមទាំងការខាតផងដែរ។</li>
<li>គ្មានអ្វីនៅលើ AROM TRADE ជាដំបូន្មានហិរញ្ញវត្ថុទេ។ សូមអាន <a href="{risk}">ការបង្ហាញហានិភ័យ</a>។</li>
</ul>
<h2>ទិន្នន័យ និងប្រាក់របស់អ្នក</h2>
<ul>
<li>កំណត់ហេតុរបស់អ្នកជាកម្មសិទ្ធិរបស់គណនីអ្នក ហើយត្រូវបានរក្សាទុកជាឯកជនក្នុងមូលដ្ឋានទិន្នន័យ cloud របស់យើង។</li>
<li>ការភ្ជាប់ឈ្មួញកណ្តាលគ្រាន់តែអានគណនីរបស់អ្នក។ AROM Sync EA មិនអាចបើក កែ ឬបិទការជួញដូរបានទេ ហើយជម្រើសសម្រាប់ទូរស័ព្ទប្រើពាក្យសម្ងាត់អ្នកវិនិយោគ (អានតែប៉ុណ្ណោះ) ដែលយើងមិនដែលរក្សាទុក។</li>
<li>គម្រោងត្រូវបង់ម្តង ៣០ ថ្ងៃតាម KHQR ហើយមិនបន្តដោយស្វ័យប្រវត្តិទេ។</li>
</ul>
<h2>ទាក់ទងយើង</h2>
<ul>
<li>អ៊ីមែល៖ <a href="mailto:info@aromx.trade">info@aromx.trade</a></li>
<li>Telegram៖ <a href="https://t.me/tentennnn0719" rel="noopener">@tentennnn0719</a></li>
<li>ឆានែល Telegram (ព័ត៌មាន និងបច្ចុប្បន្នភាព)៖ <a href="https://t.me/aromxtrade" rel="noopener">@aromxtrade</a></li>
</ul>
<p>យើងឆ្លើយតបជាភាសាខ្មែរ និងអង់គ្លេស។</p>
<p><a class="cta" href="{home}">{start}</a></p>
"""}}

TRUST["methodology"] = {"path": "/methodology", "type": "WebPage",
"en": {"title": "How AROM TRADE signals work · Rules, risk and results", "h1": "How AROM TRADE signals work",
       "desc": "The rules behind AROM TRADE signals: the checklist a setup must pass, the news lock, stops and targets, how wins and losses are counted, and shadow mode.",
       "body": """
<p class="lead">Every AROM TRADE signal comes from a fixed set of rules applied to real market candles. The engine either finds a setup that passes every rule, or it stays quiet.</p>
<h2>Three trading styles</h2>
<ul>
<li><b>Scalping</b> works on the 5-minute and 1-minute charts. Trades last minutes to a few hours.</li>
<li><b>Intraday</b> and <b>Swing</b> work on higher timeframes and hold trades longer, from hours to days.</li>
</ul>
<h2>The checklist</h2>
<p>A signal is graded A+ only when every rule in its checklist passes, and the AI Desk shows the checklist each signal passed. The scalping checklist, for example:</p>
<ul>
<li>5-minute trend: EMA 20 and EMA 50 agree, and the slope confirms it.</li>
<li>The 1-minute EMA 20 and EMA 50 agree with the 5-minute trend.</li>
<li>Price pulls back into a key level: a support or resistance zone, a trendline, or a breakout being retested.</li>
<li>A candle closes through the trigger at that level.</li>
<li>No high-impact USD news within 30 minutes.</li>
<li>The stop sits beyond the zone, between 0.3 and 1.5 times the 5-minute ATR.</li>
<li>There is at least 2R of room to the next zone.</li>
</ul>
<h2>News lock</h2>
<p>Signals pause 30 minutes before and 15 minutes after high-impact USD news, when prices can jump both ways.</p>
<h2>Stops and targets</h2>
<p>Each signal gives an entry, a stop loss and its targets. R is the distance from entry to stop, and the targets depend on the style. After TP1 the stop moves to the entry price.</p>
<table><thead><tr><th>Style</th><th>TP1</th><th>TP2</th></tr></thead><tbody>
<tr><td>Scalping</td><td>1R</td><td>2R</td></tr><tr><td>Intraday</td><td>1.5R</td><td>3R</td></tr><tr><td>Swing</td><td>2R</td><td>4R</td></tr></tbody></table>
<h2>How results are counted</h2>
<ul>
<li>Stop hit before TP1: <b>−1R</b>.</li>
<li>TP1 reached: half the position closes at TP1 and the stop moves to entry, so the trade scores at least half of TP1: <b>+0.5R</b> scalping, <b>+0.75R</b> intraday, <b>+1R</b> swing.</li>
<li>TP2 reached: the second half closes at TP2: <b>+1.5R</b> scalping, <b>+2.25R</b> intraday, <b>+3R</b> swing in total.</li>
</ul>
<p>Results are counted before spread and fees, and your broker's prices can differ slightly from ours. The live numbers are on the <a href="{track}">track record</a> page.</p>
<h2>Shadow mode</h2>
<p>A new strategy starts in shadow mode. Its signals are recorded and scored but not sent to members. It is published only after about 30 signals show that it holds up.</p>
<h2>What rules cannot do</h2>
<p>Rules remove guesswork; they do not remove risk. Signals lose often, and past results do not predict future ones. Please read the <a href="{risk}">risk disclosure</a>.</p>
"""},
"km": {"title": "របៀបដែលសញ្ញា AROM TRADE ដំណើរការ · ច្បាប់ ហានិភ័យ និងលទ្ធផល", "h1": "របៀបដែលសញ្ញា AROM TRADE ដំណើរការ",
       "desc": "ច្បាប់នៅពីក្រោយសញ្ញា AROM TRADE៖ បញ្ជីពិនិត្យដែល Setup ត្រូវឆ្លងកាត់ ការផ្អាកពេលព័ត៌មាន Stop និងគោលដៅ របៀបរាប់ឈ្នះ និងខាត និងរបៀប Shadow។",
       "body": """
<p class="lead">សញ្ញា AROM TRADE នីមួយៗមកពីច្បាប់ថេរដែលអនុវត្តលើទិន្នន័យទីផ្សារពិត។ ម៉ាស៊ីនរកឃើញ Setup ដែលឆ្លងកាត់ច្បាប់ទាំងអស់ ឬមិនផ្តល់សញ្ញាអ្វីទាំងអស់។</p>
<h2>រចនាប័ទ្មជួញដូរបី</h2>
<ul>
<li><b>Scalping</b> ធ្វើការលើក្រាហ្វ ៥ នាទី និង ១ នាទី។ ការជួញដូរមានរយៈពេលពីប៉ុន្មាននាទី ដល់ប៉ុន្មានម៉ោង។</li>
<li><b>Intraday</b> និង <b>Swing</b> ធ្វើការលើ Timeframe ធំជាង ហើយកាន់ការជួញដូរយូរជាង ពីប៉ុន្មានម៉ោង ដល់ប៉ុន្មានថ្ងៃ។</li>
</ul>
<h2>បញ្ជីពិនិត្យ</h2>
<p>សញ្ញាមួយទទួលបានចំណាត់ថ្នាក់ A+ លុះត្រាតែច្បាប់ទាំងអស់ក្នុងបញ្ជីពិនិត្យឆ្លងកាត់ ហើយ AI Desk បង្ហាញបញ្ជីពិនិត្យដែលសញ្ញានីមួយៗបានឆ្លងកាត់។ ឧទាហរណ៍ បញ្ជីពិនិត្យ Scalping៖</p>
<ul>
<li>និន្នាការ ៥ នាទី៖ EMA 20 និង EMA 50 ស្របគ្នា ហើយទំនោរបញ្ជាក់។</li>
<li>EMA 20 និង EMA 50 លើ ១ នាទី ស្របនឹងនិន្នាការ ៥ នាទី។</li>
<li>តម្លៃ Pullback ចូលកម្រិតសំខាន់៖ តំបន់ Support ឬ Resistance, Trendline ឬ Breakout ដែលកំពុងត្រូវបាន Retest។</li>
<li>ទៀនមួយបិទឆ្លងកាត់ចំណុចបង្កនៅកម្រិតនោះ។</li>
<li>គ្មានព័ត៌មាន USD ដែលមានឥទ្ធិពលខ្ពស់ក្នុងរយៈពេល ៣០ នាទី។</li>
<li>Stop នៅហួសតំបន់ ចន្លោះ 0.3 ដល់ 1.5 ដងនៃ ATR ៥ នាទី។</li>
<li>មានចន្លោះយ៉ាងហោចណាស់ 2R ទៅតំបន់បន្ទាប់។</li>
</ul>
<h2>ការផ្អាកពេលព័ត៌មាន</h2>
<p>សញ្ញាផ្អាក ៣០ នាទីមុន និង ១៥ នាទីក្រោយព័ត៌មាន USD ដែលមានឥទ្ធិពលខ្ពស់ ពេលតម្លៃអាចលោតទាំងសងខាង។</p>
<h2>Stop និងគោលដៅ</h2>
<p>សញ្ញានីមួយៗផ្តល់ Entry, Stop Loss និងគោលដៅ។ R គឺចម្ងាយពី Entry ទៅ Stop ហើយគោលដៅអាស្រ័យលើរចនាប័ទ្ម។ បន្ទាប់ពី TP1 Stop ត្រូវផ្លាស់មកតម្លៃ Entry។</p>
<table><thead><tr><th>រចនាប័ទ្ម</th><th>TP1</th><th>TP2</th></tr></thead><tbody>
<tr><td>Scalping</td><td>1R</td><td>2R</td></tr><tr><td>Intraday</td><td>1.5R</td><td>3R</td></tr><tr><td>Swing</td><td>2R</td><td>4R</td></tr></tbody></table>
<h2>របៀបរាប់លទ្ធផល</h2>
<ul>
<li>ប៉ះ Stop មុន TP1៖ <b>−1R</b>។</li>
<li>ដល់ TP1៖ ពាក់កណ្តាលនៃទំហំបិទនៅ TP1 ហើយ Stop ផ្លាស់មក Entry ដូច្នេះការជួញដូរទទួលបានយ៉ាងហោចណាស់ពាក់កណ្តាលនៃ TP1៖ <b>+0.5R</b> Scalping, <b>+0.75R</b> Intraday, <b>+1R</b> Swing។</li>
<li>ដល់ TP2៖ ពាក់កណ្តាលទីពីរបិទនៅ TP2៖ សរុប <b>+1.5R</b> Scalping, <b>+2.25R</b> Intraday, <b>+3R</b> Swing។</li>
</ul>
<p>លទ្ធផលត្រូវបានរាប់មុនគិត Spread និងថ្លៃសេវា ហើយតម្លៃរបស់ឈ្មួញកណ្តាលអ្នកអាចខុសពីរបស់យើងបន្តិច។ លេខផ្ទាល់មាននៅទំព័រ <a href="{track}">លទ្ធផលកន្លងមក</a>។</p>
<h2>របៀប Shadow</h2>
<p>យុទ្ធសាស្ត្រថ្មីចាប់ផ្តើមក្នុងរបៀប Shadow។ សញ្ញារបស់វាត្រូវបានកត់ត្រា និងវាយតម្លៃ ប៉ុន្តែមិនផ្ញើទៅសមាជិកទេ។ វាត្រូវបានផ្សាយតែបន្ទាប់ពីប្រហែល ៣០ សញ្ញាបង្ហាញថាវាដំណើរការល្អ។</p>
<h2>អ្វីដែលច្បាប់មិនអាចធ្វើបាន</h2>
<p>ច្បាប់កាត់បន្ថយការទាយ ប៉ុន្តែមិនលុបបំបាត់ហានិភ័យទេ។ សញ្ញាខាតជាញឹកញាប់ ហើយលទ្ធផលកន្លងមកមិនអាចទស្សន៍ទាយអនាគតបានទេ។ សូមអាន <a href="{risk}">ការបង្ហាញហានិភ័យ</a>។</p>
"""}}

TRACK_JS = r"""
<script>
(function(){
  var KM = document.documentElement.lang === 'km', box = document.getElementById('tr');
  var TX = KM ? {sig:'សញ្ញា', win:'អត្រាឈ្នះ', avg:'R ជាមធ្យម', tot:'R សរុប', mkt:'ទីផ្សារ · របៀប', n:'ចំនួន', since:'កត់ត្រាចាប់ពី {d} · ធ្វើបច្ចុប្បន្នភាព {u}។', small:'សញ្ញាតិចជាង ៣០ ក្នុងមួយទីផ្សារ មិនអាចប្រាប់អ្វីច្រើនបានទេ។', err:'មិនអាចផ្ទុកលទ្ធផលបានទេ។ សូមព្យាយាមម្តងទៀតពេលក្រោយ។', none:'មិនទាន់មានសញ្ញាបានបិទនៅឡើយ។', scalp:'Scalping', intraday:'Intraday', swing:'Swing', swing_brt:'Swing breakout retest (beta)'}
                : {sig:'Signals', win:'Win rate', avg:'Average R', tot:'Total R', mkt:'Market · style', n:'Signals', since:'Recorded since {d} · updated {u}.', small:'With fewer than 30 signals per market, a result says very little.', err:'The results could not load. Please try again later.', none:'No closed signals yet.', scalp:'Scalping', intraday:'Intraday', swing:'Swing', swing_brt:'Swing breakout retest (beta)'};
  var R = function(v){ v = +v || 0; return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(2) + 'R'; };
  var cls = function(v){ return +v > 0 ? 'pos' : +v < 0 ? 'neg' : ''; };
  var e = function(s){ return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); };
  var day = function(s){ try{ return new Intl.DateTimeFormat(KM ? 'km-KH' : 'en-GB', {day:'numeric', month:'short', year:'numeric', timeZone:'Asia/Phnom_Penh'}).format(new Date(s)); }catch(_){ return s; } };
  var kp = function(k, v, c){ return '<div class="kpi"><small>' + e(k) + '</small><b class="' + (c || '') + '">' + v + '</b></div>'; };
  fetch('https://sksvwikfyrdhgjngekqp.supabase.co/rest/v1/rpc/signal_track_record', {method:'POST', headers:{'apikey':'sb_publishable_9HxgkobAgQtKb2Jx8dkX-A_DxWy_m6e', 'Content-Type':'application/json'}, body:JSON.stringify({p_days:90})})
  .then(function(r){ if(!r.ok) throw 0; return r.json(); })
  .then(function(d){
    var t = d.total || {}, n = +t.n || 0;
    if(!n){ box.innerHTML = '<p class="note">' + e(TX.none) + '</p>'; return; }
    var rows = (d.rows || []).map(function(r){ return '<tr><td>' + e(r.symbol) + ' · ' + e(TX[r.mode] || r.mode) + '</td><td>' + (+r.n) + '</td><td>' + (r.n ? Math.round(100 * r.wins / r.n) + '%' : '—') + '</td><td class="' + cls(r.avg_r) + '">' + R(r.avg_r) + '</td><td class="' + cls(r.total_r) + '">' + R(r.total_r) + '</td></tr>'; }).join('');
    box.innerHTML = '<div class="kpis">' + kp(TX.sig, n) + kp(TX.win, Math.round(100 * (t.wins || 0) / n) + '%') + kp(TX.avg, R(t.avg_r), cls(t.avg_r)) + kp(TX.tot, R(t.total_r), cls(t.total_r)) + '</div>'
      + '<table><thead><tr><th>' + e(TX.mkt) + '</th><th>' + e(TX.n) + '</th><th>' + e(TX.win) + '</th><th>' + e(TX.avg) + '</th><th>' + e(TX.tot) + '</th></tr></thead><tbody>' + rows + '</tbody></table>'
      + '<p class="note">' + e(TX.since.replace('{d}', day(d.since)).replace('{u}', day(d.generated_at))) + ' ' + e(TX.small) + '</p>';
  })
  .catch(function(){ box.innerHTML = '<p class="note">' + e(TX.err) + '</p>'; });
})();
</script>
"""

TRUST["track-record"] = {"path": "/track-record", "type": "WebPage", "js": TRACK_JS,
"en": {"title": "AROM TRADE signal track record · Live results in R", "h1": "Signal track record",
       "desc": "Live results of every published AROM TRADE signal, by market and trading style: number of signals, win rate, average R and total R, losses included.",
       "body": """
<p class="lead">Every signal the engine publishes is counted here when it closes, wins and losses alike. The numbers load live from our database.</p>
<div class="card" id="tr" aria-live="polite"><p class="note">Loading results…</p></div>
<noscript><p class="note">Turn on JavaScript to load the live results.</p></noscript>
<h2>How to read it</h2>
<ul>
<li><b>R</b> is a multiple of the risk taken: −1R means the stop was hit, +1.5R means one and a half times the risk was won.</li>
<li>Half the position is closed at TP1 and the stop moves to entry, so a trade that reaches TP1 scores at least +0.5R (scalping) to +1R (swing). See <a href="{method}">how signals work</a>.</li>
<li>Results are before spread and fees. Signals still in shadow mode are not included.</li>
<li>Past results do not guarantee future results. Please read the <a href="{risk}">risk disclosure</a>.</li>
</ul>
"""},
"km": {"title": "លទ្ធផលសញ្ញា AROM TRADE · លទ្ធផលផ្ទាល់ជា R", "h1": "លទ្ធផលសញ្ញាកន្លងមក",
       "desc": "លទ្ធផលផ្ទាល់នៃសញ្ញា AROM TRADE ទាំងអស់ដែលបានផ្សាយ តាមទីផ្សារ និងរចនាប័ទ្ម៖ ចំនួនសញ្ញា អត្រាឈ្នះ R ជាមធ្យម និង R សរុប រួមទាំងការខាត។",
       "body": """
<p class="lead">សញ្ញានីមួយៗដែលម៉ាស៊ីនផ្សាយ ត្រូវបានរាប់នៅទីនេះនៅពេលវាបិទ ទាំងឈ្នះ និងខាត។ លេខទាំងនេះផ្ទុកផ្ទាល់ពីមូលដ្ឋានទិន្នន័យរបស់យើង។</p>
<div class="card" id="tr" aria-live="polite"><p class="note">កំពុងផ្ទុកលទ្ធផល…</p></div>
<noscript><p class="note">សូមបើក JavaScript ដើម្បីផ្ទុកលទ្ធផលផ្ទាល់។</p></noscript>
<h2>របៀបអាន</h2>
<ul>
<li><b>R</b> គឺជាចំនួនដងនៃហានិភ័យ៖ −1R មានន័យថាប៉ះ Stop, +1.5R មានន័យថាឈ្នះមួយដងកន្លះនៃហានិភ័យ។</li>
<li>ពាក់កណ្តាលនៃទំហំត្រូវបិទនៅ TP1 ហើយ Stop ផ្លាស់មក Entry ដូច្នេះការជួញដូរដែលដល់ TP1 ទទួលបានយ៉ាងហោចណាស់ +0.5R (Scalping) ដល់ +1R (Swing)។ សូមមើល <a href="{method}">របៀបដែលសញ្ញាដំណើរការ</a>។</li>
<li>លទ្ធផលមិនទាន់គិត Spread និងថ្លៃសេវា។ សញ្ញាដែលនៅក្នុងរបៀប Shadow មិនត្រូវបានរាប់បញ្ចូលទេ។</li>
<li>លទ្ធផលកន្លងមកមិនធានាលទ្ធផលអនាគតទេ។ សូមអាន <a href="{risk}">ការបង្ហាញហានិភ័យ</a>។</li>
</ul>
"""}}

TRUST["risk"] = {"path": "/risk", "type": "WebPage",
"en": {"title": "Risk disclosure · AROM TRADE", "h1": "Risk disclosure",
       "desc": "Trading forex, gold, crypto and indices carries a high risk of loss. AROM TRADE provides education and tools, not financial advice. Read before you trade.",
       "body": """
<p class="lead">Please read this before you act on anything you see on AROM TRADE.</p>
<h2>Trading is risky</h2>
<ul>
<li>Trading forex, gold, crypto, indices and commodities, especially with leverage, carries a high risk of losing money. You can lose all of the money in your trading account, and with some brokers more than that.</li>
<li>Prices can move very fast, gap over your stop or spike both ways around news, so a stop loss does not always close a trade at its price.</li>
<li>Only trade with money you can afford to lose.</li>
</ul>
<h2>What AROM TRADE is, and is not</h2>
<ul>
<li>AROM TRADE provides education and tools: a journal, rule-based signals, news analysis and AI explanations of market data.</li>
<li>Nothing on AROM TRADE is financial, investment or tax advice, or a recommendation to buy or sell anything.</li>
<li>AROM TRADE is not a broker. We do not hold your money and we do not place trades for you.</li>
</ul>
<h2>Signals and analysis can be wrong</h2>
<ul>
<li>Signals come from fixed rules and lose often. Past results, including our <a href="{track}">track record</a>, do not guarantee future results.</li>
<li>Market data can be delayed or differ from your broker's prices.</li>
<li>AI-written explanations can contain mistakes. Check them on your own chart.</li>
</ul>
<h2>Your decisions are yours</h2>
<p>You are responsible for every trade you take and the size of each position. Think about your own situation and, if you are unsure, ask an independent licensed adviser.</p>
"""},
"km": {"title": "ការបង្ហាញហានិភ័យ · AROM TRADE", "h1": "ការបង្ហាញហានិភ័យ",
       "desc": "ការជួញដូរ Forex មាស គ្រីបតូ និងសន្ទស្សន៍ មានហានិភ័យខ្ពស់នៃការខាតបង់។ AROM TRADE ផ្តល់ការសិក្សា និងឧបករណ៍ មិនមែនដំបូន្មានហិរញ្ញវត្ថុទេ។ សូមអានមុនជួញដូរ។",
       "body": """
<p class="lead">សូមអានខ្លឹមសារនេះ មុនពេលអ្នកធ្វើសកម្មភាពលើអ្វីដែលអ្នកឃើញនៅលើ AROM TRADE។</p>
<h2>ការជួញដូរមានហានិភ័យ</h2>
<ul>
<li>ការជួញដូរ Forex មាស គ្រីបតូ សន្ទស្សន៍ និងទំនិញ ជាពិសេសដោយប្រើ Leverage មានហានិភ័យខ្ពស់នៃការខាតប្រាក់។ អ្នកអាចខាតប្រាក់ទាំងអស់ក្នុងគណនីជួញដូររបស់អ្នក ហើយជាមួយឈ្មួញកណ្តាលខ្លះ អាចខាតច្រើនជាងនោះ។</li>
<li>តម្លៃអាចផ្លាស់ប្តូរយ៉ាងលឿន លោតរំលង Stop ឬលោតទាំងសងខាងនៅពេលព័ត៌មាន ដូច្នេះ Stop Loss មិនតែងតែបិទការជួញដូរត្រង់តម្លៃរបស់វាទេ។</li>
<li>សូមជួញដូរតែជាមួយប្រាក់ដែលអ្នកអាចខាតបានប៉ុណ្ណោះ។</li>
</ul>
<h2>AROM TRADE ជាអ្វី និងមិនមែនជាអ្វី</h2>
<ul>
<li>AROM TRADE ផ្តល់ការសិក្សា និងឧបករណ៍៖ កំណត់ហេតុ សញ្ញាផ្អែកលើច្បាប់ ការវិភាគព័ត៌មាន និងការពន្យល់ទិន្នន័យទីផ្សារដោយ AI។</li>
<li>គ្មានអ្វីនៅលើ AROM TRADE ជាដំបូន្មានហិរញ្ញវត្ថុ វិនិយោគ ឬពន្ធ ឬជាការណែនាំឱ្យទិញ ឬលក់អ្វីមួយទេ។</li>
<li>AROM TRADE មិនមែនជាឈ្មួញកណ្តាលទេ។ យើងមិនកាន់ប្រាក់របស់អ្នក ហើយមិនបើកការជួញដូរជំនួសអ្នកទេ។</li>
</ul>
<h2>សញ្ញា និងការវិភាគអាចខុស</h2>
<ul>
<li>សញ្ញាមកពីច្បាប់ថេរ ហើយខាតជាញឹកញាប់។ លទ្ធផលកន្លងមក រួមទាំង <a href="{track}">លទ្ធផលកន្លងមក</a> របស់យើង មិនធានាលទ្ធផលអនាគតទេ។</li>
<li>ទិន្នន័យទីផ្សារអាចយឺត ឬខុសពីតម្លៃរបស់ឈ្មួញកណ្តាលអ្នក។</li>
<li>ការពន្យល់ដែលសរសេរដោយ AI អាចមានកំហុស។ សូមពិនិត្យលើក្រាហ្វរបស់អ្នកផ្ទាល់។</li>
</ul>
<h2>ការសម្រេចចិត្តជារបស់អ្នក</h2>
<p>អ្នកទទួលខុសត្រូវចំពោះការជួញដូរនីមួយៗដែលអ្នកធ្វើ និងទំហំនៃការជួញដូរនីមួយៗ។ សូមគិតពីស្ថានភាពរបស់អ្នក ហើយប្រសិនបើមិនប្រាកដ សូមសួរទីប្រឹក្សាឯករាជ្យដែលមានអាជ្ញាប័ណ្ណ។</p>
"""}}

def trust_page(name, lang):
    T, ui, path = TRUST[name], UI[lang], TRUST[name]["path"]
    c = T[lang]
    links = {"home": L("/", lang), "method": L("/methodology", lang), "track": L("/track-record", lang), "risk": L("/risk", lang), "start": ui["start"]}
    body = c["body"]
    for k, v in links.items():
        body = body.replace("{" + k + "}", v)
    other = "km" if lang == "en" else "en"
    ld = {"@context": "https://schema.org", "@graph": [
        {**ORG},
        {"@type": T["type"], "@id": url(path, lang) + "#page", "url": url(path, lang), "name": c["h1"], "description": c["desc"],
         "inLanguage": lang, "isPartOf": {"@type": "WebSite", "@id": SITE + "/#site", "name": "AROM TRADE", "url": SITE + "/"},
         "publisher": {"@id": SITE + "/#org"}, "dateModified": TODAY},
        {"@type": "BreadcrumbList", "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "AROM TRADE", "item": url("/", lang)},
            {"@type": "ListItem", "position": 2, "name": c["h1"], "item": url(path, lang)}]},
    ]}
    nav_cur = lambda p: ' aria-current="page"' if p == path else ""
    return f"""<!DOCTYPE html>
<html lang="{lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{ESC(c["title"])}</title>
<meta name="description" content="{ESC(c["desc"])}">
<link rel="canonical" href="{url(path, lang)}">
{alternates(path)}<meta name="theme-color" content="#06080f">
<link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.png">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<meta property="og:type" content="website">
<meta property="og:site_name" content="AROM TRADE">
<meta property="og:locale" content="{"km_KH" if lang == "km" else "en_US"}">
<meta property="og:url" content="{url(path, lang)}">
<meta property="og:title" content="{ESC(c["title"])}">
<meta property="og:description" content="{ESC(c["desc"])}">
<meta property="og:image" content="{SITE}/icons/icon-512.png">
<meta name="twitter:card" content="summary">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&family=Kantumruy+Pro:wght@400;600;700&display=swap" rel="stylesheet">
{jsonld(ld)}<style>{SHELL_CSS}</style>
</head>
<body>
<header class="top"><div class="in">
<a class="brand" href="{L("/", lang)}"><img src="/icons/icon-192.png" alt="" width="28" height="28">AROM TRADE</a>
<nav aria-label="AROM TRADE"><a href="{L("/journey", lang)}">{ui["journal"]}</a><a href="{L("/analysis", lang)}">{ui["desk"]}</a><a href="{L("/pricing", lang)}">{ui["pricing"]}</a><a class="lang" href="{L(path, other)}" hreflang="{other}" lang="{other}">{ui["other"]}</a></nav>
</div></header>
<main>
<h1>{ESC(c["h1"])}</h1>
{body}
</main>
<footer><div class="in">
<span>AROM TRADE · {ESC(ui["edu"])}</span>
<a href="{L("/about", lang)}"{nav_cur("/about")}>{ui["about"]}</a><a href="{L("/methodology", lang)}"{nav_cur("/methodology")}>{ui["method"]}</a><a href="{L("/track-record", lang)}"{nav_cur("/track-record")}>{ui["track"]}</a><a href="{L("/risk", lang)}"{nav_cur("/risk")}>{ui["risk"]}</a><a href="mailto:info@aromx.trade">info@aromx.trade</a><a href="https://t.me/tentennnn0719" rel="noopener">Telegram</a><a href="https://t.me/aromxtrade" rel="noopener">@aromxtrade</a>
</div></footer>
{T.get("js", "")}</body>
</html>
"""

# ---------------------------------------------------------------- sitemap
def sitemap(paths):
    out = ['<?xml version="1.0" encoding="UTF-8"?>',
           '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">']
    for p in paths:
        for lang in ("en", "km"):
            out.append(f"  <url><loc>{url(p, lang)}</loc><lastmod>{TODAY}</lastmod>"
                       f'<xhtml:link rel="alternate" hreflang="en" href="{url(p, "en")}"/>'
                       f'<xhtml:link rel="alternate" hreflang="km" href="{url(p, "km")}"/>'
                       f'<xhtml:link rel="alternate" hreflang="x-default" href="{url(p, "en")}"/></url>')
    out.append("</urlset>\n")
    return "\n".join(out)

# ---------------------------------------------------------------- main
def write(rel, text):
    full = os.path.join(ROOT, rel)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w", encoding="utf8") as f:
        f.write(text)

def main():
    src = open(os.path.join(ROOT, "index.html"), encoding="utf8").read()
    if "<!--seo:head-->" not in src:
        sys.exit("index.html has no <!--seo:head--> marker")
    km = translations(src)["km"]
    for name, path, page, primary in APP:
        for lang in ("en", "km"):
            s = head(src, name, path, lang)
            s = sub1(r'<body data-page="[^"]*">', f'<body data-page="{page}">', s, "body data-page")
            for h in HEADINGS:
                s = set_heading(s, h, "h1" if h == primary else "h2")
            if lang == "km":
                s = khmerize(s, km)
            write(("km/" if lang == "km" else "") + name + ".html", s)
    for name in TRUST:
        for lang in ("en", "km"):
            write(("km/" if lang == "km" else "") + name + ".html", trust_page(name, lang))
    write("sitemap.xml", sitemap([p for n, p, _, _ in APP if n not in PRIVATE] + [TRUST[n]["path"] for n in TRUST]))
    print("built", len(APP) * 2, "app pages,", len(TRUST) * 2, "trust pages and sitemap.xml")

if __name__ == "__main__":
    main()
