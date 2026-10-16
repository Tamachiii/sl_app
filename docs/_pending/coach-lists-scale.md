# coach-lists-scale — docs to fold (wave 3, items L18)

Each block: target doc, section, then the text to fold in.

The package closes the coach-list part of P9. Migration 26 (`coach_review_counts()`, `my_conversations()`, package sql-17-coach-list-rpcs) is optional for the client: every read below works on a database without it.

## docs/INVARIANTS.md — React / hooks discipline

In the bullet that starts "**Never fan a list of session ids back into `.in('session_id', […])`.**", replace "as `useAllConfirmations`, `useCoachDashboardPrograms`, `useWeekConfirmedSessionIds` and `useStudentProgressStats` all now do." with:

as the coach's confirmation reads of `useSessionConfirmation.js` (`coachConfirmations`, behind `useReviewInbox`, `useConfirmationTotals` and `useConfirmationHistory`), `useWeekConfirmedSessionIds` and `useStudentProgressStats` all now do.

## docs/INVARIANTS.md — React / hooks discipline

In the bullet that starts "**A read whose result grows with an athlete's history goes through `fetchAllRows`**", replace "Today's callers: `useStudentProgressStats` (done sets, swaps, confirmations)," with "Today's callers: `reviewInboxQueryOptions` in `useSessionConfirmation.js` (the coach's inbox), `useConversations` in `useMessages.js` (every message of the account, on a database without `my_conversations()`), `useStudentProgressStats` (done sets, swaps, confirmations),", and replace its last sentence ("…; the one read still listed there as waiting is the conversation list in `useMessages.js`.") with:

`src/lib/supabasePaging.test.js` reads every source file and fails on a `.limit(n)` with `n` above `PAGE_SIZE`; its `WAITING` list is empty.

## docs/INVARIANTS.md — React / hooks discipline

Add after the bullet that starts "**`PAGE_SIZE` (1000) must not exceed the project's API "Max rows" setting.**":

- **A coach's list that grows with the history of every athlete is read in full only where the coach must act on all of it; the rest is a page at a time, when it is shown.** The Sessions feed's inbox — the confirmed sessions neither reviewed nor archived — is read in full by `fetchAllRows` (`reviewInboxQueryOptions` in [`useSessionConfirmation.js`](../src/hooks/useSessionConfirmation.js)), and sorted newest first by the client. "All" and the archived drawer are `useConfirmationHistory`: a `useInfiniteQuery` over `.range()`, `HISTORY_PAGE_SIZE` (30) per page, ordered `confirmed_at` then `id` descending so the order is total, read only while its view is open (`enabled`), the athlete filter and the archived flag sent to the server. An offset moves when a confirmation arrives between two pages: the flattened pages are de-duplicated on `id`. The empty states and "Show N archived" come from `useConfirmationTotals` — two head counts (`count: 'exact', head: true`), never a length of rows. One request for every confirmation, newest first, is what dropped an old session that was still waiting for its review out of the inbox, the chip and the tab's number once the coach's athletes had confirmed a thousand sessions since (review item L18).
- **An optional read function of the database is asked first, and its absence — `PGRST202`, and nothing else — falls back to a paged read with the same answer.** `useReviewCounts` calls `coach_review_counts()` and, without it, counts the inbox with `reviewCountsByStudent` through `queryClient.fetchQuery(reviewInboxQueryOptions(coachId))`, so the feed then finds the inbox read; `useConversations` calls `my_conversations()` and, without it, reads every message of the account with `fetchAllRows` and folds them. Any other error fails the read: a refused function is never an empty count or an empty list. The function and the fallback must give the same numbers — a change to one is a change to the other (`supabase/tests/coach-list-rpcs.test.js` holds the database side, `src/hooks/useSessionConfirmation.test.jsx` and `src/hooks/useMessages.test.jsx` the client side).

## docs/INVARIANTS.md — RLS / DB conventions

In the bullet that starts "**A coach-wide read names the coach; RLS is not the tenant filter.**", replace "[`useCoachDashboardPrograms`](../src/hooks/useProgram.js) (both of its reads) and [`useAllConfirmations`](../src/hooks/useSessionConfirmation.js) embed `student:students!inner(coach_id)` and filter on it;" with:

[`useCoachDashboardPrograms`](../src/hooks/useProgram.js) and the coach's confirmation reads of [`useSessionConfirmation.js`](../src/hooks/useSessionConfirmation.js) (one builder, `coachConfirmations`, behind `useReviewInbox`, `useConfirmationTotals` and `useConfirmationHistory`) embed `student:students!inner(coach_id)` and filter on it; `coach_review_counts()`, which `useReviewCounts` asks first, filters the same way in the database;

## docs/INVARIANTS.md — Coach Athletes-roster layout

In the bullet that starts "**Coach roster strip data is folded into one query and comes from the SHARED placement model.**", add after its first sentence:

That query is the coach's active blocks, sessions included, and nothing else: a session is done when it carries `sessions.performed_at`, which `sync_session_performed_at` sets exactly while the session has a confirmation (and migration `2026_08_21_session_performed_on.sql` filled in for the confirmations made before it). A second, unbounded read of the confirmations on those blocks said it until wave 3, and past a thousand of them PostgREST cut it without a word — done sessions came back as "next" on the cards.

## docs/INVARIANTS.md — Coach Athletes-roster layout

In the bullet that starts "**The Athletes roster merges the old Dashboard + Students tabs.**", replace "Cards + chips + ordering come from the pure [`buildRoster`](../src/lib/coachRoster.js) over `useStudents` + `useCoachDashboardPrograms` + `useAllConfirmations` (no new query). Attention chips: **to-review** (confirmations with `reviewed_at` and `archived_at` both null, grouped by `student_id`)," with:

Cards + chips + ordering come from the pure [`buildRoster`](../src/lib/coachRoster.js) over `useStudents` + `useCoachDashboardPrograms` + `useReviewCounts` (`{ [students.id]: n }`). Attention chips: **to-review** (the sessions confirmed and neither reviewed nor archived, per athlete — `coach_review_counts()`, or `reviewCountsByStudent` over the inbox on a database without it),

## docs/INVARIANTS.md — Coach Athletes-roster layout

In the text folded from coach-review-composer-roster's snippet ("**A read that has not answered is unknown, never empty.**"), replace "`buildRoster` takes `summary` and `confirmations` as null" with "`buildRoster` takes `summary` and `reviewCounts` as null", "and null confirmations give no "to review" chip" with "and null counts give no "to review" chip", and "`RosterView` asks `readState([summaryRead, confirmationsRead], { online, restoring })`" with "`RosterView` asks `readState([summaryRead, countsRead], { online, restoring })`".

## docs/INVARIANTS.md — Coach Athletes-roster layout

In the text folded from coach-nav-memory-badge's snippet, replace the bullet that starts "**The Sessions tab's number is the roster's "to review" count, summed.**" with:

- **The Sessions tab's number is the roster's "to review" count, summed.** [`hooks/useToReviewCount.js`](../src/hooks/useToReviewCount.js) adds up the values of `useReviewCounts` — the entry `['all-confirmations', 'review-counts', userId]` the cards' chips read — so the tab and the cards cannot disagree. It runs on every coach page, so it never reads the history: `coach_review_counts()` counts in the database, and without that function the inbox alone is read. It is `undefined` while the counts are not known, and [`layout/ReviewCountBadge`](../src/components/layout/ReviewCountBadge.jsx) draws nothing then and nothing at 0. The navigation asks this hook and nothing else. The count is as fresh as the entry: the invalidations of `['all-confirmations']` by a review, an archive and a feedback send, and the query's own refetches — a new confirmation from an athlete reaches it at the next refetch.

## docs/INVARIANTS.md — Coach Athletes-roster layout

Add after the bullet that starts "**A roster card is a link STRETCHED over the card, not an anchor wrapped around it.**":

- **The Sessions feed opens on the inbox, and reads the rest of the history only when it is shown.** [SessionsFeed.jsx](../src/components/coach/SessionsFeed.jsx): "Needs review" is `useReviewInbox`, filtered by athlete on the device; "All" is `useConfirmationHistory({ studentId, enabled: showAll })` and the archived drawer `useConfirmationHistory({ studentId, archived: true, enabled: showArchived })`, each with a "Show more" button (`sl-pill sl-pill-btn`) while `hasNextPage`, "Loading…" while the next page is on its way, and a line when it could not be read. The default view is decided once the inbox has answered — before that, a `?student=` arrival would read the history for nothing. The empty states and "Show N archived" read `useConfirmationTotals(studentId)`: numbers that are not known — still placeholder data of another athlete (`isPlaceholderData`), or a count that failed — claim no empty feed, and keep the view buttons. An inbox that got no answer is `CoachReadProblem` with Try again, never "All caught up". The athletes of the filter are `useStudents` (the value is `students.id`), not the athletes whose confirmations were read.

## docs/ARCHITECTURE.md — React Query — who owns which key

In the row of [useSessionConfirmation](../src/hooks/useSessionConfirmation.js), replace "`['all-confirmations', userId]`," in the keys column with:

`['all-confirmations', 'inbox', userId]` (`reviewInboxQueryOptions`), `['all-confirmations', 'review-counts', userId]` (`useReviewCounts`), `['all-confirmations', 'totals', userId, studentId]` (`useConfirmationTotals`, previous athlete's numbers as placeholder data), `['all-confirmations', 'history', userId, studentId, 'active' | 'archived']` (`useConfirmationHistory`, an infinite query of `HISTORY_PAGE_SIZE` rows a page),

and in the same row replace "That list deliberately does NOT hold `['all-confirmations']`: it is the coach's feed and these writes run on the student's device." with:

That list deliberately does NOT hold `['all-confirmations']`: it is the coach's feed and these writes run on the student's device. Every coach key starts with `CONFIRMATIONS_ROOT` (`'all-confirmations'`), so the writes that drop `['all-confirmations']` (a review, an archive, a feedback send, a session moved) reach the inbox, the counts, the totals and every page of the history that was read.

## docs/ARCHITECTURE.md — React Query — who owns which key

In the row of [useMessages](../src/hooks/useMessages.js), replace "`['messages', 'conversations', me]`," with:

`['messages', 'conversations', me]` (`my_conversations()` when the database has it, else every message of the account read by `fetchAllRows` and folded; `lastMessage` keeps the seven columns of a message, a column the function does not return being null),

## docs/ARCHITECTURE.md — React Query — who owns which key

In the paragraph that starts "A query may derive from another one instead of reading the network", replace "`fetchDoneSetHistory` in `src/lib/doneSetHistory.js` is the one case of a whole derived read today." with:

`fetchDoneSetHistory` in `src/lib/doneSetHistory.js` is one case of a whole derived read; `useReviewCounts` is another, on a database without `coach_review_counts()`: it awaits `queryClient.fetchQuery(reviewInboxQueryOptions(coachId))` and counts the rows, so the feed opened next finds its inbox read.

## CLAUDE.md — Feature → files map, row "Coach Athletes roster (attention-first list; merged Dashboard + Students into one tab)"

Replace "`hooks/useSessionConfirmation` (`useAllConfirmations`)" with "`hooks/useSessionConfirmation` (`useReviewCounts` — `coach_review_counts()`, or the inbox counted by `reviewCountsByStudent` on a database without it)", and replace "The three coach-wide reads behind it (`useStudents`, `useCoachDashboardPrograms`, `useAllConfirmations`) each filter on the coach explicitly — RLS also returns the rows in which the account is the athlete" with:

The coach-wide reads behind it (`useStudents`, `useCoachDashboardPrograms`, the inbox of `useSessionConfirmation`) each filter on the coach explicitly — RLS also returns the rows in which the account is the athlete. `useCoachDashboardPrograms` is one read: a session is done when it carries `performed_at`

## CLAUDE.md — Feature → files map, row "Coach sessions feed"

Replace the row's file list with:

`coach/SessionsFeed` (an arrival with `?student=` opens on that athlete's needs-review list, or on "All" when nothing is left, and never bounces into a saved review; cards pass the feed URL as the review's `from`; the athlete filter lists `useStudents`), `hooks/useSessionConfirmation` (`useReviewInbox` — the inbox, every row, `fetchAllRows`; `useConfirmationHistory` — "All" and the archived drawer, `useInfiniteQuery` over `.range()`, read only while shown, "Show more"; `useConfirmationTotals` — the two head counts behind the empty states and "Show N archived"), strings in the `coachListsScale` namespace. Tests: `coach/SessionsFeed.test.jsx`, `hooks/useSessionConfirmation.test.jsx` (on `test/fakePostgrest`, which applies `.range()` and several `.order()`)

## CLAUDE.md — Feature → files map, row "Messaging (coach ↔ student)"

Replace "`hooks/useMessages`," with "`hooks/useMessages` (`useConversations` — `my_conversations()`, or every message read by `fetchAllRows` and folded on a database without it),".

## CLAUDE.md — Feature → files map, row "Reading every row (PostgREST answers with 1000 rows at most, silently)"

Replace "used by `hooks/useStudentProgressStats`" with "used by `hooks/useSessionConfirmation` (`reviewInboxQueryOptions` — the coach's inbox), `hooks/useMessages` (the conversation list without `my_conversations()`), `hooks/useStudentProgressStats`".

## CLAUDE.md — Repo map

In the `src/test/` entry, replace "fakePostgrest.js (supabase.from() double that cuts at 1000 rows)" with "fakePostgrest.js (supabase.from() double that cuts at 1000 rows; applies `.range()` and several `.order()`, records every argument of a filter)".
