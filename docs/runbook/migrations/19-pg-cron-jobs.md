# 19 — Where pg_cron is switched on, four jobs run on a timer

| | |
|---|---|
| Migration | `supabase/migrations/2026_10_13_19_pg_cron_jobs.sql` |
| Audit | `supabase/audits/2026_10_13_19_pg_cron_jobs.audit.sql` |
| Rollback | `supabase/rollbacks/2026_10_13_19_pg_cron_jobs.down.sql` |
| Kind | optional · needs the extension pg_cron · adds 1 function and 4 jobs of pg_cron; no table, no column, no policy, no trigger |
| Wave / checkpoint | 2 / B — or any day after it |
| Findings | the scheduled halves of P10, L27 and P35 |
| Needs | migration 18 · the extension pg_cron, switched on · the `send-push` and the `dispatch-rest-push` of wave 2, deployed |

**This migration is a choice, and this page is the file.** Whether to apply it at all, what it costs, how to look at the jobs afterwards and how to switch them off: [50 — pg_cron](../50-pg-cron.md). Read that page first. Without this migration nothing is missing.

**Two things to know before the first command:**

- **Not before the `send-push` of wave 2 is deployed.** The job hands a rest push to `send-push` ten seconds early, with the time not to send before. The `send-push` from before wave 2 does not know that: it would ring every device of the athlete at once, ten seconds early, and the function the app called would ring them again at the time. Nothing in the database can tell which one is deployed: [30 — Edge Functions](../30-edge-functions.md) has the check.
- **From the first night on, old rows are deleted without anybody asking.** One of the jobs runs `run_retention()` at 03:17 UTC: on the first night nearly every rest push there is, the notifications read more than 90 days ago, the client errors older than 90 days. They do not come back. Lines 8, 12 and 15 of the audit of migration 18 count them ([18](18-retention.md#before-the-audit)); the backup you take before this file is the one that holds them.

## What it does

It makes four jobs of pg_cron. Each runs as `postgres`, in this database, at times that are UTC:

| Job | When | What it runs | What for |
|---|---|---|---|
| `sl-rest-push` | every 10 seconds | `select public.dispatch_due_rest_pushes()` | the function of migration 16: it closes the rest pushes more than a minute late, and hands each one due within ten seconds to `send-push`, once. While this job is there and switched on, `schedule_rest_push` answers `mode: cron`, and the app of wave 3 no longer calls the Edge Function itself |
| `sl-retention` | every night at 03:17 | `select public.run_retention()` | the function of migration 18: rest pushes older than 7 days, notifications read more than 90 days ago, client errors older than 90 days. It replaces the monthly routine of [page 70](../70-admin-procedures.md#once-a-month-delete-what-nobody-reads-any-more) |
| `sl-push-failures` | every hour at :07 | `select public.record_push_failures()` | the function of this migration, below |
| `sl-cron-history` | every night at 03:47 | one `delete` on `cron.job_run_details` | pg_cron keeps one row per run of a job and deletes none itself; `sl-rest-push` alone writes 8,640 a day. This job keeps three days of them |

And one function, **`record_push_failures()`**. A push leaves the database as a request to the `send-push` function, and nobody reads what came back: a secret that was changed on one side only, a function that is down, an answer that came too late — each is a push nobody got, and no screen says so (P35). The database keeps each answer for six hours. Once an hour this function reads them and writes **one line per hour in which a request failed** into the list at the bottom of the coach's roster, where the errors of the app already are:

> **DATABASE** — Push: 3 of 41 requests the database sent to send-push failed between 2026-10-13 14:00 and 15:00 UTC — 2 × HTTP 502, 1 × no answer in time

A request failed when it was not answered with a status between 200 and 299. Only hours that are over are written, each once; an hour without a failure writes nothing. What `send-push` answered is not copied into the line — it may name a device: it is in the log of the function. [50 — What a line of the database in the coach's list means](../50-pg-cron.md#what-a-line-of-the-database-in-the-coachs-list-means) says what to do about each kind.

The function is for the owner of the database and the service role, and runs with the rights of whoever calls it: it has none of its own.

## What the deployed client does differently

- **The app that is deployed, and every app before wave 3: nothing.** It writes its rest push itself and calls `dispatch-rest-push` whatever the mode. The job hands the same row to `send-push`; whoever sends asks the database first, which answers a row once: one notification, as before.
- **The app of wave 3** stops calling the Edge Function while the answer is `mode: cron`. A rest of any length up to 15 minutes rings without it.
- **The coach's roster** can show lines the database wrote, under *App errors*, marked `DATABASE`.
- **The bell and the list of errors** lose their old lines every night instead of once a month ([18 — What the deployed client does differently](18-retention.md#what-the-deployed-client-does-differently)).

**For somebody who calls the API by hand:**

| Who calls `record_push_failures` | Answer |
|---|---|
| nobody signed in, or any account | `permission denied for function record_push_failures` |

## Before: the audit

```bash
supabase db query --linked --file supabase/audits/2026_10_13_19_pg_cron_jobs.audit.sql
```

What it prints, before and after the migration, in a project that has pg_cron switched on:

| # | check | before | after |
|---|---|---|---|
| 1 | running as | `postgres` | `postgres` |
| 2 | pg_cron, the extension the jobs need | a version, 1.5 or later | the same version |
| 3 | what the jobs run is there (dispatch_due_rest_pushes, run_retention: migrations 16 and 18) | `yes` | `yes` |
| 4 | the push requests that failed are written down (record_push_failures, P35) | `no` | `yes` |
| 5 | functions of that name that the migration does not know | `none` | `none` |
| 6 | who may execute it, besides its owner | `it is not there` | `service_role` |
| 7 | it runs with the rights of | `it is not there` | `its caller` |
| 8 | its search_path | `it is not there` | `public, pg_temp` |
| 9 | the jobs of this migration | `none` | `sl-cron-history, sl-push-failures, sl-rest-push, sl-retention` |
| 10 | … each as the migration makes it: its schedule, its command, switched on, of postgres, in this database | `there is none` | `yes` |
| 11 | other jobs of pg_cron in this project | `none` | `none` |
| 12 | who sends a rest push | `the app, by calling dispatch-rest-push (no job named sl-rest-push is switched on: schedule_rest_push answers mode edge)` | `the job sl-rest-push, every ten seconds (schedule_rest_push answers mode cron)` |
| 13 | the last run of each job | `there is no job` | `sl-cron-history: no run yet; sl-push-failures: no run yet; sl-rest-push: no run yet; sl-retention: no run yet` |
| 14 | rest pushes that are waiting for their time | a number | a number |
| 15 | runs pg_cron remembers | a number | a number |
| 16 | … of which older than the three days sl-cron-history keeps | a number | a number |
| 17 | what the push requests of the last hours were answered | a sentence | a sentence |

If the "before" column is not what you see:

- **1** is not `postgres` — stop and report. The migration refuses to run as anyone else.
- **2** reads `not installed` — pg_cron is not switched on in this project. That is not an error: it is the choice of [page 50](../50-pg-cron.md). The migration refuses to run and changes nothing; lines 9 to 13, 15 and 16 have nothing to say, and line 12 reads `the app, by calling dispatch-rest-push (pg_cron is not installed: …)`. To go on, switch the extension on first.
- **2** is a version before `1.5` — stop and report: before 1.5 pg_cron does not run a job more often than once a minute.
- **3** is not `yes` — migration 16 or 18 is not in this database. Read the ledger (below).
- **4 already reads `yes`** — read the ledger. If migration 19 is there, you are done. If it is not, a function of that name was made by hand: stop and report.
- **5** is not `none` — **stop and report the line.** A function named `record_push_failures` with arguments exists; the migration refuses to run next to it.
- **9** is not `none` — **stop and report the line.** A job with one of the four names exists and the ledger does not know why; the migration refuses to run next to it. (The page of migration 16 says the same of `in place, mode cron` before this migration.)
- **11** is not `none` — a job somebody made in this project. It does not stop the migration, which leaves it alone.
- **14** — any number: the rests that are running right now. They ring whatever happens: the app has called the Edge Function for each of them.
- **15, 16** — `0` in a project where pg_cron was just switched on.
- **17** — `no request in the hours pg_net keeps`, or `41 requests, 3 of them failed`. It is what `record_push_failures` will write down; it does not stop the migration. `net._http_response cannot be read by this role` does: the migration refuses, stop and report.

## Apply

```bash
supabase db query --linked --file supabase/migrations/2026_10_13_19_pg_cron_jobs.sql
```

It creates a function and four rows in a table of pg_cron: no request of the app waits for it. The jobs start by themselves, within seconds.

A refusal changes nothing:

| Message contains | Meaning | Do |
|---|---|---|
| `needs the extension pg_cron, which is not switched on in this project` (code `SLM06`) | line 2 of the audit | nothing, if you mean to stay without it — or [page 50](../50-pg-cron.md#1-switch-the-extension-on), then this file again |
| `needs 2026_10_13_18_retention, which is not applied` (code `SLM02`) | migration 18 is not in the database | apply it first, with its checks |
| `must be run as postgres` | line 1 of the audit | stop and report |
| `needs pg_cron 1.5 or later` | line 2 of the audit | stop and report |
| `may not use the schema cron of pg_cron` or `may not use the schema net of pg_net` | `postgres` was not given the schema of the extension | stop and report the full message |
| `does not find what its jobs are made of, or may not use it as postgres: …` | a function or a table of pg_cron or of pg_net is not there, or `postgres` may not use it; or line 3 of the audit | stop and report the full message |
| `does not find the columns its function and its jobs are written with: …` | a column of pg_cron, of pg_net or of `client_errors` is not there under its name | stop and report the full message |
| `would not create: … is already there` | lines 4 and 5 of the audit: a function named `record_push_failures` exists | stop and report the names |
| `would not schedule: a job named … is already there` | line 9 of the audit | stop and report the names |
| `did not get the jobs it meant: …` or `did not get the function it meant: …` | the file read its own result back and it was not the one described here | stop and report the full message |

## After

1. Run the audit again. Lines 4, 6 to 10 and 12 read as the "after" column, and line 13 reads `no run yet` four times.

2. Read the ledger:

   ```bash
   supabase db query --linked "select name, applied_at from app_private.app_migrations order by applied_at, name"
   ```

   Expected: one row more than before, and the last one is `2026_10_13_19_pg_cron_jobs` — nineteen rows when the file is applied at Checkpoint B.

3. See it for yourself. This reads the four jobs. It creates an account and registers a phone for it — an address made up for the check: nothing is sent to it. Through the API's role, as that account, it schedules a rest of a minute, and tries to run the function that writes the failed requests down. Then it runs that function as you do — **for real: it writes the lines the next run of the job would have written**. Then it fails **whatever happened**, so that nothing is kept: the account, its rest, and every line. The answer is in the message:

   ```bash
   supabase db query --linked 'do $check$
   declare
     v_account uuid := gen_random_uuid();
     v_phone text := $m$https://fcm.googleapis.com/fcm/send/sl-check-19-$m$ || gen_random_uuid();
     v_jobs text;
     v_rest jsonb;
     v_lines bigint;
     v_ran jsonb;
     v_answer text;
   begin
     if to_regnamespace($m$cron$m$) is null or to_regclass($m$cron.job$m$) is null then
       raise exception $m$check only, nothing was written: NOT THERE: pg_cron is not in this database, and neither are the jobs$m$;
     end if;
     if to_regprocedure($m$public.record_push_failures()$m$) is null then
       raise exception $m$check only, nothing was written: NOT THERE: the function record_push_failures is not in the database$m$;
     end if;

     select string_agg(w.jobname, $m$, $m$ order by w.jobname)
       into v_jobs
       from (values
         ($m$sl-rest-push$m$, $m$10 seconds$m$, $m$select public.dispatch_due_rest_pushes()$m$),
         ($m$sl-retention$m$, $m$17 3 * * *$m$, $m$select public.run_retention()$m$),
         ($m$sl-push-failures$m$, $m$7 * * * *$m$, $m$select public.record_push_failures()$m$),
         ($m$sl-cron-history$m$, $m$47 3 * * *$m$, $m$delete from cron.job_run_details where runid < $m$)
       ) as w (jobname, schedule, command)
      where (select count(*) from cron.job j where j.jobname = w.jobname) <> 1
         or not exists (
           select 1 from cron.job j
            where j.jobname = w.jobname and j.schedule = w.schedule and starts_with(j.command, w.command)
              and j.active and j.username = current_user and j.database = current_database());

     insert into auth.users (id, email, aud, role)
       values (v_account, $m$sl-check-19@sl-app.invalid$m$, $m$authenticated$m$, $m$authenticated$m$);
     insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
       values (v_account, v_phone, $m$key$m$, $m$secret$m$, $m$sl-check-19$m$);

     perform set_config($m$role$m$, $m$authenticated$m$, true);
     perform set_config($m$request.jwt.claims$m$,
       json_build_object($m$sub$m$, v_account, $m$role$m$, $m$authenticated$m$)::text, true);
     v_rest := public.schedule_rest_push(60, jsonb_build_object($m$title$m$, $m$sl-check-19$m$), v_phone);
     begin
       perform public.record_push_failures();
       v_answer := $m$NOT PROTECTED: a signed-in user got into record_push_failures$m$;
     exception when insufficient_privilege then
       if sqlerrm <> $m$permission denied for function record_push_failures$m$ then
         v_answer := $m$NOT PROTECTED: a signed-in user got into record_push_failures$m$;
       end if;
     end;

     perform set_config($m$role$m$, $m$postgres$m$, true);
     perform set_config($m$request.jwt.claims$m$, $m$$m$, true);
     select count(*) into v_lines from public.client_errors ce where ce.role = $m$database$m$;
     v_ran := public.record_push_failures();
     select count(*) - v_lines into v_lines from public.client_errors ce where ce.role = $m$database$m$;

     v_answer := coalesce(v_answer, case
       when v_jobs is not null
         then $m$BROKEN: not there as the migration makes it, once, switched on: $m$ || v_jobs
       when (v_rest->>$m$mode$m$) is distinct from $m$cron$m$
         then $m$BROKEN: schedule_rest_push does not answer mode cron$m$
       when (v_ran->>$m$hours$m$) is null or (v_ran->>$m$failed$m$) is null
         or (v_ran->>$m$hours$m$)::bigint is distinct from v_lines
         then $m$BROKEN: record_push_failures did not answer how many hours it wrote a line for$m$
       else $m$in place: sl-rest-push hands the rest pushes over every ten seconds and schedule_rest_push answers mode cron; run_retention runs every night; the push requests that failed are written down every hour, by a function a signed-in user cannot run; pg_cron keeps three days of its runs$m$
     end);
     raise exception $m$check only, nothing was written: %$m$, v_answer;
   end $check$'
   ```

   The command must fail with `check only, nothing was written: in place: sl-rest-push hands the rest pushes over every ten seconds and schedule_rest_push answers mode cron; run_retention runs every night; the push requests that failed are written down every hour, by a function a signed-in user cannot run; pg_cron keeps three days of its runs`. Run before the migration, it fails with `… NOT THERE: the function record_push_failures is not in the database` — in a project without pg_cron, with `… NOT THERE: pg_cron is not in this database, and neither are the jobs` — and writes nothing either.

   Anything else is **not** the answer:

   - `… NOT THERE: …` after the migration — the migration is not in this database. Read the ledger.
   - `… NOT PROTECTED: …` or `… BROKEN: …` — **roll back**, and report the full message. `BROKEN: not there as the migration makes it …` names the jobs: one that was switched off or changed by hand since ([50 — Pausing a job, and starting it again](../50-pg-cron.md#pausing-a-job-and-starting-it-again)) reads so too, and is put back by switching it on.
   - a message that does not start with `check only` — the check could not get as far as its questions (the message says why). Nothing was written. Report it; lines 2 to 12 of the audit are then what says whether the migration is in place.

4. **A minute later, run the audit once more: line 13 is the proof that pg_cron runs the jobs.** `sl-rest-push` must read `succeeded`, a few seconds ago — and under 20 seconds whenever you look. The three others read `no run yet` until their hour comes. `sl-rest-push: failed …` says what pg_cron was told: **roll back** and report the line. Still `no run yet` after two minutes: pg_cron is not running jobs in this project — roll back and report.

5. In the app, as an athlete with notifications switched on: tick a set with a rest of a minute, lock the phone. **One** notification, at the end of the rest — not two, and not ten seconds early: either of those means the `send-push` that is deployed is the one from before wave 2. **Roll back at once**, then deploy the functions ([30 — Edge Functions](../30-edge-functions.md)). Then a rest of three minutes: it rings too.

6. The morning after, the audit of migration 18 ([its page](18-retention.md#before-the-audit)): lines 8, 12 and 15 read `0`, or a handful — the night's run deleted what was past its time. And line 13 of this audit reads `sl-retention: succeeded`, some hours ago.

## Rollback

```bash
supabase db query --linked --file supabase/rollbacks/2026_10_13_19_pg_cron_jobs.down.sql
```

It removes the four jobs and drops the function. The extension itself stays switched on: [50 — Turning it off](../50-pg-cron.md#turning-it-off) has what comes after, if anything.

After it the project is what it is without the migration: a rest push is sent through `dispatch-rest-push` again — `schedule_rest_push` answers `mode: edge` from the next rest on — `run_retention()` is run by hand once a month again ([page 70](../70-admin-procedures.md#once-a-month-delete-what-nobody-reads-any-more)), and a push request that failed is in the log of the function and nowhere else.

**The rests that are running.** A rest the app of wave 3 or later scheduled while the answer was `mode: cron` is sent by the job and by nobody else: the ones whose time has not come when the rollback runs — fifteen minutes of them at most — do not ring on a locked phone. Line 14 of the audit counts them: roll back when it reads `0`, or at an hour nobody trains. The app from before wave 3 calls the Edge Function for every rest: its rests ring whatever you do.

**What the jobs did does not come back**: the rows `run_retention()` deleted, and the runs `sl-cron-history` deleted. The lines `record_push_failures()` wrote stay in the coach's list, and go with the errors older than 90 days.

It is **not** refused while a later migration is in the ledger, unlike the other rollbacks: no migration may need this one, and its rollback is the way out of a choice. It leaves a job of another name alone. It stops, and changes nothing, when a job of one of the four names belongs to another role than `postgres`: `could not remove: …` — stop and report.

It also works where the extension was switched off before it was run — the jobs went with the extension, and the function and the row of the ledger are what is left: [50 — If the extension was switched off first](../50-pg-cron.md#if-the-extension-was-switched-off-first).
