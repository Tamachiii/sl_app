-- ============================================================
-- 22 — A client error is read by its author and the coach of its author;
--      an account reports 30 an hour at most
-- wave 3 · Checkpoint C1 · required · findings B6, L20
--
-- THE HOLE. client_errors holds what the app reports when it breaks: the
-- message, the stack, the address of the page and the browser of an
-- account. "Coaches read client errors" lets ANY coach read EVERY line —
-- the errors of the athletes of another coach included (B6, L20). And the
-- INSERT policy holds a report to its author but not to a number: a page
-- caught in a loop, or a script, fills the table without end (L20).
--
-- WHAT THIS FILE DOES.
--   1. "Coaches read client errors" is replaced by "Authors and their coach
--      read client errors": a line is read by
--        * its author (user_id is the caller);
--        * the coach of its author (students.coach_id, the link of today);
--        * every coach, when it has no author: the lines the database
--          writes (record_push_failures() of the optional migration 19,
--          role 'database') and those of an account that was deleted
--          (ON DELETE SET NULL). INVARIANTS: those stay readable by a coach.
--      "Is a coach" is asked of profiles in the policy itself, not with
--      is_coach(): a SELECT goes through it (migrations/README.md, the
--      rule of migration 05).
--   2. A trigger, trg_cap_client_errors, BEFORE INSERT, for a request that
--      carries a user id:
--        * the line is dated when it arrives (created_at := now()): a date
--          sent by the client would take it out of the hour counted below,
--          and out of reach of run_retention();
--        * when the caller has 30 lines of the last hour already, the line
--          is dropped without a word (RETURN NULL): the request answers as
--          if it was saved. The app that reports ignores the answer either
--          way (src/lib/errorReporter.js), and a refusal would be one more
--          line in the logs of the database per line refused.
--      A request without a user id is not judged: the owner, the service
--      role, the job of migration 19 (a line without an author), a restore.
--      Two requests of one account in the same instant can both pass at 29:
--      it is a ceiling of about 30 an hour, not a count.
--
-- WHAT IT DOES NOT DO. Delete old lines: run_retention() of migration 18
-- deletes a line 90 days after it was reported — the retention L20 asks for
-- is there, in the one place that deletes by age (migrations/README.md: not
-- a trigger that deletes on every insert). No line is written or deleted by
-- this file.
--
-- WHAT A CLIENT SEES. The coach, in the app that is deployed: the list of
-- errors at the bottom of the roster shows the lines of their athletes,
-- their own, and those without an author — not those of the athletes of
-- another coach, nor of an account that is no longer their athlete. The
-- athlete: nothing — the app reads the list for a coach only. An app that
-- reports more than 30 errors in an hour: the 31st and the next are not
-- kept, and it is not told.
--
-- Backward compatible: yes, with every client ever deployed.
-- Audit:    supabase/audits/2026_10_16_22_client_errors_scope.audit.sql
-- Rollback: supabase/rollbacks/2026_10_16_22_client_errors_scope.down.sql (reopens B6 and the cap of L20)
-- Runbook:  docs/runbook/migrations/22-client-errors-scope.md
-- ============================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
DECLARE
  v_found text;
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'migration 2026_10_16_22_client_errors_scope must be run as postgres, not as %', current_user
      USING HINT = 'Run it from the SQL editor or with `supabase db query --linked`. Nothing was changed.';
  END IF;

  IF to_regclass('app_private.app_migrations') IS NULL THEN
    RAISE EXCEPTION 'migration 2026_10_16_22_client_errors_scope needs 2026_10_16_21_rpe_half_steps_day_check, which is not applied'
      USING ERRCODE = 'SLM02', HINT = 'Apply migrations 01 to 21 first. Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_16_22_client_errors_scope') THEN
    RAISE EXCEPTION 'migration 2026_10_16_22_client_errors_scope is already applied'
      USING ERRCODE = 'SLM01', HINT = 'Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_16_21_rpe_half_steps_day_check') THEN
    RAISE EXCEPTION 'migration 2026_10_16_22_client_errors_scope needs 2026_10_16_21_rpe_half_steps_day_check, which is not applied'
      USING ERRCODE = 'SLM02', HINT = 'Apply that file first. Nothing was changed.';
  END IF;

  -- The policies of client_errors are the two of 2026_07_13: one to insert,
  -- one to read. A third one, made by hand, would go on letting through
  -- what this file closes.
  SELECT string_agg(format('"%s" (%s)', p.polname,
                           CASE p.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE'
                                         WHEN 'd' THEN 'DELETE' ELSE 'ALL' END), ', ' ORDER BY p.polname)
    INTO v_found
    FROM pg_policy p
   WHERE p.polrelid = 'public.client_errors'::regclass
     AND NOT (p.polname = 'Users insert own client errors' AND p.polcmd = 'a')
     AND NOT (p.polname = 'Coaches read client errors' AND p.polcmd = 'r');
  IF v_found IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_16_22_client_errors_scope found a policy it does not know on client_errors: %', v_found
      USING HINT = 'Made by hand or by a file that is not in the ledger. Nothing was changed. Stop and report.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy p
                  WHERE p.polrelid = 'public.client_errors'::regclass
                    AND p.polname = 'Coaches read client errors' AND p.polcmd = 'r') THEN
    RAISE EXCEPTION 'migration 2026_10_16_22_client_errors_scope would not replace "Coaches read client errors": it is not there'
      USING HINT = 'Nothing was changed. Stop and report.';
  END IF;

  SELECT string_agg(w.what, ', ' ORDER BY w.what) INTO v_found
    FROM (
      SELECT 'the function ' || p.oid::regprocedure::text AS what
        FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'cap_client_errors'
      UNION ALL
      SELECT 'the trigger ' || t.tgname || ' on client_errors'
        FROM pg_trigger t
       WHERE t.tgrelid = 'public.client_errors'::regclass AND NOT t.tgisinternal
    ) w;
  IF v_found IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_16_22_client_errors_scope would not create: % is already there', v_found
      USING HINT = 'Made by hand or by a file that is not in the ledger. Nothing was changed. Stop and report.';
  END IF;
END
$guard$;

-- ------------------------------------------------------------
-- 1. Who reads a line.
-- ------------------------------------------------------------
DROP POLICY "Coaches read client errors" ON public.client_errors;

CREATE POLICY "Authors and their coach read client errors"
  ON public.client_errors FOR SELECT
  USING (
    user_id = (SELECT auth.uid())
    OR user_id IN (SELECT s.profile_id FROM public.students s WHERE s.coach_id = (SELECT auth.uid()))
    OR (
      user_id IS NULL
      AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = (SELECT auth.uid()) AND p.role = 'coach')
    )
  );

-- ------------------------------------------------------------
-- 2. How many lines an account reports in an hour.
-- ------------------------------------------------------------
-- SECURITY DEFINER: it counts the caller's lines whatever the caller may
-- read. It counts by auth.uid(), not by the user_id the row carries — the
-- INSERT policy holds the two to one value, and a row that names somebody
-- else is refused by it afterwards, whatever is counted here.
CREATE FUNCTION public.cap_client_errors()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  NEW.created_at := now();

  IF (SELECT count(*)
        FROM (SELECT 1
                FROM public.client_errors e
               WHERE e.user_id = auth.uid()
                 AND e.created_at > now() - interval '1 hour'
               LIMIT 30) recent) >= 30 THEN
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.cap_client_errors() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trg_cap_client_errors
  BEFORE INSERT ON public.client_errors
  FOR EACH ROW EXECUTE FUNCTION public.cap_client_errors();

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
      SELECT 'the policies of client_errors are ' || coalesce(string_agg(p.polname, ', ' ORDER BY p.polname), 'none') AS wrong
        FROM pg_policy p
       WHERE p.polrelid = 'public.client_errors'::regclass
      HAVING coalesce(string_agg(p.polname, ', ' ORDER BY p.polname), '')
             <> 'Authors and their coach read client errors, Users insert own client errors'
      UNION ALL
      SELECT 'client_errors has no row-level security'
       WHERE NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.client_errors'::regclass)
      UNION ALL
      SELECT 'the trigger trg_cap_client_errors is not the one meant'
       WHERE NOT EXISTS (
         SELECT 1 FROM pg_trigger t
          WHERE t.tgrelid = 'public.client_errors'::regclass AND t.tgname = 'trg_cap_client_errors'
            AND NOT t.tgisinternal AND t.tgenabled = 'O'
            AND t.tgfoid = to_regprocedure('public.cap_client_errors()')
            -- a row trigger, BEFORE, on INSERT
            AND t.tgtype = 1 + 2 + 4)
      UNION ALL
      SELECT 'public.cap_client_errors() is executable by a user, does not run as its owner or has no search_path'
        FROM pg_proc p
       WHERE p.oid = to_regprocedure('public.cap_client_errors()')
         AND (has_function_privilege('anon', p.oid, 'EXECUTE')
              OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
              OR NOT p.prosecdef
              OR NOT ('search_path=public, pg_temp' = ANY (coalesce(p.proconfig, '{}'))))
    ) w;
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_16_22_client_errors_scope did not get what it meant: %', v_list
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;
END
$verify$;

INSERT INTO app_private.app_migrations (name)
VALUES ('2026_10_16_22_client_errors_scope')
RETURNING name, applied_at;

-- A function joined public (a trigger function, which nobody calls through
-- the API): the cache is told all the same.
NOTIFY pgrst, 'reload schema';

COMMIT;
