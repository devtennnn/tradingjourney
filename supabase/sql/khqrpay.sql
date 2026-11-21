-- KHQRPay (https://khqrpay.dev): replaces the Bakong / Anajak checkout.
-- Run AFTER security-fixes.sql (it uses extend_plan() and the 'rejected' payment status). Safe to re-run.
--
-- The khqr Edge Function creates a payments row (reference_id = bill_number) and a KHQRPay payment for it.
-- The khqrpay-webhook Edge Function verifies the signature, then calls khqrpay_handle_event() below.
-- Everything for one event happens in ONE transaction: remember the event id, update the payment, extend the plan.
-- If any step fails, the whole thing rolls back (event id included), so KHQRPay's retry can try again.

alter table public.payments add column if not exists provider text;
alter table public.payments add column if not exists kp_payment_id text;
alter table public.payments add column if not exists kp_livemode boolean;
alter table public.payments add column if not exists monitoring_gap boolean not null default false;
alter table public.payments add column if not exists scanned_at timestamptz;
create unique index if not exists payments_kp_payment_id on public.payments (kp_payment_id) where kp_payment_id is not null;

-- One row per webhook event id: every retry and every endpoint repeats the id, so this is the de-duplication key.
create table if not exists public.khqrpay_events (
  id text primary key,
  type text not null,
  payment_id text,
  result text,
  received_at timestamptz not null default now()
);
alter table public.khqrpay_events enable row level security;   -- no policies: server only
revoke all on public.khqrpay_events from anon, authenticated;

create or replace function public.khqrpay_handle_event(p_event_id text, p_type text, p_payment jsonb, p_days int default 30)
returns json language plpgsql security definer set search_path to 'public' as $$
declare
  r public.payments;
  ref text := p_payment->>'reference_id';
  kp text := p_payment->>'id';
  gap boolean := coalesce((p_payment->>'monitoring_gap')::boolean, false);
  res text;
begin
  if coalesce(p_event_id, '') = '' or coalesce(p_type, '') = '' then raise exception 'bad_event'; end if;

  insert into khqrpay_events (id, type, payment_id) values (p_event_id, p_type, kp) on conflict (id) do nothing;
  if not found then return json_build_object('result', 'duplicate'); end if;

  -- payment links send reference_id link:<id>; anything that is not one of our KHQRPay orders is acknowledged and ignored
  select * into r from payments where bill_number = ref and provider = 'khqrpay' for update;
  if r.id is null then res := 'ignored_unknown_reference';
  elsif r.kp_payment_id is not null and r.kp_payment_id <> kp then res := 'ignored_payment_mismatch';
  else
    if r.kp_payment_id is null then update payments set kp_payment_id = kp where id = r.id; end if;
    if gap then update payments set monitoring_gap = true where id = r.id; end if;

    if p_type = 'payment.completed' then
      -- the order was priced in USD: check what we asked for (requested_*), not only what the payer paid in the link's currency
      if upper(coalesce(p_payment->>'requested_currency', p_payment->>'currency')) <> upper(r.currency)
         or round(coalesce((p_payment->>'requested_amount')::numeric, (p_payment->>'amount')::numeric), 2) <> round(r.amount, 2) then
        res := 'amount_mismatch';
      else
        -- paid from any earlier state (a late payment after "expired" included); never twice
        update payments set status = 'paid', paid_at = coalesce(paid_at, now()), bakong_hash = kp
          where id = r.id and status <> 'paid';
        if found then
          if r.plan in ('premium', 'elite', 'ultra') then perform public.extend_plan(r.user_id, r.plan, p_days); end if;
          -- course: the payments_course_paid trigger gives lifetime access when the row turns paid
          res := case when coalesce((p_payment->>'late')::boolean, false) then 'paid_late' else 'paid' end;
        else res := 'already_paid';
        end if;
      end if;
    elsif p_type = 'payment.expired' or p_type = 'payment.failed' then
      -- never undo a paid order (events can arrive out of order); a claimed row waits for the admin
      update payments set status = 'expired' where id = r.id and status = 'pending';
      res := case when found then 'expired' else 'unchanged' end;
    elsif p_type = 'payment.scanned' then
      update payments set scanned_at = coalesce(scanned_at, now()) where id = r.id;
      res := 'scanned';
    else res := 'ignored_type';
    end if;
  end if;

  update khqrpay_events set result = res where id = p_event_id;
  return json_build_object('result', res);
end $$;
revoke all on function public.khqrpay_handle_event(text, text, jsonb, int) from public, anon, authenticated;
grant execute on function public.khqrpay_handle_event(text, text, jsonb, int) to service_role;
