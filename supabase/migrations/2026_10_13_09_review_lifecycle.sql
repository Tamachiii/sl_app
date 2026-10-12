-- ============================================================
-- 09 — A review needs a confirmation, and closes it
-- wave 1 · Checkpoint A2 · required · findings P57, L12 (the server half)
--
-- THE HOLE. A confirmation ("I have trained this session") and a review ("I
-- have read it", with feedback or without) were two facts nothing tied
-- together:
--   * the athlete took a confirmation back AFTER the review, changed the
--     sets and confirmed again: the feedback no longer spoke of what the
--     session held. (Migration 08 closed the sets; the confirmation itself
--     was still theirs to change and to remove.)
--   * the coach reviewed a session that was NOT confirmed — a "session
--     completed" notification whose confirmation had been taken back since,
--     the notification of a swap while the athlete was still training.
--     Feedback and "Finish without feedback" both stamped reviewed_at. The
--     session, confirmed later, never came into the "to review" list.
--   * every confirm → undo → confirm left one more "session completed" line
--     in the coach's bell, each with a push of its own; a skip that was undone
--     left its "off-plan" line behind (L12). The lines led to a review page
--     that said "not confirmed", or to an exercise with no swap in it.
--
-- WHAT THIS FILE DOES.
--   1. A confirmation is closed by the review. The athlete's UPDATE and
--      DELETE policies on session_confirmations ask session_writable(session):
--      neither archived nor reviewed — the lock of migration 08, asked of the
--      session itself. The INSERT policy is NOT touched: a session that was
--      reviewed without a confirmation can still be confirmed, which is the
--      only way it leaves its athlete's list of sessions to do.
--   2. … also when the two cross. A policy judges a row as the statement saw
--      the database when it started; a review committed in the meantime is
--      not seen. block_confirmation_delete_when_reviewed (BEFORE DELETE) reads
--      the session again, behind a row lock, and refuses a signed-in user.
--   3. A review needs a confirmation. review_needs_confirmation (BEFORE UPDATE
--      on sessions) refuses reviewed_at going from NULL to a value while the
--      session has no confirmation — to a signed-in user: the coach's "Finish
--      without feedback", and the trigger that stamps the review when the
--      coach sends feedback. On that transition ONLY: sessions reviewed
--      without a confirmation exist (the audit counts them), and they are
--      still archived, restored, renamed, reordered and moved between phases.
--   4. … and so does feedback. The INSERT policy on messages asks
--      session_is_confirmed(session) of a message that names a session.
--   5. A confirmation that is taken back takes the unread "session completed"
--      notifications of its session with it; a swap or a skip that is removed
--      takes its unread "off-plan" and "wants to keep it" notifications with
--      it (two AFTER DELETE triggers). A notification the coach has read
--      stays: it is their history.
--   6. The push of a confirmation is tagged by SESSION, not by confirmation:
--      a second confirmation of the same session replaces the first one on
--      the coach's lock screen instead of stacking under it.
--   7. ROWS ARE DELETED, ONCE: the unread notifications that are stale today —
--      "session completed" whose confirmation no longer exists, "off-plan" and
--      "wants to keep it" whose swap or skip no longer exists. The audit
--      counts them before (lines 14 and 15). They do not come back with the
--      rollback. Nothing else is written: no session, no confirmation, no
--      message.
--
-- WHAT A CLIENT SEES. With the app that is deployed today:
--   * an athlete, on a session that is not reviewed: nothing changes.
--     Confirm, Undo confirmation, confirm again.
--   * an athlete, "Undo confirmation" on a reviewed session: no message. The
--     page shows the session as not confirmed for a moment, then as confirmed
--     again; nothing was changed.
--   * an athlete whose phone sends a confirmation a second time for a session
--     that was reviewed in between (a retry after a lost answer, a second
--     device): "You don't have permission to do that." The first confirmation
--     stays as it was. The next version of the app sends a confirmation that
--     writes nothing when there is one already.
--   * a coach, on a confirmed session: nothing changes.
--   * a coach, feedback on a session that is not confirmed: the message is
--     not sent and the box shows the database's sentence ("new row violates
--     row-level security policy for table "messages""). "Finish without
--     feedback" there: "You don't have permission to do that." The next
--     version of the app does not offer either on such a session.
--
-- Backward compatible: yes, with every client ever deployed.
-- Audit:    supabase/audits/2026_10_13_09_review_lifecycle.audit.sql
-- Rollback: supabase/rollbacks/2026_10_13_09_review_lifecycle.down.sql (reopens P57)
-- Runbook:  docs/runbook/migrations/09-review-lifecycle.md
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
    RAISE EXCEPTION 'migration 2026_10_13_09_review_lifecycle must be run as postgres, not as %', current_user
      USING HINT = 'Run it from the SQL editor or with `supabase db query --linked`. Nothing was changed.';
  END IF;

  -- Asked before the ledger is read: without it the answer would be
  -- "relation does not exist" instead of this one.
  IF to_regclass('app_private.app_migrations') IS NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_09_review_lifecycle needs 2026_10_12_08_session_write_gates, which is not applied'
      USING ERRCODE = 'SLM02', HINT = 'Apply migrations 01 to 08 first. Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_13_09_review_lifecycle') THEN
    RAISE EXCEPTION 'migration 2026_10_13_09_review_lifecycle is already applied'
      USING ERRCODE = 'SLM01', HINT = 'Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_12_08_session_write_gates') THEN
    RAISE EXCEPTION 'migration 2026_10_13_09_review_lifecycle needs 2026_10_12_08_session_write_gates, which is not applied'
      USING ERRCODE = 'SLM02', HINT = 'Apply that file first. Nothing was changed.';
  END IF;

  -- CREATE OR REPLACE replaces a function with the SAME argument types. A
  -- copy of one of these with other arguments would stay next to the new one,
  -- and nothing would say so.
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text)
    INTO v_strangers
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('session_is_confirmed', 'review_needs_confirmation',
                       'block_confirmation_delete_when_reviewed',
                       'retract_session_completed_notification',
                       'retract_slot_deviation_notifications')
     -- By oid, names written with their schema: the answer must not depend on
     -- the search_path of whoever runs the file.
     AND NOT EXISTS (
       SELECT 1
         FROM unnest(ARRAY[
                'public.session_is_confirmed(uuid)',
                'public.review_needs_confirmation()',
                'public.block_confirmation_delete_when_reviewed()',
                'public.retract_session_completed_notification()',
                'public.retract_slot_deviation_notifications()'
              ]) AS known(signature)
        WHERE to_regprocedure(known.signature) = p.oid
     );
  IF v_strangers IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_09_review_lifecycle would not replace: %', v_strangers
      USING HINT = 'A function of this file exists with other arguments. Nothing was changed. Stop and report.';
  END IF;
END
$guard$;

-- ------------------------------------------------------------
-- 1. Has the athlete confirmed this session?
-- ------------------------------------------------------------
-- For the policy on messages, below. SECURITY DEFINER, like the other helpers
-- the policies are written with: it must not depend on what the caller may
-- read. Never NULL: a session that does not exist is not confirmed.
--
-- STABLE: it answers for the database as the statement that asks saw it when
-- it started. That is what a policy needs, and it is NOT enough for a rule
-- that two requests can cross — review_needs_confirmation, further down,
-- reads the table itself for that reason.
CREATE OR REPLACE FUNCTION public.session_is_confirmed(sess_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.session_confirmations c
     WHERE c.session_id = sess_id
  )
$$;

REVOKE ALL ON FUNCTION public.session_is_confirmed(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.session_is_confirmed(uuid) TO authenticated;

-- session_writable(session) — migration 08 — is asked of a session id by a
-- policy from here on (section 3): a policy runs with the privileges of the
-- user who queries the table.
REVOKE ALL ON FUNCTION public.session_writable(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.session_writable(uuid) TO authenticated;

-- ------------------------------------------------------------
-- 2. Feedback is sent on a confirmed session.
-- ------------------------------------------------------------
-- A message that names a session is the coach's feedback, and its INSERT
-- stamps the review (notify_student_on_session_feedback). It was accepted
-- for any session of the athlete. The first two lines of the session branch
-- are the ones from before; the third is new. An ordinary message — no
-- session — is judged as before.
DROP POLICY IF EXISTS "Send to coach-student counterpart" ON public.messages;
CREATE POLICY "Send to coach-student counterpart"
  ON public.messages FOR INSERT
  WITH CHECK (
    sender_id = auth.uid()
    AND public.profiles_are_coach_student(sender_id, recipient_id)
    AND (
      session_id IS NULL
      OR (
        sender_id    = public.coach_profile_for_session(session_id)
        AND recipient_id = public.student_profile_for_session(session_id)
        AND public.session_is_confirmed(session_id)
      )
    )
  );

-- ------------------------------------------------------------
-- 3. A confirmation is changed and taken back until the review.
-- ------------------------------------------------------------
-- "Not archived" was a sub-select on sessions in both; session_writable says
-- it, and "not reviewed" with it.
--
-- "Students insert own session confirmations" is NOT re-created: not
-- archived, program active — and nothing about the review. A session can be
-- reviewed and have no confirmation (the audit counts those from before this
-- file); its athlete's app lists it as still to do until it is confirmed.
--
-- An upsert that meets an existing row (INSERT … ON CONFLICT DO UPDATE, which
-- the app deployed before wave 1 sends for every confirm) is judged by the
-- UPDATE policy, and RAISES 42501 when that row may not be updated — it is
-- never skipped in silence. ON CONFLICT DO NOTHING is judged as an INSERT
-- only, and writes nothing.
DROP POLICY IF EXISTS "Students update own session confirmations" ON public.session_confirmations;
CREATE POLICY "Students update own session confirmations"
  ON public.session_confirmations FOR UPDATE
  USING (
    student_id = auth.uid()
    AND public.student_profile_for_session(session_id) = auth.uid()
    AND public.program_active_for_session(session_id) = true
    AND public.session_writable(session_id)
  )
  WITH CHECK (
    student_id = auth.uid()
    AND public.student_profile_for_session(session_id) = auth.uid()
    AND public.program_active_for_session(session_id) = true
    AND public.session_writable(session_id)
  );

DROP POLICY IF EXISTS "Students delete own session confirmations" ON public.session_confirmations;
CREATE POLICY "Students delete own session confirmations"
  ON public.session_confirmations FOR DELETE
  USING (
    student_id = auth.uid()
    AND public.student_profile_for_session(session_id) = auth.uid()
    AND public.program_active_for_session(session_id) = true
    AND public.session_writable(session_id)
  );

-- ------------------------------------------------------------
-- 4. A review needs a confirmation.
-- ------------------------------------------------------------
-- reviewed_at goes from NULL to a value only while the session has a
-- confirmation. Both writers of the app come through here: the coach's own
-- UPDATE ("Finish without feedback") and notify_student_on_session_feedback,
-- whose UPDATE runs inside the coach's request and is not inside its
-- EXCEPTION block — so a refusal here undoes the INSERT of the message too.
--
-- FOR A REQUEST THAT CARRIES A USER ID: the app, the API, and a SECURITY
-- DEFINER function called from either, which is still that user. The owner of
-- the database and the service role stamp what they decide — the statement
-- that closes a session by hand (docs/runbook/migrations/08-session-write-gates.md)
-- still does.
--
-- ON THAT TRANSITION ONLY (the WHEN of the trigger). Sessions reviewed
-- without a confirmation exist from before this file; every other write of
-- such a row — archive, restore, rename, reorder, move_session, the mirror of
-- the training date — goes through, and so does taking a review back
-- (reviewed_at = NULL). An INSERT is not judged: the app creates no session
-- with a review on it, and a coach who sends one by hand has closed a session
-- nobody trained — which archiving does as well.
--
-- VOLATILE, AND IT MUST STAY SO — the opposite of pin_draft_session_columns.
-- A BEFORE UPDATE trigger fires once the row of the session is locked. A
-- VOLATILE function then reads session_confirmations as it is NOW: a
-- confirmation taken back by a request that committed while this one waited
-- for the row is gone, and the review is refused. STABLE would read the
-- table as the statement saw it when it started, and stamp the review of a
-- session that has just been un-confirmed. For the same reason it does not
-- call session_is_confirmed(), which is STABLE.
--
-- The name of the trigger sorts AFTER trg_pin_draft_session_columns, and
-- BEFORE triggers fire in the order of their names: on a session of a draft
-- the pin has already put reviewed_at back to NULL when the WHEN below is
-- asked, so a draft stays silent (migration 06) instead of raising here.
--
-- 42501, the code of a refusal by a policy: the app shows both as "You don't
-- have permission to do that."
CREATE OR REPLACE FUNCTION public.review_needs_confirmation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.session_confirmations c
     WHERE c.session_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'session % is not confirmed by its athlete — it cannot be marked as reviewed', NEW.id
      USING ERRCODE = '42501',
            HINT = 'A review, with feedback or without, needs the confirmation of the session.';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.review_needs_confirmation() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_review_needs_confirmation ON public.sessions;
CREATE TRIGGER trg_review_needs_confirmation
  BEFORE UPDATE ON public.sessions
  FOR EACH ROW
  WHEN (OLD.reviewed_at IS NULL AND NEW.reviewed_at IS NOT NULL)
  EXECUTE FUNCTION public.review_needs_confirmation();

-- ------------------------------------------------------------
-- 5. … and the confirmation of a reviewed session stays, when the two cross.
-- ------------------------------------------------------------
-- The DELETE policy of section 3 judges the session as the athlete's
-- statement saw it when it STARTED. A review that commits while that
-- statement is on its way is not seen by it: the confirmation would go, and
-- the session would be reviewed without one — the state section 4 refuses.
--
-- So the row of the session is read again here, with FOR SHARE: the read
-- waits for a review that is being written (an UPDATE holds the row) and
-- then sees it. The other order is section 4's: a review that arrives while
-- this DELETE holds the row waits, and then finds no confirmation. The coach
-- never locks a confirmation, so the two cannot wait for each other.
--
-- FOR A REQUEST THAT CARRIES A USER ID. The owner of the database and the
-- service role take a confirmation away whatever the session says: removing
-- an account cascades here from profiles while the session is still there.
-- A cascade from the session itself is not concerned either way — the row of
-- the session is gone by the time its confirmation follows, and a session
-- that is not found refuses nothing.
--
-- It raises where the policy says nothing: this is the request that lost a
-- race, and "nothing happened" would not tell it apart from one that won.
--
-- KNOWN residual: an UPDATE of the confirmation is not read again. A note or
-- a date written in the same instant as the review breaks nothing. An UPDATE
-- that MOVES the confirmation to another session in that instant — the app
-- sends none; session_id is not held on this table — leaves this session
-- reviewed without one: the state the audit counts on line 13, which its
-- athlete leaves by confirming.
CREATE OR REPLACE FUNCTION public.block_confirmation_delete_when_reviewed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_reviewed_at timestamptz;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN OLD;
  END IF;

  SELECT s.reviewed_at INTO v_reviewed_at
    FROM public.sessions s
   WHERE s.id = OLD.session_id
     FOR SHARE;

  IF FOUND AND v_reviewed_at IS NOT NULL THEN
    RAISE EXCEPTION 'session % has been reviewed by the coach — its confirmation cannot be taken back', OLD.session_id
      USING ERRCODE = '42501',
            HINT = 'The review was written while this request was on its way.';
  END IF;
  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.block_confirmation_delete_when_reviewed() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS block_confirmation_delete_when_reviewed ON public.session_confirmations;
CREATE TRIGGER block_confirmation_delete_when_reviewed
  BEFORE DELETE ON public.session_confirmations
  FOR EACH ROW
  EXECUTE FUNCTION public.block_confirmation_delete_when_reviewed();

-- ------------------------------------------------------------
-- 6. What is taken back takes its unread notifications with it.
-- ------------------------------------------------------------
-- A "session completed" notification is written when a confirmation is
-- inserted (notify_coach_on_session_confirm). Nothing removed it when the
-- confirmation went: the coach's bell kept a line that led to a review page
-- saying "not confirmed", and the next confirmation added another.
--
-- By session, and by confirmation: a session has one confirmation at most, so
-- once it is gone every unread "session completed" of that session is stale —
-- the ones left by earlier rounds included.
--
-- UNREAD ONLY. A notification the coach has read is their history, and the
-- bell shows it as such.
-- SECURITY DEFINER: the statement is the athlete's, the notification is the
-- coach's, and nobody holds a DELETE policy on notifications.
-- It fires on a cascade too (a session that is deleted): the line would lead
-- nowhere.
CREATE OR REPLACE FUNCTION public.retract_session_completed_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  DELETE FROM public.notifications n
   WHERE n.kind = 'session_completed'
     AND n.read_at IS NULL
     AND (n.payload->>'confirmation_id' = OLD.id::text
          OR n.payload->>'session_id' = OLD.session_id::text);
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.retract_session_completed_notification() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_retract_session_completed_notification ON public.session_confirmations;
CREATE TRIGGER trg_retract_session_completed_notification
  AFTER DELETE ON public.session_confirmations
  FOR EACH ROW
  EXECUTE FUNCTION public.retract_session_completed_notification();

-- The same for a swap or a skip (L12): "skipped Dips" (session_deviation,
-- written when the row is inserted) and "wants to drop Dips going forward"
-- (promote_requested, written when the athlete asks) both name the exercise
-- slot in their payload. A slot holds one deviation at most.
CREATE OR REPLACE FUNCTION public.retract_slot_deviation_notifications()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  DELETE FROM public.notifications n
   WHERE n.kind IN ('session_deviation', 'promote_requested')
     AND n.read_at IS NULL
     AND n.payload->>'slot_id' = OLD.exercise_slot_id::text;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.retract_slot_deviation_notifications() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_retract_slot_deviation_notifications ON public.slot_deviations;
CREATE TRIGGER trg_retract_slot_deviation_notifications
  AFTER DELETE ON public.slot_deviations
  FOR EACH ROW
  EXECUTE FUNCTION public.retract_slot_deviation_notifications();

-- ------------------------------------------------------------
-- 7. The push of a confirmation: one per session on the lock screen.
-- ------------------------------------------------------------
-- The body of 2026_07_17_session_confirm_push with ONE line changed: the tag
-- was 'session-confirm-' || NEW.id — the id of the confirmation, which is a
-- new one after each undo, so the pushes of one session stacked. With the id
-- of the session the service worker replaces the previous one.
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

-- ------------------------------------------------------------
-- 8. The notifications that are stale today. Rows are deleted here, once.
-- ------------------------------------------------------------
-- What the two triggers of section 6 would have removed, had they been there.
-- After them in the file: CREATE TRIGGER holds both tables until COMMIT, so
-- nothing is taken back between these statements and the triggers.
--
-- "Session completed", unread, whose confirmation no longer exists: taken
-- back, or replaced by a later one that wrote a line of its own.
DELETE FROM public.notifications n
 WHERE n.kind = 'session_completed'
   AND n.read_at IS NULL
   AND n.payload ? 'confirmation_id'
   AND NOT EXISTS (
     SELECT 1
       FROM public.session_confirmations c
      WHERE c.id::text = n.payload->>'confirmation_id'
   );

-- "Off-plan" and "wants to keep it", unread, whose exercise has no swap and
-- no skip any more.
DELETE FROM public.notifications n
 WHERE n.kind IN ('session_deviation', 'promote_requested')
   AND n.read_at IS NULL
   AND n.payload ? 'slot_id'
   AND NOT EXISTS (
     SELECT 1
       FROM public.slot_deviations d
      WHERE d.exercise_slot_id::text = n.payload->>'slot_id'
   );

-- ------------------------------------------------------------
-- 9. Read the result back. Anything else than what was meant raises, and the
--    whole file is undone: either the database is as described, or untouched.
-- ------------------------------------------------------------
DO $verify$
DECLARE
  v_list text;
BEGIN
  -- The functions: owned by postgres, search_path pinned, closed to a request
  -- without a session, and open to a signed-in user exactly where a policy
  -- calls it.
  WITH wanted (signature, for_users) AS (
    VALUES ('public.session_is_confirmed(uuid)',                     true),
           ('public.session_writable(uuid)',                         true),
           ('public.review_needs_confirmation()',                    false),
           ('public.block_confirmation_delete_when_reviewed()',      false),
           ('public.retract_session_completed_notification()',       false),
           ('public.retract_slot_deviation_notifications()',         false),
           ('public.notify_coach_on_session_confirm()',              false)
  ),
  found AS (
    SELECT w.signature, w.for_users, p.oid, p.proowner, p.proconfig, p.prosecdef
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
               CASE WHEN NOT prosecdef THEN 'it does not run as its owner' END,
               CASE WHEN proconfig IS NULL OR NOT ('search_path=public, pg_temp' = ANY (proconfig))
                    THEN 'search_path is not public, pg_temp' END
             ) END AS wrong
        FROM found
    ) f
   WHERE f.wrong <> '';
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_09_review_lifecycle did not get the functions it meant: %', v_list
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;

  -- The policies that WRITE the two tables are the ones of this list and no
  -- other: policies add up, and one made by hand, under another name, would
  -- leave open the door this file closes.
  -- `asks`: for the three this file creates, what the policy must ask wherever
  -- it judges a row (USING for a row that is there, WITH CHECK for the row
  -- that is written). The other three are the ones from before, which this
  -- file does not touch: they are known, and not looked into.
  WITH known (tbl, name, cmd, asks) AS (
    VALUES ('public.session_confirmations', 'Students insert own session confirmations', 'a', NULL),
           ('public.session_confirmations', 'Students update own session confirmations', 'w', 'session_writable('),
           ('public.session_confirmations', 'Students delete own session confirmations', 'd', 'session_writable('),
           ('public.messages',              'Send to coach-student counterpart',         'a', 'session_is_confirmed('),
           ('public.messages',              'Recipient marks messages read',             'w', NULL),
           ('public.messages',              'Sender deletes own message',                'd', NULL)
  ),
  tables AS (
    SELECT DISTINCT tbl, tbl::regclass AS rel FROM known
  ),
  writes AS (
    SELECT t.tbl, pol.polname AS name, pol.polcmd::text AS cmd,
           coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') AS judged,
           coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '') AS checked
      FROM tables t
      JOIN pg_policy pol ON pol.polrelid = t.rel
     WHERE pol.polcmd <> 'r'
  )
  SELECT string_agg(problem, '; ' ORDER BY problem) INTO v_list
    FROM (
      SELECT 'row-level security is off on ' || t.tbl AS problem
        FROM tables t
        JOIN pg_class c ON c.oid = t.rel
       WHERE NOT c.relrowsecurity
      UNION ALL
      SELECT x.tbl || ' has the policy "' || x.name || '" for '
             || CASE x.cmd WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE'
                           WHEN 'd' THEN 'DELETE' ELSE 'ALL' END
             || ', which this migration does not know'
        FROM writes x
       WHERE NOT EXISTS (SELECT 1 FROM known k
                          WHERE k.tbl = x.tbl AND k.name = x.name AND k.cmd = x.cmd)
      UNION ALL
      SELECT k.tbl || ' has no policy "' || k.name || '"'
        FROM known k
       WHERE k.asks IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM writes x
                          WHERE x.tbl = k.tbl AND x.name = k.name AND x.cmd = k.cmd)
      UNION ALL
      SELECT x.tbl || ': "' || x.name || '" does not ask ' || k.asks || '…)'
        FROM writes x
        JOIN known k ON k.tbl = x.tbl AND k.name = x.name AND k.cmd = x.cmd
       WHERE k.asks IS NOT NULL
         AND (   (x.cmd IN ('w', 'd') AND position(k.asks IN x.judged)  = 0)
              OR (x.cmd IN ('a', 'w') AND position(k.asks IN x.checked) = 0))
    ) problems;
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_09_review_lifecycle did not get the policies it meant: %', v_list
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;

  -- The four triggers: on their table, calling their function, firing for
  -- every row, and switched on.
  WITH wanted (tbl, name, fn) AS (
    VALUES ('public.sessions',              'trg_review_needs_confirmation',
            'public.review_needs_confirmation()'),
           ('public.session_confirmations', 'block_confirmation_delete_when_reviewed',
            'public.block_confirmation_delete_when_reviewed()'),
           ('public.session_confirmations', 'trg_retract_session_completed_notification',
            'public.retract_session_completed_notification()'),
           ('public.slot_deviations',       'trg_retract_slot_deviation_notifications',
            'public.retract_slot_deviation_notifications()')
  )
  SELECT string_agg(w.tbl || ': ' || w.name, '; ' ORDER BY w.tbl, w.name) INTO v_list
    FROM wanted w
   WHERE NOT EXISTS (
     SELECT 1
       FROM pg_trigger t
      WHERE t.tgrelid = w.tbl::regclass
        AND t.tgname = w.name
        AND t.tgfoid = to_regprocedure(w.fn)
        AND t.tgenabled = 'O'
        AND NOT t.tgisinternal
   );
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_09_review_lifecycle did not get the triggers it meant: %', v_list
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;

  -- Nothing stale is left.
  IF EXISTS (
    SELECT 1 FROM public.notifications n
     WHERE n.kind = 'session_completed' AND n.read_at IS NULL AND n.payload ? 'confirmation_id'
       AND NOT EXISTS (SELECT 1 FROM public.session_confirmations c
                        WHERE c.id::text = n.payload->>'confirmation_id')
  ) OR EXISTS (
    SELECT 1 FROM public.notifications n
     WHERE n.kind IN ('session_deviation', 'promote_requested') AND n.read_at IS NULL AND n.payload ? 'slot_id'
       AND NOT EXISTS (SELECT 1 FROM public.slot_deviations d
                        WHERE d.exercise_slot_id::text = n.payload->>'slot_id')
  ) THEN
    RAISE EXCEPTION 'migration 2026_10_13_09_review_lifecycle left a stale notification behind'
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;
END
$verify$;

INSERT INTO app_private.app_migrations (name)
VALUES ('2026_10_13_09_review_lifecycle')
RETURNING name, applied_at;

-- Functions joined public: PostgREST caches what is there.
NOTIFY pgrst, 'reload schema';

COMMIT;
