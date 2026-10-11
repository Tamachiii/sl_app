# coach-logged-history-client — docs to fold (wave 1, items P12, P3 client half)

Each block: target doc, section, then the text to fold in.

## docs/INVARIANTS.md — `set_logs` — per-set targets, outcomes, RPE

Replace, in the bullet that starts "**Per-set targets live on `set_logs`, not `exercise_slots`.**", the words "`useUpdateSlot` fans uniform target edits to all logs; `useUpdateSetTarget` writes to a single log; `useResetSlotToUniform` re-syncs every log to set 1." with:

`useUpdateSlot` fans uniform target edits to the logs that are still pending; `useUpdateSetTarget` writes to a single pending log; `useResetSlotToUniform` re-syncs every pending log to set 1.

## docs/INVARIANTS.md — `set_logs` — per-set targets, outcomes, RPE

Add after the bullet that starts "**A set_log has three outcome states: pending, done, failed.**":

- **A set the athlete has logged is read-only for the coach: never deleted, and its targets never rewritten.** "Logged" is ONE predicate, `isLoggedSet` in [lib/loggedSets.js](../src/lib/loggedSets.js): `done`, `failed`, `skipped`, or a non-null `rpe`, `actual_reps` or `actual_weight_kg`. It is the predicate of the `block_*_delete_with_logged_sets` triggers, and the file also holds its two query forms (`LOGGED_SET_OR_FILTER`, `onlyPendingSets`) so that no hook writes its own. A set that carries a `set_log_videos` row is protected the same way (`isProtectedSet`). In [useSession.js](../src/hooks/useSession.js) the three paths that delete rows — a lower set count (`useUpdateSlot` → `reconcileSetLogCount`), `useRemoveSet` and `useDeleteSlot` — call `readSlotLogs` and throw `loggedSetsError()` **before their first write**: `useUpdateSlot` writes `exercise_slots.sets` ahead of the delete, so a refusal that came after it would leave a slot whose count no longer matches its rows. `reconcileSetLogCount` reads again right before the delete, because the athlete can tick a set in between. The three target writes go through `onlyPendingSets`, and a write that matches no row is not an error: the database keeps a logged row's targets without raising, and the client makes the same choice. Two things to keep when editing this: **the error's message must contain "logged set"** — that substring is how `lib/mutationErrors.js` picks `errors.hasLoggedTraining`, for the client's refusal and for the database's alike — and **`useSession`'s embedded `set_logs` must select `LOGGED_SET_COLUMNS`**, because the editor renders its locks from that projection: a flag missing there is a logged set shown as editable.

## docs/INVARIANTS.md — RLS / DB conventions

Replace, in the bullet that starts "**Logged training can never be hard-deleted; \"delete\" is archive-first**", the sentence "A blocked delete surfaces `errors.hasLoggedTraining` (\"archive instead\"); for a deliberate full erasure, drop the trigger, delete, recreate." with:

A blocked delete surfaces `errors.hasLoggedTraining` ("archive instead"); for a deliberate full erasure, drop the trigger, delete, recreate. Below the session, the coach's client refuses on its own before it writes — removing an exercise, removing a set or lowering a set count over a logged set throws the same error from `useSession.js` (see the logged-set entry under `set_logs`).

## docs/INVARIANTS.md — Coach session review

Add after the bullet that starts "**Coach session review is one-shot per session.**":

- **`SessionReview`'s back button returns to the page that opened it, and every opener has to say which page that is.** The review is reachable from the sessions feed, from a row of the Program Sheet, from the sheet's archived drawer and from the session editor's banner. Each passes `state: { from: <its own pathname + search> }` to the router, and `handleBack` — which is also what "Send feedback" and "Finish without feedback" end on — navigates there, or to `/coach/sessions` when there is none. Only a string that starts with `/coach/` is accepted. The origin is also written into `sl_last_coach_session` as `from`, next to `studentId` and `sessionId`, and read back for the same session only: the Sessions tab restores a review left open with a redirect that carries no router state. A new link into the review that passes no `from` still works, and sends the coach to the feed.
- **The review carries the way into the editor.** A pill beside "archive" links to `/coach/students/:studentId/s/:sessionId` and clears `sl_last_coach_session`, so the Sessions tab does not bounce back into a review the coach left on purpose. It is labelled "editor", not "edit": for a confirmed session the editor is read-only.
- **`SessionsFeed` treats an arrival with `?student=` as a destination.** The roster's "N to review" chip and the athlete page's "Sessions" action both link to `/coach/sessions?student=<students.id>`. On such an arrival the feed does not restore the review saved in `sl_last_coach_session` (it could be another athlete's), and its default view follows the data: the needs-review inbox when that athlete has something to review, "All" when nothing is left, so the coach never lands on an empty page. `viewChoice` stays `null` until the coach picks a view, which is what lets the default settle after the confirmations load. A card passes the feed's own URL as `from`, so the athlete filter survives a trip into a review.

## docs/INVARIANTS.md — Coach Athletes-roster layout

Add after the bullet that starts "**The Programming tab is the whole block as ONE list; there is no week page and no accordion.**":

- **A row of the sheet opens the REVIEW once its session is trained, the editor before that.** [SessionRow.jsx](../src/components/coach/SessionRow.jsx) takes `confirmed` and `trained`; either one sends the row to `/coach/student/:studentId/session/:sessionId/review` with the sheet's URL as `from`. `ProgramSheet` computes `confirmed` from `useProgramConfirmedSessionIds` **or** `sessions.performed_at` — the confirmation's mirror, which arrives with the sheet's own `['program']` query, so a confirmed row does not open the editor while the confirmations are loading — and `trained` from [`useProgramLoggedSessionIds`](../src/hooks/useSession.js) (`['program-logged-session-ids', programId]`): the sessions that hold a logged set and are neither confirmed nor archived. That query leaves confirmed sessions out on purpose (`performed_at IS NULL`): they hold nearly every logged set of a block, and without the filter the read would approach PostgREST's 1000-row cap on a long one. If it is ever truncated the failure is the safe one — the row opens the editor, which locks the logged sets and links to the review itself. A started, unconfirmed row shows a hollow ring where the ✓ will be.

## docs/INVARIANTS.md — Coach Athletes-roster layout

Replace, in the bullet that starts "**Archiving is the coach's cleanup verb, and it lives on the sheet.**", the words "instead of sending the coach to a full-page review route whose back button hardcodes `/coach/sessions` (a one-way trip out of Programming)" with:

instead of sending the coach to a full-page review route for a one-tap action

## docs/INVARIANTS.md — Coach Athletes-roster layout

Add after the bullet that starts "**The session editor's header is one row**":

- **The session editor locks what the athlete has trained, and how much depends on whether they confirmed.** [SessionEditor.jsx](../src/components/coach/SessionEditor.jsx) derives two states. **Confirmed** (`useSessionConfirmation` returns a row, or `session.performed_at` is set): the whole editor is read-only — the title is text, the date and every field are disabled, and add, remove, reorder, unlink and delete are not rendered; `ExerciseSlotRow` gets `readOnly`. **Logged sets, not confirmed** (a session in progress, or one stopped half-way): only the logged sets are locked. [ExerciseSlotRow.jsx](../src/components/coach/ExerciseSlotRow.jsx) disables and marks each logged row, drops its remove button, disables "Remove exercise" while any row of the slot is logged (student-added extras included, since the delete would cascade to them) and replaces the compact one-row view with the per-set table, where pending sets stay editable and "+ Add set" still works. This second state is deliberately not read-only as a whole: re-planning what is left of a session is what the coach opens it for, and it is what the database allows. In both states a banner says which one it is and links to the review, and "Delete this session" is not rendered — the database refuses a session with logged sets. A notes field is `readOnly`, not `disabled`, so it can still be read in full and copied.

## docs/INVARIANTS.md — Coach Athletes-roster layout

Add after the bullet that starts "**The Athletes roster merges the old Dashboard + Students tabs.**":

- **A roster card is a link STRETCHED over the card, not an anchor wrapped around it.** The card is a `relative` box; its "open this athlete" `<Link>` covers it with `after:absolute after:inset-0`. That is what allows the "N to review" chip to be a link of its own (to `/coach/sessions?student=<id>`) — an anchor cannot contain an anchor — and the chip needs `relative z-10` to sit above the stretched area, or its tap opens the athlete instead. Any other interactive element added to a card needs the same. `CoachHome.test.jsx` asserts that no `a` contains an `a`.

## docs/INVARIANTS.md — Coach Athletes-roster layout

Add after the bullet that starts "**The single-student view is ONE page with collapsible sections — no tabs.**":

- **The athlete page carries two actions under its header: Message and Sessions.** `AthleteActions` in [StudentOverview.jsx](../src/components/coach/StudentOverview.jsx) links to `/coach/messages/:profileId` — the thread is keyed on `students.profile_id`, not on the students-row id — and to `/coach/sessions?student=<students.id>`. They are the first row of the page body and not part of `CoachHome`'s header, for two reasons: that header box is shared with the roster and must not change shape, and it stays mounted over the session editor, where a row of actions above the work is what the editor's own header was trimmed to avoid. The student comes from the outlet context.

## docs/INVARIANTS.md — Messaging / notifications

Replace, in the bullet that starts "**Coach feedback messages render as session-reference cards.**", the sentence "The coach enters a thread either from `/coach/messages` or via the **Message** button on the per-student Profile tab." with:

The coach enters a thread either from `/coach/messages` or via the **Message** action at the top of the athlete page (`StudentOverview`).

## docs/ARCHITECTURE.md — Coach-section persistence across tab switches

Replace the bullet that starts "**`sl_last_coach_session`**" with:

- **`sl_last_coach_session`** — `JSON.stringify({ studentId, sessionId, from? })` for the last-open `SessionReview`; `from` is the coach route that opened it, when it said so. Read by `SessionsFeed`'s mount effect (redirects into the saved review, unless the feed was opened with `?student=`), and by `SessionReview` itself to find its origin when the router state is gone. Cleared by the review's back button and by its "editor" pill.

## docs/ARCHITECTURE.md — Back-button routing in coach deep views

Replace the line "- `SessionReview` back → `/coach/sessions`" with:

- `SessionReview` back → the page that opened it, passed as `location.state.from` (the Program Sheet, its archived drawer, the session editor, the feed with its filter), or `/coach/sessions` when there is none. Still an explicit destination, never `navigate(-1)`.

## docs/ARCHITECTURE.md — React Query — who owns which key

Replace the `useSession` row of the table with:

| [useSession](../src/hooks/useSession.js) | `['session', sessionId]`, `['program-logged-session-ids', programId]` (coach: the block's sessions that are started but not confirmed) | `['session', sessionId]` + `['week']` (broad). No coach write changes the logged-session set; it refreshes on staleness. |

## CLAUDE.md — Repo map

Add `loggedSets.js` to the `lib/` line of the map, with the comment:

loggedSets.js (isLoggedSet — the one "has the athlete logged this set" predicate, its query forms, and the error the coach hooks throw)

## CLAUDE.md — Feature → files map, row "Coach Athletes roster (attention-first list; merged Dashboard + Students into one tab)"

Add to the end of the row:

The to-review chip is a link to `/coach/sessions?student=<id>`; the card is a link stretched over the card (`after:absolute after:inset-0`), not an anchor around it

## CLAUDE.md — Feature → files map, row "Coach single-student view (ONE page, no tabs)"

Add to the end of the row:

`StudentOverview` opens with `AthleteActions` — Message (`/coach/messages/:profileId`) and Sessions (`/coach/sessions?student=<id>`)

## CLAUDE.md — Feature → files map, row "Coach sessions feed"

Replace the row's file list with:

`coach/SessionsFeed` (an arrival with `?student=` opens on that athlete's needs-review list, or on "All" when nothing is left, and never bounces into a saved review; cards pass the feed URL as the review's `from`), `hooks/useSessionConfirmation`

## CLAUDE.md — Feature → files map, row "Coach Program Sheet (the Programming tab — the whole block as ONE list)"

Add to the end of the row:

A row opens the editor until its session is trained, then the review: `confirmed` comes from `useProgramConfirmedSessionIds` or `sessions.performed_at`, `trained` from `hooks/useSession` (`useProgramLoggedSessionIds`)

## CLAUDE.md — Feature → files map, row "Coach session editor"

Add to the end of the row:

Locks what the athlete trained: read-only as a whole once the session is confirmed (`hooks/useSessionConfirmation` or `performed_at`), logged sets only while it is in progress — `lib/loggedSets` (`isLoggedSet`), with a banner linking to the review. The delete and target hooks in `hooks/useSession` refuse or skip logged sets on their own

## CLAUDE.md — Feature → files map, row "Coach session review"

Add to the end of the row:

Back returns to the page that opened the review (`location.state.from`, saved in `sl_last_coach_session`); an "editor" pill opens the session editor

## README.md — the numbered list of coach surfaces, item "Single-student view"

Replace "then a persistent **athlete header** (avatar, name, coaching-since, plus **View sessions** and **Message** actions), then collapsible sections" with:

then the athlete's name as the page title, a row of two actions (**Message** and **Sessions**), then collapsible sections

## README.md — the numbered list of coach surfaces, item "Single-student view"

Replace "Tap a session to edit its exercises in a full-width pane that stays *inside* this shell, so the tab strip and athlete context never disappear." with:

Tap a session to edit its exercises in a full-width pane that stays *inside* this shell, so the athlete context never disappears. Once the athlete has trained a session — confirmed it, or logged a set in it — the same tap opens its review instead, and the review has an **editor** button: a confirmed session is read-only there, and a session in progress has its logged sets locked while the rest stays editable.

## README.md — the numbered list of coach surfaces, item "Sessions tab"

Replace "Arriving via a student profile's \"View sessions\" deep link lands on All." with:

Arriving for one athlete — from the roster's "to review" chip or the athlete page's **Sessions** action — opens on that athlete's sessions to review, or on their full history when none is left. The review's back button returns to the page it was opened from.
