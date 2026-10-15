# coach-library-archive — docs to fold (wave 3, items none)

Each block: target doc, section, then the text to fold in.

## docs/INVARIANTS.md — RLS / DB conventions

Replace the bullet that starts "**`exercise_library.archived_at` takes an exercise out of the pickers, and the database refuses nothing about an archived exercise.**" with:

- **`exercise_library.archived_at` takes an exercise out of the pickers, and the database refuses nothing about an archived exercise.** The column exists since migration `2026_10_13_10_goals_fk_coach_links.sql` because an exercise that was ever used can no longer be deleted. It is written by the owner of the row through `Coaches manage own library` — in the app by `useArchiveExercise` (`{ id, archived }`: now, or `null` again) from the library page — and read by their athletes like any other column: an archived exercise is still the name of what they trained. A slot that holds one stays, a new slot can take one, a goal on one is still logged against, and a function that copies sessions copies their slots whatever `archived_at` says — "not offered for new work" is the client's rule ([`isActiveExercise`](../src/hooks/useExerciseLibrary.js)). Do not add a constraint or a trigger that refuses one: every copy of a block that uses it would fail. On the client: `useExerciseLibrary` returns archived rows to both roles, and must keep doing so — `SessionView`, `SessionReview` and the history look names up in it; the PICKERS filter with `isActiveExercise` (`coach/SessionEditor` "Select exercise…", `coach/StudentGoalsSection`, and on the athlete's side `student/SlotDeviationBar` and `student/StudentProgramAuthor`); a slot and a goal embed their own exercise (`exercise:exercise_library(*)`), so one that holds an archived exercise still shows it. [ExerciseLibrary.jsx](../src/components/coach/ExerciseLibrary.jsx) lists the exercises on offer with edit, archive and delete, and the archived ones in an "Archived · N" drawer under them — closed until opened, every archived exercise whatever the search and the type pills say — with restore and delete. A test that mocks `../hooks/useExerciseLibrary` for a component that filters spreads `await vi.importActual(…)` into its factory, or `isActiveExercise` is undefined there.

## docs/INVARIANTS.md — RLS / DB conventions

Add after the sub-bullet that starts "**The dialog stays mounted and its body is mounted by each open.**" (under the bullet "A library exercise that is in use is not deleted"):

  - **An exercise in use is offered "Archive instead", never a Delete.** The dialog shows it when the page passes `onArchive(id)` and the exercise is not archived already (`isActiveExercise`); it calls `onArchive` and closes. It is drawn first in the button row, in the place the disabled Delete held while the usage was read: a tap aimed at that button as the answer lands archives — which the drawer's restore undoes — and never deletes. Do not put it where Cancel was. Tests: `ExerciseDeleteDialog.test.jsx` ("archiving instead").

## docs/ARCHITECTURE.md — Data model

Replace the bullet that starts "- **`exercise_library`** — each coach owns a library;" with:

- **`exercise_library`** — each coach owns a library; slots, swaps and goals reference it by id, and an exercise that any of them names cannot be deleted (`RESTRICT`). The coach archives it instead (`archived_at`, written by `useArchiveExercise` from the library page, which keeps archived exercises in an "Archived · N" drawer with a restore): the pickers leave it out with `isActiveExercise`, and the rows that name it keep reading it.

## docs/ARCHITECTURE.md — React Query — who owns which key

In the row of [useExerciseLibrary](../src/hooks/useExerciseLibrary.js), replace the last cell ("`['exercise-library']`; `useDeleteExercise` also drops `['goals']`, since a goal row embeds its exercise") with:

`['exercise-library']`; `useDeleteExercise` also drops `['goals']`, since a goal row embeds its exercise; `useArchiveExercise` first writes the row the server sent back into `['exercise-library']`, so the exercise changes lists as soon as the write is through, then invalidates it

## docs/ARCHITECTURE.md — Session & UI behavior patterns

Replace the bullet that starts "- **Exercise Library filtering is client-side.**" with:

- **Exercise Library filtering is client-side.** Search and type-filter state live in `ExerciseLibrary` and are applied with `useMemo` over the already-fetched list — no extra Supabase queries. They apply to the exercises on offer (`isActiveExercise`); the "Archived · N" drawer counts and lists every archived exercise. Search bar + pills are hidden when no exercise is on offer, to keep the add-first flow clean; a library whose every exercise is archived says so (`coachLibraryArchive.allArchived`) above the drawer.

## docs/DESIGN_SYSTEM.md — Exercise type badge — `TypeBadge`

In the sentence that starts "Not yet on it — still the hand-written ternary:", delete `coach/ExerciseLibrary` only (the others are not this package's).

## CLAUDE.md — Feature → files map, row "Coach exercise library"

Replace the row's file list with:

`coach/ExerciseLibrary` (the exercises on offer with edit / archive / delete, their type as `ui/TypeBadge`; an "Archived · N" drawer under them, closed until opened, with restore / delete), `coach/ExerciseDeleteDialog` (reads where the exercise is used — slots, goals, athlete swaps — and offers Delete only when nothing uses it; "Archive instead" for an exercise in use that is not archived), `hooks/useExerciseLibrary` (`useExerciseLibrary` is shared with the athlete: one persisted key, the `coach_id` filter only for a coach, archived rows included; `useExerciseUsage`; `useArchiveExercise` — `{ id, archived }`; `isActiveExercise` for pickers: `coach/SessionEditor`, `coach/StudentGoalsSection`), fragment `coachLibraryArchive`; `exercise_library.archived_at` (migration `2026_10_13_10_goals_fk_coach_links.sql`) is the column an exercise in use is archived with — the database refuses nothing about an archived exercise
