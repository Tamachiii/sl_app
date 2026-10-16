# stats-panels — docs to fold (wave 3, items B39, B40, B41, B33, N7)

Each block: target doc, section, then the text to fold in.

## docs/INVARIANTS.md — Stats

Add after the bullet that starts "**Time-based stats bucket by the REAL calendar week the student trained in**":

- **The weekly panel draws consecutive weeks, a week nothing was trained in as a row of zeros.** `weeklyVolume` holds a bucket only for a week a session was trained in; [`WeeklyVolumePanel`](../src/components/student/WeeklyVolumePanel.jsx) takes it whole and picks its rows with `weeklyWindow(weeks, { now, current })`: `WEEKS_SHOWN` (4) consecutive Mon–Sun weeks, stepped by calendar day with `addDays` (a change of the clocks moves nothing), a missing week built in the hook's bucket shape with every figure at 0, never starting before the oldest week trained. The window ends at the week of today when `current` is true — `scopeReachesToday(scope, programs)` of [`lib/statsPrefs.js`](../src/lib/statsPrefs.js): `'all'`, `'active'` and the active block — so a layoff shows as empty weeks; it ends at the newest week trained for a past block, whose four weeks would otherwise all be empty weeks of today. The bars are scaled to the weeks drawn (`computeMaxWeeklyTotal`). A week's sets (`setsAdherence`, "3/3 · 100%") are drawn whenever it had prescribed sets, volume or not — a week of planks and holds has no volume, since `computeSessionVolume` skips a slot held for a time; "No training logged yet." (`statsPanels.noTraining`) is said only when `weeklyWindow` gives no week at all, and one line (`statsPanels.adherenceNote`) says that a week's sets are those of the sessions trained in it. Do not go back to `weeklyVolume.slice(-4)` in a page: the four rows were the last four weeks TRAINED, months apart after a layoff, and a week without volume replaced every row with "No volume assigned yet.".
- **The progression chart is a time axis, with a few dates under it.** In [`ExerciseProgressChart`](../src/components/student/ExerciseProgressChart.jsx), `pointPositions(points, { left, right })` places a point by its training day, counted from the digits of its `date` (`Date.UTC`, so the night the clocks change does not stretch a day); one point, or the points of one day, are centred; a point with no `date` makes the axis fall back to spacing by order. The first and the last point sit 10 units inside the plot (`INSET`) so their bar stays in it, and a bar is at most 18 wide and 0.6 of the gap to the nearest training day. The dates under the axis are `thinTicks(ticks, { max: 6 })`: for k from 6 down to 2, the point nearest each of k even marks along the axis, and the first k whose labels — `tickWidth` (a monospace estimate), centred on the point and held inside the chart by `tickCentre` — do not overlap; the first and the last point are always labelled, a single spot once. The program prefix (`BLO·7/8`) is part of a label's width. One label per point drew some 24 on top of each other after three months.

In the bullet that starts "**A Stats page computes ONE scope per visit, and holds its stats query back until it knows which.**", replace "A programs list that failed or is paused is not waited for** (`listUnavailable`): the page computes `'all'`, as it does for an id it cannot find; waiting would leave a saved block on its spinner for as long as the device is offline. An effect still writes the saved scope into the URL after mount; it decides nothing, and the query key does not change when it runs." with:

A programs list that failed or is paused is not waited for** (`listUnavailable`): the page computes `'all'`, as it does for an id it cannot find, and forgets nothing of what was saved; waiting would leave a saved block on its spinner for as long as the device is offline. **A saved block lets go once another block is active.** A block is saved with the block active when it was picked (`saveStatsScope` writes `activeBlock`, `NO_ACTIVE_BLOCK` when none was); `resolveStatsScope({ …, savedActiveBlock })` answers `{ scope: 'all', resolved: true, reset: true }` for a SAVED block when a block is active now that is neither that one nor the saved block itself — `reset` is only in the answer when it is true. A block named by the URL is kept, as are `'all'` and `'active'`, a block whose active block is still the active one, and every scope while no block is active. The selector offers the active block by its id, so without the marker a block picked as "the one I am training" stayed on screen after the next one was made active, and the athlete's new training never showed. A block saved before the marker existed is kept as it was — nothing says whether it was picked as the current block or as a past one — and is given the block active now. **The effect that writes the URL waits for the scope to be known** (`scopeResolved`, no scope in the URL): it calls `settleSavedScope` (forgets the saved scope on a reset, stamps an unmarked block) and writes the scope the page COMPUTES, never the saved one. Written at mount, as it was, the saved block reached the URL before the list could say it was replaced, and the URL wins over what was saved. The stats query does not wait for the effect, the query key does not change when it runs, and a reset sends no read: the replaced block is never computed (`StudentDashboard.requests.test.jsx`).

## docs/INVARIANTS.md — Stats persistence

In the bullet that starts "**Stats page selections are persisted in URL + localStorage.**", replace "mirrors `{ scope, exerciseId }` to localStorage too." with:

mirrors `{ scope, activeBlock, exerciseId }` to localStorage too (`activeBlock` — the block active when a block was picked; see "A Stats page computes ONE scope per visit" under "Stats").

and replace "an effect then writes the saved scope into the URL, which changes nothing that is computed." with:

once the scope is known, an effect writes it into the URL and settles the saved one (`settleSavedScope`) — a saved block is forgotten when another block has been made active since it was picked. Picking a scope writes both through `saveStatsScope`; picking "All" clears both.

## docs/INVARIANTS.md — Training is a QUEUE; the calendar is a consequence

In the bullet that starts "**A block is an ordered list of sessions, not a schedule.**", replace "which also returns `position`/`total` ("Session 7 of 24")," with:

which also returns `position`/`total` ("Session 7 of 24") — `position` is the place of the Next card (`upcoming[0]`) among the non-archived sessions, not `completed + 1`: with sessions 1, 2, 3 and 5 confirmed it is 4; `total` once nothing is left, 0 for an empty block —

## docs/INVARIANTS.md — Language of what is printed

In the paragraph that starts "Not yet through `format.js`:", replace "the locale tables of `student/StudentTraining`, `student/WeeklyVolumePanel`, `student/ExerciseProgressChart`, `hooks/useMessages`," with:

the locale tables of `student/StudentTraining`, `hooks/useMessages`,

## docs/ARCHITECTURE.md — SessionCalendar history overlay

Add after the paragraph that starts "`useStudentHistoricalSessions` fetches dated sessions from the student's NON-active programs":

A day before today with a session not confirmed is not drawn as upcoming. `SessionCalendar` gives it a ring of the muted ink (`--color-ink-400` as an inset `box-shadow`) under a fourth entry of the legend, `statsPanels.legendUnconfirmed` (UNCONFIRMED): it is either an open session whose recommended date has passed or a session trained and not confirmed, which `useStudentProgressStats` puts on the day it was trained with `completed: false`. Today and later days keep the accent dot of UPCOMING, since a session can still be done today. Nothing is called missed — the queue has no such state. Each dot carries its state in `data-dot` (`done`, `upcoming`, `unconfirmed`, `history`).

## CLAUDE.md — Feature → files map, row "Student stats (bucketed by REAL calendar weeks)"

Replace "`student/SessionCalendar`, `student/WeeklyVolumePanel` (`formatBucketRange` — rows are date ranges), `student/ExerciseProgressChart` (one point per SESSION on a date axis), `student/ProgramScopeSelector`, `lib/statsPrefs.js` (`resolveStatsScope` — which scope a page computes, decided during render from the URL and the saved scope; the stats query waits for it)," with:

`student/SessionCalendar` (a past day with a session not confirmed is UNCONFIRMED, not upcoming), `student/WeeklyVolumePanel` (`weeklyWindow` — four consecutive weeks, empty ones as zeros, to today for a scope that holds the active block; `formatBucketRange` — rows are date ranges; a week's sets drawn without volume), `student/ExerciseProgressChart` (one point per SESSION on a time axis — `pointPositions`; at most six dates under it — `thinTicks`), `student/ProgramScopeSelector`, `lib/statsPrefs.js` (`resolveStatsScope` — which scope a page computes, decided during render from the URL and the saved scope; the stats query waits for it; a saved block resets to `'all'` once another block is active — `saveStatsScope`, `settleSavedScope`, `activeBlock`; `scopeReachesToday`), strings in `lib/i18n/fragments/stats-panels.*` (namespace `statsPanels`),
