-- AROM Academy: lessons are edited by admins in Admin dashboard → Academy (website), not by hand in the database.
-- Run after course.sql and course-certificate.sql.

-- admins read every lesson (drafts too) and may add, change and delete lessons
drop policy if exists "course admin read" on public.course_lessons;
drop policy if exists "course admin insert" on public.course_lessons;
drop policy if exists "course admin update" on public.course_lessons;
drop policy if exists "course admin delete" on public.course_lessons;
create policy "course admin read" on public.course_lessons for select using (public.is_admin(auth.uid()));
create policy "course admin insert" on public.course_lessons for insert with check (public.is_admin(auth.uid()));
create policy "course admin update" on public.course_lessons for update using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));
create policy "course admin delete" on public.course_lessons for delete using (public.is_admin(auth.uid()));
grant insert, update, delete on public.course_lessons to authenticated;

-- lesson address: lowercase letters, digits and dashes (it is part of the page link, e.g. /course#risk-1)
alter table public.course_lessons drop constraint if exists course_lessons_id_check;
alter table public.course_lessons add constraint course_lessons_id_check check (id ~ '^[a-z0-9][a-z0-9-]{1,39}$');
alter table public.course_lessons drop constraint if exists course_lessons_quiz_check;
alter table public.course_lessons add constraint course_lessons_quiz_check check (quiz is null or (jsonb_typeof(quiz) = 'array' and jsonb_array_length(quiz) between 1 and 20));

create or replace function public.course_touch() returns trigger language plpgsql as $$ begin new.updated_at := now(); return new; end $$;
drop trigger if exists course_lessons_touch on public.course_lessons;
create trigger course_lessons_touch before update on public.course_lessons for each row execute function public.course_touch();

-- numbers for the Academy tab
create or replace function public.course_admin_stats() returns json
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.admin_guard();
  return json_build_object(
    'buyers', (select count(*) from public.profiles where course_until > now() and not coalesce(is_admin, false)),
    'learners', (select count(distinct user_id) from public.course_progress),
    'certificates', (select count(*) from public.course_certificates),
    'sales', (select coalesce(sum(amount), 0) from public.payments where plan = 'course' and status = 'paid'),
    'recent', (select coalesce(json_agg(r), '[]') from (select code, name, issued_at from public.course_certificates order by issued_at desc limit 15) r));
end $$;
grant execute on function public.course_admin_stats() to authenticated;
