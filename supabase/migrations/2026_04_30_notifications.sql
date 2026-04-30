-- ============================================================
-- Notifications: per-recipient feed of app events. Generic kind+payload
-- shape so adding new event types later is purely additive (new trigger +
-- new client-side render case).
--
-- Initial trigger: when a student inserts a session_confirmations row, the
-- student's coach gets a 'session_completed' notification.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.notifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id  uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  kind          text NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notifications_recipient_created_idx
  ON public.notifications (recipient_id, created_at DESC);

CREATE INDEX IF NOT EXISTS notifications_recipient_unread_idx
  ON public.notifications (recipient_id) WHERE read_at IS NULL;

-- ------------------------------------------------------------
-- Lock body fields on UPDATE so the recipient-update policy below can only
-- flip read_at (RLS can't restrict per-column otherwise). Same pattern as
-- the messages table.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lock_notification_fields_on_update()
RETURNS TRIGGER AS $$
BEGIN
  NEW.id           := OLD.id;
  NEW.recipient_id := OLD.recipient_id;
  NEW.kind         := OLD.kind;
  NEW.payload      := OLD.payload;
  NEW.created_at   := OLD.created_at;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_lock_notification_fields ON public.notifications;
CREATE TRIGGER trg_lock_notification_fields
  BEFORE UPDATE ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION public.lock_notification_fields_on_update();

-- ------------------------------------------------------------
-- RLS: recipient sees and updates their own row. INSERT happens via
-- SECURITY DEFINER triggers only (no client-facing INSERT policy).
-- ------------------------------------------------------------
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Read own notifications" ON public.notifications;
CREATE POLICY "Read own notifications"
  ON public.notifications FOR SELECT
  USING (recipient_id = auth.uid());

DROP POLICY IF EXISTS "Recipient marks notifications read" ON public.notifications;
CREATE POLICY "Recipient marks notifications read"
  ON public.notifications FOR UPDATE
  USING (recipient_id = auth.uid())
  WITH CHECK (recipient_id = auth.uid());

-- No DELETE policy — keep history.

-- ------------------------------------------------------------
-- Trigger: notify the coach when their student confirms a session.
-- Looks up the student profile + coach via the existing
-- coach_profile_for_session helper, then injects a notification carrying
-- enough context (student.id row id + session id + titles) for the client
-- to render copy + a deep link to the review screen.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_coach_on_session_confirm()
RETURNS TRIGGER AS $$
DECLARE
  v_coach_id          uuid;
  v_student_profile   uuid;
  v_student_row_id    uuid;
  v_student_name      text;
  v_session_title     text;
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

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_notify_coach_on_session_confirm ON public.session_confirmations;
CREATE TRIGGER trg_notify_coach_on_session_confirm
  AFTER INSERT ON public.session_confirmations
  FOR EACH ROW EXECUTE FUNCTION public.notify_coach_on_session_confirm();

-- ------------------------------------------------------------
-- Realtime broadcast (mirrors the messages table setup).
-- ------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'notifications'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
    END IF;
  END IF;
END $$;

ALTER TABLE public.notifications REPLICA IDENTITY FULL;
