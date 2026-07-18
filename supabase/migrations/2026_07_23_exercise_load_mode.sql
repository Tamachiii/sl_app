-- ============================================================
-- Per-exercise loading mode — unlocks relative strength (×BW).
--
-- How the logged weight_kg relates to the TOTAL resistance:
--   'full'  = logged weight IS the total load (barbell squat/bench/OHP, machines).
--   'added' = logged weight is ADDED on top of bodyweight (weighted pull-up/dip/
--             muscle-up); system load = bodyweight + added.
--   NULL    = unclassified (the default for every existing row) — behaves exactly
--             like today: the added/logged-load est. 1RM headline, no ×BW pill.
--
-- NULLABLE + no default is deliberately zero-regression and OPT-IN: nothing
-- changes on deploy, and a ×BW figure only appears once a coach classifies a
-- movement AND the student has logged bodyweight. (A NOT NULL DEFAULT would
-- silently label the weighted-calisthenics majority and show a wrong low ×BW.)
-- ============================================================

ALTER TABLE public.exercise_library
  ADD COLUMN load_mode text CHECK (load_mode IS NULL OR load_mode IN ('full','added'));

COMMENT ON COLUMN public.exercise_library.load_mode IS
  'NULL = unclassified (added/logged-load e1RM, no ×BW). ''full'' = logged weight_kg IS the total resistance; ''added'' = logged weight_kg is added on top of bodyweight (system load = bodyweight + added).';
