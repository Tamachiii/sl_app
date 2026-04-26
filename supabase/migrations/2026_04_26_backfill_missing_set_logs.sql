-- Backfill missing set_logs for legacy slots.
--
-- Context: useAddSlot has materialized one set_log per planned set since the
-- per-set-targets migration (2026_04_25_per_set_targets.sql), and the client
-- runs useEnsureSetLogs on SessionView mount as a safety net for older slots
-- that were created before that. Once the lock-inactive-program-writes
-- migration ships, the safety-net INSERT is rejected by RLS for past-program
-- slots — and any legacy session that never had its logs materialized while
-- still active becomes visually empty (no SetRows, no targets, no done state).
--
-- Run-once backfill: for every exercise_slot row, insert any missing
-- set_logs covering set_number 1..slot.sets, copying targets from the
-- slot's deprecated mirror columns (the same fallback useEnsureSetLogs uses).
-- done defaults to false because we have no record of completion — actuals
-- prior to this point were genuinely absent.
--
-- Idempotent: WHERE NOT EXISTS skips any row that already exists.

INSERT INTO public.set_logs (
  exercise_slot_id,
  set_number,
  done,
  target_reps,
  target_duration_seconds,
  target_weight_kg,
  target_rest_seconds
)
SELECT
  es.id,
  gs.n,
  false,
  es.reps,
  es.duration_seconds,
  es.weight_kg,
  es.rest_seconds
FROM public.exercise_slots es
CROSS JOIN LATERAL generate_series(1, es.sets) AS gs(n)
WHERE NOT EXISTS (
  SELECT 1 FROM public.set_logs sl
  WHERE sl.exercise_slot_id = es.id AND sl.set_number = gs.n
);
