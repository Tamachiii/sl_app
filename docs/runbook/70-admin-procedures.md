# 70 — By hand, outside a checkpoint: what the owner of the database does

| | |
|---|---|
| Where | the Supabase CLI from the root of this checkout, or the dashboard's SQL editor — as `postgres` |
| Kind | statements that write or delete rows of the app, each run when its case comes up · no migration, nothing to deploy |
| Wave / checkpoint | none: any day after the migration a procedure needs is applied |
| Routine | one: [once a month](#once-a-month-delete-what-nobody-reads-any-more), from migration 18 on |

This page is for the person who owns the Supabase project. Some things no screen of the app does, because nobody who is signed in may do them: making a coach, moving an athlete, deleting what an athlete trained, deleting old rows. They are done here, by you — or by Claude when you have asked for that one thing: none of them is part of a checkpoint, and each is asked again every time (`docs/RUNBOOK.md`, "Who runs a checkpoint").

Each of them writes rows that do not come back. Take the backup first: [00 — Before you start](00-before-you-start.md), section 2.

## Where each procedure is written

A procedure that belongs to a rule of the database is written on the page of the migration that brought the rule, next to what the rule refuses, and a test reads its statements off that page. This table says where.

| What you want to do | Where | From migration |
|---|---|---|
| link an athlete to a coach — the last step of adding an athlete | [05 — Linking an athlete to a coach](migrations/05-students-role-gate.md#linking-an-athlete-to-a-coach) | 05 |
| make an account a coach | [07 — Making a coach](migrations/07-profile-rules.md#making-a-coach) | 07 |
| give a name to an account that has none | [07 — Accounts without a name](migrations/07-profile-rules.md#accounts-without-a-name) | 07 |
| see who has an account | [20 — Who has an account](20-auth-config.md#who-has-an-account) | — |
| move an athlete to another coach | [10 — Moving an athlete to another coach](migrations/10-goals-fk-coach-links.md#moving-an-athlete-to-another-coach) | 10 |
| hand the goals of an athlete over to the coach of today, after a link was rewritten by hand | [10 — Goals left with a former coach](migrations/10-goals-fk-coach-links.md#goals-left-with-a-former-coach) | 10 |
| remove a coach's account | [10 — Removing a coach's account](migrations/10-goals-fk-coach-links.md#removing-a-coachs-account) | 10 |
| take a review back | [09 — Taking a review back](migrations/09-review-lifecycle.md#taking-a-review-back) | 09 |
| let an athlete write a reviewed session again | [08 — Letting an athlete write a reviewed session again](migrations/08-session-write-gates.md#letting-an-athlete-write-a-reviewed-session-again) | 08 |
| add the sets a reviewed session lacks | [08 — Adding the sets a reviewed session lacks](migrations/08-session-write-gates.md#adding-the-sets-a-reviewed-session-lacks) | 08 |
| delete training an athlete has logged | [04 — Deleting training history on purpose](migrations/04-logged-history-guards.md#deleting-training-history-on-purpose) | 04 |
| correct a column an athlete cannot write | [06 — Correcting one of these columns by hand](migrations/06-pin-student-writes.md#correcting-one-of-these-columns-by-hand) | 06 |
| switch off a block that is in the trash and still active, or number again the sessions or phases a lost request left parked | [11 — A block in the trash that is still active](migrations/11-activate-reorder-rpcs.md#a-block-in-the-trash-that-is-still-active), [11 — Sessions or phases left parked](migrations/11-activate-reorder-rpcs.md#sessions-or-phases-left-parked) | 11 |
| close a block for its athlete before its 72 hours are over, or open it again | [17 — Closing a window early, or opening one again](migrations/17-replay-grace-window.md#closing-a-window-early-or-opening-one-again) | 17 |
| take back a rest push that is waiting for a time far ahead | [18 — A rest push that is kept](migrations/18-retention.md#a-rest-push-that-is-kept) | 16 |
| rename the secret the database sends its pushes with | [15 — Renaming the secret](migrations/15-push-plumbing.md#renaming-the-secret) | 15 |
| change the secret itself | [30 — Edge Functions](30-edge-functions.md), the section on rotating `INTERNAL_BEARER` | — |
| create a table or a function by hand | [14 — From now on: a table you create by hand](migrations/14-table-grants-lockdown.md#from-now-on-a-table-you-create-by-hand), [03 — From now on: a function you create by hand](migrations/03-function-grants-lockdown.md#from-now-on-a-function-you-create-by-hand) | 14, 03 |
| look at the jobs of pg_cron, switch one off for a while, or switch the four off for good — where pg_cron is switched on | [50 — Looking at the jobs](50-pg-cron.md#looking-at-the-jobs), [50 — Pausing a job, and starting it again](50-pg-cron.md#pausing-a-job-and-starting-it-again), [50 — Turning it off](50-pg-cron.md#turning-it-off) | — |
| delete what nobody reads any more | [below](#once-a-month-delete-what-nobody-reads-any-more) | 18 |

## Once a month: delete what nobody reads any more

Needs migration 18 ([its page](migrations/18-retention.md) says what the function is). **Not needed once the nightly job of migration 19 runs**: that migration is optional, it needs pg_cron ([50 — pg_cron](50-pg-cron.md) is the choice), and its job does every night what this section does once a month. Line 16 of the audit below says whether pg_cron is installed at all; while it reads `nobody by itself: …`, this routine is the only thing that deletes those rows.

Three tables hold rows that are of use for a while and of none afterwards. One function deletes them:

| What | When |
|---|---|
| a rest push | created more than 7 days ago — never one that is still to be sent |
| a notification | read more than 90 days ago — never one that was not read |
| a client error | reported more than 90 days ago |

Nothing else is deleted: no set, no session, no message.

**1. Look at what would go.** Read-only:

```bash
supabase db query --linked --file supabase/audits/2026_10_13_18_retention.audit.sql
```

Lines 8, 12 and 15 are the rows a run deletes now: rest pushes, notifications, client errors. Line 10 reads `0`, or [18 — A rest push that is kept](migrations/18-retention.md#a-rest-push-that-is-kept) says what it means. On the first run line 8 is nearly the whole table: nothing has deleted a rest push so far.

**2. Run it.**

```bash
supabase db query --linked "select public.run_retention()"
```

One row, with the rows it deleted: `{"client_errors": …, "notifications": …, "scheduled_pushes": …}` — the numbers of lines 15, 12 and 8.

**3. Look again**, with the command of step 1: lines 8, 12 and 15 read `0`, and lines 7, 11 and 14 are smaller by what was deleted.

What an answer means:

| Answer | Meaning | Do |
|---|---|---|
| a number smaller than its line of step 1, and that line is not `0` afterwards | another request held those rows at that instant — an athlete who was starting a rest. The function does not wait for the app | nothing: they go with the next run |
| three times `0` | nothing was past its time | nothing |
| `function public.run_retention() does not exist` | migration 18 is not in this database | read the ledger |
| `permission denied for function run_retention` | the command did not run as `postgres` | [00 — Before you start](00-before-you-start.md), section 1 |

**A month that is skipped breaks nothing**: the rows wait a month longer. While the app from before wave 3 is in use, every rest of every athlete leaves a row that only a run deletes. With the app after it, an account's rest pushes older than 7 days go when it next rests: what a run finds then is the rows of the accounts that stopped training, the read notifications and the old errors.

**What is deleted does not come back**, and nothing shows it afterwards: a line of the bell that its account read more than 90 days ago, an error older than 90 days in the list at the bottom of the coach's roster. It is in the backup taken before the run, and nowhere else.

One table needs nobody: the answers of the requests the database sends to the Edge Functions (`net._http_response`) are deleted by pg_net itself, six hours after they arrive.
