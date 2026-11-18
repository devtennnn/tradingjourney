-- Applied as migration signals_posted_only (18 Nov 2026).
-- 1) Referral bonus feed (my_signal_feed) and unlock (use_signal_unlock): only signals that were really posted to the channel
--    (tg_message_id is not null). Before this, shadow research signals (btcx, *_brt, *_msnr, *_pat …) also appeared in the feed.
-- 2) Public track record (signal_track_record): leaves out signals a public mode logged in shadow for one symbol (feat.shadow = true).
-- 3) ai_bot_config shadow_pairs = 'XAUUSD:intraday': gold intraday keeps running and is logged, but is not posted, until removed from the list.
do $$
declare d text; n text;
begin
  d := pg_get_functiondef('public.my_signal_feed'::regproc);
  n := replace(d, $a$where to_timestamp(s.t) > now() - interval '48 hours' order by$a$, $a$where to_timestamp(s.t) > now() - interval '48 hours' and s.tg_message_id is not null order by$a$);
  if n = d then raise exception 'my_signal_feed: pattern not found'; end if; execute n;
  d := pg_get_functiondef('public.use_signal_unlock'::regproc);
  n := replace(d, $a$from public.ai_signals where id::text = p_key)$a$, $a$from public.ai_signals where id::text = p_key and tg_message_id is not null)$a$);
  if n = d then raise exception 'use_signal_unlock: pattern not found'; end if; execute n;
  d := pg_get_functiondef('public.signal_track_record'::regproc);
  n := replace(d, $a$where mode in ('scalp', 'intraday', 'swing') and status = 'closed'$a$, $a$where mode in ('scalp', 'intraday', 'swing') and status = 'closed' and coalesce((feat->>'shadow')::boolean, false) = false$a$);
  n := replace(n, $a$where mode in ('scalp', 'intraday', 'swing') and status = 'open')$a$, $a$where mode in ('scalp', 'intraday', 'swing') and status = 'open' and coalesce((feat->>'shadow')::boolean, false) = false)$a$);
  if n = d then raise exception 'signal_track_record: pattern not found'; end if; execute n;
end $$;
insert into ai_bot_config(key, value) values ('shadow_pairs', 'XAUUSD:intraday') on conflict (key) do update set value = excluded.value;
-- To publish gold intraday again:  update ai_bot_config set value = '' where key = 'shadow_pairs';
