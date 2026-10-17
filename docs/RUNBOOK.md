# RUNBOOK — what the owner does by hand, and when

The fixes of the 2026-09 review are written and tested in the repository. Three things are not done there, because no script, workflow or test of the repository touches production: **applying SQL**, **changing a dashboard setting**, and **publishing the app**. They are done by hand, at a checkpoint, and a checkpoint is yours to start. This page says when each one is due, in what order, and [who runs it](#who-runs-a-checkpoint).

It is the index. Whatever needs more than a few lines has a page of its own:

| Page | What it covers |
|---|---|
| [runbook/00-before-you-start.md](runbook/00-before-you-start.md) | the CLI link, the backup, how to run an audit, a migration and a rollback, how to read the ledger, what each error means |
| [runbook/migrations/](runbook/migrations/) | one page per migration: what it does, what a clean audit looks like, what the deployed app does differently, when to roll back |
| [runbook/20-auth-config.md](runbook/20-auth-config.md) | the Auth settings of the Supabase dashboard |
| [runbook/30-edge-functions.md](runbook/30-edge-functions.md) | the Edge Functions: the deploy command, their secrets, the check after a deploy, rotating the shared bearer, going back to the version before |
| [runbook/40-deploy.md](runbook/40-deploy.md) | publishing the app: what a push to `main` runs, the check of the ledger that stops it, the secret it reads production with, what each refusal means |
| [../BACKUPS.md](../BACKUPS.md) | what a backup holds and what it does not, how to take, check and restore one, the passphrase, the nightly run on GitHub |

## Rules that hold at every checkpoint

1. **In order, and only what the checkpoint lists.** The two digits in a file name (`…_01_…`, `…_02_…`) are the order. The files in `supabase/migrations/` dated before `2026_10` are history: production has them, never run one again.
2. **A backup less than a day old before the first statement** ([00, section 2](runbook/00-before-you-start.md)). The project is on the free plan, which has no backup of its own. The backup is one encrypted file that a script of the repository writes on your machine, taken again before each checkpoint. The nightly run on GitHub has been set up since the [first push](#first-push-checklist) (2026-10-13); a checkpoint still starts with a backup of its own, of that moment.
3. **Audit, apply, audit.** An audit is one read-only query: run it before a migration and again after. When it does not show what the migration's page calls clean, the page says whether to go on or to stop. *Stop and report* means: apply nothing more, and pass the full output on.
4. **A rollback only when the migration's page says so**, last applied first.
5. **The ledger is the proof.** A checkpoint is done when `app_private.app_migrations` lists its migrations, not when a command printed nothing alarming.
6. **Database first, app second.** A build of the app needs every `required` migration of its wave, and of the waves before it, in production. Pushing to `main` publishes the app (`.github/workflows/deploy.yml`), so the branch of the review reaches `main` only at a checkpoint whose row below says the app is published. Under its own name it is not pushed either before Checkpoint A3: the repository is public ([First-push checklist](#first-push-checklist)). The deploy holds this rule itself: between the tests and the publish, its `migrations` job reads the ledger and stops when a `required` migration of the commit is not in it, naming each one ([runbook/40-deploy.md](runbook/40-deploy.md)). It is the net, not the plan: the checkpoint still comes first. `npm run deploy`, the emergency publish from your machine, goes around it.
7. **Never** `supabase db push`, `supabase migration up`, `supabase migration repair`: the folder is not a CLI migration history and cannot be replayed.
8. **Never** `supabase config push`, and `supabase/config.toml` never gets an `[auth]` section: a push would put the CLI's Auth defaults back (sign-up on, site URL on localhost, 6-character passwords). `src/test/authConfig.test.js` holds the repository's side of that.
9. **One migration at a time, and the first surprise ends the sitting.** A line of an audit that is not what the migration's page calls clean, a check that answers anything but what its step expects, a message the page does not list: nothing more is applied, and the full output is passed on. Each step of a checkpoint says which lines stop it and which are only noted.

## Who runs a checkpoint

You decide that a checkpoint starts. Who pastes the commands is your choice, and the sequence is the same either way: in the sections below, *you* is whoever runs it.

Checkpoint A0 was run by Claude at your request, A1 to A3 and B under your standing answer of 2026-10-12 — Claude applies the migrations of the checkpoints for you — when you say that a checkpoint may start, never on its own, and never as part of the work on a package: an agent that writes or tests a migration does not run it. The answer and its conditions are noted in `review-2026-09-30/user-answers.md`, which exists in this checkout only. What Claude holds to when it runs one:

- a fresh backup first, taken and checked with the two commands of the checkpoint's first step;
- the audit before and after each migration, one migration at a time, in the order of `supabase/migrations/manifest.json`;
- rule 9: it stops at the first line that is not what the page calls clean, and reports the output as it is;
- the rollback file of each migration at hand, run only in the case its page names;
- a dashboard value changed through the Management API only when the checkpoint lists it, with the previous values saved first, as at A0;
- the checks in the app with the test athlete and its coach account only, each thing written undone in the same step, and nobody signed out;
- at the end, what the last step of the checkpoint — *what to pass on* — lists.

What that answer does not cover — each of these is asked again, every time:

- an `optional` or a `contract` migration: 19, 26, 31, and 43 to 45;
- a statement that a page gives beside its migration and that writes or deletes rows of the app: removing a coach–athlete link (05), naming an account (07), taking a review back or adding the sets a reviewed session lacks (08), handing goals over to the coach of today (10), switching off a block in the trash or numbering a phase again (11), removing a video file that no video names (25). The step of its migration says when it comes up. Claude reports what there is — the list that the query of the page's section gives, or the number on the line of the audit where the section has no query — and writes nothing until you have answered. Where the statement comes before its migration (05, 08), the migration waits for your answer, and so does everything after it; where it comes after (07, 10, 11, 25), the sequence goes on and the list is part of what is passed on;
- a run of `run_retention()` — the first one after migration 18, and each month after it — and every other procedure of [runbook/70-admin-procedures.md](runbook/70-admin-procedures.md): they are done outside a checkpoint, and each deletes or writes rows that do not come back;
- pushing to `main`, which publishes the app, and pushing the branch at all;
- deploying an Edge Function;
- enabling an extension (pg_cron) — and with it the optional migration 19, which from its first night on deletes the old rows without a question: [runbook/50-pg-cron.md](runbook/50-pg-cron.md) is what the answer is given on. Pausing a job, and the rollback of migration 19, are asked the same way;
- a GitHub secret or variable.

For Checkpoint B, and for it only, you answered on 2026-10-15 for three of these at once: switch pg_cron on and apply migration 19; deploy the two Edge Functions as [runbook/30-edge-functions.md](runbook/30-edge-functions.md) says, with their check after the deploy; and push the head of wave 2 to `main` once everything before it reads clean. Two things were done otherwise than the sequence of B says, and step 9 records both. **pg_cron was switched on by SQL**, as `postgres` (`create extension if not exists pg_cron with schema pg_catalog` — the platform lets `postgres` create it, since pg_cron is in `supautils.privileged_extensions`), not with the dashboard's switch: the effect is the same extension, `pg_cron 1.6.4`. **The version of `send-push` was seen without the rotation**: the bearer was read from the vault (`app_service_role_key`) into the environment of the check only, never printed, and the check's `200` showed that the function's secret and the vault hold one value. The rotation writes a secret of the functions and the vault's copy, and your go had not named it: it was asked, and done on 2026-10-16 at 21:10 UTC under your answer of that day ("pour le secret je t'autorise").

For Checkpoint C1 you answered on 2026-10-17 for two of them: the optional migration 26 (*26 oui*), and the push of the head of wave 3 to `main` once every step before it reads clean (*pousse*) — that commit only, as a fast-forward. The statements that write or delete rows of the app are still asked one by one, those of the end-to-end run of C1 included.

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

A checkpoint is one sitting: a list of migrations, sometimes a dashboard step or a function to deploy, and whether the app is published afterwards. A checkpoint marked **done** or **ready** has its sequence on this page: *done* is the record of what was run, *ready* is what can be run now, in the order of the table. The others are deferred: the review ends with C1, and their numbers are reserved for the work [BACKLOG.md](BACKLOG.md) lists.

| Checkpoint | Due | Migrations | Also by hand | App published after it | Hand-over |
|---|---|---|---|---|---|
| A0 | after wave 0 | 01, 02 | Auth settings; a backup on your machine | no | **done** on 2026-10-11 |
| A1 | after wave 1 | 03 | a smoke check as athlete and as coach, with the app that is deployed | no | **done** on 2026-10-13 |
| A2 | after A1 and its smoke check | 04–10 | looks in the app that is deployed, on the test athlete; what to tell the coach | no | **done** on 2026-10-13 |
| A3 | after A2 | 11–14 | just before the push: the two repository secrets — the deploy reads the ledger with `SUPABASE_DB_URL`, and stops without it | yes: the first one, the head of wave 1 — `fc7a552`, published on 2026-10-13 | **done** on 2026-10-13 |
| B | after wave 2 | 15–18, and 19 if pg_cron is enabled | deploy the two Edge Functions; pg_cron and migration 19 — you said yes on 2026-10-15 | yes: the head of wave 2 — `2bb6495`, published on 2026-10-15 | **done** on 2026-10-15 |
| **C1** | now — wave 3, the last wave of the review, is finished | 20–25, and 26 (optional) | read the list of migration 21 first; the end-to-end run *after* on the test athlete — you said yes to 26 and to the push on 2026-10-17 | yes: the head of wave 3 | **ready** |
| C2 | — | 27–30 and 32; 31 is optional | — | — | deferred to the redesign project ([BACKLOG.md](BACKLOG.md)) |
| D | — | 33–35 | — | — | deferred to the redesign project ([BACKLOG.md](BACKLOG.md)) |
| E | — | 36, 37 | — | — | deferred to the redesign project ([BACKLOG.md](BACKLOG.md)) |
| F | — | 38–40 | — | — | deferred to the redesign project ([BACKLOG.md](BACKLOG.md)) |
| G | — | 41, 42 | — | — | deferred to the redesign project ([BACKLOG.md](BACKLOG.md)) |
| Z | — | 43–45 | — | — | deferred to the redesign project ([BACKLOG.md](BACKLOG.md)) |

`supabase/migrations/manifest.json` is what counts: a migration belongs to the checkpoint its entry names, and `src/test/runbookIndex.test.js` fails when this table says otherwise. The campaign of the review ends with Checkpoint C1 (decision of 2026-10-17): C2 to G and Z belong to work that was not built — the migrations 27 to 45 are reserved numbers, not files — and [BACKLOG.md](BACKLOG.md) says what each was to bring. Migrations 43 to 45 remove what an old installed app still uses, which is why Checkpoint Z was to wait at least 14 days after the last publication.

## Checkpoint A0 — the ledger, the anonymous RPC hole, public sign-up

**Done on 2026-10-11**, by Claude at your request. This section stays as it was run: it is the record, and the model of the three that follow.

| Step | What it gave |
|---|---|
| 1 — the project | `postgres` on PostgreSQL 17.6; the exposed schemas are `public` and `graphql_public`, not `app_private` |
| 2 — the backup | the first run of the three commands against the project, all three good: `read back 24 tables, 12,729 rows, every checksum matches`, `OK`, `DRILL OK` with the 20 tables of `public` identical |
| 3 — migration 01 | audit as its page describes, before and after; in the ledger since 2026-10-11 20:24:37 UTC |
| 4 — migration 02 | line 3 listed the five functions before and reads `none` after; in the ledger since 2026-10-11 20:24:59 UTC; the dry run fails with `not authorized` |
| 5 — the Auth settings | the four values set and read back, and the public check reads `disable_signup: true`; the coach and the test athlete still sign in; the nine accounts are one coach and their eight athletes, nobody else |
| the two optional steps | not done: the two bell rows are still there, and the coach's phone has no subscription |

When this checkpoint was closed, production had migrations 01 and 02 and nothing later, and the app that was deployed was the one from before the review.

What it closes:

- **Five coach functions run for a caller who is not signed in** (finding P1, critical). With the public anon key and the id of a slot or of a draft, anyone can delete an athlete's upcoming exercises or approve a draft. Migration 02.
- **Anyone can create an account** through the API, although the app has no sign-up screen (finding L5). Auth settings.
- **Nothing records which SQL production has.** Migration 01 creates that record; every later migration signs it.
- **No backup has ever been taken.**

For the app that is deployed, nothing changes: no table and no row is touched, a signed-in user sees the same screens, and the app is not published at this checkpoint.

**Already done** — the end-to-end run on the test athlete *before* the fixes (2026-10-03). Its scripts, its three snapshots and its screenshots are in `review-2026-09-30/runs/e2e-before/`, and the run *after*, at Checkpoint C1, is compared with them. That folder is ignored by git: it exists in this checkout only, and `git clean -x` would delete it. A copy outside the repository costs one command:

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

Page: [00, section 2](runbook/00-before-you-start.md). The backup is one file on your machine, written by a script of the repository: Node only — no Docker, no `pg_dump`. It reads the database in one read-only transaction and cannot change it.

Once: a passphrase (`openssl rand -base64 32`, kept in your password manager — a backup cannot be opened without it) and two lines in `.env`, `SUPABASE_DB_PASSWORD` and `BACKUP_PASSPHRASE`. The page gives both.

```bash
node --env-file=.env scripts/backup/dump.mjs
```

First who it connects as, and where: `postgres.<project ref> at …pooler.supabase.com` — the ref is how you see it is the right project. Then one line per table with its row count, the path of the file — `~/sl_app-backups/sl_app-<UTC time>.jsonl.gz.enc`, outside the repository — and `read back … every checksum matches`.

```bash
node --env-file=.env scripts/backup/verify.mjs
```

It ends with `OK`. Look at the counts once: `auth.users` is the number of accounts, `public.set_logs` is in the thousands.

Then, once, the restore for practice. It loads the backup into a throw-away PostgreSQL on your machine, compares every table with the file, and removes the server again:

```bash
node --env-file=.env scripts/backup/drill.mjs
```

It ends with `DRILL OK`; every table of `public` reads `identical`. The tables of `auth` and `storage` may read `row count only` or `NOT LOADED`: the throw-away server is not Supabase.

**This is the first time the script meets the real database.** It is tested against PostgreSQL 17.6 in the repository, not against the project: the pooler and its TLS are new to it. If a command prints `FAILED:`, it has written nothing and changed nothing; pass the message on, and do not let it hold up step 4. Migrations 01 and 02 write to no table of the app — 01 adds a schema and one table of its own, 02 replaces six function bodies — and each has a rollback that is tested. The open hole is the larger risk. Come back to this step before Checkpoint A1, which does not start without a backup.

The nightly backup on GitHub is not set up at this checkpoint: its workflow is part of this branch, which is not on `main` yet. It is a step of the [first push](#first-push-checklist).

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
- the last line of each of the three commands of step 2 (`read back …`, `OK …`, `DRILL OK …`), or the `FAILED:` message of the one that stopped — and that there is no backup yet, if so.

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

## Checkpoint A1 — who may call a function

**Done on 2026-10-13**, by Claude under your standing answer of 2026-10-12. The section stays as it was run: it is the record.

| Step | What it gave |
|---|---|
| 1 — the backup | `sl_app-20261013T053902Z…`, taken and checked (12,831 rows) |
| 2 to 4 — migration 03 | the audit read as the "before" column of its page, then as the "after" one; no stop, nothing noted |
| 5 — the ledger | three rows, `2026_10_11_03_function_grants_lockdown` at 05:39 UTC |
| 6 — the two checks | as a request without a session: `permission denied for function student_profile_for_slot`; every table opened as a signed-in user: no refusal |
| 7 — the app that is deployed | the look was automated — a read-only pass in a browser as the coach and as the test athlete, writes blocked, plus one set ticked and unticked as the test athlete through the API, restored and checked: `SMOKE OK`, no HTTP error from Supabase, no page error |

What it closes:

- **Every function of the database answers a caller who is not signed in** (findings B2, L21). With the anon key, which is in the app's JavaScript, the twelve helpers the security policies are written with say, for any id, which athlete a session, a set or a goal belongs to and who coaches them. Migration 03 takes every right on every function away from a request without a session, and leaves a signed-in user an explicit list.
- **25 functions look names up wherever their caller says** (L23). The same migration pins their `search_path`.

For the app that is deployed, signed in, nothing changes. It is the migration with the widest reach of the review — every query of the app goes through a function it touches — so this checkpoint holds it alone and ends with a look at the app. Checkpoint A2 does not start before that look.

Page: [runbook/migrations/03-function-grants-lockdown.md](runbook/migrations/03-function-grants-lockdown.md). Rollback at hand: `supabase/rollbacks/2026_10_11_03_function_grants_lockdown.down.sql`. **It reopens the findings**, and puts the grants back in one command. Run it when line 7 of the audit of step 4 names a function, or on a `permission denied for function …` in the second check of step 6 or in step 7, and report the name of the function. The first check of step 6 is meant to answer with that message: there it is the fix, not a reason to roll back.

### Step 1 — the right project, and a backup

```bash
supabase db query --linked "select current_user, current_database(), version()"
```

One row, `postgres | postgres | PostgreSQL 17.…`, as at A0. If the first column is not `postgres`, stop.

```bash
node --env-file=.env scripts/backup/dump.mjs
```

```bash
node --env-file=.env scripts/backup/verify.mjs
```

The first ends with `read back … every checksum matches`, the second with `OK`. A `FAILED:` ends the sitting: from here on a checkpoint does not start without a backup of the day ([00, section 2](runbook/00-before-you-start.md)).

### Step 2 — the audit of migration 03

```bash
supabase db query --linked --file supabase/audits/2026_10_11_03_function_grants_lockdown.audit.sql
```

Fifteen lines. Clean is the "before" column of the page's table: line 2 reads `36`; lines 3, 4, 5, 7 and 10 read `none`; line 6 — the finding — `all 36`; line 8 `all 17`; line 9 `30 of 36`; line 11 `25 of 36`; line 12 `all 36`.

- **Stops the checkpoint**: line 1 is not `postgres`; line 2 is not `36`, or line 3 or 4 names a function — production has a function the repository does not know, or lacks one, and the migration refuses to run; line 5 is not `none`.
- **Noted, and the sequence goes on**: another count on line 6, 8, 9, 11 or 12 (a few functions were closed by hand already); a name on line 7 or 10; whatever lines 13 to 15 read.
- Lines 6 to 12 already read as the "after" column: the migration is in the database. Go to step 5; with three rows in the ledger, go on from step 6.

### Step 3 — migration 03

```bash
supabase db query --linked --file supabase/migrations/2026_10_11_03_function_grants_lockdown.sql
```

A refusal changes nothing, and the page says what each one means. `does not know: …`, `does not find: …` or `did not get the privileges it meant: …`: stop and report the full message.

### Step 4 — the audit again

```bash
supabase db query --linked --file supabase/audits/2026_10_11_03_function_grants_lockdown.audit.sql
```

The "after" column: lines 6, 8, 9, 11 and 12 read `none`, line 13 `postgres, service_role`, line 14 `postgres`. **Line 7 must read `none`**: a name there is a function the app needs and can no longer call — roll back.

### Step 5 — the ledger

```bash
supabase db query --linked "select name, applied_at from app_private.app_migrations order by applied_at, name"
```

Three rows, the last one `2026_10_11_03_function_grants_lockdown`.

### Step 6 — the refusal, and the way through, from the CLI

One of the twelve helpers, called as a request without a session calls it:

```bash
supabase db query --linked 'do $check$ begin set local role anon; perform public.student_profile_for_slot(gen_random_uuid()); end $check$'
```

It must **fail** with `permission denied for function student_profile_for_slot`. That failure is the fix.

Then every table of the app, opened the way a signed-in user opens it — which is when the database asks for the right to call the helpers of its policies. It reads no row and changes nothing:

```bash
supabase db query --linked 'do $check$
declare t record;
begin
  set local role authenticated;
  for t in select tablename from pg_tables where schemaname = $s$public$s$ order by 1 loop
    execute format($q$select 1 from public.%I limit 0$q$, t.tablename);
  end loop;
end $check$'
```

It must **not** fail. `permission denied for function …` names a helper a policy calls and a signed-in user cannot execute: roll back, and report the name.

### Step 7 — the app that is deployed, as an athlete and as the coach

On a phone or in a browser, with the app as it is published today.

As an athlete: the training list shows the current block; open the next session — the exercises and their sets are there; tick a set, then untick it; open Messages and Stats.

As the coach: the roster shows every athlete, with their programs; open an athlete, then a session of their program; open a session to review, and play a video if one has any; open Messages.

A problem looks like this: a list that should hold something is empty or shows an error, or a red message *You don't have permission to do that.* In the browser's developer tools (Network), the failed request answers `permission denied for function <name>`. Any of these: roll back, and report the name.

### Step 8 — what to pass on

- the three ledger rows of step 5, with their dates;
- any line of the audit that was not what step 2 or step 4 calls clean;
- that step 7 was done with both accounts. Checkpoint A2 starts only then.

## Checkpoint A2 — training history, the coach–athlete link, the locks of a session

**Done on 2026-10-13**, by Claude under your standing answer. The section stays as it was run.

| Step | What it gave |
|---|---|
| 1 — the backup | `sl_app-20261013T054430Z…`, taken and checked |
| 2 to 8 — migrations 04 to 10 | every audit read as the "before" column of its page, then as the "after" one; no stop and no case to decide: 05 line 11 `0` (no forged link), 08 lines 13 and 14 `0`, 09 lines 13 to 15 `0` (the migration deleted no notification); every check of a page answered `check only, nothing was written: protected: …`; the automated look at the app after each migration: `SMOKE OK` |
| 9 — the ledger | ten rows, 04 to 10 written between 05:44 and 05:49 UTC |
| the numbers noted | 04: line 11 `4770 of 5963` sets logged, line 12 `0` videos, line 13 `0`, line 14 `1 in 1 exercise(s)` (a logged set numbered above its exercise's count), line 15 `2 (0 with fewer rows, 2 with more)`; 05: lines 12 to 14 `0`, line 15 `1 coach, 8 athletes with a coach`; 06: lines 10 and 11 `0`, line 12 `0 drafts`; 07: line 10 `0`; 08: line 12 `2` reviewed sessions of a block being trained (closed for their athlete since), line 15 `0 videos`; 10: lines 12 to 15 `0`, line 16 `15 goals on 5 exercises, 4 attempts` |
| not done | the looks of steps 2 to 9 that need the coach's editor — a set added and removed, *Sets* lowered on a trained session, the library's add, rename and delete, a confirmation and its undo with the line of the bell — were not made through the app; the checks of the pages hold those protections in SQL |

Seven migrations, each of them safe with the app that is deployed. What they close:

| Migration | Finding | What is true today |
|---|---|---|
| 04 | P3, P17 | a coach's edit — a lower set count, a removed exercise, a deleted session — can delete what an athlete trained, and rewrite the targets of sets already done |
| 05 | P7, L2 | any account can write a row of `students` and make itself the coach of another account |
| 06 | P13, P14, B4 | an athlete can turn a prescribed set into one they may delete, stamp the sessions of a draft as reviewed, and notify the coach of one draft as often as they like |
| 07 | P20, B10 | the documented way to make a coach answers `UPDATE 1` and does nothing; an account created in the dashboard has an empty name |
| 08 | P58, L5 | an athlete still writes sets, notes, swaps and videos in a session the coach archived or reviewed, and can upload a file under any path |
| 09 | P57, L12 | a confirmation can be undone after the review, a session reviewed without one, and a notification outlives what it was about |
| 10 | P18, L7, P21, B9 | deleting a library exercise deletes the goals set on it with their attempts; a former coach keeps reading an athlete's attempts |

**Tell the coach before the sitting.** Until the app of wave 1 is published (Checkpoint A3), the app that is deployed does not know these rules and shows them as refusals:

- in the session editor, removing a set an athlete logged, lowering *Sets* below one or removing its exercise answers *This has logged training — archive it instead of deleting.*, and a change of reps, load or rest leaves the sets already logged as they were (migration 04);
- archiving a session of an athlete's draft, or giving it a recommended date, does not stay: both are done after *Approve* (06);
- a session you reviewed or archived can no longer be changed by its athlete — sets, notes, swaps, videos. An athlete who tries reads *Couldn't save that. Please try again.* or *You don't have permission to do that.*: from a screen that is out of date, when writing a note after the review, or anywhere on a session you reviewed before they confirmed it, which that app still shows as open. Until the next app is published, review a session only once its athlete has confirmed it. Line 12 of the audit of migration 08 is the number of sessions that close on the day (08);
- an athlete can no longer undo the confirmation of a session you reviewed: to correct one they write to you, and the session is opened again by SQL (page 09, "Taking a review back"). On a session that is not confirmed, *Finish without feedback* answers *You don't have permission to do that.* and the feedback box shows a sentence of the database. Lines in your bell that you had not read, about a confirmation or a skip that was undone, are gone (09);
- a library exercise that a goal is set on can no longer be deleted — *Can’t do that — this is still in use elsewhere.* — where the app used to delete the goal and its logged attempts with it; delete the goal first if it is no longer wanted (10).

**How each step reads.** Line 1 of every audit is `running as` and reads `postgres`: anything else stops the checkpoint. Clean is the "before" column of the table on the migration's page; the step names the lines that stop the sequence and the ones that are only noted. When the lines a migration changes already read as its "after" column, it is in the database: read the ledger ([How to run a file](#how-to-run-a-file)) and, if its row is there, go on with the next step. A refusal of the migration itself changes nothing; the page lists each message, and `canceling statement due to lock timeout` or `deadlock detected` means the app was writing at that moment: run the file again.

Each page then has **its check** — step 3 of its *After*, one pasted command. It is too long to repeat here, and a test runs it from its page. It tries the hole, on rows of production or on accounts it creates for the purpose, and then fails whatever happened, so that nothing is kept: the answer is in the message, which starts with `check only`. `NOT PROTECTED`, `NOT TRIED` or a message that does not start with `check only`: stop and report it. `BROKEN`: roll that migration back, and report. `nothing to try`: production holds no row the check could use, and the audit of the step is the answer. **The look in the app** — step 4 of the page's *After* — comes only once the check has answered what its step expects, and before the next migration.

### Step 1 — a backup

```bash
node --env-file=.env scripts/backup/dump.mjs
```

```bash
node --env-file=.env scripts/backup/verify.mjs
```

`read back … every checksum matches`, then `OK`. Taken again even when the one of A1 is from the same day: it is the state the seven migrations start from.

### Step 2 — migration 04: logged training is not deleted, and not rewritten

Page: [runbook/migrations/04-logged-history-guards.md](runbook/migrations/04-logged-history-guards.md). Rollback at hand: `supabase/rollbacks/2026_10_11_04_logged_history_guards.down.sql`. **It reopens the findings.** Run it only if a coach is refused on something nobody trained — a set that is not ticked, failed, skipped, rated or filmed. It is not the way to delete training history on purpose: that is the recipe of the page, which leaves the guards in place.

```bash
supabase db query --linked --file supabase/audits/2026_10_11_04_logged_history_guards.audit.sql
```

Clean: line 2 reads `programs; sessions; weeks`, lines 3 and 4 `missing`, line 6 `adopt_skip; adopt_swap`, lines 5, 7, 8 and 10 `none`, line 9 lists `adopt_skip(uuid, boolean); adopt_swap(uuid, uuid, boolean)`, lines 13 to 15 `0`.

- **Stops**: line 8 or line 10 is not `none` — migration 03 is not applied, or was rolled back.
- **Noted**: line 2 lacking one of the three, or line 9 lacking a function (the migration puts both right); lines 13, 14 or 15 not `0` — sets left at a parked number or out of step with their exercise's count: the migration changes none of them, and the page says what each is; lines 11 and 12, which are what it protects.

```bash
supabase db query --linked --file supabase/migrations/2026_10_11_04_logged_history_guards.sql
```

```bash
supabase db query --linked --file supabase/audits/2026_10_11_04_logged_history_guards.audit.sql
```

Lines 2 to 7 read as the "after" column: `exercise_slots; programs; sessions; set_logs; weeks`, `in place`, `in place`, `all 9`, `none`, `all 6`. **Line 9 must still list both functions**: one missing is a function the coach's app can no longer call — roll back.

The check of the page must fail with `check only, nothing was deleted: protected: set … of exercise slot … is a logged set — it cannot be deleted`.

In the app, as the coach, on the test athlete: in a session nobody trained, add a set to an exercise and remove it — both go through; in a session the test athlete trained, type a lower number in *Sets* of an exercise whose last set is done — the red message appears, and after a reload the number is the old one.

### Step 3 — migration 05: the coach–athlete link cannot be forged

Page: [runbook/migrations/05-students-role-gate.md](runbook/migrations/05-students-role-gate.md). Rollback at hand: `supabase/rollbacks/2026_10_11_05_students_role_gate.down.sql`. **It reopens the findings.** Run it only if something the app does for a coach or an athlete is refused with a sentence of that page, or by row-level security on `students` or `exercise_library`.

```bash
supabase db query --linked --file supabase/audits/2026_10_11_05_students_role_gate.audit.sql
```

Clean: line 2 lists the three policies `Coaches delete their students (DELETE); Coaches insert students (INSERT); Coaches update their students (UPDATE)`, line 3 reads `no`, lines 4, 6 and 7 `missing`, line 5 `Coaches manage own library`, lines 8 to 10 `none`, lines 11 to 14 `0`. At A0 the nine accounts were one coach and their eight athletes, so line 15 should say that and line 11 should read `0`.

- **Stops**: line 2 lists a policy under another name; line 8, 9 or 10 is not `none`.
- **Line 11 must read `0` before the migration is applied.** It counts links whose coach is not a coach, whose athlete is not a student, or that join an account to itself — the hole, already used, or a mistake made by hand. The migration refuses to run while there is one (code `SLM05`). The page's section "Links the gate refuses" lists them and removes one; a link you made yourself is reported, not removed. Then the audit again.
- **Noted**: line 2 with fewer than three policies; lines 12, 13 or 14 not `0` — the migration changes none of those rows.

```bash
supabase db query --linked --file supabase/migrations/2026_10_11_05_students_role_gate.sql
```

```bash
supabase db query --linked --file supabase/audits/2026_10_11_05_students_role_gate.audit.sql
```

Lines 2 to 7 and 9 read as the "after" column: `Coaches update their students (UPDATE)` alone, `yes`, `in place`, `none`, `in place`, `in place`, and `is_coach()` on line 9.

The check of the page must fail with `check only, nothing was written: protected: students.coach_id … is not a coach: its profile has the role student`.

In the app, as the coach: in the exercise library, add an exercise, rename it, delete it; in a session of the test athlete that nobody trained, add an exercise and remove it. All of it goes through as before.

### Step 4 — migration 06: what an athlete's own update cannot change

Page: [runbook/migrations/06-pin-student-writes.md](runbook/migrations/06-pin-student-writes.md). Rollback at hand: `supabase/rollbacks/2026_10_11_06_pin_student_writes.down.sql`. **It reopens the findings.** Run it only if something that worked is refused or lost: an athlete's set that no longer saves, a confirmed session that shows no training date, a coach who can no longer approve a draft.

```bash
supabase db query --linked --file supabase/audits/2026_10_11_06_pin_student_writes.audit.sql
```

Clean: line 2 reads `in place`, lines 3, 5 and 6 `no`, line 4 `missing`, lines 7 and 9 `none`, line 8 `approve_program(uuid)`, lines 10 and 11 `0`.

- **Stops**: line 7 or line 9 is not `none` — migration 03 is not applied, or was rolled back.
- **Noted**: line 2 reading `missing`, or line 8 without `approve_program(uuid)` (the migration puts both right); line 10 or 11 not `0` — reported before anything is changed, and neither stops the migration; line 12, the drafts athletes are writing.

```bash
supabase db query --linked --file supabase/migrations/2026_10_11_06_pin_student_writes.sql
```

```bash
supabase db query --linked --file supabase/audits/2026_10_11_06_pin_student_writes.audit.sql
```

Lines 3 to 6 read `yes`, `in place`, `yes`, `yes`. **Line 8 must still read `approve_program(uuid)`**: otherwise the coach's app can no longer approve a draft — roll back.

The check of the page must fail with `check only, nothing was written: protected: the set is still a prescribed one`. Here `NOT TRIED` is not `protected`: stop and report.

In the app, as the test athlete: open the next session, tick a set and untick it, add an extra set to an exercise and remove it. All four go through as before.

### Step 5 — migration 07: a new account has a name, and a coach is made by SQL

Page: [runbook/migrations/07-profile-rules.md](runbook/migrations/07-profile-rules.md). Rollback at hand: `supabase/rollbacks/2026_10_11_07_profile_rules.down.sql`. **It reopens the findings.** Run it only if creating an account fails — *Add user* in the dashboard answers `Database error saving new user` — or the app can no longer save a name in Profile.

```bash
supabase db query --linked --file supabase/audits/2026_10_11_07_profile_rules.audit.sql
```

Clean: lines 2 and 4 read `in place`, lines 3, 5 and 6 `no`, lines 7 to 9 `none`, line 10 `0`.

- **Stops**: **line 2 is not `in place`** — what gives a new account its profile was removed by hand, and the migration refuses to run; line 7, 8 or 9 is not `none`.
- **Noted**: line 4 reading `missing` — until now any signed-in user could have made themselves a coach: after the migration, line 11 must give the number of coaches you made; line 10 not `0` — accounts without a name, which the migration leaves and which are named afterwards.

```bash
supabase db query --linked --file supabase/migrations/2026_10_11_07_profile_rules.sql
```

```bash
supabase db query --linked --file supabase/audits/2026_10_11_07_profile_rules.audit.sql
```

Lines 3, 5 and 6 read `yes`. **Line 2 must still read `in place`.**

The check of the page must fail with `check only, nothing was written: a new account without a name is called "sl-check-07"; you can make it a coach: yes; signed in, it can make itself one: no`. `… it can make itself one: YES`: roll back, and report.

In the app, as the test athlete: open Profile, change the name, save; then change it back.

If line 10 was not `0`: the page's section "Accounts without a name" — the list, then one of its two statements — and the audit once more, where line 10 reads `0`.

### Step 6 — migration 08: an archived or reviewed session is read-only for its athlete

Page: [runbook/migrations/08-session-write-gates.md](runbook/migrations/08-session-write-gates.md). Rollback at hand: `supabase/rollbacks/2026_10_12_08_session_write_gates.down.sql`. **It reopens the findings.** Run it only if an athlete can no longer do something on a session that is in progress, or confirmed and not yet reviewed. *My sets no longer save* is not that case when the session is a reviewed one: the page's query "Sessions reviewed that their athlete has not confirmed" is run first, and a session in its answer is opened again by its own statement — the migration stays.

```bash
supabase db query --linked --file supabase/audits/2026_10_12_08_session_write_gates.audit.sql
```

Clean: lines 2 to 7 read `no`, lines 8 to 11 `none`, lines 13 and 14 `0`. Line 12 is a number: the sessions that close for their athlete today.

- **Stops**: line 8, 9 or 10 is not `none`; **line 11 is not `none`** — it names a rule, made by hand, that lets somebody write one of these tables, and the migration would undo itself rather than leave it.
- **Before applying, when line 13 is not `0`**: the page's section "Sessions reviewed that their athlete has not confirmed". The app that is deployed shows such a session to its athlete as still to do, and from this migration on no set saves there. Its query lists them; the review of each one its athlete has still to train is taken back with the statement of "Letting an athlete write a reviewed session again". It does not stop the migration, and it is not a reason to roll it back.
- **Before applying, when line 14 is not `0`**: the page's section "Adding the sets a reviewed session lacks", or the athlete reads *You don't have permission to do that.* when opening such a session.
- **Noted**: line 12; line 15 when it counts a video stored elsewhere.

```bash
supabase db query --linked --file supabase/migrations/2026_10_12_08_session_write_gates.sql
```

```bash
supabase db query --linked --file supabase/audits/2026_10_12_08_session_write_gates.audit.sql
```

Lines 2 to 7 read `yes`, and line 9 lists `session_writable_for_slot(uuid); set_video_slot(text); slot_for_set_log(uuid)`.

The check of the page must fail with `check only, nothing was written: protected: the athlete writes a set of a session in progress, and not one of a reviewed session`.

In the app, as the test athlete, on a session that is not one of line 13: open the next session, tick a set and untick it, add a note to an exercise and delete it.

### Step 7 — migration 09: a review needs a confirmation, and closes it

Page: [runbook/migrations/09-review-lifecycle.md](runbook/migrations/09-review-lifecycle.md). Rollback at hand: `supabase/rollbacks/2026_10_13_09_review_lifecycle.down.sql`. **It reopens the findings.** Run it only if something is refused on a session that is not reviewed: an athlete can no longer confirm, or undo a confirmation you have not reviewed, or your feedback on a confirmed session is not sent. *I cannot undo my confirmation* is not that case when you reviewed the session: the review of that one session is taken back with the statement of the page's section "Taking a review back".

Unlike the six others, this migration deletes rows: the notifications of lines 14 and 15.

```bash
supabase db query --linked --file supabase/audits/2026_10_13_09_review_lifecycle.audit.sql
```

Clean: lines 2 to 8 read `no`, lines 9 to 12 `none`. Lines 13, 14 and 15 are numbers.

- **Stops**: line 9, 10 or 11 is not `none`; **line 12 is not `none`** — a rule made by hand on confirmations or messages, and the migration would undo itself.
- **Noted, with their numbers**: lines 14 and 15 — unread lines of a coach's bell about a confirmation, a swap or a skip that no longer exists. The migration deletes them, and they do not come back with the rollback. Line 13 — sessions reviewed without a confirmation, which the migration leaves as they are.

```bash
supabase db query --linked --file supabase/migrations/2026_10_13_09_review_lifecycle.sql
```

```bash
supabase db query --linked --file supabase/audits/2026_10_13_09_review_lifecycle.audit.sql
```

Lines 2 to 8 read `yes`, line 10 lists `session_is_confirmed(uuid); session_writable(uuid)`, lines 14 and 15 read `0`, and line 13 is the number it was.

The check of the page must fail with `check only, nothing was written: protected: a confirmation is taken back until the review and not after, and a session that is not confirmed is not marked as reviewed`.

In the app, as the test athlete: confirm the next session, then undo the confirmation. Both go through; in the coach's bell the *completed* line appears, and is gone again after the undo.

### Step 8 — migration 10: goals outlive a library clean-up, and follow the coach of today

Page: [runbook/migrations/10-goals-fk-coach-links.md](runbook/migrations/10-goals-fk-coach-links.md). Rollback at hand: `supabase/rollbacks/2026_10_13_10_goals_fk_coach_links.down.sql`. **It reopens the findings**, and it drops the column `archived_at`: line 15 of the audit says how many archived exercises would come back into the pickers. Run it only if something the app does with a goal, the library or the roster is refused or answers wrongly. *I cannot delete this exercise* is not that case when a goal is set on it.

```bash
supabase db query --linked --file supabase/audits/2026_10_13_10_goals_fk_coach_links.audit.sql
```

Clean: lines 2 to 7 read `no`, lines 8, 10 and 11 `none`, line 9 `coach_profile_for_goal(uuid)`, lines 12, 13 and 15 `0`.

- **Stops**: line 8 or 10 is not `none`, or line 9 is not that one function — migration 03 is not applied, or was rolled back; **line 11 is not `none`** — a rule on the athletes' attempts the migration does not know.
- **Noted**: line 12 or 13 not `0` — goals set by a coach who no longer coaches the athlete; they are handed over after the migration, with the page's section "Goals left with a former coach". Lines 14, 16 and 17 are information.

```bash
supabase db query --linked --file supabase/migrations/2026_10_13_10_goals_fk_coach_links.sql
```

```bash
supabase db query --linked --file supabase/audits/2026_10_13_10_goals_fk_coach_links.audit.sql
```

Lines 2 to 7 read `yes`.

The check of the page must fail with `check only, nothing was written: protected: an exercise with a goal and a coach with an athlete are not deleted, and after a move the attempts are read by the athlete and the new coach, not by the former one`.

In the app, as the coach: open the test athlete, section Goals. The goals and the attempts logged against them read as before.

### Step 9 — the ledger

```bash
supabase db query --linked "select name, applied_at from app_private.app_migrations order by applied_at, name"
```

Ten rows, in the order of their numbers, the last one `2026_10_13_10_goals_fk_coach_links`.

### Step 10 — what to pass on

- the seven new ledger rows, with their dates;
- the numbers that were noted: lines 11 to 15 of the audit of 04, 12 to 15 of 05, 10 to 12 of 06, 10 and 11 of 07, 12 to 15 of 08, 13 to 15 of 09, 12 to 17 of 10;
- every link, account, session or goal that a page's section was used on, and what was done with it;
- any line that was not what its step calls clean, and the message of any check that did not answer as written.

## Checkpoint A3 — the functions of the next app, table privileges, the first publication

**Done on 2026-10-13**, by Claude under your standing answer; the publication on your word of the same morning ("pousse"). The section stays as it was run.

| Step | What it gave |
|---|---|
| 1 — the backup | `sl_app-20261013T055027Z…`, taken and checked (12,839 rows) |
| 2 to 5 — migrations 11 to 14 | every audit as its page's "before", then "after" column; the checks of 11 to 13 answered `in place: …`; 11: lines 10 to 13 `0`; 12: line 11 `1` — one session without an exercise, in the active block "Bloc 3" of an athlete, session "Leg", created on 2026-10-07, for the coach to write or delete — lines 12 and 13 `0`; 13: line 9 `0`, line 10 `10` devices; 14: lines 2, 3 and 5 `20`, `none`, `none` |
| 6 — the ledger | fourteen rows, 11 to 14 written at 05:50 and 05:51 UTC |
| 7 — the two checks | without a session: `permission denied for table profiles`; every table opened as a signed-in user: no refusal |
| 8 — the app that is deployed | `SMOKE OK`; a message from the coach reached the test athlete's open app in 760 ms, and was deleted by its sender — it also sent one push to the test athlete's devices (*Test technique (contrôle après migration) — à ignorer*) |
| 9 — the publication | `check-migrations.mjs --verify` on `fc7a552`: `OK: production has all 14 required migrations of this commit`. The two repository secrets set at 05:56 UTC; `fc7a552` pushed to `main` as a fast-forward from `30f2afa` — that commit only; the branch itself is not on GitHub. Run 38354023259, *Deploy to GitHub Pages*: the five jobs green — the first run of `migrations` and of `db` on GitHub. The site served `index.html` of 06:00:15 GMT, and the automated look as the coach and the test athlete read `SMOKE OK` |
| not done | the optional deploy of `send-push` below: it moved to Checkpoint B |

Four migrations, then the app of wave 1 may be published. What they close:

| Migration | Finding | What is true today |
|---|---|---|
| 11 | P16, P51 | setting a block active, and reordering sessions or phases, are several requests: one that is lost leaves an athlete without an active block, or sessions numbered 100000 and more |
| 12 | P52 | duplicating a session, a phase or a block is thirty to forty requests: one that is lost leaves a session without its exercises, in the block the athlete trains |
| 13 | L8, P22, P15 | the missing sets of a session are inserted by the app from what it has cached, and a phone stays registered to the first account that used it |
| 14 | L24 | a request without a session, and any signed-in user, holds `TRUNCATE` on every table: one statement empties the database |

Migrations 11 to 13 add nine functions and change nothing that exists. The app that is deployed does not call them, and neither does the app of wave 1; the app of wave 2 calls them and nothing else for those gestures, and the deploy asks the ledger for them. So their rollbacks have no use after this checkpoint except a check that answers `NOT PROTECTED` or `BROKEN`, and are not run at all once the app of wave 2 is published. Migration 14 is of the kind of 03: privileges, the widest reach, and a look at the app afterwards.

The steps read as those of A2: line 1 of every audit is `postgres`, the check of a page is step 3 of its *After* and its answer starts with `check only`. For 11, 12 and 13 the answer is `in place: …`; `NOT THERE` after the migration, `NOT TRIED` or a message that does not start with `check only` means stop and report, `NOT PROTECTED` or `BROKEN` means roll that migration back and report. None of the three has anything to look at in the app.

### Step 1 — a backup

```bash
node --env-file=.env scripts/backup/dump.mjs
```

```bash
node --env-file=.env scripts/backup/verify.mjs
```

`read back … every checksum matches`, then `OK`.

### Step 2 — migration 11: a block is set active, and sessions and phases reordered, in one statement each

Page: [runbook/migrations/11-activate-reorder-rpcs.md](runbook/migrations/11-activate-reorder-rpcs.md). Rollback at hand: `supabase/rollbacks/2026_10_13_11_activate_reorder_rpcs.down.sql`. It drops the three functions and writes no row.

```bash
supabase db query --linked --file supabase/audits/2026_10_13_11_activate_reorder_rpcs.audit.sql
```

Clean: lines 2 to 4 read `no`, lines 5 to 9 `none`, lines 11 to 13 `0`. Line 10 is a number.

- **Stops**: **line 5 is not `none`**, or one of lines 2 to 4 reads `yes` while the ledger does not have the migration — a function of one of the three names was made by hand, and the migration refuses to run next to it; line 6, 7, 8 or 9 is not `none`.
- **Noted**: lines 10 to 13 — what a lost request left behind until now. None stops the migration, and it changes none of them.

```bash
supabase db query --linked --file supabase/migrations/2026_10_13_11_activate_reorder_rpcs.sql
```

```bash
supabase db query --linked --file supabase/audits/2026_10_13_11_activate_reorder_rpcs.audit.sql
```

Lines 2 to 4 read `yes`, and line 7 lists `activate_program(uuid); reorder_sessions(uuid, uuid[]); reorder_weeks(uuid, uuid[])`.

The check of the page must fail with `check only, nothing was written: in place: a coach sets a block active and reorders its sessions and its phases in one request each, and an athlete does not`.

When line 11, 12 or 13 was not `0`: the page's sections "A block in the trash that is still active" and "Sessions or phases left parked", whose statements switch such a block off and number such a phase again, in the order that is on screen. When line 10 was not `0`: the list of "Athletes without an active block", for the coach.

### Step 3 — migration 12: a session, a phase and a block are copied whole, or not at all

Page: [runbook/migrations/12-copy-rpcs.md](runbook/migrations/12-copy-rpcs.md). Rollback at hand: `supabase/rollbacks/2026_10_13_12_copy_rpcs.down.sql`. It drops the four functions and writes no row: what they copied stays.

```bash
supabase db query --linked --file supabase/audits/2026_10_13_12_copy_rpcs.audit.sql
```

Clean: lines 2 to 5 read `no`, lines 6 to 10 `none`, line 13 `0`. Lines 11 and 12 are numbers.

- **Stops**: **line 6 is not `none`**, or one of lines 2 to 5 reads `yes` while the ledger does not have the migration; line 7, 8, 9 or 10 is not `none`.
- **Noted**: lines 11 to 13 — sessions without an exercise, exercises without a set, exercises that are not in the library of their athlete's coach. Nothing is repaired in the database.

```bash
supabase db query --linked --file supabase/migrations/2026_10_13_12_copy_rpcs.sql
```

```bash
supabase db query --linked --file supabase/audits/2026_10_13_12_copy_rpcs.audit.sql
```

Lines 2 to 5 read `yes`, and line 8 lists `copy_sessions(uuid[], uuid); duplicate_program(uuid, uuid, text); duplicate_session(uuid, text); duplicate_week(uuid, uuid, text)`.

The check of the page must fail with `check only, nothing was written: in place: a coach duplicates a session, a phase and a block and copies sessions to another athlete in one request each, a copy holds the targets and nothing that was trained, and an athlete does not`.

When line 11 or 12 was not `0`: the lists of the page's sections "Sessions without an exercise" and "Exercises without a set", for the coach. When line 13 was not `0`: the list of "Exercises of another coach's library", which says for which athletes a copy leaves exercises out.

### Step 4 — migration 13: the missing sets of a session, and a phone that changes hands

Page: [runbook/migrations/13-ensure-claim-rpcs.md](runbook/migrations/13-ensure-claim-rpcs.md). Rollback at hand: `supabase/rollbacks/2026_10_13_13_ensure_claim_rpcs.down.sql`. It drops the two functions and writes no row: the sets that were added stay, and a device stays with the account it was registered for last.

```bash
supabase db query --linked --file supabase/audits/2026_10_13_13_ensure_claim_rpcs.audit.sql
```

Clean: lines 2 and 3 read `no`, lines 4 to 8 `none`. Lines 9 and 10 are numbers.

- **Stops**: **line 4 is not `none`**, or line 2 or 3 reads `yes` while the ledger does not have the migration; line 5, 6, 7 or 8 is not `none`.
- **Noted**: line 9 — exercises of a session in progress that miss a set: they are added when the athlete opens the session. Line 10 — the devices registered for notifications; the page's section "Devices registered for notifications" shows an account that has none, and a coach without one is told of nothing on any device.

```bash
supabase db query --linked --file supabase/migrations/2026_10_13_13_ensure_claim_rpcs.sql
```

```bash
supabase db query --linked --file supabase/audits/2026_10_13_13_ensure_claim_rpcs.audit.sql
```

Lines 2 and 3 read `yes`, and lines 6 and 7 both list `claim_push_subscription(text, text, text, text); ensure_set_logs(uuid)`. Line 7 is meant: unlike the functions of 11 and 12, these two run as their owner.

The check of the page must fail with `check only, nothing was written: in place: the missing sets of a session are added for its athlete and for nobody else, and a device moves to the account that presents its keys and to no other`.

### Step 5 — migration 14: nothing without a session, rows and nothing else for a signed-in user

Page: [runbook/migrations/14-table-grants-lockdown.md](runbook/migrations/14-table-grants-lockdown.md). Rollback at hand: `supabase/rollbacks/2026_10_13_14_table_grants_lockdown.down.sql`. **It reopens the finding**: it gives a request without a session and a signed-in user every privilege on every table again. Run it when line 7 of the second audit of this step names a table it did not name before, or on a `permission denied for table …` in the second check of step 7 or in step 8, and report the name of the table. The first check of step 7 is meant to answer with that message: there it is the fix, not a reason to roll back.

```bash
supabase db query --linked --file supabase/audits/2026_10_13_14_table_grants_lockdown.audit.sql
```

Clean is the "before" column of the page's table: line 2 reads `20`; lines 3, 4, 5, 7 and 9 to 12 read `none`; lines 6 and 8 — the finding — `all 20`.

- **Stops**: **line 4 is not `none`** — a table `postgres` does not own, and the migration refuses to run.
- **Noted, and reported with the names**: line 2 not `20`, or a name on line 3 — a table, a view or a sequence the repository does not know; the migration treats it like the others, and a view needs a look afterwards. A name on line 5 — a table without row-level security, which every signed-in user reads and writes in full, before and after. Another count on line 6 or 8; a name on line 7, 9, 10, 11 or 12; whatever lines 13 to 15 read.

```bash
supabase db query --linked --file supabase/migrations/2026_10_13_14_table_grants_lockdown.sql
```

```bash
supabase db query --linked --file supabase/audits/2026_10_13_14_table_grants_lockdown.audit.sql
```

Lines 6 and 8 read `none`, line 13 `authenticated: DELETE, INSERT, SELECT, UPDATE; postgres: everything; service_role: everything`, line 14 `authenticated: USAGE; postgres: everything; service_role: everything`. **Line 7 must read what it read before, `none`**: a name that was not there is a table the app can no longer read or write — roll back.

### Step 6 — the ledger

```bash
supabase db query --linked "select name, applied_at from app_private.app_migrations order by applied_at, name"
```

Fourteen rows, in the order of their numbers, the last one `2026_10_13_14_table_grants_lockdown`. Production now has every `required` migration of wave 1.

### Step 7 — the refusal, and the way through, from the CLI

One table, read as a request without a session reads it:

```bash
supabase db query --linked 'do $check$ begin set local role anon; perform 1 from public.profiles limit 1; end $check$'
```

It must **fail** with `permission denied for table profiles`. That failure is the fix.

Then the check of Checkpoint A1 once more — every table of the app, opened as a signed-in user:

```bash
supabase db query --linked 'do $check$
declare t record;
begin
  set local role authenticated;
  for t in select tablename from pg_tables where schemaname = $s$public$s$ order by 1 loop
    execute format($q$select 1 from public.%I limit 0$q$, t.tablename);
  end loop;
end $check$'
```

It must **not** fail. `permission denied for table …` names a table a signed-in user can no longer read: roll back, and report the name.

### Step 8 — the app that is deployed, as an athlete and as the coach

As an athlete: the training list shows the current block; open the next session, tick a set, then untick it; open Messages.

As the coach: the roster shows every athlete; open an athlete, then a session of their program; open Messages.

With both open at once: send a message as the coach. It appears on the athlete's screen without reloading — live updates read the table as the signed-in user, too.

A problem looks like this: a list that should hold something is empty or shows an error, or a red message *You don't have permission to do that.* In the browser's developer tools (Network), the failed request answers `permission denied for table <name>`. Any of these: roll back, and report the name of the table.

### Step 9 — the app of wave 1 may be published

With fourteen rows in the ledger, the app of wave 1 may replace the one that is deployed. It is the first publication since the review began. It brings the stats, the records and the *Last time* hint that read every row instead of the first thousand, the coach's editor that locks what an athlete trained, the review that asks for a confirmation, the reviewed session shown as locked to its athlete, and a confirmation that a replay no longer overwrites. It calls none of the nine functions of migrations 11 to 13.

**Which commit: the head of wave 1, and no later one.** It is the commit this section was written in. It is found by its whole subject, because a later commit may begin with the same words — the one that records these checkpoints as done, for instance:

```bash
git log -1 --format='%H %s' --grep='^docs(runbook): Checkpoints A1 to A3 as sequences that can be pasted, and A0 recorded as done$'
```

**Done**: `fc7a552`, run 38354023259 (2026-10-13) — the record is at the top of this section. The last commit of wave 1 that changes the app or the SQL is `8fef5f2`; what follows it, up to that head, changes documents, tests, and how the database suite starts its server and ends its run — nothing that is published or applied. Two of those commits are why the gate of this first publication can be believed: before them `npm run test:db` ended with status 0 whatever its tests said, so its job could not go red, and about one run in two reported a file as failed for a reason that was no test. A commit after the head belongs to wave 2 — also the one that records a checkpoint as done in the table above. Such a commit is published at Checkpoint B and not before, even on a day when the deploy would let it through: a wave is deployable at its head, not half-way.

With that commit checked out, ask the question the deploy will ask ([runbook/40-deploy.md](runbook/40-deploy.md), section 2). The script reads the list of migrations from the checkout it runs in: on a later commit it asks for the migrations of wave 2 as well, and reports them `MISSING`.

```bash
node --env-file=.env scripts/check-migrations.mjs --verify
```

`OK: production has all 14 required migrations of this commit. The deploy can go on.` is the only ending after which it is pushed.

Publishing is a push of that commit to `main`. It is yours, or asked of Claude in so many words: it is not part of what was agreed for the checkpoints ([Who runs a checkpoint](#who-runs-a-checkpoint)). It is also the first time anything of this branch reaches GitHub, so the [First-push checklist](#first-push-checklist) goes with it — the two repository secrets first.

### Step 10 — what to pass on

- the four new ledger rows, with their dates;
- the numbers that were noted: lines 10 to 13 of the audit of 11, 11 to 13 of 12, 9 and 10 of 13, and lines 2, 3 and 5 of 14 if they were not `20`, `none` and `none`;
- any line that was not what its step calls clean, and the message of any check that did not answer as written;
- whether the app was published, and from which commit.

### Optional — `send-push` with its new gate

Not done at this checkpoint: deploying a function is asked each time, and it was not asked. Its deploy, with the version of wave 2, is step 7 of Checkpoint B, after migrations 15 and 16 and before migration 19.

## Checkpoint B — one way out for every push, the rest push that rings, 72 hours of grace, retention, pg_cron, and the app of wave 2

**Done on 2026-10-15**, by Claude under your standing answer and your go of that day; the rotation of the shared secret the next evening, on your word of 2026-10-16. The section stays as it was run.

| Step | What it gave |
|---|---|
| 1 — the backup | `sl_app-20261015T214710Z…`, 25 tables and 12,933 rows, every checksum matches, `OK`. Nobody was training: the last set was logged at 17:20 UTC, no rest push in the last 30 minutes |
| 2 — migration 15 | every audit line as the page's "before", then its "after" column; line 8 `10` devices, line 9 `0`, line 10 `set`, line 11 `app_service_role_key`; a message of the coach to the test athlete pushed through `send_push_event` by the `send-push` of before: `200 {"delivered":4}` |
| 3 — migration 16 | lines 12 to 17 before: `canceled 667, pending 1137, sent 1481`, `1137` left waiting (976 of them taken back by their athlete), the oldest due on 2026-05-11, `0` running, `3134` older than 7 days — six athletes' rows, listed by role only; after: `canceled 1643, expired 161, sent 1481`, `0` waiting; the check `in place, mode edge`; a rest of 30 s scheduled as the app of wave 1 does, sent 0.8 s after its time by the `dispatch-rest-push` of before |
| 4 — migration 17 | line 10 `8 being trained, 20 not active, 0 drafts`, line 11 `6` in the trash, lines 12 to 15 `0` |
| 5 — migration 18 | lines 7 to 15 the same before, after and after the check: rest pushes `3286`, `3134` of them for a run to delete, `0` kept; notifications `388`, `369` read, `153` for a run to delete, `2` unread and older than 90 days, kept; client errors `56`, `9` for a run to delete |
| 6 — the ledger | eighteen rows; 15 at 21:47:34, 16 at 21:48:21, 17 at 21:49:29, 18 at 21:49:36 UTC |
| 7 — `send-push` | before: `no bearer: 401 Unauthorized`, the version of 2026-05-12; deployed with `supabase functions deploy send-push --use-api` (CLI 2.109.1); after: `no bearer: 401 send-push: unauthorized` |
| 8 — `dispatch-rest-push` | `no credentials: 401 dispatch-rest-push: unauthorized`; rests of three and five minutes scheduled as the app of wave 1 does: both sent, 0.8 s after their time — before wave 2 a rest of 150 s or more never rang. Not looked at on a phone |
| 9 — pg_cron, then migration 19 | the version of `send-push` seen without the rotation, the extension switched on by SQL — both said in the step; `bearer: 200 {"delivered":0}`, `rest push: 400 send-push: schedule_id is not a uuid`; `pg_cron 1.6.4`; audit 19 before: line 11 `none`, lines 14 and 15 `0`, line 17 `4 requests, 0 of them failed`; migration 19 at 21:56:57 UTC, nineteen rows; the four jobs, `schedule_rest_push` answering `mode cron`; a minute later `sl-rest-push: succeeded 5 s ago`; a rest of a minute handed over once by the job, sent 0.9 s after its time, and not sent again by the function |
| 10 — the publication | `check-migrations.mjs --verify` on `2bb6495`: `OK: production has all 18 required migrations of this commit`; `fc7a552..2bb6495` pushed to `main` at about 21:59 UTC; run 38813898109, the five jobs green: `found 0 vulnerabilities`, lint 16 warnings, 172 files and 3415 tests with none skipped, `30 passed (30)` and `1173 passed (1173)`, `deno check` green, `adopted the 47 files that were published without a record, as the build 00000000000000`, `pruned nothing: 2 builds published, 3 are kept`; `version.json` `{"build":"20261015220232","minBuild":null}`; `SMOKE OK` as the coach and as the test athlete. The nightly backup on GitHub ran green on 2026-10-14 and 2026-10-15 (runs 38531178558 and 38699961225) |
| 11 — on a phone | not done: the looks need you and the phone. They are carried to Checkpoint C1, step 11. The test notifications of the sitting — three chat messages and five *Rest done*, each *Test technique … — à ignorer* — reached the phone, you said on 2026-10-16 |
| the morning after | looked at on 2026-10-16 at 21:05 UTC: `sl-retention` and `sl-cron-history` `succeeded 17 h ago`, `sl-push-failures` `succeeded 56 min ago`, `sl-rest-push` every ten seconds; the first night deleted 3,134 rest pushes, 153 notifications and 9 client errors; audit 19 line 17 `13 requests, 0 of them failed`; no `DATABASE` line in the coach's list |
| the rotation | 2026-10-16 at 21:10 UTC, [30, section 4](runbook/30-edge-functions.md), in one shell, the value never printed: the check of section 3 at the first try, the vault holds the value of the shell; the old value — the project's legacy service-role key — no longer opens `send-push`; afterwards a message and a rest of 30 s were delivered |
| noted | the look at Realtime missed the live event at its first try after a quiet period, at the sitting and again on 2026-10-16, then got it in under a second — given to [BACKLOG.md](BACKLOG.md) as `realtime-cold-start` |

Four migrations, two functions, one choice, and the publication. What they close:

| | Finding | What is true today |
|---|---|---|
| 15 | P35, B3, L25 | eleven functions each carry their own copy of the request that hands a push to `send-push`, with no time limit: a push is lost whenever the function is slow to answer, and nothing says so; any account can register any address as a device, and the functions then call it |
| 16 | P10, B14 | a rest of 150 seconds or more never rings on a locked phone; every rest push that was not sent stays `pending` for ever; the time of a rest is the phone's |
| 17 | P55 | a workout logged without a connection is lost when the coach activates the next block before the phone is back online |
| 18 | L27 | nothing ever deletes an old rest push, a notification read long ago or an old client error |
| 19, optional | P10, L27, P35 | nothing in the database runs on a timer |
| `send-push`, `dispatch-rest-push` | P35, P10 | a push that failed leaves no trace and a message waits four weeks for an offline phone; the rest push waits inside one request, which the platform ends after 150 seconds |

For the app that is deployed, nothing changes on a screen until the publication. **What to tell the coach** once migration 17 is in: for three days after *Set active* on another block, sets and a confirmation of the block that was switched off may still arrive — from a phone that was offline — and show up as a session to review, with its line in the bell.

**The order is fixed** — it is the order of the steps, and each page says why: migrations 15 to 18; then `send-push`, then `dispatch-rest-push` (they ask the database for `claim_rest_push`, which migration 16 creates: deployed before it, `dispatch-rest-push` sends nothing); then pg_cron and migration 19 (never before the two functions of wave 2: the job hands a rest push over ten seconds early, and the `send-push` of today would ring every device of the athlete at once, ten seconds early — and the function the app called would ring them again at the time); then the publication.

How each step of a migration reads is what it was at A2 and A3: line 1 of every audit is `running as` and reads `postgres` — anything else stops the checkpoint; clean is the "before" column of the table on the migration's page; the step names the lines that stop the sequence and the ones that are only noted; the check of a page is step 3 of its *After*, one pasted command too long to repeat here, which a test runs from the page. Its answer starts with `check only`: `NOT PROTECTED` or `BROKEN` means roll that migration back and report; `NOT THERE` after the migration, `NOT TRIED`, or a message that does not start with `check only` means stop and report. When the lines a migration changes already read as its "after" column, it is in the database: read the ledger ([How to run a file](#how-to-run-a-file)) and, if its row is there, go on with the next step.

### Step 1 — the right project, and a backup

```bash
supabase db query --linked "select current_user, current_database(), version()"
```

One row, `postgres | postgres | PostgreSQL 17.…`. If the first column is not `postgres`, stop.

```bash
node --env-file=.env scripts/backup/dump.mjs
```

```bash
node --env-file=.env scripts/backup/verify.mjs
```

`read back … every checksum matches`, then `OK`. A `FAILED:` ends the sitting. This backup is also the one that holds what the first night of pg_cron deletes (step 9): nothing is deleted by the migrations themselves.

### Step 2 — migration 15: every push leaves through one function, with a time limit

Page: [runbook/migrations/15-push-plumbing.md](runbook/migrations/15-push-plumbing.md). Rollback at hand: `supabase/rollbacks/2026_10_13_15_push_plumbing.down.sql`. **It reopens the findings** — a push is lost again whenever `send-push` is slow to answer, and any address can be registered as a device — and touches no row. Run it only when the check answers `NOT PROTECTED`, `BROKEN` or names `net.http_post`, or when a push that used to arrive no longer does. It refuses to run while the vault holds the bearer as `app_internal_bearer` only: nothing at this checkpoint renames it.

```bash
supabase db query --linked --file supabase/audits/2026_10_13_15_push_plumbing.audit.sql
```

Clean: line 2 reads `no`; line 3 lists the eleven functions — `adopt_skip, adopt_swap, approve_program, decline_promote_request, notify_coach_on_program_submit, notify_coach_on_promote_request, notify_coach_on_session_confirm, notify_coach_on_slot_deviation, notify_recipient_on_chat_message, notify_student_on_session_feedback, send_back_program`; lines 4 and 5 `none`; line 6 `no such function`; line 7 `no`; line 9 `0`; line 10 `set`; line 11 `app_service_role_key`; line 12 `yes`. Line 8 is a number: the devices registered today — 10 at Checkpoint A3.

- **Stops**: line 3 lists another function, or lacks one; line 4 or 5 is not `none`; line 7 reads `yes`; line 12 reads `no` — the migration refuses to run on all of these; line 11 reads `app_internal_bearer, and app_service_role_key with ANOTHER value` — only one of the two values can be the function's secret; line 11 reads `app_internal_bearer, and app_service_role_key with the same value` — the rotation of [30, section 4](runbook/30-edge-functions.md), which step 9 runs, writes `app_service_role_key` only, while `send_push_event` reads `app_internal_bearer` first: after it every push would be refused. The leftover name is deleted by its owner before the sitting goes on.
- **Line 9 decides.** `0` is clean. Otherwise it gives a number and the hosts of the devices the rule would refuse, and the list of the page's section "Devices whose endpoint is not at a known push service" shows them — read-only, by host, never by address:

  ```bash
  supabase db query --linked "select pr.role, pr.full_name as account, coalesce(nullif(substring(ps.endpoint from '^[A-Za-z][A-Za-z0-9+.-]*://([^/?#]*)'), ''), 'not a URL') as host, ps.user_agent, ps.created_at::date as registered, ps.last_seen_at::date as last_seen, ps.id from public.push_subscriptions ps join public.profiles pr on pr.id = ps.user_id where not (ps.endpoint ~ '^https://(fcm[.]googleapis[.]com|updates[.]push[.]services[.]mozilla[.]com|[a-z0-9.-]+[.]push[.]apple[.]com|[a-z0-9.-]+[.]notify[.]windows[.]com)/') order by 1, 2, 3"
  ```

  A host that is the push service of a real browser stops the checkpoint: the list of push services is one short, and that is a change of the repository, made in four places together. A row that is no device (an address made up for a test, `localhost`, something that is not a URL) does not stop it: the migration leaves the row, and deleting it afterwards is a statement that deletes a row of the app — asked first.
- **Noted**: line 8; line 10 or 11 reading `MISSING: no push is sent` — the database sends no notification today and will send none afterwards, until the secrets are set ([30, section 2](runbook/30-edge-functions.md)).

```bash
supabase db query --linked --file supabase/migrations/2026_10_13_15_push_plumbing.sql
```

```bash
supabase db query --linked --file supabase/audits/2026_10_13_15_push_plumbing.audit.sql
```

Lines 2 to 4, 6 and 7 read as the "after" column: `yes`; `send_push_event`; the eleven; `postgres, service_role`; `yes` — or `yes, for new and changed rows only (NOT validated)` when line 9 was not `0`. Lines 8 to 12 are what they were.

The check of the page must fail with `check only, nothing was written: in place: send_push_event queues a notification for the owner of the database and is refused to a signed-in user, and a device is registered at a push service and nowhere else`. `… in place, and NOT CONFIGURED: …` says the same with a vault that lacks the address or the bearer, as lines 10 and 11 said: noted, not a stop. A message that names `net.http_post` means roll back.

In the app, on the test athlete's phone with notifications on and the phone locked: a message from the coach's account arrives as a notification, as before. It is the one thing no query shows. When Claude runs the checkpoint it sends the message and asks you whether the phone showed it.

### Step 3 — migration 16: the end of a rest is scheduled by the database, and sent once

Page: [runbook/migrations/16-rest-push-scheduling.md](runbook/migrations/16-rest-push-scheduling.md). Rollback at hand: `supabase/rollbacks/2026_10_13_16_rest_push_scheduling.down.sql`. Run it only when the check answers `NOT PROTECTED` or `BROKEN`, and **not once the Edge Functions of wave 2 are deployed** unless the ones from before are deployed again first: they ask the database for `claim_rest_push` before they send. It deletes no row; the rows the migration closed stay closed, and a row `expired` or `sending` becomes `failed`.

```bash
supabase db query --linked --file supabase/audits/2026_10_13_16_rest_push_scheduling.audit.sql
```

Clean: line 2 reads `no`; lines 3 to 7 `none`; line 8 `canceled, failed, pending, sent`; lines 9 and 10 `no`; line 11 `yes`.

- **Stops**: line 3 is not `none` — a function of one of the four names exists, and the migration refuses to run next to it; line 4, 5, 6 or 7 is not `none`; line 8 is another list; line 11 reads `no`.
- **Noted**: lines 12 to 17 — the rest pushes by status, how many have been waiting since the request that was to send them ended (13; on 2026-10-11 the table held 3,206 rows), how many of those their athlete had taken back (14), the oldest (15), the rests that are running (16), the rows older than 7 days (17). None of them stops the migration, which closes the rows of line 13. Line 18 says who sends a rest push today.

For the record, one line per account of what was left waiting, read-only:

```bash
supabase db query --linked "select pr.role, pr.full_name as account, count(*) as left_waiting, count(*) filter (where sp.canceled_at is not null) as taken_back, min(sp.fire_at)::date as oldest, max(sp.fire_at)::date as latest from public.scheduled_pushes sp join public.profiles pr on pr.id = sp.user_id where sp.status = 'pending' and sp.fire_at <= now() - interval '60 seconds' group by pr.id, pr.role, pr.full_name order by 3 desc, 2"
```

```bash
supabase db query --linked --file supabase/migrations/2026_10_13_16_rest_push_scheduling.sql
```

It holds the table of the rest pushes for an instant: a rest that starts in that instant waits for it.

```bash
supabase db query --linked --file supabase/audits/2026_10_13_16_rest_push_scheduling.audit.sql
```

Lines 2, 5, 6, 8, 9 and 10 read as the "after" column: `yes`; `cancel_rest_push(uuid); schedule_rest_push(integer, jsonb, text)`; `cancel_rest_push(uuid); dispatch_due_rest_pushes(); schedule_rest_push(integer, jsonb, text)`; `canceled, expired, failed, pending, sending, sent`; `yes`; `yes`. Lines 13 and 14 read `0`, and line 12 shows the rows of line 13 under `expired` and `canceled`.

The check of the page must fail with `check only, nothing was written: in place, mode edge: a rest push is scheduled at the time of the server for a device of its account, taken back by its account only, and handed to a sender once — never after it was taken back, never more than a minute late`. `in place, mode cron` here means a job named `sl-rest-push` was made by hand: stop and report.

In the app, as the test athlete with *Rest end notification* on: a rest of a minute or less, phone locked, rings as before. A rest of three minutes still does not: that comes with step 8.

### Step 4 — migration 17: a block stays open for its athlete for 72 hours after it is switched off

Page: [runbook/migrations/17-replay-grace-window.md](runbook/migrations/17-replay-grace-window.md). Rollback at hand: `supabase/rollbacks/2026_10_13_17_replay_grace_window.down.sql`. **It reopens P55 and closes every open window at once**: what is waiting on a phone for a block switched off in the last three days is refused when it arrives. Run it only when the check answers `NOT PROTECTED` or `BROKEN`.

```bash
supabase db query --linked --file supabase/audits/2026_10_13_17_replay_grace_window.audit.sql
```

Clean: line 2 reads `while it is the active one`; lines 3 and 4 `no`; lines 5, 6 and 9 `none`; lines 7 and 8 `program_active_for_session(uuid)`; lines 12 to 15 `0`.

- **Stops**: line 2 starts with `SOMETHING ELSE:` or `NOT THERE:` — the rule on when an athlete writes in a block is not the one the migration was written for, and it refuses to replace it; line 5 is not `none`; line 6 or 9 is not `none`, or line 7 or 8 is not what it should be.
- **Noted**: lines 10 and 11 — the blocks out of the trash (`N being trained, M not active, K drafts`) and in it.

```bash
supabase db query --linked --file supabase/migrations/2026_10_13_17_replay_grace_window.sql
```

```bash
supabase db query --linked --file supabase/audits/2026_10_13_17_replay_grace_window.audit.sql
```

Lines 2, 3, 4 and 8 read as the "after" column: `while it is the active one, and for 72 hours after it was switched off`; `yes`; `yes`; `program_active_for_session(uuid); stamp_program_deactivated_at()`. Lines 12 to 15 still read `0`, lines 10 and 11 are the numbers they were. A block switched off before the migration has no window.

The check of the page must fail with `check only, nothing was written: in place: a block says when it was switched off, by the two requests of the app and by activate_program alike; its athlete writes in it for 72 hours, no longer, and never once it is in the trash; a signed-in user does not write that time`.

Nothing to look at in the app: every screen is what it was.

### Step 5 — migration 18: the rows nobody reads any more are deleted by one function

Page: [runbook/migrations/18-retention.md](runbook/migrations/18-retention.md). Rollback at hand: `supabase/rollbacks/2026_10_13_18_retention.down.sql`. It drops the function and nothing else, and is refused once migration 19 is in the ledger. Run it only when the check answers `NOT PROTECTED` or `BROKEN` — and then do not run the function.

```bash
supabase db query --linked --file supabase/audits/2026_10_13_18_retention.audit.sql
```

Clean: line 2 reads `no`; line 3 `none`; lines 4 to 6 `it is not there`; line 10 `0`.

- **Stops**: line 3 is not `none`; line 4, 5 or 6 reads something else while line 2 reads `no`.
- **Noted**: lines 7 to 15, the rows of the three tables. Lines 8, 12 and 15 are what a run of the function deletes — the first night of pg_cron, at step 9 — and line 8 is nearly the whole table of rest pushes. Line 10 not `0`: the page's section "A rest push that is kept". Line 16 says who runs it.

```bash
supabase db query --linked --file supabase/migrations/2026_10_13_18_retention.sql
```

```bash
supabase db query --linked --file supabase/audits/2026_10_13_18_retention.audit.sql
```

Lines 2, 4, 5 and 6 read as the "after" column: `yes`, `service_role`, `its caller`, `public, pg_temp`. **Lines 7 to 15 are the numbers of the first audit**: the migration deletes no row.

The check of the page must fail with `check only, nothing was written: in place: a run deletes the rest pushes older than 7 days, the notifications read more than 90 days ago and the client errors older than 90 days; it keeps what is more recent, a rest push that is still to be sent and a notification that was never read; a signed-in user cannot run it`. It runs the function for real and undoes it: the audit once more, and lines 7 to 15 still read the numbers of the first audit.

**The first run of the function is not a step of this checkpoint.** With pg_cron (step 9) it is the job's, the first night at 03:17 UTC. Without it, it is the monthly routine of [runbook/70-admin-procedures.md](runbook/70-admin-procedures.md), "Once a month: delete what nobody reads any more", and each run is asked first.

### Step 6 — the ledger

```bash
supabase db query --linked "select name, applied_at from app_private.app_migrations order by applied_at, name"
```

Eighteen rows, in the order of their numbers, the last one `2026_10_13_18_retention`. Production has every `required` migration of wave 2.

### Step 7 — `send-push` of wave 2

Page: [runbook/30-edge-functions.md](runbook/30-edge-functions.md), sections 1 and 3; going back is its section "Undo". From the root of the main checkout — it holds the `.env` the check reads — on the branch that carries this page.

First the check as it stands, to record which version production runs. One request that shows nothing; it writes nothing and sends no notification:

```bash
node --env-file=.env --input-type=module -e '
const url = new URL("/functions/v1/send-push", process.env.VITE_SUPABASE_URL);
const bearer = process.env.INTERNAL_BEARER;
const ask = async (headers, more = {}) => {
  const body = JSON.stringify({ user_id: "00000000-0000-0000-0000-000000000000", payload: { title: "deploy check" }, ...more });
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  return `${res.status} ${(await res.text()).replace(/\s+/g, " ").trim().slice(0, 120)}`;
};
const closed = await ask({});
console.log(`no bearer: ${closed}`);
if (closed !== "401 send-push: unauthorized") process.exit(1);
if (!bearer) {
  console.log("bearer: not sent, INTERNAL_BEARER is not set in this shell");
  process.exit(0);
}
const open = await ask({ authorization: `Bearer ${bearer}` });
console.log(`bearer: ${open}`);
if (open !== `200 {"delivered":0}`) process.exit(1);
const rest = await ask({ authorization: `Bearer ${bearer}` }, { schedule_id: "deploy check", not_before: "deploy check" });
console.log(`rest push: ${rest}`);
if (rest !== "400 send-push: schedule_id is not a uuid") process.exit(1);
'
```

`no bearer: 401 Unauthorized` is the version of 2026-05-12 (v4) — what is expected, since the optional deploy of Checkpoint A3 was not made. `no bearer: 401 send-push: unauthorized` is the gate of wave 1, deployed by somebody since. Either way, go on; anything else, the page explains it.

```bash
supabase functions deploy send-push --use-api
```

No `--no-verify-jwt`: `supabase/config.toml` carries the flag.

```bash
node --env-file=.env --input-type=module -e '
const url = new URL("/functions/v1/send-push", process.env.VITE_SUPABASE_URL);
const bearer = process.env.INTERNAL_BEARER;
const ask = async (headers, more = {}) => {
  const body = JSON.stringify({ user_id: "00000000-0000-0000-0000-000000000000", payload: { title: "deploy check" }, ...more });
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  return `${res.status} ${(await res.text()).replace(/\s+/g, " ").trim().slice(0, 120)}`;
};
const closed = await ask({});
console.log(`no bearer: ${closed}`);
if (closed !== "401 send-push: unauthorized") process.exit(1);
if (!bearer) {
  console.log("bearer: not sent, INTERNAL_BEARER is not set in this shell");
  process.exit(0);
}
const open = await ask({ authorization: `Bearer ${bearer}` });
console.log(`bearer: ${open}`);
if (open !== `200 {"delivered":0}`) process.exit(1);
const rest = await ask({ authorization: `Bearer ${bearer}` }, { schedule_id: "deploy check", not_before: "deploy check" });
console.log(`rest push: ${rest}`);
if (rest !== "400 send-push: schedule_id is not a uuid") process.exit(1);
'
```

Its first line must now read `no bearer: 401 send-push: unauthorized`: the function itself refused, so the gateway let the request through. JSON after the `401` is finding B18 — the gateway checks JWTs in front of the function and no push of the database gets through: deploy again with the same command, and if the line does not change, stop and report.

### Step 8 — `dispatch-rest-push` of wave 2

Same page, same sections. Only now: migration 16 is in the ledger (step 6), and the function asks it for `claim_rest_push`.

```bash
supabase functions deploy dispatch-rest-push --use-api
```

```bash
node --env-file=.env --input-type=module -e '
const url = new URL("/functions/v1/dispatch-rest-push", process.env.VITE_SUPABASE_URL);
const body = JSON.stringify({ scheduleId: "00000000-0000-0000-0000-000000000000" });
const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
const said = `${res.status} ${(await res.text()).replace(/\s+/g, " ").trim().slice(0, 120)}`;
console.log(`no credentials: ${said}`);
if (said !== "401 dispatch-rest-push: unauthorized") process.exit(1);
'
```

It must print `no credentials: 401 dispatch-rest-push: unauthorized`. JSON after the `401` means the gateway still checks JWTs in front of the function: a rest of a minute rings and no longer one does. Deploy again; if the line does not change, stop and report.

**On the test athlete's phone** — *Rest end notification* on, the phone locked: a rest of **three minutes**, then one of **five**. One notification each, at the end of the rest. These two are the proof: a rest of a minute is one request and proves nothing, and nothing in the repository can stand in for them — they are the only test of the function calling itself at its real address. While the phone is locked the function's log (Dashboard → Edge Functions → `dispatch-rest-push` → Logs, section 5 of the page) writes one line a minute, `hop 1, hands over in 60 s …` down to `sent to 1 device`; when nothing arrives, the line there says which hop did not take over.

### Step 9 — Optional — pg_cron, then migration 19

**The choice, in plain words.** pg_cron is an extension of the database: it runs a statement at given times, with nothing outside the database involved. This app has three uses for it, and each of them works without it:

- **The notification at the end of a rest.** Without pg_cron the app asks `dispatch-rest-push` to wait until the rest is over, and the function hands the wait over to a copy of itself every minute: a rest of three minutes is three requests. If one hand-over is lost, that rest does not ring, and nothing tries again. With pg_cron the database looks every ten seconds at the rests that are about to end and hands each one to `send-push`: one step, whatever the length of the rest.
- **The rows nobody reads any more.** Without it, you delete them once a month with one statement (page 70) — or they wait, which breaks nothing. With it, the database does it every night.
- **A push that could not be sent.** Without it, it is a line in the log of the function, for whoever goes and looks. With it, one line an hour in the list of errors at the bottom of the coach's roster.

What it costs: one short query every ten seconds, day and night, which nobody can notice; three days of the runs pg_cron remembers (a job deletes the older ones); and **old rows are deleted without a question from the first night on** — nearly every rest push there is, the notifications read more than 90 days ago, the client errors older than 90 days. They do not come back, and the backup of step 1 is the one that holds them. Turning it off later is the rollback of migration 19, then — if you want — the switch in the dashboard ([50 — Turning it off](runbook/50-pg-cron.md#turning-it-off)).

The recommendation was to switch it on, and on 2026-10-15 you said yes. To stay without it: skip this step — the deploy does not ask for migration 19, and everything before this step is complete without it. Page [runbook/50-pg-cron.md](runbook/50-pg-cron.md) is the whole decision, with the jobs, how to look at them and how to pause one.

**First, which `send-push` answers.** Nothing in the database can tell, and the job must never run next to the version from before wave 2. Seeing it takes the secret in the shell, so it is done with the rotation of `INTERNAL_BEARER` ([30, section 4](runbook/30-edge-functions.md)) — due once anyway if the value in use is the project's service-role key or was ever pasted anywhere. At an hour when nobody trains: between the second and the third command the two places disagree, and a push sent in that moment is refused (its bell row is written all the same).

```bash
export INTERNAL_BEARER="$(openssl rand -hex 32)"
```

```bash
supabase secrets set INTERNAL_BEARER="$INTERNAL_BEARER"
```

```bash
supabase db query --linked "select vault.update_secret(id, '$INTERNAL_BEARER') from vault.secrets where name = 'app_service_role_key'"
```

```bash
node --env-file=.env --input-type=module -e '
const url = new URL("/functions/v1/send-push", process.env.VITE_SUPABASE_URL);
const bearer = process.env.INTERNAL_BEARER;
const ask = async (headers, more = {}) => {
  const body = JSON.stringify({ user_id: "00000000-0000-0000-0000-000000000000", payload: { title: "deploy check" }, ...more });
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  return `${res.status} ${(await res.text()).replace(/\s+/g, " ").trim().slice(0, 120)}`;
};
const closed = await ask({});
console.log(`no bearer: ${closed}`);
if (closed !== "401 send-push: unauthorized") process.exit(1);
if (!bearer) {
  console.log("bearer: not sent, INTERNAL_BEARER is not set in this shell");
  process.exit(0);
}
const open = await ask({ authorization: `Bearer ${bearer}` });
console.log(`bearer: ${open}`);
if (open !== `200 {"delivered":0}`) process.exit(1);
const rest = await ask({ authorization: `Bearer ${bearer}` }, { schedule_id: "deploy check", not_before: "deploy check" });
console.log(`rest push: ${rest}`);
if (rest !== "400 send-push: schedule_id is not a uuid") process.exit(1);
'
```

Three lines now: `no bearer: 401 send-push: unauthorized`, `bearer: 200 {"delivered":0}` and **`rest push: 400 send-push: schedule_id is not a uuid`** — the version of wave 2. `rest push: 200 {"delivered":0}` is the `send-push` from before wave 2: deploy it again (step 7), and do not apply migration 19. `bearer: 401 send-push: unauthorized`: wait half a minute after `secrets set` and run the check again; if it stays, run the rotation again from its first command.

```bash
supabase db query --linked "select decrypted_secret = '$INTERNAL_BEARER' as vault_holds_the_value_of_this_shell from vault.decrypted_secrets where name = 'app_service_role_key'"
```

One row, `true`. Then:

```bash
unset INTERNAL_BEARER
```

**At the sitting of 2026-10-15 this was done otherwise**, and it is the record: the commands of the rotation were not run, because your go did not name it. The bearer was read from the vault (`app_service_role_key`) into the environment of the check only — never printed — and the check, run once with it, read the three lines of wave 2: the `200` proves that the function's secret and the vault hold one value. The rotation itself came the next evening, under your answer of 2026-10-16 (the table at the top of this section).

**Then what the first night deletes**, lines 8, 12 and 15 — the numbers to pass on:

```bash
supabase db query --linked --file supabase/audits/2026_10_13_18_retention.audit.sql
```

**Then the extension.** Dashboard → Database → Extensions, search for `pg_cron`, switch it on ([50, section 1](runbook/50-pg-cron.md#1-switch-the-extension-on)). It asks for nothing else, and by itself it changes nothing. **At the sitting it was switched on by SQL instead**, as `postgres`: `create extension if not exists pg_cron with schema pg_catalog` — pg_cron is in `supautils.privileged_extensions`, so the platform lets `postgres` create it. The next command, and line 2 of the audit, read `pg_cron 1.6.4` either way.

```bash
supabase db query --linked "select extname, extversion from pg_extension where extname = 'pg_cron'"
```

One row: `pg_cron`, a version 1.5 or later. No row: the extension is not on.

Page of the migration: [runbook/migrations/19-pg-cron-jobs.md](runbook/migrations/19-pg-cron-jobs.md). Rollback at hand: `supabase/rollbacks/2026_10_13_19_pg_cron_jobs.down.sql` — it removes the four jobs and the function and leaves the extension on; a rest the app scheduled while the answer was `mode: cron` and whose time has not come then does not ring (the app of wave 2 does not schedule that way yet: it still calls `dispatch-rest-push` for every rest). It is never refused for a later migration, and it also runs where the extension was switched off first.

```bash
supabase db query --linked --file supabase/audits/2026_10_13_19_pg_cron_jobs.audit.sql
```

Clean, for this migration — the "before" column of its page: line 2 is a version, 1.5 or later; line 3 `yes`; line 4 `no`; lines 5 and 9 `none`; lines 6 to 8 `it is not there`; line 12 `the app, by calling dispatch-rest-push (no job named sl-rest-push is switched on: schedule_rest_push answers mode edge)`; line 13 `there is no job`.

- **Stops**: line 2 reads `not installed` — the extension is not on — or a version before 1.5; line 3 is not `yes`; line 5 or line 9 is not `none` — the migration refuses to run next to a function or a job of its names; line 17 reads `net._http_response cannot be read by this role`.
- **Noted**: line 11, a job somebody made in this project, which the migration leaves alone; line 14, the rests that are running — they ring whatever happens; lines 15 and 16; line 17, what the push requests of the last hours were answered.

```bash
supabase db query --linked --file supabase/migrations/2026_10_13_19_pg_cron_jobs.sql
```

```bash
supabase db query --linked --file supabase/audits/2026_10_13_19_pg_cron_jobs.audit.sql
```

Lines 4, 6 to 10 and 12 read as the "after" column: `yes`; `service_role`; `its caller`; `public, pg_temp`; `sl-cron-history, sl-push-failures, sl-rest-push, sl-retention`; `yes`; `the job sl-rest-push, every ten seconds (schedule_rest_push answers mode cron)`. Line 13 reads `no run yet` four times.

```bash
supabase db query --linked "select name, applied_at from app_private.app_migrations order by applied_at, name"
```

Nineteen rows, the last one `2026_10_13_19_pg_cron_jobs`.

The check of the page must fail with `check only, nothing was written: in place: sl-rest-push hands the rest pushes over every ten seconds and schedule_rest_push answers mode cron; run_retention runs every night; the push requests that failed are written down every hour, by a function a signed-in user cannot run; pg_cron keeps three days of its runs`.

**A minute later, the audit once more — line 13 is the proof that pg_cron runs the jobs:**

```bash
supabase db query --linked --file supabase/audits/2026_10_13_19_pg_cron_jobs.audit.sql
```

`sl-rest-push` reads `succeeded`, a few seconds ago — under 20 seconds whenever you look; the three others read `no run yet` until their hour. `sl-rest-push: failed …`, or still `no run yet` after two minutes: roll back, and report the line.

On the test athlete's phone: a rest of a minute, phone locked, rings **once**, at its end — twice, or ten seconds early, means the `send-push` that answers is the one from before wave 2: roll back at once, then step 7 again. A rest of three minutes rings too.

**The morning after** — not part of the sitting, and part of what is passed on: the audit of migration 18, whose lines 8, 12 and 15 read `0` or a handful, and line 13 of the audit of migration 19, which reads `sl-retention: succeeded`, some hours ago.

### Step 10 — the app of wave 2 may be published

With eighteen rows in the ledger — nineteen with pg_cron — the app of wave 2 may replace the one of wave 1. It brings what the queue of an offline workout needs (it is kept on the device through a kill, an update and two weeks without the app, sent again when it got no answer, never sent without a session, dated at the tap), an app that opens offline and stays signed in, a training list and a next session that open in a gym without a network, a confirmation made offline that shows as done, a push subscription that follows the account signed in on the device, updates that wait until nothing would be lost, a rest timer that comes back after a kill, a video replaced without losing the previous one, chat and bell that survive a lost connection, a Stats page that sends half its requests, and the coach's activate, reorder and copy as one request each — the functions of migrations 11 to 13, which the deploy asks the ledger for.

**Which commit: the head of wave 2, and no later one.** It is the commit this section was written in, found by its whole subject:

```bash
git log -1 --format='%H %s' --grep='^docs(runbook): Checkpoint B as a sequence that can be pasted, and A1 to A3 and the first publication recorded as done$'
```

A commit after it belongs to wave 3 and is published at Checkpoint C1, not before — even on a day when the deploy would let it through.

With that commit checked out, ask the question the deploy will ask ([runbook/40-deploy.md](runbook/40-deploy.md), section 2). The script reads the migrations of the checkout it runs in: on a later commit it would ask for those of wave 3 as well, and report them `MISSING`.

```bash
node --env-file=.env scripts/check-migrations.mjs --verify
```

`OK: production has all 18 required migrations of this commit. The deploy can go on.` is the only ending after which it is pushed. Migration 19 is `optional` and is listed, not asked for.

Publishing is a push of that commit to `main`, as a fast-forward from `fc7a552`: yours, or Claude's under your go of 2026-10-15, which covers this commit and no other. Not while an athlete is in the middle of a session: the app that is deployed reloads its open pages the moment the new worker takes over, whatever they are doing — the last time it does; from the deploy after this one, an update waits for the page.

**Once the run is green**, look at it this once:

- Job `test`: `found 0 vulnerabilities`; lint under its ceiling; the unit suite with no test skipped — the tests of `supabase/functions/runbook.test.js` that look at the history of the repository — two on the first run, three since — skipped there, in a checkout of one commit; the job now takes the whole history.
- Job `db`: `Test Files  30 passed (30)`, `Tests  1173 passed (1173)` at the head of wave 2. The job now runs on `ubuntu-24.04`, not `ubuntu-latest` (first-push checklist, item 3).
- Job `functions`: `deno check` green — and since this commit a red one stops the gate.
- Job `deploy`, step *This build joins the builds that are published*: this once, its log has the line `adopted    the … files that were published without a record, as the build 00000000000000` and `pruned     nothing` — the files of the app that was live are kept, and its open pages go on finding them. On GitHub, the branch `gh-pages` still holds the old files under `assets/` next to the new ones, and has a folder `builds/` with two files. If the old files are gone, the action did not behave as [40, section 8](runbook/40-deploy.md) assumes: say so before the next deploy.
- The published `version.json` (the address of the app, followed by `version.json`; GitHub Pages can take ten minutes to show it) names the build and says `"minBuild":null`. Nothing to set: `MIN_CLIENT_BUILD` stays absent until a change to the database needs the open apps gone.

### Step 11 — on a phone, with the app of wave 2

What no test of the repository can show. On the test athlete's phone (an iPhone with iOS 17 or later, the app installed on the Home Screen) and with the coach's account; everything written is undone in the same step, and nobody is signed out of another device.

1. **A screen opened after the deploy.** With the app left open on the build before, after the deploy, open a screen not opened yet in that session (Stats, Goals): it opens, on the old build or on the new one — never on *Something went wrong*.
2. **Offline from the start.** Open the app once online, switch to airplane mode, close it from the app switcher and open it again: it lands on the training list (as the coach: the roster), with no spinner and no sign-in form. Open the next session — it was read ahead — tick two sets, write a note, and confirm the session: the dialog closes at once, the card says the confirmation is kept on the device, and the list shows the session under *Done*. Back online: the sets and the confirmation arrive once each; the coach sees the session to review; the day of the sets is the day of the taps. Then take the confirmation back and untick the sets.
3. **A sign-out that would lose something.** Still in airplane mode, tick a set, then *Sign out*: a question says that one change has not been sent; *Cancel* keeps everything. Untick the set back online.
4. **The rest timer** — the beep with the ring/silent switch on silent, no music: heard when a short rest ends, with the app open. With music playing in another app and the switch off silent: note what the music does when the rest ends — it may stop for the second of the beep, or stay stopped. If that is not acceptable, the commit "fix(rest-timer): the end-of-rest sound plays with the silent switch on" stands alone and can be reverted. During a rest of two minutes, open another app for a few seconds and come back: the screen stays on until the rest ends. During a rest, open the Camera, close the app from the app switcher and open it again on the same session: the rest is still counting.
5. **A video** on a set the coach marked *Record*, in a session in progress: a clip of 10 MB or more on mobile data shows a ring that fills and *Uploading video… N%*, and plays afterwards; *Replace* then the cross before the end leaves the first clip; airplane mode during a replace gives one message and leaves the first clip; a photo or a clip above 25 MB is refused under the set before anything is sent; an upload started on the last set of an exercise goes on when that set is ticked and its card closes. If every clip fails while the app before uploaded fine, the commit "fix(video): an upload shows its progress, can be cancelled, and fails in one place" can be reverted alone. Delete the clips afterwards.
6. **A shared phone.** Signed in as the coach with *Notifications* on (avatar menu), sign out, sign in as the test athlete: a message sent to the coach from another device no longer shows on this phone. Sign back in as the coach: *Notifications* reads *On* without a tap. If it reads *Enable* on the iPhone, iOS wants a tap for a subscription: tap it once, and say so — the docs then say it too.
7. **Chat and bell on hosted Realtime** — three things the unit tests cannot settle: open the app as the coach in two tabs and send a message from one — it shows in the other without a reload (the `sender_id` filter is accepted; were it refused, the chat would refresh only when the page comes back); delete it — say whether the other tab drops it at once; and a message from the coach reaches the test athlete's open app live, as at A3 (760 ms then).
8. **The offline banner** — airplane mode, open a session and scroll down: the amber banner stays just under the notch.
9. **The coach's editor on the test athlete**: *Set active* on another block and back, reorder the sessions of a phase that holds an archived session, reorder two phases, drag a session across a divider and back, duplicate a session and delete the copy. Each is one request now; the order on screen after a reload is the order that was dropped.
10. **The day and the time of an offline workout.** After look 2, in the review of that session the coach sees the day of the taps; in the SQL editor, read-only, each set's `logged_at` is the time of its tap — not of the reconnect — and the confirmation's `performed_on` is the day of the training.
11. **A quiet *Rest done* with the app in front** (B36). *Rest end notification* on, the app open on the session: a rest of a minute ends with the app's beep, and the *Rest done* the push brings makes no sound and no vibration and leaves the notification centre by itself a few seconds later. With the phone locked, the same rest rings as before.

One count needs no phone: how many requests the app sends when the phone is unlocked during a session — a handful, not the thirteen or so of before wave 2 — is counted by `src/lib/queryClient.cache.test.js`.

The update flow itself (a deploy that finds the app in the middle of a rest, or with a field being typed in) needs a deploy after this one: it is the first look of the next publication — Checkpoint C1, step 11.

### Step 12 — what to pass on

- the five new ledger rows — four without pg_cron — with their dates;
- the numbers that were noted: lines 8 to 11 of the audit of 15 (and the hosts of line 9 if it was not `0`), 12 to 17 of 16 with the list of what was left waiting, 10 and 11 of 17, 7 to 15 of 18, and 11 and 14 to 17 of 19;
- the lines the checks of the two functions printed before and after their deploys, the rotation's `true`, and whether the rests of three and five minutes rang;
- line 13 of the second audit of 19, and the next morning what the first night deleted;
- any line that was not what its step calls clean, and the message of any check that did not answer as written;
- whether the app was published, from which commit, the number of the run, and what step 11 showed.

## Checkpoint C1 — drafts closed to the coach, RPE in half steps, the library a change of coach leaves, indexes, the coach's video files, the coach's two lists, and the app of wave 3

**Ready.** Wave 3 is finished, and it is the last wave of the review: what was to follow is in [BACKLOG.md](BACKLOG.md). Production has migrations 01 to 19 and the app of wave 2 (`2bb6495`, published on 2026-10-15). On 2026-10-17 you said yes to this checkpoint as a whole (*pousse*, and *26 oui* for the optional migration): Claude applies migrations 20 to 25 under the standing answer and 26 under that yes, holds the end-to-end run *after* on the test athlete, and pushes the head of wave 3 to `main`, as a fast-forward from `2bb6495`, once everything before it reads clean ([Who runs a checkpoint](#who-runs-a-checkpoint)). The rule of the index holds: the first step that does not read as written stops the sitting, nothing after it is done, and the output is passed on as it is.

Six migrations, one optional one, and the publication. What they close:

| | Finding | What is true today |
|---|---|---|
| 20 | P53 | a coach's change to an athlete's draft is accepted, then lost at the athlete's next save; a higher *Sets* in a draft leaves sets without reps or load after the approval |
| 21 | L34, B12 | an RPE is a whole number; the weekday of a session may be any number, and the blocks an athlete wrote carry weekdays their builder never offered |
| 22 | B6, L20 | every coach reads every client error of every account, and an account reports errors without end |
| 23 | B8 | after a change of coach, the exercises of the blocks written before it have no name for the athlete and for the new coach |
| 24 | L28, P62, N9 | nine indexes repeat a unique key, eight foreign keys have none, and a deleted session stays named by its feedback message |
| 25 | B7 | a coach reads every file of an athlete's folder in `set-videos`, the files no video names included |
| 26, optional | L18, P9 | the coach's counts of sessions to review and the list of conversations are folded from reads the API cuts at 1000 rows |

For the app that is deployed, four things change on a screen, each said on its page: a coach's change to a draft answers *Couldn't save that. Please try again.* (20); the sessions of a block an athlete wrote show no weekday (21); the coach's list of errors at the bottom of the roster loses the lines of an account that is no longer an athlete of theirs (22); after a change of coach the former coach's exercises have their name again (23). **What to tell the coach** once migration 20 is in: a draft is changed by sending it back, or by approving it first.

**The order is fixed**: 20 to 26, each refused (`SLM02`) without the one before it, then the publication, then the looks on a phone and the end-to-end run, which need the app of wave 3.

How each step reads is what it was at B: line 1 of every audit is `running as` and reads `postgres` — anything else stops the checkpoint; clean is the "before" column of the table on the migration's page; the step names the lines that stop the sequence and the ones that are only noted; the check of a page is step 3 of its *After*, one pasted command too long to repeat here, which a test runs from the page. Its answer starts with `check only`: `NOT PROTECTED` or `BROKEN` means roll that migration back and report — but for 25, whose page says otherwise; `NOT THERE` after the migration, `NOT TRIED` (migration 07 is in production, so a check that cannot make a coach is a surprise), or a message that does not start with `check only` means stop and report. When the lines a migration changes already read as its "after" column, it is in the database: read the ledger ([How to run a file](#how-to-run-a-file)) and, if its row is there, go on with the next step.

### Step 1 — the right project, and a backup

```bash
supabase db query --linked "select current_user, current_database(), version()"
```

One row, `postgres | postgres | PostgreSQL 17.…`. If the first column is not `postgres`, stop.

```bash
node --env-file=.env scripts/backup/dump.mjs
```

```bash
node --env-file=.env scripts/backup/verify.mjs
```

`read back … every checksum matches`, then `OK`. A `FAILED:` ends the sitting. This backup also holds the weekdays migration 21 clears and the session ids migration 24 takes off the feedback messages: neither comes back with a rollback.

### Step 2 — migration 20: the draft an athlete is writing is theirs alone

Page: [runbook/migrations/20-drafts-coach-readonly.md](runbook/migrations/20-drafts-coach-readonly.md). Rollback at hand: `supabase/rollbacks/2026_10_16_20_drafts_coach_readonly.down.sql`. **It reopens P53**: a coach's change to a draft is accepted again, and lost at the next save. Run it only when the check answers `NOT PROTECTED` or `BROKEN`. It writes and deletes no row.

```bash
supabase db query --linked --file supabase/audits/2026_10_16_20_drafts_coach_readonly.audit.sql
```

Clean: line 2 reads `its author, and the coach of its athlete`; line 3 `none`; line 4 `adds the missing sets, then marks the program approved`; lines 5, 6 and 9 `none`; lines 7 and 8 `approve_program(uuid)`. Line 10 is a sentence, `N being written, M sent in`; lines 11 to 15 are numbers.

- **Stops**: line 2 starts with `PARTLY:`; line 4 starts with `SOMETHING ELSE:` or `NOT THERE:`; line 5, 6 or 9 is not `none`, or line 7 or 8 is not `approve_program(uuid)`; line 2, 3 or 4 already reads its "after" column while the ledger does not have the migration.
- **Noted**: lines 10 and 11 — the drafts out of the trash and in it; line 12 — a block made a draft again by hand, which nobody who signs in can change afterwards (the page's section "A draft nobody wrote"); lines 13 to 15 — sets a coach wrote in a draft, which the approval keeps or writes again from their exercise (the page's section "The drafts and their sets" lists them by draft). None of them stops the migration, and it writes none of them.

```bash
supabase db query --linked --file supabase/migrations/2026_10_16_20_drafts_coach_readonly.sql
```

It holds the four tables of a block for an instant: an athlete who ticks a set in that instant waits for it.

```bash
supabase db query --linked --file supabase/audits/2026_10_16_20_drafts_coach_readonly.audit.sql
```

Lines 2, 3, 4 and 8 read as the "after" column: `its author only`; `weeks, sessions, exercise_slots, set_logs`; `marks the program approved, drops the sets without a target, adds the missing sets`; `approve_program(uuid); block_draft_session_write(); block_draft_set_log_write(); block_draft_slot_write(); block_draft_week_write()`. The others are what they were.

The check of the page must fail with `check only, nothing was written: in place: the coach changes nothing in a draft of their athlete and is answered draft_read_only; the athlete writes it as before; the coach renames it and approves it, and every set of the approved block has the reps and load of its exercise`.

### Step 3 — migration 21: an RPE in half steps, and a weekday that is a weekday or none

Page: [runbook/migrations/21-rpe-half-steps-day-check.md](runbook/migrations/21-rpe-half-steps-day-check.md). Rollback at hand: `supabase/rollbacks/2026_10_16_21_rpe_half_steps_day_check.down.sql`. It rounds an RPE in a half step up, and **the weekdays the migration cleared do not come back**: the list below is their only record. Run it only when the check answers `NOT PROTECTED` or `BROKEN`.

```bash
supabase db query --linked --file supabase/audits/2026_10_16_21_rpe_half_steps_day_check.audit.sql
```

Clean: line 2 reads `a whole number from 1 to 10`; line 4 `any number`; line 5 `the number`. Line 3 is a list (how many sets were rated with each value), lines 6 to 9 are numbers.

- **Stops**: line 2 or line 5 starts with `SOMETHING ELSE:`, or line 5 with `NOT THERE:`; line 2, 4 or 5 already reads its "after" column while the ledger does not have the migration.
- **Noted**: line 3; lines 6 to 8 — the weekdays the file clears; line 9 — the weekdays of the coach's own blocks, which it leaves alone.

**Then the list of what it clears — the step the table gives this checkpoint.** Read-only; keep its output, it is passed on whole:

```bash
supabase db query --linked "select pr.full_name as athlete, p.name as block, p.status as state, coalesce(w.label, 'phase ' || w.week_number) as phase, s.sort_order + 1 as position, s.title, s.day_number as weekday, case when s.day_number not between 1 and 7 then 'not a weekday' when p.status = 'draft' then 'a draft the athlete is writing' else 'a block the athlete wrote' end as why, s.id as session_id from public.sessions s join public.weeks w on w.id = s.week_id join public.programs p on p.id = w.program_id join public.students st on st.id = p.student_id join public.profiles pr on pr.id = st.profile_id where s.day_number is not null and (s.day_number not between 1 and 7 or p.created_by is not null) order by 1, 2, w.week_number, s.sort_order"
```

Under `why`, `not a weekday` and `a draft the athlete is writing` are cleared whichever way the file is applied. `a block the athlete wrote` is a block you approved: the file as it is clears those too — the default you left standing on 2026-10-03 (B12), since their builder offers no weekday and the values are positions or a Monday the old save wrote. To keep them, say *drafts only* when the sitting starts: the file is then applied with the second command of the page's *Apply* instead of the one below, and line 8 keeps its number.

```bash
supabase db query --linked --file supabase/migrations/2026_10_16_21_rpe_half_steps_day_check.sql
```

It holds the sessions and the sets while the sets are written again with the new type — a few seconds at most: a set ticked in that moment waits for it.

```bash
supabase db query --linked --file supabase/audits/2026_10_16_21_rpe_half_steps_day_check.audit.sql
```

Lines 2, 4 and 5 read as the "after" column: `from 1 to 10, in steps of 0.5`; `none, or 1 to 7`; `no weekday`. Lines 6 to 8 read `0` — line 8 its number from before, with drafts only. Line 3 is the list it was, line 9 the number it was.

The check of the page must fail with `check only, nothing was written: in place: an RPE is saved in half steps and refused between them; a weekday is 1 to 7 or none; a draft whose session says 9 is saved without one`.

### Step 4 — migration 22: a client error is read by its author and their coach, 30 an hour

Page: [runbook/migrations/22-client-errors-scope.md](runbook/migrations/22-client-errors-scope.md). Rollback at hand: `supabase/rollbacks/2026_10_16_22_client_errors_scope.down.sql`. It gives every coach every line again and takes the cap away. Run it only when the check answers `NOT PROTECTED` or `BROKEN`.

```bash
supabase db query --linked --file supabase/audits/2026_10_16_22_client_errors_scope.audit.sql
```

Clean: line 2 reads `every coach, every line`; line 3 `no limit`; line 4 `none`. Lines 5 to 9 are numbers.

- **Stops**: line 2 starts with `SOMETHING ELSE:`, or line 4 is not `none` — a policy made by hand, next to which the migration refuses to run; line 2 or 3 already reads its "after" column while the ledger does not have the migration.
- **Noted**: line 6 — lines without an author, which every coach still reads; line 7 — lines of a former athlete, which only their author reads afterwards (the page's section "Who reported what" names the accounts, read-only); line 8 above 30 — an account past the cap of an hour; line 9 — what `run_retention()` deletes at its next night.

```bash
supabase db query --linked --file supabase/migrations/2026_10_16_22_client_errors_scope.sql
```

```bash
supabase db query --linked --file supabase/audits/2026_10_16_22_client_errors_scope.audit.sql
```

Lines 2 and 3 read as the "after" column: `its author and the coach of its author; every coach, a line without an author`; `30 — the next ones are dropped`. The others are what they were.

The check of the page must fail with `check only, nothing was written: in place: a line is read by its author and the coach of its author, a line without an author by every coach; an account keeps 30 lines an hour, dated when they arrive; the owner is not counted`.

### Step 5 — migration 23: an exercise is read by whoever reads what uses it

Page: [runbook/migrations/23-library-read-follows-program.md](runbook/migrations/23-library-read-follows-program.md). Rollback at hand: `supabase/rollbacks/2026_10_16_23_library_read_follows_program.down.sql`. It drops the policy and its function: after a change of coach the exercises of the earlier blocks lose their name again. Run it only when the check answers `NOT PROTECTED` or `BROKEN`.

```bash
supabase db query --linked --file supabase/audits/2026_10_16_23_library_read_follows_program.audit.sql
```

Clean: line 2 reads `its coach and that coach's athletes`; lines 3 and 4 `none`. Lines 5 to 8 are numbers — `0` while no athlete with a program has changed coach.

- **Stops**: line 2 starts with `SOMETHING ELSE:`; line 4 is not `none`; line 2 or 3 already reads its "after" column while the ledger does not have the migration.
- **Noted**: lines 5 to 8 — the exercises the app shows without a name today, which the migration gives back (the page's section "The exercises of a former coach" lists them).

```bash
supabase db query --linked --file supabase/migrations/2026_10_16_23_library_read_follows_program.sql
```

```bash
supabase db query --linked --file supabase/audits/2026_10_16_23_library_read_follows_program.audit.sql
```

Lines 2 and 3 read as the "after" column: `its coach, that coach's athletes, and whoever reads what uses it`; `exercise_readable_through_use(uuid)`. The others are what they were.

The check of the page must fail with `check only, nothing was written: in place: after a change of coach, the athlete and the new coach read the exercises their sessions, swaps and goals use, and nobody else does; nobody but its coach writes one, and a new session takes an exercise of the library of today`.

### Step 6 — migration 24: indexes, and a deleted session lets go of its feedback

Page: [runbook/migrations/24-indexes-cleanup.md](runbook/migrations/24-indexes-cleanup.md). Rollback at hand: `supabase/rollbacks/2026_10_16_24_indexes_cleanup.down.sql`. It puts the nine indexes back and drops the eight; the session ids it took off messages do not come back. Run it only when the check answers `NOT PROTECTED` or `BROKEN`.

```bash
supabase db query --linked --file supabase/audits/2026_10_16_24_indexes_cleanup.audit.sql
```

Clean: line 2 lists the nine names; line 3 `all nine there`; line 4 the eight foreign keys `client_errors.user_id, exercise_slots.exercise_id, goals.coach_id, messages.recipient_id, messages.sender_id, slot_comments.student_id, slot_deviations.student_id, slot_deviations.substitute_exercise_id`; line 5 `none`; line 6 `the message keeps its id`. Lines 7 and 8 are a number and a list.

- **Stops**: line 3 starts with `MISSING:`; line 4 names another foreign key; line 5 is not `none`; line 6 starts with `SOMETHING ELSE:` or `NOT THERE:`; line 2 reads `none`, line 5 the eight names or line 6 `the message loses it` while the ledger does not have the migration.
- **Noted**: line 2 with fewer than nine names — one was dropped by hand, and the migration drops the others; line 7 — feedback messages whose session was deleted, which lose that id (the page's section "The messages that lose their session" lists them); line 8 — how often the nine were read.

```bash
supabase db query --linked --file supabase/migrations/2026_10_16_24_indexes_cleanup.sql
```

It holds the thirteen tables it touches for a second or two while it builds the eight indexes: a request of the app in that moment waits for it.

```bash
supabase db query --linked --file supabase/audits/2026_10_16_24_indexes_cleanup.audit.sql
```

Lines 2 and 4 read `none`, line 5 the eight names, line 6 `the message loses it`, line 7 `0`, line 8 `none`; line 3 still reads `all nine there`.

The check of the page must fail with `check only, nothing was written: in place: no index repeats a unique key and every foreign key has one; a deleted session leaves its feedback message without it, and nobody else takes it off`.

### Step 7 — migration 25: a coach reads a video's file through the video that names it

Page: [runbook/migrations/25-storage-video-policies.md](runbook/migrations/25-storage-video-policies.md). Rollback at hand: `supabase/rollbacks/2026_10_16_25_storage_video_policies.down.sql`. It gives the coach every file of an athlete's folder again. Run it only when the check answers `BROKEN` — the coach or the athlete no longer reads a video of theirs. `NOT PROTECTED` is the one answer of this page that a rollback does not cure: run the audit and report line 3 with the full message.

```bash
supabase db query --linked --file supabase/audits/2026_10_16_25_storage_video_policies.audit.sql
```

Clean: line 2 reads `every file in the folder of one of their athletes`; line 3 `none`; line 8 `0`. Lines 4 to 7 are numbers, `0` while nobody has uploaded a video.

- **Stops**: line 2 starts with `SOMETHING ELSE:`; line 3 is not `none` — a policy made by hand lets somebody read the files whatever the migration says; line 2 already reads its "after" column while the ledger does not have the migration.
- **Noted**: line 5 — the files the coach stops reading, which the athlete still reads (the page's section "Files that no video names" lists them; removing one is a delete through the Storage dashboard, asked first, and a file removed is in no backup); line 6 — those of them older than a day; line 7 — a video whose file is gone; line 8 not `0` — go on, and report it.

```bash
supabase db query --linked --file supabase/migrations/2026_10_16_25_storage_video_policies.sql
```

`must be owner of table objects` or `permission denied` on `storage.objects` means the project no longer lets the SQL editor write the rules of the files: stop and report.

```bash
supabase db query --linked --file supabase/audits/2026_10_16_25_storage_video_policies.audit.sql
```

Line 2 reads `the files a video of one of their athletes names`; the others are what they were.

The check of the page must fail with `check only, nothing was written: in place: a coach reads the file a video of their athlete names, and not the one no video names; the athlete reads both, and another coach neither`. `… NOT TRIED: the two files of the check could not be written into storage.objects (…)` is noted, not a stop: line 2 of the audit then says that the migration is in place.

### Step 8 — the ledger

```bash
supabase db query --linked "select name, applied_at from app_private.app_migrations order by applied_at, name"
```

Twenty-five rows, in the order of their numbers, the last one `2026_10_16_25_storage_video_policies`. Production has every `required` migration of wave 3.

### Step 9 — Optional — migration 26: the coach's two lists in one request each

You said yes to it on 2026-10-17. Without it nothing is missing: the app of wave 3 reads the coach's sessions to review and the conversations page by page, the same lists, slower to open; with it each list is one request. The app that is deployed does not call the two functions.

Page: [runbook/migrations/26-coach-list-rpcs.md](runbook/migrations/26-coach-list-rpcs.md). Rollback at hand: `supabase/rollbacks/2026_10_16_26_coach_list_rpcs.down.sql`. It drops the two functions, and the app goes back to its paged reads. Run it when the check answers `NOT PROTECTED` or `BROKEN`.

```bash
supabase db query --linked --file supabase/audits/2026_10_16_26_coach_list_rpcs.audit.sql
```

Clean: lines 2 and 3 read `no`; lines 4 to 8 `none`. Lines 9 to 14 are numbers.

- **Stops**: line 2 or 3 reads `yes` while the ledger does not have the migration; line 4, 5, 7 or 8 is not `none`, or line 6 is not `none` before the migration.
- **Noted**: lines 9 to 14 — line 10 is how many sessions wait for a review; line 11 or 14 above `0` is a coach whose counts, or an account whose conversations, the app that is deployed reads cut.

```bash
supabase db query --linked --file supabase/migrations/2026_10_16_26_coach_list_rpcs.sql
```

```bash
supabase db query --linked --file supabase/audits/2026_10_16_26_coach_list_rpcs.audit.sql
```

Lines 2 and 3 read `yes`, line 6 `coach_review_counts(); my_conversations()`; the others are what they were.

```bash
supabase db query --linked "select name, applied_at from app_private.app_migrations order by applied_at, name"
```

Twenty-six rows, the last one `2026_10_16_26_coach_list_rpcs`.

The check of the page must fail with `check only, nothing was written: in place: a coach reads the sessions to review of each athlete and their conversations in one request each; the athlete reads their own conversation, and another coach nothing`.

### Step 10 — the app of wave 3 may be published

With twenty-five rows in the ledger — twenty-six with migration 26 — the app of wave 3 may replace the one of wave 2. It brings the Stats page that counts what was trained (one definition of a performed session, the dates of an athlete west of Greenwich, a weekly panel of consecutive weeks, a chart on a time axis), records and *Last time* that follow the number shown and the order of training, the session of a gym — a decimal comma read as one, an RPE in half steps, a set marked failed by a hold, Undo on a removed or skipped set, a question before an exercise is skipped, a rest that can be skipped or given 30 s more and that keeps its beep, wake lock and push on every page, a push for this device only that leads back to the session —, a password changed with the current one, the coach's pages that say *not found* or *couldn't be loaded* instead of drawing an empty editor, a draft the coach cannot write, the library's archive, 44 px targets, the feed and the inbox past a thousand confirmations, and a chat that does not send on Enter on a phone.

**Which commit: the head of wave 3, and no later one.** It is the commit this section was written in, found by its whole subject:

```bash
git log -1 --format='%H %s' --grep='^docs(runbook): Checkpoint C1 as a sequence that can be pasted, and Checkpoint B recorded as done$'
```

With that commit checked out, ask the question the deploy will ask ([runbook/40-deploy.md](runbook/40-deploy.md), section 2). The script reads the migrations of the checkout it runs in: on a later commit that brings migrations of its own it would report them `MISSING`.

```bash
node --env-file=.env scripts/check-migrations.mjs --verify
```

`OK: production has all 24 required migrations of this commit. The deploy can go on.` is the only ending after which it is pushed. Migrations 19 and 26 are `optional` and are listed, not asked for.

Publishing is a push of that commit to `main`, as a fast-forward from `2bb6495`: yours, or Claude's under your go of 2026-10-17, which covers this commit and no other. Since wave 2 an open app takes an update only when nothing would be lost — no write waiting, no rest running, no field in use — so the time of the push matters less than it did; still not in the middle of somebody's session, and not before your phone is ready for the first look of step 11 — the app of wave 2 open on it, a rest running —, because that look is the update itself: the push waits for you to say so.

**Once the run is green**, look at it this once:

- Job `test`: `found 0 vulnerabilities`; lint `14 problems (0 errors, 14 warnings)`, at its ceiling; the unit suite with no test skipped — `Test Files  192 passed (192)`, `Tests  4283 passed (4283)` at the head of wave 3.
- Job `db`: `Test Files  34 passed (34)`, `Tests  1320 passed (1320)` at the head of wave 3, on `ubuntu-24.04`.
- Job `functions`: `deno check` green.
- Job `deploy`, step *This build joins the builds that are published*: `pruned     nothing: 3 builds published, 3 are kept` — the build adopted at B, the build of wave 2 and this one. A fourth publication prunes the oldest.
- The published `version.json` names the new build and says `"minBuild":null`: nothing to set.

### Step 11 — on a phone, with the app of wave 3

What no test of the repository can show, on the test athlete's phone (an iPhone with iOS 17 or later, the app installed on the Home Screen) and with the coach's account; everything written is undone in the same step, and nobody is signed out of another device. When Claude runs the checkpoint, these are yours: Claude says which look is next and what to watch.

1. **The update itself.** With the app of wave 2 open on the phone during a rest, publish: the new version waits until the rest is over and nothing is being typed, then offers *Update* or *Later*, and never reloads under a finger.
2. **The looks of Checkpoint B, step 11, one to eleven** — no phone has run them yet. Run them with the app of wave 3.
3. **A decimal comma**, with an iPhone keyboard in French and the app in English: `82,5` in the athlete's *Actual* weight, in the coach's target weight of a slot and in the bodyweight card is saved as 82.5 — the coach sees 82.5, the athlete does not see *BW*. Put the values back afterwards.
4. **The session's controls.** An RPE in a half step (7.5) is saved and shows as such; a hold on a set's circle marks it failed, a tap does not; removing an extra set and skipping a set each offer Undo, which gives the set back as it was; skipping an exercise asks first. During a rest, *+30 s* and *Skip*; with Stats opened in the middle of a rest, the beep and the push still come.
5. **The rest push of wave 3**, *Rest end notification* on, phone locked: a rest of three minutes rings once, on this phone only — a second device of the same account stays silent —, in the app's language, and a tap on it opens the session it was taken in.
6. **The touch targets**, on a phone, as both accounts: every button of the session, the Program Sheet, the library, the bell and the avatar is pressed at the first try; the bell's panel fits the screen; in the chat, Enter writes a new line and the button sends.
7. **The phase menu on a last, empty phase**: in the Program Sheet, the ⋯ of the last phase, with no session in it, opens a menu whose *Reorder phases* and *Delete phase* can be pressed. Delete the phase only if you made it for the look.

### Step 12 — the end-to-end run *after*, on the test athlete

The run that was planned for C2, held here because C1 is the last checkpoint. It is the run *before* of 2026-10-03 again, from its scripts in `review-2026-09-30/runs/e2e-before/` — a folder of this checkout only —, now on the app of wave 3: from the main checkout, a preview build of the head served under `/sl_app/` on the machine and pointed at production, in a fresh browser profile, with notifications denied, as the test athlete and its coach thread only. Its write guard is the one of the run before, with these added: the missing sets of the test session (`rpc/ensure_set_logs`), the coach's two read functions, which go out as POST (`rpc/coach_review_counts`, `rpc/my_conversations`), and the coach's one feedback message on the test session — a POST to `messages` with `session_id` the test session, the coach as sender, the test athlete as recipient and a body that starts with `E2E `, which the run before refused (E12) and its self-test in `01_login.mjs` expects refused. With notifications denied, the app asks for no rest push. The scripts were written for the app deployed on 2026-10-03 and point at the live site: before the run, `APP` in `lib.mjs` is the address of the preview, and the steps whose controls changed in wave 3 — the skip that asks first, the RPE in half steps, a set marked failed by a hold, the feedback that is sent — are written again for the app of wave 3.

What should read differently from the run before: opening the session writes nothing and leaves no change waiting (E1, L8); the *Actual* sends `actual_weight_kg: 82.5` (E4, L9); four changes made offline are replayed in order, each `logged_at` the time of its tap (E8, P23); the exercise skip asks first (E9, L12); the review names the phase and *Session n/total* and dates the session by the day it was trained (E10, E11, L14); once the feedback is sent, the session is locked for the athlete and *Undo* is gone (E12, P57); the bell's panel stays inside the screen at 360 and 375 px (E13, L30); an offline reload shows the list and stays signed in (E17, L3, L4), back from a deep link goes to the athlete's home (L31), and the past-block session offers *Review* (L32). What will **not** have changed, because it is in [BACKLOG.md](BACKLOG.md): the coach's review in French (L17), the fonts served from Google, no content security policy.

What the run leaves is taken away in this order, each statement asked first like every statement that writes rows of the app ([Who runs a checkpoint](#who-runs-a-checkpoint)): the feedback message and the review, with the statement of page 09's section "Taking a review back"; a logged extra set, with the recipe of page 04's section "Deleting training history on purpose"; then the undo steps in the app. The unread notification of the skip goes with the skip.

### Step 13 — what to pass on

- the six or seven new ledger rows, with their dates;
- the numbers that were noted: lines 10 to 15 of the audit of 20, 3 and 6 to 9 of 21 with the whole list of step 3, 5 to 9 of 22, 5 to 8 of 23, 2, 7 and 8 of 24, 4 to 8 of 25, 9 to 14 of 26;
- any line that was not what its step calls clean, and the message of any check that did not answer as written;
- whether the app was published, from which commit, the number of the run, and what the looks of step 11 showed;
- what the end-to-end run showed against the run before, and what it left that was taken away.

## By hand in the SQL editor, from these checkpoints on

What the migrations of waves 1 to 3 change for the things you do yourself, outside a checkpoint. Each has its statement on a page; none has a screen in the app.

Since Checkpoint B these statements, and the one routine among them, have a page of their own: [runbook/70-admin-procedures.md](runbook/70-admin-procedures.md) — what you want to do, and where its statement is written. Of the rows of C1, that page lists 25 only: 20 and 21 are done in the app, and the read of 22 is on its own page, linked in the table.

| From | What | Where |
|---|---|---|
| A1 (03) | a function you create by hand can be called by `postgres` and the service role only, until a `GRANT EXECUTE … TO authenticated` is written for it | [03](runbook/migrations/03-function-grants-lockdown.md), "From now on: a function you create by hand" |
| A2 (04) | training history is deleted on purpose with one recipe, which leaves the guards in place — never by dropping a trigger | [04](runbook/migrations/04-logged-history-guards.md), "Deleting training history on purpose" |
| A2 (05) | a new athlete is linked to their coach with one statement: the API refuses to create, move or delete a link | [05](runbook/migrations/05-students-role-gate.md), "Linking an athlete to a coach" |
| A2 (07) | a coach is made with one statement, and the role comes before the athletes are linked; an account created in the dashboard is named after the first part of its address until somebody gives it a name | [07](runbook/migrations/07-profile-rules.md), "Making a coach", "Accounts without a name" |
| A2 (08, 09) | a session the coach reviewed is opened again for its athlete by taking the review back: there is no reopening in the app | [09](runbook/migrations/09-review-lifecycle.md), "Taking a review back"; [08](runbook/migrations/08-session-write-gates.md), "Letting an athlete write a reviewed session again" |
| A2 (10) | an athlete is moved to another coach with one statement, which hands their goals over as well — not before Checkpoint C1 for an athlete who already has a program: until then their sessions would show exercises without a name. The account of a coach whose athletes moved on is not deleted | [10](runbook/migrations/10-goals-fk-coach-links.md), "Moving an athlete to another coach", "Removing a coach's account" |
| A3 (11) | a block left active in the trash, or a phase left numbered 100000 and more by a lost request, is put right with one statement | [11](runbook/migrations/11-activate-reorder-rpcs.md), "A block in the trash that is still active", "Sessions or phases left parked" |
| A3 (14) | a table you create by hand cannot be reached without a session, and is read and written in full by every signed-in user until `alter table … enable row level security` is run on it and its policies are written. Afterwards the audit of migration 14 is run again: its lines 5 and 6 must read `none` | [14](runbook/migrations/14-table-grants-lockdown.md), "From now on: a table you create by hand" |
| B (15) | the secret the database sends its pushes with is renamed `app_internal_bearer` — optional, and only once [30](runbook/30-edge-functions.md), sections 2 and 4, name it; a device whose address is at no push service is deleted, then the rule on addresses is recorded as holding for every row | [15](runbook/migrations/15-push-plumbing.md), "Renaming the secret", "Devices whose endpoint is not at a known push service" |
| B (17) | the 72 hours a block stays open for its athlete after *Set active* on another one are closed early, or opened again for an athlete whose phone was offline longer; giving an athlete their block back is *Set active*, in the app | [17](runbook/migrations/17-replay-grace-window.md), "The blocks that are still open", "Closing a window early, or opening one again" |
| B (18) | once a month — until the nightly job of the optional migration 19 runs, if it ever does — the rows nobody reads any more are deleted with one statement: rest pushes older than 7 days, notifications read more than 90 days ago, client errors older than 90 days. Read-only look before, the run, the look again | [70](runbook/70-admin-procedures.md), "Once a month: delete what nobody reads any more"; [18](runbook/migrations/18-retention.md), "A rest push that is kept" |
| B (19), only where pg_cron is switched on | the jobs are looked at, switched off for a while and switched on again with the statements of the page; the monthly routine of the row above is no longer needed while `sl-retention` runs | [50](runbook/50-pg-cron.md), "Looking at the jobs", "Pausing a job, and starting it again", "Turning it off" |
| C1 (20) | a draft is changed by its author only: you send it back, or approve it and then change it; a block made a draft again by hand, with no author, is approved in the app | [20](runbook/migrations/20-drafts-coach-readonly.md), "Changing a draft for your athlete", "A draft nobody wrote" |
| C1 (21) | a weekday cleared by the migration is set again in the Program Sheet, from the list kept at the checkpoint | [21](runbook/migrations/21-rpe-half-steps-day-check.md), "The sessions that lose their weekday" |
| C1 (22) | the client errors of a former athlete are read in the SQL editor, not in the app | [22](runbook/migrations/22-client-errors-scope.md), "Who reported what" |
| C1 (25) | a video file that no video names is removed through the Storage dashboard — never with `delete from storage.objects`, which leaves the bytes behind — and is in no backup | [25](runbook/migrations/25-storage-video-policies.md), "Files that no video names" |

## First-push checklist

**Done on 2026-10-13**, with the first publication (`fc7a552`, run 38354023259): every item below read as written, and its line says what it gave. The list stays — it is what the first run of a job on GitHub is checked against — and its rule stays with it:

**Not before Checkpoint A3 is applied.** The repository is public, and this branch says how to use holes that stay open in production until then: the Checkpoint A0 section above and the page of migration 02 (the five coach functions, until A0), `supabase/tests/known-holes.test.js` and the tests that try each migration on the database as it was before it (one test per hole, each of them open in production until the migrations of wave 1 are applied at A1 to A3). A push under any branch name publishes them, not only a push to `main`. From then on the same order holds for every wave: its checkpoint first, its commits on GitHub afterwards.

**Before the push: the two repository secrets.** Settings → Secrets and variables → Actions: `SUPABASE_DB_URL`, the session-pooler connection string of the project with the database password in it, and `BACKUP_PASSPHRASE`, the passphrase of your `.env`. [BACKUPS.md](../BACKUPS.md), section *The nightly run on GitHub*, says where each comes from — and what it means that the first is the connection string of the `postgres` role. The deploy that the push starts reads the ledger with the first one and publishes nothing without it; the nightly backup needs both. Set them the day of the push, not earlier: until then `main` carries the previous backup workflow. Then ask the question the deploy will ask, on the commit you are about to push ([runbook/40-deploy.md](runbook/40-deploy.md), section 2); `OK` is the only ending after which you push.

Nothing is pushed while the review is being worked through, so the parts of CI that only run on GitHub had never run. On the first run after the push, check:

1. Job `migrations`: green. Its log ends with `OK: production has all … required migrations of this commit. The deploy can go on.` and shows the user `postgres.<project ref>` it connected as. Red: nothing was published, and the last lines of the job say which case it is — [runbook/40-deploy.md](runbook/40-deploy.md), section 4. This job has never run on GitHub: the pooler and its TLS are new to it, as they were to the backup script. If it stays red although the ledger is complete — you have read it yourself — section 5 of that page says how to publish without the check. — *2026-10-13*: green, connected as `postgres.<project ref>` through the session pooler, `OK: production has all 14 required migrations of this commit`.
2. Job `test`, step `npm audit --omit=dev --audit-level=high`: green. Red with an unchanged lockfile means a new advisory was published since: run `npm audit --omit=dev` locally, then `npm audit fix` (never `--force`), run the tests, commit the lockfile. — *2026-10-13*: `found 0 vulnerabilities`; lint 25 warnings; 102 files, 1419 tests passed and 2 skipped. The two that skipped pass in a full clone: they are tests of `supabase/functions/runbook.test.js` that ask git about a commit of the published `main` (`a61f0c31f2`, the version of the two Edge Functions the page's "Undo" goes back to), and the job had checked out one commit and no history, so they stepped aside (`it.skipIf`). Since wave 2 the job checks out the whole history (`fetch-depth: 0`) and they run — three of them by then: a run of the unit suite reports no skipped test.
3. Job `db`: green. Read its log this once: the step `npm run test:db` ends with a summary that reads `Test Files  25 passed (25)` — 25 files and 932 tests on the head of wave 1, 30 files and 1173 tests on the head of wave 2 — with no `failed` beside it. This job has never run on GitHub either: it starts a PostgreSQL from the binaries `npm ci` installs. Red: nothing was published, and the log names the file and the test. Run `npm run test:db` on the same commit on your machine. Red there too: it is the test, and it is fixed before anything is published. Green there: it is the runner, and the first error of the job's log — a server that did not start, a step that ran out of time — is what to report. — *2026-10-13*: green, `25 passed (25)` and `932 passed (932)`, its first run on GitHub. Since wave 2 the job runs on `ubuntu-24.04`, not `ubuntu-latest`: GitHub moves `ubuntu-latest` to Ubuntu 26 from 2026-10-19, and the PostgreSQL binaries `npm ci` installs have only been started on 24.04 there. It goes back to the moving image — one line of `.github/workflows/test.yml`, and the test in `src/test/ciGuardrails.test.js` that holds it — once a run on Ubuntu 26 is green.
4. The two third-party actions resolve. A wrong commit fails the job at "Set up job":
   - `peaceiris/actions-gh-pages@84c30a85c19949d7eee79c4ff27748b70285e453` (v4.1.0) in `.github/workflows/deploy.yml`
   - `denoland/setup-deno@22d081ff2d3a40755e97629de92e3bcbfa7cf2ed` (v2.0.5) in `.github/workflows/test.yml`

   *2026-10-13*: both resolved.
5. Job `functions`: the `deno check` step is green, with no "Edge Functions" warning on the run summary. Then delete `continue-on-error: true` and the reporting step after it in `.github/workflows/test.yml`: from then on a broken function stops the gate. — *2026-10-13*: green, no warning. Both are deleted since wave 2, and `src/test/ciGuardrails.test.js` refuses them back: a function that does not type-check stops the gate.
6. **The nightly backup.** A schedule runs from `main` only. From the day this branch is on `main`, `.github/workflows/backup.yml` is the workflow of [BACKUPS.md](../BACKUPS.md): it runs the same script as step 2 of Checkpoint A0, and a run without its two secrets **fails** instead of skipping. So, the same day:
   - the two repository secrets are set — the step before the push, above;
   - Actions → **Nightly DB backup** → *Run workflow*. Green, with an artifact `db-backup-<n>`;
   - download the artifact and check it with the passphrase you kept: `verify.mjs` and `drill.mjs` with the path of the file, as in BACKUPS.md.

   Until the secrets are set, the scheduled run is red every night. That is the reminder.

   *2026-10-13*: the two secrets set at 05:56 UTC; run 38354397417 by hand, green, artifact `db-backup-92` (834,458 bytes, kept 30 days); downloaded and checked: `verify.mjs` OK, 25 tables and 12,843 rows, `drill.mjs` `DRILL OK`.

**Updating a pinned action.** The actions are pinned to a commit, because a tag can be moved:

```bash
git ls-remote https://github.com/<owner>/<repo> 'refs/tags/v<major>*'
```

Take the commit of the release you want (for an annotated tag, the line ending in `^{}`), paste the 40 characters after the `@`, and update the `# vX.Y.Z` comment on the same line. `src/test/ciGuardrails.test.js` refuses a tag, a branch, a short SHA, or a SHA without its release comment.

**Known advisories, in development tools only.** What ships is clean: `npm audit --omit=dev` finds nothing, and that is the audit CI runs. `npm audit` without `--omit=dev` reports two things more. One chain has no fix: `braces` (GHSA-vfj7-8cjw-p6xm, every version) through `micromatch`, `fast-glob`, `globby` and `gh-pages`, five entries, all high. The only thing npm offers for it is `--force`, a downgrade of `gh-pages` to 6.1.1. Do not run it: `gh-pages` is used only by the emergency `npm run deploy`. The other, `source-map-js` (GHSA-68fv-2mgg-jv7q, a dependency of the build and test tools), was published after the dependencies of wave 0 were settled and has a fix that breaks nothing: `npm audit fix`, without `--force`, the next time the dependencies are touched.
