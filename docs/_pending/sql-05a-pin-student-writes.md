# sql-05a-pin-student-writes — docs to fold (wave 1, items P13, P14, B4)

Each block: target doc, section, then the text to fold in.

## docs/INVARIANTS.md — `set_logs` — per-set targets, outcomes, RPE

Replace, in the bullet that starts "**Students log off-plan actuals on `set_logs.actual_reps` / `actual_weight_kg`", "it is now **hardened by the `pin_set_log_targets_for_student` BEFORE UPDATE trigger**, which reverts any student attempt to mutate `target_*`. Coach writes resolve a different `auth.uid()` than the slot's student, so `useUpdateSlot` / `useUpdateSetTarget` pass through untouched." with:

it is now **hardened by the `pin_set_log_targets_for_student` BEFORE UPDATE trigger**, which reverts any student attempt to mutate `target_*` — and what the set IS (next bullet). Coach writes resolve a different `auth.uid()` than the slot's student, so `useUpdateSlot` / `useUpdateSetTarget` pass through untouched.

Add after that bullet:

- **The athlete owns what they DID on a set; what the set IS belongs to the coach, and the athlete's own UPDATE cannot change it.** `pin_set_log_targets_for_student` (migration `2026_10_11_06_pin_student_writes.sql`, review P14) puts seven columns back to `OLD` when the writer is the athlete of the set: the four `target_*`, `is_student_added`, `exercise_slot_id` and `set_number`. `is_student_added` is what the `Students delete own set logs` policy trusts — flipped to `true`, a prescribed set could be deleted and inserted again with other targets; a set given another `set_number` or another `exercise_slot_id` leaves its place in `UNIQUE(exercise_slot_id, set_number)` free for a forged one. Whose set it is, is asked of `OLD.exercise_slot_id`, never of `NEW`: the slot is one of the columns held. **Silent**, like the pin on the targets: the UPDATE answers "1 row" and the columns keep their values — never read a row count as "written", read the row. A new column that says what a set is (a prescription column, a link to another row) joins the list in that function; a new column for what the athlete did does not. The coach is not the athlete of the set and passes through — `reconcileSetLogCount` in `src/hooks/useSession.js` renumbers the athlete's extra sets (park at `set_number + 100000`, then place) — and so does a statement without a user id. No athlete-side hook may send one of the seven columns in an `update`: it would be dropped without an error. `supabase/tests/pins.test.js` holds it.

## docs/INVARIANTS.md — RLS / DB conventions

Replace, in the bullet that starts "**Students can DELETE only their own extra sets**", "KNOWN residual gap: the student INSERT policy still accepts `target_*` values — it must, because `useEnsureSetLogs` materializes prescribed rows under the student JWT." with:

`is_student_added` cannot be written by the athlete's own UPDATE (`pin_set_log_targets_for_student`, migration 06), so a prescribed set cannot be turned into a deletable one. KNOWN residual gap: the student INSERT policy still accepts `target_*` values — it must, because `useEnsureSetLogs` materializes prescribed rows under the student JWT.

Replace, in the bullet that starts "**Student program authoring is an approval-gate model", "and blocks the author (`auth.uid() = created_by`) from moving `status`/`approved_at` — only the coach can approve." with:

and blocks the author (`auth.uid() = created_by`) from moving `status`/`approved_at` — only the coach can approve — and from changing `submitted_at` once it is set (next bullets).

Add after that bullet:

- **A session of a DRAFT carries no `reviewed_at`, no `archived_at`, no `performed_at` and no `scheduled_date` — whoever writes it.** `trg_pin_draft_session_columns` (`pin_draft_session_columns()`, `BEFORE INSERT OR UPDATE` on `sessions`, migration `2026_10_11_06_pin_student_writes.sql`, review P13) sets the four to NULL while `programs.status = 'draft'`. `Students author own draft sessions` is `FOR ALL`: the author writes every column of the sessions of their draft, and a draft sent in with `reviewed_at` set gave, once approved, sessions that never reached the coach's "to review" list and refused feedback as already given. **The rule is keyed on the status of the program, never on who writes**: `sessions.performed_at` is written by `sync_session_performed_at`, a SECURITY DEFINER trigger that runs inside the athlete's own request — on an approved program the athlete may well have authored. A pin "for the author" or "for the athlete" undoes that write, and confirmed sessions lose their training date (`supabase/tests/pins.test.js`, "once approved, a program its athlete wrote is trained and reviewed like any other", fails on exactly that). Consequences: the coach cannot archive or date a session of a draft either — the write is accepted and not kept, both are done after approval; a session moved into a draft loses the four; a new session column that records what happened to a session after approval joins the list in that function. `approve_program` clears the four on the sessions of the program it approves, for the drafts written before the trigger existed. Silent, like the other pins. **The function is `STABLE`, and a later `CREATE OR REPLACE` must keep the keyword**: the policy judges the program through `week_is_own_draft` (`STABLE`), as the statement saw it when it started, and a `VOLATILE` trigger function reads it as it is by the time the row is reached — so a stamp that waits for a row lock while the coach approves was "own draft" for the policy and "approved" for the pin, and landed on the approved program. An author reaches that with the API alone, a few connections stamping at once. No single-connection test sees it; `supabase/tests/pins.test.js`, "a stamp on its way while the coach approves …", holds it on three. KNOWN residual gaps: (1) the trigger judges a session when it is written — a program flipped from `approved` back to `draft` (no path of the app does it; a coach calling the API by hand could) keeps its stamped sessions until each is next written; (2) the price of `STABLE` — a week created earlier in the SAME statement as its session (a data-modifying CTE) is not seen. The policies do not see it either, so the author and the coach are refused (`42501`); only a caller row-level security does not apply to (the owner, the service role) gets a stamped session into a draft that way. `save_draft_tree` writes the weeks, then the sessions, in two statements — keep it so.
- **A submission is made once.** For the author of a draft, `pin_program_authoring_columns` keeps `submitted_at` as it is once it is not NULL (migration 06, review B4): `notify_coach_on_program_submit` fires on every NULL → set edge, and an author who could clear the column and set it again notified the coach, bell and push, as often as they liked. The way back is the coach's — `send_back_program`, after which the author submits again and the coach is told again, once — and `approve_program` clears it with the approval; neither is the author. A "withdraw my submission" feature for the athlete is therefore an RPC with its own rule, not an UPDATE of the column. KNOWN residual gap: an author can still discard a draft, write a new one and submit it — one notification per draft.

## docs/ARCHITECTURE.md — Auth and Row-Level Security

Add after the paragraph that starts "**Who coaches whom.**" (the one `docs/_pending/sql-04-students-role-gate.md` adds):

**Rows two sides write.** Three tables hold rows that an athlete may write and that also carry columns which are not theirs. Row-level security decides who may write the row; a `BEFORE` trigger puts the other side's columns back, silently, so the rest of the write is saved: `pin_set_log_targets_for_student` on `set_logs` (for the athlete of the set: the targets, `is_student_added`, `exercise_slot_id`, `set_number`), `pin_program_authoring_columns` on `programs` (for the author of a draft: `status`, `approved_at`, and `submitted_at` once set; `created_by` and `student_id` for everyone) and `pin_draft_session_columns` on `sessions` (for everyone, while the program is a draft: `reviewed_at`, `archived_at`, `performed_at`, `scheduled_date`). A pin is keyed on who writes only where no trigger writes the column on that person's behalf; `sessions.performed_at` is written inside the athlete's request by `sync_session_performed_at`, which is why the pin on sessions is keyed on the status of the program instead — and it is `STABLE`, so that it reads the status the policy read when the coach approves at that very moment.

## CLAUDE.md — Feature → files map, row "Off-plan deviation logging (student records actual reps/load)"

Replace "migration `2026_06_28_set_log_actuals.sql` (`set_logs.actual_*` + `pin_set_log_targets_for_student` trigger)" with:

migration `2026_06_28_set_log_actuals.sql` (`set_logs.actual_*` + `pin_set_log_targets_for_student` trigger; since `2026_10_11_06_pin_student_writes.sql` the trigger also holds `is_student_added`, `exercise_slot_id` and `set_number` for the athlete of the set — tests `supabase/tests/pins.test.js`)

## CLAUDE.md — Feature → files map, row "Student program authoring (Phase 3.4, OFFLINE-capable)"

Add at the end of the row's cell:

A session of a draft carries no `reviewed_at` / `archived_at` / `performed_at` / `scheduled_date`, whoever writes (`trg_pin_draft_session_columns`), `approve_program` clears the four, and the author cannot change `submitted_at` once it is set — migration `2026_10_11_06_pin_student_writes.sql`, tests `supabase/tests/pins.test.js`

## CLAUDE.md — Feature → files map, row "DB / RLS test suite (`npm run test:db`)"

Add to the row's file list, after the entry for `students-gate.test.js` (the one `docs/_pending/sql-04-students-role-gate.md` adds):

`pins.test.js` (the columns an athlete must not change: a set keeps its targets, its exercise, its number and `is_student_added` under its athlete's update; a session of a draft carries none of the four dates, whoever writes, and `approve_program` clears them; a submission is made once; a stamp sent while the coach approves, on three connections; the deployed app's set, confirmation, draft and editor writes replayed; migration `2026_10_11_06_pin_student_writes.sql` tried on the frozen baseline — holes before, closed after, back after its rollback — with the audit table, the check and the correction statement of its runbook page read off the page)

## README.md — Database Tests

Replace "A run reports 10 files and `218 passed | 7 expected fail`" with the file and test counts of the wave-1 gate run. This package brings the count to 14 files and `467 passed | 1 expected fail`.

Add after the bullet that starts "- `students-gate.test.js` holds the rule" (the one `docs/_pending/sql-04-students-role-gate.md` adds):

- `pins.test.js` holds the rule "a row two sides write keeps the other side's columns": the athlete's pin on a set, the pin on the sessions of a draft, the submission made once. All three are silent — the statement is accepted and the column keeps its value — so a test about a pin reads the row back; an `attempt()` that did not throw proves nothing. One of its tests is not a `scenario()`: three transactions of their own — a row held, the author's stamp waiting for it, the coach's approval committed meanwhile — because a policy and a trigger can only disagree across connections. It is the pattern for any "what if the coach does X while the athlete's request is on its way" test: helpers called OUTSIDE `scenario()` each open their own transaction (`{ commit: true }` to keep it), `pg_stat_activity.wait_event_type = 'Lock'` says the second one is waiting, and the test deletes what it committed.

## docs/RUNBOOK.md — new section "Checkpoint A2 — …", after the section of Checkpoint A1

Add when Checkpoint A2 is handed over (its row marked **ready**). The part of the sequence that belongs to migration 06, after the steps of migration 05, every command taken from `docs/runbook/migrations/06-pin-student-writes.md` as it stands there, one per fence:

1. the audit of migration 06 — it reads as the "before" column of the page's table; lines 10 and 11 are `0`, or are reported and do not stop anything;
2. the migration;
3. the audit again — lines 3 to 6 read as the "after" column, and **line 8 still reads `approve_program(uuid)`**;
4. the page's check, which must fail with `check only, nothing was written: protected: the set is still a prescribed one` — `NOT TRIED` is not `protected`: stop and report;
5. the smoke check in the app that is deployed, as the test athlete (step 4 of the page's "After"), only once step 4 above answered `protected`.

Add to what the coach is told at this checkpoint, one line: from migration 06 on, archiving a session of an athlete's draft or giving it a recommended date does not stay — both are done after *Approve*.
