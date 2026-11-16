-- Telegram signal markets: each member chooses which markets send them private signals (Alerts -> settings -> Telegram signals).
-- Run once in Supabase -> SQL Editor. Safe to re-run.
-- null = every market (the default for everyone already connected); an array = only those markets; an empty array = no signals (payment messages still arrive).
alter table public.telegram_links add column if not exists pairs text[];
