-- Rollback of 2026_10_11_03_function_grants_lockdown: gives the 36 functions of
-- `public`, and the default privileges of `postgres`, back what they had
-- before.
--
-- !! IT REOPENS FINDINGS B2 / L21. After this file, anyone holding the anon
-- !! key can again call every function of `public` without signing in — the
-- !! helpers that say whom a session, a slot, a set or a goal belongs to
-- !! included — and a function created later is open to everyone again.
--
-- There is one reason to run it: after the migration, the app (signed in)
-- answers "permission denied for function …" somewhere. Report which function,
-- and re-apply the migration as soon as it is understood
-- (docs/runbook/migrations/03-function-grants-lockdown.md).
--
-- "What they had before" is the state of the repository before the migration
-- (supabase/tests/fixtures/prod_baseline_2026_09_30.sql), function by
-- function:
--   * EXECUTE for anon and authenticated on all 36;
--   * EXECUTE for PUBLIC on 30 — not on the six RPCs that carried
--     `REVOKE ALL … FROM public`;
--   * no search_path on 25, `search_path = public` on 11;
--   * a new function of postgres in public executable by PUBLIC, anon,
--     authenticated and service_role.
--
-- Refused (SLM04) while the ledger records a later migration: those create
-- functions with grants of their own and re-create some of these 36 with the
-- search_path this file would take away. Roll the later ones back first, last
-- applied first.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
DECLARE
  v_later text;
BEGIN
  -- Two questions, in this order: the second cannot be asked without a ledger.
  IF to_regclass('app_private.app_migrations') IS NULL THEN
    RAISE EXCEPTION 'migration 2026_10_11_03_function_grants_lockdown is not applied: there is no app_private.app_migrations'
      USING ERRCODE = 'SLM03', HINT = 'Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_11_03_function_grants_lockdown') THEN
    RAISE EXCEPTION 'migration 2026_10_11_03_function_grants_lockdown is not applied'
      USING ERRCODE = 'SLM03', HINT = 'Nothing was changed.';
  END IF;

  SELECT string_agg(name, ', ' ORDER BY name) INTO v_later
    FROM app_private.app_migrations
   WHERE substring(name from '^[0-9]{4}_[0-9]{2}_[0-9]{2}_([0-9]{2})_')::int > 3;
  IF v_later IS NOT NULL THEN
    RAISE EXCEPTION 'the ledger still records later migrations: %', v_later
      USING ERRCODE = 'SLM04', HINT = 'Roll those back first. Nothing was changed.';
  END IF;
END
$guard$;

-- ------------------------------------------------------------
-- What a function created later starts with: as Supabase set it up.
-- ------------------------------------------------------------
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON FUNCTIONS TO anon, authenticated;
-- Back to PostgreSQL's built-in default, which removes the global entry.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  GRANT EXECUTE ON FUNCTIONS TO PUBLIC;

-- ------------------------------------------------------------
-- anon and authenticated: EXECUTE on all 36, by name.
-- ------------------------------------------------------------
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
  public.session_is_own_draft(uuid),
  public.adopt_swap(uuid, uuid, boolean),
  public.adopt_skip(uuid, boolean),
  public.decline_promote_request(uuid),
  public.approve_program(uuid),
  public.send_back_program(uuid),
  public.save_draft_tree(jsonb),
  public.move_session(uuid, uuid, uuid[], uuid[]),
  public.handle_new_user(),
  public.profiles_pin_immutable_columns(),
  public.restrict_student_goal_update(),
  public.pin_set_log_targets_for_student(),
  public.pin_program_authoring_columns(),
  public.lock_message_fields_on_update(),
  public.lock_notification_fields_on_update(),
  public.sync_session_performed_at(),
  public.notify_coach_on_session_confirm(),
  public.notify_coach_on_slot_deviation(),
  public.notify_coach_on_promote_request(),
  public.notify_coach_on_program_submit(),
  public.notify_student_on_session_feedback(),
  public.notify_recipient_on_chat_message(),
  public.block_program_delete_with_logged_sets(),
  public.block_week_delete_with_logged_sets(),
  public.block_session_delete_with_logged_sets()
TO anon, authenticated;

-- ------------------------------------------------------------
-- PUBLIC: on the 30 that never revoked it. The six that did — adopt_swap,
-- adopt_skip, decline_promote_request, approve_program, send_back_program,
-- save_draft_tree — stay without.
-- ------------------------------------------------------------
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
  public.session_is_own_draft(uuid),
  public.move_session(uuid, uuid, uuid[], uuid[]),
  public.handle_new_user(),
  public.profiles_pin_immutable_columns(),
  public.restrict_student_goal_update(),
  public.pin_set_log_targets_for_student(),
  public.pin_program_authoring_columns(),
  public.lock_message_fields_on_update(),
  public.lock_notification_fields_on_update(),
  public.sync_session_performed_at(),
  public.notify_coach_on_session_confirm(),
  public.notify_coach_on_slot_deviation(),
  public.notify_coach_on_promote_request(),
  public.notify_coach_on_program_submit(),
  public.notify_student_on_session_feedback(),
  public.notify_recipient_on_chat_message(),
  public.block_program_delete_with_logged_sets(),
  public.block_week_delete_with_logged_sets(),
  public.block_session_delete_with_logged_sets()
TO PUBLIC;

-- ------------------------------------------------------------
-- search_path: none on the 25 that had none…
-- ------------------------------------------------------------
ALTER FUNCTION public.student_profile_for_slot(uuid)              RESET search_path;
ALTER FUNCTION public.student_profile_for_session(uuid)           RESET search_path;
ALTER FUNCTION public.student_profile_for_set_log(uuid)           RESET search_path;
ALTER FUNCTION public.student_profile_for_goal(uuid)              RESET search_path;
ALTER FUNCTION public.coach_profile_for_session(uuid)             RESET search_path;
ALTER FUNCTION public.coach_profile_for_goal(uuid)                RESET search_path;
ALTER FUNCTION public.profiles_are_coach_student(uuid, uuid)      RESET search_path;
ALTER FUNCTION public.program_active_for_session(uuid)            RESET search_path;
ALTER FUNCTION public.program_active_for_slot(uuid)               RESET search_path;

ALTER FUNCTION public.handle_new_user()                           RESET search_path;
ALTER FUNCTION public.profiles_pin_immutable_columns()            RESET search_path;
ALTER FUNCTION public.restrict_student_goal_update()              RESET search_path;
ALTER FUNCTION public.pin_set_log_targets_for_student()           RESET search_path;
ALTER FUNCTION public.pin_program_authoring_columns()             RESET search_path;
ALTER FUNCTION public.lock_message_fields_on_update()             RESET search_path;
ALTER FUNCTION public.lock_notification_fields_on_update()        RESET search_path;
ALTER FUNCTION public.sync_session_performed_at()                 RESET search_path;
ALTER FUNCTION public.notify_coach_on_session_confirm()           RESET search_path;
ALTER FUNCTION public.notify_coach_on_slot_deviation()            RESET search_path;
ALTER FUNCTION public.notify_coach_on_promote_request()           RESET search_path;
ALTER FUNCTION public.notify_student_on_session_feedback()        RESET search_path;
ALTER FUNCTION public.notify_recipient_on_chat_message()          RESET search_path;
ALTER FUNCTION public.block_program_delete_with_logged_sets()     RESET search_path;
ALTER FUNCTION public.block_week_delete_with_logged_sets()        RESET search_path;
ALTER FUNCTION public.block_session_delete_with_logged_sets()     RESET search_path;

-- …and `public` on the 11 that had it.
ALTER FUNCTION public.program_is_own_draft(uuid)                  SET search_path = public;
ALTER FUNCTION public.week_is_own_draft(uuid)                     SET search_path = public;
ALTER FUNCTION public.session_is_own_draft(uuid)                  SET search_path = public;
ALTER FUNCTION public.adopt_swap(uuid, uuid, boolean)             SET search_path = public;
ALTER FUNCTION public.adopt_skip(uuid, boolean)                   SET search_path = public;
ALTER FUNCTION public.decline_promote_request(uuid)               SET search_path = public;
ALTER FUNCTION public.approve_program(uuid)                       SET search_path = public;
ALTER FUNCTION public.send_back_program(uuid)                     SET search_path = public;
ALTER FUNCTION public.save_draft_tree(jsonb)                      SET search_path = public;
ALTER FUNCTION public.move_session(uuid, uuid, uuid[], uuid[])    SET search_path = public;
ALTER FUNCTION public.notify_coach_on_program_submit()            SET search_path = public;

DELETE FROM app_private.app_migrations WHERE name = '2026_10_11_03_function_grants_lockdown';

-- The SET clause is part of a function's header, which PostgREST caches.
NOTIFY pgrst, 'reload schema';

COMMIT;
