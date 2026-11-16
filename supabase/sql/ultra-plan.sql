-- ULTRA plan ($50.99 / 30 days). Ultra includes everything in Elite and Premium.
-- Run once in Supabase -> SQL Editor. Safe to re-run. Run AFTER khqr-all.sql (it replaces functions defined there).
begin;

-- 1) the plan column
alter table public.profiles add column if not exists ultra_until timestamptz;

-- 2) tier helpers: ultra includes elite includes premium
create or replace function public.is_ultra(uid uuid) returns boolean language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from public.profiles p where p.id = uid and (p.is_admin or (p.ultra_until is not null and p.ultra_until > now())));
$$;
create or replace function public.is_elite(uid uuid) returns boolean language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from public.profiles p where p.id = uid
    and (p.is_admin or (p.elite_until is not null and p.elite_until > now()) or (p.ultra_until is not null and p.ultra_until > now())));
$$;
create or replace function public.is_premium(uid uuid) returns boolean language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from public.profiles p where p.id = uid
    and (p.is_premium or p.is_admin
         or (p.premium_until is not null and p.premium_until > now())
         or (p.elite_until   is not null and p.elite_until   > now())
         or (p.ultra_until   is not null and p.ultra_until   > now())));
$$;
create or replace function public.user_tier(uid uuid) returns text language sql stable security definer set search_path to 'public' as $$
  select case when public.is_ultra(uid) then 'ultra' when public.is_elite(uid) then 'elite' when public.is_premium(uid) then 'premium' else 'free' end;
$$;
grant execute on function public.is_ultra(uuid) to authenticated, service_role;

-- 3) notifications: Ultra members see premium AND elite announcements
drop policy if exists "audience can read notifications" on public.notifications;
create policy "audience can read notifications" on public.notifications for select to authenticated using (
  is_admin(auth.uid()) or (((expires_at is null) or (expires_at > now())) and (
    (audience = 'all')
    or (audience = 'free' and user_tier(auth.uid()) = 'free')
    or (audience = 'premium' and user_tier(auth.uid()) = any (array['premium','elite','ultra']))
    or (audience = 'elite' and user_tier(auth.uid()) = any (array['elite','ultra']))
  )));

-- 4) allow 'ultra' in keys, promo codes and payments
alter table public.activation_keys drop constraint if exists activation_keys_plan_check;
alter table public.activation_keys add constraint activation_keys_plan_check check (plan = any (array['premium','elite','ultra']));
alter table public.promo_codes drop constraint if exists promo_codes_plan_check;
alter table public.promo_codes add constraint promo_codes_plan_check check (plan = any (array['any','premium','elite','ultra']));
alter table public.payments drop constraint if exists payments_plan_check;
alter table public.payments add constraint payments_plan_check check (plan = any (array['premium','elite','ultra']));

-- 5) helper: which profile column holds a plan
create or replace function public.plan_col(p text) returns text language sql immutable as $$
  select case p when 'ultra' then 'ultra_until' when 'elite' then 'elite_until' else 'premium_until' end;
$$;

-- 6) activation keys
create or replace function public.admin_create_keys(p_plan text, p_days integer, p_count integer default 1, p_max_uses integer default 1, p_note text default null, p_valid_days integer default null)
returns json language plpgsql security definer set search_path to 'public' as $f$
declare out jsonb := '[]'::jsonb; c text; i int;
begin
  perform public.admin_guard();
  if p_plan not in ('premium','elite','ultra') or p_days < 1 or p_days > 3650 or p_count < 1 or p_count > 200 or p_max_uses < 1 then raise exception 'bad_request'; end if;
  for i in 1..p_count loop
    loop
      c := public.gen_key_code();
      exit when not exists (select 1 from public.activation_keys where code = c);
    end loop;
    insert into public.activation_keys (code, plan, days, max_uses, note, valid_until)
    values (c, p_plan, p_days, p_max_uses, nullif(btrim(p_note), ''), case when p_valid_days is null then null else now() + make_interval(days => p_valid_days) end);
    out := out || to_jsonb(c);
  end loop;
  perform public.audit_write(auth.uid(), 'key_created', jsonb_build_object('count', p_count, 'plan', p_plan, 'days', p_days, 'max_uses', p_max_uses, 'note', p_note));
  return json_build_object('codes', out);
end $f$;

create or replace function public.redeem_key(p_code text)
returns json language plpgsql security definer set search_path to 'public' as $f$
declare uid uuid := auth.uid(); c text; k public.activation_keys; col text; col_until timestamptz; nxt timestamptz; fails int;
begin
  if uid is null then return json_build_object('error', 'not_authenticated'); end if;
  select count(*) into fails from public.audit_log where user_id = uid and action = 'key_failed' and created_at > now() - interval '1 hour';
  if fails >= 10 then return json_build_object('error', 'too_many_attempts'); end if;

  c := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  if c like 'DEVT%' then c := substr(c, 5); end if;
  if length(c) <> 12 then
    perform public.audit_write(uid, 'key_failed', jsonb_build_object('reason', 'format'));
    return json_build_object('error', 'invalid_key');
  end if;
  c := 'DEVT-' || substr(c,1,4) || '-' || substr(c,5,4) || '-' || substr(c,9,4);

  select * into k from public.activation_keys where code = c for update;
  if not found then
    perform public.audit_write(uid, 'key_failed', jsonb_build_object('reason', 'not_found', 'code', c));
    return json_build_object('error', 'invalid_key');
  end if;
  if k.revoked then return json_build_object('error', 'key_revoked'); end if;
  if k.valid_until is not null and k.valid_until < now() then return json_build_object('error', 'key_expired'); end if;
  if exists (select 1 from public.key_redemptions where key_id = k.id and user_id = uid) then return json_build_object('error', 'key_already_used_by_you'); end if;
  if k.uses >= k.max_uses then return json_build_object('error', 'key_used_up'); end if;

  col := public.plan_col(k.plan);
  execute format('select %I from public.profiles where id = $1', col) into col_until using uid;
  nxt := greatest(coalesce(col_until, now()), now()) + make_interval(days => k.days);
  execute format('update public.profiles set %I = $1 where id = $2', col) using nxt, uid;

  update public.activation_keys set uses = uses + 1, last_redeemed_at = now() where id = k.id;
  insert into public.key_redemptions (key_id, user_id, plan, days, until) values (k.id, uid, k.plan, k.days, nxt);
  perform public.audit_write(uid, 'key_redeemed', jsonb_build_object('code', k.code, 'plan', k.plan, 'days', k.days, 'until', nxt));
  return json_build_object('plan', k.plan, 'days', k.days, 'until', nxt);
end $f$;

create or replace function public.admin_set_plan(p_user uuid, p_plan text, p_days integer default 30)
returns json language plpgsql security definer set search_path to 'public' as $f$
declare col text; cur timestamptz; nxt timestamptz;
begin
  perform public.admin_guard();
  if p_plan = 'none' then
    update public.profiles set premium_until = null, elite_until = null, ultra_until = null, is_premium = false where id = p_user;
    perform public.audit_write(p_user, 'admin_grant', jsonb_build_object('plan','none'));
    return json_build_object('ok', true);
  end if;
  if p_plan not in ('premium','elite','ultra') or p_days < 1 or p_days > 3650 then raise exception 'bad_request'; end if;
  col := public.plan_col(p_plan);
  execute format('select %I from public.profiles where id = $1', col) into cur using p_user;
  nxt := greatest(coalesce(cur, now()), now()) + make_interval(days => p_days);
  execute format('update public.profiles set %I = $1 where id = $2', col) using nxt, p_user;
  perform public.audit_write(p_user, 'admin_grant', jsonb_build_object('plan',p_plan,'days',p_days,'until',nxt));
  return json_build_object('ok', true, 'until', nxt);
end $f$;

-- 7) approving a payment by hand
create or replace function public.admin_approve_payment(p_id uuid)
returns json language plpgsql security definer set search_path to 'public' as $f$
declare r public.payments; col text; cur timestamptz; nxt timestamptz;
begin
  perform public.admin_guard();
  select * into r from public.payments where id = p_id for update;
  if r.id is null then raise exception 'not_found'; end if;
  if r.status = 'paid' then return json_build_object('ok', true, 'already', true); end if;
  col := public.plan_col(coalesce(r.plan, 'premium'));
  execute format('select %I from public.profiles where id = $1', col) into cur using r.user_id;
  nxt := greatest(coalesce(cur, now()), now()) + interval '30 days';
  execute format('update public.profiles set %I = $1 where id = $2', col) using nxt, r.user_id;
  update public.payments set status = 'paid', paid_at = now(), approved_by = auth.uid() where id = r.id;
  perform public.audit_write(r.user_id, 'plan_upgrade', jsonb_build_object('plan', coalesce(r.plan,'premium'), 'days', 30, 'until', nxt, 'amount', r.amount, 'bill', r.bill_number, 'via', 'admin approval', 'promo', r.promo_code));
  return json_build_object('ok', true, 'until', nxt);
end $f$;

-- 8) audit plan changes of the new column too
create or replace function public.audit_profiles() returns trigger language plpgsql security definer set search_path to 'public' as $f$
begin
  begin
    if new.premium_until is distinct from old.premium_until then
      perform public.audit_write(new.id, 'plan_change', jsonb_build_object('plan','premium','from',old.premium_until,'to',new.premium_until));
    end if;
    if new.elite_until is distinct from old.elite_until then
      perform public.audit_write(new.id, 'plan_change', jsonb_build_object('plan','elite','from',old.elite_until,'to',new.elite_until));
    end if;
    if new.ultra_until is distinct from old.ultra_until then
      perform public.audit_write(new.id, 'plan_change', jsonb_build_object('plan','ultra','from',old.ultra_until,'to',new.ultra_until));
    end if;
    if new.is_premium is distinct from old.is_premium then
      perform public.audit_write(new.id, 'plan_change', jsonb_build_object('plan','premium_lifetime','to',new.is_premium));
    end if;
    if new.display_name is distinct from old.display_name and old.display_name is not null then
      perform public.audit_write(new.id, 'name_changed', jsonb_build_object('from',old.display_name,'to',new.display_name));
    end if;
    if new.avatar_url is distinct from old.avatar_url then
      perform public.audit_write(new.id, 'avatar_changed', jsonb_build_object('removed', new.avatar_url is null));
    end if;
    if new.username is distinct from old.username then
      perform public.audit_write(new.id, 'username_set', jsonb_build_object('from',old.username,'to',new.username));
    end if;
    if new.is_admin is distinct from old.is_admin then
      perform public.audit_write(new.id, 'admin_role', jsonb_build_object('admin',new.is_admin));
    end if;
  exception when others then null;
  end;
  return new;
end $f$;

-- 9) admin overview / users: count and show Ultra
create or replace function public.admin_overview()
 returns json language plpgsql stable security definer set search_path to 'public' as $f$
begin
  perform public.admin_guard();
  return json_build_object(
    'users',          (select count(*) from auth.users),
    'verified',       (select count(*) from auth.users where email_confirmed_at is not null),
    'new_7d',         (select count(*) from auth.users where created_at > now() - interval '7 days'),
    'active_7d',      (select count(*) from auth.users where last_sign_in_at > now() - interval '7 days'),
    'ultra_active',   (select count(*) from public.profiles where ultra_until > now()),
    'elite_active',   (select count(*) from public.profiles where (elite_until > now() or is_admin) and not (coalesce(ultra_until, '-infinity') > now())),
    'premium_active', (select count(*) from public.profiles where (premium_until > now() or is_premium) and not (coalesce(elite_until, '-infinity') > now() or coalesce(ultra_until, '-infinity') > now() or is_admin)),
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
           p.username, p.display_name, p.premium_until, p.elite_until, p.ultra_until, p.is_premium, p.is_admin,
           (select count(*) from public.trades t where t.user_id = u.id) as trades,
           (select coalesce(sum(y.amount), 0) from public.payments y where y.user_id = u.id and y.status = 'paid') as paid_total
    from auth.users u left join public.profiles p on p.id = u.id
    where lower(coalesce(u.email,'')) like q or lower(coalesce(p.username,'')) like q or lower(coalesce(p.display_name,'')) like q
    order by u.created_at desc limit least(greatest(p_limit,1),200) offset greatest(p_offset,0)) r);
end $f$;

commit;
