-- Private copies of AI signals to Elite / Ultra members who connected Telegram (Profile -> Telegram).
-- Run once in Supabase -> SQL Editor. Safe to re-run. Needs the edge function "signal-dm" (deployed) and supabase/sql/telegram-link.sql (already run).
-- How it works: the bot (ai-telegram) is NOT changed. When it saves a posted signal (tg_message_id) or a follow-up (hits / status) on public.ai_signals,
-- this trigger calls signal-dm, which sends each eligible member the signal as a TEXT message (new signal) or the TP / SL text (follow-up). No picture cards.
-- Switch off any time:  insert into public.ai_bot_config (key, value) values ('dm_signals', 'off') on conflict (key) do update set value = 'off';
create extension if not exists pg_net;

create or replace function public.notify_signal_dm() returns trigger language plpgsql security definer set search_path to 'public' as $$
declare k text; kind text;
begin
  select value into k from public.ai_bot_config where key = 'cron_secret';
  if k is null then return new; end if;
  if old.tg_message_id is null and new.tg_message_id is not null then kind := 'new';
  elsif new.tg_message_id is not null and (new.hits is distinct from old.hits or new.status is distinct from old.status) then kind := 'update';
  else return new; end if;
  perform net.http_post(
    url := 'https://sksvwikfyrdhgjngekqp.supabase.co/functions/v1/signal-dm?key=' || k,
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := jsonb_build_object('id', new.id, 'kind', kind, 'old_hits', coalesce(old.hits, 0), 'old_status', old.status),
    timeout_milliseconds := 8000);
  return new;
exception when others then
  return new;   -- a notification problem must never block the bot
end $$;
revoke all on function public.notify_signal_dm() from public, anon, authenticated;

drop trigger if exists ai_signals_dm on public.ai_signals;
create trigger ai_signals_dm after update of tg_message_id, hits, status on public.ai_signals
  for each row execute function public.notify_signal_dm();
