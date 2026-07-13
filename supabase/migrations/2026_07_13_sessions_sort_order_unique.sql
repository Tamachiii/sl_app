-- ============================================================
-- Sessions: unique sort_order per week.
--
-- sessions had no uniqueness on (week_id, sort_order), and the editor
-- created collisions: adding a session assigned sort_order from the count
-- of NON-archived sessions, so after any archive/delete the new session
-- reused an existing position. Week duplication then mapped old→new
-- sessions BY sort_order, silently merging the tied sessions' slots into
-- one copy and leaving the other empty.
--
-- The client is fixed to (a) assign max(sort_order)+1 over all sessions
-- and (b) map duplication copies by insertion index instead of sort_order.
-- This migration repairs existing ties, then adds the constraint so the
-- collision class is dead at the DB level.
--
-- NOTE: sessions have no drag-reorder flow (only weeks and slots do). If
-- one is ever added, it must use the two-pass park-then-place renumber the
-- week reorder uses — plain pairwise swaps would trip this constraint.
-- ============================================================

-- Repair: renumber each week's sessions 0..n-1, stable on the existing
-- (sort_order, day_number, created id) order so nothing visibly moves.
WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY week_id
      ORDER BY sort_order, day_number, id
    ) - 1 AS rn
  FROM public.sessions
)
UPDATE public.sessions s
   SET sort_order = r.rn
  FROM ranked r
 WHERE s.id = r.id
   AND s.sort_order IS DISTINCT FROM r.rn;

ALTER TABLE public.sessions
  DROP CONSTRAINT IF EXISTS sessions_week_sort_order_unique;
ALTER TABLE public.sessions
  ADD CONSTRAINT sessions_week_sort_order_unique UNIQUE (week_id, sort_order);
