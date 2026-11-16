-- Bakong token store (one row). Lets every function instance share one renewed token, so Bakong's ~100 renew_token calls/day are never wasted.
-- Run once in Supabase -> SQL Editor. Safe to re-run. Only the khqr function (service role) can touch it.
create table if not exists public.bakong_token (
  id int primary key default 1 check (id = 1),
  token text,
  exp timestamptz,
  renewed_at timestamptz,
  day date,
  renews_today int not null default 0,
  last_attempt timestamptz,
  last_error text
);
alter table public.bakong_token enable row level security;   -- no policies: not readable from the browser
revoke all on public.bakong_token from anon, authenticated;
