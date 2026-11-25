-- Live newswire (/news): Khmer translations of headlines, translated once by the newswire edge function and reused for every visitor.
create table if not exists public.news_tr (
  id          text primary key,          -- hash of the English headline
  en          text not null,
  km          text,
  created_at  timestamptz not null default now()
);
alter table public.news_tr enable row level security;
revoke all on public.news_tr from anon, authenticated;
