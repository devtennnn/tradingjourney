-- IB partner notices: email (Resend) + Telegram when a partner sends the profile form and when the admin approves / asks for changes / hides it.
-- Needs the edge function "ib-notify" (verify_jwt = false) and the secret RESEND_API_KEY (optional MAIL_FROM). Safe to re-run.
create extension if not exists pg_net;

create or replace function public.notify_ib_profile() returns trigger language plpgsql security definer set search_path to 'public' as $$
declare k text; ev text;
begin
  if tg_op = 'INSERT' or (new.status = 'pending' and new.updated_at is distinct from old.updated_at) then
    ev := case when new.status = 'pending' then 'submitted' end;           -- every save by the partner goes back to review
  elsif new.status is distinct from old.status and new.status in ('approved', 'rejected', 'hidden') then
    ev := new.status;
  elsif new.status in ('rejected', 'hidden') and new.admin_note is distinct from old.admin_note then
    ev := new.status;                                                       -- same decision with a new note
  end if;
  if ev is null then return new; end if;
  select value into k from public.ai_bot_config where key = 'cron_secret';
  if k is null then return new; end if;
  perform net.http_post(
    url := 'https://sksvwikfyrdhgjngekqp.supabase.co/functions/v1/ib-notify?key=' || k,
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := jsonb_build_object('user_id', new.user_id, 'event', ev),
    timeout_milliseconds := 8000);
  return new;
exception when others then
  return new;   -- a notification problem must never block a save
end $$;
revoke all on function public.notify_ib_profile() from public, anon, authenticated;

drop trigger if exists ib_profiles_notify on public.ib_profiles;
create trigger ib_profiles_notify after insert or update on public.ib_profiles
  for each row execute function public.notify_ib_profile();
