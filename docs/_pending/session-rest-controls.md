# session-rest-controls — docs to fold (wave 3, items P44, L34, B34, B29)

Each block: target doc, section, then the text to fold in. The package also closes live item N5 (the prescribed rest of an exercise whose sets are not rested alike).

## docs/INVARIANTS.md — Rest timer

In the bullet that starts "**Rest timer is an app-wide singleton with one rendering site.**", replace "`clearRestTimer(logId)` is a no-op unless the active timer matches — undoing a stale set never kills the current rest." with:

`clearRestTimer(logId)` is a no-op unless the active timer matches — undoing a stale set never kills the current rest. `extendRestTimer(logId, seconds)` ("+30 s") moves the end of the running rest of that set later, and does nothing to the rest of another set, to a rest that has ended, or when there is none: a tap that lands as the rest ends must not start another one.

In the same bullet, replace from "Rendering lives in **one** place:" to "auto-hides ~5s later." with:

The visible timer lives in **one** place: [RestTimerBanner.jsx](../src/components/student/RestTimerBanner.jsx), in the right slot of `SessionView`'s top bar (the slot opposite the back button), so the indicator survives exercise-card transitions without pushing scroll content down. While a rest runs it shows the countdown (`Rest` above `m:ss`) and two 44 px controls, "+30 s" (`extendRestTimer(logId, 30)`) and Skip (`clearRestTimer(logId)` of the running set); the slot grows for them, so the title is off-centre during a rest. On expiry it flashes "Rest done" without controls and auto-hides ~5s later (`HIDE_AFTER_EXPIRY_MS`). SetRow only writes to the singleton, from its gesture handlers (next bullet); it never reads or renders remaining time.

Add after the same bullet:

- **The countdown is never in a live region; a hidden status region says when a rest starts and when it ends.** A live region whose text or label changes every second is read aloud every second by VoiceOver and TalkBack, and "Rest done" is lost in it (P44). `RestTimerBanner` has no `role`, no `aria-live` and no label that holds the time. [RestTimerHost.jsx](../src/components/student/RestTimerHost.jsx) renders a `role="status"` element, `sr-only`, mounted with the shell and never unmounted while it lives — a region added together with its text is not announced. It holds `sessionRestControls.restStarted` ("Rest 1:30") from the start of a rest, the length read once per rest (keyed on `logId:endsAt`, so "+30 s" says the new length and the text never moves while the rest runs), `student.session.restDone` from `endsAt` to `HIDE_AFTER_EXPIRY_MS` after it, and nothing otherwise — no rest, a rest taken back or skipped, the flash over. Tests: `student/RestTimerHost.test.jsx`, `student/RestTimerBanner.test.jsx`.

In the bullet that starts "**The running rest is also in `localStorage`", replace "from `commit`, the one function through which `startRestTimer`, `clearRestTimer` and `resetRestTimer` change the timer, and removes the key when there is no timer. **Whatever changes `endsAt` goes through `commit`**, never through `state = …`: a skip or a "+30 s" written beside it leaves the old end time in storage, and the next launch brings back a rest the athlete had ended." with:

from `commit`, the one function through which `startRestTimer`, `clearRestTimer`, `extendRestTimer` and `resetRestTimer` change the timer, and removes the key when there is no timer. **Whatever changes `endsAt` goes through `commit`**, never through `state = …`: Skip is `clearRestTimer` and "+30 s" is `extendRestTimer`, and either written beside `commit` would leave the old end time in storage — the next launch would bring back a rest the athlete had ended, or end one early.

In the same bullet, replace "Two things follow from a restored rest: the effects hook treats it as a rest that just started (wake lock, beep at `endsAt`)," with:

Two things follow from a restored rest: the effects hook treats it as a rest that just started (wake lock, beep at `endsAt`) on whichever page of the shell the app opens on,

In the bullet that starts "**Out-of-band rest-timer effects ride the singleton via two hooks, mounted in `SessionView` only.**", replace that bold lead with:

**Out-of-band rest-timer effects ride the singleton via two hooks, mounted once, by [RestTimerHost.jsx](../src/components/student/RestTimerHost.jsx), which [AppShell.jsx](../src/components/layout/AppShell.jsx) renders for a student (`role === 'student'`).** A change of tab does not end them — they used to be mounted by `SessionView`, and a look at Stats in the middle of a rest cancelled the push, cleared the beep and released the wake lock while the countdown ran on (B34). What ends a rest's effects is the timer (a new set, Undo, Skip, "+30 s", the end) or the shell unmounting at sign-out. Do not call the two hooks from a page.

In the same bullet, replace "The AudioContext is created/resumed on the first `pointerdown` so iOS lets it play unattended at expiry." with:

The AudioContext is created/resumed on the first `pointerdown` (or `touchstart`) after the hook's first mount, so iOS lets it play unattended at expiry. The listener is armed by the hook (`armAudioUnlock`, once), never when the module loads: through `AppShell` the module is in the bundle a coach loads too, and a coach's first tap would build an AudioContext nobody plays.

## docs/INVARIANTS.md — Web Push (rest-timer "Rest done" lock-screen notification)

In the bullet that starts "**"Rest done" in front of the athlete is shown quietly and taken away", replace "the page that schedules it is the page that beeps, and it takes the push back when it is left." with:

the app that schedules it is the app that beeps — `RestTimerHost` runs both, on every page of the student shell — and the push is taken back when the rest is cleared, replaced, skipped or given 30 s more (a new push is scheduled for the new end), or when the shell unmounts at sign-out. A change of tab keeps it.

## docs/INVARIANTS.md — `set_logs` — per-set targets, outcomes, RPE

In the bullet that starts "**Per-set targets live on `set_logs`, not `exercise_slots`.**", add at the end:

On the athlete's card, the rest is shown once in the header of an exercise when every prescribed set has the same — also when their reps or loads differ — and on each row (`SetRow` `showRest`, under the set's target) when the rests differ (`sharedRest` in [SlotGroupCard.jsx](../src/components/student/SlotGroupCard.jsx)); a set without a prescribed rest, and an extra set, say nothing. The headline grouping of `summarizeSlotPrescription` leaves rest out, so without the rows Dips rested 3:00 after sets 1 to 3 and 2:00 after 4 to 6 showed no rest anywhere (N5).

Add after the bullet that starts "**A set_log has three outcome states: pending, done, failed.**":

- **An RPE is a number in half steps; the athlete is offered 6 to 10.** `set_logs.rpe` is `numeric(3,1)`, from 1 to 10 in steps of 0.5 (migration `2026_10_16_21_rpe_half_steps_day_check`). The API hands it over as a JSON number — 8 reads `8`, 7.5 reads `7.5`. [RpeInput.jsx](../src/components/student/RpeInput.jsx) offers `RPE_VALUES` (6, 6.5 … 10, nine 44 px buttons in rows of five) and gives `onChange` the number; `setRpe.mutate({ logId, rpe: 7.5, done? })` writes it as it is. A rating that is not offered — 1 to 5 from before half steps, or sent by an older build — is drawn first in the tenth cell, pressed, so it stays on screen and can be taken back. A rating is printed with `formatRpe(value, lang)` ("7.5", "7,5"), in the grid and on the set's pill. Compare ratings as numbers (`Number(value)`), never as text.

## docs/INVARIANTS.md — Offline-safe student writes

Add after the bullet that starts "**The confirm dialog closes at the tap, and the field of a note when it is left — neither waits for an answer.**":

- **An exercise has one note control, whatever the state of its card, and a collapsed card has it too.** "Add note" was in the body of a card, rendered only while it was open (B29). [SlotGroupCard.jsx](../src/components/student/SlotGroupCard.jsx) renders `SlotCommentBox` `compact` beside the header of a collapsed card — outside the header's toggle button, a 44 px bubble named `sessionRestControls.addNoteOn` / `editNoteOn` with the exercise's name, accent when there is a note, whose field opens on a line of its own under the header — and the full box in the body of an open card; never both. A superset has one, on its lead slot, named after its exercises. A read-only session (`isReadOnly`) offers none on a collapsed card and shows the passive "Note attached" badge; a collapsed card that can be written shows the note on its control instead of the badge. `SessionView.test.jsx` holds "one note control per superset" and "none when reviewed"; a second, collapsed exercise answers to "Add note for coach: <name>", so a test that asks for the open exercise's box anchors its name (`/^add note for coach$/i`).

## README.md — Rest Timer (in-app + Web Push)

Replace "The student rest timer is an app-wide singleton ([hooks/useRestTimer.js](src/hooks/useRestTimer.js)) with one rendering site ([RestTimerBanner.jsx](src/components/student/RestTimerBanner.jsx)) and two effect hooks mounted in `SessionView`." with:

The student rest timer is an app-wide singleton ([hooks/useRestTimer.js](src/hooks/useRestTimer.js)). The session page draws it ([RestTimerBanner.jsx](src/components/student/RestTimerBanner.jsx)): the countdown, "+30 s" and Skip. [RestTimerHost.jsx](src/components/student/RestTimerHost.jsx), which the student shell mounts on every page, runs the two effect hooks below and the hidden status region a screen reader hears — "Rest 1:30" when a rest starts, "Rest done" when it ends, nothing in between — so a change of tab in the middle of a rest keeps the beep, the wake lock and the push.

## CLAUDE.md — Feature → files map, row "Rest timer (in-app cues + Web Push)"

Replace the start of the row's file list, "`hooks/useRestTimer`, `hooks/useRestTimerEffects`, `hooks/useRestTimerPush`, `student/RestTimerBanner`, `student/SessionView`," with:

`hooks/useRestTimer` (`extendRestTimer` for "+30 s"), `hooks/useRestTimerEffects`, `hooks/useRestTimerPush`, `student/RestTimerHost` (mounted by `layout/AppShell` for a student: the two hooks and the `sr-only` status region; strings in the `sessionRestControls` namespace), `student/RestTimerBanner` (countdown, "+30 s", Skip — not a live region), `student/SessionView`,

## CLAUDE.md — Feature → files map, row "Student session logging"

Replace the sentence "`student/RpeInput` is two rows of five 44 px buttons." (from the snippet of session-touch-undo) with:

`student/RpeInput` offers half steps from 6 to 10 (`RPE_VALUES`, `formatRpe`; `set_logs.rpe numeric(3,1)` since migration `2026_10_16_21_rpe_half_steps_day_check`), nine 44 px buttons in rows of five, a rating that is not offered any more shown first and pressed. A collapsed exercise carries its note control beside its header (`student/SlotCommentBox` `compact`); a row shows its rest when the exercise's sets are not rested alike (`student/SetRow` `showRest`).

## docs/DESIGN_SYSTEM.md — 44px targets — `sl-pill-btn` and `sl-hit`

Add after the paragraph that starts "Used by `ui/ToastHost` (the action pill and the dismiss icon)":

The rest timer's "+30 s" and Skip (`student/RestTimerBanner`) and the note bubble of a collapsed exercise (`student/SlotCommentBox` `compact`) are `sl-pill sl-pill-btn` too — `px-0` for the two icon-only ones, which `min-width` keeps 44 px wide. The right slot of the session bar is the 44 px placeholder that keeps the title centred while no rest runs; during a rest it grows for the countdown and the two controls, and the title, `min-w-0` and truncated, gives way.

## docs/DESIGN_SYSTEM.md — new section "Live regions", after "Toasts"

````markdown
## Live regions

A text that changes every second — a countdown, a progress number — is never inside a live region (`aria-live`, `role="status"`, `role="alert"`, `role="timer"`) and never in an `aria-label` that changes with it: VoiceOver and TalkBack read it aloud each time, and the announcement that matters is lost. Announce the events instead, from a region that is in the page before its text is — a region mounted together with its text says nothing:

```jsx
<div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
  {announcement /* '' between events */}
</div>
```

`student/RestTimerHost` is the model: "Rest 1:30" when a rest starts, "Rest done" when it ends, empty otherwise. The visible countdown (`student/RestTimerBanner`) is plain text.
````
