-- IB & Community Partner program ($19.99 / 30 days).
-- Paying for plan 'ib' gives: 30 days of IB status (ib_until), 30 days of Elite, three 5 % promo codes owned by the partner
-- (valid while the IB status lasts), a listing in the IB directory after an admin approves the profile, and the right to ask the admin
-- for one 10 % or 15 % code. Everything below runs in the database so every payment path (KHQRPay webhook, admin approval) behaves the same.

alter table public.profiles add column if not exists ib_until timestamptz;
alter table public.promo_codes add column if not exists owner_id uuid references auth.users(id) on delete set null;
create index if not exists promo_codes_owner on public.promo_codes (owner_id) where owner_id is not null;

alter table public.payments drop constraint if exists payments_plan_check;
alter table public.payments add constraint payments_plan_check check (plan = any (array['premium','elite','ultra','course','ib']));

create or replace function public.plan_col(p text) returns text language sql immutable as $$
  select case p when 'ultra' then 'ultra_until' when 'elite' then 'elite_until' when 'course' then 'course_until' when 'ib' then 'ib_until' else 'premium_until' end;
$$;

-- partner profile shown in the directory once approved
create table if not exists public.ib_profiles (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  ib_name      text not null check (char_length(ib_name) between 2 and 60),
  ib_photo     text check (ib_photo is null or (char_length(ib_photo) <= 140000 and (ib_photo ~ '^https://[^\s"<>]+$' or ib_photo ~ '^data:image/(png|webp|jpeg);base64,[A-Za-z0-9+/=]+$'))),
  broker_name  text not null check (char_length(broker_name) between 2 and 60),
  broker_logo  text check (broker_logo is null or (char_length(broker_logo) <= 140000 and (broker_logo ~ '^https://[^\s"<>]+$' or broker_logo ~ '^data:image/(png|webp|jpeg|svg\+xml);base64,[A-Za-z0-9+/=]+$'))),
  ref_link     text not null check (ref_link ~ '^https://[^\s"<>]+$' and char_length(ref_link) <= 400),
  rebate       numeric check (rebate is null or (rebate >= 0 and rebate <= 1000)),
  rebate_note  text check (char_length(rebate_note) <= 60),
  description  text not null check (char_length(description) between 80 and 1200),
  contact      text check (char_length(contact) <= 80),
  status       text not null default 'pending' check (status in ('pending','approved','hidden','rejected')),
  admin_note   text check (char_length(admin_note) <= 300),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
alter table public.ib_profiles enable row level security;
drop policy if exists ib_own_read on public.ib_profiles;
create policy ib_own_read on public.ib_profiles for select to authenticated using (user_id = auth.uid() or public.is_admin(auth.uid()));
drop policy if exists ib_admin_write on public.ib_profiles;
create policy ib_admin_write on public.ib_profiles for all to authenticated using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));
revoke all on public.ib_profiles from anon;
grant select on public.ib_profiles to authenticated;
grant insert, update, delete on public.ib_profiles to authenticated;

-- requests for a 10 % or 15 % code
create table if not exists public.ib_requests (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  percent     int not null check (percent in (10, 15)),
  message     text check (char_length(message) <= 500),
  status      text not null default 'open' check (status in ('open','granted','declined')),
  code        text,
  created_at  timestamptz not null default now(),
  decided_at  timestamptz
);
alter table public.ib_requests enable row level security;
drop policy if exists ibr_read on public.ib_requests;
create policy ibr_read on public.ib_requests for select to authenticated using (user_id = auth.uid() or public.is_admin(auth.uid()));
revoke all on public.ib_requests from anon;
grant select on public.ib_requests to authenticated;

create or replace function public.ib_code_new() returns text language plpgsql volatile set search_path = public, extensions as $$
declare c text;
begin
  loop
    c := 'IB' || upper(substr(translate(encode(extensions.gen_random_bytes(8), 'base64'), '+/=0O1IL', ''), 1, 6));
    exit when char_length(c) = 8 and not exists (select 1 from promo_codes where code = c);
  end loop;
  return c;
end $$;

-- grant the 30 days, Elite and the three 5 % codes; extend the codes the partner already owns
create or replace function public.ib_activate(p_user uuid, p_days int default 30) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare nxt timestamptz; have int;
begin
  update profiles set ib_until = greatest(coalesce(ib_until, now()), now()) + make_interval(days => p_days),
                      elite_until = greatest(coalesce(elite_until, now()), now()) + make_interval(days => p_days)
    where id = p_user returning ib_until into nxt;
  update promo_codes set valid_until = nxt, active = true where owner_id = p_user and (campaign like 'IB %' or campaign = 'IB');
  select count(*) into have from promo_codes where owner_id = p_user and kind = 'percent' and value = 5;
  while have < 3 loop
    insert into promo_codes (code, kind, value, plan, max_uses, per_user, valid_until, active, campaign, note, owner_id)
      values (ib_code_new(), 'percent', 5, 'any', null, 1, nxt, true, 'IB', 'IB partner 5 % code', p_user);
    have := have + 1;
  end loop;
  return nxt;
end $$;
revoke all on function public.ib_activate(uuid, int) from public, anon, authenticated;

create or replace function public.payments_ib_paid() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.plan = 'ib' and new.status = 'paid' and coalesce(old.status, '') <> 'paid' then perform ib_activate(new.user_id, 30); end if;
  return new;
end $$;
drop trigger if exists payments_ib_paid on public.payments;
create trigger payments_ib_paid after update of status on public.payments for each row execute function public.payments_ib_paid();

-- admin approval: the trigger above does the IB part, so the generic column update is skipped for plan 'ib'
create or replace function public.admin_approve_payment(p_id uuid) returns json language plpgsql security definer set search_path to 'public' as $function$
declare r public.payments; col text; cur timestamptz; nxt timestamptz;
begin
  perform public.admin_guard();
  select * into r from public.payments where id = p_id for update;
  if r.id is null then raise exception 'not_found'; end if;
  if r.status = 'paid' then return json_build_object('ok', true, 'already', true); end if;
  if coalesce(r.plan, 'premium') <> 'ib' then
    col := public.plan_col(coalesce(r.plan, 'premium'));
    execute format('select %I from public.profiles where id = $1', col) into cur using r.user_id;
    nxt := greatest(coalesce(cur, now()), now()) + interval '30 days';
    execute format('update public.profiles set %I = $1 where id = $2', col) using nxt, r.user_id;
  end if;
  update public.payments set status = 'paid', paid_at = now(), approved_by = auth.uid() where id = r.id;
  if r.plan = 'ib' then select ib_until into nxt from public.profiles where id = r.user_id; end if;
  perform public.audit_write(r.user_id, 'plan_upgrade', jsonb_build_object('plan', coalesce(r.plan,'premium'), 'days', 30, 'until', nxt, 'amount', r.amount, 'bill', r.bill_number, 'via', 'admin approval', 'promo', r.promo_code));
  return json_build_object('ok', true, 'until', nxt);
end $function$;

-- promo codes owned by a partner cannot discount the IB plan itself or be used by their owner
create or replace function public.promo_quote_internal(p_user uuid, p_code text, p_plan text, p_price numeric) returns json language plpgsql security definer set search_path to 'public' as $function$
declare c public.promo_codes; used int; mine int; disc numeric; fin numeric;
begin
  select * into c from public.promo_codes where code = upper(trim(coalesce(p_code, '')));
  if c.id is null then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if not c.active then return json_build_object('ok', false, 'error', 'inactive'); end if;
  if c.valid_from > now() then return json_build_object('ok', false, 'error', 'not_started'); end if;
  if c.valid_until is not null and c.valid_until < now() then return json_build_object('ok', false, 'error', 'expired'); end if;
  if c.owner_id is not null and (p_plan = 'ib' or p_plan = 'course') then return json_build_object('ok', false, 'error', 'plan_mismatch', 'plan', 'any'); end if;
  if c.owner_id is not null and c.owner_id = p_user then return json_build_object('ok', false, 'error', 'already_used'); end if;
  if c.plan <> 'any' and c.plan <> p_plan then return json_build_object('ok', false, 'error', 'plan_mismatch', 'plan', c.plan); end if;
  select count(*) into used from public.payments y where y.promo_code = c.code
    and (y.status in ('paid','claimed') or (y.status = 'pending' and y.expires_at > now()));
  if c.max_uses is not null and used >= c.max_uses then return json_build_object('ok', false, 'error', 'limit_reached'); end if;
  select count(*) into mine from public.payments y where y.promo_code = c.code and y.user_id = p_user
    and (y.status in ('paid','claimed') or (y.status = 'pending' and y.expires_at > now()));
  if mine >= c.per_user then return json_build_object('ok', false, 'error', 'already_used'); end if;
  if c.kind = 'percent' then disc := round(p_price * c.value / 100, 2); else disc := least(c.value, p_price - 0.01); end if;
  disc := greatest(disc, 0); fin := round(p_price - disc, 2);
  if fin < 0.01 then fin := 0.01; disc := round(p_price - fin, 2); end if;
  return json_build_object('ok', true, 'code', c.code, 'kind', c.kind, 'value', c.value, 'plan', c.plan, 'list_price', p_price, 'discount', disc, 'final', fin);
end $function$;

-- ---------- member side ----------
-- save the own profile (needs an active IB status); every change goes back to "pending" until an admin approves it again
create or replace function public.ib_save_profile(p jsonb) returns json language plpgsql security definer set search_path = public as $$
declare u uuid := auth.uid(); ok boolean;
begin
  if u is null then raise exception 'not_signed_in'; end if;
  select coalesce(ib_until > now(), false) or coalesce(is_admin, false) into ok from profiles where id = u;
  if not coalesce(ok, false) then raise exception 'ib_inactive'; end if;
  insert into ib_profiles (user_id, ib_name, ib_photo, broker_name, broker_logo, ref_link, rebate, rebate_note, description, contact, status, updated_at)
  values (u, trim(p->>'ib_name'), nullif(p->>'ib_photo', ''), trim(p->>'broker_name'), nullif(p->>'broker_logo', ''), trim(p->>'ref_link'),
          nullif(p->>'rebate', '')::numeric, nullif(trim(p->>'rebate_note'), ''), trim(p->>'description'), nullif(trim(p->>'contact'), ''), 'pending', now())
  on conflict (user_id) do update set ib_name = excluded.ib_name, ib_photo = excluded.ib_photo, broker_name = excluded.broker_name, broker_logo = excluded.broker_logo,
    ref_link = excluded.ref_link, rebate = excluded.rebate, rebate_note = excluded.rebate_note, description = excluded.description, contact = excluded.contact,
    status = 'pending', updated_at = now();
  return json_build_object('ok', true, 'status', 'pending');
end $$;
revoke all on function public.ib_save_profile(jsonb) from public, anon;
grant execute on function public.ib_save_profile(jsonb) to authenticated;

-- the partner's own codes with how many paid orders used each
create or replace function public.ib_my_codes() returns table (code text, value numeric, valid_until timestamptz, active boolean, paid_uses bigint)
language sql stable security definer set search_path = public as $$
  select c.code, c.value, c.valid_until, c.active, (select count(*) from payments y where y.promo_code = c.code and y.status = 'paid')
  from promo_codes c where c.owner_id = auth.uid() order by c.value, c.created_at;
$$;
revoke all on function public.ib_my_codes() from public, anon;
grant execute on function public.ib_my_codes() to authenticated;

-- ask the admin for one 10 % or 15 % code (one open request at a time)
create or replace function public.ib_request_code(p_percent int, p_message text) returns json language plpgsql security definer set search_path = public as $$
declare u uuid := auth.uid();
begin
  if u is null then raise exception 'not_signed_in'; end if;
  if p_percent not in (10, 15) then raise exception 'bad_request'; end if;
  if not exists (select 1 from profiles where id = u and ib_until > now()) then raise exception 'ib_inactive'; end if;
  if exists (select 1 from ib_requests where user_id = u and status = 'open') then raise exception 'already_open'; end if;
  insert into ib_requests (user_id, percent, message) values (u, p_percent, left(coalesce(p_message, ''), 500));
  return json_build_object('ok', true);
end $$;
revoke all on function public.ib_request_code(int, text) from public, anon;
grant execute on function public.ib_request_code(int, text) to authenticated;

-- public directory: approved profiles of partners whose IB status is active
create or replace function public.ib_directory() returns table (ib_name text, ib_photo text, broker_name text, broker_logo text, ref_link text, rebate numeric, rebate_note text, description text, contact text)
language sql stable security definer set search_path = public as $$
  select p.ib_name, p.ib_photo, p.broker_name, p.broker_logo, p.ref_link, p.rebate, p.rebate_note, p.description, p.contact
  from ib_profiles p join profiles f on f.id = p.user_id
  where p.status = 'approved' and f.ib_until > now() order by p.updated_at desc;
$$;
grant execute on function public.ib_directory() to anon, authenticated;

-- ---------- admin side ----------
create or replace function public.admin_ib_list() returns json language plpgsql security definer set search_path = public as $$
begin
  perform admin_guard();
  return json_build_object(
    'profiles', coalesce((select json_agg(x order by x.updated_at desc) from (select p.*, f.username, f.ib_until from ib_profiles p left join profiles f on f.id = p.user_id) x), '[]'),
    'requests', coalesce((select json_agg(x order by x.created_at desc) from (select r.*, f.username, p.ib_name from ib_requests r left join profiles f on f.id = r.user_id left join ib_profiles p on p.user_id = r.user_id) x), '[]'),
    'members',  coalesce((select json_agg(x) from (select id, username, ib_until from profiles where ib_until is not null order by ib_until desc) x), '[]'));
end $$;
create or replace function public.admin_ib_set_status(p_user uuid, p_status text, p_note text) returns json language plpgsql security definer set search_path = public as $$
begin
  perform admin_guard();
  if p_status not in ('pending','approved','hidden','rejected') then raise exception 'bad_request'; end if;
  update ib_profiles set status = p_status, admin_note = left(nullif(p_note, ''), 300), updated_at = now() where user_id = p_user;
  return json_build_object('ok', found);
end $$;
-- grant: create the requested code (owned by the partner, valid while the IB status lasts) and close the request
create or replace function public.admin_ib_decide(p_id uuid, p_grant boolean) returns json language plpgsql security definer set search_path = public as $$
declare r ib_requests; c text; until_ts timestamptz;
begin
  perform admin_guard();
  select * into r from ib_requests where id = p_id for update;
  if r.id is null or r.status <> 'open' then raise exception 'not_open'; end if;
  if p_grant then
    select ib_until into until_ts from profiles where id = r.user_id;
    c := ib_code_new();
    insert into promo_codes (code, kind, value, plan, max_uses, per_user, valid_until, active, campaign, note, owner_id, created_by)
      values (c, 'percent', r.percent, 'any', null, 1, until_ts, true, 'IB', 'IB partner ' || r.percent || ' % code (request)', r.user_id, auth.uid());
    update ib_requests set status = 'granted', code = c, decided_at = now() where id = r.id;
  else
    update ib_requests set status = 'declined', decided_at = now() where id = r.id;
  end if;
  return json_build_object('ok', true, 'code', c);
end $$;
revoke all on function public.admin_ib_list(), public.admin_ib_set_status(uuid, text, text), public.admin_ib_decide(uuid, boolean) from public, anon;
grant execute on function public.admin_ib_list(), public.admin_ib_set_status(uuid, text, text), public.admin_ib_decide(uuid, boolean) to authenticated;
revoke all on function public.ib_code_new() from public, anon, authenticated;
revoke all on function public.payments_ib_paid() from public, anon, authenticated;
