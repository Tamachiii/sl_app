-- Rollback of 2026_10_11_04_logged_history_guards: removes the guards below the
-- session, and gives five functions back the text they had before.
--
-- !! IT REOPENS FINDINGS P3 AND P17. After this file, the coach's session
-- !! editor can again delete a set the athlete logged, delete an exercise
-- !! with its logged sets, videos and comment, and rewrite the reps and load
-- !! of a set that is done; adopt_swap and adopt_skip again treat a failed
-- !! or rated set, a video and a comment as "not trained".
--
-- There is one reason to run it: after the migration, a coach is refused
-- ("This has logged training — archive it instead of deleting.") on
-- something nobody trained — a set that is not ticked, failed, skipped, rated
-- or filmed. Report the session, and re-apply the migration as soon as it is
-- understood (docs/runbook/migrations/04-logged-history-guards.md).
--
-- It is NOT the way to delete training history on purpose: the page has a
-- section for that, which leaves the guards in place.
--
-- What it does:
--   * drops the four triggers of the migration (delete on exercise_slots and
--     on set_logs, the set count, the targets) and their four functions;
--   * gives block_program_ / block_week_ / block_session_delete_with_logged_sets,
--     adopt_swap and adopt_skip the text they had after migration 03. The
--     three triggers on programs, weeks and sessions stay: they were there
--     before;
--   * drops set_log_is_logged(set_logs) and history_delete_allowed().
-- No table and no row is touched. Rows the guards protected while they were
-- in place are still there; nothing protects them afterwards.
--
-- Refused (SLM04) while the ledger records a later migration: those build on
-- these functions. Roll the later ones back first, last applied first.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
DECLARE
  v_later text;
BEGIN
  -- Two questions, in this order: the second cannot be asked without a ledger.
  IF to_regclass('app_private.app_migrations') IS NULL THEN
    RAISE EXCEPTION 'migration 2026_10_11_04_logged_history_guards is not applied: there is no app_private.app_migrations'
      USING ERRCODE = 'SLM03', HINT = 'Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_11_04_logged_history_guards') THEN
    RAISE EXCEPTION 'migration 2026_10_11_04_logged_history_guards is not applied'
      USING ERRCODE = 'SLM03', HINT = 'Nothing was changed.';
  END IF;

  SELECT string_agg(name, ', ' ORDER BY name) INTO v_later
    FROM app_private.app_migrations
   WHERE substring(name from '^[0-9]{4}_[0-9]{2}_[0-9]{2}_([0-9]{2})_')::int > 4;
  IF v_later IS NOT NULL THEN
    RAISE EXCEPTION 'the ledger still records later migrations: %', v_later
      USING ERRCODE = 'SLM04', HINT = 'Roll those back first. Nothing was changed.';
  END IF;
END
$guard$;

-- ------------------------------------------------------------
-- The four triggers of the migration, then their functions.
-- ------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_pin_logged_set_log_targets ON public.set_logs;
DROP TRIGGER IF EXISTS block_set_log_delete_when_logged ON public.set_logs;
DROP TRIGGER IF EXISTS block_slot_sets_below_logged_set ON public.exercise_slots;
DROP TRIGGER IF EXISTS block_slot_delete_with_logged_sets ON public.exercise_slots;

DROP FUNCTION IF EXISTS public.pin_logged_set_log_targets();
DROP FUNCTION IF EXISTS public.block_set_log_delete_when_logged();
DROP FUNCTION IF EXISTS public.block_slot_sets_below_logged_set();
DROP FUNCTION IF EXISTS public.block_slot_delete_with_logged_sets();

-- ------------------------------------------------------------
-- The five functions the migration re-created, as they were: each spells
-- "logged" out for itself again, and none knows a way through.
-- CREATE OR REPLACE keeps their grants; the search_path is repeated because
-- it would be dropped otherwise.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.block_program_delete_with_logged_sets()
RETURNS trigger AS $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count
    FROM public.set_logs sl
    JOIN public.exercise_slots es ON es.id = sl.exercise_slot_id
    JOIN public.sessions s        ON s.id = es.session_id
    JOIN public.weeks w           ON w.id = s.week_id
   WHERE w.program_id = OLD.id
     AND (
       sl.done OR sl.failed OR sl.skipped
       OR sl.rpe IS NOT NULL
       OR sl.actual_reps IS NOT NULL
       OR sl.actual_weight_kg IS NOT NULL
     );
  IF v_count > 0 THEN
    RAISE EXCEPTION
      'program % still has % logged set(s) — move it to the trash instead of deleting',
      OLD.id, v_count;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.block_week_delete_with_logged_sets()
RETURNS trigger AS $$
DECLARE v_count int;
BEGIN
  SELECT count(*) INTO v_count
    FROM public.set_logs sl
    JOIN public.exercise_slots es ON es.id = sl.exercise_slot_id
    JOIN public.sessions s        ON s.id = es.session_id
   WHERE s.week_id = OLD.id
     AND (sl.done OR sl.failed OR sl.skipped
          OR sl.rpe IS NOT NULL OR sl.actual_reps IS NOT NULL
          OR sl.actual_weight_kg IS NOT NULL);
  IF v_count > 0 THEN
    RAISE EXCEPTION 'week % still has % logged set(s) — archive it instead of deleting', OLD.id, v_count;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.block_session_delete_with_logged_sets()
RETURNS trigger AS $$
DECLARE v_count int;
BEGIN
  SELECT count(*) INTO v_count
    FROM public.set_logs sl
    JOIN public.exercise_slots es ON es.id = sl.exercise_slot_id
   WHERE es.session_id = OLD.id
     AND (sl.done OR sl.failed OR sl.skipped
          OR sl.rpe IS NOT NULL OR sl.actual_reps IS NOT NULL
          OR sl.actual_weight_kg IS NOT NULL);
  IF v_count > 0 THEN
    RAISE EXCEPTION 'session % still has % logged set(s) — archive it instead of deleting', OLD.id, v_count;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- adopt_swap, as migration 02 left it.
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
          AND (sl.done = true OR sl.skipped = true
               OR sl.actual_reps IS NOT NULL OR sl.actual_weight_kg IS NOT NULL)
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

-- adopt_skip, as migration 02 left it.
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
          AND (sl.done = true OR sl.skipped = true
               OR sl.actual_reps IS NOT NULL OR sl.actual_weight_kg IS NOT NULL)
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

-- ------------------------------------------------------------
-- Nothing reads the two helpers any more.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.history_delete_allowed();
DROP FUNCTION IF EXISTS public.set_log_is_logged(public.set_logs);

DELETE FROM app_private.app_migrations WHERE name = '2026_10_11_04_logged_history_guards';

-- Two functions left public: PostgREST has to forget them.
NOTIFY pgrst, 'reload schema';

COMMIT;
