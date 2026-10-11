-- Rollback of 2026_10_12_08_session_write_gates: gives the athlete's write
-- policies on set_logs, slot_comments, slot_deviations, set_log_videos and
-- the files of the set-videos bucket the text they had, and removes the four
-- functions.
--
-- !! IT REOPENS FINDINGS P58 AND L5. After this file an athlete can again
-- !! write the sets of a session the coach has reviewed or archived, edit a
-- !! note on a reviewed session, edit or remove a swap of an archived one,
-- !! replace or remove a video — the row and the file — on any session of
-- !! any block; and any account, one nobody coaches included, can again
-- !! upload files under its own id.
--
-- There is one reason to run it: after the migration, an athlete can no
-- longer do something on a session that is in progress, or confirmed and not
-- yet reviewed — tick a set, rate it, add a note, swap or skip an exercise,
-- add or remove an extra set, upload or replace a video. Report what was
-- being done, and re-apply the migration as soon as it is understood
-- (docs/runbook/migrations/08-session-write-gates.md).
--
-- What it does:
--   * re-creates the eleven write policies with the text of the baseline
--     ("Students manage own set log videos" is one FOR ALL policy again, and
--     the four that replaced it are dropped);
--   * drops session_writable, session_writable_for_slot, slot_for_set_log and
--     set_video_slot.
-- No table, no row and no file is touched. What was written while the gate
-- was in place is what passed it.
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
    RAISE EXCEPTION 'migration 2026_10_12_08_session_write_gates is not applied: there is no app_private.app_migrations'
      USING ERRCODE = 'SLM03', HINT = 'Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_12_08_session_write_gates') THEN
    RAISE EXCEPTION 'migration 2026_10_12_08_session_write_gates is not applied'
      USING ERRCODE = 'SLM03', HINT = 'Nothing was changed.';
  END IF;

  SELECT string_agg(name, ', ' ORDER BY name) INTO v_later
    FROM app_private.app_migrations
   WHERE substring(name from '^[0-9]{4}_[0-9]{2}_[0-9]{2}_([0-9]{2})_')::int > 8;
  IF v_later IS NOT NULL THEN
    RAISE EXCEPTION 'the ledger still records later migrations: %', v_later
      USING ERRCODE = 'SLM04', HINT = 'Roll those back first. Nothing was changed.';
  END IF;
END
$guard$;

-- ------------------------------------------------------------
-- The files: the first folder is the athlete's id, and nothing else.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "Students delete own set videos" ON storage.objects;
CREATE POLICY "Students delete own set videos"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'set-videos'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "Students upload own set videos" ON storage.objects;
CREATE POLICY "Students upload own set videos"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'set-videos'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- ------------------------------------------------------------
-- set_log_videos: one FOR ALL policy.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "Students delete own set log videos" ON public.set_log_videos;
DROP POLICY IF EXISTS "Students update own set log videos" ON public.set_log_videos;
DROP POLICY IF EXISTS "Students insert own set log videos" ON public.set_log_videos;
DROP POLICY IF EXISTS "Students read own set log videos" ON public.set_log_videos;

DROP POLICY IF EXISTS "Students manage own set log videos" ON public.set_log_videos;
CREATE POLICY "Students manage own set log videos"
  ON public.set_log_videos FOR ALL
  USING (public.student_profile_for_set_log(set_log_id) = auth.uid())
  WITH CHECK (public.student_profile_for_set_log(set_log_id) = auth.uid());

-- ------------------------------------------------------------
-- slot_deviations: "not archived" on INSERT only.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "Students insert own slot deviations" ON public.slot_deviations;
CREATE POLICY "Students insert own slot deviations"
  ON public.slot_deviations FOR INSERT
  WITH CHECK (
    student_id = auth.uid()
    AND public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND NOT EXISTS (
      SELECT 1 FROM public.exercise_slots es
      JOIN public.sessions s ON s.id = es.session_id
      WHERE es.id = slot_deviations.exercise_slot_id AND s.archived_at IS NOT NULL
    )
    AND public.program_active_for_slot(exercise_slot_id) = true
  );

DROP POLICY IF EXISTS "Students update own slot deviations" ON public.slot_deviations;
CREATE POLICY "Students update own slot deviations"
  ON public.slot_deviations FOR UPDATE
  USING (
    student_id = auth.uid()
    AND public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND public.program_active_for_slot(exercise_slot_id) = true
  )
  WITH CHECK (
    student_id = auth.uid()
    AND public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND public.program_active_for_slot(exercise_slot_id) = true
  );

DROP POLICY IF EXISTS "Students delete own slot deviations" ON public.slot_deviations;
CREATE POLICY "Students delete own slot deviations"
  ON public.slot_deviations FOR DELETE
  USING (
    student_id = auth.uid()
    AND public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND public.program_active_for_slot(exercise_slot_id) = true
  );

-- ------------------------------------------------------------
-- slot_comments: "not archived", and nothing about the review.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "Students insert own slot comments" ON public.slot_comments;
CREATE POLICY "Students insert own slot comments"
  ON public.slot_comments FOR INSERT
  WITH CHECK (
    student_id = auth.uid()
    AND public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND NOT EXISTS (
      SELECT 1 FROM public.exercise_slots es
      JOIN public.sessions s ON s.id = es.session_id
      WHERE es.id = slot_comments.exercise_slot_id AND s.archived_at IS NOT NULL
    )
    AND public.program_active_for_slot(exercise_slot_id) = true
  );

DROP POLICY IF EXISTS "Students update own slot comments" ON public.slot_comments;
CREATE POLICY "Students update own slot comments"
  ON public.slot_comments FOR UPDATE
  USING (
    student_id = auth.uid()
    AND public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND NOT EXISTS (
      SELECT 1 FROM public.exercise_slots es
      JOIN public.sessions s ON s.id = es.session_id
      WHERE es.id = slot_comments.exercise_slot_id AND s.archived_at IS NOT NULL
    )
    AND public.program_active_for_slot(exercise_slot_id) = true
  )
  WITH CHECK (
    student_id = auth.uid()
    AND public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND NOT EXISTS (
      SELECT 1 FROM public.exercise_slots es
      JOIN public.sessions s ON s.id = es.session_id
      WHERE es.id = slot_comments.exercise_slot_id AND s.archived_at IS NOT NULL
    )
    AND public.program_active_for_slot(exercise_slot_id) = true
  );

DROP POLICY IF EXISTS "Students delete own slot comments" ON public.slot_comments;
CREATE POLICY "Students delete own slot comments"
  ON public.slot_comments FOR DELETE
  USING (
    student_id = auth.uid()
    AND public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND NOT EXISTS (
      SELECT 1 FROM public.exercise_slots es
      JOIN public.sessions s ON s.id = es.session_id
      WHERE es.id = slot_comments.exercise_slot_id AND s.archived_at IS NOT NULL
    )
    AND public.program_active_for_slot(exercise_slot_id) = true
  );

-- ------------------------------------------------------------
-- set_logs: own set, program active, and nothing about the session.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "Students insert own set logs" ON public.set_logs;
CREATE POLICY "Students insert own set logs"
  ON public.set_logs FOR INSERT
  WITH CHECK (
    public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND public.program_active_for_slot(exercise_slot_id) = true
  );

DROP POLICY IF EXISTS "Students update own set logs" ON public.set_logs;
CREATE POLICY "Students update own set logs"
  ON public.set_logs FOR UPDATE
  USING (
    public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND public.program_active_for_slot(exercise_slot_id) = true
  )
  WITH CHECK (
    public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND public.program_active_for_slot(exercise_slot_id) = true
  );

DROP POLICY IF EXISTS "Students delete own set logs" ON public.set_logs;
CREATE POLICY "Students delete own set logs"
  ON public.set_logs FOR DELETE
  USING (
    public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND public.program_active_for_slot(exercise_slot_id) = true
    AND is_student_added = true
  );

-- ------------------------------------------------------------
-- No policy reads them any more.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.set_video_slot(text);
DROP FUNCTION IF EXISTS public.slot_for_set_log(uuid);
DROP FUNCTION IF EXISTS public.session_writable_for_slot(uuid);
DROP FUNCTION IF EXISTS public.session_writable(uuid);

DELETE FROM app_private.app_migrations WHERE name = '2026_10_12_08_session_write_gates';

-- Functions left public: PostgREST has to forget them.
NOTIFY pgrst, 'reload schema';

COMMIT;
