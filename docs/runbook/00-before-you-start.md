# 00 — Before you start: backup, audits, migrations, the ledger

This page is for the person who applies SQL to the production database. You do that by hand; nothing in the repository, and no agent, ever runs SQL against production.

Every database change of the 2026-09 review is a **migration**: one numbered file in `supabase/migrations/`, listed in `supabase/migrations/manifest.json`, with three companions:

| File | What it is |
|---|---|
| `supabase/migrations/<name>.sql` | the change, in one transaction |
| `supabase/audits/<name>.audit.sql` | a read-only query: what the database looks like before (and after) |
| `supabase/rollbacks/<name>.down.sql` | undoes the change |
| `docs/runbook/migrations/<NN>-<name>.md` | what it does, what a clean audit looks like, when to roll back |

`<name>` is `YYYY_MM_DD_NN_<what>`: `NN` is the order. Apply the files in that order, and only the ones the checkpoint you are at lists (`docs/RUNBOOK.md`).

The files in `supabase/migrations/` dated before `2026_10` are history. Production already has them; never run them again.

## 1. Once, before the first migration

**The CLI is linked to the project.** From the repository root:

```bash
supabase db query --linked "select current_user, current_database(), version()"
```

Expected: one row, `postgres | postgres | PostgreSQL 17.…`. If the first column is not `postgres`, stop: the files assume that role (what they create must belong to it).

**The `app_private` schema must stay out of the API.** Dashboard → Project Settings → Data API → *Exposed schemas*: the list must not contain `app_private`, now or later. Migration 01 creates that schema for things the app must not reach.

## 2. Before each checkpoint: a backup less than a day old

The project is on the free plan: it has no backup of its own. The backup is one file, written on your machine by a script of the repository — Node only, no Docker. `BACKUPS.md` says what the file holds and what it does not.

**Once.** Create a passphrase, and keep it in your password manager: a backup cannot be opened without it.

```bash
openssl rand -base64 32
```

Then two lines in `.env` at the root of the checkout, each value between single quotes (without them a `#` cuts the value short). The database password is the one of Dashboard → Project Settings → Database. `.env` is ignored by git.

```ini
SUPABASE_DB_PASSWORD='<the database password>'
BACKUP_PASSPHRASE='<the passphrase>'
```

**Each time**, from the root of the repository:

```bash
node --env-file=.env scripts/backup/dump.mjs
```

It reads the database in one read-only transaction — it cannot change anything. It prints who it connects as and where (`postgres.<project ref> at …pooler.supabase.com`: the ref is how you see it is the right project), one line per table with its row count, and the path of the file: `~/sl_app-backups/sl_app-<UTC time>.jsonl.gz.enc`, outside the repository, encrypted with the passphrase. The line to look for is `read back … every checksum matches`. A command that prints `FAILED:` has written nothing: pass the message on.

Then check the file on its own. This opens the most recent backup, recounts every table and recomputes every checksum; it connects to nothing:

```bash
node --env-file=.env scripts/backup/verify.mjs
```

It ends with `OK`, the number of tables and the number of rows. Look at the counts once: `auth.users` is the number of accounts, `public.set_logs` is in the thousands.

**Once, after the first backup — and again after a wave that changes tables:** restore it, for practice. This starts a throw-away PostgreSQL on your machine, loads the backup into the structure of `supabase/schema.sql`, compares every table with the file, and removes the server again. It touches no other database.

```bash
node --env-file=.env scripts/backup/drill.mjs
```

It ends with `DRILL OK`. Every table of `public` must read `identical`. The tables of `auth` and `storage` may read `row count only` or `NOT LOADED`: the throw-away server is not Supabase and has less of them — `BACKUPS.md` says what that leaves unproven.

The file holds every athlete's data and the accounts, with their e-mail addresses and password hashes — encrypted, which is why the passphrase matters. Never copy a backup into the checkout: the repository is public.

**The nightly backup on GitHub** does the same every night once it is set up — two repository secrets, after the first push of this branch: `BACKUPS.md`, section *The nightly run on GitHub*, and the first-push checklist of `docs/RUNBOOK.md`. Until then, the backup is the one you take here.

The video files are in no backup: object storage never is. Today the bucket is empty.

## 3. Run an audit file

```bash
supabase db query --linked --file supabase/audits/<name>.audit.sql
```

An audit is one `SELECT`. It changes nothing and can be run as often as you like. It prints one table; the migration's page says what that table looks like when it is safe to go on, and what to do when it is not. Run it before applying the migration, and again after.

## 4. Apply a migration file

```bash
supabase db query --linked --file supabase/migrations/<name>.sql
```

A migration is one transaction: it is applied completely or not at all. It then appears in the ledger (next section) — check that rather than the output of the command.

What an error means:

| Message contains | Meaning | Do |
|---|---|---|
| `is already applied` (code `SLM01`) | this file is in the ledger | nothing — it changed nothing |
| `needs …, which is not applied` (code `SLM02`) | the migration before it is missing | apply that one first |
| code `SLM05` | rows that are already in the database break the rule this migration brings; the message names the first of them | nothing was changed; the migration's page says how to list and remove them, then run the file again |
| `canceling statement due to lock timeout` | a table was in use for more than 5 seconds | nothing was changed; run the file again |
| anything else | the file failed | nothing was changed; stop and report the full message |

## 5. Read the ledger

After migration 01, the database knows what has been applied:

```bash
supabase db query --linked "select name, applied_at from app_private.app_migrations order by applied_at, name"
```

One row per applied migration. After a checkpoint, the list must contain every `required` migration the checkpoint names. (Before migration 01 this query fails with `relation "app_private.app_migrations" does not exist`: nothing is applied yet.)

## 6. Roll a migration back

```bash
supabase db query --linked --file supabase/rollbacks/<name>.down.sql
```

Only when the migration's page says so, and last applied first. A rollback removes its row from the ledger.

| Message contains | Meaning |
|---|---|
| `is not applied` (code `SLM03`) | there is nothing to roll back; nothing was changed |
| code `SLM04` | a later migration still needs it; roll that one back first |

## Without the CLI

Dashboard → SQL Editor: paste the whole file, run it. Same transaction, same errors. The editor shows the result of one statement only, which is why an audit is a single query.

Use it too if `supabase db query` itself fails — a message about the CLI, the login or the network rather than one of the messages above. Migration 01 is the place to find that out: it only adds a schema and a table that the app does not use.

## Never

- `supabase db push`, `supabase migration up`, `supabase migration repair` — the folder is not a CLI migration history and cannot be replayed.
- `supabase config push` — it would overwrite the Auth settings.
- Editing a migration file after it has been applied. A correction is a new migration.
- Applying a `contract` migration (the manifest says which) before its checkpoint: old installed clients still use what it removes.
