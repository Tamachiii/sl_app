-- Rollback of 2026_10_16_23_library_read_follows_program: an exercise is read
-- by the coach it belongs to and by that coach's athletes, and by nobody
-- else — the policy "Users read the exercises their training uses" and its
-- function go.
--
-- !! THIS REOPENS FINDING B8. From this file on, an athlete who changed coach
-- !! and their new coach read the blocks written before the change with
-- !! exercises that have no name: the app that is deployed breaks on them.
--
-- Every app works without the migration as it did before it, for every
-- athlete who never changed coach. There is no reason to run this file other
-- than the check of the page answering NOT PROTECTED or BROKEN, or a
-- migration applied to the wrong project
-- (docs/runbook/migrations/23-library-read-follows-program.md).
--
-- No row is written or deleted by this file.
--
-- Refused (SLM04) while the ledger records a later migration: those build on
-- this one. Roll the later ones back first, last applied first.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
DECLARE
  v_later text;
BEGIN
  IF to_regclass('app_private.app_migrations') IS NULL THEN
    RAISE EXCEPTION 'migration 2026_10_16_23_library_read_follows_program is not applied: there is no app_private.app_migrations'
      USING ERRCODE = 'SLM03', HINT = 'Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_16_23_library_read_follows_program') THEN
    RAISE EXCEPTION 'migration 2026_10_16_23_library_read_follows_program is not applied'
      USING ERRCODE = 'SLM03', HINT = 'Nothing was changed.';
  END IF;

  SELECT string_agg(name, ', ' ORDER BY name) INTO v_later
    FROM app_private.app_migrations
   WHERE substring(name from '^[0-9]{4}_[0-9]{2}_[0-9]{2}_([0-9]{2})_')::int > 23;
  IF v_later IS NOT NULL THEN
    RAISE EXCEPTION 'the ledger still records later migrations: %', v_later
      USING ERRCODE = 'SLM04', HINT = 'Roll those back first. Nothing was changed.';
  END IF;
END
$guard$;

-- The policy first: it calls the function.
DROP POLICY IF EXISTS "Users read the exercises their training uses" ON public.exercise_library;
DROP FUNCTION IF EXISTS public.exercise_readable_through_use(uuid);

DELETE FROM app_private.app_migrations WHERE name = '2026_10_16_23_library_read_follows_program';

-- A function left public: PostgREST must forget it.
NOTIFY pgrst, 'reload schema';

COMMIT;
