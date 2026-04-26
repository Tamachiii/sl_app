-- Lock student writes on sessions whose parent program is no longer active.
--
-- Context: when a coach swaps the active program (programs.is_active flip),
-- sessions in the deactivated block remain navigable from the student's stats
-- calendar but were still mutable — students could re-confirm, undo, toggle
-- set_logs, or edit slot comments on history.
--
-- Tighten student-side write paths (INSERT/UPDATE/DELETE) on
-- session_confirmations / set_logs / slot_comments to also reject when the
-- parent program is inactive. Crucially keep SELECT permissive so the student
-- can still *view* their own RPEs, done flags, slot comments, and old
-- confirmation timestamps when they re-open a past session via the calendar.
--
-- Coach-side policies are unchanged so coaches can still review and edit
-- prior blocks.

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

-- ─── set_logs ────────────────────────────────────────────────────────────
-- Replace the previous FOR ALL student policy with SELECT (permissive) +
-- INSERT/UPDATE/DELETE (gated by program-active). The previous policy
-- already gated only on ownership; the gate here adds program-active.
-- Also drop the new split-policy names to make this migration idempotent —
-- safe to re-run if a partial earlier version was applied.
DROP POLICY IF EXISTS "Students manage own set logs" ON public.set_logs;
DROP POLICY IF EXISTS "Students read own set logs" ON public.set_logs;
DROP POLICY IF EXISTS "Students insert own set logs" ON public.set_logs;
DROP POLICY IF EXISTS "Students update own set logs" ON public.set_logs;
DROP POLICY IF EXISTS "Students delete own set logs" ON public.set_logs;

CREATE POLICY "Students read own set logs"
  ON public.set_logs FOR SELECT
  USING (public.student_profile_for_slot(exercise_slot_id) = auth.uid());

CREATE POLICY "Students insert own set logs"
  ON public.set_logs FOR INSERT
  WITH CHECK (
    public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND public.program_active_for_slot(exercise_slot_id) = true
  );

CREATE POLICY "Students update own set logs"
  ON public.set_logs FOR UPDATE
  USING (
    public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND public.program_active_for_slot(exercise_slot_id) = true
  )
  WITH CHECK (
    public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND public.program_active_for_slot(exercise_slot_id) = true
  );

CREATE POLICY "Students delete own set logs"
  ON public.set_logs FOR DELETE
  USING (
    public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND public.program_active_for_slot(exercise_slot_id) = true
  );

-- ─── session_confirmations ──────────────────────────────────────────────
-- Same split. SELECT is permissive so students can still see the timestamp
-- and notes of an old confirmation on archived/past-program sessions.
-- Writes are blocked when the session is archived OR the program inactive.
DROP POLICY IF EXISTS "Students manage own session confirmations" ON public.session_confirmations;
DROP POLICY IF EXISTS "Students read own session confirmations" ON public.session_confirmations;
DROP POLICY IF EXISTS "Students insert own session confirmations" ON public.session_confirmations;
DROP POLICY IF EXISTS "Students update own session confirmations" ON public.session_confirmations;
DROP POLICY IF EXISTS "Students delete own session confirmations" ON public.session_confirmations;

CREATE POLICY "Students read own session confirmations"
  ON public.session_confirmations FOR SELECT
  USING (
    student_id = auth.uid()
    AND public.student_profile_for_session(session_id) = auth.uid()
  );

CREATE POLICY "Students insert own session confirmations"
  ON public.session_confirmations FOR INSERT
  WITH CHECK (
    student_id = auth.uid()
    AND public.student_profile_for_session(session_id) = auth.uid()
    AND NOT EXISTS (
      SELECT 1 FROM public.sessions s
      WHERE s.id = session_confirmations.session_id AND s.archived_at IS NOT NULL
    )
    AND public.program_active_for_session(session_id) = true
  );

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

-- ─── slot_comments ──────────────────────────────────────────────────────
-- SELECT permissive so students can still view their own old comments on
-- archived/past sessions. Writes blocked under the same conditions.
DROP POLICY IF EXISTS "Students manage own slot comments" ON public.slot_comments;
DROP POLICY IF EXISTS "Students read own slot comments" ON public.slot_comments;
DROP POLICY IF EXISTS "Students insert own slot comments" ON public.slot_comments;
DROP POLICY IF EXISTS "Students update own slot comments" ON public.slot_comments;
DROP POLICY IF EXISTS "Students delete own slot comments" ON public.slot_comments;

CREATE POLICY "Students read own slot comments"
  ON public.slot_comments FOR SELECT
  USING (
    student_id = auth.uid()
    AND public.student_profile_for_slot(exercise_slot_id) = auth.uid()
  );

CREATE POLICY "Students insert own slot comments"
  ON public.slot_comments FOR INSERT
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

CREATE POLICY "Students update own slot comments"
  ON public.slot_comments FOR UPDATE
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

CREATE POLICY "Students delete own slot comments"
  ON public.slot_comments FOR DELETE
  USING (
    student_id = auth.uid()
    AND public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND NOT EXISTS (
      SELECT 1 FROM public.exercise_slots es
      JOIN public.sessions s ON s.id = es.session_id
      WHERE es.id = slot_comments.exercise_slot_id AND s.archived_at IS NOT NULL
    )
    AND public.program_active_for_slot(exercise_slot_id) = true
  );
