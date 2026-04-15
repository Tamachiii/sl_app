-- Allow time-under-tension exercises (planks, hangs, holds…) by letting an
-- exercise_slot specify duration_seconds instead of reps. Exactly one of the
-- two must be set so callers always have an unambiguous unit to display.

ALTER TABLE public.exercise_slots
  ADD COLUMN IF NOT EXISTS duration_seconds int CHECK (duration_seconds IS NULL OR duration_seconds > 0);

ALTER TABLE public.exercise_slots
  ALTER COLUMN reps DROP NOT NULL;

-- Drop the legacy reps>0 check (only valid when reps is non-null) and recreate
-- it as a more permissive form, then enforce "exactly one of reps/seconds".
ALTER TABLE public.exercise_slots
  DROP CONSTRAINT IF EXISTS exercise_slots_reps_check;

ALTER TABLE public.exercise_slots
  ADD CONSTRAINT exercise_slots_reps_check
    CHECK (reps IS NULL OR reps > 0);

ALTER TABLE public.exercise_slots
  DROP CONSTRAINT IF EXISTS exercise_slots_unit_one_of;

ALTER TABLE public.exercise_slots
  ADD CONSTRAINT exercise_slots_unit_one_of
    CHECK ((reps IS NOT NULL) <> (duration_seconds IS NOT NULL));
