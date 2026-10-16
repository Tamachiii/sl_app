-- ============================================================
-- 25 — A coach reads a set video through its row
-- wave 3 · Checkpoint C1 · required · finding B7
--
-- THE HOLE. A coach read every file of the bucket set-videos whose first
-- folder is the profile id of one of their athletes ("Coaches read student
-- set videos", by folder). storage.objects has no foreign key to
-- set_log_videos: a file that no video names — the old file of a replace,
-- the file of a video that was deleted, an upload that was cancelled or
-- whose row was refused, each one left behind when its clean-up failed —
-- stayed in the bucket, and the coach could still list it, read it and sign
-- a link to it. The athlete had taken it out of the app; the coach had not
-- (B7).
--
-- WHAT THIS FILE DOES. The same policy, under the same name, asks one more
-- thing: a coach reads a file of set-videos when the file is in the folder
-- of one of their athletes, as before, AND a video of that athlete names it
-- — a row of set_log_videos whose storage_path is the name of the file and
-- whose set is a set of the athlete whose folder holds it
-- (public.student_profile_for_set_log). The row is read with the rights of
-- the coach: "Coaches read student set log videos" lets them read the
-- videos of their athletes of today, and no other. A file no video names is
-- the athlete's alone; a row cannot lend a coach a file of another folder.
-- After a change of coach (transfer_student, migration 10) the new coach
-- reads the files the videos of the athlete name, the former coach none —
-- as with every other row of the athlete.
--
-- WHAT IT DOES NOT TOUCH. The athlete's three policies on storage.objects:
-- they read every file of their folder, and add and remove one under a slot
-- of their own while its session is writable (migrations 08 and 17).
-- set_log_videos and its policies. No file and no row is written, moved or
-- removed: the files no video names stay where they are, and the page of
-- this migration lists them (docs/runbook/migrations/25-storage-video-policies.md,
-- "Files that no video names").
--
-- WHAT A CLIENT SEES. Nothing. The app reads the videos of a session from
-- set_log_videos and asks Storage for a signed link to the path of each
-- row: every file the coach is shown is named by a row. A link that was
-- signed before stays valid until it expires.
--
-- Backward compatible: yes, with every client ever deployed.
-- Audit:    supabase/audits/2026_10_16_25_storage_video_policies.audit.sql
-- Rollback: supabase/rollbacks/2026_10_16_25_storage_video_policies.down.sql (reopens B7)
-- Runbook:  docs/runbook/migrations/25-storage-video-policies.md
-- ============================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
DECLARE
  v_found text;
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'migration 2026_10_16_25_storage_video_policies must be run as postgres, not as %', current_user
      USING HINT = 'Run it from the SQL editor or with `supabase db query --linked`. Nothing was changed.';
  END IF;

  IF to_regclass('app_private.app_migrations') IS NULL THEN
    RAISE EXCEPTION 'migration 2026_10_16_25_storage_video_policies needs 2026_10_16_24_indexes_cleanup, which is not applied'
      USING ERRCODE = 'SLM02', HINT = 'Apply migrations 01 to 24 first. Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_16_25_storage_video_policies') THEN
    RAISE EXCEPTION 'migration 2026_10_16_25_storage_video_policies is already applied'
      USING ERRCODE = 'SLM01', HINT = 'Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_16_24_indexes_cleanup') THEN
    RAISE EXCEPTION 'migration 2026_10_16_25_storage_video_policies needs 2026_10_16_24_indexes_cleanup, which is not applied'
      USING ERRCODE = 'SLM02', HINT = 'Apply that file first. Nothing was changed.';
  END IF;

  -- The policy it rewrites, as migration 08 left it: a coach reads by folder.
  SELECT CASE
           WHEN p.oid IS NULL THEN 'it is not there'
           WHEN p.polcmd <> 'r' OR NOT p.polpermissive OR p.polroles <> ARRAY[to_regrole('authenticated')::oid]
             THEN 'it is not a permissive SELECT policy for authenticated'
           WHEN e.qual LIKE '%set_log_videos%' THEN 'it already asks set_log_videos'
           WHEN e.qual LIKE '%set-videos%' AND e.qual LIKE '%foldername(name)%' AND e.qual LIKE '%coach_id = auth.uid()%'
                AND e.qual NOT LIKE '% OR %'
             THEN NULL
           ELSE 'it reads ' || coalesce(e.qual, 'every row')
         END
    INTO v_found
    FROM (SELECT 1) AS one
    LEFT JOIN pg_policy p
      ON p.polrelid = 'storage.objects'::regclass AND p.polname = 'Coaches read student set videos'
    LEFT JOIN LATERAL (SELECT pg_get_expr(p.polqual, p.polrelid) AS qual) e ON true;
  IF v_found IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_16_25_storage_video_policies does not find the policy "Coaches read student set videos" of storage.objects as migration 08 left it: %', v_found
      USING HINT = 'Made by hand or by a file that is not in the ledger. Nothing was changed. Stop and report the full message.';
  END IF;

  -- Any other policy that reads the files of the bucket would let a coach
  -- read them whatever this one says: the policies of a table add up. The
  -- athlete's own one is known by what it asks; a policy that names no
  -- bucket reads them too.
  SELECT string_agg('"' || p.polname || '"', ', ' ORDER BY p.polname) INTO v_found
    FROM pg_policy p
    CROSS JOIN LATERAL (SELECT pg_get_expr(p.polqual, p.polrelid) AS qual) e
   WHERE p.polrelid = 'storage.objects'::regclass
     AND p.polcmd IN ('r', '*') AND p.polpermissive
     AND (e.qual IS NULL OR e.qual LIKE '%set-videos%' OR e.qual NOT LIKE '%bucket_id%')
     AND p.polname <> 'Coaches read student set videos'
     AND NOT (p.polname = 'Students read own set videos'
              AND e.qual LIKE '%set-videos%'
              AND e.qual LIKE '%(storage.foldername(name))[1] = (auth.uid())::text%'
              AND e.qual NOT LIKE '% OR %');
  IF v_found IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_16_25_storage_video_policies found a policy that reads the files of set-videos and that it does not know: %', v_found
      USING HINT = 'A coach would read every file through it, whatever this file does. Nothing was changed. Stop and report the full message.';
  END IF;

  -- What the policy is written with: a name missing would be the message of
  -- CREATE POLICY, and a helper a signed-in user may not execute would make
  -- every read of the bucket fail.
  SELECT string_agg(w.what, ', ' ORDER BY w.what) INTO v_found
    FROM (
      SELECT c.tbl || '.' || c.col AS what
        FROM (VALUES ('public.set_log_videos', 'storage_path'), ('public.set_log_videos', 'set_log_id'),
                     ('public.students', 'profile_id'), ('public.students', 'coach_id')) AS c (tbl, col)
       WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a
                          WHERE a.attrelid = to_regclass(c.tbl) AND a.attname = c.col AND NOT a.attisdropped)
      UNION ALL
      SELECT 'public.student_profile_for_set_log(uuid), executable by a signed-in user'
       WHERE to_regprocedure('public.student_profile_for_set_log(uuid)') IS NULL
          OR NOT has_function_privilege('authenticated', to_regprocedure('public.student_profile_for_set_log(uuid)'), 'EXECUTE')
      UNION ALL
      SELECT 'storage.foldername(text)'
       WHERE to_regprocedure('storage.foldername(text)') IS NULL
    ) w;
  IF v_found IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_16_25_storage_video_policies does not find what its policy is written with: %', v_found
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;
END
$guard$;

-- ------------------------------------------------------------
-- The coach's reading policy, written again under its name: by folder, as
-- before, and through a video of the athlete whose folder holds the file.
-- ------------------------------------------------------------
DROP POLICY "Coaches read student set videos" ON storage.objects;
CREATE POLICY "Coaches read student set videos"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'set-videos'
    AND (storage.foldername(name))[1] IN (
      SELECT profile_id::text FROM public.students WHERE coach_id = auth.uid()
    )
    AND EXISTS (
      SELECT 1
        FROM public.set_log_videos v
       WHERE v.storage_path = objects.name
         AND public.student_profile_for_set_log(v.set_log_id)::text = (storage.foldername(objects.name))[1]
    )
  );

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
      SELECT 'the policy "Coaches read student set videos" is not the one meant' AS wrong
       WHERE NOT EXISTS (
         SELECT 1
           FROM pg_policy p
           CROSS JOIN LATERAL (SELECT pg_get_expr(p.polqual, p.polrelid) AS qual) e
          WHERE p.polrelid = 'storage.objects'::regclass
            AND p.polname = 'Coaches read student set videos'
            AND p.polcmd = 'r' AND p.polpermissive
            AND p.polroles = ARRAY[to_regrole('authenticated')::oid]
            AND e.qual LIKE '%set-videos%'
            AND e.qual LIKE '%coach_id = auth.uid()%'
            AND e.qual LIKE '%set_log_videos v%'
            AND e.qual LIKE '%v.storage_path = objects.name%'
            AND e.qual LIKE '%student_profile_for_set_log(v.set_log_id)%'
            AND e.qual NOT LIKE '% OR %')
      UNION ALL
      SELECT 'the policies of storage.objects that name set-videos are ' || coalesce(string_agg(p.polname || ' (' || p.polcmd::text || ')', ', ' ORDER BY p.polname), 'none')
        FROM pg_policy p
       WHERE p.polrelid = 'storage.objects'::regclass
         AND (coalesce(pg_get_expr(p.polqual, p.polrelid), '') LIKE '%set-videos%'
              OR coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') LIKE '%set-videos%')
      HAVING coalesce(string_agg(p.polname || ' (' || p.polcmd::text || ')', ', ' ORDER BY p.polname), 'none')
             IS DISTINCT FROM 'Coaches read student set videos (r), Students delete own set videos (d), Students read own set videos (r), Students upload own set videos (a)'
    ) w;
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_16_25_storage_video_policies did not get what it meant: %', v_list
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;
END
$verify$;

INSERT INTO app_private.app_migrations (name)
VALUES ('2026_10_16_25_storage_video_policies')
RETURNING name, applied_at;

COMMIT;
