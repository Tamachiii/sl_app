-- Supersets: pair multiple exercise_slots as a single back-to-back group.
-- Slots sharing the same superset_group are performed alternating between them.
ALTER TABLE public.exercise_slots
  ADD COLUMN IF NOT EXISTS superset_group uuid;

CREATE INDEX IF NOT EXISTS idx_exercise_slots_superset_group
  ON public.exercise_slots(superset_group);
