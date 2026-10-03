# 01 — Migration ledger

| | |
|---|---|
| Migration | `supabase/migrations/2026_10_03_01_migration_ledger.sql` |
| Audit | `supabase/audits/2026_10_03_01_migration_ledger.audit.sql` |
| Rollback | `supabase/rollbacks/2026_10_03_01_migration_ledger.down.sql` |
| Kind | required · expand (adds, removes nothing) |
| Wave / checkpoint | 0 / A0 |
| Findings | L26, P69 |

## What it does

Creates the schema `app_private` and the table `app_private.app_migrations (name, applied_at)`, and writes its own name into it. Every later migration inserts its name there in the transaction that makes its changes, refuses to run a second time, and refuses to run before the migration it builds on.

Nothing else changes: no table of the app, no policy, no function. The schema is not exposed by the API and `anon`, `authenticated` and `service_role` have no privilege on it.

## What the deployed client does differently

Nothing. The app does not read or write this table.

## Before: the audit

```bash
supabase db query --linked --file supabase/audits/2026_10_03_01_migration_ledger.audit.sql
```

A clean result, before applying:

| check | value | expected |
|---|---|---|
| running as | `postgres` | postgres |
| schema app_private exists | `false` | false before, true after |
| table app_private.app_migrations exists | `false` | false before, true after |
| API roles that can use app_private | `none` | none |

If it is not clean:

- **running as** is not `postgres` — stop and report. The file must be run by the role that owns the `public` tables.
- **schema app_private exists** is `true` and the table line is `true` — the migration is already applied; go to "After".
- **schema app_private exists** is `true` and the table line is `false` — something else created a schema with that name. Stop and report; do not drop it.

## Apply

```bash
supabase db query --linked --file supabase/migrations/2026_10_03_01_migration_ledger.sql
```

## After

Run the audit again: lines 2 and 3 are now `true`, line 4 is still `none`. Then read the ledger:

```bash
supabase db query --linked "select name, applied_at from app_private.app_migrations order by applied_at, name"
```

Expected: one row, `2026_10_03_01_migration_ledger`.

Also check once that Dashboard → Project Settings → Data API → *Exposed schemas* does not list `app_private`.

## Rollback

```bash
supabase db query --linked --file supabase/rollbacks/2026_10_03_01_migration_ledger.down.sql
```

Drops the table and the schema. There is no reason to run it in production — the ledger changes nothing in the app — and it is refused (code `SLM04`) as soon as the ledger holds another migration, because dropping it would forget what is applied. Use it only if the migration was applied to the wrong project.
