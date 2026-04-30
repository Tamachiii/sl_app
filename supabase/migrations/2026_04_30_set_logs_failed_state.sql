-- ============================================================
-- Add a "failed" outcome to set_logs alongside the existing
-- "done" flag, so a student can explicitly mark a set as failed
-- (vs. simply not yet started). The two are mutually exclusive.
-- ============================================================

ALTER TABLE public.set_logs
  ADD COLUMN IF NOT EXISTS failed    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS failed_at timestamptz;

ALTER TABLE public.set_logs
  DROP CONSTRAINT IF EXISTS set_logs_done_xor_failed;

ALTER TABLE public.set_logs
  ADD CONSTRAINT set_logs_done_xor_failed CHECK (NOT (done AND failed));
