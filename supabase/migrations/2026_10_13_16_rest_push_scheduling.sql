-- ============================================================
-- 16 — The end of a rest is scheduled by the database: its time, the device
--      it is for, one sender, and nothing left waiting for ever
-- wave 2 · Checkpoint B · required · findings P10, B14, and the database's
--                                     half of B35 and B38
--
-- THE HOLES. When an athlete ticks a set, the app starts a rest timer and
-- asks for a notification at its end — the one thing that reaches a locked
-- phone. It did that in two requests of its own: a row in scheduled_pushes,
-- then a call of the dispatch-rest-push Edge Function, which waits inside
-- the request until the time has come.
--   * A REST OF 150 SECONDS OR MORE NEVER RINGS (P10). The platform ends a
--     request after 150 seconds. The function is gone by then, nothing else
--     reads the row, and the long rests — the ones with the phone locked —
--     are the ones that are lost.
--   * THE ROWS STAY (B14). Nothing deletes a row of scheduled_pushes, and a
--     row whose function died stays 'pending' for ever: anything that looked
--     for work in that table would start by sending months of old pushes.
--   * THE TIME IS THE PHONE'S (B35). fire_at is written by the app from the
--     clock of the device: a phone that is a minute off rings a minute off.
--   * EVERY DEVICE RINGS (B38). A row says whose it is and not which device
--     asked: the push goes to the phone in the hand and to the laptop at
--     home.
--   * AND NOTHING SAYS WHO SENDS. With a second way to send — a job, a chain
--     of function calls — two senders can pick the same row.
--
-- WHAT THIS FILE DOES.
--   1. scheduled_pushes can say more: two statuses — 'sending' (a sender has
--      taken the row and is sending it) and 'expired' (nobody sent it within
--      a minute of its time) — and two columns: endpoint (the device the
--      push is for; NULL is every device of the account, which is what a row
--      of the app deployed today means) and dispatched_at (when the job of
--      migration 19 handed the row to send-push; NULL until then, and for
--      ever where that job does not run).
--   2. An account names a device of its own only: the two policies through
--      which the app writes the table itself ask that endpoint is NULL or
--      one of the caller's push_subscriptions.
--   3. schedule_rest_push(p_seconds, p_payload, p_endpoint) is the whole
--      request of the next app: the time is now() + p_seconds on the
--      server's clock, the rows the caller still had waiting are closed (one
--      rest at a time), the caller's rows older than 7 days are deleted, and
--      the answer says who will send — { id, fire_at, mode }, mode 'cron'
--      while a pg_cron job named sl-rest-push is active, 'edge' otherwise:
--      then the app calls dispatch-rest-push with the id, as it does today.
--   4. cancel_rest_push(p_id) closes a row of the caller that is still
--      waiting.
--   5. claim_rest_push(p_id) is the ONE way a row gets sent: it moves the
--      row from 'pending' to 'sending' and answers it — once. Whoever sends
--      asks it first, at the time of the push, and sends only what it
--      answered: two senders that pick the same row are one push. A row that
--      was canceled, or whose time is more than a minute past, is never
--      answered. For the service role: the Edge Functions.
--   6. dispatch_due_rest_pushes() is what the job of migration 19 runs every
--      ten seconds. It closes the rows more than a minute late, and hands
--      each row due in the next ten seconds to send-push — once — with the
--      time not to send before; send-push waits, then asks claim_rest_push.
--      NOTHING CALLS IT YET: without that job it is inert.
--   7. The rows that are waiting today for a time more than a minute past
--      are closed: 'expired', or 'canceled' where their athlete had asked
--      for that. No row is deleted, and a rest that is running is untouched.
--
-- WHAT A CLIENT SEES. Nothing. The app that is deployed, and the one of
-- wave 1, go on with their own INSERT, their own call of dispatch-rest-push
-- and their own UPDATE of canceled_at — none of them names an endpoint. The
-- dispatch-rest-push that is deployed goes on reading and writing the rows
-- it is given. The app of wave 3 calls the two functions, and falls back on
-- today's requests where they are missing.
--
-- Backward compatible: yes, with every client and both Edge Functions as
-- deployed. The Edge Functions of wave 2 need this file first.
-- Audit:    supabase/audits/2026_10_13_16_rest_push_scheduling.audit.sql
-- Rollback: supabase/rollbacks/2026_10_13_16_rest_push_scheduling.down.sql
-- Runbook:  docs/runbook/migrations/16-rest-push-scheduling.md
-- ============================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
DECLARE
  v_list text;
BEGIN
  -- First of all, because no other role can even look at the ledger. What is
  -- created below must belong to the role that owns the tables: three of the
  -- functions run as their owner, and the default privileges that keep a new
  -- function closed (migration 03) are those of `postgres`.
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'migration 2026_10_13_16_rest_push_scheduling must be run as postgres, not as %', current_user
      USING HINT = 'Run it from the SQL editor or with `supabase db query --linked`. Nothing was changed.';
  END IF;

  -- Asked before the ledger is read: without it the answer would be
  -- "relation does not exist" instead of this one.
  IF to_regclass('app_private.app_migrations') IS NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_16_rest_push_scheduling needs 2026_10_13_15_push_plumbing, which is not applied'
      USING ERRCODE = 'SLM02', HINT = 'Apply migrations 01 to 15 first. Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_13_16_rest_push_scheduling') THEN
    RAISE EXCEPTION 'migration 2026_10_13_16_rest_push_scheduling is already applied'
      USING ERRCODE = 'SLM01', HINT = 'Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_13_15_push_plumbing') THEN
    RAISE EXCEPTION 'migration 2026_10_13_16_rest_push_scheduling needs 2026_10_13_15_push_plumbing, which is not applied'
      USING ERRCODE = 'SLM02', HINT = 'Apply that file first. Nothing was changed.';
  END IF;

  -- The four functions are CREATED, not replaced. One that is there already,
  -- under one of the names — with these arguments or with others — was made
  -- by hand: the API finds a function by its name and the names of its
  -- arguments, and two of a name are a call that may reach the wrong one.
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text)
    INTO v_list
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('schedule_rest_push', 'cancel_rest_push', 'claim_rest_push', 'dispatch_due_rest_pushes');
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_16_rest_push_scheduling would not create: % is already there', v_list
      USING HINT = 'A function of this file exists, made by hand or by a file that is not in the ledger. Nothing was changed. Stop and report.';
  END IF;

  -- The two columns are ADDED. One of that name that is there already was
  -- made by hand, and may hold something else.
  SELECT string_agg('public.scheduled_pushes.' || a.attname, ', ' ORDER BY a.attname)
    INTO v_list
    FROM pg_attribute a
   WHERE a.attrelid = to_regclass('public.scheduled_pushes')
     AND a.attname IN ('endpoint', 'dispatched_at') AND NOT a.attisdropped;
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_16_rest_push_scheduling would not add: % is already there', v_list
      USING HINT = 'A column of this file exists, made by hand or by a file that is not in the ledger. Nothing was changed. Stop and report.';
  END IF;

  -- The body of a function is not checked against the database when it is
  -- created: a column or a function that is missing would be found by the
  -- first athlete who rests. Asked here instead.
  SELECT string_agg(w.what, ', ' ORDER BY w.what)
    INTO v_list
    FROM (VALUES ('public.scheduled_pushes.id'),
                 ('public.scheduled_pushes.user_id'),
                 ('public.scheduled_pushes.fire_at'),
                 ('public.scheduled_pushes.payload'),
                 ('public.scheduled_pushes.status'),
                 ('public.scheduled_pushes.canceled_at'),
                 ('public.scheduled_pushes.created_at'),
                 ('public.push_subscriptions.user_id'),
                 ('public.push_subscriptions.endpoint')
         ) AS w (what)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = to_regclass(substring(w.what from '^(.*)[.][^.]+$'))
        AND a.attname = substring(w.what from '[.]([^.]+)$') AND NOT a.attisdropped
   );
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_16_rest_push_scheduling does not find the columns its functions are written with: %', v_list
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;
  -- dispatch_due_rest_pushes hands a row over through the function of
  -- migration 15, inside a net that would turn "no such function" into a
  -- warning every ten seconds.
  IF to_regprocedure('public.send_push_event(uuid, jsonb, jsonb)') IS NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_16_rest_push_scheduling does not find the function its functions call: public.send_push_event(uuid, jsonb, jsonb)'
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;

  -- The rule on the status is REPLACED by one that knows two more. It must
  -- be the rule this file was written for: one that says something else was
  -- changed by hand, and replacing it would undo that without a word.
  SELECT CASE
           WHEN count(*) = 0 THEN 'the constraint scheduled_pushes_status_check is not there'
           WHEN max(pg_get_constraintdef(c.oid))
                <> 'CHECK ((status = ANY (ARRAY[''pending''::text, ''sent''::text, ''canceled''::text, ''failed''::text])))'
             THEN 'the constraint scheduled_pushes_status_check reads ' || max(pg_get_constraintdef(c.oid))
         END
    INTO v_list
    FROM pg_constraint c
   WHERE c.conrelid = to_regclass('public.scheduled_pushes')
     AND c.conname = 'scheduled_pushes_status_check'
     AND c.contype = 'c';
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_16_rest_push_scheduling would not replace the rule on public.scheduled_pushes.status: %', v_list
      USING HINT = 'It was written for a rule that allows pending, sent, canceled and failed. Nothing was changed. Stop and report the full message.';
  END IF;

  -- The two policies are ALTERED: each must be there, for its command.
  SELECT string_agg(w.name || ' (' || w.command || ')', ', ' ORDER BY w.name)
    INTO v_list
    FROM (VALUES ('Insert own scheduled pushes', 'a', 'INSERT'),
                 ('Cancel own scheduled pushes', 'w', 'UPDATE')
         ) AS w (name, cmd, command)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_policy p
      WHERE p.polrelid = to_regclass('public.scheduled_pushes')
        AND p.polname = w.name AND p.polcmd::text = w.cmd
   );
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_16_rest_push_scheduling does not find the policies of public.scheduled_pushes it adds a condition to: %', v_list
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;
END
$guard$;

-- ------------------------------------------------------------
-- 1. What a row can say.
-- ------------------------------------------------------------
--   status   pending    waiting for its time
--            sending    a sender has taken it (claim_rest_push) and is
--                       sending; the sender then writes sent or failed
--            sent       at least one device got it          (sent_at)
--            failed     no device got it                    (error)
--            canceled   its athlete took it back before its time
--                       (canceled_at) — the next set was started, the
--                       session was left
--            expired    its time is more than a minute past and nobody had
--                       sent it: a push that late is worse than none
--   endpoint       the device the push is for — the endpoint of one of the
--                  account's push_subscriptions. NULL: every device of the
--                  account, which is what a row means that the app from
--                  before wave 3 inserts.
--   dispatched_at  when dispatch_due_rest_pushes handed the row to
--                  send-push. It is what makes that happen once. NULL where
--                  the job of migration 19 does not run.
--
-- The app that is deployed cancels by writing canceled_at on a row it leaves
-- 'pending': a row is canceled when its status says so OR canceled_at is
-- set. Every function below reads both.
--
-- One statement: the lock on the table is taken once. The rule is checked
-- against the rows that are there, which hold one of the first four.
ALTER TABLE public.scheduled_pushes
  ADD COLUMN endpoint      text,
  ADD COLUMN dispatched_at timestamptz,
  DROP CONSTRAINT scheduled_pushes_status_check,
  ADD CONSTRAINT scheduled_pushes_status_check
    CHECK (status IN ('pending', 'sending', 'sent', 'canceled', 'failed', 'expired'));

-- ------------------------------------------------------------
-- 2. An account names a device of its own, and no other.
-- ------------------------------------------------------------
-- Until the contract step an account still writes this table itself (the
-- app from before wave 3 does), and whoever sends a row reads where to from
-- it. Without the condition a row is a way to aim a push, with a text of the
-- writer's choosing, at the device of somebody else whose endpoint the
-- writer has learnt. The app that is deployed never writes the column: its
-- rows pass as they did.
--
-- The policies keep their name, their command and their roles. The lookup
-- runs with the rights of the caller, who reads their own subscriptions and
-- no others — which is the question.
ALTER POLICY "Insert own scheduled pushes" ON public.scheduled_pushes
  WITH CHECK (
    user_id = auth.uid()
    AND (
      endpoint IS NULL
      OR EXISTS (
        SELECT 1 FROM public.push_subscriptions ps
         WHERE ps.user_id = auth.uid()
           AND ps.endpoint = scheduled_pushes.endpoint
      )
    )
  );

ALTER POLICY "Cancel own scheduled pushes" ON public.scheduled_pushes
  USING (user_id = auth.uid())
  WITH CHECK (
    user_id = auth.uid()
    AND (
      endpoint IS NULL
      OR EXISTS (
        SELECT 1 FROM public.push_subscriptions ps
         WHERE ps.user_id = auth.uid()
           AND ps.endpoint = scheduled_pushes.endpoint
      )
    )
  );

-- ------------------------------------------------------------
-- 3. The end of a rest, scheduled in one request.
-- ------------------------------------------------------------
--   p_seconds    how long the rest is, from now: 1 to 900
--   p_payload    what the notification shows — { "title", "body", "tag",
--                "data": { "url" } } — handed to the service worker as it is
--   p_endpoint   the device that asks: the endpoint of its push
--                subscription. Left out or NULL: every device of the account
--   returns      { "id", "fire_at", "mode" }
--                id        the row; what cancel_rest_push takes
--                fire_at   now() + p_seconds, on the clock of the database
--                mode      'cron'  the job of migration 19 sends it: the app
--                                  has nothing more to do
--                          'edge'  nobody will, unless the app now calls the
--                                  dispatch-rest-push Edge Function with
--                                  { "scheduleId": id }
--
--   does      closes every row of the caller that is still waiting — one
--             rest at a time: the set that starts a rest ends the one before
--             ('canceled'; 'expired' for a row nobody had sent a minute after
--             its time) — deletes the caller's rows older than 7 days, and
--             inserts the new one.
--
--   refuses   not authorized             (42501) the request carries no
--                                        user id
--             rest_seconds_out_of_range  p_seconds is missing, under 1 or
--                                        over 900
--             payload_invalid            p_payload is not a JSON object, or
--                                        is longer than 2000 bytes
--             device_not_registered      p_endpoint is not a device of the
--                                        caller — or, without one, the
--                                        caller has no device at all
--   … and has then written nothing.
--
-- THE MODE is read where pg_cron keeps its jobs. 'cron' only while a job
-- named sl-rest-push is there and active; no pg_cron, no such job, a job
-- switched off, or a table that cannot be read: 'edge'. Answering 'edge'
-- when the job does run costs one call of the Edge Function and no second
-- push — whoever sends asks claim_rest_push first.
--
-- 900 SECONDS is what the Edge Function can wait for, in hops, where no job
-- runs; the function refuses the same rest in both modes rather than accept
-- one that only one of them can ring.
--
-- Two calls of one account at the same instant are served one after the
-- other (an advisory lock on the account, held to the end of the
-- transaction): the second closes the row of the first.
--
-- SECURITY DEFINER: it reads the jobs of pg_cron, which no signed-in user
-- may, and it must go on working once the contract step has taken the
-- policies away through which an account writes this table itself. It asks
-- who calls first, and writes rows of the caller only.
CREATE FUNCTION public.schedule_rest_push(
  p_seconds  integer,
  p_payload  jsonb,
  p_endpoint text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_id      uuid;
  v_fire_at timestamptz;
  v_mode    text := 'edge';
  v_job     boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authorized'
      USING ERRCODE = 'insufficient_privilege',
            DETAIL = 'The request carries no user id.',
            HINT = 'The end of a rest is scheduled by the account that rests. Nothing was changed.';
  END IF;
  IF p_seconds IS NULL OR p_seconds < 1 OR p_seconds > 900 THEN
    RAISE EXCEPTION 'rest_seconds_out_of_range'
      USING DETAIL = 'The end of a rest is scheduled 1 to 900 seconds ahead.',
            HINT = 'Nothing was changed.';
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR octet_length(p_payload::text) > 2000 THEN
    RAISE EXCEPTION 'payload_invalid'
      USING DETAIL = 'The payload is what the notification shows: a JSON object, of 2000 bytes at most.',
            HINT = 'Nothing was changed.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.push_subscriptions ps
     WHERE ps.user_id = v_uid
       AND (p_endpoint IS NULL OR ps.endpoint = p_endpoint)
  ) THEN
    RAISE EXCEPTION 'device_not_registered'
      USING DETAIL = 'The endpoint sent is not a device this account has switched notifications on for — or none was sent, and the account has no such device.',
            HINT = 'Nothing was changed.';
  END IF;

  -- One call at a time for an account: the next statement of a call that
  -- waited here sees the row of the one before.
  PERFORM pg_advisory_xact_lock(hashtextextended('sl_app.rest_push.' || v_uid::text, 0));

  UPDATE public.scheduled_pushes sp
     SET status      = CASE WHEN sp.canceled_at IS NULL AND sp.fire_at <= now() - interval '60 seconds'
                            THEN 'expired' ELSE 'canceled' END,
         canceled_at = CASE WHEN sp.canceled_at IS NULL AND sp.fire_at > now() - interval '60 seconds'
                            THEN now() ELSE sp.canceled_at END
   WHERE sp.user_id = v_uid
     AND sp.status = 'pending';

  DELETE FROM public.scheduled_pushes sp
   WHERE sp.user_id = v_uid
     AND sp.created_at < now() - interval '7 days';

  INSERT INTO public.scheduled_pushes (user_id, fire_at, payload, endpoint)
  VALUES (v_uid, now() + make_interval(secs => p_seconds), p_payload, p_endpoint)
  RETURNING id, fire_at INTO v_id, v_fire_at;

  -- Who will send it. The table is pg_cron's, and is not there without the
  -- extension: asked by name, and read in a statement of its own. Whatever
  -- goes wrong with the question, the rest is scheduled, and 'edge' is the
  -- answer that is always safe.
  BEGIN
    IF to_regclass('cron.job') IS NOT NULL THEN
      EXECUTE 'SELECT EXISTS (SELECT 1 FROM cron.job j WHERE j.jobname = $1 AND j.active)'
         INTO v_job
        USING 'sl-rest-push';
      IF v_job THEN
        v_mode := 'cron';
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_mode := 'edge';
  END;

  RETURN jsonb_build_object('id', v_id, 'fire_at', v_fire_at, 'mode', v_mode);
END;
$$;

REVOKE ALL ON FUNCTION public.schedule_rest_push(integer, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.schedule_rest_push(integer, jsonb, text) TO authenticated;

-- ------------------------------------------------------------
-- 4. A rest that ends early: its push is taken back.
-- ------------------------------------------------------------
--   p_id      the id schedule_rest_push answered
--   returns   { "canceled": true }   the row was waiting, and is closed
--             { "canceled": false }  there was nothing to take back: it is
--                                    sent or being sent, closed already, not
--                                    the caller's, or no row at all
--   refuses   not authorized   (42501) the request carries no user id
--
-- Too late is not an error: a rest that ends in the second its push leaves
-- is a push that arrives. Somebody else's row and no row are one answer.
--
-- SECURITY DEFINER, for the reason schedule_rest_push is: the contract step
-- takes the UPDATE policy away. It closes rows of the caller only.
CREATE FUNCTION public.cancel_rest_push(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authorized'
      USING ERRCODE = 'insufficient_privilege',
            DETAIL = 'The request carries no user id.',
            HINT = 'A rest is taken back by the account that scheduled it. Nothing was changed.';
  END IF;

  UPDATE public.scheduled_pushes sp
     SET status      = 'canceled',
         canceled_at = COALESCE(sp.canceled_at, now())
   WHERE sp.id = p_id
     AND sp.user_id = v_uid
     AND sp.status = 'pending';

  RETURN jsonb_build_object('canceled', FOUND);
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_rest_push(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_rest_push(uuid) TO authenticated;

-- ------------------------------------------------------------
-- 5. The one way a row gets sent.
-- ------------------------------------------------------------
--   p_id      a row of scheduled_pushes
--   returns   { "id", "user_id", "payload", "endpoint", "fire_at" } — the
--             row is the caller's to send, and is 'sending' from now on
--             NULL — it is not: somebody else took it, its athlete took it
--             back, its time is more than a minute past, or there is no
--             such row
--
-- WHOEVER SENDS A REST PUSH ASKS THIS FIRST, at the time of the push, and
-- sends only what it answered: the dispatch-rest-push Edge Function when its
-- wait is over, send-push when it is handed a row with a time not to send
-- before. The row is locked by the UPDATE that takes it, and a second caller
-- that waited for that lock finds a row that is no longer 'pending': two
-- senders that pick one row are one push, and a cancel that arrives in the
-- same instant either comes first — no push — or finds a row it can no
-- longer take back.
--
--   to whom   the devices of "user_id": all of them when "endpoint" is null,
--             the one with that endpoint otherwise — read from
--             push_subscriptions WITH THE USER ID, never by the endpoint
--             alone: a device that has changed hands since the row was
--             written is no longer this account's, and gets nothing.
--   then      the sender writes what happened on the row it was answered:
--             status 'sent' and sent_at, or 'failed' and error.
--
-- A row that is asked for and can no longer be sent is closed here —
-- 'canceled' when canceled_at is set (the cancel of the app from before
-- wave 3 leaves the status alone), 'expired' when its time is more than a
-- minute past: where no job runs, nothing else would.
--
-- NOT FOR A SIGNED-IN USER, and SECURITY INVOKER: it is given no right its
-- caller does not have. The service role, which the Edge Functions are,
-- holds every row; a signed-in user handed this function by mistake would
-- reach their own rows and no others.
CREATE FUNCTION public.claim_rest_push(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row public.scheduled_pushes;
BEGIN
  UPDATE public.scheduled_pushes sp
     SET status = 'sending'
   WHERE sp.id = p_id
     AND sp.status = 'pending'
     AND sp.canceled_at IS NULL
     AND sp.fire_at > now() - interval '60 seconds'
  RETURNING sp.* INTO v_row;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'id',       v_row.id,
      'user_id',  v_row.user_id,
      'payload',  v_row.payload,
      'endpoint', v_row.endpoint,
      'fire_at',  v_row.fire_at
    );
  END IF;

  -- Not taken. If it is still 'pending', it is one that can no longer be
  -- sent: say so on the row.
  UPDATE public.scheduled_pushes sp
     SET status = CASE WHEN sp.canceled_at IS NULL THEN 'expired' ELSE 'canceled' END
   WHERE sp.id = p_id
     AND sp.status = 'pending'
     AND (sp.canceled_at IS NOT NULL OR sp.fire_at <= now() - interval '60 seconds');

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_rest_push(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_rest_push(uuid) TO service_role;

-- ------------------------------------------------------------
-- 6. What the job runs — once there is a job.
-- ------------------------------------------------------------
--   returns   { "handed_over", "expired" } — how many rows this run passed
--             to send_push_event, and how many it closed
--
-- Every ten seconds, by the pg_cron job sl-rest-push that migration 19
-- makes. Until then NOTHING CALLS IT, and this file changes nothing about
-- who sends a rest push.
--
--   closes      every row still 'pending' more than a minute after its
--               time: 'expired', or 'canceled' where canceled_at is set.
--   hands over  every row that is waiting, not canceled, not handed over
--               yet, and due within the next ten seconds — to
--               send_push_event (migration 15), which queues the request
--               for the send-push Edge Function:
--                 { "user_id", "payload", "schedule_id", "not_before",
--                   "endpoint", "ttl": 60, "urgency": "high" }
--               "not_before" is the time of the row; "endpoint" is left out
--               when the row names none. send-push answers at once, waits
--               until not_before, asks claim_rest_push(schedule_id), and
--               sends what it is answered — to that device, or to all.
--               The row is marked (dispatched_at) in the same step: it is
--               handed over ONCE, whatever becomes of the request.
--
-- The row stays 'pending' until send-push takes it. So a rest that ends
-- early in those ten seconds is still taken back, and a row that the app
-- from before wave 3 also sent to dispatch-rest-push is sent by whichever of
-- the two asks claim_rest_push first.
--
-- ONCE, AND NOT AGAIN. A send-push that does not know "schedule_id" — the
-- one deployed before wave 2 — sends what it is handed at once, to every
-- device, and marks nothing: handed the same row every ten seconds it would
-- ring seven times. So would a retry here. The job is switched on after the
-- send-push of wave 2 is deployed (docs/runbook/migrations/
-- 16-rest-push-scheduling.md), and a request that is lost is a push that is
-- lost, as for every other push.
--
-- The call of send_push_event stands in a net of its own, like the eleven of
-- migration 15: a row that cannot be handed over is a warning, its mark is
-- undone with it, and the next run tries again. Rows that another
-- transaction holds are passed over, never waited for: a job that runs every
-- ten seconds must not queue behind a request.
--
-- SECURITY DEFINER: send_push_event has no right of its own, and is called
-- as the owner. For the owner and the service role — never a signed-in user.
CREATE FUNCTION public.dispatch_due_rest_pushes()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row     record;
  v_tried   uuid[] := '{}';
  v_handed  integer;
  v_expired integer;
BEGIN
  WITH late AS (
    SELECT sp.id
      FROM public.scheduled_pushes sp
     WHERE sp.status = 'pending'
       AND sp.fire_at <= now() - interval '60 seconds'
     ORDER BY sp.id
       FOR UPDATE SKIP LOCKED
  )
  UPDATE public.scheduled_pushes sp
     SET status = CASE WHEN sp.canceled_at IS NULL THEN 'expired' ELSE 'canceled' END
    FROM late
   WHERE sp.id = late.id;
  GET DIAGNOSTICS v_expired = ROW_COUNT;

  FOR v_row IN
    SELECT sp.id, sp.user_id, sp.payload, sp.endpoint, sp.fire_at
      FROM public.scheduled_pushes sp
     WHERE sp.status = 'pending'
       AND sp.canceled_at IS NULL
       AND sp.dispatched_at IS NULL
       AND sp.fire_at <= now() + interval '10 seconds'
       AND jsonb_typeof(sp.payload) = 'object'
     ORDER BY sp.fire_at, sp.id
       FOR UPDATE SKIP LOCKED
  LOOP
    v_tried := v_tried || v_row.id;
    BEGIN
      UPDATE public.scheduled_pushes sp
         SET dispatched_at = now()
       WHERE sp.id = v_row.id;
      PERFORM public.send_push_event(
        v_row.user_id,
        v_row.payload,
        jsonb_strip_nulls(jsonb_build_object(
          'schedule_id', v_row.id,
          'not_before',  v_row.fire_at,
          'endpoint',    v_row.endpoint,
          'ttl',         60,
          'urgency',     'high'
        ))
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'send-push hand-over (rest push) failed: %', SQLERRM;
    END;
  END LOOP;

  -- The rows whose mark was not undone.
  SELECT count(*) INTO v_handed
    FROM public.scheduled_pushes sp
   WHERE sp.id = ANY (v_tried)
     AND sp.dispatched_at IS NOT NULL;

  RETURN jsonb_build_object('handed_over', v_handed, 'expired', v_expired);
END;
$$;

REVOKE ALL ON FUNCTION public.dispatch_due_rest_pushes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_due_rest_pushes() TO service_role;

-- ------------------------------------------------------------
-- 7. The rows that have been waiting since their function died (B14).
-- ------------------------------------------------------------
-- Every row still 'pending' more than a minute after its time: the request
-- that was to send it ended long ago. 'canceled' where its athlete had asked
-- for that — the app writes canceled_at and leaves the status to the
-- function — 'expired' otherwise. The rule of the three functions above, run
-- once on what is there.
--
-- A rest that is running — a row whose time is still to come, or less than a
-- minute past — is not touched: the dispatch-rest-push that is deployed
-- reads its row again before it sends, and would take any other status for a
-- cancel.
--
-- No row is deleted. The rows do not come back as 'pending' with the
-- rollback, and must not.
UPDATE public.scheduled_pushes sp
   SET status = CASE WHEN sp.canceled_at IS NULL THEN 'expired' ELSE 'canceled' END
 WHERE sp.status = 'pending'
   AND sp.fire_at <= now() - interval '60 seconds';

-- ------------------------------------------------------------
-- 8. Read the result back. Anything else than what was meant raises, and the
--    whole file is undone: either the database is as described, or untouched.
-- ------------------------------------------------------------
DO $verify$
DECLARE
  v_list text;
BEGIN
  -- The four functions: owned by postgres, search_path pinned, a jsonb for
  -- an answer; two for a signed-in user and two not; claim_rest_push with
  -- the rights of its caller, the others as their owner.
  WITH wanted (signature, for_users, definer) AS (
    VALUES ('public.schedule_rest_push(integer, jsonb, text)', true,  true),
           ('public.cancel_rest_push(uuid)',                   true,  true),
           ('public.claim_rest_push(uuid)',                    false, false),
           ('public.dispatch_due_rest_pushes()',               false, true)
  ),
  found AS (
    SELECT w.signature, w.for_users, w.definer, p.oid, p.proowner, p.proconfig, p.prosecdef, p.prorettype, p.proacl
      FROM wanted w
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(w.signature)
  )
  SELECT string_agg(f.signature || ': ' || f.wrong, '; ' ORDER BY f.signature) INTO v_list
    FROM (
      SELECT signature,
             CASE WHEN oid IS NULL THEN 'missing' ELSE concat_ws(', ',
               CASE WHEN pg_get_userbyid(proowner) <> 'postgres' THEN 'not owned by postgres' END,
               CASE WHEN prorettype <> 'jsonb'::regtype THEN 'it does not return jsonb' END,
               CASE WHEN has_function_privilege('anon', oid, 'EXECUTE') THEN 'anon may execute it' END,
               CASE WHEN EXISTS (SELECT 1 FROM aclexplode(COALESCE(proacl, acldefault('f', proowner))) a
                                  WHERE a.grantee = 0)
                    THEN 'PUBLIC may execute it' END,
               CASE WHEN has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT for_users
                    THEN 'a signed-in user may execute it' END,
               CASE WHEN NOT has_function_privilege('authenticated', oid, 'EXECUTE') AND for_users
                    THEN 'a signed-in user may NOT execute it' END,
               CASE WHEN NOT has_function_privilege('service_role', oid, 'EXECUTE')
                    THEN 'the service role may NOT execute it' END,
               CASE WHEN definer AND NOT prosecdef THEN 'it does not run as its owner' END,
               CASE WHEN prosecdef AND NOT definer THEN 'it runs as its owner' END,
               CASE WHEN proconfig IS NULL OR NOT ('search_path=public, pg_temp' = ANY (proconfig))
                    THEN 'search_path is not public, pg_temp' END
             ) END AS wrong
        FROM found
    ) f
   WHERE f.wrong <> '';
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_16_rest_push_scheduling did not get the functions it meant: %', v_list
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;

  -- The table: the two columns, the six statuses, the two policies with
  -- their condition.
  SELECT string_agg(w.wrong, '; ' ORDER BY w.wrong) INTO v_list
    FROM (
      SELECT 'public.scheduled_pushes.' || c.col || ' is not there, or is not a ' || c.typ AS wrong
        FROM (VALUES ('endpoint', 'text'), ('dispatched_at', 'timestamp with time zone')) AS c (col, typ)
       WHERE NOT EXISTS (
         SELECT 1 FROM pg_attribute a
          WHERE a.attrelid = 'public.scheduled_pushes'::regclass
            AND a.attname = c.col AND NOT a.attisdropped
            AND format_type(a.atttypid, a.atttypmod) = c.typ
       )
      UNION ALL
      SELECT 'the rule on public.scheduled_pushes.status is not the one of six statuses'
       WHERE NOT EXISTS (
         SELECT 1 FROM pg_constraint k
          WHERE k.conrelid = 'public.scheduled_pushes'::regclass
            AND k.conname = 'scheduled_pushes_status_check' AND k.contype = 'c' AND k.convalidated
            AND pg_get_constraintdef(k.oid)
                = 'CHECK ((status = ANY (ARRAY[''pending''::text, ''sending''::text, ''sent''::text, ''canceled''::text, ''failed''::text, ''expired''::text])))'
       )
      UNION ALL
      SELECT 'the policy "' || w.name || '" does not ask whose device the endpoint is'
        FROM (VALUES ('Insert own scheduled pushes'), ('Cancel own scheduled pushes')) AS w (name)
       WHERE NOT EXISTS (
         SELECT 1 FROM pg_policy p
          WHERE p.polrelid = 'public.scheduled_pushes'::regclass
            AND p.polname = w.name
            AND position('push_subscriptions' IN pg_get_expr(p.polwithcheck, p.polrelid)) > 0
       )
      UNION ALL
      SELECT count(*) || ' row(s) of public.scheduled_pushes still pending more than a minute after their time'
        FROM public.scheduled_pushes sp
       WHERE sp.status = 'pending' AND sp.fire_at <= now() - interval '60 seconds'
      HAVING count(*) > 0
    ) w;
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_16_rest_push_scheduling did not get the table it meant: %', v_list
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;

  -- One function per name: the API calls by name.
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO v_list
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('schedule_rest_push', 'cancel_rest_push', 'claim_rest_push', 'dispatch_due_rest_pushes')
     AND NOT EXISTS (
       SELECT 1
         FROM unnest(ARRAY[
                'public.schedule_rest_push(integer, jsonb, text)',
                'public.cancel_rest_push(uuid)',
                'public.claim_rest_push(uuid)',
                'public.dispatch_due_rest_pushes()'
              ]) AS known(signature)
        WHERE to_regprocedure(known.signature) = p.oid
     );
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_16_rest_push_scheduling did not get the functions it meant: % stands next to them', v_list
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;
END
$verify$;

INSERT INTO app_private.app_migrations (name)
VALUES ('2026_10_13_16_rest_push_scheduling')
RETURNING name, applied_at;

-- Two columns and four functions joined public: PostgREST learns of them
-- when its schema cache is reloaded.
NOTIFY pgrst, 'reload schema';

COMMIT;
