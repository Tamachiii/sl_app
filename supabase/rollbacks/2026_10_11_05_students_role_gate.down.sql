-- Rollback of 2026_10_11_05_students_role_gate: gives public.students and
-- public.exercise_library back the policies they had, and removes the three
-- checks.
--
-- !! IT REOPENS FINDINGS P7 AND L2. After this file any signed-in account,
-- !! an athlete included, can again insert a students row that makes it the
-- !! coach of a profile nobody coaches yet — its own coach, for one —, point
-- !! a row at another profile, delete an athlete with everything they own,
-- !! and write exercise-library rows of its own.
--
-- There is one reason to run it: after the migration, something the app does
-- for a coach or an athlete is refused with a message of this migration
-- ("… is not in the library of the coach of this program", "the coach-athlete
-- link … cannot be changed from the app") or by row-level security on
-- students or exercise_library. Report what was being done, and re-apply the
-- migration as soon as it is understood
-- (docs/runbook/migrations/05-students-role-gate.md).
--
-- What it does:
--   * re-creates "Coaches insert students" and "Coaches delete their
--     students", and gives "Coaches update their students" and "Coaches
--     manage own library" the text they had after migration 04;
--   * drops the three triggers of the migration and their functions;
--   * drops is_coach().
-- No table and no row is touched. A link written while the gate was in place
-- is a link that passed it.
--
-- Refused (SLM04) while the ledger records a later migration: those build on
-- these functions. Roll the later ones back first, last applied first.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
DECLARE
  v_later text;
BEGIN
  -- Two questions, in this order: the second cannot be asked without a ledger.
  IF to_regclass('app_private.app_migrations') IS NULL THEN
    RAISE EXCEPTION 'migration 2026_10_11_05_students_role_gate is not applied: there is no app_private.app_migrations'
      USING ERRCODE = 'SLM03', HINT = 'Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_11_05_students_role_gate') THEN
    RAISE EXCEPTION 'migration 2026_10_11_05_students_role_gate is not applied'
      USING ERRCODE = 'SLM03', HINT = 'Nothing was changed.';
  END IF;

  SELECT string_agg(name, ', ' ORDER BY name) INTO v_later
    FROM app_private.app_migrations
   WHERE substring(name from '^[0-9]{4}_[0-9]{2}_[0-9]{2}_([0-9]{2})_')::int > 5;
  IF v_later IS NOT NULL THEN
    RAISE EXCEPTION 'the ledger still records later migrations: %', v_later
      USING ERRCODE = 'SLM04', HINT = 'Roll those back first. Nothing was changed.';
  END IF;
END
$guard$;

-- ------------------------------------------------------------
-- The three triggers of the migration, then their functions.
-- ------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_check_deviation_substitute_in_coach_library ON public.slot_deviations;
DROP TRIGGER IF EXISTS trg_check_slot_exercise_in_coach_library ON public.exercise_slots;
DROP TRIGGER IF EXISTS trg_check_students_link ON public.students;

DROP FUNCTION IF EXISTS public.check_deviation_substitute_in_coach_library();
DROP FUNCTION IF EXISTS public.check_slot_exercise_in_coach_library();
DROP FUNCTION IF EXISTS public.check_students_link();

-- ------------------------------------------------------------
-- The policies, as they were: coach_id = auth.uid() and nothing else.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "Coaches manage own library" ON public.exercise_library;
CREATE POLICY "Coaches manage own library"
  ON public.exercise_library FOR ALL
  USING (coach_id = auth.uid());

DROP POLICY IF EXISTS "Coaches update their students" ON public.students;
CREATE POLICY "Coaches update their students"
  ON public.students FOR UPDATE
  USING (coach_id = auth.uid());

DROP POLICY IF EXISTS "Coaches insert students" ON public.students;
CREATE POLICY "Coaches insert students"
  ON public.students FOR INSERT
  WITH CHECK (coach_id = auth.uid());

DROP POLICY IF EXISTS "Coaches delete their students" ON public.students;
CREATE POLICY "Coaches delete their students"
  ON public.students FOR DELETE
  USING (coach_id = auth.uid());

-- ------------------------------------------------------------
-- No policy reads it any more.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.is_coach();

DELETE FROM app_private.app_migrations WHERE name = '2026_10_11_05_students_role_gate';

-- A function left public: PostgREST has to forget it.
NOTIFY pgrst, 'reload schema';

COMMIT;
