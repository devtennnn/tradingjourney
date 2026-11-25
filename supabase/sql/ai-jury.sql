-- AI jury: several language models review every new signal BEFORE its outcome is known (shadow only: nothing here changes what members receive).
-- Votes are stored per signal and model, then compared with the real result in ai_jury_report.
create table if not exists public.ai_signal_votes (
  id          bigserial primary key,
  signal_id   bigint not null references public.ai_signals(id) on delete cascade,
  model       text not null,
  verdict     text not null check (verdict in ('take', 'skip', 'error')),
  confidence  int,
  reason      text,
  risks       text,
  ms          int,
  tokens_in   int,
  tokens_out  int,
  created_at  timestamptz not null default now(),
  unique (signal_id, model)
);
create index if not exists ai_signal_votes_signal on public.ai_signal_votes (signal_id);
alter table public.ai_signal_votes enable row level security;   -- no policies: only the service role (edge functions) reads or writes
revoke all on public.ai_signal_votes from anon, authenticated;

-- Per model: how did signals it said "take" do compared with the ones it said "skip" (closed signals only, R before spread)
create or replace view public.ai_jury_report with (security_invoker = true) as
select v.model,
       count(*) filter (where v.verdict <> 'error')                                           as votes,
       count(*) filter (where v.verdict = 'error')                                            as errors,
       count(*) filter (where v.verdict = 'take' and s.status = 'closed')                     as take_closed,
       round(avg(s.r_result) filter (where v.verdict = 'take' and s.status = 'closed')::numeric, 2) as take_avg_r,
       count(*) filter (where v.verdict = 'skip' and s.status = 'closed')                     as skip_closed,
       round(avg(s.r_result) filter (where v.verdict = 'skip' and s.status = 'closed')::numeric, 2) as skip_avg_r,
       round(avg(v.ms) filter (where v.verdict <> 'error'))                                   as avg_ms
from public.ai_signal_votes v join public.ai_signals s on s.id = v.signal_id
group by v.model;
revoke all on public.ai_jury_report from anon, authenticated;

-- Consensus: signals where at least N models said "take"
create or replace function public.ai_jury_consensus(p_min int default 3)
returns table (takes bigint, n bigint, avg_r numeric, wins bigint)
language sql security definer set search_path = public as $$
  with t as (select v.signal_id, count(*) filter (where v.verdict = 'take') as takes from ai_signal_votes v group by v.signal_id)
  select t.takes, count(*), round(avg(s.r_result)::numeric, 2), count(*) filter (where s.r_result > 0)
  from t join ai_signals s on s.id = t.signal_id where s.status = 'closed' group by t.takes order by t.takes;
$$;
revoke all on function public.ai_jury_consensus(int) from public, anon, authenticated;
