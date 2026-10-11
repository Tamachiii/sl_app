-- Audit for 2026_10_11_05_students_role_gate. Read-only, one result table.
-- Run it before applying the migration, and again after.
--
--    check                                                        before                      after
--    1 running as                                                 postgres                    postgres
--    2 policies that let a signed-in user write students (P7, L2)
--                                                                 Coaches delete their students (DELETE); Coaches insert students (INSERT); Coaches update their students (UPDATE)
--                                                                                             Coaches update their students (UPDATE)
--    3 the update policy on students checks the new row and asks for a coach
--                                                                 no                          yes
--    4 a students row is checked when it is written               missing                     in place
--    5 policies that write the exercise library without asking for a coach
--                                                                 Coaches manage own library  none
--    6 the exercise of a slot is checked against the coach's library
--                                                                 missing                     in place
--    7 the substitute of a swap is checked against the coach's library
--                                                                 missing                     in place
--    8 functions of this migration a request without a session may execute
--                                                                 none                        none
--    9 functions of this migration a signed-in user may execute   none                        is_coach()
--   10 functions of this migration without search_path = public, pg_temp
--                                                                 none                        none
--   11 coach-athlete links the gate refuses                       0                           0
--   12 library exercises that belong to an account that is not a coach
--                                                                 0                           0
--   13 exercise slots that hold an exercise of another coach's library
--                                                                 0                           0
--   14 swaps whose substitute is from another coach's library     0                           0
--   15 accounts                                                   a sentence                  the same sentence
--
-- Lines 2 to 7 and 9 are the findings: they read as the "after" column once
-- the migration is applied.
-- Line 11 MUST read 0 before the migration: it refuses to run otherwise
-- (SLM05). A row counted there is a link somebody forged, or a coach who is
-- somebody's athlete. The runbook page lists them and says what to do
-- (docs/runbook/migrations/05-students-role-gate.md).
-- Lines 12 to 14 are information and do not stop the migration: rows written
-- while the hole was open, or left by a change of coach. The migration
-- changes none of them; the page says what each one means.
-- Line 15 is information: how many accounts are coaches, athletes with a
-- coach, and athletes nobody coaches yet.
with fn (signature) as (
  values ('public.is_coach()'),
         ('public.check_students_link()'),
         ('public.check_slot_exercise_in_coach_library()'),
         ('public.check_deviation_substitute_in_coach_library()')
),
-- Those of the four that exist: none before the migration, all after.
f as (
  select p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as shown,
         has_function_privilege('anon', p.oid, 'EXECUTE') as anon_may,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') as user_may,
         exists (select 1 from unnest(p.proconfig) as setting
                  where setting = 'search_path=public, pg_temp') as pinned_path
    from fn
    join pg_proc p on p.oid = to_regprocedure(fn.signature)
),
-- The triggers, by table: in place means there, and not switched off.
trg as (
  select c.relname as tbl, t.tgname as name
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
   where c.relnamespace = 'public'::regnamespace
     and not t.tgisinternal
     and t.tgenabled in ('O', 'A')
),
-- The policies of the two tables, with the text of what they ask.
pol as (
  select c.relname as tbl, p.polname as name,
         case p.polcmd when 'r' then 'SELECT' when 'a' then 'INSERT' when 'w' then 'UPDATE'
                       when 'd' then 'DELETE' else 'ALL' end as cmd,
         coalesce(pg_get_expr(p.polqual, p.polrelid), '') as asks_of_the_row,
         coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') as asks_of_the_new_row
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
   where c.oid in ('public.students'::regclass, 'public.exercise_library'::regclass)
),
-- Every link, with the role of both ends. "Refused" is the rule of the
-- migration, written out: its trigger does not exist before.
link as (
  select s.id,
         (s.profile_id = s.coach_id) as itself,
         (cp.role <> 'coach') as coach_is_not_one,
         (ap.role <> 'student') as athlete_is_not_one
    from public.students s
    join public.profiles cp on cp.id = s.coach_id
    join public.profiles ap on ap.id = s.profile_id
),
-- Every slot with the coach of its program.
slot as (
  select es.id, es.exercise_id, p.id as program_id, st.coach_id as program_coach
    from public.exercise_slots es
    join public.sessions se on se.id = es.session_id
    join public.weeks w on w.id = se.week_id
    join public.programs p on p.id = w.program_id
    join public.students st on st.id = p.student_id
)
select "check", value, expected
  from (
    values
      (1, 'running as',
          current_user::text,
          'postgres'),
      (2, 'policies that let a signed-in user write students (P7, L2)',
          (select coalesce(string_agg(name || ' (' || cmd || ')', '; ' order by name collate "C"), 'none')
             from pol where tbl = 'students' and cmd <> 'SELECT'),
          'the three "Coaches …" policies before — Coaches update their students (UPDATE) after'),
      (3, 'the update policy on students checks the new row and asks for a coach',
          case when exists (select 1 from pol
                             where tbl = 'students' and name = 'Coaches update their students' and cmd = 'UPDATE'
                               and asks_of_the_row like '%is_coach()%'
                               and asks_of_the_new_row like '%is_coach()%')
               then 'yes' else 'no' end,
          'no before, yes after'),
      (4, 'a students row is checked when it is written',
          case when exists (select 1 from trg where tbl = 'students' and name = 'trg_check_students_link')
               then 'in place' else 'missing' end,
          'missing before, in place after'),
      (5, 'policies that write the exercise library without asking for a coach',
          (select coalesce(string_agg(name, '; ' order by name collate "C"), 'none')
             from pol
            where tbl = 'exercise_library' and cmd in ('INSERT', 'UPDATE', 'ALL')
              and asks_of_the_new_row not like '%is_coach()%'),
          'Coaches manage own library before, none after'),
      (6, 'the exercise of a slot is checked against the coach''s library',
          case when exists (select 1 from trg
                             where tbl = 'exercise_slots' and name = 'trg_check_slot_exercise_in_coach_library')
               then 'in place' else 'missing' end,
          'missing before, in place after'),
      (7, 'the substitute of a swap is checked against the coach''s library',
          case when exists (select 1 from trg
                             where tbl = 'slot_deviations' and name = 'trg_check_deviation_substitute_in_coach_library')
               then 'in place' else 'missing' end,
          'missing before, in place after'),
      (8, 'functions of this migration a request without a session may execute',
          (select coalesce(string_agg(shown, '; ' order by shown collate "C"), 'none') from f where anon_may),
          'none, before and after'),
      (9, 'functions of this migration a signed-in user may execute',
          (select coalesce(string_agg(shown, '; ' order by shown collate "C"), 'none') from f where user_may),
          'none before, is_coach() after'),
      (10, 'functions of this migration without search_path = public, pg_temp',
          (select coalesce(string_agg(shown, '; ' order by shown collate "C"), 'none') from f where not pinned_path),
          'none, before and after'),
      (11, 'coach-athlete links the gate refuses',
          (select case when count(*) = 0 then '0'
                       else count(*) || ' (' || count(*) filter (where coach_is_not_one) || ' whose coach is not a coach, '
                            || count(*) filter (where athlete_is_not_one) || ' whose athlete is not a student, '
                            || count(*) filter (where itself) || ' linked to itself)' end
             from link where itself or coach_is_not_one or athlete_is_not_one),
          '0 — otherwise the migration refuses to run: remove them first'),
      (12, 'library exercises that belong to an account that is not a coach',
          (select case when count(*) = 0 then '0'
                       else count(*) || ' of ' || count(distinct el.coach_id) || ' account(s)' end
             from public.exercise_library el
             join public.profiles p on p.id = el.coach_id
            where p.role <> 'coach'),
          '0 — otherwise go on, and report the line'),
      (13, 'exercise slots that hold an exercise of another coach''s library',
          (select case when count(*) = 0 then '0'
                       else count(*) || ' in ' || count(distinct slot.program_id) || ' program(s)' end
             from slot
             join public.exercise_library el on el.id = slot.exercise_id
            where el.coach_id <> slot.program_coach),
          '0 — otherwise go on, and report the line'),
      (14, 'swaps whose substitute is from another coach''s library',
          (select count(*)::text
             from public.slot_deviations d
             join slot on slot.id = d.exercise_slot_id
             join public.exercise_library el on el.id = d.substitute_exercise_id
            where el.coach_id <> slot.program_coach),
          '0 — otherwise go on, and report the line'),
      (15, 'accounts',
          (select count(*) filter (where p.role = 'coach') || ' coach(es), '
                  || count(*) filter (where p.role = 'student' and s.id is not null) || ' athlete(s) with a coach, '
                  || count(*) filter (where p.role = 'student' and s.id is null) || ' athlete(s) without one'
             from public.profiles p
             left join public.students s on s.profile_id = p.id),
          'information; the same before and after')
  ) as t (n, "check", value, expected)
 order by n;
