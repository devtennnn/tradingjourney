-- Broker sync for phone-only members (MetaApi), applied as migration broker_sync_metaapi.
-- A MetaApi account is a cloud MetaTrader terminal logged in with the member's INVESTOR (read-only) password.
-- The password goes straight to MetaApi and is never stored here; we only keep MetaApi's account id.
alter table public.broker_accounts add column if not exists source text not null default 'ea';
alter table public.broker_accounts drop constraint if exists broker_accounts_source_check;
alter table public.broker_accounts add constraint broker_accounts_source_check check (source in ('ea', 'metaapi'));
alter table public.broker_accounts add column if not exists ma_id text unique;
alter table public.broker_accounts add column if not exists ma_region text;
alter table public.broker_accounts add column if not exists ma_state text;
alter table public.broker_accounts add column if not exists ma_error text;
create index if not exists broker_accounts_metaapi on public.broker_accounts(source) where source = 'metaapi';
-- every 2 minutes: read each MetaApi account (returns at once when there are none)
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('broker-metaapi-poll') where exists (select 1 from cron.job where jobname = 'broker-metaapi-poll');
    perform cron.schedule('broker-metaapi-poll', '*/2 * * * *', $c$ select net.http_get(url := 'https://sksvwikfyrdhgjngekqp.supabase.co/functions/v1/broker-sync?run=poll&key=' || (select value from public.ai_bot_config where key = 'cron_secret'), timeout_milliseconds := 120000) $c$);
  end if;
end $$;
