-- AROM Academy certificates. Run after course.sql.
-- Quizzes are graded HERE (course_submit_quiz), so a passing score cannot be written from the browser.
-- A certificate needs: the paid course (has_course), every published lesson done, every chapter quiz at 75% or better.
-- Anyone can check a certificate code with course_verify(code): it returns only the name, the date and the course.

-- the browser may only mark a lesson done; quiz scores come from course_submit_quiz
drop policy if exists "own progress write" on public.course_progress;
drop policy if exists "own progress update" on public.course_progress;
create policy "own progress write" on public.course_progress for insert
  with check (auth.uid() = user_id and quiz_score is null and quiz_total is null);
create policy "own progress update" on public.course_progress for update
  using (auth.uid() = user_id and quiz_total is null) with check (auth.uid() = user_id and quiz_score is null and quiz_total is null);

create or replace function public.course_submit_quiz(p_lesson text, p_answers int[]) returns json
language plpgsql security definer set search_path = public as $$
declare l public.course_lessons; n int; s int := 0; i int; best int;
begin
  if auth.uid() is null then raise exception 'login_required'; end if;
  select * into l from public.course_lessons where id = p_lesson and published;
  if l.id is null or l.quiz is null then raise exception 'no_quiz'; end if;
  if not (l.free or public.has_course()) then raise exception 'locked'; end if;
  n := jsonb_array_length(l.quiz);
  if coalesce(array_length(p_answers, 1), 0) <> n then raise exception 'answer_all'; end if;
  for i in 0 .. n - 1 loop
    if p_answers[i + 1] = (l.quiz -> i ->> 'a')::int then s := s + 1; end if;
  end loop;
  insert into public.course_progress (user_id, lesson_id, quiz_score, quiz_total, done_at)
    values (auth.uid(), p_lesson, s, n, now())
  on conflict (user_id, lesson_id) do update set quiz_score = greatest(coalesce(course_progress.quiz_score, 0), excluded.quiz_score), quiz_total = excluded.quiz_total, done_at = now()
  returning quiz_score into best;
  return json_build_object('score', s, 'total', n, 'best', best, 'pass', best * 4 >= n * 3);
end $$;
grant execute on function public.course_submit_quiz(text, int[]) to authenticated;

create table if not exists public.course_certificates (
  code text primary key,                 -- AROM-XXXX-XXXX, printed on the certificate
  user_id uuid not null unique references auth.users(id) on delete cascade,
  name text not null,
  issued_at timestamptz not null default now()
);
alter table public.course_certificates enable row level security;
drop policy if exists "own certificate" on public.course_certificates;
create policy "own certificate" on public.course_certificates for select using (auth.uid() = user_id);
grant select on public.course_certificates to authenticated;

-- what is still missing for the certificate (shown on the page)
create or replace function public.course_cert_status() returns json
language sql stable security definer set search_path = public as $$
  with l as (select id, quiz is not null as q, jsonb_array_length(coalesce(quiz, '[]')) as n from public.course_lessons where published),
       p as (select * from public.course_progress where user_id = auth.uid())
  select json_build_object(
    'owned', public.has_course(),
    'lessons', (select count(*) from l), 'done', (select count(*) from l join p on p.lesson_id = l.id),
    'quizzes', (select count(*) from l where q), 'passed', (select count(*) from l join p on p.lesson_id = l.id where l.q and p.quiz_score * 4 >= l.n * 3),
    'cert', (select json_build_object('code', code, 'name', name, 'issued_at', issued_at) from public.course_certificates where user_id = auth.uid()));
$$;
grant execute on function public.course_cert_status() to authenticated;

create or replace function public.course_issue_certificate(p_name text) returns json
language plpgsql security definer set search_path = public as $$
declare st json; c public.course_certificates; nm text := regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g'); v_code text; k int := 0;
begin
  if auth.uid() is null then raise exception 'login_required'; end if;
  select * into c from public.course_certificates where user_id = auth.uid();
  if c.code is not null then return json_build_object('code', c.code, 'name', c.name, 'issued_at', c.issued_at, 'already', true); end if;
  st := public.course_cert_status();
  if not (st->>'owned')::boolean then raise exception 'not_owned'; end if;
  if (st->>'done')::int < (st->>'lessons')::int then raise exception 'lessons_left'; end if;
  if (st->>'passed')::int < (st->>'quizzes')::int then raise exception 'quiz_left'; end if;
  if length(nm) < 2 or length(nm) > 60 or nm ~ '[<>{}\\]' then raise exception 'bad_name'; end if;
  loop   -- unambiguous letters and digits only (no 0/O, 1/I/L)
    v_code := 'AROM-' || (select string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + floor(random() * 31)::int, 1), '') from generate_series(1, 4))
                || '-' || (select string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + floor(random() * 31)::int, 1), '') from generate_series(1, 4));
    exit when not exists (select 1 from public.course_certificates x where x.code = v_code) or k > 5;
    k := k + 1;
  end loop;
  insert into public.course_certificates (code, user_id, name) values (v_code, auth.uid(), nm) returning * into c;
  perform public.audit_write(auth.uid(), 'course_certificate', jsonb_build_object('code', c.code));
  return json_build_object('code', c.code, 'name', c.name, 'issued_at', c.issued_at, 'already', false);
end $$;
grant execute on function public.course_issue_certificate(text) to authenticated;

-- public check of a certificate code: name, date and course only
create or replace function public.course_verify(p_code text) returns json
language sql stable security definer set search_path = public as $$
  select coalesce((select json_build_object('valid', true, 'code', code, 'name', name, 'issued_at', issued_at, 'course', 'AROM Academy: trade gold with a plan')
                   from public.course_certificates where code = upper(trim(coalesce(p_code, '')))), json_build_object('valid', false));
$$;
grant execute on function public.course_verify(text) to anon, authenticated;
