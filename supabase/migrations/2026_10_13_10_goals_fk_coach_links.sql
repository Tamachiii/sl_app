-- ============================================================
-- 10 — Goals outlive a library clean-up and a change of coach
-- wave 1 · Checkpoint A2 · required · findings P18, L7, P21, B9
--
-- THE HOLES. A goal is set by a coach, on an exercise of their library, for
-- one athlete; the athlete logs their attempts against it (goal_progress).
-- Three things could take those rows away, or leave them in the wrong hands:
--   * goals.exercise_id was ON DELETE CASCADE, where the exercise of a slot
--     and the substitute of a swap are RESTRICT. A coach who tidied the
--     library and deleted an exercise that was in no program deleted, with
--     it, every goal set on it and every attempt the athletes had logged
--     (P18, L7). The dialog said `Delete "…"?`.
--   * students.coach_id and goals.coach_id were ON DELETE CASCADE: removing a
--     coach's account removed the link of each of their athletes — and with
--     the link the athlete's programs, sessions and sets — and the goals with
--     their progress. What could stand in the way was not a rule about
--     accounts: the guard on logged sets, whose sentence ("move it to the
--     trash instead") names a remedy that cannot work there — or an exercise
--     in a session, when the DELETE happened to reach the library before the
--     link (B9).
--   * "Coaches read goal progress for their students" asked who SET the goal
--     (goals.coach_id), never who coaches the athlete today. After an athlete
--     had moved to another coach, the former one kept reading every weight
--     and note the athlete logged, and the new one could neither see nor
--     manage those goals (P21). Nothing moved an athlete properly either: the
--     link was rewritten by hand, and the goals stayed behind.
--
-- WHAT THIS FILE DOES.
--   1. goals.exercise_id, goals.coach_id and students.coach_id become ON
--      DELETE RESTRICT. A library exercise that a goal is set on is not
--      deleted; a profile that coaches an athlete, or that set a goal, is not
--      deleted. Each is refused with 23503, and nothing is removed.
--   2. exercise_library.archived_at (nullable). RESTRICT alone would mean
--      that an exercise which was ever used never leaves the list: a later
--      version of the app archives it instead — out of the pickers, still
--      there for the slots, the goals and the history that name it. This
--      file adds the column and nothing reads it yet.
--   3. coach_profile_for_goal(goal) — the helper the read policy of
--      goal_progress is written with — answers the coach of a goal only
--      while that coach is the coach of the goal's athlete: the profile that
--      set the goal AND that public.students links to the athlete today. The
--      policy itself is not rewritten.
--   4. transfer_student(athlete, new coach): moves the link and hands the
--      athlete's goals to the new coach, in one statement. For the owner of
--      the database and the service role — a request that carries a user id
--      is refused by the function itself, by the gate on the link (migration
--      05), and has no EXECUTE on it to begin with.
--
-- NO ROW IS WRITTEN BY THIS FILE. Goals whose coach is no longer the coach
-- of their athlete — a link rewritten or removed by hand before today — are
-- counted by the audit (lines 12 and 13) and handed over with
-- transfer_student, by the owner.
--
-- WHAT A CLIENT SEES. With the app that is deployed today:
--   * a coach who deletes a library exercise that a goal is set on: "Can’t do
--     that — this is still in use elsewhere." (the toast the app already has
--     for an exercise used by a session). The exercise, the goals and their
--     progress stay. An exercise nothing uses is deleted as before.
--   * a coach, an athlete, goals and progress otherwise: nothing changes. A
--     coach reads the progress of the goals they set for the athletes they
--     coach, as before.
--   * the library read returns one more column, archived_at, which is empty.
--
-- Backward compatible: yes, with every client ever deployed.
-- Audit:    supabase/audits/2026_10_13_10_goals_fk_coach_links.audit.sql
-- Rollback: supabase/rollbacks/2026_10_13_10_goals_fk_coach_links.down.sql (reopens P18 / L7, P21, B9)
-- Runbook:  docs/runbook/migrations/10-goals-fk-coach-links.md
-- ============================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
DECLARE
  v_strangers text;
  v_list      text;
BEGIN
  -- First of all, because no other role can even look at the ledger. What is
  -- created below must belong to the role that owns the tables: a SECURITY
  -- DEFINER function runs as its owner, and the default privileges that keep
  -- a new function closed (migration 03) are those of `postgres`.
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'migration 2026_10_13_10_goals_fk_coach_links must be run as postgres, not as %', current_user
      USING HINT = 'Run it from the SQL editor or with `supabase db query --linked`. Nothing was changed.';
  END IF;

  -- Asked before the ledger is read: without it the answer would be
  -- "relation does not exist" instead of this one.
  IF to_regclass('app_private.app_migrations') IS NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_10_goals_fk_coach_links needs 2026_10_13_09_review_lifecycle, which is not applied'
      USING ERRCODE = 'SLM02', HINT = 'Apply migrations 01 to 09 first. Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_13_10_goals_fk_coach_links') THEN
    RAISE EXCEPTION 'migration 2026_10_13_10_goals_fk_coach_links is already applied'
      USING ERRCODE = 'SLM01', HINT = 'Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_13_09_review_lifecycle') THEN
    RAISE EXCEPTION 'migration 2026_10_13_10_goals_fk_coach_links needs 2026_10_13_09_review_lifecycle, which is not applied'
      USING ERRCODE = 'SLM02', HINT = 'Apply that file first. Nothing was changed.';
  END IF;

  -- CREATE OR REPLACE replaces a function with the SAME argument types. A
  -- copy of one of these with other arguments would stay next to the new one,
  -- and nothing would say so.
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text)
    INTO v_strangers
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('coach_profile_for_goal', 'transfer_student')
     -- By oid, names written with their schema: the answer must not depend on
     -- the search_path of whoever runs the file.
     AND NOT EXISTS (
       SELECT 1
         FROM unnest(ARRAY[
                'public.coach_profile_for_goal(uuid)',
                'public.transfer_student(uuid, uuid)'
              ]) AS known(signature)
        WHERE to_regprocedure(known.signature) = p.oid
     );
  IF v_strangers IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_10_goals_fk_coach_links would not replace: %', v_strangers
      USING HINT = 'A function of this file exists with other arguments. Nothing was changed. Stop and report.';
  END IF;

  -- The three foreign keys are dropped and re-created BY NAME (PostgreSQL
  -- has no statement that changes what a foreign key does on DELETE). Each
  -- must be there under the name it was created with, and be the only one on
  -- its column: a second one, made by hand, would go on cascading after this
  -- file had run.
  SELECT string_agg(w.tbl || '.' || w.col || ': ' || w.problem, '; ' ORDER BY w.tbl, w.col)
    INTO v_list
    FROM (
      SELECT k.tbl, k.col,
             CASE
               WHEN fk.n = 0 THEN 'no foreign key'
               WHEN fk.n > 1 THEN fk.n || ' foreign keys (' || fk.names || ')'
               WHEN NOT fk.as_expected THEN 'its foreign key is ' || fk.names || ', not ' || k.name || ' to ' || k.ref
             END AS problem
        FROM (VALUES ('public.goals',    'exercise_id', 'public.exercise_library', 'goals_exercise_id_fkey'),
                     ('public.goals',    'coach_id',    'public.profiles',         'goals_coach_id_fkey'),
                     ('public.students', 'coach_id',    'public.profiles',         'students_coach_id_fkey')
             ) AS k (tbl, col, ref, name)
       CROSS JOIN LATERAL (
         SELECT count(*) AS n,
                string_agg(c.conname, ', ' ORDER BY c.conname) AS names,
                coalesce(bool_and(c.conname = k.name AND c.confrelid = to_regclass(k.ref)
                                  AND cardinality(c.conkey) = 1), false) AS as_expected
           FROM pg_constraint c
           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attname = k.col
          WHERE c.conrelid = to_regclass(k.tbl)
            AND c.contype = 'f'
            AND a.attnum = ANY (c.conkey)
       ) fk
    ) w
   WHERE w.problem IS NOT NULL;
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_10_goals_fk_coach_links does not find the foreign keys it rewrites: %', v_list
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;

  -- ADD COLUMN would say "already exists" and nothing about why.
  IF EXISTS (
    SELECT 1 FROM pg_attribute a
     WHERE a.attrelid = to_regclass('public.exercise_library')
       AND a.attname = 'archived_at' AND NOT a.attisdropped
  ) THEN
    RAISE EXCEPTION 'migration 2026_10_13_10_goals_fk_coach_links: public.exercise_library already has a column archived_at'
      USING HINT = 'It was added by hand, or by a file that is not in the ledger. Nothing was changed. Stop and report.';
  END IF;
END
$guard$;

-- ------------------------------------------------------------
-- 1. What a goal points at is not deleted under it.
-- ------------------------------------------------------------
-- DROP and ADD in ONE statement per table: there is no moment at which the
-- column has no foreign key. ADD validates the rows that are there — every
-- one already satisfied the key it replaces.
--
-- RESTRICT, not NO ACTION: the refusal is made when the row is deleted and
-- cannot be put off to the end of a transaction.
--
-- The exercise of a goal. Deleting it took the goal, and goal_progress with
-- it (which follows goals, and still does: deleting a GOAL is its coach's
-- decision, and removes its attempts). Now: 23503, like an exercise that a
-- session uses.
--
-- The coach of a goal, and the coach of a link. A profile goes when its
-- account is deleted (profiles.id follows auth.users). For an ATHLETE that
-- still takes their own link, programs, goals and messages with it — rows
-- that are theirs (students.profile_id and goals.student_id stay CASCADE).
-- For a COACH it took other people's: now refused while one athlete is
-- linked to them, or one goal names them. The athletes are moved first
-- (transfer_student, below), and their goals go with them.
ALTER TABLE public.goals
  DROP CONSTRAINT goals_exercise_id_fkey,
  ADD CONSTRAINT goals_exercise_id_fkey
    FOREIGN KEY (exercise_id) REFERENCES public.exercise_library(id) ON DELETE RESTRICT,
  DROP CONSTRAINT goals_coach_id_fkey,
  ADD CONSTRAINT goals_coach_id_fkey
    FOREIGN KEY (coach_id) REFERENCES public.profiles(id) ON DELETE RESTRICT;

ALTER TABLE public.students
  DROP CONSTRAINT students_coach_id_fkey,
  ADD CONSTRAINT students_coach_id_fkey
    FOREIGN KEY (coach_id) REFERENCES public.profiles(id) ON DELETE RESTRICT;

-- ------------------------------------------------------------
-- 2. An exercise can be archived.
-- ------------------------------------------------------------
-- With section 1 an exercise that a session, a swap or a goal ever used can
-- no longer be deleted — and would stay in every picker for good. Archiving
-- is the way out: the row stays, with its name, for what points at it.
--
-- Written by the owner of the row through "Coaches manage own library",
-- which is FOR ALL: no policy is added. Read by their athletes like any
-- other column — an archived exercise is still the name of what they
-- trained. NOTHING IN THE DATABASE REFUSES AN ARCHIVED EXERCISE: a slot that
-- holds one is copied, a goal on one is still logged against. "Not offered
-- for new work" is the pickers' rule (isActiveExercise, in the app).
ALTER TABLE public.exercise_library
  ADD COLUMN archived_at timestamptz;

COMMENT ON COLUMN public.exercise_library.archived_at IS
  'When its coach archived the exercise; NULL = in use. An archived exercise '
  'is left out of the pickers and stays readable for the slots, swaps, goals '
  'and history that name it. Nothing in the database refuses one: hiding it '
  'is the client''s rule (2026_10_13_10).';

-- ------------------------------------------------------------
-- 3. The coach of a goal is the coach of its athlete, today.
-- ------------------------------------------------------------
-- The one caller is the policy "Coaches read goal progress for their
-- students": USING (coach_profile_for_goal(goal_id) = auth.uid()). It
-- answered goals.coach_id — who SET the goal. It now answers that profile
-- only while public.students links it to the goal's athlete, and NULL
-- otherwise: a goal whose athlete has moved, or has no coach any more, is
-- read by its athlete alone until it is handed over (section 4).
--
-- That is the rule "Coaches manage goals for their students" already asks of
-- the goal itself (coach_id = auth.uid() AND the link). The progress now
-- follows the goal.
--
-- Same header as before — a uuid in, a uuid out, STABLE, SECURITY DEFINER —
-- so the policy that depends on it is not touched, and neither is what
-- PostgREST knows of it. The argument keeps its name: CREATE OR REPLACE does
-- not rename one.
CREATE OR REPLACE FUNCTION public.coach_profile_for_goal(g uuid)
RETURNS uuid AS $$
  SELECT gl.coach_id
    FROM public.goals gl
    JOIN public.students s
      ON s.profile_id = gl.student_id
     AND s.coach_id = gl.coach_id
   WHERE gl.id = g
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.coach_profile_for_goal(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.coach_profile_for_goal(uuid) TO authenticated;

-- ------------------------------------------------------------
-- 4. Moving an athlete to another coach.
-- ------------------------------------------------------------
-- The link and the goals, together: students.coach_id says who coaches the
-- athlete, goals.coach_id who manages each of their goals, and the policies
-- on goals and on goal_progress ask for both. Moved one without the other,
-- the goals are managed by nobody.
--
--   p_student     the PROFILE id of the athlete (what auth.users, profiles
--                 and goals.student_id hold) — not the id of the students row
--   p_new_coach   the profile id of the coach they go to
--
-- Called with the coach the athlete already has, it moves no link and hands
-- over the goals that were left with a former coach — which is how goals
-- that stayed behind after a link was rewritten by hand are put right.
--
-- NOT FOR A SIGNED-IN USER, three times over:
--   * no EXECUTE for `authenticated` (below; and not in the allow-list of
--     schema.sql) — the owner and the service role call it;
--   * the first lines refuse a request that carries a user id;
--   * trg_check_students_link (migration 05) refuses, with a user id, any
--     UPDATE that moves a link, whatever function it comes from.
-- SECURITY INVOKER for the same reason: it is given no right its caller does
-- not have. The owner of the tables and the service role are not held by
-- row-level security; anybody else would be, and would reach no row.
--
-- What it does NOT judge is left to what already does: the new coach must be
-- a profile with the role coach, and not the athlete themselves
-- (trg_check_students_link, 23514); a profile that does not exist is the
-- foreign key's (23503).
--
-- What it does NOT move: the exercises. The slots of the athlete's programs
-- and their goals keep pointing at the library of the former coach, which
-- neither the athlete nor the new coach can read
-- (docs/runbook/migrations/10-goals-fk-coach-links.md, "Moving an athlete to
-- another coach").
CREATE OR REPLACE FUNCTION public.transfer_student(p_student uuid, p_new_coach uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_link_id    uuid;
  v_from_coach uuid;
  v_goals      integer;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'an athlete is moved to another coach by the owner of the database, not from the app'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'transfer_student is called from the SQL editor or with the service-role key.';
  END IF;

  IF p_student IS NULL OR p_new_coach IS NULL THEN
    RAISE EXCEPTION 'transfer_student needs the profile id of the athlete and of the new coach'
      USING ERRCODE = 'null_value_not_allowed',
            HINT = 'One of the two is NULL: an e-mail address that is not an account gives no id.';
  END IF;

  -- The row is held until the end of the transaction: two transfers of the
  -- same athlete wait for each other.
  SELECT s.id, s.coach_id INTO v_link_id, v_from_coach
    FROM public.students s
   WHERE s.profile_id = p_student
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile % is not the athlete of a coach: there is no link to move', p_student
      USING ERRCODE = 'no_data_found',
            HINT = 'A first link is made with: insert into public.students (profile_id, coach_id) values (…, …).';
  END IF;

  IF v_from_coach IS DISTINCT FROM p_new_coach THEN
    UPDATE public.students
       SET coach_id = p_new_coach
     WHERE id = v_link_id;
  END IF;

  UPDATE public.goals
     SET coach_id = p_new_coach
   WHERE student_id = p_student
     AND coach_id IS DISTINCT FROM p_new_coach;
  GET DIAGNOSTICS v_goals = ROW_COUNT;

  RETURN jsonb_build_object(
    'student_id',    p_student,
    'from_coach_id', v_from_coach,
    'to_coach_id',   p_new_coach,
    'link_moved',    v_from_coach IS DISTINCT FROM p_new_coach,
    'goals_moved',   v_goals
  );
END;
$$;

REVOKE ALL ON FUNCTION public.transfer_student(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 5. Read the result back. Anything else than what was meant raises, and the
--    whole file is undone: either the database is as described, or untouched.
-- ------------------------------------------------------------
DO $verify$
DECLARE
  v_list text;
BEGIN
  -- The three foreign keys: one on each column, under its name, validated,
  -- and refusing the DELETE.
  SELECT string_agg(k.tbl || '.' || k.col, '; ' ORDER BY k.tbl, k.col) INTO v_list
    FROM (VALUES ('public.goals',    'exercise_id', 'public.exercise_library', 'goals_exercise_id_fkey'),
                 ('public.goals',    'coach_id',    'public.profiles',         'goals_coach_id_fkey'),
                 ('public.students', 'coach_id',    'public.profiles',         'students_coach_id_fkey')
         ) AS k (tbl, col, ref, name)
   WHERE (SELECT count(*) FROM pg_constraint c
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attname = k.col
           WHERE c.conrelid = to_regclass(k.tbl) AND c.contype = 'f' AND a.attnum = ANY (c.conkey)) <> 1
      OR NOT EXISTS (
           SELECT 1 FROM pg_constraint c
            WHERE c.conrelid = to_regclass(k.tbl) AND c.contype = 'f'
              AND c.conname = k.name
              AND c.confrelid = to_regclass(k.ref)
              AND c.confdeltype = 'r'
              AND c.convalidated
         );
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_10_goals_fk_coach_links did not get the foreign keys it meant: %', v_list
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;

  -- The column: a timestamp, empty for every exercise that is there.
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a
     WHERE a.attrelid = 'public.exercise_library'::regclass
       AND a.attname = 'archived_at' AND NOT a.attisdropped
       AND a.atttypid = 'timestamptz'::regtype
       AND NOT a.attnotnull AND NOT a.atthasdef
  ) THEN
    RAISE EXCEPTION 'migration 2026_10_13_10_goals_fk_coach_links did not get the column it meant: public.exercise_library.archived_at'
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;

  -- The functions: owned by postgres, search_path pinned, closed to a request
  -- without a session. The helper runs as its owner and is open to a
  -- signed-in user, because a policy calls it; transfer_student runs as its
  -- caller and is open to nobody who is signed in.
  WITH wanted (signature, for_users, definer) AS (
    VALUES ('public.coach_profile_for_goal(uuid)',  true,  true),
           ('public.transfer_student(uuid, uuid)', false, false)
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
               CASE WHEN definer AND NOT prosecdef THEN 'it does not run as its owner' END,
               CASE WHEN prosecdef AND NOT definer THEN 'it runs as its owner' END,
               CASE WHEN proconfig IS NULL OR NOT ('search_path=public, pg_temp' = ANY (proconfig))
                    THEN 'search_path is not public, pg_temp' END
             ) END AS wrong
        FROM found
    ) f
   WHERE f.wrong <> '';
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_10_goals_fk_coach_links did not get the functions it meant: %', v_list
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;

  -- The policies of goal_progress are the two of this list and no other:
  -- policies add up, and one made by hand, under another name, would go on
  -- showing the progress to whoever it names. The coach's asks the helper.
  WITH known (name, cmd, asks) AS (
    VALUES ('Students manage own goal progress',             '*', NULL),
           ('Coaches read goal progress for their students', 'r', 'coach_profile_for_goal(')
  ),
  there AS (
    SELECT pol.polname AS name, pol.polcmd::text AS cmd,
           coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') AS judged
      FROM pg_policy pol
     WHERE pol.polrelid = 'public.goal_progress'::regclass
  )
  SELECT string_agg(problem, '; ' ORDER BY problem) INTO v_list
    FROM (
      SELECT 'row-level security is off on public.goal_progress' AS problem
        FROM pg_class c
       WHERE c.oid = 'public.goal_progress'::regclass AND NOT c.relrowsecurity
      UNION ALL
      SELECT 'public.goal_progress has the policy "' || t.name || '", which this migration does not know'
        FROM there t
       WHERE NOT EXISTS (SELECT 1 FROM known k WHERE k.name = t.name AND k.cmd = t.cmd)
      UNION ALL
      SELECT 'public.goal_progress has no policy "' || k.name || '"'
        FROM known k
       WHERE k.asks IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM there t WHERE t.name = k.name AND t.cmd = k.cmd)
      UNION ALL
      SELECT '"' || t.name || '" does not ask ' || k.asks || '…)'
        FROM there t
        JOIN known k ON k.name = t.name AND k.cmd = t.cmd
       WHERE k.asks IS NOT NULL
         AND position(k.asks IN t.judged) = 0
    ) problems;
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_10_goals_fk_coach_links did not get the policies it meant: %', v_list
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;
END
$verify$;

INSERT INTO app_private.app_migrations (name)
VALUES ('2026_10_13_10_goals_fk_coach_links')
RETURNING name, applied_at;

-- A column, three foreign keys and a function joined or changed in public:
-- PostgREST caches all three.
NOTIFY pgrst, 'reload schema';

COMMIT;
