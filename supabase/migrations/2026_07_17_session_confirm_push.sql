-- ============================================================
-- Web Push for session confirmations.
--
-- notify_coach_on_session_confirm (2026_04_30_notifications.sql) inserts an
-- in-app 'session_completed' notification when a student confirms a session,
-- but — unlike the slot-deviation and feedback triggers — it never fired a
-- Web Push. So a coach with the new push toggle enabled got a lock-screen
-- push when a student SWAPPED an exercise, but nothing when the student
-- actually COMPLETED the session — the coach's primary signal.
--
-- This replaces the function to add the same best-effort send-push block the
-- deviation trigger uses (2026_06_28_slot_deviations.sql): Vault-gated,
-- EXCEPTION-wrapped so push failure can never roll back the confirmation, and
-- skipped silently when the app_functions_url / app_service_role_key secrets
-- aren't set. The trigger itself is unchanged — replacing the function is
-- enough. The in-app notification insert is preserved verbatim.
--
-- Deep link matches the client's 'session_completed' route
-- (useNotifications.js): /coach/student/<row>/session/<id>/review.
-- ============================================================

CREATE OR REPLACE FUNCTION public.notify_coach_on_session_confirm()
RETURNS TRIGGER AS $$
DECLARE
  v_coach_id          uuid;
  v_student_profile   uuid;
  v_student_row_id    uuid;
  v_student_name      text;
  v_session_title     text;
  v_functions_url     text;
  v_service_key       text;
BEGIN
  v_coach_id        := public.coach_profile_for_session(NEW.session_id);
  v_student_profile := public.student_profile_for_session(NEW.session_id);

  IF v_coach_id IS NULL OR v_student_profile IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT s.id INTO v_student_row_id
    FROM public.students s
   WHERE s.profile_id = v_student_profile;

  SELECT p.full_name INTO v_student_name
    FROM public.profiles p
   WHERE p.id = v_student_profile;

  SELECT COALESCE(NULLIF(BTRIM(s.title), ''), 'Session') INTO v_session_title
    FROM public.sessions s
   WHERE s.id = NEW.session_id;

  -- In-app notification (existing behavior, unchanged).
  INSERT INTO public.notifications (recipient_id, kind, payload)
  VALUES (
    v_coach_id,
    'session_completed',
    jsonb_build_object(
      'session_id', NEW.session_id,
      'session_title', v_session_title,
      'student_profile_id', v_student_profile,
      'student_row_id', v_student_row_id,
      'student_name', v_student_name,
      'confirmation_id', NEW.id
    )
  );

  -- Best-effort Web Push (same pattern as notify_coach_on_slot_deviation).
  BEGIN
    SELECT decrypted_secret INTO v_functions_url
      FROM vault.decrypted_secrets WHERE name = 'app_functions_url';
    SELECT decrypted_secret INTO v_service_key
      FROM vault.decrypted_secrets WHERE name = 'app_service_role_key';

    IF v_functions_url IS NOT NULL AND v_service_key IS NOT NULL
       AND v_functions_url <> '' AND v_service_key <> ''
    THEN
      PERFORM net.http_post(
        url := v_functions_url || '/send-push',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || v_service_key
        ),
        body := jsonb_build_object(
          'user_id', v_coach_id,
          'payload', jsonb_build_object(
            'title', 'Session completed',
            'body',  COALESCE(v_student_name, 'Your athlete')
                     || ' completed ' || v_session_title,
            'tag',   'session-confirm-' || NEW.id::text,
            'data',  jsonb_build_object(
              'url', '/sl_app/#/coach/student/' || COALESCE(v_student_row_id::text, '')
                     || '/session/' || NEW.session_id::text || '/review'
            )
          )
        )
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Push delivery must never break the confirmation INSERT; the bell
    -- notification still lights up for an open tab.
    RAISE WARNING 'send-push fan-out (session confirm) failed: %', SQLERRM;
  END;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger already exists from 2026_04_30_notifications.sql; replacing the
-- function above takes effect without re-creating the trigger.
