-- ============================================================
-- messages.session_id: optional reference to the session a message is about.
-- Used by the coach "session feedback" flow at the end of SessionReview.
--
-- Constraints:
--   * NULL means "ordinary chat message" (default).
--   * Non-null only valid when sender = coach for that session and recipient =
--     student for that session — enforced by the INSERT RLS policy.
--   * Pinned on UPDATE so the existing "recipient marks read" path can't be
--     used to mutate the link.
--
-- Trigger: when a row is inserted with session_id IS NOT NULL, drop a
-- 'session_feedback' notification on the recipient (student). Same
-- SECURITY DEFINER + payload pattern as notify_coach_on_session_confirm.
-- ============================================================

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS session_id uuid REFERENCES public.sessions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS messages_session_idx
  ON public.messages (session_id) WHERE session_id IS NOT NULL;

-- Pin session_id on UPDATE alongside the other immutable columns.
CREATE OR REPLACE FUNCTION public.lock_message_fields_on_update()
RETURNS TRIGGER AS $$
BEGIN
  NEW.id           := OLD.id;
  NEW.sender_id    := OLD.sender_id;
  NEW.recipient_id := OLD.recipient_id;
  NEW.body         := OLD.body;
  NEW.session_id   := OLD.session_id;
  NEW.created_at   := OLD.created_at;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Replace the INSERT policy: the original kept stays (sender = self + a
-- coach-student pair), and we add the session_id well-formedness check.
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

-- Trigger: notify the student when their coach inserts a feedback message.
-- Mirrors notify_coach_on_session_confirm — payload carries session_id +
-- title + coach name so the bell can render copy and a deep link.
CREATE OR REPLACE FUNCTION public.notify_student_on_session_feedback()
RETURNS TRIGGER AS $$
DECLARE
  v_coach_name    text;
  v_session_title text;
BEGIN
  IF NEW.session_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT p.full_name INTO v_coach_name
    FROM public.profiles p
   WHERE p.id = NEW.sender_id;

  SELECT COALESCE(NULLIF(BTRIM(s.title), ''), 'Session') INTO v_session_title
    FROM public.sessions s
   WHERE s.id = NEW.session_id;

  INSERT INTO public.notifications (recipient_id, kind, payload)
  VALUES (
    NEW.recipient_id,
    'session_feedback',
    jsonb_build_object(
      'session_id',       NEW.session_id,
      'session_title',    v_session_title,
      'coach_profile_id', NEW.sender_id,
      'coach_name',       v_coach_name,
      'message_id',       NEW.id
    )
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_notify_student_on_session_feedback ON public.messages;
CREATE TRIGGER trg_notify_student_on_session_feedback
  AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.notify_student_on_session_feedback();
