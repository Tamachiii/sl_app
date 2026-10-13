# stats-request-plan — docs to fold (wave 2, items P34, N4)

Each block: target doc, section, then the text to fold in.

## docs/INVARIANTS.md — Stats

Add after the bullet that starts "**The flat `set_logs` list in `useStudentProgressStats` holds DONE sets and nothing else.**":

- **A Stats page computes ONE scope per visit, and holds its stats query back until it knows which.** Every scope is a cache entry of its own (`['student-progress-stats', <owner>, <scope>]`) and a full read — a tree and three lists — so a page that starts on the default and switches a moment later reads the whole history under `'all'` for nothing. [`resolveStatsScope`](../src/lib/statsPrefs.js) decides from what the FIRST render can see: the URL param, else the saved scope read from localStorage during render. `'all'` and `'active'` are known at once; a program id is known when the programs list is there — kept if the list has it, `'all'` if it does not — and until then `resolved` is false and `scope` is the id that was asked for. Both surfaces ([`StudentDashboard`](../src/components/student/StudentDashboard.jsx), [`StudentStatsSection`](../src/components/coach/StudentStatsSection.jsx)) pass `{ enabled: scopeResolved }` to `useStudentProgressStats`. Three things must stay as they are. **The saved scope is read on every render, never held in state or a memo**: picking "All" clears it and the next render has to see that. **"Scope not known" counts as loading** (`!scopeResolved || isLoading`): a query that is held back is not loading for React Query (`isLoading` false, `data` undefined), and without that the page falls through to its empty state — "No program assigned yet" — until the list arrives. **A programs list that failed or is paused is not waited for** (`listUnavailable`): the page computes `'all'`, as it does for an id it cannot find; waiting would leave a saved block on its spinner for as long as the device is offline. An effect still writes the saved scope into the URL after mount; it decides nothing, and the query key does not change when it runs.
- **The Stats page sends six reads, and the athlete's row id once.** In order: `students` (the row id), the shallow programs list, the program tree, then confirmations, done sets and swaps TOGETHER (`Promise.all` in `useStudentProgressStats` — the three filter through the program join and none needs the rows of another; the tree stays first because it decides whether they are sent at all). The history overlay ([`useStudentHistoricalSessions`](../src/hooks/useStudentHistoricalSessions.js), two more reads) is drawn in the `'active'` scope only and takes `{ enabled }` so that it is read there only: eight reads in that scope. Changing the scope adds four (the tree and the three lists of the new scope). [`src/components/student/StudentDashboard.requests.test.jsx`](../src/components/student/StudentDashboard.requests.test.jsx) mounts the page on its real hooks over `fakePostgrest` and counts; a new read on this page changes those numbers on purpose or not at all. Awaiting the three lists one after the other again fails `src/hooks/useStudentProgressStats.test.jsx` ("the three flat lists go out together").
- **An athlete's `students.id` is one cache entry, `['my-student-id', userId]`, shared through `myStudentIdQueryOptions`.** [`useStudents.js`](../src/hooks/useStudents.js) exports the read as query options. A component observes it with `useMyStudentId()`; a `queryFn` that needs the id before its own reads takes it with `queryClient.ensureQueryData(myStudentIdQueryOptions(user.id))` — the cached value, the read already in flight, or a new one — and never reads `students` itself. `useStudentProgressStats` (athlete flow) and `useStudentHistoricalSessions` do; the Stats page mounts both next to `useMyStudentId` and used to send the same request three times. The entry has `staleTime: Infinity`: nothing in the app re-creates the row an account trains under (`students` has no INSERT or DELETE policy, `transfer_student` updates the row in place). It is not in `PERSISTED_QUERY_ROOTS`, so a reload reads it again, and a failed read is not kept. An owner who deletes and re-creates a link by SQL changes the id under a session that is open: that session keeps the old id until it reloads.
- **Changing the Stats scope keeps the figures that were on screen — of the same owner only.** `useStudentProgressStats` passes `placeholderData`: while a scope that was never read loads, `data` is the previous scope's, `isPlaceholderData` is true and `isLoading` stays false. Both surfaces keep the page as it is — the selector, which already shows the new choice, stays usable — and wrap the figures in an element with `aria-busy="true"` and `opacity-50` until the new ones arrive. It is NOT React Query's `keepPreviousData`: the coach's section stays mounted from one athlete to the next, and would show athlete A's figures under athlete B's name while B loads. The function returns the previous data only when `previousQuery.queryKey[1]` — the owner, a `students.id` in the coach flow and the user id in the athlete's — is the owner being asked for. A component that reads `data` for anything it must not show stale (the history overlay is one: it is not drawn over outgoing figures) checks `isPlaceholderData`.

## docs/INVARIANTS.md — Stats persistence

Replace, in the bullet that starts "**Stats page selections are persisted in URL + localStorage.**", the sentence "On mount, if the URL has no scope param, the parent hydrates it from localStorage." with:

The scope is decided during render by `resolveStatsScope` — the URL param wins, else the saved scope, else `'all'` — so the first render already computes the saved scope (see "A Stats page computes ONE scope per visit" under "Stats"); an effect then writes the saved scope into the URL, which changes nothing that is computed.

Replace, in the same bullet, the sentence "Stale ids fall back gracefully via the existing `scopeIsValid` and `exercises.some(...)` checks." with:

Stale ids fall back gracefully: `resolveStatsScope` answers `'all'` for a program id the programs list does not have, and `ExerciseProgressChart` falls back through its `exercises.some(...)` check.

## docs/ARCHITECTURE.md — Program periodization (multiple blocks per student)

Replace, in the bullet that starts "**`useStudentProgramDetails`** is the lighter stats-free fetch", the sentence "**`useStudentProgressStats(studentId?, scope='all')`** is the heavy aggregate fetch; omit `studentId` for self-stats, pass it from the coach view, and pass `scope` to choose 'all' programs, only the 'active' one, or a specific program id." with:

**`useStudentProgressStats(studentId?, scope='all', { enabled = true })`** is the heavy aggregate fetch; omit `studentId` for self-stats, pass it from the coach view, and pass `scope` to choose 'all' programs, only the 'active' one, or a specific program id. A page passes `enabled: false` until it knows its scope (`resolveStatsScope` in `src/lib/statsPrefs.js`), and gets the previous scope's figures back as placeholder data while a new scope of the same athlete loads.

## docs/ARCHITECTURE.md — SessionCalendar history overlay

Replace the sentence "The hook stays separate because it's the lightest possible fetch (no aggregation) and is fast to skip when not needed." with:

The hook stays separate because it is the lightest possible fetch (no aggregation), and it is not sent at all outside that scope: `useStudentHistoricalSessions({ enabled })`, which `StudentDashboard` passes as `scope === 'active'`.

## docs/ARCHITECTURE.md — React Query — who owns which key

Replace the table row that starts "| [useStudents]" with:

| [useStudents](../src/hooks/useStudents.js) | `['students']` (the athletes the signed-in user coaches: `coach_id = user.id`, not every `students` row RLS lets them read), `['my-student-id', userId]` (the athlete's own `students.id`; `staleTime: Infinity`, not persisted; exported as `myStudentIdQueryOptions` so that a `queryFn` shares the entry through `queryClient.ensureQueryData`) | n/a |

Replace the table row that starts "| [useStudentProgressStats]" with:

| [useStudentProgressStats](../src/hooks/useStudentProgressStats.js) | `['student-progress-stats', studentRowId ?? userId, scope]` — one entry per scope (`'all'`, `'active'` or a program id); takes `{ enabled }`; in the athlete flow the row id comes from `['my-student-id', userId]`; hands back the previous scope of the same owner as placeholder data | read-only; renewed by `['student-progress-stats']` (confirm and unconfirm, the program writes of `useProgram`, the adopt hooks of `useAdoptSwap`) |

Replace the table row that starts "| [useStudentHistoricalSessions]" with:

| [useStudentHistoricalSessions](../src/hooks/useStudentHistoricalSessions.js) | `['student-historical-sessions', userId]` — takes `{ enabled }`, on for the Stats page's `'active'` scope only; the row id comes from `['my-student-id', userId]` | read-only |

Replace, in the paragraph that starts "A query may derive from another one instead of reading the network", the sentence "`fetchDoneSetHistory` in `src/lib/doneSetHistory.js` is the one case today." with:

`fetchDoneSetHistory` in `src/lib/doneSetHistory.js` is the one case of a whole derived read today. A smaller form of the same idea: a `queryFn` that only needs one value another query holds takes it with `queryClient.ensureQueryData(<the exported query options>)` and goes on with its own reads — `myStudentIdQueryOptions` in `src/hooks/useStudents.js`, used by the two stats queries. That entry does have an observer (`useMyStudentId`), and `ensureQueryData` joins the read the observer has in flight.

## CLAUDE.md — Feature → files map, row "Student stats (bucketed by REAL calendar weeks)"

Replace the row's file list with:

`student/StudentDashboard`, `coach/StudentStatsSection` (the same figures for one athlete, inside the coach's athlete page), `student/SessionCalendar`, `student/WeeklyVolumePanel` (`formatBucketRange` — rows are date ranges), `student/ExerciseProgressChart` (one point per SESSION on a date axis), `student/ProgramScopeSelector`, `lib/statsPrefs.js` (`resolveStatsScope` — which scope a page computes, decided during render from the URL and the saved scope; the stats query waits for it), `hooks/useStudentProgressStats` (buckets on `sessions.performed_at`; `backlogSessions` holds undated work; `{ enabled }`; the three flat lists read together; the previous scope of the same athlete stands in while a new one loads), `hooks/useStudentHistoricalSessions` (`{ enabled }` — read in the `'active'` scope only), `hooks/useStudents` (`useMyStudentId` + `myStudentIdQueryOptions` — the athlete's `students.id`, one cache entry for every query that needs it), `student/StudentDashboard.requests.test.jsx` (the page on its real hooks: how many reads it sends, and in which order)
