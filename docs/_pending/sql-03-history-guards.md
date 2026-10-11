# sql-03-history-guards — docs to fold (wave 1, items P3, P17)

Each block: target doc, section, then the text to fold in.

## docs/INVARIANTS.md — RLS / DB conventions

Replace, in the bullet that starts "**Logged training can never be hard-deleted; "delete" is archive-first**", the text from "Hard delete is offered only from the trash and only when the program has zero logged sets" to the end of the bullet with:

Hard delete is offered only from the trash and only when the program has zero logged sets — `useHardDeleteProgram`'s count check is the friendly message, the database is the guarantee (next bullets). A blocked delete surfaces `errors.hasLoggedTraining` ("archive instead").

Add after that bullet:

- **A logged set has ONE definition: `set_log_is_logged(set_logs)`.** Done, failed, skipped, an RPE or an actual (`done OR failed OR skipped OR rpe IS NOT NULL OR actual_reps IS NOT NULL OR actual_weight_kg IS NOT NULL`) — migration `2026_10_11_04_logged_history_guards.sql`. It takes the row (`set_log_is_logged(sl)`), so a caller cannot leave a column out. Every guard below reads it, and so do `adopt_swap` and `adopt_skip`. A new rule about "already trained" calls the function and never repeats the columns: a predicate spelled out in two places ends up shorter in one of them (review P17). It is not granted to `authenticated`: only SECURITY DEFINER functions call it, as their owner — a client that needs the same answer reads the six columns. A set that carries a `set_log_videos` row is protected like a logged one by the delete guards; that is written next to each call (`OR EXISTS (… set_log_videos …)`), not inside the function.
- **A logged set cannot be hard-deleted at any level, cascades included.** Five `BEFORE DELETE` row triggers: `block_program_delete_with_logged_sets`, `block_week_delete_with_logged_sets`, `block_session_delete_with_logged_sets`, `block_slot_delete_with_logged_sets` (on `exercise_slots`) and `block_set_log_delete_when_logged` (on `set_logs`). The last one is the net under the others: a row trigger fires on a cascade too, so whatever starts a delete — the editor, the API, a `students` row, a profile, an account — the logged row itself refuses. One exception: an extra set (`is_student_added`) deleted by the athlete who added it; in a cascade the slot is already gone, `student_profile_for_slot()` answers NULL and the exception does not apply. A comment or a deviation alone does not hold a slot: the coach removes an exercise nobody trained with them. Every message contains `logged set`, which `lib/mutationErrors.js` maps to `errors.hasLoggedTraining` — a new guard keeps those two words. `supabase/tests/history-guards.test.js` holds all of it, the cascades with the upper guards switched off included. KNOWN residual gap: the coach's `FOR ALL` policy on `set_logs` has no column pin, so a coach who calls the API by hand can still write `done`, `rpe` or `actual_*` — un-log a set, then delete it. The app never writes those columns as a coach; the guards stop what the editor and a cascade do, not a coach who sets out to falsify a log.
- **`exercise_slots.sets` cannot go below a logged prescribed set** (`block_slot_sets_below_logged_set`, `BEFORE UPDATE OF sets`). The rows it looks at are the ones a lower count orphans: not `is_student_added`, `set_number` above the new count, logged or with a video. The guard is on the count, not only on the rows, because the session editor lowers a set count in two writes — the count first, then the DELETE: refusing the first leaves nothing changed. The refusal is the net, not the interface: a client that removes or drops sets must read the logged flags first and say no itself.
- **The targets of a logged set are pinned for a signed-in user — silently.** `trg_pin_logged_set_log_targets` (`BEFORE UPDATE` on `set_logs`, entered only when a `target_*` column changes) puts `target_reps`, `target_duration_seconds`, `target_weight_kg` and `target_rest_seconds` back on a row that `set_log_is_logged`. A set done as prescribed has no actual: its targets ARE what the athlete lifted. It does not raise, because the editor writes a target change to every set of the exercise in one statement and a refusal would abort the edit for the sets still to come. So **an UPDATE of targets answers "1 row" for a logged set and has changed nothing**: a client fans a target change out to pending sets only, and never reads a row count as "written". The athlete is pinned on every row, logged or not, by `pin_set_log_targets_for_student`. A statement with no user id (the SQL editor, the service role) is not pinned: that is a deliberate correction.
- **The one way through the delete guards is `SET LOCAL app.allow_history_delete = 'on'`, and it is not for the app.** `history_delete_allowed()` is true when the transaction set that value AND `auth.uid()` is NULL — the SQL editor, a migration, a function called with the service-role key. The six refusals (the five delete guards and the set-count guard) read it; for a signed-in user it does nothing, whoever set it. Never drop or disable a guard trigger to delete something: one that is not put back leaves the door open for everyone. The owner's recipe is in `docs/runbook/migrations/04-logged-history-guards.md`; a function that must delete history (erasing an account) calls `set_config('app.allow_history_delete', 'on', true)` itself and is executable by the service role only.

Replace, in the bullet that starts "**Adopting a swap into the program is a coach-only, forward-only, SECURITY DEFINER RPC (Phase 3.1).**", "**have no performed `set_logs`** (`done`/`skipped`/`actual_*`), no `session_confirmations` row, and no `slot_deviations` row of their own" with:

**have no logged `set_logs`** (`set_log_is_logged`: done, failed, skipped, an RPE or an actual) and no set with a video, no `slot_comments` row, no `session_confirmations` row, and no `slot_deviations` row of their own

Add, at the end of the same bullet:

`adopt_skip` shares that predicate word for word, so what its dry run counts is what its DELETE removes, and none of it is held by a delete guard: the function never raises on a slot the athlete has touched, it leaves it out.

Replace, in the bullet that starts "**Students can DELETE only their own extra sets**", "closing the DELETE + re-INSERT lane around the target-pin trigger." with:

closing the DELETE + re-INSERT lane around the target-pin trigger. The delete guard on `set_logs` follows the same line: a logged extra set goes for the athlete who added it and for nobody else — the coach is refused like on any logged set.

## README.md — Database Tests

Replace "A run reports 10 files and `218 passed | 7 expected fail`" with the file and test counts of the wave-1 gate run. This package brings the count to 12 files and `341 passed | 5 expected fail`.

Add after the bullet that starts "- `rpc-auth.test.js` calls the five coach-only SECURITY DEFINER RPCs":

- `history-guards.test.js` holds the rule "logged training is never deleted or rewritten": each way a set becomes logged, every level a delete can start from (with the upper guards switched off, to prove the one on `set_logs` alone), the writes of the session editor replayed in the order the app sends them, the pin on targets, `app.allow_history_delete`, and `adopt_swap` / `adopt_skip`. A test that needs to delete logged rows on purpose says `set local app.allow_history_delete = 'on'` first, as `postgres` or the service role.

## CLAUDE.md — Feature → files map, row "Program trash / archive-first delete"

Add after that row:

| Logged training is history (delete guards, set-count guard, target pin) | `supabase/schema.sql` section "LOGGED TRAINING IS HISTORY": `set_log_is_logged(set_logs)` (the one definition of a logged set), five `BEFORE DELETE` guards from `programs` down to `set_logs`, `block_slot_sets_below_logged_set`, `trg_pin_logged_set_log_targets`, and `history_delete_allowed()` (`SET LOCAL app.allow_history_delete = 'on'`, honoured only without a user id). Migration `2026_10_11_04_logged_history_guards.sql`; tests `supabase/tests/history-guards.test.js`; the owner's recipe for a deliberate delete in `docs/runbook/migrations/04-logged-history-guards.md`. Client side: `lib/mutationErrors.js` maps any message containing `logged set` to `errors.hasLoggedTraining` |

## CLAUDE.md — Feature → files map, row "DB / RLS test suite (`npm run test:db`)"

Add to the row's file list, after the entry for `function-acl.test.js`:

`history-guards.test.js` (logged training cannot be deleted or rewritten below the session: the delete guards and their cascades, the set-count guard, the silent pin on targets, the `app.allow_history_delete` way through, `adopt_swap`/`adopt_skip` leaving touched slots alone; the deployed editor's writes replayed in order; migration `2026_10_11_04_logged_history_guards.sql` tried on the frozen baseline with the audit table, the check and the recipe of its runbook page read off the page)

## docs/RUNBOOK.md — new section "Checkpoint A2 — …", after the section of Checkpoint A1

Add when Checkpoint A2 is handed over (its row marked **ready**). The part of the sequence that belongs to migration 04, every command taken from `docs/runbook/migrations/04-logged-history-guards.md` as it stands there, one per fence:

1. the audit of migration 04 — it reads as the "before" column of the page's table; lines 13 to 15 are `0`, or are reported and do not stop anything;
2. the migration;
3. the audit again — lines 2 to 7 read as the "after" column, and **line 9 still lists both adopt functions**;
4. the page's check, which must fail with `check only, nothing was deleted: protected: …`;
5. the smoke check in the app that is deployed, as the coach on the test athlete (step 4 of the page's "After"), only once step 4 above answered `protected`.

The ledger is read once, after the last migration of the checkpoint. Name the rollback file, `supabase/rollbacks/2026_10_11_04_logged_history_guards.down.sql`, and when it is run: a coach refused on something nobody trained. Link the page as `](runbook/migrations/04-logged-history-guards.md)`.

Say once, in the rules that hold at every checkpoint or in this section: from this migration on, training history is deleted on purpose with the recipe of that page ("Deleting training history on purpose"), never by dropping a trigger.
