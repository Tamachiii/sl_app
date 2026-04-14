-- Add an optional scheduled date to sessions so coaches can pin a session to
-- a specific calendar day and the student app can surface it directly.
ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS scheduled_date date;

CREATE INDEX IF NOT EXISTS idx_sessions_scheduled_date
  ON public.sessions(scheduled_date);
