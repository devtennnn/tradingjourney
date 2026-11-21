-- Test for khqrpay_handle_event(). Needs security-fixes.sql and khqrpay.sql applied.
-- Runs inside a transaction that is ALWAYS rolled back (the final RAISE aborts it), with a dummy user. Nothing is kept.
-- Success shows: ERROR: KHQRPAY_TEST_OK ...   Any other error is a failure.
begin;
do $t$
declare uid uuid := gen_random_uuid(); r json; p public.payments; until1 timestamptz; until2 timestamptz;
  pay jsonb := jsonb_build_object('id','pay_T1','reference_id','DTTEST0001','amount','14.99','currency','USD','requested_amount','14.99','requested_currency','USD');
begin
  insert into auth.users (id, email, raw_user_meta_data) values (uid, 'khqrpay-test-' || uid || '@example.invalid', '{}'::jsonb);
  insert into public.payments (user_id, bill_number, md5, payload, plan, amount, currency, status, expires_at, provider)
    values (uid, 'DTTEST0001', 'kp:DTTEST0001', 'x', 'elite', 14.99, 'USD', 'pending', now() + interval '3 minutes', 'khqrpay');

  r := public.khqrpay_handle_event('evt_1', 'payment.scanned', pay);
  if r->>'result' <> 'scanned' then raise exception 'scanned: %', r; end if;

  -- expired first, then a late completed: honoured
  r := public.khqrpay_handle_event('evt_2', 'payment.expired', pay);
  select * into p from public.payments where bill_number = 'DTTEST0001';
  if r->>'result' <> 'expired' or p.status <> 'expired' then raise exception 'expired: % %', r, p.status; end if;

  r := public.khqrpay_handle_event('evt_3', 'payment.completed', pay || '{"late":true}');
  select * into p from public.payments where bill_number = 'DTTEST0001';
  select elite_until into until1 from public.profiles where id = uid;
  if r->>'result' <> 'paid_late' or p.status <> 'paid' or until1 is null or until1 < now() + interval '29 days' then raise exception 'late paid: % % %', r, p.status, until1; end if;

  -- duplicate of the same event id: no second extension
  r := public.khqrpay_handle_event('evt_3', 'payment.completed', pay || '{"late":true}');
  select elite_until into until2 from public.profiles where id = uid;
  if r->>'result' <> 'duplicate' or until2 <> until1 then raise exception 'duplicate: % % %', r, until1, until2; end if;

  -- a different completed event for the same payment (other endpoint / resend with new id): still no second extension
  r := public.khqrpay_handle_event('evt_4', 'payment.completed', pay);
  select elite_until into until2 from public.profiles where id = uid;
  if r->>'result' <> 'already_paid' or until2 <> until1 then raise exception 'already paid: % %', r, until2; end if;

  -- expired arriving after completed: stays paid
  r := public.khqrpay_handle_event('evt_5', 'payment.expired', pay);
  select * into p from public.payments where bill_number = 'DTTEST0001';
  if r->>'result' <> 'unchanged' or p.status <> 'paid' then raise exception 'expired after paid: % %', r, p.status; end if;

  -- wrong requested amount, other payment id, unknown reference
  insert into public.payments (user_id, bill_number, md5, payload, plan, amount, currency, status, expires_at, provider)
    values (uid, 'DTTEST0002', 'kp:DTTEST0002', 'x', 'premium', 2.50, 'USD', 'pending', now() + interval '3 minutes', 'khqrpay');
  r := public.khqrpay_handle_event('evt_6', 'payment.completed', jsonb_build_object('id','pay_T2','reference_id','DTTEST0002','amount','0.01','currency','USD','requested_amount','0.01','requested_currency','USD'));
  select * into p from public.payments where bill_number = 'DTTEST0002';
  if r->>'result' <> 'amount_mismatch' or p.status <> 'pending' then raise exception 'mismatch: % %', r, p.status; end if;
  r := public.khqrpay_handle_event('evt_7', 'payment.completed', jsonb_build_object('id','pay_OTHER','reference_id','DTTEST0002','amount','2.50','currency','USD','requested_amount','2.50','requested_currency','USD'));
  if r->>'result' <> 'ignored_payment_mismatch' then raise exception 'payment id mismatch: %', r; end if;
  r := public.khqrpay_handle_event('evt_8', 'payment.completed', jsonb_build_object('id','pay_X','reference_id','link:abc'));
  if r->>'result' <> 'ignored_unknown_reference' then raise exception 'unknown ref: %', r; end if;

  -- monitoring gap is remembered
  r := public.khqrpay_handle_event('evt_9', 'payment.scanned', jsonb_build_object('id','pay_T2','reference_id','DTTEST0002','monitoring_gap',true));
  select * into p from public.payments where bill_number = 'DTTEST0002';
  if not p.monitoring_gap then raise exception 'gap not stored'; end if;

  raise exception 'KHQRPAY_TEST_OK elite_until=%', until1;
end $t$;
rollback;
