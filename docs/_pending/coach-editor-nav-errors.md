# coach-editor-nav-errors — docs to fold (wave 3, items P46, P49, L11, B27; parts of P53, L15, B8)

Each block: target doc, section, then the text to fold in.

## docs/INVARIANTS.md — Coach session review

Add after the bullet that starts "**The review carries the way into the editor.**":

- **A coach page says "not found" for a read that answered with nothing, and "couldn't be loaded" for a read that did not answer — never the page itself, and never one for the other.** `useSession` reads with `.maybeSingle()` and resolves `null` for a session that is not there (deleted, or not this account's); `useProgram` does the same for a block. `SessionEditor`, `SessionReview`, `CoachHome` (the athlete route) and `StudentProgrammingSection` branch in this order: data → the page; `isSuccess` with `data == null` → `CoachNotFound` (the way back: the athlete page on the session's block, the page that opened the review or `/coach/sessions`, `/coach/students`, the current block); otherwise `readState` → spinner on `loading`, `CoachReadProblem` with "Try again" (`refetch({ cancelRefetch: false })`) on `offline` and `failed`. Both components are in [`coach/CoachPageState.jsx`](../src/components/coach/CoachPageState.jsx). The order matters: `readState` reads a missing `data` as "not answered", so the `null` check comes first. Testing `isLoading` alone is the trap: a failed read rendered the full editor, empty and writable, a review titled "Session" with a feedback form, a spinner for ever, and "No students yet" to a coach with athletes.
- **A "not found" is never where a tab comes back to.** The editor and the athletes page call `useForgetCoachStudentsPath(notFound)` ([`hooks/useRememberCoachStudentsPath.jsx`](../src/hooks/useRememberCoachStudentsPath.jsx)): it removes `sl_last_coach_students_path` and marks the path in `sl_last_coach_students_path_forgotten`, which `useRememberCoachStudentsPath` skips. The mark is load-bearing: the writer sits in `CoachHome`, above the editor, and React runs a child's effects before its parent's, so a plain removal in the same render would be written back. The mark goes with the next path the writer writes. `SessionReview` writes `sl_last_coach_session` only once its session is known, and removes a saved copy of itself when it learns the session is gone: `SessionsFeed` restores that key on every visit.
- **An athlete's draft is read-only for the coach until it is approved.** `useSession` carries the block's `status` as `program_status`; on `'draft'` the session editor is read-only as a whole (title, date, every field, no "+ Add exercise", no delete), under the banner `coachEditorNavErrors.draft.editor`, and `StudentProgrammingSection` puts `coachEditorNavErrors.draft.sheet` above the sheet. Approve, send back, rename and trash stay in the program menu (`ProgramManageDialog`). A session cached by an older build has no `program_status` and is read as approved until it is read again.
- **A drag in the session editor is one mutation, drawn at once, and leaves every superset one run of two slots or more.** `planSlotDrag` in [`lib/slotOrder.js`](../src/lib/slotOrder.js) decides it: the order renumbered 0 to n-1; the dragged slot joins the superset it is dropped between two members of, stays in its own when it lands beside a member of it, and leaves it otherwise; then a superset of one is cleared, and a group found in two runs gives its later run the id of that run's first slot. Only the rows that change are written, by `useReorderSlots(sessionId)` in `hooks/useSession.js`: one request per row, sent together (no unique constraint on `exercise_slots (session_id, sort_order)`), each `.select('id').single()` so a row not updated is an error; the order is written to `['session', sessionId]` in `onMutate`, put back on an error, and read again once, by the last drag of a run (`mutationScope('slot-order', sessionId)`, `laterWriteQueued`). `SessionEditor` is mounted once per session (`key={sessionId}`) because that scope must not change while the hook lives. The editor draws a superset as the run of adjacent slots that share `superset_group` (`groupSlotsBySuperset`), so a write that only renumbered could split one.
- **A slot whose exercise the coach cannot read comes with `exercise: null`.** RLS hides the library row of another coach (a former coach's exercise after `transfer_student`). The session editor renders a card that says so in place of `ExerciseSlotRow`, which reads the exercise; the review keeps the slot under `coachEditorNavErrors.exercise.unavailableTitle`, with its sets, swap, skip, videos and notes.

## docs/INVARIANTS.md — Training is a QUEUE; the calendar is a consequence

Replace, in the bullet that starts "**"No program assigned yet" is said by a read that answered, and by nothing else.**", the words "`failed` (`isError` on a network)" with:

`failed` (`isError` on a network, or a read that answered with nothing — `isSuccess` with `data == null`, a `maybeSingle` read of a row that is not there: waiting will not bring it, so it is not `loading`)

## docs/ARCHITECTURE.md — Back-button routing in coach deep views

Replace the bullet that starts "`SessionEditor` back → `/coach/students/:studentId`" with:

- `SessionEditor` back → the athlete page on the session's block: `/coach/students/:studentId?program=<program_id>` when the session's block is not the active one (`useSession` carries `program_id` and `program_is_active`), the bare `/coach/students/:studentId` otherwise, and the editor URL's own `?program=` while there is no session. It navigates with `replace`, so the system's back from the athlete page does not open the editor again; deleting the session goes to the same place.

Add after the paragraph that starts "A page with no single logical parent uses `useBackOr(fallback)`":

Signing in returns to the link that asked for it. `ProtectedRoute` and the unauthenticated catch-all of `routes.jsx` redirect to `/login` with `state: { from }` — the path and query, `loginState(location)` in [`lib/returnPath.js`](../src/lib/returnPath.js) — and `LoginPage` navigates to `returnPathFor(role, from)` once signed in: `from` when it is a string that starts with `/${role}/`, the role's home otherwise (another role's page, `/`, a value that is not a string, `//host`, an absolute URL).

## docs/ARCHITECTURE.md — Coach-section persistence across tab switches

Add after the bullet that starts "**`sl_last_coach_students_path`**":

- **`sl_last_coach_students_path_forgotten`** — the path a page of the Athletes tab found nothing at (an athlete not on the roster, a session that is not there), written by `useForgetCoachStudentsPath` together with the removal of `sl_last_coach_students_path`. `useRememberCoachStudentsPath` does not write a path equal to it, and removes it when it writes another path.

Replace, in the bullet that starts "**`sl_last_coach_session`**", the sentence "Cleared by the review's back button and by its \"editor\" pill." with:

Written once the review's session is known to be there. Cleared by the review's back button, by its "editor" pill, and by the review itself when it learns its session is gone.

## CLAUDE.md — Feature → files map, row "Coach session editor"

Replace the row with:

| Coach session editor | `coach/SessionEditor` (mounted once per session, `key={sessionId}`; header is ONE row — back, title, recommended date; delete at the bottom as the app's only delete path. Renders INSIDE the athlete shell at `/coach/students/:studentId/s/:sessionId` — no page padding of its own. Back and delete go to the athlete page on the session's block — `?program=<program_id>` when it is not the active one — with `replace`), `coach/ExerciseSlotRow`, `coach/CoachPageState` (`CoachReadProblem` / `CoachNotFound`: a read that did not answer, a session that is not there), `hooks/useSession` (`useSession` resolves `null` for a missing session and carries `program_id`, `program_is_active`, `program_status`; `useReorderSlots` — one optimistic mutation per drag), `lib/slotOrder` (`planSlotDrag` — the order and the supersets after a drop), `hooks/useExerciseLibrary`, `hooks/useRememberCoachStudentsPath` (`useForgetCoachStudentsPath`). Locks what the athlete trained: read-only as a whole once the session is confirmed (`hooks/useSessionConfirmation` or `performed_at`) or when its block is an athlete's draft, logged sets only while it is in progress — `lib/loggedSets` (`isLoggedSet`), with a banner linking to the review. A slot with `exercise: null` (an exercise of a library the coach cannot read) is a card that says so. The delete and target hooks in `hooks/useSession` refuse or skip logged sets on their own |

## CLAUDE.md — Feature → files map, row "Auth / login"

Replace "`auth/ProtectedRoute`, `auth/RoleGate`, `routes.jsx` (`RedirectToRoleHome` waits for an unknown role)." with:

`auth/ProtectedRoute` and `routes.jsx` (`RedirectToLogin`) send to `/login` with `state.from`, and `auth/LoginPage` returns there once signed in when it is a page of the role — `lib/returnPath` (`loginState`, `returnPathFor`), `auth/RoleGate`, `routes.jsx` (`RedirectToRoleHome` waits for an unknown role).
