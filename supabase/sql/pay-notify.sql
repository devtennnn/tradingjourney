-- Telegram message to YOU whenever a payment becomes "paid" (any path: Anajak webhook, own KHQR check, admin approval).
-- Run once in Supabase -> SQL Editor. Safe to re-run. Needs the edge function "pay-notify" (deployed) and the TELEGRAM_BOT_TOKEN secret (already used by the signals bot).
create extension if not exists pg_net;

-- 1) WHERE the message goes: a PRIVATE chat only (never the public signals channel).
--    Open Telegram, send any message to your bot, then open https://api.telegram.org/bot<TOKEN>/getUpdates in a browser (or message @userinfobot) to read your numeric id,
--    then replace 123456789 below with it. For a private admin group the id starts with -100.
insert into public.ai_bot_config (key, value) values ('pay_chat_id', '123456789')
on conflict (key) do update set value = excluded.value;

-- 2) The trigger: fires once when a payment turns paid.
create or replace function public.notify_payment_paid() returns trigger language plpgsql security definer set search_path to 'public' as $$
declare k text;
begin
  select value into k from public.ai_bot_config where key = 'cron_secret';
  if k is null then return new; end if;
  perform net.http_post(
    url := 'https://sksvwikfyrdhgjngekqp.supabase.co/functions/v1/pay-notify?key=' || k,
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := jsonb_build_object('id', new.id),
    timeout_milliseconds := 8000);
  return new;
exception when others then
  return new;   -- a notification problem must never block a payment
end $$;
revoke all on function public.notify_payment_paid() from public, anon, authenticated;

drop trigger if exists payments_notify_paid on public.payments;
create trigger payments_notify_paid after update of status on public.payments
  for each row when (new.status = 'paid' and old.status is distinct from 'paid') execute function public.notify_payment_paid();
