// Vercel Serverless Function: GET /api/market-news?week=this|next
// Market News Alerts feed: the Forex Factory weekly calendar (all countries) filtered down to the events
// that move GOLD, the US DOLLAR and OIL, plus BIG global events (major central banks, CPI, GDP, jobs).
// Each event gets tags and a plain "how it usually moves the market" guide. No actual results are invented:
// the feed only has forecast and previous values. Cached 15 minutes on Vercel's CDN.
const MAJORS = ['EUR', 'GBP', 'JPY', 'CNY', 'CAD', 'AUD', 'CHF', 'NZD'];
const BIG_RX = /(rate|interest|monetary policy|policy statement|press conference|cpi|inflation|gdp|employment change|non-farm|unemployment rate)/i;
const FED_RX = /(fomc|fed chair|powell|federal funds|fed )/i;
const OIL_RX = /(crude oil|opec|oil inventor|wti|brent|api weekly)/i;
const USD_MED_RX = /(claims|retail sales|ism|pmi|jolts|adp non-farm|consumer sentiment|pce|consumer confidence|durable goods)/i;
const INVERSE_RX = /(unemployment|jobless|claims)/i;     // higher than forecast = weaker economy

function classify(e) {
  const title = String(e.title || ''), cur = String(e.country || '').toUpperCase(), imp = String(e.impact || '');
  if (imp === 'Holiday') return null;
  const tags = new Set();
  let guide = '';
  if (OIL_RX.test(title)) {
    tags.add('OIL');
    guide = /opec/i.test(title)
      ? 'Output cut → Oil ↑ · Output increase → Oil ↓'
      : 'Bigger draw than forecast → Oil ↑ · Build → Oil ↓';
  }
  if (cur === 'USD' && (imp === 'High' || (imp === 'Medium' && (FED_RX.test(title) || USD_MED_RX.test(title))))) {
    tags.add('USD'); tags.add('GOLD');
    if (!guide) guide = FED_RX.test(title)
      ? 'Hawkish → USD ↑ Gold ↓ · Dovish → USD ↓ Gold ↑'
      : INVERSE_RX.test(title)
        ? 'Higher than forecast → USD ↓ Gold ↑ · Lower → USD ↑ Gold ↓'
        : 'Above forecast → USD ↑ Gold ↓ · Below forecast → USD ↓ Gold ↑';
  }
  if (cur !== 'USD' && MAJORS.includes(cur) && imp === 'High' && BIG_RX.test(title)) {
    tags.add('BIG');
    if (!guide) guide = `Strong / hawkish → ${cur} ↑ USD ↓ · Weak / dovish → ${cur} ↓ USD ↑ · expect volatility in gold`;
  }
  if (cur === 'USD' && imp === 'High' && BIG_RX.test(title)) tags.add('BIG');
  if (!tags.size) return null;
  const ms = Date.parse(e.date);
  if (!isFinite(ms)) return null;
  return {title, country: cur, impact: imp, ms, date: e.date, forecast: e.forecast || '', previous: e.previous || '',
    tags: [...tags], guide, key: cur + '|' + title + '|' + ms};
}

module.exports = async (req, res) => {
  const week = req.query && req.query.week === 'next' ? 'nextweek' : 'thisweek';
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const r = await fetch(`https://nfs.faireconomy.media/ff_calendar_${week}.json`, {
      headers: {'User-Agent': 'Mozilla/5.0 (AROM TRADE market alerts)', Accept: 'application/json'},
    });
    if (!r.ok) { res.setHeader('Cache-Control', 'no-store'); return res.status(502).json({error: 'calendar feed returned ' + r.status}); }
    const data = await r.json();
    const events = (Array.isArray(data) ? data : []).map(classify).filter(Boolean).sort((a, b) => a.ms - b.ms);
    res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=1800');
    return res.status(200).json({week, source: 'Forex Factory', events});
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(500).json({error: String(e && e.message || e)});
  }
};
module.exports.classify = classify;
