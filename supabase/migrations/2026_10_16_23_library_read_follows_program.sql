-- ============================================================
-- 23 — An exercise is read by whoever reads what uses it
-- wave 3 · Checkpoint C1 · required · finding B8
--
-- THE HOLE. An exercise of a library is read by the coach it belongs to
-- ("Coaches manage own library") and by that coach's athletes ("Students
-- read their coachs library"). When an athlete changes coach
-- (transfer_student, migration 10), their blocks keep the exercises of the
-- former coach's library — a slot holds an exercise, a swap a substitute,
-- a goal its exercise — and nobody who reads those blocks reads them any
-- more: the athlete is no longer that coach's, and the new coach is not
-- the owner. The app embeds the exercise in every read of a session, gets
-- NULL, and the session of the athlete, the review and the editor of the
-- coach break on it (B8; INVARIANTS: "What it does not move").
--
-- WHAT THIS FILE DOES. A third policy to read exercise_library, "Users read
-- the exercises their training uses": an exercise is read by an account
-- when something it reads names it —
--   * an exercise slot of a program of an athlete it is, or coaches
--     (students.profile_id or students.coach_id: the policies of programs);
--   * a swap (slot_deviations.substitute_exercise_id) on such a slot;
--   * a goal it reads: its own as the athlete, or one of its athlete that
--     it holds as their coach (the policy of goals).
-- The question is asked by public.exercise_readable_through_use(uuid):
-- STABLE, SECURITY DEFINER — it reads the slots, the swaps and the goals
-- whatever the caller may read, and answers true or false, never NULL —,
-- executable by a signed-in user, whose reads of the library call it.
--
-- The policy is named to come after the two others: PostgreSQL asks the
-- permissive policies of a table in the order of their names, and stops at
-- the first that says yes. An exercise of the caller's library, or of the
-- library of the caller's coach, never reaches the function.
--
-- WHAT IT DOES NOT TOUCH. Who writes an exercise: the new policy is for
-- SELECT, and "Coaches manage own library" stays the one that lets a coach
-- write, update or delete — their own exercises only. Which exercise a new
-- slot or a new swap may take: the library of the program's coach, as
-- before (migration 05) — the copy functions and save_draft_tree ask the
-- library by its coach_id, and leave the former coach's exercises out as
-- before. No row is written.
--
-- WHAT A CLIENT SEES. Nothing for an athlete who never changed coach. After
-- a change of coach, the exercises of the blocks that were written before it
-- have their name again — for the athlete and for the new coach. The app
-- that is deployed reads the library of an athlete without a filter: it
-- lists those exercises next to the library of the coach of today, and a
-- swap to one of them is refused by the gate of migration 05 (23514), as
-- any exercise of another library is.
--
-- Backward compatible: yes, with every client ever deployed.
-- Audit:    supabase/audits/2026_10_16_23_library_read_follows_program.audit.sql
-- Rollback: supabase/rollbacks/2026_10_16_23_library_read_follows_program.down.sql (reopens B8)
-- Runbook:  docs/runbook/migrations/23-library-read-follows-program.md
-- ============================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
DECLARE
  v_found text;
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'migration 2026_10_16_23_library_read_follows_program must be run as postgres, not as %', current_user
      USING HINT = 'Run it from the SQL editor or with `supabase db query --linked`. Nothing was changed.';
  END IF;

  IF to_regclass('app_private.app_migrations') IS NULL THEN
    RAISE EXCEPTION 'migration 2026_10_16_23_library_read_follows_program needs 2026_10_16_22_client_errors_scope, which is not applied'
      USING ERRCODE = 'SLM02', HINT = 'Apply migrations 01 to 22 first. Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_16_23_library_read_follows_program') THEN
    RAISE EXCEPTION 'migration 2026_10_16_23_library_read_follows_program is already applied'
      USING ERRCODE = 'SLM01', HINT = 'Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_16_22_client_errors_scope') THEN
    RAISE EXCEPTION 'migration 2026_10_16_23_library_read_follows_program needs 2026_10_16_22_client_errors_scope, which is not applied'
      USING ERRCODE = 'SLM02', HINT = 'Apply that file first. Nothing was changed.';
  END IF;

  SELECT string_agg(w.what, ', ' ORDER BY w.what) INTO v_found
    FROM (
      SELECT 'the function ' || p.oid::regprocedure::text AS what
        FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'exercise_readable_through_use'
      UNION ALL
      SELECT 'the policy "' || p.polname || '"'
        FROM pg_policy p
       WHERE p.polrelid = 'public.exercise_library'::regclass
         AND p.polname = 'Users read the exercises their training uses'
    ) w;
  IF v_found IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_16_23_library_read_follows_program would not create: % is already there', v_found
      USING HINT = 'Made by hand or by a file that is not in the ledger. Nothing was changed. Stop and report.';
  END IF;

  -- What the function is written with: its body is checked when it is
  -- created, but a name missing would be the message of CREATE FUNCTION.
  SELECT string_agg(c.tbl || '.' || c.col, ', ' ORDER BY c.tbl, c.col) INTO v_found
    FROM (VALUES ('public.exercise_slots', 'exercise_id'), ('public.exercise_slots', 'session_id'),
                 ('public.sessions', 'week_id'), ('public.weeks', 'program_id'), ('public.programs', 'student_id'),
                 ('public.students', 'profile_id'), ('public.students', 'coach_id'),
                 ('public.slot_deviations', 'substitute_exercise_id'), ('public.slot_deviations', 'exercise_slot_id'),
                 ('public.goals', 'exercise_id'), ('public.goals', 'student_id'), ('public.goals', 'coach_id')
         ) AS c (tbl, col)
   WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a
                      WHERE a.attrelid = to_regclass(c.tbl) AND a.attname = c.col AND NOT a.attisdropped);
  IF v_found IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_16_23_library_read_follows_program does not find what its function is written with: %', v_found
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;
END
$guard$;

-- ------------------------------------------------------------
-- The question, asked once per exercise that the two other policies did not
-- let through.
-- ------------------------------------------------------------
CREATE FUNCTION public.exercise_readable_through_use(p_exercise_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
           SELECT 1
             FROM public.exercise_slots es
             JOIN public.sessions se ON se.id = es.session_id
             JOIN public.weeks w     ON w.id = se.week_id
             JOIN public.programs p  ON p.id = w.program_id
             JOIN public.students st ON st.id = p.student_id
            WHERE es.exercise_id = p_exercise_id
              AND (st.profile_id = auth.uid() OR st.coach_id = auth.uid()))
      OR EXISTS (
           SELECT 1
             FROM public.slot_deviations d
             JOIN public.exercise_slots es ON es.id = d.exercise_slot_id
             JOIN public.sessions se ON se.id = es.session_id
             JOIN public.weeks w     ON w.id = se.week_id
             JOIN public.programs p  ON p.id = w.program_id
             JOIN public.students st ON st.id = p.student_id
            WHERE d.substitute_exercise_id = p_exercise_id
              AND (st.profile_id = auth.uid() OR st.coach_id = auth.uid()))
      OR EXISTS (
           SELECT 1
             FROM public.goals g
            WHERE g.exercise_id = p_exercise_id
              AND (g.student_id = auth.uid()
                   OR (g.coach_id = auth.uid()
                       AND EXISTS (SELECT 1 FROM public.students st
                                    WHERE st.profile_id = g.student_id AND st.coach_id = auth.uid()))))
$$;

REVOKE ALL ON FUNCTION public.exercise_readable_through_use(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.exercise_readable_through_use(uuid) TO authenticated;

CREATE POLICY "Users read the exercises their training uses"
  ON public.exercise_library FOR SELECT
  USING (public.exercise_readable_through_use(id));

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
      SELECT 'the policy "Users read the exercises their training uses" is not the one meant' AS wrong
       WHERE NOT EXISTS (
         SELECT 1 FROM pg_policy p
          WHERE p.polrelid = 'public.exercise_library'::regclass
            AND p.polname = 'Users read the exercises their training uses'
            AND p.polcmd = 'r' AND p.polpermissive
            AND pg_get_expr(p.polqual, p.polrelid) IN ('exercise_readable_through_use(id)',
                                                       'public.exercise_readable_through_use(id)'))
      UNION ALL
      SELECT 'public.exercise_readable_through_use(uuid) is not STABLE, does not run as its owner, has no search_path, or is not executable by a signed-in user alone'
        FROM pg_proc p
       WHERE p.oid = to_regprocedure('public.exercise_readable_through_use(uuid)')
         AND (p.provolatile <> 's' OR NOT p.prosecdef
              OR NOT ('search_path=public, pg_temp' = ANY (coalesce(p.proconfig, '{}')))
              OR has_function_privilege('anon', p.oid, 'EXECUTE')
              OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE'))
      UNION ALL
      SELECT 'the policies that write exercise_library changed: ' || string_agg(p.polname, ', ' ORDER BY p.polname)
        FROM pg_policy p
       WHERE p.polrelid = 'public.exercise_library'::regclass AND p.polcmd <> 'r'
      HAVING string_agg(p.polname, ', ' ORDER BY p.polname) IS DISTINCT FROM 'Coaches manage own library'
    ) w;
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_16_23_library_read_follows_program did not get what it meant: %', v_list
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;
END
$verify$;

INSERT INTO app_private.app_migrations (name)
VALUES ('2026_10_16_23_library_read_follows_program')
RETURNING name, applied_at;

-- A function joined public: PostgREST learns of it when its schema cache is
-- reloaded.
NOTIFY pgrst, 'reload schema';

COMMIT;
