# sql-08b-copy-rpcs — docs to fold (wave 1, items: none — the database's half of P52)

Each block: target doc, section, then the text to fold in.

## docs/INVARIANTS.md — RLS / DB conventions

Add after the bullet that starts "**Setting a block active, reordering the sessions of a phase and reordering the phases of a block each have a function that does it in one statement**" (the one `docs/_pending/sql-08a-activate-reorder-rpcs.md` adds):

- **Duplicating a session, a phase or a block, and copying sessions to another phase, each have a function that makes the whole copy or none — and the hooks' own requests do not.** Migration `2026_10_13_12_copy_rpcs.sql` (the database's half of review P52) adds four `SECURITY INVOKER` functions, executable by a signed-in user: what is copied is what the caller can read, where it goes is where the caller can write, so a coach copies for their own athletes and from one of them to another, and nobody else does. `useDuplicateSession`, `useCopySessions`, `useDuplicateWeek` and `useDuplicateProgram` do not call them yet: each still sends one request per row or per table (thirty to forty for a block), each request a transaction of its own, so a request that is lost leaves a session with no exercise, or exercises with no set, in the block the athlete trains. The contract:
  - **`duplicate_session(p_session_id, p_title_suffix default ' (copy)')`** puts the copy RIGHT AFTER its source — the sessions that follow move down by one, archived ones included — and returns `{ session_id, week_id, sort_order, title, slots, set_logs, slots_left_out }`. A session without a title is called `Session` before the suffix; with `''` or `null` the title is copied as it is. The copy is never archived.
  - **`copy_sessions(p_session_ids, p_dest_week_id)`** makes one copy per entry of the list, in the order of the list, after every session the phase holds (archived ones included), with the titles as they are and none archived, and returns `{ session_ids, week_id, slots, set_logs, slots_left_out }` — `session_ids` in the order of the list. An entry the caller cannot read refuses the whole list (`session_not_found`); an empty list copies nothing.
  - **`duplicate_week(p_week_id, p_dest_program_id default null, p_label_suffix default ' (copy)')`** adds the phase as the LAST phase of its program — or of `p_dest_program_id`, which is how "copy this phase to…" reaches another block or another athlete — with its sessions in their order, numbered from 0, the archived ones still archived. A phase without a name gives a copy without one. Returns `{ week_id, program_id, week_number, label, sessions, slots, set_logs, slots_left_out }`.
  - **`duplicate_program(p_program_id, p_target_student_id default null, p_name_suffix default ' (copy)')`** makes a block for the athlete of the source, or for `p_target_student_id` — the id of a row of `students`, what `programs.student_id` holds, not a profile. The copy is `approved`, **not active**, out of the trash and the coach's (`created_by` NULL) whatever its source is (a draft, a block in the trash, the block being trained), last in the athlete's list, its phases numbered from 1 with their names as they are. Returns `{ program_id, student_id, name, sort_order, weeks, sessions, slots, set_logs, slots_left_out }`.
  - **The answer is an object, and the id is in it under a fixed key.** Keys are added, never renamed. The arguments that have a default may be left out of the call.
  - **The refusals are `P0001` with a fixed word as the message** (HTTP 400): `session_not_found`, `week_not_found`, `program_not_found`, `student_not_found` (nothing with this id that the caller can read — somebody else's athlete and a wrong id are the same answer) and `copy_source_changed` (what was to be copied was deleted or moved while the call waited: refetch, then try again). `not authorized` is `42501` (the caller reads the place and may not write it — the athlete) and reaches the toast as `errors.notAllowed`; the others fall to `errors.generic` in `mutationErrorKey` until a hook maps them. Nothing was written in any of those cases.
  - **Two copies into one phase, one program or one athlete's list wait for each other**, and so do a copy and a reorder of the same phase: the parent is locked first, in the order `reorder_sessions` and `reorder_weeks` take it.
- **A copy is the prescription, and nothing of what was trained.** Copied: a session's title and recommended weekday; everything the coach wrote on an exercise (`exercise_id`, `sets`, the slot's own numbers, `sort_order`, `superset_group`, `notes`, `record_video_set_numbers`); the number and the four `target_*` of each prescribed set. Not copied: `scheduled_date`, `reviewed_at`, `performed_at`; `done`, `failed`, `skipped`, `rpe`, `weight_kg`, `actual_*`, `logged_at`, `failed_at`; the sets the athlete added (`is_student_added`); `slot_comments`, `slot_deviations`, videos, confirmations. `archived_at` is carried by `duplicate_week` and `duplicate_program` only. A set of a draft does not exist before `approve_program`, so the copy of a draft holds exercises without sets: the athlete's app adds them when the session is opened (`useEnsureSetLogs`). This is what `useDuplicate.js` copies, column for column — `supabase/tests/copy-rpcs.test.js` holds the two against each other — with two differences: the copy of a session stands right after its source instead of at the end of the phase, and a duplicated phase or block has its sessions numbered from 0 and its phases from 1 whatever the numbers of the source were.
- **`slots_left_out` is not zero when exercises could not be copied, and the app must say so.** A slot takes an exercise of the library of its program's coach (`trg_check_slot_exercise_in_coach_library`). After `transfer_student`, an athlete's older blocks still name the former coach's exercises: a copy of one holds the sessions and the exercises that are in the new coach's library, and `slots_left_out` counts the others — the function does not fail. Without a change of coach it is always `0`. A hook that calls one of the four shows a message when it is not.
- **A column added to `programs`, `weeks`, `sessions`, `exercise_slots` or `set_logs` is listed in `WHAT_A_COPY_IS`** at the top of `supabase/tests/copy-rpcs.test.js` as `copied` or `left`, or the DB suite fails. A copied column is added to the three `INSERT`s between the marks `-- >>> the copy` and `-- <<< the copy`, which are the same lines in the four functions, in the migration that re-creates them and in `schema.sql` (`supabase/migrations/README.md`, "A migration that adds a column to a program, a phase, a session, an exercise slot or a set").

## docs/ARCHITECTURE.md — Per-set targets

Replace the bullet "- `useDuplicate` copies `set_logs` targets across (not actuals) — a duplicated session arrives clean." with:

- `useDuplicate` copies `set_logs` targets across (not actuals) — a duplicated session arrives clean. The database has the same copies as one statement each since migration `2026_10_13_12_copy_rpcs.sql`: `duplicate_session`, `copy_sessions`, `duplicate_week` and `duplicate_program` lock the place the copy goes to, read everything that is copied in one statement — so the copy is the block as it was at one instant, whatever is edited meanwhile — and write the sessions, their exercises and the prescribed sets from what was read, all or nothing. They are `SECURITY INVOKER` and ride the coach's policies, like `move_session`. The hooks do not call them yet.

## CLAUDE.md — Feature → files map, row "Program duplicate (whole-block copy, same student)"

Add to the end of the row:

. In the database (migration `2026_10_13_12_copy_rpcs.sql`): `duplicate_program(p_program_id, p_target_student_id, p_name_suffix)` makes the whole copy in one statement — for the athlete of the block or for another athlete of the coach, inactive, prescription only — and answers `{ program_id, …, slots_left_out }`; `SECURITY INVOKER`, not called by `useDuplicateProgram` yet

## CLAUDE.md — Feature → files map, row "Coach Program Sheet (the Programming tab — the whole block as ONE list)"

Add to the end of the row:

. In the database (migration `2026_10_13_12_copy_rpcs.sql`): `duplicate_session(p_session_id, p_title_suffix)` (the copy right after its source), `copy_sessions(p_session_ids, p_dest_week_id)` (one copy per entry, at the end of the phase) and `duplicate_week(p_week_id, p_dest_program_id, p_label_suffix)` (the last phase of its block or of another one) each make a whole copy or none — `SECURITY INVOKER`, not called by `useDuplicateSession` / `useCopySessions` / `useDuplicateWeek` yet

## CLAUDE.md — Feature → files map, row "DB / RLS test suite (`npm run test:db`)"

Add to the row's file list, after the entry for `atomic-rpcs.test.js` (the one `docs/_pending/sql-08a-activate-reorder-rpcs.md` adds):

`copy-rpcs.test.js` (`duplicate_session`, `copy_sessions`, `duplicate_week` and `duplicate_program`: `WHAT_A_COPY_IS` — every column of the five tables as copied or left, which a new column must join; each copy against its source and against what the requests of the app that is deployed give; a write that fails half-way — the function leaves nothing, the requests leave a session without its exercises or its sets; an edit that lands while a copy is written; where a copy goes; every kind of caller; the exercises of a former coach's library, left out and counted; drafts and blocks in the trash; requests that cross, on two connections; migration `2026_10_13_12_copy_rpcs.sql` tried on the frozen baseline with the audit table, the check and the lists of its runbook page read off the page)

## CLAUDE.md — When you add a feature

Add to step 2, after the sentence that ends "`rls-matrix.test.js` when what a role can do changed (regenerate `supabase/tests/snapshots/rls-matrix.txt` with `-u` and commit the diff).":

A column added to `programs`, `weeks`, `sessions`, `exercise_slots` or `set_logs` also joins `WHAT_A_COPY_IS` in `supabase/tests/copy-rpcs.test.js` — copied by the four copy functions, or left behind on purpose — or that file fails.

## README.md — Database Tests

Replace the file and test counts of the sentence that starts "A run reports" (as `docs/_pending/sql-08a-activate-reorder-rpcs.md` leaves it) with the counts of the wave-1 gate run. This package adds one file and 46 tests: 23 files and `857 passed` in the sql lane's worktree, with no expected failure.

Add after the bullet that starts "- `atomic-rpcs.test.js` holds" (the one `docs/_pending/sql-08a-activate-reorder-rpcs.md` adds):

- `copy-rpcs.test.js` holds the four functions that copy. The requests of the app that is deployed are written out in it (`app`, after `src/hooks/useDuplicate.js`), so that a copy made by a function is compared with the copy those requests make of the same block, row for row and column for column (`sessionOf`, `weekOf`, `programOf` read whole rows as JSON, without ids). The block it copies is dressed so that every column holds something — a column that is NULL in the source is NULL in a copy whether it is copied or not — and a test fails when a column is not. A request that is lost is a trigger that raises on the `INSERT` it would have made (`loseTheInsertThat`).

## docs/RUNBOOK.md — new section "Checkpoint A3 — …", after the section of Checkpoint A2

Add when Checkpoint A3 is handed over (its row marked **ready**). The part of the sequence that belongs to migration 12, the second of the checkpoint, every command taken from `docs/runbook/migrations/12-copy-rpcs.md` as it stands there, one per fence:

1. the audit of migration 12 — it reads as the "before" column of the page's table. **Line 6 must read `none`**, and lines 2 to 5 `no`: otherwise stop and report, the migration refuses to run next to a function of one of its names. **Lines 11 to 13 are noted**: sessions without an exercise, exercises without a set, exercises of another coach's library — any number stops nothing; `0` is expected on line 13;
2. the migration;
3. the audit again — lines 2 to 5 read `yes`, line 8 lists the four functions, the others are those of step 1;
4. the ledger: twelve rows, the last one `2026_10_13_12_copy_rpcs`;
5. the page's check, which must fail with `check only, nothing was written: in place: a coach duplicates a session, a phase and a block and copies sessions to another athlete in one request each, a copy holds the targets and nothing that was trained, and an athlete does not` — `NOT PROTECTED` or `BROKEN` means roll back; `NOT THERE`, `NOT TRIED` or a message that does not start with `check only` means stop and report;
6. when line 11 or 12 of step 1 was not `0`: the lists of the page's sections "Sessions without an exercise" and "Exercises without a set", for the coach — nothing is repaired in the database. When line 13 was not `0`: the list of "Exercises of another coach's library", which says for which athletes a copy leaves exercises out.

Say with the rollback of migration 12, in the words of its page: it drops the four functions and writes no row — what they copied stays — and it is not run once the version of the app that follows wave 1 is published, which duplicates and copies through them and through nothing else.

Add to the rule about publishing the app ("Database first, app second"), for the checkpoint of wave 2: the build of wave 2 calls `duplicate_session`, `copy_sessions`, `duplicate_week` and `duplicate_program`, so migration 12 is in the ledger before it is published — Checkpoint A3 puts it there.
