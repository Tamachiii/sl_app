-- ============================================================
-- 04 — Logged training cannot be deleted or rewritten below the session
-- wave 1 · Checkpoint A2 · required · findings P3, P17
--
-- THE HOLE (P3). "Logged training can never be hard-deleted" was enforced on
-- three tables: a BEFORE DELETE trigger refuses to delete a program, a week or
-- a session that still has logged sets. Nothing stood below. The coach's
-- session editor opens every session, trained ones included, and
--   * the × on a set deletes its set_logs row,
--   * typing a lower number in "Sets" deletes the rows above it,
--   * "Remove exercise" deletes the exercise_slots row, and the foreign keys
--     take its sets, their videos, the athlete's comment and deviation along,
--   * editing reps, load or rest writes the new numbers onto EVERY set of the
--     exercise, the ones already done included — and a set done as prescribed
--     reads "what the athlete lifted" from those numbers.
-- No warning, no way back.
--
-- AND ITS COUSIN (P17). adopt_swap and adopt_skip rewrite or delete the
-- UPCOMING slots of an exercise and leave alone the ones the athlete already
-- trained. Their idea of "trained" was shorter than the triggers': a set that
-- was failed, or only rated, did not count — nor did a video or a comment. A
-- skip adopted while the athlete was in the next session deleted the attempt.
--
-- WHAT THIS FILE DOES.
--   1. ONE definition of a logged set, public.set_log_is_logged(set_logs):
--      done, failed, skipped, an RPE or an actual. The three existing guards,
--      the new ones and the two adopt functions all read it.
--   2. Two more delete guards, so the rule holds at every level and on every
--      path, cascades included:
--        set_logs        a set that is logged, or carries a video. One
--                        exception: an extra set, deleted by the athlete who
--                        added it.
--        exercise_slots  a slot that has such a set.
--      The three guards above them count a set with a video as well.
--   3. A guard on exercise_slots.sets: the count cannot go below a logged
--      prescribed set. The app that is deployed today writes the new count
--      BEFORE it deletes the rows, so this is what stops it with nothing
--      changed.
--   4. A pin, not a refusal, on the targets of a logged set: when a signed-in
--      user rewrites target_* the logged rows keep theirs, and the write goes
--      on for the others. (An athlete's write was already pinned, on every
--      row.) A refusal would abort the whole edit of a half-trained exercise.
--   5. adopt_swap / adopt_skip leave alone a slot with a logged set, a video
--      or a comment — as they already did for one with a deviation.
--   6. One way through, for the owner of the database: inside a transaction,
--        SET LOCAL app.allow_history_delete = 'on';
--      turns the six refusals off. It is read only when the statement comes
--      with NO user id: the SQL editor, a function called with the
--      service-role key. For a signed-in user it does nothing.
--      (docs/runbook/migrations/04-logged-history-guards.md — "Deleting
--      training history on purpose". It replaces "drop the trigger, delete,
--      re-create it".)
--
-- WHAT A CLIENT SEES. An athlete: nothing. A coach, with the app that is
-- deployed today:
--   * × on a logged set, "Sets" lowered below one, "Remove exercise" on an
--     exercise that has one → the toast "This has logged training — archive
--     it instead of deleting." and nothing changed. All six messages contain
--     'logged set', which that app already maps to this toast.
--   * reps / load / rest edited on an exercise the athlete has started → no
--     error; the sets already logged keep their numbers, the others take the
--     new ones, and the editor shows the exercise set by set from then on.
--   * "Adopt into program" / "Remove from upcoming" may count fewer sessions.
-- Scaffolding — anything nobody trained — is deleted and edited as before.
--
-- No row of the app is read or written by this file: the audit says what is
-- there.
--
-- Backward compatible: yes, with every client ever deployed.
-- Audit:    supabase/audits/2026_10_11_04_logged_history_guards.audit.sql
-- Rollback: supabase/rollbacks/2026_10_11_04_logged_history_guards.down.sql (reopens P3 / P17)
-- Runbook:  docs/runbook/migrations/04-logged-history-guards.md
-- ============================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
DECLARE
  v_strangers text;
BEGIN
  -- First of all, because no other role can even look at the ledger. What is
  -- created below must belong to the role that owns the tables: a SECURITY
  -- DEFINER function runs as its owner, and the default privileges that keep
  -- a new function closed (migration 03) are those of `postgres`.
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'migration 2026_10_11_04_logged_history_guards must be run as postgres, not as %', current_user
      USING HINT = 'Run it from the SQL editor or with `supabase db query --linked`. Nothing was changed.';
  END IF;

  -- Asked before the ledger is read: without it the answer would be
  -- "relation does not exist" instead of this one.
  IF to_regclass('app_private.app_migrations') IS NULL THEN
    RAISE EXCEPTION 'migration 2026_10_11_04_logged_history_guards needs 2026_10_11_03_function_grants_lockdown, which is not applied'
      USING ERRCODE = 'SLM02', HINT = 'Apply migrations 01 to 03 first. Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_11_04_logged_history_guards') THEN
    RAISE EXCEPTION 'migration 2026_10_11_04_logged_history_guards is already applied'
      USING ERRCODE = 'SLM01', HINT = 'Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_11_03_function_grants_lockdown') THEN
    RAISE EXCEPTION 'migration 2026_10_11_04_logged_history_guards needs 2026_10_11_03_function_grants_lockdown, which is not applied'
      USING ERRCODE = 'SLM02', HINT = 'Apply that file first. Nothing was changed.';
  END IF;

  -- CREATE OR REPLACE replaces a function with the SAME argument types. A
  -- copy of one of these with other arguments would keep its old body — an
  -- adopt_skip that still deletes a failed attempt — and nothing would say so.
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text)
    INTO v_strangers
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('set_log_is_logged', 'history_delete_allowed',
                       'block_program_delete_with_logged_sets', 'block_week_delete_with_logged_sets',
                       'block_session_delete_with_logged_sets', 'block_slot_delete_with_logged_sets',
                       'block_set_log_delete_when_logged', 'block_slot_sets_below_logged_set',
                       'pin_logged_set_log_targets', 'adopt_swap', 'adopt_skip')
     -- By oid, names written with their schema: the answer must not depend on
     -- the search_path of whoever runs the file.
     AND NOT EXISTS (
       SELECT 1
         FROM unnest(ARRAY[
                'public.set_log_is_logged(public.set_logs)',
                'public.history_delete_allowed()',
                'public.block_program_delete_with_logged_sets()',
                'public.block_week_delete_with_logged_sets()',
                'public.block_session_delete_with_logged_sets()',
                'public.block_slot_delete_with_logged_sets()',
                'public.block_set_log_delete_when_logged()',
                'public.block_slot_sets_below_logged_set()',
                'public.pin_logged_set_log_targets()',
                'public.adopt_swap(uuid, uuid, boolean)',
                'public.adopt_skip(uuid, boolean)'
              ]) AS known(signature)
        WHERE to_regprocedure(known.signature) = p.oid
     );
  IF v_strangers IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_11_04_logged_history_guards would not replace: %', v_strangers
      USING HINT = 'A function of this file exists with other arguments. Nothing was changed. Stop and report.';
  END IF;
END
$guard$;

-- ------------------------------------------------------------
-- 1. What "logged" means — in one place.
-- ------------------------------------------------------------
-- A set the athlete recorded something on: ticked done, marked failed or
-- skipped, rated, or logged with an actual. It is the predicate the three
-- block_* triggers each spelled out, and the one adopt_swap / adopt_skip
-- spelled shorter (no `failed`, no `rpe`).
--
-- It takes the ROW, so a caller writes set_log_is_logged(sl) and cannot leave
-- a column out. Not for the API: only SECURITY DEFINER functions of this file
-- call it, as their owner.
CREATE OR REPLACE FUNCTION public.set_log_is_logged(sl public.set_logs)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT sl.done OR sl.failed OR sl.skipped
      OR sl.rpe IS NOT NULL
      OR sl.actual_reps IS NOT NULL
      OR sl.actual_weight_kg IS NOT NULL
$$;

REVOKE ALL ON FUNCTION public.set_log_is_logged(public.set_logs) FROM PUBLIC, anon, authenticated;

-- The one way through the guards below. True only when BOTH hold:
--   * the transaction said  SET LOCAL app.allow_history_delete = 'on'
--   * the statement comes with no user id — the SQL editor, a migration, a
--     function called with the service-role key. A signed-in user's request
--     always carries one, so for the app the setting does nothing, whoever
--     managed to set it.
CREATE OR REPLACE FUNCTION public.history_delete_allowed()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT auth.uid() IS NULL
     AND coalesce(current_setting('app.allow_history_delete', true), '') = 'on'
$$;

REVOKE ALL ON FUNCTION public.history_delete_allowed() FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 2. The three guards that existed: same messages, the shared predicate, a
--    set with a video counted, and the way through.
-- ------------------------------------------------------------
-- Their triggers are written again too (CREATE OR REPLACE TRIGGER: the same
-- definition, so nothing moves where they are in place). One that had been
-- dropped by hand to erase something — the recipe until today — and never
-- put back comes back here.
CREATE OR REPLACE FUNCTION public.block_program_delete_with_logged_sets()
RETURNS trigger AS $$
DECLARE
  v_count int;
BEGIN
  IF public.history_delete_allowed() THEN
    RETURN OLD;
  END IF;
  SELECT count(*) INTO v_count
    FROM public.set_logs sl
    JOIN public.exercise_slots es ON es.id = sl.exercise_slot_id
    JOIN public.sessions s        ON s.id = es.session_id
    JOIN public.weeks w           ON w.id = s.week_id
   WHERE w.program_id = OLD.id
     AND (public.set_log_is_logged(sl)
          OR EXISTS (SELECT 1 FROM public.set_log_videos v WHERE v.set_log_id = sl.id));
  IF v_count > 0 THEN
    RAISE EXCEPTION
      'program % still has % logged set(s) — move it to the trash instead of deleting',
      OLD.id, v_count;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.block_program_delete_with_logged_sets() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER block_program_delete_with_logged_sets
  BEFORE DELETE ON public.programs
  FOR EACH ROW
  EXECUTE FUNCTION public.block_program_delete_with_logged_sets();

CREATE OR REPLACE FUNCTION public.block_week_delete_with_logged_sets()
RETURNS trigger AS $$
DECLARE
  v_count int;
BEGIN
  IF public.history_delete_allowed() THEN
    RETURN OLD;
  END IF;
  SELECT count(*) INTO v_count
    FROM public.set_logs sl
    JOIN public.exercise_slots es ON es.id = sl.exercise_slot_id
    JOIN public.sessions s        ON s.id = es.session_id
   WHERE s.week_id = OLD.id
     AND (public.set_log_is_logged(sl)
          OR EXISTS (SELECT 1 FROM public.set_log_videos v WHERE v.set_log_id = sl.id));
  IF v_count > 0 THEN
    RAISE EXCEPTION 'week % still has % logged set(s) — archive it instead of deleting', OLD.id, v_count;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.block_week_delete_with_logged_sets() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER block_week_delete_with_logged_sets
  BEFORE DELETE ON public.weeks
  FOR EACH ROW
  EXECUTE FUNCTION public.block_week_delete_with_logged_sets();

CREATE OR REPLACE FUNCTION public.block_session_delete_with_logged_sets()
RETURNS trigger AS $$
DECLARE
  v_count int;
BEGIN
  IF public.history_delete_allowed() THEN
    RETURN OLD;
  END IF;
  SELECT count(*) INTO v_count
    FROM public.set_logs sl
    JOIN public.exercise_slots es ON es.id = sl.exercise_slot_id
   WHERE es.session_id = OLD.id
     AND (public.set_log_is_logged(sl)
          OR EXISTS (SELECT 1 FROM public.set_log_videos v WHERE v.set_log_id = sl.id));
  IF v_count > 0 THEN
    RAISE EXCEPTION 'session % still has % logged set(s) — archive it instead of deleting', OLD.id, v_count;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.block_session_delete_with_logged_sets() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER block_session_delete_with_logged_sets
  BEFORE DELETE ON public.sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.block_session_delete_with_logged_sets();

-- ------------------------------------------------------------
-- 3. The two guards that were missing: the slot, and the set itself.
-- ------------------------------------------------------------
-- "Remove exercise". A comment or a deviation alone does not hold a slot: the
-- coach removes it on purpose, and those go with it.
CREATE OR REPLACE FUNCTION public.block_slot_delete_with_logged_sets()
RETURNS trigger AS $$
DECLARE
  v_count int;
BEGIN
  IF public.history_delete_allowed() THEN
    RETURN OLD;
  END IF;
  SELECT count(*) INTO v_count
    FROM public.set_logs sl
   WHERE sl.exercise_slot_id = OLD.id
     AND (public.set_log_is_logged(sl)
          OR EXISTS (SELECT 1 FROM public.set_log_videos v WHERE v.set_log_id = sl.id));
  IF v_count > 0 THEN
    RAISE EXCEPTION
      'exercise slot % still has % logged set(s) — archive the session instead of deleting the exercise',
      OLD.id, v_count;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.block_slot_delete_with_logged_sets() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER block_slot_delete_with_logged_sets
  BEFORE DELETE ON public.exercise_slots
  FOR EACH ROW
  EXECUTE FUNCTION public.block_slot_delete_with_logged_sets();

-- The set: the × of the editor, the rows a lower "Sets" drops, a DELETE sent
-- to the API, and every cascade that reaches this table — a row trigger fires
-- on those too, so this one is the net under the four above.
--
-- The exception is the athlete's own extra set: they added it, they may take
-- it back, done or not. During a cascade the slot is already gone and
-- student_profile_for_slot() answers NULL: the exception cannot hide a
-- cascade.
CREATE OR REPLACE FUNCTION public.block_set_log_delete_when_logged()
RETURNS trigger AS $$
BEGIN
  IF NOT (public.set_log_is_logged(OLD)
          OR EXISTS (SELECT 1 FROM public.set_log_videos v WHERE v.set_log_id = OLD.id)) THEN
    RETURN OLD;
  END IF;
  IF OLD.is_student_added
     AND public.student_profile_for_slot(OLD.exercise_slot_id) = auth.uid() THEN
    RETURN OLD;
  END IF;
  IF public.history_delete_allowed() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'set % of exercise slot % is a logged set — it cannot be deleted',
    OLD.set_number, OLD.exercise_slot_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.block_set_log_delete_when_logged() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER block_set_log_delete_when_logged
  BEFORE DELETE ON public.set_logs
  FOR EACH ROW
  EXECUTE FUNCTION public.block_set_log_delete_when_logged();

-- ------------------------------------------------------------
-- 4. "Sets" cannot go below a logged set.
-- ------------------------------------------------------------
-- The app deployed today lowers a set count in two writes: exercise_slots.sets
-- first, then the DELETE of the prescribed rows numbered above it. The guard
-- of section 3 would stop the second and leave the first: a slot that says 3
-- sets and holds 5. Refusing the FIRST write leaves nothing changed.
-- Same rows as that DELETE: prescribed (an athlete's extra set is not part of
-- the count), numbered above the new count, logged or with a video.
CREATE OR REPLACE FUNCTION public.block_slot_sets_below_logged_set()
RETURNS trigger AS $$
DECLARE
  v_count int;
BEGIN
  IF public.history_delete_allowed() THEN
    RETURN NEW;
  END IF;
  SELECT count(*) INTO v_count
    FROM public.set_logs sl
   WHERE sl.exercise_slot_id = NEW.id
     AND NOT sl.is_student_added
     AND sl.set_number > NEW.sets
     AND (public.set_log_is_logged(sl)
          OR EXISTS (SELECT 1 FROM public.set_log_videos v WHERE v.set_log_id = sl.id));
  IF v_count > 0 THEN
    RAISE EXCEPTION
      'exercise slot % has % logged set(s) above set % — the set count cannot go below them',
      NEW.id, v_count, NEW.sets;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.block_slot_sets_below_logged_set() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER block_slot_sets_below_logged_set
  BEFORE UPDATE OF sets ON public.exercise_slots
  FOR EACH ROW
  WHEN (NEW.sets < OLD.sets)
  EXECUTE FUNCTION public.block_slot_sets_below_logged_set();

-- ------------------------------------------------------------
-- 5. The targets of a logged set stay what they were.
-- ------------------------------------------------------------
-- A set done as prescribed has no actual: its reps and load ARE its targets.
-- Rewriting them rewrites what the athlete lifted, in every stat and record.
--
-- Silent, on purpose: the editor writes a change of reps, load or rest to
-- every set of the exercise in one statement. Raising here would refuse the
-- change for the sets still to come as well. So the logged rows keep their
-- targets and the statement goes on.
--
-- For a signed-in user only. The athlete is already pinned on every row by
-- pin_set_log_targets_for_student; this is the coach. A statement with no
-- user id — the SQL editor, the service role — is a deliberate correction.
CREATE OR REPLACE FUNCTION public.pin_logged_set_log_targets()
RETURNS trigger AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND public.set_log_is_logged(OLD) THEN
    NEW.target_reps             := OLD.target_reps;
    NEW.target_duration_seconds := OLD.target_duration_seconds;
    NEW.target_weight_kg        := OLD.target_weight_kg;
    NEW.target_rest_seconds     := OLD.target_rest_seconds;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.pin_logged_set_log_targets() FROM PUBLIC, anon, authenticated;

-- WHEN: an athlete ticking a set — the write this table sees most — does not
-- touch a target, and does not enter the function.
CREATE OR REPLACE TRIGGER trg_pin_logged_set_log_targets
  BEFORE UPDATE ON public.set_logs
  FOR EACH ROW
  WHEN (NEW.target_reps IS DISTINCT FROM OLD.target_reps
        OR NEW.target_duration_seconds IS DISTINCT FROM OLD.target_duration_seconds
        OR NEW.target_weight_kg IS DISTINCT FROM OLD.target_weight_kg
        OR NEW.target_rest_seconds IS DISTINCT FROM OLD.target_rest_seconds)
  EXECUTE FUNCTION public.pin_logged_set_log_targets();

-- ------------------------------------------------------------
-- 6. adopt_swap / adopt_skip: "already trained" is the same word (P17).
-- ------------------------------------------------------------
-- Everything but the predicate is the text of migration 02, the authorization
-- line included.
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

-- ------------------------------------------------------------
-- 7. Read the result back. Anything else than what was meant raises, and the
--    whole file is undone: either the database is as described, or untouched.
-- ------------------------------------------------------------
DO $verify$
DECLARE
  v_list text;
BEGIN
  -- The eleven functions: owned by postgres, search_path pinned, closed to a
  -- request without a session, and open to a signed-in user only where the
  -- app calls them (the two adopt RPCs).
  WITH wanted (signature, for_users) AS (
    VALUES ('public.set_log_is_logged(public.set_logs)', false),
           ('public.history_delete_allowed()', false),
           ('public.block_program_delete_with_logged_sets()', false),
           ('public.block_week_delete_with_logged_sets()', false),
           ('public.block_session_delete_with_logged_sets()', false),
           ('public.block_slot_delete_with_logged_sets()', false),
           ('public.block_set_log_delete_when_logged()', false),
           ('public.block_slot_sets_below_logged_set()', false),
           ('public.pin_logged_set_log_targets()', false),
           ('public.adopt_swap(uuid, uuid, boolean)', true),
           ('public.adopt_skip(uuid, boolean)', true)
  ),
  found AS (
    SELECT w.signature, w.for_users, p.oid, p.proowner, p.proconfig
      FROM wanted w
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(w.signature)
  )
  SELECT string_agg(f.signature || ': ' || f.wrong, '; ' ORDER BY f.signature) INTO v_list
    FROM (
      SELECT signature,
             CASE WHEN oid IS NULL THEN 'missing' ELSE concat_ws(', ',
               CASE WHEN pg_get_userbyid(proowner) <> 'postgres' THEN 'not owned by postgres' END,
               CASE WHEN has_function_privilege('anon', oid, 'EXECUTE') THEN 'anon may execute it' END,
               CASE WHEN has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT for_users
                    THEN 'a signed-in user may execute it' END,
               CASE WHEN NOT has_function_privilege('authenticated', oid, 'EXECUTE') AND for_users
                    THEN 'a signed-in user may NOT execute it' END,
               CASE WHEN proconfig IS NULL OR NOT ('search_path=public, pg_temp' = ANY (proconfig))
                    THEN 'search_path is not public, pg_temp' END
             ) END AS wrong
        FROM found
    ) f
   WHERE f.wrong <> '';
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_11_04_logged_history_guards did not get the functions it meant: %', v_list
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;

  -- The seven triggers: on their table, calling their function, enabled.
  WITH wanted (tbl, trg, fn) AS (
    VALUES ('programs',       'block_program_delete_with_logged_sets', 'block_program_delete_with_logged_sets'),
           ('weeks',          'block_week_delete_with_logged_sets',    'block_week_delete_with_logged_sets'),
           ('sessions',       'block_session_delete_with_logged_sets', 'block_session_delete_with_logged_sets'),
           ('exercise_slots', 'block_slot_delete_with_logged_sets',    'block_slot_delete_with_logged_sets'),
           ('set_logs',       'block_set_log_delete_when_logged',      'block_set_log_delete_when_logged'),
           ('exercise_slots', 'block_slot_sets_below_logged_set',      'block_slot_sets_below_logged_set'),
           ('set_logs',       'trg_pin_logged_set_log_targets',        'pin_logged_set_log_targets')
  )
  SELECT string_agg(w.trg || ' on ' || w.tbl, ', ' ORDER BY w.trg) INTO v_list
    FROM wanted w
   WHERE NOT EXISTS (
     SELECT 1
       FROM pg_trigger t
       JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE t.tgrelid = ('public.' || w.tbl)::regclass
        AND t.tgname = w.trg
        AND NOT t.tgisinternal
        AND t.tgenabled = 'O'
        AND p.pronamespace = 'public'::regnamespace
        AND p.proname = w.fn
   );
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_11_04_logged_history_guards did not get the triggers it meant: %', v_list
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;
END
$verify$;

INSERT INTO app_private.app_migrations (name)
VALUES ('2026_10_11_04_logged_history_guards')
RETURNING name, applied_at;

-- Two functions joined public: PostgREST caches what is there.
NOTIFY pgrst, 'reload schema';

COMMIT;
