# BACKUPS.md — Database backup & restore

The app runs on a Supabase project with real student data and, until July 2026,
had **no backup posture at all** — every hard delete (and the cascade chains
behind program/student deletes) was unrecoverable. This file documents the
nightly backup workflow, the one-time setup it needs, and the restore drill.

**Status: no nightly backup runs.** The workflow has skipped every night (its
secrets were never set), and the one-time setup below does not work as written
— see the notice at the top of that section before touching it. Until it is
corrected, the backup is a dump taken by hand before each change to
production: `docs/runbook/00-before-you-start.md`, section 2.

## What gets backed up

`.github/workflows/backup.yml` runs nightly (02:30 UTC, plus on demand via
*Run workflow*) and stores an **encrypted** `dump.tar.gz.enc` as a workflow
artifact (30-day retention) containing:

- `schema.sql` — structure of the `public` schema (`supabase db dump`)
- `data.sql` — data of the `public` schema (`--data-only`)

**Not covered — know the gaps:**

- **`auth` schema (user accounts / password hashes).** Managed by Supabase and
  not part of the dump. Worst case, accounts are re-created and re-linked by
  `profiles.id`; consider the project's own PITR/backup tier for full recovery.
  *(October 2026: the command says otherwise. `supabase db dump --data-only
  --dry-run` prints a `pg_dump` call that leaves `auth` out of its excluded
  schemas, so `data.sql` holds the account rows, password hashes included —
  treat the file accordingly. Restoring accounts from it has not been tried.)*
- **Storage buckets (set videos).** Object storage is never part of a DB dump.
  Videos are the one data class with no recovery story yet.
- Check the Supabase dashboard → *Database* → *Backups* for what the project's
  plan already provides (paid tiers include daily backups; free tier does not).

## One-time setup (two GitHub secrets)

> **Not working yet — do not follow this section.** Found in October 2026,
> before anyone had run it: the two steps below cannot produce a dump. They
> would leave a login role in production, its password in GitHub, and a
> failing run every night.
>
> - `backup.yml` dumps with `supabase db dump --db-url`, and that command
>   always runs `pg_dump --role "postgres"` (`supabase db dump --dry-run`
>   prints the call; CLI 2.109.1, schema and data alike). The role below is
>   not a member of `postgres`: `permission denied to set role "postgres"`.
> - The role cannot read a table either. `NOINHERIT` keeps it from using
>   `pg_read_all_data`: `permission denied for table profiles`. Without
>   `NOINHERIT` it reads, but not the way `pg_dump` does — with `row_security`
>   off, which needs `BYPASSRLS` on a database where every table has
>   row-level security: `query would be affected by row-level security policy
>   for table "profiles"`.
>
> The three refusals were reproduced on PostgreSQL 17.6, production's
> version, in the database of `npm run test:db`. So the correction is more
> than a word in the `CREATE ROLE`: a role that only reads cannot be the one
> `supabase db dump` runs as.
>
> Not tried, because nothing in the repository reaches production:
>
> - whether the SQL editor's role may `GRANT pg_read_all_data` at all. In the
>   test database it may not (`permission denied to grant role
>   "pg_read_all_data"`): `postgres` is no superuser there, as in production,
>   and the stand-in for the platform (`supabase/tests/shim.sql`) gives it no
>   admin right on that role. Production may;
> - whether a GitHub runner reaches `db.<project-ref>.supabase.co`. On the
>   free plan that host is said to answer over IPv6 only, which GitHub's
>   runners do not have; the session-pooler address would be the one to use.
>
> Until the section is corrected the workflow goes on skipping, and the
> backup is the dump of `docs/runbook/00-before-you-start.md`, section 2.

1. **Create a dump-only role** (SQL editor or `supabase db query`) — never put
   the service-role key or the `postgres` password in GitHub secrets:

   ```sql
   CREATE ROLE backup_reader LOGIN PASSWORD '<generate-a-strong-password>' NOINHERIT;
   GRANT pg_read_all_data TO backup_reader;
   ```

2. **Add repository secrets** (Settings → Secrets and variables → Actions):

   - `SUPABASE_DB_URL` — direct connection string for that role:
     `postgresql://backup_reader:<password>@db.<project-ref>.supabase.co:5432/postgres`
     (use the *session* pooler URL instead if the network blocks port 5432).
   - `BACKUP_PASSPHRASE` — a long random string (e.g. `openssl rand -base64 32`).
     Artifacts on a public repo are downloadable by anyone; the dump is
     AES-256 encrypted with this passphrase before upload. **Store a copy of
     the passphrase somewhere that survives losing GitHub access.**

   Until both secrets exist, the workflow no-ops with a warning — it never
   fails the Actions tab.

## Restore drill — run it once now, and after any schema overhaul

A backup that has never been restored is a hope, not a backup.

```bash
# 1. Download dump.tar.gz.enc from the latest "Nightly DB backup" run.
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -in dump.tar.gz.enc -out dump.tar.gz -pass pass:'<BACKUP_PASSPHRASE>'
tar xzf dump.tar.gz

# 2. Restore into a scratch database (local Supabase or a throwaway project):
supabase start                                   # local stack
psql "$LOCAL_DB_URL" -f schema.sql
psql "$LOCAL_DB_URL" -f data.sql

# 3. Verify: row counts on set_logs/sessions/messages, one known student's
#    program renders in the app pointed at the scratch DB.
```

For a real production incident, restoring into a fresh Supabase project also
requires re-applying `supabase/functions/` (Edge Functions + secrets) and the
Vault secrets described in `supabase/migrations/2026_05_12_feedback_push.sql`.

## Rollback story (app, not data)

The deployed frontend is just the `gh-pages` branch — `git revert` on `main`
(or re-running the deploy workflow from an older commit) rolls the app back.
Database migrations are forward-only: write a new migration to undo a bad one,
and lean on this backup for anything destructive.
