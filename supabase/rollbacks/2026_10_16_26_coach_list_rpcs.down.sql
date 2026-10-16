-- Rollback of 2026_10_16_26_coach_list_rpcs: drops coach_review_counts() and
-- my_conversations().
--
-- NOTHING BREAKS. The app that is deployed does not call them. The version of
-- the app that follows wave 3 calls them when they are there, and reads the
-- coach's roster counts and conversations page by page when the API answers
-- that they are not (PGRST202): after this file the two lists open more
-- slowly, and show the same thing.
--
-- What it does: drops the two functions. No row is written or removed: the
-- functions only read.
--
-- NOT REFUSED WHILE A LATER MIGRATION IS IN THE LEDGER, unlike the rollbacks
-- of the required migrations: this migration is optional, no migration after
-- it may need it (supabase/migrations/README.md, "What a migration
-- requires"), and its rollback is the way out of a choice — it must stay
-- open, as the rollback of migration 19 does.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
BEGIN
  -- Two questions, in this order: the second cannot be asked without a ledger.
  IF to_regclass('app_private.app_migrations') IS NULL THEN
    RAISE EXCEPTION 'migration 2026_10_16_26_coach_list_rpcs is not applied: there is no app_private.app_migrations'
      USING ERRCODE = 'SLM03', HINT = 'Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_16_26_coach_list_rpcs') THEN
    RAISE EXCEPTION 'migration 2026_10_16_26_coach_list_rpcs is not applied'
      USING ERRCODE = 'SLM03', HINT = 'Nothing was changed.';
  END IF;
END
$guard$;

-- By their arguments: a function of the same name that somebody made
-- afterwards, with other arguments, is not this file's to drop.
DROP FUNCTION IF EXISTS public.coach_review_counts();
DROP FUNCTION IF EXISTS public.my_conversations();

DELETE FROM app_private.app_migrations WHERE name = '2026_10_16_26_coach_list_rpcs';

-- Two functions left public: PostgREST must forget them.
NOTIFY pgrst, 'reload schema';

COMMIT;
