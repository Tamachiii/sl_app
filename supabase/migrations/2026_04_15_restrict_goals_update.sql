-- Restrict students to only updating achieved/achieved_at on their own goals.
-- Without this, students could modify target_weight_kg, notes, coach_id, etc.

-- Add a trigger to prevent students from modifying coach-owned columns
CREATE OR REPLACE FUNCTION public.restrict_student_goal_update()
RETURNS TRIGGER AS $$
BEGIN
  -- If the updater is the student (not the coach), lock down all columns
  -- except achieved and achieved_at
  IF auth.uid() = NEW.student_id AND auth.uid() != OLD.coach_id THEN
    NEW.exercise_id      := OLD.exercise_id;
    NEW.kind             := OLD.kind;
    NEW.target_weight_kg := OLD.target_weight_kg;
    NEW.target_sets      := OLD.target_sets;
    NEW.target_reps      := OLD.target_reps;
    NEW.notes            := OLD.notes;
    NEW.coach_id         := OLD.coach_id;
    NEW.student_id       := OLD.student_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_restrict_student_goal_update ON public.goals;
CREATE TRIGGER trg_restrict_student_goal_update
  BEFORE UPDATE ON public.goals
  FOR EACH ROW EXECUTE FUNCTION public.restrict_student_goal_update();
