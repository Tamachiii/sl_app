-- Rollback of 2026_10_13_16_rest_push_scheduling: drops the four functions
-- of the rest push, the two columns and the condition of the two policies,
-- and puts the rule of four statuses back.
--
-- !! NOT ONCE THE EDGE FUNCTIONS OF WAVE 2 ARE DEPLOYED, unless the ones
-- !! from before are deployed again first. The dispatch-rest-push and the
-- !! send-push of wave 2 ask claim_rest_push before they send: after this
-- !! file that call fails, and no rest push is sent by anybody.
--
-- With the Edge Functions that were deployed before wave 2, and with every
-- app — the one of wave 3 falls back on its own INSERT where
-- schedule_rest_push is missing — nothing anybody sees changes. There is no
-- reason to run it other than the check of the page answering NOT PROTECTED
-- or BROKEN, or a migration applied to the wrong project
-- (docs/runbook/migrations/16-rest-push-scheduling.md).
--
-- ROWS ARE REWRITTEN, AND DO NOT COME BACK.
--   * The rule of four statuses cannot hold a row that is 'expired' or
--     'sending'. Both become 'failed', with a sentence in `error` that says
--     which it was (an error that is there already is kept).
--   * The rows the migration closed — the backlog — stay closed: they are
--     NOT made 'pending' again. Nothing was going to send them.
--   * endpoint and dispatched_at go with their columns: a rest that is
--     running when this file is run rings on every device of its athlete.
-- No row is deleted.
--
-- Refused (SLM04) while the ledger records a later migration: those build on
-- this one — migration 19 schedules dispatch_due_rest_pushes. Roll the later
-- ones back first, last applied first.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
DECLARE
  v_later text;
BEGIN
  -- Two questions, in this order: the second cannot be asked without a ledger.
  IF to_regclass('app_private.app_migrations') IS NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_16_rest_push_scheduling is not applied: there is no app_private.app_migrations'
      USING ERRCODE = 'SLM03', HINT = 'Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_13_16_rest_push_scheduling') THEN
    RAISE EXCEPTION 'migration 2026_10_13_16_rest_push_scheduling is not applied'
      USING ERRCODE = 'SLM03', HINT = 'Nothing was changed.';
  END IF;

  SELECT string_agg(name, ', ' ORDER BY name) INTO v_later
    FROM app_private.app_migrations
   WHERE substring(name from '^[0-9]{4}_[0-9]{2}_[0-9]{2}_([0-9]{2})_')::int > 16;
  IF v_later IS NOT NULL THEN
    RAISE EXCEPTION 'the ledger still records later migrations: %', v_later
      USING ERRCODE = 'SLM04', HINT = 'Roll those back first. Nothing was changed.';
  END IF;
END
$guard$;

-- By their arguments: a function of the same name that somebody made
-- afterwards, with other arguments, is not this file's to drop.
DROP FUNCTION IF EXISTS public.dispatch_due_rest_pushes();
DROP FUNCTION IF EXISTS public.claim_rest_push(uuid);
DROP FUNCTION IF EXISTS public.cancel_rest_push(uuid);
DROP FUNCTION IF EXISTS public.schedule_rest_push(integer, jsonb, text);

-- The two policies as they were: whose row it is, and nothing about the
-- endpoint — the column is about to go.
ALTER POLICY "Insert own scheduled pushes" ON public.scheduled_pushes
  WITH CHECK (user_id = auth.uid());

ALTER POLICY "Cancel own scheduled pushes" ON public.scheduled_pushes
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- The two statuses the old rule does not know. Not 'pending': a row that is
-- pending is a push somebody may still send.
UPDATE public.scheduled_pushes sp
   SET status = 'failed',
       error  = COALESCE(sp.error, CASE sp.status
                  WHEN 'expired' THEN 'expired: nobody had sent it a minute after its time'
                  ELSE 'sending: its sender had not said what became of it'
                END)
 WHERE sp.status IN ('expired', 'sending');

-- One statement: the lock on the table is taken once.
ALTER TABLE public.scheduled_pushes
  DROP CONSTRAINT scheduled_pushes_status_check,
  ADD CONSTRAINT scheduled_pushes_status_check
    CHECK (status IN ('pending', 'sent', 'canceled', 'failed')),
  DROP COLUMN endpoint,
  DROP COLUMN dispatched_at;

DELETE FROM app_private.app_migrations WHERE name = '2026_10_13_16_rest_push_scheduling';

-- Two columns and four functions left public: PostgREST must forget them.
NOTIFY pgrst, 'reload schema';

COMMIT;
