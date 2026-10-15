-- Audit for 2026_10_16_23_library_read_follows_program. Read-only, one result table.
-- Run it before applying the migration, and again after.
--
--    check                                                        before                      after
--    1 running as                                                 postgres                    postgres
--    2 who reads an exercise of a library (B8)                    its coach and that coach's athletes
--                                                                                             its coach, that coach's athletes, and whoever reads what uses it
--    3 functions of this migration a signed-in user may execute   none                        exercise_readable_through_use(uuid)
--    4 functions of this migration open without a session, or without search_path = public, pg_temp
--                                                                 none                        none
--    5 slots whose exercise is not in the library of the coach of their athlete
--                                                                 a number                    the same number
--    6 swaps whose exercise is not in the library of the coach of their athlete
--                                                                 a number                    the same number
--    7 goals whose exercise is not in the library of the coach of their athlete
--                                                                 a number                    the same number
--    8 athletes those belong to                                   a number                    the same number
--
-- Lines 2 and 3 are the migration: they read as the "after" column once it
-- is applied.
--    2  MUST read `its coach and that coach's athletes` before. A line that
--       starts with SOMETHING ELSE: stop and report it.
-- Lines 5 to 8 are the rows. The migration writes none of them: before it,
-- the athlete and the coach of today read those exercises without a name
-- (the app breaks on them); after it, with their name. 0 everywhere when no
-- athlete ever changed coach. The runbook page lists them.
with rule as (
  select p.polname, p.polcmd
    from pg_policy p
   where p.polrelid = 'public.exercise_library'::regclass
),
f as (
  select p.oid, p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as shown
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = 'exercise_readable_through_use'
),
slot_use as (
  select st.id as link, es.exercise_id
    from public.exercise_slots es
    join public.sessions se on se.id = es.session_id
    join public.weeks w on w.id = se.week_id
    join public.programs p on p.id = w.program_id
    join public.students st on st.id = p.student_id
    join public.exercise_library el on el.id = es.exercise_id
   where el.coach_id is distinct from st.coach_id
),
swap_use as (
  select st.id as link, d.substitute_exercise_id
    from public.slot_deviations d
    join public.exercise_slots es on es.id = d.exercise_slot_id
    join public.sessions se on se.id = es.session_id
    join public.weeks w on w.id = se.week_id
    join public.programs p on p.id = w.program_id
    join public.students st on st.id = p.student_id
    join public.exercise_library el on el.id = d.substitute_exercise_id
   where el.coach_id is distinct from st.coach_id
),
goal_use as (
  select st.id as link, g.exercise_id
    from public.goals g
    join public.students st on st.profile_id = g.student_id
    join public.exercise_library el on el.id = g.exercise_id
   where el.coach_id is distinct from st.coach_id
)
select "check", value, expected
  from (
    values
      (1, 'running as',
          current_user::text,
          'postgres'),
      (2, 'who reads an exercise of a library (B8)',
          case
            when (select string_agg(polname, ', ' order by polname) from rule where polcmd in ('r', '*'))
                 = 'Coaches manage own library, Students read their coachs library'
              then 'its coach and that coach''s athletes'
            when (select string_agg(polname, ', ' order by polname) from rule where polcmd in ('r', '*'))
                 = 'Coaches manage own library, Students read their coachs library, Users read the exercises their training uses'
              then 'its coach, that coach''s athletes, and whoever reads what uses it'
            else 'SOMETHING ELSE: ' || coalesce((select string_agg(polname, ', ' order by polname) from rule where polcmd in ('r', '*')), 'nobody')
          end,
          'its coach and that coach''s athletes before — otherwise stop and report; the other after'),
      (3, 'functions of this migration a signed-in user may execute',
          coalesce((select string_agg(shown, '; ' order by shown) from f where has_function_privilege('authenticated', f.oid, 'EXECUTE')), 'none'),
          'none before, the function after: the policy calls it with the rights of the user'),
      (4, 'functions of this migration open without a session, or without search_path = public, pg_temp',
          coalesce((select string_agg(shown, '; ' order by shown)
                      from f
                      join pg_proc p on p.oid = f.oid
                     where has_function_privilege('anon', f.oid, 'EXECUTE')
                        or not ('search_path=public, pg_temp' = any (coalesce(p.proconfig, '{}')))), 'none'),
          'none, before and after'),
      (5, 'slots whose exercise is not in the library of the coach of their athlete',
          (select count(*)::text from slot_use),
          'information; the same before and after'),
      (6, 'swaps whose exercise is not in the library of the coach of their athlete',
          (select count(*)::text from swap_use),
          'information; the same before and after'),
      (7, 'goals whose exercise is not in the library of the coach of their athlete',
          (select count(*)::text from goal_use),
          'information; the same before and after'),
      (8, 'athletes those belong to',
          (select count(distinct link)::text
             from (select link from slot_use union all select link from swap_use union all select link from goal_use) u),
          'information; the same before and after')
  ) as t (n, "check", value, expected)
 order by n;
