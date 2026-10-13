-- ============================================================
-- 19 — Where pg_cron is switched on, four jobs do what otherwise waits for
--      the app or for the owner: a rest push is handed over by the database,
--      the rows nobody reads go every night, the push requests that failed
--      are written down every hour
-- wave 2 · Checkpoint B · OPTIONAL · the scheduled halves of P10, L27 and P35
--
-- THIS FILE IS A CHOICE. It needs the extension pg_cron, which the owner of
-- the project switches on (Dashboard → Database → Extensions) or does not.
-- Without the extension the file refuses (SLM06) and changes nothing — and
-- nothing is missing: migrations 15 to 18 and the Edge Functions of wave 2
-- are complete without it.
--
--                    without this file              with it
--   a rest push      the app calls the              the database hands it to
--                    dispatch-rest-push function,   send-push ten seconds
--                    which waits, in hops, until    before its time; the app
--                    the time has come              has nothing more to do
--   old rows         the owner runs                 every night
--                    run_retention() once a month
--   a push request   in the log of the function,    one line an hour in the
--   that failed      for whoever goes and looks     coach's list of errors
--
-- WHAT IT MAKES. One function, and four jobs of pg_cron:
--
--   sl-rest-push       every 10 seconds   select public.dispatch_due_rest_pushes()
--       Migration 16 wrote the function for this job: it closes the rest
--       pushes that are more than a minute late and hands each one due within
--       ten seconds to send-push, once, with the time not to send before.
--       While this job is there and active, schedule_rest_push answers
--       mode 'cron' — the NAME of the job is that contract.
--   sl-retention       every night, 03:17 UTC   select public.run_retention()
--       Migration 18: rest pushes older than 7 days, notifications read more
--       than 90 days ago, client errors older than 90 days.
--   sl-push-failures   every hour, at :07   select public.record_push_failures()
--       The function of this file, below.
--   sl-cron-history    every night, 03:47 UTC
--       pg_cron keeps one row per run of a job (cron.job_run_details), and
--       nothing of its own deletes one: sl-rest-push alone writes 8,640 a
--       day. This job keeps three days of them.
--
-- A job runs as the role that made it — postgres, who runs this file — in
-- this database.
--
-- BEFORE IT, IN THIS ORDER: migrations 15 to 18, then the two Edge Functions
-- of wave 2, then the extension, then this file. NEVER BEFORE THE send-push OF
-- WAVE 2 IS DEPLOYED: the job hands a rest push over ten seconds early, with
-- the time not to send before. The send-push from before wave 2 does not know
-- that: it would ring every device of the athlete at once, ten seconds early,
-- and the Edge Function the app called would ring them again at the time.
-- Nothing in the database can tell which send-push is deployed.
--
-- WHAT A CLIENT SEES.
--   * The app that is deployed, and every app before wave 3: nothing. It
--     writes its rest push itself and calls dispatch-rest-push whatever the
--     mode. The job hands the same row to send-push; whoever sends asks
--     claim_rest_push first, which answers a row once: one notification.
--   * The app of wave 3: it stops calling the Edge Function while the answer
--     is mode 'cron'. A rest of any length up to 15 minutes rings without it.
--   * The coach's list of errors (the bottom of the roster) can show lines
--     the database wrote: "DATABASE — Push: 3 of 41 requests … failed".
--   * FROM THE FIRST NIGHT ON, what run_retention() deletes is deleted
--     without anybody asking: on the first night nearly every rest push
--     there is, the notifications read more than 90 days ago, the client
--     errors older than 90 days. Lines 8, 12 and 15 of the audit of
--     migration 18 count them. Those rows do not come back.
--
-- Backward compatible: yes, with every client ever deployed — given the two
-- Edge Functions of wave 2.
-- Audit:    supabase/audits/2026_10_13_19_pg_cron_jobs.audit.sql
-- Rollback: supabase/rollbacks/2026_10_13_19_pg_cron_jobs.down.sql
-- Runbook:  docs/runbook/migrations/19-pg-cron-jobs.md, and the decision
--           itself in docs/runbook/50-pg-cron.md
-- ============================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
DECLARE
  v_list    text;
  v_version text;
BEGIN
  -- First of all, because no other role can even look at the ledger. A job
  -- runs as the role that made it, and what is created below must belong to
  -- the role that owns the tables.
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'migration 2026_10_13_19_pg_cron_jobs must be run as postgres, not as %', current_user
      USING HINT = 'Run it from the SQL editor or with `supabase db query --linked`. Nothing was changed.';
  END IF;

  -- Asked before the ledger is read: without it the answer would be
  -- "relation does not exist" instead of this one.
  IF to_regclass('app_private.app_migrations') IS NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_19_pg_cron_jobs needs 2026_10_13_18_retention, which is not applied'
      USING ERRCODE = 'SLM02', HINT = 'Apply migrations 01 to 18 first. Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_13_19_pg_cron_jobs') THEN
    RAISE EXCEPTION 'migration 2026_10_13_19_pg_cron_jobs is already applied'
      USING ERRCODE = 'SLM01', HINT = 'Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_13_18_retention') THEN
    RAISE EXCEPTION 'migration 2026_10_13_19_pg_cron_jobs needs 2026_10_13_18_retention, which is not applied'
      USING ERRCODE = 'SLM02', HINT = 'Apply that file first. Nothing was changed.';
  END IF;

  -- THE CHOICE. Nothing below is asked of a project that does not have the
  -- extension: this is where the file stops for it.
  SELECT e.extversion INTO v_version FROM pg_extension e WHERE e.extname = 'pg_cron';
  IF v_version IS NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_19_pg_cron_jobs needs the extension pg_cron, which is not switched on in this project'
      USING ERRCODE = 'SLM06',
            HINT = 'This migration is optional, and nothing is missing without it: a rest push is sent through the dispatch-rest-push Edge Function, and run_retention() is run by hand once a month. To use it, switch pg_cron on (Dashboard, Database, Extensions) and run this file again. Nothing was changed.';
  END IF;
  -- A job every ten seconds is what hands the rest pushes over, and pg_cron
  -- runs one only since 1.5.
  IF v_version ~ '^[0-9]+[.][0-9]+'
     AND string_to_array(substring(v_version from '^[0-9]+[.][0-9]+'), '.')::integer[] < ARRAY[1, 5] THEN
    RAISE EXCEPTION 'migration 2026_10_13_19_pg_cron_jobs needs pg_cron 1.5 or later, and this project has %', v_version
      USING HINT = 'Before 1.5 pg_cron does not run a job more often than once a minute. Nothing was changed. Stop and report.';
  END IF;

  -- What the jobs are made with, what they run and what they read: asked, not
  -- assumed. The schema is pg_cron's, its tables and functions are given to
  -- postgres by the platform, and the body of a function is not checked
  -- against the database when it is created — a table that cannot be read
  -- would be found by the first run, an hour from now.
  IF to_regnamespace('cron') IS NULL OR NOT has_schema_privilege(to_regnamespace('cron')::oid, 'USAGE') THEN
    RAISE EXCEPTION 'migration 2026_10_13_19_pg_cron_jobs may not use the schema cron of pg_cron as %', current_user
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;
  IF to_regnamespace('net') IS NULL OR NOT has_schema_privilege(to_regnamespace('net')::oid, 'USAGE') THEN
    RAISE EXCEPTION 'migration 2026_10_13_19_pg_cron_jobs may not use the schema net of pg_net as %', current_user
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;
  SELECT string_agg(w.what, ', ' ORDER BY w.n)
    INTO v_list
    FROM (VALUES
      (1, 'cron.schedule(text, text, text), to execute',
          COALESCE(has_function_privilege(to_regprocedure('cron.schedule(text, text, text)'), 'EXECUTE'), false)),
      (2, 'cron.unschedule(text), to execute',
          COALESCE(has_function_privilege(to_regprocedure('cron.unschedule(text)'), 'EXECUTE'), false)),
      (3, 'cron.job, to read',
          COALESCE(has_table_privilege(to_regclass('cron.job'), 'SELECT'), false)),
      (4, 'cron.job_run_details, to read and to delete from',
          COALESCE(has_table_privilege(to_regclass('cron.job_run_details'), 'SELECT')
                   AND has_table_privilege(to_regclass('cron.job_run_details'), 'DELETE'), false)),
      (5, 'net._http_response, to read',
          COALESCE(has_table_privilege(to_regclass('net._http_response'), 'SELECT'), false)),
      (6, 'public.dispatch_due_rest_pushes() (migration 16)',
          to_regprocedure('public.dispatch_due_rest_pushes()') IS NOT NULL),
      (7, 'public.run_retention() (migration 18)',
          to_regprocedure('public.run_retention()') IS NOT NULL)
    ) AS w (n, what, there)
   WHERE NOT w.there;
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_19_pg_cron_jobs does not find what its jobs are made of, or may not use it as %: %', current_user, v_list
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;

  SELECT string_agg(w.what, ', ' ORDER BY w.what)
    INTO v_list
    FROM (VALUES ('cron.job.jobname'),
                 ('cron.job.schedule'),
                 ('cron.job.command'),
                 ('cron.job.active'),
                 ('cron.job.username'),
                 ('cron.job.database'),
                 ('cron.job_run_details.runid'),
                 ('cron.job_run_details.end_time'),
                 ('net._http_response.created'),
                 ('net._http_response.status_code'),
                 ('net._http_response.timed_out'),
                 ('net._http_response.error_msg'),
                 ('public.client_errors.user_id'),
                 ('public.client_errors.role'),
                 ('public.client_errors.message'),
                 ('public.client_errors.stack'),
                 ('public.client_errors.url'),
                 ('public.client_errors.user_agent')
         ) AS w (what)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = to_regclass(substring(w.what from '^(.*)[.][^.]+$'))
        AND a.attname = substring(w.what from '[.]([^.]+)$') AND NOT a.attisdropped
   );
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_19_pg_cron_jobs does not find the columns its function and its jobs are written with: %', v_list
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;

  -- The function is CREATED, not replaced. One that is there already under
  -- that name — without arguments or with some — was made by hand, and the
  -- job that calls `record_push_failures` may reach the wrong one.
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text)
    INTO v_list
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = 'record_push_failures';
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_19_pg_cron_jobs would not create: % is already there', v_list
      USING HINT = 'A function of this file exists, made by hand or by a file that is not in the ledger. Nothing was changed. Stop and report.';
  END IF;

  -- A job of one of the four names, whoever made it. cron.schedule would
  -- change the schedule and the command of one of postgres and leave it
  -- switched off if it was; one of another role would run next to the new
  -- one — and schedule_rest_push answers mode 'cron' for the name alone.
  SELECT string_agg(format('%s (of %s%s)', j.jobname, j.username, CASE WHEN j.active THEN '' ELSE ', switched off' END),
                    ', ' ORDER BY j.jobname, j.username)
    INTO v_list
    FROM cron.job j
   WHERE j.jobname IN ('sl-rest-push', 'sl-retention', 'sl-push-failures', 'sl-cron-history');
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_19_pg_cron_jobs would not schedule: a job named % is already there', v_list
      USING HINT = 'A job of this file exists, made by hand or by a file that is not in the ledger. Nothing was changed. Stop and report.';
  END IF;
END
$guard$;

-- ------------------------------------------------------------
-- The push requests that failed, written down where the coach reads.
-- ------------------------------------------------------------
--   returns   { "hours": n, "failed": n } — the hours this run wrote a line
--             for, and the requests those lines count. Keys are added, never
--             renamed.
--
-- A push leaves the database as a request of pg_net to the send-push Edge
-- Function (send_push_event, migration 15), sent once the transaction has
-- committed, and nobody reads what came back: pg_net keeps each answer in
-- net._http_response for six hours and then deletes it. A key that was
-- rotated on one side only, a function that is down, a time limit that is
-- passed — each is a push nobody got, and nothing on any screen says so
-- (review P35).
--
-- This function reads those answers and writes ONE LINE PER HOUR in which a
-- request failed into client_errors — the list at the bottom of the coach's
-- roster, which is where the app's own errors already are:
--
--     role     'database'
--     message  'Push: 3 of 41 requests the database sent to send-push failed
--               between 2026-10-13 14:00 and 15:00 UTC — 2 × HTTP 502,
--               1 × no answer in time'
--     url      'pg_net 2026-10-13T14:00Z' — which hour; it is also what keeps
--              a second run from writing that hour again
--
-- A REQUEST FAILED when it was not answered with a status between 200 and
-- 299: another status ('HTTP 502'), no answer within the ten seconds
-- send_push_event gives ('no answer in time'), no answer at all ('no answer',
-- with what pg_net says of it: the name that did not resolve, the connection
-- that was refused). What send-push ANSWERED is not copied — the body may
-- name a device: it is in the log of the function.
--
-- ONLY HOURS THAT ARE OVER, so that an hour is counted whole and once; and
-- every such hour pg_net still holds, so that a run that was missed is caught
-- up by the next one, up to the six hours pg_net keeps.
--
-- Every request of pg_net is counted: in this database send_push_event is
-- the one function that makes any (supabase/tests/push-plumbing.test.js). A
-- database webhook added in the dashboard would be counted with them.
--
-- SECURITY INVOKER, and for no client: it reads a table of pg_net and writes
-- a line no signed-in user may write (the policy of client_errors lets an
-- account report as itself, and under its own role). The job runs it as
-- postgres. It is not given to `authenticated`, and must not be.
CREATE FUNCTION public.record_push_failures()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_hour   record;
  v_key    text;
  v_hours  integer := 0;
  v_failed integer := 0;
BEGIN
  -- One run at a time: a run that waited here reads the lines of the one
  -- before it, and writes none of them again.
  PERFORM pg_advisory_xact_lock(hashtextextended('sl_app.record_push_failures', 0));

  FOR v_hour IN
    WITH answered AS (
      SELECT date_trunc('hour', r.created, 'UTC') AS hour,
             CASE
               WHEN r.timed_out IS TRUE THEN 'no answer in time'
               WHEN r.status_code BETWEEN 200 AND 299 AND r.error_msg IS NULL THEN NULL
               WHEN r.status_code IS NOT NULL THEN 'HTTP ' || r.status_code
               ELSE 'no answer' || COALESCE(' (' || left(r.error_msg, 80) || ')', '')
             END AS failure
        FROM net._http_response r
       WHERE r.created < date_trunc('hour', now(), 'UTC')
    ),
    kinds AS (
      SELECT a.hour, a.failure, count(*) AS n
        FROM answered a
       WHERE a.failure IS NOT NULL
       GROUP BY a.hour, a.failure
    )
    SELECT a.hour,
           count(*) AS sent,
           count(a.failure) AS failed,
           (SELECT string_agg(k.n || ' × ' || k.failure, ', ' ORDER BY k.n DESC, k.failure)
              FROM kinds k
             WHERE k.hour = a.hour) AS kinds
      FROM answered a
     GROUP BY a.hour
    HAVING count(a.failure) > 0
     ORDER BY a.hour
  LOOP
    v_key := 'pg_net ' || to_char(v_hour.hour AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24":00Z"');
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM public.client_errors ce
       WHERE ce.role = 'database' AND ce.url = v_key
    );

    INSERT INTO public.client_errors (user_id, role, message, stack, url, user_agent)
    VALUES (
      NULL,
      'database',
      left(format(
        'Push: %s of %s requests the database sent to send-push failed between %s and %s UTC — %s',
        v_hour.failed,
        v_hour.sent,
        to_char(v_hour.hour AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI'),
        to_char((v_hour.hour + interval '1 hour') AT TIME ZONE 'UTC', 'HH24:MI'),
        v_hour.kinds
      ), 2000),
      'What each request was answered is in net._http_response for six hours, and in the log of the send-push Edge Function.',
      v_key,
      'public.record_push_failures()'
    );
    v_hours := v_hours + 1;
    v_failed := v_failed + v_hour.failed;
  END LOOP;

  RETURN jsonb_build_object('hours', v_hours, 'failed', v_failed);
END;
$$;

-- For the owner and the service role. Said here, next to the function, so
-- that the result does not depend on what a new function is born with.
REVOKE ALL ON FUNCTION public.record_push_failures() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_push_failures() TO service_role;

-- ------------------------------------------------------------
-- The four jobs. Each is made, then read back: anything else than what was
-- meant raises, and the whole file is undone — the jobs with it, which are
-- rows of a table like any other.
-- ------------------------------------------------------------
-- cron.schedule(name, schedule, command) makes a job of the role that calls
-- it, in the database it is called in. The times are UTC, which is pg_cron's
-- clock on Supabase.
--
-- sl-cron-history. The runs of a job are numbered in the order they started.
-- The statement finds the first run that ended within the last three days and
-- deletes every run numbered before it — by its number and not by its time,
-- because a run that never started has none (the database refused the
-- connection) and would stay for ever. While no run has ended for three days
-- it deletes nothing.
DO $jobs$
DECLARE
  v_job  record;
  v_list text;
BEGIN
  FOR v_job IN
    SELECT j.jobname, j.schedule, j.command
      FROM (VALUES
        ('sl-rest-push',     '10 seconds', 'select public.dispatch_due_rest_pushes()'),
        ('sl-retention',     '17 3 * * *', 'select public.run_retention()'),
        ('sl-push-failures', '7 * * * *',  'select public.record_push_failures()'),
        ('sl-cron-history',  '47 3 * * *', 'delete from cron.job_run_details where runid < (select coalesce(min(runid), 0) from cron.job_run_details where end_time >= now() - interval ''3 days'')')
      ) AS j (jobname, schedule, command)
  LOOP
    PERFORM cron.schedule(v_job.jobname, v_job.schedule, v_job.command);

    -- One job of that name, as it was meant: switched on, of the role that
    -- runs this file, in this database.
    IF (SELECT count(*) FROM cron.job j WHERE j.jobname = v_job.jobname) <> 1
       OR NOT EXISTS (
         SELECT 1 FROM cron.job j
          WHERE j.jobname = v_job.jobname
            AND j.schedule = v_job.schedule
            AND j.command = v_job.command
            AND j.active
            AND j.username = current_user
            AND j.database = current_database()
       ) THEN
      v_list := concat_ws(', ', v_list, v_job.jobname);
    END IF;
  END LOOP;

  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_19_pg_cron_jobs did not get the jobs it meant: %', v_list
      USING HINT = 'Each job is read back after it is made: one of that name, with its schedule and its command, switched on, of the role that runs this file, in this database. Nothing was changed. Stop and report the full message.';
  END IF;
END
$jobs$;

-- ------------------------------------------------------------
-- Read the function back, the same way.
-- ------------------------------------------------------------
DO $verify$
DECLARE
  v_list text;
BEGIN
  -- Owned by postgres, a jsonb for an answer, for the owner and the service
  -- role and nobody else, with the rights of its caller, search_path pinned.
  SELECT CASE WHEN p.oid IS NULL THEN 'missing' ELSE concat_ws(', ',
           CASE WHEN pg_get_userbyid(p.proowner) <> 'postgres' THEN 'not owned by postgres' END,
           CASE WHEN p.prorettype <> 'jsonb'::regtype THEN 'it does not return jsonb' END,
           CASE WHEN has_function_privilege('anon', p.oid, 'EXECUTE') THEN 'anon may execute it' END,
           CASE WHEN EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                              WHERE a.grantee = 0)
                THEN 'PUBLIC may execute it' END,
           CASE WHEN has_function_privilege('authenticated', p.oid, 'EXECUTE')
                THEN 'a signed-in user may execute it' END,
           CASE WHEN NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
                THEN 'the service role may NOT execute it' END,
           CASE WHEN p.prosecdef THEN 'it runs as its owner' END,
           CASE WHEN p.proconfig IS NULL OR NOT ('search_path=public, pg_temp' = ANY (p.proconfig))
                THEN 'search_path is not public, pg_temp' END
         ) END
    INTO v_list
    FROM (SELECT to_regprocedure('public.record_push_failures()') AS oid) want
    LEFT JOIN pg_proc p ON p.oid = want.oid;
  IF v_list <> '' THEN
    RAISE EXCEPTION 'migration 2026_10_13_19_pg_cron_jobs did not get the function it meant: public.record_push_failures(): %', v_list
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;
END
$verify$;

INSERT INTO app_private.app_migrations (name)
VALUES ('2026_10_13_19_pg_cron_jobs')
RETURNING name, applied_at;

-- A function joined public: PostgREST learns of it when its schema cache is
-- reloaded.
NOTIFY pgrst, 'reload schema';

COMMIT;
