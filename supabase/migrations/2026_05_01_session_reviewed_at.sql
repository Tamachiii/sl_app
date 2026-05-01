-- ============================================================
-- sessions.reviewed_at: marks the session as reviewed by the coach.
--
-- Two ways the column gets set:
--   * Coach sends feedback → notify_student_on_session_feedback trigger sets
--     reviewed_at = NOW() (when still NULL).
--   * Coach clicks "Finish without feedback" → client UPDATEs the row directly
--     under the existing "Coaches manage sessions" RLS policy.
--
-- Once set, the SessionReview UI renders read-only and the SessionsFeed shows
-- a "Reviewed" pill. NULL means "not yet reviewed".
-- ============================================================

ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;

CREATE INDEX IF NOT EXISTS sessions_reviewed_idx
  ON public.sessions (reviewed_at) WHERE reviewed_at IS NOT NULL;

-- Extend the existing feedback trigger so sending feedback also marks the
-- session reviewed. Idempotent: the WHERE clause skips already-reviewed rows
-- so a coach can't accidentally rewind reviewed_at by re-firing the trigger.
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

  UPDATE public.sessions
     SET reviewed_at = NEW.created_at
   WHERE id = NEW.session_id
     AND reviewed_at IS NULL;

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

-- Backfill: any session that already has a feedback message gets stamped with
-- the message's created_at so the historical "reviewed" state is correct.
UPDATE public.sessions s
   SET reviewed_at = m.created_at
  FROM (
    SELECT session_id, MIN(created_at) AS created_at
      FROM public.messages
     WHERE session_id IS NOT NULL
     GROUP BY session_id
  ) m
 WHERE s.id = m.session_id
   AND s.reviewed_at IS NULL;
