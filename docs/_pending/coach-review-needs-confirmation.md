# coach-review-needs-confirmation — docs to fold (wave 1, items: none — coach half of P57 on the client)

Each block: target doc, section, then the text to fold in.

## docs/INVARIANTS.md — Coach session review

Replace, in the bullet that starts "**Coach session review is one-shot per session.**", the sentence "[SessionReview.jsx](../src/components/coach/SessionReview.jsx) renders three branches: [SessionFeedbackSent.jsx](../src/components/coach/SessionFeedbackSent.jsx) (feedback exists), [SessionReviewedNoFeedback.jsx](../src/components/coach/SessionReviewedNoFeedback.jsx) (`reviewed_at` set but no feedback), or [SessionFeedbackComposer.jsx](../src/components/coach/SessionFeedbackComposer.jsx) (not yet reviewed)." with:

[SessionReview.jsx](../src/components/coach/SessionReview.jsx) renders four branches at its feedback step: [SessionFeedbackSent.jsx](../src/components/coach/SessionFeedbackSent.jsx) (feedback exists), [SessionReviewedNoFeedback.jsx](../src/components/coach/SessionReviewedNoFeedback.jsx) (`reviewed_at` set but no feedback), [SessionFeedbackComposer.jsx](../src/components/coach/SessionFeedbackComposer.jsx) (not yet reviewed, and confirmed), or [SessionReviewNotConfirmed.jsx](../src/components/coach/SessionReviewNotConfirmed.jsx) (not yet reviewed, and no confirmation to review — see the next entry).

## docs/INVARIANTS.md — Coach session review

Add after the bullet that starts "**Coach session review is one-shot per session.**":

- **A review needs a confirmation, and the page offers its feedback step only on a confirmation READ SINCE IT OPENED.** The composer — which also carries "Finish without feedback", the only other caller of `useMarkSessionReviewed` — renders for a confirmed session only. The page is reached without a confirmation in ordinary ways: a session in progress opened from the sheet or from a `session_deviation` notification, an archived session that was never trained, and a `session_completed` notification that went stale because the athlete undid the confirmation. A session reviewed in that last state never came back to the inbox, which reads from `session_confirmations`. The database refuses both writes too (the review-lifecycle migration, 09); this is the client half and it does not depend on it. **The cache is not an answer here**: `['session-confirmation', sessionId]` is served for two minutes and persisted across reloads, so [SessionReview.jsx](../src/components/coach/SessionReview.jsx) calls `useSessionConfirmation(sessionId, { refetchOnMount: 'always' })`, takes `openedAt` when it mounts, and derives `confirmationState` from the query's two timestamps: `confirmed` or `none` once `dataUpdatedAt >= openedAt`; `unverified` when the read failed since then (`errorUpdatedAt >= openedAt`) or waits for the network (`isPaused`); `checking` otherwise, which renders nothing. Four rules to keep when editing it:
  - **The successful read is tested first, and nothing un-reads it.** A refetch on window focus that fails later leaves a confirmed session `confirmed`. The composer keeps the coach's unsent text in its own state, so gating it on `isSuccess`, `isError` or `isFetching` would unmount it — and lose the text — on a flaky network. Only a read that returns no row takes the composer away.
  - **"Not confirmed" is a statement about the athlete, made for `none` only.** A failed or parked read shows, in the composer's place, the `unverified` variant of [SessionReviewNotConfirmed.jsx](../src/components/coach/SessionReviewNotConfirmed.jsx) with a "Check again" button, and the status line at the top of the page stays empty. A confirmation the cache already holds is still shown at the top without waiting (its date and the athlete's notes are content); only its absence waits for the read.
  - **`SessionReview` is a keyed wrapper around `SessionReviewPage`** (`key` = student and session ids). The router keeps a route's element mounted when only its params change, and `refetchOnMount` does not fire on a key change: without one mount per session, the first review's `openedAt` would vouch for whatever the cache holds about the second, or leave it in `checking` for good.
  - **The two read-only cards do not look at the confirmation.** Sessions reviewed before the rule existed have none, and keep saying that they were reviewed. Neither do the deviation actions (adopt, remove, decline) or archive: a deviation is notified while the session is still in progress.

  A test that mocks `useSessionConfirmation` for this page has to give the query's `dataUpdatedAt`, or the page stays in `checking` (`confirmationQuery()` in `SessionReview.test.jsx`). `SessionReview.confirmation.test.jsx` runs the page on the real hook and a real query client, so the reading of those timestamps is React Query's behaviour and not an assumption about it.

## docs/ARCHITECTURE.md — React Query — who owns which key

Replace the `useSessionConfirmation` row of the table with:

| [useSessionConfirmation](../src/hooks/useSessionConfirmation.js) | `['session-confirmation', sessionId]`, `['all-confirmations', userId]`, `['my-confirmed-session-ids', userId]`, `['week-confirmed-session-ids', weekId]` | `invalidateConfirmationQueries(qc)` hits the student-side prefixes. It deliberately does NOT drop `['all-confirmations']`: that is the coach's feed and this mutation runs on the student's device. `useSessionConfirmation(sessionId, { refetchOnMount })` passes React Query's option through; the coach's `SessionReview` reads with `'always'`, because it offers its feedback form on that row and the cached answer can predate an undo. |

## CLAUDE.md — Feature → files map, row "Coach session review"

Add to the row's file list, after `coach/SessionReviewedNoFeedback`:

`coach/SessionReviewNotConfirmed`

## CLAUDE.md — Feature → files map, row "Coach session review"

Add to the end of the row:

The feedback step (composer and "Finish without feedback") is offered only for a session whose confirmation was read since the page opened — `useSessionConfirmation(sessionId, { refetchOnMount: 'always' })` and `confirmationState`; without one the page says the session is not confirmed, and a failed read says it could not check

## README.md — Design System, Theming, and i18n

Replace, in the bullet that starts "**Coach feedback flow**", the sentence "`SessionReview` ends with `SessionFeedbackComposer` — an optional textarea + \"Send feedback\" / \"Finish without feedback\" pair." with:

`SessionReview` ends with `SessionFeedbackComposer` — an optional textarea + "Send feedback" / "Finish without feedback" pair — once the athlete has confirmed the session. For a session that is not confirmed (still in progress, or confirmed and then undone) the page says so and offers no form: a review needs a confirmation.
