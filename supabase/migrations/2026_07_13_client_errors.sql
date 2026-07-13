-- ============================================================
-- Production error telemetry.
--
-- The app had no feedback loop for crashes on students' phones: the sole
-- ErrorBoundary logged nothing, so the dev-coach only learned of a failure
-- if a student happened to mention it. This table is that feedback loop.
--
-- Insert-only for any authenticated user (a client can only report its OWN
-- errors — user_id is pinned to auth.uid()); coaches read all rows so the
-- dev-coach can triage from inside the app. No UPDATE/DELETE policy: reports
-- are immutable append-only telemetry. Reads are coach-only, so a student
-- can never see another user's stack traces.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.client_errors (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  role        text,
  -- Bound the free-text so a hostile direct POST can't bloat the table.
  message     text NOT NULL CHECK (char_length(message) <= 2000),
  stack       text CHECK (stack IS NULL OR char_length(stack) <= 8000),
  url         text CHECK (url IS NULL OR char_length(url) <= 500),
  user_agent  text CHECK (user_agent IS NULL OR char_length(user_agent) <= 500),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS client_errors_created_idx
  ON public.client_errors (created_at DESC);

ALTER TABLE public.client_errors ENABLE ROW LEVEL SECURITY;

-- A signed-in user may report only their own error, and may not spoof the
-- role: it must be NULL or match their real profiles.role (else a student
-- could POST role='coach' rows to poison the coach triage view).
DROP POLICY IF EXISTS "Users insert own client errors" ON public.client_errors;
CREATE POLICY "Users insert own client errors"
  ON public.client_errors FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND (
      role IS NULL
      OR role = (SELECT p.role FROM public.profiles p WHERE p.id = auth.uid())
    )
  );

-- Coaches read everything for triage; students read nothing (stack traces
-- can carry other users' data).
DROP POLICY IF EXISTS "Coaches read client errors" ON public.client_errors;
CREATE POLICY "Coaches read client errors"
  ON public.client_errors FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
       WHERE p.id = auth.uid() AND p.role = 'coach'
    )
  );

-- Retention: keep 90 days. No pg_cron dependency — the app prunes opportun-
-- istically is overkill; instead document that a periodic
--   DELETE FROM public.client_errors WHERE created_at < now() - interval '90 days';
-- can be run from the dashboard or a future cron. Left as a comment so the
-- table can't grow silently unbounded without the operator knowing.
