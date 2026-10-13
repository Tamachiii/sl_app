-- Audit for 2026_10_13_19_pg_cron_jobs. Read-only, one result table.
-- Run it before applying the migration, and again after — and whenever you
-- want to know whether the jobs run: lines 13 and 17.
--
--    check                                                        before                      after
--    1 running as                                                 postgres                    postgres
--    2 pg_cron, the extension the jobs need                       a version, 1.5 or later     the same
--    3 what the jobs run is there (dispatch_due_rest_pushes, run_retention: migrations 16 and 18)
--                                                                 yes                         yes
--    4 the push requests that failed are written down (record_push_failures, P35)
--                                                                 no                          yes
--    5 functions of that name that the migration does not know    none                        none
--    6 who may execute it, besides its owner                      it is not there             service_role
--    7 it runs with the rights of                                 it is not there             its caller
--    8 its search_path                                            it is not there             public, pg_temp
--    9 the jobs of this migration                                 none                        sl-cron-history, sl-push-failures, sl-rest-push, sl-retention
--   10 … each as the migration makes it: its schedule, its command, switched on, of postgres, in this database
--                                                                 there is none               yes
--   11 other jobs of pg_cron in this project                      none                        none
--   12 who sends a rest push
--        before  the app, by calling dispatch-rest-push (no job named sl-rest-push is switched on: schedule_rest_push answers mode edge)
--        after   the job sl-rest-push, every ten seconds (schedule_rest_push answers mode cron)
--   13 the last run of each job
--        before  there is no job
--        after   sl-cron-history: no run yet; sl-push-failures: no run yet; sl-rest-push: no run yet; sl-retention: no run yet
--   14 rest pushes that are waiting for their time                a number                    a number
--   15 runs pg_cron remembers                                     a number                    a number
--   16 … of which older than the three days sl-cron-history keeps a number                    a number
--   17 what the push requests of the last hours were answered     a sentence                  a sentence
--
-- Line 2 is the choice. `not installed` is not an error: the migration is
-- optional, it refuses to run (SLM06), and the project goes on without it —
-- lines 9 to 13, 15 and 16 then have nothing to say.
-- Lines 3 and 5 decide whether the migration runs at all:
--    3  MUST read `yes`: otherwise migration 16 or 18 is not in this
--       database.
--    5  MUST read `none`: a function listed there is named
--       record_push_failures and was made by hand. Stop and report it.
--       (Before the migration, line 4 reading `yes` is the same thing.)
--    9  MUST read `none` before: a job listed there has one of the four
--       names and was made by hand. Stop and report it.
-- Lines 4, 6 to 10 and 12 are the migration: they read as the "after" column
-- once it is applied.
--   10  anything else than `yes` after the migration names the job and what
--       is not as it was made: `sl-rest-push: switched off`.
--   12  `the app, …` before — with `(pg_cron is not installed: …)` between
--       the brackets where the extension is not there, the sentence of line
--       18 of the audit of migration 16 —, `the job …` once sl-rest-push is
--       there and switched on.
--   13  THE PROOF THAT pg_cron RUNS THEM. Right after the migration every job
--       reads `no run yet`; a minute later sl-rest-push reads `succeeded N s
--       ago`, and stays under 20 s for as long as the job runs. `failed`
--       says so, with what pg_cron was told.
--   14  what the job, or the Edge Function the app called, is about to send.
--       Before a ROLLBACK it is what may lose its sender: see the header of
--       the rollback file.
--   15  one row per run: sl-rest-push alone writes 8,640 a day.
--   16  what tonight's run of sl-cron-history deletes.
--   17  pg_net keeps what each request was answered for six hours. `n of
--       them failed` is what record_push_failures writes down, hour by hour,
--       once an hour is over — and it says so with or without the migration.
with can as (
  -- What this role may look at. Each question is asked before the one that
  -- would fail without its answer: a schema that is not there, then a schema
  -- that may not be used, then the table.
  select (select e.extversion from pg_extension e where e.extname = 'pg_cron') as version,
         case when to_regnamespace('cron') is null then false
              when not has_schema_privilege(to_regnamespace('cron')::oid, 'USAGE') then false
              else coalesce(has_table_privilege(to_regclass('cron.job'), 'SELECT'), false)
         end as reads_jobs,
         case when to_regnamespace('cron') is null then false
              when not has_schema_privilege(to_regnamespace('cron')::oid, 'USAGE') then false
              else coalesce(has_table_privilege(to_regclass('cron.job'), 'SELECT')
                            and has_table_privilege(to_regclass('cron.job_run_details'), 'SELECT'), false)
         end as reads_runs,
         case when to_regnamespace('net') is null then false
              when not has_schema_privilege(to_regnamespace('net')::oid, 'USAGE') then false
              else coalesce(has_table_privilege(to_regclass('net._http_response'), 'SELECT'), false)
         end as reads_answers
),
-- The tables of pg_cron are not there in a project without the extension, and
-- a query that names one would not even start. So they are read through
-- query_to_xml, which takes its query as text — and gets one that reads
-- nothing where the table is not there to read.
jobs as (
  select j.jobid, j.jobname, j.schedule, j.command, j.active, j.username, j.database
    from can
   cross join lateral xmltable('/table/row' passing query_to_xml(
           case when can.reads_jobs
                then $q$select jobid, jobname, schedule, command, active, username, database from cron.job$q$
                else $q$select 1 where false$q$
           end, false, false, '')
         columns jobid bigint path 'jobid', jobname text path 'jobname', schedule text path 'schedule',
                 command text path 'command', active boolean path 'active', username text path 'username',
                 database text path 'database') as j
),
-- The most recent run of each job.
last_runs as (
  select r.jobid, r.status, r.message, r.seconds_ago
    from can
   cross join lateral xmltable('/table/row' passing query_to_xml(
           case when can.reads_runs
                then $q$select d.jobid, d.status, left(d.return_message, 120) as message,
                               extract(epoch from now() - coalesce(d.end_time, d.start_time))::bigint as seconds_ago
                          from cron.job_run_details d
                         where d.runid in (select max(k.runid) from cron.job_run_details k group by k.jobid)$q$
                else $q$select 1 where false$q$
           end, false, false, '')
         columns jobid bigint path 'jobid', status text path 'status', message text path 'message',
                 seconds_ago bigint path 'seconds_ago') as r
),
-- How many runs pg_cron remembers, and how many the nightly job deletes: the
-- condition of sl-cron-history, word for word.
history as (
  select h.runs, h.old
    from can
   cross join lateral xmltable('/table/row' passing query_to_xml(
           case when can.reads_runs
                then $q$select count(*) as runs,
                               count(*) filter (where runid < (select coalesce(min(runid), 0) from cron.job_run_details
                                                                where end_time >= now() - interval '3 days')) as old
                          from cron.job_run_details$q$
                else $q$select 1 where false$q$
           end, false, false, '')
         columns runs bigint path 'runs', old bigint path 'old') as h
),
-- What pg_net was answered: a request failed when it was not answered with a
-- status between 200 and 299 — the condition of record_push_failures.
answers as (
  select a.answered, a.failed
    from can
   cross join lateral xmltable('/table/row' passing query_to_xml(
           case when can.reads_answers
                then $q$select count(*) as answered,
                               count(*) filter (where (timed_out is not true and status_code between 200 and 299
                                                       and error_msg is null) is not true) as failed
                          from net._http_response$q$
                else $q$select 1 where false$q$
           end, false, false, '')
         columns answered bigint path 'answered', failed bigint path 'failed') as a
),
-- The four jobs, as the migration makes them.
meant (jobname, schedule, command) as (
  values ('sl-rest-push',     '10 seconds', 'select public.dispatch_due_rest_pushes()'),
         ('sl-retention',     '17 3 * * *', 'select public.run_retention()'),
         ('sl-push-failures', '7 * * * *',  'select public.record_push_failures()'),
         ('sl-cron-history',  '47 3 * * *', $c$delete from cron.job_run_details where runid < (select coalesce(min(runid), 0) from cron.job_run_details where end_time >= now() - interval '3 days')$c$)
),
judged as (
  select m.jobname,
         count(j.jobid) as there,
         concat_ws(', ',
           case when count(j.jobid) > 1 then count(j.jobid) || ' jobs of that name' end,
           'another schedule (' || string_agg(distinct j.schedule, ', ') filter (where j.schedule <> m.schedule) || ')',
           case when bool_or(j.command <> m.command) then 'another command' end,
           case when bool_or(not j.active) then 'switched off' end,
           'of ' || string_agg(distinct j.username, ', ') filter (where j.username <> current_user),
           'in the database ' || string_agg(distinct j.database, ', ') filter (where j.database <> current_database())
         ) as wrong
    from meant m
    left join jobs j on j.jobname = m.jobname
   group by m.jobname
),
f as (
  select p.oid,
         p.proowner,
         p.prosecdef,
         p.proconfig,
         coalesce(p.proacl, acldefault('f', p.proowner)) as acl
    from pg_proc p
   where p.oid = to_regprocedure('public.record_push_failures()')
),
-- Every function of public under that name, whatever its arguments.
named as (
  select p.oid, p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as shown
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname = 'record_push_failures'
),
-- A duration in the unit that reads best.
ago as (
  select r.jobid, r.status, r.message,
         case when r.seconds_ago is null then 'at a time pg_cron did not note'
              when r.seconds_ago < 120 then r.seconds_ago || ' s ago'
              when r.seconds_ago < 7200 then (r.seconds_ago / 60) || ' min ago'
              when r.seconds_ago < 172800 then (r.seconds_ago / 3600) || ' h ago'
              else (r.seconds_ago / 86400) || ' days ago'
         end as shown
    from last_runs r
)
select "check", value, expected
  from (
    values
      (1, 'running as',
          current_user::text,
          'postgres'),
      (2, 'pg_cron, the extension the jobs need',
          coalesce((select version from can), 'not installed'),
          'a version, 1.5 or later — `not installed` is the choice not to use it: the migration then refuses to run'),
      (3, 'what the jobs run is there (dispatch_due_rest_pushes, run_retention: migrations 16 and 18)',
          case when to_regprocedure('public.dispatch_due_rest_pushes()') is not null
                and to_regprocedure('public.run_retention()') is not null
               then 'yes'
               else 'NO: ' || concat_ws(' and ',
                      case when to_regprocedure('public.dispatch_due_rest_pushes()') is null then 'dispatch_due_rest_pushes is not there' end,
                      case when to_regprocedure('public.run_retention()') is null then 'run_retention is not there' end)
          end,
          'yes — otherwise apply migrations 16 and 18 first'),
      (4, 'the push requests that failed are written down (record_push_failures, P35)',
          case when exists (select 1 from f) then 'yes' else 'no' end,
          'no before, yes after'),
      (5, 'functions of that name that the migration does not know',
          (select coalesce(string_agg(n.shown, '; ' order by n.shown collate "C"), 'none')
             from named n
            where n.oid is distinct from to_regprocedure('public.record_push_failures()')),
          'none — otherwise stop and report the line'),
      (6, 'who may execute it, besides its owner',
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
      (7, 'it runs with the rights of',
          coalesce((select case when f.prosecdef then 'its owner' else 'its caller' end from f), 'it is not there'),
          'it is not there before; its caller after'),
      (8, 'its search_path',
          coalesce(
            (select coalesce(
                      (select substring(setting from '^search_path=(.*)$')
                         from unnest(f.proconfig) as setting
                        where setting like 'search_path=%'),
                      'NOT SET')
               from f),
            'it is not there'),
          'it is not there before; public, pg_temp after'),
      (9, 'the jobs of this migration',
          (select coalesce(string_agg(d.jobname, ', ' order by d.jobname collate "C"), 'none')
             from judged d where d.there > 0),
          'none before — otherwise stop and report the line; the four names after'),
      (10, '… each as the migration makes it: its schedule, its command, switched on, of postgres, in this database',
          case when not exists (select 1 from judged d where d.there > 0) then 'there is none'
               when not exists (select 1 from judged d where d.there = 0 or d.wrong <> '') then 'yes'
               else (select string_agg(d.jobname || ': ' || case when d.there = 0 then 'missing' else d.wrong end,
                                       '; ' order by d.jobname collate "C")
                       from judged d where d.there = 0 or d.wrong <> '')
          end,
          'there is none before; yes after — otherwise the line says which job, and what'),
      (11, 'other jobs of pg_cron in this project',
          (select coalesce(string_agg(coalesce(j.jobname, 'job ' || j.jobid), ', '
                                      order by coalesce(j.jobname, 'job ' || j.jobid) collate "C"), 'none')
             from jobs j
            where j.jobname is null or j.jobname not in (select m.jobname from meant m)),
          'information: they are not this migration''s, and it leaves them alone'),
      (12, 'who sends a rest push',
          case when not (select reads_jobs from can)
                 then 'the app, by calling dispatch-rest-push (pg_cron is not installed: schedule_rest_push answers mode edge)'
               when exists (select 1 from jobs j where j.jobname = 'sl-rest-push' and j.active)
                 then 'the job sl-rest-push, every ten seconds (schedule_rest_push answers mode cron)'
               else 'the app, by calling dispatch-rest-push (no job named sl-rest-push is switched on: schedule_rest_push answers mode edge)'
          end,
          'the app before; the job after'),
      (13, 'the last run of each job',
          case when not exists (select 1 from judged d where d.there > 0) then 'there is no job'
               else (select string_agg(
                              j.jobname || ': ' || coalesce(
                                a.status || ' ' || a.shown
                                  || case when a.status = 'failed' then coalesce(' (' || a.message || ')', '') else '' end,
                                'no run yet'),
                              '; ' order by j.jobname collate "C")
                       from jobs j
                       left join ago a on a.jobid = j.jobid
                      where j.jobname in (select m.jobname from meant m))
          end,
          'there is no job before; no run yet right after; a minute later sl-rest-push reads succeeded, a few seconds ago'),
      (14, 'rest pushes that are waiting for their time',
          (select count(*)::text
             from public.scheduled_pushes sp
            where sp.status = 'pending' and sp.canceled_at is null
              and sp.fire_at > now() - interval '60 seconds'),
          'information: the rests that are running right now'),
      (15, 'runs pg_cron remembers',
          coalesce((select h.runs::text from history h), 'pg_cron is not installed'),
          'information'),
      (16, '… of which older than the three days sl-cron-history keeps',
          coalesce((select h.old::text from history h), 'pg_cron is not installed'),
          'information: what tonight''s run of that job deletes'),
      (17, 'what the push requests of the last hours were answered',
          coalesce(
            (select case when a.answered = 0 then 'no request in the hours pg_net keeps'
                         else a.answered || ' requests, ' || a.failed || ' of them failed' end
               from answers a),
            'net._http_response cannot be read by this role'),
          'information: pg_net keeps six hours of them')
  ) as t (n, "check", value, expected)
 order by n;
