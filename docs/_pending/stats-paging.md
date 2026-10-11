# stats-paging — docs to fold (wave 1, items P9, L1)

Each block: target doc, section, then the text to fold in.

## docs/INVARIANTS.md — React / hooks discipline

Replace, in the bullet that starts "**Counting rows means `{ count: 'exact', head: true }`, never `data.length`.**", the sentence "If the rows themselves are needed, page with `.range()` until a short read (see `useStudentLifetimeStats`)." with:

If the rows themselves are needed, read them with `fetchAllRows` (next bullet).

Add after that bullet:

- **A read whose result grows with an athlete's history goes through `fetchAllRows`, never through `.limit(<a big number>)`.** PostgREST answers one request with at most `db-max-rows` rows (1000 in production) and reports nothing when it cuts; a client limit can only lower that ceiling. [`fetchAllRows(buildQuery, { pageSize, column, ascending })`](../src/lib/supabasePaging.js) asks again until a page comes back short. It pages by KEYSET — `order=<column>.asc`, then `<column>=gt.<last key>` — because an offset shifts when a row is inserted between two requests and a value does not; rows are de-duplicated on the key. Four rules follow. `buildQuery` returns a NEW query on every call, with its filters and without `.order()`, `.limit()` or `.range()`. The select must include the key column (`id` by default) — a row without it throws on the first page, not on the day a second page is needed. The key must be unique among the rows the query matches (`id`; `logged_on` within one athlete's `bodyweight_logs`; `session_id` in `session_confirmations`). And the result comes back in KEY order, which for a uuid is no order: a caller that needs dates sorts the rows itself (`useStudentProgressStats` sorts confirmations newest first, `readDoneSetHistory` sorts sets oldest first). A full page is never taken for the end, and a full page that brings nothing new throws instead of stopping. Today's callers: `useStudentProgressStats` (done sets, swaps, confirmations), `readDoneSetHistory` in `lib/doneSetHistory.js` (the done sets and swaps that `useStudentRecords` and `useLastPerformance` derive from), `fetchBodyweightSeries` in `useBodyweight.js` (the bodyweight series behind `useStudentRecords`), `useStudentLifetimeStats` (volume rows), `useStudentHistoricalSessions` (confirmations). `src/lib/supabasePaging.test.js` reads every source file and fails on a `.limit(n)` with `n` above `PAGE_SIZE`; the one read still listed there as waiting is the conversation list in `useMessages.js`.
- **`PAGE_SIZE` (1000) must not exceed the project's API "Max rows" setting.** The loop ends on a page shorter than the page size, so a server that caps lower makes every page look like the last one and the truncation is back, silently, for every caller. If Max rows is ever lowered in the dashboard, lower `PAGE_SIZE` in `src/lib/supabasePaging.js` in the same change. Raising Max rows needs nothing.
- **A hook test that reads a growing table mocks Supabase with `fakePostgrest`, not with a resolved value.** A `mockResolvedValue` hands the whole fixture back whatever the request says, which is how three hooks passed their tests while cutting at 1000 rows in production. [`fakePostgrest(tables)`](../src/test/fakePostgrest.js) serves tables by name, sorts on `.order()`, applies `.gt()` / `.lt()`, and never returns more than `maxRows` (1000) rows whatever `.limit()` it is sent; every other filter is recorded on `db.requests`, not applied, so the fixture is what the WHERE clause lets through and the test asserts the filters. A fixture of 1001 rows is then enough to prove a read pages.

## docs/INVARIANTS.md — Stats

Replace, in the bullet that starts "**Stats are performance-aware: charts show PERFORMED work, not just the prescription**", the words "builds a `perfBySlot` index from the flat `set_logs` fetch (which now selects `done`/`skipped`/`actual_reps`/`actual_weight_kg` alongside `target_*`, filtered through the program join)" with:

builds a `perfBySlot` index from the flat `set_logs` read — DONE rows only (`done = true`), filtered through the program join and read to its end with `fetchAllRows`

Add after that bullet:

- **The flat `set_logs` list in `useStudentProgressStats` holds DONE sets and nothing else.** Every figure derived from it — `totalSetsDone`, `avgRpe`, `sets_done`, performed volume and tonnage — counts done sets only, so the pending, failed and skipped rows are not downloaded (they were most of the rows and none of the result). Anything that needs the prescribed sets reads them from the program tree (`exercise_slots.sets`, the embedded `set_logs` targets), which is complete. A new figure about failed or skipped sets needs its own read; do not drop the `done` filter to get it — that puts the athlete's whole prescription back into a read that is paged.
- **Of two sets that tie for a best, the EARLIER one holds the record.** `buildRecords` keeps the first set that reaches a value, so the sets must reach it oldest first: `readDoneSetHistory` sorts the done sets by `logged_at` (then `id`), and `useStudentRecords` reduces them in the order it receives them. Pages arrive in id order, which is arbitrary; without the sort a record matched last week could take the date of the record and light the "New PR" badge for a lift that set no record.
- **"Last time" does not depend on the order its rows arrive in.** `useLastPerformance` picks its exercises out of the athlete's whole history (every done set, all exercises — a prior swap sits under another `exercise_id`); `buildLastPerformance` picks the latest prior session per exercise and orders its sets itself, whatever order the list is in. The old newest-first `.order('logged_at')` existed only so that the cut at 1000 rows kept the recent part; there is no cut any more.

## docs/ARCHITECTURE.md — Testing

Add after the paragraph that starts "`src/test/hardcodedScan.js` is test support":

`src/test/fakePostgrest.js` is the stand-in for `supabase.from()` in hook tests that read a table which grows: `fakePostgrest({ table: rows | { rows, count, error } | (request) => … })` returns `{ from, requests, requestsTo(table) }`, and a test wires it with `supabase.from.mockImplementation(db.from)`. It keeps the one server behaviour a resolved mock hides — a response is cut at `maxRows` (1000) whatever `.limit()` asked for — and the three things paging depends on: `.order()` sorts, `.gt()` / `.lt()` filter, `.limit()` cuts. Other filters are recorded, not applied; `select(…, { head: true })` answers with a count and no rows; `.maybeSingle()` gives the first row or null, `.single()` the row when there is exactly one and a `PGRST116` error otherwise. `src/test/fakePostgrest.test.js` holds that contract. Tables are served by name, so a test does not depend on the order in which a hook sends its reads.

## CLAUDE.md — Repo map

Replace the line that starts "  lib/           supabase.js  queryClient.js" with:

```
  lib/           supabase.js  queryClient.js  volume.js  day.js  preload.js
                 supabasePaging.js (fetchAllRows — every row of a read, 1000 at a time)
```

Replace the line that starts "  test/          setup.js  utils.jsx" with:

```
  test/          setup.js  utils.jsx (createTestQueryClient)
                 fakePostgrest.js (supabase.from() double that cuts at 1000 rows)
```

## CLAUDE.md — Feature → files map

Add a row after the row "Performance-aware stats":

| Reading every row (PostgREST answers with 1000 rows at most, silently) | `lib/supabasePaging` (`fetchAllRows` — keyset on a unique column, de-duplicated; `PAGE_SIZE`), used by `hooks/useStudentProgressStats` (done sets, swaps, confirmations — the set-log read is `done = true` only), `lib/doneSetHistory` (the done sets and swaps behind `hooks/useStudentRecords` and `hooks/useLastPerformance`), `hooks/useStudentLifetimeStats`, `hooks/useStudentHistoricalSessions`, `hooks/useBodyweight` (`fetchBodyweightSeries` — the whole series, newest first). Tests: `test/fakePostgrest` (a `supabase.from()` that cuts at 1000 rows like the server), `lib/supabasePaging.test.js` (also fails on any `.limit(n)` above a page in `src/`) |

## README.md — Testing Conventions

Add after the bullet that starts "Mocks: child hooks are stubbed":

- A hook that reads a table which grows with history is tested against `src/test/fakePostgrest.js`: a `supabase.from()` double that serves tables by name and, like PostgREST, never returns more than 1000 rows per request. With a plain resolved mock a read that stops at the first page passes.

## docs/ENVIRONMENT.md — Supabase Auth settings (production)

Add a new section after this one:

````markdown
## Supabase API settings (production)

| Setting | In the dashboard | Value |
|---|---|---|
| Max rows (`db-max-rows`) | Project Settings → Data API → Settings → Max rows | `1000` — the default. It may be raised, never lowered below `PAGE_SIZE` in `src/lib/supabasePaging.js` |

The app reads long lists a page of 1000 at a time and takes a page shorter than that for the end. With a lower Max rows every page is short, and stats, records and "Last time" are silently cut again.
````
