-- Rollback of 2026_10_11_06_pin_student_writes: removes the pin on the sessions
-- of a draft, and gives three functions back the text they had before.
--
-- !! IT REOPENS FINDINGS P13, P14 AND B4. After this file an athlete can
-- !! again mark a prescribed set as "added by me" and delete it, renumber a
-- !! set or move it to another exercise, send a draft in with its sessions
-- !! already marked reviewed, archived or trained, and take a submission
-- !! back and make it again — one notification to the coach each time.
--
-- There is one reason to run it: after the migration, something the app does
-- is refused or lost that worked before — an athlete's set that no longer
-- saves, a confirmed session that shows no training date, a coach who can no
-- longer approve a draft. Report what was being done, and re-apply the
-- migration as soon as it is understood
-- (docs/runbook/migrations/06-pin-student-writes.md).
--
-- What it does:
--   * drops the trigger on sessions and its function;
--   * gives pin_set_log_targets_for_student, pin_program_authoring_columns
--     and approve_program the text they had after migration 05. Their
--     triggers on set_logs and on programs stay: they were there before.
-- No table and no row is touched. What approve_program cleared on a draft it
-- approved while the migration was in place stays cleared.
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
    RAISE EXCEPTION 'migration 2026_10_11_06_pin_student_writes is not applied: there is no app_private.app_migrations'
      USING ERRCODE = 'SLM03', HINT = 'Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_11_06_pin_student_writes') THEN
    RAISE EXCEPTION 'migration 2026_10_11_06_pin_student_writes is not applied'
      USING ERRCODE = 'SLM03', HINT = 'Nothing was changed.';
  END IF;

  SELECT string_agg(name, ', ' ORDER BY name) INTO v_later
    FROM app_private.app_migrations
   WHERE substring(name from '^[0-9]{4}_[0-9]{2}_[0-9]{2}_([0-9]{2})_')::int > 6;
  IF v_later IS NOT NULL THEN
    RAISE EXCEPTION 'the ledger still records later migrations: %', v_later
      USING ERRCODE = 'SLM04', HINT = 'Roll those back first. Nothing was changed.';
  END IF;
END
$guard$;

-- ------------------------------------------------------------
-- The trigger of the migration, then its function.
-- ------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_pin_draft_session_columns ON public.sessions;
DROP FUNCTION IF EXISTS public.pin_draft_session_columns();

-- ------------------------------------------------------------
-- The three functions the migration re-created, as they were. CREATE OR
-- REPLACE keeps their grants; the search_path is repeated because it would be
-- dropped otherwise.
-- ------------------------------------------------------------
-- The targets only, and whose set it is asked of the row as it would BE.
CREATE OR REPLACE FUNCTION public.pin_set_log_targets_for_student()
RETURNS trigger AS $$
BEGIN
  IF public.student_profile_for_slot(NEW.exercise_slot_id) = auth.uid() THEN
    NEW.target_reps             := OLD.target_reps;
    NEW.target_duration_seconds := OLD.target_duration_seconds;
    NEW.target_weight_kg        := OLD.target_weight_kg;
    NEW.target_rest_seconds     := OLD.target_rest_seconds;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- status and approved_at for the author; submitted_at is theirs to set and
-- to clear again.
CREATE OR REPLACE FUNCTION public.pin_program_authoring_columns()
RETURNS TRIGGER AS $$
BEGIN
  -- created_by + student_id immutable for everyone (tenant isolation: a draft
  -- author can never re-point their draft to another student).
  NEW.created_by := OLD.created_by;
  NEW.student_id := OLD.student_id;
  IF auth.uid() IS NOT DISTINCT FROM OLD.created_by THEN
    NEW.status := OLD.status;
    NEW.approved_at := OLD.approved_at;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- The text of migration 02: the sessions of the program are left as the
-- draft carried them.
CREATE OR REPLACE FUNCTION public.approve_program(p_program_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_student_id   uuid;
  v_student_prof uuid;
  v_coach_id     uuid;
  v_prog_name    text;
  v_created      int := 0;
  v_functions_url text;
  v_service_key   text;
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
    BEGIN
      SELECT decrypted_secret INTO v_functions_url FROM vault.decrypted_secrets WHERE name = 'app_functions_url';
      SELECT decrypted_secret INTO v_service_key   FROM vault.decrypted_secrets WHERE name = 'app_service_role_key';
      IF v_functions_url IS NOT NULL AND v_service_key IS NOT NULL
         AND v_functions_url <> '' AND v_service_key <> '' THEN
        PERFORM net.http_post(
          url := v_functions_url || '/send-push',
          headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_service_key),
          body := jsonb_build_object('user_id', v_student_prof, 'payload', jsonb_build_object(
            'title', 'Program approved',
            'body',  'Your coach approved your program' || COALESCE(': ' || v_prog_name, ''),
            'tag',   'program-approved-' || p_program_id::text,
            'data',  jsonb_build_object('url', '/sl_app/#/student')))
        );
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'send-push fan-out (program approved) failed: %', SQLERRM;
    END;
  END IF;

  RETURN jsonb_build_object('approved', true, 'set_logs_created', v_created);
END;
$$;

DELETE FROM app_private.app_migrations WHERE name = '2026_10_11_06_pin_student_writes';

-- A function left public: PostgREST has to forget it.
NOTIFY pgrst, 'reload schema';

COMMIT;
