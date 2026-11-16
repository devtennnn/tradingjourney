-- AROM Intelligence · chart upload: usage log for the daily cap (run once in Supabase SQL Editor)
-- One row per analysis. Used only to count "uses in the last 24 hours" per member. The picture itself is never stored.
create table if not exists public.intelligence_chart_uses (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now()
);
create index if not exists intelligence_chart_uses_user_time on public.intelligence_chart_uses (user_id, created_at desc);

-- only the edge function (service role) reads or writes it: RLS on, no policies
alter table public.intelligence_chart_uses enable row level security;
revoke all on public.intelligence_chart_uses from anon, authenticated;

-- housekeeping: forget rows older than 7 days (runs every night at 03:10 UTC when pg_cron is enabled)
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'intelligence_chart_uses_cleanup';
    perform cron.schedule('intelligence_chart_uses_cleanup', '10 3 * * *', $c$ delete from public.intelligence_chart_uses where created_at < now() - interval '7 days' $c$);
  end if;
end $$;
