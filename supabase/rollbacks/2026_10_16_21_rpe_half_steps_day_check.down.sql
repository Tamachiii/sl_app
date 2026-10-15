-- Rollback of 2026_10_16_21_rpe_half_steps_day_check: set_logs.rpe is a
-- whole number from 1 to 10 again, a session's weekday is any number again,
-- and save_draft_tree writes the number it is sent, as 2026_08_22 left it.
--
-- !! AN RPE IN A HALF STEP IS ROUNDED, AWAY FROM ZERO: 7.5 becomes 8, 9.5
-- !! becomes 10. The half is lost; the set stays logged.
-- !! THE WEEKDAYS THE MIGRATION CLEARED DO NOT COME BACK. They were listed by
-- !! the page before the migration ("The sessions that lose their weekday");
-- !! a coach sets one again in the Program Sheet.
--
-- The app that is deployed works either way: it writes whole numbers from 1
-- to 10, and a weekday from 1 to 7 or none. There is no reason to run this
-- file other than the check of the page answering BROKEN, or a migration
-- applied to the wrong project (docs/runbook/migrations/21-rpe-half-steps-day-check.md).
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
    RAISE EXCEPTION 'migration 2026_10_16_21_rpe_half_steps_day_check is not applied: there is no app_private.app_migrations'
      USING ERRCODE = 'SLM03', HINT = 'Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_16_21_rpe_half_steps_day_check') THEN
    RAISE EXCEPTION 'migration 2026_10_16_21_rpe_half_steps_day_check is not applied'
      USING ERRCODE = 'SLM03', HINT = 'Nothing was changed.';
  END IF;

  SELECT string_agg(name, ', ' ORDER BY name) INTO v_later
    FROM app_private.app_migrations
   WHERE substring(name from '^[0-9]{4}_[0-9]{2}_[0-9]{2}_([0-9]{2})_')::int > 21;
  IF v_later IS NOT NULL THEN
    RAISE EXCEPTION 'the ledger still records later migrations: %', v_later
      USING ERRCODE = 'SLM04', HINT = 'Roll those back first. Nothing was changed.';
  END IF;
END
$guard$;

LOCK TABLE public.sessions, public.set_logs IN ACCESS EXCLUSIVE MODE;

-- The range rule is dropped and written again for the integer column, with
-- the text the baseline has.
ALTER TABLE public.set_logs
  DROP CONSTRAINT set_logs_rpe_half_step,
  DROP CONSTRAINT set_logs_rpe_check,
  ALTER COLUMN rpe TYPE integer USING round(rpe)::integer,
  ADD CONSTRAINT set_logs_rpe_check CHECK (rpe IS NULL OR (rpe BETWEEN 1 AND 10));

ALTER TABLE public.sessions
  DROP CONSTRAINT sessions_day_number_weekday;

-- save_draft_tree as 2026_08_22_draft_day_number_optional.sql left it.
CREATE OR REPLACE FUNCTION public.save_draft_tree(p_tree jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_student   uuid;
  v_pid       uuid        := (p_tree->'program'->>'id')::uuid;
  v_name      text        := COALESCE(NULLIF(trim(p_tree->'program'->>'name'), ''), 'My program');
  v_submitted timestamptz := NULLIF(p_tree->'program'->>'submitted_at','')::timestamptz;
  v_existing  text;
  v_bad       uuid;
  v_weeks int := 0; v_sessions int := 0; v_slots int := 0;
BEGIN
  IF v_pid IS NULL THEN RAISE EXCEPTION 'save_draft_tree: program id required'; END IF;
  SELECT id INTO v_student FROM public.students WHERE profile_id = auth.uid();
  IF v_student IS NULL THEN RAISE EXCEPTION 'save_draft_tree: no student profile'; END IF;

  SELECT status INTO v_existing FROM public.programs WHERE id = v_pid;
  IF v_existing IS NOT NULL AND v_existing <> 'draft' THEN
    RAISE EXCEPTION 'draft_not_editable' USING ERRCODE = 'P0001', DETAIL = 'program is no longer a draft';
  END IF;

  SELECT (s->>'exercise_id')::uuid INTO v_bad
    FROM jsonb_array_elements(COALESCE(p_tree->'slots','[]'::jsonb)) s
   WHERE (s->>'exercise_id')::uuid NOT IN (
     SELECT el.id FROM public.exercise_library el
     JOIN public.students st ON st.coach_id = el.coach_id
     WHERE st.profile_id = auth.uid())
   LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'exercise_unavailable' USING ERRCODE = 'P0001', DETAIL = v_bad::text;
  END IF;

  INSERT INTO public.programs (id, student_id, created_by, status, is_active, name, sort_order)
  VALUES (v_pid, v_student, auth.uid(), 'draft', false, v_name, 0)
  ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

  DELETE FROM public.weeks WHERE program_id = v_pid;

  INSERT INTO public.weeks (id, program_id, week_number, label)
  SELECT (w->>'id')::uuid, v_pid, (w->>'week_number')::int, NULLIF(w->>'label','')
    FROM jsonb_array_elements(COALESCE(p_tree->'weeks','[]'::jsonb)) w;
  GET DIAGNOSTICS v_weeks = ROW_COUNT;

  INSERT INTO public.sessions (id, week_id, title, day_number, sort_order)
  SELECT (s->>'id')::uuid, (s->>'week_id')::uuid,
         COALESCE(NULLIF(s->>'title',''),'Session'),
         -- No weekday chosen stays NULL (2026_08_22): sort_order is the order.
         (s->>'day_number')::int,
         COALESCE((s->>'sort_order')::int,0)
    FROM jsonb_array_elements(COALESCE(p_tree->'sessions','[]'::jsonb)) s;
  GET DIAGNOSTICS v_sessions = ROW_COUNT;

  INSERT INTO public.exercise_slots
    (id, session_id, exercise_id, sets, reps, weight_kg, duration_seconds, rest_seconds, sort_order)
  SELECT (s->>'id')::uuid, (s->>'session_id')::uuid, (s->>'exercise_id')::uuid,
         COALESCE((s->>'sets')::int,3),
         COALESCE((s->>'reps')::int, CASE WHEN (s->>'duration_seconds') IS NULL THEN 1 ELSE NULL END),
         (s->>'weight_kg')::numeric,
         (s->>'duration_seconds')::int,
         (s->>'rest_seconds')::int,
         COALESCE((s->>'sort_order')::int,0)
    FROM jsonb_array_elements(COALESCE(p_tree->'slots','[]'::jsonb)) s;
  GET DIAGNOSTICS v_slots = ROW_COUNT;

  IF v_submitted IS NOT NULL THEN
    UPDATE public.programs SET submitted_at = v_submitted WHERE id = v_pid AND submitted_at IS NULL;
  END IF;

  RETURN jsonb_build_object('program_id', v_pid, 'weeks', v_weeks, 'sessions', v_sessions, 'slots', v_slots);
END;
$$;

REVOKE ALL ON FUNCTION public.save_draft_tree(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_draft_tree(jsonb) TO authenticated;

DELETE FROM app_private.app_migrations WHERE name = '2026_10_16_21_rpe_half_steps_day_check';

-- A column of public changed its type back.
NOTIFY pgrst, 'reload schema';

COMMIT;
