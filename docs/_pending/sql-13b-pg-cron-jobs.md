# sql-13b-pg-cron-jobs — docs to fold (wave 2, items: none)

Each block: target doc, section, then the text to fold in.

## docs/INVARIANTS.md — Web Push (rest-timer "Rest done" lock-screen notification)

Add after the bullet that starts "**The job hands a row over once, and leaves it `pending`.**" (folded from `sql-11-rest-push-scheduling`):

- **pg_cron is a choice of the owner, and everything works without it.** Production does not have the extension switched on. The optional migration `2026_10_13_19_pg_cron_jobs.sql` refuses to run without it (`SLM06`) and then makes four jobs, each of `postgres`, in this database: `sl-rest-push` (every 10 seconds, `dispatch_due_rest_pushes()`), `sl-retention` (every night at 03:17 UTC, `run_retention()`), `sl-push-failures` (every hour at :07, `record_push_failures()`) and `sl-cron-history` (every night, three days of pg_cron's own runs). Nothing in `src/` and no Edge Function may count on a job being there: the only thing that asks is `schedule_rest_push`, whose answer `mode` tells the app whether to call `dispatch-rest-push` itself. `supabase/tests/cron-jobs.test.js` holds the jobs; `docs/runbook/50-pg-cron.md` is the owner's page.
- **The name `sl-rest-push` is the contract.** `schedule_rest_push` answers `mode: 'cron'` while `cron.job` holds a job of that name that is switched on — whoever made it, whatever it runs — and `'edge'` otherwise: no extension, no job, a job switched off with `cron.alter_job(jobid, active := false)`. Never give that name to another job, and never make a job of that name by hand: the app of wave 3 stops calling the Edge Function for as long as it is there. A rest scheduled while the answer was `'cron'` is sent by the job and by nobody else, so switching the job off — a pause, the rollback of migration 19, the extension switched off in the dashboard — leaves the rests that are running at that instant without a sender (15 minutes of them at most); the app from before wave 3 calls the Edge Function for every rest and is not concerned.
- **The job needs the `send-push` of wave 2, and nothing in the database can check that.** It hands a row over ten seconds before its time with `schedule_id` and `not_before`; a `send-push` that does not know them sends at once, to every device, and the function the app called sends again at the time. The order of switching on is migration 16, the two Edge Functions of wave 2, the extension, migration 19 — written on both runbook pages, and held by nothing but them.

## docs/INVARIANTS.md — RLS / DB conventions

Add after the bullet that starts "**`run_retention()` is run by the owner or by a job, and waits for nobody.**" (folded from `sql-13a-retention`):

- **A migration that needs an extension the project may not have is `optional`, names the extension in the manifest, and exists in `schema.sql` inside one block.** `"extension": "pg_cron"` in `supabase/migrations/manifest.json` is what the tests go by. In `schema.sql` everything such a migration makes — a function included, created with `EXECUTE` — stands inside one `DO` block that asks `pg_extension` first and does nothing without the extension, and its line of the ledger is a separate statement under the same condition: a database installed without pg_cron is production without migration 19, to the last object, and that is the database every test file runs on. `parity.test.js` compares both projects. A function of such a migration is therefore in no list of `function-acl.test.js`: `cron-jobs.test.js` holds who may execute `record_push_failures()`, with whose rights it runs and its `search_path`. No later migration and no client may need what such a migration makes, and its rollback is never refused for a later migration.
- **A job is made, changed and removed through pg_cron's functions, never by writing `cron.job`.** `postgres` reads that table and may not write it — on Supabase, and in the stub of the suite (`supabase/tests/shim-pg-cron.sql`): `cron.schedule(name, schedule, command)`, `cron.alter_job(jobid, active := …)`, `cron.unschedule(name)`. `cron.schedule` on a name that exists replaces the schedule and the command of that job and leaves it switched off if it was. The four definitions are one text in the migration, the block of `schema.sql`, the audit, the rollback, the two runbook pages and `JOBS` of `cron-jobs.test.js`, which compares them; `supabase/migrations/README.md` ("A migration that adds a job, or changes what one runs") has the rules.
- **Where the jobs run, old rows are deleted without anybody asking.** `sl-retention` runs `run_retention()` every night: the monthly routine of `docs/runbook/70-admin-procedures.md` is then nobody's, and applying migration 19 is agreeing to the first run — nearly every rest push there is, the notifications read more than 90 days ago, the client errors older than 90 days.

## docs/INVARIANTS.md — RLS / DB conventions

Add after the bullet that starts "**No mutation failure is silent** (2026_07_13).":

- **`client_errors` also holds lines the database wrote: `role = 'database'`, `user_id` NULL.** Where pg_cron is switched on, `record_push_failures()` (migration `2026_10_13_19_pg_cron_jobs.sql`) writes one line per hour that is over and in which a request the database sent through pg_net was not answered with a status from 200 to 299 — "Push: 3 of 41 requests the database sent to send-push failed between … UTC — 2 × HTTP 502, 1 × no answer in time" — with the hour as its `url` (`pg_net 2026-10-13T14:00Z`), which is also what keeps an hour from being written twice. Review P35: a push that could not be sent was in the log of a function and nowhere else. No signed-in user can write such a row (the `INSERT` policy holds a report to the account and the role of its author), `useClientErrors` shows it like any other line (the role in capitals, the message, the `url`), and `run_retention()` deletes it after 90 days. A policy that narrows who reads `client_errors` keeps the lines without a `user_id` readable by a coach; a trigger that caps what an account reports lets a row without a `user_id` through. And `send-push` answers 2xx for everything that is not a failure — an account without a device included — or the list fills with lines that mean nothing.

## docs/ARCHITECTURE.md — Migrations and the ledger

Replace "**The manifest.** `supabase/migrations/manifest.json` lists the migrations that follow the format, in apply order, each with a `kind` (`required`, `optional`, `contract`), its wave and checkpoint, and whether its rollback is exact (`reversible`)." with:

**The manifest.** `supabase/migrations/manifest.json` lists the migrations that follow the format, in apply order, each with a `kind` (`required`, `optional`, `contract`), its wave and checkpoint, whether its rollback is exact (`reversible`) and — on an `optional` migration that needs one — the `extension` the owner must have switched on first (`pg_cron`).

## docs/ARCHITECTURE.md — Migrations and the ledger

Replace "its guard refuses a second run (`SLM01`) and a run before the migration it requires (`SLM02`)." with:

its guard refuses a second run (`SLM01`) and a run before the migration it requires (`SLM02`); a migration that names an `extension` refuses where it is not switched on (`SLM06`).

## docs/ARCHITECTURE.md — Migrations and the ledger

Replace "`schema.sql` ends with the same schema and table and an `INSERT` of the names of the migrations merged into it." with:

`schema.sql` ends with the same schema and table and an `INSERT` of the names of the migrations merged into it — a migration that names an `extension` in a statement of its own, which inserts the name only where the extension is there (`installedBySchemaSql` in `manifest.js` says which names a database installed from the file holds).

## docs/ARCHITECTURE.md — Migrations and the ledger

Replace "`scratchDatabase()` in `harness.js` clones either one for a test that loads SQL files itself." with:

`scratchDatabase()` in `harness.js` clones either one for a test that loads SQL files itself, and `db.enableExtension('pg_cron')` switches on, in such a database, an extension production does not have: the stub `supabase/tests/shim-pg-cron.sql`, run as the platform. Neither template has it.

## docs/ARCHITECTURE.md — Migrations and the ledger

Replace the bullet that starts "- `parity.test.js`: `sl_bare` + `fixtures/prod_baseline_2026_09_30.sql`" with:

- `parity.test.js`: `sl_bare` + `fixtures/prod_baseline_2026_09_30.sql` (`schema.sql` as it was compared with production on 2026-09-30, frozen, SHA-256 pinned) + the `required` and `optional` migrations must have the catalog of `schema.sql` — twice: as production is, without the migrations that name an `extension`, against `sl_template`; and with each extension switched on right before the first migration that needs it, against `schema.sql` loaded into a project that has them. `catalog.js` reads a catalog as data (`catalogSnapshot`) and lists the differences one line per object (`diffCatalogs`); the rows a SQL file writes are compared one by one for the tables of `REFERENCE_DATA` (the ledger, the storage buckets, the jobs of pg_cron); `catalog.test.js` makes each kind of change, on objects of its own, and checks it is seen.

## docs/ARCHITECTURE.md — Migrations and the ledger

Replace "A second pass on the baseline applies every migration that is not `optional` (`withoutOptionalProblems`): none may need an optional one." with:

A migration that names an `extension` gets it switched on right before its turn. A second pass on the baseline applies every migration that is not `optional` (`withoutOptionalProblems`): none may need an optional one. A third, without the extension, runs each migration that names one: it must refuse with `SLM06` and change nothing.

## docs/ARCHITECTURE.md — new section "What runs on a timer: pg_cron, where it is switched on", after the section "Retention: what is deleted, and when"

````markdown
## What runs on a timer: pg_cron, where it is switched on

Nothing in this app needs a timer inside the database: a rest push is sent by an Edge Function the app calls, the old rows are deleted by the owner once a month, and a push that could not be sent is in the log of a function. pg_cron is an extension the owner switches on to have the database do all three — `docs/runbook/50-pg-cron.md` is that decision — and the optional migration `2026_10_13_19_pg_cron_jobs.sql` then makes four jobs:

| Job | Schedule (UTC) | Runs | Instead of |
|---|---|---|---|
| `sl-rest-push` | every 10 seconds | `dispatch_due_rest_pushes()` | the app calling `dispatch-rest-push`, which waits in hops of two minutes |
| `sl-retention` | 03:17 every night | `run_retention()` | the monthly routine of `docs/runbook/70-admin-procedures.md` |
| `sl-push-failures` | :07 every hour | `record_push_failures()` | reading the log of `send-push` |
| `sl-cron-history` | 03:47 every night | a `DELETE` on `cron.job_run_details` | nothing: pg_cron keeps one row per run — 8,640 a day for the first job alone — and deletes none |

A job runs as the role that made it (`postgres`), in this database. It is made with `cron.schedule(name, schedule, command)`, switched off and on with `cron.alter_job(jobid, active := …)` and removed with `cron.unschedule(name)`: `postgres` reads `cron.job` and may not write it.

`record_push_failures()` is the one function the migration creates. A push leaves the database as a pg_net request to `send-push` (`send_push_event`), sent after the transaction commits, and nobody reads the answer; pg_net keeps each answer in `net._http_response` for six hours. The function writes one line per hour that is over and in which a request was not answered with a status from 200 to 299 into `client_errors` — `role = 'database'`, `user_id` NULL, the hour as `url`, "how many of how many, and what kind" as the message, never what the function answered — and answers `{ hours, failed }`. An hour is written once; every hour pg_net still holds is caught up by the next run. It is `SECURITY INVOKER`, for the owner and the service role.

In `schema.sql` the function and the four `cron.schedule` calls stand inside one `DO` block that asks for the extension first; a database without pg_cron — production today, and the database the tests run on — has none of it, and its ledger does not record migration 19. The migration's rollback removes the jobs and the function and is never refused for a later migration; it also runs where the extension was switched off first, so that the migration can be applied again.
````

## docs/ARCHITECTURE.md — Rest push: scheduled by the database, sent once

Replace "**The two modes.** Without pg_cron the app starts the sender itself (`mode: 'edge'`). With the optional job `sl-rest-push`, `dispatch_due_rest_pushes()` runs every ten seconds:" (folded from `sql-11-rest-push-scheduling`) with:

**The two modes.** Without pg_cron the app starts the sender itself (`mode: 'edge'`). With the job `sl-rest-push` of the optional migration 19 ("What runs on a timer", below), `dispatch_due_rest_pushes()` runs every ten seconds:

## docs/ARCHITECTURE.md — Auth and Row-Level Security

Add after the sentence that starts "`run_retention()` is for the same two and is `SECURITY INVOKER`" (folded from `sql-13a-retention`):

Where pg_cron is switched on, `record_push_failures()` is a fourth: it reads a table of pg_net and writes a line into `client_errors` that no signed-in user may write, with the rights of the job that calls it.

## CLAUDE.md — Repo map

Replace, in the `supabase/` block, the line "tests/ (DB suite: harness.js, sql.js, catalog.js, migration-checks.js," with:

tests/ (DB suite: harness.js, sql.js, catalog.js, migration-checks.js, shim.sql + shim-pg-cron.sql (pg_cron, switched on by a test that needs it),

## CLAUDE.md — Repo map

Replace, in the `docs/` block, the line "runbook/ (00-before-you-start.md  20-auth-config.md  30-edge-functions.md  40-deploy.md  70-admin-procedures.md" (folded from `sql-13a-retention`) with:

runbook/ (00-before-you-start.md  20-auth-config.md  30-edge-functions.md  40-deploy.md  50-pg-cron.md  70-admin-procedures.md

## CLAUDE.md — Feature → files map, new row after "Retention"

Add the row:

| pg_cron jobs (OPTIONAL: where the owner has switched the extension on, the database hands the rest pushes over, deletes the old rows every night and writes the failed push requests down — everything works without it, and production does not have it) | `supabase/schema.sql` section "THE JOBS: WHAT RUNS ON A TIMER, WHERE pg_cron IS SWITCHED ON" (one `DO` block that does nothing without the extension: `record_push_failures()` and the four jobs `sl-rest-push` / `sl-retention` / `sl-push-failures` / `sl-cron-history`), migration `2026_10_13_19_pg_cron_jobs.sql` (`optional`, `"extension": "pg_cron"` in the manifest, refuses with `SLM06` without it), `docs/runbook/50-pg-cron.md` (the choice in plain words, the order — the Edge Functions of wave 2 first —, looking at the jobs, pausing one, turning it off, what a `DATABASE` line in the coach's list means), `docs/runbook/migrations/19-pg-cron-jobs.md`, `supabase/tests/cron-jobs.test.js` (`JOBS` — the four definitions, held to the migration, `schema.sql`, the audit, the rollback and the pages), `supabase/tests/shim-pg-cron.sql` (the stub: nothing runs a job) + `db.enableExtension('pg_cron')` in `supabase/tests/harness.js`, `supabase/migrations/README.md` ("A migration that needs an extension the project may not have", "A migration that adds a job, or changes what one runs"). Nothing in `src/` knows about it: `schedule_rest_push` answers `mode: cron` while a job named `sl-rest-push` is switched on |

## CLAUDE.md — Feature → files map, row "Rest timer (in-app cues + Web Push)"

Add at the end of the row's file list:

; where pg_cron is switched on, the job `sl-rest-push` of the optional migration 19 is what runs `dispatch_due_rest_pushes` (the "pg_cron jobs" row)

## CLAUDE.md — Feature → files map, row "Error telemetry"

Add at the end of the row's file list:

; where pg_cron is switched on, the list also holds lines the database wrote — `role = 'database'`, `user_id` NULL: one per hour in which a push request failed (`record_push_failures()`, the "pg_cron jobs" row)

## CLAUDE.md — Feature → files map, row "Migrations + ledger (how a DB change is written and tracked)"

Replace "refusal codes `SLM01`–`SLM05`" with:

refusal codes `SLM01`–`SLM06`; `installedBySchemaSql` — what a database installed from `schema.sql` has on record, with or without an optional extension; `migrationsBefore` — what a project has applied before a given migration, which a test that builds "production before migration N" runs

## CLAUDE.md — Feature → files map, row "DB / RLS test suite (`npm run test:db`)"

Add before the sentence "The migration tests are the next row.":

`cron-jobs.test.js` (the optional migration `2026_10_13_19_pg_cron_jobs.sql`, in databases that have the pg_cron stub switched on — `scratchDatabase()` + `db.enableExtension('pg_cron')`, never the database of the file, which is production as it is: `JOBS` — the four jobs, one text in the migration, `schema.sql`, the audit, the rollback and the two pages; the name `sl-rest-push` as the contract of `schedule_rest_push`'s `mode`; each job's command run as the job runs it; `record_push_failures` — one line per hour that is over, each hour once, what "failed" means in the function, the audit and the page alike, two runs at once; `sl-cron-history` by the number of a run; a project with pg_cron as the project without it plus exactly one function, four jobs and one line of the ledger; the statements of `docs/runbook/50-pg-cron.md` read off the page; the migration on the frozen baseline — refused with `SLM06` without the extension, its refusals, its rollback with a later migration in the ledger and with the extension switched off first — with the audit table and the check of its runbook page read off the page).

## CLAUDE.md — When you add a feature

Add to step 2, after the bullet that starts "A table that is created follows":

   - A migration that needs an extension production may not have (pg_cron), and a job of pg_cron, follow "A migration that needs an extension the project may not have" and "A migration that adds a job, or changes what one runs" in the same file: `optional`, `"extension"` in the manifest, a guard that refuses with `SLM06` and never creates the extension, everything inside one guarded block of `schema.sql`, a rollback that is never refused for a later migration. Its tests run in a `scratchDatabase()` with `db.enableExtension('pg_cron')`; a test that builds "production before migration N" on the baseline runs `migrationsBefore(manifest.migrations, name)` and not the whole manifest, which stops at migration 19 without the extension.

## README.md — Database Tests

Replace "- `parity.test.js` — the frozen production baseline (`fixtures/prod_baseline_2026_09_30.sql`) plus every migration of `supabase/migrations/manifest.json` has the same catalog as `schema.sql`. The failure names the object and the side that lacks it." with:

- `parity.test.js` — the frozen production baseline (`fixtures/prod_baseline_2026_09_30.sql`) plus every migration of `supabase/migrations/manifest.json` has the same catalog as `schema.sql` — in a project as production is, without the migrations that wait for an extension, and in one that has pg_cron switched on. The failure names the object and the side that lacks it.

## README.md — Database Tests

Add after the bullet that starts "- `retention.test.js` holds" (folded from `sql-13a-retention`):

- `cron-jobs.test.js` holds the optional migration 19: four jobs of pg_cron and `record_push_failures()`. None of it is in the database the suite runs on, so its tests build their own: `scratchDatabase()`, `await db.enableExtension('pg_cron')`, then `schema.sql` (`home`) or the baseline and the migrations (`production()`). Nothing runs a job in the stub: `runJob(db, 'sl-retention')` runs its command as `postgres`, which is what pg_cron does at its time, and a run is a row the test writes into `cron.job_run_details`. What pg_net was answered is a row the test writes into `net._http_response` (`answered(hoursAgo, { status, timedOut, error })`). A request of a user of the API is a transaction that sets the role and the claims (`story`, `request`), because `asUser()` does not see a scratch database.

## README.md — Database Tests

Replace "Both are registered as extensions by hand so that `CREATE EXTENSION IF NOT EXISTS` in `schema.sql` is a no-op. `pg_cron` is absent, as in production." with:

Both are registered as extensions by hand so that `CREATE EXTENSION IF NOT EXISTS` in `schema.sql` is a no-op. `net._http_response` is there and stays empty: nothing answers a request, a test writes the answer. `pg_cron` is absent, as in production; a test that needs it switches a stub on in a scratch database (`db.enableExtension('pg_cron')`, `supabase/tests/shim-pg-cron.sql`), in which nothing runs a job and `postgres` may read `cron.job` and not write it, as on Supabase.

## docs/RUNBOOK.md — new section "Checkpoint B — …", after the section of Checkpoint A3

Add when Checkpoint B is handed over (its row marked **ready**), as the LAST part of the sequence, after the two Edge Functions of wave 2 are deployed and checked and after the app is published — and marked as a choice: **"Optional — pg_cron"**. Everything before it is complete without it. Every command is taken from `docs/runbook/50-pg-cron.md` and `docs/runbook/migrations/19-pg-cron-jobs.md` as it stands there, one per fence.

Say first, in the words of [runbook/50-pg-cron.md](runbook/50-pg-cron.md), "The choice": what the project has without pg_cron and with it, that the recommendation is to switch it on, what it costs, and that staying without it is doing nothing. Then, only on a yes:

1. the order, which is not to be changed: migrations 15 to 18 applied, **the `send-push` and the `dispatch-rest-push` of wave 2 deployed and checked** ([runbook/30-edge-functions.md](runbook/30-edge-functions.md)), a backup taken and checked, and the audit of migration 18 read — lines 8, 12 and 15 are what the first night deletes;
2. the extension, switched on in the dashboard (Database → Extensions → `pg_cron`) — by the owner: it is one of the things that are asked each time — and the command of page 50 that shows its row in `pg_extension`;
3. the audit of migration 19 — it reads as the "before" column of the page's table. **Line 2 must be a version, 1.5 or later; lines 3, 5 and 9 must read `yes`, `none` and `none`**: otherwise stop and report, the migration refuses to run. Line 17 is noted: what the push requests of the last hours were answered;
4. the migration;
5. the audit again — lines 4, 6 to 10 and 12 read as the "after" column, line 13 reads `no run yet` four times;
6. the ledger: one row more, the last one `2026_10_13_19_pg_cron_jobs`;
7. the page's check, which must fail with `check only, nothing was written: in place: sl-rest-push hands the rest pushes over every ten seconds and schedule_rest_push answers mode cron; run_retention runs every night; the push requests that failed are written down every hour, by a function a signed-in user cannot run; pg_cron keeps three days of its runs` — `NOT PROTECTED` or `BROKEN` means roll back; `NOT THERE` or a message that does not start with `check only` means stop and report;
8. a minute later, the audit once more: **line 13 must read `sl-rest-push: succeeded`, a few seconds ago.** `failed`, or still `no run yet` after two minutes: roll back and report the line;
9. in the app, as an athlete with notifications on: a rest of a minute with the phone locked rings **once**, at its end — twice, or ten seconds early, means the `send-push` that is deployed is the one from before wave 2: roll back at once — and a rest of three minutes rings too;
10. the morning after: the audit of migration 18 reads `0`, or a handful, on lines 8, 12 and 15, and line 13 of the audit of migration 19 reads `sl-retention: succeeded`.

Say with the rollback of migration 19, in the words of its page: it removes the four jobs and the function and leaves the extension on; a rest the app of wave 3 scheduled while the answer was `mode: cron`, and whose time has not come, does not ring — roll back when line 14 of the audit reads `0`, or at an hour nobody trains; what the jobs deleted does not come back; it is never refused for a later migration, and it also runs where the extension was switched off first.

## docs/RUNBOOK.md — Who runs a checkpoint

Replace, in the list that starts "What that answer does not cover — each of these is asked again, every time:", the item "- enabling an extension (pg_cron);" with:

- enabling an extension (pg_cron) — and with it the optional migration 19, which from its first night on deletes the old rows without a question: [runbook/50-pg-cron.md](runbook/50-pg-cron.md) is what the answer is given on. Pausing a job, and the rollback of migration 19, are asked the same way;

## docs/RUNBOOK.md — By hand in the SQL editor, from these checkpoints on

Add when Checkpoint B is handed over, after the row "| B (18) |" (folded from `sql-13a-retention`):

| B (19), only where pg_cron is switched on | the jobs are looked at, switched off for a while and switched on again with the statements of the page; the monthly routine of the row above is no longer needed while `sl-retention` runs | [50](runbook/50-pg-cron.md), "Looking at the jobs", "Pausing a job, and starting it again", "Turning it off" |
