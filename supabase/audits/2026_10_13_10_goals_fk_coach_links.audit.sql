-- Audit for 2026_10_13_10_goals_fk_coach_links. Read-only, one result table.
-- Run it before applying the migration, and again after.
--
--    check                                                        before                      after
--    1 running as                                                 postgres                    postgres
--    2 a library exercise that a goal is set on cannot be deleted (P18, L7)
--                                                                 no                          yes
--    3 the profile of a coach cannot be deleted while an athlete is linked to it (B9)
--                                                                 no                          yes
--    4 … nor while a goal names it                                no                          yes
--    5 an exercise can be archived                                no                          yes
--    6 a coach reads the progress of a goal only while they coach its athlete (P21)
--                                                                 no                          yes
--    7 an athlete is moved to another coach together with their goals (transfer_student)
--                                                                 no                          yes
--    8 functions of this migration a request without a session may execute
--                                                                 none                        none
--    9 functions of this migration a signed-in user may execute   coach_profile_for_goal(uuid)
--                                                                                             coach_profile_for_goal(uuid)
--   10 functions of this migration without search_path = public, pg_temp
--                                                                 none                        none
--   11 policies on goal_progress that the migration does not know none                        none
--   12 goals whose athlete has another coach today                0                           0
--   13 goals whose athlete has no coach today                     0                           0
--   14 library exercises with a goal and in no program            a number                    the same number
--   15 archived exercises                                         0                           0
--   16 goals                                                      a sentence                  the same
--   17 accounts                                                   a sentence                  the same
--
-- Lines 2 to 7 are the findings: they read `yes` once the migration is
-- applied.
-- Line 11 MUST read `none` before the migration: it undoes itself otherwise.
-- A policy listed there lets somebody read or write goal_progress under a
-- name this migration does not know. Stop and report it.
-- Lines 12 and 13 are the goals the new rule takes out of their coach's
-- sight: set by a coach who no longer coaches the athlete. Until the
-- migration that coach reads their progress; afterwards the athlete alone
-- does, until the goals are handed over
-- (docs/runbook/migrations/10-goals-fk-coach-links.md, "Goals left with a
-- former coach"). The migration changes neither number.
-- Line 14 is information: the exercises whose deletion took goals with it
-- until now. From the migration on they can be archived, not deleted.
-- Line 15 counts the exercises archived since the migration. Read it before
-- a rollback: the rollback drops the column, and those exercises are back in
-- the pickers.
-- Lines 16 and 17 are information, and the migration changes neither.
with fn (signature) as (
  values ('public.coach_profile_for_goal(uuid)'),
         ('public.transfer_student(uuid, uuid)')
),
-- Those of the two that exist: one before the migration, both after.
f as (
  select p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as shown,
         has_function_privilege('anon', p.oid, 'EXECUTE') as anon_may,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') as user_may,
         exists (select 1 from unnest(p.proconfig) as setting
                  where setting = 'search_path=public, pg_temp') as pinned_path
    from fn
    join pg_proc p on p.oid = to_regprocedure(fn.signature)
),
-- Every foreign key that holds one of the three columns, with what it does
-- when the row it points at is deleted: 'r' RESTRICT and 'a' NO ACTION
-- refuse, 'c' CASCADE deletes the row that points.
fk as (
  select w.line, c.confdeltype::text as on_delete
    from (values (2, 'public.goals',    'exercise_id'),
                 (3, 'public.students', 'coach_id'),
                 (4, 'public.goals',    'coach_id')
         ) as w (line, tbl, col)
    join pg_attribute a on a.attrelid = w.tbl::regclass and a.attname = w.col
    join pg_constraint c on c.conrelid = a.attrelid and c.contype = 'f' and a.attnum = any (c.conkey)
),
-- Every policy of goal_progress, with what it asks of a row that is there.
pol as (
  select p.polname as name,
         p.polcmd::text as cmd,
         coalesce(pg_get_expr(p.polqual, p.polrelid), '') as judged
    from pg_policy p
   where p.polrelid = 'public.goal_progress'::regclass
),
-- The policies the table has, before the migration and after.
known (name) as (
  values ('Students manage own goal progress'),
         ('Coaches read goal progress for their students')
)
select "check", value, expected
  from (
    values
      (1, 'running as',
          current_user::text,
          'postgres'),
      (2, 'a library exercise that a goal is set on cannot be deleted (P18, L7)',
          case when exists (select 1 from fk where line = 2)
                and not exists (select 1 from fk where line = 2 and on_delete not in ('r', 'a'))
               then 'yes' else 'no' end,
          'no before, yes after'),
      (3, 'the profile of a coach cannot be deleted while an athlete is linked to it (B9)',
          case when exists (select 1 from fk where line = 3)
                and not exists (select 1 from fk where line = 3 and on_delete not in ('r', 'a'))
               then 'yes' else 'no' end,
          'no before, yes after'),
      (4, '… nor while a goal names it',
          case when exists (select 1 from fk where line = 4)
                and not exists (select 1 from fk where line = 4 and on_delete not in ('r', 'a'))
               then 'yes' else 'no' end,
          'no before, yes after'),
      (5, 'an exercise can be archived',
          case when exists (select 1 from pg_attribute a
                             where a.attrelid = 'public.exercise_library'::regclass
                               and a.attname = 'archived_at' and not a.attisdropped)
               then 'yes' else 'no' end,
          'no before, yes after'),
      (6, 'a coach reads the progress of a goal only while they coach its athlete (P21)',
          case when exists (select 1 from pol
                             where name = 'Coaches read goal progress for their students' and cmd = 'r'
                               and judged like '%coach_profile_for_goal(%')
                and exists (select 1 from pg_proc p
                             where p.oid = to_regprocedure('public.coach_profile_for_goal(uuid)')
                               and p.prosrc like '%public.students%'
                               and p.prosrc like '%s.coach_id = gl.coach_id%')
               then 'yes' else 'no' end,
          'no before, yes after'),
      (7, 'an athlete is moved to another coach together with their goals (transfer_student)',
          case when to_regprocedure('public.transfer_student(uuid, uuid)') is not null then 'yes' else 'no' end,
          'no before, yes after'),
      (8, 'functions of this migration a request without a session may execute',
          (select coalesce(string_agg(shown, '; ' order by shown collate "C"), 'none') from f where anon_may),
          'none, before and after'),
      (9, 'functions of this migration a signed-in user may execute',
          (select coalesce(string_agg(shown, '; ' order by shown collate "C"), 'none') from f where user_may),
          'coach_profile_for_goal(uuid), before and after'),
      (10, 'functions of this migration without search_path = public, pg_temp',
          (select coalesce(string_agg(shown, '; ' order by shown collate "C"), 'none') from f where not pinned_path),
          'none, before and after'),
      (11, 'policies on goal_progress that the migration does not know',
          (select coalesce(string_agg(p.name, '; ' order by p.name collate "C"), 'none')
             from pol p
            where not exists (select 1 from known k where k.name = p.name)),
          'none — otherwise stop and report the line'),
      (12, 'goals whose athlete has another coach today',
          (select count(*)::text
             from public.goals g
             join public.students s on s.profile_id = g.student_id
            where s.coach_id <> g.coach_id),
          '0 — otherwise hand them over after the migration; the same before and after'),
      (13, 'goals whose athlete has no coach today',
          (select count(*)::text
             from public.goals g
            where not exists (select 1 from public.students s where s.profile_id = g.student_id)),
          '0 — otherwise read the page; the same before and after'),
      (14, 'library exercises with a goal and in no program',
          (select count(*)::text
             from public.exercise_library el
            where exists (select 1 from public.goals g where g.exercise_id = el.id)
              and not exists (select 1 from public.exercise_slots es where es.exercise_id = el.id)
              and not exists (select 1 from public.slot_deviations d where d.substitute_exercise_id = el.id)),
          'information; the same before and after'),
      -- Read through the row as json: the column is not there before the
      -- migration, and a query that names it would not run.
      (15, 'archived exercises',
          (select count(*)::text
             from public.exercise_library el
            where to_jsonb(el) ->> 'archived_at' is not null),
          '0 before; the number of exercises archived since, after'),
      (16, 'goals',
          (select count(*) from public.goals) || ' goal(s) on '
          || (select count(distinct exercise_id) from public.goals) || ' exercise(s), with '
          || (select count(*) from public.goal_progress) || ' logged attempt(s)',
          'information; the same before and after'),
      (17, 'accounts',
          (select count(*) from public.profiles where role = 'coach') || ' coach(es), '
          || (select count(*) from public.students) || ' athlete(s) with a coach',
          'information; the same before and after')
  ) as t (n, "check", value, expected)
 order by n;
