-- FREE plan: 1 signal a day.
-- Free (and Premium) members get the FIRST A+ signal the bot posts each day (Phnom Penh day, UTC+7), on the site and by Telegram DM.
-- Elite and Ultra still get every signal. This function is the server-side source for the site card, so the limit cannot be bypassed in the browser.
-- Run once in the Supabase SQL Editor. Safe to run again.
create or replace function public.free_daily_signal()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select to_jsonb(x) from (
    select symbol, mode, side, entry, sl, tp1, tp2, tp3, t, hits, status, result
    from public.ai_signals
    where tg_message_id is not null
      and t >= extract(epoch from (date_trunc('day', now() at time zone 'Asia/Phnom_Penh') at time zone 'Asia/Phnom_Penh'))::bigint
    order by t asc
    limit 1
  ) x
$$;
revoke all on function public.free_daily_signal() from public, anon;
grant execute on function public.free_daily_signal() to authenticated;
