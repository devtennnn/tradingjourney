# AROM Intelligence (/intelligence)

One page, eight modules, one transparent score. **Ultra plan only ($50.99 / 30 days).**
Files: `intelligence.html` (page), `supabase/functions/intelligence/` (`index.ts` = the gate + data loading, `engine.js` = the analysis engine, plain JS that also runs in Node for tests),
`api/candles.js` (also returns volume `v`), `api/market-news.js` (economic calendar).

## The gate is server-side
The engine is NOT shipped to the browser. The page calls the edge function `intelligence` (JWT required). The function checks `profiles.is_admin` or `profiles.ultra_until > now()`
and answers `403 ultra_required` for everyone else (no analysis in the response, no upstream calls made); signed out = 401; more than 40 requests a minute per user = 429.
Candles/calendar are fetched by the function from the site's own `/api/candles` and `/api/market-news` (secret `SITE_URL` overrides the default https://aromx.trade).
Admins count as Ultra.

## Ultra plan
`supabase/sql/ultra-plan.sql` (run once): `profiles.ultra_until`, `is_ultra()`, Ultra counts as Elite and Premium everywhere (`is_elite`, `is_premium`, `user_tier`, notification audiences),
Ultra allowed in activation keys / promo codes / payments, `redeem_key`, `admin_create_keys`, `admin_set_plan`, `admin_approve_payment`, admin overview and user list.
The payment function takes `PLAN_PRICE_ULTRA` (default 50.99). Upgrade link from the locked page: `/pricing?plan=ultra`.

| # | Module | Weight | Data | Notes |
|---|--------|-------:|------|-------|
| 01 | Market structure (BOS, CHoCH, MSS, HH/HL/LH/LL, internal vs external) | 20 | candles | external pivots k=5, internal k=2; a CLOSE beyond the last swing is a break |
| 02 | Liquidity (BSL/SSL, equal highs/lows, sweeps, stop hunts) | 15 | candles | a sweep = wick through a known swing level and a close back inside |
| 03 | ICT / SMC (order blocks, FVG, inversion FVG, premium/discount, displacement, dealing range) | 20 | candles | premium/discount only inside the dealing range |
| 04a | EMA 20/50/200, RSI 14, ATR regime | 10 | candles | RSI beyond 75/25 is damped (stretched) |
| 04b | Fibonacci retracement of the latest swing leg | 5 | candles | 0.5-0.79 = OTE zone |
| 05 | Order flow (VWAP, volume profile, estimated delta, absorption, exhaustion) | 10 | candles + REAL volume | unavailable for spot FX / metals (no volume). Bid/ask imbalance needs a level-2 feed: not available |
| 06 | Fundamental (economic calendar) | 10 | Forex Factory feed | **risk gate, not a direction**: the feed has no actual-vs-forecast, no headline sentiment |
| 07 | Multi-timeframe (4 rungs: macro, structure, setup, entry) | 10 | M1 M5 M15 H1 (+H4, D1 built from H1) | scalp = H1/M15/M5/M1, intraday = H4/H1/M15/M5, swing = D1/H4/H1/M15 |
| 08 | AI reasoning (rule based) | - | the outputs above | explains, finds conflicts, recommends WAIT |

Score = Σ weight × module score / Σ weight, over modules that are available AND directional (unavailable modules and the news risk gate are left out
and the rest are re-weighted). Coverage = share of the 100 weight points that had real data. It recommends WAIT when: coverage < 60%, |score| < 25,
strong modules conflict (opposing share > 30%), high-impact news within 30 minutes, the signal opposes the higher-timeframe bias, volatility is
extreme with only a moderate edge, or there is no valid plan (stop too wide, no liquidity target, reward:risk < 1.5).

Not proven: the weights and thresholds (`CFG`, `WEIGHTS` in the engine) are an engineering hypothesis. There is no backtest yet. Next steps worth doing:
forward-test log (store each decision and its outcome), then tune. It is analysis for education, not financial advice.

Tests (kept outside the repo during development): unit tests build candles by hand (BOS/CHoCH, FVG, IFVG, order block, sweeps, equal highs, Fibonacci, VWAP, news gate, decision rules) and run the
engine on the real BTC M1 history in `data/`.

## Upload a chart (Ultra)

AROM Intelligence → **Upload a chart**: a member uploads a screenshot plus details (market, timeframe, their idea, optional entry/SL/TP). The edge function `intelligence-chart` sends it to Claude (vision) and returns a structured reading: structure, liquidity, ICT/SMC, indicators, key levels, multi-timeframe (if visible), a review of the member's idea, a trade plan and what a picture cannot tell. Optionally it cross-checks with the live engine.

One-time setup:
1. Run `supabase/sql/intelligence-chart.sql` in the Supabase SQL Editor (usage table for the daily cap).
2. Supabase → Edge Functions → Secrets: add `ANTHROPIC_API_KEY` (from console.anthropic.com). Never share it in chat or commit it.
3. Optional secrets: `INTEL_CHART_DAILY` (analyses per member per 24 h, default 20), `INTEL_CHART_MODEL` (default `claude-opus-5-5`; a cheaper model such as `claude-sonnet-5-5` also works), `INTEL_CHART_EFFORT` (`low`|`medium`|`high`, default `medium`).

Privacy: the image is resized in the browser, sent to Anthropic for that one request and not stored. Only (user, time) is kept for the cap. Each analysis costs API credits, so keep the daily cap sensible.
