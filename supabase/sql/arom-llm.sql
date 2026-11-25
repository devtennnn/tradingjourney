-- AROM LLM (AI Desk tab): per-user daily quota and a log of every answer. Only the arom-llm edge function (service role) touches these.
create table if not exists public.llm_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day     date not null,
  n       int  not null default 0,
  primary key (user_id, day)
);
alter table public.llm_usage enable row level security;
revoke all on public.llm_usage from anon, authenticated;

create table if not exists public.llm_log (
  id          bigserial primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  kind        text not null check (kind in ('scan', 'chat')),
  sym         text, tf int, model text,
  result      jsonb,
  tokens_in   int, tokens_out int,
  created_at  timestamptz not null default now()
);
create index if not exists llm_log_user on public.llm_log (user_id, created_at desc);
alter table public.llm_log enable row level security;
revoke all on public.llm_log from anon, authenticated;

-- Take one use of today's quota (UTC day). Returns the uses left after this one, or -1 when the quota is spent.
create or replace function public.llm_take(p_user uuid, p_limit int)
returns int language plpgsql security definer set search_path = public as $$
declare v int;
begin
  insert into llm_usage (user_id, day, n) values (p_user, current_date, 1)
  on conflict (user_id, day) do update set n = llm_usage.n + 1 where llm_usage.n < p_limit
  returning n into v;
  if v is null then return -1; end if;
  return p_limit - v;
end $$;
-- Give one use back when the model failed, so a failure does not cost the member a scan.
create or replace function public.llm_refund(p_user uuid)
returns void language sql security definer set search_path = public as $$
  update llm_usage set n = greatest(0, n - 1) where user_id = p_user and day = current_date;
$$;
create or replace function public.llm_left(p_user uuid, p_limit int)
returns int language sql stable security definer set search_path = public as $$
  select greatest(0, p_limit - coalesce((select n from llm_usage where user_id = p_user and day = current_date), 0));
$$;
revoke all on function public.llm_take(uuid, int), public.llm_refund(uuid), public.llm_left(uuid, int) from public, anon, authenticated;
