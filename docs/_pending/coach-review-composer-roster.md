# coach-review-composer-roster — docs to fold (wave 3, items P47, P48, L14, B28, N12, N14, N16)

Each block: target doc, section, then the text to fold in.

## docs/INVARIANTS.md — App updates (a new version waits for the page)

In the bullet that starts "**Text that was typed and not sent is in progress wherever the focus is.**", replace "The drafts of `messaging/MessageComposer`, `coach/SessionFeedbackComposer`, the exercise and goal forms and the "Actual" editor of `student/SetRow` live in `useState` and nowhere else: a reload at the next return to the app, with the focus on a button, would lose them." with:

The drafts of `messaging/MessageComposer`, the exercise and goal forms and the "Actual" editor of `student/SetRow` live in `useState` and nowhere else: a reload at the next return to the app, with the focus on a button, would lose them. The feedback of `coach/SessionFeedbackComposer` is also kept on the device (`sl_feedback_draft:<sessionId>`, see "Coach session review") and comes back after a reload, but it counts here like the others: a reload still takes the coach off the page they were writing on.

## docs/INVARIANTS.md — Coach session review

Add after the bullet that starts "**Coach session review is one-shot per session.**":

- **The feedback being written is kept per session until it is sent, emptied or discarded on purpose — and "Finish without feedback" asks before it discards one.** [`lib/feedbackDraft.js`](../src/lib/feedbackDraft.js) keeps it in `localStorage` under `sl_feedback_draft:<sessionId>` (`feedbackDraftKey`; `readFeedbackDraft`, `writeFeedbackDraft` — blank text removes the key —, `clearFeedbackDraft`; every access in a `try`, so a refused storage stops neither the typing nor the send). [SessionFeedbackComposer.jsx](../src/components/coach/SessionFeedbackComposer.jsx) reads it once in its `useState` initializer — one composer per session, because `SessionReview` keys `SessionReviewPage` on the session —, writes it on every change, and forgets it when the send succeeds and when the coach finishes without sending (`finish`). With text that is not blank, "Finish without feedback" opens a `ConfirmDialog` ("Finish without sending?") first; Cancel leaves the text in the box and on the device. `SessionReviewPage` forgets the draft once the session says it is reviewed (`existingFeedback` or `session.reviewed_at`): the review was finished on another device, or the send succeeded after the coach had left the page and the composer could not hear it. The key is not wiped at sign-out: only the session's coach can open its review (RLS), and the composer is the only reader.

## docs/INVARIANTS.md — Coach session review

In the sub-bullet that starts "**The successful read is tested first, and nothing un-reads it.**", replace "The composer keeps the coach's unsent text in its own state, so gating it on `isSuccess`, `isError` or `isFetching` would unmount it — and lose the text — on a flaky network." with:

The composer is the coach's unsent text: gating it on `isSuccess`, `isError` or `isFetching` would unmount it on a flaky network — the draft comes back from `sl_feedback_draft:<sessionId>` when it mounts again, but the coach would see the box vanish under their thumb.

## docs/INVARIANTS.md — Coach session review

Replace the bullet that starts "**The review carries the way into the editor.**" with:

- **The review carries the way into the editor, and archives with a way back.** A 44px pill (`sl-pill sl-pill-btn`) beside "archive" links to `/coach/students/:studentId/s/:sessionId` and clears `sl_last_coach_session`, so the Sessions tab does not bounce back into a review the coach left on purpose. It is labelled "editor", not "edit": for a confirmed session the editor is read-only. "archive" is a 44px button too; once `useArchiveSession` has archived the session, an info toast says "Session archived" (`coachReviewComposerRoster.archive.done`) with Undo (`uiSharedHelpers.undo`), which sends `{ sessionId, archived: false }`. "unarchive" restores with no toast.

## docs/INVARIANTS.md — Coach session review

Add after the bullet that starts "**`SessionsFeed` treats an arrival with `?student=` as a destination.**":

- **PLANNED is what the coach prescribed: a set the athlete added is not part of it.** A row with `is_student_added` has no target. `SessionReview` builds the slot's summary, its rest and the per-set list under PLANNED from the rows with `is_student_added` false only (`plannedLogs`); listed there, an extra set read "SET 7 (BW)". [SlotProgress.jsx](../src/components/coach/SlotProgress.jsx) counts "n/planned done" and "n/planned RPE" over the prescribed rows, says the extra sets done apart ("+N extra", `coachReviewComposerRoster.review.extraSets`), and counts failed and skipped over every row; an extra set keeps its "+Set n" pill. In the off-plan band an extra set is "+Set n" followed by what was done, with no struck-through target.
- **The review and the feed date a session by the day it was TRAINED.** The confirmed banner of `SessionReview` says "Trained on {date}" (`coachReviewComposerRoster.review.trainedOn`) and a `SessionsFeed` card prints its date, both from `performedDate` ([lib/day.js](../src/lib/day.js) — `performed_on`, then `performed_at`, then `confirmed_at`) through `formatDate(lang, …)`. Never `confirmed_at` alone: for a confirmation sent offline it is the moment the queue was replayed.
- **A feed card says where its session sits as the Programming sheet says it: the phase's name and "Session n/total".** The line under a card's title is `week_label` (left out when the phase has no name) and `coach.roster.sessionOf` from [`useCoachSessionPositions`](../src/hooks/useProgram.js) (left out while that read has no answer), joined with " · ", and no line at all when both are missing. An untitled session is `coach.week.sessionN` with that place, or `coach.editor.titlePlaceholder` while it is not known. Never `week_number` or `day_number`: a phase is a free-text name and a session needs no weekday — "W1 · W1 · D2", a bare "· D" and "Session null" are what they printed.

## docs/INVARIANTS.md — Coach Athletes-roster layout

In the bullet that starts "**The Athletes roster merges the old Dashboard + Students tabs.**", add after the sentence that ends "(derive from key-absence, *not* a null field, since an active program with nothing scheduled is not a gap).":

**A read that has not answered is unknown, never empty.** `buildRoster` takes `summary` and `confirmations` as null (or undefined) when their read holds no data: a null summary gives no "No program" and no "Quiet" chip and no program name, position or strip, and null confirmations give no "to review" chip — read as `{}`, a summary on its way or answered by a 500 put a red "No program" on every athlete and sorted them all to the top. `RosterView` asks `readState([summaryRead, confirmationsRead], { online, restoring })`: `loading` draws one placeholder card per athlete (`role="status"`, `aria-busy`, nothing to tap — the order is not known yet, and cards drawn now would re-sort under the coach's thumb); `offline` or `failed` draws a notice with Try again, which calls `refetch({ cancelRefetch: false })` on each read that holds no data, above the cards built from what was read; `ready` is the attention-first roster. A read that holds data, however old, is used even when its refresh failed. `useClientErrors` is not part of it.

## docs/ARCHITECTURE.md — Coach-section persistence across tab switches

Replace "Two flows drive "pick up where you left off" via three localStorage keys:" with:

Two flows drive "pick up where you left off" via three localStorage keys, and a fourth keeps the feedback being written:

## docs/ARCHITECTURE.md — Coach-section persistence across tab switches

Add after the bullet that starts "- **`sl_last_coach_sessions_student`**":

- **`sl_feedback_draft:<sessionId>`** — the text of the feedback being written for that session, one key per session ([lib/feedbackDraft.js](../src/lib/feedbackDraft.js)). Written by `SessionFeedbackComposer` as it is typed (blank text removes it) and read when it mounts; removed when the feedback is sent, when the coach finishes without it, and by `SessionReview` once the session is reviewed.

## docs/ARCHITECTURE.md — React Query — who owns which key

In the row of [useProgram](../src/hooks/useProgram.js), replace the key cell ("`['program', studentId]`, `['programs', studentId]`, `['active-program', studentId]`, `['coach-dashboard-programs']`") with:

`['program', studentId]`, `['programs', studentId]`, `['active-program', studentId]`, `['coach-dashboard-programs', userId]`, `['coach-dashboard-programs', 'session-positions', userId]` (`useCoachSessionPositions`: `{ [sessionId]: { n, total } }`, the place of each non-archived session in its block across every block of the coach's athletes that is not in the trash; under the dashboard's root so `invalidateCoachDashboard` drops it too; not persisted)

## docs/ARCHITECTURE.md — Data model

In the bullet that starts "- **Coaches browse all programs**", replace "`CopyDialog` picks its destination from the same two — the athlete's list, then the phases of the block chosen in it." with:

`CopyDialog` picks its destination from the same two — the athlete's list, then the phases of the block chosen in it, each named as the sheet names it (`week.label`, or `coach.sheet.unnamedPhase`) and followed by the places its sessions hold in the block ("Sessions 4–6", "Session 7", "No sessions yet"), which tells two phases of the same name apart.

## docs/INVARIANTS.md — Language of what is printed

In the paragraph that starts "Not yet through `format.js`:", delete `coach/SessionsFeed` from "the device-locale dates and numbers of …" (its card date goes through `formatDate`; `coach/SessionReview` stays, for "Archived on").

## CLAUDE.md — Repo map

Under `lib/`, add after the line of `draftTree.js`:

```
                 feedbackDraft.js (the coach's feedback being written, kept per session on the
                 device until it is sent, emptied or discarded: sl_feedback_draft:<sessionId>)
```

## CLAUDE.md — Feature → files map, row "Coach session review"

Replace "`coach/SessionReview`, `coach/SessionFeedbackComposer`, `coach/SessionFeedbackSent`," with:

`coach/SessionReview` (the confirmed banner dates the session by the day it was trained — `performedDate`; PLANNED leaves out a set the athlete added; "archive" is a 44px button followed by an Undo toast), `coach/SlotProgress` (counts the prescribed sets against the plan, "+N extra" apart), `coach/SessionFeedbackComposer` (the draft is kept per session in `lib/feedbackDraft` — `sl_feedback_draft:<sessionId>` — until it is sent, emptied or discarded; "Finish without feedback" asks first when the box holds text), `coach/SessionFeedbackSent`,

and add at the end of the row: Strings in the `coachReviewComposerRoster` namespace. Tests: `coach/SessionFeedbackComposer.test.jsx`, `lib/feedbackDraft.test.js`, `coach/SlotProgress.test.jsx`.

## CLAUDE.md — Feature → files map, row "Coach sessions feed"

Replace the row's file list with:

`coach/SessionsFeed` (an arrival with `?student=` opens on that athlete's needs-review list, or on "All" when nothing is left, and never bounces into a saved review; cards pass the feed URL as the review's `from`; a card names the phase and "Session n/total", an untitled session "Session n", and its date is the day trained, through `formatDate`), `hooks/useSessionConfirmation`, `hooks/useProgram` (`useCoachSessionPositions` — the place of every session in its block, a read nothing waits for)

## CLAUDE.md — Feature → files map, row "Coach Athletes roster (attention-first list; merged Dashboard + Students into one tab)"

Replace "`lib/coachRoster` (`buildRoster` — pure, + `STALE_AFTER_DAYS`)," with:

`lib/coachRoster` (`buildRoster` — pure, + `STALE_AFTER_DAYS`; a null `summary` or `confirmations` is unknown and invents no chip), `lib/readState` (the roster waits for its two reads with one placeholder card per athlete, and says when one got no answer, with Try again),

## CLAUDE.md — Feature → files map, row "Coach Program Sheet (the Programming tab — the whole block as ONE list)"

Replace "`ui/CopyDialog` (athlete → BLOCK → week)" with:

`ui/CopyDialog` (athlete → BLOCK → phase; a phase is named by its name, or "Unnamed phase", and the places its sessions hold in the block — never "Week n")
