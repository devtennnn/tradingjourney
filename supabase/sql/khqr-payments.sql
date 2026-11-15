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
