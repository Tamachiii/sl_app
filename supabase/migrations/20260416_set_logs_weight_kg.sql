-- Add weight_kg to set_logs so students can record the actual load they lifted.
-- Nullable: bodyweight sets and time-based sets simply leave it NULL.
ALTER TABLE public.set_logs
  ADD COLUMN IF NOT EXISTS weight_kg numeric(6,2);
