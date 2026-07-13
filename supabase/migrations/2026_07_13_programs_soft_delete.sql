-- ============================================================
-- Archive-first program delete.
--
-- Deleting a program was a bare DELETE riding the full cascade chain
-- (weeks → sessions → exercise_slots → set_logs → set_log_videos): one
-- confirmed click irreversibly destroyed a student's entire logged
-- history, PR charts, and lifetime stats. Confirmed finding of the
-- 2026-07-11 audit; highest-stakes item in the app.
--
-- New model:
--   * "Delete" in the UI becomes MOVE TO TRASH: programs.deleted_at is
--     stamped and is_active is cleared in the same UPDATE (a trashed row
--     must never hold the one-active-per-student slot, or the partial
--     unique index would block activating/creating a replacement).
--   * Trashed programs disappear from every surface (client filters on
--     deleted_at IS NULL) but keep all their data; restore = NULL it out
--     (the program comes back inactive).
--   * Hard delete is only offered from the trash and only succeeds when
--     the program has ZERO logged sets — enforced both client-side (for
--     a friendly message) and by the BEFORE DELETE trigger below, so no
--     API path can destroy logged training. The trigger also fires on
--     cascade deletes (e.g. a students-row delete), closing the armed
--     "coach deletes student" total-cascade path found in the audit.
--
-- For a deliberate full erasure (GDPR), drop the trigger in the same
-- session, delete, and recreate it — that is what "deliberate" means.
-- ============================================================

ALTER TABLE public.programs
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE OR REPLACE FUNCTION public.block_program_delete_with_logged_sets()
RETURNS trigger AS $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count
    FROM public.set_logs sl
    JOIN public.exercise_slots es ON es.id = sl.exercise_slot_id
    JOIN public.sessions s        ON s.id = es.session_id
    JOIN public.weeks w           ON w.id = s.week_id
   WHERE w.program_id = OLD.id
     AND (
       sl.done OR sl.failed OR sl.skipped
       OR sl.rpe IS NOT NULL
       OR sl.actual_reps IS NOT NULL
       OR sl.actual_weight_kg IS NOT NULL
     );
  IF v_count > 0 THEN
    RAISE EXCEPTION
      'program % still has % logged set(s) — move it to the trash instead of deleting',
      OLD.id, v_count;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS block_program_delete_with_logged_sets ON public.programs;
CREATE TRIGGER block_program_delete_with_logged_sets
  BEFORE DELETE ON public.programs
  FOR EACH ROW
  EXECUTE FUNCTION public.block_program_delete_with_logged_sets();

-- The program-level trigger alone leaves the highest-stakes hole open: the
-- live coach UI deletes WEEKS and SESSIONS directly (WeekView), and those
-- bare deletes cascade weeks→sessions→slots→set_logs without ever touching
-- the program row. Guard those two levels too, so logged training can never
-- be hard-deleted from any path. Sessions already support soft-archive
-- (archived_at); a coach who hits this should archive instead.
CREATE OR REPLACE FUNCTION public.block_week_delete_with_logged_sets()
RETURNS trigger AS $$
DECLARE v_count int;
BEGIN
  SELECT count(*) INTO v_count
    FROM public.set_logs sl
    JOIN public.exercise_slots es ON es.id = sl.exercise_slot_id
    JOIN public.sessions s        ON s.id = es.session_id
   WHERE s.week_id = OLD.id
     AND (sl.done OR sl.failed OR sl.skipped
          OR sl.rpe IS NOT NULL OR sl.actual_reps IS NOT NULL
          OR sl.actual_weight_kg IS NOT NULL);
  IF v_count > 0 THEN
    RAISE EXCEPTION 'week % still has % logged set(s) — archive it instead of deleting', OLD.id, v_count;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS block_week_delete_with_logged_sets ON public.weeks;
CREATE TRIGGER block_week_delete_with_logged_sets
  BEFORE DELETE ON public.weeks
  FOR EACH ROW
  EXECUTE FUNCTION public.block_week_delete_with_logged_sets();

CREATE OR REPLACE FUNCTION public.block_session_delete_with_logged_sets()
RETURNS trigger AS $$
DECLARE v_count int;
BEGIN
  SELECT count(*) INTO v_count
    FROM public.set_logs sl
    JOIN public.exercise_slots es ON es.id = sl.exercise_slot_id
   WHERE es.session_id = OLD.id
     AND (sl.done OR sl.failed OR sl.skipped
          OR sl.rpe IS NOT NULL OR sl.actual_reps IS NOT NULL
          OR sl.actual_weight_kg IS NOT NULL);
  IF v_count > 0 THEN
    RAISE EXCEPTION 'session % still has % logged set(s) — archive it instead of deleting', OLD.id, v_count;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS block_session_delete_with_logged_sets ON public.sessions;
CREATE TRIGGER block_session_delete_with_logged_sets
  BEFORE DELETE ON public.sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.block_session_delete_with_logged_sets();

-- Couple trash to write-access at the DB level: a trashed program must never
-- be writable, regardless of is_active. The write-gate helpers key on
-- is_active only, and today the client always clears is_active on trash — but
-- a stray/admin/edge UPDATE leaving deleted_at set with is_active=true would
-- otherwise re-open student writes to a trashed block. Fold deleted_at into
-- the "active for writes" definition so the two can't drift.
CREATE OR REPLACE FUNCTION public.program_active_for_session(sess_id uuid)
RETURNS boolean AS $$
  SELECT p.is_active AND p.deleted_at IS NULL
  FROM public.sessions sess
  JOIN public.weeks w    ON w.id = sess.week_id
  JOIN public.programs p ON p.id = w.program_id
  WHERE sess.id = sess_id
$$ LANGUAGE sql SECURITY DEFINER STABLE;
