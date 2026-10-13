# sql-13a-retention — docs to fold (wave 2, items L27)

Each block: target doc, section, then the text to fold in.

## docs/INVARIANTS.md — RLS / DB conventions

Add after the bullet that starts "**Nothing is read or written without a session.**":

- **Rows nobody reads any more are deleted by `run_retention()`, by their age — and nothing an athlete trained is ever deleted that way.** Three tables fill by themselves and nothing deleted a row of them (review L27): `scheduled_pushes`, `notifications`, `client_errors`. Since migration `2026_10_13_18_retention.sql` one function deletes a rest push 7 days after it was written — never one that is still to be sent: `status = 'pending' AND canceled_at IS NULL AND fire_at > now() - interval '60 seconds'`, what `claim_rest_push` would still hand to a sender —, a notification 90 days after its recipient READ it — never one that was not read —, and a client error 90 days after it was reported, and answers `{ "scheduled_pushes": n, "notifications": n, "client_errors": n }`. Every table of `public` is in one of the two lists of `supabase/tests/retention.test.js` — `DELETED_BY_A_RUN` with its age, `KEPT_FOR_GOOD` with the reason — and the test fails on a table that is in neither: a new table that grows with events gets its `DELETE` in that function, and a table of training never does. The 7 days are also the age at which `schedule_rest_push` deletes the caller's own rows; the test holds the two to the same rows.
- **`run_retention()` is run by the owner or by a job, and waits for nobody.** Nothing calls it: no trigger, no other function, no app, and applying a migration never does — the test refuses a function of `public` whose text names it. The owner runs it once a month (`docs/runbook/70-admin-procedures.md`), or the nightly pg_cron job of the optional migration 19 does; without a run nothing breaks, the rows wait. It is `SECURITY INVOKER` and executable by its owner and the service role only (`NOT_FOR_USERS` of `function-acl.test.js`): given to `authenticated` it would delete what that user's policies allow — their own rest pushes — and nothing else. Each of its `DELETE`s takes its rows through `FOR UPDATE SKIP LOCKED`, so a row another request holds — an account that is starting its next rest — is passed over and goes with the next run: a run never blocks the app and never deadlocks with it.

## docs/INVARIANTS.md — Messaging / notifications

Add after the bullet that starts "**A notification about something the athlete can take back is removed with it, while it is unread.**":

- **The bell is not a history: a line its recipient read more than 90 days ago is deleted.** `run_retention()` (migration `2026_10_13_18_retention.sql`) deletes a notification 90 days after `read_at` — counted from when it was read, so a line opened today stays 90 days however old it is — and never one whose `read_at` is NULL. The unread count never moves because of it, and the list of the 30 most recent lines changes only for an account with fewer than 30 newer ones. A screen that must show what happened long ago reads the thing itself — the confirmation, the message, the swap — not its notification. The delete reaches an open app as a realtime `DELETE` event, which `useNotificationsRealtime` ignores (no `recipient_id` on it): the line leaves the bell at its next load.

## docs/INVARIANTS.md — Web Push (rest-timer "Rest done" lock-screen notification)

Add after the bullet that starts "**More than a minute late is never sent.**" (folded from `sql-11-rest-push-scheduling`):

- **A rest push is gone a week after it was written.** `scheduled_pushes` is the queue of the rests that are to ring, not a record of the rests an athlete took: `schedule_rest_push` deletes the caller's own rows older than 7 days when they next rest, and `run_retention()` (migration `2026_10_13_18_retention.sql`) deletes everybody's — also the rows the app from before wave 3 inserts itself, which nothing else deletes. Whatever became of the row: `sent`, `failed`, `canceled`, `expired`, left `sending`. The one exception is a row that is still to be sent, which only a phone whose clock is days ahead can leave behind. Nothing may count on a row of that table older than a week; a statistic about rests reads `set_logs`.

## docs/ARCHITECTURE.md — Auth and Row-Level Security

Add after the paragraph that starts "Two more are for the service role and the owner only:" (folded from `sql-11-rest-push-scheduling`):

`run_retention()` is for the same two and is `SECURITY INVOKER`: it deletes rows by their age in every account, and has no right of its own to do it with.

## docs/ARCHITECTURE.md — new section "Retention: what is deleted, and when", after the section "Rest push: scheduled by the database, sent once"

````markdown
## Retention: what is deleted, and when

Most of the database is kept for good: what a coach planned and what an athlete trained are the point of the app, and no row of them is deleted by its age. Three tables are different — one row per event, of use for a while and of none afterwards:

| Table | What a row is | Of use until | Deleted |
|---|---|---|---|
| `scheduled_pushes` | the end of one rest, to ring on a locked phone | it is sent, taken back, or a minute late | 7 days after it was written — never while it is still to be sent |
| `notifications` | a line of the bell | its recipient has read it | 90 days after `read_at`; never while `read_at` is NULL |
| `client_errors` | what the app reported when it broke | the coach has looked at the list | 90 days after it was reported |

One function does it, `public.run_retention()` (migration `2026_10_13_18_retention.sql`), and answers how many rows of each table it deleted. Nothing calls it. The owner of the database runs it once a month — `docs/runbook/70-admin-procedures.md`, which is also where every other thing the owner does by hand is listed — or, where pg_cron is enabled and the optional migration 19 applied, a job runs it every night. A month without a run costs nothing but the rows that wait.

Two things bound a table without it. `schedule_rest_push` deletes the caller's own rest pushes older than 7 days at the start of every rest, so with the app that calls it only the rows of accounts that stopped training are left for a run; the app from before wave 3 inserts its rows itself, and those wait for a run. And pg_net deletes the answers of the requests the database sends (`net._http_response`) by itself, six hours after they arrive.

A run is safe next to the app: each `DELETE` takes its rows through `FOR UPDATE SKIP LOCKED`, so it never waits for a request that holds one — and that row goes with the next run. Every table of `public` is listed in `supabase/tests/retention.test.js` as deleted by a run, with its age, or as kept for good, with the reason.
````

## CLAUDE.md — Repo map

Replace, in the `docs/` block, the line "runbook/ (00-before-you-start.md  20-auth-config.md  30-edge-functions.md  40-deploy.md" with:

runbook/ (00-before-you-start.md  20-auth-config.md  30-edge-functions.md  40-deploy.md  70-admin-procedures.md

## CLAUDE.md — When to load the other docs

Replace, in the bullet that starts "**`docs/RUNBOOK.md`** (+ `docs/runbook/`)", the text "the checkpoints, which migrations each one applies, the Auth dashboard steps." with:

the checkpoints, which migrations each one applies, the Auth dashboard steps, and — `docs/runbook/70-admin-procedures.md` — what the owner does outside a checkpoint: the monthly run of `run_retention()`, and where the statement for each other case is written.

## CLAUDE.md — Feature → files map, new row after "Error telemetry"

Add the row:

| Retention (rows deleted by their age: rest pushes after 7 days, read notifications and client errors after 90; by the owner once a month, or by the nightly pg_cron job of the optional migration 19) | `supabase/schema.sql` section "RETENTION: THE ROWS NOBODY READS ANY MORE" (`run_retention()` — `SECURITY INVOKER`, for the owner and the service role, three `DELETE`s through `FOR UPDATE SKIP LOCKED`, answers `{ scheduled_pushes, notifications, client_errors }`), migration `2026_10_13_18_retention.sql`, `docs/runbook/70-admin-procedures.md` ("Once a month" — the audit of migration 18, the run, the audit again; and the table of every other statement the owner has), `docs/runbook/migrations/18-retention.md` ("A rest push that is kept"), `supabase/tests/retention.test.js` (`DELETED_BY_A_RUN` / `KEPT_FOR_GOOD` — every table of `public` in one of the two), `supabase/migrations/README.md` ("A migration that deletes rows by their age"). Nothing in `src/` calls it |

## CLAUDE.md — Feature → files map, row "Error telemetry"

Add at the end of the row's file list:

; rows older than 90 days are deleted by `run_retention()` (the "Retention" row)

## CLAUDE.md — Feature → files map, row "Notifications (in-app bell)"

Add at the end of the row's file list:

; a line read more than 90 days ago is deleted by `run_retention()`, one that was never read stays (the "Retention" row)

## CLAUDE.md — Feature → files map, row "DB / RLS test suite (`npm run test:db`)"

Add before the sentence "The migration tests are the next row.":

`retention.test.js` (`run_retention`: `DELETED_BY_A_RUN` and `KEPT_FOR_GOOD` — every table of `public` as deleted by a run, with its age, or kept for good, which a new table must join; each age to the second; a rest push that is still to be sent kept, by what `claim_rest_push` would answer; a notification that was never read kept; the 7 days against those of `schedule_rest_push`; every kind of caller, and what a grant to a signed-in user by mistake would give; a row another request holds passed over, and a rest that starts while a run is under way, on two connections; the bell and the coach's list of errors as the deployed app reads them, before and after a run; the links of `docs/runbook/70-admin-procedures.md`; migration `2026_10_13_18_retention.sql` tried on the frozen baseline with the audit table, the check and the statements of its runbook page and the monthly routine of page 70 read off the pages).

## CLAUDE.md — When you add a feature

Add to step 2, at the end of the bullet that starts "A table that is created follows":

It also joins `KEPT_FOR_GOOD` or `DELETED_BY_A_RUN` in `supabase/tests/retention.test.js` — and, in the second case, gets its `DELETE` in `run_retention()` ("A migration that deletes rows by their age" in `supabase/migrations/README.md`) — or that file fails.

## README.md — Database Tests

Add after the bullet that starts "- `replay-grace.test.js` holds" (folded from `sql-12-replay-grace`):

- `retention.test.js` holds "the rows nobody reads any more are deleted by one function, and nothing else is". A test cannot wait 90 days: it writes rows with the dates of the past, as the owner — `push(q, user, { age: '8 days', status, due, takenBack })`, `line(q, user, { written, read })`, `report(q, user, age)` — and inside a `scenario()` the clock is one instant, so "exactly 7 days ago" is exact. `left(q, table, planted)` answers the labels of the rows that are still there. Its two lists, `DELETED_BY_A_RUN` and `KEPT_FOR_GOOD`, name every table of `public`: a new table joins one of them.

## docs/RUNBOOK.md — new section "Checkpoint B — …", after the section of Checkpoint A3

Add when Checkpoint B is handed over (its row marked **ready**), after the part that belongs to migration 17. The part of the sequence that belongs to migration 18, the last `required` one of the checkpoint, every command taken from `docs/runbook/migrations/18-retention.md` as it stands there, one per fence. It needs nothing but migration 17, no app and no Edge Function needs it, and the optional migration 19 needs it.

1. the audit of migration 18 — it reads as the "before" column of the page's table. **Line 2 must read `no` and line 3 `none`**: otherwise stop and report, the migration refuses to run. Lines 4 to 6 read `it is not there`. **Lines 7 to 15 are noted**: the rows of the three tables, and on lines 8, 12 and 15 what a run of the function deletes. None of them stops the migration; line 10 reads `0`, and when it does not the page's section "A rest push that is kept" says what it means;
2. the migration;
3. the audit again — lines 2, 4, 5 and 6 read as the "after" column, **lines 7 to 15 are the numbers of step 1**: the migration deletes no row;
4. the ledger: eighteen rows, the last one `2026_10_13_18_retention`;
5. the page's check, which must fail with `check only, nothing was written: in place: a run deletes the rest pushes older than 7 days, the notifications read more than 90 days ago and the client errors older than 90 days; it keeps what is more recent, a rest push that is still to be sent and a notification that was never read; a signed-in user cannot run it` — `NOT PROTECTED` or `BROKEN` means roll back and do not run the function; `NOT THERE` or a message that does not start with `check only` means stop and report;
6. the audit a last time: lines 7 to 15 are still the numbers of step 1 — the check ran the function for real, and undid it;
7. nothing to look at in the app: every screen is what it was.

**The first run is not a step of the checkpoint.** `select public.run_retention()` deletes rows of the app that do not come back — on the first run nearly every rest push there is: it is one of the statements that are asked each time ("Who runs a checkpoint"). What is passed on at the end of the checkpoint says how many rows lines 8, 12 and 15 count, and that the routine of `docs/runbook/70-admin-procedures.md`, "Once a month", is waiting for an answer. The backup of the checkpoint is the one that holds those rows.

Say with the rollback of migration 18, in the words of its page: it drops the function and reopens L27; nothing anybody sees changes; what a run deleted does not come back; it is refused once migration 19 is in the ledger.

## docs/RUNBOOK.md — Who runs a checkpoint

Add when Checkpoint B is handed over, to the list that starts "What that answer does not cover — each of these is asked again, every time:", after the item that starts "a statement that a page gives beside its migration":

- a run of `run_retention()` — the first one after migration 18, and each month after it — and every other procedure of [runbook/70-admin-procedures.md](runbook/70-admin-procedures.md): they are done outside a checkpoint, and each deletes or writes rows that do not come back;

## docs/RUNBOOK.md — By hand in the SQL editor, from these checkpoints on

Add when Checkpoint B is handed over, before the table of the section:

Since Checkpoint B these statements, and the one routine among them, have a page of their own: [runbook/70-admin-procedures.md](runbook/70-admin-procedures.md) — what you want to do, and where its statement is written.

## docs/RUNBOOK.md — By hand in the SQL editor, from these checkpoints on

Add when Checkpoint B is handed over, after the last row of the table:

| B (18) | once a month — until the nightly job of the optional migration 19 runs, if it ever does — the rows nobody reads any more are deleted with one statement: rest pushes older than 7 days, notifications read more than 90 days ago, client errors older than 90 days. Read-only look before, the run, the look again | [70](runbook/70-admin-procedures.md), "Once a month: delete what nobody reads any more"; [18](runbook/migrations/18-retention.md), "A rest push that is kept" |
