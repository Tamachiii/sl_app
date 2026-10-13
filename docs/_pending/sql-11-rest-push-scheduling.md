# sql-11-rest-push-scheduling — docs to fold (wave 2, items P10, B14)

Each block: target doc, section, then the text to fold in.

## docs/INVARIANTS.md — Web Push (rest-timer "Rest done" lock-screen notification)

Replace, in the bullet that starts "**Live Activities / Dynamic Island are native-iOS-only.**", the text from "and `scheduled_pushes` (one row per pending notification" to the end of the bullet with:

and `scheduled_pushes` (one row per rest whose end is to ring: `fire_at`, `payload`, `endpoint`, `status`, `canceled_at`, `sent_at`, `dispatched_at`). Both were added in [2026_05_11_push_notifications.sql](../supabase/migrations/2026_05_11_push_notifications.sql); there are no triggers on either. An account writes its own rows through RLS — the app from before wave 3 does — and since migration `2026_10_13_16_rest_push_scheduling.sql` four functions hold the rest push: the next bullets.

## docs/INVARIANTS.md — Web Push (rest-timer "Rest done" lock-screen notification)

Add after the bullet that starts "**Live Activities / Dynamic Island are native-iOS-only.**":

- **A rest push is sent by whoever `claim_rest_push(id)` answers the row to, and by nobody else.** The function (migration `2026_10_13_16_rest_push_scheduling.sql`, service role only) moves the row from `pending` to `sending` and answers `{ id, user_id, payload, endpoint, fire_at }` — once. A second caller gets NULL, and so does a caller that asks for a row that was canceled or whose time is more than a minute past. There are two ways to send on purpose — the `dispatch-rest-push` Edge Function, and a pg_cron job through `send-push` — and an app from before wave 3 calls the Edge Function whatever the mode: the claim is what makes one notification of them. A sender asks at the time of the push, sends only what it was answered, then writes `sent` (and `sent_at`) or `failed` (and `error`) on that row. It never sends a row it merely read and never writes `sending` itself. `supabase/tests/rest-push.test.js` has the test on two connections.
- **A row is canceled when its status says so OR `canceled_at` is set.** The app from before wave 3 cancels with `UPDATE … SET canceled_at` and leaves the row `pending`; `cancel_rest_push` writes both. Whatever asks "is this row still to be sent" asks `status = 'pending' AND canceled_at IS NULL`.
- **The time of a rest push is the server's, and one account has one rest waiting.** `schedule_rest_push(p_seconds, p_payload, p_endpoint)` writes `fire_at = now() + p_seconds` — 1 to 900 seconds, in both modes — closes every row the caller still had `pending` (`canceled`; `expired` for one nobody had sent a minute after its time), deletes the caller's rows older than 7 days, and answers `{ id, fire_at, mode }`. Two calls of one account at the same instant are served one after the other. `mode` is `'cron'` only while `cron.job` holds an active job named `sl-rest-push`; otherwise `'edge'`, and the app must then call `dispatch-rest-push` with `{ scheduleId: id }` or nobody sends. Answering `'edge'` when the job does run costs one function call and never a second push.
- **The job hands a row over once, and leaves it `pending`.** `dispatch_due_rest_pushes()` — what the pg_cron job runs every ten seconds, and nothing else calls — passes each row that is waiting, not canceled, not handed over yet and due within ten seconds to `send_push_event` with `{ schedule_id, not_before, endpoint, ttl: 60, urgency: 'high' }` (`endpoint` left out when the row names none), and stamps `dispatched_at` in the same step. `send-push` waits until `not_before` and claims then, so a rest that ends early in those ten seconds is still taken back. Do not make the job claim, and do not make it hand a row over twice: a `send-push` that does not know `schedule_id` — the one from before wave 2 — sends at once and marks nothing, and would ring every ten seconds. **So the order of switching on is fixed: migration 16, then the two Edge Functions of wave 2, then pg_cron and migration 19.**
- **More than a minute late is never sent.** A row still `pending` 60 seconds after `fire_at` is closed as `expired` (`canceled` when `canceled_at` is set) — by the job, by `claim_rest_push` when it is asked for that row, by the next rest of its account. `interval '60 seconds'` is written in those three functions; a change is a change of all three. `expired` rows are the measure of rest pushes nobody sent; a row left `sending` is a sender that claimed and never reported.
- **An account names a device of its own.** `scheduled_pushes.endpoint` is where the push goes: one of the caller's `push_subscriptions`, or NULL for every device of the account. `schedule_rest_push` refuses anything else (`device_not_registered`), and the `INSERT` and `UPDATE` policies of the table ask the same of a row written directly. A sender reads the devices of the row's `user_id`, then filters by the endpoint — never by the endpoint alone: a device that changed hands since is no longer that account's.

## docs/INVARIANTS.md — Web Push (rest-timer "Rest done" lock-screen notification)

Replace the bullet that starts "**Delays > 350s are refused.**" with:

- **A rest is 1 to 900 seconds for the database; the 350 s clamp is the app's and the deployed function's.** `schedule_rest_push` refuses a rest outside 1–900 seconds (`rest_seconds_out_of_range`) in both modes: 15 minutes is what the Edge Function can wait for, in hops, where no job runs. The app from before wave 3 (`useRestTimerPush`) and the `dispatch-rest-push` deployed before wave 2 still clamp at 350 s, and that function still waits inside one request, which the platform ends after 150 seconds: with them a rest of 150 seconds or more gets no push, only the in-app beep and the wake lock.

## docs/ARCHITECTURE.md — Auth and Row-Level Security

Replace, in the row of the table that starts "| `authenticated` | the allow-list:", the text "`ensure_set_logs`, `claim_push_subscription`)" with:

`ensure_set_logs`, `claim_push_subscription`, `schedule_rest_push`, `cancel_rest_push`)

## docs/ARCHITECTURE.md — Auth and Row-Level Security

Add after the paragraph that starts "One function is on no list on purpose:":

Two more are for the service role and the owner only: `claim_rest_push(p_id)`, which hands a rest push to whoever sends it — once — and `dispatch_due_rest_pushes()`, which the optional pg_cron job runs. The first is `SECURITY INVOKER`; the second calls `send_push_event` and is therefore `SECURITY DEFINER`.

## docs/ARCHITECTURE.md — new section "Rest push: scheduled by the database, sent once", after the section "Auth and Row-Level Security"

Add:

````markdown
## Rest push: scheduled by the database, sent once

The end of a rest is a row of `scheduled_pushes`. Migration `2026_10_13_16_rest_push_scheduling.sql` gave the table its state machine and the four functions that move a row through it; `supabase/tests/rest-push.test.js` holds them.

```
                 schedule_rest_push / the INSERT of an app from before wave 3
                                     │
                                  pending ──── cancel_rest_push, the next rest, ───▶ canceled
                                     │         or canceled_at written by an old app
              claim_rest_push(id)    │
              at the time of the push│         a minute after fire_at, unclaimed ───▶ expired
                                     ▼
                                  sending ──── the sender reports ───▶ sent | failed
```

**What the app calls** (a signed-in account; both functions are `SECURITY DEFINER` and ask who calls first):

| Call | Answer | Notes |
|---|---|---|
| `schedule_rest_push(p_seconds int, p_payload jsonb, p_endpoint text default null)` | `{ id, fire_at, mode }` | `fire_at` is `now() + p_seconds` on the server; `p_endpoint` is this device's push endpoint (left out or NULL: every device of the account); `mode` is `'cron'` or `'edge'` |
| `cancel_rest_push(p_id uuid)` | `{ canceled: true \| false }` | `false` is not an error: the row was sent, is being sent, is closed, or is not the caller's |

Refusals: `not authorized` (`42501`, no user id), and with `P0001` the fixed words `rest_seconds_out_of_range` (not 1–900), `payload_invalid` (not a JSON object, or over 2000 bytes) and `device_not_registered` (the endpoint is not one of the caller's `push_subscriptions` — or none was sent and the caller has no device). With `mode: 'edge'` the app then invokes the `dispatch-rest-push` Edge Function with `{ scheduleId: id }`; with `'cron'` it does nothing more. Where the functions are missing (`PGRST202`) the app falls back on its own `INSERT` and its own `UPDATE … SET canceled_at`, which the table's policies still allow.

**What a sender does** (the service role):

1. wait until `fire_at` — the Edge Function by its own means, `send-push` until the `not_before` it was handed;
2. `claim_rest_push(p_id)` → `{ id, user_id, payload, endpoint, fire_at }`, or NULL. NULL means: not yours — somebody else took it, it was canceled, it is more than a minute late, or it does not exist. Stop;
3. read `push_subscriptions` of `user_id`; when `endpoint` is not null keep the one with that endpoint. No device left: record `failed`;
4. send `payload` as it is, with a time-to-live of 60 seconds and high urgency;
5. record the outcome on the row, which is `sending`: `status = 'sent'` and `sent_at`, or `status = 'failed'` and `error`.

**The two modes.** Without pg_cron the app starts the sender itself (`mode: 'edge'`). With the optional job `sl-rest-push`, `dispatch_due_rest_pushes()` runs every ten seconds: it closes the rows more than a minute late and hands each row due within ten seconds to `send_push_event`, whose body `send-push` receives as `{ user_id, payload, schedule_id, not_before, endpoint?, ttl: 60, urgency: 'high' }`. The row is stamped `dispatched_at` and stays `pending`: `send-push` answers at once, waits until `not_before` and goes through steps 2 to 5. An app from before wave 3 still calls `dispatch-rest-push` for its own rows in either mode; step 2 decides which of the two sends.

**What bounds the table.** An account's rows older than 7 days are deleted when it next rests; rows are never deleted by a sender.
````

## CLAUDE.md — Feature → files map, row "Rest timer (in-app cues + Web Push)"

Replace the row's file list with:

`hooks/useRestTimer`, `hooks/useRestTimerEffects`, `hooks/useRestTimerPush`, `student/RestTimerBanner`, `student/SessionView`, `supabase/functions/dispatch-rest-push/`. The database's side of the push is migration `2026_10_13_16_rest_push_scheduling.sql`: `schedule_rest_push` / `cancel_rest_push` (the app), `claim_rest_push` (whoever sends, once), `dispatch_due_rest_pushes` (the optional pg_cron job `sl-rest-push`), and `scheduled_pushes.status` / `endpoint` / `dispatched_at`; `supabase/tests/rest-push.test.js` holds it, and `supabase/migrations/README.md` ("A migration that schedules, sends or takes back a rest push") has the rules

## CLAUDE.md — Feature → files map, row "DB / RLS test suite (`npm run test:db`)"

Add before the sentence "The migration tests are the next row.":

`rest-push.test.js` (the four functions of the rest push next to the requests of the app and of the `dispatch-rest-push` that are deployed; two senders, a cancel and a claim, two rests of one account that cross — on two connections; the pg_cron table of jobs made by the test, `makeCron`; migration `2026_10_13_16_rest_push_scheduling.sql` on the frozen baseline with a table as months of the app left it).

## CLAUDE.md — When you add a feature

Add to step 3, after the bullet that starts "A new Edge Function is a directory under `supabase/functions/`":

   - Whatever sends a rest push — an Edge Function, a job — asks `public.claim_rest_push(id)` at the time of the push and sends only the row it is answered; it never sends a row it merely read from `scheduled_pushes` and never writes `status = 'sending'` itself (`supabase/migrations/README.md`, "A migration that schedules, sends or takes back a rest push").

## README.md — Rest Timer (in-app + Web Push)

Replace "The DB tables ([2026_05_11_push_notifications.sql](supabase/migrations/2026_05_11_push_notifications.sql)) are RLS-scoped to the owning user." with:

The DB tables ([2026_05_11_push_notifications.sql](supabase/migrations/2026_05_11_push_notifications.sql)) are RLS-scoped to the owning user. Since migration 16 the database also holds the schedule itself: `schedule_rest_push` computes the time on the server for one device and says who sends (`mode` `cron` or `edge`), `cancel_rest_push` takes a rest back, and whoever sends asks `claim_rest_push` first, which answers a row once — never a canceled one, never one more than a minute late. The app and the Edge Function described above do not use them yet.

## README.md — Database Tests

Replace "- `rpc-auth.test.js` calls the five coach-only SECURITY DEFINER RPCs as every kind of caller. A new SECURITY DEFINER function that a client can call must be added to its table of calls: the test that lists them fails otherwise." with:

- `rpc-auth.test.js` calls the five coach-only SECURITY DEFINER RPCs as every kind of caller, and the four that act for the account that calls (`ensure_set_logs`, `claim_push_subscription`, `schedule_rest_push`, `cancel_rest_push`) as every caller without a user id. A new SECURITY DEFINER function that a client can call must be added to its table of calls, and one that no client can call to `NOT_FOR_A_CLIENT` with the reason: the test that lists them fails otherwise.

## README.md — Database Tests

Add after the bullet that starts "- `ensure-claim.test.js` holds the two functions that write for the account that calls.":

- `rest-push.test.js` holds "the end of a rest is scheduled by the database, and a rest push is sent once". The requests of the app and the statements of the `dispatch-rest-push` function that are deployed are written out in it (`app`, `deployedFunction`), because the migration is applied while both are live. A row is put into any state with `plant(q, user, secondsFromNow, { status, takenBack, endpoint, handedOver, daysOld })` and read back as one word (`stateOf`: `'pending handed-over'`, `'canceled taken-back'`). pg_cron is not in the suite: the tests about `mode` make its table of jobs themselves (`makeCron`, `job`). Requests that cross — two senders, a cancel and a claim, two rests of one account, the job and a row that is held — commit, on the rows of one athlete, and delete them again.

## docs/RUNBOOK.md — new section "Checkpoint B — …", after the section of Checkpoint A3

Add when Checkpoint B is handed over (its row marked **ready**), after the part that belongs to migration 15. The part of the sequence that belongs to migration 16, every command taken from `docs/runbook/migrations/16-rest-push-scheduling.md` as it stands there, one per fence. **It comes before the two Edge Functions of wave 2 are deployed** — they call `claim_rest_push`, which this migration creates — and before migration 19, if pg_cron is chosen.

1. the audit of migration 16 — it reads as the "before" column of the page's table. **Line 3 must read `none`, line 8 `canceled, failed, pending, sent`, line 11 `yes`, and lines 2, 9 and 10 `no`**: otherwise stop and report, the migration refuses to run. **Lines 12 to 17 are noted**: the rows by status, how many have been waiting since the request that was to send them ended (13) and how many of those their athlete had taken back (14), the oldest (15), the rests that are running (16), the rows older than 7 days (17). None of them stops the migration. Line 18 says whether pg_cron is already installed;
2. the list of the page's section "The rest pushes that were left waiting", for the record: one line per account;
3. the migration;
4. the audit again — lines 2, 5, 6, 8, 9 and 10 read as the "after" column, lines 13 and 14 read `0`, and line 12 shows the rows of line 13 under `expired` and `canceled`;
5. the ledger: sixteen rows, the last one `2026_10_13_16_rest_push_scheduling`;
6. the page's check, which must fail with `check only, nothing was written: in place, mode edge: a rest push is scheduled at the time of the server for a device of its account, taken back by its account only, and handed to a sender once — never after it was taken back, never more than a minute late` — `NOT PROTECTED` or `BROKEN` means roll back; `NOT THERE` or a message that does not start with `check only` means stop and report; `in place, mode cron` before migration 19 means a job named `sl-rest-push` was made by hand: report it;
7. in the app, as an athlete with notifications on: a rest of a minute or less with the phone locked rings as before. A rest of three minutes still does not: that comes with the Edge Functions of wave 2, and is checked after their deploy.

Say with the order: **migration 16, then `send-push` and `dispatch-rest-push` of wave 2, then — only if pg_cron is chosen — the extension and migration 19.** The job of migration 19 hands a row to `send-push` ten seconds before its time, with the time not to send before; the `send-push` deployed before wave 2 does not know that, and would ring every device of the athlete at once, ten seconds early. Without pg_cron nothing is lost: the app calls `dispatch-rest-push`, which waits in hops of two minutes.

Say with the rollback of migration 16, in the words of its page: not once the Edge Functions of wave 2 are deployed, unless the ones from before are deployed again first — they ask `claim_rest_push` before they send; rows that are `expired` or `sending` become `failed` with a sentence in `error`, the rows the migration closed are not reopened, and no row is deleted.
