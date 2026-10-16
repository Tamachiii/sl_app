-- ============================================================
-- 26 — Two lists of the coach answered by the database: the sessions to
--      review of each athlete, and the conversations
-- wave 3 · Checkpoint C1 · optional · findings L18, P9 (the database's half)
--
-- THE HOLES. Two lists of the coach are folded by the app from the whole
-- history, read row by row:
--   * the sessions still to review — the chips of the Athletes roster, the
--     count of the Sessions feed — are counted from EVERY confirmation of
--     every athlete of the coach (src/hooks/useSessionConfirmation.js,
--     useAllConfirmations; src/lib/coachRoster.js, reviewCountsByStudent);
--   * the list of conversations is folded from EVERY message of the account
--     (src/hooks/useMessages.js, useConversations).
-- The API answers 1000 rows at most, and says nothing when it cuts: past
-- 1000 confirmations the oldest sessions still to review drop out of the
-- counts; past 1000 messages the oldest conversations drop out of the list,
-- with their unread messages (L18). And every opening of those screens
-- downloads the whole history again (P9: 11 requests and 199 kB for the
-- roster of one coach, live).
--
-- WHAT THIS FILE DOES. Pure expand: two functions that read, and nothing
-- else — no table, no column, no policy, no trigger, no row.
--   1. coach_review_counts() → (student_id, to_review): one row per athlete
--      of the caller who has sessions to review, and how many. student_id is
--      students.id, the key the roster goes by. "To review" is what the app
--      counts: a confirmation of a session that is neither reviewed nor
--      archived, in a block out of the trash. An athlete with none has no
--      row.
--   2. my_conversations() → one row per account the caller has exchanged a
--      message with, the newest conversation first: counterpart_id,
--      full_name (NULL when the caller may not read that profile, or when it
--      has no name), last_body, last_at, unread (the messages of that
--      account the caller has not opened) — then the rest of the last
--      message, so that the app holds it as it holds it today: last_id,
--      last_sender_id, last_recipient_id, last_session_id, last_read_at.
--      Feedback messages count, as in the app.
-- On the same rows each answers what the app's fold answers, and
-- supabase/tests/coach-list-rpcs.test.js holds it to a copy of that fold.
--
-- STABLE and SECURITY INVOKER, both: they read with the rights of their
-- caller, and give nobody a row their caller could not read. They name the
-- caller themselves — auth.uid() as the coach of the athlete, as the sender
-- or the recipient of the message — because row-level security is not the
-- filter of a coach-wide list: an account that coaches and is somebody's
-- athlete reads its own block too (docs/INVARIANTS.md, "A coach-wide read
-- names the coach"). A request without a user id — the service role, the
-- SQL editor — gets no row. Executable by a signed-in user, never without a
-- session.
--
-- OPTIONAL. Nothing needs it. The app that is deployed does not call them.
-- The version of the app that follows wave 3 calls them when they are there,
-- and reads the lists page by page when the API answers that they are not
-- (PGRST202): slower to open, never wrong. No later migration requires this
-- one, and its rollback is never refused for one.
--
-- Backward compatible: yes, with every client ever deployed.
-- Audit:    supabase/audits/2026_10_16_26_coach_list_rpcs.audit.sql
-- Rollback: supabase/rollbacks/2026_10_16_26_coach_list_rpcs.down.sql
-- Runbook:  docs/runbook/migrations/26-coach-list-rpcs.md
-- ============================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
DECLARE
  v_there   text;
  v_missing text;
BEGIN
  -- First of all, because no other role can even look at the ledger. What is
  -- created below must belong to the role that owns the tables: the default
  -- privileges that keep a new function closed (migration 03) are those of
  -- `postgres`.
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'migration 2026_10_16_26_coach_list_rpcs must be run as postgres, not as %', current_user
      USING HINT = 'Run it from the SQL editor or with `supabase db query --linked`. Nothing was changed.';
  END IF;

  -- Asked before the ledger is read: without it the answer would be
  -- "relation does not exist" instead of this one.
  IF to_regclass('app_private.app_migrations') IS NULL THEN
    RAISE EXCEPTION 'migration 2026_10_16_26_coach_list_rpcs needs 2026_10_16_25_storage_video_policies, which is not applied'
      USING ERRCODE = 'SLM02', HINT = 'Apply migrations 01 to 25 first. Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_16_26_coach_list_rpcs') THEN
    RAISE EXCEPTION 'migration 2026_10_16_26_coach_list_rpcs is already applied'
      USING ERRCODE = 'SLM01', HINT = 'Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_16_25_storage_video_policies') THEN
    RAISE EXCEPTION 'migration 2026_10_16_26_coach_list_rpcs needs 2026_10_16_25_storage_video_policies, which is not applied'
      USING ERRCODE = 'SLM02', HINT = 'Apply that file first. Nothing was changed.';
  END IF;

  -- The two functions are CREATED, not replaced. One that is there already,
  -- under one of the names — with these arguments or with others — was made
  -- by hand: the API finds a function by its name and the names of its
  -- arguments, and two of a name are a call that may reach the wrong one.
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text)
    INTO v_there
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('coach_review_counts', 'my_conversations');
  IF v_there IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_16_26_coach_list_rpcs would not create: % is already there', v_there
      USING HINT = 'A function of this file exists, made by hand or by a file that is not in the ledger. Nothing was changed. Stop and report.';
  END IF;

  -- The columns the two functions read, asked by name: a refusal that names
  -- them is worth more than the message of CREATE FUNCTION.
  SELECT string_agg(w.tbl || '.' || w.col, ', ' ORDER BY w.tbl, w.col)
    INTO v_missing
    FROM (VALUES ('public.session_confirmations', 'session_id'),
                 ('public.sessions', 'id'),
                 ('public.sessions', 'week_id'),
                 ('public.sessions', 'reviewed_at'),
                 ('public.sessions', 'archived_at'),
                 ('public.weeks',    'id'),
                 ('public.weeks',    'program_id'),
                 ('public.programs', 'id'),
                 ('public.programs', 'student_id'),
                 ('public.programs', 'deleted_at'),
                 ('public.students', 'id'),
                 ('public.students', 'coach_id'),
                 ('public.messages', 'id'),
                 ('public.messages', 'sender_id'),
                 ('public.messages', 'recipient_id'),
                 ('public.messages', 'body'),
                 ('public.messages', 'session_id'),
                 ('public.messages', 'read_at'),
                 ('public.messages', 'created_at'),
                 ('public.profiles', 'id'),
                 ('public.profiles', 'full_name')
         ) AS w (tbl, col)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = to_regclass(w.tbl)
        AND a.attname = w.col AND NOT a.attisdropped
   );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_16_26_coach_list_rpcs does not find the columns its functions are written with: %', v_missing
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;
END
$guard$;

-- ------------------------------------------------------------
-- 1. The sessions to review, per athlete of the caller.
-- ------------------------------------------------------------
-- One row per athlete of the caller (students.coach_id = auth.uid()) who has
-- at least one session to review; an athlete with none has no row, so a
-- missing athlete reads 0 — as the Map of reviewCountsByStudent
-- (src/lib/coachRoster.js) the roster reads with `|| 0`.
--
--   student_id   students.id — the link, not the profile: the roster and
--                the Sessions feed go by it (session_confirmations.student_id
--                is the athlete's PROFILE id, and is not read here)
--   to_review    the confirmations of sessions that are neither reviewed nor
--                archived, in a block out of the trash — the predicate of the
--                roster and of the Sessions feed
--
-- A confirmation per session (session_confirmations.session_id is unique):
-- the count is a count of sessions. The block may be any block of the
-- athlete — the active one, a past one, an approved one waiting — as the
-- app's read takes them all.
CREATE FUNCTION public.coach_review_counts()
RETURNS TABLE (student_id uuid, to_review integer)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT st.id, count(*)::integer
    FROM public.session_confirmations c
    JOIN public.sessions s  ON s.id = c.session_id
    JOIN public.weeks w     ON w.id = s.week_id
    JOIN public.programs p  ON p.id = w.program_id
    JOIN public.students st ON st.id = p.student_id
   WHERE st.coach_id = auth.uid()
     AND p.deleted_at IS NULL
     AND s.reviewed_at IS NULL
     AND s.archived_at IS NULL
   GROUP BY st.id
   ORDER BY st.id;
$$;

REVOKE ALL ON FUNCTION public.coach_review_counts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.coach_review_counts() TO authenticated;

-- ------------------------------------------------------------
-- 2. The conversations of the caller.
-- ------------------------------------------------------------
-- One row per account the caller has exchanged a message with — sent or
-- received, feedback included — the newest conversation first. What
-- useConversations (src/hooks/useMessages.js) folds from the rows of the
-- account:
--
--   counterpart_id      the other side of each message
--   full_name           its name as the caller may read it: NULL when the
--                       caller may not read that profile (a former coach
--                       after transfer_student, a former athlete) or when the
--                       name is empty — `full_name || null` in the app
--   last_body, last_at  the newest message of the pair: by created_at, then
--                       by id when two share the time
--   unread              the messages of the pair the caller received and has
--                       not opened (read_at IS NULL)
--   last_id, last_sender_id, last_recipient_id, last_session_id,
--   last_read_at        the rest of the newest message: with last_body and
--                       last_at, the seven columns the app holds of a
--                       message (MESSAGE_COLUMNS in src/lib/messageCache.js)
--                       — the "You:" of the list and the patches of the
--                       realtime events read them
--
-- Columns are added at the end of the list, never renamed: a RETURNS TABLE is
-- changed by dropping the function and creating it again.
CREATE FUNCTION public.my_conversations()
RETURNS TABLE (
  counterpart_id    uuid,
  full_name         text,
  last_body         text,
  last_at           timestamptz,
  unread            integer,
  last_id           uuid,
  last_sender_id    uuid,
  last_recipient_id uuid,
  last_session_id   uuid,
  last_read_at      timestamptz
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  WITH mine AS (
    SELECT m.id, m.sender_id, m.recipient_id, m.body, m.session_id, m.read_at, m.created_at,
           CASE WHEN m.sender_id = auth.uid() THEN m.recipient_id ELSE m.sender_id END AS counterpart
      FROM public.messages m
     WHERE m.sender_id = auth.uid()
        OR m.recipient_id = auth.uid()
  ),
  newest AS (
    SELECT DISTINCT ON (x.counterpart)
           x.counterpart, x.id, x.sender_id, x.recipient_id, x.body, x.session_id, x.read_at, x.created_at
      FROM mine x
     ORDER BY x.counterpart, x.created_at DESC, x.id DESC
  ),
  counted AS (
    SELECT x.counterpart,
           (count(*) FILTER (WHERE x.recipient_id = auth.uid() AND x.read_at IS NULL))::integer AS unread
      FROM mine x
     GROUP BY x.counterpart
  )
  SELECT n.counterpart, NULLIF(pr.full_name, ''), n.body, n.created_at, k.unread,
         n.id, n.sender_id, n.recipient_id, n.session_id, n.read_at
    FROM newest n
    JOIN counted k ON k.counterpart = n.counterpart
    LEFT JOIN public.profiles pr ON pr.id = n.counterpart
   ORDER BY n.created_at DESC, n.id DESC;
$$;

REVOKE ALL ON FUNCTION public.my_conversations() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.my_conversations() TO authenticated;

-- ------------------------------------------------------------
-- 3. Read the result back. Anything else than what was meant raises, and the
--    whole file is undone: either the database is as described, or untouched.
-- ------------------------------------------------------------
DO $verify$
DECLARE
  v_list text;
BEGIN
  -- The two functions: owned by postgres, what they answer, STABLE, running
  -- with the rights of their caller, the search_path pinned, open to a
  -- signed-in user and closed to a request without a session.
  WITH wanted (signature, answers) AS (
    VALUES ('public.coach_review_counts()',
            'TABLE(student_id uuid, to_review integer)'),
           ('public.my_conversations()',
            'TABLE(counterpart_id uuid, full_name text, last_body text, last_at timestamp with time zone, unread integer, '
            || 'last_id uuid, last_sender_id uuid, last_recipient_id uuid, last_session_id uuid, last_read_at timestamp with time zone)')
  ),
  found AS (
    SELECT w.signature, w.answers, p.oid, p.proowner, p.proconfig, p.prosecdef, p.provolatile, p.proacl
      FROM wanted w
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(w.signature)
  )
  SELECT string_agg(f.signature || ': ' || f.wrong, '; ' ORDER BY f.signature) INTO v_list
    FROM (
      SELECT signature,
             CASE WHEN oid IS NULL THEN 'missing' ELSE concat_ws(', ',
               CASE WHEN pg_get_userbyid(proowner) <> 'postgres' THEN 'not owned by postgres' END,
               CASE WHEN pg_get_function_result(oid) <> answers THEN 'it does not return ' || answers END,
               CASE WHEN provolatile <> 's' THEN 'it is not STABLE' END,
               CASE WHEN has_function_privilege('anon', oid, 'EXECUTE') THEN 'anon may execute it' END,
               CASE WHEN EXISTS (SELECT 1 FROM aclexplode(COALESCE(proacl, acldefault('f', proowner))) a
                                  WHERE a.grantee = 0)
                    THEN 'PUBLIC may execute it' END,
               CASE WHEN NOT has_function_privilege('authenticated', oid, 'EXECUTE')
                    THEN 'a signed-in user may NOT execute it' END,
               CASE WHEN prosecdef THEN 'it runs as its owner' END,
               CASE WHEN proconfig IS NULL OR NOT ('search_path=public, pg_temp' = ANY (proconfig))
                    THEN 'search_path is not public, pg_temp' END
             ) END AS wrong
        FROM found
    ) f
   WHERE f.wrong <> '';
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_16_26_coach_list_rpcs did not get the functions it meant: %', v_list
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;

  -- One function per name: the API calls by name.
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO v_list
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('coach_review_counts', 'my_conversations')
     AND p.oid NOT IN (to_regprocedure('public.coach_review_counts()'), to_regprocedure('public.my_conversations()'));
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_16_26_coach_list_rpcs did not get the functions it meant: % stands next to them', v_list
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;
END
$verify$;

INSERT INTO app_private.app_migrations (name)
VALUES ('2026_10_16_26_coach_list_rpcs')
RETURNING name, applied_at;

-- Two functions joined public: PostgREST learns of a function when its schema
-- cache is reloaded.
NOTIFY pgrst, 'reload schema';

COMMIT;
