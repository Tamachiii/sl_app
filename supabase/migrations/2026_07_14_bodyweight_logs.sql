-- ============================================================
-- Bodyweight logging.
--
-- Street-lifting strength is judged relative to bodyweight (a weighted
-- pull-up at 70kg BW +30kg is a very different feat at 90kg BW), so the
-- PR/e1RM surface needs a bodyweight series to compute relative strength.
-- One row per student per day (upsert on logged_on); the student owns their
-- series, the coach reads it.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.bodyweight_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id  uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  weight_kg   numeric(5,2) NOT NULL CHECK (weight_kg > 0 AND weight_kg < 500),
  logged_on   date NOT NULL DEFAULT current_date,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (student_id, logged_on)
);

CREATE INDEX IF NOT EXISTS bodyweight_logs_student_idx
  ON public.bodyweight_logs (student_id, logged_on DESC);

ALTER TABLE public.bodyweight_logs ENABLE ROW LEVEL SECURITY;

-- Student: full CRUD on their own series.
DROP POLICY IF EXISTS "Students manage own bodyweight" ON public.bodyweight_logs;
CREATE POLICY "Students manage own bodyweight"
  ON public.bodyweight_logs FOR ALL
  USING (student_id = auth.uid())
  WITH CHECK (student_id = auth.uid());

-- Coach: read their own students' series (mirrors the goals coach-read).
DROP POLICY IF EXISTS "Coaches read their students bodyweight" ON public.bodyweight_logs;
CREATE POLICY "Coaches read their students bodyweight"
  ON public.bodyweight_logs FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.students s
      WHERE s.profile_id = bodyweight_logs.student_id AND s.coach_id = auth.uid()
    )
  );
