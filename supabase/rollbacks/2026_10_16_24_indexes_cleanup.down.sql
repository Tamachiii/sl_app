-- Rollback of 2026_10_16_24_indexes_cleanup: the nine indexes that repeat a
-- unique key are built again, the eight of the migration go, and a feedback
-- message keeps the id of its session when the session is deleted, as
-- before (N9).
--
-- !! THE SESSION IDS THE MIGRATION CLEARED DO NOT COME BACK. They named
-- !! sessions that were gone; the audit counted them (line 6).
--
-- Every app works without the migration as it did before it. There is no
-- reason to run this file other than the check of the page answering BROKEN,
-- or a migration applied to the wrong project
-- (docs/runbook/migrations/24-indexes-cleanup.md).
--
-- Refused (SLM04) while the ledger records a later migration: those build on
-- this one. Roll the later ones back first, last applied first.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
DECLARE
  v_later text;
BEGIN
  IF to_regclass('app_private.app_migrations') IS NULL THEN
    RAISE EXCEPTION 'migration 2026_10_16_24_indexes_cleanup is not applied: there is no app_private.app_migrations'
      USING ERRCODE = 'SLM03', HINT = 'Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_16_24_indexes_cleanup') THEN
    RAISE EXCEPTION 'migration 2026_10_16_24_indexes_cleanup is not applied'
      USING ERRCODE = 'SLM03', HINT = 'Nothing was changed.';
  END IF;

  SELECT string_agg(name, ', ' ORDER BY name) INTO v_later
    FROM app_private.app_migrations
   WHERE substring(name from '^[0-9]{4}_[0-9]{2}_[0-9]{2}_([0-9]{2})_')::int > 24;
  IF v_later IS NOT NULL THEN
    RAISE EXCEPTION 'the ledger still records later migrations: %', v_later
      USING ERRCODE = 'SLM04', HINT = 'Roll those back first. Nothing was changed.';
  END IF;
END
$guard$;

LOCK TABLE public.students, public.weeks, public.sessions, public.session_confirmations, public.messages,
           public.exercise_slots, public.set_logs, public.set_log_videos, public.slot_comments,
           public.slot_deviations, public.goals, public.bodyweight_logs, public.client_errors
  IN ACCESS EXCLUSIVE MODE;

-- As the baseline has them.
CREATE INDEX IF NOT EXISTS idx_students_profile_id ON public.students(profile_id);
CREATE INDEX IF NOT EXISTS idx_weeks_program_id ON public.weeks(program_id);
CREATE INDEX IF NOT EXISTS idx_sessions_week_id ON public.sessions(week_id);
CREATE INDEX IF NOT EXISTS idx_set_logs_slot_id ON public.set_logs(exercise_slot_id);
CREATE INDEX IF NOT EXISTS idx_session_confirmations_session_id ON public.session_confirmations(session_id);
CREATE INDEX IF NOT EXISTS idx_slot_comments_slot_id ON public.slot_comments(exercise_slot_id);
CREATE INDEX IF NOT EXISTS idx_slot_deviations_slot_id ON public.slot_deviations(exercise_slot_id);
CREATE INDEX IF NOT EXISTS idx_set_log_videos_set_log ON public.set_log_videos(set_log_id);
CREATE INDEX IF NOT EXISTS bodyweight_logs_student_idx ON public.bodyweight_logs (student_id, logged_on DESC);

DROP INDEX IF EXISTS public.client_errors_user_created_idx;
DROP INDEX IF EXISTS public.exercise_slots_exercise_idx;
DROP INDEX IF EXISTS public.goals_coach_idx;
DROP INDEX IF EXISTS public.slot_comments_student_idx;
DROP INDEX IF EXISTS public.slot_deviations_student_idx;
DROP INDEX IF EXISTS public.slot_deviations_substitute_idx;
DROP INDEX IF EXISTS public.messages_sender_created_idx;
DROP INDEX IF EXISTS public.messages_recipient_created_idx;

-- As the baseline has it: the session of a message is put back on every
-- UPDATE, the foreign key's included.
CREATE OR REPLACE FUNCTION public.lock_message_fields_on_update()
RETURNS TRIGGER AS $$
BEGIN
  NEW.id           := OLD.id;
  NEW.sender_id    := OLD.sender_id;
  NEW.recipient_id := OLD.recipient_id;
  NEW.body         := OLD.body;
  NEW.session_id   := OLD.session_id;
  NEW.created_at   := OLD.created_at;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.lock_message_fields_on_update() FROM PUBLIC, anon, authenticated;

DELETE FROM app_private.app_migrations WHERE name = '2026_10_16_24_indexes_cleanup';

COMMIT;
