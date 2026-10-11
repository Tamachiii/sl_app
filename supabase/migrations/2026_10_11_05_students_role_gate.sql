-- ============================================================
-- 05 — The coach ↔ athlete link cannot be forged
-- wave 1 · Checkpoint A2 · required · findings P7, L2
--
-- THE HOLE. public.students says who coaches whom, and every "Coaches …"
-- policy of the schema is written against it: whoever is the coach_id of a
-- row reads and writes that athlete's programs, sets, videos, bodyweight,
-- goals and messages. Three policies let a signed-in user write the table,
-- and all they asked was coach_id = auth.uid():
--   * INSERT — any account could make itself the coach of any profile that
--     had no row yet. An athlete knows the id of their coach, and a coach has
--     no row of their own: the athlete registers the coach as "their
--     athlete", shows up in the coach's roster as a ghost card that cannot be
--     removed, and can write programs and feedback the coach receives.
--   * UPDATE — no WITH CHECK and nothing on the columns: a row could be
--     pointed at another profile, and an athlete's whole training tree went
--     to somebody else.
--   * DELETE — one request removed an athlete with everything they own.
-- The app never used any of the three: it only reads this table.
-- The exercise library had the same gap (coach_id = auth.uid(), no role), and
-- nothing checked whose library the exercise of a slot or of a swap came from.
--
-- WHAT THIS FILE DOES.
--   1. public.is_coach(): true when the caller's profile has the role coach.
--   2. students: the INSERT and DELETE policies are dropped. Rows are created
--      and removed by the owner of the database (SQL editor) or with the
--      service-role key — nobody else. The UPDATE policy stays, for a coach,
--      with a WITH CHECK.
--   3. A trigger on students, for EVERY writer, the SQL editor included:
--        coach_id is a profile with the role coach,
--        profile_id is a profile with the role student,
--        and they are two profiles.
--      It is asked when a row is created or when its link changes; a row that
--      is only edited is not judged again. For a signed-in user id, profile_id
--      and coach_id cannot change at all.
--   4. exercise_library: adding or editing a row requires is_coach().
--   5. A trigger on exercise_slots and one on slot_deviations: the exercise —
--      the substitute, for a swap — belongs to the library of the coach of
--      that program. Asked when the row is created or when the exercise
--      changes, so a slot that already holds another coach's exercise (an
--      athlete who changed coach) stays editable.
--
-- IT REFUSES TO RUN (SLM05) while the table holds a link the gate would
-- refuse: such a row is the hole, already used, and it keeps giving its
-- "coach" the reach of one. The audit counts them (line 11) and the runbook
-- page has the statements to list and remove them.
--
-- WHAT A CLIENT SEES. With the app that is deployed today: nothing, for an
-- athlete and for a coach. The app does not write students; a coach adds,
-- edits and deletes library exercises as before; the pickers of the editor
-- and of the swap only offer the coach's own library.
-- By hand, through the API: an INSERT or a DELETE on students is refused by
-- row-level security; an UPDATE that moves the link is refused (42501); a
-- library row written by an account that is not a coach is refused; an
-- exercise from another library is refused (23514).
--
-- No row of the app is written by this file.
--
-- Backward compatible: yes, with every client ever deployed.
-- Audit:    supabase/audits/2026_10_11_05_students_role_gate.audit.sql
-- Rollback: supabase/rollbacks/2026_10_11_05_students_role_gate.down.sql (reopens P7 / L2)
-- Runbook:  docs/runbook/migrations/05-students-role-gate.md
-- ============================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
DECLARE
  v_strangers text;
  v_count     int;
  v_links     text;
BEGIN
  -- First of all, because no other role can even look at the ledger. What is
  -- created below must belong to the role that owns the tables: a SECURITY
  -- DEFINER function runs as its owner, and the default privileges that keep
  -- a new function closed (migration 03) are those of `postgres`.
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'migration 2026_10_11_05_students_role_gate must be run as postgres, not as %', current_user
      USING HINT = 'Run it from the SQL editor or with `supabase db query --linked`. Nothing was changed.';
  END IF;

  -- Asked before the ledger is read: without it the answer would be
  -- "relation does not exist" instead of this one.
  IF to_regclass('app_private.app_migrations') IS NULL THEN
    RAISE EXCEPTION 'migration 2026_10_11_05_students_role_gate needs 2026_10_11_04_logged_history_guards, which is not applied'
      USING ERRCODE = 'SLM02', HINT = 'Apply migrations 01 to 04 first. Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_11_05_students_role_gate') THEN
    RAISE EXCEPTION 'migration 2026_10_11_05_students_role_gate is already applied'
      USING ERRCODE = 'SLM01', HINT = 'Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_11_04_logged_history_guards') THEN
    RAISE EXCEPTION 'migration 2026_10_11_05_students_role_gate needs 2026_10_11_04_logged_history_guards, which is not applied'
      USING ERRCODE = 'SLM02', HINT = 'Apply that file first. Nothing was changed.';
  END IF;

  -- CREATE OR REPLACE replaces a function with the SAME argument types. A
  -- copy of one of these with other arguments would stay next to the new one,
  -- and nothing would say so.
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text)
    INTO v_strangers
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('is_coach', 'check_students_link',
                       'check_slot_exercise_in_coach_library',
                       'check_deviation_substitute_in_coach_library')
     -- By oid, names written with their schema: the answer must not depend on
     -- the search_path of whoever runs the file.
     AND NOT EXISTS (
       SELECT 1
         FROM unnest(ARRAY[
                'public.is_coach()',
                'public.check_students_link()',
                'public.check_slot_exercise_in_coach_library()',
                'public.check_deviation_substitute_in_coach_library()'
              ]) AS known(signature)
        WHERE to_regprocedure(known.signature) = p.oid
     );
  IF v_strangers IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_11_05_students_role_gate would not replace: %', v_strangers
      USING HINT = 'A function of this file exists with other arguments. Nothing was changed. Stop and report.';
  END IF;

  -- The links that are already there. Nobody writes the table from here to
  -- COMMIT (the lock is the one CREATE TRIGGER takes further down), so what
  -- is counted now is what the gate starts with.
  LOCK TABLE public.students IN SHARE ROW EXCLUSIVE MODE;
  SELECT count(*),
         string_agg(bad.described, '; ' ORDER BY bad.id) FILTER (WHERE bad.n <= 5)
    INTO v_count, v_links
    FROM (
      SELECT s.id,
             row_number() OVER (ORDER BY s.id) AS n,
             s.id::text || ' (' || concat_ws(', ',
               CASE WHEN s.profile_id = s.coach_id THEN 'its own coach' END,
               CASE WHEN cp.role <> 'coach' THEN 'coach_id has the role ' || cp.role END,
               CASE WHEN ap.role <> 'student' THEN 'profile_id has the role ' || ap.role END
             ) || ')' AS described
        FROM public.students s
        JOIN public.profiles cp ON cp.id = s.coach_id
        JOIN public.profiles ap ON ap.id = s.profile_id
       WHERE s.profile_id = s.coach_id OR cp.role <> 'coach' OR ap.role <> 'student'
    ) bad;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'migration 2026_10_11_05_students_role_gate: % row(s) of public.students link profiles the gate refuses: %',
      v_count, v_links || CASE WHEN v_count > 5 THEN '; …' ELSE '' END
      USING ERRCODE = 'SLM05',
            HINT = 'Each is a coach who is not a coach, an athlete who is not a student, or a profile linked to itself. '
                   'List and remove them with the statements of docs/runbook/migrations/05-students-role-gate.md, '
                   'then run this file again. Nothing was changed.';
  END IF;
END
$guard$;

-- ------------------------------------------------------------
-- 1. Is the caller a coach?
-- ------------------------------------------------------------
-- The role is profiles.role, which a signed-in user cannot change
-- (profiles_pin_immutable_columns). SECURITY DEFINER because it is called
-- from policies: it must not depend on what the caller may read. It answers
-- about the caller only, who can read that row anyway.
-- In a policy it is written (SELECT public.is_coach()): asked once per
-- statement, not once per row.
CREATE OR REPLACE FUNCTION public.is_coach()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
     WHERE p.id = auth.uid() AND p.role = 'coach'
  )
$$;

REVOKE ALL ON FUNCTION public.is_coach() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_coach() TO authenticated;

-- ------------------------------------------------------------
-- 2. students: who may write a row.
-- ------------------------------------------------------------
-- No INSERT policy and no DELETE policy: with row-level security on, that is
-- "nobody who goes through the API as a user". The owner of the database and
-- the service role are not subject to it. The app only ever read this table.
DROP POLICY IF EXISTS "Coaches insert students" ON public.students;
DROP POLICY IF EXISTS "Coaches delete their students" ON public.students;

-- UPDATE stays, for the columns that are not the link (notes, today). The
-- coach of the row, who is a coach — and the row it leaves must still be
-- theirs. The trigger below keeps the link itself.
DROP POLICY IF EXISTS "Coaches update their students" ON public.students;
CREATE POLICY "Coaches update their students"
  ON public.students FOR UPDATE
  USING (coach_id = auth.uid() AND (SELECT public.is_coach()))
  WITH CHECK (coach_id = auth.uid() AND (SELECT public.is_coach()));

-- ------------------------------------------------------------
-- 3. students: what a row may say.
-- ------------------------------------------------------------
-- For every writer. The policies above stop the app's users; this is what
-- keeps a row written by hand in the SQL editor, or by a function that runs
-- with the service-role key, from making a coach out of somebody who is not.
--
--   * a signed-in user cannot move the link: id, profile_id and coach_id stay
--     what they were. Moving an athlete to another coach is done without a
--     user id, where the new link is checked like a new row.
--   * a new link, or one that moves: two different profiles, the coach with
--     the role coach, the athlete with the role student.
--   * a row whose link does not move is not judged again, so a column next to
--     it can always be written.
-- A profile that does not exist is left to the foreign key, which says it
-- better.
CREATE OR REPLACE FUNCTION public.check_students_link()
RETURNS trigger AS $$
DECLARE
  v_role text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF auth.uid() IS NOT NULL
       AND (NEW.id IS DISTINCT FROM OLD.id
            OR NEW.profile_id IS DISTINCT FROM OLD.profile_id
            OR NEW.coach_id IS DISTINCT FROM OLD.coach_id) THEN
      RAISE EXCEPTION 'the coach-athlete link % cannot be changed from the app', OLD.id
        USING ERRCODE = 'insufficient_privilege',
              HINT = 'students.id, profile_id and coach_id are written by the owner of the database only.';
    END IF;
    IF NEW.profile_id IS NOT DISTINCT FROM OLD.profile_id
       AND NEW.coach_id IS NOT DISTINCT FROM OLD.coach_id THEN
      RETURN NEW;
    END IF;
  END IF;

  IF NEW.profile_id = NEW.coach_id THEN
    RAISE EXCEPTION 'students: profile % cannot be its own coach', NEW.coach_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT p.role INTO v_role FROM public.profiles p WHERE p.id = NEW.coach_id;
  IF v_role IS NOT NULL AND v_role <> 'coach' THEN
    RAISE EXCEPTION 'students.coach_id % is not a coach: its profile has the role %', NEW.coach_id, v_role
      USING ERRCODE = 'check_violation',
            HINT = 'Only a profile with the role coach can be given athletes.';
  END IF;

  SELECT p.role INTO v_role FROM public.profiles p WHERE p.id = NEW.profile_id;
  IF v_role IS NOT NULL AND v_role <> 'student' THEN
    RAISE EXCEPTION 'students.profile_id % is not an athlete: its profile has the role %', NEW.profile_id, v_role
      USING ERRCODE = 'check_violation',
            HINT = 'Only a profile with the role student can be linked to a coach.';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.check_students_link() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER trg_check_students_link
  BEFORE INSERT OR UPDATE ON public.students
  FOR EACH ROW
  EXECUTE FUNCTION public.check_students_link();

-- ------------------------------------------------------------
-- 4. The exercise library is written by a coach.
-- ------------------------------------------------------------
-- USING is what it was: the owner of a row reads it and may delete it. WITH
-- CHECK is what a new or edited row must pass, and it now asks for the role.
-- An athlete reads their coach's library through the policy next to this one,
-- which is not touched.
DROP POLICY IF EXISTS "Coaches manage own library" ON public.exercise_library;
CREATE POLICY "Coaches manage own library"
  ON public.exercise_library FOR ALL
  USING (coach_id = auth.uid())
  WITH CHECK (coach_id = auth.uid() AND (SELECT public.is_coach()));

-- ------------------------------------------------------------
-- 5. A slot, and a swap, take an exercise of the program coach's library.
-- ------------------------------------------------------------
-- "The program's coach" is students.coach_id of the athlete the program
-- belongs to. Asked when the slot is created or when its exercise changes:
-- after an athlete changed coach, the slots that still hold the former
-- coach's exercises can be edited in every other column, and take an exercise
-- of the new library the day theirs is replaced.
-- For every writer, like the rule on students. A session or an exercise that
-- does not exist is left to the foreign key.
CREATE OR REPLACE FUNCTION public.check_slot_exercise_in_coach_library()
RETURNS trigger AS $$
DECLARE
  v_program_coach uuid;
  v_library_coach uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.exercise_id IS NOT DISTINCT FROM OLD.exercise_id THEN
    RETURN NEW;
  END IF;

  SELECT st.coach_id INTO v_program_coach
    FROM public.sessions se
    JOIN public.weeks w     ON w.id = se.week_id
    JOIN public.programs p  ON p.id = w.program_id
    JOIN public.students st ON st.id = p.student_id
   WHERE se.id = NEW.session_id;
  SELECT el.coach_id INTO v_library_coach
    FROM public.exercise_library el
   WHERE el.id = NEW.exercise_id;

  IF v_program_coach IS NOT NULL AND v_library_coach IS NOT NULL
     AND v_library_coach <> v_program_coach THEN
    RAISE EXCEPTION 'exercise % is not in the library of the coach of this program', NEW.exercise_id
      USING ERRCODE = 'check_violation',
            HINT = 'An exercise slot takes an exercise from the library of its athlete''s coach.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.check_slot_exercise_in_coach_library() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER trg_check_slot_exercise_in_coach_library
  BEFORE INSERT OR UPDATE OF exercise_id ON public.exercise_slots
  FOR EACH ROW
  EXECUTE FUNCTION public.check_slot_exercise_in_coach_library();

-- The substitute of a swap. A skip has none.
--
-- The app saves a deviation as an upsert: INSERT … ON CONFLICT (exercise_slot_id)
-- DO UPDATE. PostgreSQL fires the INSERT trigger on the proposed row first,
-- whether or not the slot already has a deviation. When it has one with this
-- same substitute, the statement can only become the UPDATE of that row (or
-- fail on the unique key) and the substitute does not change: it is not asked
-- again, so that a swap made before a change of coach can still take a note.
CREATE OR REPLACE FUNCTION public.check_deviation_substitute_in_coach_library()
RETURNS trigger AS $$
DECLARE
  v_program_coach uuid;
  v_library_coach uuid;
BEGIN
  IF NEW.substitute_exercise_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.substitute_exercise_id IS NOT DISTINCT FROM OLD.substitute_exercise_id THEN
      RETURN NEW;
    END IF;
  ELSIF EXISTS (
    SELECT 1 FROM public.slot_deviations d
     WHERE d.exercise_slot_id = NEW.exercise_slot_id
       AND d.substitute_exercise_id = NEW.substitute_exercise_id
  ) THEN
    RETURN NEW;
  END IF;

  SELECT st.coach_id INTO v_program_coach
    FROM public.exercise_slots es
    JOIN public.sessions se ON se.id = es.session_id
    JOIN public.weeks w     ON w.id = se.week_id
    JOIN public.programs p  ON p.id = w.program_id
    JOIN public.students st ON st.id = p.student_id
   WHERE es.id = NEW.exercise_slot_id;
  SELECT el.coach_id INTO v_library_coach
    FROM public.exercise_library el
   WHERE el.id = NEW.substitute_exercise_id;

  IF v_program_coach IS NOT NULL AND v_library_coach IS NOT NULL
     AND v_library_coach <> v_program_coach THEN
    RAISE EXCEPTION 'substitute exercise % is not in the library of the coach of this program', NEW.substitute_exercise_id
      USING ERRCODE = 'check_violation',
            HINT = 'A swap takes an exercise from the library of the athlete''s coach.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.check_deviation_substitute_in_coach_library() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER trg_check_deviation_substitute_in_coach_library
  BEFORE INSERT OR UPDATE OF substitute_exercise_id ON public.slot_deviations
  FOR EACH ROW
  EXECUTE FUNCTION public.check_deviation_substitute_in_coach_library();

-- ------------------------------------------------------------
-- 6. Read the result back. Anything else than what was meant raises, and the
--    whole file is undone: either the database is as described, or untouched.
-- ------------------------------------------------------------
DO $verify$
DECLARE
  v_list text;
BEGIN
  -- The four functions: owned by postgres, search_path pinned, closed to a
  -- request without a session, and open to a signed-in user only where a
  -- policy calls it (is_coach).
  WITH wanted (signature, for_users) AS (
    VALUES ('public.is_coach()', true),
           ('public.check_students_link()', false),
           ('public.check_slot_exercise_in_coach_library()', false),
           ('public.check_deviation_substitute_in_coach_library()', false)
  ),
  found AS (
    SELECT w.signature, w.for_users, p.oid, p.proowner, p.proconfig
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
               CASE WHEN proconfig IS NULL OR NOT ('search_path=public, pg_temp' = ANY (proconfig))
                    THEN 'search_path is not public, pg_temp' END
             ) END AS wrong
        FROM found
    ) f
   WHERE f.wrong <> '';
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_11_05_students_role_gate did not get the functions it meant: %', v_list
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;

  -- The three triggers: on their table, calling their function, enabled.
  WITH wanted (tbl, trg, fn) AS (
    VALUES ('students',        'trg_check_students_link',                         'check_students_link'),
           ('exercise_slots',  'trg_check_slot_exercise_in_coach_library',        'check_slot_exercise_in_coach_library'),
           ('slot_deviations', 'trg_check_deviation_substitute_in_coach_library', 'check_deviation_substitute_in_coach_library')
  )
  SELECT string_agg(w.trg || ' on ' || w.tbl, ', ' ORDER BY w.trg) INTO v_list
    FROM wanted w
   WHERE NOT EXISTS (
     SELECT 1
       FROM pg_trigger t
       JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE t.tgrelid = ('public.' || w.tbl)::regclass
        AND t.tgname = w.trg
        AND NOT t.tgisinternal
        AND t.tgenabled = 'O'
        AND p.pronamespace = 'public'::regnamespace
        AND p.proname = w.fn
   );
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_11_05_students_role_gate did not get the triggers it meant: %', v_list
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;

  -- The policies. A policy this file does not know — one made by hand, under
  -- another name — would leave the door it closes open:
  --   students          row-level security on; ONE policy that writes, the
  --                     UPDATE above
  --   exercise_library  row-level security on; every policy that adds or
  --                     edits a row asks for is_coach()
  SELECT string_agg(problem, '; ' ORDER BY problem) INTO v_list
    FROM (
      SELECT 'row-level security is off on public.' || c.relname AS problem
        FROM pg_class c
       WHERE c.oid IN ('public.students'::regclass, 'public.exercise_library'::regclass)
         AND NOT c.relrowsecurity
      UNION ALL
      SELECT 'public.students still has the policy "' || pol.polname || '" for '
             || CASE pol.polcmd WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE'
                                WHEN 'd' THEN 'DELETE' ELSE 'ALL' END
        FROM pg_policy pol
       WHERE pol.polrelid = 'public.students'::regclass
         AND pol.polcmd <> 'r'
         AND NOT (pol.polname = 'Coaches update their students' AND pol.polcmd = 'w')
      UNION ALL
      SELECT 'public.students has no policy "Coaches update their students" that asks for is_coach()'
       WHERE NOT EXISTS (
         SELECT 1 FROM pg_policy pol
          WHERE pol.polrelid = 'public.students'::regclass
            AND pol.polname = 'Coaches update their students' AND pol.polcmd = 'w'
            AND pg_get_expr(pol.polqual, pol.polrelid) LIKE '%is_coach()%'
            AND pg_get_expr(pol.polwithcheck, pol.polrelid) LIKE '%is_coach()%'
       )
      UNION ALL
      SELECT 'public.exercise_library has the policy "' || pol.polname || '", which writes without asking for is_coach()'
        FROM pg_policy pol
       WHERE pol.polrelid = 'public.exercise_library'::regclass
         AND pol.polcmd IN ('a', 'w', '*')
         AND coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '') NOT LIKE '%is_coach()%'
    ) problems;
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_11_05_students_role_gate did not get the policies it meant: %', v_list
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;
END
$verify$;

INSERT INTO app_private.app_migrations (name)
VALUES ('2026_10_11_05_students_role_gate')
RETURNING name, applied_at;

-- A function joined public: PostgREST caches what is there.
NOTIFY pgrst, 'reload schema';

COMMIT;
