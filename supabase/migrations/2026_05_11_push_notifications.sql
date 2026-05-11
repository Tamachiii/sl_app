-- ============================================================
-- Web Push: rest-timer "Rest done" notification (PWA fallback for the
-- iOS Dynamic Island / Live Activity ask, which is unavailable to web).
--
-- Two tables:
--
-- 1. push_subscriptions — one row per device/browser the user has opted
--    into push on. The fields mirror the Web Push spec (endpoint, p256dh,
--    auth). Owned by the user; CRUD via RLS.
--
-- 2. scheduled_pushes — one row per pending notification to fire at
--    fire_at. The client inserts a row when a rest timer starts and
--    sets canceled_at when the timer is cleared (set undone, new set
--    started, or session left). The dispatch-rest-push Edge Function
--    reads with the service role, sleeps until fire_at, double-checks
--    canceled_at, and delivers via the web-push protocol.
--
-- There are no triggers on these tables. RLS is the only client-side
-- guardrail; the Edge Function uses the service role and bypasses RLS.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  endpoint      text NOT NULL UNIQUE,
  p256dh        text NOT NULL,
  auth          text NOT NULL,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx
  ON public.push_subscriptions (user_id);

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Read own push subscriptions" ON public.push_subscriptions;
CREATE POLICY "Read own push subscriptions"
  ON public.push_subscriptions FOR SELECT
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Insert own push subscriptions" ON public.push_subscriptions;
CREATE POLICY "Insert own push subscriptions"
  ON public.push_subscriptions FOR INSERT
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Update own push subscriptions" ON public.push_subscriptions;
CREATE POLICY "Update own push subscriptions"
  ON public.push_subscriptions FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Delete own push subscriptions" ON public.push_subscriptions;
CREATE POLICY "Delete own push subscriptions"
  ON public.push_subscriptions FOR DELETE
  USING (user_id = auth.uid());


CREATE TABLE IF NOT EXISTS public.scheduled_pushes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  fire_at       timestamptz NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'canceled', 'failed')),
  canceled_at   timestamptz,
  sent_at       timestamptz,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scheduled_pushes_user_status_idx
  ON public.scheduled_pushes (user_id, status, fire_at);

ALTER TABLE public.scheduled_pushes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Read own scheduled pushes" ON public.scheduled_pushes;
CREATE POLICY "Read own scheduled pushes"
  ON public.scheduled_pushes FOR SELECT
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Insert own scheduled pushes" ON public.scheduled_pushes;
CREATE POLICY "Insert own scheduled pushes"
  ON public.scheduled_pushes FOR INSERT
  WITH CHECK (user_id = auth.uid());

-- Update is intentionally narrow on the client side: only the row's owner
-- can mark it canceled. The Edge Function (service role) is the only
-- writer for sent_at / status='sent'. We don't bother with a column-pin
-- trigger because the worst a malicious client can do to their own row
-- is suppress their own notification.
DROP POLICY IF EXISTS "Cancel own scheduled pushes" ON public.scheduled_pushes;
CREATE POLICY "Cancel own scheduled pushes"
  ON public.scheduled_pushes FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Owner may delete their own row (e.g. opportunistic cleanup after expiry).
DROP POLICY IF EXISTS "Delete own scheduled pushes" ON public.scheduled_pushes;
CREATE POLICY "Delete own scheduled pushes"
  ON public.scheduled_pushes FOR DELETE
  USING (user_id = auth.uid());
