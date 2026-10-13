-- Audit for 2026_10_13_16_rest_push_scheduling. Read-only, one result table.
-- Run it before applying the migration, and again after.
--
--    check                                                        before                      after
--    1 running as                                                 postgres                    postgres
--    2 the end of a rest is scheduled by the database (schedule_rest_push, P10)
--                                                                 no                          yes
--    3 functions of these names that the migration does not know  none                        none
--    4 functions of this migration a request without a session may execute
--                                                                 none                        none
--    5 functions of this migration a signed-in user may execute   none                        cancel_rest_push(uuid); schedule_rest_push(integer, jsonb, text)
--    6 functions of this migration that run as their owner        none                        cancel_rest_push(uuid); dispatch_due_rest_pushes(); schedule_rest_push(integer, jsonb, text)
--    7 functions of this migration without search_path = public, pg_temp
--                                                                 none                        none
--    8 what the status of a rest push can be                      canceled, failed, pending, sent
--                                                                                             canceled, expired, failed, pending, sending, sent
--    9 a rest push says which device it is for, and when it was handed over (endpoint, dispatched_at)
--                                                                 no                          yes
--   10 an account names a device of its own only (the two policies it writes through)
--                                                                 no                          yes
--   11 the function a rest push is handed to send-push with (send_push_event, migration 15)
--                                                                 yes                         yes
--   12 rest pushes, by status                                     a list                      the same, less line 13, plus what it became
--   13 rest pushes still waiting more than a minute after their time (the backlog, B14)
--                                                                 a number                    0
--   14 … of which their athlete had taken back                    a number                    0
--   15 … the oldest of them was due on                            a date, or none             none
--   16 rest pushes waiting for a time still to come, or less than a minute past
--                                                                 a number                    the rests that are running then
--   17 rest pushes older than 7 days                              a number                    the same number
--   18 who sends a rest push                                      a sentence                  the same sentence
--
-- Lines 2, 5, 6, 8, 9 and 10 are the migration: they read as the "after"
-- column once it is applied. Line 6 is meant: three of the four functions do
-- what the caller's own rights do not cover, and run as their owner;
-- claim_rest_push runs with the rights of its caller, the service role.
-- Lines 3, 8 and 11 decide whether the migration runs at all:
--    3  MUST read `none`: a function listed there has one of the four names
--       and was made by hand. Stop and report it. (Before the migration,
--       line 2 reading `yes` is the same thing.)
--    8  MUST read `canceled, failed, pending, sent` before: the migration
--       replaces that rule and refuses to replace another one.
--   11  MUST read `yes`: migration 15 is what the job hands a row over with.
-- Lines 12 to 17 are the rows. The migration deletes none of them:
--   13  rows that have been `pending` since the request that was to send them
--       ended — every rest of 150 seconds or more since the feature exists,
--       and every rest whose push failed before it could be recorded. The
--       migration closes them: `expired`, or `canceled` for those of line 14.
--       After it the line reads 0, and line 12 shows where they went.
--   14  the ones of line 13 on which the app had written canceled_at: their
--       athlete started the next set, or left the session, and the function
--       was no longer there to record it.
--   16  rests that are running while the audit is read. The migration leaves
--       them alone, and so the number is whatever is running the second time.
--   17  nothing deletes these today. From this migration on, an account's
--       rows older than 7 days go when it next rests; migration 18 brings
--       the function that removes the rest.
--   18  `the app, by calling dispatch-rest-push …` unless pg_cron is
--       installed: the job is made by migration 19, which is optional.
with fn (signature) as (
  values ('public.schedule_rest_push(integer, jsonb, text)'),
         ('public.cancel_rest_push(uuid)'),
         ('public.claim_rest_push(uuid)'),
         ('public.dispatch_due_rest_pushes()')
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
     and p.proname in ('schedule_rest_push', 'cancel_rest_push', 'claim_rest_push', 'dispatch_due_rest_pushes')
),
-- The rows, each with what the migration makes of it.
r as (
  select sp.status,
         sp.created_at,
         sp.fire_at,
         sp.canceled_at is not null as taken_back,
         sp.status = 'pending' and sp.fire_at <= now() - interval '60 seconds' as backlog
    from public.scheduled_pushes sp
),
policies as (
  select count(*) as there,
         count(*) filter (where position('push_subscriptions' in pg_get_expr(p.polwithcheck, p.polrelid)) > 0) as asking
    from pg_policy p
   where p.polrelid = to_regclass('public.scheduled_pushes')
     and p.polname in ('Insert own scheduled pushes', 'Cancel own scheduled pushes')
)
select "check", value, expected
  from (
    values
      (1, 'running as',
          current_user::text,
          'postgres'),
      (2, 'the end of a rest is scheduled by the database (schedule_rest_push, P10)',
          case when exists (select 1 from f where signature = 'public.schedule_rest_push(integer, jsonb, text)')
               then 'yes' else 'no' end,
          'no before, yes after'),
      (3, 'functions of these names that the migration does not know',
          (select coalesce(string_agg(n.shown, '; ' order by n.shown collate "C"), 'none')
             from named n
            where not exists (select 1 from fn where to_regprocedure(fn.signature) = n.oid)),
          'none — otherwise stop and report the line'),
      (4, 'functions of this migration a request without a session may execute',
          (select coalesce(string_agg(shown, '; ' order by shown collate "C"), 'none') from f where anon_may),
          'none, before and after'),
      (5, 'functions of this migration a signed-in user may execute',
          (select coalesce(string_agg(shown, '; ' order by shown collate "C"), 'none') from f where user_may),
          'none before; cancel_rest_push and schedule_rest_push after'),
      (6, 'functions of this migration that run as their owner',
          (select coalesce(string_agg(shown, '; ' order by shown collate "C"), 'none') from f where as_owner),
          'none before; all but claim_rest_push after'),
      (7, 'functions of this migration without search_path = public, pg_temp',
          (select coalesce(string_agg(shown, '; ' order by shown collate "C"), 'none') from f where not pinned_path),
          'none, before and after'),
      (8, 'what the status of a rest push can be',
          coalesce(
            (select string_agg(allowed.status[1], ', ' order by allowed.status[1] collate "C")
               from pg_constraint c
              cross join lateral regexp_matches(pg_get_constraintdef(c.oid), '''([a-z]+)''::text', 'g') as allowed (status)
              where c.conrelid = to_regclass('public.scheduled_pushes')
                and c.conname = 'scheduled_pushes_status_check' and c.contype = 'c'),
            'NOT THERE: no constraint scheduled_pushes_status_check'),
          'canceled, failed, pending, sent before — otherwise stop and report; with expired and sending after'),
      (9, 'a rest push says which device it is for, and when it was handed over (endpoint, dispatched_at)',
          case (select count(*) from pg_attribute a
                 where a.attrelid = to_regclass('public.scheduled_pushes')
                   and a.attname in ('endpoint', 'dispatched_at') and not a.attisdropped)
            when 2 then 'yes' when 0 then 'no' else 'one of the two only' end,
          'no before, yes after'),
      (10, 'an account names a device of its own only (the two policies it writes through)',
          (select case when there < 2 then 'NOT THERE: the two policies are not both there'
                       when asking = 2 then 'yes' when asking = 0 then 'no' else 'one of the two only' end
             from policies),
          'no before, yes after'),
      (11, 'the function a rest push is handed to send-push with (send_push_event, migration 15)',
          case when to_regprocedure('public.send_push_event(uuid, jsonb, jsonb)') is null then 'no' else 'yes' end,
          'yes — otherwise stop and report'),
      (12, 'rest pushes, by status',
          (select coalesce(string_agg(s.status || ' ' || s.n, ', ' order by s.status collate "C"), 'none')
             from (select status, count(*) as n from r group by status) s),
          'information; after, the rows of line 13 are expired or canceled'),
      (13, 'rest pushes still waiting more than a minute after their time (the backlog, B14)',
          (select count(*)::text from r where backlog),
          'a number before — the migration closes them; 0 after'),
      (14, '… of which their athlete had taken back',
          (select count(*)::text from r where backlog and taken_back),
          'a number before — they become canceled, the others expired; 0 after'),
      (15, '… the oldest of them was due on',
          (select coalesce(min(fire_at)::date::text, 'none') from r where backlog),
          'information'),
      (16, 'rest pushes waiting for a time still to come, or less than a minute past',
          (select count(*)::text from r where status = 'pending' and not backlog),
          'information — rests that are running; the migration leaves them alone'),
      (17, 'rest pushes older than 7 days',
          (select count(*)::text from r where created_at < now() - interval '7 days'),
          'information; the same before and after'),
      (18, 'who sends a rest push',
          case when to_regclass('cron.job') is null
               then 'the app, by calling dispatch-rest-push (pg_cron is not installed: schedule_rest_push answers mode edge)'
               else 'pg_cron is installed: the job sl-rest-push of migration 19 once it is there and active, the app until then'
          end,
          'information; the same before and after')
  ) as t (n, "check", value, expected)
 order by n;
