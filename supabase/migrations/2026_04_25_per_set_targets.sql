-- ============================================================
-- Per-set targets on set_logs
-- Until now, prescription lived on exercise_slots ({sets, reps, weight_kg,
-- duration_seconds, rest_seconds}) and applied uniformly across every set.
-- We now store the prescription on each set_log row alongside the actuals,
-- so a single exercise can have heterogeneous sets (drop sets, back-offs).
--
-- The exercise_slots columns stay (deprecated, read-only mirrors of "set 1")
-- as a safety net. Drop them in a follow-up migration once nothing reads them.
-- ============================================================

ALTER TABLE public.set_logs
  ADD COLUMN IF NOT EXISTS target_reps             int,
  ADD COLUMN IF NOT EXISTS target_duration_seconds int,
  ADD COLUMN IF NOT EXISTS target_weight_kg        numeric(6,2),
  ADD COLUMN IF NOT EXISTS target_rest_seconds     int;

ALTER TABLE public.set_logs
  ADD CONSTRAINT set_logs_target_unit_one_of
  CHECK (
    target_reps IS NULL
    OR target_duration_seconds IS NULL
  );

-- Backfill existing per-set rows from their slot's uniform values.
UPDATE public.set_logs sl
   SET target_reps             = es.reps,
       target_duration_seconds = es.duration_seconds,
       target_weight_kg        = es.weight_kg,
       target_rest_seconds     = es.rest_seconds
  FROM public.exercise_slots es
 WHERE sl.exercise_slot_id = es.id
   AND sl.target_reps IS NULL
   AND sl.target_duration_seconds IS NULL;

-- Materialize set_logs for slots whose student never opened the session yet,
-- so the prescription is durable even if the student never visits. The client
-- still calls useEnsureSetLogs as a safety net.
INSERT INTO public.set_logs (
  exercise_slot_id, set_number, done,
  target_reps, target_duration_seconds, target_weight_kg, target_rest_seconds
)
SELECT es.id, gs.n, false,
       es.reps, es.duration_seconds, es.weight_kg, es.rest_seconds
  FROM public.exercise_slots es
       CROSS JOIN LATERAL generate_series(1, es.sets) AS gs(n)
       LEFT JOIN public.set_logs sl
         ON sl.exercise_slot_id = es.id AND sl.set_number = gs.n
 WHERE sl.id IS NULL;
