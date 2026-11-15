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
