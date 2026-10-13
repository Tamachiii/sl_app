-- Rollback of 2026_10_13_15_push_plumbing: gives the eleven functions that
-- send a push the text they had, drops send_push_event, and drops the rule
-- on push_subscriptions.endpoint.
--
-- !! IT REOPENS FINDING B3 AND THE DATABASE'S HALF OF P35. After this file
-- !! each of the eleven functions calls send-push itself again, with pg_net's
-- !! own time limit (2 or 5 seconds): a push is lost again whenever the
-- !! function takes longer to answer, and nothing says so. And an account
-- !! can again register any address as the endpoint of a device.
--
-- There is one reason to run it: after the migration, something that used to
-- work no longer does — a write that now fails where it sent a push before
-- (the coach's feedback, a confirmation, a message), or a browser that can
-- no longer switch notifications on although its push service is a real one.
-- Report what was being done, and re-apply the migration as soon as it is
-- understood (docs/runbook/migrations/15-push-plumbing.md).
--
-- What it does:
--   * drops the constraint push_subscriptions_endpoint_known_push_service;
--   * re-creates the six trigger functions and the five RPCs with the text
--     they had after migration 14 — each with its own copy of the block that
--     reads app_functions_url and app_service_role_key from the vault and
--     calls net.http_post;
--   * drops send_push_event.
-- No table and no row is touched: every device stays registered, whatever
-- its endpoint, and no notification is removed.
--
-- THE VAULT. The functions this file puts back read the bearer under the
-- name app_service_role_key, and under no other. If the secret was renamed
-- to app_internal_bearer after the migration, this file REFUSES to run until
-- it is renamed back (the statement is on the runbook page, "Rollback"):
-- without it every push would stop, and nothing would say so.
--
-- Refused (SLM04) while the ledger records a later migration: those build on
-- this one. Roll the later ones back first, last applied first.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
DECLARE
  v_later text;
BEGIN
  -- Two questions, in this order: the second cannot be asked without a ledger.
  IF to_regclass('app_private.app_migrations') IS NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_15_push_plumbing is not applied: there is no app_private.app_migrations'
      USING ERRCODE = 'SLM03', HINT = 'Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_13_15_push_plumbing') THEN
    RAISE EXCEPTION 'migration 2026_10_13_15_push_plumbing is not applied'
      USING ERRCODE = 'SLM03', HINT = 'Nothing was changed.';
  END IF;

  SELECT string_agg(name, ', ' ORDER BY name) INTO v_later
    FROM app_private.app_migrations
   WHERE substring(name from '^[0-9]{4}_[0-9]{2}_[0-9]{2}_([0-9]{2})_')::int > 15;
  IF v_later IS NOT NULL THEN
    RAISE EXCEPTION 'the ledger still records later migrations: %', v_later
      USING ERRCODE = 'SLM04', HINT = 'Roll those back first. Nothing was changed.';
  END IF;

  -- The bearer, under the one name the functions below read. A second IF,
  -- so that the vault is only looked at where there is one.
  IF to_regclass('vault.secrets') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'app_internal_bearer')
       AND NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'app_service_role_key') THEN
      RAISE EXCEPTION 'the vault holds the bearer of send-push as app_internal_bearer only: the functions this rollback puts back read app_service_role_key, and would send no push'
        USING HINT = 'Rename the secret back first: docs/runbook/migrations/15-push-plumbing.md, "Rollback". Nothing was changed.';
    END IF;
  END IF;
END
$guard$;

-- ------------------------------------------------------------
-- The rule on the endpoint.
-- ------------------------------------------------------------
ALTER TABLE public.push_subscriptions
  DROP CONSTRAINT IF EXISTS push_subscriptions_endpoint_known_push_service;

-- ------------------------------------------------------------
-- The eleven functions, with the text they had: each reads the two secrets
-- and calls net.http_post itself, without a time limit of its own.
-- ------------------------------------------------------------
-- (1 of 11) A session is confirmed: the coach is told.
CREATE OR REPLACE FUNCTION public.notify_coach_on_session_confirm()
RETURNS TRIGGER AS $$
DECLARE
  v_coach_id          uuid;
  v_student_profile   uuid;
  v_student_row_id    uuid;
  v_student_name      text;
  v_session_title     text;
  v_functions_url     text;
  v_service_key       text;
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

  -- Best-effort Web Push (same pattern as notify_coach_on_slot_deviation).
  BEGIN
    SELECT decrypted_secret INTO v_functions_url
      FROM vault.decrypted_secrets WHERE name = 'app_functions_url';
    SELECT decrypted_secret INTO v_service_key
      FROM vault.decrypted_secrets WHERE name = 'app_service_role_key';

    IF v_functions_url IS NOT NULL AND v_service_key IS NOT NULL
       AND v_functions_url <> '' AND v_service_key <> ''
    THEN
      PERFORM net.http_post(
        url := v_functions_url || '/send-push',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || v_service_key
        ),
        body := jsonb_build_object(
          'user_id', v_coach_id,
          'payload', jsonb_build_object(
            'title', 'Session completed',
            'body',  COALESCE(v_student_name, 'Your athlete')
                     || ' completed ' || v_session_title,
            'tag',   'session-confirm-' || NEW.session_id::text,
            'data',  jsonb_build_object(
              'url', '/sl_app/#/coach/student/' || COALESCE(v_student_row_id::text, '')
                     || '/session/' || NEW.session_id::text || '/review'
            )
          )
        )
      );
    END IF;
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
  v_functions_url   text;
  v_service_key     text;
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

  -- Best-effort Web Push (same pattern as notify_student_on_session_feedback).
  BEGIN
    SELECT decrypted_secret INTO v_functions_url
      FROM vault.decrypted_secrets WHERE name = 'app_functions_url';
    SELECT decrypted_secret INTO v_service_key
      FROM vault.decrypted_secrets WHERE name = 'app_service_role_key';

    IF v_functions_url IS NOT NULL AND v_service_key IS NOT NULL
       AND v_functions_url <> '' AND v_service_key <> ''
    THEN
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

      PERFORM net.http_post(
        url := v_functions_url || '/send-push',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || v_service_key
        ),
        body := jsonb_build_object(
          'user_id', v_coach_id,
          'payload', jsonb_build_object(
            'title', 'Off-plan session',
            'body',  v_body,
            'tag',   'deviation-' || NEW.id::text,
            'data',  jsonb_build_object(
              'url', '/sl_app/#/coach/student/' || COALESCE(v_student_row_id::text, '')
                     || '/session/' || v_session_id::text || '/review'
            )
          )
        )
      );
    END IF;
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
  v_functions_url  text;
  v_service_key    text;
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

    BEGIN
      SELECT decrypted_secret INTO v_functions_url FROM vault.decrypted_secrets WHERE name = 'app_functions_url';
      SELECT decrypted_secret INTO v_service_key   FROM vault.decrypted_secrets WHERE name = 'app_service_role_key';
      IF v_functions_url IS NOT NULL AND v_service_key IS NOT NULL
         AND v_functions_url <> '' AND v_service_key <> '' THEN
        PERFORM net.http_post(
          url := v_functions_url || '/send-push',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || v_service_key
          ),
          body := jsonb_build_object(
            'user_id', v_student_prof,
            'payload', jsonb_build_object(
              'title', 'Program updated',
              'body',  COALESCE(v_coach_name, 'Your coach') || ' adopted your swap: '
                       || COALESCE(v_orig_name, 'an exercise') || ' → '
                       || COALESCE(v_sub_name, 'another exercise'),
              'tag',   'swap-adopted-' || p_slot_id::text,
              'data',  jsonb_build_object('url', '/sl_app/#/student/session/' || v_session_id::text)
            )
          )
        );
      END IF;
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
  v_functions_url  text;
  v_service_key    text;
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

    BEGIN
      SELECT decrypted_secret INTO v_functions_url FROM vault.decrypted_secrets WHERE name = 'app_functions_url';
      SELECT decrypted_secret INTO v_service_key   FROM vault.decrypted_secrets WHERE name = 'app_service_role_key';
      IF v_functions_url IS NOT NULL AND v_service_key IS NOT NULL
         AND v_functions_url <> '' AND v_service_key <> '' THEN
        PERFORM net.http_post(
          url := v_functions_url || '/send-push',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || v_service_key
          ),
          body := jsonb_build_object(
            'user_id', v_student_prof,
            'payload', jsonb_build_object(
              'title', 'Program updated',
              'body',  COALESCE(v_coach_name, 'Your coach') || ' dropped '
                       || COALESCE(v_orig_name, 'an exercise') || ' from your upcoming sessions',
              'tag',   'skip-adopted-' || p_slot_id::text,
              'data',  jsonb_build_object('url', '/sl_app/#/student/session/' || v_session_id::text)
            )
          )
        );
      END IF;
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
  v_functions_url   text;
  v_service_key     text;
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

  BEGIN
    SELECT decrypted_secret INTO v_functions_url FROM vault.decrypted_secrets WHERE name = 'app_functions_url';
    SELECT decrypted_secret INTO v_service_key   FROM vault.decrypted_secrets WHERE name = 'app_service_role_key';
    IF v_functions_url IS NOT NULL AND v_service_key IS NOT NULL
       AND v_functions_url <> '' AND v_service_key <> '' THEN
      IF NEW.kind = 'swap' THEN
        v_body := COALESCE(v_student_name, 'Your athlete') || ' wants to keep '
                  || COALESCE(v_substitute_name, 'their swap') || ' instead of '
                  || COALESCE(v_original_name, 'the prescription');
      ELSE
        v_body := COALESCE(v_student_name, 'Your athlete') || ' wants to drop '
                  || COALESCE(v_original_name, 'an exercise') || ' going forward';
      END IF;
      PERFORM net.http_post(
        url := v_functions_url || '/send-push',
        headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_service_key),
        body := jsonb_build_object(
          'user_id', v_coach_id,
          'payload', jsonb_build_object(
            'title', 'Program change requested',
            'body',  v_body,
            'tag',   'promote-req-' || NEW.exercise_slot_id::text,
            'data',  jsonb_build_object(
              'url', '/sl_app/#/coach/student/' || COALESCE(v_student_row_id::text, '')
                     || '/session/' || v_session_id::text || '/review'
            )
          )
        )
      );
    END IF;
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
  v_functions_url text;
  v_service_key   text;
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

    BEGIN
      SELECT decrypted_secret INTO v_functions_url FROM vault.decrypted_secrets WHERE name = 'app_functions_url';
      SELECT decrypted_secret INTO v_service_key   FROM vault.decrypted_secrets WHERE name = 'app_service_role_key';
      IF v_functions_url IS NOT NULL AND v_service_key IS NOT NULL
         AND v_functions_url <> '' AND v_service_key <> '' THEN
        PERFORM net.http_post(
          url := v_functions_url || '/send-push',
          headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_service_key),
          body := jsonb_build_object(
            'user_id', v_student_prof,
            'payload', jsonb_build_object(
              'title', 'Coach kept your plan',
              'body',  COALESCE(v_coach_name, 'Your coach') || ' is keeping '
                       || COALESCE(v_original_name, 'the prescribed exercise') || ' in your program',
              'tag',   'promote-declined-' || p_slot_id::text,
              'data',  jsonb_build_object('url', '/sl_app/#/student/session/' || v_session_id::text)
            )
          )
        );
      END IF;
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
  v_functions_url text;
  v_service_key   text;
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
    BEGIN
      SELECT decrypted_secret INTO v_functions_url FROM vault.decrypted_secrets WHERE name = 'app_functions_url';
      SELECT decrypted_secret INTO v_service_key   FROM vault.decrypted_secrets WHERE name = 'app_service_role_key';
      IF v_functions_url IS NOT NULL AND v_service_key IS NOT NULL
         AND v_functions_url <> '' AND v_service_key <> '' THEN
        PERFORM net.http_post(
          url := v_functions_url || '/send-push',
          headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_service_key),
          body := jsonb_build_object('user_id', v_student_prof, 'payload', jsonb_build_object(
            'title', 'Program approved',
            'body',  'Your coach approved your program' || COALESCE(': ' || v_prog_name, ''),
            'tag',   'program-approved-' || p_program_id::text,
            'data',  jsonb_build_object('url', '/sl_app/#/student')))
        );
      END IF;
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
  v_functions_url text; v_service_key text;
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
  BEGIN
    SELECT decrypted_secret INTO v_functions_url FROM vault.decrypted_secrets WHERE name = 'app_functions_url';
    SELECT decrypted_secret INTO v_service_key   FROM vault.decrypted_secrets WHERE name = 'app_service_role_key';
    IF v_functions_url IS NOT NULL AND v_service_key IS NOT NULL AND v_functions_url <> '' AND v_service_key <> '' THEN
      PERFORM net.http_post(url := v_functions_url || '/send-push',
        headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_service_key),
        body := jsonb_build_object('user_id', v_coach_id, 'payload', jsonb_build_object(
          'title', 'Program submitted',
          'body', COALESCE(v_student_name,'Your athlete') || ' submitted a program for approval' || COALESCE(': ' || NEW.name, ''),
          'tag', 'program-submitted-' || NEW.id::text,
          'data', jsonb_build_object('url', '/sl_app/#/coach/students/' || COALESCE(v_student_row_id::text,'') || '/programming'))));
    END IF;
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
  v_functions_url text; v_service_key text;
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
    BEGIN
      SELECT decrypted_secret INTO v_functions_url FROM vault.decrypted_secrets WHERE name = 'app_functions_url';
      SELECT decrypted_secret INTO v_service_key   FROM vault.decrypted_secrets WHERE name = 'app_service_role_key';
      IF v_functions_url IS NOT NULL AND v_service_key IS NOT NULL AND v_functions_url <> '' AND v_service_key <> '' THEN
        PERFORM net.http_post(url := v_functions_url || '/send-push',
          headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_service_key),
          body := jsonb_build_object('user_id', v_student_prof, 'payload', jsonb_build_object(
            'title', 'Program sent back',
            'body', 'Your coach sent your program back for changes' || COALESCE(': ' || v_prog_name, ''),
            'tag', 'program-sent-back-' || p_program_id::text,
            'data', jsonb_build_object('url', '/sl_app/#/student/author'))));
      END IF;
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
  v_functions_url   text;
  v_service_key     text;
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

  -- Web Push fan-out (best-effort). Skips silently when the Vault
  -- secrets aren't configured so this migration can be applied before
  -- the project ref and service-role key are stashed, and so a project
  -- that's deliberately not using push isn't forced to.
  BEGIN
    SELECT decrypted_secret INTO v_functions_url
      FROM vault.decrypted_secrets
     WHERE name = 'app_functions_url';
    SELECT decrypted_secret INTO v_service_key
      FROM vault.decrypted_secrets
     WHERE name = 'app_service_role_key';

    IF v_functions_url IS NOT NULL
       AND v_service_key IS NOT NULL
       AND v_functions_url <> ''
       AND v_service_key <> ''
    THEN
      -- Trim to 200 chars so the encrypted push payload stays under the
      -- 4 KB Web Push limit. iOS only shows ~200 chars on the lock screen.
      v_body_preview := LEFT(BTRIM(NEW.body), 200);

      PERFORM net.http_post(
        url := v_functions_url || '/send-push',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || v_service_key
        ),
        body := jsonb_build_object(
          'user_id', NEW.recipient_id,
          'payload', jsonb_build_object(
            'title', 'Feedback from ' || COALESCE(v_coach_name, 'your coach'),
            'body',  COALESCE(NULLIF(v_body_preview, ''), 'Tap to read your coach''s feedback.'),
            'tag',   'feedback-' || NEW.id::text,
            'data',  jsonb_build_object(
              'url', '/sl_app/#/student/session/' || NEW.session_id::text
            )
          )
        )
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Push delivery must never break the in-app notification path. The
    -- coach's feedback INSERT succeeded; the bell will still light up.
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
  v_functions_url   text;
  v_service_key     text;
  v_body_preview    text;
BEGIN
  -- Feedback messages are handled by notify_student_on_session_feedback.
  IF NEW.session_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  BEGIN
    SELECT decrypted_secret INTO v_functions_url
      FROM vault.decrypted_secrets
     WHERE name = 'app_functions_url';
    SELECT decrypted_secret INTO v_service_key
      FROM vault.decrypted_secrets
     WHERE name = 'app_service_role_key';

    IF v_functions_url IS NOT NULL
       AND v_service_key IS NOT NULL
       AND v_functions_url <> ''
       AND v_service_key <> ''
    THEN
      -- One lookup covers both ends: the recipient's surface is the
      -- opposite of the sender's role, and the no-name fallback names the
      -- sender's role (blank full_name is the default after signup).
      SELECT p.full_name, p.role INTO v_sender_name, v_sender_role
        FROM public.profiles p
       WHERE p.id = NEW.sender_id;

      v_body_preview := LEFT(BTRIM(NEW.body), 200);

      PERFORM net.http_post(
        url := v_functions_url || '/send-push',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || v_service_key
        ),
        body := jsonb_build_object(
          'user_id', NEW.recipient_id,
          'payload', jsonb_build_object(
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
        )
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Push delivery must never break the message INSERT; the realtime
    -- badge still updates for open tabs.
    RAISE WARNING 'chat push fan-out failed: %', SQLERRM;
  END;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.notify_recipient_on_chat_message() FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- Nothing calls it any more.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.send_push_event(uuid, jsonb, jsonb);

DELETE FROM app_private.app_migrations WHERE name = '2026_10_13_15_push_plumbing';

-- A function left public: PostgREST has to forget it.
NOTIFY pgrst, 'reload schema';

COMMIT;
