-- ============================================================
-- Session Confirmations
-- Lets students mark a planned session as "confirmed / done"
-- so coaches can see which sessions have actually been completed.
-- ============================================================

CREATE TABLE public.session_confirmations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   uuid NOT NULL UNIQUE REFERENCES public.sessions(id) ON DELETE CASCADE,
  student_id   uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  notes        text
);

CREATE INDEX idx_session_confirmations_session_id ON public.session_confirmations(session_id);
CREATE INDEX idx_session_confirmations_student_id ON public.session_confirmations(student_id);

-- Walk from session_id up to the student's profile_id (for RLS).
CREATE OR REPLACE FUNCTION public.student_profile_for_session(sess_id uuid)
RETURNS uuid AS $$
  SELECT s.profile_id
  FROM public.sessions sess
  JOIN public.weeks w   ON w.id = sess.week_id
  JOIN public.programs p ON p.id = w.program_id
  JOIN public.students s ON s.id = p.student_id
  WHERE sess.id = sess_id
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Walk from session_id up to the coach's profile_id.
CREATE OR REPLACE FUNCTION public.coach_profile_for_session(sess_id uuid)
RETURNS uuid AS $$
  SELECT s.coach_id
  FROM public.sessions sess
  JOIN public.weeks w   ON w.id = sess.week_id
  JOIN public.programs p ON p.id = w.program_id
  JOIN public.students s ON s.id = p.student_id
  WHERE sess.id = sess_id
$$ LANGUAGE sql SECURITY DEFINER STABLE;

ALTER TABLE public.session_confirmations ENABLE ROW LEVEL SECURITY;

-- Students can manage only their own confirmations, and only for their own sessions.
CREATE POLICY "Students manage own session confirmations"
  ON public.session_confirmations FOR ALL
  USING (
    student_id = auth.uid()
    AND public.student_profile_for_session(session_id) = auth.uid()
  )
  WITH CHECK (
    student_id = auth.uid()
    AND public.student_profile_for_session(session_id) = auth.uid()
  );

-- Coaches can read confirmations for their students' sessions.
CREATE POLICY "Coaches read confirmations for their students"
  ON public.session_confirmations FOR SELECT
  USING (
    public.coach_profile_for_session(session_id) = auth.uid()
  );
