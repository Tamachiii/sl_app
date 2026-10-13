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
2. **A backup less than a day old before the first statement** ([00, section 2](runbook/00-before-you-start.md)). The project is on the free plan, which has no backup of its own. The backup is one encrypted file that a script of the repository writes on your machine, taken again before each checkpoint — until the nightly run on GitHub is set up, which is a step of the [first push](#first-push-checklist).
3. **Audit, apply, audit.** An audit is one read-only query: run it before a migration and again after. When it does not show what the migration's page calls clean, the page says whether to go on or to stop. *Stop and report* means: apply nothing more, and pass the full output on.
4. **A rollback only when the migration's page says so**, last applied first.
5. **The ledger is the proof.** A checkpoint is done when `app_private.app_migrations` lists its migrations, not when a command printed nothing alarming.
6. **Database first, app second.** A build of the app needs every `required` migration of its wave, and of the waves before it, in production. Pushing to `main` publishes the app (`.github/workflows/deploy.yml`), so the branch of the review reaches `main` only at a checkpoint whose row below says the app is published. Under its own name it is not pushed either before Checkpoint A3: the repository is public ([First-push checklist](#first-push-checklist)). The deploy holds this rule itself: between the tests and the publish, its `migrations` job reads the ledger and stops when a `required` migration of the commit is not in it, naming each one ([runbook/40-deploy.md](runbook/40-deploy.md)). It is the net, not the plan: the checkpoint still comes first. `npm run deploy`, the emergency publish from your machine, goes around it.
7. **Never** `supabase db push`, `supabase migration up`, `supabase migration repair`: the folder is not a CLI migration history and cannot be replayed.
8. **Never** `supabase config push`, and `supabase/config.toml` never gets an `[auth]` section: a push would put the CLI's Auth defaults back (sign-up on, site URL on localhost, 6-character passwords). `src/test/authConfig.test.js` holds the repository's side of that.
9. **One migration at a time, and the first surprise ends the sitting.** A line of an audit that is not what the migration's page calls clean, a check that answers anything but what its step expects, a message the page does not list: nothing more is applied, and the full output is passed on. Each step of a checkpoint says which lines stop it and which are only noted.

## Who runs a checkpoint

You decide that a checkpoint starts. Who pastes the commands is your choice, and the sequence is the same either way: in the sections below, *you* is whoever runs it.

Checkpoint A0 was run by Claude at your request, and since 2026-10-12 your standing answer is that Claude applies the migrations of the checkpoints for you — when you say that a checkpoint may start, never on its own, and never as part of the work on a package: an agent that writes or tests a migration does not run it. The answer and its conditions are noted in `review-2026-09-30/user-answers.md`, which exists in this checkout only. What Claude holds to when it runs one:

- a fresh backup first, taken and checked with the two commands of the checkpoint's first step;
- the audit before and after each migration, one migration at a time, in the order of `supabase/migrations/manifest.json`;
- rule 9: it stops at the first line that is not what the page calls clean, and reports the output as it is;
- the rollback file of each migration at hand, run only in the case its page names;
- a dashboard value changed through the Management API only when the checkpoint lists it, with the previous values saved first, as at A0;
- the checks in the app with the test athlete and its coach account only, each thing written undone in the same step, and nobody signed out;
- at the end, what the last step of the checkpoint — *what to pass on* — lists.

What that answer does not cover — each of these is asked again, every time:

- an `optional` or a `contract` migration: 19, 31, and 43 to 45;
- a statement that a page gives beside its migration and that writes or deletes rows of the app: removing a coach–athlete link (05), naming an account (07), taking a review back or adding the sets a reviewed session lacks (08), handing goals over to the coach of today (10), switching off a block in the trash or numbering a phase again (11). The step of its migration says when it comes up. Claude reports what there is — the list that the query of the page's section gives, or the number on the line of the audit where the section has no query — and writes nothing until you have answered. Where the statement comes before its migration (05, 08), the migration waits for your answer, and so does everything after it; where it comes after (07, 10, 11), the sequence goes on and the list is part of what is passed on;
- pushing to `main`, which publishes the app, and pushing the branch at all;
- deploying an Edge Function;
- enabling an extension (pg_cron);
- a GitHub secret or variable.

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

A checkpoint is one sitting: a list of migrations, sometimes a dashboard step or a function to deploy, and whether the app is published afterwards. A checkpoint marked **done** or **ready** has its sequence on this page: *done* is the record of what was run, *ready* is what can be run now, in the order of the table. The others are the plan: their numbers are fixed, their pages are written by the wave that brings the code.

| Checkpoint | Due | Migrations | Also by hand | App published after it | Hand-over |
|---|---|---|---|---|---|
| A0 | after wave 0 | 01, 02 | Auth settings; a backup on your machine | no | **done** on 2026-10-11 |
| **A1** | now — wave 1 is finished | 03 | a smoke check as athlete and as coach, with the app that is deployed | no | **ready** |
| **A2** | after A1 and its smoke check | 04–10 | looks in the app that is deployed, on the test athlete; what to tell the coach | no | **ready** |
| **A3** | after A2 | 11–14 | just before the push: the two repository secrets — the deploy reads the ledger with `SUPABASE_DB_URL`, and stops without it | yes: the first one, the head of wave 1 | **ready** |
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

The last commit of wave 1 that changes the app or the SQL is `8fef5f2`; what follows it, up to that head, changes documents, tests, and how the database suite starts its server and ends its run — nothing that is published or applied. Two of those commits are why the gate of this first publication can be believed: before them `npm run test:db` ended with status 0 whatever its tests said, so its job could not go red, and about one run in two reported a file as failed for a reason that was no test. A commit after the head belongs to wave 2 — also the one that records a checkpoint as done in the table above. Such a commit is published at Checkpoint B and not before, even on a day when the deploy would let it through: a wave is deployable at its head, not half-way.

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

Page: [runbook/30-edge-functions.md](runbook/30-edge-functions.md). Not a migration, and nothing waits for it: the function is deployed in any case at Checkpoint B. Doing it now closes finding L25 (the function compared its secret in a way that leaks it slowly, and answered any browser) and tries the deploy once on a small change. The database in production calls the new version exactly as it calls the old one. Deploying a function is asked each time ([Who runs a checkpoint](#who-runs-a-checkpoint)).

```bash
supabase functions deploy send-push --use-api
```

No `--no-verify-jwt`: `supabase/config.toml` carries the flag now (finding B18). Then the check of section 3 of the page, from the root of the checkout. Its first line must read `no bearer: 401 send-push: unauthorized`. Before the deploy the same check prints `no bearer: 401 Unauthorized`; anything else is explained on the page.

Then, once: rotate the shared secret (section 4 of the page) if the value in use is the project's service-role key or was ever pasted anywhere. Five commands, at an hour when nobody trains.

## By hand in the SQL editor, from these checkpoints on

What the migrations of wave 1 change for the things you do yourself, outside a checkpoint. Each has its statement on a page; none has a screen in the app.

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

## First-push checklist

**Not before Checkpoint A3 is applied.** The repository is public, and this branch says how to use holes that stay open in production until then: the Checkpoint A0 section above and the page of migration 02 (the five coach functions, until A0), `supabase/tests/known-holes.test.js` and the tests that try each migration on the database as it was before it (one test per hole, each of them open in production until the migrations of wave 1 are applied at A1 to A3). A push under any branch name publishes them, not only a push to `main`. From then on the same order holds for every wave: its checkpoint first, its commits on GitHub afterwards.

**Before the push: the two repository secrets.** Settings → Secrets and variables → Actions: `SUPABASE_DB_URL`, the session-pooler connection string of the project with the database password in it, and `BACKUP_PASSPHRASE`, the passphrase of your `.env`. [BACKUPS.md](../BACKUPS.md), section *The nightly run on GitHub*, says where each comes from — and what it means that the first is the connection string of the `postgres` role. The deploy that the push starts reads the ledger with the first one and publishes nothing without it; the nightly backup needs both. Set them the day of the push, not earlier: until then `main` carries the previous backup workflow. Then ask the question the deploy will ask, on the commit you are about to push ([runbook/40-deploy.md](runbook/40-deploy.md), section 2); `OK` is the only ending after which you push.

Nothing is pushed while the review is being worked through, so the parts of CI that only run on GitHub have never run. On the first run after the push, check:

1. Job `migrations`: green. Its log ends with `OK: production has all … required migrations of this commit. The deploy can go on.` and shows the user `postgres.<project ref>` it connected as. Red: nothing was published, and the last lines of the job say which case it is — [runbook/40-deploy.md](runbook/40-deploy.md), section 4. This job has never run on GitHub: the pooler and its TLS are new to it, as they were to the backup script. If it stays red although the ledger is complete — you have read it yourself — section 5 of that page says how to publish without the check.
2. Job `test`, step `npm audit --omit=dev --audit-level=high`: green. Red with an unchanged lockfile means a new advisory was published since: run `npm audit --omit=dev` locally, then `npm audit fix` (never `--force`), run the tests, commit the lockfile.
3. Job `db`: green. Read its log this once: the step `npm run test:db` ends with a summary that reads `Test Files  25 passed (25)` — 25 files and 932 tests on the head of wave 1, more on a later commit — with no `failed` beside it. This job has never run on GitHub either: it starts a PostgreSQL from the binaries `npm ci` installs. Red: nothing was published, and the log names the file and the test. Run `npm run test:db` on the same commit on your machine. Red there too: it is the test, and it is fixed before anything is published. Green there: it is the runner, and the first error of the job's log — a server that did not start, a step that ran out of time — is what to report.
4. The two third-party actions resolve. A wrong commit fails the job at "Set up job":
   - `peaceiris/actions-gh-pages@84c30a85c19949d7eee79c4ff27748b70285e453` (v4.1.0) in `.github/workflows/deploy.yml`
   - `denoland/setup-deno@22d081ff2d3a40755e97629de92e3bcbfa7cf2ed` (v2.0.5) in `.github/workflows/test.yml`
5. Job `functions`: the `deno check` step is green, with no "Edge Functions" warning on the run summary. Then delete `continue-on-error: true` and the reporting step after it in `.github/workflows/test.yml`: from then on a broken function stops the gate.
6. **The nightly backup.** A schedule runs from `main` only. From the day this branch is on `main`, `.github/workflows/backup.yml` is the workflow of [BACKUPS.md](../BACKUPS.md): it runs the same script as step 2 of Checkpoint A0, and a run without its two secrets **fails** instead of skipping. So, the same day:
   - the two repository secrets are set — the step before the push, above;
   - Actions → **Nightly DB backup** → *Run workflow*. Green, with an artifact `db-backup-<n>`;
   - download the artifact and check it with the passphrase you kept: `verify.mjs` and `drill.mjs` with the path of the file, as in BACKUPS.md.

   Until the secrets are set, the scheduled run is red every night. That is the reminder.

**Updating a pinned action.** The actions are pinned to a commit, because a tag can be moved:

```bash
git ls-remote https://github.com/<owner>/<repo> 'refs/tags/v<major>*'
```

Take the commit of the release you want (for an annotated tag, the line ending in `^{}`), paste the 40 characters after the `@`, and update the `# vX.Y.Z` comment on the same line. `src/test/ciGuardrails.test.js` refuses a tag, a branch, a short SHA, or a SHA without its release comment.

**Known advisories, in development tools only.** What ships is clean: `npm audit --omit=dev` finds nothing, and that is the audit CI runs. `npm audit` without `--omit=dev` reports two things more. One chain has no fix: `braces` (GHSA-vfj7-8cjw-p6xm, every version) through `micromatch`, `fast-glob`, `globby` and `gh-pages`, five entries, all high. The only thing npm offers for it is `--force`, a downgrade of `gh-pages` to 6.1.1. Do not run it: `gh-pages` is used only by the emergency `npm run deploy`. The other, `source-map-js` (GHSA-68fv-2mgg-jv7q, a dependency of the build and test tools), was published after the dependencies of wave 0 were settled and has a fix that breaks nothing: `npm audit fix`, without `--force`, the next time the dependencies are touched.
