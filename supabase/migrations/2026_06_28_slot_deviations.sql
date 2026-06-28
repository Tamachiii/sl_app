-- Phase 2 of student-authored deviations: STRUCTURAL off-script changes.
-- Three primitives, all anchored to a coach-prescribed slot, none of which
-- mutate the coach's prescription:
--   1. Skip / add SETS      -> set_logs.skipped / set_logs.is_student_added
--   2. Swap / skip EXERCISE -> new slot_deviations table (one row per slot)
-- The coach is notified (in-app + best-effort Web Push) the first time a slot
-- goes off-script, reusing the session-confirm + feedback-push patterns.

-- ------------------------------------------------------------
-- 1. set_logs: per-set skip + student-added extra sets
-- ------------------------------------------------------------
ALTER TABLE public.set_logs
  ADD COLUMN IF NOT EXISTS skipped          boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_student_added boolean NOT NULL DEFAULT false;

-- A skipped set is neither done nor failed (the student chose not to do it).
ALTER TABLE public.set_logs
  DROP CONSTRAINT IF EXISTS set_logs_skipped_not_resolved,
  ADD  CONSTRAINT set_logs_skipped_not_resolved
    CHECK (NOT (skipped AND (done OR failed)));

COMMENT ON COLUMN public.set_logs.skipped IS
  'Student intentionally skipped this prescribed set (vs simply leaving it pending). Mutually exclusive with done/failed.';
COMMENT ON COLUMN public.set_logs.is_student_added IS
  'Set the student logged beyond the prescription (target_* are NULL on these rows).';

-- ------------------------------------------------------------
-- 2. slot_deviations: swap / skip a whole exercise
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.slot_deviations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exercise_slot_id       uuid NOT NULL UNIQUE REFERENCES public.exercise_slots(id) ON DELETE CASCADE,
  student_id             uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  kind                   text NOT NULL CHECK (kind IN ('swap', 'skip')),
  -- Library-only substitutes (no free-text) so every swap stays a known
  -- exercise and analytics don't get a blind spot. RESTRICT mirrors
  -- exercise_slots.exercise_id: a coach can't delete a library exercise a
  -- student is using as a substitute.
  substitute_exercise_id uuid REFERENCES public.exercise_library(id) ON DELETE RESTRICT,
  note                   text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slot_deviations_swap_has_substitute CHECK (
    (kind = 'swap' AND substitute_exercise_id IS NOT NULL)
    OR (kind = 'skip' AND substitute_exercise_id IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_slot_deviations_slot_id ON public.slot_deviations(exercise_slot_id);

ALTER TABLE public.slot_deviations ENABLE ROW LEVEL SECURITY;

-- RLS mirrors slot_comments: student owns the row (read stays permissive so
-- old deviations show on archived/past sessions; writes gated to the active,
-- non-archived program), coach reads their students' rows.
DROP POLICY IF EXISTS "Students read own slot deviations" ON public.slot_deviations;
CREATE POLICY "Students read own slot deviations"
  ON public.slot_deviations FOR SELECT
  USING (
    student_id = auth.uid()
    AND public.student_profile_for_slot(exercise_slot_id) = auth.uid()
  );

DROP POLICY IF EXISTS "Students insert own slot deviations" ON public.slot_deviations;
CREATE POLICY "Students insert own slot deviations"
  ON public.slot_deviations FOR INSERT
  WITH CHECK (
    student_id = auth.uid()
    AND public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND NOT EXISTS (
      SELECT 1 FROM public.exercise_slots es
      JOIN public.sessions s ON s.id = es.session_id
      WHERE es.id = slot_deviations.exercise_slot_id AND s.archived_at IS NOT NULL
    )
    AND public.program_active_for_slot(exercise_slot_id) = true
  );

DROP POLICY IF EXISTS "Students update own slot deviations" ON public.slot_deviations;
CREATE POLICY "Students update own slot deviations"
  ON public.slot_deviations FOR UPDATE
  USING (
    student_id = auth.uid()
    AND public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND public.program_active_for_slot(exercise_slot_id) = true
  )
  WITH CHECK (
    student_id = auth.uid()
    AND public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND public.program_active_for_slot(exercise_slot_id) = true
  );

DROP POLICY IF EXISTS "Students delete own slot deviations" ON public.slot_deviations;
CREATE POLICY "Students delete own slot deviations"
  ON public.slot_deviations FOR DELETE
  USING (
    student_id = auth.uid()
    AND public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND public.program_active_for_slot(exercise_slot_id) = true
  );

DROP POLICY IF EXISTS "Coaches read slot deviations for their students" ON public.slot_deviations;
CREATE POLICY "Coaches read slot deviations for their students"
  ON public.slot_deviations FOR SELECT
  USING (
    public.student_profile_for_slot(exercise_slot_id) IN (
      SELECT profile_id FROM public.students WHERE coach_id = auth.uid()
    )
  );

-- ------------------------------------------------------------
-- 3. Notify the coach when a slot first goes off-script
--    (AFTER INSERT only, mirroring notify_coach_on_session_confirm —
--     editing an existing deviation does not re-notify, avoiding spam).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_coach_on_slot_deviation()
RETURNS TRIGGER AS $$
DECLARE
  v_session_id      uuid;
  v_coach_id        uuid;
  v_student_profile uuid;
  v_student_row_id  uuid;
  v_student_name    text;
  v_session_title   text;
  v_original_name   text;
  v_substitute_name text;
  v_functions_url   text;
  v_service_key     text;
  v_body            text;
BEGIN
  SELECT es.session_id INTO v_session_id
    FROM public.exercise_slots es
   WHERE es.id = NEW.exercise_slot_id;

  v_coach_id        := public.coach_profile_for_session(v_session_id);
  v_student_profile := public.student_profile_for_session(v_session_id);

  IF v_coach_id IS NULL OR v_student_profile IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT s.id INTO v_student_row_id
    FROM public.students s WHERE s.profile_id = v_student_profile;
  SELECT p.full_name INTO v_student_name
    FROM public.profiles p WHERE p.id = v_student_profile;
  SELECT COALESCE(NULLIF(BTRIM(s.title), ''), 'Session') INTO v_session_title
    FROM public.sessions s WHERE s.id = v_session_id;
  SELECT el.name INTO v_original_name
    FROM public.exercise_slots es
    JOIN public.exercise_library el ON el.id = es.exercise_id
   WHERE es.id = NEW.exercise_slot_id;
  IF NEW.substitute_exercise_id IS NOT NULL THEN
    SELECT el.name INTO v_substitute_name
      FROM public.exercise_library el WHERE el.id = NEW.substitute_exercise_id;
  END IF;

  INSERT INTO public.notifications (recipient_id, kind, payload)
  VALUES (
    v_coach_id,
    'session_deviation',
    jsonb_build_object(
      'session_id',        v_session_id,
      'session_title',     v_session_title,
      'student_profile_id', v_student_profile,
      'student_row_id',    v_student_row_id,
      'student_name',      v_student_name,
      'slot_id',           NEW.exercise_slot_id,
      'deviation_kind',    NEW.kind,
      'original_exercise', v_original_name,
      'substitute_exercise', v_substitute_name
    )
  );

  -- Best-effort Web Push (same pattern as notify_student_on_session_feedback).
  BEGIN
    SELECT decrypted_secret INTO v_functions_url
      FROM vault.decrypted_secrets WHERE name = 'app_functions_url';
    SELECT decrypted_secret INTO v_service_key
      FROM vault.decrypted_secrets WHERE name = 'app_service_role_key';

    IF v_functions_url IS NOT NULL AND v_service_key IS NOT NULL
       AND v_functions_url <> '' AND v_service_key <> ''
    THEN
      IF NEW.kind = 'swap' THEN
        v_body := COALESCE(v_student_name, 'Your athlete') || ' swapped '
                  || COALESCE(v_original_name, 'an exercise') || ' → '
                  || COALESCE(v_substitute_name, 'another exercise')
                  || ' in ' || v_session_title;
      ELSE
        v_body := COALESCE(v_student_name, 'Your athlete') || ' skipped '
                  || COALESCE(v_original_name, 'an exercise')
                  || ' in ' || v_session_title;
      END IF;

      PERFORM net.http_post(
        url := v_functions_url || '/send-push',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || v_service_key
        ),
        body := jsonb_build_object(
          'user_id', v_coach_id,
          'payload', jsonb_build_object(
            'title', 'Off-plan session',
            'body',  v_body,
            'tag',   'deviation-' || NEW.id::text,
            'data',  jsonb_build_object(
              'url', '/sl_app/#/coach/student/' || COALESCE(v_student_row_id::text, '')
                     || '/session/' || v_session_id::text || '/review'
            )
          )
        )
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'send-push fan-out (slot deviation) failed: %', SQLERRM;
  END;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_notify_coach_on_slot_deviation ON public.slot_deviations;
CREATE TRIGGER trg_notify_coach_on_slot_deviation
  AFTER INSERT ON public.slot_deviations
  FOR EACH ROW EXECUTE FUNCTION public.notify_coach_on_slot_deviation();
