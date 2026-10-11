# stats-shared-history — docs to fold (wave 1, items P39, N22)

Each block: target doc, section, then the text to fold in.

## docs/INVARIANTS.md — Stats

Add after the bullet that starts "**Personal records + bodyweight** (2026_07_14).":

- **An athlete's done-set history is read ONCE, by `fetchDoneSetHistory`, and whatever reduces the whole history derives from that read.** [`lib/doneSetHistory.js`](../src/lib/doneSetHistory.js) holds it. `readDoneSetHistory(studentRowId)` sends the done `set_logs` and the `kind='swap'` `slot_deviations` together, each to its end with `fetchAllRows`, and returns flat rows, oldest first (`logged_at`, then `id`), with the swap already applied: `exerciseId` is the exercise PERFORMED (the substitute on a swapped slot), `exercise` its `{ id, name, type, load_mode }` — or null when the reader may not see that library row —, `swapped` says which, and `target_*` are null on a swapped set, because the slot's pinned targets are the original exercise's numbers. `fetchDoneSetHistory(queryClient, { studentRowId, userId })` keeps that list in the query cache under `['student-records', 'history', <athlete>]`: the STUDENTS-table id in the coach flow, the signed-in user's id when an athlete reads their own. [`useStudentRecords`](../src/hooks/useStudentRecords.js) and [`useLastPerformance`](../src/hooks/useLastPerformance.js) call it from their `queryFn` and reduce; neither reads `set_logs` or `slot_deviations` itself. Each used to scan that five-level join on its own — "Last time" once per session opened and once more per exercise added in the session editor, 152 kB a time in production. Six rules keep it one read:
  1. **The key's root is `'student-records'` on purpose.** `invalidateConfirmationQueries` (confirm, unconfirm) and `useLogBodyweight` invalidate `['student-records']`, and that prefix is the only thing that tells the history an athlete's done sets changed. A new write path that changes what an athlete has done invalidates `['student-records']`, never a narrower key; and the history cannot move under another root without those sites learning it. `src/hooks/sharedHistory.test.jsx` drives the real `useConfirmSession` and fails if a confirmation stops renewing the history.
  2. **It is read with `queryClient.fetchQuery`, never observed with `useQuery`.** With no observer an invalidation only flags the entry and the next derivation pays for the read; callers that arrive while a read is in flight share it. An observer would download the whole list again on every confirmation and every return to the tab. The price of having none: an invalidation that lands while a read is in flight restarts nothing, and the read's own success clears the flag — so the `queryFn` in `fetchDoneSetHistory` compares the entry's `isInvalidated` before and after its read and, when it went up in between, reads once more before anyone gets the list. Keep that comparison if the `queryFn` is rewritten; without it a session confirmed during the read is missing from a list held as fresh for ten minutes. It sees one invalidation per read: a second one during the repeat, or one during a read that began on an entry already flagged, waits for `HISTORY_STALE_MS`.
  3. **Between two invalidations a read is trusted for `HISTORY_STALE_MS` (10 minutes), and dropped from memory after the same time.** Sets ticked on this device since the last read are missing from it until the session is confirmed or the ten minutes have passed. "Last time" never looks at the open session, so this delays only what the NEXT session's hint and the records list show; a coach sees a workout the athlete finished on another device at most ten minutes late. Do not close that window by invalidating on every set tap: that is one full scan per tap, which is what this module removed.
  4. **`'student-records'` stays out of `PERSISTED_QUERY_ROOTS`.** The list runs to hundreds of kB and the persister re-serialises the whole cache on every event. What is persisted for offline use is the small object `useLastPerformance` reduces it to, under `'last-performance'`.
  5. **The athlete scope lives here.** With a `studentRowId` both reads carry `.eq('exercise_slots.sessions.weeks.programs.student_id', …)` on every page; without one NO filter is sent and RLS scopes the rows to the signed-in athlete. A coach caller MUST pass it (see the `useLastPerformance` bullet under "Coach Athletes-roster layout"). Both hooks name the athlete the same way — if one resolved a `students` row and the other did not, one athlete would get two entries and two reads.
  6. **It passes `retry: false`.** The hook that derives from it retries; inheriting the client's default too would multiply the attempts of a read that is several requests long. A failed read is not kept.

  A new figure over an athlete's whole done-set history — a coach-side records list, an e1RM trend — calls `fetchDoneSetHistory`; it does not add a scan. `useStudentProgressStats` is deliberately not a consumer: it is scoped to a block, needs the prescribed side, and ESTIMATES a swapped set from the prescription where this list holds measured numbers only.
- **A swap is a swap even when its substitute cannot be shown.** `readDoneSetHistory` decides on `slot_deviations.substitute_exercise_id`, not on the embedded library row: a set on a swapped slot belongs to the substitute's id whether or not the reader may see that exercise (one from a former coach's library comes back with no row). "Last time" works on the id alone; a record needs a name, so `useStudentRecords` sets none for a set whose `exercise` is null. Handing such a set back to the exercise prescribed would credit work — possibly a record — to a lift that was not done. For the same reason the library embed on `set_logs` is a plain one, not `!inner`: a hidden exercise must not take the set out of the history.

Replace, in the bullet that starts "**Personal records + bodyweight** (2026_07_14).", the words "reduces the student's DONE `set_logs` (program-join filtered, students.id resolved from the profile — `programs.student_id` is `students.id`, NOT `profiles.id`) into one record per exercise" with:

reduces the athlete's done sets — taken from the shared history (`fetchDoneSetHistory`, next bullet), not read by the hook; a coach names the athlete with a `students.id`, which is what `programs.student_id` references, NOT `profiles.id`, and an athlete reading their own passes nothing — into one record per exercise

Replace, in the same bullet, the words "the hook also fetches the student's `kind='swap'` `slot_deviations` (through the same program join, never an unbounded slot-id `.in()`) and credits a swapped set to the SUBSTITUTE exercise — using **only the logged actuals**, because the slot's pinned `target_*` are the coach's ORIGINAL exercise's numbers and are foreign to the substitute, so they're dropped before the reduce." with:

the history reads the athlete's `kind='swap'` `slot_deviations` alongside the sets (through the same program join, never an unbounded slot-id `.in()`) and hands a swapped set over under the SUBSTITUTE exercise — with **only the logged actuals**, because the slot's pinned `target_*` are the coach's ORIGINAL exercise's numbers and are foreign to the substitute, so they are null on such a set.

## docs/INVARIANTS.md — Coach Athletes-roster layout

Replace the bullet that starts "**`useLastPerformance` is role-aware and MUST be scoped when a coach calls it.**" with:

- **`useLastPerformance` is role-aware and MUST be scoped when a coach calls it.** Pass a STUDENTS-table id as `studentRowId` (same convention as `useStudentRecords`/`useStudentProgressStats`): the hook hands it to `fetchDoneSetHistory`, where both the `set_logs` and the `slot_deviations` read filter through the program join, on every page. Omit it and RLS alone scopes to the signed-in student. Skipping the scope in the coach flow is not a no-op — a coach's RLS returns EVERY athlete's logs, so the hint would silently show the most recent number across the whole roster. `studentRowId` is in the hint's query key, and names the history's cache entry, for the same reason. `src/hooks/useLastPerformance.test.jsx` ("whose history") holds all of it: the filter on every page of both reads, no athlete filter on either read without it, and two athletes opened in turn — same session id, same exercise — each getting their own numbers from their own entries.
- **Opening a session, adding an exercise in the editor, or coming back to the tab must not download the athlete's history.** The hint's key is `['last-performance', studentRowId ?? 'self', sessionId, exerciseIds]`, so each of those starts or refetches a query — and that query only picks its exercises out of the list `fetchDoneSetHistory` already holds (see "Stats"). Putting a `supabase.from('set_logs')` back into the hook's `queryFn` brings the scan-per-session back without failing any assertion on the hint itself; the request counts in `src/hooks/useLastPerformance.test.jsx` ("the history is read once") are what notices.
- **Nothing invalidates `['last-performance']`: a hint is renewed by its own `staleTime` (one minute) and by nothing else.** That is enough as long as a mount or a return to the tab re-derives any hint older than that — which is free, since it comes out of the shared history, and a confirmation does renew that. Lengthen the hint's `staleTime`, or stop it refetching on focus, and a session that was opened before another one was trained keeps its older "last time" — the entry is persisted, so across reloads too. Whoever makes that change makes the confirmation invalidate `['last-performance']` in the same commit; re-deriving every cached hint costs one history read between them.

## docs/ARCHITECTURE.md — React Query — who owns which key

Add after the table row that starts "| [useStudentProgressStats]":

| [useStudentRecords](../src/hooks/useStudentRecords.js) | `['student-records', studentRowId ?? userId]` — derived from the shared history below, plus the bodyweight series | read-only; renewed by `['student-records']` (confirm, unconfirm, `useLogBodyweight`) |
| [useLastPerformance](../src/hooks/useLastPerformance.js) | `['last-performance', studentRowId ?? 'self', sessionId, exerciseIds]` — picked out of the shared history below; persisted | read-only |
| [lib/doneSetHistory](../src/lib/doneSetHistory.js) | `['student-records', 'history', studentRowId ?? userId]` — every done set of the athlete, swaps applied. Read through `queryClient.fetchQuery` by the two hooks above, never observed, never persisted; trusted for `HISTORY_STALE_MS` | read-only; flagged stale by the same `['student-records']` invalidations, read again by the next query that derives from it |

Add after the table:

A query may derive from another one instead of reading the network: its `queryFn` awaits `queryClient.fetchQuery` on the shared key and reduces the result. `fetchDoneSetHistory` in `src/lib/doneSetHistory.js` is the one case today. The shared entry then has no observer, which is the point — invalidating it costs nothing until something derives from it — and three options are set where it is fetched, not inherited: `staleTime` (how old a read a deriving query accepts), `gcTime` (an unobserved entry is otherwise collected after five minutes, before it is stale) and `retry: false` (the deriving query retries).

## CLAUDE.md — Repo map

Add to the `lib/` entry, after the line for `supabasePaging.js` (after the line that starts "  lib/           supabase.js  queryClient.js" if that one is not there yet):

```
                 doneSetHistory.js (fetchDoneSetHistory — an athlete's done sets, read once, shared
                 by records and "Last time")
```

## CLAUDE.md — Feature → files map

Add a row after the row "Performance-aware stats":

| An athlete's done-set history (ONE read for records + "Last time") | `lib/doneSetHistory` (`readDoneSetHistory` — done sets + swaps, paged, sent together, flat rows oldest first with the swap applied; `fetchDoneSetHistory(queryClient, { studentRowId, userId })` — the cached entry `['student-records', 'history', athlete]`, trusted for `HISTORY_STALE_MS`, renewed by any `['student-records']` invalidation, never persisted), consumed by `hooks/useStudentRecords` and `hooks/useLastPerformance` from their `queryFn`. Tests: `lib/doneSetHistory.test.js`, `hooks/sharedHistory.test.jsx` (both hooks side by side + the real confirm mutation) |

Replace, in the row "Session "Last time" reference", the words "(now role-aware: pass a `studentRowId` and both reads filter through the program join, or omit it and RLS scopes to the signed-in student)" with:

(role-aware: pass a `studentRowId` and both reads of the shared history in `lib/doneSetHistory` filter through the program join, or omit it and RLS scopes to the signed-in student; adding an exercise in the editor starts a new query that finds the history in the cache and sends nothing)

Replace, in the row ""Last time" hint (prior performance at point of logging)", the words "`hooks/useLastPerformance` (student-only, RLS-scoped; no `students.id` resolve)" with:

`hooks/useLastPerformance` (picks the open session's exercises out of the athlete's shared history, `lib/doneSetHistory`; RLS-scoped in the athlete flow, no `students.id` resolve)

Replace, in the row "Personal records + bodyweight", the words "`hooks/useStudentRecords`, `hooks/useBodyweight`" with:

`hooks/useStudentRecords` (reduces the shared history from `lib/doneSetHistory`; reads only the bodyweight series itself), `hooks/useBodyweight`

Replace, in the row "Performance-aware stats", the words "each fetches the student's `slot_deviations` swaps and credits a swapped set to the substitute exercise" with:

both derive from `lib/doneSetHistory`, which reads the student's `slot_deviations` swaps once and hands a swapped set over under the substitute exercise
