-- Rollback of 2026_10_13_09_review_lifecycle: removes the four triggers and
-- their functions, gives the three policies and the push of a confirmation
-- the text they had, and takes session_writable(uuid) back from signed-in
-- users.
--
-- !! IT REOPENS FINDING P57 AND THE SERVER HALF OF L12. After this file an
-- !! athlete can again take a confirmation back after the coach's review; a
-- !! coach can again review — with feedback or without — a session its
-- !! athlete has not confirmed, which then never comes into the "to review"
-- !! list; and a confirmation, a swap or a skip that is taken back leaves
-- !! its notification in the coach's bell.
--
-- There is one reason to run it: after the migration, something the app does
-- on a session that is NOT reviewed is refused — an athlete who can no longer
-- confirm, or undo a confirmation the coach has not reviewed; a coach whose
-- feedback on a confirmed session is not sent. Report what was being done,
-- and re-apply the migration as soon as it is understood
-- (docs/runbook/migrations/09-review-lifecycle.md).
--
-- What it does:
--   * drops trg_review_needs_confirmation (sessions),
--     block_confirmation_delete_when_reviewed and
--     trg_retract_session_completed_notification (session_confirmations),
--     trg_retract_slot_deviation_notifications (slot_deviations), and the
--     four functions they call;
--   * re-creates "Students update own session confirmations", "Students
--     delete own session confirmations" and "Send to coach-student
--     counterpart" with the text of the baseline;
--   * gives notify_coach_on_session_confirm the text it had after migration
--     03 (the push is tagged by confirmation again);
--   * drops session_is_confirmed, and revokes EXECUTE on session_writable(uuid)
--     from authenticated: no policy asks it any more.
-- No table and no row is touched. THE NOTIFICATIONS THE MIGRATION DELETED DO
-- NOT COME BACK, nor the ones its triggers removed while it was in place:
-- they were about confirmations, swaps and skips that no longer exist.
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
    RAISE EXCEPTION 'migration 2026_10_13_09_review_lifecycle is not applied: there is no app_private.app_migrations'
      USING ERRCODE = 'SLM03', HINT = 'Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_13_09_review_lifecycle') THEN
    RAISE EXCEPTION 'migration 2026_10_13_09_review_lifecycle is not applied'
      USING ERRCODE = 'SLM03', HINT = 'Nothing was changed.';
  END IF;

  SELECT string_agg(name, ', ' ORDER BY name) INTO v_later
    FROM app_private.app_migrations
   WHERE substring(name from '^[0-9]{4}_[0-9]{2}_[0-9]{2}_([0-9]{2})_')::int > 9;
  IF v_later IS NOT NULL THEN
    RAISE EXCEPTION 'the ledger still records later migrations: %', v_later
      USING ERRCODE = 'SLM04', HINT = 'Roll those back first. Nothing was changed.';
  END IF;
END
$guard$;

-- ------------------------------------------------------------
-- The four triggers of the migration, then their functions.
-- ------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_retract_slot_deviation_notifications ON public.slot_deviations;
DROP TRIGGER IF EXISTS trg_retract_session_completed_notification ON public.session_confirmations;
DROP TRIGGER IF EXISTS block_confirmation_delete_when_reviewed ON public.session_confirmations;
DROP TRIGGER IF EXISTS trg_review_needs_confirmation ON public.sessions;

DROP FUNCTION IF EXISTS public.retract_slot_deviation_notifications();
DROP FUNCTION IF EXISTS public.retract_session_completed_notification();
DROP FUNCTION IF EXISTS public.block_confirmation_delete_when_reviewed();
DROP FUNCTION IF EXISTS public.review_needs_confirmation();

-- ------------------------------------------------------------
-- A confirmation: not archived, program active — nothing about the review.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "Students update own session confirmations" ON public.session_confirmations;
CREATE POLICY "Students update own session confirmations"
  ON public.session_confirmations FOR UPDATE
  USING (
    student_id = auth.uid()
    AND public.student_profile_for_session(session_id) = auth.uid()
    AND NOT EXISTS (
      SELECT 1 FROM public.sessions s
      WHERE s.id = session_confirmations.session_id AND s.archived_at IS NOT NULL
    )
    AND public.program_active_for_session(session_id) = true
  )
  WITH CHECK (
    student_id = auth.uid()
    AND public.student_profile_for_session(session_id) = auth.uid()
    AND NOT EXISTS (
      SELECT 1 FROM public.sessions s
      WHERE s.id = session_confirmations.session_id AND s.archived_at IS NOT NULL
    )
    AND public.program_active_for_session(session_id) = true
  );

DROP POLICY IF EXISTS "Students delete own session confirmations" ON public.session_confirmations;
CREATE POLICY "Students delete own session confirmations"
  ON public.session_confirmations FOR DELETE
  USING (
    student_id = auth.uid()
    AND public.student_profile_for_session(session_id) = auth.uid()
    AND NOT EXISTS (
      SELECT 1 FROM public.sessions s
      WHERE s.id = session_confirmations.session_id AND s.archived_at IS NOT NULL
    )
    AND public.program_active_for_session(session_id) = true
  );

-- ------------------------------------------------------------
-- Feedback: on any session of the athlete.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "Send to coach-student counterpart" ON public.messages;
CREATE POLICY "Send to coach-student counterpart"
  ON public.messages FOR INSERT
  WITH CHECK (
    sender_id = auth.uid()
    AND public.profiles_are_coach_student(sender_id, recipient_id)
    AND (
      session_id IS NULL
      OR (
        sender_id    = public.coach_profile_for_session(session_id)
        AND recipient_id = public.student_profile_for_session(session_id)
      )
    )
  );

-- ------------------------------------------------------------
-- The push of a confirmation: tagged by confirmation.
-- ------------------------------------------------------------
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
    RAISE WARNING 'send-push fan-out (session confirm) failed: %', SQLERRM;
  END;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.notify_coach_on_session_confirm() FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- No policy reads them any more.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.session_is_confirmed(uuid);
-- session_writable(uuid) is migration 08's, and stays: session_writable_for_slot
-- calls it as its owner. A signed-in user no longer does.
REVOKE ALL ON FUNCTION public.session_writable(uuid) FROM PUBLIC, anon, authenticated;

DELETE FROM app_private.app_migrations WHERE name = '2026_10_13_09_review_lifecycle';

-- Functions left public: PostgREST has to forget them.
NOTIFY pgrst, 'reload schema';

COMMIT;
