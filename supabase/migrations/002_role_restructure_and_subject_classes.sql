-- ============================================================
-- Migration 002 — run this in the SQL Editor on your EXISTING
-- Supabase project. Safe to run once; it only adds/replaces —
-- nothing here drops or rewrites your existing data (houses,
-- students, marks already entered are untouched).
-- ============================================================

-- ── 1. Which classes take which subject ─────────────────────
-- Subjects no longer implicitly apply to all 21 classes — each
-- subject now explicitly lists the grade+section combos that take it.

create table subject_classes (
  subject_id uuid not null references subjects(id) on delete cascade,
  grade text not null,
  section text not null,
  primary key (subject_id, grade, section)
);

alter table subject_classes enable row level security;
create policy "subject_classes read" on subject_classes for select using (auth.uid() is not null);
-- No direct write policies — subject_classes is only ever written through
-- create_subject / update_subject / delete_subject below (all security
-- definer, all super_admin-only).

-- One-time backfill: if you already have subjects and want them to keep
-- applying to every class exactly as before, uncomment and run this once:
--
-- insert into subject_classes (subject_id, grade, section)
-- select s.id, g.grade, sec.section
-- from subjects s
-- cross join unnest(array['6','7','8']) as g(grade)
-- cross join unnest(array['A','B','C','D','E','F','G']) as sec(section)
-- on conflict do nothing;

-- ── 2. Absent marking ────────────────────────────────────────

alter table marks add column if not exists is_absent boolean not null default false;

-- ── 3. Subjects are now managed only via RPC (super_admin only) ────────
-- Remove the old direct-table write policies; create_subject/update_subject/
-- delete_subject below are security definer and enforce super_admin.

drop policy if exists "subjects write" on subjects;
drop policy if exists "subjects update" on subjects;

-- ── 4. RPC: create / update / delete a subject, with its class list ────

create or replace function create_subject(p_name text, p_classes jsonb)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_class record;
begin
  if not is_super_admin() then raise exception 'Super admin access required'; end if;

  insert into subjects (name) values (p_name) returning id into v_id;

  for v_class in select * from jsonb_to_recordset(p_classes) as x(grade text, section text) loop
    insert into subject_classes (subject_id, grade, section) values (v_id, v_class.grade, v_class.section)
    on conflict do nothing;
  end loop;

  return jsonb_build_object('ok', true, 'subjectId', v_id);
end;
$$;

create or replace function update_subject(p_subject_id uuid, p_name text, p_classes jsonb)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_class record;
begin
  if not is_super_admin() then raise exception 'Super admin access required'; end if;

  update subjects set name = p_name where id = p_subject_id;

  delete from subject_classes where subject_id = p_subject_id;
  for v_class in select * from jsonb_to_recordset(p_classes) as x(grade text, section text) loop
    insert into subject_classes (subject_id, grade, section) values (p_subject_id, v_class.grade, v_class.section)
    on conflict do nothing;
  end loop;

  return jsonb_build_object('ok', true);
end;
$$;

create or replace function delete_subject(p_subject_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
begin
  if not is_super_admin() then raise exception 'Super admin access required'; end if;

  delete from marks where test_id in (select id from tests where subject_id = p_subject_id);
  delete from tests where subject_id = p_subject_id;
  delete from teacher_assignments where subject_id = p_subject_id;
  delete from subject_classes where subject_id = p_subject_id;
  delete from subjects where id = p_subject_id;

  return jsonb_build_object('ok', true);
end;
$$;

-- ── 5. Rewrite initialize_academic_year to respect subject_classes ─────
-- Previously this created PT-1..4 for every subject × every class. Now it
-- only creates them for the class combinations actually mapped to each
-- subject via subject_classes.

create or replace function initialize_academic_year(p_label text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_year_id uuid;
  v_subject record;
  v_class record;
  v_pt int;
  v_created int := 0;
  v_rows int;
begin
  if not is_admin_or_above() then raise exception 'Admin access required'; end if;

  insert into academic_years (label) values (p_label)
    on conflict (label) do nothing;
  select id into v_year_id from academic_years where label = p_label;

  for v_subject in select id from subjects loop
    for v_class in select grade, section from subject_classes where subject_id = v_subject.id loop
      for v_pt in 1..4 loop
        insert into tests (name, subject_id, grade, section, academic_year_id, is_predefined, pt_number)
        values ('PT-' || v_pt, v_subject.id, v_class.grade, v_class.section, v_year_id, true, v_pt)
        on conflict (subject_id, grade, section, academic_year_id, name) do nothing;
        get diagnostics v_rows = row_count;
        v_created := v_created + v_rows;
      end loop;
    end loop;
  end loop;

  return jsonb_build_object('ok', true, 'academic_year_id', v_year_id, 'testsCreated', v_created);
end;
$$;

-- ── 6. submit_marks: support marking a student absent ───────────────────
-- p_records values can now be either a plain number, or the string
-- "ABSENT" to mark that student absent for this test (marks_obtained
-- stored as null, is_absent = true; excluded from averages the same way
-- an ungraded/null entry already was).

create or replace function submit_marks(p_test_id uuid, p_records jsonb)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_test tests%rowtype;
  rec record;
  v_absent boolean;
  v_value numeric;
  v_saved int := 0;
begin
  select * into v_test from tests where id = p_test_id;
  if v_test.id is null then raise exception 'Test not found'; end if;
  if not (is_admin_or_above() or teacher_has_access(v_test.subject_id, v_test.grade, v_test.section)) then
    raise exception 'You do not have access to this test';
  end if;

  for rec in select * from jsonb_each_text(p_records) loop
    v_absent := (rec.value = 'ABSENT');
    v_value := case when v_absent then null else rec.value::numeric end;

    if not v_absent and v_test.max_marks is not null and v_value > v_test.max_marks then
      raise exception 'Marks % exceed max marks % for one student', v_value, v_test.max_marks;
    end if;

    insert into marks (test_id, student_id, marks_obtained, is_absent, entered_by, entered_at)
    values (p_test_id, rec.key::uuid, v_value, v_absent, auth.uid(), now())
    on conflict (test_id, student_id) do update
      set marks_obtained = excluded.marks_obtained,
          is_absent = excluded.is_absent,
          entered_by = excluded.entered_by,
          entered_at = excluded.entered_at;
    v_saved := v_saved + 1;
  end loop;

  return jsonb_build_object('ok', true, 'saved', v_saved);
end;
$$;

-- ── 7. get_class_result_sheet: surface is_absent for display ("AB") ────

create or replace function get_class_result_sheet(p_test_ids uuid[], p_grade text, p_section text)
returns table(student_id uuid, student_name text, test_id uuid, test_name text, subject_name text, marks_obtained numeric, max_marks numeric, is_absent boolean)
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
  select s.id, s.name, t.id, t.name, sub.name, m.marks_obtained, t.max_marks, coalesce(m.is_absent, false)
  from students s
  cross join unnest(p_test_ids) as chosen_test_id
  join tests t on t.id = chosen_test_id and t.grade = p_grade and t.section = p_section
  join subjects sub on sub.id = t.subject_id
  left join marks m on m.test_id = t.id and m.student_id = s.id
  where s.grade = p_grade and s.section = p_section and s.active
  order by s.name, sub.name;
end;
$$;
