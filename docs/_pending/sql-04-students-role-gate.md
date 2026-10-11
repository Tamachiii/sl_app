# sql-04-students-role-gate — docs to fold (wave 1, items P7, L2)

Each block: target doc, section, then the text to fold in.

## docs/INVARIANTS.md — RLS / DB conventions

Add after the bullet that starts "**Signups are always `role='student'`**":

- **`students` is the root of authorization, and no signed-in user creates, deletes or moves a link.** Every "Coaches …" policy asks this table who coaches whom, so a row that should not exist gives its `coach_id` the reach of a coach over its `profile_id`. The table has NO `INSERT` policy and NO `DELETE` policy (migration `2026_10_11_05_students_role_gate.sql`, review P7 / L2): a link is made and removed by the owner of the database in the SQL editor, or with the service-role key. `Coaches update their students` stays, for the coach of the row who is a coach, with a `WITH CHECK` — for the columns that are not the link. `trg_check_students_link` (`check_students_link()`, `BEFORE INSERT OR UPDATE`) holds what a row may say **for every writer, `postgres` and the service role included**: `coach_id` is a profile with the role `coach`, `profile_id` one with the role `student`, and they are two profiles (`23514`); with a user id, `id`, `profile_id` and `coach_id` do not change at all (`42501`, `the coach-athlete link … cannot be changed from the app`), whatever role the statement runs as — so a function that moves an athlete is not granted to `authenticated`. A row whose link does not move is not judged again: a column next to it can always be written. Never add a write policy on `students` that reads `coach_id = auth.uid()` alone — any account can put its own id there, which is how an athlete made itself the coach of its coach. The app only reads the table. KNOWN residual gap: the trigger judges a link when it is written, not when a role changes — promoting a profile that is somebody's athlete, or demoting a coach who has athletes, leaves a link the gate would refuse; `profiles.role` is written by the owner only. `supabase/tests/students-gate.test.js` holds all of it.
- **A policy that lets a COACH write asks for the role: `(SELECT public.is_coach())`.** `is_coach()` (SECURITY DEFINER, STABLE, in the allow-list of `authenticated`) is true when the caller's profile has the role `coach`; `profiles.role` cannot be written by a signed-in user. `Coaches manage own library` on `exercise_library` asks it in its `WITH CHECK`, so only a coach adds or edits a library row; its `USING` is still `coach_id = auth.uid()` alone, because a `FOR ALL` policy's `USING` is also what a `SELECT` goes through, and `is_coach()` is not executable without a session — a read that answered "no rows" would answer `permission denied for function is_coach`. For the same reason an `INSERT` or an `UPDATE` on `exercise_library`, and an `UPDATE` on `students`, sent without a session are refused with that message (`42501`, mapped to `errors.notAllowed`) where row-level security used to answer. Written as a sub-select the function is asked once per statement, not once per row.
- **The exercise of a slot, and the substitute of a swap, come from the library of the program's coach — asked when the row is created or the exercise changes.** `trg_check_slot_exercise_in_coach_library` (`BEFORE INSERT OR UPDATE OF exercise_id` on `exercise_slots`) and `trg_check_deviation_substitute_in_coach_library` (`BEFORE INSERT OR UPDATE OF substitute_exercise_id` on `slot_deviations`) compare `exercise_library.coach_id` with `students.coach_id` of the athlete the program belongs to and raise `23514` (`… is not in the library of the coach of this program`), for every writer. They do NOT judge a row whose exercise stays what it is: after an athlete changed coach, the slots and swaps that still hold the former coach's exercises can be edited in every other column, and take an exercise of the new library the day theirs is replaced. Two consequences to keep in mind: **a copy is an `INSERT`** — duplicating a session, a week or a program that holds another coach's exercise is refused until that exercise is replaced, and a function that copies slots must decide what it does with such a slot before it inserts; and **the app saves a swap as an upsert**, for which PostgreSQL fires the `INSERT` trigger on the proposed row even when the row exists — the deviation trigger therefore lets an `INSERT` through when the slot already has a deviation with that same substitute (the statement can only become the `UPDATE` of that row). Remove that exception and a swap made before a change of coach can no longer take a note.

Replace, in the bullet that starts "**Structural deviations: students can swap/skip an exercise, skip a set, or add an extra set", "`substitute_exercise_id` FK to the coach's library — **library-only, no free-text**, so swaps stay known exercises for stats" with:

`substitute_exercise_id` FK to `exercise_library`, held to the library of the program's coach by `trg_check_deviation_substitute_in_coach_library` — **library-only, no free-text**, so swaps stay known exercises for stats

Replace, in the bullet that starts "**Every migration signs the ledger, and refuses to run twice or out of order.**", "a rollback raises `SLM03` when there is nothing to roll back and `SLM04` when a later migration still needs what it would remove." with:

a rollback raises `SLM03` when there is nothing to roll back and `SLM04` when a later migration still needs what it would remove. A migration that brings a rule raises `SLM05` when rows that are already in the database break it and would keep the hole in use (migration 05: a `students` link whose coach is not a coach): its audit counts them, its runbook page lists and removes them, and the file is run again — it never deletes them itself.

## docs/ARCHITECTURE.md — Auth and Row-Level Security

Add after the paragraph that starts "Tables like `set_logs`, `session_confirmations`, `slot_comments`, `exercise_slots`, and `set_log_videos` all use these helpers":

**Who coaches whom.** Both helpers end at `public.students (profile_id, coach_id)`: one row per athlete, naming their coach. It is the root of the model — a coach reads and writes an athlete's programs, sets, videos, bodyweight, goals and messages because a row of this table says so — and it is written by the owner of the database only: the table has no `INSERT` and no `DELETE` policy, and `trg_check_students_link` requires, of every writer, a `coach_id` with the role `coach` and a `profile_id` with the role `student`. Each coach has a library (`exercise_library.coach_id`), written by a coach only (`is_coach()`), and the exercise of a slot or of a swap is taken from the library of the program's coach (two triggers, asked on insert and when the exercise changes). A new athlete is linked in the SQL editor: `docs/runbook/migrations/05-students-role-gate.md`, "Linking an athlete to a coach".

## CLAUDE.md — Feature → files map, row "Supabase Auth settings (dashboard-only: sign-up off, site URL, redirect list, password length)"

Add after that row:

| Coach ↔ athlete link (who coaches whom cannot be forged; a library is a coach's) | `supabase/schema.sql` section "THE COACH ↔ ATHLETE LINK": `students` has no INSERT and no DELETE policy, `trg_check_students_link` (coach role, student role, two profiles, for every writer; the link does not move with a user id), `is_coach()` (asked by `Coaches update their students` and by the `WITH CHECK` of `Coaches manage own library`), `trg_check_slot_exercise_in_coach_library` + `trg_check_deviation_substitute_in_coach_library` (an exercise of the program coach's library, on insert or when the exercise changes). Migration `2026_10_11_05_students_role_gate.sql` (refuses with `SLM05` on a link the gate would refuse); tests `supabase/tests/students-gate.test.js`; the owner's statement to link an athlete in `docs/runbook/migrations/05-students-role-gate.md`. The app only reads `students` (`hooks/useStudents`) |

## CLAUDE.md — Feature → files map, row "Migrations + ledger (how a DB change is written and tracked)"

Replace "refusal codes `SLM01`–`SLM04`" with:

refusal codes `SLM01`–`SLM05`

## CLAUDE.md — Feature → files map, row "DB / RLS test suite (`npm run test:db`)"

Add to the row's file list, after the entry for `history-guards.test.js` (the one `docs/_pending/sql-03-history-guards.md` adds):

`students-gate.test.js` (the coach ↔ athlete link: nobody inserts, deletes or moves a `students` row through the API; a link joins a coach and an athlete for `postgres` and the service role too; `is_coach()`; the library written by a coach only; a slot and a swap take an exercise of the program coach's library, and what a change of coach left stays editable; the deployed app's library, slot and swap writes replayed; migration `2026_10_11_05_students_role_gate.sql` tried on the frozen baseline — hole before, closed after, back after its rollback, refused on a forged link — with the audit table, the list, the removal, the check and the linking statement of its runbook page read off the page)

## README.md — Database Tests

Replace "A run reports 10 files and `218 passed | 7 expected fail`" with the file and test counts of the wave-1 gate run. This package brings the count to 13 files and `416 passed | 4 expected fail`.

Add after the bullet that starts "- `history-guards.test.js` holds the rule" (the one `docs/_pending/sql-03-history-guards.md` adds):

- `students-gate.test.js` holds the rule "the coach–athlete link cannot be forged": who may write a `students` row (nobody through the API), what a row may say for every writer, the exercise library written by a coach only, and whose exercises a slot and a swap may take. A fixture that links an athlete does it as `postgres` (`createUser({ coach })`), and the coach must have been promoted first: the trigger judges fixtures too.

## README.md — Deployment

Add after the sentence "promote a coach manually via `UPDATE public.profiles SET role='coach' WHERE id = …`." of the paragraph that starts "**Auth hardening note:**":

An athlete is linked to a coach by the owner, in the SQL editor — the statement is in [docs/runbook/migrations/05-students-role-gate.md](docs/runbook/migrations/05-students-role-gate.md), "Linking an athlete to a coach". The API refuses to create, move or delete a `students` row, and the database refuses a link whose coach is not a coach or whose athlete is not a student.

## docs/RUNBOOK.md — new section "Checkpoint A2 — …", after the section of Checkpoint A1

Add when Checkpoint A2 is handed over (its row marked **ready**). The part of the sequence that belongs to migration 05, after the steps of migration 04, every command taken from `docs/runbook/migrations/05-students-role-gate.md` as it stands there, one per fence:

1. the audit of migration 05 — it reads as the "before" column of the page's table. **Line 11 must read `0`**: otherwise the page's section "Links the gate refuses" (the list, then the removal of one link), and the audit again. Lines 12 to 14 are `0`, or are reported and do not stop anything;
2. the migration — a refusal with code `SLM05` is line 11 again;
3. the audit again — lines 2 to 7 and 9 read as the "after" column;
4. the page's check, which must fail with `check only, nothing was written: protected: …`;
5. the smoke check in the app that is deployed, as the coach (step 4 of the page's "After": the library, then an exercise added to and removed from a session of the test athlete), only once step 4 above answered `protected`.

Add to the rules of the index, or to the first-push checklist, one line: from migration 05 on, a new athlete is linked to their coach with the statement of that page ("Linking an athlete to a coach") — the app has no screen for it and the API refuses.
