-- ============================================================
-- Coach RLS for set_logs (per-set prescriptions)
-- The previous "Students manage own set logs" FOR ALL policy denied the
-- coach all writes. Now that prescriptions live on set_logs, the coach
-- needs to insert/update/delete rows for slots inside their students'
-- programs (via session → program → student → coach).
--
-- Discipline note: the coach UI only ever writes the target_* columns.
-- The student-only actual columns (done, rpe, weight_kg, logged_at) are
-- not enforced at the DB layer here — they're client-discipline. If we
-- later split actuals to a separate table, this policy can tighten.
-- ============================================================

DROP POLICY IF EXISTS "Coaches manage set log prescriptions" ON public.set_logs;

CREATE POLICY "Coaches manage set log prescriptions"
  ON public.set_logs FOR ALL
  USING (
    public.student_profile_for_slot(exercise_slot_id) IN (
      SELECT profile_id FROM public.students WHERE coach_id = auth.uid()
    )
  )
  WITH CHECK (
    public.student_profile_for_slot(exercise_slot_id) IN (
      SELECT profile_id FROM public.students WHERE coach_id = auth.uid()
    )
  );

-- The pre-existing "Coaches read set logs" SELECT policy is now subsumed
-- by the FOR ALL above; drop it to avoid two policies covering the same
-- read path.
DROP POLICY IF EXISTS "Coaches read set logs" ON public.set_logs;
