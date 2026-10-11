# 40 — Publishing the app: the deploy and its gate

This page is for the person who pushes to `main`. A push to `main` publishes the app: `.github/workflows/deploy.yml` runs, and what it builds replaces what every athlete has installed the next time their phone checks.

The app of a commit and the SQL of that commit belong together. The app calls the functions and reads the columns its migrations add, and you apply those migrations to production by hand ([00](00-before-you-start.md)). **Database first, app second**: every `required` migration of a commit is in production before the app of that commit is published.

Until October 2026 that was a rule on a page. The deploy now checks it, and stops when it does not hold.

## 1. What a push to `main` runs

| Job | What it does | Red means |
|---|---|---|
| `test` | lint, the unit tests, the database tests, the audit of what ships | the code is not fit to publish |
| `migrations` | reads the ledger of production and compares it with `supabase/migrations/manifest.json` | **production does not have what this app needs — or nobody could tell** |
| `deploy` | builds with the real keys and publishes to GitHub Pages | the build or the upload failed |

Each one waits for the one before it. Nothing is published unless the first two are green.

The `migrations` job runs one command, `node scripts/check-migrations.mjs --verify`. It opens one read-only transaction, reads `app_private.app_migrations` — the ledger, where every migration writes its own name when it is applied — and compares names:

- a **`required`** migration of the manifest that is not in the ledger stops the deploy, and is named;
- an `optional` one is not asked for: it may be skipped by design;
- a `contract` one is not asked for either: it is applied long after the deploy, at Checkpoint Z.

It reads no table of the app and cannot change anything.

What it does not check: that the SQL behind a name in the ledger still is what its file says (the ledger is a list of names), that the Edge Functions are deployed, or any dashboard setting. Those stay steps of the checkpoints in [RUNBOOK.md](../RUNBOOK.md).

## 2. Before you push to `main`

Ask the same question yourself first. It is the command the deploy runs. On your machine it connects the way the backup does ([00, section 2](00-before-you-start.md)): the database password of `.env`, and the address the linked CLI keeps.

```bash
node --env-file=.env scripts/check-migrations.mjs --verify
```

It prints who it connects as and where — `postgres.<project ref> at …pooler.supabase.com`: the ref is how you see it is the right project — then one line per migration of the checkout:

```text
  NN  migration                               kind      checkpoint  production
  01  2026_10_03_01_migration_ledger          required  A0          applied 2026-10-12 08:01 UTC
  02  2026_10_03_02_rpc_auth_null_guard       required  A0          applied 2026-10-12 08:03 UTC
  03  2026_10_11_03_function_grants_lockdown  required  A1          MISSING
```

It ends with `OK: production has all … required migrations of this commit. The deploy can go on.` — or with `REFUSED:` and the list of what is missing, each with its checkpoint and its page. `OK` is the only ending after which you push.

Run it on the commit you are about to push: the list is the `manifest.json` of the checkout.

This one connects to nothing. It lists what the commit needs and gives the query that reads the ledger by hand:

```bash
node scripts/check-migrations.mjs --print
```

## 3. Once: the secret the deploy reads production with

The `migrations` job needs the repository secret `SUPABASE_DB_URL`. It is the secret of the nightly backup: one value serves both. What it is, where it comes from, and what it means that it is the connection string of the `postgres` role: [BACKUPS.md](../../BACKUPS.md), section *The nightly run on GitHub*. Set it together with `BACKUP_PASSPHRASE`, as that section says: Settings → Secrets and variables → Actions → *Secrets*.

**When: the day of the first push to `main`, just before the push.** A secret can be set before the workflow that reads it exists. Not days earlier: until the push, `main` carries the previous backup workflow, which would use the secret that night for a command BACKUPS.md no longer describes.

If you pushed first, nothing is lost and nothing was published: the `migrations` job of that run is red with `SUPABASE_DB_URL is not set`. Set the two secrets, then re-run the job (section 4).

## 4. When the `migrations` job is red

Nothing was published: the app that was live is still live. Open the job; the last lines say which case it is.

| The message starts with | It means | Do |
|---|---|---|
| `REFUSED: … not applied in production` | the app of this commit is ahead of the database | apply the migrations it lists, in order, each at its checkpoint ([RUNBOOK.md](../RUNBOOK.md)), then re-run. When it adds `Production has no ledger at all`, migration 01 itself is missing: Checkpoint A0 |
| `REFUSED: the ledger of production was not read — SUPABASE_DB_URL is not set` | the secret does not exist | section 3 — or section 5 |
| `REFUSED: the ledger of production could not be read.` | the secret is set and did not work; the line under it says why | the next table |
| `REFUSED: supabase/migrations/manifest.json cannot be judged` | a fault of the repository, not of production | nothing to apply. Stop and report the message |
| `FAILED:` | the check itself broke | stop and report the message |

**Could not be read**, by what the line under it says. Whatever it says, look at the project in the dashboard first: a free-plan project that has been paused answers no connection until it is restored.

| It says | Do |
|---|---|
| `password authentication failed`, code `28P01` | the password inside `SUPABASE_DB_URL` is not the database password. Set the secret again (BACKUPS.md). Inside a URL, a password with characters other than letters, digits, `-`, `.`, `_` and `~` is percent-encoded |
| `is not a PostgreSQL connection URL` | the same: the secret is not a whole connection string, or its password is not percent-encoded |
| `ENETUNREACH` or `ENOTFOUND` | the address is not the session pooler's. `db.<ref>.supabase.co` answers over IPv6 only, which a GitHub runner does not have: take the string of Dashboard → Connect → Session pooler |
| `Tenant or user not found` | the pooler does not know the project named in the user (`postgres.<project ref>`), or it is the pooler of another region. Copy the string again from Dashboard → Connect → Session pooler |
| `ECONNREFUSED`, `ETIMEDOUT`, `timeout` | the database did not answer in time. Re-run |
| `Role … may not read app_private.app_migrations` | the connection string is not the one of the `postgres` role |
| `Row-level security is on for app_private.app_migrations` | somebody enabled row-level security on the ledger, which must not have it. Stop and report |

**Re-run.** Actions → the red run → *Re-run failed jobs*. The run keeps its commit, so no new commit is needed: the tests are not run again, the check is, and the deploy follows when the check is green.

## 5. Publishing while the secret is not set: `ALLOW_DEPLOY_WITHOUT_LEDGER_CHECK`

A repository **variable**, not a secret: Settings → Secrets and variables → Actions → *Variables* → name `ALLOW_DEPLOY_WITHOUT_LEDGER_CHECK`, value `true`. That exact word: `True`, `1` or `yes` leave the deploy stopped.

With it, and with no `SUPABASE_DB_URL`, the `migrations` job is green without having read anything. It prints `NOT CHECKED`, lists what the commit needs, and leaves a warning on the run. From then on the rule of this page is kept by hand: before each push, read the ledger and compare it with the list of `--print` (section 2) —

```bash
supabase db query --linked "select name, applied_at from app_private.app_migrations order by applied_at, name"
```

What the variable does **not** do:

- It does not lift a migration that was found missing. Once the secret is set the check runs, whatever the variable says.
- It does not lift a secret that is set and does not work (section 4). Fix the secret. If it cannot be fixed that day, the way out is to delete the secret: the variable then applies — and the nightly backup, which reads the same secret, is red until the secret is back.

Delete the variable the day the secret is set. A run that checked and still found the variable says so in a warning.

## 6. The emergency publish

`npm run deploy` builds on your machine and publishes from there. It goes around **both** gates: the tests and this one. So the check comes first, by hand, and `OK` is the only ending after which you publish:

```bash
node --env-file=.env scripts/check-migrations.mjs --verify
```

## 7. Putting an older app back

`git revert` on `main`, or *Re-run all jobs* on the run of an older commit, publishes the app of that commit again (BACKUPS.md, *Rollback of the app*). When that commit carries this gate, the check runs then too, with the manifest of the commit being published. An older commit needs fewer migrations than production has: the check notes the others (`the ledger also lists …`) and does not stop for them — every migration is written to be safe under the app that was live before it.

One limit the check does not know: the `contract` migrations of Checkpoint Z remove what old apps still use. After Checkpoint Z, an app from before the last wave cannot be put back.
