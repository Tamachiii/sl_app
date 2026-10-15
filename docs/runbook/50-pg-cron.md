# 50 — pg_cron: letting the database do things on a timer, or not

| | |
|---|---|
| Where | the Supabase dashboard (the extension), then the Supabase CLI from the root of this checkout — as `postgres` |
| Kind | a choice · one extension to switch on, then one optional migration ([19](migrations/19-pg-cron-jobs.md)) |
| Wave / checkpoint | 2 / B — after migrations 15 to 18 and after the two Edge Functions of wave 2 are deployed; or any day later; or never |
| Decision | yours. The recommendation is to switch it on |

This page is for the person who owns the Supabase project. It says what pg_cron is for in this app, what you have without it, how to switch it on, how to look at it afterwards, and how to switch it off again. Switching an extension on, and applying an optional migration, are two of the things that are asked each time (`docs/RUNBOOK.md`, "Who runs a checkpoint").

## The choice

pg_cron is an extension of the database: it runs a statement at given times — every ten seconds, every night — with nothing outside the database involved. This app has three uses for it. **Each of them works without it**, in another way:

| | Without pg_cron | With pg_cron |
|---|---|---|
| **The notification at the end of a rest** | The app asks a function outside the database (`dispatch-rest-push`) to wait until the rest is over, and that function sends. A function may run for 150 seconds at most, and a request is only sure of half of that, so for a longer rest it hands over to a copy of itself, every minute: three requests for a rest of three minutes, fifteen for one of fifteen. If one of those hand-overs is lost, the rest does not ring, and nothing tries again | The database looks every ten seconds at the rests that are about to end, and hands each to the function that sends (`send-push`) ten seconds before its time. One step, for a rest of any length up to 15 minutes |
| **The rows nobody reads any more** — old rest pushes, notifications read long ago, old errors | You delete them, once a month, with one statement ([page 70](70-admin-procedures.md#once-a-month-delete-what-nobody-reads-any-more)). A month that is skipped breaks nothing | The database does it every night |
| **A push that could not be sent** | It is in the log of the function, for whoever goes and looks | One line an hour in the list of errors at the bottom of the coach's roster |

**The recommendation is to switch it on.** The rest notification is the one thing of this app that must reach a locked phone at a precise second, and the way without pg_cron has more places where it can be lost. The two other uses are a routine you no longer have to remember, and a failure you no longer have to go looking for.

What it costs:

- **A job every ten seconds**, day and night: one short query on a small table. Nothing an athlete or a coach can notice.
- **pg_cron writes one row per run**: 8,640 a day for that job alone. The migration adds a job that keeps three days of them.
- **Old rows are deleted without a question from then on**, the first time on the night after you apply the migration: nearly every rest push there is, the notifications read more than 90 days ago, the client errors older than 90 days. They do not come back.
- **One more thing that can be switched off by accident.** Switching the extension off in the dashboard removes the jobs, and a rest then rings through the function again — for the app deployed today at once, for the app of wave 3 from its next rest on.

What does not change either way: who may read or write what, what an athlete sees, and what a backup holds.

**To stay without it: do nothing.** Migration 19 is never applied, the deploy check does not ask for it, and this page ends here for you.

## Before you switch it on

In this order, and not otherwise:

1. **Migrations 15 to 18 are applied** — Checkpoint B. The ledger says so ([00 — Before you start](00-before-you-start.md), section 5).
2. **The `send-push` and the `dispatch-rest-push` of wave 2 are deployed, and checked** — [30 — Edge Functions](30-edge-functions.md). **This is the step that must not be skipped.** The job hands a rest push to `send-push` ten seconds early, with the time not to send before. The `send-push` from before wave 2 does not know that: it would ring every device of the athlete at once, ten seconds early, and the function the app called would ring them again at the time. Nothing in the database can tell which one is deployed.
3. **A backup, taken and checked** — [00 — Before you start](00-before-you-start.md), section 2. It is the one that holds what the first night deletes.
4. **You have read what the first night deletes**: lines 8, 12 and 15 of the audit of migration 18 —

   ```bash
   supabase db query --linked --file supabase/audits/2026_10_13_18_retention.audit.sql
   ```

## 1. Switch the extension on

In the dashboard of the project: **Database → Extensions**, search for `pg_cron`, switch it on. It asks for nothing else.

Then see that it is there:

```bash
supabase db query --linked "select extname, extversion from pg_extension where extname = 'pg_cron'"
```

One row: `pg_cron`, and a version that is 1.5 or later. No row: the extension is not on.

Switching it on changes nothing by itself: no job exists yet, and a rest is still sent as before.

## 2. Apply migration 19

[19 — Where pg_cron is switched on, four jobs run on a timer](migrations/19-pg-cron-jobs.md): its audit, the file, its audit again, the ledger, and a check that says `in place`. The jobs start by themselves within seconds.

## 3. See that it runs

Steps 4 to 6 of that page: a minute later the audit shows `sl-rest-push: succeeded`, a few seconds ago; a rest of a minute rings once, on time, on a locked phone, and so does one of three minutes; and the morning after, the old rows are gone.

## Looking at the jobs

The four jobs, and whether each is switched on:

```bash
supabase db query --linked "select jobname, schedule, active, command from cron.job order by jobname"
```

| jobname | schedule | means |
|---|---|---|
| `sl-cron-history` | `47 3 * * *` | every night at 03:47 UTC |
| `sl-push-failures` | `7 * * * *` | at seven minutes past every hour |
| `sl-rest-push` | `10 seconds` | every ten seconds |
| `sl-retention` | `17 3 * * *` | every night at 03:17 UTC |

`active` reads `true` four times. A fifth line is a job somebody made by hand: this app has four.

The last three runs of each:

```bash
supabase db query --linked "select j.jobname, d.status, d.return_message, d.start_time, d.end_time from cron.job j left join lateral (select r.* from cron.job_run_details r where r.jobid = j.jobid order by r.runid desc limit 3) d on true order by j.jobname, d.runid desc"
```

`status` reads `succeeded`. A job that has not run yet has one line with nothing in it. The runs that failed, of the three days pg_cron keeps:

```bash
supabase db query --linked "select j.jobname, d.status, d.return_message, d.start_time from cron.job_run_details d join cron.job j on j.jobid = d.jobid where d.status = 'failed' order by d.runid desc limit 20"
```

No row is the answer you want. `return_message` is what the database said: report it with the name of the job.

The audit of migration 19 says the same in one line (line 13), and what the push requests of the last hours were answered (line 17):

```bash
supabase db query --linked --file supabase/audits/2026_10_13_19_pg_cron_jobs.audit.sql
```

### Pausing a job, and starting it again

A job is switched off without being removed:

```bash
supabase db query --linked "select jobname, cron.alter_job(jobid, active := false) from cron.job where jobname = 'sl-retention'"
```

and switched on again:

```bash
supabase db query --linked "select jobname, cron.alter_job(jobid, active := true) from cron.job where jobname = 'sl-retention'"
```

Each answers one row, or none when there is no job of that name. Put another of the four names in the place of `sl-retention` for another job.

What a pause means:

| Job | While it is switched off |
|---|---|
| `sl-retention` | nothing is deleted. The monthly routine of [page 70](70-admin-procedures.md#once-a-month-delete-what-nobody-reads-any-more) is yours again |
| `sl-push-failures` | no line is written. The hours pg_net still holds — six — are caught up when it is switched on again |
| `sl-cron-history` | the runs pg_cron remembers pile up, 8,640 a day and more. Not for longer than a few days |
| `sl-rest-push` | **the database sends no rest push.** `schedule_rest_push` answers `mode: edge` from the next rest on, and the app calls the function again. A rest the app of wave 3 scheduled before the pause, and whose time has not come, does not ring: pause this one at an hour nobody trains, or when line 14 of the audit reads `0` |

A job is made, changed and removed through pg_cron's own functions — `cron.alter_job` above, `cron.schedule`, `cron.unschedule`. `postgres` reads the table `cron.job` and may not write it: an `update` or a `delete` on it answers `permission denied for table job`.

## What a line of the database in the coach's list means

Under *App errors* at the bottom of the roster, a line marked `DATABASE`:

> Push: 3 of 41 requests the database sent to send-push failed between 2026-10-13 14:00 and 15:00 UTC — 2 × HTTP 502, 1 × no answer in time

It is about one hour that is over. The first number is the pushes nobody got; the second, all the pushes of that hour. One such line now and then is a phone that was unreachable. **A line every hour, or a first number close to the second, is something to repair:**

| The line says | It means | Look at |
|---|---|---|
| `HTTP 401` or `HTTP 403` | the function refused the database: the secret the database sends is not the one the function expects | [30 — Edge Functions](30-edge-functions.md), the section on rotating `INTERNAL_BEARER` |
| `HTTP 404` | there is no function at the address the database calls | [30 — Edge Functions](30-edge-functions.md): the deploy, and the address stored in the vault |
| `HTTP 500`, `HTTP 502` or another number from 500 on | the function ran and could not send: the push service refused, or the function failed | the log of `send-push` in the dashboard, at that hour |
| `no answer in time` | the function did not answer within ten seconds | the log of `send-push`; one now and then is a cold start |
| `no answer (…)` | the request did not reach a function at all. What stands between the brackets is what the database was told | the address stored in the vault, [30 — Edge Functions](30-edge-functions.md) |

What the function answered is not in the line. For six hours it is in the database:

```bash
supabase db query --linked "select created, status_code, timed_out, error_msg, left(content, 200) as answered from net._http_response where (timed_out is not true and status_code between 200 and 299 and error_msg is null) is not true order by created desc limit 20"
```

A line is written once per hour, at seven minutes past the next one; an hour without a failed request writes none. The lines go with the errors older than 90 days.

## Turning it off

**Run the rollback of migration 19 first** — [19 — Rollback](migrations/19-pg-cron-jobs.md#rollback) says what it does to the rests that are running:

```bash
supabase db query --linked --file supabase/rollbacks/2026_10_13_19_pg_cron_jobs.down.sql
```

After it the project is what it is without pg_cron: the left column of [the table at the top](#the-choice). The monthly routine of [page 70](70-admin-procedures.md#once-a-month-delete-what-nobody-reads-any-more) is yours again.

Then, only if you want the extension itself gone: **Database → Extensions**, `pg_cron`, switch it off. An extension that is on and has no job costs nothing; leaving it on is fine.

To come back: [switch it on](#1-switch-the-extension-on) if it is off, and apply migration 19 again.

### If the extension was switched off first

Then the jobs went with it: no rest push is handed over by the database any more, and from its next rest on every app calls the function again. Nothing is broken — but the database still says that migration 19 is applied, and the function that wrote the failed requests down is still there, with nothing to call it. **Run the rollback all the same**: it finds no job to remove, drops the function and takes the migration off the ledger. After that the project is as if the migration had never been applied, and it can be applied again once the extension is back.

## What a backup holds

The jobs are not in a backup: a backup is the rows of the app ([BACKUPS.md](../../BACKUPS.md)), and a job is a row of pg_cron. A database that is rebuilt has them again once the extension is switched on and migration 19 is applied — or at once, when it is installed from `supabase/schema.sql` in a project that has the extension.

The nightly backup on GitHub starts at 02:30 UTC and `sl-retention` runs at 03:17 UTC: what a night deletes is in the backup of that night.
