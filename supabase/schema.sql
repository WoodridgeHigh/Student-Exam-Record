-- ============================================================
-- Exam & Marks Records — Supabase schema
-- Run this entire file once in the Supabase SQL Editor, in a
-- project separate from (or the same as) the attendance app —
-- either works, they don't share any tables.
-- ============================================================

create extension if not exists pgcrypto;

-- ── TABLES ───────────────────────────────────────────────────

create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  name text not null,
  role text not null check (role in ('teacher', 'admin', 'super_admin'))
);

-- Only one super admin can ever exist.
create unique index one_super_admin_only on profiles ((role)) where (role = 'super_admin');

create table subjects (
  id uuid primary key default gen_random_uuid(),
  name text unique not null
);

create table houses (
  id uuid primary key default gen_random_uuid(),
  name text unique not null
);

create table academic_years (
  id uuid primary key default gen_random_uuid(),
  label text unique not null,       -- e.g. '2026-27'
  is_current boolean not null default false
);

-- Which subject+grade+section combinations a teacher can access.
-- A teacher can have several rows (e.g. Math for 6-A, Science for 7-C).
create table teacher_assignments (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references profiles(id) on delete cascade,
  subject_id uuid not null references subjects(id) on delete cascade,
  grade text not null,
  section text not null,
  unique (teacher_id, subject_id, grade, section)
);

-- Super-admin-defined custom fields. Values live in students.extra_fields.
create table field_definitions (
  id uuid primary key default gen_random_uuid(),
  field_key text unique not null,          -- machine key, e.g. 'blood_group'
  label text not null,                     -- display label, e.g. 'Blood Group'
  field_type text not null check (field_type in ('text', 'number', 'date', 'select')),
  options jsonb,                           -- for field_type = 'select': ["A+","A-",...]
  created_at timestamptz not null default now()
);

create table students (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  gender text check (gender in ('M', 'F', 'Other')),
  house_id uuid references houses(id),
  grade text not null,
  section text not null,
  extra_fields jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- One row per exam instance: either a predefined PT (auto-created for every
-- subject+class+year via initialize_academic_year) or a custom test created
-- ad hoc by a teacher/admin. Grade/section/academic_year are fixed at
-- creation time, so a student's promotion to a new grade never reinterprets
-- historical tests.
create table tests (
  id uuid primary key default gen_random_uuid(),
  name text not null,                      -- 'PT-1' or a custom name like 'Unit Test 1'
  subject_id uuid not null references subjects(id),
  grade text not null,
  section text not null,
  academic_year_id uuid not null references academic_years(id),
  is_predefined boolean not null default false,
  pt_number smallint check (pt_number between 1 and 4),
  max_marks numeric,
  is_locked boolean not null default false,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  unique (subject_id, grade, section, academic_year_id, name)
);

create table marks (
  id uuid primary key default gen_random_uuid(),
  test_id uuid not null references tests(id) on delete cascade,
  student_id uuid not null references students(id) on delete cascade,
  marks_obtained numeric,
  entered_by uuid references profiles(id),
  entered_at timestamptz not null default now(),
  unique (test_id, student_id)
);

create index idx_students_class on students (grade, section);
create index idx_tests_class on tests (subject_id, grade, section, academic_year_id);
create index idx_marks_test on marks (test_id);

-- ── HELPER FUNCTIONS ─────────────────────────────────────────

create or replace function my_role()
returns text
language sql stable security definer
set search_path = public
as $$
  select role from profiles where id = auth.uid();
$$;

create or replace function is_admin_or_above()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists(select 1 from profiles where id = auth.uid() and role in ('admin', 'super_admin'));
$$;

create or replace function is_super_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists(select 1 from profiles where id = auth.uid() and role = 'super_admin');
$$;

create or replace function teacher_has_access(p_subject_id uuid, p_grade text, p_section text)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists(
    select 1 from teacher_assignments
    where teacher_id = auth.uid() and subject_id = p_subject_id and grade = p_grade and section = p_section
  );
$$;

-- ── ROW LEVEL SECURITY ───────────────────────────────────────

alter table profiles enable row level security;
alter table subjects enable row level security;
alter table houses enable row level security;
alter table academic_years enable row level security;
alter table teacher_assignments enable row level security;
alter table field_definitions enable row level security;
alter table students enable row level security;
alter table tests enable row level security;
alter table marks enable row level security;

-- profiles: see your own row, or all rows if admin/super_admin.
-- No write policies — accounts are only created/edited via the Edge Function.
create policy "profiles read" on profiles
  for select using (auth.uid() = id or is_admin_or_above());

-- subjects / houses / academic_years: readable by any signed-in user
-- (needed for dropdowns everywhere), writable by admin/super_admin.
create policy "subjects read" on subjects for select using (auth.uid() is not null);
create policy "subjects write" on subjects for insert with check (is_admin_or_above());
create policy "subjects update" on subjects for update using (is_admin_or_above());

create policy "houses read" on houses for select using (auth.uid() is not null);
create policy "houses write" on houses for insert with check (is_admin_or_above());
create policy "houses update" on houses for update using (is_admin_or_above());

create policy "years read" on academic_years for select using (auth.uid() is not null);
create policy "years write" on academic_years for insert with check (is_admin_or_above());
create policy "years update" on academic_years for update using (is_admin_or_above());

-- teacher_assignments: a teacher can see their own; admin/super_admin manage all.
create policy "assignments read" on teacher_assignments
  for select using (teacher_id = auth.uid() or is_admin_or_above());
create policy "assignments write" on teacher_assignments
  for insert with check (is_admin_or_above());
create policy "assignments delete" on teacher_assignments
  for delete using (is_admin_or_above());

-- field_definitions: readable by any signed-in user (so forms know what
-- extra fields exist); only super_admin can define new ones.
create policy "fields read" on field_definitions for select using (auth.uid() is not null);
create policy "fields write" on field_definitions for insert with check (is_super_admin());
create policy "fields update" on field_definitions for update using (is_super_admin());

-- students: teachers see only students in a class they're assigned to
-- (any subject); admin/super_admin see and manage everyone.
create policy "students read" on students
  for select using (
    is_admin_or_above()
    or (grade, section) in (select grade, section from teacher_assignments where teacher_id = auth.uid())
  );
create policy "students write" on students for insert with check (is_admin_or_above());
create policy "students update" on students for update using (is_admin_or_above());

-- tests: teachers see/manage only tests within their assigned subject+class,
-- and even then, never the predefined PT rows' definition itself (handled
-- inside the RPC functions below, not via a table-level UPDATE policy —
-- there is deliberately NO direct update policy for `tests`; every write
-- goes through create_test / update_test / set_pt_max_marks / set_test_lock).
create policy "tests read" on tests
  for select using (
    is_admin_or_above()
    or teacher_has_access(subject_id, grade, section)
  );

-- marks: same class-scoping as tests, for both reading and (via RPC) writing.
create policy "marks read" on marks
  for select using (
    is_admin_or_above()
    or exists(
      select 1 from tests t
      where t.id = marks.test_id and teacher_has_access(t.subject_id, t.grade, t.section)
    )
  );

-- ── RPC: set up a new academic year's predefined PT-1..PT-4 tests ──────
-- Run once per year by admin/super_admin. Safe to re-run — skips tests
-- that already exist.

create or replace function initialize_academic_year(p_label text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_year_id uuid;
  v_grade text;
  v_section text;
  v_subject record;
  v_pt int;
  v_created int := 0;
  v_rows int;
begin
  if not is_admin_or_above() then raise exception 'Admin access required'; end if;

  insert into academic_years (label) values (p_label)
    on conflict (label) do nothing;
  select id into v_year_id from academic_years where label = p_label;

  foreach v_grade in array array['6', '7', '8'] loop
    foreach v_section in array array['A', 'B', 'C', 'D', 'E', 'F', 'G'] loop
      for v_subject in select id from subjects loop
        for v_pt in 1..4 loop
          insert into tests (name, subject_id, grade, section, academic_year_id, is_predefined, pt_number)
          values ('PT-' || v_pt, v_subject.id, v_grade, v_section, v_year_id, true, v_pt)
          on conflict (subject_id, grade, section, academic_year_id, name) do nothing;
          get diagnostics v_rows = row_count;
          v_created := v_created + v_rows;
        end loop;
      end loop;
    end loop;
  end loop;

  return jsonb_build_object('ok', true, 'academic_year_id', v_year_id, 'testsCreated', v_created);
end;
$$;

-- ── RPC: set / lock the max marks of a predefined PT test ──────────────

create or replace function set_pt_max_marks(p_test_id uuid, p_max_marks numeric)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_test tests%rowtype;
begin
  if not is_admin_or_above() then raise exception 'Admin access required'; end if;
  select * into v_test from tests where id = p_test_id;
  if v_test.id is null then raise exception 'Test not found'; end if;
  if v_test.is_locked then raise exception 'This test is locked — unlock it first'; end if;

  update tests set max_marks = p_max_marks where id = p_test_id;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function set_test_lock(p_test_id uuid, p_locked boolean)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
begin
  if not is_admin_or_above() then raise exception 'Admin access required'; end if;
  update tests set is_locked = p_locked where id = p_test_id;
  return jsonb_build_object('ok', true);
end;
$$;

-- ── RPC: create / edit a custom test ───────────────────────────────────
-- Predefined PTs can never be created or edited through these — only
-- through initialize_academic_year / set_pt_max_marks / set_test_lock above.

create or replace function create_test(p_name text, p_subject_id uuid, p_grade text, p_section text, p_academic_year_id uuid, p_max_marks numeric)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not (is_admin_or_above() or teacher_has_access(p_subject_id, p_grade, p_section)) then
    raise exception 'You do not have access to this subject/class';
  end if;

  insert into tests (name, subject_id, grade, section, academic_year_id, is_predefined, max_marks, created_by)
  values (p_name, p_subject_id, p_grade, p_section, p_academic_year_id, false, p_max_marks, auth.uid())
  returning id into v_id;

  return jsonb_build_object('ok', true, 'testId', v_id);
end;
$$;

create or replace function update_test(p_test_id uuid, p_name text, p_max_marks numeric)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_test tests%rowtype;
begin
  select * into v_test from tests where id = p_test_id;
  if v_test.id is null then raise exception 'Test not found'; end if;
  if v_test.is_predefined then
    raise exception 'Predefined PT tests cannot be edited here — an admin uses set_pt_max_marks / set_test_lock instead';
  end if;
  if not (is_admin_or_above() or teacher_has_access(v_test.subject_id, v_test.grade, v_test.section)) then
    raise exception 'You do not have access to this test';
  end if;

  update tests set name = p_name, max_marks = p_max_marks where id = p_test_id;
  return jsonb_build_object('ok', true);
end;
$$;

-- ── RPC: submit marks for a test (bulk upsert, access-checked) ─────────
-- p_records is a JSON object like {"<student_uuid>": 18, "<student_uuid>": 20}

create or replace function submit_marks(p_test_id uuid, p_records jsonb)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_test tests%rowtype;
  rec record;
  v_value numeric;
  v_saved int := 0;
begin
  select * into v_test from tests where id = p_test_id;
  if v_test.id is null then raise exception 'Test not found'; end if;
  if not (is_admin_or_above() or teacher_has_access(v_test.subject_id, v_test.grade, v_test.section)) then
    raise exception 'You do not have access to this test';
  end if;

  for rec in select * from jsonb_each_text(p_records) loop
    v_value := rec.value::numeric;
    if v_test.max_marks is not null and v_value > v_test.max_marks then
      raise exception 'Marks % exceed max marks % for one student', v_value, v_test.max_marks;
    end if;

    insert into marks (test_id, student_id, marks_obtained, entered_by, entered_at)
    values (p_test_id, rec.key::uuid, v_value, auth.uid(), now())
    on conflict (test_id, student_id) do update
      set marks_obtained = excluded.marks_obtained,
          entered_by = excluded.entered_by,
          entered_at = excluded.entered_at;
    v_saved := v_saved + 1;
  end loop;

  return jsonb_build_object('ok', true, 'saved', v_saved);
end;
$$;

-- ── RPC: reports ────────────────────────────────────────────────────────

-- General leaderboard across a chosen set of tests, optionally filtered
-- by grade/section/house. Percentage-based so tests with different max
-- marks can be combined meaningfully. p_limit = null returns everyone.
create or replace function get_leaderboard(p_test_ids uuid[], p_grade text default null, p_section text default null, p_house_id uuid default null, p_limit int default null)
returns table(student_id uuid, name text, grade text, section text, house_name text, total_obtained numeric, total_max numeric, percentage numeric)
language plpgsql security definer
set search_path = public
as $$
begin
  if not is_admin_or_above() then raise exception 'Admin access required'; end if;

  return query
  select s.id, s.name, s.grade, s.section, h.name,
    sum(m.marks_obtained), sum(t.max_marks),
    round(100.0 * sum(m.marks_obtained) / nullif(sum(t.max_marks), 0), 2)
  from marks m
  join tests t on t.id = m.test_id
  join students s on s.id = m.student_id
  left join houses h on h.id = s.house_id
  where t.id = any(p_test_ids)
    and m.marks_obtained is not null
    and (p_grade is null or p_grade = '' or s.grade = p_grade)
    and (p_section is null or p_section = '' or s.section = p_section)
    and (p_house_id is null or s.house_id = p_house_id)
  group by s.id, s.name, s.grade, s.section, h.name
  order by percentage desc nulls last
  limit p_limit;
end;
$$;

-- Top N students per class, in one call — for a "top 3 per class" report.
create or replace function get_top_n_per_class(p_test_ids uuid[], p_top_n int default 3)
returns table(grade text, section text, rank int, student_id uuid, name text, total_obtained numeric, total_max numeric, percentage numeric)
language plpgsql security definer
set search_path = public
as $$
begin
  if not is_admin_or_above() then raise exception 'Admin access required'; end if;

  return query
  select ranked.grade, ranked.section, ranked.rnk::int, ranked.student_id, ranked.name,
    ranked.total_obtained, ranked.total_max, ranked.percentage
  from (
    select s.grade, s.section, s.id as student_id, s.name,
      sum(m.marks_obtained) as total_obtained, sum(t.max_marks) as total_max,
      round(100.0 * sum(m.marks_obtained) / nullif(sum(t.max_marks), 0), 2) as percentage,
      row_number() over (partition by s.grade, s.section order by round(100.0 * sum(m.marks_obtained) / nullif(sum(t.max_marks), 0), 2) desc nulls last) as rnk
    from marks m
    join tests t on t.id = m.test_id
    join students s on s.id = m.student_id
    where t.id = any(p_test_ids) and m.marks_obtained is not null
    group by s.grade, s.section, s.id, s.name
  ) ranked
  where ranked.rnk <= p_top_n
  order by ranked.grade, ranked.section, ranked.rnk;
end;
$$;

-- Simple result sheet for one class + one set of tests (e.g. one PT across
-- all subjects, or a term's worth of tests) — subject columns pivoted out
-- client-side from this flat row-per-student-per-test shape.
create or replace function get_class_result_sheet(p_test_ids uuid[], p_grade text, p_section text)
returns table(student_id uuid, student_name text, test_id uuid, test_name text, subject_name text, marks_obtained numeric, max_marks numeric)
language plpgsql security definer
set search_path = public
as $$
begin
  if not (is_admin_or_above() or exists(
    select 1 from tests t where t.id = any(p_test_ids) and teacher_has_access(t.subject_id, p_grade, p_section)
  )) then
    raise exception 'You do not have access to this class';
  end if;

  return query
  select s.id, s.name, t.id, t.name, sub.name, m.marks_obtained, t.max_marks
  from students s
  cross join unnest(p_test_ids) as chosen_test_id
  join tests t on t.id = chosen_test_id and t.grade = p_grade and t.section = p_section
  join subjects sub on sub.id = t.subject_id
  left join marks m on m.test_id = t.id and m.student_id = s.id
  where s.grade = p_grade and s.section = p_section and s.active
  order by s.name, sub.name;
end;
$$;

-- ── RPC: add a super-admin-defined custom field ────────────────────────

create or replace function add_field_definition(p_field_key text, p_label text, p_field_type text, p_options jsonb default null)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
begin
  if not is_super_admin() then raise exception 'Super admin access required'; end if;
  insert into field_definitions (field_key, label, field_type, options)
  values (p_field_key, p_label, p_field_type, p_options);
  return jsonb_build_object('ok', true);
end;
$$;
