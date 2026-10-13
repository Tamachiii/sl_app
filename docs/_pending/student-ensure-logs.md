# student-ensure-logs — docs to fold (wave 2, items L8, N1)

Each block: target doc, section, then the text to fold in.

## docs/INVARIANTS.md — Offline-safe student writes

Add after the bullet that starts "**The moment of a set is put into the variables by the hook, when `mutate` is called.**" (the last one the snippet of `student-setlog-optimistic-timestamps` adds to this section — fold that snippet first).

To the integrator, before the text: two things in the tree wait for this lane to meet `lane/w2-offline-core`. Both were checked on 2026-10-13 on a throw-away clone that stacks this lane on the head of that one — the lane's commits apply without a conflict (`src/hooks/useSetLogs.js` is touched by both and merges by itself), and in the suites that were run there (`src/lib`, the set-log hooks, `src/components/student`, `OfflineBanner`) the only tests that turn red are the three `it.fails` of this lane, each with "Expect test to fail".

1. The second bullet below depends on the `onSettled` default that `core-mutation-contracts` gives the set-log keys in `lib/offlineMutations.js`. Without it, rows added while a set-log write was on its way are read at the next opening of the page only. `src/hooks/useSetLogs.ensure.test.jsx` says so as an `it.fails`, "the rows added while a tick was on its way are read once the tick has landed": delete `.fails` there — nothing else changes in the test; it passes on the stacked clone.
2. `src/lib/offlineSafety.test.js` excuses `useEnsureSetLogs` from its rule "an online-only write has an online guard" for as long as the hook does not name `ensure_set_logs` (`LEGACY_UNGATED`). The hook names it now and reads the network itself, so the rule holds for it without the excuse — the file passes on the stacked clone with the filter removed. Delete `LEGACY_UNGATED`, the filter that reads it and the test "an excuse is for an entry of the list, and for nothing else", and change the comment of the `useEnsureSetLogs` entry of `ONLINE_ONLY` to "started by the hook itself, only when the device and `onlineManager` are online".

The text below describes the tree with both lanes in it.

- **Opening a session starts no write, and nothing that could wait for a network.** `useEnsureSetLogs(sessionId, slots, logs, { enabled })` in [`hooks/useSetLogs.js`](../src/hooks/useSetLogs.js) completes the sets of the session the athlete has open — a prescribed set without its row is added by `ensure_set_logs(p_session_id)` — and it is the hook, not the page, that decides whether anything is sent. Five rules. (1) **Nothing is missing, nothing is sent**: `missingSets` counts, for every exercise the page shows, the numbers from 1 to `sets` without a row among the sets the page has read (`logs`, `undefined` until they are — a list that is not there yet is not an empty one). It is the rule of the function, word for word: a row on a number is a row, an athlete's extra set included. The two must stay one rule — a set the device counts missing and the database does not is a call at every opening. (2) **Nothing is started without a network**: the effect asks `useOnlineStatus()` AND `onlineManager.isOnline()`, the second because it is the one that parks a mutation instead of sending it. A mutation started offline does not fail, it is paused: it is a "change waiting to sync" over a workout in which nothing was entered, and a write the queue cannot replay after a relaunch — its `mutationFn` is not one `registerOfflineMutationDefaults` knows. So this mutation has no `mutationKey`, is not in `MUTATION_KEYS`, and is never started to wait; when the network returns the effect runs again. (3) **The device says whether to ask, the database what is missing**: the variables are `{ sessionId }` and the request is `supabase.rpc('ensure_set_logs', { p_session_id })`. No number of sets and no target leaves the device, so a set the coach removed since the device read the session cannot come back. (4) **Each list of missing sets is asked for once per opening of the page** (`asked`, a `Set` of `sessionId|slot:number,…` held in a ref, emptied when the network goes): an answer that changes nothing on the device must not be asked for again. (5) **A refusal is silent** (`meta: { skipErrorToast: true }`): the athlete asked for nothing, and the sets that exist are on screen. The page switches the hook off (`enabled: false`) on a session it shows read-only — the function refuses a past block and an archived session, and rows added to a reviewed one would be sets the coach never read — and while the session or its sets are being read again (`isFetching`): "missing" is counted on two reads, which are only worth comparing once both have answered. Tests: `src/hooks/useSetLogs.ensure.test.jsx` (the hook, with the device offline, `onlineManager` offline, and each alone), `src/components/student/SessionView.offline.test.jsx` (the page on its real reads next to `OfflineBanner`: a session opened without a network leaves the mutation cache empty).
- **The answer of `ensure_set_logs` is what is read again.** More than `0`: `['set-logs', sessionId]`, which has new rows. `0`: the database is short of nothing where the device counted a set missing, so the device's copy is behind — `['session', sessionId]` (its numbers of sets) and `['set-logs', sessionId]` are both invalidated, after which the two agree and nothing is asked. The read of the sets is left out while a set-log write is pending (`isMutating({ mutationKey: ['set-log'] })`): made between two queued writes it comes back without the second, and the read that follows the last of them (`refreshAfter` in `lib/offlineMutations.js`) brings the added rows as well. No other key is touched, and nothing is read again after a refusal.
- **A database without `ensure_set_logs` is served by the hook itself, and still from the database's exercises.** On `PGRST202` — and on no other error: a refusal of the function is not a missing function — `insertMissingSetLogs(sessionId)` reads `exercise_slots` of the session (`id, sets, reps, duration_seconds, weight_kg, rest_seconds`) and the `set_logs` of those exercises, and inserts the missing rows with the targets of their exercise, under the athlete's own policies. It answers the number of rows like the function, so what is read again is the same. It takes nothing from the cache either. It is an athlete's own `INSERT` of prescribed rows with targets — the write the contract migration of review L6 (Checkpoint Z) is there to close: the migration and the removal of this path go together.

## docs/INVARIANTS.md — RLS / DB conventions

Replace, in the bullet that starts "**The missing sets of a session, and the registration of a device for notifications, each have a function that does it for the account that calls**", the sentence "`useEnsureSetLogs` still reads which sets exist and inserts the others from the exercises in its cache, so a set the coach has removed since comes back (P22);" with:

`useEnsureSetLogs` calls the first, with the id of the session and nothing else, when the session page counts a prescribed set without a row (the bullet "**Opening a session starts no write, and nothing that could wait for a network.**" under "Offline-safe student writes");

To the integrator: the bold lead of that bullet ends "— and the app's own requests do not use them yet." It is false for `ensure_set_logs` from this package on, and for `claim_push_subscription` from `core-push-identity` (lane offline-core, same wave) on. With both folded the lead ends at "for the account that calls."

Replace, in the bullet that starts "**A session the coach has reviewed is read-only for the athlete and its confirmation cannot be undone**", the sentence "The `useEnsureSetLogs` safety net is not fired on a read-only session: rows added to a reviewed session would be sets the coach never read." with:

`useEnsureSetLogs` is switched off on a read-only session (`enabled: false`): rows added to a reviewed session would be sets the coach never read, and `ensure_set_logs` refuses a session that is closed.

## docs/INVARIANTS.md — Training is a QUEUE; the calendar is a consequence

Replace, in the bullet that starts "**"No program assigned yet" is said by a read that answered, and by nothing else.**" (added by the snippet of `student-training-list-offline` — fold that one first), the words "`readState` in [`StudentTraining.jsx`](../src/components/student/StudentTraining.jsx) names" with:

`readState` in [`lib/readState.js`](../src/lib/readState.js) names

Replace, in the same bullet, the words "`offline` and `failed` render `Unavailable`" with:

`offline` and `failed` render [`Unavailable`](../src/components/student/Unavailable.jsx)

Add after that bullet:

- **The session page shows a session only when it holds one, and offers no confirmation of a session it does not hold.** [`SessionView.jsx`](../src/components/student/SessionView.jsx) is made of two reads: `useSession`, and `useSetLogs` once the session is known to have exercises (a session without an exercise waits for no sets). `readState` over those — the same function as the training list, with `useOnlineStatus()` and `useIsRestoring()` — decides what is rendered: the spinner on `loading`, the page on `ready`, and on `offline` or `failed` the top bar (the session's title when the row is there, `sessionUnavailable.title` otherwise) over `Unavailable` with the strings of the `sessionUnavailable` namespace and a "Try again" that calls `refetch({ cancelRefetch: false })` on the reads. Nothing else of the page is rendered then: no progress line, no exercise, no "Confirm session". Testing `isLoading` alone is the trap, as on the list: a read that waits for the network or failed is not loading and has no data, and rendered as an empty session it was a page titled "Session" with a live "Confirm session" (live item N1). The session row without its sets is not a session either: exercises with no set under them, and a confirmation whose training date `performedOnFromLogs` cannot read. Data wins here too — the workout the device holds is shown offline and after a refresh that failed. When the network returns and the page is not `ready`, an effect asks again by itself, once, on the offline → online step. What is NOT waited for: the confirmation, the notes, the swaps, the videos and "Last time". A session that was read ahead and never opened has none of them on the device, and it has to be trainable and confirmable in the gym; an unknown confirmation is shown as "not confirmed", and the confirm is insert-or-nothing.

## docs/ARCHITECTURE.md — Program periodization (multiple blocks per student)

Replace, in the bullet that starts "**Server-side materialization**", the sentence "`useEnsureSetLogs` does not call it yet." with:

`useEnsureSetLogs` calls it from the athlete's session page, only when the page counts a prescribed set without a row and the device is online; a database that does not have the function (`PGRST202`) is served by three requests of the hook that read the exercises there as well.

Replace, in the bullet that starts "**Backfill**", the words "SessionView additionally skips the lazy materialization on read-only sessions to keep the console clean." with:

SessionView switches the hook off on read-only sessions, where `ensure_set_logs` refuses.

## docs/ARCHITECTURE.md — React Query — who owns which key

Replace, in the row "useSetLogs" (as the snippet of `student-setlog-optimistic-timestamps` leaves it — fold that one first), the sentence "`useAddStudentSet`, `useRemoveStudentSet` and `useEnsureSetLogs` invalidate `['set-logs']` (broad) themselves." with:

`useAddStudentSet` and `useRemoveStudentSet` invalidate `['set-logs']` (broad) themselves. `useEnsureSetLogs` invalidates `['set-logs', sessionId]` when its answer is more than 0, and `['session', sessionId]` with it when the answer is 0 — the device's copy is behind — leaving the sets to the read that follows a set-log write when one is pending.

To the integrator: the same snippet's bullet "**The set-log hooks read nothing again by themselves.**" (docs/INVARIANTS.md, "Offline-safe student writes") ends "`useAddStudentSet`, `useRemoveStudentSet` and `useEnsureSetLogs` are not on these keys and still invalidate `['set-logs']` themselves: they add or remove rows." It stays true; `useEnsureSetLogs` narrows it to the sets of its session, as the row above says.

## README.md — Offline Support (Student Session Logging)

Add after the bullet that starts "- **Training list and next session**" (added by the snippet of `student-training-list-offline` — fold that one first):

- **Opening a session** — writes nothing. The page shows the session and the sets the device holds, and asks the database to add a prescribed set only when it finds one without a row and the device is online (`ensure_set_logs`, which reads the exercises in the database): nothing is ever "waiting to sync" because a session was opened. A session that is not on the device and cannot be read — it was never opened and was not the next one of the list — is shown as that: "This session isn't on this device yet" without a network, "couldn't be loaded" with one, a "Try again", and no "Confirm session". It opens by itself when the network returns.

## README.md — Database Tests

Replace, in the bullet that starts "- `ensure-claim.test.js` holds the two functions that write for the account that calls.", the words "(`app.ensure`, after `useEnsureSetLogs`, takes the exercises "as the app has them in its cache";" with:

(`app.ensure`, after `useEnsureSetLogs` as it was until wave 2, takes the exercises "as the app has them in its cache" — the hook calls `ensure_set_logs` now;

## CLAUDE.md — Repo map

Replace "                 loggedSets.js (isLoggedSet — the one "has the athlete logged this set" predicate," with:

````
                 readState.js (readState — what a page can say about the reads it is made of:
                 ready, loading, offline or failed)
                 loggedSets.js (isLoggedSet — the one "has the athlete logged this set" predicate,
````

Replace "                 StudentProfile" (the last line of the `student/` list) with:

````
                 StudentProfile  Unavailable (what stands where content would be when its read
                 got no answer)
````

## CLAUDE.md — Feature → files map, row "Student session logging"

Replace "`ensure_set_logs(p_session_id)` adds the prescribed sets that are missing in a session of the calling athlete, from the exercises as they are in the database, and answers how many — `SECURITY DEFINER`, own session + block being trained + session neither archived nor reviewed, not called by `useEnsureSetLogs` yet." with:

`ensure_set_logs(p_session_id)` adds the prescribed sets that are missing in a session of the calling athlete, from the exercises as they are in the database, and answers how many — `SECURITY DEFINER`, own session + block being trained + session neither archived nor reviewed. `useEnsureSetLogs(sessionId, slots, logs, { enabled })` in `hooks/useSetLogs` calls it from `SessionView`: only when the page counts a prescribed set without a row, only when the device and `onlineManager` are online, once per list of missing sets, with a mutation that has no key, is never queued and says nothing when it is refused; its answer decides what is read again, and on `PGRST202` it reads the exercises in the database and inserts the rows itself. `SessionView` renders the session only when its two reads hold data (`lib/readState`, shared with the training list): otherwise a spinner, or the top bar over `student/Unavailable` — "isn't on this device yet" / "couldn't be loaded" with Try again, strings in the `sessionUnavailable` namespace — and no "Confirm session". Tests: `hooks/useSetLogs.ensure.test.jsx`, `student/SessionView.offline.test.jsx` (the real reads and hook, a cache saved with `shouldPersistQuery`, `OfflineBanner` next to the page), `student/SessionView.test.jsx` (hook layer stubbed: each state of the two reads), `lib/readState.test.js`.

## CLAUDE.md — Feature → files map, row "Student training surface (ONE page: was Home + Sessions)"

Replace, in the text the snippet of `student-training-list-offline` puts into this row (fold that one first), "The page renders the list only when both of its reads hold data (`readState`): otherwise a spinner, or `Unavailable`" with:

The page renders the list only when both of its reads hold data (`readState` of `lib/readState`): otherwise a spinner, or `student/Unavailable`
