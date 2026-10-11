-- ============================================================
-- 07 — A new account has a name, and the owner can make a coach
-- wave 1 · Checkpoint A2 · required · findings P20, B10
--
-- TWO THINGS ABOUT public.profiles, each one function body.
--
-- B10 — the name. Every account gets its profile from a trigger on
-- auth.users (handle_new_user). It stored the name the account was created
-- with, or '' — and an account made in the dashboard ("Add user") or by an
-- invitation carries no name at all. The app shows a placeholder for an empty
-- name; the pushes to the coach do not: they are written with
-- COALESCE(name, 'Your athlete'), which an empty string passes, and read
-- " completed Session 3". With several athletes the coach cannot tell whose.
--
-- P20 — the role. A new account is always a student; a coach is made by the
-- owner of the database, with the statement README and INVARIANTS give:
--   UPDATE public.profiles SET role = 'coach' WHERE id = …
-- The trigger that keeps a signed-in user from writing their own role
-- (profiles_pin_immutable_columns) put the role back for EVERY caller, the
-- SQL editor included. The statement answered "UPDATE 1" and changed nothing:
-- a second coach could not be made, and a coach who lost their account could
-- not get the role on a new one.
--
-- WHAT THIS FILE DOES.
--   1. handle_new_user stores a name that is never empty: the name the
--      account was created with, without the white space around it; else what
--      stands before the @ of its e-mail address; else 'Athlete'. Never NULL
--      either — profiles.full_name is NOT NULL, and an INSERT that fails in
--      this trigger fails the creation of the account.
--   2. profiles_pin_immutable_columns keeps the role when the request carries
--      a user id — the app, the API, a function called from either — and lets
--      it change otherwise: the SQL editor, the service-role key. id and
--      created_at stay what they were for everyone, as before.
--   3. A role that changes is held to the rule of migration 05 — a link of
--      public.students joins a coach to an athlete: an account that is
--      somebody's athlete is not made a coach, and a coach who has athletes
--      does not stop being one. Refused with a sentence (23514). Without
--      this, the statement that now works would be a way to write the very
--      rows the gate of migration 05 refuses.
--
-- WHAT A CLIENT SEES. With the app that is deployed today: nothing changes
-- for an account that exists. An account created from now on without a name
-- is shown under the first part of its e-mail address — to itself, to its
-- coach, in the notifications — until its owner types a name in Profile.
-- A signed-in user who sends a role with their own profile gets what they
-- got before: the write is accepted, the role is not changed.
--
-- No row of the app is written by this file. The profiles that have an empty
-- name today keep it: the audit counts them (line 10) and the runbook page
-- has the statement that names them.
--
-- Backward compatible: yes, with every client ever deployed.
-- Audit:    supabase/audits/2026_10_11_07_profile_rules.audit.sql
-- Rollback: supabase/rollbacks/2026_10_11_07_profile_rules.down.sql (reopens P20 / B10)
-- Runbook:  docs/runbook/migrations/07-profile-rules.md
-- ============================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
DECLARE
  v_strangers text;
BEGIN
  -- First of all, because no other role can even look at the ledger. What is
  -- re-created below must belong to the role that owns the tables: a SECURITY
  -- DEFINER function runs as its owner, and the default privileges that keep
  -- a new function closed (migration 03) are those of `postgres`.
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'migration 2026_10_11_07_profile_rules must be run as postgres, not as %', current_user
      USING HINT = 'Run it from the SQL editor or with `supabase db query --linked`. Nothing was changed.';
  END IF;

  -- Asked before the ledger is read: without it the answer would be
  -- "relation does not exist" instead of this one.
  IF to_regclass('app_private.app_migrations') IS NULL THEN
    RAISE EXCEPTION 'migration 2026_10_11_07_profile_rules needs 2026_10_11_06_pin_student_writes, which is not applied'
      USING ERRCODE = 'SLM02', HINT = 'Apply migrations 01 to 06 first. Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_11_07_profile_rules') THEN
    RAISE EXCEPTION 'migration 2026_10_11_07_profile_rules is already applied'
      USING ERRCODE = 'SLM01', HINT = 'Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_11_06_pin_student_writes') THEN
    RAISE EXCEPTION 'migration 2026_10_11_07_profile_rules needs 2026_10_11_06_pin_student_writes, which is not applied'
      USING ERRCODE = 'SLM02', HINT = 'Apply that file first. Nothing was changed.';
  END IF;

  -- CREATE OR REPLACE replaces a function with the SAME argument types. A
  -- copy of one of these with other arguments would keep its old body, and
  -- nothing would say so.
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text)
    INTO v_strangers
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('handle_new_user', 'profiles_pin_immutable_columns')
     -- By oid, names written with their schema: the answer must not depend on
     -- the search_path of whoever runs the file.
     AND NOT EXISTS (
       SELECT 1
         FROM unnest(ARRAY[
                'public.handle_new_user()',
                'public.profiles_pin_immutable_columns()'
              ]) AS known(signature)
        WHERE to_regprocedure(known.signature) = p.oid
     );
  IF v_strangers IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_11_07_profile_rules would not replace: %', v_strangers
      USING HINT = 'A function of this file exists with other arguments. Nothing was changed. Stop and report.';
  END IF;

  -- The trigger on auth.users is NOT written by this file: the table is the
  -- platform's, and the trigger has been there since the first account. A
  -- new body does nothing where no trigger calls it — and there, an account
  -- created today gets no profile at all, which is the thing to report.
  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger t
     WHERE t.tgrelid = to_regclass('auth.users')
       AND t.tgfoid = to_regprocedure('public.handle_new_user()')
       AND NOT t.tgisinternal
       AND t.tgenabled IN ('O', 'A')
  ) THEN
    RAISE EXCEPTION 'migration 2026_10_11_07_profile_rules: no trigger on auth.users calls public.handle_new_user(), or it is switched off'
      USING HINT = 'An account created today gets no profile, with or without this file. Nothing was changed. Stop and report.';
  END IF;
END
$guard$;

-- ------------------------------------------------------------
-- 1. A new account has a name (B10).
-- ------------------------------------------------------------
-- Everything but the name is the text from before: the role is 'student',
-- whatever the account says of itself.
--
-- The name, in this order:
--   * raw_user_meta_data->>'full_name' — what a sign-up form or an invitation
--     sends — without the white space around it;
--   * what stands before the @ of the e-mail address. "Add user" in the
--     dashboard asks for an address and a password and nothing else, so this
--     is what most accounts start with;
--   * 'Athlete' — an account without an address (a phone number, an anonymous
--     sign-in: neither is switched on, and both must still get a profile).
-- White space is [[:space:]]: blanks, tabs, line ends. Written as a class and
-- not as \s, so that the text reads the same whatever
-- standard_conforming_strings is.
--
-- It must never raise and never produce NULL: this runs inside the INSERT
-- that creates the account, and profiles.full_name is NOT NULL. Every step
-- answers NULL for a NULL — metadata that is missing, that is not an object,
-- an address that is missing.
--
-- SECURITY DEFINER, as before: the INSERT into auth.users is made by GoTrue,
-- which holds nothing on public.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
DECLARE
  v_name text;
BEGIN
  v_name := NULLIF(regexp_replace(NEW.raw_user_meta_data->>'full_name',
                                  '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
  IF v_name IS NULL THEN
    v_name := NULLIF(regexp_replace(split_part(NEW.email, '@', 1),
                                    '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
  END IF;

  INSERT INTO public.profiles (id, role, full_name)
  VALUES (
    NEW.id,
    -- Never trust client-supplied metadata for the role (2026_07_12): the
    -- anon key is public, so signup metadata is attacker-controlled. A coach
    -- is made by the owner of the database (profiles_pin_immutable_columns).
    'student',
    -- Never empty (review B10): an empty name passes every
    -- COALESCE(name, 'Your athlete') of the push triggers.
    COALESCE(v_name, 'Athlete')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 2. The role of a profile: kept for a signed-in user, the owner's to
--    change (P20).
-- ------------------------------------------------------------
-- "Users update own profile" lets a signed-in user write their own row, every
-- column of it: this trigger is what keeps the role out of their hands. It is
-- keyed on the user id of the request, like the gate on public.students:
--   * with one — the app, the API, and any function called from them, a
--     SECURITY DEFINER one included — the role stays what it was. Silent: the
--     rest of the write (the name) is saved.
--   * without one — the SQL editor, `supabase db query`, the service-role
--     key — the role is written. Those callers own the database; a request
--     without a session (anon) is not one of them: it has no policy on this
--     table and reaches no row.
-- id and created_at stay what they were for every caller, as before.
--
-- A role that does change is held to what migration 05 holds every row of
-- public.students to — a coach on one side, an athlete on the other:
--   * an account that is somebody's athlete is not made a coach;
--   * a coach who has athletes does not stop being one.
-- Raised (23514), not silent: the caller is the owner, who has to know that
-- nothing happened. The gate of migration 05 judges a link when it is
-- written; this is the same rule, asked when the other side of it moves.
--
-- SECURITY INVOKER, as before: the two reads of public.students are made by
-- a caller without a user id, and those who reach a row of this table
-- without one — the owner, the service role — read every row of that one.
CREATE OR REPLACE FUNCTION public.profiles_pin_immutable_columns()
RETURNS trigger AS $$
DECLARE
  v_athletes integer;
BEGIN
  NEW.id := OLD.id;
  NEW.created_at := OLD.created_at;

  -- A request with a user id: nobody gives themselves — or anybody — a role.
  IF auth.uid() IS NOT NULL THEN
    NEW.role := OLD.role;
    RETURN NEW;
  END IF;

  -- Without one, the role is the owner's to change (review P20) — as long as
  -- every link of public.students still joins a coach to an athlete.
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    IF NEW.role = 'coach' AND EXISTS (
         SELECT 1 FROM public.students s WHERE s.profile_id = OLD.id
       ) THEN
      RAISE EXCEPTION 'profile % (%) cannot be made a coach: it is the athlete of a coach', OLD.id, OLD.full_name
        USING ERRCODE = 'check_violation',
              HINT = 'An account is a coach or an athlete, not both: a coach gets an account of their own. Nothing was written.';
    END IF;
    IF NEW.role IS DISTINCT FROM 'coach' THEN
      SELECT count(*) INTO v_athletes FROM public.students s WHERE s.coach_id = OLD.id;
      IF v_athletes > 0 THEN
        RAISE EXCEPTION 'profile % (%) cannot stop being a coach: it has % athlete(s)', OLD.id, OLD.full_name, v_athletes
          USING ERRCODE = 'check_violation',
                HINT = 'Its athletes go to another coach first. Nothing was written.';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.profiles_pin_immutable_columns() FROM PUBLIC, anon, authenticated;

-- The trigger is written again (the same definition: nothing moves where it
-- is in place). One that had been dropped or switched off by hand comes back
-- here — and with it the only thing that keeps a signed-in user from writing
-- their own role.
CREATE OR REPLACE TRIGGER profiles_pin_immutable_columns
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.profiles_pin_immutable_columns();

-- ------------------------------------------------------------
-- 3. Read the result back. Anything else than what was meant raises, and the
--    whole file is undone: either the database is as described, or untouched.
-- ------------------------------------------------------------
DO $verify$
DECLARE
  v_list text;
BEGIN
  -- The two functions: owned by postgres, search_path pinned, closed to the
  -- API — a trigger fires whatever the privileges of the user whose statement
  -- fires it. handle_new_user runs as its owner, or no account can be
  -- created; the pin runs as whoever writes the profile.
  WITH wanted (signature, definer) AS (
    VALUES ('public.handle_new_user()', true),
           ('public.profiles_pin_immutable_columns()', false)
  ),
  found AS (
    SELECT w.signature, w.definer, p.oid, p.proowner, p.proconfig, p.prosecdef
      FROM wanted w
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(w.signature)
  )
  SELECT string_agg(f.signature || ': ' || f.wrong, '; ' ORDER BY f.signature) INTO v_list
    FROM (
      SELECT signature,
             CASE WHEN oid IS NULL THEN 'missing' ELSE concat_ws(', ',
               CASE WHEN pg_get_userbyid(proowner) <> 'postgres' THEN 'not owned by postgres' END,
               CASE WHEN has_function_privilege('anon', oid, 'EXECUTE') THEN 'anon may execute it' END,
               CASE WHEN has_function_privilege('authenticated', oid, 'EXECUTE')
                    THEN 'a signed-in user may execute it' END,
               CASE WHEN prosecdef AND NOT definer THEN 'it runs as its owner' END,
               CASE WHEN NOT prosecdef AND definer THEN 'it does not run as its owner' END,
               CASE WHEN proconfig IS NULL OR NOT ('search_path=public, pg_temp' = ANY (proconfig))
                    THEN 'search_path is not public, pg_temp' END
             ) END AS wrong
        FROM found
    ) f
   WHERE f.wrong <> '';
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_11_07_profile_rules did not get the functions it meant: %', v_list
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;

  -- The pin: on public.profiles, before an update, calling its function,
  -- enabled.
  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger t
     WHERE t.tgrelid = 'public.profiles'::regclass
       AND t.tgname = 'profiles_pin_immutable_columns'
       AND t.tgfoid = to_regprocedure('public.profiles_pin_immutable_columns()')
       AND NOT t.tgisinternal
       AND t.tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'migration 2026_10_11_07_profile_rules did not get the triggers it meant: profiles_pin_immutable_columns on profiles'
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;
END
$verify$;

INSERT INTO app_private.app_migrations (name)
VALUES ('2026_10_11_07_profile_rules')
RETURNING name, applied_at;

-- No NOTIFY: two function bodies. No table, no column, no key and no function
-- header moved, so PostgREST has nothing to learn.

COMMIT;
