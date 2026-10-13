-- Rollback of 2026_10_13_19_pg_cron_jobs: removes the four jobs and drops
-- record_push_failures(). It is how the jobs are switched off for good; it
-- leaves the extension itself alone, which is switched off in the dashboard,
-- afterwards, if at all.
--
-- AFTER IT the project is what it is without the migration, and nothing is
-- missing:
--   * a rest push is sent through the dispatch-rest-push Edge Function again.
--     schedule_rest_push answers mode 'edge' from the next rest on, and the
--     app calls the function — as the app from before wave 3 does anyway.
--   * run_retention() is run by hand again, once a month
--     (docs/runbook/70-admin-procedures.md).
--   * a push request that failed is in the log of the send-push function,
--     and nowhere else.
--
-- !! THE RESTS THAT ARE RUNNING. A rest the app of wave 3 or later scheduled
-- !! while the answer was mode 'cron' is sent by the job, and by nobody else:
-- !! the ones whose time has not come when this file runs — 15 minutes of
-- !! them at most — do not ring on a locked phone. Line 14 of the audit counts
-- !! them: run this file when it reads 0, or at an hour nobody trains. The
-- !! app from before wave 3 calls the Edge Function for every rest: its rests
-- !! ring whatever this file does.
--
-- WHAT THE JOBS DID DOES NOT COME BACK: the rows run_retention() deleted, the
-- lines record_push_failures() wrote into client_errors — which stay, and go
-- with the errors older than 90 days — and the runs sl-cron-history deleted.
--
-- NOT REFUSED WHILE A LATER MIGRATION IS IN THE LEDGER, unlike the other
-- rollbacks: this migration is optional, no migration after it may need it
-- (supabase/migrations/README.md, "What a migration requires"), and its
-- rollback is the way out of a choice — it must stay open.
--
-- IT WORKS WITHOUT THE EXTENSION. Where pg_cron was switched off before this
-- file was run, the jobs went with it: what is left is the function and the
-- row of the ledger, which this file removes. Run it, and the migration can
-- be applied again once the extension is back.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
BEGIN
  -- Two questions, in this order: the second cannot be asked without a ledger.
  IF to_regclass('app_private.app_migrations') IS NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_19_pg_cron_jobs is not applied: there is no app_private.app_migrations'
      USING ERRCODE = 'SLM03', HINT = 'Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_13_19_pg_cron_jobs') THEN
    RAISE EXCEPTION 'migration 2026_10_13_19_pg_cron_jobs is not applied'
      USING ERRCODE = 'SLM03', HINT = 'Nothing was changed.';
  END IF;
  -- A job is removed by the role it belongs to.
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'the rollback of 2026_10_13_19_pg_cron_jobs must be run as postgres, not as %', current_user
      USING HINT = 'Run it from the SQL editor or with `supabase db query --linked`. Nothing was changed.';
  END IF;
END
$guard$;

-- The four jobs, by their names, where pg_cron is there. A job is removed
-- through cron.unschedule: postgres reads cron.job and may not write it. One
-- that is gone already — removed by hand — is not looked for; one of these
-- names that belongs to another role is not this file's to remove, and stops
-- it: schedule_rest_push would go on answering mode 'cron' for it.
DO $jobs$
DECLARE
  v_job  text;
  v_list text;
BEGIN
  IF to_regnamespace('cron') IS NULL
     OR NOT has_schema_privilege(to_regnamespace('cron')::oid, 'USAGE')
     OR to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'pg_cron is not in this database any more: its jobs went with it';
    RETURN;
  END IF;

  FOR v_job IN
    SELECT j.jobname FROM cron.job j
     WHERE j.jobname IN ('sl-rest-push', 'sl-retention', 'sl-push-failures', 'sl-cron-history')
       AND j.username = current_user
     ORDER BY j.jobname
  LOOP
    PERFORM cron.unschedule(v_job);
  END LOOP;

  SELECT string_agg(format('%s (of %s)', j.jobname, j.username), ', ' ORDER BY j.jobname, j.username)
    INTO v_list
    FROM cron.job j
   WHERE j.jobname IN ('sl-rest-push', 'sl-retention', 'sl-push-failures', 'sl-cron-history');
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'the rollback of 2026_10_13_19_pg_cron_jobs could not remove: %', v_list
      USING HINT = 'A job of one of the four names belongs to another role, which is the one that removes it. Nothing was changed. Stop and report.';
  END IF;
END
$jobs$;

-- By its arguments: a function of the same name that somebody made
-- afterwards, with arguments, is not this file's to drop.
DROP FUNCTION IF EXISTS public.record_push_failures();

DELETE FROM app_private.app_migrations WHERE name = '2026_10_13_19_pg_cron_jobs';

-- A function left public: PostgREST must forget it.
NOTIFY pgrst, 'reload schema';

COMMIT;
