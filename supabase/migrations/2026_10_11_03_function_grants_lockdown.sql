-- ============================================================
-- 03 — Function privileges: an explicit allow-list, closed defaults, a pinned
--      search_path
-- wave 1 · Checkpoint A1 · required · findings B2, L21, L23
--
-- WHO COULD CALL WHAT (B2, L21). Supabase's default privileges grant EXECUTE
-- on every function `postgres` creates in `public` to `anon`, `authenticated`
-- and `service_role` BY NAME, on top of the EXECUTE that PostgreSQL itself
-- gives PUBLIC. The repository never took any of it back — and the
-- `REVOKE ALL … FROM public` that six RPCs carry removes the PUBLIC entry only.
-- So all 36 functions of `public` were callable through /rest/v1/rpc/ with
-- nothing but the anon key, which ships in the app's JavaScript. Twelve of
-- them are the SECURITY DEFINER helpers the RLS policies are written with:
-- they bypass RLS by design and answer, for any uuid,
--   * which athlete a session, a slot, a set or a goal belongs to, and who
--     coaches them         (student_profile_for_*, coach_profile_for_*)
--   * whether two accounts are coach and athlete (profiles_are_coach_student)
--   * whether a program is the active one       (program_active_for_*)
-- Those uuids are in the app's URLs and in every push notification.
--
-- WHAT THIS FILE DOES.
--   1. Takes every privilege on every function of `public` away from PUBLIC,
--      `anon` and `authenticated`.
--   2. Gives `authenticated` EXECUTE back on an explicit allow-list of 19:
--      the 12 helpers the policies call (a policy runs with the privileges of
--      the user who queries the table) and the 7 RPCs the app calls. That
--      includes move_session, which never had a grant of its own.
--      The 17 trigger functions get nothing: a trigger fires whatever the
--      privileges of the user whose statement fires it. `service_role` and
--      the owner keep everything.
--   3. Changes what a function created LATER starts with. For `postgres`:
--        - in any schema, no EXECUTE for PUBLIC any more. This one has to be
--          global: the PUBLIC grant is PostgreSQL's built-in default, and a
--          per-schema default privilege can only add to it;
--        - in `public`, no EXECUTE for `anon` or `authenticated` by name.
--      A function created after this file is executable by its owner and by
--      `service_role`, until a GRANT says otherwise. That holds for one
--      created by hand in the SQL editor too.
--   4. Pins `search_path = public, pg_temp` on all 36 (L23). 25 had none and
--      ran with the caller's; 11 had `public`, which still lets a temporary
--      object of the caller shadow a table. Every reference in the 36 bodies
--      is schema-qualified today, so nothing resolves differently.
--
-- WHAT A CLIENT SEES. Signed in, with the app that is deployed today: nothing.
-- It calls the 7 RPCs, and its queries go through the 12 helpers, as before.
-- Without a session (the anon key alone):
--   * a call to any function is refused — "permission denied for function …"
--     (42501) — before the function is entered;
--   * a query on a table whose policies call a helper (exercise_slots,
--     goal_progress, session_confirmations, sessions, set_log_videos,
--     set_logs, slot_comments, slot_deviations, weeks; messages on insert) is
--     refused with the same error, where it used to answer with no row.
-- The app sends no request without a session; the one way there is an expired
-- session that could not be renewed. In that state the app deployed today
-- reads a refused draft save as "the coach took this draft over" and reloads
-- the draft from the server, where it used to keep the unsaved edits
-- (docs/runbook/migrations/03-function-grants-lockdown.md).
--
-- A WRONG ALLOW-LIST BREAKS EVERY READ AT ONCE, so this file checks itself:
-- it refuses to run when `public` holds a function it does not know or lacks
-- one it expects, and its last block reads the result back and raises — which
-- undoes everything — if the privileges or the search_path are not exactly
-- the ones meant.
--
-- Backward compatible: yes, for a signed-in client — every one ever deployed.
-- Audit:    supabase/audits/2026_10_11_03_function_grants_lockdown.audit.sql
-- Rollback: supabase/rollbacks/2026_10_11_03_function_grants_lockdown.down.sql (reopens B2/L21)
-- Runbook:  docs/runbook/migrations/03-function-grants-lockdown.md
-- ============================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
DECLARE
  -- Every function of `public`, as `name(argument types)`. The file is
  -- written for exactly these.
  v_known text[] := ARRAY[
    -- the 12 helpers the policies call
    'student_profile_for_slot(uuid)',
    'student_profile_for_session(uuid)',
    'student_profile_for_set_log(uuid)',
    'student_profile_for_goal(uuid)',
    'coach_profile_for_session(uuid)',
    'coach_profile_for_goal(uuid)',
    'profiles_are_coach_student(uuid, uuid)',
    'program_active_for_session(uuid)',
    'program_active_for_slot(uuid)',
    'program_is_own_draft(uuid)',
    'week_is_own_draft(uuid)',
    'session_is_own_draft(uuid)',
    -- the 7 RPCs the app calls
    'adopt_swap(uuid, uuid, boolean)',
    'adopt_skip(uuid, boolean)',
    'decline_promote_request(uuid)',
    'approve_program(uuid)',
    'send_back_program(uuid)',
    'save_draft_tree(jsonb)',
    'move_session(uuid, uuid, uuid[], uuid[])',
    -- the 17 trigger functions
    'handle_new_user()',
    'profiles_pin_immutable_columns()',
    'restrict_student_goal_update()',
    'pin_set_log_targets_for_student()',
    'pin_program_authoring_columns()',
    'lock_message_fields_on_update()',
    'lock_notification_fields_on_update()',
    'sync_session_performed_at()',
    'notify_coach_on_session_confirm()',
    'notify_coach_on_slot_deviation()',
    'notify_coach_on_promote_request()',
    'notify_coach_on_program_submit()',
    'notify_student_on_session_feedback()',
    'notify_recipient_on_chat_message()',
    'block_program_delete_with_logged_sets()',
    'block_week_delete_with_logged_sets()',
    'block_session_delete_with_logged_sets()'
  ];
  v_list text;
BEGIN
  -- First of all, because no other role can even look at the ledger. The
  -- default privileges below are those of the role that creates the
  -- functions, and a REVOKE only removes what the role running it granted.
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'migration 2026_10_11_03_function_grants_lockdown must be run as postgres, not as %', current_user
      USING HINT = 'Run it from the SQL editor or with `supabase db query --linked`. Nothing was changed.';
  END IF;

  -- Asked before the ledger is read: without it the answer would be
  -- "relation does not exist" instead of this one.
  IF to_regclass('app_private.app_migrations') IS NULL THEN
    RAISE EXCEPTION 'migration 2026_10_11_03_function_grants_lockdown needs 2026_10_03_02_rpc_auth_null_guard, which is not applied'
      USING ERRCODE = 'SLM02', HINT = 'Apply migrations 01 and 02 first. Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_11_03_function_grants_lockdown') THEN
    RAISE EXCEPTION 'migration 2026_10_11_03_function_grants_lockdown is already applied'
      USING ERRCODE = 'SLM01', HINT = 'Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_03_02_rpc_auth_null_guard') THEN
    RAISE EXCEPTION 'migration 2026_10_11_03_function_grants_lockdown needs 2026_10_03_02_rpc_auth_null_guard, which is not applied'
      USING ERRCODE = 'SLM02', HINT = 'Apply that file first. Nothing was changed.';
  END IF;

  -- The revoke below takes every function of `public`; the grants name 19.
  -- A function this file does not know would be closed to the app without a
  -- word — and it may be one a policy or the app calls.
  SELECT string_agg(f.signature, ', ' ORDER BY f.signature) INTO v_list
    FROM (SELECT p.proname || '(' || oidvectortypes(p.proargtypes) || ')' AS signature
            FROM pg_proc p
           WHERE p.pronamespace = 'public'::regnamespace) f
   WHERE f.signature <> ALL (v_known);
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_11_03_function_grants_lockdown does not know: %', v_list
      USING HINT = 'public holds a function this file was not written for; it would lose its grants. Nothing was changed. Stop and report.';
  END IF;

  SELECT string_agg(k.signature, ', ' ORDER BY k.signature) INTO v_list
    FROM unnest(v_known) AS k(signature)
   WHERE to_regprocedure('public.' || k.signature) IS NULL;
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_11_03_function_grants_lockdown does not find: %', v_list
      USING HINT = 'A function the app needs is not in public (or has other arguments). Nothing was changed. Stop and report.';
  END IF;

  SELECT string_agg(p.proname || ' (' || pg_get_userbyid(p.proowner) || ')', ', ' ORDER BY p.proname) INTO v_list
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND pg_get_userbyid(p.proowner) <> 'postgres';
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_11_03_function_grants_lockdown cannot change functions postgres does not own: %', v_list
      USING HINT = 'Nothing was changed. Stop and report.';
  END IF;
END
$guard$;

-- ------------------------------------------------------------
-- 1. Nobody but the owner and service_role — on every function of public.
-- ------------------------------------------------------------
REVOKE ALL ON ALL ROUTINES IN SCHEMA public FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 2. The allow-list: what a signed-in user may execute.
-- ------------------------------------------------------------
-- The helpers the RLS policies are written with. A policy is evaluated with
-- the privileges of the user who queries the table, so a helper that
-- `authenticated` cannot execute fails every query on every table whose
-- policies name it.
GRANT EXECUTE ON FUNCTION
  public.student_profile_for_slot(uuid),
  public.student_profile_for_session(uuid),
  public.student_profile_for_set_log(uuid),
  public.student_profile_for_goal(uuid),
  public.coach_profile_for_session(uuid),
  public.coach_profile_for_goal(uuid),
  public.profiles_are_coach_student(uuid, uuid),
  public.program_active_for_session(uuid),
  public.program_active_for_slot(uuid),
  public.program_is_own_draft(uuid),
  public.week_is_own_draft(uuid),
  public.session_is_own_draft(uuid)
TO authenticated;

-- The RPCs the app calls. The five coach RPCs authorize the caller themselves
-- (migration 02); save_draft_tree and move_session are SECURITY INVOKER and
-- ride the caller's RLS.
GRANT EXECUTE ON FUNCTION
  public.adopt_swap(uuid, uuid, boolean),
  public.adopt_skip(uuid, boolean),
  public.decline_promote_request(uuid),
  public.approve_program(uuid),
  public.send_back_program(uuid),
  public.save_draft_tree(jsonb),
  public.move_session(uuid, uuid, uuid[], uuid[])
TO authenticated;

-- ------------------------------------------------------------
-- 3. What a function created later starts with.
-- ------------------------------------------------------------
-- Global (no IN SCHEMA): the EXECUTE of PUBLIC is PostgreSQL's built-in
-- default, and only a global default privilege can take it away.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
-- In public: undo the part of Supabase's default that names the two roles a
-- request arrives as. service_role keeps its own.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON FUNCTIONS FROM anon, authenticated;

-- ------------------------------------------------------------
-- 4. search_path = public, pg_temp on every function.
-- ------------------------------------------------------------
-- ALTER, not CREATE OR REPLACE: no body is touched. From here on a function
-- that is re-created must repeat the clause — CREATE OR REPLACE drops a SET
-- the new text does not carry.
ALTER FUNCTION public.student_profile_for_slot(uuid)              SET search_path = public, pg_temp;
ALTER FUNCTION public.student_profile_for_session(uuid)           SET search_path = public, pg_temp;
ALTER FUNCTION public.student_profile_for_set_log(uuid)           SET search_path = public, pg_temp;
ALTER FUNCTION public.student_profile_for_goal(uuid)              SET search_path = public, pg_temp;
ALTER FUNCTION public.coach_profile_for_session(uuid)             SET search_path = public, pg_temp;
ALTER FUNCTION public.coach_profile_for_goal(uuid)                SET search_path = public, pg_temp;
ALTER FUNCTION public.profiles_are_coach_student(uuid, uuid)      SET search_path = public, pg_temp;
ALTER FUNCTION public.program_active_for_session(uuid)            SET search_path = public, pg_temp;
ALTER FUNCTION public.program_active_for_slot(uuid)               SET search_path = public, pg_temp;
ALTER FUNCTION public.program_is_own_draft(uuid)                  SET search_path = public, pg_temp;
ALTER FUNCTION public.week_is_own_draft(uuid)                     SET search_path = public, pg_temp;
ALTER FUNCTION public.session_is_own_draft(uuid)                  SET search_path = public, pg_temp;

ALTER FUNCTION public.adopt_swap(uuid, uuid, boolean)             SET search_path = public, pg_temp;
ALTER FUNCTION public.adopt_skip(uuid, boolean)                   SET search_path = public, pg_temp;
ALTER FUNCTION public.decline_promote_request(uuid)               SET search_path = public, pg_temp;
ALTER FUNCTION public.approve_program(uuid)                       SET search_path = public, pg_temp;
ALTER FUNCTION public.send_back_program(uuid)                     SET search_path = public, pg_temp;
ALTER FUNCTION public.save_draft_tree(jsonb)                      SET search_path = public, pg_temp;
ALTER FUNCTION public.move_session(uuid, uuid, uuid[], uuid[])    SET search_path = public, pg_temp;

ALTER FUNCTION public.handle_new_user()                           SET search_path = public, pg_temp;
ALTER FUNCTION public.profiles_pin_immutable_columns()            SET search_path = public, pg_temp;
ALTER FUNCTION public.restrict_student_goal_update()              SET search_path = public, pg_temp;
ALTER FUNCTION public.pin_set_log_targets_for_student()           SET search_path = public, pg_temp;
ALTER FUNCTION public.pin_program_authoring_columns()             SET search_path = public, pg_temp;
ALTER FUNCTION public.lock_message_fields_on_update()             SET search_path = public, pg_temp;
ALTER FUNCTION public.lock_notification_fields_on_update()        SET search_path = public, pg_temp;
ALTER FUNCTION public.sync_session_performed_at()                 SET search_path = public, pg_temp;
ALTER FUNCTION public.notify_coach_on_session_confirm()           SET search_path = public, pg_temp;
ALTER FUNCTION public.notify_coach_on_slot_deviation()            SET search_path = public, pg_temp;
ALTER FUNCTION public.notify_coach_on_promote_request()           SET search_path = public, pg_temp;
ALTER FUNCTION public.notify_coach_on_program_submit()            SET search_path = public, pg_temp;
ALTER FUNCTION public.notify_student_on_session_feedback()        SET search_path = public, pg_temp;
ALTER FUNCTION public.notify_recipient_on_chat_message()          SET search_path = public, pg_temp;
ALTER FUNCTION public.block_program_delete_with_logged_sets()     SET search_path = public, pg_temp;
ALTER FUNCTION public.block_week_delete_with_logged_sets()        SET search_path = public, pg_temp;
ALTER FUNCTION public.block_session_delete_with_logged_sets()     SET search_path = public, pg_temp;

-- ------------------------------------------------------------
-- 5. Read the result back. Anything else than what was meant raises, and the
--    whole file is undone: either the database is as described, or untouched.
-- ------------------------------------------------------------
DO $verify$
DECLARE
  v_allowed text[] := ARRAY[
    'student_profile_for_slot(uuid)', 'student_profile_for_session(uuid)',
    'student_profile_for_set_log(uuid)', 'student_profile_for_goal(uuid)',
    'coach_profile_for_session(uuid)', 'coach_profile_for_goal(uuid)',
    'profiles_are_coach_student(uuid, uuid)',
    'program_active_for_session(uuid)', 'program_active_for_slot(uuid)',
    'program_is_own_draft(uuid)', 'week_is_own_draft(uuid)', 'session_is_own_draft(uuid)',
    'adopt_swap(uuid, uuid, boolean)', 'adopt_skip(uuid, boolean)',
    'decline_promote_request(uuid)', 'approve_program(uuid)', 'send_back_program(uuid)',
    'save_draft_tree(jsonb)', 'move_session(uuid, uuid, uuid[], uuid[])'
  ];
  v_list text;
BEGIN
  WITH fn AS (
    SELECT p.proname || '(' || oidvectortypes(p.proargtypes) || ')' AS signature,
           has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon_may,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') AS user_may,
           p.proconfig
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
  )
  SELECT string_agg(f.signature || ': ' || f.wrong, '; ' ORDER BY f.signature) INTO v_list
    FROM (
      SELECT signature,
             concat_ws(', ',
               CASE WHEN anon_may THEN 'anon may execute it' END,
               CASE WHEN user_may AND signature <> ALL (v_allowed) THEN 'a signed-in user may execute it' END,
               CASE WHEN NOT user_may AND signature = ANY (v_allowed) THEN 'a signed-in user may NOT execute it' END,
               CASE WHEN proconfig IS NULL OR NOT ('search_path=public, pg_temp' = ANY (proconfig))
                    THEN 'search_path is not public, pg_temp' END
             ) AS wrong
        FROM fn
    ) f
   WHERE f.wrong <> '';
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_11_03_function_grants_lockdown did not get the privileges it meant: %', v_list
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;
END
$verify$;

INSERT INTO app_private.app_migrations (name)
VALUES ('2026_10_11_03_function_grants_lockdown')
RETURNING name, applied_at;

-- The header of 36 functions changed (their SET clause): PostgREST caches it.
NOTIFY pgrst, 'reload schema';

COMMIT;
