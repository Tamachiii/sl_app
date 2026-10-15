-- Rollback of 2026_10_16_22_client_errors_scope: every coach reads every
-- client error again, and an account reports as many as it sends.
--
-- !! THIS REOPENS FINDING B6, AND THE CAP OF L20. From this file on, any
-- !! coach reads the errors of the athletes of every other coach — the
-- !! message, the stack, the page and the browser —, and a page caught in a
-- !! loop fills the table without end.
--
-- Every app works without the migration as it did before it. There is no
-- reason to run this file other than the check of the page answering BROKEN
-- (a coach who no longer reads the lines of their athletes, or an athlete
-- whose first error is not kept), or a migration applied to the wrong
-- project (docs/runbook/migrations/22-client-errors-scope.md).
--
-- No row is written or deleted by this file. The lines dropped by the cap
-- while the migration was in place were never written; the lines dated by
-- it keep their date.
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
    RAISE EXCEPTION 'migration 2026_10_16_22_client_errors_scope is not applied: there is no app_private.app_migrations'
      USING ERRCODE = 'SLM03', HINT = 'Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_16_22_client_errors_scope') THEN
    RAISE EXCEPTION 'migration 2026_10_16_22_client_errors_scope is not applied'
      USING ERRCODE = 'SLM03', HINT = 'Nothing was changed.';
  END IF;

  SELECT string_agg(name, ', ' ORDER BY name) INTO v_later
    FROM app_private.app_migrations
   WHERE substring(name from '^[0-9]{4}_[0-9]{2}_[0-9]{2}_([0-9]{2})_')::int > 22;
  IF v_later IS NOT NULL THEN
    RAISE EXCEPTION 'the ledger still records later migrations: %', v_later
      USING ERRCODE = 'SLM04', HINT = 'Roll those back first. Nothing was changed.';
  END IF;
END
$guard$;

DROP TRIGGER IF EXISTS trg_cap_client_errors ON public.client_errors;
DROP FUNCTION IF EXISTS public.cap_client_errors();

DROP POLICY IF EXISTS "Authors and their coach read client errors" ON public.client_errors;

-- As 2026_07_13_client_errors.sql wrote it.
CREATE POLICY "Coaches read client errors"
  ON public.client_errors FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
       WHERE p.id = auth.uid() AND p.role = 'coach'
    )
  );

DELETE FROM app_private.app_migrations WHERE name = '2026_10_16_22_client_errors_scope';

-- A function left public: PostgREST must forget it.
NOTIFY pgrst, 'reload schema';

COMMIT;
