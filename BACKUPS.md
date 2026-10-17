# BACKUPS.md — backup and restore of the database

The project is on the Supabase free plan, which keeps no backup of its own. A hard delete, a bad migration or a lost project is recoverable only from a file made by the scripts in `scripts/backup/`.

A backup is **one file**: `sl_app-<UTC time>.jsonl.gz.enc`. It is written by `scripts/backup/dump.mjs` with Node and the `pg` package the repository already installs — no Docker, no Supabase CLI, no `pg_dump`.

| Command | What it does | Needs |
|---|---|---|
| `node --env-file=.env scripts/backup/dump.mjs` | reads the database in one read-only transaction and writes the file | the database password, the passphrase |
| `node --env-file=.env scripts/backup/verify.mjs [file]` | opens the file, recounts the rows, recomputes every checksum | the passphrase; no database |
| `node --env-file=.env scripts/backup/drill.mjs [file]` | restores the file into a throw-away PostgreSQL on this machine and compares | the passphrase; no database |
| `node --env-file=.env scripts/backup/restore.mjs [file] --db-url <target>` | loads the file into a database you name | the passphrase, a scratch database |

`[file]` left out means the most recent file of `~/sl_app-backups/`. `npm run backup:dump`, `backup:verify`, `backup:drill` and `backup:restore` run the same scripts with the variables of your shell instead of `.env`.

## Status — what is tested, and what has never run

Tested, on every run of `npm run test:db` (`supabase/tests/backup-roundtrip.test.js`), against PostgreSQL 17.6, production's version: a database with accounts, logged sets, messages, notifications, goals, a draft, videos' metadata and one row of every awkward type is dumped, verified, restored into a database that only had `supabase/schema.sql`, and compared table by table in SQL. The same file checks that a changed byte, a file cut short and a wrong passphrase fail the verification; that the dump reads one instant while another session writes, and holds every table against a `TRUNCATE` or a rewriting migration until it is done; that it cannot write; that a role which row-level security would filter gets an error instead of a smaller backup; that nothing printed ever holds the connection string, the password or the passphrase; and that the three commands of `docs/runbook/00-before-you-start.md` run as written.

**Run against the real project, by hand:** the dump, its check and the drill, for the first time at Checkpoint A0 on 2026-10-11 — 24 tables, 12,729 rows, every checksum matching, and the 20 tables of `public` identical after the restore (`docs/RUNBOOK.md`, Checkpoint A0). That run is where the script met the session pooler, its TLS, the real `auth.users` (about twice the columns of the test stand-in) and the real size of the tables. A backup is taken again as the first step of every checkpoint. If a dump fails, the message says where; nothing is written unless the whole dump succeeded.

**Run on GitHub, every night since the first push:** the workflow of [the nightly run](#the-nightly-run-on-github) was run by hand on 2026-10-13, the day of the first push — run 38354397417, green, artifact `db-backup-92` (834,458 bytes), downloaded and checked with `verify.mjs` (25 tables, 12,843 rows) and `drill.mjs` (`DRILL OK`) — and green on its schedule on 2026-10-14 and 2026-10-15, runs 38531178558 and 38699961225 (`docs/RUNBOOK.md`, first-push checklist item 6, and Checkpoint B, step 10).

**Never run:**

- **Restoring the accounts into a real Supabase project.** There, `auth.users` belongs to `supabase_auth_admin` and GoTrue has tables this backup does not hold. The restore is tested into plain PostgreSQL with stand-ins for Supabase (`supabase/tests/shim.sql`). [Rebuilding production](#rebuilding-production--an-outline-never-done) is an outline for that reason.

## What a backup holds

The tables of the app's two schemas are read from the catalog at the moment of the dump, so a table that a later migration adds to `public` or to `app_private` is in the next backup without any change to the scripts. A table created in a **third** schema would not be: that schema has to be added to `scripts/backup/lib/catalog.mjs`.

| Tables | Why |
|---|---|
| every table of schema `public` | the app's data: profiles, programs, sessions, logged sets, messages, goals, … |
| every table of schema `app_private` | today one: `app_migrations`, which migrations the database had (the schema does not exist before migration 01) |
| `auth.users`, `auth.identities` | the accounts, with their e-mail addresses and password hashes. Every row of the app hangs on `profiles.id = auth.users.id`; without them nobody can sign in to a restored database |
| `storage.buckets`, `storage.objects` | the bucket and one row per uploaded video — the **metadata** |

The file starts with a header — format version, time, PostgreSQL version, the commit of the checkout and the SHA-256 of its `supabase/schema.sql`, every table with its columns and types — and ends with a trailer: the row count and SHA-256 of each table. A dump that did not reach its end has no trailer and is not a backup; `dump.mjs` gives the file its name only once the trailer is written and the file has been read back.

**What it does NOT hold:**

- **The video files.** Object storage is in no database dump. The backup has the rows that describe them, not the bytes. The `set-videos` bucket holds 0 objects today (October 2026); the day athletes upload, the files need a copy of their own — not built yet.
- **The structure.** Tables, policies, functions and triggers are not in the file: it is a data backup, restored into a database built from `supabase/schema.sql`. `supabase/tests/parity.test.js` holds that file to production's structure as the review found it plus the migrations written since — so production is behind it by whatever migrations are not applied yet, and the ledger rows in the backup say which ones it had. The header of each backup names the commit it was taken next to and lists every column it read, so a backup that does not fit a schema says which column is the reason.
- **The Vault secrets** (`app_functions_url`, `app_service_role_key`, which the push triggers read) and **the Edge Function secrets** (the VAPID keys). They are set by hand: `README.md`, section *Rest Timer*, and the header of `supabase/migrations/2026_05_12_feedback_push.sql`.
- **The Auth settings** of the dashboard: `docs/runbook/20-auth-config.md`.
- **The rest of `auth`:** sessions, refresh tokens, MFA factors, the audit log. After a restore everyone signs in again.
- **Database roles and their passwords**, and anything in the schemas the platform owns (`net`, `vault`, `realtime`, …).

## Take a backup now

Once:

1. `npm ci` has been run, and the CLI is linked to the project (`supabase/.temp/pooler-url` exists — `supabase link` writes it).
2. Create the passphrase and keep it where it survives this machine — see [The passphrase](#the-passphrase):

   ```bash
   openssl rand -base64 32
   ```

3. Put two lines into `.env` at the root of the checkout, each value between single quotes (without them a `#` starts a comment and cuts the value):

   ```ini
   SUPABASE_DB_PASSWORD='<the database password>'
   BACKUP_PASSPHRASE='<the passphrase of step 2>'
   ```

   `.env` is ignored by git, and Vite only hands variables that start with `VITE_` to the app. The database password is the one of Dashboard → Project Settings → Database; the CLI's `--linked` commands read the same variable.

Then, each time:

```bash
node --env-file=.env scripts/backup/dump.mjs
```

It prints where it connects — the host and the user, `postgres.<project ref>`, which is how to see that it is the right project; never the password — then one line per table with its row count, the path of the file, and `read back … every checksum matches`. Exit code 0 means exactly that: every table was dumped, the trailer was written, and the file was opened again from the disk and found whole. On any error nothing is left behind under a backup's name.

```bash
node --env-file=.env scripts/backup/verify.mjs
```

The same check again, on its own: the most recent file of `~/sl_app-backups/`, with no connection to anything. Run it on a copy, on a download, before a restore.

The file lands in `~/sl_app-backups/` (mode 700, the file 600), outside the repository. `dump.mjs` refuses a path inside the checkout, and `.gitignore` ignores `*.jsonl.gz*` for a file copied there by hand: the repository is public.

How the connection is made:

- `SUPABASE_DB_PASSWORD` plus the address in `supabase/.temp/pooler-url` — the **session pooler** (`…pooler.supabase.com:5432`). Not `db.<ref>.supabase.co`: on the free plan that host answers over IPv6 only, which WSL and GitHub's runners do not have. `SUPABASE_DB_URL`, when set, is used instead and must be the whole session-pooler connection string.
- Over TLS, always, for anything that is not a local address. By default the server's certificate is **not checked**: Supabase signs it with its own CA, which Node does not know. To check it, download the CA file (Dashboard → Project Settings → Database → SSL configuration) and set `PGSSLROOTCERT=<path to the file>`. The `source` line the command prints says which of the two it is. Set in `.env`, the variable reaches the other commands too: `verify.mjs` opens no connection, the drill's own server is on this machine and is not asked for TLS, and `restore.mjs` checks the target it is given against the same file (a scratch server on this machine then needs `?sslmode=disable` at the end of its URL).
- In one transaction, `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`: the dump sees one instant of the database even while athletes log sets, and the server refuses any write in it. The script itself only lets statements through that have the shape of a read (`scripts/backup/lib/snapshot.mjs`).
- With every table held from before the first row is read until the file is written — the lock of an ordinary read, the one `pg_dump` takes. Reading and writing rows goes on as usual. A `TRUNCATE`, or a migration that changes a table, does not: sent while a dump runs it waits for the dump, and whatever else wants that table waits behind it. (A migration of the 2026-09 review gives up after 5 seconds instead — `canceling statement due to lock timeout`, nothing changed.) So apply migrations when no dump is running. The snapshot alone would not have been enough here: either of the two, once committed, leaves its table **empty** for a dump that started before, in a backup that would still have ended green. If one was already under way when the dump started, the dump waits for it, and stops with `Another session emptied, rewrote or replaced …` when it did that to a table: nothing is written, take the backup again.
- As the role of the connection string — `postgres`. It must read through row-level security; a role that cannot gets an error, not a backup with rows missing.

`--no-encrypt` writes the file in clear, `….jsonl.gz`. It then holds every athlete's data, the e-mail addresses and the password hashes, readable by anything that can read the file. Without that flag and without a passphrase the command writes nothing.

## The passphrase

- One passphrase for the local backups and for the nightly run. Long and random — `openssl rand -base64 32`; the scripts refuse one shorter than 20 characters, because the file's protection on a public artifact is that passphrase and nothing else.
- **A backup without its passphrase is noise.** Keep it in your password manager, or on paper, somewhere that survives losing this machine *and* losing access to GitHub. `.env` and the GitHub secret are places it is used, not places it is kept: a GitHub secret cannot be read back.
- Never next to the files it opens (not in the same cloud folder, not in the repository).
- Changing it does not re-encrypt old files: they keep the passphrase they were written with. Note the date of a change next to the old value.

## Open a backup without these scripts

The file is `gzip`, encrypted in the format of the `openssl enc` command (AES-256-CBC, key from PBKDF2-HMAC-SHA256 with 200000 rounds). With the two variables set in the shell, on any machine with OpenSSL 1.1.1 or later:

```bash
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 -pass env:BACKUP_PASSPHRASE -in "$BACKUP_FILE" | gunzip | head -n 1
```

That prints the header. Without `| head -n 1` it prints everything: one JSON object per line — `{"table":…}`, then one `{"row":{…}}` per row, then `{"end":…}`. Each value is the text PostgreSQL prints for it (`"20.00"`, `"2026-10-03 18:04:05.123456+00"`, `"{1,3}"`), or `null`. `scripts/backup/lib/format.mjs` describes the format.

## The restore drill

A backup that has never been restored is a hope.

```bash
node --env-file=.env scripts/backup/drill.mjs
```

It needs nothing but the repository: it starts the throw-away PostgreSQL of the database suite (binaries from npm, production's version), builds a database from `supabase/schema.sql` of the checkout, loads the most recent backup into it, reads every table back and compares it with the trailer of the file, then deletes the server. It prints one line per table and ends with `DRILL OK`.

What a green drill proves: the file opens with your passphrase; every row of every table of `public` fits the structure and the constraints of `supabase/schema.sql`; and what was loaded reads back identical to what was dumped.

What it cannot prove: the scratch server is PostgreSQL with stand-ins for Supabase. Its `auth.users` has part of the real columns, and it has no `auth.identities`; those are loaded as far as they fit and the report says so (`row count only`, `NOT LOADED`). The rows are on this machine's disk in clear for the seconds the drill runs, in a temp directory that is removed at the end.

Run it once now, after the first real dump, and again after any wave that changes the schema. If the checkout has moved on since the backup was taken — a migration merged into `supabase/schema.sql` that tightens a constraint — the drill says which table refused a row; `git worktree add` at the commit the header names gives the structure the backup was taken with.

**Into a database you name** — `restore.mjs` is the same loader, for a scratch database of your own that already has the tables:

```bash
node --env-file=.env scripts/backup/restore.mjs --db-url '<connection URL of the scratch database>'
```

- One transaction: every table loaded and equal to the backup, or the target exactly as it was.
- Triggers are off while it loads (`SET LOCAL session_replication_role = replica`, as a data dump of `pg_dump` does): the rows already passed them once. Constraints stay on.
- `app_private.app_migrations` is **not** loaded. It records which migrations made the structure, so the target's own ledger is the truth about the target; the command prints both, side by side.
- It refuses a target that already holds rows, unless `--replace-existing-rows`.
- It refuses a target that lacks a table or a column of the backup, unless that table is one of `auth.*` or `storage.*` and `--tolerate-platform-gaps` is given. `--skip <schema.table>` leaves a table out on purpose.
- The target is named with `--db-url` and nowhere else. It is never taken from `SUPABASE_DB_URL` or `SUPABASE_DB_PASSWORD`.
- It refuses a host that is a Supabase project unless a flag repeats that host, and the linked production project unless a second flag repeats its ref. The refusal prints the flag. This is a tool for a drill, not a button for production.

## Rebuilding production — an outline, never done

Nobody has done this. It is the list of what a real incident needs, in order, so that the day it happens is not the day it is thought about for the first time.

1. A new Supabase project (or the old one, if only data was lost).
2. The structure: `supabase/schema.sql` in the SQL editor — of the commit the backup's header names, or of a later one if its migrations only add.
3. The data: `restore.mjs` with the pooler URL of that project and the flag it asks for. **Untested there:** whether `postgres` may write `auth.users` and `auth.identities` as GoTrue has them. If it may not, `--skip auth.users --skip auth.identities` loads everything else, and the accounts have to come back another way with the **same ids** — the rows of the backup give each id, e-mail address and password hash. The `public` tables do not depend on how an account came back, only on its id.
4. What the backup does not hold: the Vault secrets, the Edge Functions (`supabase functions deploy`) and their secrets, the Auth settings (`docs/runbook/20-auth-config.md`), and — for a new project — the two `VITE_SUPABASE_*` values of the deploy.
5. The videos, from wherever a copy of the bucket is kept — today there is none to restore.

## The nightly run on GitHub

`.github/workflows/backup.yml` runs at 02:30 UTC, and on demand (Actions → **Nightly DB backup** → *Run workflow*): `dump.mjs`, then `verify.mjs` on what was written, then the upload of the encrypted file as the artifact `db-backup-<run number>`.

**When to set it up: once the workflow of this page is on the default branch** — the day the review branch reaches `main`, after Checkpoint A3 (`docs/RUNBOOK.md`, First-push checklist). A schedule only runs from `main`, and until then `main` carries the previous workflow, which skips without the secrets and, with them, would run a command this page no longer describes. Before that day, the backup is the one you take on your machine before each checkpoint.

That day, set them just before the push rather than after it. The deploy the push starts reads `SUPABASE_DB_URL` too — it compares the migrations production has with the ones the commit needs — and stops without it: [docs/runbook/40-deploy.md](docs/runbook/40-deploy.md), section 3.

Two repository secrets (Settings → Secrets and variables → Actions):

- `SUPABASE_DB_URL` — the **session-pooler** connection string of the project, with the database password in it: Dashboard → Connect → Session pooler. It is the address of `supabase/.temp/pooler-url` with `:<password>` added after the user name. A password with characters other than letters, digits, `-`, `.`, `_` and `~` must be percent-encoded inside a URL.
- `BACKUP_PASSPHRASE` — the passphrase of [The passphrase](#the-passphrase), the same as in your `.env`.

**Which role, and what that means.** The connection string is the one of the `postgres` role: the role that owns the schema, the same one the SQL editor uses. Stored as a GitHub secret, it gives whoever can read that secret full access to the database — which is everyone with write access to the repository: a workflow on any branch they push can read it. (A pull request from a fork cannot.) The workflow uses it to read: one read-only transaction, the job has no write token on the repository, the secrets are in the environment of the dump and verify steps only, and no dependency's install script runs in the job. The deploy holds it the same way, in a job of its own that reads one table, the list of applied migrations (`.github/workflows/deploy.yml`, job `migrations`). But the credential itself can do anything. A role that can only read is the better secret, and it is **not set up yet**: the recipe this page used to give for one could not produce a dump, and a correct one needs a role that reads through row-level security in `auth` and `storage` — something only tried on the test database, with a superuser the SQL editor is not. It stays a follow-up until it has been tried on a real project.

After setting the two secrets:

1. Run the workflow by hand. It must be green **and** have an artifact `db-backup-<n>`.
2. Download the artifact, unzip it, and check the file with the passphrase you kept — not with the one in GitHub, which cannot be read back:

   ```bash
   node --env-file=.env scripts/backup/verify.mjs ~/Downloads/<the file>.jsonl.gz.enc
   ```

3. Run the drill on it: `node --env-file=.env scripts/backup/drill.mjs ~/Downloads/<the file>.jsonl.gz.enc`.

**A run without the two secrets fails**, red, and names the missing one. It no longer skips: a green run always has an artifact.

Know about the schedule: GitHub stops the scheduled runs of a repository that has had no activity for 60 days, without a failed run to show for it, and a failed run is reported by e-mail to whoever last edited the workflow's schedule. Until the workflow keeps itself alive (planned), look at the Actions tab when the repository has been quiet.

## Retention

- **GitHub:** each artifact is kept 30 days, so 30 nightly backups at any time. Anyone with a GitHub account can download an artifact of a public repository; what they get is the encrypted file. They can read the log of each run as well, which is what the two commands print: the pooler host and the user `postgres.<project ref>`, the PostgreSQL version, and one line per table with its row count — how many accounts, messages and push subscriptions there were that night. No row, and neither the password nor the passphrase.
- **Your machine:** `~/sl_app-backups/` keeps every file until you delete it. Keep at least the backup taken before each checkpoint until the next checkpoint has gone well, and one copy somewhere that is not this machine — the encrypted file can go anywhere the passphrase is not.

## Rollback of the app (not of the data)

The deployed frontend is the `gh-pages` branch: `git revert` on `main`, or the deploy workflow run again from an older commit, puts the previous app back. A migration of the 2026-09 review has a rollback file of its own (`docs/runbook/00-before-you-start.md`, section 6); a rollback undoes a change of structure, not a loss of rows — that is what this page is for.
