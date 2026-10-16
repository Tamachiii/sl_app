-- Rollback of 2026_10_16_25_storage_video_policies: a coach reads every file
-- of set-videos in the folder of one of their athletes again — the policy
-- "Coaches read student set videos" gets back the text migration 08 left it
-- with.
--
-- !! THIS REOPENS FINDING B7. From this file on, a coach reads, lists and
-- !! signs a link to the files no video names: the old file of a replace,
-- !! the file of a deleted video, an upload that was cancelled.
--
-- Every app works without the migration as it did before it. There is no
-- reason to run this file other than the check of the page answering
-- BROKEN — a coach who no longer reads the video of their athlete — or a
-- migration applied to the wrong project
-- (docs/runbook/migrations/25-storage-video-policies.md).
--
-- No row and no file is written or removed by this file.
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
    RAISE EXCEPTION 'migration 2026_10_16_25_storage_video_policies is not applied: there is no app_private.app_migrations'
      USING ERRCODE = 'SLM03', HINT = 'Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_16_25_storage_video_policies') THEN
    RAISE EXCEPTION 'migration 2026_10_16_25_storage_video_policies is not applied'
      USING ERRCODE = 'SLM03', HINT = 'Nothing was changed.';
  END IF;

  SELECT string_agg(name, ', ' ORDER BY name) INTO v_later
    FROM app_private.app_migrations
   WHERE substring(name from '^[0-9]{4}_[0-9]{2}_[0-9]{2}_([0-9]{2})_')::int > 25;
  IF v_later IS NOT NULL THEN
    RAISE EXCEPTION 'the ledger still records later migrations: %', v_later
      USING ERRCODE = 'SLM04', HINT = 'Roll those back first. Nothing was changed.';
  END IF;
END
$guard$;

DROP POLICY IF EXISTS "Coaches read student set videos" ON storage.objects;
CREATE POLICY "Coaches read student set videos"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'set-videos'
    AND (storage.foldername(name))[1] IN (
      SELECT profile_id::text FROM public.students WHERE coach_id = auth.uid()
    )
  );

DELETE FROM app_private.app_migrations WHERE name = '2026_10_16_25_storage_video_policies';

COMMIT;
