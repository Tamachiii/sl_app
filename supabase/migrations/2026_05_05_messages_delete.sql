-- ============================================================
-- Allow a sender to delete their own ordinary chat messages.
-- Coach session-feedback messages (session_id IS NOT NULL) stay immutable so
-- the one-shot review invariant on sessions.reviewed_at holds (the
-- notify_student_on_session_feedback trigger and the unique partial index on
-- messages.session_id both treat feedback as write-once).
-- ============================================================

DROP POLICY IF EXISTS "Sender deletes own message" ON public.messages;
CREATE POLICY "Sender deletes own message"
  ON public.messages FOR DELETE
  USING (sender_id = auth.uid() AND session_id IS NULL);
