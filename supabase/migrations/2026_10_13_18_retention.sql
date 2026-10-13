-- ============================================================
-- 18 — The rows nobody reads any more are deleted by one function, which the
--      owner runs once a month — or a job, every night
-- wave 2 · Checkpoint B · required · finding L27, and the retention that B14
--                                     and L20 ask for
--
-- THE HOLE. Three tables hold rows that are of use for a while and of none
-- afterwards, and nothing ever deleted one of them:
--   * scheduled_pushes — one row per rest timer: the largest table after
--     set_logs, and the one that grows with every set an athlete ticks. A row
--     is of use until its push is sent, taken back, or a minute late.
--   * notifications — the lines of the bell. The app shows the 30 most recent
--     ones of an account.
--   * client_errors — what the app reports when it breaks, for the coach's
--     triage list: the 20 most recent.
-- Since migration 16 schedule_rest_push deletes the caller's own rest pushes
-- older than 7 days — for the app that calls it. The app from before wave 3
-- inserts its rows itself, and nothing deletes those. And where every app
-- calls it, that leaves the rows of every account that stopped training, and
-- the two other tables as they were. A job would do the rest — and pg_cron,
-- which runs jobs, is not installed and may never be: without it nothing
-- inside the database happens on a timer.
--
-- WHAT THIS FILE DOES. It creates ONE function, and deletes NO row.
--
--   run_retention()
--     → { "scheduled_pushes": n, "notifications": n, "client_errors": n }
--
--   deletes   rest pushes created more than 7 days ago, whatever became of
--             them — except one that is still to be sent: waiting, not taken
--             back, for a time still to come or less than a minute past
--             notifications their recipient READ more than 90 days ago
--             client errors reported more than 90 days ago
--   keeps     a notification that was not read, however old
--             every other table: none is named in it
--   answers   how many rows of each it deleted
--
-- WHO RUNS IT. The owner of the database, by hand, once a month
-- (docs/runbook/70-admin-procedures.md) — or, where pg_cron is switched on,
-- the nightly job of the optional migration 19. Nothing else: no trigger, no
-- other function, no app. It is executable by its owner and by the service
-- role, and it runs with the rights of whoever calls it (SECURITY INVOKER):
-- it has no right of its own.
--
-- WITHOUT A RUN nothing breaks: the rows wait. A month that is skipped is
-- rows that wait a month longer. Once the app starts its rests through
-- schedule_rest_push, the table that grows fastest is bounded without a run:
-- an account's rest pushes older than 7 days go with its own next rest.
--
-- WHAT A CLIENT SEES. Nothing when the file is applied. After a run, in every
-- version of the app:
--   * the bell loses the lines its account read more than 90 days ago — which
--     it showed only to an account with fewer than 30 newer ones. The count
--     on the bell is the unread lines, and none of those is deleted.
--   * the coach's list of errors loses the ones older than 90 days.
--   * nothing reads a rest push once it is sent, taken back or late.
--
-- Backward compatible: yes, with every client ever deployed.
-- Audit:    supabase/audits/2026_10_13_18_retention.audit.sql
-- Rollback: supabase/rollbacks/2026_10_13_18_retention.down.sql
-- Runbook:  docs/runbook/migrations/18-retention.md
-- ============================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
DECLARE
  v_list text;
BEGIN
  -- First of all, because no other role can even look at the ledger. What is
  -- created below must belong to the role that owns the tables: the default
  -- privileges that keep a new function closed (migration 03) are those of
  -- `postgres`.
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'migration 2026_10_13_18_retention must be run as postgres, not as %', current_user
      USING HINT = 'Run it from the SQL editor or with `supabase db query --linked`. Nothing was changed.';
  END IF;

  -- Asked before the ledger is read: without it the answer would be
  -- "relation does not exist" instead of this one.
  IF to_regclass('app_private.app_migrations') IS NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_18_retention needs 2026_10_13_17_replay_grace_window, which is not applied'
      USING ERRCODE = 'SLM02', HINT = 'Apply migrations 01 to 17 first. Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_13_18_retention') THEN
    RAISE EXCEPTION 'migration 2026_10_13_18_retention is already applied'
      USING ERRCODE = 'SLM01', HINT = 'Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_13_17_replay_grace_window') THEN
    RAISE EXCEPTION 'migration 2026_10_13_18_retention needs 2026_10_13_17_replay_grace_window, which is not applied'
      USING ERRCODE = 'SLM02', HINT = 'Apply that file first. Nothing was changed.';
  END IF;

  -- The function is CREATED, not replaced. One that is there already under
  -- that name — without arguments or with some — was made by hand, and a job
  -- or a person that calls `run_retention` may reach the wrong one.
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text)
    INTO v_list
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = 'run_retention';
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_18_retention would not create: % is already there', v_list
      USING HINT = 'A function of this file exists, made by hand or by a file that is not in the ledger. Nothing was changed. Stop and report.';
  END IF;

  -- The body of a function is not checked against the database when it is
  -- created: a column that is missing would be found by the first run, a
  -- month from now. Asked here instead.
  SELECT string_agg(w.what, ', ' ORDER BY w.what)
    INTO v_list
    FROM (VALUES ('public.scheduled_pushes.id'),
                 ('public.scheduled_pushes.created_at'),
                 ('public.scheduled_pushes.fire_at'),
                 ('public.scheduled_pushes.status'),
                 ('public.scheduled_pushes.canceled_at'),
                 ('public.notifications.id'),
                 ('public.notifications.read_at'),
                 ('public.client_errors.id'),
                 ('public.client_errors.created_at')
         ) AS w (what)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = to_regclass(substring(w.what from '^(.*)[.][^.]+$'))
        AND a.attname = substring(w.what from '[.]([^.]+)$') AND NOT a.attisdropped
   );
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_18_retention does not find the columns its function is written with: %', v_list
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;
END
$guard$;

-- ------------------------------------------------------------
-- The one function that deletes what nobody reads any more.
-- ------------------------------------------------------------
--   returns   { "scheduled_pushes": n, "notifications": n, "client_errors": n }
--             — the rows this run deleted. Keys are added, never renamed.
--
--   REST PUSHES   created more than 7 days ago: sent, failed, taken back,
--                 expired, left 'sending' by a sender that never said, or
--                 still 'pending' long after their time. The age is the one
--                 schedule_rest_push deletes the caller's own rows at
--                 (migration 16): this is the same broom, for the accounts
--                 that do not rest any more — and for every account while
--                 the app from before wave 3 is in use, which never calls
--                 that function.
--                 NEVER ONE THAT IS STILL TO BE SENT: a row that is waiting
--                 for a time still to come, or less than a minute past,
--                 belongs to a sender. "Waiting" is what it is for every
--                 function of migration 16: status 'pending' AND canceled_at
--                 NULL — a row the app from before wave 3 took back, by
--                 writing canceled_at and leaving the status, waits for
--                 nobody and goes. A rest lasts 15 minutes at most, so a row
--                 a week old is not waiting — unless the app from before
--                 wave 3 wrote it from a phone whose clock is days ahead.
--                 That row is left until its time has passed.
--   NOTIFICATIONS read more than 90 days ago — by the time they were READ,
--                 not written: a line that was marked as read today stays
--                 for 90 days, however old it is. A line that was never read
--                 is never deleted here: it is still on its account's bell.
--   CLIENT ERRORS reported more than 90 days ago.
--
-- The three ages are written here, and the 7 days once more in
-- schedule_rest_push. The audit of this migration counts with the same
-- conditions: a change of one is a change of both, and of the test.
--
-- IT WAITS FOR NOBODY. Each DELETE takes its rows through
-- FOR UPDATE SKIP LOCKED: a row another request holds at that instant — an
-- account that is scheduling its next rest, an account that is being deleted
-- — is passed over, and goes with the next run. So a run never stands in the
-- way of the app, and never deadlocks with it.
--
-- SECURITY INVOKER, and for no client: the owner of the database (the SQL
-- editor, a pg_cron job) and the service role hold every row; anybody else
-- would reach what their own rights let them delete — their own rest pushes,
-- and nothing of the two other tables. It is not given to `authenticated`,
-- and must not be.
CREATE FUNCTION public.run_retention()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_pushes        integer;
  v_notifications integer;
  v_errors        integer;
BEGIN
  WITH old AS (
    SELECT sp.id
      FROM public.scheduled_pushes sp
     WHERE sp.created_at < now() - interval '7 days'
       AND NOT (    sp.status = 'pending'
                AND sp.canceled_at IS NULL
                AND sp.fire_at > now() - interval '60 seconds')
     ORDER BY sp.id
       FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.scheduled_pushes sp
   USING old
   WHERE sp.id = old.id;
  GET DIAGNOSTICS v_pushes = ROW_COUNT;

  WITH old AS (
    SELECT n.id
      FROM public.notifications n
     WHERE n.read_at IS NOT NULL
       AND n.read_at < now() - interval '90 days'
     ORDER BY n.id
       FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.notifications n
   USING old
   WHERE n.id = old.id;
  GET DIAGNOSTICS v_notifications = ROW_COUNT;

  WITH old AS (
    SELECT ce.id
      FROM public.client_errors ce
     WHERE ce.created_at < now() - interval '90 days'
     ORDER BY ce.id
       FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.client_errors ce
   USING old
   WHERE ce.id = old.id;
  GET DIAGNOSTICS v_errors = ROW_COUNT;

  RETURN jsonb_build_object(
    'scheduled_pushes', v_pushes,
    'notifications',    v_notifications,
    'client_errors',    v_errors
  );
END;
$$;

-- For the owner and the service role. Said here, next to the function, so
-- that the result does not depend on what a new function is born with.
REVOKE ALL ON FUNCTION public.run_retention() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_retention() TO service_role;

-- ------------------------------------------------------------
-- Read the result back. Anything else than what was meant raises, and the
-- whole file is undone: either the database is as described, or untouched.
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
    FROM (SELECT to_regprocedure('public.run_retention()') AS oid) want
    LEFT JOIN pg_proc p ON p.oid = want.oid;
  IF v_list <> '' THEN
    RAISE EXCEPTION 'migration 2026_10_13_18_retention did not get the function it meant: public.run_retention(): %', v_list
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;

  -- One function of that name: a job calls it by name.
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text)
    INTO v_list
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = 'run_retention'
     AND p.oid IS DISTINCT FROM to_regprocedure('public.run_retention()');
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_18_retention did not get the function it meant: % stands next to it', v_list
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;
END
$verify$;

INSERT INTO app_private.app_migrations (name)
VALUES ('2026_10_13_18_retention')
RETURNING name, applied_at;

-- A function joined public: PostgREST learns of it when its schema cache is
-- reloaded.
NOTIFY pgrst, 'reload schema';

COMMIT;
