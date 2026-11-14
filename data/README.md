# Backtest data (M1 candles: unix_seconds,open,high,low,close, UTC)

Downloaded from Twelve Data on 2026-11-14 (free plan), ~11 to 20 days each.

| File | Span | Notes |
|---|---|---|
| BTCUSD.csv | 2026-10-25 → 11-14 | Continuous candles (open = previous close). Clean. |
| xauusd_m1.csv | 2026-11-03 → 11-14 | **Questionable.** 58% of candles open exactly at their high/low and the open does not match the previous close; wick-based rules are unreliable on it. |
| EURUSD.csv | 2026-11-07 → 11-14 | Same open-placement issue as gold, milder. |

Replace gold/EURUSD with the candles your live bot trades on: `node tools/site-to-csv.js XAUUSD > data/xau_site.csv`.
Run: `node tools/backtest.js --csv data/BTCUSD.csv --symbol BTCUSD` · `node tools/explore.js data/BTCUSD.csv 5 BTCUSD` · `node tools/sweep.js data/BTCUSD.csv 5`
