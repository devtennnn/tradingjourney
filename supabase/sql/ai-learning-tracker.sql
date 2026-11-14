-- AROM AI · learning tracker. Run once in Supabase → SQL Editor.
-- Stores WHY each signal fired (feat) and how it ended in R, so tools/backtest.js and the stats view can learn from real results.
alter table public.ai_signals add column if not exists feat jsonb;          -- feature snapshot at signal time (level type, trend strength, hour, risk/ATR ...)
alter table public.ai_signals add column if not exists r_result numeric;    -- realized R: sl = -1, tp1 then BE = +0.5, tp2 = +1.5, expired = 0 (spread not included)

create or replace view public.ai_signal_stats as
select symbol, mode,
       feat->>'lvl' as level, trigger,
       case when (feat->>'hr')::int < 7 then 'asia' when (feat->>'hr')::int < 13 then 'london'
            when (feat->>'hr')::int < 17 then 'ny-overlap' when (feat->>'hr')::int < 21 then 'ny-late' else 'rollover' end as session,
       count(*)                                         as trades,
       round(avg((r_result > 0)::int)::numeric, 3)      as win_rate,
       round(avg(r_result), 3)                          as avg_r,
       round(sum(r_result), 2)                          as total_r
from public.ai_signals
where status = 'closed' and r_result is not null
group by 1, 2, 3, 4, 5;
revoke all on public.ai_signal_stats from anon, authenticated;
