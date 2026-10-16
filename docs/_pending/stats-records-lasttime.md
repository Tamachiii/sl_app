# stats-records-lasttime — docs to fold (wave 3, items P37, P30)

Each block: target doc, section, then the text to fold in.

## docs/INVARIANTS.md — Stats

In the bullet that starts "**Personal records + bodyweight** (2026_07_14).", replace "and a `recent` flag for a PR set in the last 14 days." with:

and a `recent` flag for a PR set in the last 14 days. `recent` is said of the number the card shows, and only of it: `bestE1rmAt` for a record that has an e1RM (the rounded `bestE1rm` that [PersonalRecords](../src/components/student/PersonalRecords.jsx) tests to pick the e1RM view), `bestRepsAt` only for a record with none. The most reps in a set move with any set at any load — a light back-off of 12, an extra set with reps and no weight — and lit "New PR" beside an e1RM that had not changed; do not put `bestRepsAt` back in the flag of a weighted record.

Replace the bullet that starts "**\"Last time\" does not depend on the order its rows arrive in.**" with:

- **"Last time" is the session trained last, by `logged_at`, and does not depend on the order its rows arrive in.** `useLastPerformance` hands the athlete's whole history to `buildLastPerformance` (every done set, all exercises — a prior swap sits under another `exercise_id`) with the open session's `exerciseIds`, which are the only exercises that get an entry. Per exercise, the sessions are ranked by the latest `logged_at` of their sets of it, compared as instants (the stamps come as `Z`, `.000Z` and `+00:00`, which do not sort as text); a session with no stamp comes after every session with one, and `scheduledDate` then `sessionId` only break ties, so the answer is the same on every load. Two kinds of session are left out: the open session itself, and a session that STARTED AFTER it — whose first logged set, of any exercise, is later than the open session's first. `sessions.scheduled_date` takes no part: it is advice, a copy of a block carries none, and an athlete trains a session before its date; a rule that dropped the sessions dated on or after the open one (or after today) hid a session trained ahead of its date, and one that ranked by the date first put an old dated block above last week's undated copy. An open session with no logged set in the history cuts nothing, nor does a session with no stamp. The hook's third parameter (`_currentScheduledDate`) is not read and stays for its two callers. The old newest-first `.order('logged_at')` existed only so that the cut at 1000 rows kept the recent part; there is no cut any more.

In the item that starts "**Between two invalidations a read is trusted for `HISTORY_STALE_MS` (10 minutes)**", replace ""Last time" never looks at the open session, so this delays only what the NEXT session's hint and the records list show;" with:

"Last time" reads the open session only for the time of its first set, which cuts the sessions started after it — a session being trained has none — so this delays only what the NEXT session's hint and the records list show;

## docs/INVARIANTS.md — Coach Athletes-roster layout

In the bullet that starts "**An athlete's own "Last time" is held as fresh for four hours, and a confirmation is what renews it.**", replace "every cached hint but the session's own (a hint never looks at its own session) is invalidated" with:

every cached hint but the session's own (a hint reads its own session only for the time of its first set, and a confirmation does not change when the session started; the confirmation of a LATER session is what changes this hint, and it flags it) is invalidated

## CLAUDE.md — Feature → files map, row "Personal records + bodyweight"

Replace "`lib/records.js` (Epley e1RM + `systemLoad`)" with:

`lib/records.js` (Epley e1RM + `systemLoad`; `recent` — the "New PR" pill — follows `bestE1rmAt` for a record with an e1RM and `bestRepsAt` only for a reps-only one)

## CLAUDE.md — Feature → files map, row ""Last time" hint (prior performance at point of logging)"

Replace "`lib/lastPerformance` (`buildLastPerformance`/`formatLastPerformance`/`daysSince`)" with:

`lib/lastPerformance` (`buildLastPerformance` — the session trained last by `logged_at`, leaving out the open session and those started after it, `scheduled_date` playing no part; `formatLastPerformance`/`daysSince`)
