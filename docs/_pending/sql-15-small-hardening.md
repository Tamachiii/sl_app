# sql-15-small-hardening — docs to fold (wave 3, items L34, B12, B6, L20, B8, L28, P62, N9)

Each block: target doc, section, then the text to fold in.

## docs/INVARIANTS.md — `set_logs` — per-set targets, outcomes, RPE

Add after the bullet that starts "**A set_log has three outcome states: pending, done, failed.**":

- **An RPE is a number from 1 to 10 in steps of 0.5.** `set_logs.rpe` is `numeric(3,1)` since migration `2026_10_16_21_rpe_half_steps_day_check.sql` (review L34): `set_logs_rpe_check` holds the range and `set_logs_rpe_half_step` (`rpe * 2 = trunc(rpe * 2)`) the half steps; `numeric(3,1)` rounds a value to one decimal before either rule is asked (7.04 is stored as 7.0, 7.26 as 7.3 and refused). The API hands it over as a JSON number — `8.0`, which JavaScript reads as `8` — so a client that writes whole numbers reads them back unchanged. SQL that builds text from one prints `8.0` (`trim_scale(rpe)` prints `8`), and a function that holds one in a variable declares it `numeric`: an `integer` rounds 7.5 to 8 without a word. A set with an RPE of 7.5 is logged like any rated set (`set_log_is_logged`). The rollback of migration 21 rounds a half step up.

## docs/INVARIANTS.md — Training is a QUEUE; the calendar is a consequence

In the bullet that starts "**`sessions.day_number` is a RECOMMENDED weekday (1 = Mon … 7 = Sun) and is NULLABLE**", add at the end:

Since migration `2026_10_16_21_rpe_half_steps_day_check.sql` (review B12) the database holds it: `sessions_day_number_weekday` refuses anything but NULL or 1 to 7 (`23514`). That migration cleared every value outside 1 to 7 and every weekday of a block an athlete wrote (`programs.created_by` set — drafts and approved blocks, trained sessions included), whose builder has no weekday control: those were positions or the coalesced Monday. `save_draft_tree` writes a number outside 1 to 7 as NULL rather than refuse the whole tree — what a phone that cached its draft before that migration still sends. The coach's editor writes 1 to 7 or NULL (`nextFreeDayNumber` of `lib/day.js` stops at 7), and the four copy functions copy the value as it is.

## docs/INVARIANTS.md — RLS / DB conventions

In the bullet that starts "**`client_errors` also holds lines the database wrote: `role = 'database'`, `user_id` NULL.**", replace "A policy that narrows who reads `client_errors` keeps the lines without a `user_id` readable by a coach; a trigger that caps what an account reports lets a row without a `user_id` through." with:

"Authors and their coach read client errors" (migration `2026_10_16_22_client_errors_scope.sql`) keeps the lines without a `user_id` readable by every coach, and `trg_cap_client_errors` lets them through: it judges a request that carries a user id only.

## docs/INVARIANTS.md — RLS / DB conventions

Add after the bullet that starts "**`client_errors` also holds lines the database wrote**":

- **A client error is read by its author and by the coach of its author; a line without an author by every coach.** "Authors and their coach read client errors" (migration `2026_10_16_22_client_errors_scope.sql`, review B6, L20) replaced "Coaches read client errors", under which every coach read every line — the message, the stack, the page and the browser of the athletes of any coach. "The coach of the author" is `students.coach_id` today: a line of a former athlete is read by its author only, and one of a deleted account (`ON DELETE SET NULL`) by every coach. "Is a coach" is asked of `profiles` in the policy itself, not with `is_coach()`. `useClientErrors` is unchanged: it reads for a coach only.
- **An account keeps 30 client errors an hour, dated when they arrive.** `trg_cap_client_errors` (`cap_client_errors()`, `SECURITY DEFINER`, `BEFORE INSERT`) sets `created_at := now()` for a request that carries a user id — a date the client sends would escape both the hour and `run_retention()` — and drops the line without a word (`RETURN NULL`) once the caller has 30 lines of the last hour, counted by `auth.uid()`. The request answers as if the line was kept; `errorReporter.js` ignores the answer either way. The owner, the service role, the job of migration 19 and a restore are not judged. Two requests in the same instant can both pass at 29: a ceiling of about 30, not a count. Nothing old is deleted there: `run_retention()` does.

## docs/INVARIANTS.md — RLS / DB conventions

In the sub-bullet that starts "**What it does not move.**", replace "The exercises: the slots of the athlete's programs and their goals keep pointing at the former coach's library, which neither the athlete nor the new coach can read — sessions show exercises without a name until an exercise is readable through the program that uses it." with:

The exercises: the slots of the athlete's programs, their swaps and their goals keep pointing at the former coach's library. The athlete and the new coach read those exercises — and nothing else of that library — through "Users read the exercises their training uses" (next bullet); neither may write one, and a new slot, swap or copy takes an exercise of the library of today.

## docs/INVARIANTS.md — RLS / DB conventions

Add after the bullet that starts "**An athlete changes coach with `public.transfer_student(athlete profile id, new coach profile id)`, and with nothing else.**" (after its sub-bullets):

- **An exercise is read by its coach, by that coach's athletes, and by whoever reads something that uses it.** "Users read the exercises their training uses" (migration `2026_10_16_23_library_read_follows_program.sql`, review B8) asks `exercise_readable_through_use(exercise)` — `STABLE`, `SECURITY DEFINER`, in the allow-list of `authenticated`, true or false and never NULL — whether a slot of a program the caller reads as its athlete or its coach (`students.profile_id` / `students.coach_id`, the policies of `programs`), a swap on such a slot, or a goal the caller reads names the exercise. Without it, after a change of coach the app embedded NULL for every exercise of the blocks written before it and broke. The policy is for `SELECT` only and its name sorts after "Coaches manage own library" and "Students read their coachs library": PostgreSQL asks permissive policies in the order of their names and stops at the first yes, so an exercise of the caller's library or their coach's never reaches the function. A new reference to `exercise_library` that an athlete or their coach reads joins the function. `useExerciseLibrary` reads an athlete's library without a filter: after a change of coach the exercises of the former coach their training uses are in the swap picker of `SlotDeviationBar`, where `trg_check_deviation_substitute_in_coach_library` refuses a swap to one (`23514`), and in the picker of `StudentProgramAuthor`, where `save_draft_tree` refuses the whole tree once one is picked (`exercise_unavailable`; `draftSaveErrorHandler` keeps the draft on the device until the exercise is taken out). A goal is the one use without a library rule: `goals.exercise_id` may name an exercise of any library (slots and swaps have the gates of migration `2026_10_11_05_students_role_gate.sql`, goals none), so a coach who writes a goal through the API on an exercise of another library — by its id — reads that exercise through the policy.

## docs/INVARIANTS.md — RLS / DB conventions

Add after the bullet that starts "**An exercise is read by its coach, by that coach's athletes, and by whoever reads something that uses it.**":

- **Every foreign key of `public` has an index that starts with its column, and no index repeats the first column of a unique key.** Migration `2026_10_16_24_indexes_cleanup.sql` (review L28, P62) dropped nine indexes a unique key stood in for (`idx_students_profile_id`, `idx_weeks_program_id`, `idx_sessions_week_id`, `idx_set_logs_slot_id`, `idx_session_confirmations_session_id`, `idx_slot_comments_slot_id`, `idx_slot_deviations_slot_id`, `idx_set_log_videos_set_log`, `bodyweight_logs_student_idx`) and indexed the foreign keys that had none: `client_errors (user_id, created_at DESC)` — what the cap counts —, `exercise_slots (exercise_id)` — what `exercise_readable_through_use` reads —, `goals (coach_id)`, `slot_comments (student_id)`, `slot_deviations (student_id)` and `(substitute_exercise_id)`, and `messages (sender_id, created_at DESC)` and `(recipient_id, created_at DESC)`, a conversation from one side, newest first. A new foreign key gets its index in its migration — its own, a unique key that starts with its column, or one on `WHERE <column> IS NOT NULL`; `supabase/tests/small-hardening.test.js` asks the catalog. The six indexes the advisors call unused stay until measured after the policies of wave 4.

## docs/INVARIANTS.md — Messaging / notifications

In the bullet that starts "**Messaging is realtime + RLS-scoped.**", replace "Only the recipient UPDATEs — the `BEFORE UPDATE` trigger pins every column except `read_at` (including `session_id`)." with:

Only the recipient UPDATEs — the `BEFORE UPDATE` trigger (`lock_message_fields_on_update`) pins every column except `read_at`, `session_id` included, except when the session it names is gone: then the UPDATE is the `ON DELETE SET NULL` of the foreign key, and NULL goes through (migration `2026_10_16_24_indexes_cleanup.sql`, review N9). Putting the id back left a feedback message naming a deleted session, and made the delete fail within the transaction that wrote the message. A feedback message whose session was deleted is an ordinary message: its sender may delete it.

## docs/ARCHITECTURE.md — Data model

In the diagram, replace "sessions (id, week_id, title, day_number 1..7, scheduled_date, sort_order, archived_at)" with:

sessions (id, week_id, title, day_number NULL|1..7, scheduled_date, sort_order, archived_at)

and replace "          weight_kg, rpe, done, logged_at)" with:

          weight_kg, rpe numeric(3,1) 1..10 by 0.5, done, logged_at)

## docs/ARCHITECTURE.md — Data model

In the bullet that starts "**`exercise_library`** — each coach owns a library;", add at the end:

It is read by its coach, by that coach's athletes, and — since migration `2026_10_16_23_library_read_follows_program.sql` — by whoever reads a slot, a swap or a goal that names one of its exercises: after a change of coach, the athlete and the new coach read the former coach's exercises their training uses.

## CLAUDE.md — Feature → files map, row "Coach exercise library"

Add at the end of the row:

; an exercise is also read by whoever reads a slot, a swap or a goal that uses it — the policy "Users read the exercises their training uses" and `exercise_readable_through_use(uuid)` (migration `2026_10_16_23_library_read_follows_program.sql`), so the athlete and the new coach read the former coach's exercises after `transfer_student`

## CLAUDE.md — Feature → files map, row "Error telemetry"

Replace "migration `2026_07_13_client_errors.sql`;" with:

migrations `2026_07_13_client_errors.sql` and `2026_10_16_22_client_errors_scope.sql` (a line is read by its author and the coach of its author, a line without an author by every coach; `trg_cap_client_errors` keeps 30 lines an hour per account, dated when they arrive);

## CLAUDE.md — Feature → files map, row "Student session logging"

Add at the end of the row:

`set_logs.rpe` is `numeric(3,1)`, 1 to 10 in steps of 0.5 (`set_logs_rpe_check`, `set_logs_rpe_half_step`; migration `2026_10_16_21_rpe_half_steps_day_check.sql`)

## CLAUDE.md — Feature → files map, row "DB / RLS test suite (`npm run test:db`)"

Add before "`auth-accounts.test.js` (the "who has an account" query":

`small-hardening.test.js` (four migrations of wave 3, each as the app's requests on `schema.sql` and then on the frozen baseline — the finding before, closed after, back after its rollback — with the audit table, the check and the list of its runbook page read off the page: 21, an RPE of 7.5 saved and 7.3 refused, a weekday 1 to 7 or none, the weekdays cleared — every one of a block an athlete wrote, or with `app.day_number_clearing = 'drafts'` those of drafts only —, `save_draft_tree` writing a weekday of 9 as none; 22, who reads a client error and the cap of 30 an hour; 23, the exercises of a former coach read by the athlete and the new coach after `transfer_student`, through a slot, a swap and a goal, and written by nobody else; 24, the nine indexes gone, every foreign key indexed, a feedback message that loses its deleted session);
