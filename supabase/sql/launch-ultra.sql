-- Launch gift: 3 days of Ultra for members who join the Telegram channel AND community. Run once in the Supabase SQL Editor. Safe to run again.
--   launch_promo  : one settings row (window, days, cap, the two Telegram chats). Edit it with SQL, e.g.
--                     update public.launch_promo set closes_at = '2026-11-30 12:00+00', max_claims = 500, enabled = true;
--   launch_claims : one row per member who claimed; tg_user_id is UNIQUE, so one Telegram account can claim only once (fake accounts cannot reuse it).
--   launch_grant / launch_revoke : the only way plans are changed by this promo (service role only, called by the edge function launch-claim).
-- Times are stored in UTC. 12:00 UTC = 19:00 (7:00 PM) Cambodia time.
create table if not exists public.launch_promo (
  id          int primary key default 1 check (id = 1),
  enabled     boolean not null default true,
  opens_at    timestamptz not null default '2026-11-17 12:00:00+00',   -- 7:00 PM Cambodia time, 17 Nov 2026
  closes_at   timestamptz not null default '2026-11-24 12:00:00+00',   -- one week later (change it with SQL)
  days        int not null default 3 check (days between 1 and 30),
  max_claims  int,                                                      -- null = no cap
  channel     text not null default '@aromxtrade',
  community   text not null default '@aromxtradecommunity',
  channel_url text not null default 'https://t.me/aromxtrade',
  community_url text not null default 'https://t.me/aromxtradecommunity'
);
insert into public.launch_promo (id) values (1) on conflict (id) do nothing;

create table if not exists public.launch_claims (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  tg_user_id     bigint not null unique,
  claimed_at     timestamptz not null default now(),
  days           int not null,
  prev_until     timestamptz,                  -- ultra_until before the gift (restored if the gift is revoked)
  granted_until  timestamptz not null,
  status         text not null default 'active' check (status in ('active','revoked','ended')),
  revoked_at     timestamptz,
  revoke_reason  text,
  last_check_at  timestamptz,
  check_note     text
);
create index if not exists launch_claims_status_idx on public.launch_claims (status, granted_until);

alter table public.launch_promo enable row level security;
alter table public.launch_claims enable row level security;
revoke all on public.launch_promo, public.launch_claims from anon, authenticated;     -- no policies: only the edge function (service role) reads or writes

create or replace function public.launch_grant(p_user uuid, p_tg bigint)
returns json language plpgsql security definer set search_path to 'public' as $f$
declare pr public.launch_promo; cur timestamptz; nxt timestamptz; n int;
begin
  select * into pr from public.launch_promo where id = 1 for update;
  if not found or not pr.enabled then raise exception 'disabled'; end if;
  if now() < pr.opens_at then raise exception 'not_open'; end if;
  if now() > pr.closes_at then raise exception 'closed'; end if;
  if pr.max_claims is not null then select count(*) into n from public.launch_claims; if n >= pr.max_claims then raise exception 'sold_out'; end if; end if;
  if exists (select 1 from public.launch_claims where user_id = p_user) then raise exception 'already_claimed'; end if;
  if exists (select 1 from public.launch_claims where tg_user_id = p_tg) then raise exception 'telegram_used'; end if;
  select ultra_until into cur from public.profiles where id = p_user for update;
  if not found then raise exception 'no_profile'; end if;
  nxt := greatest(coalesce(cur, now()), now()) + make_interval(days => pr.days);
  insert into public.launch_claims (user_id, tg_user_id, days, prev_until, granted_until) values (p_user, p_tg, pr.days, cur, nxt);
  update public.profiles set ultra_until = nxt where id = p_user;
  return json_build_object('until', nxt, 'days', pr.days);
end $f$;

-- Undo the gift (the member left the channel or community). Only touches the plan if it still holds the gifted date, so a purchase made meanwhile is never taken away.
create or replace function public.launch_revoke(p_user uuid, p_reason text)
returns json language plpgsql security definer set search_path to 'public' as $f$
declare c public.launch_claims; cur timestamptz; restore timestamptz; changed boolean := false;
begin
  select * into c from public.launch_claims where user_id = p_user and status = 'active' for update;
  if not found then return json_build_object('revoked', false); end if;
  select ultra_until into cur from public.profiles where id = p_user for update;
  if cur is not distinct from c.granted_until then
    restore := case when c.prev_until is not null and c.prev_until > now() then c.prev_until else null end;
    update public.profiles set ultra_until = restore where id = p_user; changed := true;
  end if;
  update public.launch_claims set status = 'revoked', revoked_at = now(), revoke_reason = left(coalesce(p_reason, ''), 200) where user_id = p_user;
  return json_build_object('revoked', true, 'plan_changed', changed);
end $f$;

revoke all on function public.launch_grant(uuid, bigint) from public, anon, authenticated;
revoke all on function public.launch_revoke(uuid, text) from public, anon, authenticated;
grant execute on function public.launch_grant(uuid, bigint) to service_role;
grant execute on function public.launch_revoke(uuid, text) to service_role;

-- re-check members every 10 minutes (needs pg_cron + pg_net, already used by the signal bot)
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') and exists (select 1 from pg_extension where extname = 'pg_net') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'arom-launch-watch';
    perform cron.schedule('arom-launch-watch', '*/10 * * * *', $c$ select net.http_get(url := 'https://sksvwikfyrdhgjngekqp.supabase.co/functions/v1/launch-claim?run=watch&key=' || (select value from public.ai_bot_config where key = 'cron_secret')) $c$);
  end if;
end $$;
