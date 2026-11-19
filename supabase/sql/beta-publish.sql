-- BETA publish of a shadow research mode for one symbol (ai-telegram v36+).
-- ai_bot_config.publish_pairs = "SYMBOL:mode,..." -> that shadow mode posts to the channel for that symbol, tagged feat.beta = true.
-- Auto-pause (in the bot): when the posted, closed results of the pair reach -8R in total, or after 30 closed signals with a negative
-- average, new signals are only logged (feat.beta_paused = true) and never posted. Remove the pair from publish_pairs to stop it by hand.
-- Members are told: BETA strategy, risk 0.5% per trade. Not financial advice.
--
-- Evidence for XAUUSD swing_brt (H4+D1 trend -> H1 breakout + retest), 2 years of H1 gold after spread:
--   n=281, +0.34R average (95% 0.14 to 0.54), positive in 4 of 5 half-years, BUY +0.35R / SELL +0.32R, max drawdown 22R.
--
-- signal_track_record and admin_ai_report count feat.beta rows as posted (migration beta_publish_pairs).
insert into public.ai_bot_config(key, value) values ('publish_pairs', 'XAUUSD:swing_brt')
on conflict (key) do update set value = excluded.value;
-- Stop the beta:   update public.ai_bot_config set value = '' where key = 'publish_pairs';

-- shadow_pairs = "SYMBOL:mode,..." -> a public mode keeps running for that symbol but only logs (feat.shadow = true), never posts.
-- 19 Nov 2026: gold scalping moved to shadow. Backtest on Twelve Data gold M1 with closed-market candles removed, 20 days, $0.40 spread:
--   n=106, -0.28R per trade (95% -0.49 to -0.08), both halves negative; live posted results 23 signals, -2R. Gold intraday has been shadow since 16 Nov.
update public.ai_bot_config set value = 'XAUUSD:intraday,XAUUSD:scalp' where key = 'shadow_pairs';
