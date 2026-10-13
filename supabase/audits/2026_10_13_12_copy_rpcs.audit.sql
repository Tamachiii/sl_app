-- Audit for 2026_10_13_12_copy_rpcs. Read-only, one result table.
-- Run it before applying the migration, and again after.
--
--    check                                                        before                      after
--    1 running as                                                 postgres                    postgres
--    2 a session is duplicated in one request (duplicate_session, P52)
--                                                                 no                          yes
--    3 sessions are copied into a phase in one request (copy_sessions, P52)
--                                                                 no                          yes
--    4 a phase is duplicated in one request (duplicate_week, P52)
--                                                                 no                          yes
--    5 a block is duplicated in one request (duplicate_program, P52)
--                                                                 no                          yes
--    6 functions of these names that the migration does not know  none                        none
--    7 functions of this migration a request without a session may execute
--                                                                 none                        none
--    8 functions of this migration a signed-in user may execute   none                        copy_sessions(uuid[], uuid); duplicate_program(uuid, uuid, text); duplicate_session(uuid, text); duplicate_week(uuid, uuid, text)
--    9 functions of this migration that run as their owner        none                        none
--   10 functions of this migration without search_path = public, pg_temp
--                                                                 none                        none
--   11 sessions without an exercise                               a number                    the same number
--   12 exercises without a set                                    a number                    the same number
--   13 exercises that are not in the library of their athlete's coach
--                                                                 0                           0
--
-- Lines 2 to 5 and 8 are the migration: they read as the "after" column once
-- it is applied.
-- Line 6 MUST read `none` before the migration: it refuses to run otherwise.
-- A function listed there has one of the four names and was made by hand.
-- Stop and report it. (Before the migration, lines 2 to 5 reading `yes` are
-- the same thing: the function is there and the ledger does not know why.)
-- Lines 11 to 13 are for information. The migration changes none of them,
-- and none of them stops it:
--   11  sessions that hold no exercise, archived ones left out, in approved
--       blocks out of the trash. A session the coach has just added looks
--       like that — and so does one that a "Duplicate" or a "Copy to…" of
--       the app left behind when one of its requests was lost
--       (docs/runbook/migrations/12-copy-rpcs.md, "Sessions without an
--       exercise").
--   12  exercises that hold no set at all, in approved blocks out of the
--       trash: the same lost request, one step later — or the copy of a
--       draft. The athlete's app makes the sets when the session is opened.
--   13  exercises a copy leaves out: their exercise belongs to the library of
--       another coach than their athlete's. `0` unless an athlete changed
--       coach.
with fn (signature) as (
  values ('public.duplicate_session(uuid, text)'),
         ('public.copy_sessions(uuid[], uuid)'),
         ('public.duplicate_week(uuid, uuid, text)'),
         ('public.duplicate_program(uuid, uuid, text)')
),
-- Those of the four that exist: none before the migration, all after.
f as (
  select fn.signature,
         p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as shown,
         has_function_privilege('anon', p.oid, 'EXECUTE') as anon_may,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') as user_may,
         p.prosecdef as as_owner,
         exists (select 1 from unnest(p.proconfig) as setting
                  where setting = 'search_path=public, pg_temp') as pinned_path
    from fn
    join pg_proc p on p.oid = to_regprocedure(fn.signature)
),
-- Every function of public under one of the four names, whatever its
-- arguments.
named as (
  select p.oid, p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as shown
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('duplicate_session', 'copy_sessions', 'duplicate_week', 'duplicate_program')
),
-- The exercises of the approved blocks that are not in the trash, each with
-- the coach of its athlete and the coach whose library its exercise is in.
slot as (
  select es.id, st.coach_id as athlete_coach, el.coach_id as library_coach,
         exists (select 1 from public.set_logs sl where sl.exercise_slot_id = es.id) as has_sets,
         p.status = 'approved' and p.deleted_at is null as in_use
    from public.exercise_slots es
    join public.exercise_library el on el.id = es.exercise_id
    join public.sessions s          on s.id = es.session_id
    join public.weeks w             on w.id = s.week_id
    join public.programs p          on p.id = w.program_id
    join public.students st         on st.id = p.student_id
)
select "check", value, expected
  from (
    values
      (1, 'running as',
          current_user::text,
          'postgres'),
      (2, 'a session is duplicated in one request (duplicate_session, P52)',
          case when exists (select 1 from f where signature = 'public.duplicate_session(uuid, text)')
               then 'yes' else 'no' end,
          'no before, yes after'),
      (3, 'sessions are copied into a phase in one request (copy_sessions, P52)',
          case when exists (select 1 from f where signature = 'public.copy_sessions(uuid[], uuid)')
               then 'yes' else 'no' end,
          'no before, yes after'),
      (4, 'a phase is duplicated in one request (duplicate_week, P52)',
          case when exists (select 1 from f where signature = 'public.duplicate_week(uuid, uuid, text)')
               then 'yes' else 'no' end,
          'no before, yes after'),
      (5, 'a block is duplicated in one request (duplicate_program, P52)',
          case when exists (select 1 from f where signature = 'public.duplicate_program(uuid, uuid, text)')
               then 'yes' else 'no' end,
          'no before, yes after'),
      (6, 'functions of these names that the migration does not know',
          (select coalesce(string_agg(n.shown, '; ' order by n.shown collate "C"), 'none')
             from named n
            where not exists (select 1 from fn where to_regprocedure(fn.signature) = n.oid)),
          'none — otherwise stop and report the line'),
      (7, 'functions of this migration a request without a session may execute',
          (select coalesce(string_agg(shown, '; ' order by shown collate "C"), 'none') from f where anon_may),
          'none, before and after'),
      (8, 'functions of this migration a signed-in user may execute',
          (select coalesce(string_agg(shown, '; ' order by shown collate "C"), 'none') from f where user_may),
          'none before; the four of them after'),
      (9, 'functions of this migration that run as their owner',
          (select coalesce(string_agg(shown, '; ' order by shown collate "C"), 'none') from f where as_owner),
          'none, before and after'),
      (10, 'functions of this migration without search_path = public, pg_temp',
          (select coalesce(string_agg(shown, '; ' order by shown collate "C"), 'none') from f where not pinned_path),
          'none, before and after'),
      (11, 'sessions without an exercise',
          (select count(*)::text
             from public.sessions s
             join public.weeks w    on w.id = s.week_id
             join public.programs p on p.id = w.program_id
            where p.status = 'approved' and p.deleted_at is null
              and s.archived_at is null
              and not exists (select 1 from public.exercise_slots es where es.session_id = s.id)),
          'information — read the page; the same before and after'),
      (12, 'exercises without a set',
          (select count(*)::text from slot where in_use and not has_sets),
          'information — read the page; the same before and after'),
      (13, 'exercises that are not in the library of their athlete''s coach',
          (select count(*)::text from slot where library_coach <> athlete_coach),
          '0 unless an athlete changed coach — a copy leaves them out; the same before and after')
  ) as t (n, "check", value, expected)
 order by n;
