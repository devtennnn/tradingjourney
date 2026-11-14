-- BTC shadow mode ("btcx"): logs signals to ai_signals (mode = 'btcx') but never posts to Telegram / push.
-- 1) Deploy the updated ai-telegram edge function FIRST (unknown modes are ignored, so this is safe in any order).
-- 2) Turn it on (idempotent). Needs BTCUSD in ai_bot_config 'symbols' as well:
insert into public.ai_bot_config (key, value) values ('modes', 'scalp,intraday,swing,btcx')
  on conflict (key) do update set value = case when public.ai_bot_config.value like '%btcx%' then public.ai_bot_config.value else public.ai_bot_config.value || ',btcx' end;
-- To stop: update public.ai_bot_config set value = replace(value, ',btcx', '') where key = 'modes';

-- 3) Scoreboard. Promotion rule (decide BEFORE looking): at least 100 closed trades AND avg_r - 1.28*se > 0 (90% confident it is above zero)
--    AND it also beats the live scalp mode over the same dates. Until then it stays shadow.
create or replace view public.ai_shadow_report as
select mode, count(*) as trades,
       round(avg((r_result > 0)::int)::numeric, 3) as win_rate,
       round(avg(r_result), 3) as avg_r,
       round(sum(r_result), 2) as total_r,
       round((avg(r_result) - 1.28 * coalesce(stddev_samp(r_result), 1) / sqrt(greatest(count(*), 1)))::numeric, 3) as avg_r_lower90,
       min(to_timestamp(t)) as first_signal, max(to_timestamp(t)) as last_signal
from public.ai_signals
where status = 'closed' and r_result is not null and symbol = 'BTCUSD' and mode in ('btcx', 'scalp')
group by mode;
revoke all on public.ai_shadow_report from anon, authenticated;
-- Note: r_result excludes spread. Subtract about (spread / risk) per trade when judging, e.g. $5 spread on a $65 stop = 0.08R.
