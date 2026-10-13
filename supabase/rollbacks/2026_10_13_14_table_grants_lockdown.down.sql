-- Rollback of 2026_10_13_14_table_grants_lockdown: gives `anon` and
-- `authenticated` back every privilege on every table, view and sequence of
-- `public`, and on those `postgres` creates there later.
--
-- !! IT REOPENS FINDING L24. After this file, a request that carries nothing
-- !! but the anon key, and every signed-in user, hold TRUNCATE, REFERENCES,
-- !! TRIGGER and MAINTAIN on all the tables of the app again, and a table
-- !! created without row-level security is open to anyone who has the app.
--
-- There is one reason to run it: after the migration, the app (signed in)
-- answers "permission denied for table …" somewhere. Report which table, and
-- re-apply the migration as soon as it is understood
-- (docs/runbook/migrations/14-table-grants-lockdown.md).
--
-- "Back" is what Supabase's default privileges give, which is the state of
-- the repository before the migration
-- (supabase/tests/fixtures/prod_baseline_2026_09_30.sql): everything, on
-- everything, for both roles. A privilege somebody had taken away by hand
-- before the migration is granted too. PUBLIC gets nothing: it held nothing.
--
-- No table, no column, no policy, no function and no row is touched:
-- row-level security decides what the two roles read and write, as before
-- and as after the migration.
--
-- Refused (SLM04) while the ledger records a later migration: a table
-- created since carries grants of its own, which this file would widen.
-- Roll the later ones back first, last applied first.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
DECLARE
  v_later text;
BEGIN
  -- The default privileges below are those of `postgres`, and a GRANT made
  -- by another role is not the one the migration took away.
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'the rollback of 2026_10_13_14_table_grants_lockdown must be run as postgres, not as %', current_user
      USING HINT = 'Run it from the SQL editor or with `supabase db query --linked`. Nothing was changed.';
  END IF;

  -- Two questions, in this order: the second cannot be asked without a ledger.
  IF to_regclass('app_private.app_migrations') IS NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_14_table_grants_lockdown is not applied: there is no app_private.app_migrations'
      USING ERRCODE = 'SLM03', HINT = 'Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_13_14_table_grants_lockdown') THEN
    RAISE EXCEPTION 'migration 2026_10_13_14_table_grants_lockdown is not applied'
      USING ERRCODE = 'SLM03', HINT = 'Nothing was changed.';
  END IF;

  SELECT string_agg(name, ', ' ORDER BY name) INTO v_later
    FROM app_private.app_migrations
   WHERE substring(name from '^[0-9]{4}_[0-9]{2}_[0-9]{2}_([0-9]{2})_')::int > 14;
  IF v_later IS NOT NULL THEN
    RAISE EXCEPTION 'the ledger still records later migrations: %', v_later
      USING ERRCODE = 'SLM04', HINT = 'Roll those back first. Nothing was changed.';
  END IF;
END
$guard$;

-- ------------------------------------------------------------
-- What a table or a sequence created later starts with: as Supabase set it up.
-- ------------------------------------------------------------
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON SEQUENCES TO anon, authenticated;

-- ------------------------------------------------------------
-- anon and authenticated: everything, on every table, view and sequence.
-- ------------------------------------------------------------
GRANT ALL ON ALL TABLES    IN SCHEMA public TO anon, authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;

DELETE FROM app_private.app_migrations WHERE name = '2026_10_13_14_table_grants_lockdown';

-- No NOTIFY: privileges are not in PostgREST's schema cache.

COMMIT;
