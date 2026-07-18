-- ============================================================
-- Phase 3.4c — submit → approve/send-back loop.
--
-- When a student submits a draft (submitted_at NULL→set), notify the coach.
-- The coach then APPROVES (approve_program, 3.4a) or SENDS IT BACK
-- (send_back_program below — clears submitted_at so the student can revise).
-- ============================================================

CREATE OR REPLACE FUNCTION public.notify_coach_on_program_submit()
RETURNS TRIGGER AS $$
DECLARE
  v_coach_id       uuid;
  v_student_prof   uuid;
  v_student_row_id uuid;
  v_student_name   text;
  v_functions_url  text;
  v_service_key    text;
BEGIN
  -- Only on the NULL → set transition of a draft (the moment of submitting).
  -- Gating on OLD.submitted_at IS NULL (not just "changed") means a student
  -- cannot spam the coach by bumping an already-set submitted_at; a re-submit
  -- after send-back still fires because send_back_program resets it to NULL.
  IF NEW.status <> 'draft'
     OR NEW.submitted_at IS NULL
     OR OLD.submitted_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT s.coach_id, s.profile_id, s.id
    INTO v_coach_id, v_student_prof, v_student_row_id
    FROM public.students s WHERE s.id = NEW.student_id;
  IF v_coach_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT p.full_name INTO v_student_name FROM public.profiles p WHERE p.id = v_student_prof;

  INSERT INTO public.notifications (recipient_id, kind, payload)
  VALUES (
    v_coach_id,
    'program_submitted',
    jsonb_build_object(
      'program_id', NEW.id,
      'program_name', NEW.name,
      'student_profile_id', v_student_prof,
      'student_row_id', v_student_row_id,
      'student_name', v_student_name
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
          'user_id', v_coach_id,
          'payload', jsonb_build_object(
            'title', 'Program submitted',
            'body',  COALESCE(v_student_name, 'Your athlete') || ' submitted a program for approval'
                     || COALESCE(': ' || NEW.name, ''),
            'tag',   'program-submitted-' || NEW.id::text,
            'data',  jsonb_build_object(
              'url', '/sl_app/#/coach/students/' || COALESCE(v_student_row_id::text, '') || '/programming'
            )
          )
        )
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'send-push fan-out (program submitted) failed: %', SQLERRM;
  END;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_notify_coach_on_program_submit ON public.programs;
CREATE TRIGGER trg_notify_coach_on_program_submit
  AFTER UPDATE ON public.programs
  FOR EACH ROW EXECUTE FUNCTION public.notify_coach_on_program_submit();

-- Coach sends a submitted draft back for revision: clears submitted_at (status
-- stays 'draft', so the student can edit again) and notifies the student.
CREATE OR REPLACE FUNCTION public.send_back_program(p_program_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_student_id   uuid;
  v_student_prof uuid;
  v_coach_id     uuid;
  v_prog_name    text;
  v_functions_url text;
  v_service_key   text;
BEGIN
  SELECT p.student_id, p.name INTO v_student_id, v_prog_name
    FROM public.programs p WHERE p.id = p_program_id AND p.status = 'draft' AND p.submitted_at IS NOT NULL;
  IF v_student_id IS NULL THEN
    RETURN jsonb_build_object('sent_back', false);
  END IF;
  SELECT s.coach_id, s.profile_id INTO v_coach_id, v_student_prof
    FROM public.students s WHERE s.id = v_student_id;
  IF v_coach_id IS NULL OR v_coach_id <> auth.uid() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  UPDATE public.programs SET submitted_at = NULL WHERE id = p_program_id;

  IF v_student_prof IS NOT NULL THEN
    INSERT INTO public.notifications (recipient_id, kind, payload)
    VALUES (v_student_prof, 'program_sent_back',
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
            'title', 'Program sent back',
            'body',  'Your coach sent your program back for changes' || COALESCE(': ' || v_prog_name, ''),
            'tag',   'program-sent-back-' || p_program_id::text,
            'data',  jsonb_build_object('url', '/sl_app/#/student/author')))
        );
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'send-push fan-out (program sent back) failed: %', SQLERRM;
    END;
  END IF;

  RETURN jsonb_build_object('sent_back', true);
END;
$$;

REVOKE ALL ON FUNCTION public.send_back_program(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.send_back_program(uuid) TO authenticated;
