-- ============================================================
-- Enforce one coach-feedback message per session.
--
-- A message with session_id IS NOT NULL is, by the existing INSERT RLS policy,
-- coach feedback (sender = coach for that session, recipient = student). The
-- previous index was non-unique; this swap promotes it to UNIQUE so the DB
-- itself rejects a second feedback insert for the same session — the client
-- already hides the composer when feedback exists, this is the belt-and-
-- braces.
-- ============================================================

DROP INDEX IF EXISTS public.messages_session_idx;

CREATE UNIQUE INDEX messages_session_idx
  ON public.messages (session_id)
  WHERE session_id IS NOT NULL;
