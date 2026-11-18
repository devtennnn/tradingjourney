-- Broker sync (Ultra), applied to the project as migration broker_sync.
-- MT5 / MT4 accounts push balance, open positions and closed trades through the read-only AROM Sync EA (downloads/AROM_Sync.mq5 / .mq4).
-- Tables are locked (RLS on, no policies, no grants): only the broker-sync edge function (service role) reads and writes them,
-- after checking the member's JWT (site) or the account's sync code hash (EA). The plain sync code is never stored.
create table if not exists public.broker_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  label text not null default 'MT5',
  platform text not null default 'mt5' check (platform in ('mt5', 'mt4')),
  token_hash text not null unique,
  token_hint text not null,
  login text, server text, company text, currency text, leverage int,
  balance numeric, equity numeric, margin numeric, free_margin numeric, floating numeric,
  auto_import boolean not null default true,
  ea_version text,
  last_sync_at timestamptz,
  last_deal_at bigint,
  created_at timestamptz not null default now()
);
create index if not exists broker_accounts_user on public.broker_accounts(user_id);
create table if not exists public.broker_positions (
  account_id uuid not null references public.broker_accounts(id) on delete cascade,
  ticket bigint not null, symbol text not null, side text not null check (side in ('BUY', 'SELL')),
  volume numeric, open_price numeric, open_time bigint, sl numeric, tp numeric, price numeric, profit numeric, swap numeric,
  primary key (account_id, ticket)
);
create table if not exists public.broker_deals (
  account_id uuid not null references public.broker_accounts(id) on delete cascade,
  position_id bigint not null, symbol text not null, side text not null check (side in ('BUY', 'SELL')),
  volume numeric, open_time bigint, close_time bigint not null, open_price numeric, close_price numeric, sl numeric, tp numeric,
  profit numeric, commission numeric, swap numeric, net numeric, comment text,
  trade_id uuid,
  created_at timestamptz not null default now(),
  primary key (account_id, position_id)
);
create index if not exists broker_deals_close on public.broker_deals(account_id, close_time desc);
create table if not exists public.broker_snapshots (
  account_id uuid not null references public.broker_accounts(id) on delete cascade,
  at timestamptz not null default now(), balance numeric, equity numeric,
  primary key (account_id, at)
);
alter table public.broker_accounts enable row level security;
alter table public.broker_positions enable row level security;
alter table public.broker_deals enable row level security;
alter table public.broker_snapshots enable row level security;
revoke all on public.broker_accounts, public.broker_positions, public.broker_deals, public.broker_snapshots from anon, authenticated;
