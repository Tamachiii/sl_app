-- Rollback of 2026_10_16_20_drafts_coach_readonly: the coach of an athlete
-- writes the phases, sessions, exercises and sets of that athlete's draft
-- again, and approve_program is the one of migration 15 — the missing sets
-- added first, the program marked approved last.
--
-- !! THIS REOPENS FINDING P53. From this file on, a change the coach makes
-- !! in a draft is accepted — and lost at the athlete's next save; and the
-- !! sets without a target that the coach's editor adds to a draft outlive
-- !! its approval: the athlete trains sessions without reps or load.
--
-- Every app works without the migration as it did before it: none of them
-- needs the refusal, and approve_program answers the same either way. There
-- is no reason to run this file other than the check of the page answering
-- NOT PROTECTED or BROKEN, or a migration applied to the wrong project
-- (docs/runbook/migrations/20-drafts-coach-readonly.md).
--
-- No row is written or deleted by this file. A draft approved while the
-- migration was in place keeps the sets it was given.
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
    RAISE EXCEPTION 'migration 2026_10_16_20_drafts_coach_readonly is not applied: there is no app_private.app_migrations'
      USING ERRCODE = 'SLM03', HINT = 'Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_16_20_drafts_coach_readonly') THEN
    RAISE EXCEPTION 'migration 2026_10_16_20_drafts_coach_readonly is not applied'
      USING ERRCODE = 'SLM03', HINT = 'Nothing was changed.';
  END IF;

  SELECT string_agg(name, ', ' ORDER BY name) INTO v_later
    FROM app_private.app_migrations
   WHERE substring(name from '^[0-9]{4}_[0-9]{2}_[0-9]{2}_([0-9]{2})_')::int > 20;
  IF v_later IS NOT NULL THEN
    RAISE EXCEPTION 'the ledger still records later migrations: %', v_later
      USING ERRCODE = 'SLM04', HINT = 'Roll those back first. Nothing was changed.';
  END IF;
END
$guard$;

-- The triggers first, from the top of the tree down — the order in which
-- the migration took the four tables —, then their functions.
DROP TRIGGER IF EXISTS block_draft_tree_write ON public.weeks;
DROP TRIGGER IF EXISTS block_draft_tree_write ON public.sessions;
DROP TRIGGER IF EXISTS block_draft_tree_write ON public.exercise_slots;
DROP TRIGGER IF EXISTS block_draft_tree_write ON public.set_logs;
DROP FUNCTION IF EXISTS public.block_draft_week_write();
DROP FUNCTION IF EXISTS public.block_draft_session_write();
DROP FUNCTION IF EXISTS public.block_draft_slot_write();
DROP FUNCTION IF EXISTS public.block_draft_set_log_write();

-- approve_program as migration 15 wrote it, byte for byte (copied from
-- 2026_10_13_15_push_plumbing.sql). CREATE OR REPLACE keeps the privileges;
-- they are said again all the same.
CREATE OR REPLACE FUNCTION public.approve_program(p_program_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_student_id   uuid;
  v_student_prof uuid;
  v_coach_id     uuid;
  v_prog_name    text;
  v_created      int := 0;
BEGIN
  SELECT p.student_id, p.name INTO v_student_id, v_prog_name
    FROM public.programs p WHERE p.id = p_program_id AND p.status = 'draft';
  IF v_student_id IS NULL THEN
    RETURN jsonb_build_object('approved', false);
  END IF;
  SELECT s.coach_id, s.profile_id INTO v_coach_id, v_student_prof
    FROM public.students s WHERE s.id = v_student_id;
  -- auth.uid() IS NULL is tested first, and the comparison is NULL-safe: with
  -- a plain `<>` a caller without a session skipped this RAISE (review P1).
  IF auth.uid() IS NULL OR v_coach_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  -- No session of the program enters its life as reviewed, archived, trained
  -- or dated (review P13): those are written after approval, by the coach and
  -- by the athlete's confirmation.
  UPDATE public.sessions s
     SET reviewed_at = NULL, archived_at = NULL, performed_at = NULL, scheduled_date = NULL
    FROM public.weeks w
   WHERE w.id = s.week_id
     AND w.program_id = p_program_id
     AND (s.reviewed_at IS NOT NULL OR s.archived_at IS NOT NULL
          OR s.performed_at IS NOT NULL OR s.scheduled_date IS NOT NULL);

  INSERT INTO public.set_logs
    (exercise_slot_id, set_number, done, target_reps, target_duration_seconds, target_weight_kg, target_rest_seconds)
  SELECT es.id, gs.n, false, es.reps, es.duration_seconds, es.weight_kg, es.rest_seconds
    FROM public.exercise_slots es
    JOIN public.sessions s ON s.id = es.session_id
    JOIN public.weeks w    ON w.id = s.week_id
    CROSS JOIN LATERAL generate_series(1, GREATEST(es.sets, 1)) AS gs(n)
   WHERE w.program_id = p_program_id
     AND NOT EXISTS (SELECT 1 FROM public.set_logs sl WHERE sl.exercise_slot_id = es.id AND sl.set_number = gs.n);
  GET DIAGNOSTICS v_created = ROW_COUNT;

  UPDATE public.programs SET status = 'approved', approved_at = now(), submitted_at = NULL
   WHERE id = p_program_id;

  IF v_student_prof IS NOT NULL THEN
    INSERT INTO public.notifications (recipient_id, kind, payload)
    VALUES (v_student_prof, 'program_approved',
      jsonb_build_object('program_id', p_program_id, 'program_name', v_prog_name));
    -- Best-effort Web Push, through send_push_event (2026_10_13_15). Whatever
    -- it raises stays a warning: a push never undoes the write that caused it.
    BEGIN
      PERFORM public.send_push_event(
        v_student_prof,
        jsonb_build_object(
          'title', 'Program approved',
          'body',  'Your coach approved your program' || COALESCE(': ' || v_prog_name, ''),
          'tag',   'program-approved-' || p_program_id::text,
          'data',  jsonb_build_object('url', '/sl_app/#/student')
        )
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'send-push fan-out (program approved) failed: %', SQLERRM;
    END;
  END IF;

  RETURN jsonb_build_object('approved', true, 'set_logs_created', v_created);
END;
$$;

REVOKE ALL ON FUNCTION public.approve_program(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.approve_program(uuid) TO authenticated;

DELETE FROM app_private.app_migrations WHERE name = '2026_10_16_20_drafts_coach_readonly';

-- Four functions left public: PostgREST must forget them.
NOTIFY pgrst, 'reload schema';

COMMIT;
