-- Rollback of 2026_10_13_18_retention: drops run_retention().
--
-- !! THIS REOPENS FINDING L27. From this file on nothing deletes the rest
-- !! pushes of an account that stopped training, a notification that was
-- !! read, or a client error: the three tables grow again without a bound
-- !! of their own.
--
-- Nothing anybody sees changes: no app calls the function, and every app
-- works without it as it did before it. There is no reason to run this file
-- other than the check of the page answering NOT PROTECTED or BROKEN, or a
-- migration applied to the wrong project
-- (docs/runbook/migrations/18-retention.md).
--
-- WHAT A RUN DELETED DOES NOT COME BACK. The migration itself deletes no row
-- and this file writes none: the rows a run of the function removed — rest
-- pushes older than 7 days, notifications read more than 90 days ago, client
-- errors older than 90 days — are in the backup taken before that run, and
-- nowhere else.
--
-- Refused (SLM04) while the ledger records a later migration: those build on
-- this one — the job of migration 19 calls run_retention() every night. Roll
-- the later ones back first, last applied first.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
DECLARE
  v_later text;
BEGIN
  -- Two questions, in this order: the second cannot be asked without a ledger.
  IF to_regclass('app_private.app_migrations') IS NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_18_retention is not applied: there is no app_private.app_migrations'
      USING ERRCODE = 'SLM03', HINT = 'Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_13_18_retention') THEN
    RAISE EXCEPTION 'migration 2026_10_13_18_retention is not applied'
      USING ERRCODE = 'SLM03', HINT = 'Nothing was changed.';
  END IF;

  SELECT string_agg(name, ', ' ORDER BY name) INTO v_later
    FROM app_private.app_migrations
   WHERE substring(name from '^[0-9]{4}_[0-9]{2}_[0-9]{2}_([0-9]{2})_')::int > 18;
  IF v_later IS NOT NULL THEN
    RAISE EXCEPTION 'the ledger still records later migrations: %', v_later
      USING ERRCODE = 'SLM04', HINT = 'Roll those back first. Nothing was changed.';
  END IF;
END
$guard$;

-- By its arguments: a function of the same name that somebody made
-- afterwards, with arguments, is not this file's to drop.
DROP FUNCTION IF EXISTS public.run_retention();

DELETE FROM app_private.app_migrations WHERE name = '2026_10_13_18_retention';

-- A function left public: PostgREST must forget it.
NOTIFY pgrst, 'reload schema';

COMMIT;
