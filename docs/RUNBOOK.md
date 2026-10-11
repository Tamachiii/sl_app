# RUNBOOK — what the owner does by hand, and when

The fixes of the 2026-09 review are written and tested in the repository. Three things are not done there, because nothing in the repository, and no agent, ever touches production: **applying SQL**, **changing a dashboard setting**, and **publishing the app**. They are yours. This page says when each one is due and in what order.

It is the index. Whatever needs more than a few lines has a page of its own:

| Page | What it covers |
|---|---|
| [runbook/00-before-you-start.md](runbook/00-before-you-start.md) | the CLI link, the backup, how to run an audit, a migration and a rollback, how to read the ledger, what each error means |
| [runbook/migrations/](runbook/migrations/) | one page per migration: what it does, what a clean audit looks like, what the deployed app does differently, when to roll back |
| [runbook/20-auth-config.md](runbook/20-auth-config.md) | the Auth settings of the Supabase dashboard |
| [../BACKUPS.md](../BACKUPS.md) | the nightly backup, which does not run yet and whose set-up is not to be followed as written; the restore drill |

## Rules that hold at every checkpoint

1. **In order, and only what the checkpoint lists.** The two digits in a file name (`…_01_…`, `…_02_…`) are the order. The files in `supabase/migrations/` dated before `2026_10` are history: production has them, never run one again.
2. **A backup less than a day old before the first statement** ([00, section 2](runbook/00-before-you-start.md)). The project is on the free plan, which has no backup of its own, and the nightly GitHub dump has never run: its set-up does not work as written (step 2 of Checkpoint A0 says why). Until it is corrected, the backup is a dump on your machine, taken again before each checkpoint.
3. **Audit, apply, audit.** An audit is one read-only query: run it before a migration and again after. When it does not show what the migration's page calls clean, the page says whether to go on or to stop. *Stop and report* means: apply nothing more, and pass the full output on.
4. **A rollback only when the migration's page says so**, last applied first.
5. **The ledger is the proof.** A checkpoint is done when `app_private.app_migrations` lists its migrations, not when a command printed nothing alarming.
6. **Database first, app second.** A build of the app needs every `required` migration of its wave, and of the waves before it, in production. Pushing to `main` publishes the app (`.github/workflows/deploy.yml`), so the branch of the review reaches `main` only at a checkpoint whose row below says the app is published. Under its own name it is not pushed either before Checkpoint A3: the repository is public ([First-push checklist](#first-push-checklist)).
7. **Never** `supabase db push`, `supabase migration up`, `supabase migration repair`: the folder is not a CLI migration history and cannot be replayed.
8. **Never** `supabase config push`, and `supabase/config.toml` never gets an `[auth]` section: a push would put the CLI's Auth defaults back (sign-up on, site URL on localhost, 6-character passwords). `src/test/authConfig.test.js` holds the repository's side of that.

## How to run a file

From the root of the repository, with the CLI linked to the project, on the branch that carries the review (`fix/review-2026-09` until it is merged): the files exist there only. `<name>` is the file name without its extension, for example `2026_10_03_01_migration_ledger`.

Look (read-only, as often as you like):

```bash
supabase db query --linked --file supabase/audits/<name>.audit.sql
```

Apply (one transaction: all of it or nothing):

```bash
supabase db query --linked --file supabase/migrations/<name>.sql
```

Read what is applied:

```bash
supabase db query --linked "select name, applied_at from app_private.app_migrations order by applied_at, name"
```

Undo (only when the migration's page says so):

```bash
supabase db query --linked --file supabase/rollbacks/<name>.down.sql
```

Without the CLI: Dashboard → SQL Editor, paste the whole file, run it. Same transaction, same errors. What a refusal means (`SLM01` already applied, `SLM02` the one before it is missing, a lock timeout) is in [00, section 4](runbook/00-before-you-start.md).

## Checkpoints

A checkpoint is one sitting: a list of migrations, sometimes a dashboard step or a function to deploy, and whether the app is published afterwards. A checkpoint marked **ready** has its sequence on this page. The others are the plan: their numbers are fixed, their pages are written by the wave that brings the code.

| Checkpoint | Due | Migrations | Also by hand | App published after it | Hand-over |
|---|---|---|---|---|---|
| **A0** | now — wave 0 is finished | 01, 02 | Auth settings; a dump on your machine | no | **ready** |
| A1 | after wave 1 | 03 | a smoke check as athlete and as coach, with the app that is deployed | no | with wave 1 |
| A2 | after A1 | 04–10 | — | no | with wave 1 |
| A3 | after A2 | 11–14 | — | yes: the first one | with wave 1 |
| B | after wave 2 | 15–18, and 19 if pg_cron is enabled | deploy the two Edge Functions; decide on pg_cron | yes | with wave 2 |
| C1 | after wave 3 | 20–26 | read the audit list of migration 21 first | yes | with wave 3 |
| C2 | after wave 4 | 27–30 and 32; 31 is optional | the second end-to-end run on the test athlete | yes | with wave 4 |
| D | after wave 5 | 33–35 | — | yes | with wave 5 |
| E | after wave 6 | 36, 37 | deploy the invitation function; e-mail templates and a custom SMTP sender | yes | with wave 6 |
| F | after wave 7 | 38–40 | deploy the account-deletion function | yes | with wave 7 |
| G | after wave 8 | 41, 42 | — | yes | with wave 8 |
| Z | at least 14 days after the last time the app was published | 43–45 | a fresh backup | no | with wave 8 |

`supabase/migrations/manifest.json` is what counts: a migration belongs to the checkpoint its entry names, and `src/test/runbookIndex.test.js` fails when this table says otherwise. Migrations 43 to 45 remove what an old installed app still uses, which is why Checkpoint Z waits.

## Checkpoint A0 — the ledger, the anonymous RPC hole, public sign-up

What it closes:

- **Five coach functions run for a caller who is not signed in** (finding P1, critical). With the public anon key and the id of a slot or of a draft, anyone can delete an athlete's upcoming exercises or approve a draft. Migration 02.
- **Anyone can create an account** through the API, although the app has no sign-up screen (finding L5). Auth settings.
- **Nothing records which SQL production has.** Migration 01 creates that record; every later migration signs it.
- **No backup has ever been taken.**

For the app that is deployed, nothing changes: no table and no row is touched, a signed-in user sees the same screens, and the app is not published at this checkpoint.

**Already done** — the end-to-end run on the test athlete *before* the fixes (2026-10-03). Its scripts, its three snapshots and its screenshots are in `review-2026-09-30/runs/e2e-before/`, and the run at Checkpoint C2 is compared with them. That folder is ignored by git: it exists in this checkout only, and `git clean -x` would delete it. A copy outside the repository costs one command:

```bash
tar czf ~/sl_app-e2e-before-2026-10-03.tar.gz -C review-2026-09-30/runs e2e-before
```

### Step 1 — the CLI talks to the right project

```bash
supabase db query --linked "select current_user, current_database(), version()"
```

One row: `postgres | postgres | PostgreSQL 17.…`. If the first column is not `postgres`, stop.

Then, once: Dashboard → Project Settings → Data API → *Exposed schemas* must not list `app_private`, now or later.

### Step 2 — a backup exists

The backup of this checkpoint is a dump on your machine ([00, section 2](runbook/00-before-you-start.md)). It needs Docker: `docker info` must answer first. The two files land in your home folder, outside the repository: they hold every athlete's data in clear text, and the accounts with their e-mail addresses and password hashes.

```bash
supabase db dump --linked -f ~/sl_app-backup-schema.sql
supabase db dump --linked --data-only -f ~/sl_app-backup-data.sql
```

Then look at what was written. A dump that could not run still leaves its file behind, empty:

```bash
ls -l ~/sl_app-backup-schema.sql ~/sl_app-backup-data.sql
tail -n 1 ~/sl_app-backup-data.sql
```

Neither size is 0, and the last line of the data file is `RESET ALL;`.

**Do not set up the nightly GitHub dump at this checkpoint.** [BACKUPS.md](../BACKUPS.md) describes it — a dump-only database role and two repository secrets, `SUPABASE_DB_URL` and `BACKUP_PASSPHRASE` — and that set-up cannot produce a dump. The workflow's command, `supabase db dump --db-url`, always switches to the role `postgres`, which a dump-only role is not allowed to do; and the role as the page writes it cannot read a single table. Following it would leave a login role in production, its password in GitHub and a failing run every night. BACKUPS.md now says so above the two steps. The corrected set-up will be a step of a later checkpoint, on this page, when BACKUPS.md and the workflow have been rewritten. Until then the workflow skips every night — green, with no artifact — and the dump above is taken again before each checkpoint.

If the dump cannot be taken today — no Docker on this machine, for instance — do not let it hold up step 4. Migrations 01 and 02 write to no table of the app — 01 adds a schema and one table of its own, 02 replaces six function bodies — and each has a rollback that is tested. The open hole is the larger risk. Come back to this step before Checkpoint A1, which does not start without a backup.

### Step 3 — migration 01, the ledger

Page: [runbook/migrations/01-migration-ledger.md](runbook/migrations/01-migration-ledger.md). Rollback at hand: `supabase/rollbacks/2026_10_03_01_migration_ledger.down.sql`. There is no reason to run it.

```bash
supabase db query --linked --file supabase/audits/2026_10_03_01_migration_ledger.audit.sql
```

Four lines: `running as` reads `postgres`, the two `exists` lines read `false`, the last one `none`. Anything else: the page says what it means.

```bash
supabase db query --linked --file supabase/migrations/2026_10_03_01_migration_ledger.sql
```

```bash
supabase db query --linked --file supabase/audits/2026_10_03_01_migration_ledger.audit.sql
```

The two `exists` lines now read `true`.

### Step 4 — migration 02, the coach functions refuse a caller without a session

Page: [runbook/migrations/02-rpc-auth-null-guard.md](runbook/migrations/02-rpc-auth-null-guard.md). The most urgent step of the checkpoint. It needs migration 01 and nothing else: it does not wait for step 5.

Rollback at hand: `supabase/rollbacks/2026_10_03_02_rpc_auth_null_guard.down.sql`. **It reopens the hole.** Run it only if a signed-in coach is refused (`not authorized`) on an athlete of their own.

```bash
supabase db query --linked --file supabase/audits/2026_10_03_02_rpc_auth_null_guard.audit.sql
```

Eight lines. Line 3, `coach RPCs that run without a session (P1)`, lists the five functions of line 2: that is the finding. Lines 4, 5 and 6 read `none`. Stop and report if line 2 has a sixth entry or line 6 names a function; for any other surprise the page says whether to go on.

```bash
supabase db query --linked --file supabase/migrations/2026_10_03_02_rpc_auth_null_guard.sql
```

```bash
supabase db query --linked --file supabase/audits/2026_10_03_02_rpc_auth_null_guard.audit.sql
```

Line 3 now reads `none`. Line 7 still lists the five: `anon` keeps the right to *call* them until migration 03 at Checkpoint A1, and from now on that call is refused in the function's first lines.

```bash
supabase db query --linked "select name, applied_at from app_private.app_migrations order by applied_at, name"
```

Two rows: `2026_10_03_01_migration_ledger` and `2026_10_03_02_rpc_auth_null_guard`.

Then see the refusal for yourself. This asks one of the five for a dry run, which writes nothing, as a caller without a user id — which is what you are in the CLI:

```bash
supabase db query --linked "select public.adopt_skip((select id from public.exercise_slots order by id limit 1), true)"
```

It must **fail** with `not authorized`. That failure is the fix.

Two things to know afterwards. Calling one of the five from the SQL editor or with the service-role key now answers `not authorized` as well, since neither has a user id: to run one as a given coach, use the SQL editor's role selector (*authenticated*, that user). And a coach whose session expired while the app was open now gets an error on those five actions until they sign in again, where the action used to go through as an anonymous call.

### Step 5 — the Auth settings

Page: [runbook/20-auth-config.md](runbook/20-auth-config.md). Dashboard only: no SQL file, no migration. In this order:

1. **The check** (page, section 1) — one read-only command. Today it prints `disable_signup: false`.
2. **Who has an account** (same section) — one read-only query. An address you do not know is noted and reported, not deleted.
3. **The four settings**, Dashboard → Authentication:

   | Setting | Where | Value |
   |---|---|---|
   | Allow new users to sign up | Sign In / Providers | off |
   | Site URL | URL Configuration | `https://tamachiii.github.io/sl_app/` |
   | Redirect URLs | URL Configuration | `https://tamachiii.github.io/sl_app/**`, and nothing else |
   | Minimum password length | Sign In / Providers → Email | `8` |

4. **The check again**: `disable_signup: true`. It shows that one setting only; the three others are confirmed by reloading the two dashboard pages and reading the values back.
5. **Sign in to the app in a private window.** It works as before.

Four switches on those pages look like hardening and break the app that is deployed. Leave them as they are: the **Email provider** on and **Captcha protection** off (either one turned the other way, nobody can sign in), **Secure password change** off and **Password requirements** at none (the app's change-password dialog would fail). The page says why.

Not steps: leaked-password protection is for paid plans only, so the Security Advisor keeps that warning; a custom SMTP sender is needed from wave 6.

### Step 6 — say that it is done

Checkpoint A1 is written against a production that has A0. Pass on:

- the two ledger rows of step 4, with their dates;
- any line of an audit, or of the account list, that was not what its page calls clean;
- whether the two dump files of step 2 exist and are not empty, or that there is no backup yet.

### Optional — two bell rows left by the first end-to-end run

The run undid everything it wrote except two notifications in the coach's bell, both about the test athlete's session of 2026-10-03 and both already read: a signed-in user cannot delete a notification. Leaving them changes nothing.

To remove them:

```bash
supabase db query --linked --file review-2026-09-30/runs/e2e-before/cleanup.sql
```

The file deletes those two rows and nothing else: its `DELETE` names the two ids, the coach as recipient and the session, in one transaction. A second run deletes nothing.

It ends with one query that counts what the run left, the expected value noted beside each count, and its header — written for the SQL editor — says to roll back when a count differs. Through this command it commits either way. Read the counts as information, not as a gate: the expected values date from 2026-10-03, the test athlete's rows may have moved since, and no count can make the delete reach a third row.

It has not been run by anyone. Like the rest of that folder it is in this checkout only.

### Optional — the coach's phone receives nothing yet

The coach account has no push subscription, so every push meant for the coach (a confirmed session, a message, an off-plan exercise) reaches no device. On the coach's phone, in the installed app: avatar → **Notifications** → *Enable*. On an iPhone the app must be on the Home Screen first.

## First-push checklist

**Not before Checkpoint A3 is applied.** The repository is public, and this branch says how to use holes that stay open in production until then: the Checkpoint A0 section above and the page of migration 02 (the five coach functions, until A0), `supabase/tests/known-holes.test.js` (one test per hole that is still open, until the migrations of wave 1 are applied at A1 to A3). A push under any branch name publishes them, not only a push to `main`. From then on the same order holds for every wave: its checkpoint first, its commits on GitHub afterwards.

Nothing is pushed while the review is being worked through, so the parts of CI that only run on GitHub have never run. On the first run after the push, check:

1. Job `test`, step `npm audit --omit=dev --audit-level=high`: green. Red with an unchanged lockfile means a new advisory was published since: run `npm audit --omit=dev` locally, then `npm audit fix` (never `--force`), run the tests, commit the lockfile.
2. The three third-party actions resolve. A wrong commit fails the job at "Set up job":
   - `peaceiris/actions-gh-pages@84c30a85c19949d7eee79c4ff27748b70285e453` (v4.1.0) in `.github/workflows/deploy.yml`
   - `supabase/setup-cli@1dedf2c611547ede7232d26866dd3c56ab903bbb` (v1.7.3) in `.github/workflows/backup.yml` — run the backup once by hand (Actions → Nightly DB backup → Run workflow). It needs no secret for this: without them the run skips the dump and stays green, and the action is fetched at "Set up job" all the same
   - `denoland/setup-deno@22d081ff2d3a40755e97629de92e3bcbfa7cf2ed` (v2.0.5) in `.github/workflows/test.yml`
3. Job `functions`: the `deno check` step is green, with no "Edge Functions" warning on the run summary. Then delete `continue-on-error: true` and the reporting step after it in `.github/workflows/test.yml`: from then on a broken function stops the gate.

**Updating a pinned action.** The actions are pinned to a commit, because a tag can be moved:

```bash
git ls-remote https://github.com/<owner>/<repo> 'refs/tags/v<major>*'
```

Take the commit of the release you want (for an annotated tag, the line ending in `^{}`), paste the 40 characters after the `@`, and update the `# vX.Y.Z` comment on the same line. `src/test/ciGuardrails.test.js` refuses a tag, a branch, a short SHA, or a SHA without its release comment.

**Known advisories, in development tools only.** What ships is clean: `npm audit --omit=dev` finds nothing, and that is the audit CI runs. `npm audit` without `--omit=dev` reports two things more. One chain has no fix: `braces` (GHSA-vfj7-8cjw-p6xm, every version) through `micromatch`, `fast-glob`, `globby` and `gh-pages`, five entries, all high. The only thing npm offers for it is `--force`, a downgrade of `gh-pages` to 6.1.1. Do not run it: `gh-pages` is used only by the emergency `npm run deploy`. The other, `source-map-js` (GHSA-68fv-2mgg-jv7q, a dependency of the build and test tools), was published after the dependencies of wave 0 were settled and has a fix that breaks nothing: `npm audit fix`, without `--force`, the next time the dependencies are touched.
