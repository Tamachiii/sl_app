-- ============================================================
-- 06 — The set and session columns an athlete must not change
-- wave 1 · Checkpoint A2 · required · findings P13, P14, B4
--
-- THREE HOLES, one kind: a row an athlete may write, with a column in it
-- that is not theirs to write.
--
-- P14 — a set. An athlete writes their own set_logs rows: done, failed, RPE,
-- actuals. A trigger gives the coach's target_* back on every such write, and
-- the DELETE policy lets an athlete delete only a set they added themselves
-- (is_student_added). That flag was not held. An athlete could
--   * mark a prescribed set as "added by me", delete it, and insert it again
--     with other targets;
--   * move a set to another number, or to another exercise, and insert a
--     replacement in the place it left.
-- Either way the coach's prescription of an existing set was replaced, and
-- with it what the records and the off-plan review read.
--
-- P13 — a session of a draft. An athlete writes the sessions of the program
-- they are drafting, every column of them. Three of those columns are how the
-- app knows that a session was reviewed by the coach, archived, trained. A
-- draft could be sent in with reviewed_at already set: once approved, those
-- sessions never reach the coach's "to review" list, and feedback on them is
-- refused as "already reviewed".
--
-- B4 — a submission. Sending a draft in (submitted_at NULL → a time) notifies
-- the coach, bell and push. The author could take the submission back and
-- make it again, as often as they liked: one notification each time.
--
-- WHAT THIS FILE DOES.
--   1. The athlete's pin on a set also holds is_student_added,
--      exercise_slot_id and set_number. Whose set it is, is asked of the row
--      as it WAS — the slot being one of the columns held. Silent, like the
--      pin on the targets: the rest of the write goes through. The coach is
--      not the athlete of the set: the editor renumbers sets as before.
--   2. A trigger on sessions: while the program is a draft, reviewed_at,
--      archived_at, performed_at and scheduled_date are NULL — on insert and
--      on update, WHOEVER writes. Keyed on the status of the program and not
--      on the writer, because performed_at is written by a trigger that runs
--      in the athlete's own request when they confirm a session
--      (sync_session_performed_at): a pin "for the athlete" would undo it.
--      A session whose week or program is not there is not a draft's.
--      The function is STABLE: it judges the program as the policy that lets
--      the author write the session judges it, also when the coach approves
--      at that very moment (section 2).
--   3. approve_program clears the four columns on the sessions of the program
--      it approves: whatever a draft carried from before this file, an
--      approved program starts without it.
--   4. The author of a draft cannot change submitted_at once it is set. Taking
--      a submission back is the coach's (send_back_program), after which the
--      author submits again — and the coach is told again, once.
--
-- WHAT A CLIENT SEES. An athlete, with the app that is deployed today:
-- nothing. It never sends one of the held columns in an update of a set,
-- never writes a session outside save_draft_tree — which sets none of the
-- four — and never clears submitted_at.
-- A coach, on a draft an athlete is writing or has sent in: archiving one of
-- its sessions, or giving it a recommended date, is accepted and does not
-- stay — the session shows as before after the next refresh. Both are done
-- after "Approve". (An athlete's next save replaces the whole draft anyway,
-- with whatever the coach had changed in it.)
-- By hand, through the API: the write is accepted and the held columns keep
-- their values. No error.
--
-- No row of the app is written by this file: the audit counts the sessions of
-- a draft that already carry one of the four columns (line 10), and they are
-- cleared when the draft is approved or the session is next written.
--
-- Backward compatible: yes, with every client ever deployed.
-- Audit:    supabase/audits/2026_10_11_06_pin_student_writes.audit.sql
-- Rollback: supabase/rollbacks/2026_10_11_06_pin_student_writes.down.sql (reopens P13 / P14 / B4)
-- Runbook:  docs/runbook/migrations/06-pin-student-writes.md
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
    RAISE EXCEPTION 'migration 2026_10_11_06_pin_student_writes must be run as postgres, not as %', current_user
      USING HINT = 'Run it from the SQL editor or with `supabase db query --linked`. Nothing was changed.';
  END IF;

  -- Asked before the ledger is read: without it the answer would be
  -- "relation does not exist" instead of this one.
  IF to_regclass('app_private.app_migrations') IS NULL THEN
    RAISE EXCEPTION 'migration 2026_10_11_06_pin_student_writes needs 2026_10_11_05_students_role_gate, which is not applied'
      USING ERRCODE = 'SLM02', HINT = 'Apply migrations 01 to 05 first. Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_11_06_pin_student_writes') THEN
    RAISE EXCEPTION 'migration 2026_10_11_06_pin_student_writes is already applied'
      USING ERRCODE = 'SLM01', HINT = 'Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_11_05_students_role_gate') THEN
    RAISE EXCEPTION 'migration 2026_10_11_06_pin_student_writes needs 2026_10_11_05_students_role_gate, which is not applied'
      USING ERRCODE = 'SLM02', HINT = 'Apply that file first. Nothing was changed.';
  END IF;

  -- CREATE OR REPLACE replaces a function with the SAME argument types. A
  -- copy of one of these with other arguments would keep its old body — an
  -- approve_program that leaves a pre-filled review in place — and nothing
  -- would say so.
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text)
    INTO v_strangers
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('pin_set_log_targets_for_student', 'pin_draft_session_columns',
                       'pin_program_authoring_columns', 'approve_program')
     -- By oid, names written with their schema: the answer must not depend on
     -- the search_path of whoever runs the file.
     AND NOT EXISTS (
       SELECT 1
         FROM unnest(ARRAY[
                'public.pin_set_log_targets_for_student()',
                'public.pin_draft_session_columns()',
                'public.pin_program_authoring_columns()',
                'public.approve_program(uuid)'
              ]) AS known(signature)
        WHERE to_regprocedure(known.signature) = p.oid
     );
  IF v_strangers IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_11_06_pin_student_writes would not replace: %', v_strangers
      USING HINT = 'A function of this file exists with other arguments. Nothing was changed. Stop and report.';
  END IF;
END
$guard$;

-- ------------------------------------------------------------
-- 1. A set: what its athlete's own write leaves as it was (P14).
-- ------------------------------------------------------------
-- The athlete owns what they did on a set: done, failed, skipped, the RPE,
-- the actuals, the times. The coach owns what the set IS:
--   target_*           the prescription — held since 2026_06_28
--   is_student_added   prescribed, or an extra the athlete added. The DELETE
--                      policy trusts it: only an extra can be deleted by its
--                      athlete
--   exercise_slot_id   which exercise it belongs to
--   set_number         which set of that exercise it is
-- A set that could be renumbered or moved leaves its place free for a row
-- inserted with other targets; one that could be marked "added" can be
-- deleted first.
--
-- Whose set it is, is asked of OLD: the slot is one of the columns held, and
-- a row pointed at a slot that is nobody's — or at none — is still its
-- athlete's row.
--
-- Silent, like the pin on the targets: the statement goes through and the
-- columns keep their values. The app never sends one of them in an athlete's
-- update, so nothing it does is changed.
--
-- The coach is not the athlete of the set and passes through: the editor
-- renumbers the athlete's extra sets when the set count changes. So does a
-- statement without a user id.
CREATE OR REPLACE FUNCTION public.pin_set_log_targets_for_student()
RETURNS trigger AS $$
BEGIN
  IF public.student_profile_for_slot(OLD.exercise_slot_id) = auth.uid() THEN
    NEW.target_reps             := OLD.target_reps;
    NEW.target_duration_seconds := OLD.target_duration_seconds;
    NEW.target_weight_kg        := OLD.target_weight_kg;
    NEW.target_rest_seconds     := OLD.target_rest_seconds;
    NEW.is_student_added        := OLD.is_student_added;
    NEW.exercise_slot_id        := OLD.exercise_slot_id;
    NEW.set_number              := OLD.set_number;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.pin_set_log_targets_for_student() FROM PUBLIC, anon, authenticated;

-- The trigger is written again (the same definition: nothing moves where it
-- is in place). One that had been dropped by hand comes back here.
CREATE OR REPLACE TRIGGER trg_pin_set_log_targets_for_student
  BEFORE UPDATE ON public.set_logs
  FOR EACH ROW EXECUTE FUNCTION public.pin_set_log_targets_for_student();

-- ------------------------------------------------------------
-- 2. A session of a draft carries no review, no archive, no training date
--    and no recommended date (P13).
-- ------------------------------------------------------------
-- The four columns say what happened to a session once it is part of a
-- program an athlete trains: the coach reviewed it, the coach archived it,
-- the athlete trained it, the coach recommends a day for it. A draft is none
-- of that yet — and its author may write every column of its sessions
-- ("Students author own draft sessions" is FOR ALL).
--
-- So: NULL while the program is a draft, for EVERY writer. Not "for the
-- athlete": sessions.performed_at is written by sync_session_performed_at,
-- which runs inside the athlete's own request when they confirm a session —
-- of an approved program, which the athlete may well have authored. A pin
-- keyed on who writes could not tell that write from a forged one. The status
-- of the program can: a draft is never active, and is never trained.
--
-- A session whose week or program does not exist is not a draft's: the
-- foreign key answers for it.
--
-- Silent: save_draft_tree, the coach's editor and every other writer go on;
-- the four columns stay empty until the program is approved.
--
-- STABLE, AND IT MUST STAY SO. Two things judge the same write: the policy
-- that lets the author write the session at all ("Students author own draft
-- sessions", through week_is_own_draft — STABLE), and this function. A STABLE
-- function reads the database as the statement that fired it saw it when it
-- STARTED; a VOLATILE one reads it as it is by the time the row is reached.
-- They differ when the coach approves while a stamp of the author waits for
-- a row lock: a draft for the policy, an approved program for a VOLATILE
-- pin, which then holds nothing — the stamp is written on the approved
-- program, and P13 is open again to an author who sends their stamps in
-- parallel with nothing but the API. No test on ONE connection sees the
-- difference: supabase/tests/pins.test.js has one on three.
--
-- The price: the function does not see a week created earlier in the SAME
-- statement (a data-modifying CTE). Neither do the policies, so that write
-- is refused to the author and to the coach; only a caller row-level
-- security does not apply to — the owner of the database, the service role —
-- gets a stamped session into a draft that way. save_draft_tree writes the
-- weeks, then the sessions: two statements.
CREATE OR REPLACE FUNCTION public.pin_draft_session_columns()
RETURNS trigger AS $$
BEGIN
  -- Nothing to hold: the write every draft save makes, and most others.
  IF NEW.reviewed_at IS NULL AND NEW.archived_at IS NULL
     AND NEW.performed_at IS NULL AND NEW.scheduled_date IS NULL THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.weeks w
      JOIN public.programs p ON p.id = w.program_id
     WHERE w.id = NEW.week_id
       AND p.status = 'draft'
  ) THEN
    NEW.reviewed_at    := NULL;
    NEW.archived_at    := NULL;
    NEW.performed_at   := NULL;
    NEW.scheduled_date := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.pin_draft_session_columns() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER trg_pin_draft_session_columns
  BEFORE INSERT OR UPDATE ON public.sessions
  FOR EACH ROW EXECUTE FUNCTION public.pin_draft_session_columns();

-- ------------------------------------------------------------
-- 3. A submission is made once (B4).
-- ------------------------------------------------------------
-- Everything but the three lines on submitted_at is the text from before.
-- The author sets submitted_at (NULL → a time): that is the submission, and
-- notify_coach_on_program_submit tells the coach on that edge. Once set, the
-- author's writes leave it as it is — they can neither take the submission
-- back nor date it again. The coach takes it back (send_back_program), and
-- approve_program clears it: neither is the author, neither is held.
CREATE OR REPLACE FUNCTION public.pin_program_authoring_columns()
RETURNS TRIGGER AS $$
BEGIN
  -- created_by + student_id immutable for everyone (tenant isolation: a draft
  -- author can never re-point their draft to another student).
  NEW.created_by := OLD.created_by;
  NEW.student_id := OLD.student_id;
  IF auth.uid() IS NOT DISTINCT FROM OLD.created_by THEN
    NEW.status := OLD.status;
    NEW.approved_at := OLD.approved_at;
    -- Submitted once: NULL → a time is the author's, the way back is the
    -- coach's (review B4 — each new NULL → time edge notified the coach).
    IF OLD.submitted_at IS NOT NULL THEN
      NEW.submitted_at := OLD.submitted_at;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.pin_program_authoring_columns() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER trg_pin_program_authoring_columns
  BEFORE UPDATE ON public.programs
  FOR EACH ROW EXECUTE FUNCTION public.pin_program_authoring_columns();

-- ------------------------------------------------------------
-- 4. approve_program: an approved program starts clean (P13).
-- ------------------------------------------------------------
-- Everything but the UPDATE of public.sessions is the text of migration 02,
-- the authorization line included. The trigger of section 2 keeps a draft
-- clean from now on; this clears what a draft carried from before it, at the
-- one moment it would start to matter.
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

-- ------------------------------------------------------------
-- 5. Read the result back. Anything else than what was meant raises, and the
--    whole file is undone: either the database is as described, or untouched.
-- ------------------------------------------------------------
DO $verify$
DECLARE
  v_list text;
BEGIN
  -- The four functions: owned by postgres, search_path pinned, closed to a
  -- request without a session, and open to a signed-in user only where the
  -- app calls it (approve_program).
  WITH wanted (signature, for_users) AS (
    VALUES ('public.pin_set_log_targets_for_student()', false),
           ('public.pin_draft_session_columns()', false),
           ('public.pin_program_authoring_columns()', false),
           ('public.approve_program(uuid)', true)
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
    RAISE EXCEPTION 'migration 2026_10_11_06_pin_student_writes did not get the functions it meant: %', v_list
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;

  -- The three triggers: on their table, calling their function, enabled.
  WITH wanted (tbl, trg, fn) AS (
    VALUES ('set_logs', 'trg_pin_set_log_targets_for_student', 'pin_set_log_targets_for_student'),
           ('sessions', 'trg_pin_draft_session_columns',       'pin_draft_session_columns'),
           ('programs', 'trg_pin_program_authoring_columns',   'pin_program_authoring_columns')
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
    RAISE EXCEPTION 'migration 2026_10_11_06_pin_student_writes did not get the triggers it meant: %', v_list
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;
END
$verify$;

INSERT INTO app_private.app_migrations (name)
VALUES ('2026_10_11_06_pin_student_writes')
RETURNING name, applied_at;

-- A function joined public: PostgREST caches what is there.
NOTIFY pgrst, 'reload schema';

COMMIT;
