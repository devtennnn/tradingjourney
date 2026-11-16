-- Market-data adapter (AROM Intelligence integration, phase 2). Run once in the Supabase SQL Editor. Safe to run again.
-- market_cache       : shared cache of provider answers (quotes, candles) so many members cost one provider call
-- integration_health : per provider: last success / error, calls today, quota left (SiftingIO free key = 10,000 calls a month)
-- Both tables are written and read only by edge functions (service role). Members cannot read them; admins read health through the function.
create table if not exists public.market_cache (
  key         text primary key,
  payload     jsonb not null,
  fetched_at  timestamptz not null default now()
);
create index if not exists market_cache_fetched on public.market_cache (fetched_at);

create table if not exists public.integration_health (
  provider         text primary key,
  status           text,
  quota_limit      integer,
  quota_remaining  integer,
  rate_limit       integer,
  calls_day        date,
  calls_today      integer not null default 0,
  errors_today     integer not null default 0,
  calls_total      bigint  not null default 0,
  errors_total     bigint  not null default 0,
  last_success_at  timestamptz,
  last_error       text,
  last_error_at    timestamptz,
  updated_at       timestamptz not null default now()
);

alter table public.market_cache enable row level security;
alter table public.integration_health enable row level security;
revoke all on public.market_cache, public.integration_health from anon, authenticated;

-- housekeeping: drop cached rows older than 3 days (nightly 03:20 UTC, only if pg_cron is enabled)
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'market_cache_cleanup';
    perform cron.schedule('market_cache_cleanup', '20 3 * * *', $c$ delete from public.market_cache where fetched_at < now() - interval '3 days' $c$);
  end if;
end $$;
