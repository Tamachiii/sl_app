-- Rollback of 2026_10_13_11_activate_reorder_rpcs: drops activate_program,
-- reorder_sessions and reorder_weeks.
--
-- !! NOT ONCE THE APP THAT CALLS THEM IS PUBLISHED. The version of the app
-- !! that follows wave 1 sets a block active and reorders sessions and
-- !! phases through these three functions and through nothing else: after
-- !! this file, each of those gestures fails for every coach until the file
-- !! of the migration is applied again.
--
-- With the app that is deployed today nothing calls them, and this file
-- changes nothing anybody sees. There is no reason to run it other than a
-- migration applied to the wrong project
-- (docs/runbook/migrations/11-activate-reorder-rpcs.md).
--
-- What it does: drops the three functions. No row is written: a block that
-- was activated stays active, sessions and phases keep the order they were
-- given.
--
-- Refused (SLM04) while the ledger records a later migration: those build on
-- this one. Roll the later ones back first, last applied first.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
DECLARE
  v_later text;
BEGIN
  -- Two questions, in this order: the second cannot be asked without a ledger.
  IF to_regclass('app_private.app_migrations') IS NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_11_activate_reorder_rpcs is not applied: there is no app_private.app_migrations'
      USING ERRCODE = 'SLM03', HINT = 'Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_13_11_activate_reorder_rpcs') THEN
    RAISE EXCEPTION 'migration 2026_10_13_11_activate_reorder_rpcs is not applied'
      USING ERRCODE = 'SLM03', HINT = 'Nothing was changed.';
  END IF;

  SELECT string_agg(name, ', ' ORDER BY name) INTO v_later
    FROM app_private.app_migrations
   WHERE substring(name from '^[0-9]{4}_[0-9]{2}_[0-9]{2}_([0-9]{2})_')::int > 11;
  IF v_later IS NOT NULL THEN
    RAISE EXCEPTION 'the ledger still records later migrations: %', v_later
      USING ERRCODE = 'SLM04', HINT = 'Roll those back first. Nothing was changed.';
  END IF;
END
$guard$;

-- By their arguments: a function of the same name that somebody made
-- afterwards, with other arguments, is not this file's to drop.
DROP FUNCTION IF EXISTS public.activate_program(uuid);
DROP FUNCTION IF EXISTS public.reorder_sessions(uuid, uuid[]);
DROP FUNCTION IF EXISTS public.reorder_weeks(uuid, uuid[]);

DELETE FROM app_private.app_migrations WHERE name = '2026_10_13_11_activate_reorder_rpcs';

-- Three functions left public: PostgREST must forget them.
NOTIFY pgrst, 'reload schema';

COMMIT;
