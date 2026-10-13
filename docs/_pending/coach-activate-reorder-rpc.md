# coach-activate-reorder-rpc — docs to fold (wave 2, items P16, P51)

Each block: target doc, section, then the text to fold in.

## docs/INVARIANTS.md — RLS / DB conventions

Replace the bold lead and the paragraph of the bullet that starts "**Setting a block active, reordering the sessions of a phase and reordering the phases of a block each have a function that does it in one statement — and the hooks' own requests do not.**", up to and including "The contract:" (its sub-bullets `activate_program` and `reorder_sessions` / `reorder_weeks` stay as they are), with:

- **Setting a block active, reordering the sessions of a phase and reordering the phases of a block are each ONE call of a function that does it in one statement.** Migration `2026_10_13_11_activate_reorder_rpcs.sql` (review P16 and P51) holds three `SECURITY INVOKER` functions, executable by a signed-in user and written on the model of `move_session`: they give the caller no right the policies of `programs`, `weeks` and `sessions` do not. `useSetActiveProgram` is one `activate_program` call, `useReorderSessions` one `reorder_sessions` call, `useReorderWeeks` one `reorder_weeks` call. `useCreateProgram` inserts the program INACTIVE and, with `setActive`, calls `activate_program` afterwards: the block the athlete trains is switched off by the statement that switches the new one on, and by no request before it. A hook that goes back to several requests brings the hole back — each request is a transaction of its own, so one that is lost leaves the athlete without an active block, and every set they log is then refused (`program_active_for_session()`), or leaves sessions numbered 100000 and more in the athlete's queue. The contract:

## docs/INVARIANTS.md — RLS / DB conventions

Replace the three sub-bullets of that same bullet that start "**The refusals are `P0001` with that fixed word as the message**", "**Two calls for the same athlete, phase or block wait for each other**" and "**`useReorderPrograms` has no function**" with:

  - **The refusals are `P0001` with that fixed word as the message** (HTTP 400), except `not authorized`, which is `42501` and reaches the toast as `errors.notAllowed`; the others fall to `errors.generic` in `mutationErrorKey`. A hook sends a refused request once and never again by itself: `onError` puts the order on screen back — unless a later drag of the same scope waits, whose order it would remove — and the lists are read again in `onSettled` — after a failure too, because what the functions refuse is something the page still shows (a list from before a session was added in another tab, a program that went to the trash). `useCreateProgram` invalidates in `onSettled` for one more reason: a create whose activation is refused has still created the program, inactive.
  - **Two calls for the same athlete, phase or block wait for each other** (the parent is locked first), so the last one sent is the one that stays — the database needs no scope from the client to stay consistent. The client has one all the same, for the list on screen: "The order of a block is written one drag at a time" under "Training is a QUEUE".
  - **`useReorderPrograms` has no function**: `programs.sort_order` has no unique key, so no order of arrival is refused, and the hook keeps its one request per program in two passes (park at 100000 + n, then place). Two drags could still cross — the requests of the second landing among those of the first — so `useReorderPrograms(studentRowId)` runs under a mutation scope per athlete, like the reorders of a block. `ProgramSwitcher`, which calls it, is mounted once per athlete for the reason given under "The order of a block is written one drag at a time": the hook must not change scope while a reorder waits.

## docs/INVARIANTS.md — Training is a QUEUE; the calendar is a consequence

Replace, in the bullet that starts "**Sessions list by POSITION (`sessions.sort_order`), never by weekday.**", its last sentence "Like `useReorderWeeks` it must renumber in TWO passes (park at 100000+, then place): `sessions_week_sort_order_unique` is UNIQUE and NOT deferrable, and the payload must include ARCHIVED rows because the constraint spans them." with:

It is one call of `reorder_sessions`, which parks and places every row in a single statement: `sessions_week_sort_order_unique` is UNIQUE and NOT deferrable, so the two steps cannot be two requests. The list must include ARCHIVED rows — the constraint spans them, and the function refuses a list that is not every session of the phase (`reorder_ids_mismatch`).

## docs/INVARIANTS.md — Training is a QUEUE; the calendar is a consequence

Add after the bullet that starts "**`move_session` still parks at `100000 + n`; `reorder_sessions` does not.**":

- **The order of a block is written one drag at a time, and only the last drag of a run reads the server again.** `useReorderSessions`, `useMoveSession` and `useReorderWeeks` ([hooks/useWeek.js](../src/hooks/useWeek.js)) each take the block's id and run under ONE TanStack mutation scope per block (`block-order-<program id>`, from `mutationScope` in [lib/mutationScope.js](../src/lib/mutationScope.js)); `ProgramSheet` hands `program.id` to all three, because its single `handleDragEnd` can end in any of them. Mutations of one scope are sent one after the other, in the order they were made — but each still runs its `onMutate` at once, so the order of a second drag is on screen while the first is on its way, and every drag sends the FULL list of ids as the sheet shows it. All three draw their order in `onMutate`, the move included: a session still shown in the phase it left would have the next drag send lists from before the move — a reorder the database refuses (`reorder_ids_mismatch`), or a second move renumbered from lists `move_session` does not check. Four things follow. (1) **A hook never changes scope while one of its writes waits: `ProgramSheet` is mounted once per block and `ProgramSwitcher` once per athlete** — `key={selectedProgram.id}` and `key={studentId}` in [StudentProgrammingSection.jsx](../src/components/coach/StudentProgrammingSection.jsx). `scope` is an option of `useMutation`, and TanStack Query hands the options of a hook that renders again to the mutation that hook still has pending (`MutationObserver.setOptions`): rendered with another id, the hook re-points its waiting write at a queue it was never put in, where it is not given its turn — the write is not sent until the next focus or reconnection, and not at all after a reload. A hook that unmounts leaves its writes in the cache as they were made, and they go out in their turn. So the scope is per block, not per phase; a component that calls one of these hooks is keyed on the id it hands them; a hook called without an id has no scope and sends at once; and a callback that has to outlive the sheet goes in the hook's options, never in `mutate(vars, { … })`, whose callbacks are dropped with the component. (2) `onSettled` asks `laterWriteQueued(qc, scope)` before it invalidates. A refetch started by the first of two drags answers with the order BEFORE the second, puts that back on screen — the row just dropped jumps back — and a third drag made at that moment sends a list that undoes the second. (3) `onError` asks the same before it puts its snapshot back (`restoreBlockOrder`): a snapshot is the WHOLE block from before its drag, so it would take the order of a later drag off the screen. The refetch of the last drag settles what a failed one left there. (4) The three hooks settle through one `refreshBlockOrder` (`['program']`, `['week']`, `['student-program-details']`, the coach dashboard), so whichever is last makes up for the refetches the others left out: a mutation that joins the scope must settle through it too. `laterWriteQueued` counts the mutation that asks as pending, which is what it is inside `onError` and `onSettled` — called from `onSuccess` of a `mutate()` call, after the mutation is done, the same test is wrong by one.

## docs/ARCHITECTURE.md — Program periodization (multiple blocks per student)

Replace the bullet that starts "`useSetActiveProgram` deactivates the current active program first" with:

- `useSetActiveProgram` is one call of `activate_program`, which switches the athlete's other programs off and this one on in one statement (the partial unique index allows one active program per athlete). `useCreateProgram` always inserts the program inactive and, with `setActive: true`, calls the same function afterwards — never the current block off first. `useEnsureProgram` explicitly inserts `is_active: true` since the column default is `false`.

## docs/ARCHITECTURE.md — Two-pass reorder writes

Replace the heading "### Two-pass reorder writes" and the two paragraphs under it that start "Week reordering (`useReorderWeeks`) does an **optimistic two-pass write**" and "The database has the same operation as one statement since migration" with (the paragraph that starts "`ProgramSheet` is dnd-kit sortable at two levels" stays under the new heading):

````markdown
### Reorder writes

Reordering the sessions of a phase (`useReorderSessions`) and the phases of a block (`useReorderWeeks`) is **optimistic, and one request**. `onMutate` rewrites every cached `['program', id]` that holds the phase or the block, numbered the way the function leaves them (`sort_order` 0 to n-1, `week_number` 1 to n); `mutationFn` is one `supabase.rpc()` call of `reorder_sessions(p_week_id, p_ids)` or `reorder_weeks(p_program_id, p_ids)`; `onError` restores the snapshot. `useMoveSession` — a session dragged across a divider, one `move_session` call — draws the same way: the session leaves its phase, and both phases are numbered from the two lists the call sends. The functions (migration `2026_10_13_11_activate_reorder_rpcs.sql`) lock the parent, check that the list is exactly its children (archived sessions included), park every row above every number the parent holds and place them — all or nothing. `(week_id, sort_order)` and `(program_id, week_number)` are unique and not deferrable, which is why parking and placing cannot be two requests. `activate_program(p_program_id)` does the same for the two writes of "Set active". All three are `SECURITY INVOKER` and ride the coach's policies, like `move_session`.

`useReorderPrograms` still sends one request per program, in two passes (park at `sort_order = 100000 + idx`, then `idx`): `programs.sort_order` has no unique key, and the database has no function for it.

Two drags never cross on their way to the database. `useReorderSessions`, `useMoveSession` and `useReorderWeeks` take the block's id and share one mutation scope per block; `useReorderPrograms` takes the athlete's `students` row and has one per athlete (`mutationScope` in `src/lib/mutationScope.js`). TanStack Query sends the mutations of a scope one after the other, in the order they were made, while each still draws its optimistic order at once. Their `onSettled` invalidates only when no later write of the scope is waiting (`laterWriteQueued`), so a run of drags ends in one refetch, made by the last. Their `onError` puts its snapshot back under the same condition: the snapshot is the list from before that drag, without the order a later one has drawn.

A hook keeps its scope for as long as it is mounted. `StudentProgrammingSection` mounts `ProgramSheet` with `key={selectedProgram.id}` and `ProgramSwitcher` with `key={studentId}`: rendered again with another id, a hook would hand its new scope to the write it still has pending (`MutationObserver.setOptions`), and TanStack Query would look for that write's turn in a queue it is not in. The hooks of the sheet the coach has left unmount instead, and their writes are sent as they were made.
````

## docs/ARCHITECTURE.md — Two-pass reorder writes

Replace, at the end of the paragraph that starts "`ProgramSheet` is dnd-kit sortable at two levels", the sentence "Tests that render `ProgramSheet` (directly or via `CoachHome`) must mock `useReorderWeeks`, `useReorderSessions` and `useMoveSession` from `hooks/useWeek`." with:

Tests that render `ProgramSheet` (directly or via `CoachHome`) must mock `useReorderWeeks`, `useReorderSessions` and `useMoveSession` from `hooks/useWeek`. A drag cannot be made in jsdom — dnd-kit measures a layout that is not there — so `ProgramSheet.test.jsx` wraps the real `DndContext` in a `vi.mock('@dnd-kit/core')` that keeps the sheet's `onDragEnd`, and calls it with `{ active, over }` the way a drop does. `StudentProgrammingSection.test.jsx` does the same around the real order hooks and holds the two `key`s: a write that waits when the coach picks another block, or when the page moves to another athlete, is still sent.

## CLAUDE.md — Repo map

Add to the `lib/` lines of the tree, after the `loggedSets.js` entry:

```
                 mutationScope.js (mutationScope / laterWriteQueued — the scope the coach's reorders
                 wait in, and "is a later write of it still waiting")
```

## CLAUDE.md — Feature → files map, row "Coach programs CRUD"

Replace the end of the row, from "In the database (migration `2026_10_13_11_activate_reorder_rpcs.sql`): `activate_program(p_program_id)` switches" to "not called by `useSetActiveProgram` yet", with:

`useSetActiveProgram` is one call of `activate_program(p_program_id)` (migration `2026_10_13_11_activate_reorder_rpcs.sql`, `SECURITY INVOKER`), which switches the athlete's other programs off and this one on in one statement and refuses a draft and a program in the trash; `useCreateProgram` inserts the program inactive and, with `setActive`, activates it through the same function. `useReorderPrograms(studentRowId)` keeps one request per program and runs under a mutation scope per athlete (`lib/mutationScope`); the switcher is mounted once per athlete (`key` in `coach/StudentProgrammingSection`), because the hook must keep one scope while a reorder waits

## CLAUDE.md — Feature → files map, row "Coach phase reordering"

Replace the row's file list with:

`coach/PhaseDivider` (`SortablePhaseDivider`), `coach/ProgramSheet` ("Reorder phases" in a divider ⋯ menu → dnd-kit vertical sort, sessions hidden), `hooks/useWeek` (`useReorderWeeks(blockId)` — one `reorder_weeks` call with every phase of the block, in the block's mutation scope), `lib/mutationScope`

## CLAUDE.md — Feature → files map, row "Coach Program Sheet (the Programming tab — the whole block as ONE list)"

Replace the sentence of the row that starts "In the database (migration `2026_10_13_11_activate_reorder_rpcs.sql`): `reorder_sessions(p_week_id, p_ids)` and `reorder_weeks(p_program_id, p_ids)` renumber" and ends "not called by `useReorderSessions` / `useReorderWeeks` yet." with:

`useReorderSessions` and `useReorderWeeks` are each one call of `reorder_sessions(p_week_id, p_ids)` / `reorder_weeks(p_program_id, p_ids)` (migration `2026_10_13_11_activate_reorder_rpcs.sql`, `SECURITY INVOKER`), which renumber a whole phase or block in one statement from the full list of its children, archived sessions included. With `useMoveSession` they take the block's id and share one mutation scope per block (`lib/mutationScope`: `mutationScope`, `laterWriteQueued`), so two drags reach the database in the order they were made and only the last one of a run refetches; all three draw their order at once. The sheet is mounted once per block (`key={selectedProgram.id}` in `coach/StudentProgrammingSection`, tests `coach/StudentProgrammingSection.test.jsx`): a hook that changed block would lose the write it has waiting.
