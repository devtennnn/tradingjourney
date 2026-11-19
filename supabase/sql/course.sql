-- AROM Academy: a course sold on its own (KHQR, lifetime access), text lessons + chapter quizzes.
-- Access: profiles.course_until > now() (a paid course sets it to 2999-12-31) or admin. Free preview lessons are readable by anyone.
-- Paid lesson text never ships in the page HTML: it is read from course_lessons, and row-level security only returns it to buyers.

alter table public.profiles add column if not exists course_until timestamptz;

-- payments may now be for the course
alter table public.payments drop constraint if exists payments_plan_check;
alter table public.payments add constraint payments_plan_check check (plan = any (array['premium','elite','ultra','course']));

-- admin approval (admin_approve_payment) looks the column up here
create or replace function public.plan_col(p text) returns text language sql immutable as $$
  select case p when 'ultra' then 'ultra_until' when 'elite' then 'elite_until' when 'course' then 'course_until' else 'premium_until' end;
$$;

-- a paid course payment = lifetime access, whichever path confirmed it (gateway webhook, Bakong check or admin approval)
create or replace function public.course_on_paid() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.plan = 'course' and new.status = 'paid' then
    update public.profiles set course_until = timestamptz '2999-12-31 00:00:00+00' where id = new.user_id;
    perform public.audit_write(new.user_id, 'course_access', jsonb_build_object('bill', new.bill_number, 'amount', new.amount));
  end if;
  return new;
end $$;
drop trigger if exists payments_course_paid on public.payments;
create trigger payments_course_paid after insert or update of status on public.payments
  for each row when (new.plan = 'course' and new.status = 'paid') execute function public.course_on_paid();

create or replace function public.has_course(u uuid default auth.uid()) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = u and (is_admin or coalesce(course_until, 'epoch') > now()));
$$;

create table if not exists public.course_lessons (
  id text primary key,                      -- slug, e.g. 'risk-1'
  chapter int not null,
  ord int not null,
  chapter_en text not null, chapter_km text not null,
  title_en text not null, title_km text not null,
  mins int not null default 5,
  free boolean not null default false,      -- free preview lesson
  body_en text not null default '', body_km text not null default '',   -- light markdown: ## heading, - list, **bold**, > tip, blank line = paragraph
  quiz jsonb,                               -- [{q_en,q_km,opts_en[],opts_km[],a}] (chapter quiz on the last lesson of a chapter)
  published boolean not null default true,
  updated_at timestamptz not null default now()
);
alter table public.course_lessons enable row level security;
drop policy if exists "course outline" on public.course_lessons;
drop policy if exists "course read" on public.course_lessons;
-- the table returns a lesson (with its text and quiz) only when it is a free preview or the reader bought the course;
-- titles of every lesson come from course_outline() below
create policy "course read" on public.course_lessons for select using (published and (free or public.has_course()));
grant select on public.course_lessons to anon, authenticated;

-- the outline (titles only) for everyone, including lessons they have not bought
create or replace function public.course_outline() returns table (id text, chapter int, ord int, chapter_en text, chapter_km text, title_en text, title_km text, mins int, free boolean, has_quiz boolean)
language sql stable security definer set search_path = public as $$
  select id, chapter, ord, chapter_en, chapter_km, title_en, title_km, mins, free, quiz is not null from public.course_lessons where published order by chapter, ord;
$$;
grant execute on function public.course_outline() to anon, authenticated;
grant execute on function public.has_course(uuid) to anon, authenticated;

create table if not exists public.course_progress (
  user_id uuid not null references auth.users(id) on delete cascade,
  lesson_id text not null references public.course_lessons(id) on delete cascade,
  done_at timestamptz not null default now(),
  quiz_score int, quiz_total int,
  primary key (user_id, lesson_id)
);
alter table public.course_progress enable row level security;
drop policy if exists "own progress read" on public.course_progress;
drop policy if exists "own progress write" on public.course_progress;
drop policy if exists "own progress update" on public.course_progress;
create policy "own progress read" on public.course_progress for select using (auth.uid() = user_id);
create policy "own progress write" on public.course_progress for insert with check (auth.uid() = user_id);
create policy "own progress update" on public.course_progress for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
grant select, insert, update on public.course_progress to authenticated;
