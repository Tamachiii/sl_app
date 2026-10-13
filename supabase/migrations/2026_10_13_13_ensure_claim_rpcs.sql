-- ============================================================
-- 13 — The missing sets of a session are added by the database, and a
--      device's push subscription follows the account that signs in
-- wave 1 · Checkpoint A3 · required · findings L8, P22, P15 (the database's
--                                      half), and what L6 needs later
--
-- THE HOLES. Two things an account does for itself are done by the app with
-- the rights row-level security gives it, and those rights do not fit.
--   * THE SETS OF A SESSION. A set is a row of set_logs, and a session whose
--     exercise has fewer rows than its number of sets is completed by the
--     athlete's app when the session is opened (src/hooks/useSetLogs.js,
--     useEnsureSetLogs): it reads which sets exist, and inserts the others
--     with the athlete's own rights — with the number of sets, the reps and
--     the load it has in its CACHE, which is kept for fourteen days. A
--     set the coach has removed since comes back (P22). And because the app
--     must be able to insert a prescribed set, an athlete may insert a set
--     with the targets of their choosing: the one write of an athlete to
--     set_logs that nothing holds (L6; pin_set_log_targets_for_student
--     holds the UPDATE). That cannot be closed while the app inserts.
--   * THE DEVICE. A push subscription is a row of push_subscriptions, unique
--     by its endpoint, written and read by its owner only. On a device two
--     accounts use — a coach who also signs in as a test athlete — the
--     browser hands the second account the subscription of the first: its
--     endpoint is taken, the upsert of the second account is refused by
--     row-level security, nothing the app shows says why, and the device
--     goes on receiving the notifications of the first account while the
--     second can never switch its own on (P15).
--
-- WHAT THIS FILE DOES. Pure expand: two functions, and nothing else — no
-- table, no column, no policy, no trigger, no row.
--   1. ensure_set_logs(p_session_id) adds the prescribed sets that are
--      missing in ONE session of the caller: it reads the exercises as they
--      are in the database now, and answers how many rows it added. For the
--      athlete of the session only, and only where an athlete may write: the
--      block being trained, a session neither archived nor reviewed.
--      Around its INSERT it sets app.trusted_set_log_insert = 'on' for the
--      transaction, and takes it back before it returns. Nothing reads that
--      setting yet. The contract migration that will turn an athlete's own
--      INSERT into an extra set without targets (L6, Checkpoint Z) reads it
--      to tell these rows from a forged one: this function runs inside the
--      athlete's request, with the athlete's user id, like the forged one.
--   2. claim_push_subscription(p_endpoint, p_p256dh, p_auth, p_user_agent)
--      registers the device for the caller. An endpoint nobody holds is
--      created; the caller's own is refreshed; one that ANOTHER account
--      holds moves to the caller only when the two keys sent are the ones
--      stored with it — which the browser that holds the subscription can
--      present, and nobody who merely learnt the address.
--
-- SECURITY DEFINER, both, and each asks who calls before it does anything:
-- neither is given to a request without a user id. They do what the policies
-- cannot say — insert a set with targets that are the coach's, take a row
-- over from another account — so they do not ride the caller's rights, and
-- they hold the rules themselves. Executable by a signed-in user, never
-- without a session.
--
-- WHAT A CLIENT SEES. Nothing: the app that is deployed today does not call
-- them, and goes on with its own INSERT and its own upsert, which work as
-- before. The next version of the app calls them — it needs this file in the
-- database first.
--
-- Backward compatible: yes, with every client ever deployed.
-- Audit:    supabase/audits/2026_10_13_13_ensure_claim_rpcs.audit.sql
-- Rollback: supabase/rollbacks/2026_10_13_13_ensure_claim_rpcs.down.sql
-- Runbook:  docs/runbook/migrations/13-ensure-claim-rpcs.md
-- ============================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
DECLARE
  v_there   text;
  v_missing text;
BEGIN
  -- First of all, because no other role can even look at the ledger. What is
  -- created below must belong to the role that owns the tables: a SECURITY
  -- DEFINER function runs as its owner, and the default privileges that keep
  -- a new function closed (migration 03) are those of `postgres`.
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'migration 2026_10_13_13_ensure_claim_rpcs must be run as postgres, not as %', current_user
      USING HINT = 'Run it from the SQL editor or with `supabase db query --linked`. Nothing was changed.';
  END IF;

  -- Asked before the ledger is read: without it the answer would be
  -- "relation does not exist" instead of this one.
  IF to_regclass('app_private.app_migrations') IS NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_13_ensure_claim_rpcs needs 2026_10_13_12_copy_rpcs, which is not applied'
      USING ERRCODE = 'SLM02', HINT = 'Apply migrations 01 to 12 first. Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_13_13_ensure_claim_rpcs') THEN
    RAISE EXCEPTION 'migration 2026_10_13_13_ensure_claim_rpcs is already applied'
      USING ERRCODE = 'SLM01', HINT = 'Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_13_12_copy_rpcs') THEN
    RAISE EXCEPTION 'migration 2026_10_13_13_ensure_claim_rpcs needs 2026_10_13_12_copy_rpcs, which is not applied'
      USING ERRCODE = 'SLM02', HINT = 'Apply that file first. Nothing was changed.';
  END IF;

  -- The two functions are CREATED, not replaced. One that is there already,
  -- under one of the names — with these arguments or with others — was made
  -- by hand: the API finds a function by its name and the names of its
  -- arguments, and two of a name are a call that may reach the wrong one.
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text)
    INTO v_there
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('ensure_set_logs', 'claim_push_subscription');
  IF v_there IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_13_ensure_claim_rpcs would not create: % is already there', v_there
      USING HINT = 'A function of this file exists, made by hand or by a file that is not in the ledger. Nothing was changed. Stop and report.';
  END IF;

  -- The body of a function is not checked against the database when it is
  -- created: a column, a helper or a unique key that is missing would be
  -- found by the first athlete who opens a session. Asked here instead.
  SELECT string_agg(w.tbl || '.' || w.col, ', ' ORDER BY w.tbl, w.col)
    INTO v_missing
    FROM (VALUES ('public.exercise_slots',     'id'),
                 ('public.exercise_slots',     'session_id'),
                 ('public.exercise_slots',     'sets'),
                 ('public.exercise_slots',     'reps'),
                 ('public.exercise_slots',     'duration_seconds'),
                 ('public.exercise_slots',     'weight_kg'),
                 ('public.exercise_slots',     'rest_seconds'),
                 ('public.set_logs',           'exercise_slot_id'),
                 ('public.set_logs',           'set_number'),
                 ('public.set_logs',           'done'),
                 ('public.set_logs',           'target_reps'),
                 ('public.set_logs',           'target_duration_seconds'),
                 ('public.set_logs',           'target_weight_kg'),
                 ('public.set_logs',           'target_rest_seconds'),
                 ('public.push_subscriptions', 'id'),
                 ('public.push_subscriptions', 'user_id'),
                 ('public.push_subscriptions', 'endpoint'),
                 ('public.push_subscriptions', 'p256dh'),
                 ('public.push_subscriptions', 'auth'),
                 ('public.push_subscriptions', 'user_agent'),
                 ('public.push_subscriptions', 'last_seen_at')
         ) AS w (tbl, col)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = to_regclass(w.tbl)
        AND a.attname = w.col AND NOT a.attisdropped
   );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_13_ensure_claim_rpcs does not find the columns its functions are written with: %', v_missing
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;

  -- The three questions an athlete's write asks (migration 08) are asked by
  -- ensure_set_logs through the helpers the policies use.
  SELECT string_agg(h.signature, ', ' ORDER BY h.signature)
    INTO v_missing
    FROM (VALUES ('public.student_profile_for_session(uuid)'),
                 ('public.program_active_for_session(uuid)'),
                 ('public.session_writable(uuid)')
         ) AS h (signature)
   WHERE to_regprocedure(h.signature) IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_13_ensure_claim_rpcs does not find the functions its functions call: %', v_missing
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;

  -- Both functions insert with ON CONFLICT on a unique key: a set is one row
  -- per exercise and number, a subscription one row per endpoint. Without
  -- the key the INSERT raises when it is run, not when it is written.
  SELECT string_agg(k.tbl || ' (' || array_to_string(k.cols, ', ') || ')', '; ' ORDER BY k.tbl)
    INTO v_missing
    FROM (VALUES ('public.set_logs',           ARRAY['exercise_slot_id', 'set_number']),
                 ('public.push_subscriptions', ARRAY['endpoint'])
         ) AS k (tbl, cols)
   WHERE NOT EXISTS (
     SELECT 1
       FROM pg_index i
      WHERE i.indrelid = to_regclass(k.tbl)
        AND i.indisunique AND i.indisvalid AND i.indimmediate
        AND i.indpred IS NULL AND i.indexprs IS NULL
        AND i.indnkeyatts = cardinality(k.cols)
        AND NOT EXISTS (
          SELECT 1
            FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS c (attnum, place)
            JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = c.attnum
           WHERE c.place <= i.indnkeyatts
             AND a.attname::text <> ALL (k.cols)
        )
   );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_13_ensure_claim_rpcs does not find the unique keys its functions are written with: %', v_missing
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;
END
$guard$;

-- ------------------------------------------------------------
-- 1. The prescribed sets of a session, completed for its athlete.
-- ------------------------------------------------------------
-- A set is a row of set_logs: the coach's editor writes one per set when an
-- exercise is added, and approve_program writes them for a draft. A session
-- can still be short of some — a block copied from a draft, a request of the
-- editor that was lost, a block from before the rows were written up front —
-- and the athlete's page shows the sets it finds. This adds the others.
--
--   p_session_id   one session of the caller
--   returns        how many rows were added; 0 when none was missing
--
--   adds      for every exercise of the session, every number from 1 to its
--             number of sets that has no row — whatever that row is: an
--             extra set of the athlete standing on a number is a row. A new
--             row is not done, and its targets are those of the exercise
--             (reps or seconds, load, rest), which is what the editor and
--             approve_program write. Nothing that exists is touched.
--   reads     the exercises in the database, at the moment of the call. The
--             app sends the id of the session and nothing else: a number of
--             sets it remembers is not asked for.
--
--   refuses   not authorized         (42501) the request carries no user id,
--                                    or the session is not the caller's own
--                                    — somebody else's session, the session
--                                    of an athlete the caller coaches, and
--                                    no such session are the same answer
--             program_not_active     the session is the caller's, in a
--                                    program that is not the block being
--                                    trained: a past block, a draft, a block
--                                    in the trash
--             session_not_writable   the coach has archived or reviewed it
--   … and has then written nothing.
--
-- The three refusals are the three questions every write of an athlete asks
-- since migration 08, asked through the same helpers as the policies of
-- set_logs: a change of one of those rules is a change of this function too,
-- with nothing to rewrite here. They are asked HERE because the function is
-- SECURITY DEFINER — it runs as the owner of the tables, whom row-level
-- security does not hold. It has to be: the rows it adds carry the coach's
-- targets, which an athlete's own INSERT will not be allowed to write.
--
-- THE SETTING. app.trusted_set_log_insert is 'on' while the INSERT below
-- runs, and 'off' again before the function returns — by hand: a setting
-- changed inside a function lasts until the end of the transaction, not of
-- the function. A call that fails takes it back with everything else it did.
-- It is how a trigger on set_logs tells these rows from an INSERT the
-- athlete sent themselves: auth.uid() is the athlete in both. No trigger
-- reads it yet. Nothing else may set it: a function of this schema that a
-- signed-in user can execute and that sets a setting named by its caller
-- would hand every athlete the same word.
--
-- The exercises are locked FOR SHARE first, in the order of their ids: the
-- number of sets is read under that lock, so a coach who changes it in the
-- same instant waits for the rows to be there, and the editor's own clean-up
-- then sees them. Two calls for one session do not wait for the lock — each
-- waits for the other's rows (ON CONFLICT), and the second adds nothing.
CREATE FUNCTION public.ensure_set_logs(p_session_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_created integer;
BEGIN
  -- auth.uid() IS NULL is tested first, and the comparison is NULL-safe: a
  -- session that does not exist has no athlete, and neither has a caller
  -- without a session.
  IF v_uid IS NULL OR public.student_profile_for_session(p_session_id) IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'not authorized'
      USING ERRCODE = 'insufficient_privilege',
            DETAIL = 'The session is not one of the caller''s own.',
            HINT = 'The sets of a session are completed for its athlete. Nothing was changed.';
  END IF;
  IF public.program_active_for_session(p_session_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'program_not_active'
      USING DETAIL = 'The session belongs to a program that is not the block being trained: a past block, a draft, or a block in the trash.',
            HINT = 'Nothing was changed.';
  END IF;
  IF NOT public.session_writable(p_session_id) THEN
    RAISE EXCEPTION 'session_not_writable'
      USING DETAIL = 'The coach has archived or reviewed this session.',
            HINT = 'Nothing was changed.';
  END IF;

  PERFORM 1
     FROM public.exercise_slots es
    WHERE es.session_id = p_session_id
    ORDER BY es.id
      FOR SHARE;

  PERFORM set_config('app.trusted_set_log_insert', 'on', true);

  INSERT INTO public.set_logs
    (exercise_slot_id, set_number, done, target_reps, target_duration_seconds, target_weight_kg, target_rest_seconds)
  SELECT es.id, gs.n, false, es.reps, es.duration_seconds, es.weight_kg, es.rest_seconds
    FROM public.exercise_slots es
   CROSS JOIN LATERAL generate_series(1, es.sets) AS gs (n)
   WHERE es.session_id = p_session_id
     AND NOT EXISTS (
       SELECT 1 FROM public.set_logs sl
        WHERE sl.exercise_slot_id = es.id AND sl.set_number = gs.n
     )
   ORDER BY es.id, gs.n
  ON CONFLICT (exercise_slot_id, set_number) DO NOTHING;
  GET DIAGNOSTICS v_created = ROW_COUNT;

  PERFORM set_config('app.trusted_set_log_insert', 'off', true);

  RETURN v_created;
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_set_logs(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_set_logs(uuid) TO authenticated;

-- ------------------------------------------------------------
-- 2. A device registered for notifications belongs to the account that is
--    signed in on it.
-- ------------------------------------------------------------
-- A push subscription is what the browser hands the app: an address at the
-- push service (the endpoint) and two keys (p256dh, auth). The browser keeps
-- it across sign-outs, so the next account on the same device is handed the
-- same one. push_subscriptions holds one row per endpoint, and its policies
-- let an account write its own rows only: through them the second account
-- cannot take the row over, and the first one goes on receiving on that
-- device. This function is how the row changes hands.
--
--   p_endpoint, p_p256dh, p_auth   the subscription, as the browser gives it
--   p_user_agent                   what the device calls itself; left out or
--                                  NULL, the one that is stored stays
--   returns   { "subscription_id", "outcome" }
--             outcome   'created'    nobody held this endpoint: a new row
--                       'refreshed'  the caller held it: the keys and the
--                                    user agent are the ones sent, and
--                                    last_seen_at is now
--                       'rehomed'    another account held it, with these
--                                    keys: the row is the caller's now, and
--                                    the other account no longer receives
--                                    on this device
--
--   refuses   not authorized            (42501) the request carries no user
--                                       id
--             subscription_incomplete   the endpoint or one of the two keys
--                                       is missing or empty
--             endpoint_keys_mismatch    another account holds the endpoint,
--                                       and the keys sent are not the ones
--                                       stored with it
--   … and has then written nothing.
--
-- WHY THE KEYS. The row of another account is taken over on the word of the
-- caller, so the caller proves they hold the subscription: `auth` is a
-- secret the browser shares with this database and with nobody else, and it
-- is readable by the owner of the row only. Somebody who has learnt an
-- endpoint and no more cannot move it to their account — which would send
-- their notifications to that device and stop its owner's. The caller's own
-- row needs no proof: its policies let them write it as they like already.
--
-- The row is locked before it is judged: two accounts that claim one
-- endpoint in the same instant are served one after the other, and the
-- second is judged against what the first left. An endpoint that is
-- registered between the look and the INSERT is found by the next turn of
-- the loop, as a row that is there — the loop of the PostgreSQL manual for
-- "update, else insert". ON CONFLICT DO UPDATE alone could not answer what
-- happened: it does not say whose the row was.
--
-- SECURITY DEFINER: the UPDATE that moves a row to the caller is one no
-- policy allows. Every signed-in account may call it, as every account may
-- register a device today.
CREATE FUNCTION public.claim_push_subscription(
  p_endpoint   text,
  p_p256dh     text,
  p_auth       text,
  p_user_agent text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_id      uuid;
  v_owner   uuid;
  v_p256dh  text;
  v_auth    text;
  v_outcome text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authorized'
      USING ERRCODE = 'insufficient_privilege',
            DETAIL = 'The request carries no user id.',
            HINT = 'A device is registered by the account that is signed in on it. Nothing was changed.';
  END IF;
  IF btrim(COALESCE(p_endpoint, '')) = ''
     OR btrim(COALESCE(p_p256dh, '')) = ''
     OR btrim(COALESCE(p_auth, '')) = '' THEN
    RAISE EXCEPTION 'subscription_incomplete'
      USING DETAIL = 'A push subscription is an endpoint and its two keys, p256dh and auth: one of the three is missing or empty.',
            HINT = 'Nothing was changed.';
  END IF;

  LOOP
    SELECT ps.id, ps.user_id, ps.p256dh, ps.auth
      INTO v_id, v_owner, v_p256dh, v_auth
      FROM public.push_subscriptions ps
     WHERE ps.endpoint = p_endpoint
       FOR UPDATE;

    IF FOUND THEN
      IF v_owner = v_uid THEN
        v_outcome := 'refreshed';
      ELSIF v_p256dh = p_p256dh AND v_auth = p_auth THEN
        v_outcome := 'rehomed';
      ELSE
        RAISE EXCEPTION 'endpoint_keys_mismatch'
          USING DETAIL = 'Another account holds this endpoint, and the keys sent are not the ones stored with it.',
                HINT = 'A device takes a subscription over by presenting the keys it was registered with. Nothing was changed.';
      END IF;

      UPDATE public.push_subscriptions ps
         SET user_id      = v_uid,
             p256dh       = p_p256dh,
             auth         = p_auth,
             user_agent   = COALESCE(p_user_agent, ps.user_agent),
             last_seen_at = now()
       WHERE ps.id = v_id;

      RETURN jsonb_build_object('subscription_id', v_id, 'outcome', v_outcome);
    END IF;

    INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, last_seen_at)
    VALUES (v_uid, p_endpoint, p_p256dh, p_auth, p_user_agent, now())
    ON CONFLICT (endpoint) DO NOTHING
    RETURNING id INTO v_id;

    IF v_id IS NOT NULL THEN
      RETURN jsonb_build_object('subscription_id', v_id, 'outcome', 'created');
    END IF;
    -- Registered by another request in the same instant, and committed by
    -- now: the next turn finds it, and judges it as a row that is there.
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_push_subscription(text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_push_subscription(text, text, text, text) TO authenticated;

-- ------------------------------------------------------------
-- 3. Read the result back. Anything else than what was meant raises, and the
--    whole file is undone: either the database is as described, or untouched.
-- ------------------------------------------------------------
DO $verify$
DECLARE
  v_list text;
BEGIN
  -- The two functions: owned by postgres, search_path pinned, running as
  -- their owner, open to a signed-in user and closed to a request without a
  -- session.
  WITH wanted (signature, answers) AS (
    VALUES ('public.ensure_set_logs(uuid)',                           'integer'),
           ('public.claim_push_subscription(text, text, text, text)', 'jsonb')
  ),
  found AS (
    SELECT w.signature, w.answers, p.oid, p.proowner, p.proconfig, p.prosecdef, p.prorettype, p.proacl
      FROM wanted w
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(w.signature)
  )
  SELECT string_agg(f.signature || ': ' || f.wrong, '; ' ORDER BY f.signature) INTO v_list
    FROM (
      SELECT signature,
             CASE WHEN oid IS NULL THEN 'missing' ELSE concat_ws(', ',
               CASE WHEN pg_get_userbyid(proowner) <> 'postgres' THEN 'not owned by postgres' END,
               CASE WHEN prorettype <> to_regtype(answers) THEN 'it does not return ' || answers END,
               CASE WHEN has_function_privilege('anon', oid, 'EXECUTE') THEN 'anon may execute it' END,
               CASE WHEN EXISTS (SELECT 1 FROM aclexplode(COALESCE(proacl, acldefault('f', proowner))) a
                                  WHERE a.grantee = 0)
                    THEN 'PUBLIC may execute it' END,
               CASE WHEN NOT has_function_privilege('authenticated', oid, 'EXECUTE')
                    THEN 'a signed-in user may NOT execute it' END,
               CASE WHEN NOT prosecdef THEN 'it does not run as its owner' END,
               CASE WHEN proconfig IS NULL OR NOT ('search_path=public, pg_temp' = ANY (proconfig))
                    THEN 'search_path is not public, pg_temp' END
             ) END AS wrong
        FROM found
    ) f
   WHERE f.wrong <> '';
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_13_ensure_claim_rpcs did not get the functions it meant: %', v_list
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;

  -- One function per name: the API calls by name.
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO v_list
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('ensure_set_logs', 'claim_push_subscription')
     AND NOT EXISTS (
       SELECT 1
         FROM unnest(ARRAY[
                'public.ensure_set_logs(uuid)',
                'public.claim_push_subscription(text, text, text, text)'
              ]) AS known(signature)
        WHERE to_regprocedure(known.signature) = p.oid
     );
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_13_ensure_claim_rpcs did not get the functions it meant: % stands next to them', v_list
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;
END
$verify$;

INSERT INTO app_private.app_migrations (name)
VALUES ('2026_10_13_13_ensure_claim_rpcs')
RETURNING name, applied_at;

-- Two functions joined public: PostgREST learns of a function when its
-- schema cache is reloaded.
NOTIFY pgrst, 'reload schema';

COMMIT;
