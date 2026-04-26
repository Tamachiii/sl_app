-- Lock student writes on sessions whose parent program is no longer active.
--
-- Context: when a coach swaps the active program (programs.is_active flip),
-- sessions in the deactivated block remain navigable from the student's stats
-- calendar but were still mutable — students could re-confirm, undo, toggle
-- set_logs, or edit slot comments on history. Tighten the student-side RLS
-- policies on session_confirmations / set_logs / slot_comments to also reject
-- writes when the parent program is inactive. Coach-side policies are
-- unchanged so coaches can still edit prior blocks.

CREATE OR REPLACE FUNCTION public.program_active_for_session(sess_id uuid)
RETURNS boolean AS $$
  SELECT p.is_active
  FROM public.sessions sess
  JOIN public.weeks w    ON w.id = sess.week_id
  JOIN public.programs p ON p.id = w.program_id
  WHERE sess.id = sess_id
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.program_active_for_slot(slot_id uuid)
RETURNS boolean AS $$
  SELECT public.program_active_for_session(es.session_id)
  FROM public.exercise_slots es
  WHERE es.id = slot_id
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- session_confirmations: extend the existing student policy to also reject
-- inactive-program sessions.
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

-- set_logs: students can only mutate their actuals for slots whose session's
-- program is still active. Coach policy unchanged.
DROP POLICY IF EXISTS "Students manage own set logs" ON public.set_logs;
CREATE POLICY "Students manage own set logs"
  ON public.set_logs FOR ALL
  USING (
    public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND public.program_active_for_slot(exercise_slot_id) = true
  )
  WITH CHECK (
    public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND public.program_active_for_slot(exercise_slot_id) = true
  );

-- slot_comments: same gate as session_confirmations — block writes on
-- archived-session OR inactive-program slots.
DROP POLICY IF EXISTS "Students manage own slot comments" ON public.slot_comments;
CREATE POLICY "Students manage own slot comments"
  ON public.slot_comments FOR ALL
  USING (
    student_id = auth.uid()
    AND public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND NOT EXISTS (
      SELECT 1 FROM public.exercise_slots es
      JOIN public.sessions s ON s.id = es.session_id
      WHERE es.id = slot_comments.exercise_slot_id AND s.archived_at IS NOT NULL
    )
    AND public.program_active_for_slot(exercise_slot_id) = true
  )
  WITH CHECK (
    student_id = auth.uid()
    AND public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND NOT EXISTS (
      SELECT 1 FROM public.exercise_slots es
      JOIN public.sessions s ON s.id = es.session_id
      WHERE es.id = slot_comments.exercise_slot_id AND s.archived_at IS NOT NULL
    )
    AND public.program_active_for_slot(exercise_slot_id) = true
  );
