-- Rollback of 2026_10_13_12_copy_rpcs: drops duplicate_session,
-- copy_sessions, duplicate_week and duplicate_program.
--
-- !! NOT ONCE THE APP THAT CALLS THEM IS PUBLISHED. The version of the app
-- !! that follows wave 1 duplicates a session, a phase and a block, and
-- !! copies sessions to another phase, through these four functions and
-- !! through nothing else: after this file, each of those gestures fails for
-- !! every coach until the file of the migration is applied again.
--
-- With the app that is deployed today nothing calls them, and this file
-- changes nothing anybody sees. There is no reason to run it other than a
-- migration applied to the wrong project
-- (docs/runbook/migrations/12-copy-rpcs.md).
--
-- What it does: drops the four functions. No row is written: the sessions,
-- phases and blocks they copied stay where they are, with their exercises
-- and their sets.
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
    RAISE EXCEPTION 'migration 2026_10_13_12_copy_rpcs is not applied: there is no app_private.app_migrations'
      USING ERRCODE = 'SLM03', HINT = 'Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_13_12_copy_rpcs') THEN
    RAISE EXCEPTION 'migration 2026_10_13_12_copy_rpcs is not applied'
      USING ERRCODE = 'SLM03', HINT = 'Nothing was changed.';
  END IF;

  SELECT string_agg(name, ', ' ORDER BY name) INTO v_later
    FROM app_private.app_migrations
   WHERE substring(name from '^[0-9]{4}_[0-9]{2}_[0-9]{2}_([0-9]{2})_')::int > 12;
  IF v_later IS NOT NULL THEN
    RAISE EXCEPTION 'the ledger still records later migrations: %', v_later
      USING ERRCODE = 'SLM04', HINT = 'Roll those back first. Nothing was changed.';
  END IF;
END
$guard$;

-- By their arguments: a function of the same name that somebody made
-- afterwards, with other arguments, is not this file's to drop.
DROP FUNCTION IF EXISTS public.duplicate_session(uuid, text);
DROP FUNCTION IF EXISTS public.copy_sessions(uuid[], uuid);
DROP FUNCTION IF EXISTS public.duplicate_week(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.duplicate_program(uuid, uuid, text);

DELETE FROM app_private.app_migrations WHERE name = '2026_10_13_12_copy_rpcs';

-- Four functions left public: PostgREST must forget them.
NOTIFY pgrst, 'reload schema';

COMMIT;
