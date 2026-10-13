# coach-duplicate-rpc — docs to fold (wave 2, items P52)

Each block: target doc, section, then the text to fold in.

## docs/INVARIANTS.md — RLS / DB conventions

Replace the bold lead and the paragraph of the bullet that starts "**Duplicating a session, a phase or a block, and copying sessions to another phase, each have a function that makes the whole copy or none — and the hooks' own requests do not.**", up to and including "The contract:" (its sub-bullets `duplicate_session`, `copy_sessions`, `duplicate_week` and `duplicate_program` stay as they are), with:

- **Duplicating a session, a phase or a block, and copying sessions to another phase, are each ONE call of a function that makes the whole copy or none.** Migration `2026_10_13_12_copy_rpcs.sql` (review P52) holds four `SECURITY INVOKER` functions, executable by a signed-in user: what is copied is what the caller can read, where it goes is where the caller can write, so a coach copies for their own athletes and from one of them to another, and nobody else does. `useDuplicateSession` is one `duplicate_session` call, `useCopySessions` one `copy_sessions` call, `useDuplicateWeek` one `duplicate_week` call and `useDuplicateProgram` one `duplicate_program` call ([useDuplicate.js](../src/hooks/useDuplicate.js)); the file reads and writes no table itself. A hook that goes back to its own requests brings the hole back — one request per row or per table (thirty to forty for a block), each a transaction of its own, so a request that is lost leaves a session with no exercise, or exercises with no set, in the block the athlete trains — and with it the `.in()` over every exercise id of a phase and the read that is cut at 1000 sets. The contract:

## docs/INVARIANTS.md — RLS / DB conventions

Replace the two sub-bullets of that same bullet that start "**The answer is an object, and the id is in it under a fixed key.**" and "**The refusals are `P0001` with a fixed word as the message**" with:

  - **The answer is an object, and the id is in it under a fixed key.** Keys are added, never renamed. The arguments that have a default may be left out of the call: the hooks send no suffix, so a copy is named with the function's own `' (copy)'`. A hook returns the answer as it is — what a caller reads the new id from (`session_id`, `session_ids`, `week_id`). `useDuplicateProgram` adds one key, `id` (the value of `program_id`): "Duplicate program" selects the copy by it, and the hook seeds `['programs', <student_id of the answer>]` with a row of `useProgramsForStudent` — `approved`, inactive, not submitted, `weeks: []` — in its own `onSuccess`, which runs before the caller's, because `CoachHome` drops a `?program` that is not in the list.
  - **The refusals are `P0001` with a fixed word as the message** (HTTP 400): `session_not_found`, `week_not_found`, `program_not_found`, `student_not_found` (nothing with this id that the caller can read — somebody else's athlete and a wrong id are the same answer) and `copy_source_changed` (what was to be copied was deleted or moved while the call waited). `not authorized` is `42501` (the caller reads the place and may not write it — the athlete) and reaches the toast as `errors.notAllowed`; the others fall to `errors.generic` in `mutationErrorKey`. Nothing was written in any of those cases, so a hook sends a refused copy once, never again by itself, and has nothing to clean up. It reads the caches again in `onSettled` — after a refusal too, because what the functions refuse is something the page still shows (a session deleted in another tab, a block that went to the trash): `['program']`, `['week']`, `['session']`, `['set-logs']`, `['student-program-details']` and the coach dashboard for the four, plus `['programs']` — the lists of every athlete, whose rows count their phases — for a new phase and a new block.

## docs/INVARIANTS.md — RLS / DB conventions

Replace, in the bullet that starts "**A copy is the prescription, and nothing of what was trained.**", its last sentence, from "This is what `useDuplicate.js` copies, column for column" to "whatever the numbers of the source were.", with:

This is what the app copied with its own requests until wave 2, column for column — `supabase/tests/copy-rpcs.test.js` replays those requests and holds the two against each other — with two differences the coach sees: the copy of a session stands RIGHT AFTER its source instead of at the end of the phase, and a duplicated phase or block has its sessions numbered from 0 and its phases from 1 whatever the numbers of the source were.

## docs/INVARIANTS.md — RLS / DB conventions

Replace, in the bullet that starts "**`slots_left_out` is not zero when exercises could not be copied, and the app must say so.**", its last sentence "A hook that calls one of the four shows a message when it is not." with:

The four hooks of [useDuplicate.js](../src/hooks/useDuplicate.js) say so through one `useLeftOutNotice`: an `info` toast with the count (`coachDuplicateRpc.leftOut`), pushed from the hook's own `onSuccess` so that it is shown whatever became of the component that asked for the copy. A fifth caller of one of the functions goes through it too — the copy looks complete and is not.

## docs/INVARIANTS.md — RLS / DB conventions

Replace, in the bullet that starts "**No mutation failure is silent** (2026_07_13).", the sentence "A mutation that renders its OWN inline error opts out with `meta: { skipErrorToast: true }` (the message composers, `useHardDeleteProgram`)." with:

A mutation that renders its OWN inline error opts out with `meta: { skipErrorToast: true }` (the message composers, `useHardDeleteProgram`) — and so does one whose message holds something the cache cannot know: `useArchiveSessions` pushes its own toast from `onError`, "N of M archived" when some rows landed and the line of `mutationErrorKey` when none did. A hook that opts out says something for EVERY error, or the failure is silent again.

## docs/INVARIANTS.md — Coach Athletes-roster layout

Replace the bullet that starts "**Bulk session writes are SEQUENTIAL, and settle their caches on `onSettled`.**" with:

- **Archiving a selection is SEQUENTIAL and says how far it got; copying one is a single call.** `useArchiveSessions` ([useWeek.js](../src/hooks/useWeek.js)) walks a hand-picked list of ids one request at a time and stops at the first that fails — also one that throws instead of answering. The error it throws carries `error.partial`, the number of rows written before it, and the hook tells the coach ONCE, itself (`meta: { skipErrorToast: true }`): `coachDuplicateRpc.archivePartial` / `restorePartial` ("2 of 5 archived. The rest could not be saved — try again.") when some landed, the usual line of `mutationErrorKey` when none did. It invalidates on `onSettled` rather than `onSuccess` — a partial failure still moved rows, so the caches have to refresh either way — and the sheet keeps its selection after a failure, because it leaves selection mode in `onSuccess` only. `useCopySessions` ([useDuplicate.js](../src/hooks/useDuplicate.js)) is not sequential any more: one `copy_sessions` call copies every entry of the list or none, so it has no count to report and no `error.partial`. (The INVARIANTS ban on fanning ids into `.in(...)` is about UNBOUNDED slot-id lists; a coach's hand-made selection goes into the body of one `rpc()` call.)

## docs/INVARIANTS.md — Coach Athletes-roster layout

Replace the bullet that starts "**`CopyDialog` picks the destination in full: athlete → BLOCK → week.**" with:

- **`CopyDialog` picks the destination in full: athlete → BLOCK → week — and keeps it for as long as it is open.** It used to resolve straight to the destination athlete's ACTIVE program (`useActiveProgram`), which dead-ended with "No weeks" for an athlete who had none and made it impossible to copy into a block being prepared for later. Copies APPEND to the end of the destination week — there is deliberately no insert-at-position picker, because the coach can drag sessions into place on the sheet, so a fourth dropdown would buy nothing a reorder doesn't do better. The three selects live in `CopyForm`, the child `Dialog` mounts only while it is open: the destination is forgotten when the dialog closes — Cancel, the cross, Escape, or the parent once the copy is made — and NOT when Copy is pressed. The parent closes the dialog in the `onSuccess` of its `mutate()`, so a copy that is refused leaves it open with the destination still chosen, to be sent again; clearing at the click left an open dialog with empty selects and a dead button. A choice counts only while it is offered: the copy hooks read the lists again after a refusal, and a block that went to the trash or a phase that was deleted is then neither shown nor sent (`programId` / `weekId` are derived from the lists on every render). A closed `CopyDialog` calls no hook — the sheet keeps two mounted.

## docs/ARCHITECTURE.md — Per-set targets

Replace the bullet that starts "`useDuplicate` copies `set_logs` targets across (not actuals)" with:

- A copy carries the `set_logs` targets across, never the actuals — a duplicated session arrives clean. The four hooks of `useDuplicate` are one `supabase.rpc()` call each since wave 2: `duplicate_session`, `copy_sessions`, `duplicate_week` and `duplicate_program` (migration `2026_10_13_12_copy_rpcs.sql`) lock the place the copy goes to, read everything that is copied in one statement — so the copy is the block as it was at one instant, whatever is edited meanwhile — and write the sessions, their exercises and the prescribed sets from what was read, all or nothing. They are `SECURITY INVOKER` and ride the coach's policies, like `move_session`. What a copy holds is decided in those functions and nowhere in the client; a hook returns the function's answer, and shows a toast when `slots_left_out` is not 0.

## docs/ARCHITECTURE.md — Program periodization (multiple blocks per student)

Replace, in the bullet that starts "**Coaches browse all programs** via `useProgramsForStudent(studentId)`", the sentence "`useActiveProgram(studentId)` resolves "the student's current block" and backs `CopyDialog`'s destination." with:

`CopyDialog` picks its destination from the same two — the athlete's list, then the phases of the block chosen in it. `useActiveProgram(studentId)` resolves "the student's current block" and has no caller in the app.

## docs/ARCHITECTURE.md — React Query — who owns which key

Replace the row `[useDuplicate](../src/hooks/useDuplicate.js)` of the table with:

| [useDuplicate](../src/hooks/useDuplicate.js) | n/a | in `onSettled`, after a refusal too: `['program']`, `['week']`, `['session']`, `['set-logs']`, `['student-program-details']`, `['coach-dashboard-programs']`; `useDuplicateWeek` and `useDuplicateProgram` also `['programs']` (every athlete's list — a row counts its phases). `useDuplicateProgram` seeds `['programs', studentId]` with the copy in `onSuccess` |

## docs/ARCHITECTURE.md — Testing

Add after the paragraph that starts "`src/test/fakePostgrest.js` is the stand-in for `supabase.from()`":

A hook test that counts toasts ("the coach is told once") builds its client around the mutation cache handler of the app, not a copy of it: `new MutationCache({ onError: appClient.getMutationCache().config.onError })` with `appClient` imported from `src/lib/queryClient.js`, and `vi.mock('../lib/toast')` so that `pushToast` is a spy. Every toast then lands in one list, whether the cache or the hook pushed it, and `expect(pushToast.mock.calls).toEqual([[…]])` fails on a second one. `useDuplicate.test.jsx` and the `useArchiveSessions` tests of `useWeek.test.jsx` are written this way; a hook's own toast is asserted in English, which `useI18n()` falls back to without a provider.

## CLAUDE.md — Feature → files map, row "Program duplicate (whole-block copy, same student)"

Replace the row's file list with:

`coach/ProgramSwitcher` (ManageProgramDialog "Duplicate program"), `hooks/useDuplicate` (`useDuplicateProgram` — one call of `duplicate_program(p_program_id, p_target_student_id, p_name_suffix)`, migration `2026_10_13_12_copy_rpcs.sql`, `SECURITY INVOKER`, which makes the whole copy in one statement or none: inactive, last in the athlete's list, phases numbered from 1 with their names as they are, prescription only — no student actuals. The hook returns the function's answer `{ program_id, …, slots_left_out }` plus `id`, seeds the athlete's list with the copy, and shows a toast when exercises were left out), strings in `lib/i18n/fragments/coach-duplicate-rpc.*` (namespace `coachDuplicateRpc`)

## CLAUDE.md — Feature → files map, row "Coach Program Sheet (the Programming tab — the whole block as ONE list)"

Replace the sentence of the row that starts "In the database (migration `2026_10_13_12_copy_rpcs.sql`): `duplicate_session(p_session_id, p_title_suffix)` (the copy right after its source)" and ends "not called by `useDuplicateSession` / `useCopySessions` / `useDuplicateWeek` yet" with:

`useDuplicateSession`, `useCopySessions` and `useDuplicateWeek` are each one call of `duplicate_session(p_session_id, p_title_suffix)` (the copy RIGHT AFTER its source), `copy_sessions(p_session_ids, p_dest_week_id)` (one copy per entry, at the end of the phase) and `duplicate_week(p_week_id, p_dest_program_id, p_label_suffix)` (the last phase of its block or of another one) — migration `2026_10_13_12_copy_rpcs.sql`, `SECURITY INVOKER`, a whole copy or none. They return the function's answer, read the block again after a refusal too, and show a toast when `slots_left_out` is not 0 (`coachDuplicateRpc.leftOut`). `useArchiveSessions` still writes one session after the other and says "N of M archived" itself when it stops half-way. `ui/CopyDialog` keeps its destination while it is open, so a refused copy can be sent again (tests `ui/CopyDialog.test.jsx`)

## README.md — Database Tests

Replace, in the bullet that starts "`copy-rpcs.test.js` holds the four functions that copy.", the sentence "The requests of the app that is deployed are written out in it (`app`, after `src/hooks/useDuplicate.js`), so that a copy made by a function is compared with the copy those requests make of the same block, row for row and column for column (`sessionOf`, `weekOf`, `programOf` read whole rows as JSON, without ids)." with:

The requests the app sent before wave 2 are written out in it (`app` — what `src/hooks/useDuplicate.js` did before it called the functions), so that a copy made by a function is compared with the copy those requests make of the same block, row for row and column for column (`sessionOf`, `weekOf`, `programOf` read whole rows as JSON, without ids).
