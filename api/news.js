// Vercel Serverless Function: GET /api/news?week=this|next
// Fetches the Forex Factory weekly calendar on the server (no browser CORS limits),
// keeps USD events only, and lets Vercel's CDN cache it for 30 minutes so the feed is hit rarely.
module.exports = async (req, res) => {
  const week = req.query && req.query.week === 'next' ? 'nextweek' : 'thisweek';
  try {
    const r = await fetch(`https://nfs.faireconomy.media/ff_calendar_${week}.json`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (DEVTEN Trading Journal)', Accept: 'application/json' },
    });
    if (!r.ok) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(502).json({ error: 'calendar feed returned ' + r.status });
    }
    const data = await r.json();
    const usd = Array.isArray(data) ? data.filter(e => e && String(e.country).toUpperCase() === 'USD') : [];
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json(usd);
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(500).json({ error: String(e && e.message || e) });
  }
};
