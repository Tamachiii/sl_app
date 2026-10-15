# coach-sheet-ux — docs to fold (wave 3, items P32, L10, B26, L15; part of P11)

Each block: target doc, section, then the text to fold in.

## docs/INVARIANTS.md — Shell, routing, viewport

Add after the bullet that starts "**Anything pressed is 44px: a pill that is a button takes `sl-pill-btn`**":

- **A menu that hangs off a control inside a box with `overflow: hidden` is drawn by `PortalMenu`, never inside the box.** [`coach/PortalMenu.jsx`](../src/components/coach/PortalMenu.jsx) renders a portal on `<body>` with a fixed position read from the trigger's box and the viewport in the click handler (`anchorOf`), below the trigger, or above it when the room below is short and there is more above (`placeMenu`). The caller gives the menu's height, counted from 44px items, so nothing is measured once it is drawn and no effect sets state. A scroll (capture, any scroller) or a resize closes it, Escape closes it and gives the focus back to the trigger, and its first button takes the focus when it opens. The Program Sheet is one `sl-card overflow-hidden`: an absolutely positioned menu inside it was cut at the card's edge, and on the last, empty phase "Reorder phases" and "Delete phase" (the only way to delete a phase) could not be pressed. Tests: `coach/PortalMenu.test.jsx`, `coach/ProgramSheet.test.jsx` ("menus are drawn outside the card").

## docs/INVARIANTS.md — Coach Athletes-roster layout

Replace, in the bullet that starts "**The Programming tab is the whole block as ONE list; there is no week page and no accordion.**", the sentence "Phase-level actions (add session / duplicate / copy to… / reorder phases / delete) live in the divider's ⋯ menu — including entering phase-reorder mode, which has no standing top-level button." with:

Phase-level actions (add session / duplicate / copy to… / reorder phases / delete) live in the divider's ⋯ menu — including entering phase-reorder mode, which has no standing top-level button. That menu and the row's weekday picker (two rows of four 44px cells) are drawn by `PortalMenu`, outside the card. Every control of a row is a 44px box beside the next one, none of them an `sl-hit` area: the button that opens the session stretches over the whole row, between the day pill and the duplicate button, which write on a tap.

Add after the same bullet:

- **A new session is born untitled.** `ProgramSheet` creates sessions without a title (the footer, a phase menu, the first session of an empty block), and `useCreateSession` writes `null` for a missing or empty one. An untitled session is named by its position across the block wherever the sheet shows it, so the name follows every reorder, move and archive; a title written as "Session {n}" was true on the day it was added and on no other. The session editor shows `coach.editor.titlePlaceholder` for it, and so does the archived drawer, where an index would be no place in the block.
- **The sheet of an athlete's draft offers no write.** On `program.status === 'draft'` the sheet draws the block and nothing that writes: the day is text (`DayPill` with `readOnly`), there is no duplicate, no "+ Add session" in the footer or a menu, no "+ Phase", no Select, no Reorder, a phase name is text and a divider has no ⋯ menu (`PhaseDivider` with `readOnly`; "Copy to…" goes with it, since the dialog can pick the draft itself as the destination), and the drawer has no restore. A row still opens its session, in the editor's read-only state. An empty draft says `coachSheetUx.draftEmpty` and offers no first session. Migration 20 refuses those writes in the database (`draft_read_only`).

Replace, in the bullet that starts "**Archiving is the coach's cleanup verb, and it lives on the sheet.**", the sentence "Any archive write must invalidate `['student-program-details']` too — archiving pulls the session out of the athlete's queue." with:

Any archive write must invalidate `['student-program-details']` and `['student-progress-stats']` too — archiving pulls the session out of the athlete's queue, and the athlete's stats count sessions by `archived_at`. `useArchiveSession` does it in `onSuccess`, `useArchiveSessions` in `onSettled` (a selection that stopped half-way moved rows too). The drawer marks a row "archived" and nothing else, confirmed or trained.

## docs/INVARIANTS.md — RLS / DB conventions

Replace, in the sub-bullet that starts "**`duplicate_session(p_session_id, p_title_suffix default ' (copy)')`**", the sentence "The copy is never archived." with:

The copy is never archived. The app sends the suffix: `useDuplicateSession` takes `{ sessionId, titleSuffix }` and sends `p_title_suffix` when `titleSuffix` is given (the key is left out otherwise); `ProgramSheet` sends a space and `coachSheetUx.copySuffix` — " (copy)", " (copie)", " (Kopie)" — and `''` for a source without a title (blank included), whose copy stays untitled and is named by its position. A copy made is announced by an info toast whose Undo (`uiSharedHelpers.undo`) deletes the answer's `session_id` through `useDeleteSession`. The toast and the delete are both in the hook's own options, so Undo still works once the sheet is gone. A copy has no logged set, so the delete guards let it go. Only the row being copied waits (`isPending` and `variables.sessionId`).

## docs/DESIGN_SYSTEM.md — 44px targets — `sl-pill-btn` and `sl-hit`

Add after the paragraph that starts "Both classes stand in `@layer components`":

A menu item is a 44px row (`min-h-11`, on one line: the menu's height is counted from it). A menu that hangs off a control inside a card with `overflow-hidden` goes through `coach/PortalMenu`, which draws it on `<body>` and opens it upward when the room below is short. In a dense row, controls that write on a tap sit beside the main target as 44px boxes (`w-11 h-11`, `h-11 min-w-11`), not as `sl-hit` areas that would lie over it, and the row drops the padding they replace (`min-h-11`, no `py-*`).

## CLAUDE.md — Repo map

Replace the line "StudentStatsSection  CoachMessages" under `coach/` with:

StudentStatsSection  CoachMessages  PortalMenu (a menu on `<body>`, placed from its trigger)

## CLAUDE.md — Feature → files map, row "Coach Program Sheet (the Programming tab — the whole block as ONE list)"

Replace "divider ⋯ menu = add session / duplicate / copy to… / reorder phases / delete phase." with:

divider ⋯ menu = add session / duplicate / copy to… / reorder phases / delete phase, drawn by `coach/PortalMenu` (a portal on `<body>`, upward when the room below is short) like the row's weekday picker.

Replace "`coach/SessionRow` holds the row itself: day pill + title + N ex + confirmed ✓ + duplicate;" with:

`coach/SessionRow` holds the row itself: day pill + title + N ex + confirmed ✓ + duplicate, each a 44px box;

Replace "An empty block's CTA adds a SESSION and creates phase 1 implicitly)" with:

An empty block's CTA adds a SESSION and creates phase 1 implicitly. A new session is born untitled (`useCreateSession` writes `null`) and is named by its position. On an athlete's draft (`program.status === 'draft'`) the sheet offers no write; rows open the read-only editor)

Replace "They return the function's answer, read the block again after a refusal too, and show a toast when `slots_left_out` is not 0 (`coachDuplicateRpc.leftOut`)." with:

They return the function's answer, read the block again after a refusal too, and show a toast when `slots_left_out` is not 0 (`coachDuplicateRpc.leftOut`). `useDuplicateSession` sends the coach's `p_title_suffix` (`coachSheetUx.copySuffix`, `''` for an untitled source) and pushes an info toast whose Undo deletes the copy (`useDeleteSession`). Both archive hooks also invalidate `['student-progress-stats']`.
