-- Rest time: optional per-slot rest period between sets (in seconds).
ALTER TABLE public.exercise_slots
  ADD COLUMN IF NOT EXISTS rest_seconds int
  CHECK (rest_seconds IS NULL OR rest_seconds >= 0);
