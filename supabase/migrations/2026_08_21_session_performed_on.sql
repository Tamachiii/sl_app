-- ============================================================
-- Phase 1 of the "calendar is a consequence" refactor: record WHEN a session
-- was actually trained, as a first-class fact.
--
-- Until now the closest thing to a completion date was
-- `session_confirmations.confirmed_at` (server clock at INSERT time). That is
-- wrong in the one case that matters most for a PWA: a student who trains
-- offline and reconnects two days later gets the REPLAY timestamp, not the
-- training moment. `set_logs.logged_at` is truthful (minted client-side at the
-- moment the set is ticked, so it survives offline queueing) but is per-set and
-- was never aggregated anywhere.
--
-- Two additive columns:
--   * session_confirmations.performed_on — a bare LOCAL calendar date the
--     client computes from the session's set_logs at confirm time. Nullable:
--     old rows and any client that doesn't send it fall back to confirmed_at.
--   * sessions.performed_at — a denormalized mirror, so a surface that already
--     walks the program tree (student Home queue, coach roster staleness) gets
--     the date without a second join. Same idiom as `sessions.reviewed_at`.
--
-- The mirror is kept in sync by a DEDICATED trigger rather than by extending
-- notify_coach_on_session_confirm: that function is the notification/Web-Push
-- path (AFTER INSERT only, with an EXCEPTION-wrapped pg_net call), and folding
-- a data write into it would both mix failure domains and miss the UPDATE
-- (offline replay upserts) and DELETE (undo) branches this needs.
--
-- Nothing about weeks changes here. `programs → weeks → sessions` stays exactly
-- as it is; this migration only adds the truth the later phases read from.
-- ============================================================

-- ── Columns ────────────────────────────────────────────────────────────────

ALTER TABLE public.session_confirmations
  ADD COLUMN IF NOT EXISTS performed_on date;

COMMENT ON COLUMN public.session_confirmations.performed_on IS
  'Local calendar date the student actually trained, computed client-side from '
  'the session''s set_logs.logged_at at confirm time. NULL falls back to '
  'confirmed_at. Deliberately not bounded in the past: confirming days after '
  'training is normal and is the whole point of the column.';

ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS performed_at timestamptz;

COMMENT ON COLUMN public.sessions.performed_at IS
  'Denormalized mirror of the session''s confirmation date, maintained by '
  'trg_sync_session_performed_at. NULL means "not performed" (never confirmed, '
  'or the confirmation was undone).';

CREATE INDEX IF NOT EXISTS sessions_performed_idx
  ON public.sessions (performed_at) WHERE performed_at IS NOT NULL;

-- ── Backfill (one-time, before the trigger exists so it can't churn) ───────
-- Preference order matches the client's: the FIRST logged set of the session
-- (when the student started training) beats the confirmation timestamp. `::date`
-- resolves in the database timezone rather than the student's, which can be a
-- day off for a late-night trainer — acceptable for historical rows, and the
-- reason new rows compute the date client-side in local time instead.

WITH first_log AS (
  SELECT es.session_id, MIN(sl.logged_at) AS logged_at
    FROM public.set_logs sl
    JOIN public.exercise_slots es ON es.id = sl.exercise_slot_id
   WHERE sl.logged_at IS NOT NULL
   GROUP BY es.session_id
)
UPDATE public.session_confirmations sc
   SET performed_on = fl.logged_at::date
  FROM first_log fl
 WHERE fl.session_id = sc.session_id
   AND sc.performed_on IS NULL;

-- Whatever is left never had a logged set (confirmed without ticking anything).
UPDATE public.session_confirmations
   SET performed_on = confirmed_at::date
 WHERE performed_on IS NULL;

UPDATE public.sessions s
   SET performed_at = COALESCE(sc.performed_on::timestamptz, sc.confirmed_at)
  FROM public.session_confirmations sc
 WHERE sc.session_id = s.id
   AND s.performed_at IS NULL;

-- ── Mirror trigger ─────────────────────────────────────────────────────────
-- SECURITY DEFINER because students have no UPDATE grant on `sessions` (only
-- coaches do) — the mirror is derived data, not a student write.

CREATE OR REPLACE FUNCTION public.sync_session_performed_at()
RETURNS TRIGGER AS $$
DECLARE
  v_performed timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Undoing a confirmation un-performs the session; leaving a stale
    -- performed_at would keep it out of the "what's next" queue and skew the
    -- staleness chip.
    UPDATE public.sessions SET performed_at = NULL WHERE id = OLD.session_id;
    RETURN OLD;
  END IF;

  v_performed := COALESCE(NEW.performed_on::timestamptz, NEW.confirmed_at);

  -- performed_on is client-supplied (the INSERT policy allows any column the
  -- student writes), so guard the one direction that can't be legitimate: a
  -- date in the future. A day of slack absorbs timezones ahead of the server.
  IF v_performed > NEW.confirmed_at + interval '1 day' THEN
    v_performed := NEW.confirmed_at;
  END IF;

  UPDATE public.sessions SET performed_at = v_performed WHERE id = NEW.session_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_sync_session_performed_at ON public.session_confirmations;
CREATE TRIGGER trg_sync_session_performed_at
  AFTER INSERT OR DELETE OR UPDATE OF performed_on, confirmed_at
  ON public.session_confirmations
  FOR EACH ROW EXECUTE FUNCTION public.sync_session_performed_at();
