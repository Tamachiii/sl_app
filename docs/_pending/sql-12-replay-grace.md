# sql-12-replay-grace — docs to fold (wave 2, items P55)

Each block: target doc, section, then the text to fold in.

## docs/INVARIANTS.md — RLS / DB conventions

Replace, in the bullet that starts "**A session is read-only for its athlete when its program is not the block being trained", the text "`program_active_for_slot(x) = true` (my program is the active, non-trashed one)" with:

`program_active_for_slot(x) = true` (my program is out of the trash, and is the active one or was switched off less than 72 hours ago — next bullet)

## docs/INVARIANTS.md — RLS / DB conventions

Add after the bullet that starts "**A session is read-only for its athlete when its program is not the block being trained":

- **A block stays open for its athlete for 72 hours after it is switched off — in the database, and only there.** The app queues what an athlete logs without a connection; when the coach activates the next block in between, the workout is replayed against a block that is no longer the active one, and before migration `2026_10_13_17_replay_grace_window.sql` every set of it reached no row (PGRST116), the confirmation and the notes were refused, and nothing could be sent again (review P55). Since then `programs.deactivated_at` holds the time `is_active` last went from true to false, and `program_active_for_session(session)` answers yes for a program that is out of the trash and is the active one **or** is approved and was switched off less than 72 hours ago. `program_active_for_slot`, the policies of `set_logs`, `slot_comments`, `slot_deviations`, `set_log_videos`, `session_confirmations` and of the `set-videos` files, and `ensure_set_logs` all ask that one function, so the window is the same for every write of an athlete — and `interval '72 hours'` is written there and nowhere else. Three things it does not open: a session the coach archived or reviewed (`session_writable`), a block in the trash (taken out inside its 72 hours it is open again for what is left of them), and a draft. A block that was switched off before the migration has no time and no window. `supabase/tests/replay-grace.test.js` holds it, with the athlete's queue (`MUTATION_KEYS`) replayed after a switch.
- **"Open for its athlete" and "the block being trained" are two questions since migration 17.** `program_active_for_session` / `program_active_for_slot` answer the first — for three days after a switch, for two blocks of one athlete. `programs.is_active` answers the second, for one. What an athlete may WRITE asks the function. Which block is the current one — the queue (`buildQueue`), "No program assigned yet", `session.program_is_active` and the "From a past program — read-only." banner of `SessionView`, a count "of the active block" — reads `is_active`, and must go on doing so: the screens show a block that is not active as read-only from the moment of the switch, and the window is for what was already waiting on a phone. Do not derive the lock of a screen from the window, and do not write a policy that compares `deactivated_at` itself.
- **`programs.deactivated_at` is written by a trigger, and by no request that carries a user id.** `trg_stamp_program_deactivated_at` (BEFORE INSERT OR UPDATE on `programs`) writes `now()` when a statement switches a block off — the two UPDATEs of `useSetActiveProgram` and of `useCreateProgram` with `setActive`, `activate_program`, a block sent to the trash while it is active — and NULL while the row is active. Any other write of a signed-in user leaves the column as it was (NULL on a new row), **silently**: the statement is accepted and the rest of it is saved, like the pins of migration 06. It has to be held: the author of a draft writes the row of their draft, and a time put there would keep the block open for its athlete after the coach approves it. A request without a user id — the SQL editor, the service-role key — writes it as it likes on a block that is not active: that is how the owner closes a window early (`NULL`) or opens one again (`now()`), `docs/runbook/migrations/17-replay-grace-window.md`. A hook never sends the column, and a function that switches a block off writes `is_active = false` and nothing more.

## docs/INVARIANTS.md — RLS / DB conventions

Replace, in the bullet that starts "**Logged training can never be hard-deleted; \"delete\" is archive-first**", the sentence "`program_active_for_session` folds in `deleted_at IS NULL`, so a trashed program is never writable regardless of `is_active`." with:

`program_active_for_session` folds in `deleted_at IS NULL`, so a trashed program is never writable regardless of `is_active` — and of the 72 hours a block stays open after it is switched off (migration 17).

## docs/INVARIANTS.md — RLS / DB conventions

Replace, in the bullet that starts "**Setting a block active, reordering the sessions of a phase and reordering the phases of a block each have a function", the text "so a request that is lost leaves the athlete without an active block — every set they log is then refused —" with:

so a request that is lost leaves the athlete without an active block — their page says "No program assigned yet", and what they log in the block that was switched off is saved for 72 hours (migration 17) and refused from then on —

## docs/INVARIANTS.md — Offline-safe student writes

Add after the bullet that starts "**A confirm is insert-or-nothing: the first confirmation of a session is the one that stays.**":

- **A queue replayed after the coach has switched blocks is saved for 72 hours, and refused after.** Every queued write of an athlete — the five on a set, the note, the swap or skip, confirm and unconfirm — goes through `program_active_for_session`, which since migration `2026_10_13_17_replay_grace_window.sql` answers yes for 72 hours after a block is switched off. Inside that time a replay succeeds exactly as it would have on the active block: the UPDATE returns its row, the confirmation is inserted and notifies the coach, `sessions.performed_at` follows `performed_on`. After it, and for a block in the trash, a replay fails as before — an UPDATE reaches no row (PGRST116), an INSERT is refused (`42501`) — and is not sent again. The window does not depend on when the set was tapped: the database has no proof of that time, so it is counted from the switch.

## docs/ARCHITECTURE.md — Read-only gate on past-program sessions

Replace the paragraph that starts "A session is read-only for its athlete iff `programs.is_active = false`" with:

A session is read-only for its athlete iff its program is not the active one (`programs.is_active = false`, or the program is in the trash), OR `sessions.archived_at IS NOT NULL`, OR `sessions.reviewed_at IS NOT NULL`. The first two are enforced at two layers, the third in the database. The two layers do not draw the first line at the same moment, on purpose: the screens close a block when it stops being the active one; the database closes it 72 hours later (`programs.deactivated_at`, migration `2026_10_13_17_replay_grace_window.sql`), so that what an athlete logged without a connection is still saved when the coach has switched blocks in between.

## docs/ARCHITECTURE.md — Read-only gate on past-program sessions

Replace, in the bullet that starts "- **RLS gate**", the text "`program_active_for_session(sess_id)` and `program_active_for_slot(slot_id)` walk session → week → program (migration `2026_04_26_lock_inactive_program_writes.sql`);" with:

`program_active_for_session(sess_id)` and `program_active_for_slot(slot_id)` walk session → week → program (migration `2026_04_26_lock_inactive_program_writes.sql`) and answer yes for a program out of the trash that is the active one or — approved — was switched off less than 72 hours ago (`programs.deactivated_at`, stamped by `trg_stamp_program_deactivated_at`; migration `2026_10_13_17_replay_grace_window.sql`);

## docs/ARCHITECTURE.md — Program periodization (multiple blocks per student)

Add after the bullet that starts "- `useSetActiveProgram` deactivates the current active program first":

- Switching a block off stamps `programs.deactivated_at` (a trigger, whichever request does it), and switching it on empties it. The column is the database's: no hook reads or sends it, and a value sent by a signed-in user is left out without an error. For 72 hours from that time the athlete's writes to the block are still accepted by the policies — see "Read-only gate on past-program sessions".

## CLAUDE.md — Feature → files map, row "Offline support (student writes)"

Replace the row's file list with:

`lib/queryClient.js`, `lib/offlineMutations.js`, `hooks/useOnlineStatus.js`, `components/ui/OfflineBanner.jsx`, `vite.config.js`, `main.jsx`, `App.jsx`. A queue replayed after the coach has switched blocks is saved by the database for 72 hours: migration `2026_10_13_17_replay_grace_window.sql` (`programs.deactivated_at`, the trigger `trg_stamp_program_deactivated_at`, `program_active_for_session`), `supabase/tests/replay-grace.test.js`; the rules are in `supabase/migrations/README.md` ("A migration that changes when an athlete may write in a block, or switches one off")

## CLAUDE.md — Feature → files map, row "DB / RLS test suite (`npm run test:db`)"

Replace "`seed`/`createUser`/`createProgram`/`createDraftProgram`" with:

`seed`/`createUser`/`createProgram`/`createDraftProgram`/`pastBlock`

## CLAUDE.md — Feature → files map, row "DB / RLS test suite (`npm run test:db`)"

Add before the sentence "The migration tests are the next row.":

`replay-grace.test.js` (a block stays open for its athlete for 72 hours after it is switched off: who writes `programs.deactivated_at` and who cannot, the window to the second, the athlete's queue replayed after the coach's two requests and after `activate_program`, the trash, the lock of a session inside the window; migration `2026_10_13_17_replay_grace_window.sql` on the frozen baseline — the workout lost before, saved after, lost again after the rollback — with the statements of its page that close a window and open one again).

## CLAUDE.md — When you add a feature

Add to step 3, after the bullet that starts "A new Edge Function is a directory under `supabase/functions/`":

   - In a database test, a past block is made with `pastBlock(q, program)` of `supabase/tests/harness.js`: `update programs set is_active = false` alone leaves a block its athlete still writes in for 72 hours (migration 17). A rule about what an athlete may write asks `program_active_for_session` / `program_active_for_slot`; a rule about which block is the current one reads `programs.is_active`.

## README.md — Offline Support (Student Session Logging)

Add after the bullet that starts "- **Conflict policy**":

- **A switch of block in between** — an athlete writes only in the block they are training, and a coach may set the next block active while a workout is still waiting on a phone. The database keeps a block open for its athlete for 72 hours after it is switched off (`programs.deactivated_at`, migration 17), so the queue is saved in the session it was logged in when the phone is back; the screens show that block as a past one, read-only, from the moment of the switch. After the 72 hours, and for a block in the trash, a replay is refused.

## README.md — Database Tests

Replace "- Fixtures: `seed()`, `createUser()`, `createProgram()`, `createDraftProgram()`;" with:

- Fixtures: `seed()`, `createUser()`, `createProgram()`, `createDraftProgram()`, and `pastBlock(q, program)` — a block switched off more than 72 hours ago, which is what "a past block" means since migration 17;

## README.md — Database Tests

Add after the bullet that starts "- `ensure-claim.test.js` holds the two functions that write for the account that calls.":

- `replay-grace.test.js` holds "a block stays open for its athlete for 72 hours after it is switched off". A test cannot wait 73 hours: it moves the time of the switch back as the owner of the database — `pastBlock(q, program, '73 hours')` — which is the one caller the column can be written by. Inside a `scenario()` the clock is one instant, so a block switched off there was switched off exactly now (`switchedOff(q, id)` answers `0`, in hours). The coach's requests and the nine writes of the athlete's queue are written out as the deployed app sends them (`coachApp`, `queue`, after `useProgram.js` and `lib/offlineMutations.js`), and a workout is sent whole (`send(workout(session))`) and compared with `SAVED` or `REFUSED`.

## docs/RUNBOOK.md — new section "Checkpoint B — …", after the section of Checkpoint A3

Add when Checkpoint B is handed over (its row marked **ready**), after the part that belongs to migration 16. The part of the sequence that belongs to migration 17, every command taken from `docs/runbook/migrations/17-replay-grace-window.md` as it stands there, one per fence. It needs nothing but migration 16, and nothing of Checkpoint B needs it before the app of wave 2 is published.

1. the audit of migration 17 — it reads as the "before" column of the page's table. **Line 2 must read `while it is the active one` and line 5 `none`**: otherwise stop and report, the migration refuses to run. Lines 3 and 4 read `no`, lines 12 to 15 read `0`. **Lines 10 and 11 are noted**: the blocks out of the trash (`N being trained, M not active, K drafts`) and in it. None of them stops the migration;
2. the migration;
3. the audit again — lines 2, 3, 4 and 8 read as the "after" column, lines 12 to 15 still read `0`, lines 10 and 11 are the numbers of step 1;
4. the ledger: seventeen rows, the last one `2026_10_13_17_replay_grace_window`;
5. the page's check, which must fail with `check only, nothing was written: in place: a block says when it was switched off, by the two requests of the app and by activate_program alike; its athlete writes in it for 72 hours, no longer, and never once it is in the trash; a signed-in user does not write that time` — `NOT PROTECTED` or `BROKEN` means roll back; `NOT THERE`, `NOT TRIED` or a message that does not start with `check only` means stop and report;
6. nothing to look at in the app: every screen is what it was.

Say with it what to tell the coach: for three days after *Set active* on another block, sets and a confirmation of the block that was switched off may still arrive — from a phone that was offline — and show up as a session to review, with its bell line.

Say with the rollback of migration 17, in the words of its page: it reopens P55 and closes every open window at once — what is waiting on a phone for a block switched off in the last three days is refused when it arrives; the times do not come back when the migration is applied again; no row is deleted.

## docs/RUNBOOK.md — By hand in the SQL editor, from these checkpoints on

Add when Checkpoint B is handed over, after the last entry of the section:

- **Closing the 72 hours of a block early, or opening them again** (from migration 17). After *Set active* on another block, the block that was switched off stays open for its athlete for 72 hours, for what a phone without a connection still has to send. The time of the switch is the one column of a block that nobody who is signed in can write; the owner can. The two statements, and the list of the blocks that are open, are in `docs/runbook/migrations/17-replay-grace-window.md`, sections "The blocks that are still open" and "Closing a window early, or opening one again". Giving an athlete their block back is not this: it is *Set active*, in the app.
