-- ============================================================
-- 14 — Table privileges: nothing without a session, rows for a signed-in
--      user, and the same for a table created later
-- wave 1 · Checkpoint A3 · required · finding L24
--
-- WHO HELD WHAT (L24). Supabase's default privileges grant EVERY privilege on
-- every table `postgres` creates in `public` to `anon`, `authenticated` and
-- `service_role`, by name. The repository never took any of it back: on all
-- 20 tables a request without a session — the anon key, which ships in the
-- app's JavaScript — and every signed-in user hold SELECT, INSERT, UPDATE,
-- DELETE, TRUNCATE, REFERENCES, TRIGGER and MAINTAIN. Row-level security is
-- the only gate, and it is a gate for ROWS:
--   * TRUNCATE is not subject to it, and fires none of the triggers that
--     keep logged training from being deleted (migration 04). `TRUNCATE
--     public.profiles CASCADE`, run as `anon` or as any signed-in user,
--     empties every table of the app.
--   * MAINTAIN (PostgreSQL 17) is CLUSTER, VACUUM FULL and REINDEX:
--     statements that lock a table, or its indexes, against everyone else
--     while they run.
--   * TRIGGER and REFERENCES are for someone who creates triggers and foreign
--     keys. Nobody who arrives through the API does.
-- None of it is reachable today: the API sends SELECT, INSERT, UPDATE, DELETE
-- and calls to functions, never a TRUNCATE. It is one mistake away — a
-- function that runs with the caller's rights and executes a text it was
-- handed, a table created without row-level security, which the anon key
-- could then read and write in full.
--
-- WHAT THIS FILE DOES.
--   1. Takes every privilege on every table, view and sequence of `public`
--      away from `anon` — and from PUBLIC, which holds none, so that the
--      result does not depend on that.
--   2. Leaves `authenticated` the four privileges row-level security judges
--      row by row — SELECT, INSERT, UPDATE, DELETE — and takes TRUNCATE,
--      REFERENCES, TRIGGER and MAINTAIN away. On a sequence it leaves USAGE
--      (the next number, for a serial column) and takes SELECT and UPDATE
--      (setval) away. `public` holds no sequence and no view today.
--   3. Changes what a table or a sequence created LATER by `postgres` in
--      `public` starts with, to the same: nothing for `anon`, the four (or
--      USAGE) for `authenticated`. That holds for one created by hand in the
--      SQL editor too.
--   `service_role` (the Edge Functions) and the owner keep everything.
--   No table, no column, no policy, no function and no row is touched.
--
-- WHAT IT DOES NOT DO. It grants nothing. A table on which a signed-in user
-- lacks one of the four today (there is none in the repository) still lacks
-- it afterwards: line 7 of the audit lists them, before and after.
--
-- WHAT A CLIENT SEES. Signed in, with the app that is deployed today:
-- nothing. Its requests are SELECT, INSERT, UPDATE and DELETE, judged by the
-- same policies as before. Without a session (the anon key alone), every
-- table of `public` now refuses every request — "permission denied for
-- table …" (42501) — before a policy is looked at:
--   * 11 tables answered a read with no row: bodyweight_logs, client_errors,
--     exercise_library, goals, messages, notifications, profiles, programs,
--     push_subscriptions, scheduled_pushes, students;
--   * the 9 others have refused since migration 03, for the function their
--     policies call: the code is the same, the message names the table now;
--   * an UPDATE or a DELETE that was accepted and reached no row is refused.
-- The app sends no request without a session; the one way there is an expired
-- session that could not be renewed
-- (docs/runbook/migrations/14-table-grants-lockdown.md).
--
-- IT CHECKS ITSELF. A REVOKE removes what the role running it granted, and
-- says nothing about the rest: this file refuses to run as another role than
-- `postgres` or when `public` holds a table `postgres` does not own, and its
-- last block reads the result back and raises — which undoes everything — if
-- `anon` still holds a privilege somewhere, or `authenticated` one of those
-- taken away.
--
-- Backward compatible: yes, for a signed-in client — every one ever deployed.
-- Audit:    supabase/audits/2026_10_13_14_table_grants_lockdown.audit.sql
-- Rollback: supabase/rollbacks/2026_10_13_14_table_grants_lockdown.down.sql (reopens L24)
-- Runbook:  docs/runbook/migrations/14-table-grants-lockdown.md
-- ============================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
DECLARE
  v_list text;
BEGIN
  -- First of all, because no other role can even look at the ledger. The
  -- default privileges below are those of the role that creates the tables,
  -- and a REVOKE only removes what the role running it granted.
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'migration 2026_10_13_14_table_grants_lockdown must be run as postgres, not as %', current_user
      USING HINT = 'Run it from the SQL editor or with `supabase db query --linked`. Nothing was changed.';
  END IF;

  -- Asked before the ledger is read: without it the answer would be
  -- "relation does not exist" instead of this one.
  IF to_regclass('app_private.app_migrations') IS NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_14_table_grants_lockdown needs 2026_10_13_13_ensure_claim_rpcs, which is not applied'
      USING ERRCODE = 'SLM02', HINT = 'Apply migrations 01 to 13 first. Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_13_14_table_grants_lockdown') THEN
    RAISE EXCEPTION 'migration 2026_10_13_14_table_grants_lockdown is already applied'
      USING ERRCODE = 'SLM01', HINT = 'Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_13_13_ensure_claim_rpcs') THEN
    RAISE EXCEPTION 'migration 2026_10_13_14_table_grants_lockdown needs 2026_10_13_13_ensure_claim_rpcs, which is not applied'
      USING ERRCODE = 'SLM02', HINT = 'Apply that file first. Nothing was changed.';
  END IF;

  -- The privileges on a table are its owner's to take back. On one that
  -- another role owns, the REVOKE below would answer with a warning and
  -- leave everything as it is.
  SELECT string_agg(c.relname || ' (' || pg_get_userbyid(c.relowner) || ')', ', ' ORDER BY c.relname) INTO v_list
    FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace
     AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
     AND pg_get_userbyid(c.relowner) <> 'postgres';
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_14_table_grants_lockdown cannot change tables postgres does not own: %', v_list
      USING HINT = 'Nothing was changed. Stop and report.';
  END IF;
END
$guard$;

-- ------------------------------------------------------------
-- 1. Without a session: nothing. On every table, view and sequence of public.
-- ------------------------------------------------------------
-- ALL TABLES is tables, views, materialized views and foreign tables. Taking
-- a privilege on a table away takes it away on each of its columns too.
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM PUBLIC, anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon;

-- ------------------------------------------------------------
-- 2. Signed in: rows, and nothing else.
-- ------------------------------------------------------------
-- SELECT, INSERT, UPDATE and DELETE stay, untouched: they are what the
-- policies judge. (A row lock — SELECT … FOR UPDATE, which the functions of
-- migrations 11 and 12 take with the caller's rights — asks for UPDATE.)
REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON ALL TABLES IN SCHEMA public FROM authenticated;
-- USAGE stays: nextval(), which the default of a serial column calls with the
-- rights of whoever inserts. SELECT reads the counter, UPDATE is setval().
REVOKE SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public FROM authenticated;

-- ------------------------------------------------------------
-- 3. What a table or a sequence created later starts with.
-- ------------------------------------------------------------
-- In public, for what `postgres` creates: the part of Supabase's default that
-- names the two roles a request arrives as. service_role keeps its own.
-- (PostgreSQL itself gives PUBLIC nothing on a new table: there is no global
-- default to take back here, unlike for functions.)
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLES FROM authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE SELECT, UPDATE ON SEQUENCES FROM authenticated;

-- ------------------------------------------------------------
-- 4. Read the result back. Anything else than what was meant raises, and the
--    whole file is undone: either the database is as described, or untouched.
-- ------------------------------------------------------------
DO $verify$
DECLARE
  v_list text;
BEGIN
  -- What the two roles can do, as PostgreSQL itself answers it: a grant to
  -- PUBLIC counts, and so does a grant on a single column.
  WITH rel AS (
    SELECT c.oid, c.relname, c.relkind = 'S' AS is_sequence
      FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
  ),
  held AS (
    SELECT r.relname, r.is_sequence, w.who, p.privilege
      FROM rel r
     CROSS JOIN (VALUES ('anon'), ('authenticated')) AS w (who)
     CROSS JOIN LATERAL unnest(
             CASE WHEN r.is_sequence
                  THEN ARRAY['USAGE', 'SELECT', 'UPDATE']
                  ELSE ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']
             END) AS p (privilege)
     WHERE CASE
             WHEN r.is_sequence THEN has_sequence_privilege(w.who, r.oid, p.privilege)
             WHEN p.privilege IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
               THEN has_any_column_privilege(w.who, r.oid, p.privilege)
             ELSE has_table_privilege(w.who, r.oid, p.privilege)
           END
  ),
  wrong AS (
    SELECT h.relname,
           CASE h.who WHEN 'anon' THEN 'a request without a session' ELSE 'a signed-in user' END
             || ' still holds ' || string_agg(h.privilege, ', ' ORDER BY h.privilege) AS what
      FROM held h
     WHERE h.who = 'anon'
        OR (NOT h.is_sequence AND h.privilege IN ('TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'))
        OR (h.is_sequence AND h.privilege IN ('SELECT', 'UPDATE'))
     GROUP BY h.relname, h.who
  )
  SELECT string_agg(w.relname || ': ' || w.what, '; ' ORDER BY w.relname, w.what) INTO v_list
    FROM wrong w;
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_14_table_grants_lockdown did not get the privileges it meant: %', v_list
      USING HINT = 'A privilege granted by another role than postgres, or to PUBLIC by one. Nothing was changed. Stop and report the full message.';
  END IF;

  -- What `postgres` gives from now on: the entry for the schema, and a global
  -- one if somebody made it.
  WITH given AS (
    SELECT d.defaclobjtype AS kind,
           CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END AS grantee,
           a.privilege_type AS privilege
      FROM pg_default_acl d
     CROSS JOIN LATERAL aclexplode(d.defaclacl) a
     WHERE d.defaclrole = 'postgres'::regrole
       AND d.defaclnamespace IN (0, 'public'::regnamespace)
       AND d.defaclobjtype IN ('r', 'S')
  )
  SELECT string_agg(DISTINCT
           'a new ' || CASE g.kind WHEN 'r' THEN 'table' ELSE 'sequence' END
           || ' would give ' || g.grantee || ' ' || g.privilege, '; ') INTO v_list
    FROM given g
   WHERE g.grantee IN ('anon', 'PUBLIC')
      OR (g.grantee = 'authenticated' AND g.kind = 'r'
          AND g.privilege NOT IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE'))
      OR (g.grantee = 'authenticated' AND g.kind = 'S' AND g.privilege <> 'USAGE');
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_14_table_grants_lockdown did not get the default privileges it meant: %', v_list
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;
END
$verify$;

INSERT INTO app_private.app_migrations (name)
VALUES ('2026_10_13_14_table_grants_lockdown')
RETURNING name, applied_at;

-- No NOTIFY: privileges are not in PostgREST's schema cache. It asks
-- PostgreSQL at each request, as the role the request arrives with.

COMMIT;
