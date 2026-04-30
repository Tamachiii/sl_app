-- ============================================================
-- A failed set cannot carry an RPE value. Rating a set the
-- student didn't complete isn't meaningful — and the UI already
-- locks the RPE input on failed sets, so this just makes the
-- invariant true at the DB level too.
--
-- Step 1 cleans up any rows where the bug let an RPE survive a
-- transition to failed; step 2 adds the CHECK constraint that
-- prevents the state from arising again.
-- ============================================================

UPDATE public.set_logs
   SET rpe = NULL
 WHERE failed = TRUE
   AND rpe IS NOT NULL;

ALTER TABLE public.set_logs
  DROP CONSTRAINT IF EXISTS set_logs_no_rpe_when_failed;

ALTER TABLE public.set_logs
  ADD CONSTRAINT set_logs_no_rpe_when_failed CHECK (
    NOT (failed AND rpe IS NOT NULL)
  );
