-- AROM TRADE · AI Telegram bot
-- Run in Supabase → SQL Editor. Step 1 creates the signal log; step 2 schedules the scan every 5 minutes.

-- ===== 1) Signal log (one row per A+ signal; the unique key stops double posting) =====
create table if not exists public.ai_signals (
  id            bigserial primary key,
  symbol        text        not null,
  t             bigint      not null,              -- signal candle close time (unix seconds, UTC)
  side          text        not null check (side in ('BUY','SELL')),
  entry         numeric     not null,
  sl            numeric     not null,
  tp1           numeric     not null,
  tp2           numeric     not null,
  tp3           numeric     not null,
  risk          numeric,
  trigger       text,
  source        text,
  status        text        not null default 'open' check (status in ('open','closed')),
  hits          int         not null default 0,    -- highest TP reached so far
  result        text,                              -- sl | tp1 | tp2 | tp3 | expired | unknown
  tg_message_id bigint,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (symbol, t)
);
create index if not exists ai_signals_open_idx on public.ai_signals (symbol, status);

-- Only the server (service_role key in Vercel) touches this table. No public access.
alter table public.ai_signals enable row level security;
revoke all on public.ai_signals from anon, authenticated;

-- ===== 2) Run the scan every 5 minutes, 1 minute after each M5 candle closes =====
-- Database → Extensions: enable "pg_cron" and "pg_net" first (or run the two lines below).
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Replace YOUR_CRON_SECRET with the same text you put in Vercel as CRON_SECRET.
select cron.unschedule('arom-ai-scan') where exists (select 1 from cron.job where jobname = 'arom-ai-scan');
select cron.schedule(
  'arom-ai-scan',
  '1-59/5 * * * *',
  $$ select net.http_get(
       url := 'https://truetradejourney.vercel.app/api/ai-scan?key=YOUR_CRON_SECRET',
       timeout_milliseconds := 20000
     ); $$
);

-- Check it is running (after ~10 minutes):
--   select * from cron.job_run_details order by start_time desc limit 5;
--   select id, status_code, left(content::text, 300) from net._http_response order by id desc limit 5;
-- Signals posted so far:
--   select symbol, side, entry, sl, tp1, status, result, created_at from public.ai_signals order by id desc;
-- Stop the bot:
--   select cron.unschedule('arom-ai-scan');
