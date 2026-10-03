-- Rollback of 2026_10_03_01_migration_ledger: drops the ledger and its schema.
--
-- Only possible while the ledger holds no other migration — it is refused
-- otherwise, because dropping the table would forget what is applied. Roll the
-- later migrations back first, last one first.
--
-- There is no reason to run this in production: the ledger changes nothing in
-- the app. It exists so that the migration is proven reversible.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
DECLARE
  v_later text;
BEGIN
  IF to_regclass('app_private.app_migrations') IS NULL THEN
    RAISE EXCEPTION 'migration 2026_10_03_01_migration_ledger is not applied: there is no app_private.app_migrations'
      USING ERRCODE = 'SLM03', HINT = 'Nothing was changed.';
  END IF;

  SELECT string_agg(name, ', ' ORDER BY name) INTO v_later
    FROM app_private.app_migrations
   WHERE name <> '2026_10_03_01_migration_ledger';
  IF v_later IS NOT NULL THEN
    RAISE EXCEPTION 'the ledger still records later migrations: %', v_later
      USING ERRCODE = 'SLM04', HINT = 'Roll those back first. Nothing was changed.';
  END IF;
END
$guard$;

-- No CASCADE: if something else has moved into the schema, stop.
DROP TABLE app_private.app_migrations;
DROP SCHEMA app_private;

COMMIT;
