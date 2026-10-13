-- Rollback of 2026_10_13_10_goals_fk_coach_links: gives the three foreign
-- keys back ON DELETE CASCADE and coach_profile_for_goal the text it had,
-- drops transfer_student and the column exercise_library.archived_at.
--
-- !! IT REOPENS FINDINGS P18 / L7, P21 AND B9. After this file a coach who
-- !! deletes a library exercise deletes, with it, the goals set on it and
-- !! the attempts the athletes logged; deleting a coach's account deletes
-- !! the links of their athletes — and their programs — and the goals; and
-- !! a coach reads the progress of every goal they ever set, whoever coaches
-- !! the athlete today.
--
-- There is one reason to run it: after the migration, something the app
-- does with a goal, with the exercise library or with the roster is refused
-- or answers wrongly — a coach who can no longer read the progress of an
-- athlete they coach, an exercise NOTHING uses that cannot be deleted, a
-- library that does not load. Report what was being done, and re-apply the
-- migration as soon as it is understood
-- (docs/runbook/migrations/10-goals-fk-coach-links.md).
--
-- What it does:
--   * re-creates goals_exercise_id_fkey, goals_coach_id_fkey and
--     students_coach_id_fkey with ON DELETE CASCADE;
--   * gives coach_profile_for_goal the text it had after migration 03: the
--     profile that set the goal, linked to its athlete or not;
--   * drops transfer_student(uuid, uuid);
--   * DROPS THE COLUMN exercise_library.archived_at. An exercise archived
--     while the migration was in place is an ordinary exercise again, back
--     in every picker, and nothing remembers that it was archived (line 15
--     of the audit counts them — read it first).
-- No row is deleted. An athlete moved with transfer_student stays with their
-- new coach, and so do their goals.
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
    RAISE EXCEPTION 'migration 2026_10_13_10_goals_fk_coach_links is not applied: there is no app_private.app_migrations'
      USING ERRCODE = 'SLM03', HINT = 'Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_13_10_goals_fk_coach_links') THEN
    RAISE EXCEPTION 'migration 2026_10_13_10_goals_fk_coach_links is not applied'
      USING ERRCODE = 'SLM03', HINT = 'Nothing was changed.';
  END IF;

  SELECT string_agg(name, ', ' ORDER BY name) INTO v_later
    FROM app_private.app_migrations
   WHERE substring(name from '^[0-9]{4}_[0-9]{2}_[0-9]{2}_([0-9]{2})_')::int > 10;
  IF v_later IS NOT NULL THEN
    RAISE EXCEPTION 'the ledger still records later migrations: %', v_later
      USING ERRCODE = 'SLM04', HINT = 'Roll those back first. Nothing was changed.';
  END IF;
END
$guard$;

-- ------------------------------------------------------------
-- Moving an athlete: by hand again, and the goals stay behind.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.transfer_student(uuid, uuid);

-- ------------------------------------------------------------
-- The coach of a goal: whoever set it.
-- ------------------------------------------------------------
-- The text of the baseline, with the search_path migration 03 gave it. The
-- grant to `authenticated` is from migration 03 too, and CREATE OR REPLACE
-- keeps it.
CREATE OR REPLACE FUNCTION public.coach_profile_for_goal(g uuid)
RETURNS uuid AS $$
  SELECT coach_id FROM public.goals WHERE id = g
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

-- ------------------------------------------------------------
-- An exercise is deleted, or it stays in the pickers.
-- ------------------------------------------------------------
ALTER TABLE public.exercise_library
  DROP COLUMN IF EXISTS archived_at;

-- ------------------------------------------------------------
-- The three foreign keys: the row that points is deleted with what it
-- points at.
-- ------------------------------------------------------------
ALTER TABLE public.students
  DROP CONSTRAINT students_coach_id_fkey,
  ADD CONSTRAINT students_coach_id_fkey
    FOREIGN KEY (coach_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

ALTER TABLE public.goals
  DROP CONSTRAINT goals_exercise_id_fkey,
  ADD CONSTRAINT goals_exercise_id_fkey
    FOREIGN KEY (exercise_id) REFERENCES public.exercise_library(id) ON DELETE CASCADE,
  DROP CONSTRAINT goals_coach_id_fkey,
  ADD CONSTRAINT goals_coach_id_fkey
    FOREIGN KEY (coach_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

DELETE FROM app_private.app_migrations WHERE name = '2026_10_13_10_goals_fk_coach_links';

-- A column, three foreign keys and a function left or changed in public.
NOTIFY pgrst, 'reload schema';

COMMIT;
