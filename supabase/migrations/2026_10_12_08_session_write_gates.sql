-- ============================================================
-- 08 — Archived and reviewed sessions are read-only for the athlete
-- wave 1 · Checkpoint A2 · required · findings P58, L5 (the upload policy)
--
-- THE HOLE. "A session the coach archived is read-only" and "a session the
-- coach reviewed is what the coach saw" were rules of the app's screens. In
-- the database an athlete wrote five things, and the state of the session was
-- asked of almost none:
--   * set_logs       — own set, program active. Not archived, not reviewed:
--     a second device that still shows the session open kept ticking sets,
--     rating them and logging actuals on rows the coach had already reviewed.
--   * slot_comments  — not archived was asked; reviewed was not.
--   * slot_deviations — not archived on INSERT only: a swap or a skip of an
--     archived session could be edited and removed.
--   * set_log_videos — own set, and nothing else: one FOR ALL policy. A video
--     could be replaced or removed on any session, of any block, at any time.
--   * the files of the set-videos bucket — the first folder of the path is
--     the athlete's id, and nothing else. Any account, one nobody coaches
--     included, uploaded what it liked under its own id (L5), and an athlete
--     removed the file of a video the coach had reviewed.
-- Nothing told the coach: no notification is sent for any of these writes.
--
-- WHAT THIS FILE DOES.
--   1. public.session_writable(session) and
--      public.session_writable_for_slot(slot): is the session open for its
--      athlete — not archived, not reviewed. Whether the PROGRAM is the block
--      being trained stays the question of program_active_for_slot /
--      program_active_for_session; an athlete's write asks three things: the
--      row is mine, my program is the active one, the session is writable.
--   2. The athlete's write policies on set_logs, slot_comments and
--      slot_deviations ask the three. Reading is what it was.
--   3. set_log_videos: the FOR ALL policy becomes four. Reading is what it
--      was; adding, changing and removing a video ask the three — and the
--      path of the file is <athlete>/<exercise slot of the set>/<file>, which
--      is where the app has always stored it.
--   4. The files: an athlete adds and removes a file only at
--      <their id>/<a slot of theirs, in a writable session of their active
--      program>/<file>. Reading — theirs and the coach's — is what it was.
--
-- THE GATE IS reviewed_at, NOT THE CONFIRMATION. A confirmed session that the
-- coach has not reviewed yet is still written: the app queues the sets logged
-- offline one by one and the confirmation separately, and a set may arrive
-- after the confirmation it belongs to.
--
-- WHAT A CLIENT SEES. With the app that is deployed today:
--   * a session in progress, and one that is confirmed and not yet reviewed:
--     nothing changes.
--   * a session the coach reviewed or archived, written from a screen that
--     still shows it open (a second device, a tab left open): a set shows
--     "Couldn't save that. Please try again." and goes back to what it was; a
--     note or a swap shows "You don't have permission to do that."; an upload
--     shows its error. Removing a note, a swap or a video there shows nothing
--     and removes nothing: it is back after the next refresh.
--   * the coach: nothing changes. The editor, the review, Adopt, Remove from
--     upcoming and Decline work on a reviewed session as before.
--
-- No row of the app is written by this file, and no file of the bucket.
--
-- Backward compatible: yes, with every client ever deployed.
-- Audit:    supabase/audits/2026_10_12_08_session_write_gates.audit.sql
-- Rollback: supabase/rollbacks/2026_10_12_08_session_write_gates.down.sql (reopens P58 / L5)
-- Runbook:  docs/runbook/migrations/08-session-write-gates.md
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
    RAISE EXCEPTION 'migration 2026_10_12_08_session_write_gates must be run as postgres, not as %', current_user
      USING HINT = 'Run it from the SQL editor or with `supabase db query --linked`. Nothing was changed.';
  END IF;

  -- Asked before the ledger is read: without it the answer would be
  -- "relation does not exist" instead of this one.
  IF to_regclass('app_private.app_migrations') IS NULL THEN
    RAISE EXCEPTION 'migration 2026_10_12_08_session_write_gates needs 2026_10_11_07_profile_rules, which is not applied'
      USING ERRCODE = 'SLM02', HINT = 'Apply migrations 01 to 07 first. Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_12_08_session_write_gates') THEN
    RAISE EXCEPTION 'migration 2026_10_12_08_session_write_gates is already applied'
      USING ERRCODE = 'SLM01', HINT = 'Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_11_07_profile_rules') THEN
    RAISE EXCEPTION 'migration 2026_10_12_08_session_write_gates needs 2026_10_11_07_profile_rules, which is not applied'
      USING ERRCODE = 'SLM02', HINT = 'Apply that file first. Nothing was changed.';
  END IF;

  -- CREATE OR REPLACE replaces a function with the SAME argument types. A
  -- copy of one of these with other arguments would stay next to the new one,
  -- and nothing would say so.
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text)
    INTO v_strangers
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('session_writable', 'session_writable_for_slot',
                       'slot_for_set_log', 'set_video_slot')
     -- By oid, names written with their schema: the answer must not depend on
     -- the search_path of whoever runs the file.
     AND NOT EXISTS (
       SELECT 1
         FROM unnest(ARRAY[
                'public.session_writable(uuid)',
                'public.session_writable_for_slot(uuid)',
                'public.slot_for_set_log(uuid)',
                'public.set_video_slot(text)'
              ]) AS known(signature)
        WHERE to_regprocedure(known.signature) = p.oid
     );
  IF v_strangers IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_12_08_session_write_gates would not replace: %', v_strangers
      USING HINT = 'A function of this file exists with other arguments. Nothing was changed. Stop and report.';
  END IF;
END
$guard$;

-- ------------------------------------------------------------
-- 1. Is this session open for its athlete?
-- ------------------------------------------------------------
-- The session's own lock, in ONE place: the coach has not archived it and has
-- not reviewed it. reviewed_at, not the confirmation: a set logged offline
-- may be replayed after the confirmation of its session.
--
-- It says nothing about the program. "Is this program the block being
-- trained" is program_active_for_session / program_active_for_slot, and an
-- athlete's write asks both, next to "is this row mine":
--     student_profile_for_slot(x) = auth.uid()
--     AND program_active_for_slot(x) = true
--     AND session_writable_for_slot(x)
--
-- Never NULL: a session that does not exist is not writable. So
-- `IF NOT public.session_writable(x) THEN RAISE` refuses what it should.
--
-- SECURITY DEFINER, like the other helpers the policies are written with: it
-- must not depend on what the caller may read, and a policy that reached
-- sessions through its own sub-select would be judged by the policies of
-- sessions in turn.
--
-- session_writable(session) is not called by a policy yet, so a signed-in
-- user gets no EXECUTE on it: session_writable_for_slot calls it as its
-- owner.
CREATE OR REPLACE FUNCTION public.session_writable(sess_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE((
    SELECT s.archived_at IS NULL AND s.reviewed_at IS NULL
      FROM public.sessions s
     WHERE s.id = sess_id
  ), false)
$$;

REVOKE ALL ON FUNCTION public.session_writable(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.session_writable_for_slot(slot_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE((
    SELECT public.session_writable(es.session_id)
      FROM public.exercise_slots es
     WHERE es.id = slot_id
  ), false)
$$;

REVOKE ALL ON FUNCTION public.session_writable_for_slot(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.session_writable_for_slot(uuid) TO authenticated;

-- The exercise slot a set belongs to. A video is attached to a set, and the
-- three questions are asked of its slot: the policies of set_log_videos reach
-- it through this, as their SELECT reaches the athlete through
-- student_profile_for_set_log. NULL for a set that does not exist — and every
-- question asked of NULL is answered "no".
CREATE OR REPLACE FUNCTION public.slot_for_set_log(log_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT sl.exercise_slot_id
    FROM public.set_logs sl
   WHERE sl.id = log_id
$$;

REVOKE ALL ON FUNCTION public.slot_for_set_log(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.slot_for_set_log(uuid) TO authenticated;

-- The exercise slot the path of a video names:
--     <athlete's profile id>/<exercise slot id>/<set number>-<uuid>.<ext>
-- its second folder. NULL when the path has no second folder or when that
-- folder is not a uuid as PostgreSQL prints one (lower case, with dashes) —
-- so a policy answers "no" to a path of another shape instead of failing on
-- a cast.
-- "Folder" as storage.foldername() means it: everything but the last part.
CREATE OR REPLACE FUNCTION public.set_video_slot(object_name text)
RETURNS uuid
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
           WHEN cardinality(string_to_array(object_name, '/')) >= 3
            AND (string_to_array(object_name, '/'))[2]
                ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           THEN (string_to_array(object_name, '/'))[2]::uuid
         END
$$;

REVOKE ALL ON FUNCTION public.set_video_slot(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_video_slot(text) TO authenticated;

-- ------------------------------------------------------------
-- 2. A set: logged, added and removed in a writable session only.
-- ------------------------------------------------------------
-- "Students read own set logs" and the coach's policy are not touched.
DROP POLICY IF EXISTS "Students insert own set logs" ON public.set_logs;
CREATE POLICY "Students insert own set logs"
  ON public.set_logs FOR INSERT
  WITH CHECK (
    public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND public.program_active_for_slot(exercise_slot_id) = true
    AND public.session_writable_for_slot(exercise_slot_id)
  );

DROP POLICY IF EXISTS "Students update own set logs" ON public.set_logs;
CREATE POLICY "Students update own set logs"
  ON public.set_logs FOR UPDATE
  USING (
    public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND public.program_active_for_slot(exercise_slot_id) = true
    AND public.session_writable_for_slot(exercise_slot_id)
  )
  WITH CHECK (
    public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND public.program_active_for_slot(exercise_slot_id) = true
    AND public.session_writable_for_slot(exercise_slot_id)
  );

-- Their own extra sets only, as before (2026_07_12).
DROP POLICY IF EXISTS "Students delete own set logs" ON public.set_logs;
CREATE POLICY "Students delete own set logs"
  ON public.set_logs FOR DELETE
  USING (
    public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND public.program_active_for_slot(exercise_slot_id) = true
    AND public.session_writable_for_slot(exercise_slot_id)
    AND is_student_added = true
  );

-- ------------------------------------------------------------
-- 3. A note on an exercise.
-- ------------------------------------------------------------
-- "Not archived" was a sub-select on exercise_slots and sessions in each of
-- the three; session_writable_for_slot says it, and "not reviewed" with it.
DROP POLICY IF EXISTS "Students insert own slot comments" ON public.slot_comments;
CREATE POLICY "Students insert own slot comments"
  ON public.slot_comments FOR INSERT
  WITH CHECK (
    student_id = auth.uid()
    AND public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND public.program_active_for_slot(exercise_slot_id) = true
    AND public.session_writable_for_slot(exercise_slot_id)
  );

DROP POLICY IF EXISTS "Students update own slot comments" ON public.slot_comments;
CREATE POLICY "Students update own slot comments"
  ON public.slot_comments FOR UPDATE
  USING (
    student_id = auth.uid()
    AND public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND public.program_active_for_slot(exercise_slot_id) = true
    AND public.session_writable_for_slot(exercise_slot_id)
  )
  WITH CHECK (
    student_id = auth.uid()
    AND public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND public.program_active_for_slot(exercise_slot_id) = true
    AND public.session_writable_for_slot(exercise_slot_id)
  );

DROP POLICY IF EXISTS "Students delete own slot comments" ON public.slot_comments;
CREATE POLICY "Students delete own slot comments"
  ON public.slot_comments FOR DELETE
  USING (
    student_id = auth.uid()
    AND public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND public.program_active_for_slot(exercise_slot_id) = true
    AND public.session_writable_for_slot(exercise_slot_id)
  );

-- ------------------------------------------------------------
-- 4. A swap or a skip of an exercise.
-- ------------------------------------------------------------
-- UPDATE and DELETE did not ask about the session at all. The coach's side —
-- adopt_swap, adopt_skip, decline_promote_request — is SECURITY DEFINER and
-- does not come through these.
DROP POLICY IF EXISTS "Students insert own slot deviations" ON public.slot_deviations;
CREATE POLICY "Students insert own slot deviations"
  ON public.slot_deviations FOR INSERT
  WITH CHECK (
    student_id = auth.uid()
    AND public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND public.program_active_for_slot(exercise_slot_id) = true
    AND public.session_writable_for_slot(exercise_slot_id)
  );

DROP POLICY IF EXISTS "Students update own slot deviations" ON public.slot_deviations;
CREATE POLICY "Students update own slot deviations"
  ON public.slot_deviations FOR UPDATE
  USING (
    student_id = auth.uid()
    AND public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND public.program_active_for_slot(exercise_slot_id) = true
    AND public.session_writable_for_slot(exercise_slot_id)
  )
  WITH CHECK (
    student_id = auth.uid()
    AND public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND public.program_active_for_slot(exercise_slot_id) = true
    AND public.session_writable_for_slot(exercise_slot_id)
  );

DROP POLICY IF EXISTS "Students delete own slot deviations" ON public.slot_deviations;
CREATE POLICY "Students delete own slot deviations"
  ON public.slot_deviations FOR DELETE
  USING (
    student_id = auth.uid()
    AND public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND public.program_active_for_slot(exercise_slot_id) = true
    AND public.session_writable_for_slot(exercise_slot_id)
  );

-- ------------------------------------------------------------
-- 5. The video of a set: the row.
-- ------------------------------------------------------------
-- One FOR ALL policy becomes four. Reading stays open — an athlete watches
-- the videos of every session they ever trained. Writing asks the three
-- questions of the slot of the set.
--
-- A row that is added or changed also says where its file is, and that is not
-- the athlete's to choose: <their id>/<the slot of this set>/<file>. The file
-- policies below judge a file by the slot its path names; a row free to point
-- at a file under ANOTHER slot — one of a session still to come — would leave
-- that file replaceable after the review of this one.
DROP POLICY IF EXISTS "Students manage own set log videos" ON public.set_log_videos;

DROP POLICY IF EXISTS "Students read own set log videos" ON public.set_log_videos;
CREATE POLICY "Students read own set log videos"
  ON public.set_log_videos FOR SELECT
  USING (public.student_profile_for_set_log(set_log_id) = auth.uid());

DROP POLICY IF EXISTS "Students insert own set log videos" ON public.set_log_videos;
CREATE POLICY "Students insert own set log videos"
  ON public.set_log_videos FOR INSERT
  WITH CHECK (
    public.student_profile_for_set_log(set_log_id) = auth.uid()
    AND public.program_active_for_slot(public.slot_for_set_log(set_log_id)) = true
    AND public.session_writable_for_slot(public.slot_for_set_log(set_log_id))
    AND split_part(storage_path, '/', 1) = auth.uid()::text
    AND public.set_video_slot(storage_path) = public.slot_for_set_log(set_log_id)
  );

DROP POLICY IF EXISTS "Students update own set log videos" ON public.set_log_videos;
CREATE POLICY "Students update own set log videos"
  ON public.set_log_videos FOR UPDATE
  USING (
    public.student_profile_for_set_log(set_log_id) = auth.uid()
    AND public.program_active_for_slot(public.slot_for_set_log(set_log_id)) = true
    AND public.session_writable_for_slot(public.slot_for_set_log(set_log_id))
  )
  WITH CHECK (
    public.student_profile_for_set_log(set_log_id) = auth.uid()
    AND public.program_active_for_slot(public.slot_for_set_log(set_log_id)) = true
    AND public.session_writable_for_slot(public.slot_for_set_log(set_log_id))
    AND split_part(storage_path, '/', 1) = auth.uid()::text
    AND public.set_video_slot(storage_path) = public.slot_for_set_log(set_log_id)
  );

DROP POLICY IF EXISTS "Students delete own set log videos" ON public.set_log_videos;
CREATE POLICY "Students delete own set log videos"
  ON public.set_log_videos FOR DELETE
  USING (
    public.student_profile_for_set_log(set_log_id) = auth.uid()
    AND public.program_active_for_slot(public.slot_for_set_log(set_log_id)) = true
    AND public.session_writable_for_slot(public.slot_for_set_log(set_log_id))
  );

-- ------------------------------------------------------------
-- 6. The video of a set: the file.
-- ------------------------------------------------------------
-- A file is added, and removed, at
--     <the athlete's id>/<a slot of theirs>/<file>
-- while that slot's program is the block being trained and its session is
-- writable. So: an account nobody coaches has no slot and uploads nothing
-- (L5); nobody uploads under another athlete's exercise; and the file of a
-- reviewed or archived session stays where it is.
-- There is no UPDATE policy, as before: a file is not overwritten or renamed.
-- The two SELECT policies — the athlete's own folder, the coach's athletes —
-- are not touched.
DROP POLICY IF EXISTS "Students upload own set videos" ON storage.objects;
CREATE POLICY "Students upload own set videos"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'set-videos'
    AND (storage.foldername(name))[1] = auth.uid()::text
    AND public.student_profile_for_slot(public.set_video_slot(name)) = auth.uid()
    AND public.program_active_for_slot(public.set_video_slot(name)) = true
    AND public.session_writable_for_slot(public.set_video_slot(name))
  );

DROP POLICY IF EXISTS "Students delete own set videos" ON storage.objects;
CREATE POLICY "Students delete own set videos"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'set-videos'
    AND (storage.foldername(name))[1] = auth.uid()::text
    AND public.student_profile_for_slot(public.set_video_slot(name)) = auth.uid()
    AND public.program_active_for_slot(public.set_video_slot(name)) = true
    AND public.session_writable_for_slot(public.set_video_slot(name))
  );

-- ------------------------------------------------------------
-- 7. Read the result back. Anything else than what was meant raises, and the
--    whole file is undone: either the database is as described, or untouched.
-- ------------------------------------------------------------
DO $verify$
DECLARE
  v_list text;
BEGIN
  -- The four functions: owned by postgres, search_path pinned, closed to a
  -- request without a session, and open to a signed-in user exactly where a
  -- policy calls it.
  WITH wanted (signature, for_users, definer) AS (
    VALUES ('public.session_writable(uuid)',          false, true),
           ('public.session_writable_for_slot(uuid)', true,  true),
           ('public.slot_for_set_log(uuid)',          true,  true),
           ('public.set_video_slot(text)',            true,  false)
  ),
  found AS (
    SELECT w.signature, w.for_users, w.definer, p.oid, p.proowner, p.proconfig, p.prosecdef
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
               CASE WHEN prosecdef AND NOT definer THEN 'it runs as its owner' END,
               CASE WHEN NOT prosecdef AND definer THEN 'it does not run as its owner' END,
               CASE WHEN proconfig IS NULL OR NOT ('search_path=public, pg_temp' = ANY (proconfig))
                    THEN 'search_path is not public, pg_temp' END
             ) END AS wrong
        FROM found
    ) f
   WHERE f.wrong <> '';
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_12_08_session_write_gates did not get the functions it meant: %', v_list
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;

  -- The policies. On each of the five tables, the policies that WRITE are the
  -- ones of this list and no other: a policy this file does not know — one
  -- made by hand, under another name — would leave open the door it closes.
  -- `gated`: it is an athlete's, and asks whether the session is writable
  -- wherever it judges a row (USING for a row that is there, WITH CHECK for
  -- the row that is written).
  WITH wanted (tbl, name, cmd, gated) AS (
    VALUES ('public.set_logs',        'Coaches manage set log prescriptions', '*', false),
           ('public.set_logs',        'Students insert own set logs',         'a', true),
           ('public.set_logs',        'Students update own set logs',         'w', true),
           ('public.set_logs',        'Students delete own set logs',         'd', true),
           ('public.slot_comments',   'Students insert own slot comments',    'a', true),
           ('public.slot_comments',   'Students update own slot comments',    'w', true),
           ('public.slot_comments',   'Students delete own slot comments',    'd', true),
           ('public.slot_deviations', 'Students insert own slot deviations',  'a', true),
           ('public.slot_deviations', 'Students update own slot deviations',  'w', true),
           ('public.slot_deviations', 'Students delete own slot deviations',  'd', true),
           ('public.set_log_videos',  'Students insert own set log videos',   'a', true),
           ('public.set_log_videos',  'Students update own set log videos',   'w', true),
           ('public.set_log_videos',  'Students delete own set log videos',   'd', true),
           ('storage.objects',        'Students upload own set videos',       'a', true),
           ('storage.objects',        'Students delete own set videos',       'd', true)
  ),
  tables AS (
    SELECT DISTINCT tbl, tbl::regclass AS rel FROM wanted
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
       WHERE NOT EXISTS (SELECT 1 FROM wanted w
                          WHERE w.tbl = x.tbl AND w.name = x.name AND w.cmd = x.cmd)
      UNION ALL
      SELECT w.tbl || ' has no policy "' || w.name || '"'
        FROM wanted w
       WHERE NOT EXISTS (SELECT 1 FROM writes x
                          WHERE x.tbl = w.tbl AND x.name = w.name AND x.cmd = w.cmd)
      UNION ALL
      SELECT x.tbl || ': "' || x.name || '" does not ask whether the session is writable'
        FROM writes x
        JOIN wanted w ON w.tbl = x.tbl AND w.name = x.name AND w.cmd = x.cmd
       WHERE w.gated
         AND (   (x.cmd IN ('w', 'd') AND x.judged  NOT LIKE '%session_writable_for_slot(%')
              OR (x.cmd IN ('a', 'w') AND x.checked NOT LIKE '%session_writable_for_slot(%'))
    ) problems;
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_12_08_session_write_gates did not get the policies it meant: %', v_list
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;

  -- Reading is what it was: the athlete still has a policy to read each of
  -- the four tables, and their own files.
  WITH wanted (tbl, name) AS (
    VALUES ('public.set_logs',        'Students read own set logs'),
           ('public.slot_comments',   'Students read own slot comments'),
           ('public.slot_deviations', 'Students read own slot deviations'),
           ('public.set_log_videos',  'Students read own set log videos'),
           ('storage.objects',        'Students read own set videos')
  )
  SELECT string_agg(w.tbl || ' has no policy "' || w.name || '"', '; ' ORDER BY w.tbl) INTO v_list
    FROM wanted w
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_policy pol
      WHERE pol.polrelid = w.tbl::regclass AND pol.polname = w.name AND pol.polcmd = 'r'
   );
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_12_08_session_write_gates would leave an athlete unable to read: %', v_list
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;
END
$verify$;

INSERT INTO app_private.app_migrations (name)
VALUES ('2026_10_12_08_session_write_gates')
RETURNING name, applied_at;

-- Functions joined public: PostgREST caches what is there.
NOTIFY pgrst, 'reload schema';

COMMIT;
