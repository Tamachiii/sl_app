-- Audit for 2026_10_13_18_retention. Read-only, one result table.
-- Run it before applying the migration, and again after — and, from then on,
-- before each run of run_retention(): lines 8, 12 and 15 are what that run
-- deletes.
--
--    check                                                        before                      after
--    1 running as                                                 postgres                    postgres
--    2 the rows nobody reads any more are deleted by one function (run_retention, L27)
--                                                                 no                          yes
--    3 functions of that name that the migration does not know    none                        none
--    4 who may execute it, besides its owner                      it is not there             service_role
--    5 it runs with the rights of                                 it is not there             its caller
--    6 its search_path                                            it is not there             public, pg_temp
--    7 rest pushes                                                a number                    the same number
--    8 rest pushes created more than 7 days ago: what a run deletes
--                                                                 a number                    the same number
--    9 … the oldest of them is from                               a date, or none             the same
--   10 rest pushes created more than 7 days ago that are still to be sent: kept
--                                                                 0                           0
--   11 notifications                                              a sentence                  the same sentence
--   12 notifications read more than 90 days ago: what a run deletes
--                                                                 a number                    the same number
--   13 notifications never read that are older than 90 days: kept a number                    the same number
--   14 client errors                                              a number                    the same number
--   15 client errors older than 90 days: what a run deletes       a number                    the same number
--   16 who runs it                                                a sentence                  the same sentence
--
-- Lines 2, 4, 5 and 6 are the migration: they read as the "after" column
-- once it is applied. Line 3 decides whether the migration runs at all:
--    3  MUST read `none`: a function listed there is named run_retention and
--       was made by hand. Stop and report it. (Before the migration, line 2
--       reading `yes` is the same thing.)
-- Lines 7 to 15 are the rows. THE MIGRATION DELETES NONE OF THEM: every
-- number is the same before and after it. A RUN of the function deletes the
-- rows of lines 8, 12 and 15 — after it those three read 0, and lines 7, 11
-- and 14 are smaller by as much.
--    8  sent, failed, taken back, expired, or left waiting long after their
--       time. On the first run this is nearly the whole table: nothing has
--       deleted a row of it so far.
--   10  a row a week old that is waiting for a time still to come, or less
--       than a minute past. No rest lasts that long: it was written by the
--       app from before wave 3 on a phone whose clock is days ahead. It is
--       kept until its time has passed, and goes with the run after.
--   12  by the time they were READ. A line marked as read today stays 90
--       days, however old it is.
--   13  lines that are still on their account's bell. Never deleted.
--   16  `nobody by itself: …` unless pg_cron is installed: the nightly job is
--       made by migration 19, which is optional.
with f as (
  select p.oid,
         p.proowner,
         p.prosecdef,
         p.proconfig,
         coalesce(p.proacl, acldefault('f', p.proowner)) as acl
    from pg_proc p
   where p.oid = to_regprocedure('public.run_retention()')
),
-- Every function of public under that name, whatever its arguments.
named as (
  select p.oid, p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as shown
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname = 'run_retention'
),
-- The rest pushes, each with what a run makes of it: the conditions of the
-- function, word for word.
pushes as (
  select sp.created_at,
         sp.created_at < now() - interval '7 days' as old,
         sp.status = 'pending' and sp.canceled_at is null
           and sp.fire_at > now() - interval '60 seconds' as to_be_sent
    from public.scheduled_pushes sp
),
notes as (
  select n.read_at is not null as is_read,
         n.read_at is not null and n.read_at < now() - interval '90 days' as read_long_ago,
         n.read_at is null and n.created_at < now() - interval '90 days' as unread_and_old
    from public.notifications n
),
errors as (
  select ce.created_at < now() - interval '90 days' as old
    from public.client_errors ce
)
select "check", value, expected
  from (
    values
      (1, 'running as',
          current_user::text,
          'postgres'),
      (2, 'the rows nobody reads any more are deleted by one function (run_retention, L27)',
          case when exists (select 1 from f) then 'yes' else 'no' end,
          'no before, yes after'),
      (3, 'functions of that name that the migration does not know',
          (select coalesce(string_agg(n.shown, '; ' order by n.shown collate "C"), 'none')
             from named n
            where n.oid is distinct from to_regprocedure('public.run_retention()')),
          'none — otherwise stop and report the line'),
      (4, 'who may execute it, besides its owner',
          coalesce(
            (select coalesce(string_agg(g.name, ', ' order by g.name collate "C"), 'nobody')
               from f
               left join lateral (
                 select distinct case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee)::text end as name
                   from aclexplode(f.acl) a
                  where a.privilege_type = 'EXECUTE' and a.grantee <> f.proowner
               ) g on true
              group by f.oid),
            'it is not there'),
          'it is not there before; service_role after, and nobody else'),
      (5, 'it runs with the rights of',
          coalesce((select case when f.prosecdef then 'its owner' else 'its caller' end from f), 'it is not there'),
          'it is not there before; its caller after'),
      (6, 'its search_path',
          coalesce(
            (select coalesce(
                      (select substring(setting from '^search_path=(.*)$')
                         from unnest(f.proconfig) as setting
                        where setting like 'search_path=%'),
                      'NOT SET')
               from f),
            'it is not there'),
          'it is not there before; public, pg_temp after'),
      (7, 'rest pushes',
          (select count(*)::text from pushes),
          'information; the same before and after the migration'),
      (8, 'rest pushes created more than 7 days ago: what a run deletes',
          (select count(*)::text from pushes where old and not to_be_sent),
          'information; the same before and after the migration, 0 after a run'),
      (9, '… the oldest of them is from',
          (select coalesce(min(created_at)::date::text, 'none') from pushes where old and not to_be_sent),
          'information'),
      (10, 'rest pushes created more than 7 days ago that are still to be sent: kept',
          (select count(*)::text from pushes where old and to_be_sent),
          '0 — otherwise a phone whose clock is days ahead: the runbook page says what it means'),
      (11, 'notifications',
          (select count(*) || ', ' || count(*) filter (where is_read) || ' of them read' from notes),
          'information; the same before and after the migration'),
      (12, 'notifications read more than 90 days ago: what a run deletes',
          (select count(*)::text from notes where read_long_ago),
          'information; the same before and after the migration, 0 after a run'),
      (13, 'notifications never read that are older than 90 days: kept',
          (select count(*)::text from notes where unread_and_old),
          'information; never deleted'),
      (14, 'client errors',
          (select count(*)::text from errors),
          'information; the same before and after the migration'),
      (15, 'client errors older than 90 days: what a run deletes',
          (select count(*)::text from errors where old),
          'information; the same before and after the migration, 0 after a run'),
      (16, 'who runs it',
          case when to_regclass('cron.job') is null
               then 'nobody by itself: the owner, once a month (pg_cron is not installed)'
               else 'pg_cron is installed: the nightly job of migration 19 once it is there and active, the owner once a month until then'
          end,
          'information; the same before and after')
  ) as t (n, "check", value, expected)
 order by n;
