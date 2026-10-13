# sql-08a-activate-reorder-rpcs — docs to fold (wave 1, items: none — the database's half of P16 and P51)

Each block: target doc, section, then the text to fold in.

## docs/INVARIANTS.md — RLS / DB conventions

Add after the bullet that starts "**Logged training can never be hard-deleted; \"delete\" is archive-first**":

- **Setting a block active, reordering the sessions of a phase and reordering the phases of a block each have a function that does it in one statement — and the hooks' own requests do not.** Migration `2026_10_13_11_activate_reorder_rpcs.sql` (the database's half of review P16 and P51) adds three `SECURITY INVOKER` functions, executable by a signed-in user and written on the model of `move_session`: they give the caller no right the policies of `programs`, `weeks` and `sessions` do not. `useSetActiveProgram`, `useCreateProgram` with `setActive`, `useReorderSessions` and `useReorderWeeks` do not call them yet: each still sends several requests, each request a transaction of its own, so a request that is lost leaves the athlete without an active block — every set they log is then refused — or sessions numbered 100000 and more in a phase those hooks can no longer reorder. The contract:
  - **`activate_program(p_program_id)`** switches every other active program of the athlete off — one in the trash included — and this one on, and returns `{ program_id, student_id, already_active, deactivated }` (`student_id` is the `students` row, `deactivated` a count). Called for the program that is active already it writes nothing and answers `already_active: true`: a request sent twice is not an error. It refuses, before any write: `program_not_found` (no such program that the caller can read — somebody else's athlete and a wrong id are the same answer), `not authorized` (`42501`: the caller reads it and may not write it — its athlete), `program_is_draft`, `program_in_trash`.
  - **`reorder_sessions(p_week_id, p_ids)`** and **`reorder_weeks(p_program_id, p_ids)`** take EVERY child of the parent, once each, in the order wanted — archived sessions included, because the unique key counts them — and return nothing. Afterwards `sort_order` is 0 to n-1 and `week_number` 1 to n, whatever the numbers were: a phase that an interrupted reorder left at 100000 and more is put right by the same call. A list that is not exactly the children is refused with `reorder_ids_mismatch` (its `details` count what is missing, foreign, or there twice) — which is what a page loaded before a session was added, moved or deleted sends: refetch, then try again. Also `week_not_found` / `program_not_found` and `not authorized` as above. A list that is the order already writes nothing.
  - **The refusals are `P0001` with that fixed word as the message** (HTTP 400), except `not authorized`, which is `42501` and reaches the toast as `errors.notAllowed`; the others fall to `errors.generic` in `mutationErrorKey` until a hook maps them.
  - **Two calls for the same athlete, phase or block wait for each other** (the parent is locked first), so the last one sent is the one that stays — the database needs no per-week scope from the client to stay consistent; a scope only keeps the optimistic cache in step.
  - **`useReorderPrograms` has no function**: `programs.sort_order` has no unique key, so its two passes cannot collide.

## docs/INVARIANTS.md — Training is a QUEUE; the calendar is a consequence

Add after the bullet that starts "**Dragging a session across a divider MOVES it between phases, and that is ONE write.**":

- **`move_session` still parks at `100000 + n`; `reorder_sessions` does not.** A unique key that is not deferrable is checked row by row, inside one `UPDATE` too: parked at a constant, a session can meet one that an interrupted reorder left at that number, and `move_session` then fails with `sessions_week_sort_order_unique` on such a phase — or goes through, as the ids fall. `reorder_sessions` and `reorder_weeks` park above every number the parent holds (`GREATEST(max, n) + place`) and cannot. A phase left parked is put right by one call of `reorder_sessions` with its sessions in the order they are shown (`docs/runbook/migrations/11-activate-reorder-rpcs.md`, "Sessions or phases left parked").

## docs/ARCHITECTURE.md — Two-pass reorder writes

Add after the paragraph that starts "Week reordering (`useReorderWeeks`) does an **optimistic two-pass write**":

The database has the same operation as one statement since migration `2026_10_13_11_activate_reorder_rpcs.sql`: `reorder_weeks(p_program_id, p_ids)` and `reorder_sessions(p_week_id, p_ids)` lock the parent, check that the list is exactly its children (archived sessions included), park every row above every number the parent holds and place them — all or nothing — and `activate_program(p_program_id)` does the same for the two writes of "Set active". They are `SECURITY INVOKER` and ride the coach's policies, like `move_session`. The hooks above do not call them yet.

## CLAUDE.md — Feature → files map, row "Coach programs CRUD"

Add to the end of the row:

. In the database (migration `2026_10_13_11_activate_reorder_rpcs.sql`): `activate_program(p_program_id)` switches the athlete's other programs off and this one on in one statement and refuses a draft and a program in the trash — `SECURITY INVOKER`, not called by `useSetActiveProgram` yet

## CLAUDE.md — Feature → files map, row "Coach Program Sheet (the Programming tab — the whole block as ONE list)"

Add to the end of the row:

. In the database (migration `2026_10_13_11_activate_reorder_rpcs.sql`): `reorder_sessions(p_week_id, p_ids)` and `reorder_weeks(p_program_id, p_ids)` renumber a whole phase or block in one statement from the full list of its children, archived sessions included — `SECURITY INVOKER`, not called by `useReorderSessions` / `useReorderWeeks` yet

## CLAUDE.md — Feature → files map, row "DB / RLS test suite (`npm run test:db`)"

Add to the row's file list, after the entry for `goals.test.js` (the one `docs/_pending/sql-07-goals-fk-coach-links.md` adds):

`atomic-rpcs.test.js` (`activate_program`, `reorder_sessions` and `reorder_weeks`: each next to the requests of the app that is deployed, with a write that fails half-way — the function leaves everything as it was, the requests leave the athlete without a block or a phase parked at 100000; the lists that are refused; every kind of caller; two requests that cross, on two connections; migration `2026_10_13_11_activate_reorder_rpcs.sql` tried on the frozen baseline with the audit table, the check and the repair statements of its runbook page read off the page)

## README.md — Database Tests

Replace the file and test counts of the sentence that starts "A run reports" (as `docs/_pending/sql-07-goals-fk-coach-links.md` leaves it) with the counts of the wave-1 gate run. This package brings the count to 22 files and `808 passed`, with no expected failure.

Add after the bullet that starts "- `goals.test.js` holds" (the one `docs/_pending/sql-07-goals-fk-coach-links.md` adds):

- `atomic-rpcs.test.js` holds the three functions that do in one statement what the app did in several requests. A request that is lost half-way is a trigger that raises on the write it would have made (`loseTheRequestThat`): each `q()` of the harness is one request, so the same failure shows what the function leaves and what the requests leave. Two requests that cross need two connections and committed rows (`cross`), and have an athlete of their own.

## docs/RUNBOOK.md — new section "Checkpoint A3 — …", after the section of Checkpoint A2

Add when Checkpoint A3 is handed over (its row marked **ready**). The part of the sequence that belongs to migration 11, the first of the checkpoint, every command taken from `docs/runbook/migrations/11-activate-reorder-rpcs.md` as it stands there, one per fence:

1. the audit of migration 11 — it reads as the "before" column of the page's table. **Line 5 must read `none`**, and lines 2 to 4 `no`: otherwise stop and report, the migration refuses to run next to a function of one of its names. **Lines 10 to 13 are noted**: what a lost request left behind until now — `0` is expected on lines 11 to 13; any number stops nothing;
2. the migration;
3. the audit again — lines 2 to 4 read `yes`, line 7 lists the three functions, the others are those of step 1;
4. the ledger: eleven rows, the last one `2026_10_13_11_activate_reorder_rpcs`;
5. the page's check, which must fail with `check only, nothing was written: in place: a coach sets a block active and reorders its sessions and its phases in one request each, and an athlete does not` — `NOT PROTECTED` or `BROKEN` means roll back; `NOT THERE`, `NOT TRIED` or a message that does not start with `check only` means stop and report;
6. when line 11, 12 or 13 of step 1 was not `0`: the page's sections "A block in the trash that is still active" and "Sessions or phases left parked", whose statements switch such a block off and number such a phase again, in the order that is on screen. When line 10 was not `0`: the list of "Athletes without an active block", for the coach.

Say with the rollback of migration 11, in the words of its page: it drops the three functions and writes no row — and it is not run once the version of the app that follows wave 1 is published, which sets a block active and reorders through them and through nothing else.

Add to the rule about publishing the app ("Database first, app second"), for the checkpoint of wave 2: the build of wave 2 calls `activate_program`, `reorder_sessions` and `reorder_weeks`, so migration 11 is in the ledger before it is published — Checkpoint A3 puts it there.
