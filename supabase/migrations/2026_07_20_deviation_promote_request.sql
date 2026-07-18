-- ============================================================
-- Phase 3.3 — student proposal loop: "ask coach to make this permanent".
--
-- A deviation (swap/skip) is captured whether it's a one-off or a genuine
-- change request. This adds an EXPLICIT student signal: the student can flag a
-- deviation as a proposal to adopt it into the program. The coach then either
-- APPROVES (runs the existing adopt_swap / adopt_skip — which already notify
-- the student on success) or DECLINES (decline_promote_request below).
--
-- Kept lightweight: a nullable flag on the existing slot_deviations row (the
-- deviation IS the proposal), not a separate table. The student sets it via a
-- normal UPDATE of their own row (existing student-UPDATE RLS covers it); an
-- AFTER UPDATE trigger notifies the coach on the NULL→set transition.
-- ============================================================

ALTER TABLE public.slot_deviations
  ADD COLUMN IF NOT EXISTS promote_requested_at timestamptz;

-- Notify the coach when a student asks to make a deviation permanent.
CREATE OR REPLACE FUNCTION public.notify_coach_on_promote_request()
RETURNS TRIGGER AS $$
DECLARE
  v_session_id      uuid;
  v_coach_id        uuid;
  v_student_prof    uuid;
  v_student_row_id  uuid;
  v_student_name    text;
  v_session_title   text;
  v_original_name   text;
  v_substitute_name text;
  v_functions_url   text;
  v_service_key     text;
  v_body            text;
BEGIN
  -- Only on the NULL → set transition (the moment of asking).
  IF NEW.promote_requested_at IS NULL
     OR NEW.promote_requested_at IS NOT DISTINCT FROM OLD.promote_requested_at THEN
    RETURN NEW;
  END IF;

  SELECT es.session_id INTO v_session_id
    FROM public.exercise_slots es WHERE es.id = NEW.exercise_slot_id;
  v_coach_id     := public.coach_profile_for_session(v_session_id);
  v_student_prof := public.student_profile_for_session(v_session_id);
  IF v_coach_id IS NULL OR v_student_prof IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT st.id INTO v_student_row_id FROM public.students st WHERE st.profile_id = v_student_prof;
  SELECT p.full_name INTO v_student_name FROM public.profiles p WHERE p.id = v_student_prof;
  SELECT COALESCE(NULLIF(BTRIM(s.title), ''), 'Session') INTO v_session_title
    FROM public.sessions s WHERE s.id = v_session_id;
  SELECT el.name INTO v_original_name
    FROM public.exercise_slots es JOIN public.exercise_library el ON el.id = es.exercise_id
   WHERE es.id = NEW.exercise_slot_id;
  IF NEW.substitute_exercise_id IS NOT NULL THEN
    SELECT el.name INTO v_substitute_name FROM public.exercise_library el WHERE el.id = NEW.substitute_exercise_id;
  END IF;

  INSERT INTO public.notifications (recipient_id, kind, payload)
  VALUES (
    v_coach_id,
    'promote_requested',
    jsonb_build_object(
      'session_id', v_session_id,
      'session_title', v_session_title,
      'student_profile_id', v_student_prof,
      'student_row_id', v_student_row_id,
      'student_name', v_student_name,
      'slot_id', NEW.exercise_slot_id,
      'deviation_kind', NEW.kind,
      'original_exercise', v_original_name,
      'substitute_exercise', v_substitute_name
    )
  );

  BEGIN
    SELECT decrypted_secret INTO v_functions_url FROM vault.decrypted_secrets WHERE name = 'app_functions_url';
    SELECT decrypted_secret INTO v_service_key   FROM vault.decrypted_secrets WHERE name = 'app_service_role_key';
    IF v_functions_url IS NOT NULL AND v_service_key IS NOT NULL
       AND v_functions_url <> '' AND v_service_key <> '' THEN
      IF NEW.kind = 'swap' THEN
        v_body := COALESCE(v_student_name, 'Your athlete') || ' wants to keep '
                  || COALESCE(v_substitute_name, 'their swap') || ' instead of '
                  || COALESCE(v_original_name, 'the prescription');
      ELSE
        v_body := COALESCE(v_student_name, 'Your athlete') || ' wants to drop '
                  || COALESCE(v_original_name, 'an exercise') || ' going forward';
      END IF;
      PERFORM net.http_post(
        url := v_functions_url || '/send-push',
        headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_service_key),
        body := jsonb_build_object(
          'user_id', v_coach_id,
          'payload', jsonb_build_object(
            'title', 'Program change requested',
            'body',  v_body,
            'tag',   'promote-req-' || NEW.exercise_slot_id::text,
            'data',  jsonb_build_object(
              'url', '/sl_app/#/coach/student/' || COALESCE(v_student_row_id::text, '')
                     || '/session/' || v_session_id::text || '/review'
            )
          )
        )
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'send-push fan-out (promote request) failed: %', SQLERRM;
  END;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_notify_coach_on_promote_request ON public.slot_deviations;
CREATE TRIGGER trg_notify_coach_on_promote_request
  AFTER UPDATE ON public.slot_deviations
  FOR EACH ROW EXECUTE FUNCTION public.notify_coach_on_promote_request();

-- Coach declines a promote request: clears the flag and gives the student
-- closure. Coach-only SECURITY DEFINER (coaches have SELECT-only on
-- slot_deviations, so the write must go through a self-authorizing definer).
CREATE OR REPLACE FUNCTION public.decline_promote_request(p_slot_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session_id    uuid;
  v_coach_id      uuid;
  v_student_prof  uuid;
  v_original_name text;
  v_coach_name    text;
  v_session_title text;
  v_functions_url text;
  v_service_key   text;
  v_had_request   boolean;
BEGIN
  SELECT es.session_id INTO v_session_id
    FROM public.exercise_slots es WHERE es.id = p_slot_id;
  IF v_session_id IS NULL THEN
    RAISE EXCEPTION 'slot not found';
  END IF;

  v_coach_id := public.coach_profile_for_session(v_session_id);
  IF v_coach_id IS NULL OR v_coach_id <> auth.uid() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  UPDATE public.slot_deviations
     SET promote_requested_at = NULL
   WHERE exercise_slot_id = p_slot_id
     AND promote_requested_at IS NOT NULL;
  GET DIAGNOSTICS v_had_request = ROW_COUNT;

  -- Graceful no-op if there was nothing pending (double-submit safe).
  IF NOT v_had_request THEN
    RETURN jsonb_build_object('declined', false);
  END IF;

  v_student_prof := public.student_profile_for_session(v_session_id);
  IF v_student_prof IS NOT NULL THEN
    SELECT el.name INTO v_original_name
      FROM public.exercise_slots es JOIN public.exercise_library el ON el.id = es.exercise_id
     WHERE es.id = p_slot_id;
    SELECT p.full_name INTO v_coach_name FROM public.profiles p WHERE p.id = v_coach_id;
    SELECT COALESCE(NULLIF(BTRIM(s.title), ''), 'Session') INTO v_session_title
      FROM public.sessions s WHERE s.id = v_session_id;

    INSERT INTO public.notifications (recipient_id, kind, payload)
    VALUES (
      v_student_prof,
      'promote_declined',
      jsonb_build_object(
        'session_id', v_session_id,
        'session_title', v_session_title,
        'coach_name', v_coach_name,
        'original_exercise', v_original_name
      )
    );

    BEGIN
      SELECT decrypted_secret INTO v_functions_url FROM vault.decrypted_secrets WHERE name = 'app_functions_url';
      SELECT decrypted_secret INTO v_service_key   FROM vault.decrypted_secrets WHERE name = 'app_service_role_key';
      IF v_functions_url IS NOT NULL AND v_service_key IS NOT NULL
         AND v_functions_url <> '' AND v_service_key <> '' THEN
        PERFORM net.http_post(
          url := v_functions_url || '/send-push',
          headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_service_key),
          body := jsonb_build_object(
            'user_id', v_student_prof,
            'payload', jsonb_build_object(
              'title', 'Coach kept your plan',
              'body',  COALESCE(v_coach_name, 'Your coach') || ' is keeping '
                       || COALESCE(v_original_name, 'the prescribed exercise') || ' in your program',
              'tag',   'promote-declined-' || p_slot_id::text,
              'data',  jsonb_build_object('url', '/sl_app/#/student/session/' || v_session_id::text)
            )
          )
        );
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'send-push fan-out (promote declined) failed: %', SQLERRM;
    END;
  END IF;

  RETURN jsonb_build_object('declined', true);
END;
$$;

REVOKE ALL ON FUNCTION public.decline_promote_request(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.decline_promote_request(uuid) TO authenticated;
