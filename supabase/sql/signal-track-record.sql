-- AI Desk "Live track record" (applied to the project as migration signal_track_record).
-- Public, read-only aggregates of the signals members actually received (scalp / intraday / swing only; shadow research modes excluded).
-- ai_signals itself stays locked (RLS on, no policies): this function returns no message ids, no user data, only results.
-- R is computed from the targets hit and each mode's plan (half off at TP1, stop to entry, rest at TP2), before spread and fees:
--   SL -1 · TP1 only rr1/2 · TP2+ (rr1+rr2)/2 · expired / unknown 0.   scalp 1R/2R · intraday 1.5R/3R · swing 2R/4R.
create or replace function public.signal_track_record(p_days int default 30)
returns json
language sql
stable
security definer
set search_path = public
as $$
  with base as (
    select symbol, mode, side, t, result, coalesce(hits, 0) as hits,
      case mode when 'intraday' then 1.5 when 'swing' then 2 else 1 end as rr1,
      case mode when 'intraday' then 3   when 'swing' then 4 else 2 end as rr2
    from ai_signals
    where mode in ('scalp', 'intraday', 'swing') and status = 'closed'
      and to_timestamp(t) >= now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 365))
  ), r as (
    select *, case when result = 'sl' then -1.0
                   when result in ('expired', 'unknown') or result is null then 0.0
                   when hits >= 2 then (rr1 + rr2) / 2.0
                   when hits = 1 then rr1 / 2.0 else 0.0 end as rv
    from base
  ), g as (
    select symbol, mode, count(*) as n, count(*) filter (where rv > 0) as wins, count(*) filter (where rv < 0) as losses,
      round(avg(rv)::numeric, 2) as avg_r, round(sum(rv)::numeric, 1) as total_r
    from r group by symbol, mode
  )
  select json_build_object(
    'days', least(greatest(coalesce(p_days, 30), 1), 365),
    'since', (select min(to_timestamp(t)) from r),
    'generated_at', now(),
    'total', (select json_build_object('n', count(*), 'wins', count(*) filter (where rv > 0), 'losses', count(*) filter (where rv < 0),
                                        'avg_r', round(avg(rv)::numeric, 2), 'total_r', round(sum(rv)::numeric, 1)) from r),
    'rows', coalesce((select json_agg(g order by g.mode, g.symbol) from g), '[]'::json),
    'recent', coalesce((select json_agg(x) from (select symbol, mode, side, t, result, round(rv::numeric, 2) as r from r order by t desc limit 12) x), '[]'::json),
    'open', (select count(*) from ai_signals where mode in ('scalp', 'intraday', 'swing') and status = 'open')
  );
$$;
revoke all on function public.signal_track_record(int) from public;
grant execute on function public.signal_track_record(int) to anon, authenticated;
