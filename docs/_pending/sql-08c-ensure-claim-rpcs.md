# sql-08c-ensure-claim-rpcs — docs to fold (wave 1, items: none — the database's half of L8, P22 and P15, and what L6 needs)

Each block: target doc, section, then the text to fold in.

## docs/INVARIANTS.md — RLS / DB conventions

Add after the bullet that starts "**A column added to `programs`, `weeks`, `sessions`, `exercise_slots` or `set_logs` is listed in `WHAT_A_COPY_IS`**" (the one `docs/_pending/sql-08b-copy-rpcs.md` adds):

- **The missing sets of a session, and the registration of a device for notifications, each have a function that does it for the account that calls — and the app's own requests do not use them yet.** Migration `2026_10_13_13_ensure_claim_rpcs.sql` (the database's half of review L8, P22 and P15) adds two `SECURITY DEFINER` functions, executable by a signed-in user, each of which asks who calls before it does anything. `useEnsureSetLogs` still reads which sets exist and inserts the others from the exercises in its cache, so a set the coach has removed since comes back (P22); `enablePush` and `reconcilePushSubscription` still upsert `push_subscriptions` under the owner-only policies, so the second account on a shared device is refused — silently by `usePushAutoHeal`, with an error code the toggle has no words for — and the device goes on receiving the first account's notifications (P15). The contract:
  - **`ensure_set_logs(p_session_id)`** returns an `integer`: how many rows of `set_logs` it added, `0` when none was missing. For every exercise of the session it adds every number from 1 to `exercise_slots.sets` that has no row — read in the database at the moment of the call, never sent by the app — not done, with the targets of the exercise (`reps` or `duration_seconds`, `weight_kg`, `rest_seconds`), which is what the editor and `approve_program` write. A row that stands on a number is left alone, an extra set of the athlete included; nothing that exists is touched; a second call adds nothing. It refuses, before any write: `not authorized` (`42501`) when the request carries no user id or the session is not the caller's own — somebody else's session, the session of an athlete the caller coaches and no such session are the same answer; `program_not_active` when the session is the caller's in a program that is not the block being trained (a past block, a draft, a block in the trash); `session_not_writable` when the coach has archived or reviewed it. A confirmed session that is not reviewed yet is still completed.
  - **`claim_push_subscription(p_endpoint, p_p256dh, p_auth, p_user_agent default null)`** returns `{ subscription_id, outcome }`. `outcome` is `created` (nobody held the endpoint: a new row for the caller), `refreshed` (the caller held it: the keys sent are stored, `last_seen_at` is now, and the user agent is replaced unless it is left out or `null`) or `rehomed` (another account held it **with these two keys**: the row keeps its id and is the caller's now — the other account no longer reads it, and receives nothing on that device). It refuses, before any write: `not authorized` (`42501`) without a user id; `subscription_incomplete` when the endpoint or one of the two keys is `null`, empty or blank; `endpoint_keys_mismatch` when another account holds the endpoint and the keys sent are not the ones stored with it. Any signed-in account may call it — an athlete, a coach, an account nobody coaches — as any account may register a device today.
  - **The refusals other than `not authorized` are `P0001` with that fixed word as the message** (HTTP 400) and fall to `errors.generic` in `mutationErrorKey` until a hook maps them; `not authorized` reaches the toast as `errors.notAllowed`. Nothing was written in any of those cases. Keys and outcomes of the answer of `claim_push_subscription` are added, never renamed.
  - **A hook that calls `ensure_set_logs` does not call it for a session it shows as read-only**: the function refuses, and every opening of a past session would log an error. It needs no client-side list of what is missing to be correct — the function decides — only to know whether a call is worth sending.
  - **Two calls at once are harmless**: two `ensure_set_logs` for one session wait for each other's rows and the second answers `0`; two claims of one endpoint are served one after the other, and the second is judged against what the first left.
- **`app.trusted_set_log_insert` is the mark of `ensure_set_logs`, and nothing else may set it.** The function sets it to `'on'` for the transaction around its one `INSERT` and back to `'off'` before it returns. Nothing reads it yet: it is how the contract migration that will turn an athlete's own `INSERT` into an extra set without targets (review L6, Checkpoint Z) tells a prescribed set the function adds from one the athlete inserts by hand — `auth.uid()` is the athlete in both. An API user cannot set it because they run no statement of their own: a function executable by `authenticated` that sets a setting named by its caller would hand every athlete the word. `ensure-claim.test.js` reads the body of the function: one `INSERT`, between the two lines.
- **A push subscription changes hands only with its keys.** `push_subscriptions` holds one row per endpoint, and `auth` is a secret the browser shares with the database — readable by the owner of the row and by the service role only. `claim_push_subscription` moves the row of another account to the caller on that proof and on nothing else; somebody who has learnt an endpoint cannot point it at their account. The four owner-only policies of the table stay: the app deployed before wave 2 writes the table itself.

## docs/INVARIANTS.md — RLS / DB conventions

Replace, in the bullet that starts "**Students can DELETE only their own extra sets**" (as `docs/_pending/sql-05a-pin-student-writes.md` leaves it), "KNOWN residual gap: the student INSERT policy still accepts `target_*` values — it must, because `useEnsureSetLogs` materializes prescribed rows under the student JWT. Don't \"fix\" the INSERT policy without first moving that materialization server-side." with:

KNOWN residual gap: the student INSERT policy still accepts `target_*` values — it must, while `useEnsureSetLogs` materializes prescribed rows under the student JWT. The function that does it server-side exists (`ensure_set_logs`, migration `2026_10_13_13_ensure_claim_rpcs.sql`) and marks its rows with `app.trusted_set_log_insert`; the INSERT is closed by a `contract` migration once no deployed app inserts prescribed rows itself. Don't "fix" the INSERT policy before that.

## docs/INVARIANTS.md — Web Push (rest-timer "Rest done" lock-screen notification)

Replace, in the bullet that starts "**Live Activities / Dynamic Island are native-iOS-only.**", "`push_subscriptions` (per-device subscription owned by the user; full CRUD via RLS keyed on `user_id = auth.uid()`)" with:

`push_subscriptions` (per-device subscription owned by the user; full CRUD via RLS keyed on `user_id = auth.uid()`, and `claim_push_subscription` to take a device over from the account that used it before — only with the keys stored with it)

## docs/ARCHITECTURE.md — Read-only gate on past-program sessions

Add after the bullet that starts "- **Backfill** — `useAddSlot` materializes one set_log per planned set":

- **Server-side materialization** — `ensure_set_logs(p_session_id)` (migration `2026_10_13_13_ensure_claim_rpcs.sql`) adds the prescribed rows that are missing in one session of the calling athlete and returns how many. It reads `exercise_slots` at the moment of the call, so it cannot bring back a set the coach removed, and it holds the exercises `FOR SHARE` while it reads their `sets`, so an edit of the count waits for the rows. It is `SECURITY DEFINER` and asks the three questions of an athlete's write itself (own session, block being trained, session neither archived nor reviewed) through the helpers the policies use. `useEnsureSetLogs` does not call it yet.

## CLAUDE.md — Feature → files map, row "Student session logging"

Add to the end of the row:

. In the database (migration `2026_10_13_13_ensure_claim_rpcs.sql`): `ensure_set_logs(p_session_id)` adds the prescribed sets that are missing in a session of the calling athlete, from the exercises as they are in the database, and answers how many — `SECURITY DEFINER`, own session + block being trained + session neither archived nor reviewed, not called by `useEnsureSetLogs` yet

## CLAUDE.md — Feature → files map, row "Web Push subscription toggle"

Add to the end of the row:

. In the database (migration `2026_10_13_13_ensure_claim_rpcs.sql`): `claim_push_subscription(p_endpoint, p_p256dh, p_auth, p_user_agent)` creates the row, refreshes the caller's own, or takes the endpoint over from another account when the two keys sent are the ones stored with it, and answers `{ subscription_id, outcome }` — `SECURITY DEFINER`, not called by `lib/pushNotifications` yet

## CLAUDE.md — Feature → files map, row "DB / RLS test suite (`npm run test:db`)"

Add to the row's file list, after the entry for `copy-rpcs.test.js` (the one `docs/_pending/sql-08b-copy-rpcs.md` adds):

`ensure-claim.test.js` (`ensure_set_logs` and `claim_push_subscription`: `WHAT_A_NEW_SET_IS` — every column of `set_logs` as written by the function or left to its default, which a new column must join; each next to the request of the app that is deployed — the insert that brings back a set the coach removed, the upsert that is refused on a shared device; every kind of caller; the sessions an athlete may not write; the mark `app.trusted_set_log_insert`, on during the `INSERT` and off afterwards, tried against the trigger the contract migration describes; the keys that move a device and the ones that do not; requests that cross, on two connections; migration `2026_10_13_13_ensure_claim_rpcs.sql` tried on the frozen baseline with the audit table, the check and the lists of its runbook page read off the page)

## CLAUDE.md — When you add a feature

Add to step 2, after the sentence that starts "A column added to `programs`, `weeks`, `sessions`, `exercise_slots` or `set_logs` also joins `WHAT_A_COPY_IS`" (the one `docs/_pending/sql-08b-copy-rpcs.md` adds):

A column added to `set_logs` also joins `WHAT_A_NEW_SET_IS` in `supabase/tests/ensure-claim.test.js` — written by `ensure_set_logs` from the exercise, or left to its default on purpose.

## README.md — Database Tests

Replace the file and test counts of the sentence that starts "A run reports" (as `docs/_pending/sql-08b-copy-rpcs.md` leaves it) with the counts of the wave-1 gate run. This package adds one file and 41 tests (36 in `ensure-claim.test.js`, 2 in `rpc-auth.test.js`, 3 for the migration in `migration-conventions.test.js`): 24 files and `898 passed` in the sql lane's worktree, with no expected failure.

Add after the bullet that starts "- `copy-rpcs.test.js` holds" (the one `docs/_pending/sql-08b-copy-rpcs.md` adds):

- `ensure-claim.test.js` holds the two functions that write for the account that calls. The requests of the app that is deployed are written out in it (`app.ensure`, after `useEnsureSetLogs`, takes the exercises "as the app has them in its cache"; `app.subscribe`, after `upsertSubscriptionRow`), so each finding is shown on the same rows as the function that closes it. What a set carried when it was inserted is read by a trigger the test adds for the length of one scenario (`watchInserts`); the trigger of the contract migration that is not written yet stands in the same way (`test_pin_insert`). Requests that cross have an athlete of their own, and commit.

## docs/RUNBOOK.md — new section "Checkpoint A3 — …", after the section of Checkpoint A2

Add when Checkpoint A3 is handed over (its row marked **ready**). The part of the sequence that belongs to migration 13, the third of the checkpoint, every command taken from `docs/runbook/migrations/13-ensure-claim-rpcs.md` as it stands there, one per fence:

1. the audit of migration 13 — it reads as the "before" column of the page's table. **Line 4 must read `none`**, and lines 2 and 3 `no`: otherwise stop and report, the migration refuses to run next to a function of one of its names. **Lines 9 and 10 are noted**: exercises of a session in progress that miss a set, and devices registered for notifications — any number stops nothing;
2. the migration;
3. the audit again — lines 2 and 3 read `yes`, lines 6 and 7 list the two functions (line 7 is meant: these two run as their owner), the others are those of step 1;
4. the ledger: thirteen rows, the last one `2026_10_13_13_ensure_claim_rpcs`;
5. the page's check, which must fail with `check only, nothing was written: in place: the missing sets of a session are added for its athlete and for nobody else, and a device moves to the account that presents its keys and to no other` — `NOT PROTECTED` or `BROKEN` means roll back; `NOT THERE`, `NOT TRIED` or a message that does not start with `check only` means stop and report;
6. when line 9 of step 1 was not `0`: the list of the page's section "Exercises that miss a set" — nothing is repaired in the database, the sets are added when the athlete opens the session. For line 10: the list of "Devices registered for notifications", which shows an account that has none — a coach without one is told of nothing on any device.

Say with the rollback of migration 13, in the words of its page: it drops the two functions and writes no row — the sets that were added stay, a device stays with the account it was registered for last — and it is not run once the version of the app that follows wave 1 is published, which registers a device through `claim_push_subscription`.

Add to the rule about publishing the app ("Database first, app second"), for the checkpoint of wave 2: the build of wave 2 calls `ensure_set_logs` and `claim_push_subscription`, so migration 13 is in the ledger before it is published — Checkpoint A3 puts it there.
