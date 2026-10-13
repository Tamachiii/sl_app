-- ============================================================
-- 15 — Every push leaves the database through one function, with a time
--      limit of ten seconds; a device's endpoint is an address at a push
--      service
-- wave 2 · Checkpoint B · required · findings P35 (the database's half), B3;
--                                     the vault name L25 asks for
--
-- THE HOLES.
--   * ELEVEN COPIES OF ONE CALL (P35). Eleven functions tell somebody that
--     something happened: six triggers (a session confirmed, an exercise
--     swapped or skipped, "make this permanent", a draft submitted, feedback
--     on a session, a chat message) and five RPCs of the coach (adopt_swap,
--     adopt_skip, decline_promote_request, approve_program,
--     send_back_program). Each carried its own copy of the same block: read
--     two secrets from the vault, call the send-push Edge Function through
--     pg_net. None passed a time limit, so pg_net used its own — 2 or 5
--     seconds, depending on its version — which a cold start of the function
--     plus the round trip to the push service does not fit in. pg_net does
--     not try again, and nothing reads its answer: the push was lost, and
--     nothing said so.
--   * A SECRET UNDER THE WRONG NAME (L25). The bearer the database presents
--     to send-push is stored in the vault as app_service_role_key. It is not
--     the service-role key and must not be; eleven functions read that name,
--     so it could not be renamed.
--   * AN ENDPOINT IS WHATEVER THE ACCOUNT WRITES (B3). A push subscription
--     is a row of push_subscriptions that its account writes itself, and the
--     Edge Functions send an HTTPS POST to the `endpoint` it holds: any
--     signed-in account could make them call an address of its choosing.
--
-- WHAT THIS FILE DOES.
--   1. send_push_event(p_user, p_payload, p_options): the one function that
--      reads the vault and calls pg_net. Same address and same bearer as
--      before, a time limit of 10 seconds, and the same body — the recipient
--      and the payload — plus "ttl": 86400, which the send-push that is
--      deployed today ignores, and the keys of p_options. It reads the
--      bearer from app_internal_bearer and, while the vault has none of that
--      name, from app_service_role_key: the secret can now be renamed, when
--      its owner wants (the runbook page gives the statement). For its
--      owner and the service role only, and with the rights of its caller.
--   2. The eleven functions are re-created. Everything they do — who is
--      told, the bell row, the text and the link of the push, what an RPC
--      answers, who may call it — is what it was; the block that sends the
--      push is one call of send_push_event, still inside the function's own
--      EXCEPTION net: a push that cannot be queued is a warning in the log,
--      never the failure of the write that caused it.
--   3. push_subscriptions.endpoint must be an address at a known push
--      service: https, then fcm.googleapis.com,
--      updates.push.services.mozilla.com, a host under push.apple.com or one
--      under notify.windows.com, then a path. The rule is added NOT VALID —
--      the rows that are there are not judged, a row that is written from
--      now on is — and validated in the same transaction when no row breaks
--      it, which the audit says beforehand (line 9). No row is changed or
--      deleted, whatever it holds.
--
-- WHAT A CLIENT SEES. Nothing, with the send-push that is deployed and with
-- the one of wave 2: same request, same answer. A push that used to be lost
-- to pg_net's time limit now arrives. The app that is deployed, on a browser
-- whose push service is not one of the four: switching notifications on
-- fails as it does for any other refusal — that app shows nothing. The audit
-- lists the hosts of the devices production holds that are on none of them.
--
-- Backward compatible: yes, with every client and every send-push deployed.
-- Audit:    supabase/audits/2026_10_13_15_push_plumbing.audit.sql
-- Rollback: supabase/rollbacks/2026_10_13_15_push_plumbing.down.sql
-- Runbook:  docs/runbook/migrations/15-push-plumbing.md
-- ============================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
DECLARE
  v_list text;
BEGIN
  -- First of all, because no other role can even look at the ledger. What is
  -- created below must belong to the role that owns the tables: the eleven
  -- functions run as their owner, and the default privileges that keep a new
  -- function closed (migration 03) are those of `postgres`.
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'migration 2026_10_13_15_push_plumbing must be run as postgres, not as %', current_user
      USING HINT = 'Run it from the SQL editor or with `supabase db query --linked`. Nothing was changed.';
  END IF;

  -- Asked before the ledger is read: without it the answer would be
  -- "relation does not exist" instead of this one.
  IF to_regclass('app_private.app_migrations') IS NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_15_push_plumbing needs 2026_10_13_14_table_grants_lockdown, which is not applied'
      USING ERRCODE = 'SLM02', HINT = 'Apply migrations 01 to 14 first. Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_13_15_push_plumbing') THEN
    RAISE EXCEPTION 'migration 2026_10_13_15_push_plumbing is already applied'
      USING ERRCODE = 'SLM01', HINT = 'Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_13_14_table_grants_lockdown') THEN
    RAISE EXCEPTION 'migration 2026_10_13_15_push_plumbing needs 2026_10_13_14_table_grants_lockdown, which is not applied'
      USING ERRCODE = 'SLM02', HINT = 'Apply that file first. Nothing was changed.';
  END IF;

  -- send_push_event is CREATED, not replaced. One that is there already,
  -- with these arguments or with others, was made by hand.
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text)
    INTO v_list
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = 'send_push_event';
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_15_push_plumbing would not create: % is already there', v_list
      USING HINT = 'A function of this file exists, made by hand or by a file that is not in the ledger. Nothing was changed. Stop and report.';
  END IF;

  -- The eleven are REPLACED, and CREATE OR REPLACE replaces a function with
  -- the SAME argument types: one that is missing would be created next to
  -- nothing that calls it, and a copy with other arguments would stay as it
  -- is, sending its push the old way.
  WITH eleven (signature) AS (
    VALUES ('public.notify_coach_on_session_confirm()'),
           ('public.notify_coach_on_slot_deviation()'),
           ('public.adopt_swap(uuid, uuid, boolean)'),
           ('public.adopt_skip(uuid, boolean)'),
           ('public.notify_coach_on_promote_request()'),
           ('public.decline_promote_request(uuid)'),
           ('public.approve_program(uuid)'),
           ('public.notify_coach_on_program_submit()'),
           ('public.send_back_program(uuid)'),
           ('public.notify_student_on_session_feedback()'),
           ('public.notify_recipient_on_chat_message()')
  )
  SELECT string_agg(problem, '; ' ORDER BY problem) INTO v_list
    FROM (
      SELECT e.signature || ' is not there' AS problem
        FROM eleven e
       WHERE to_regprocedure(e.signature) IS NULL
      UNION ALL
      SELECT p.oid::regprocedure::text || ' stands next to the one this file replaces'
        FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace
         AND p.proname IN (SELECT split_part(split_part(e.signature, '(', 1), '.', 2) FROM eleven e)
         -- By oid, names written with their schema: the answer must not
         -- depend on the search_path of whoever runs the file.
         AND NOT EXISTS (SELECT 1 FROM eleven e WHERE to_regprocedure(e.signature) = p.oid)
    ) problems;
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_15_push_plumbing would not replace the eleven functions it means: %', v_list
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;

  -- The body of a function is not checked against the database when it is
  -- created, and send_push_event is called inside a net that turns every
  -- error into a warning: a pg_net without the time limit, or a vault that
  -- is not where the function reads it, would be eleven pushes that are
  -- never sent, and no error anywhere. Asked here instead.
  SELECT string_agg(problem, '; ' ORDER BY problem) INTO v_list
    FROM (
      SELECT 'net.http_post(url, body, params, headers, timeout_milliseconds) is not there: pg_net is not installed, or is a version without the time limit' AS problem
       WHERE NOT EXISTS (
         SELECT 1 FROM pg_proc p
          WHERE p.oid = to_regprocedure('net.http_post(text, jsonb, jsonb, jsonb, integer)')
            AND p.proargnames @> ARRAY['url', 'body', 'headers', 'timeout_milliseconds']
       )
      UNION ALL
      SELECT 'vault.decrypted_secrets (name, decrypted_secret) is not there: the vault is not installed'
       WHERE (SELECT count(*) FROM pg_attribute a
               WHERE a.attrelid = to_regclass('vault.decrypted_secrets')
                 AND a.attname IN ('name', 'decrypted_secret') AND NOT a.attisdropped) <> 2
      UNION ALL
      SELECT 'public.push_subscriptions.endpoint is not there'
       WHERE NOT EXISTS (
         SELECT 1 FROM pg_attribute a
          WHERE a.attrelid = to_regclass('public.push_subscriptions')
            AND a.attname = 'endpoint' AND NOT a.attisdropped
       )
    ) problems;
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_15_push_plumbing does not find what its functions are written with: %', v_list
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;

  -- The rule on the endpoint is ADDED. One of that name that is there
  -- already was made by hand, and may say something else.
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conrelid = 'public.push_subscriptions'::regclass
       AND c.conname = 'push_subscriptions_endpoint_known_push_service'
  ) THEN
    RAISE EXCEPTION 'migration 2026_10_13_15_push_plumbing would not add: the constraint push_subscriptions_endpoint_known_push_service is already there'
      USING HINT = 'Made by hand, or by a file that is not in the ledger. Nothing was changed. Stop and report.';
  END IF;
END
$guard$;

-- ------------------------------------------------------------
-- 1. The one function that reads the vault and calls pg_net.
-- ------------------------------------------------------------
--   p_user      the profile id of who is told
--   p_payload   what the service worker shows: { "title", "body", "tag",
--               "data": { "url" } } — sent as it is
--   p_options   what the caller asks of the delivery; left out, nothing
--   returns     the id pg_net gave the request, or NULL when nothing was
--               queued because the vault is not configured
--
--   where      vault secret app_functions_url, then '/send-push'
--   who        Authorization: Bearer <vault secret app_internal_bearer>, and
--              while the vault has none of that name (or an empty one), the
--              one stored as app_service_role_key. The value is the
--              INTERNAL_BEARER secret of the send-push function — a random
--              string made for this, never the service-role key.
--   how long   10 seconds, for the answer of the function
--   what       { "user_id": p_user, "payload": p_payload, "ttl": 86400 }
--              plus the keys of p_options, at the top level of the body.
--              "ttl" is how long, in seconds, the push service keeps the
--              message for a device that is offline (without it: four
--              weeks); a caller that wants another one passes it in
--              p_options. "user_id" and "payload" are the two arguments,
--              whatever p_options holds. The send-push deployed before
--              wave 2 reads those two keys and ignores the others.
--
--   raises     22023  no recipient, a payload or options that are not a JSON
--                     object — and whatever pg_net or the vault raise.
--              Nothing is queued then.
--   … and does NOT raise for a vault that is not configured: a project that
--   does not send pushes is not an error. Nor for anything that happens to
--   the request: pg_net sends it once the transaction has committed, and
--   what send-push answers is never read here.
--
-- EVERY CALLER KEEPS ITS OWN NET — the call stands in a block with
-- EXCEPTION WHEN OTHERS, as in the eleven functions below: the write that
-- caused the push is never undone for it.
--
-- NOT FOR A SIGNED-IN USER. Whoever may call it sends any text and any link
-- to any account: no EXECUTE for `authenticated` or `anon` (below; and it is
-- not in the allow-list of schema.sql). SECURITY INVOKER for the same
-- reason: it is given no right its caller does not have. The eleven are
-- SECURITY DEFINER and call it as their owner, who reads the vault and may
-- execute net.http_post; the service role does both too.
CREATE FUNCTION public.send_push_event(
  p_user    uuid,
  p_payload jsonb,
  p_options jsonb DEFAULT '{}'::jsonb
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_functions_url text;
  v_bearer        text;
  v_options       jsonb := COALESCE(p_options, '{}'::jsonb);
BEGIN
  IF p_user IS NULL OR p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'send_push_event needs a recipient and a payload that is a JSON object'
      USING ERRCODE = 'invalid_parameter_value',
            HINT = 'Nothing was queued.';
  END IF;
  IF jsonb_typeof(v_options) <> 'object' THEN
    RAISE EXCEPTION 'send_push_event takes its options as a JSON object'
      USING ERRCODE = 'invalid_parameter_value',
            HINT = 'Nothing was queued.';
  END IF;

  SELECT ds.decrypted_secret INTO v_functions_url
    FROM vault.decrypted_secrets ds
   WHERE ds.name = 'app_functions_url';

  -- The bearer under its own name; until the vault has it, under the name it
  -- was first stored with.
  SELECT ds.decrypted_secret INTO v_bearer
    FROM vault.decrypted_secrets ds
   WHERE ds.name = 'app_internal_bearer';
  IF COALESCE(v_bearer, '') = '' THEN
    SELECT ds.decrypted_secret INTO v_bearer
      FROM vault.decrypted_secrets ds
     WHERE ds.name = 'app_service_role_key';
  END IF;

  -- Not configured: no push and no error. The bell row is the caller's, and
  -- it is written either way.
  IF COALESCE(v_functions_url, '') = '' OR COALESCE(v_bearer, '') = '' THEN
    RETURN NULL;
  END IF;

  RETURN net.http_post(
    url     := rtrim(v_functions_url, '/') || '/send-push',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || v_bearer
    ),
    body    := jsonb_build_object('ttl', 86400)
               || (v_options - 'user_id'::text - 'payload'::text)
               || jsonb_build_object('user_id', p_user, 'payload', p_payload),
    timeout_milliseconds := 10000
  );
END;
$$;

-- Its owner and the service role, said here and not left to what a new
-- function starts with in the database this file runs in.
REVOKE ALL ON FUNCTION public.send_push_event(uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.send_push_event(uuid, jsonb, jsonb) TO service_role;

-- ------------------------------------------------------------
-- 2. The eleven functions, re-created whole.
-- ------------------------------------------------------------
-- CREATE OR REPLACE replaces the whole body — and the words after it: each
-- definition repeats SECURITY DEFINER and SET search_path, and is followed
-- by its privileges. The text of each is the text of supabase/schema.sql,
-- which is the text from before this file with ONE change: the block that
-- read two secrets and called net.http_post is a call of send_push_event,
-- and the two variables that held the secrets are gone. Where the text of
-- the push was put together only once the secrets had been found, it is now
-- put together before the call, inside the same net.
--
-- What is NOT changed, in any of them: who is told, the bell row, the title,
-- the text, the tag and the link of the push, the sentence of the warning,
-- what an RPC answers and whom it refuses (the line of migration 02).

-- (1 of 11) A session is confirmed: the coach is told.
CREATE OR REPLACE FUNCTION public.notify_coach_on_session_confirm()
RETURNS TRIGGER AS $$
DECLARE
  v_coach_id          uuid;
  v_student_profile   uuid;
  v_student_row_id    uuid;
  v_student_name      text;
  v_session_title     text;
BEGIN
  v_coach_id        := public.coach_profile_for_session(NEW.session_id);
  v_student_profile := public.student_profile_for_session(NEW.session_id);

  IF v_coach_id IS NULL OR v_student_profile IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT s.id INTO v_student_row_id
    FROM public.students s
   WHERE s.profile_id = v_student_profile;

  SELECT p.full_name INTO v_student_name
    FROM public.profiles p
   WHERE p.id = v_student_profile;

  SELECT COALESCE(NULLIF(BTRIM(s.title), ''), 'Session') INTO v_session_title
    FROM public.sessions s
   WHERE s.id = NEW.session_id;

  INSERT INTO public.notifications (recipient_id, kind, payload)
  VALUES (
    v_coach_id,
    'session_completed',
    jsonb_build_object(
      'session_id', NEW.session_id,
      'session_title', v_session_title,
      'student_profile_id', v_student_profile,
      'student_row_id', v_student_row_id,
      'student_name', v_student_name,
      'confirmation_id', NEW.id
    )
  );

  -- Best-effort Web Push, through send_push_event (2026_10_13_15). Whatever
  -- it raises stays a warning: a push never undoes the write that caused it.
  BEGIN
    PERFORM public.send_push_event(
      v_coach_id,
      jsonb_build_object(
        'title', 'Session completed',
        'body',  COALESCE(v_student_name, 'Your athlete')
                 || ' completed ' || v_session_title,
        'tag',   'session-confirm-' || NEW.session_id::text,
        'data',  jsonb_build_object(
          'url', '/sl_app/#/coach/student/' || COALESCE(v_student_row_id::text, '')
                 || '/session/' || NEW.session_id::text || '/review'
        )
      )
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'send-push fan-out (session confirm) failed: %', SQLERRM;
  END;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.notify_coach_on_session_confirm() FROM PUBLIC, anon, authenticated;

-- (2 of 11) An exercise is swapped or skipped: the coach is told.
CREATE OR REPLACE FUNCTION public.notify_coach_on_slot_deviation()
RETURNS TRIGGER AS $$
DECLARE
  v_session_id      uuid;
  v_coach_id        uuid;
  v_student_profile uuid;
  v_student_row_id  uuid;
  v_student_name    text;
  v_session_title   text;
  v_original_name   text;
  v_substitute_name text;
  v_body            text;
BEGIN
  SELECT es.session_id INTO v_session_id
    FROM public.exercise_slots es
   WHERE es.id = NEW.exercise_slot_id;

  v_coach_id        := public.coach_profile_for_session(v_session_id);
  v_student_profile := public.student_profile_for_session(v_session_id);

  IF v_coach_id IS NULL OR v_student_profile IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT s.id INTO v_student_row_id
    FROM public.students s WHERE s.profile_id = v_student_profile;
  SELECT p.full_name INTO v_student_name
    FROM public.profiles p WHERE p.id = v_student_profile;
  SELECT COALESCE(NULLIF(BTRIM(s.title), ''), 'Session') INTO v_session_title
    FROM public.sessions s WHERE s.id = v_session_id;
  SELECT el.name INTO v_original_name
    FROM public.exercise_slots es
    JOIN public.exercise_library el ON el.id = es.exercise_id
   WHERE es.id = NEW.exercise_slot_id;
  IF NEW.substitute_exercise_id IS NOT NULL THEN
    SELECT el.name INTO v_substitute_name
      FROM public.exercise_library el WHERE el.id = NEW.substitute_exercise_id;
  END IF;

  INSERT INTO public.notifications (recipient_id, kind, payload)
  VALUES (
    v_coach_id,
    'session_deviation',
    jsonb_build_object(
      'session_id',          v_session_id,
      'session_title',       v_session_title,
      'student_profile_id',  v_student_profile,
      'student_row_id',      v_student_row_id,
      'student_name',        v_student_name,
      'slot_id',             NEW.exercise_slot_id,
      'deviation_kind',      NEW.kind,
      'original_exercise',   v_original_name,
      'substitute_exercise', v_substitute_name
    )
  );

  -- Best-effort Web Push, through send_push_event (2026_10_13_15). Whatever
  -- it raises stays a warning: a push never undoes the write that caused it.
  BEGIN
    IF NEW.kind = 'swap' THEN
      v_body := COALESCE(v_student_name, 'Your athlete') || ' swapped '
                || COALESCE(v_original_name, 'an exercise') || ' → '
                || COALESCE(v_substitute_name, 'another exercise')
                || ' in ' || v_session_title;
    ELSE
      v_body := COALESCE(v_student_name, 'Your athlete') || ' skipped '
                || COALESCE(v_original_name, 'an exercise')
                || ' in ' || v_session_title;
    END IF;

    PERFORM public.send_push_event(
      v_coach_id,
      jsonb_build_object(
        'title', 'Off-plan session',
        'body',  v_body,
        'tag',   'deviation-' || NEW.id::text,
        'data',  jsonb_build_object(
          'url', '/sl_app/#/coach/student/' || COALESCE(v_student_row_id::text, '')
                 || '/session/' || v_session_id::text || '/review'
        )
      )
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'send-push fan-out (slot deviation) failed: %', SQLERRM;
  END;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.notify_coach_on_slot_deviation() FROM PUBLIC, anon, authenticated;

-- (3 of 11) The coach adopts a swap: the athlete is told.
CREATE OR REPLACE FUNCTION public.adopt_swap(
  p_slot_id uuid,
  p_substitute_id uuid,
  p_dry_run boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session_id     uuid;
  v_original_ex    uuid;
  v_coach_id       uuid;
  v_student_prof   uuid;
  v_program_id     uuid;
  v_week_number    int;
  v_sort_order     int;
  v_slot_ids       uuid[];
  v_applied        int := 0;
  v_orig_name      text;
  v_sub_name       text;
  v_session_title  text;
  v_coach_name     text;
BEGIN
  SELECT es.session_id, es.exercise_id
    INTO v_session_id, v_original_ex
    FROM public.exercise_slots es
   WHERE es.id = p_slot_id;
  IF v_session_id IS NULL THEN
    RAISE EXCEPTION 'slot not found';
  END IF;

  v_coach_id := public.coach_profile_for_session(v_session_id);
  -- auth.uid() IS NULL is tested first, and the comparison is NULL-safe: with
  -- a plain `<>` a caller without a session skipped this RAISE (review P1).
  IF auth.uid() IS NULL OR v_coach_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.exercise_library el
     WHERE el.id = p_substitute_id AND el.coach_id = v_coach_id
  ) THEN
    RAISE EXCEPTION 'substitute not in coach library';
  END IF;

  SELECT w.program_id, w.week_number, s.sort_order
    INTO v_program_id, v_week_number, v_sort_order
    FROM public.sessions s
    JOIN public.weeks w ON w.id = s.week_id
   WHERE s.id = v_session_id;

  -- Forward-only via a REAL ordinal bound (strictly later in program order),
  -- not the optional "confirmed" flag: never rewrite an already-trained slot.
  -- "Trained" is anything the athlete left on the slot: a logged set (the
  -- shared set_log_is_logged: done, failed, skipped, an RPE or an actual), a
  -- video, a comment, a deviation of its own (review P17).
  SELECT array_agg(es.id)
    INTO v_slot_ids
    FROM public.exercise_slots es
    JOIN public.sessions s ON s.id = es.session_id
    JOIN public.weeks w ON w.id = s.week_id
   WHERE w.program_id = v_program_id
     AND es.exercise_id = v_original_ex
     AND s.archived_at IS NULL
     AND s.id <> v_session_id
     AND (w.week_number > v_week_number
          OR (w.week_number = v_week_number AND s.sort_order > v_sort_order))
     AND NOT EXISTS (
       SELECT 1 FROM public.session_confirmations sc WHERE sc.session_id = s.id
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.set_logs sl
        WHERE sl.exercise_slot_id = es.id
          AND (public.set_log_is_logged(sl)
               OR EXISTS (SELECT 1 FROM public.set_log_videos v WHERE v.set_log_id = sl.id))
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.slot_comments c WHERE c.exercise_slot_id = es.id
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.slot_deviations d WHERE d.exercise_slot_id = es.id
     );

  v_applied := COALESCE(array_length(v_slot_ids, 1), 0);

  IF p_dry_run THEN
    RETURN jsonb_build_object('applied', v_applied, 'dry_run', true);
  END IF;

  IF v_slot_ids IS NOT NULL THEN
    UPDATE public.exercise_slots
       SET exercise_id = p_substitute_id
     WHERE id = ANY(v_slot_ids);
  END IF;

  v_student_prof := public.student_profile_for_session(v_session_id);
  IF v_student_prof IS NOT NULL AND v_applied > 0 THEN
    SELECT el.name INTO v_orig_name FROM public.exercise_library el WHERE el.id = v_original_ex;
    SELECT el.name INTO v_sub_name  FROM public.exercise_library el WHERE el.id = p_substitute_id;
    SELECT COALESCE(NULLIF(BTRIM(s.title), ''), 'Session') INTO v_session_title
      FROM public.sessions s WHERE s.id = v_session_id;
    SELECT p.full_name INTO v_coach_name FROM public.profiles p WHERE p.id = v_coach_id;

    INSERT INTO public.notifications (recipient_id, kind, payload)
    VALUES (
      v_student_prof,
      'swap_adopted',
      jsonb_build_object(
        'session_id', v_session_id,
        'session_title', v_session_title,
        'coach_name', v_coach_name,
        'original_exercise', v_orig_name,
        'substitute_exercise', v_sub_name,
        'applied_count', v_applied
      )
    );

    -- Best-effort Web Push, through send_push_event (2026_10_13_15). Whatever
    -- it raises stays a warning: a push never undoes the write that caused it.
    BEGIN
      PERFORM public.send_push_event(
        v_student_prof,
        jsonb_build_object(
          'title', 'Program updated',
          'body',  COALESCE(v_coach_name, 'Your coach') || ' adopted your swap: '
                   || COALESCE(v_orig_name, 'an exercise') || ' → '
                   || COALESCE(v_sub_name, 'another exercise'),
          'tag',   'swap-adopted-' || p_slot_id::text,
          'data',  jsonb_build_object('url', '/sl_app/#/student/session/' || v_session_id::text)
        )
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'send-push fan-out (swap adopted) failed: %', SQLERRM;
    END;
  END IF;

  RETURN jsonb_build_object('applied', v_applied, 'dry_run', false);
END;
$$;

REVOKE ALL ON FUNCTION public.adopt_swap(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.adopt_swap(uuid, uuid, boolean) TO authenticated;

-- (4 of 11) The coach adopts a skip: the athlete is told.
CREATE OR REPLACE FUNCTION public.adopt_skip(
  p_slot_id uuid,
  p_dry_run boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session_id     uuid;
  v_original_ex    uuid;
  v_coach_id       uuid;
  v_student_prof   uuid;
  v_program_id     uuid;
  v_week_number    int;
  v_sort_order     int;
  v_slot_ids       uuid[];
  v_applied        int := 0;
  v_orig_name      text;
  v_session_title  text;
  v_coach_name     text;
BEGIN
  SELECT es.session_id, es.exercise_id
    INTO v_session_id, v_original_ex
    FROM public.exercise_slots es
   WHERE es.id = p_slot_id;
  IF v_session_id IS NULL THEN
    RAISE EXCEPTION 'slot not found';
  END IF;

  v_coach_id := public.coach_profile_for_session(v_session_id);
  -- auth.uid() IS NULL is tested first, and the comparison is NULL-safe: with
  -- a plain `<>` a caller without a session skipped this RAISE (review P1).
  IF auth.uid() IS NULL OR v_coach_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  SELECT w.program_id, w.week_number, s.sort_order
    INTO v_program_id, v_week_number, v_sort_order
    FROM public.sessions s
    JOIN public.weeks w ON w.id = s.week_id
   WHERE s.id = v_session_id;

  -- The predicate of adopt_swap, word for word: what the dry run counts is
  -- what the DELETE below removes, and none of it carries a logged set, a
  -- video or a comment — so the delete guards never have to refuse it.
  SELECT array_agg(es.id)
    INTO v_slot_ids
    FROM public.exercise_slots es
    JOIN public.sessions s ON s.id = es.session_id
    JOIN public.weeks w ON w.id = s.week_id
   WHERE w.program_id = v_program_id
     AND es.exercise_id = v_original_ex
     AND s.archived_at IS NULL
     AND s.id <> v_session_id
     AND (w.week_number > v_week_number
          OR (w.week_number = v_week_number AND s.sort_order > v_sort_order))
     AND NOT EXISTS (
       SELECT 1 FROM public.session_confirmations sc WHERE sc.session_id = s.id
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.set_logs sl
        WHERE sl.exercise_slot_id = es.id
          AND (public.set_log_is_logged(sl)
               OR EXISTS (SELECT 1 FROM public.set_log_videos v WHERE v.set_log_id = sl.id))
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.slot_comments c WHERE c.exercise_slot_id = es.id
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.slot_deviations d WHERE d.exercise_slot_id = es.id
     );

  v_applied := COALESCE(array_length(v_slot_ids, 1), 0);

  IF p_dry_run THEN
    RETURN jsonb_build_object('applied', v_applied, 'dry_run', true);
  END IF;

  IF v_slot_ids IS NOT NULL THEN
    DELETE FROM public.exercise_slots WHERE id = ANY(v_slot_ids);
  END IF;

  v_student_prof := public.student_profile_for_session(v_session_id);
  IF v_student_prof IS NOT NULL AND v_applied > 0 THEN
    SELECT el.name INTO v_orig_name FROM public.exercise_library el WHERE el.id = v_original_ex;
    SELECT COALESCE(NULLIF(BTRIM(s.title), ''), 'Session') INTO v_session_title
      FROM public.sessions s WHERE s.id = v_session_id;
    SELECT p.full_name INTO v_coach_name FROM public.profiles p WHERE p.id = v_coach_id;

    INSERT INTO public.notifications (recipient_id, kind, payload)
    VALUES (
      v_student_prof,
      'skip_adopted',
      jsonb_build_object(
        'session_id', v_session_id,
        'session_title', v_session_title,
        'coach_name', v_coach_name,
        'original_exercise', v_orig_name,
        'applied_count', v_applied
      )
    );

    -- Best-effort Web Push, through send_push_event (2026_10_13_15). Whatever
    -- it raises stays a warning: a push never undoes the write that caused it.
    BEGIN
      PERFORM public.send_push_event(
        v_student_prof,
        jsonb_build_object(
          'title', 'Program updated',
          'body',  COALESCE(v_coach_name, 'Your coach') || ' dropped '
                   || COALESCE(v_orig_name, 'an exercise') || ' from your upcoming sessions',
          'tag',   'skip-adopted-' || p_slot_id::text,
          'data',  jsonb_build_object('url', '/sl_app/#/student/session/' || v_session_id::text)
        )
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'send-push fan-out (skip adopted) failed: %', SQLERRM;
    END;
  END IF;

  RETURN jsonb_build_object('applied', v_applied, 'dry_run', false);
END;
$$;

REVOKE ALL ON FUNCTION public.adopt_skip(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.adopt_skip(uuid, boolean) TO authenticated;

-- (5 of 11) "Make this permanent": the coach is told.
CREATE OR REPLACE FUNCTION public.notify_coach_on_promote_request()
RETURNS TRIGGER AS $$
DECLARE
  v_session_id      uuid;
  v_coach_id        uuid;
  v_student_prof    uuid;
  v_student_row_id  uuid;
  v_student_name    text;
  v_session_title   text;
  v_original_name   text;
  v_substitute_name text;
  v_body            text;
BEGIN
  IF NEW.promote_requested_at IS NULL
     OR NEW.promote_requested_at IS NOT DISTINCT FROM OLD.promote_requested_at THEN
    RETURN NEW;
  END IF;

  SELECT es.session_id INTO v_session_id
    FROM public.exercise_slots es WHERE es.id = NEW.exercise_slot_id;
  v_coach_id     := public.coach_profile_for_session(v_session_id);
  v_student_prof := public.student_profile_for_session(v_session_id);
  IF v_coach_id IS NULL OR v_student_prof IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT st.id INTO v_student_row_id FROM public.students st WHERE st.profile_id = v_student_prof;
  SELECT p.full_name INTO v_student_name FROM public.profiles p WHERE p.id = v_student_prof;
  SELECT COALESCE(NULLIF(BTRIM(s.title), ''), 'Session') INTO v_session_title
    FROM public.sessions s WHERE s.id = v_session_id;
  SELECT el.name INTO v_original_name
    FROM public.exercise_slots es JOIN public.exercise_library el ON el.id = es.exercise_id
   WHERE es.id = NEW.exercise_slot_id;
  IF NEW.substitute_exercise_id IS NOT NULL THEN
    SELECT el.name INTO v_substitute_name FROM public.exercise_library el WHERE el.id = NEW.substitute_exercise_id;
  END IF;

  INSERT INTO public.notifications (recipient_id, kind, payload)
  VALUES (
    v_coach_id,
    'promote_requested',
    jsonb_build_object(
      'session_id', v_session_id,
      'session_title', v_session_title,
      'student_profile_id', v_student_prof,
      'student_row_id', v_student_row_id,
      'student_name', v_student_name,
      'slot_id', NEW.exercise_slot_id,
      'deviation_kind', NEW.kind,
      'original_exercise', v_original_name,
      'substitute_exercise', v_substitute_name
    )
  );

  -- Best-effort Web Push, through send_push_event (2026_10_13_15). Whatever
  -- it raises stays a warning: a push never undoes the write that caused it.
  BEGIN
    IF NEW.kind = 'swap' THEN
      v_body := COALESCE(v_student_name, 'Your athlete') || ' wants to keep '
                || COALESCE(v_substitute_name, 'their swap') || ' instead of '
                || COALESCE(v_original_name, 'the prescription');
    ELSE
      v_body := COALESCE(v_student_name, 'Your athlete') || ' wants to drop '
                || COALESCE(v_original_name, 'an exercise') || ' going forward';
    END IF;
    PERFORM public.send_push_event(
      v_coach_id,
      jsonb_build_object(
        'title', 'Program change requested',
        'body',  v_body,
        'tag',   'promote-req-' || NEW.exercise_slot_id::text,
        'data',  jsonb_build_object(
          'url', '/sl_app/#/coach/student/' || COALESCE(v_student_row_id::text, '')
                 || '/session/' || v_session_id::text || '/review'
        )
      )
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'send-push fan-out (promote request) failed: %', SQLERRM;
  END;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.notify_coach_on_promote_request() FROM PUBLIC, anon, authenticated;

-- (6 of 11) The coach declines it: the athlete is told.
CREATE OR REPLACE FUNCTION public.decline_promote_request(p_slot_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session_id    uuid;
  v_coach_id      uuid;
  v_student_prof  uuid;
  v_original_name text;
  v_coach_name    text;
  v_session_title text;
  v_had_request   boolean;
BEGIN
  SELECT es.session_id INTO v_session_id
    FROM public.exercise_slots es WHERE es.id = p_slot_id;
  IF v_session_id IS NULL THEN
    RAISE EXCEPTION 'slot not found';
  END IF;

  v_coach_id := public.coach_profile_for_session(v_session_id);
  -- auth.uid() IS NULL is tested first, and the comparison is NULL-safe: with
  -- a plain `<>` a caller without a session skipped this RAISE (review P1).
  IF auth.uid() IS NULL OR v_coach_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  UPDATE public.slot_deviations
     SET promote_requested_at = NULL
   WHERE exercise_slot_id = p_slot_id
     AND promote_requested_at IS NOT NULL;
  GET DIAGNOSTICS v_had_request = ROW_COUNT;

  IF NOT v_had_request THEN
    RETURN jsonb_build_object('declined', false);
  END IF;

  v_student_prof := public.student_profile_for_session(v_session_id);
  IF v_student_prof IS NOT NULL THEN
    SELECT el.name INTO v_original_name
      FROM public.exercise_slots es JOIN public.exercise_library el ON el.id = es.exercise_id
     WHERE es.id = p_slot_id;
    SELECT p.full_name INTO v_coach_name FROM public.profiles p WHERE p.id = v_coach_id;
    SELECT COALESCE(NULLIF(BTRIM(s.title), ''), 'Session') INTO v_session_title
      FROM public.sessions s WHERE s.id = v_session_id;

    INSERT INTO public.notifications (recipient_id, kind, payload)
    VALUES (
      v_student_prof,
      'promote_declined',
      jsonb_build_object(
        'session_id', v_session_id,
        'session_title', v_session_title,
        'coach_name', v_coach_name,
        'original_exercise', v_original_name
      )
    );

    -- Best-effort Web Push, through send_push_event (2026_10_13_15). Whatever
    -- it raises stays a warning: a push never undoes the write that caused it.
    BEGIN
      PERFORM public.send_push_event(
        v_student_prof,
        jsonb_build_object(
          'title', 'Coach kept your plan',
          'body',  COALESCE(v_coach_name, 'Your coach') || ' is keeping '
                   || COALESCE(v_original_name, 'the prescribed exercise') || ' in your program',
          'tag',   'promote-declined-' || p_slot_id::text,
          'data',  jsonb_build_object('url', '/sl_app/#/student/session/' || v_session_id::text)
        )
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'send-push fan-out (promote declined) failed: %', SQLERRM;
    END;
  END IF;

  RETURN jsonb_build_object('declined', true);
END;
$$;

REVOKE ALL ON FUNCTION public.decline_promote_request(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.decline_promote_request(uuid) TO authenticated;

-- (7 of 11) The coach approves a draft: the athlete is told.
CREATE OR REPLACE FUNCTION public.approve_program(p_program_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_student_id   uuid;
  v_student_prof uuid;
  v_coach_id     uuid;
  v_prog_name    text;
  v_created      int := 0;
BEGIN
  SELECT p.student_id, p.name INTO v_student_id, v_prog_name
    FROM public.programs p WHERE p.id = p_program_id AND p.status = 'draft';
  IF v_student_id IS NULL THEN
    RETURN jsonb_build_object('approved', false);
  END IF;
  SELECT s.coach_id, s.profile_id INTO v_coach_id, v_student_prof
    FROM public.students s WHERE s.id = v_student_id;
  -- auth.uid() IS NULL is tested first, and the comparison is NULL-safe: with
  -- a plain `<>` a caller without a session skipped this RAISE (review P1).
  IF auth.uid() IS NULL OR v_coach_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  -- No session of the program enters its life as reviewed, archived, trained
  -- or dated (review P13): those are written after approval, by the coach and
  -- by the athlete's confirmation.
  UPDATE public.sessions s
     SET reviewed_at = NULL, archived_at = NULL, performed_at = NULL, scheduled_date = NULL
    FROM public.weeks w
   WHERE w.id = s.week_id
     AND w.program_id = p_program_id
     AND (s.reviewed_at IS NOT NULL OR s.archived_at IS NOT NULL
          OR s.performed_at IS NOT NULL OR s.scheduled_date IS NOT NULL);

  INSERT INTO public.set_logs
    (exercise_slot_id, set_number, done, target_reps, target_duration_seconds, target_weight_kg, target_rest_seconds)
  SELECT es.id, gs.n, false, es.reps, es.duration_seconds, es.weight_kg, es.rest_seconds
    FROM public.exercise_slots es
    JOIN public.sessions s ON s.id = es.session_id
    JOIN public.weeks w    ON w.id = s.week_id
    CROSS JOIN LATERAL generate_series(1, GREATEST(es.sets, 1)) AS gs(n)
   WHERE w.program_id = p_program_id
     AND NOT EXISTS (SELECT 1 FROM public.set_logs sl WHERE sl.exercise_slot_id = es.id AND sl.set_number = gs.n);
  GET DIAGNOSTICS v_created = ROW_COUNT;

  UPDATE public.programs SET status = 'approved', approved_at = now(), submitted_at = NULL
   WHERE id = p_program_id;

  IF v_student_prof IS NOT NULL THEN
    INSERT INTO public.notifications (recipient_id, kind, payload)
    VALUES (v_student_prof, 'program_approved',
      jsonb_build_object('program_id', p_program_id, 'program_name', v_prog_name));
    -- Best-effort Web Push, through send_push_event (2026_10_13_15). Whatever
    -- it raises stays a warning: a push never undoes the write that caused it.
    BEGIN
      PERFORM public.send_push_event(
        v_student_prof,
        jsonb_build_object(
          'title', 'Program approved',
          'body',  'Your coach approved your program' || COALESCE(': ' || v_prog_name, ''),
          'tag',   'program-approved-' || p_program_id::text,
          'data',  jsonb_build_object('url', '/sl_app/#/student')
        )
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'send-push fan-out (program approved) failed: %', SQLERRM;
    END;
  END IF;

  RETURN jsonb_build_object('approved', true, 'set_logs_created', v_created);
END;
$$;

REVOKE ALL ON FUNCTION public.approve_program(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.approve_program(uuid) TO authenticated;

-- (8 of 11) A draft is submitted: the coach is told.
CREATE OR REPLACE FUNCTION public.notify_coach_on_program_submit()
RETURNS TRIGGER AS $$
DECLARE
  v_coach_id uuid; v_student_prof uuid; v_student_row_id uuid; v_student_name text;
BEGIN
  -- Fire only on the NULL → set edge (blocks re-submit spam; re-fires after
  -- send_back_program resets submitted_at to NULL).
  IF NEW.status <> 'draft' OR NEW.submitted_at IS NULL
     OR OLD.submitted_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT s.coach_id, s.profile_id, s.id INTO v_coach_id, v_student_prof, v_student_row_id
    FROM public.students s WHERE s.id = NEW.student_id;
  IF v_coach_id IS NULL THEN RETURN NEW; END IF;
  SELECT p.full_name INTO v_student_name FROM public.profiles p WHERE p.id = v_student_prof;
  INSERT INTO public.notifications (recipient_id, kind, payload)
  VALUES (v_coach_id, 'program_submitted', jsonb_build_object(
    'program_id', NEW.id, 'program_name', NEW.name, 'student_profile_id', v_student_prof,
    'student_row_id', v_student_row_id, 'student_name', v_student_name));
  -- Best-effort Web Push, through send_push_event (2026_10_13_15). Whatever
  -- it raises stays a warning: a push never undoes the write that caused it.
  BEGIN
    PERFORM public.send_push_event(
      v_coach_id,
      jsonb_build_object(
        'title', 'Program submitted',
        'body', COALESCE(v_student_name,'Your athlete') || ' submitted a program for approval' || COALESCE(': ' || NEW.name, ''),
        'tag', 'program-submitted-' || NEW.id::text,
        'data', jsonb_build_object('url', '/sl_app/#/coach/students/' || COALESCE(v_student_row_id::text,'') || '/programming')
      )
    );
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'send-push fan-out (program submitted) failed: %', SQLERRM; END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.notify_coach_on_program_submit() FROM PUBLIC, anon, authenticated;

-- (9 of 11) The coach sends a draft back: the athlete is told.
CREATE OR REPLACE FUNCTION public.send_back_program(p_program_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_student_id uuid; v_student_prof uuid; v_coach_id uuid; v_prog_name text;
BEGIN
  SELECT p.student_id, p.name INTO v_student_id, v_prog_name
    FROM public.programs p WHERE p.id = p_program_id AND p.status = 'draft' AND p.submitted_at IS NOT NULL;
  IF v_student_id IS NULL THEN RETURN jsonb_build_object('sent_back', false); END IF;
  SELECT s.coach_id, s.profile_id INTO v_coach_id, v_student_prof FROM public.students s WHERE s.id = v_student_id;
  -- auth.uid() IS NULL is tested first, and the comparison is NULL-safe: with
  -- a plain `<>` a caller without a session skipped this RAISE (review P1).
  IF auth.uid() IS NULL OR v_coach_id IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'not authorized'; END IF;
  UPDATE public.programs SET submitted_at = NULL WHERE id = p_program_id;
  IF v_student_prof IS NOT NULL THEN
    INSERT INTO public.notifications (recipient_id, kind, payload)
    VALUES (v_student_prof, 'program_sent_back', jsonb_build_object('program_id', p_program_id, 'program_name', v_prog_name));
    -- Best-effort Web Push, through send_push_event (2026_10_13_15). Whatever
    -- it raises stays a warning: a push never undoes the write that caused it.
    BEGIN
      PERFORM public.send_push_event(
        v_student_prof,
        jsonb_build_object(
          'title', 'Program sent back',
          'body', 'Your coach sent your program back for changes' || COALESCE(': ' || v_prog_name, ''),
          'tag', 'program-sent-back-' || p_program_id::text,
          'data', jsonb_build_object('url', '/sl_app/#/student/author')
        )
      );
    EXCEPTION WHEN OTHERS THEN RAISE WARNING 'send-push fan-out (program sent back) failed: %', SQLERRM; END;
  END IF;
  RETURN jsonb_build_object('sent_back', true);
END;
$$;

REVOKE ALL ON FUNCTION public.send_back_program(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.send_back_program(uuid) TO authenticated;

-- (10 of 11) Feedback on a session: the athlete is told.
CREATE OR REPLACE FUNCTION public.notify_student_on_session_feedback()
RETURNS TRIGGER AS $$
DECLARE
  v_coach_name      text;
  v_session_title   text;
  v_body_preview    text;
BEGIN
  IF NEW.session_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT p.full_name INTO v_coach_name
    FROM public.profiles p
   WHERE p.id = NEW.sender_id;

  SELECT COALESCE(NULLIF(BTRIM(s.title), ''), 'Session') INTO v_session_title
    FROM public.sessions s
   WHERE s.id = NEW.session_id;

  -- Sending feedback also marks the session reviewed (idempotent).
  UPDATE public.sessions
     SET reviewed_at = NEW.created_at
   WHERE id = NEW.session_id
     AND reviewed_at IS NULL;

  -- In-app notification (existing behavior, unchanged).
  INSERT INTO public.notifications (recipient_id, kind, payload)
  VALUES (
    NEW.recipient_id,
    'session_feedback',
    jsonb_build_object(
      'session_id',       NEW.session_id,
      'session_title',    v_session_title,
      'coach_profile_id', NEW.sender_id,
      'coach_name',       v_coach_name,
      'message_id',       NEW.id
    )
  );

  -- Best-effort Web Push, through send_push_event (2026_10_13_15). Whatever
  -- it raises stays a warning: a push never undoes the write that caused it —
  -- the feedback is sent, and the bell row above is written.
  BEGIN
    -- Trim to 200 chars so the encrypted push payload stays under the
    -- 4 KB Web Push limit. iOS only shows ~200 chars on the lock screen.
    v_body_preview := LEFT(BTRIM(NEW.body), 200);

    PERFORM public.send_push_event(
      NEW.recipient_id,
      jsonb_build_object(
        'title', 'Feedback from ' || COALESCE(v_coach_name, 'your coach'),
        'body',  COALESCE(NULLIF(v_body_preview, ''), 'Tap to read your coach''s feedback.'),
        'tag',   'feedback-' || NEW.id::text,
        'data',  jsonb_build_object(
          'url', '/sl_app/#/student/session/' || NEW.session_id::text
        )
      )
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'send-push fan-out failed: %', SQLERRM;
  END;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.notify_student_on_session_feedback() FROM PUBLIC, anon, authenticated;

-- (11 of 11) A chat message: its recipient is told (no bell row).
CREATE OR REPLACE FUNCTION public.notify_recipient_on_chat_message()
RETURNS TRIGGER AS $$
DECLARE
  v_sender_name     text;
  v_sender_role     text;
  v_body_preview    text;
BEGIN
  -- Feedback messages are handled by notify_student_on_session_feedback.
  IF NEW.session_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Best-effort Web Push, through send_push_event (2026_10_13_15). Whatever
  -- it raises stays a warning: a push never undoes the write that caused it —
  -- the message is sent, and the badge of an open tab still updates.
  BEGIN
    -- One lookup covers both ends: the recipient's surface is the
    -- opposite of the sender's role, and the no-name fallback names the
    -- sender's role.
    SELECT p.full_name, p.role INTO v_sender_name, v_sender_role
      FROM public.profiles p
     WHERE p.id = NEW.sender_id;

    v_body_preview := LEFT(BTRIM(NEW.body), 200);

    PERFORM public.send_push_event(
      NEW.recipient_id,
      jsonb_build_object(
        'title', 'Message from ' || COALESCE(
                   NULLIF(BTRIM(v_sender_name), ''),
                   CASE WHEN v_sender_role = 'coach' THEN 'your coach' ELSE 'your student' END
                 ),
        'body',  COALESCE(NULLIF(v_body_preview, ''), 'Tap to read.'),
        'tag',   'chat-' || NEW.sender_id::text,
        'data',  jsonb_build_object(
          'url', '/sl_app/#/'
                 || CASE WHEN v_sender_role = 'coach' THEN 'student' ELSE 'coach' END
                 || '/messages'
        )
      )
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'chat push fan-out failed: %', SQLERRM;
  END;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.notify_recipient_on_chat_message() FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 3. An endpoint is an address at a known push service.
-- ------------------------------------------------------------
-- A push subscription is what the browser hands the app: an address at its
-- push service (the endpoint) and two keys. The account writes the row
-- itself, and send-push and dispatch-rest-push POST to whatever the column
-- holds — with the project's VAPID signature. So the column is held to what
-- a browser can hand over:
--
--     https://fcm.googleapis.com/…                  Chrome and the browsers built on it
--     https://updates.push.services.mozilla.com/…   Firefox
--     https://<anything>.push.apple.com/…           Safari, and the web apps of iOS
--     https://<anything>.notify.windows.com/…       Edge
--
-- The host is everything between `https://` and the first `/`: lower case,
-- no port, no user name before an @ — an address that only LOOKS like one of
-- the four (https://fcm.googleapis.com.example.org/, …@example.org/) is
-- refused. THE SAME LIST IS IN supabase/functions/_shared/pushHosts.js,
-- which the functions ask before they send. A push service that is added,
-- is added in both — here by a migration that drops this constraint and
-- adds it again.
--
-- NOT VALID: the rows that are there are not read by this statement, so a
-- row that breaks the rule does not stop the file. From here on every INSERT
-- is judged, and every UPDATE of a row — also one that leaves the endpoint
-- alone: a row that breaks the rule can still be deleted, and no longer be
-- refreshed. A refused write is 23514 and names the constraint.
ALTER TABLE public.push_subscriptions
  ADD CONSTRAINT push_subscriptions_endpoint_known_push_service CHECK (
    endpoint ~ '^https://(fcm[.]googleapis[.]com|updates[.]push[.]services[.]mozilla[.]com|[a-z0-9.-]+[.]push[.]apple[.]com|[a-z0-9.-]+[.]notify[.]windows[.]com)/'
  ) NOT VALID;

-- Validated here when no row is in the way — the table is locked since the
-- statement above, so what is counted is what is judged. Otherwise the rule
-- stays as it is, for new and changed rows, and the runbook page says how
-- the rows are looked at and how the rule is validated afterwards
-- (docs/runbook/migrations/15-push-plumbing.md, "Devices whose endpoint is
-- not at a known push service"). No row is deleted by this file.
DO $validate$
DECLARE
  v_in_the_way bigint;
BEGIN
  SELECT count(*) INTO v_in_the_way
    FROM public.push_subscriptions ps
   WHERE ps.endpoint !~ '^https://(fcm[.]googleapis[.]com|updates[.]push[.]services[.]mozilla[.]com|[a-z0-9.-]+[.]push[.]apple[.]com|[a-z0-9.-]+[.]notify[.]windows[.]com)/';
  IF v_in_the_way = 0 THEN
    ALTER TABLE public.push_subscriptions
      VALIDATE CONSTRAINT push_subscriptions_endpoint_known_push_service;
  ELSE
    RAISE NOTICE 'push_subscriptions_endpoint_known_push_service is NOT validated: % device(s) hold an endpoint that is not at a known push service', v_in_the_way;
  END IF;
END
$validate$;

-- ------------------------------------------------------------
-- 4. Read the result back. Anything else than what was meant raises, and the
--    whole file is undone: either the database is as described, or untouched.
-- ------------------------------------------------------------
DO $verify$
DECLARE
  v_list text;
BEGIN
  -- The twelve functions: owned by postgres, search_path pinned, closed to a
  -- request without a session. send_push_event runs as its caller and is
  -- open to nobody who is signed in; the eleven run as their owner, and a
  -- signed-in user executes the five RPCs — as before — and no trigger
  -- function. The service role executes all of them.
  WITH wanted (signature, for_users, definer) AS (
    VALUES ('public.send_push_event(uuid, jsonb, jsonb)',            false, false),
           ('public.notify_coach_on_session_confirm()',              false, true),
           ('public.notify_coach_on_slot_deviation()',               false, true),
           ('public.adopt_swap(uuid, uuid, boolean)',                true,  true),
           ('public.adopt_skip(uuid, boolean)',                      true,  true),
           ('public.notify_coach_on_promote_request()',              false, true),
           ('public.decline_promote_request(uuid)',                  true,  true),
           ('public.approve_program(uuid)',                          true,  true),
           ('public.notify_coach_on_program_submit()',               false, true),
           ('public.send_back_program(uuid)',                        true,  true),
           ('public.notify_student_on_session_feedback()',           false, true),
           ('public.notify_recipient_on_chat_message()',             false, true)
  ),
  found AS (
    SELECT w.signature, w.for_users, w.definer, p.oid, p.proowner, p.proconfig, p.prosecdef, p.proacl, p.prosrc
      FROM wanted w
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(w.signature)
  )
  SELECT string_agg(f.signature || ': ' || f.wrong, '; ' ORDER BY f.signature) INTO v_list
    FROM (
      SELECT signature,
             CASE WHEN oid IS NULL THEN 'missing' ELSE concat_ws(', ',
               CASE WHEN pg_get_userbyid(proowner) <> 'postgres' THEN 'not owned by postgres' END,
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
                    THEN 'search_path is not public, pg_temp' END,
               -- The eleven: no copy of the old block left, and the call.
               CASE WHEN definer AND prosrc ~ '(net[.]http_|vault[.])'
                    THEN 'it still reads the vault or calls pg_net itself' END,
               CASE WHEN definer AND position('public.send_push_event(' IN prosrc) = 0
                    THEN 'it does not call send_push_event' END
             ) END AS wrong
        FROM found
    ) f
   WHERE f.wrong <> '';
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_15_push_plumbing did not get the functions it meant: %', v_list
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;

  -- One function reads the vault and calls pg_net, in the whole schema.
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO v_list
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.prosrc ~ '(net[.]http_|vault[.])'
     AND p.oid IS DISTINCT FROM to_regprocedure('public.send_push_event(uuid, jsonb, jsonb)');
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_15_push_plumbing left a function that reads the vault or calls pg_net itself: %', v_list
      USING HINT = 'A twelfth function sends a push, and this file does not know it. Nothing was changed. Stop and report the full message.';
  END IF;

  -- The rule on the endpoint: there, under its name, and a check.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conrelid = 'public.push_subscriptions'::regclass
       AND c.conname = 'push_subscriptions_endpoint_known_push_service'
       AND c.contype = 'c'
  ) THEN
    RAISE EXCEPTION 'migration 2026_10_13_15_push_plumbing did not get the rule it meant on public.push_subscriptions.endpoint'
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;
END
$verify$;

INSERT INTO app_private.app_migrations (name)
VALUES ('2026_10_13_15_push_plumbing')
RETURNING name, applied_at;

-- A function joined public: PostgREST learns of a function when its schema
-- cache is reloaded. (It then answers "permission denied" for it instead of
-- "not found": nobody the API serves may execute it.)
NOTIFY pgrst, 'reload schema';

COMMIT;
