-- ============================================================
-- Stage 1 of the Programming rework: `sessions.sort_order` becomes the ONE
-- source of truth for the order of a block.
--
-- Until now the order a coach and an athlete SAW was computed client-side,
-- weekday first (`compareSessions`), with `sort_order` as a mere tiebreak —
-- and later `compareQueued` put two dated sessions in date order ahead of
-- that. `sort_order` itself was only ever written at INSERT, so it carried
-- creation order and nothing else. The consequence: the recommended weekday
-- was the only lever that actually reordered the athlete's queue. Setting a
-- day silently reprioritised training.
--
-- The client is about to sort by `sort_order` alone. Measured on production
-- before this ran: 56 of 253 sessions across 28 of 86 weeks would have
-- CHANGED POSITION on deploy. This backfill renumbers every week to the order
-- that is on screen today, so nothing moves.
--
-- The ordering rule below reproduces `compareQueued`, which is what both
-- surfaces render:
--   1. active sessions before archived ones (the sheet lists them separately,
--      and UNIQUE(week_id, sort_order) spans both, so archived rows take the
--      tail of the range),
--   2. real calendar date when the coach set one,
--   3. recommended weekday, unset sorting last,
--   4. the previous sort_order, then id, so the result is deterministic.
--
-- Caveat, recorded deliberately: `compareQueued` is NOT a total order when a
-- week mixes dated and undated sessions — it compares two dated sessions by
-- date but falls back to weekday the moment one side has no date, which can
-- produce a cycle (A<B, B<C, C<A). Only 3 of 86 weeks mix them, and in those
-- the on-screen order is already whatever Array.sort happened to produce. This
-- migration replaces that with something deterministic.
--
-- Two passes because `sessions_week_sort_order_unique` is UNIQUE and NOT
-- deferrable: writing final positions directly would collide mid-statement.
-- Same park-then-place shape as `useReorderWeeks`.
-- ============================================================

-- Pass 1 — park every row far outside the target range (max sort_order was 4).
UPDATE public.sessions SET sort_order = sort_order + 1000;

-- Pass 2 — place each week's sessions at 0..n-1 in the order shown today.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY week_id
           ORDER BY (archived_at IS NOT NULL),
                    scheduled_date NULLS LAST,
                    COALESCE(day_number, 99),
                    sort_order,
                    id
         ) - 1 AS new_order
    FROM public.sessions
)
UPDATE public.sessions s
   SET sort_order = r.new_order
  FROM ranked r
 WHERE r.id = s.id;

COMMENT ON COLUMN public.sessions.sort_order IS
  'Position of the session within its week, 0-based and contiguous. THE source '
  'of order for both the coach sheet and the athlete queue since 2026_08_22 — '
  'day_number and scheduled_date are advisory hints that no longer sort. '
  'Renumbering must be a two-pass park-then-place: '
  'sessions_week_sort_order_unique is UNIQUE and not deferrable.';
