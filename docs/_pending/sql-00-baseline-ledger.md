# sql-00-baseline-ledger — docs to fold (wave 0, items L26)

Each block: target doc, section, then the text to fold in.

## CLAUDE.md — Repo map

Replace the `supabase/` line with:

```
supabase/        schema.sql (install path, and what the DB tests load)
                 migrations/ (manifest.json + manifest.js, README.md = the format;
                 files before 2026_10 are history)
                 audits/  rollbacks/ (one file per migration of the manifest)
                 functions/dispatch-rest-push/  functions/send-push/
                 tests/ (DB suite: harness.js, sql.js, catalog.js, migration-checks.js,
                 fixtures/prod_baseline_2026_09_30.sql, snapshots/rls-matrix.txt)
docs/runbook/    00-before-you-start.md  migrations/NN-<name>.md (for whoever applies SQL)
```

## CLAUDE.md — Feature → files map, row "DB / RLS test suite (`npm run test:db`)"

Add at the end of the row's file list:

`scratchDatabase()` in `harness.js` (a database a test builds from SQL files, from `sl_bare` = `shim.sql` only) and `q.dryRun` (run one statement and undo it); `sql.js` (`runSql`/`runSqlFile`/`splitStatements`) + `sql.test.js`; `catalog.js` (`catalogSnapshot`/`diffCatalogs` — the catalog of a database as data) + `catalog.test.js`; `parity.test.js` (frozen `fixtures/prod_baseline_2026_09_30.sql` + the manifest's migrations = `schema.sql`); `migration-checks.js` + `migration-conventions.test.js` (every migration: refused out of order, applied, refused twice, rolled back, applied again; then the list without the optional ones); `migration-ledger.test.js`; `rls-matrix.test.js` + `snapshots/rls-matrix.txt` (what six callers can do to every table).

## CLAUDE.md — Feature → files map, new row after "DB / RLS test suite"

Add:

| Migrations + ledger (how a DB change is written and tracked) | `supabase/migrations/README.md` (the format), `supabase/migrations/manifest.json` + `manifest.js` (`loadManifest`/`pathsOf`/`predecessorOf`/`manifestProblems`, refusal codes `SLM01`–`SLM04`), `supabase/audits/`, `supabase/rollbacks/`, `docs/runbook/00-before-you-start.md` + `docs/runbook/migrations/`, ledger table `app_private.app_migrations` (migration `2026_10_03_01_migration_ledger.sql`), tests `supabase/tests/parity.test.js` + `migration-conventions.test.js` + `migration-ledger.test.js` |

## CLAUDE.md — Commands

Replace the `npm run test:db` comment with:

```bash
npm run test:db   # DB suite on an embedded Postgres 17: RLS as anon/student/coach, baseline + migrations = schema.sql, every migration up/down/up, the RLS matrix (~7 s)
```

## CLAUDE.md — When you add a feature

Replace step 2 ("DB changes → SQL in `supabase/migrations/2026_MM_DD_<name>.sql` *and* append to `schema.sql`. …") with:

2. DB changes → a migration in the format of `supabase/migrations/README.md`, in one commit: `supabase/migrations/YYYY_MM_DD_NN_<name>.sql` (`DD` = commit day, `NN` = global order), its audit in `supabase/audits/`, its rollback in `supabase/rollbacks/`, its page in `docs/runbook/migrations/`, an entry in `supabase/migrations/manifest.json`, **and** the same change merged into `supabase/schema.sql` with the migration's name added to the ledger `INSERT` at the end of that file. Then `npm run test:db`: `parity.test.js` fails when the migration and `schema.sql` disagree, `migration-conventions.test.js` when the file breaks the format, `rls-matrix.test.js` when what a role can do changed (regenerate `supabase/tests/snapshots/rls-matrix.txt` with `-u` and commit the diff). Never edit `supabase/tests/fixtures/prod_baseline_2026_09_30.sql` or a file dated before `2026_10`. Nothing here applies SQL to production: the user does, following `docs/runbook/`.

## docs/INVARIANTS.md — RLS / DB conventions

Replace the last sentence of the first bullet ("Migrations go in `supabase/migrations/<date>_<name>.sql` *and* append to `schema.sql`.") with:

A database change is a migration in the format of `supabase/migrations/README.md` *and* the same change merged into `schema.sql`.

Add after the first bullet:

- **`schema.sql` and the migrations must describe the same database, and a test proves it.** `supabase/tests/parity.test.js` loads the frozen production baseline (`supabase/tests/fixtures/prod_baseline_2026_09_30.sql`), applies every `required` and `optional` migration of `supabase/migrations/manifest.json` in order, and compares the catalog with `schema.sql` object by object (`supabase/tests/catalog.js`: functions with their settings and privileges, policies, triggers, columns, constraints, indexes, table privileges, default privileges, enums, publications, comments, seeded rows). A change made to only one of the two turns it red. A table that a SQL file fills is listed in `REFERENCE_DATA` of `catalog.js`, so that its rows are compared one by one: the test refuses rows in any other table, where it could only compare how many there are. The baseline is `schema.sql` as the live review of 2026-09-30 compared it with production; its SHA-256 is pinned, and it is never edited to make the test pass. `contract` migrations are left out of `schema.sql` until they have been applied, so that `schema.sql` keeps describing production.
- **Every migration signs the ledger, and refuses to run twice or out of order.** `app_private.app_migrations (name, applied_at)` holds one row per applied migration, inserted by the migration inside its own transaction and removed by its rollback file. A migration raises `SLM01` when its name is already there and `SLM02` when the migration it requires is not; a rollback raises `SLM03` when there is nothing to roll back. `supabase/tests/migration-conventions.test.js` runs every migration through refused-out-of-order → applied → refused twice → rolled back → applied again, and compares the catalog at each step, so a rollback that leaves an object behind fails. It then applies the list once more with the `optional` migrations left out: a `required` or `contract` migration that uses what an optional one made fails there. `schema.sql` inserts the names of the migrations merged into it, so a database installed from it starts with a complete ledger.
- **`app_private` is out of the API's reach, and has no RLS on purpose.** The schema is not in the exposed schemas and `anon`, `authenticated` and `service_role` hold no privilege on it (`supabase/tests/migration-ledger.test.js`). The ledger is not in `public` because a `public` table needs RLS, and a table with RLS and no policy reads as empty to a read-only role, so a check of the ledger before a deploy would read "nothing is applied". Never add `app_private` to the exposed schemas, and never grant an API role `USAGE` on it.
- **`supabase/tests/snapshots/rls-matrix.txt` is the record of who can do what.** `rls-matrix.test.js` measures, for anon, two athletes, their coach, another coach and the service role, how many rows of each table they can read, insert, update and delete, and compares the result with that file. A migration that rewrites policies or grants and means to change nothing must leave it untouched; one that means to change a cell regenerates the file and commits the diff.

## docs/ARCHITECTURE.md — Auth and Row-Level Security

Replace item 2 of "When you add a table" ("Migration SQL under supabase/migrations/ *and* append the same statements to supabase/schema.sql.") with:

2. A migration in the format of [supabase/migrations/README.md](../supabase/migrations/README.md) (file, audit, rollback, runbook page, manifest entry) *and* the same statements merged into [supabase/schema.sql](../supabase/schema.sql).
3. An insert probe for the table in `insertProbes()` of `supabase/tests/rls-matrix.test.js` — the test fails until the table has one.

## docs/ARCHITECTURE.md — new section "Migrations and the ledger", before "Set video uploads"

Add:

````markdown
## Migrations and the ledger

Production gets its SQL by hand, one file at a time; the database tests load `supabase/schema.sql`. Three pieces keep the two the same database.

**The manifest.** `supabase/migrations/manifest.json` lists the migrations that follow the format, in apply order, each with a `kind` (`required`, `optional`, `contract`), its wave and checkpoint, and whether its rollback is exact (`reversible`). `supabase/migrations/manifest.js` reads it and derives, from the name `YYYY_MM_DD_NN_<name>`, the four files of a migration: `supabase/migrations/<name>.sql`, `supabase/audits/<name>.audit.sql` (one read-only query), `supabase/rollbacks/<name>.down.sql` and `docs/runbook/migrations/NN-<name>.md`. The files dated before `2026_10` are history: they cannot be replayed and nothing reads them.

**The ledger.** `app_private.app_migrations (name, applied_at)`, created by migration 01. A migration file is one transaction — `BEGIN`, `SET LOCAL lock_timeout`, a guard, the change, the ledger insert, `NOTIFY pgrst, 'reload schema'` when the API surface changes (a table, a column, a primary, unique or foreign key, a function header of `public` — in the rollback file too), `COMMIT` — and its guard refuses a second run (`SLM01`) and a run before the migration it requires (`SLM02`). What a migration requires is the nearest `required` migration before it; a `contract` one requires the nearest `required` or `contract` one (`predecessorOf`). `schema.sql` ends with the same schema and table and an `INSERT` of the names of the migrations merged into it.

**The tests** (`npm run test:db`). `postgres.js` builds two templates per run: `sl_bare` (`shim.sql` only — a Supabase project before any user SQL) and `sl_template` (`sl_bare` + `schema.sql`). `scratchDatabase()` in `harness.js` clones either one for a test that loads SQL files itself.

- `parity.test.js`: `sl_bare` + `fixtures/prod_baseline_2026_09_30.sql` (`schema.sql` as it was compared with production on 2026-09-30, frozen, SHA-256 pinned) + the `required` and `optional` migrations must have the catalog of `schema.sql`. `catalog.js` reads a catalog as data (`catalogSnapshot`) and lists the differences one line per object (`diffCatalogs`); `catalog.test.js` makes each kind of change, on objects of its own, and checks it is seen.
- `migration-conventions.test.js`: the rules of the format, on the text (`staticProblems`) and by running each migration on the baseline, in order (`checkMigration` in `migration-checks.js`): audit read-only → refused without the migration it requires → applied → refused twice → rolled back (catalog equal to before) → refused twice → applied again (catalog equal to the first time). A second pass on the baseline applies every migration that is not `optional` (`withoutOptionalProblems`): none may need an optional one. The same code is run on deliberately wrong migrations, and the judge of the manifest (`manifestProblems`) on a temporary folder of its own.
- `migration-ledger.test.js`: no API role can read, write or reach `app_private`; the rollback of migration 01 refuses (`SLM04`) while the ledger records a later migration.
- `rls-matrix.test.js`: what six callers can do to every table, against `snapshots/rls-matrix.txt`.

Applying a migration to production is the user's step, described in `docs/runbook/00-before-you-start.md` and in the migration's own page.
````

## README.md — Directory Structure, `supabase/` block

Replace the three `supabase/` lines with:

```
supabase/
  schema.sql           Tables, RLS, triggers, RPCs — the install path
  migrations/          manifest.json + one file per change (README.md gives the format)
  audits/              One read-only query per migration, run before and after applying it
  rollbacks/           One file per migration that undoes it
  tests/               Database suite (RLS / triggers / RPCs / migrations) — `npm run test:db`
docs/runbook/          How to apply a migration to production, one page per migration
```

## README.md — Database Tests

Replace "and a run takes about two seconds" with "and a run takes about seven seconds".

Replace the "How it works." paragraph's last sentence ("That template is cloned into a fresh database for each test file.") with:

That template is cloned into a fresh database for each test file. The database right after `shim.sql` is kept as a second template (`sl_bare`), for the tests that build a database from SQL files themselves.

Add after the bullet that starts "Fixtures: `seed()`":

- `q.dryRun(sql, params)` runs one statement and undoes it at once — the result comes back, the database is untouched. `scratchDatabase()` gives a test a database of its own to load SQL files into (`db.runFile`, `db.runSql`, `db.readOnly`, `db.query`), starting from an empty Supabase project or from a copy of `schema.sql`.

Add after the "Writing a test." list, as a new paragraph block:

````markdown
**Migrations.** A database change is written as a migration (format: `supabase/migrations/README.md`) and merged into `schema.sql`. Four test files hold that together:

- `parity.test.js` — the frozen production baseline (`fixtures/prod_baseline_2026_09_30.sql`) plus every migration of `supabase/migrations/manifest.json` has the same catalog as `schema.sql`. The failure names the object and the side that lacks it.
- `migration-conventions.test.js` — every migration is one transaction with a lock timeout, refuses to run twice or before the migration it requires, signs the ledger, has a read-only audit, and has a rollback that gives back the catalog it started from. Each one is run: applied, rolled back, applied again — and the list once more without the optional ones.
- `migration-ledger.test.js` — `app_private.app_migrations` is out of reach of every API role.
- `rls-matrix.test.js` — what anon, two athletes, their coach, another coach and the service role can read, insert, update and delete in every table, compared with `supabase/tests/snapshots/rls-matrix.txt`. After a deliberate change: `npx vitest run --config vitest.db.config.js supabase/tests/rls-matrix.test.js -u`, then read the diff of that file.
````

Replace the last bullet of "Limits of the shim." ("Only `schema.sql` is loaded. `supabase/migrations/` is not replayed, so SQL that exists only in a migration is not tested.") with:

- The behaviour tests run against `schema.sql`; the migrations of `manifest.json` are replayed on the frozen baseline and must give the same catalog (`parity.test.js`). The files of `supabase/migrations/` dated before `2026_10` are not replayed. The baseline is `schema.sql` as it stood when the live review compared it with production: where production differed inside a function body (two `RAISE WARNING` strings, comments), the baseline has the repository's text.
- Cluster-wide state (roles, `ALTER ROLE … SET`) is shared by every database of a run and is not part of the catalog comparison.
