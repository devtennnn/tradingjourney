-- AROM AI (OpenAI) storage. Run once in the Supabase SQL Editor. Safe to run again.
--   ai_usage_log     : one row per AI request (tokens, model) for the daily limit and cost tracking. Edge function only.
--   ai_conversations : a member's chat threads. The member can read their OWN threads; only the function writes.
--   ai_messages      : messages of those threads (with the data each answer used). Same rule: a member reads only their own.
--   ai_reports       : generated analyst reports with the data snapshot they were based on (shared cache, so the same analysis is not paid for twice). Edge function only.
create table if not exists public.ai_usage_log (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  kind          text not null,
  model         text,
  input_tokens  integer,
  output_tokens integer,
  ok            boolean not null default true,
  created_at    timestamptz not null default now()
);
create index if not exists ai_usage_log_user_time on public.ai_usage_log (user_id, created_at desc);

create table if not exists public.ai_conversations (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  title       text,
  symbol      text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists ai_conversations_user on public.ai_conversations (user_id, updated_at desc);

create table if not exists public.ai_messages (
  id               bigint generated always as identity primary key,
  conversation_id  uuid not null references public.ai_conversations(id) on delete cascade,
  user_id          uuid not null references auth.users(id) on delete cascade,
  role             text not null check (role in ('user', 'assistant')),
  content          text not null,
  data_refs        jsonb,
  created_at       timestamptz not null default now()
);
create index if not exists ai_messages_conv on public.ai_messages (conversation_id, id);

create table if not exists public.ai_reports (
  id             bigint generated always as identity primary key,
  kind           text not null,
  symbol         text not null,
  timeframe      text not null,
  lang           text not null,
  variant        text not null default 'default',
  payload        jsonb not null,
  data_snapshot  jsonb,
  model          text,
  last_candle_at text,
  generated_at   timestamptz not null default now()
);
create index if not exists ai_reports_lookup on public.ai_reports (kind, symbol, timeframe, lang, variant, generated_at desc);

alter table public.ai_usage_log enable row level security;
alter table public.ai_conversations enable row level security;
alter table public.ai_messages enable row level security;
alter table public.ai_reports enable row level security;
revoke all on public.ai_usage_log, public.ai_reports from anon, authenticated;
revoke all on public.ai_conversations, public.ai_messages from anon, authenticated;
grant select on public.ai_conversations, public.ai_messages to authenticated;

drop policy if exists "own conversations" on public.ai_conversations;
create policy "own conversations" on public.ai_conversations for select to authenticated using (user_id = auth.uid());
drop policy if exists "own messages" on public.ai_messages;
create policy "own messages" on public.ai_messages for select to authenticated using (user_id = auth.uid());

-- retention (nightly 03:30 UTC when pg_cron is enabled): reports 30 days, usage log 90 days, conversations 180 days
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'arom_ai_retention';
    perform cron.schedule('arom_ai_retention', '30 3 * * *', $c$
      delete from public.ai_reports where generated_at < now() - interval '30 days';
      delete from public.ai_usage_log where created_at < now() - interval '90 days';
      delete from public.ai_conversations where updated_at < now() - interval '180 days';
    $c$);
  end if;
end $$;
