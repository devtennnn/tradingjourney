-- AI signal report for the Admin dashboard (Admin -> AI report). Admin only. v2 NOT YET APPLIED (waiting for approval): apply as migration admin_ai_report_v2.
-- Reads public.ai_signals between two instants and returns totals, by pair, by strategy, per day (ICT) and the signal list (max 500).
-- Research (shadow) signals = shadow research modes (anything other than scalp / intraday / swing) and public modes logged in shadow for one
-- symbol (feat.shadow = true, e.g. gold intraday while paused). They are left out unless p_research is true; each row and strategy says if it is shadow.
-- p_symbol (optional) limits the report to one market, e.g. 'XAUUSD'.
-- Realized R uses the stored r_result; older rows without it are derived from the result: SL -1, TP1 +0.5, TP2/TP3 +1.5, expired 0.
drop function if exists public.admin_ai_report(timestamptz, timestamptz, boolean);
create or replace function public.admin_ai_report(p_from timestamptz, p_to timestamptz, p_research boolean default false, p_symbol text default null)
returns json language plpgsql stable security definer set search_path to 'public' as $f$
declare out json;
begin
  perform public.admin_guard();
  with s0 as (
    select a.symbol, coalesce(a.mode, 'scalp') as mode, a.side, a.t, a.entry, a.sl, a.tp1, a.tp2, a.tp3, a.status, a.result, coalesce(a.hits, 0) as hits,
           to_timestamp(a.t) as ts, a.feat,
           (coalesce(a.mode, 'scalp') not in ('scalp', 'intraday', 'swing') or coalesce((a.feat->>'shadow')::boolean, false)) as shadow,
           case when a.status = 'closed' then coalesce(a.r_result, case a.result when 'sl' then -1 when 'tp1' then 0.5 when 'tp2' then 1.5 when 'tp3' then 1.5 else 0 end) end as r
    from public.ai_signals a
    where to_timestamp(a.t) >= p_from and to_timestamp(a.t) < p_to and (p_symbol is null or p_symbol = '' or a.symbol = upper(p_symbol))
  ),
  s as (select * from s0 where p_research or not shadow),
  tot as (
    select count(*)::int signals, (count(*) filter (where status = 'closed'))::int closed, (count(*) filter (where status <> 'closed'))::int open,
           (count(*) filter (where status = 'closed' and result in ('tp1','tp2','tp3')))::int wins, (count(*) filter (where status = 'closed' and result = 'sl'))::int losses,
           (count(*) filter (where hits >= 1))::int tp1, (count(*) filter (where hits >= 2))::int tp2, (count(*) filter (where hits >= 3))::int tp3,
           coalesce(sum(r), 0)::float net_r, (count(*) filter (where shadow))::int shadow from s),
  pr as (
    select symbol, count(*)::int signals, (count(*) filter (where status = 'closed'))::int closed, (count(*) filter (where status <> 'closed'))::int open,
           (count(*) filter (where status = 'closed' and result in ('tp1','tp2','tp3')))::int wins, (count(*) filter (where status = 'closed' and result = 'sl'))::int losses,
           (count(*) filter (where hits >= 1))::int tp1, (count(*) filter (where hits >= 2))::int tp2, (count(*) filter (where hits >= 3))::int tp3,
           coalesce(sum(r), 0)::float net_r from s group by symbol),
  md as (
    select mode, shadow, count(*)::int signals, (count(*) filter (where status = 'closed'))::int closed,
           (count(*) filter (where status = 'closed' and result in ('tp1','tp2','tp3')))::int wins,
           (count(*) filter (where status = 'closed' and result = 'sl'))::int losses, coalesce(sum(r), 0)::float net_r,
           round((avg(r) filter (where status = 'closed'))::numeric, 2)::float avg_r from s group by mode, shadow),
  dy as (
    select (ts at time zone 'Asia/Phnom_Penh')::date as day, count(*)::int signals, coalesce(sum(r), 0)::float net_r from s group by 1)
  select json_build_object(
    'from', p_from, 'to', p_to, 'research', p_research, 'symbol', nullif(upper(coalesce(p_symbol, '')), ''),
    'hidden_shadow', (select count(*) from s0 where shadow and not p_research),
    'total', (select row_to_json(tot) from tot),
    'pairs', (select coalesce(json_agg(row_to_json(pr) order by pr.signals desc, pr.symbol), '[]'::json) from pr),
    'modes', (select coalesce(json_agg(row_to_json(md) order by md.shadow, md.mode), '[]'::json) from md),
    'daily', (select coalesce(json_agg(row_to_json(dy) order by dy.day), '[]'::json) from dy),
    'signals', (select coalesce(json_agg(x order by x.t desc), '[]'::json) from (select symbol, mode, shadow, side, t, entry, sl, tp1, tp2, tp3, status, result, hits, r::float as r,
                  feat->>'pat' as pat from s order by t desc limit 500) x)
  ) into out;
  return out;
end $f$;

revoke all on function public.admin_ai_report(timestamptz, timestamptz, boolean, text) from public, anon;
grant execute on function public.admin_ai_report(timestamptz, timestamptz, boolean, text) to authenticated;
