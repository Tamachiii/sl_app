# session-reviewed-lock — docs to fold (wave 1, items: none — athlete half of P57 on the client)

Each block: target doc, section, then the text to fold in.

## docs/INVARIANTS.md — RLS / DB conventions

Replace, in the bullet that starts "**Past-program sessions are read-only on the student surface.**", "Enforced UI-side in `SessionView` via `isReadOnly` (derived from `session.program_is_active` + `archived_at`)" with:

Enforced UI-side in `SessionView` via `isClosed` (derived from `session.program_is_active` + `archived_at`; `isReadOnly` is wider — it adds the reviewed session of the next bullet)

## docs/INVARIANTS.md — RLS / DB conventions

Add after the bullet that starts "**Past-program sessions are read-only on the student surface.**":

- **A session the coach has reviewed is read-only for the athlete and its confirmation cannot be undone — and [SessionView.jsx](../src/components/student/SessionView.jsx) reads that from `session.reviewed_at`, never from the feedback message.** The page keeps three facts apart: `isClosed` (past program or archived — nothing can be written, the confirmation included), `isReviewed` (`session.reviewed_at` is set) and `isReadOnly = isClosed || isReviewed`, which is what `SlotGroupCard` receives and what locks the sets, RPE, actuals, extra sets, swap and skip, the note for the coach, and the video's replace and delete (`VideoUploadButton` disables both on `disabled`; playing stays). The `useEnsureSetLogs` safety net is not fired on a read-only session: rows added to a reviewed session would be sets the coach never read. Where "Undo confirmation" was, a reviewed session shows `ReviewedLock`: the reason (`sessionReviewedLock.locked`) and a link to `/student/messages`. There is no reopening in the app; the link is the athlete's only way to get something corrected. Rules to keep when editing it:
  - **A reviewed session can still be CONFIRMED.** Sessions reviewed without a confirmation, or whose confirmation was undone after the review, exist from before the two were tied together. Read-only without a Confirm button would leave such a session "Next" in the training list for good (`buildQueue` drops a session only when it is confirmed or archived), so the page shows the lock (`sessionReviewedLock.lockedUnconfirmed`, which says the confirmation will be final) above the Confirm button. Only `isClosed` hides Confirm.
  - **A closed session keeps its own line.** Past program and archived win over reviewed ("From a past program — …", "Archived by your coach — …"), and show no link: no message to the coach reopens a past block.
  - **`reviewed_at` comes from a cached row, and nothing pushes a review to the athlete's device.** `['session', sessionId]` is served without a request while it is fresh and is persisted for offline use, so "not reviewed" is only as true as the row is recent. The page asks for the row again — `refetch({ cancelRefetch: false })`, which joins a request already on its way — at the three moments a review may have happened behind the cache: when it shows a confirmed session that is not read-only (the only kind a coach reviews), when `useSessionFeedback` returns a message while the row still says "not reviewed" (feedback arrives over the messages channel a second after it is sent), and on the tap on "Undo confirmation" (a review without feedback sends nothing). These three do not depend on the query's `staleTime` or on a refetch on focus: a change to either must leave them in place. Offline the request waits; nothing on the page waits for it.
  - **The undo dialog is open only while `canUndo`** (`isConfirmed && !isReadOnly`), so a "reviewed" answer that arrives while the athlete reads it takes its button away.
  - **Do not key the lock on the feedback message.** A review without feedback has none, and the page would lock on another rule than the column everything else reads. The message is a reason to read the row again, nothing more.

  This is the client half: it shows the lock and does not depend on a migration. The database holds the same rule for the athlete's writes in migrations 08 (`session_write_gates`) and 09 (`review_lifecycle`). A test that mocks `useSession` for this page has to give the query's `refetch` (`mockRefetchSession` in `SessionView.test.jsx`).

## docs/ARCHITECTURE.md — Read-only gate on past-program sessions

Replace the bullet that starts "- **UI gate** —" with:

- **UI gate** — `useSession` hydrates `session.program_is_active` from the embedded `weeks(programs(is_active))`. `SessionView` derives `isClosed` from that and `archived_at`, then hides Confirm / Undo and swaps in a "From a past program — read-only." (or "Archived by your coach — read-only.") banner. `isReadOnly` (`isClosed`, or `session.reviewed_at` set) is what locks `SetRow` toggles + `SlotCommentBox`; `VideoUploadButton` inherits via the same `locked` prop — upload, replace and delete are disabled, play is not. A reviewed session of the active block is read-only without being closed: it shows `ReviewedLock` (the reason and a link to `/student/messages`) where "Undo confirmation" was, and can still be confirmed if it never was. See "A session the coach has reviewed" in [INVARIANTS.md](INVARIANTS.md).

## CLAUDE.md — Feature → files map, row "Student session logging"

Add to the end of the row:

. A session the coach has reviewed (`session.reviewed_at`) is read-only: `SessionView` passes `isReadOnly` down and shows `ReviewedLock` — the reason and a link to messages — where "Undo confirmation" was; strings in the `sessionReviewedLock` namespace

## README.md — Design System, Theming, and i18n

Add to the end of the bullet that starts "**Student-side feedback surface**":

Once the coach has reviewed a session — with feedback or without — `SessionView` shows it read-only: the sets, notes and videos stay as the coach read them, and where "Undo confirmation" was the page says that the coach has reviewed the session and links to Messages, the way to ask for a correction.
