# stats-completion-rules — docs to fold (wave 3, items P11, P60, P38, B22)

Each block: target doc, section, then the text to fold in.

## docs/INVARIANTS.md — The date a session was actually trained

Replace the bullet that starts "**Rows written before the column existed degrade quietly, never by inventing a date.**" with:

- **Rows written before the column existed degrade quietly, never by inventing a date.** `buildQueue` ignores a confirmed session with no `performed_at` when computing staleness; `buildDayStrip` falls back to the day it was PLANNED for; `trainedOn` in [`useStudentProgressStats`](../src/hooks/useStudentProgressStats.js) takes `performed_at` → the confirmation's `performed_on` → the earliest `logged_at` of the session's done sets (`performedOnFromLogs`, asked only with sets that carry a time — it answers "today" for none) → the confirmation's `confirmed_at` → `scheduled_date` for a LEGACY row only, archived AND reviewed. An open session with none of these is counted in `backlogSessions` rather than parked on a made-up day; an archived one with none of these and no done set was never trained, and is in no figure (next section).

## docs/INVARIANTS.md — Stats

Add as the first bullet of the section:

- **One definition of a performed session, behind every figure of the Stats page.** `isPerformed` in [`useStudentProgressStats`](../src/hooks/useStudentProgressStats.js): confirmed, or archived with a training date (`trainedOn`) or at least one done set. Archiving is no proof of training — it is also how a coach clears a session nobody will train, and `duplicate_week` / `duplicate_program` can hand over archived sessions — so an archived session that was never trained is in NO figure: not `totalSessions` nor `totalSessionsConfirmed`, not `totalSets`, no week bucket, no progression point, not the calendar, as `buildQueue` leaves it out of the athlete's list. One that was trained keeps every figure it earned, and goes on the calendar on its training date only, never on its plan date. A session trained and NOT confirmed is dated by its done sets and counts everywhere a date counts — its week (sets, planned and performed volume), its progression point, its day on the calendar — but it is not performed: not in `totalSessionsConfirmed`, not in a week's `sessions_confirmed`, `completed: false` on the calendar. The table test "one state per row, every figure" in `src/hooks/useStudentProgressStats.test.jsx` holds each state of a set and of a session against every figure; a new state or a new figure joins it.

Replace, in the bullet that starts "**Time-based stats bucket by the REAL calendar week the student trained in**", the words "(Mon–Sun of `performed_at`)" with:

(Mon–Sun of the day `trainedOn` gives)

and the sentence "`sessionCalendar` plots trained sessions on their REAL date and open ones on the recommended date, so a session trained without any coach-set date finally appears at all." with:

`sessionCalendar` plots trained sessions on their REAL date and open ones on the recommended date, so a session trained without any coach-set date finally appears at all; an archived session is on it only where it was trained, and `completed` is `isPerformed`.

Replace, in the bullet that starts "**Stats are performance-aware: charts show PERFORMED work, not just the prescription**", the sentence "`performedReps` = a done set's `actual_reps ?? target_reps` (`??`, so a real 0 is respected; skipped/undone contribute 0);" with:

`performedReps(l, slot)` = a done set's `actual_reps ?? target_reps` (`??`, so a real 0 is respected; skipped/undone contribute 0), and 0 on a slot held for a time — `exercise_slots.duration_seconds` set, the database allows reps or a duration and never both — whatever was typed in its actual reps or in a set added to it (its done sets still count as sets done);

and the words "plus `sets_done`/`sets_prescribed` for adherence;" with:

plus `sets_done`/`sets_prescribed` for adherence and `extra_sets_done` beside them;

Add after the bullet that starts "**The flat `set_logs` list in `useStudentProgressStats` holds DONE sets and nothing else.**":

- **"Sets done" counts the PRESCRIBED sets done; the sets the athlete added are counted apart.** `totalSetsDone` goes by the rule of a week's `sets_done` — done and not `is_student_added`, out of the prescribed `totalSets` — and `totalExtraSetsDone` (`extra_sets_done` per week) holds the added ones. Both are summed over the sessions of the tree, so a row the scope did not ask for adds nothing. Added sets are real work: they stay in the volume, the tonnage and `avgRpe`. Counted with the prescribed ones, the card read "5 done, of 3 prescribed" beside a week that said 3/3. The "Sets done" card of [`StudentDashboard`](../src/components/student/StudentDashboard.jsx) and of [`StudentStatsSection`](../src/components/coach/StudentStatsSection.jsx) adds "· +N extra" (`statsCompletionRules.extraSets`) after "of N prescribed" when there are any, and nothing otherwise.
- **The `'all'` scope leaves the athlete's drafts out.** A draft (`programs.status = 'draft'`) is no block they train, and its sessions and sets lowered the completion for work nobody had asked of them yet. The tree is read with `.neq('status', 'draft')` in that scope, `applyProgramScope` puts the same filter on the three flat lists (`status` is in their `programs!inner(…)` embed), and the hook skips a program row that says it is a draft all the same. `'active'` cannot be a draft (`programs_draft_not_active`), and a draft picked by its id is still shown; neither asks. Blocks approved and not yet started stay in `'all'`.

## docs/ARCHITECTURE.md — Program periodization (multiple blocks per student)

In the bullet that starts "**`useStudentProgramDetails`** is the lighter stats-free fetch", replace "pass `scope` to choose 'all' programs, only the 'active' one, or a specific program id." with:

pass `scope` to choose 'all' programs (drafts left out), only the 'active' one, or a specific program id.

## CLAUDE.md — Feature → files map, row "Student stats (bucketed by REAL calendar weeks)"

Replace "`hooks/useStudentProgressStats` (buckets on `sessions.performed_at`; `backlogSessions` holds undated work; `{ enabled }`; the three flat lists read together; the previous scope of the same athlete stands in while a new one loads)" with:

`hooks/useStudentProgressStats` (`isPerformed` — one definition of a performed session: confirmed, or archived with a date or a done set; an archived session never trained is in no figure — and `trainedOn` — the day every time-based figure keys off: `performed_at`, the confirmation, the earliest done set, the plan date of a legacy archived-and-reviewed row; a session trained and not confirmed is dated, not done; `backlogSessions` holds undated open work; `totalSetsDone` prescribed sets only, `totalExtraSetsDone` apart; drafts out of `'all'`; `{ enabled }`; the three flat lists read together; the previous scope of the same athlete stands in while a new one loads; the table test "one state per row, every figure"), strings of the "+N extra" in `lib/i18n/fragments/stats-completion-rules.*` (namespace `statsCompletionRules`)

## CLAUDE.md — Feature → files map, row "Performance-aware stats"

Replace "`hooks/useStudentProgressStats` (performed vs planned volume/tonnage + adherence;" with:

`hooks/useStudentProgressStats` (performed vs planned volume/tonnage + adherence; a slot held for a time — `duration_seconds` — adds no reps, whatever was typed;
