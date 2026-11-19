-- AROM Academy quiz rules. Run after course.sql, course-certificate.sql and course-admin.sql.
--   1. An answer is saved the moment it is ticked and can never be changed (course_quiz_answer refuses a second answer).
--   2. The quiz is graded when the last question is answered. Pass = 75% (3 of 4).
--   3. A failed quiz can be taken again only 7 days after it was submitted.
--   4. The correct answers never reach the browser: they live in course_quiz_keys, which only admins can read.

-- answer keys, readable and writable by admins only
create table if not exists public.course_quiz_keys (
  lesson_id text primary key references public.course_lessons(id) on delete cascade on update cascade,
  answers int[] not null
);
alter table public.course_quiz_keys enable row level security;
drop policy if exists "quiz keys admin" on public.course_quiz_keys;
create policy "quiz keys admin" on public.course_quiz_keys for all using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));
grant select, insert, update, delete on public.course_quiz_keys to authenticated;

-- move the existing answers out of the lesson rows
insert into public.course_quiz_keys (lesson_id, answers)
  select id, array(select (q.v->>'a')::int from jsonb_array_elements(quiz) with ordinality as q(v, o) order by q.o)
  from public.course_lessons where quiz is not null and quiz -> 0 ? 'a'
on conflict (lesson_id) do update set answers = excluded.answers;
update public.course_lessons
  set quiz = (select jsonb_agg(q.v - 'a' order by q.o) from jsonb_array_elements(quiz) with ordinality as q(v, o))
  where quiz is not null and quiz -> 0 ? 'a';

-- one row per quiz attempt; written only by course_quiz_answer
create table if not exists public.course_quiz_attempts (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  lesson_id text not null references public.course_lessons(id) on delete cascade on update cascade,
  answers int[] not null,
  started_at timestamptz not null default now(),
  submitted_at timestamptz,
  score int, total int
);
create index if not exists course_quiz_attempts_user on public.course_quiz_attempts (user_id, lesson_id, id desc);
alter table public.course_quiz_attempts enable row level security;
drop policy if exists "own attempts" on public.course_quiz_attempts;
create policy "own attempts" on public.course_quiz_attempts for select using (auth.uid() = user_id);
grant select on public.course_quiz_attempts to authenticated;

-- the old one-shot grading call is replaced (it allowed changing answers and retrying at once)
drop function if exists public.course_submit_quiz(text, int[]);

create or replace function public.course_quiz_state(p_lesson text) returns json
language plpgsql stable security definer set search_path = public as $$
declare n int; cur public.course_quiz_attempts; last public.course_quiz_attempts; best int; passed boolean; retry timestamptz;
begin
  if auth.uid() is null then return json_build_object('login', true); end if;
  select jsonb_array_length(quiz) into n from public.course_lessons where id = p_lesson and quiz is not null;
  if n is null then return json_build_object('quiz', false); end if;
  select * into cur from public.course_quiz_attempts where user_id = auth.uid() and lesson_id = p_lesson and submitted_at is null order by id desc limit 1;
  if cur.id is not null and coalesce(array_length(cur.answers, 1), 0) <> n then cur := null; end if;   -- the quiz was edited: that attempt no longer fits
  select * into last from public.course_quiz_attempts where user_id = auth.uid() and lesson_id = p_lesson and submitted_at is not null order by id desc limit 1;
  select max(score) into best from public.course_quiz_attempts where user_id = auth.uid() and lesson_id = p_lesson and submitted_at is not null;
  passed := coalesce(best, 0) * 4 >= n * 3 and best is not null;
  retry := case when not passed and last.id is not null and last.submitted_at + interval '7 days' > now() then last.submitted_at + interval '7 days' end;
  return json_build_object('quiz', true, 'total', n, 'answers', case when cur.id is not null then to_json(cur.answers) end,
    'last', case when last.id is not null then json_build_object('score', last.score, 'total', last.total, 'at', last.submitted_at) end,
    'best', best, 'passed', passed, 'retry_at', retry,
    'attempts', (select count(*) from public.course_quiz_attempts where user_id = auth.uid() and lesson_id = p_lesson and submitted_at is not null));
end $$;
grant execute on function public.course_quiz_state(text) to authenticated;

create or replace function public.course_quiz_answer(p_lesson text, p_q int, p_choice int) returns json
language plpgsql security definer set search_path = public as $$
declare l public.course_lessons; k int[]; n int; st json; cur public.course_quiz_attempts; s int := 0; i int;
begin
  if auth.uid() is null then raise exception 'login_required'; end if;
  select * into l from public.course_lessons where id = p_lesson and published;
  if l.id is null or l.quiz is null then raise exception 'no_quiz'; end if;
  if not (l.free or public.has_course()) then raise exception 'locked'; end if;
  n := jsonb_array_length(l.quiz);
  if p_q is null or p_q < 0 or p_q >= n then raise exception 'bad_question'; end if;
  if p_choice is null or p_choice < 0 or p_choice >= jsonb_array_length(l.quiz -> p_q -> 'opts_en') then raise exception 'bad_choice'; end if;
  st := public.course_quiz_state(p_lesson);
  if (st->>'passed')::boolean then raise exception 'already_passed'; end if;
  if st->>'retry_at' is not null then raise exception 'wait_until %', st->>'retry_at'; end if;
  perform pg_advisory_xact_lock(hashtext('quiz:' || auth.uid() || ':' || p_lesson));
  select * into cur from public.course_quiz_attempts where user_id = auth.uid() and lesson_id = p_lesson and submitted_at is null order by id desc limit 1 for update;
  if cur.id is not null and coalesce(array_length(cur.answers, 1), 0) <> n then
    delete from public.course_quiz_attempts where id = cur.id; cur := null;
  end if;
  if cur.id is null then
    insert into public.course_quiz_attempts (user_id, lesson_id, answers) values (auth.uid(), p_lesson, array_fill(null::int, array[n])) returning * into cur;
  end if;
  if cur.answers[p_q + 1] is not null then raise exception 'answer_locked'; end if;   -- a ticked answer is final
  cur.answers[p_q + 1] := p_choice;
  update public.course_quiz_attempts set answers = cur.answers where id = cur.id;
  if array_position(cur.answers, null) is null then   -- every question answered: grade it now
    select answers into k from public.course_quiz_keys where lesson_id = p_lesson;
    if k is null or coalesce(array_length(k, 1), 0) <> n then raise exception 'no_answer_key'; end if;
    for i in 1 .. n loop if cur.answers[i] = k[i] then s := s + 1; end if; end loop;
    update public.course_quiz_attempts set submitted_at = now(), score = s, total = n where id = cur.id;
    insert into public.course_progress (user_id, lesson_id, quiz_score, quiz_total, done_at) values (auth.uid(), p_lesson, s, n, now())
    on conflict (user_id, lesson_id) do update set quiz_score = greatest(coalesce(course_progress.quiz_score, 0), excluded.quiz_score), quiz_total = excluded.quiz_total, done_at = now();
  end if;
  return public.course_quiz_state(p_lesson);
end $$;
grant execute on function public.course_quiz_answer(text, int, int) to authenticated;
