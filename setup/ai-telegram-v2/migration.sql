-- AROM AI strategies (Scalping / Intraday / Swing) for the Telegram bot
alter table public.ai_signals add column if not exists mode text not null default 'scalp';
do $$ declare c record; begin
  for c in select conname from pg_constraint where conrelid = 'public.ai_signals'::regclass and contype = 'u' loop
    execute format('alter table public.ai_signals drop constraint %I', c.conname); end loop; end $$;
drop index if exists public.ai_signals_symbol_t_key;
create unique index if not exists ai_signals_symbol_mode_t on public.ai_signals (symbol, mode, t);
alter table public.ai_ready add column if not exists mode text not null default 'scalp';
alter table public.ai_ready drop constraint if exists ai_ready_pkey;
alter table public.ai_ready add primary key (symbol, mode, slot);
insert into public.ai_bot_config (key, value) values ('modes', 'scalp,intraday,swing') on conflict (key) do update set value = excluded.value;
