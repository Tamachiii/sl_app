-- Goals: coach-set targets for a student, linked to an exercise in the library.
-- Two flavours:
--   one_rm  — a single top-weight target (target_weight_kg, reps defaults to 1)
--   format  — an "N sets × R reps @ W kg" target (all three fields required)

DO $$ BEGIN
  CREATE TYPE goal_kind AS ENUM ('one_rm', 'format');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS public.goals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  coach_id         uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  exercise_id      uuid NOT NULL REFERENCES public.exercise_library(id) ON DELETE CASCADE,
  kind             goal_kind NOT NULL,
  target_weight_kg numeric(6,2) NOT NULL,
  target_sets      int,
  target_reps      int NOT NULL DEFAULT 1,
  notes            text,
  achieved         boolean NOT NULL DEFAULT false,
  achieved_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_goals_student_id  ON public.goals(student_id);
CREATE INDEX IF NOT EXISTS idx_goals_exercise_id ON public.goals(exercise_id);

CREATE TABLE IF NOT EXISTS public.goal_progress (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goal_id      uuid NOT NULL REFERENCES public.goals(id) ON DELETE CASCADE,
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  weight_kg    numeric(6,2) NOT NULL,
  sets         int,
  reps         int,
  notes        text
);

CREATE INDEX IF NOT EXISTS idx_goal_progress_goal_id ON public.goal_progress(goal_id);

CREATE OR REPLACE FUNCTION public.student_profile_for_goal(g uuid)
RETURNS uuid AS $$
  SELECT student_id FROM public.goals WHERE id = g
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.coach_profile_for_goal(g uuid)
RETURNS uuid AS $$
  SELECT coach_id FROM public.goals WHERE id = g
$$ LANGUAGE sql SECURITY DEFINER STABLE;

ALTER TABLE public.goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.goal_progress ENABLE ROW LEVEL SECURITY;

-- Students: read their own goals, and update only the achieved / achieved_at fields.
CREATE POLICY "Students read own goals"
  ON public.goals FOR SELECT
  USING (student_id = auth.uid());

CREATE POLICY "Students mark own goals achieved"
  ON public.goals FOR UPDATE
  USING (student_id = auth.uid())
  WITH CHECK (student_id = auth.uid());

-- Coaches: full CRUD for goals they own, scoped to their assigned students.
CREATE POLICY "Coaches manage goals for their students"
  ON public.goals FOR ALL
  USING (
    coach_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.students s
      WHERE s.profile_id = goals.student_id AND s.coach_id = auth.uid()
    )
  )
  WITH CHECK (
    coach_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.students s
      WHERE s.profile_id = goals.student_id AND s.coach_id = auth.uid()
    )
  );

-- Progress: student inserts/reads/deletes their own, coach can read.
CREATE POLICY "Students manage own goal progress"
  ON public.goal_progress FOR ALL
  USING (public.student_profile_for_goal(goal_id) = auth.uid())
  WITH CHECK (public.student_profile_for_goal(goal_id) = auth.uid());

CREATE POLICY "Coaches read goal progress for their students"
  ON public.goal_progress FOR SELECT
  USING (public.coach_profile_for_goal(goal_id) = auth.uid());
