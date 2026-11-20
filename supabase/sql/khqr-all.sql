-- WARNING: superseded. Do not re-run on the live database: later files (ultra-plan.sql, course.sql, security-fixes.sql) replaced some functions here
-- (admin_approve_payment, plan_col, payments_plan_check, promo_quote_internal). Re-running this would undo those fixes.
-- KHQR payments: ALL 3 steps in one file. Paste into Supabase -> SQL Editor and click Run once. Safe to re-run.
-- KHQR payments, step 1 of 3 (run once in Supabase -> SQL Editor). Re-runnable.
-- Run the three files in this order:  1) khqr-payments.sql   2) khqr-manual-confirmation.sql   3) promo-codes.sql
-- The promo_codes table and its 4 codes are already there; file 3 only re-creates the functions around them.
begin;

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  bill_number text not null unique,
  md5 text not null,
  payload text not null,
  plan text not null default 'premium' check (plan in ('premium','elite')),
  amount numeric not null,
  currency text not null default 'USD',
  status text not null default 'pending' check (status in ('pending','paid','expired','claimed')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  paid_at timestamptz,
  bakong_hash text
);
create index if not exists payments_user_idx on public.payments (user_id, created_at desc);
create index if not exists payments_status_idx on public.payments (status, created_at desc);
create index if not exists payments_md5_idx on public.payments (md5);

-- only the khqr edge function (service role) writes; a signed-in user may read their own rows
alter table public.payments enable row level security;
drop policy if exists payments_select_own on public.payments;
create policy payments_select_own on public.payments for select to authenticated using (user_id = auth.uid());
revoke all on public.payments from anon;
revoke insert, update, delete on public.payments from authenticated;

-- audit trail: created / expired (paid + approved rows are written by the functions themselves)
create or replace function public.audit_payments() returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if tg_op = 'INSERT' then
    perform public.audit_write(new.user_id, 'payment_created', jsonb_build_object('plan', new.plan, 'amount', new.amount, 'bill', new.bill_number));
  elsif tg_op = 'UPDATE' and new.status = 'expired' and old.status is distinct from 'expired' then
    perform public.audit_write(new.user_id, 'payment_expired', jsonb_build_object('plan', new.plan, 'amount', new.amount, 'bill', new.bill_number));
  end if;
  return new;
end $$;
drop trigger if exists audit_payments on public.payments;
create trigger audit_payments after insert or update on public.payments for each row execute function public.audit_payments();

-- Mark open QRs whose time ran out
create or replace function public.expire_stale_payments() returns integer language plpgsql security definer set search_path to 'public' as $$
declare n integer;
begin
  update public.payments set status = 'expired' where status = 'pending' and expires_at < now();
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.expire_stale_payments() from public, anon, authenticated;
grant execute on function public.expire_stale_payments() to service_role;

-- admin screens: show money again
create or replace function public.admin_overview()
 returns json language plpgsql stable security definer set search_path to 'public' as $f$
begin
  perform public.admin_guard();
  return json_build_object(
    'users',          (select count(*) from auth.users),
    'verified',       (select count(*) from auth.users where email_confirmed_at is not null),
    'new_7d',         (select count(*) from auth.users where created_at > now() - interval '7 days'),
    'active_7d',      (select count(*) from auth.users where last_sign_in_at > now() - interval '7 days'),
    'elite_active',   (select count(*) from public.profiles where elite_until > now() or is_admin),
    'premium_active', (select count(*) from public.profiles where (premium_until > now() or is_premium) and not (coalesce(elite_until, '-infinity') > now() or is_admin)),
    'trades',         (select count(*) from public.trades),
    'act_total',      (select count(*) from public.payments where status = 'paid'),
    'revenue_total',  (select coalesce(sum(amount), 0) from public.payments where status = 'paid'),
    'act_30d',        (select count(*) from public.payments where status = 'paid' and paid_at > now() - interval '30 days'),
    'act_elite_30d',  (select count(*) from public.payments where status = 'paid' and plan = 'elite' and paid_at > now() - interval '30 days')
  );
end $f$;

create or replace function public.admin_users(p_search text default ''::text, p_limit integer default 50, p_offset integer default 0)
 returns json language plpgsql stable security definer set search_path to 'public' as $f$
declare q text := '%' || lower(coalesce(p_search, '')) || '%';
begin
  perform public.admin_guard();
  return (select coalesce(json_agg(r order by r.created_at desc), '[]'::json) from (
    select u.id, u.email, u.created_at, u.last_sign_in_at, u.email_confirmed_at is not null as verified,
           p.username, p.display_name, p.premium_until, p.elite_until, p.is_premium, p.is_admin,
           (select count(*) from public.trades t where t.user_id = u.id) as trades,
           (select coalesce(sum(y.amount), 0) from public.payments y where y.user_id = u.id and y.status = 'paid') as paid_total
    from auth.users u left join public.profiles p on p.id = u.id
    where lower(coalesce(u.email,'')) like q or lower(coalesce(p.username,'')) like q or lower(coalesce(p.display_name,'')) like q
    order by u.created_at desc limit least(greatest(p_limit,1),200) offset greatest(p_offset,0)) r);
end $f$;

commit;

-- KHQR: manual confirmation path for when Bakong cannot be reached (it rejects calls from outside Cambodia).
-- Already applied to the tradejourney project as migration "khqr_manual_confirmation". Safe to re-run.
alter table public.payments add column if not exists claimed_at timestamptz;
alter table public.payments add column if not exists claim_note text;
alter table public.payments add column if not exists approved_by uuid;
alter table public.payments drop constraint if exists payments_status_check;
alter table public.payments add constraint payments_status_check check (status in ('pending','paid','expired','claimed'));

-- The user says "I paid this QR". Changes no plan: an admin has to approve it.
create or replace function public.claim_payment(p_id uuid, p_note text default null)
returns json language plpgsql security definer set search_path to 'public' as $$
declare r public.payments;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  update public.payments set status = 'claimed', claimed_at = now(), claim_note = left(p_note, 200)
   where id = p_id and user_id = auth.uid() and status in ('pending','expired') and created_at > now() - interval '3 days'
   returning * into r;
  if r.id is null then
    select * into r from public.payments where id = p_id and user_id = auth.uid();
    if r.id is null then return json_build_object('ok', false, 'error', 'not_found'); end if;
    return json_build_object('ok', r.status in ('claimed','paid'), 'status', r.status);
  end if;
  perform public.audit_write(auth.uid(), 'payment_claimed', jsonb_build_object('plan', r.plan, 'amount', r.amount, 'bill', r.bill_number));
  return json_build_object('ok', true, 'status', 'claimed');
end $$;

-- Admin approves a payment after checking the bill number in the bank app: marks it paid and adds 30 days, once.
create or replace function public.admin_approve_payment(p_id uuid)
returns json language plpgsql security definer set search_path to 'public' as $$
declare r public.payments; cur timestamptz; nxt timestamptz;
begin
  perform public.admin_guard();
  select * into r from public.payments where id = p_id for update;
  if r.id is null then raise exception 'not_found'; end if;
  if r.status = 'paid' then return json_build_object('ok', true, 'already', true); end if;
  if coalesce(r.plan, 'premium') = 'elite' then select elite_until into cur from public.profiles where id = r.user_id;
  else select premium_until into cur from public.profiles where id = r.user_id; end if;
  nxt := greatest(coalesce(cur, now()), now()) + interval '30 days';
  if coalesce(r.plan, 'premium') = 'elite' then update public.profiles set elite_until = nxt where id = r.user_id;
  else update public.profiles set premium_until = nxt where id = r.user_id; end if;
  update public.payments set status = 'paid', paid_at = now(), approved_by = auth.uid() where id = r.id;
  perform public.audit_write(r.user_id, 'plan_upgrade', jsonb_build_object('plan', coalesce(r.plan,'premium'), 'days', 30, 'until', nxt, 'amount', r.amount, 'bill', r.bill_number, 'via', 'admin approval'));
  return json_build_object('ok', true, 'until', nxt);
end $$;

-- Admin rejects a claim (nothing found in the bank): back to expired so the user can create a new QR.
create or replace function public.admin_reject_payment(p_id uuid)
returns json language plpgsql security definer set search_path to 'public' as $$
declare r public.payments;
begin
  perform public.admin_guard();
  update public.payments set status = 'expired', claim_note = trim(both ' ' from coalesce(claim_note, '') || ' [rejected]')
   where id = p_id and status in ('claimed','pending') returning * into r;
  if r.id is null then raise exception 'not_found'; end if;
  perform public.audit_write(r.user_id, 'payment_rejected', jsonb_build_object('plan', coalesce(r.plan,'premium'), 'amount', r.amount, 'bill', r.bill_number));
  return json_build_object('ok', true);
end $$;

-- admin_payments: also return the claim fields, newest claims first
create or replace function public.admin_payments(p_status text default null, p_limit integer default 100)
returns json language plpgsql stable security definer set search_path to 'public' as $$
begin
  perform public.admin_guard();
  return (select coalesce(json_agg(r order by (r.status = 'claimed') desc, r.created_at desc), '[]'::json) from (
    select y.id, y.created_at, y.paid_at, y.expires_at, y.status, coalesce(y.plan,'premium') as plan, y.amount, y.currency, y.bill_number,
           y.claimed_at, y.claim_note, u.email, p.username
    from public.payments y left join auth.users u on u.id = y.user_id left join public.profiles p on p.id = y.user_id
    where p_status is null or p_status = '' or y.status = any(string_to_array(p_status, ','))
    order by y.created_at desc limit least(greatest(p_limit,1),500)) r);
end $$;

revoke all on function public.claim_payment(uuid, text) from public, anon;
revoke all on function public.admin_approve_payment(uuid) from public, anon;
revoke all on function public.admin_reject_payment(uuid) from public, anon;
grant execute on function public.claim_payment(uuid, text) to authenticated;
grant execute on function public.admin_approve_payment(uuid) to authenticated;
grant execute on function public.admin_reject_payment(uuid) to authenticated;

-- Promo codes: percent / fixed discounts on a plan price, with limits, expiry and tracking.
-- Run once in Supabase -> SQL Editor (project: tradejourney). Safe to re-run.
create table if not exists public.promo_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9_-]{3,24}$'),
  kind text not null check (kind in ('percent','fixed')),
  value numeric not null check (value > 0),
  plan text not null default 'any' check (plan in ('any','premium','elite')),
  max_uses integer check (max_uses is null or max_uses > 0),          -- total uses (paid + waiting); null = unlimited
  per_user integer not null default 1 check (per_user > 0),
  valid_from timestamptz not null default now(),
  valid_until timestamptz,
  active boolean not null default true,
  campaign text,
  note text,
  created_by uuid,
  created_at timestamptz not null default now(),
  constraint promo_percent_range check (kind <> 'percent' or value <= 99),
  constraint promo_fixed_range check (kind <> 'fixed' or value <= 1000)
);
alter table public.promo_codes enable row level security;   -- no policies: only the security-definer functions below touch it
revoke all on public.promo_codes from anon, authenticated;

alter table public.payments add column if not exists promo_code text references public.promo_codes(code) on update cascade on delete restrict;
alter table public.payments add column if not exists list_price numeric;
alter table public.payments add column if not exists discount numeric not null default 0;
create index if not exists payments_promo_idx on public.payments (promo_code) where promo_code is not null;

-- ===== internal: price quote for one user / plan (used by the khqr function with the service role only) =====
-- A use is "taken" when its payment is paid or claimed, or its QR is still open. The caller's own open QR for the same plan does not count against them.
create or replace function public.promo_quote_internal(p_user uuid, p_code text, p_plan text, p_price numeric)
returns json language plpgsql security definer set search_path to 'public' as $$
declare c public.promo_codes; used int; mine int; disc numeric; fin numeric;
begin
  select * into c from public.promo_codes where code = upper(trim(coalesce(p_code, '')));
  if c.id is null then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if not c.active then return json_build_object('ok', false, 'error', 'inactive'); end if;
  if c.valid_from > now() then return json_build_object('ok', false, 'error', 'not_started'); end if;
  if c.valid_until is not null and c.valid_until < now() then return json_build_object('ok', false, 'error', 'expired'); end if;
  if c.plan <> 'any' and c.plan <> p_plan then return json_build_object('ok', false, 'error', 'plan_mismatch', 'plan', c.plan); end if;
  select count(*) into used from public.payments y where y.promo_code = c.code
    and (y.status in ('paid','claimed') or (y.status = 'pending' and y.expires_at > now()))
    and not (y.user_id = p_user and y.plan = p_plan and y.status = 'pending');
  if c.max_uses is not null and used >= c.max_uses then return json_build_object('ok', false, 'error', 'limit_reached'); end if;
  select count(*) into mine from public.payments y where y.promo_code = c.code and y.user_id = p_user
    and (y.status in ('paid','claimed') or (y.status = 'pending' and y.expires_at > now()))
    and not (y.plan = p_plan and y.status = 'pending');
  if mine >= c.per_user then return json_build_object('ok', false, 'error', 'already_used'); end if;
  if c.kind = 'percent' then disc := round(p_price * c.value / 100, 2); else disc := least(c.value, p_price - 0.01); end if;
  disc := greatest(disc, 0); fin := round(p_price - disc, 2);
  if fin < 0.01 then fin := 0.01; disc := round(p_price - fin, 2); end if;
  return json_build_object('ok', true, 'code', c.code, 'kind', c.kind, 'value', c.value, 'plan', c.plan, 'list_price', p_price, 'discount', disc, 'final', fin);
end $$;

-- ===== internal: insert a payment that uses a promo code, re-checking the limits under a lock (two buyers cannot both take the last use) =====
create or replace function public.create_payment_row(p_user uuid, p_bill text, p_md5 text, p_payload text, p_plan text, p_list_price numeric,
  p_amount numeric, p_currency text, p_expires timestamptz, p_code text)
returns json language plpgsql security definer set search_path to 'public' as $$
declare q json; r public.payments;
begin
  perform pg_advisory_xact_lock(hashtext('promo:' || upper(trim(p_code))));
  q := public.promo_quote_internal(p_user, p_code, p_plan, p_list_price);
  if not (q->>'ok')::boolean then raise exception 'promo_%', q->>'error'; end if;
  if abs((q->>'final')::numeric - p_amount) > 0.004 then raise exception 'promo_price_changed'; end if;
  insert into public.payments (user_id, bill_number, md5, payload, plan, amount, currency, status, expires_at, promo_code, list_price, discount)
    values (p_user, p_bill, p_md5, p_payload, p_plan, p_amount, p_currency, 'pending', p_expires, (q->>'code'), p_list_price, (q->>'discount')::numeric)
    returning * into r;
  return row_to_json(r);
end $$;

-- ===== admin =====
create or replace function public.admin_promo_create(p_code text, p_kind text, p_value numeric, p_plan text default 'any', p_max_uses integer default null,
  p_per_user integer default 1, p_valid_until timestamptz default null, p_campaign text default null, p_note text default null)
returns json language plpgsql security definer set search_path to 'public' as $$
declare cd text := upper(trim(coalesce(p_code, ''))); r public.promo_codes; tries int := 0;
begin
  perform public.admin_guard();
  if p_kind not in ('percent','fixed') then raise exception 'bad_kind'; end if;
  if p_value is null or p_value <= 0 then raise exception 'bad_value'; end if;
  if p_kind = 'percent' and p_value > 99 then raise exception 'percent_max_99'; end if;
  if p_kind = 'fixed' and p_value > 1000 then raise exception 'fixed_max_1000'; end if;
  if coalesce(p_plan, 'any') not in ('any','premium','elite') then raise exception 'bad_plan'; end if;
  if p_max_uses is not null and p_max_uses < 1 then raise exception 'bad_max_uses'; end if;
  if coalesce(p_per_user, 1) < 1 then raise exception 'bad_per_user'; end if;
  if p_valid_until is not null and p_valid_until <= now() then raise exception 'expiry_in_past'; end if;
  if cd = '' then
    loop
      cd := 'DT' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
      exit when not exists (select 1 from public.promo_codes where code = cd);
      tries := tries + 1; if tries > 20 then raise exception 'could_not_generate'; end if;
    end loop;
  elsif cd !~ '^[A-Z0-9_-]{3,24}$' then raise exception 'bad_code';
  end if;
  begin
    insert into public.promo_codes (code, kind, value, plan, max_uses, per_user, valid_until, campaign, note, created_by)
      values (cd, p_kind, round(p_value, 2), coalesce(p_plan, 'any'), p_max_uses, coalesce(p_per_user, 1), p_valid_until, nullif(trim(p_campaign), ''), nullif(trim(p_note), ''), auth.uid())
      returning * into r;
  exception when unique_violation then raise exception 'code_taken';
  end;
  perform public.audit_write(auth.uid(), 'promo_created', jsonb_build_object('code', r.code, 'kind', r.kind, 'value', r.value, 'plan', r.plan, 'max_uses', r.max_uses));
  return json_build_object('ok', true, 'id', r.id, 'code', r.code);
end $$;

create or replace function public.admin_promo_list()
returns json language plpgsql stable security definer set search_path to 'public' as $$
begin
  perform public.admin_guard();
  return (select coalesce(json_agg(x order by x.created_at desc), '[]'::json) from (
    select c.id, c.code, c.kind, c.value, c.plan, c.max_uses, c.per_user, c.valid_from, c.valid_until, c.active, c.campaign, c.note, c.created_at,
           coalesce(s.paid, 0) as paid, coalesce(s.reserved, 0) as reserved, coalesce(s.discount_total, 0) as discount_total,
           coalesce(s.revenue, 0) as revenue, s.last_paid, coalesce(s.users, 0) as users
    from public.promo_codes c
    left join lateral (
      select count(*) filter (where y.status = 'paid') as paid,
             count(*) filter (where y.status = 'claimed' or (y.status = 'pending' and y.expires_at > now())) as reserved,
             sum(y.discount) filter (where y.status = 'paid') as discount_total,
             sum(y.amount) filter (where y.status = 'paid') as revenue,
             max(y.paid_at) filter (where y.status = 'paid') as last_paid,
             count(distinct y.user_id) filter (where y.status = 'paid') as users
      from public.payments y where y.promo_code = c.code) s on true) x);
end $$;

create or replace function public.admin_promo_redemptions(p_id uuid)
returns json language plpgsql stable security definer set search_path to 'public' as $$
begin
  perform public.admin_guard();
  return (select coalesce(json_agg(x order by x.created_at desc), '[]'::json) from (
    select y.id, y.created_at, y.paid_at, y.status, coalesce(y.plan, 'premium') as plan, y.list_price, y.discount, y.amount, y.currency, y.bill_number,
           u.email, p.username
    from public.payments y join public.promo_codes c on c.code = y.promo_code
    left join auth.users u on u.id = y.user_id left join public.profiles p on p.id = y.user_id
    where c.id = p_id order by y.created_at desc limit 300) x);
end $$;

create or replace function public.admin_promo_toggle(p_id uuid, p_active boolean)
returns json language plpgsql security definer set search_path to 'public' as $$
declare r public.promo_codes;
begin
  perform public.admin_guard();
  update public.promo_codes set active = p_active where id = p_id returning * into r;
  if r.id is null then raise exception 'not_found'; end if;
  perform public.audit_write(auth.uid(), 'promo_toggled', jsonb_build_object('code', r.code, 'active', r.active));
  return json_build_object('ok', true, 'active', r.active);
end $$;

create or replace function public.admin_promo_delete(p_id uuid)
returns json language plpgsql security definer set search_path to 'public' as $$
declare r public.promo_codes;
begin
  perform public.admin_guard();
  select * into r from public.promo_codes where id = p_id;
  if r.id is null then raise exception 'not_found'; end if;
  if exists (select 1 from public.payments where promo_code = r.code) then raise exception 'in_use'; end if;
  delete from public.promo_codes where id = p_id;
  perform public.audit_write(auth.uid(), 'promo_deleted', jsonb_build_object('code', r.code));
  return json_build_object('ok', true);
end $$;

-- approving a payment by hand: remember which promo it used in the audit trail
create or replace function public.admin_approve_payment(p_id uuid)
returns json language plpgsql security definer set search_path to 'public' as $$
declare r public.payments; cur timestamptz; nxt timestamptz;
begin
  perform public.admin_guard();
  select * into r from public.payments where id = p_id for update;
  if r.id is null then raise exception 'not_found'; end if;
  if r.status = 'paid' then return json_build_object('ok', true, 'already', true); end if;
  if coalesce(r.plan, 'premium') = 'elite' then select elite_until into cur from public.profiles where id = r.user_id;
  else select premium_until into cur from public.profiles where id = r.user_id; end if;
  nxt := greatest(coalesce(cur, now()), now()) + interval '30 days';
  if coalesce(r.plan, 'premium') = 'elite' then update public.profiles set elite_until = nxt where id = r.user_id;
  else update public.profiles set premium_until = nxt where id = r.user_id; end if;
  update public.payments set status = 'paid', paid_at = now(), approved_by = auth.uid() where id = r.id;
  perform public.audit_write(r.user_id, 'plan_upgrade', jsonb_build_object('plan', coalesce(r.plan,'premium'), 'days', 30, 'until', nxt, 'amount', r.amount, 'bill', r.bill_number, 'via', 'admin approval', 'promo', r.promo_code));
  return json_build_object('ok', true, 'until', nxt);
end $$;

-- admin_payments: show the promo used
create or replace function public.admin_payments(p_status text default null, p_limit integer default 100)
returns json language plpgsql stable security definer set search_path to 'public' as $$
begin
  perform public.admin_guard();
  return (select coalesce(json_agg(r order by (r.status = 'claimed') desc, r.created_at desc), '[]'::json) from (
    select y.id, y.created_at, y.paid_at, y.expires_at, y.status, coalesce(y.plan,'premium') as plan, y.amount, y.currency, y.bill_number,
           y.claimed_at, y.claim_note, y.promo_code, y.list_price, y.discount, u.email, p.username
    from public.payments y left join auth.users u on u.id = y.user_id left join public.profiles p on p.id = y.user_id
    where p_status is null or p_status = '' or y.status = any(string_to_array(p_status, ','))
    order by y.created_at desc limit least(greatest(p_limit,1),500)) r);
end $$;

-- permissions: admin functions for signed-in users (the guard decides); internal ones for the service role only
revoke all on function public.admin_promo_create(text, text, numeric, text, integer, integer, timestamptz, text, text) from public, anon;
revoke all on function public.admin_promo_list() from public, anon;
revoke all on function public.admin_promo_redemptions(uuid) from public, anon;
revoke all on function public.admin_promo_toggle(uuid, boolean) from public, anon;
revoke all on function public.admin_promo_delete(uuid) from public, anon;
grant execute on function public.admin_promo_create(text, text, numeric, text, integer, integer, timestamptz, text, text) to authenticated;
grant execute on function public.admin_promo_list() to authenticated;
grant execute on function public.admin_promo_redemptions(uuid) to authenticated;
grant execute on function public.admin_promo_toggle(uuid, boolean) to authenticated;
grant execute on function public.admin_promo_delete(uuid) to authenticated;
revoke all on function public.promo_quote_internal(uuid, text, text, numeric) from public, anon, authenticated;
revoke all on function public.create_payment_row(uuid, text, text, text, text, numeric, numeric, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.promo_quote_internal(uuid, text, text, numeric) to service_role;
grant execute on function public.create_payment_row(uuid, text, text, text, text, numeric, numeric, text, timestamptz, text) to service_role;
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
