# Exam & Marks Records

Free, no-paid-hosting system for creating tests, entering and locking marks,
and generating reports (with PDF export) across academic years — with three
roles: teacher, admin, and a single super admin who can extend the data
model itself.

**Stack:** Supabase (Postgres + Auth + Edge Functions, free tier) · manual
username/password login · plain HTML/CSS/JS on GitHub Pages · client-side
PDF export (`html2pdf.js`, no backend rendering needed).

This mirrors the architecture of the attendance app in the same account —
same login pattern, same RLS-based access control approach — but is a
completely separate set of tables, so it can live in its own Supabase
project or share one with the attendance app without conflicting.

---

## 1. Create a Supabase project

Same as the attendance app: [supabase.com](https://supabase.com) → **New
project**. You can reuse the same Supabase project as the attendance app (the
table names don't collide) or use a fresh one — either is fine.

## 2. Run the schema

**SQL Editor** → paste in the entire contents of `supabase/schema.sql` → **Run**.

This creates: `profiles`, `subjects`, `houses`, `academic_years`,
`teacher_assignments`, `field_definitions`, `students`, `tests`, `marks` —
plus all the RLS policies and the functions the app calls
(`initialize_academic_year`, `set_pt_max_marks`, `set_test_lock`,
`create_test`, `update_test`, `submit_marks`, `get_leaderboard`,
`get_top_n_per_class`, `get_class_result_sheet`, `add_field_definition`).

## 3. Turn off email confirmation

**Authentication → Sign In / Providers → Email** → turn **Confirm email** OFF
(usernames are mapped to fake `@examrecords.local` addresses — see "How login
works" below — so nothing can ever confirm them).

## 4. Deploy the Edge Function

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase functions deploy admin-actions
```
Or paste `supabase/functions/admin-actions/index.ts` into a new function
called `admin-actions` from the dashboard's Edge Functions tab.

## 5. Create the super admin (one-time, in the dashboard)

There's no self-service sign-up, and only one super admin can ever exist —
so this one account is set up by hand, the only time you'll do this:

1. **Authentication → Users → Add user**. Email: `super@examrecords.local`
   (or any username + `@examrecords.local`), set a password, check **Auto
   Confirm User**, create it.
2. Copy the user's **UUID**.
3. **Table Editor → profiles → Insert row**: `id` = that UUID, `username` =
   whatever you used before the `@`, `name` = your name, `role` =
   `super_admin`. Save.
4. Sign in on the site with that username/password. From here, use the
   **Teachers** tab to create admin and teacher accounts — the Edge
   Function handles the role hierarchy correctly from this point on
   (only the super admin can create further admins; admins can create
   teachers).

## 6. Configure the frontend

**Project Settings → API** for your URL and anon key, then edit
`docs/js/config.js`:

```js
const CONFIG = {
  SUPABASE_URL: 'https://xxxxxxxx.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOi...',
  SCHOOL_NAME: 'Your School Name'
};
```

## 7. Deploy to GitHub Pages

Same as before: repo **Settings → Pages** → **Deploy from a branch** →
`main` / `/docs`.

## 8. First-time setup, in order

Once you're signed in as super admin (or an admin they've created):

1. **Setup tab** → add your **Subjects** (e.g. Math, Science, English...) —
   do this before initializing a year, since PT-1 to PT-4 get generated for
   every subject that exists at that moment.
2. **Setup tab** → add **Houses** if you use them.
3. **Setup tab** → type an academic year label (e.g. `2026-27`) and click
   **Create year & generate PT-1 to PT-4**. This creates one PT-1..PT-4 row
   for every subject × grade × section (3 × 7 × your subject count) with
   blank, unlocked max marks.
4. **PT Max Marks tab** → for each subject/class, set the max marks for
   PT-1 through PT-4, then **Lock** them once finalized. Locked tests can't
   be edited until explicitly unlocked.
5. **Students tab** → CSV import (`sample-data/students_template.csv`) or
   add one at a time.
6. **Teachers tab** → create teacher accounts, assigning each one or more
   subject+class combinations. Only the super admin sees the option to
   create another **admin** account here.

From there: teachers sign in, see only their assigned subject+class
combinations, and can create custom tests or enter marks (including for
PT-1..4, once an admin has set and possibly locked the max marks — a PT with
no max marks set yet shows "Enter marks" disabled).

---

## How reports work

On the **Reports tab**, you first narrow down and check off exactly which
tests to include (by year, and optionally subject/grade/section) — nothing
is hardcoded to "PTs only" or "this year only," so you can build a report
across any combination: a single PT for one class, all four PTs for a whole
grade, a mix of PTs and custom tests, etc. Then pick a report type:

- **Leaderboard** — ranks students by total percentage across the selected
  tests, optionally filtered further by grade/section/house, with an
  optional result-count limit.
- **Top 3 per class** — same ranking, but broken out separately per class in
  one table (handles "top 3 per class across all 21 classes" in one click).
- **Class result sheet** — a single class, one column per test, one row per
  student — closer to a traditional report card layout.

**Export as PDF** turns whatever's currently shown into a PDF, client-side
(no server involved). The HTML structure being exported is the
`#printArea` div in `docs/admin.html`/the report-building code in
`docs/js/admin.js`'s `generateReport()` function — since you mentioned
wanting to finalize the exact PDF layout yourself, that's the part to edit:
the table markup generated there is plain HTML/CSS, so you can restyle it
(add a school letterhead, adjust columns, add a signature line, etc.)
without touching anything else in the app.

---

## How login and access control work

Same approach as the attendance app: each username maps to a fake
`username@examrecords.local` address so Supabase's real auth system (bcrypt
hashing, signed sessions) has something email-shaped to work with, without
you or the app ever handling raw email addresses. Row Level Security on
every table means a teacher's queries are automatically scoped to their
assigned subject+class combinations by Postgres itself — not by a
client-side check that could be bypassed.

The **role hierarchy** is enforced in the `admin-actions` Edge Function:
teachers are created by admin or super admin; admin accounts can only be
created by the super admin; the super admin is never created through the
app UI at all, and the database has a hard constraint (a partial unique
index) guaranteeing only one can ever exist.

**Predefined PT protection**: `update_test()` explicitly refuses to touch
any test where `is_predefined = true` — the only way to change a PT's max
marks is `set_pt_max_marks()`, and only admin/super admin can call it, and
only while `is_locked = false`. This is enforced in the database function
itself, not just hidden in the UI, so it holds even if someone calls the
API directly.

---

## What's intentionally left for you to extend

Given how much ground this covers, a few things are built as a solid
foundation but kept simple on purpose — happy to build any of these out
further once you've used the app for a bit and know what you actually need:

1. **Editing students / custom field values** currently uses simple browser
   prompts rather than a polished modal form — functional, but not pretty.
2. **CSV import for students** matches houses by exact name; a row with a
   house name that doesn't match anything existing is imported without a
   house rather than failing the whole import.
3. **No promotion/roll-over tool** — moving all students up a grade at
   year-end is a manual edit per student (or a CSV re-import) for now.
4. **No consecutive-term trend reports** (e.g. "improved most since PT-1") —
   the leaderboard functions are a good foundation to extend for this.
5. **No audit trail** on who changed what, beyond `entered_by`/`entered_at`
   on marks — worth adding if multiple admins will be editing the same data.

---

## Repo structure

```
supabase/schema.sql                 Tables, RLS policies, RPC functions
supabase/functions/admin-actions/   Edge Function: account creation, password resets
docs/index.html                     Login page
docs/teacher.html + js              Teacher: assigned classes, tests, marks entry
docs/admin.html + js                Admin/super admin: setup, PT locking, students,
                                     teachers, tests & marks (any class), reports, fields
docs/css/styles.css                 Shared styles
sample-data/                        CSV template for bulk student import
```
