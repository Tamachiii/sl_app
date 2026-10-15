# session-touch-undo — docs to fold (wave 3, items P68, L12)

Each block: target doc, section, then the text to fold in.

## docs/INVARIANTS.md — `set_logs` — per-set targets, outcomes, RPE

Replace, in the bullet that starts "**A set_log has three outcome states: pending, done, failed.**", the sentence "UI: on mobile, [SetRow.jsx](../src/components/student/SetRow.jsx) commits a swipe right-to-left as done and left-to-right as failed (commit threshold 64px, gated on horizontal-dominant motion so vertical scroll still wins); tapping the indicator cycles `neutral → done → failed → neutral` so a single button reaches every state without swiping." with:

UI: on mobile, [SetRow.jsx](../src/components/student/SetRow.jsx) commits a swipe right-to-left as done and left-to-right as failed (commit threshold 64px, gated on horizontal-dominant motion so vertical scroll still wins). On the indicator, **a tap never makes a set failed**: it marks a pending set done and clears a failed one, and on a done set it writes nothing — it shows `sessionTouchUndo.holdToFail` for `HOLD_HINT_MS` (4 s). **Failed is a hold**: a press of `LONG_PRESS_MS` (500 ms) on the indicator marks a pending or a done set failed (`holdToFail` → `markFailed`). A finger that travels more than `LONG_PRESS_SLOP_PX` (10 px), a `pointercancel` (the browser taking a vertical pan) or a release before the delay holds nothing — the row is `touch-action: pan-y`, so the browser never cancels a horizontal drag and the travel itself ends the hold — and the click that ends a hold that fired is not taken for a tap (`press.current.fired`). The context menu of the indicator is the hold for whoever cannot hold (WCAG 2.1.1): a right click, the menu key or Shift+F10, and Android, which opens it on a long press — `handleIndicatorContextMenu` marks the set failed and shows no menu, once per press. The indicator is `select-none` with no touch callout. Its name on a done set is `sessionTouchUndo.doneIndicatorLabel` ("Done. Hold to mark set failed"). Tests: `src/components/student/SetRow.test.jsx` ("a hold on the indicator marks the set failed", fake timers and pointer events).

Add after the bullet that starts "**Structural deviations: students can swap/skip an exercise, skip a set, or add an extra set**":

- **What a tap on a set or an exercise loses has a way back, and skipping an exercise asks first.** Three places in the athlete's session (review P68, L12):
  - **Removing an extra set** (the "Extra ✕" chip of `SetRow`) is followed by a `sessionTouchUndo.setRemoved` toast with Undo. `useRemoveStudentSet` answers `{ logId, removed }` — the row as the DELETE returned it (`.select()`), or `null` when the policy filtered the DELETE (a session closed since the page read it: no error, no row, and then no toast). Undo is `useAddStudentSet` with `restore: removed`: an INSERT with the set's own `id`, `done`, `failed`, `rpe`, `logged_at`, `failed_at`, `actual_reps` and `actual_weight_kg`, no target. A `23505` on its number (taken meanwhile by "+ Add set") reads the slot's sets and inserts after the last; its `id` already there is the set back already. The insert is online-only: without a network the Undo inserts nothing and says so (`sessionTouchUndo.undoNeedsNetwork`). A video of the set is not brought back (its `set_log_videos` row went with the set). **An INSERT trigger on `set_logs` that rewrites an athlete's insert must keep these columns, or the Undo brings back an empty extra set.**
  - **Skipping a set** clears its outcome, its dates, its RPE and its actual values (`patchForSkipped(true)`), so it is followed by a `sessionTouchUndo.setSkipped` toast whose Undo writes them back, as read at the tap (`outcomeOf`): `setSkipped(false)`, then `toggleDone` with `at` = the old `logged_at` (or `setFailed` with the old `failed_at`), `setRpe`, `logActual` — queued writes on the row's FIFO scope, so they land in that order, each row they leave passes the CHECKs, and the Undo works offline. After a skip made on the row, the strip's Undo is the same way back and closes the toast (`takeBackSkip`, once); on a set skipped before the row was shown it only drops the flag. `patchForSkipped(false)` stays `{ skipped: false }`: a write queued by an older build carries it. Tests: `SetRow.test.jsx`, `SetRow.replay.test.jsx` (the database ends with the set as it was).
  - **Skipping an exercise** (`SlotDeviationBar`) opens a `ConfirmDialog` — "Skip {name}?", the coach will be notified, the sets are hidden until the skip is undone (`sessionTouchUndo.skipExercise*`) — and `useSaveSlotDeviation` is called only on its answer: the `slot_deviations` INSERT notifies the coach, bell and push, the moment it is written. Undo deletes the row, and `retract_slot_deviation_notifications` takes back the unread notification; a push already delivered stays delivered.

  An Undo toast is pushed from the promise of `mutateAsync` or at the tap, never from a per-call `onSuccess`: `useRemoveStudentSet`'s `onSettled` reads the sets again before the mutation settles, the row has unmounted by then, and a per-call callback of an unmounted observer is never called. The toast's `onClick` runs on a row that may be gone; it calls the `mutate` of hooks the row held, which still run.

## docs/INVARIANTS.md — Rest timer

Replace, in the bullet that starts "**The rest timer and the RPE selector follow the athlete's gestures, never a change of the row.**", the words "the handlers of the tap and of the swipe call three functions" with:

the handlers of the tap, of the hold on the indicator (and of its context menu) and of the swipe call three functions

Add at the end of the same bullet:

The Undo of a skip (`takeBackSkip`) starts no rest: the rest the skip cleared was the rest of a set done earlier.

## docs/INVARIANTS.md — Stats

Add after the bullet that starts "**"Last time" does not depend on the order its rows arrive in.**":

- **The "Last time" hint keeps its place while it is read, so the sets do not move when it arrives.** It reads the athlete's whole history and arrives after the sets (1.55 s against 0.77 s on a gym's 4G in the live review): it pushed every row down by its height under a finger on its way to set 1. [`SessionView.jsx`](../src/components/student/SessionView.jsx) passes `lastPerformanceLoading` down `SlotGroupCard` to each `SlotBody` (superset included) — true while the `useLastPerformance` read is pending and in flight, or pending while the swaps it is keyed on are being read (`useSlotDeviations` not yet fetched and fetching). The card then shows `LastTimePlaceholder`, the hint's own box (`HINT_BOX`, the same two lines of type), `aria-hidden`, in the hint's place. A read paused without a network, or that failed, keeps no place — it would be kept for good. An exercise without history gives its place back once the answer is there. Tests: `src/components/student/SlotGroupCard.test.jsx`, `src/components/student/SessionView.test.jsx` ("the place of the "Last time" hint").

## docs/DESIGN_SYSTEM.md — 44px targets — `sl-pill-btn` and `sl-hit`

Replace "Used by `ui/ToastHost` (the action pill and the dismiss icon)." with:

Used by `ui/ToastHost` (the action pill and the dismiss icon) and by the athlete's session: every pill that is a button is `sl-pill sl-pill-btn` — Swap, Skip, Change, Undo and "make this permanent" in `student/SlotDeviationBar`, "+ Add set" in `student/SlotGroupCard`, "Add note" in `student/SlotCommentBox`, the Undo of a skipped set and the Extra chip in `student/SetRow`, "Reply in messages" in `student/SessionView`. The way back of the session bar is `w-11 h-11`, and so is the slot across from it (`min-w-11 h-11`), which keeps the title centred. The exercises of the swap picker and the two fields of the Actual editor are `min-h-11`. `student/RpeInput` is two rows of five buttons (`grid-cols-5`), each `h-11`: ten columns were about 27 × 36 px on a 390 px phone, and the selector opens after every set.

## docs/DESIGN_SYSTEM.md — Toasts

Add after the bullet that starts "**Look**":

- **The first toasts with an action are the athlete's**: `student/SetRow` pushes "Extra set removed" and "Set skipped" (`sessionTouchUndo.setRemoved` / `setSkipped`, kind `info`) with `uiSharedHelpers.undo`. Push such a toast from the promise of `mutateAsync` or at the tap — never from a per-call `onSuccess`, which is not called once the component that started the mutation has unmounted — and write its `onClick` for a component that may be gone.

## docs/DESIGN_SYSTEM.md — Exercise type badge — `TypeBadge`

Delete, from the sentence "Not yet on it — still the hand-written ternary: `coach/SessionReview`, `coach/ExerciseLibrary`, `student/SlotDeviationBar`, `student/StudentProgramAuthor`.", the entry `student/SlotDeviationBar` (its swap picker draws `<TypeBadge type={ex.type} className="shrink-0" />`) — and `student/StudentProgramAuthor`, on `TypeBadge` since commit e5cad71 of session-decimal-input, whose snippet does not say it.

## CLAUDE.md — Feature → files map, row "Student session logging"

Add at the end of the sentence that starts "`SetRow` starts and clears the rest timer and opens the RPE selector in its gesture handlers":

A tap never marks a set failed: failed is a hold of 500 ms on the indicator, or its context menu (`holdToFail`); a tap on a done set shows how (`sessionTouchUndo.holdToFail`). `student/RpeInput` is two rows of five 44 px buttons. The "Last time" hint keeps its place while it is read (`lastPerformanceLoading`, `LastTimePlaceholder` in `student/SlotGroupCard`).

## CLAUDE.md — Feature → files map, row "Structural deviations (swap/skip exercise, skip/add set)"

Add at the end of the row:

Ways back (strings in the `sessionTouchUndo` namespace): an exercise Skip asks first in a `ui/ConfirmDialog` that says the coach is notified (L12); removing an extra set and skipping a set push an Undo toast from `student/SetRow` — `useRemoveStudentSet` answers the deleted row and `useAddStudentSet({ restore })` inserts it again with its id and values, the skip's Undo writes back what `patchForSkipped` cleared (`takeBackSkip`). The swap picker offers active exercises only (`isActiveExercise`) under `ui/TypeBadge`. Tests: `student/SlotDeviationBar.test.jsx`, `student/SetRow.test.jsx`, `student/SetRow.replay.test.jsx`, `hooks/useSetLogs.test.jsx`
