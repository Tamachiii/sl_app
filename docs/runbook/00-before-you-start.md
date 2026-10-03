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

Either of these:

- GitHub → Actions → **Nightly DB backup** → *Run workflow*, wait for the green run, and check that it has an artifact `db-backup-<n>`. A run that is green with **no artifact** means the two secrets are missing — that is not a backup (`BACKUPS.md`).
- Or a dump on your machine (schema, then data). `supabase db dump` runs `pg_dump` in a container, so Docker must be running:

  ```bash
  supabase db dump --linked -f backup-schema.sql
  supabase db dump --linked --data-only -f backup-data.sql
  ```

  Keep both files outside the repository.

Neither covers the `auth` schema (accounts) or the video bucket; `BACKUPS.md` lists the gaps.

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
