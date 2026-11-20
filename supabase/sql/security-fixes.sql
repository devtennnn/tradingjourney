-- Security fixes from the 20 Nov 2026 audit. Run once in the Supabase SQL Editor (safe to re-run).
-- Each block names the issue it closes. Nothing here reads or changes user data except:
--   * the payments status check gains 'rejected'
--   * a unique index on broker_accounts (one MetaApi row per user; no current row breaks it)

-- 1. Plan / admin checks: nobody can ask about ANOTHER user's plan or admin flag.
--    Allowed: your own id, server code (service role, cron, SQL editor), or an admin.
create or replace function public.tier_peek_ok(uid uuid) returns boolean
language sql stable security definer set search_path to 'public' as $$
  select coalesce(uid = auth.uid(), false)
      or coalesce(auth.role(), '') not in ('anon', 'authenticated')
      or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin);
$$;

create or replace function public.is_admin(uid uuid) returns boolean
language sql stable security definer set search_path to 'public' as $$
  select public.tier_peek_ok(uid) and coalesce((select p.is_admin from public.profiles p where p.id = uid), false);
$$;

create or replace function public.is_elite(uid uuid) returns boolean
language sql stable security definer set search_path to 'public' as $$
  select public.tier_peek_ok(uid) and exists (select 1 from public.profiles p where p.id = uid
    and (p.is_admin or (p.elite_until is not null and p.elite_until > now()) or (p.ultra_until is not null and p.ultra_until > now())));
$$;

create or replace function public.is_premium(uid uuid) returns boolean
language sql stable security definer set search_path to 'public' as $$
  select public.tier_peek_ok(uid) and exists (select 1 from public.profiles p where p.id = uid
    and (p.is_premium or p.is_admin
         or (p.premium_until is not null and p.premium_until > now())
         or (p.elite_until   is not null and p.elite_until   > now())
         or (p.ultra_until   is not null and p.ultra_until   > now())));
$$;

create or replace function public.is_ultra(uid uuid) returns boolean
language sql stable security definer set search_path to 'public' as $$
  select public.tier_peek_ok(uid) and exists (select 1 from public.profiles p where p.id = uid
    and (p.is_admin or (p.ultra_until is not null and p.ultra_until > now())));
$$;

create or replace function public.has_course(u uuid default auth.uid()) returns boolean
language sql stable security definer set search_path to 'public' as $$
  select public.tier_peek_ok(u) and exists (select 1 from public.profiles where id = u and (is_admin or coalesce(course_until, 'epoch') > now()));
$$;
-- user_tier() calls the functions above, so it is covered too.

-- 2. Web Push: only real browser push services, bounded settings, and you can only change / remove your own subscription.
create or replace function public.push_subscribe(p_sub jsonb, p_prefs jsonb, p_lang text default 'en')
returns void language plpgsql security definer set search_path to 'public' as $$
declare ep text := p_sub->>'endpoint'; n int;
begin
  if ep is null or length(ep) > 1000
     or ep !~ '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9.-]+\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com)/' then
    raise exception 'bad endpoint';
  end if;
  if coalesce(p_sub->'keys'->>'p256dh','') = '' or coalesce(p_sub->'keys'->>'auth','') = ''
     or length(p_sub->'keys'->>'p256dh') > 200 or length(p_sub->'keys'->>'auth') > 100 then raise exception 'bad keys'; end if;
  if p_prefs is not null and (length(p_prefs::text) > 8000
     or (jsonb_typeof(p_prefs->'pa') = 'array' and jsonb_array_length(p_prefs->'pa') > 20)) then raise exception 'bad prefs'; end if;
  if auth.uid() is not null then
    select count(*) into n from push_subs where user_id = auth.uid() and endpoint <> ep;
    if n >= 10 then raise exception 'too many devices'; end if;
  end if;
  insert into push_subs (endpoint, p256dh, auth, user_id, prefs, lang, updated_at, fails)
  values (ep, p_sub->'keys'->>'p256dh', p_sub->'keys'->>'auth', auth.uid(), coalesce(p_prefs, '{}'::jsonb), left(coalesce(nullif(p_lang,''), 'en'), 5), now(), 0)
  on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth,
    user_id = coalesce(auth.uid(), push_subs.user_id), prefs = excluded.prefs, lang = excluded.lang, updated_at = now(), fails = 0
    where push_subs.user_id is null or push_subs.user_id = auth.uid();
end $$;

create or replace function public.push_unsubscribe(p_endpoint text) returns void
language sql security definer set search_path to 'public' as $$
  delete from push_subs where endpoint = p_endpoint and (user_id is null or user_id = auth.uid());
$$;

-- 3. Promo limits: every open promo QR of the caller now counts. (The khqr function re-opens the
--    user's existing QR for the same promo BEFORE it asks for a quote, so re-opening still works.)
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
    and (y.status in ('paid','claimed') or (y.status = 'pending' and y.expires_at > now()));
  if c.max_uses is not null and used >= c.max_uses then return json_build_object('ok', false, 'error', 'limit_reached'); end if;
  select count(*) into mine from public.payments y where y.promo_code = c.code and y.user_id = p_user
    and (y.status in ('paid','claimed') or (y.status = 'pending' and y.expires_at > now()));
  if mine >= c.per_user then return json_build_object('ok', false, 'error', 'already_used'); end if;
  if c.kind = 'percent' then disc := round(p_price * c.value / 100, 2); else disc := least(c.value, p_price - 0.01); end if;
  disc := greatest(disc, 0); fin := round(p_price - disc, 2);
  if fin < 0.01 then fin := 0.01; disc := round(p_price - fin, 2); end if;
  return json_build_object('ok', true, 'code', c.code, 'kind', c.kind, 'value', c.value, 'plan', c.plan, 'list_price', p_price, 'discount', disc, 'final', fin);
end $$;

-- 4. Plan extension in one statement (khqr settle and khqr-webhook call this), so two payments settled
--    at the same moment both add their days. Server only.
create or replace function public.extend_plan(p_user uuid, p_plan text, p_days int) returns timestamptz
language plpgsql security definer set search_path to 'public' as $$
declare col text; nxt timestamptz;
begin
  if p_plan not in ('premium','elite','ultra') or p_days < 1 or p_days > 3650 then raise exception 'bad_request'; end if;
  col := public.plan_col(p_plan);
  execute format('update public.profiles set %1$I = greatest(coalesce(%1$I, now()), now()) + make_interval(days => $1) where id = $2 returning %1$I', col)
    into nxt using p_days, p_user;
  return nxt;
end $$;
revoke all on function public.extend_plan(uuid, text, int) from public, anon, authenticated;
grant execute on function public.extend_plan(uuid, text, int) to service_role;

-- 5. Rejected payments get their own status, so the gateway webhook / re-check can never settle them later.
alter table public.payments drop constraint if exists payments_status_check;
alter table public.payments add constraint payments_status_check check (status in ('pending','paid','expired','claimed','rejected'));

create or replace function public.admin_reject_payment(p_id uuid) returns json
language plpgsql security definer set search_path to 'public' as $$
declare r public.payments;
begin
  perform public.admin_guard();
  update public.payments set status = 'rejected', claim_note = trim(both ' ' from coalesce(claim_note, '') || ' [rejected]')
   where id = p_id and status in ('claimed','pending','expired') returning * into r;
  if r.id is null then raise exception 'not_found'; end if;
  perform public.audit_write(r.user_id, 'payment_rejected', jsonb_build_object('plan', coalesce(r.plan,'premium'), 'amount', r.amount, 'bill', r.bill_number));
  return json_build_object('ok', true);
end $$;

-- 6. Course quiz: take the lock FIRST, then check "already passed" / "wait 7 days",
--    so a burst of parallel answers cannot open several graded attempts.
create or replace function public.course_quiz_answer(p_lesson text, p_q integer, p_choice integer)
returns json language plpgsql security definer set search_path to 'public' as $$
declare l public.course_lessons; k int[]; n int; st json; cur public.course_quiz_attempts; s int := 0; i int;
begin
  if auth.uid() is null then raise exception 'login_required'; end if;
  select * into l from public.course_lessons where id = p_lesson and published;
  if l.id is null or l.quiz is null then raise exception 'no_quiz'; end if;
  if not (l.free or public.has_course()) then raise exception 'locked'; end if;
  n := jsonb_array_length(l.quiz);
  if p_q is null or p_q < 0 or p_q >= n then raise exception 'bad_question'; end if;
  if p_choice is null or p_choice < 0 or p_choice >= jsonb_array_length(l.quiz -> p_q -> 'opts_en') then raise exception 'bad_choice'; end if;
  perform pg_advisory_xact_lock(hashtext('quiz:' || auth.uid() || ':' || p_lesson));
  st := public.course_quiz_state(p_lesson);   -- read AFTER the lock: sees any attempt graded a moment ago
  if (st->>'passed')::boolean then raise exception 'already_passed'; end if;
  if st->>'retry_at' is not null then raise exception 'wait_until %', st->>'retry_at'; end if;
  select * into cur from public.course_quiz_attempts where user_id = auth.uid() and lesson_id = p_lesson and submitted_at is null order by id desc limit 1 for update;
  if cur.id is not null and coalesce(array_length(cur.answers, 1), 0) <> n then
    delete from public.course_quiz_attempts where id = cur.id; cur := null;
  end if;
  if cur.id is null then
    insert into public.course_quiz_attempts (user_id, lesson_id, answers) values (auth.uid(), p_lesson, array_fill(null::int, array[n])) returning * into cur;
  end if;
  if cur.answers[p_q + 1] is not null then raise exception 'answer_locked'; end if;   -- a ticked answer is final
  cur.answers[p_q + 1] := p_choice;
  update public.course_quiz_attempts set answers = cur.answers where id = cur.id;
  if array_position(cur.answers, null) is null then   -- every question answered: grade it now
    select answers into k from public.course_quiz_keys where lesson_id = p_lesson;
    if k is null or coalesce(array_length(k, 1), 0) <> n then raise exception 'no_answer_key'; end if;
    for i in 1 .. n loop if cur.answers[i] = k[i] then s := s + 1; end if; end loop;
    update public.course_quiz_attempts set submitted_at = now(), score = s, total = n where id = cur.id;
    insert into public.course_progress (user_id, lesson_id, quiz_score, quiz_total, done_at) values (auth.uid(), p_lesson, s, n, now())
    on conflict (user_id, lesson_id) do update set quiz_score = greatest(coalesce(course_progress.quiz_score, 0), excluded.quiz_score), quiz_total = excluded.quiz_total, done_at = now();
  end if;
  return public.course_quiz_state(p_lesson);
end $$;

-- 7. Certificate codes from a cryptographic random source.
create or replace function public.course_issue_certificate(p_name text) returns json
language plpgsql security definer set search_path to 'public' as $$
declare st json; c public.course_certificates; nm text := regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g'); v_code text; k int := 0;
  al text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; b bytea;
begin
  if auth.uid() is null then raise exception 'login_required'; end if;
  select * into c from public.course_certificates where user_id = auth.uid();
  if c.code is not null then return json_build_object('code', c.code, 'name', c.name, 'issued_at', c.issued_at, 'already', true); end if;
  st := public.course_cert_status();
  if not (st->>'owned')::boolean then raise exception 'not_owned'; end if;
  if (st->>'done')::int < (st->>'lessons')::int then raise exception 'lessons_left'; end if;
  if (st->>'passed')::int < (st->>'quizzes')::int then raise exception 'quiz_left'; end if;
  if length(nm) < 2 or length(nm) > 60 or nm ~ '[<>{}\\]' then raise exception 'bad_name'; end if;
  loop   -- unambiguous letters and digits only (no 0/O, 1/I/L)
    b := extensions.gen_random_bytes(8);
    v_code := 'AROM-';
    for i in 0 .. 7 loop
      v_code := v_code || substr(al, 1 + get_byte(b, i) % 31, 1);
      if i = 3 then v_code := v_code || '-'; end if;
    end loop;
    exit when not exists (select 1 from public.course_certificates x where x.code = v_code) or k > 5;
    k := k + 1;
  end loop;
  insert into public.course_certificates (code, user_id, name) values (v_code, auth.uid(), nm) returning * into c;
  perform public.audit_write(auth.uid(), 'course_certificate', jsonb_build_object('code', c.code));
  return json_build_object('code', c.code, 'name', c.name, 'issued_at', c.issued_at, 'already', false);
end $$;

-- 8. Activation keys: one redeem at a time per user, so parallel guesses cannot slip past the 10-per-hour limit.
create or replace function public.redeem_key(p_code text) returns json
language plpgsql security definer set search_path to 'public' as $$
declare uid uuid := auth.uid(); c text; k public.activation_keys; col text; col_until timestamptz; nxt timestamptz; fails int;
begin
  if uid is null then return json_build_object('error', 'not_authenticated'); end if;
  perform pg_advisory_xact_lock(hashtext('redeem:' || uid));
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
end $$;

-- 9. MetaApi: at most one cloud terminal row per user, enforced by the database (broker-sync reserves the row before the billed call).
create unique index if not exists broker_accounts_one_metaapi on public.broker_accounts (user_id) where source = 'metaapi';

-- 10. Sign-up audit: keep the username short (the admin page also escapes it now).
create or replace function public.audit_auth_users() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  begin
    if tg_op = 'INSERT' then
      perform public.audit_write(new.id, 'signup', jsonb_build_object('email', new.email, 'username', left(new.raw_user_meta_data->>'username', 40)));
    else
      if old.email_confirmed_at is null and new.email_confirmed_at is not null then
        perform public.audit_write(new.id, 'email_verified', jsonb_build_object('email', new.email));
      end if;
      if new.last_sign_in_at is distinct from old.last_sign_in_at and new.last_sign_in_at is not null then
        perform public.audit_write(new.id, 'login', jsonb_build_object('email', new.email));
      end if;
      if new.encrypted_password is distinct from old.encrypted_password then
        perform public.audit_write(new.id, 'password_changed', '{}'::jsonb);
      end if;
      if new.email is distinct from old.email then
        perform public.audit_write(new.id, 'email_changed', jsonb_build_object('from', old.email, 'to', new.email));
      end if;
    end if;
  exception when others then null;
  end;
  return new;
end $$;
