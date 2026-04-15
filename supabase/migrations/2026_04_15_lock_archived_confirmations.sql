-- Once a coach archives a session, the student should not be able to delete
-- (unconfirm) the confirmation. Enforce at the RLS layer so the UI lock is
-- not the only gate.
DROP POLICY IF EXISTS "Students manage own session confirmations" ON public.session_confirmations;

CREATE POLICY "Students manage own session confirmations"
  ON public.session_confirmations FOR ALL
  USING (
    student_id = auth.uid()
    AND public.student_profile_for_session(session_id) = auth.uid()
    AND NOT EXISTS (
      SELECT 1 FROM public.sessions s
      WHERE s.id = session_confirmations.session_id AND s.archived_at IS NOT NULL
    )
  )
  WITH CHECK (
    student_id = auth.uid()
    AND public.student_profile_for_session(session_id) = auth.uid()
    AND NOT EXISTS (
      SELECT 1 FROM public.sessions s
      WHERE s.id = session_confirmations.session_id AND s.archived_at IS NOT NULL
    )
  );
