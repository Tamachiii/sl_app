# tooling-backup-now — docs to fold (wave 0, items P67)

Each block: target doc, section, then the text to fold in. `BACKUPS.md`, `docs/runbook/00-before-you-start.md` (section 2) and the backup parts of `docs/RUNBOOK.md` were written directly by the package and are current.

## README.md — Deployment

Replace the paragraph that starts "**Backups:** none runs on its own yet." with:

**Backups:** the project is on the free plan, which keeps none. A backup is one encrypted file written by `scripts/backup/dump.mjs` — Node and `pg` only, one read-only transaction — on the owner's machine before each change to production ([docs/runbook/00-before-you-start.md](docs/runbook/00-before-you-start.md), section 2) and every night by `.github/workflows/backup.yml` once its two secrets are set, which is a step of the first push. `scripts/backup/verify.mjs` checks a file without a database, `scripts/backup/drill.mjs` restores it into a throw-away PostgreSQL and compares. What a backup holds and does not (the video files, the Vault and function secrets, the Auth settings), the passphrase, and what has never been run against production: [BACKUPS.md](BACKUPS.md).

## README.md — Directory Structure

Add after the line that starts "  tests/               Database suite":

```
scripts/
  backup/              dump.mjs, verify.mjs, drill.mjs, restore.mjs — the database backup (BACKUPS.md)
```

## README.md — Database Tests

Replace "and a run takes under ten seconds." with:

and a run takes about 25 seconds.

Replace "A run reports 10 files and `218 passed | 7 expected fail`" with:

A run reports 11 files and `269 passed | 7 expected fail`

Add after the bullet that starts "`auth-accounts.test.js` runs the account list":

- `backup-roundtrip.test.js` runs the backup scripts (`scripts/backup/`) as child processes against a database seeded to look like production: dump, verify, restore into a database that only had `schema.sql`, and every table compared in SQL. It also holds what a backup must refuse (a clear file on a CI runner, a path inside the repository, a role that row-level security filters, a Supabase host as restore target), that a `TRUNCATE` or a rewriting `ALTER TABLE` sent during a dump waits for it and one committed just before its locks stops it, that a changed byte or a wrong passphrase fails the verification, and that nothing printed contains the connection string, the password or the passphrase. The three commands of `docs/runbook/00-before-you-start.md` section 2 and the `openssl` line of `BACKUPS.md` are read off their page and run. It creates two login roles in the cluster with the suite's superuser (`supabase_admin`) and drops them at the end.

## CLAUDE.md — Repo map

Add after the line that starts "                 fixtures/prod_baseline_2026_09_30.sql":

```
scripts/backup/  dump.mjs  verify.mjs  drill.mjs  restore.mjs   (the four commands)
                 lib/: format (the file + the one reader) · envelope (openssl-compatible
                 AES) · snapshot (read-only transaction + statement guard) · catalog (what
                 is read, and how a table is printed) · dump · verify · restore ·
                 connection (env → pg options, TLS, Supabase-host detection) · secrets
                 (scrub) · cli
```

## CLAUDE.md — Feature → files map, row "Nightly DB backups"

Replace the whole row with:

| Database backups (one encrypted file; by hand before each checkpoint, nightly on GitHub once its two secrets are set — **never yet run against production**) | `scripts/backup/dump.mjs` (every table of `public` from the catalog + `auth.users`/`auth.identities` + `storage.buckets`/`storage.objects` + `app_private.app_migrations`, in one `REPEATABLE READ READ ONLY` transaction, rows as `row_to_json` of text-cast columns), `scripts/backup/verify.mjs` (no database), `scripts/backup/drill.mjs` (restore into the DB suite's embedded Postgres, via `supabase/tests/postgres.js`), `scripts/backup/restore.mjs` (`--db-url` only; refuses a Supabase host, the production ref, a non-empty target), `scripts/backup/lib/` (`format.mjs` is the file format and `readBackup`, `snapshot.mjs` the read-only guard, `restore.mjs` the loader: `session_replication_role = replica`, ledger never loaded), `supabase/tests/backup-roundtrip.test.js`, `.github/workflows/backup.yml` (fails without its secrets; uploads the `.enc` file only), `BACKUPS.md`, `docs/runbook/00-before-you-start.md` §2, `src/test/ciGuardrails.test.js` (the workflow's guards) + `src/test/runbookIndex.test.js` (index, 00 page, `BACKUPS.md` and workflow agree). A new table in `public` needs nothing; a new table **outside** `public` that holds user data must be added to `PLATFORM_TABLES` in `scripts/backup/lib/catalog.mjs` |

## CLAUDE.md — Commands

Replace "(~9 s)" at the end of the `npm run test:db` line with:

(~25 s)

Add after the line that starts "npm run test:docs":

```
node --env-file=.env scripts/backup/dump.mjs     # backup → ~/sl_app-backups/ (needs SUPABASE_DB_PASSWORD + BACKUP_PASSPHRASE; reads production, cannot write)
node --env-file=.env scripts/backup/verify.mjs   # check the newest backup file, no database
node --env-file=.env scripts/backup/drill.mjs    # restore it into a throw-away Postgres and compare
```

## CLAUDE.md — When you add a feature

Add after the step that starts "2. DB changes":

A table created outside `public` (a new private schema) is **not** in a backup until it is listed in `PLATFORM_TABLES` (`scripts/backup/lib/catalog.mjs`); a table in `public` is picked up from the catalog. An agent never runs `scripts/backup/dump.mjs` or `restore.mjs` against production — they read the owner's `.env`.

## docs/ARCHITECTURE.md — The hand-over

Add after the paragraph that starts "**The hand-over.**":

**Backups.** A backup is data only: the rows of `public`, the accounts and the storage metadata, as text, in one gzip file encrypted in the format of `openssl enc`. The dump reads them in one `REPEATABLE READ READ ONLY` transaction and holds ACCESS SHARE on every table from before the first row to the end: a snapshot does not protect a table against `TRUNCATE` or an `ALTER TABLE` that rewrites it (both leave the table empty for a snapshot taken earlier), so a migration sent while a dump runs waits for it — or gives up on its own `lock_timeout`. The structure is `supabase/schema.sql`, which `supabase/tests/parity.test.js` keeps equal to production; the header of a backup names the commit and the SHA-256 of that file, and lists every column it read. A restore loads the rows with triggers off (`session_replication_role = replica`) into a database built from `schema.sql`, never loads `app_private.app_migrations` (the target's ledger describes the target), and is only accepted when every table reads back equal to the file. `BACKUPS.md` has the commands and the limits.
