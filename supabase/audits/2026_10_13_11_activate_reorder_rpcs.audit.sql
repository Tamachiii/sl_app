-- Audit for 2026_10_13_11_activate_reorder_rpcs. Read-only, one result table.
-- Run it before applying the migration, and again after.
--
--    check                                                        before                      after
--    1 running as                                                 postgres                    postgres
--    2 a block is activated in one request (activate_program, P16)
--                                                                 no                          yes
--    3 the sessions of a phase are reordered in one request (reorder_sessions, P51)
--                                                                 no                          yes
--    4 the phases of a block are reordered in one request (reorder_weeks, P51)
--                                                                 no                          yes
--    5 functions of these names that the migration does not know  none                        none
--    6 functions of this migration a request without a session may execute
--                                                                 none                        none
--    7 functions of this migration a signed-in user may execute   none                        activate_program(uuid); reorder_sessions(uuid, uuid[]); reorder_weeks(uuid, uuid[])
--    8 functions of this migration that run as their owner        none                        none
--    9 functions of this migration without search_path = public, pg_temp
--                                                                 none                        none
--   10 athletes with a block and none active                      a number                    the same number
--   11 active blocks that are in the trash                        0                           0
--   12 sessions numbered 100000 or more                           0                           0
--   13 phases numbered 100000 or more                             0                           0
--
-- Lines 2 to 4 and 7 are the migration: they read as the "after" column once
-- it is applied.
-- Line 5 MUST read `none` before the migration: it refuses to run otherwise.
-- A function listed there has one of the three names and was made by hand.
-- Stop and report it. (Before the migration, lines 2 to 4 reading `yes` are
-- the same thing: the function is there and the ledger does not know why.)
-- Lines 10 to 13 are what the requests this migration replaces have left
-- behind when one of them was lost. The migration changes none of them, and
-- none of them stops it:
--   10  athletes who have at least one approved block out of the trash, and
--       none that is active. It is also what an athlete between two blocks
--       looks like — read the list with the coach
--       (docs/runbook/migrations/11-activate-reorder-rpcs.md, "Athletes
--       without an active block").
--   11  a block in the trash that still holds its athlete's one active place:
--       the athlete sees no program, and no screen shows why.
--   12  sessions an interrupted reorder left parked. Their phase can no longer
--       be reordered by the app that is deployed.
--   13  the same for the phases of a block.
with fn (signature) as (
  values ('public.activate_program(uuid)'),
         ('public.reorder_sessions(uuid, uuid[])'),
         ('public.reorder_weeks(uuid, uuid[])')
),
-- Those of the three that exist: none before the migration, all after.
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
-- Every function of public under one of the three names, whatever its
-- arguments.
named as (
  select p.oid, p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as shown
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('activate_program', 'reorder_sessions', 'reorder_weeks')
)
select "check", value, expected
  from (
    values
      (1, 'running as',
          current_user::text,
          'postgres'),
      (2, 'a block is activated in one request (activate_program, P16)',
          case when exists (select 1 from f where signature = 'public.activate_program(uuid)')
               then 'yes' else 'no' end,
          'no before, yes after'),
      (3, 'the sessions of a phase are reordered in one request (reorder_sessions, P51)',
          case when exists (select 1 from f where signature = 'public.reorder_sessions(uuid, uuid[])')
               then 'yes' else 'no' end,
          'no before, yes after'),
      (4, 'the phases of a block are reordered in one request (reorder_weeks, P51)',
          case when exists (select 1 from f where signature = 'public.reorder_weeks(uuid, uuid[])')
               then 'yes' else 'no' end,
          'no before, yes after'),
      (5, 'functions of these names that the migration does not know',
          (select coalesce(string_agg(n.shown, '; ' order by n.shown collate "C"), 'none')
             from named n
            where not exists (select 1 from fn where to_regprocedure(fn.signature) = n.oid)),
          'none — otherwise stop and report the line'),
      (6, 'functions of this migration a request without a session may execute',
          (select coalesce(string_agg(shown, '; ' order by shown collate "C"), 'none') from f where anon_may),
          'none, before and after'),
      (7, 'functions of this migration a signed-in user may execute',
          (select coalesce(string_agg(shown, '; ' order by shown collate "C"), 'none') from f where user_may),
          'none before; the three of them after'),
      (8, 'functions of this migration that run as their owner',
          (select coalesce(string_agg(shown, '; ' order by shown collate "C"), 'none') from f where as_owner),
          'none, before and after'),
      (9, 'functions of this migration without search_path = public, pg_temp',
          (select coalesce(string_agg(shown, '; ' order by shown collate "C"), 'none') from f where not pinned_path),
          'none, before and after'),
      (10, 'athletes with a block and none active',
          (select count(*)::text
             from public.students st
            where exists (select 1 from public.programs p
                           where p.student_id = st.id and p.deleted_at is null and p.status = 'approved')
              and not exists (select 1 from public.programs p
                               where p.student_id = st.id and p.is_active and p.deleted_at is null)),
          'information — read the list with the coach; the same before and after'),
      (11, 'active blocks that are in the trash',
          (select count(*)::text
             from public.programs p
            where p.is_active and p.deleted_at is not null),
          '0 — otherwise read the page; the same before and after'),
      (12, 'sessions numbered 100000 or more',
          (select count(*)::text from public.sessions s where s.sort_order >= 100000),
          '0 — otherwise read the page; the same before and after'),
      (13, 'phases numbered 100000 or more',
          (select count(*)::text from public.weeks w where w.week_number >= 100000),
          '0 — otherwise read the page; the same before and after')
  ) as t (n, "check", value, expected)
 order by n;
