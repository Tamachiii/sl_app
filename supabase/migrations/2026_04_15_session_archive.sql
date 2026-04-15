-- Session archiving: the coach marks a reviewed session archived so it stops
-- cluttering the week view. A session is archived iff archived_at IS NOT NULL.
ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_sessions_archived_at ON public.sessions(archived_at);
