-- Connect Telegram: lets a user link their own Telegram chat to their account, so the bot can message them privately (e.g. "payment successful").
-- Run once in Supabase -> SQL Editor. Safe to re-run. Only the edge functions tg-link / tg-webhook / pay-notify (service role) touch these tables.
create table if not exists public.telegram_links (
  user_id uuid primary key references auth.users(id) on delete cascade,
  chat_id bigint not null unique,            -- one Telegram chat belongs to one account
  tg_username text,
  linked_at timestamptz not null default now()
);
create table if not exists public.telegram_link_codes (
  code text primary key,                     -- one-time code carried by the t.me/<bot>?start=<code> link
  user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null
);
create index if not exists telegram_link_codes_user_idx on public.telegram_link_codes (user_id);
alter table public.telegram_links enable row level security;        -- no policies: not readable from the browser
alter table public.telegram_link_codes enable row level security;
revoke all on public.telegram_links from anon, authenticated;
revoke all on public.telegram_link_codes from anon, authenticated;
