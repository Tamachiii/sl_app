# sql-07-goals-fk-coach-links — docs to fold (wave 1, items P18, P21, B9)

Each block: target doc, section, then the text to fold in.

## docs/INVARIANTS.md — RLS / DB conventions

Add after the bullet that starts "**`students` is the root of authorization, and no signed-in user creates, deletes or moves a link.**" (the one `docs/_pending/sql-04-students-role-gate.md` adds) and the two bullets that follow it there:

- **What an account or a library exercise takes with it when it is deleted is decided per foreign key, and a coach's account takes nothing of an athlete's.** Migration `2026_10_13_10_goals_fk_coach_links.sql` (review P18 / L7, B9). A row that belongs to the account alone goes with it: `students.profile_id`, `goals.student_id` and the athlete's logs and messages are `ON DELETE CASCADE`. A row that somebody else's training hangs on holds the account: `students.coach_id` and `goals.coach_id` are `ON DELETE RESTRICT`, so the profile of a coach is not deleted while an athlete is linked to it or a goal names it — `23503`, nothing removed, whoever deletes (the dashboard's *Delete user* included). And a library exercise that anything names is not deleted: `exercise_slots.exercise_id`, `slot_deviations.substitute_exercise_id` and `goals.exercise_id` are all `RESTRICT`; `goal_progress` still follows its goal (`CASCADE`), because deleting a goal is its coach's decision. Three things to keep:
  - **A new reference to `profiles` or to `exercise_library` chooses its `ON DELETE` by that rule**, and a new reference to `exercise_library` also joins the three that `useExerciseUsage` counts for the delete dialog.
  - **The refusal names the first thing in the way, and which one comes first is not fixed.** The triggers of the foreign keys on one table fire in the order of their internal names, and a re-created constraint gets a new one: deleting a coach's profile is refused by `students_coach_id_fkey`, by `goals_coach_id_fkey`, or — when the `DELETE` reaches the coach's library first — by `exercise_slots_exercise_id_fkey` or `goals_exercise_id_fkey`. Code that reads the error goes by `23503`, never by the constraint name; `supabase/tests/goals.test.js` asserts the name only where one key alone is in the way.
  - **A coach whose athletes moved on with their programs cannot be deleted**: their exercises are still in those sessions. The account stays (`docs/runbook/migrations/10-goals-fk-coach-links.md`, "Removing a coach's account").
- **`exercise_library.archived_at` takes an exercise out of the pickers, and the database refuses nothing about an archived exercise.** The column exists since migration `2026_10_13_10_goals_fk_coach_links.sql` because an exercise that was ever used can no longer be deleted. It is written by the owner of the row through `Coaches manage own library` and read by their athletes like any other column: an archived exercise is still the name of what they trained. A slot that holds one stays, a new slot can take one, a goal on one is still logged against, and a function that copies sessions copies their slots whatever `archived_at` says — "not offered for new work" is the client's rule ([`isActiveExercise`](../src/hooks/useExerciseLibrary.js)). Do not add a constraint or a trigger that refuses one: every copy of a block that uses it would fail.
- **"The coach of this athlete" is `students.coach_id` today — never a column that remembers who wrote a row.** `goals.coach_id` says who manages a goal; who may read what hangs under it is asked of the link as well. `coach_profile_for_goal(goal)` — the helper the read policy of `goal_progress` is written with — answers the profile that set the goal only while `students` links it to the goal's athlete, and NULL otherwise (migration `2026_10_13_10_goals_fk_coach_links.sql`, review P21: it used to answer `goals.coach_id` alone, and a former coach went on reading every attempt of an athlete who had moved). That is the rule `Coaches manage goals for their students` already asked of the goal itself. A new policy for a coach on a table that carries its own `coach_id` asks the link too, directly or through such a helper.
- **An athlete changes coach with `public.transfer_student(athlete profile id, new coach profile id)`, and with nothing else.** It moves `students.coach_id` and hands the athlete's goals to the new coach (`goals.coach_id`) in one statement, and returns `{ student_id, from_coach_id, to_coach_id, link_moved, goals_moved }`; called with the coach the athlete already has, it moves no link and hands over the goals a former coach still held. Rewriting `students.coach_id` by hand leaves the goals with a coach who can no longer read them, and no coach reads their progress until they are handed over. It is for a caller without a user id — the SQL editor, the service-role key: it is not granted to `authenticated`, it raises `42501` first thing when `auth.uid()` is not NULL, and it is `SECURITY INVOKER`, so it has no right its caller lacks; `trg_check_students_link` refuses the move with a user id whatever function it comes from, and judges the new link (a coach, an athlete, two profiles). Rules to keep:
  - **A table that gets a `coach_id` next to a `student_id` joins the body of `transfer_student`** — in its migration and in `schema.sql` — or its comment says why the rows stay with the former coach.
  - **A screen that moves an athlete calls it from an Edge Function with the service-role key**, never through a `SECURITY DEFINER` wrapper: inside a user's request `auth.uid()` is still that user, and both the function and the trigger refuse.
  - **What it does not move.** The exercises: the slots of the athlete's programs and their goals keep pointing at the former coach's library, which neither the athlete nor the new coach can read — sessions show exercises without a name until an exercise is readable through the program that uses it. The conversation with the former coach: both keep their messages, the two can no longer write to each other, and a message of the former coach that the athlete had not opened stays counted by `useUnreadMessageCount`, which counts every unread message addressed to the user while `StudentMessages` shows the conversation with the coach of today only. The former coach's notifications about the athlete.

Replace, in the bullet "**A library exercise that is in use is not deleted, and the client decides that on a usage read made since the dialog opened.**" that `docs/_pending/coach-tenant-filters-library.md` adds, the sentence "The database refuses the same delete for slots and swaps, and for goals once `goals.exercise_id` is RESTRICT (migration 10); the dialog does not depend on that, and where the key still cascades it is what keeps the athletes' goals and their logged progress." with:

The database refuses the same delete for all three (`ON DELETE RESTRICT`; for goals since migration `2026_10_13_10_goals_fk_coach_links.sql`); the dialog does not depend on that, and against a database that does not have the migration yet it is what keeps the athletes' goals and their logged progress.

## docs/ARCHITECTURE.md — Data model

Replace "- **`goals`** + `goal_progress` — student-chosen target lifts, coach can also author them. See [src/hooks/useGoals.js](../src/hooks/useGoals.js)." with:

- **`goals`** + `goal_progress` — a goal is set by a coach (`coach_id`), on an exercise of their library (`exercise_id`), for one athlete (`student_id`, a profile id); the athlete logs attempts against it in `goal_progress` and marks it achieved. The goal goes with its athlete's account (`CASCADE`), and holds its coach's profile and its exercise (`RESTRICT`); its attempts follow it. The coach who set a goal reads and manages it, and reads its attempts, while they coach its athlete; `transfer_student` hands the goals over when the athlete changes coach. See [src/hooks/useGoals.js](../src/hooks/useGoals.js).

Replace "- **`exercises`** — each coach owns a library; slots reference by `exercise_id`." with:

- **`exercise_library`** — each coach owns a library; slots, swaps and goals reference it by id, and an exercise that any of them names cannot be deleted (`RESTRICT`). `archived_at` takes it out of the pickers instead; the rows that name it keep reading it.

## docs/ARCHITECTURE.md — Auth and Row-Level Security

Add after the paragraph that starts "**Who coaches whom.**" (the one `docs/_pending/sql-04-students-role-gate.md` adds):

**Changing coach.** `public.transfer_student(athlete, new coach)` is the one way an athlete moves: it rewrites `students.coach_id` — which every "Coaches …" policy follows at once, so the new coach reads the programs, sets, videos and bodyweight and the former one none of them — and `goals.coach_id` of the athlete's goals in the same statement. It is called by the owner of the database or with the service-role key, runs with the rights of its caller, and refuses a request that carries a user id. The exercise library does not move: the athlete's slots and goals keep the ids of the former coach's exercises.

## CLAUDE.md — Feature → files map, row "Coach goals (per student)"

Add to the end of the row:

. In the database (migration `2026_10_13_10_goals_fk_coach_links.sql`): a goal holds its exercise and its coach's profile (`ON DELETE RESTRICT`) and goes with its athlete's account; `coach_profile_for_goal` — the helper of the coach's read policy on `goal_progress` — follows the coach–athlete link; `transfer_student(athlete, new coach)` moves the link and the goals together, for the owner of the database only (`docs/runbook/migrations/10-goals-fk-coach-links.md`)

## CLAUDE.md — Feature → files map, row "Coach exercise library"

Add to the end of the row:

; `exercise_library.archived_at` (migration `2026_10_13_10_goals_fk_coach_links.sql`) is the column an exercise in use is archived with — the database refuses nothing about an archived exercise

## CLAUDE.md — Feature → files map, row "DB / RLS test suite (`npm run test:db`)"

Add to the row's file list, after the entry for `review-lifecycle.test.js` (the one `docs/_pending/sql-06b-review-lifecycle.md` adds):

`goals.test.js` (goals outlive a library clean-up and a change of coach: the library delete of the deployed app refused as "in use" with the goal and its attempts kept; an exercise archived, restored and still read by its athletes; the account of a coach held by a link, by a goal, by an exercise in use — and an athlete's account still going with what is theirs; who reads `goal_progress` while the link stands, once it is moved by hand and once it is removed; `transfer_student` as the owner, the service role, every signed-in user and a function that runs as its owner inside a user's request; migration `2026_10_13_10_goals_fk_coach_links.sql` tried on the frozen baseline — holes before, closed after, back after its rollback — with the audit table, the check and the statements of its runbook page read off the page)

## README.md — Database Tests

Replace "A run reports 10 files and `218 passed | 7 expected fail`: the seven are the holes of the 2026-09-30 review that are still open, kept as `it.fails` in `known-holes.test.js` until their migration lands." with the file and test counts of the wave-1 gate run. This package brings the count to 21 files and `763 passed`, with no expected failure left: the last `it.fails` of `known-holes.test.js` (P18 / L7) is a plain test, and the sentence about the open holes goes.

Add after the bullet that starts "- `review-lifecycle.test.js` holds" (the one `docs/_pending/sql-06b-review-lifecycle.md` adds):

- `goals.test.js` holds what a deleted exercise or account takes with it, and who reads a goal's attempts. A test that deletes a profile asserts `23503` and that nothing went — not which foreign key said so: PostgreSQL names the first one it meets, and that order changes with the internal names of the constraints' triggers, from one database to the next. Where the name matters, the test builds the case in which one key alone is in the way.

## docs/RUNBOOK.md — new section "Checkpoint A2 — …", after the section of Checkpoint A1

Add when Checkpoint A2 is handed over (its row marked **ready**). The part of the sequence that belongs to migration 10, after the steps of migration 09, every command taken from `docs/runbook/migrations/10-goals-fk-coach-links.md` as it stands there, one per fence:

1. the audit of migration 10 — it reads as the "before" column of the page's table. **Line 11 must read `none`**: otherwise stop and report the line, the migration would undo itself. **Lines 12 and 13 are noted**: goals set by a coach who no longer coaches the athlete — `0` is expected; any other number stops nothing, and the goals are handed over after the migration with the page's section "Goals left with a former coach". Lines 14, 16 and 17 are information;
2. the migration — on `canceling statement due to lock timeout` or `deadlock detected`, run the file again: it holds `profiles`, `students`, `goals` and `exercise_library` for an instant;
3. the audit again — lines 2 to 7 read `yes`, the others are those of step 1;
4. the ledger: ten rows, the last one `2026_10_13_10_goals_fk_coach_links`;
5. the page's check, which must fail with `check only, nothing was written: protected: an exercise with a goal and a coach with an athlete are not deleted, and after a move the attempts are read by the athlete and the new coach, not by the former one` — `BROKEN` means roll back; `NOT PROTECTED`, `NOT TRIED` or a message that does not start with `check only` means stop and report;
6. the look in the app that is deployed, as the coach (step 4 of the page's "After": the Goals of the test athlete read as before), only once step 5 answered `protected`.

Say with the rollback of migration 10, in the words of its page: "I cannot delete this exercise" is not a reason to roll back when a goal is set on it; and the rollback drops the column `archived_at` — line 15 of the audit says how many archived exercises would come back into the pickers.

Add to what the coach is told at this checkpoint, two lines: from migration 10 on, a library exercise that a goal is set on can no longer be deleted — the app answers "Can’t do that — this is still in use elsewhere." — where it used to delete the goal and its logged attempts with it; delete the goal first if it is no longer wanted. And an athlete is moved to another coach by the owner, with one statement of the page ("Moving an athlete to another coach") — not before Checkpoint C1 for an athlete who already has a program.
