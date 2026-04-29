-- ============================================================
-- Messages between coach and their students.
-- One row per message; threading is implicit via (sender, recipient).
-- read_at on each row tracks per-message read state for the recipient.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  body         text NOT NULL CHECK (char_length(btrim(body)) > 0 AND char_length(body) <= 4000),
  read_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT messages_no_self_send CHECK (sender_id <> recipient_id)
);

-- Index for thread lookup ordered newest-first. Pair key (LEAST, GREATEST) so a
-- single index serves both directions of the conversation.
CREATE INDEX IF NOT EXISTS messages_pair_created_idx
  ON public.messages (LEAST(sender_id, recipient_id), GREATEST(sender_id, recipient_id), created_at DESC);

-- Partial index for quick unread-count lookups by recipient.
CREATE INDEX IF NOT EXISTS messages_recipient_unread_idx
  ON public.messages (recipient_id) WHERE read_at IS NULL;

-- ------------------------------------------------------------
-- Helper: are these two profiles a coach/student pair?
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.profiles_are_coach_student(a uuid, b uuid)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.students s
    WHERE (s.coach_id = a AND s.profile_id = b)
       OR (s.coach_id = b AND s.profile_id = a)
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- ------------------------------------------------------------
-- Trigger: lock body / sender / recipient on UPDATE so the
-- recipient-update policy below can only flip read_at.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lock_message_fields_on_update()
RETURNS TRIGGER AS $$
BEGIN
  NEW.id           := OLD.id;
  NEW.sender_id    := OLD.sender_id;
  NEW.recipient_id := OLD.recipient_id;
  NEW.body         := OLD.body;
  NEW.created_at   := OLD.created_at;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_lock_message_fields ON public.messages;
CREATE TRIGGER trg_lock_message_fields
  BEFORE UPDATE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.lock_message_fields_on_update();

-- ------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Read own messages" ON public.messages;
CREATE POLICY "Read own messages"
  ON public.messages FOR SELECT
  USING (sender_id = auth.uid() OR recipient_id = auth.uid());

DROP POLICY IF EXISTS "Send to coach-student counterpart" ON public.messages;
CREATE POLICY "Send to coach-student counterpart"
  ON public.messages FOR INSERT
  WITH CHECK (
    sender_id = auth.uid()
    AND public.profiles_are_coach_student(sender_id, recipient_id)
  );

DROP POLICY IF EXISTS "Recipient marks messages read" ON public.messages;
CREATE POLICY "Recipient marks messages read"
  ON public.messages FOR UPDATE
  USING (recipient_id = auth.uid())
  WITH CHECK (recipient_id = auth.uid());

-- No DELETE policy — messages are immutable history.

-- ------------------------------------------------------------
-- Realtime: enable inserts/updates broadcast to subscribed clients.
-- Hosted Supabase ships a 'supabase_realtime' publication; in dev environments
-- it may be absent — guard the ADD TABLE.
-- ------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    -- Add only if not already in the publication.
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'messages'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
    END IF;
  END IF;
END $$;

-- REPLICA IDENTITY FULL ensures realtime UPDATE events carry the old row, so
-- the read_at flip propagates to other tabs without a refetch.
ALTER TABLE public.messages REPLICA IDENTITY FULL;
