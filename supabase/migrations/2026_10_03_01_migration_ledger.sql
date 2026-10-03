-- ============================================================
-- 01 — Migration ledger
-- wave 0 · Checkpoint A0 · required · findings L26, P69
--
-- Until now nothing in the database said which migration files had been
-- applied: they are run by hand, and supabase_migrations.schema_migrations
-- holds a single row. This file creates the ledger every later migration
-- signs:
--
--   app_private.app_migrations (name, applied_at)
--
-- `app_private` is a new schema that the API does not expose and that anon,
-- authenticated and service_role cannot use. It is not `public` on purpose: a
-- public table needs RLS, and a table with RLS and no policy looks EMPTY to a
-- read-only role — a check of the ledger before a deploy would read "nothing
-- is applied".
--
-- From here on, every migration file
--   * refuses to run twice            (SQLSTATE SLM01),
--   * refuses to run before the migration it builds on (SLM02),
--   * inserts its own name here, in the same transaction as its changes.
-- The format is in supabase/migrations/README.md.
--
-- Backward compatible: nothing reads or writes this table but migrations.
-- Audit:    supabase/audits/2026_10_03_01_migration_ledger.audit.sql
-- Rollback: supabase/rollbacks/2026_10_03_01_migration_ledger.down.sql
-- Runbook:  docs/runbook/migrations/01-migration-ledger.md
-- ============================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

-- Re-run guard. The ledger cannot be asked before it exists, so for this one
-- file "already applied" is "the schema is there".
DO $guard$
BEGIN
  IF to_regnamespace('app_private') IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_03_01_migration_ledger is already applied: schema app_private exists'
      USING ERRCODE = 'SLM01', HINT = 'Nothing was changed.';
  END IF;
END
$guard$;

CREATE SCHEMA app_private;

COMMENT ON SCHEMA app_private IS
  'Objects the API must never reach: not in the exposed schemas, no privilege '
  'for anon, authenticated or service_role. Holds the migration ledger.';

CREATE TABLE app_private.app_migrations (
  name        text PRIMARY KEY
              CHECK (name ~ '^[0-9]{4}_[0-9]{2}_[0-9]{2}_[0-9]{2}_[a-z][a-z0-9_]*$'),
  applied_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE app_private.app_migrations IS
  'One row per applied migration of supabase/migrations/manifest.json: the '
  'file name without .sql. Written by the migration itself, in its own '
  'transaction; removed by its rollback file.';

-- A schema outside `public` gets no default grant on Supabase. Said out loud
-- anyway, so the result does not depend on how the project was set up.
REVOKE ALL ON SCHEMA app_private FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE app_private.app_migrations FROM PUBLIC, anon, authenticated, service_role;

INSERT INTO app_private.app_migrations (name)
VALUES ('2026_10_03_01_migration_ledger')
RETURNING name, applied_at;

COMMIT;
