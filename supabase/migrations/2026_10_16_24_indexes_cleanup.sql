-- ============================================================
-- 24 — Nine indexes that repeat a unique key go; every foreign key has an
--      index; a deleted session leaves its feedback message without it
-- wave 3 · Checkpoint C1 · required · findings L28, P62 (its index half), N9
--
-- L28. Nine indexes repeat what a unique key of their table already
-- indexes — the same first column, which is all a lookup of that column
-- reads: every write of those tables updates two indexes for the work of
-- one. And seven foreign keys have no index at all: deleting the row they
-- point at reads the whole table that holds them, under a lock. This file
--   * drops the nine (idx_students_profile_id, idx_weeks_program_id,
--     idx_sessions_week_id, idx_set_logs_slot_id,
--     idx_session_confirmations_session_id, idx_slot_comments_slot_id,
--     idx_slot_deviations_slot_id, idx_set_log_videos_set_log,
--     bodyweight_logs_student_idx), after checking that the unique key that
--     stands in for each is there;
--   * indexes client_errors.user_id (with created_at, which the cap of
--     migration 22 counts by), exercise_slots.exercise_id (which the
--     policy of migration 23 reads), goals.coach_id, slot_comments.student_id,
--     slot_deviations.student_id and slot_deviations.substitute_exercise_id;
--   * P62: messages (sender_id, created_at DESC) and (recipient_id,
--     created_at DESC) — a conversation read by one side, newest first; the
--     first is also the index of the foreign key messages.sender_id.
-- The six indexes the advisors call unused stay: they wait for a few weeks
-- of the policies of wave 4 (plan, "Deferred").
--
-- N9. messages.session_id is ON DELETE SET NULL: a feedback message loses
-- the session it was about when the session is deleted. The trigger that
-- keeps a message as it was written (lock_message_fields_on_update, BEFORE
-- UPDATE) put the id back — the action of the foreign key is an UPDATE too
-- —, so the message kept the id of a session that is gone: a link to
-- nothing in the conversation, and a row that breaks its own foreign key.
-- From this file on the trigger lets session_id go to NULL when, and only
-- when, the session it names is gone; every other write keeps it, as
-- before. The messages that already name a session that is gone are given
-- what the foreign key would have given them: NULL (the audit counts them;
-- the ids do not come back with the rollback). A feedback message without
-- a session is an ordinary message: its sender may delete it.
--
-- Locks: the thirteen tables, from the top of the tree down, for the
-- time it takes to build eight indexes on tables of a few thousand rows.
--
-- Backward compatible: yes, with every client ever deployed.
-- Audit:    supabase/audits/2026_10_16_24_indexes_cleanup.audit.sql
-- Rollback: supabase/rollbacks/2026_10_16_24_indexes_cleanup.down.sql
-- Runbook:  docs/runbook/migrations/24-indexes-cleanup.md
-- ============================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
DECLARE
  v_found text;
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'migration 2026_10_16_24_indexes_cleanup must be run as postgres, not as %', current_user
      USING HINT = 'Run it from the SQL editor or with `supabase db query --linked`. Nothing was changed.';
  END IF;

  IF to_regclass('app_private.app_migrations') IS NULL THEN
    RAISE EXCEPTION 'migration 2026_10_16_24_indexes_cleanup needs 2026_10_16_23_library_read_follows_program, which is not applied'
      USING ERRCODE = 'SLM02', HINT = 'Apply migrations 01 to 23 first. Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_16_24_indexes_cleanup') THEN
    RAISE EXCEPTION 'migration 2026_10_16_24_indexes_cleanup is already applied'
      USING ERRCODE = 'SLM01', HINT = 'Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_16_23_library_read_follows_program') THEN
    RAISE EXCEPTION 'migration 2026_10_16_24_indexes_cleanup needs 2026_10_16_23_library_read_follows_program, which is not applied'
      USING ERRCODE = 'SLM02', HINT = 'Apply that file first. Nothing was changed.';
  END IF;

  -- The nine, and the unique key each one repeats. An index of one of the
  -- nine names that says something else was made by hand: it is not
  -- dropped. A unique key that is missing would leave its column without
  -- an index: nothing is dropped.
  SELECT string_agg(w.wrong, '; ' ORDER BY w.wrong) INTO v_found
    FROM (
      SELECT d.name || ' is ' || pg_get_indexdef(to_regclass('public.' || d.name)) AS wrong
        FROM (VALUES
          ('idx_students_profile_id',              'CREATE INDEX idx_students_profile_id ON public.students USING btree (profile_id)'),
          ('idx_weeks_program_id',                 'CREATE INDEX idx_weeks_program_id ON public.weeks USING btree (program_id)'),
          ('idx_sessions_week_id',                 'CREATE INDEX idx_sessions_week_id ON public.sessions USING btree (week_id)'),
          ('idx_set_logs_slot_id',                 'CREATE INDEX idx_set_logs_slot_id ON public.set_logs USING btree (exercise_slot_id)'),
          ('idx_session_confirmations_session_id', 'CREATE INDEX idx_session_confirmations_session_id ON public.session_confirmations USING btree (session_id)'),
          ('idx_slot_comments_slot_id',            'CREATE INDEX idx_slot_comments_slot_id ON public.slot_comments USING btree (exercise_slot_id)'),
          ('idx_slot_deviations_slot_id',          'CREATE INDEX idx_slot_deviations_slot_id ON public.slot_deviations USING btree (exercise_slot_id)'),
          ('idx_set_log_videos_set_log',           'CREATE INDEX idx_set_log_videos_set_log ON public.set_log_videos USING btree (set_log_id)'),
          ('bodyweight_logs_student_idx',          'CREATE INDEX bodyweight_logs_student_idx ON public.bodyweight_logs USING btree (student_id, logged_on DESC)')
        ) AS d (name, meant)
       WHERE to_regclass('public.' || d.name) IS NOT NULL
         AND pg_get_indexdef(to_regclass('public.' || d.name)) <> d.meant
      UNION ALL
      SELECT 'the unique key ' || k.name || ' is not there, or not the one meant'
        FROM (VALUES
          ('students_profile_id_key',                  'CREATE UNIQUE INDEX students_profile_id_key ON public.students USING btree (profile_id)'),
          ('weeks_program_id_week_number_key',         'CREATE UNIQUE INDEX weeks_program_id_week_number_key ON public.weeks USING btree (program_id, week_number)'),
          ('sessions_week_sort_order_unique',          'CREATE UNIQUE INDEX sessions_week_sort_order_unique ON public.sessions USING btree (week_id, sort_order)'),
          ('set_logs_exercise_slot_id_set_number_key', 'CREATE UNIQUE INDEX set_logs_exercise_slot_id_set_number_key ON public.set_logs USING btree (exercise_slot_id, set_number)'),
          ('session_confirmations_session_id_key',     'CREATE UNIQUE INDEX session_confirmations_session_id_key ON public.session_confirmations USING btree (session_id)'),
          ('slot_comments_exercise_slot_id_key',       'CREATE UNIQUE INDEX slot_comments_exercise_slot_id_key ON public.slot_comments USING btree (exercise_slot_id)'),
          ('slot_deviations_exercise_slot_id_key',     'CREATE UNIQUE INDEX slot_deviations_exercise_slot_id_key ON public.slot_deviations USING btree (exercise_slot_id)'),
          ('set_log_videos_set_log_id_key',            'CREATE UNIQUE INDEX set_log_videos_set_log_id_key ON public.set_log_videos USING btree (set_log_id)'),
          ('bodyweight_logs_student_id_logged_on_key', 'CREATE UNIQUE INDEX bodyweight_logs_student_id_logged_on_key ON public.bodyweight_logs USING btree (student_id, logged_on)')
        ) AS k (name, meant)
       WHERE NOT EXISTS (SELECT 1 FROM pg_index x
                          WHERE x.indexrelid = to_regclass('public.' || k.name)
                            AND x.indisunique AND x.indisvalid AND x.indisready
                            AND pg_get_indexdef(x.indexrelid) = k.meant)
    ) w;
  IF v_found IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_16_24_indexes_cleanup would not drop the nine: %', v_found
      USING HINT = 'Changed by hand or by a file that is not in the ledger. Nothing was changed. Stop and report the full message.';
  END IF;

  -- The eight are CREATED.
  SELECT string_agg(n.name, ', ' ORDER BY n.name) INTO v_found
    FROM (VALUES ('client_errors_user_created_idx'), ('exercise_slots_exercise_idx'), ('goals_coach_idx'),
                 ('slot_comments_student_idx'), ('slot_deviations_student_idx'), ('slot_deviations_substitute_idx'),
                 ('messages_sender_created_idx'), ('messages_recipient_created_idx')) AS n (name)
   WHERE to_regclass('public.' || n.name) IS NOT NULL;
  IF v_found IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_16_24_indexes_cleanup would not create: % is already there', v_found
      USING HINT = 'Made by hand or by a file that is not in the ledger. Nothing was changed. Stop and report.';
  END IF;

  -- lock_message_fields_on_update is REPLACED: it must be the one of the
  -- baseline, compared without regard to how it is laid out.
  SELECT CASE
           WHEN to_regprocedure('public.lock_message_fields_on_update()') IS NULL
             THEN 'public.lock_message_fields_on_update() is not there'
           WHEN (SELECT md5(regexp_replace(btrim(p.prosrc, E' \t\r\n'), '[[:space:]]+', ' ', 'g'))
                   FROM pg_proc p WHERE p.oid = to_regprocedure('public.lock_message_fields_on_update()'))
                <> 'ab63319458c5d50a0dfedd9b09f8a354'
             THEN 'public.lock_message_fields_on_update() is not the text of the baseline (md5 of its text, spaces folded: '
                  || (SELECT md5(regexp_replace(btrim(p.prosrc, E' \t\r\n'), '[[:space:]]+', ' ', 'g'))
                        FROM pg_proc p WHERE p.oid = to_regprocedure('public.lock_message_fields_on_update()'))
                  || ')'
         END
    INTO v_found;
  IF v_found IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_16_24_indexes_cleanup would not replace lock_message_fields_on_update: %', v_found
      USING HINT = 'It was written for the function of the baseline. Nothing was changed. Stop and report the full message.';
  END IF;
END
$guard$;

-- The tables, from the top of the tree down — the order of a cascade —,
-- then those beside it.
LOCK TABLE public.students, public.weeks, public.sessions, public.session_confirmations, public.messages,
           public.exercise_slots, public.set_logs, public.set_log_videos, public.slot_comments,
           public.slot_deviations, public.goals, public.bodyweight_logs, public.client_errors
  IN ACCESS EXCLUSIVE MODE;

-- ------------------------------------------------------------
-- 1. L28 — the nine that repeat a unique key.
-- ------------------------------------------------------------
DROP INDEX IF EXISTS public.idx_students_profile_id;
DROP INDEX IF EXISTS public.idx_weeks_program_id;
DROP INDEX IF EXISTS public.idx_sessions_week_id;
DROP INDEX IF EXISTS public.idx_set_logs_slot_id;
DROP INDEX IF EXISTS public.idx_session_confirmations_session_id;
DROP INDEX IF EXISTS public.idx_slot_comments_slot_id;
DROP INDEX IF EXISTS public.idx_slot_deviations_slot_id;
DROP INDEX IF EXISTS public.idx_set_log_videos_set_log;
DROP INDEX IF EXISTS public.bodyweight_logs_student_idx;

-- ------------------------------------------------------------
-- 2. L28, P62 — the foreign keys without an index, and the two sides of a
--    conversation.
-- ------------------------------------------------------------
CREATE INDEX client_errors_user_created_idx ON public.client_errors (user_id, created_at DESC);
CREATE INDEX exercise_slots_exercise_idx    ON public.exercise_slots (exercise_id);
CREATE INDEX goals_coach_idx                ON public.goals (coach_id);
CREATE INDEX slot_comments_student_idx      ON public.slot_comments (student_id);
CREATE INDEX slot_deviations_student_idx    ON public.slot_deviations (student_id);
CREATE INDEX slot_deviations_substitute_idx ON public.slot_deviations (substitute_exercise_id);
CREATE INDEX messages_sender_created_idx    ON public.messages (sender_id, created_at DESC);
CREATE INDEX messages_recipient_created_idx ON public.messages (recipient_id, created_at DESC);

-- ------------------------------------------------------------
-- 3. N9 — the session of a feedback message goes with the session.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lock_message_fields_on_update()
RETURNS TRIGGER AS $$
BEGIN
  NEW.id           := OLD.id;
  NEW.sender_id    := OLD.sender_id;
  NEW.recipient_id := OLD.recipient_id;
  NEW.body         := OLD.body;
  -- The session stays — unless it is gone: then this UPDATE is the foreign
  -- key's ON DELETE SET NULL, and NULL goes through (2026_10_16_24, review N9).
  IF NOT (NEW.session_id IS NULL
          AND OLD.session_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM public.sessions s WHERE s.id = OLD.session_id)) THEN
    NEW.session_id := OLD.session_id;
  END IF;
  NEW.created_at   := OLD.created_at;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.lock_message_fields_on_update() FROM PUBLIC, anon, authenticated;

-- What the foreign key would have done: the messages that name a session
-- that is gone. The trigger above lets it through.
UPDATE public.messages m
   SET session_id = NULL
 WHERE m.session_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.sessions s WHERE s.id = m.session_id);

-- ------------------------------------------------------------
-- The file reads its own result back.
-- ------------------------------------------------------------
DO $verify$
DECLARE
  v_list text;
BEGIN
  SELECT string_agg(w.wrong, '; ' ORDER BY w.wrong)
    INTO v_list
    FROM (
      SELECT n.name || ' is still there' AS wrong
        FROM (VALUES ('idx_students_profile_id'), ('idx_weeks_program_id'), ('idx_sessions_week_id'),
                     ('idx_set_logs_slot_id'), ('idx_session_confirmations_session_id'), ('idx_slot_comments_slot_id'),
                     ('idx_slot_deviations_slot_id'), ('idx_set_log_videos_set_log'), ('bodyweight_logs_student_idx')) AS n (name)
       WHERE to_regclass('public.' || n.name) IS NOT NULL
      UNION ALL
      SELECT n.name || ' is not there, or not valid'
        FROM (VALUES ('client_errors_user_created_idx'), ('exercise_slots_exercise_idx'), ('goals_coach_idx'),
                     ('slot_comments_student_idx'), ('slot_deviations_student_idx'), ('slot_deviations_substitute_idx'),
                     ('messages_sender_created_idx'), ('messages_recipient_created_idx')) AS n (name)
       WHERE NOT EXISTS (SELECT 1 FROM pg_index x WHERE x.indexrelid = to_regclass('public.' || n.name) AND x.indisvalid)
      UNION ALL
      -- Every foreign key of public has an index that starts with its column:
      -- a whole one, or one on the rows where the column is set.
      SELECT 'the foreign key ' || c.conname || ' has no index'
        FROM pg_constraint c
       WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
         AND NOT EXISTS (
           SELECT 1 FROM pg_index x
            WHERE x.indrelid = c.conrelid AND x.indkey[0] = c.conkey[1] AND x.indisvalid
              AND (x.indpred IS NULL
                   OR pg_get_expr(x.indpred, x.indrelid)
                      = '(' || (SELECT a.attname FROM pg_attribute a
                                 WHERE a.attrelid = c.conrelid AND a.attnum = c.conkey[1]) || ' IS NOT NULL)'))
      UNION ALL
      SELECT 'lock_message_fields_on_update() does not let the foreign key through'
        FROM pg_proc p
       WHERE p.oid = to_regprocedure('public.lock_message_fields_on_update()')
         AND (position('NOT EXISTS (SELECT 1 FROM public.sessions s WHERE s.id = OLD.session_id)' IN p.prosrc) = 0
              OR NOT p.prosecdef
              OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
      UNION ALL
      SELECT count(*) || ' messages still name a session that is gone'
        FROM public.messages m
       WHERE m.session_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM public.sessions s WHERE s.id = m.session_id)
      HAVING count(*) > 0
    ) w;
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_16_24_indexes_cleanup did not get what it meant: %', v_list
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;
END
$verify$;

INSERT INTO app_private.app_migrations (name)
VALUES ('2026_10_16_24_indexes_cleanup')
RETURNING name, applied_at;

COMMIT;
