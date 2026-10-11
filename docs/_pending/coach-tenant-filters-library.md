# coach-tenant-filters-library — docs to fold (wave 1, items L2, L7)

Each block: target doc, section, then the text to fold in.

## docs/INVARIANTS.md — RLS / DB conventions

Add after the bullet that starts "**RLS is strict.**":

- **A coach-wide read names the coach; RLS is not the tenant filter.** RLS answers "what may this account read", and an account may read the rows it coaches *and* the rows in which it is the athlete: `students` has both SELECT policies, the athlete's own `programs` and `session_confirmations` follow, and `exercise_library` is readable by the athletes of its owner. For a coach who is also somebody's athlete — an account promoted to coach that keeps its `students` row, or a forged link — the two sets differ, and an unfiltered read puts that coach in their own roster with their own block, and another coach's exercises in their pickers. So [`useStudents`](../src/hooks/useStudents.js) filters `coach_id = user.id`; [`useCoachDashboardPrograms`](../src/hooks/useProgram.js) (both of its reads) and [`useAllConfirmations`](../src/hooks/useSessionConfirmation.js) embed `student:students!inner(coach_id)` and filter on it; [`useExerciseLibrary`](../src/hooks/useExerciseLibrary.js) filters `coach_id` when the role is coach. Two things to keep: **a filter on an embedded row only drops the parent row when every embed on its path is `!inner`** — remove one `!inner` and the request still answers 200, with the filter doing nothing, which is why the hook tests assert the select as well as the filter — and **a new read across all of a coach's athletes needs the same filter**. A read that is given one athlete's id is scoped by that id and does not. `useStudents` returns an empty list to an athlete, which is right: `MessageThread` calls it for both roles and reads it only as a coach.

## docs/INVARIANTS.md — RLS / DB conventions

Add after the bullet that starts "**Logged training can never be hard-deleted; \"delete\" is archive-first**":

- **A library exercise that is in use is not deleted, and the client decides that on a usage read made since the dialog opened.** Three foreign keys point at `exercise_library`: `exercise_slots.exercise_id`, `slot_deviations.substitute_exercise_id` and `goals.exercise_id`. `useExerciseUsage(exerciseId)` in [useExerciseLibrary.js](../src/hooks/useExerciseLibrary.js) counts all three on the server and returns `{ slots, goals, swaps }`; [ExerciseDeleteDialog.jsx](../src/components/coach/ExerciseDeleteDialog.jsx) offers Delete only when the three are zero, lists the counts otherwise, and says that it could not check when the read failed or waits for the network. The database refuses the same delete for slots and swaps, and for goals once `goals.exercise_id` is RESTRICT (migration 10); the dialog does not depend on that, and where the key still cascades it is what keeps the athletes' goals and their logged progress. Rules to keep when editing it:
  - **"Nothing uses it" is never taken from the cache.** `useExerciseUsage` sets `gcTime: 0` and `staleTime: 0`, and the dialog's body acts only on an answer read since it mounted: `usage.isFetchedAfterMount` **and** `usage.dataUpdatedAt >= openedAt`. Both are needed — a failed fetch also sets `isFetchedAfterMount`, and a timestamp alone cannot tell a read made in the millisecond before the open from one made since. `ExerciseDeleteDialog.test.jsx` holds one case for each.
  - **A count that did not come back is an error, not a zero.** "Unknown" must not read as "unused".
  - **The successful read is tested first and nothing un-reads it**: a refetch on window focus that fails later leaves the counts, and the Delete button, as they were.
  - **The dialog stays mounted and its body is mounted by each open.** Closing goes through `<dialog>.close()`, which returns focus to the row's button; the body (`UsageCheck`) takes `openedAt` when it mounts, so it must not be lifted into the part that stays.
  - **While the usage is being read, Delete is rendered and disabled**, so the button under a finger does not change when the answer arrives.
  - **The counts are what the signed-in coach can read.** A reference they cannot see (legacy sessions of an athlete who moved to another coach) still stops the delete in the database, and `errors.inUse` says so. The slot count includes trashed programs and archived sessions, and the dialog's text says that.

  A test that mocks `useExerciseUsage` for the library page has to give the query's `isFetchedAfterMount` and `dataUpdatedAt`, or the dialog stays on "Checking…" (`usageQuery()` in `ExerciseLibrary.test.jsx`).

## docs/INVARIANTS.md — Offline-safe student writes

Add after the bullet that starts "**Offline-safe student writes are wired through one allow-list.**":

- **`['exercise-library']` is one key for two requests, and has to stay one key.** [`useExerciseLibrary`](../src/hooks/useExerciseLibrary.js) is shared: the coach's request carries `coach_id = <their id>`, the athlete's carries no filter (theirs would match nothing, and empty the swap picker of `SessionView` and the picker of `StudentProgramAuthor`). The key is the same for both because `exercise-library` is a persisted root and the entry an athlete's device already holds is what names their exercises offline: a key per user or per role would leave that entry unread. The price is that the cache can hold a list fetched without the filter — restored from a device that ran an earlier client, or read before the profile, and with it the role, had loaded (`RoleGate` renders its page while the role is unknown) — and nothing refetches it when the role arrives, since the key does not change. The hook's `select` therefore applies the coach rule to whatever the cache holds. Do not move that rule into the query function alone, and read the library through the hook: `queryClient.getQueryData(['exercise-library'])` returns the list before `select`.

## docs/ARCHITECTURE.md — React Query — who owns which key

Replace the `useExerciseLibrary` row of the table with:

| [useExerciseLibrary](../src/hooks/useExerciseLibrary.js) | `['exercise-library']` (one persisted key for both roles: a coach's request filters on `coach_id` and `select` hides any foreign row the cache holds; an athlete's request is unfiltered), `['exercise-usage', exerciseId]` (the counts behind the delete dialog; `gcTime: 0`, never served from the cache) | `['exercise-library']`; `useDeleteExercise` also drops `['goals']`, since a goal row embeds its exercise |

## docs/ARCHITECTURE.md — React Query — who owns which key

Replace the `useStudents` row of the table with:

| [useStudents](../src/hooks/useStudents.js) | `['students']` (the athletes the signed-in user coaches: `coach_id = user.id`, not every `students` row RLS lets them read) | n/a |

## CLAUDE.md — Feature → files map, row "Coach exercise library"

Replace the row's file list with:

`coach/ExerciseLibrary`, `coach/ExerciseDeleteDialog` (reads where the exercise is used — slots, goals, athlete swaps — and offers Delete only when nothing uses it), `hooks/useExerciseLibrary` (`useExerciseLibrary` is shared with the athlete: one persisted key, the `coach_id` filter only for a coach; `useExerciseUsage`; `isActiveExercise` for pickers)

## CLAUDE.md — Feature → files map, row "Coach Athletes roster (attention-first list; merged Dashboard + Students into one tab)"

Add to the end of the row:

The three coach-wide reads behind it (`useStudents`, `useCoachDashboardPrograms`, `useAllConfirmations`) each filter on the coach explicitly — RLS also returns the rows in which the account is the athlete

## README.md — Roles & Flows

Replace "5. **Library tab** — exercise CRUD with search + type filter." with:

5. **Library tab** — exercise CRUD with search + type filter. Deleting an exercise first shows where it is used (program slots, goals, athlete swaps) and is offered only when nothing uses it.
