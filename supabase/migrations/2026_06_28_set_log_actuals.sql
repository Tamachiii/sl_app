-- Phase 1 of student-authored deviations: capture what the student ACTUALLY
-- did (reps performed + load used) when it diverges from the coach's
-- prescription. The coach-owned target_* columns are never touched.
--
-- A NULL actual means "did it as prescribed" — so a populated actual_* always
-- signals an off-plan set, which keeps the coach-side "Off-plan" read-out and
-- any future adherence metric clean. Students already hold INSERT/UPDATE/DELETE
-- on their own set_logs (gated to the active program), so these columns ride
-- the existing "Students update own set logs" policy with no new RLS.

ALTER TABLE public.set_logs
  ADD COLUMN IF NOT EXISTS actual_reps      int,
  ADD COLUMN IF NOT EXISTS actual_weight_kg numeric(6,2);

-- Idempotent: Postgres has no ADD CONSTRAINT IF NOT EXISTS, so drop-then-add
-- lets this migration re-run cleanly after a partial apply.
ALTER TABLE public.set_logs
  DROP CONSTRAINT IF EXISTS set_logs_actual_reps_nonneg,
  ADD  CONSTRAINT set_logs_actual_reps_nonneg
    CHECK (actual_reps IS NULL OR actual_reps >= 0);

ALTER TABLE public.set_logs
  DROP CONSTRAINT IF EXISTS set_logs_actual_weight_nonneg,
  ADD  CONSTRAINT set_logs_actual_weight_nonneg
    CHECK (actual_weight_kg IS NULL OR actual_weight_kg >= 0);

COMMENT ON COLUMN public.set_logs.actual_reps IS
  'Student-recorded reps actually performed when they deviated from target_reps. NULL = followed the prescription.';
COMMENT ON COLUMN public.set_logs.actual_weight_kg IS
  'Student-recorded load actually used when they deviated from target_weight_kg. NULL = followed the prescription.';

-- Harden the coach/student column boundary on set_logs. Until now the split
-- (coach owns target_*, student owns actuals) was enforced only by client
-- discipline. Now that students write more to this shared row, pin the
-- coach-owned target_* columns on any STUDENT update so a student can never
-- rewrite the prescription — even with a hand-crafted payload. Coach updates
-- (auth.uid() is the coach, not the slot's student) are left untouched, so
-- useUpdateSlot / useUpdateSetTarget keep working. Mirrors
-- restrict_student_goal_update.
CREATE OR REPLACE FUNCTION public.pin_set_log_targets_for_student()
RETURNS trigger AS $$
BEGIN
  IF public.student_profile_for_slot(NEW.exercise_slot_id) = auth.uid() THEN
    NEW.target_reps             := OLD.target_reps;
    NEW.target_duration_seconds := OLD.target_duration_seconds;
    NEW.target_weight_kg        := OLD.target_weight_kg;
    NEW.target_rest_seconds     := OLD.target_rest_seconds;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_pin_set_log_targets_for_student ON public.set_logs;
CREATE TRIGGER trg_pin_set_log_targets_for_student
  BEFORE UPDATE ON public.set_logs
  FOR EACH ROW EXECUTE FUNCTION public.pin_set_log_targets_for_student();
