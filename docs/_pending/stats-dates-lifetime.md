# stats-dates-lifetime — docs to fold (wave 3, items P19, P36)

Each block: target doc, section, then the text to fold in.

## docs/INVARIANTS.md — The date a session was actually trained

Add after the bullet that starts "**The mirror is maintained by its own trigger, `sync_session_performed_at`**":

- **`sessions.performed_at` holds a DATE stored as midnight UTC, and is read as a date — never through `new Date()`.** What `sync_session_performed_at` writes is `performed_on::timestamptz`, `'2026-09-28T00:00:00+00:00'` for a session trained on Monday 28 September, and the optimistic write of `useSessionConfirmation` (`performedAtOf`) writes the same string. Read as an instant, that midnight is Sunday evening anywhere west of Greenwich: the session sat on Sunday of the strip, in the week before on the Stats page and its calendar, and "trained today" read "yesterday". Europe and CI (UTC) never see it. Every reader takes the date part, at local midnight: `performedDate` in [`lib/day.js`](../src/lib/day.js) (and through it `buildDayStrip`, the done list of `StudentTraining`, the coach roster), `buildQueue` (`lastPerformedAt` is that Date, and `daysSince` is given the Date, never a `'YYYY-MM-DD'` string, which `new Date()` reads as UTC), `trainedOn` in [`useStudentProgressStats`](../src/hooks/useStudentProgressStats.js) (`calendarDay`), and `useStudentHistoricalSessions`. `confirmed_at` and `logged_at` are real instants and are read in the device's zone, where the athlete trained. Two cases are read by their UTC date part and accepted: a `performed_at` the trigger set from `confirmed_at` (a `performed_on` more than a day in the future, clamped), which is a day early for an evening west of Greenwich; and a confirmation whose `performed_on` is itself wrong in the future, which `trainedOn` takes as it is where the mirror was clamped — the app always sends `performedOnFromLogs`. The zone tests run through `inTimeZone(zone, fn)` of `src/test/inTimeZone.js` (sets `process.env.TZ`, checks that `Intl` follows it, keeps it across the awaits of a hook test) in Los Angeles, Kiritimati and Paris; a fixture of `performed_at` is written as the database writes it, `'<day>T00:00:00+00:00'`.

Replace the bullet that starts "**Rows written before the column existed degrade quietly, never by inventing a date.**" — the text `docs/_pending/stats-completion-rules.md` gives it; this one replaces that one — with:

- **Rows written before the column existed degrade quietly, never by inventing a date.** `buildQueue` ignores a confirmed session with no `performed_at` when computing staleness; `buildDayStrip` falls back to the day it was PLANNED for; `trainedOn` in [`useStudentProgressStats`](../src/hooks/useStudentProgressStats.js) takes the confirmation's `performed_on` → `performed_at`, read as a date → the earliest `logged_at` of the session's done sets (`performedOnFromLogs`, asked only with sets that carry a time — it answers "today" for none) → the confirmation's `confirmed_at` → `scheduled_date` for a LEGACY row only, archived AND reviewed. An open session with none of these is counted in `backlogSessions` rather than parked on a made-up day; an archived one with none of these and no done set was never trained, and is in no figure (next section).

## docs/INVARIANTS.md — Stats

In the bullet that starts "**Time-based stats bucket by the REAL calendar week the student trained in**", add after the words "(Mon–Sun of the day `trainedOn` gives)" (the wording `docs/_pending/stats-completion-rules.md` gives them):

, a `'YYYY-MM-DD'` that is the same in every zone — the date columns read as dates, the instants in the device's zone (previous section)

Add after the bullet that starts "**Stats are performance-aware: charts show PERFORMED work, not just the prescription**":

- **The lifetime volume of the Profile page is the tonnage of the Stats page, over every done set of every block that is not in the trash.** [`useStudentLifetimeStats`](../src/hooks/useStudentLifetimeStats.js) (`setTonnage`): reps = `actual_reps ?? target_reps`, 0 on a slot held for a time (`exercise_slots.duration_seconds`), times load = `actual_weight_kg ?? target_weight_kg`, 1 kg for no load or a load of 0. It reads no `set_logs.weight_kg` and joins no exercise: `volume_weight` is a multiplier, which the old total multiplied by the target reps (5 × 5 at 100 kg made 25), and an inner join to the library dropped the sets of an exercise the athlete can no longer read. The two counts and the volume read filter `programs.deleted_at IS NULL` through their embed, as the Stats page, the training list and the history do. One difference with the Stats page is kept: on a SWAPPED slot the Stats page takes the actual load alone, which needs the swaps; here a swapped set with no actual load counts its target. "Sessions" counts confirmations and "Sets done" every done set, added ones included.

## docs/INVARIANTS.md — `set_logs` — per-set targets, outcomes, RPE

In the bullet that starts "**Per-set targets live on `set_logs`, not `exercise_slots`.**", replace "and student actuals (`done`, `failed`, `rpe`, `weight_kg`)." with:

and student actuals (`done`, `failed`, `skipped`, `rpe`, `actual_reps`, `actual_weight_kg`, `logged_at`). `set_logs.weight_kg` is the athlete's load from before the actuals: nothing writes it, and no select of `set_logs` names it — `src/lib/setLogsSelects.test.js` reads every select on `set_logs` in `src/` (chained on `.from('set_logs')` or embedded as `set_logs(…)`, constants resolved) and fails on one that does, so the column can be dropped without breaking a read.

## docs/ARCHITECTURE.md — Per-set targets

Replace "and the student's actuals (`done`, `rpe`, `weight_kg`)." with:

and the student's actuals (`done`, `rpe`, `actual_reps`, `actual_weight_kg`; the older `weight_kg` is read and written by nothing).

## docs/ARCHITECTURE.md — SessionCalendar history overlay

Add at the end of the paragraph that starts "`useStudentHistoricalSessions` fetches dated sessions":

A session is on the day it was trained — `performed_at` read as a date by `performedDate` — and on its `scheduled_date` otherwise.

## CLAUDE.md — Repo map

In the `src/test/` entry, add after "`fakeServiceWorker.js` (…; memoryStorage)":

inTimeZone.js (inTimeZone(zone, fn) — a test run as a device in that zone, sync or async; ZONES)

## CLAUDE.md — Feature → files map, row "Real training dates (`performed_on` / `performed_at`)"

Replace "The date comes from the session's `set_logs.logged_at`, NOT from `confirmed_at` — which is the replay moment for an offline confirm" with:

The date comes from the session's `set_logs.logged_at`, NOT from `confirmed_at` — which is the replay moment for an offline confirm. `sessions.performed_at` holds that date as midnight UTC and is read as a date (`performedDate`, `buildQueue`, `trainedOn`, `hooks/useStudentHistoricalSessions`), never through `new Date()`; tests in three zones through `test/inTimeZone`

## CLAUDE.md — Feature → files map, row "Student stats (bucketed by REAL calendar weeks)"

In the text `docs/_pending/stats-completion-rules.md` gives this row, replace "the day every time-based figure keys off: `performed_at`, the confirmation, the earliest done set," with:

the day every time-based figure keys off: the confirmation's `performed_on`, `performed_at` read as a date, the earliest done set,

## CLAUDE.md — Feature → files map, row "Student profile"

Replace "`hooks/useStudentLifetimeStats`" with:

`hooks/useStudentLifetimeStats` (confirmations, done sets, and the volume as the Stats page's tonnage over done sets — actual else target reps × load, 1 kg without a load, nothing on a timed slot; a swapped set without an actual load counts its target; blocks in the trash left out), `lib/setLogsSelects.test.js` (no select of `set_logs` names its `weight_kg`)
