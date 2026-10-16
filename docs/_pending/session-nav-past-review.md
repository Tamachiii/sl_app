# session-nav-past-review — docs to fold (wave 3, items L31, L32)

Each block: target doc, section, then the text to fold in. The package also closes the greeting half of live item N7 ("No sessions logged yet" said to an athlete with confirmed sessions in earlier blocks) and the athlete's half of B8 (a session whose exercise the athlete cannot read).

## docs/INVARIANTS.md — Shell, routing, viewport

In the bullet that starts "**A page's back button calls `useBackOr(fallback)`, never `navigate(-1)` on its own.**", replace "Still on `navigate(-1)`: `student/SessionView`, `student/MyGoals`, `student/StudentProfile`." with:

The athlete's three deep pages — `student/SessionView` (both of its top bars: the session and the page that says it could not be loaded), `student/MyGoals` and `student/StudentProfile` — use `useBackOr('/student')`.

## docs/INVARIANTS.md — Training is a QUEUE; the calendar is a consequence

In the bullet that starts "**Everything already trained sits in a closed `Drawer`**", replace "but a finished session keeps its **Review session** CTA — opening an old session to see what you did is why the history is on the page, and `SessionView` already renders a past block read-only." with:

but a finished session keeps its **Review session** CTA — opening an old session to see what you did is why the history is on the page, and `SessionView` already renders a past block read-only. So does a past-block session that was trained and never confirmed: `SessionCard`'s **`hasLoggedSets`** — set by `StudentTraining` on past-block cards only, from `isLoggedSet` (`lib/loggedSets`) over the session's `set_logs` — gives a locked card that is neither confirmed nor archived the same Review CTA, and a locked card's CTA always says Review. A past-block session with no logged set gets none: its page would have nothing to show.

In the same bullet, replace "**The greeting shows at most one line, and only when it says something**: staleness when the athlete has been away, the 7-day count otherwise, and nothing at all on a fresh account — "Trained today" told them what they already knew." with:

**The greeting shows at most one line, and only when it says something**: staleness when the athlete has been away, the 7-day count otherwise — "Trained today" told them what they already knew. "No sessions logged yet" (`student.training.neverTrained`) is said only when the block being trained has sessions that are not archived, none of its confirmed sessions has a training date (`queue.daysSinceLast` is null), and `useMyConfirmedSessionIds` — every block's confirmations — has answered with none (`neverTrained` of `Greeting`). The queue knows the block being trained only: an athlete with confirmed sessions in earlier blocks, on the first session of a new one, gets no line, and so does a page whose confirmation read did not answer.

In the bullet that starts "**The training list is built from two reads, both of them kept on the device, and from nothing else.**", replace "The header request selects nothing of a session but `archived_at`; a column added to it grows what is re-serialised to IndexedDB on every change of the cache." with:

The header request selects nothing of a session but `archived_at`, and the tree of the block being trained (`ACTIVE_TREE`) selects the targets of each set and nothing the athlete logged; a column added to either grows what is re-serialised to IndexedDB on every change of the cache.

In the bullet that starts "**The sessions of a past block are a read of their own, made when its drawer opens, and never stored.**", add at the end:

Its tree (`PAST_TREE`, built by the same `programTree(setColumns)` as the active one) selects `LOGGED_SET_COLUMNS` on `set_logs` besides the targets: it is how a card knows `hasLoggedSets`. Since the read is not stored, the columns cost nothing on the device; they never move to `ACTIVE_TREE`.

## docs/INVARIANTS.md — RLS / DB conventions

In the bullet that starts "**An athlete changes coach with `public.transfer_student(", in the sub-bullet "**What it does not move.**", replace "sessions show exercises without a name until an exercise is readable through the program that uses it." with:

the embed `exercise:exercise_library(…)` of a session read comes back null for such an exercise, and the athlete's pages name it "Exercise unavailable" (`sessionNavPastReview.exerciseUnavailable`: the header and the note control of `SlotGroupCard`, the summary row of `SessionCard`) until it is readable through the program that uses it. Code of the session page reads `slot.exercise?.…`, never `slot.exercise.…`: a null exercise used to throw and take the whole page down.

## docs/ARCHITECTURE.md — Session & UI behavior patterns

In the bullet that starts "**`SessionCard`** supports controlled and uncontrolled open state.", replace "`locked` drops the start affordance for a past block's read-only sessions." with:

`locked` drops the start affordance for a past block's read-only sessions; `hasLoggedSets` gives such a session the Review CTA when it is neither confirmed nor archived and one of its sets was logged.

## CLAUDE.md — Feature → files map, row "Back button on a deep-linked page"

Replace the row's file list with:

`hooks/useBackOr` (`useBackOr(fallback)` — one step back, or the fallback with `replace` on the first entry of the tab; the athlete's `student/SessionView`, `student/MyGoals` and `student/StudentProfile` call it with `'/student'`), `hooks/useBackOr.test.jsx` (both routers), `student/MyGoals.test.jsx`, `student/StudentProfile.test.jsx`, `student/SessionView.test.jsx` ("the way back")

## CLAUDE.md — Feature → files map, row "Student training surface (ONE page: was Home + Sessions)"

Replace "`student/SessionCard` (`locked` suppresses the start affordance on past-block sessions)" with:

`student/SessionCard` (`locked` suppresses the start affordance on past-block sessions; `hasLoggedSets` keeps Review on an unconfirmed one with a logged set; an exercise the athlete cannot read is listed as `sessionNavPastReview.exerciseUnavailable`)

In the same row, replace "`useStudentPastProgram` — the sessions of one past block, read when its drawer opens, key `studentPastProgramKey`, not persisted" with:

`useStudentPastProgram` — the sessions of one past block, read when its drawer opens, key `studentPastProgramKey`, not persisted, its sets with `LOGGED_SET_COLUMNS` of `lib/loggedSets`

## CLAUDE.md — Feature → files map, row "Student session logging"

Replace "`student/SessionView`, `student/SetRow`, `student/RpeInput`," at the start of the row with:

`student/SessionView`, `student/SetRow`, `student/RpeInput`, `student/SlotGroupCard` (an exercise the athlete cannot read — a former coach's library, `exercise` null — is named `sessionNavPastReview.exerciseUnavailable`),
