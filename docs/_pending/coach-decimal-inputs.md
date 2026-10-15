# coach-decimal-inputs — docs to fold (wave 3, items L9)

Each block: target doc, section, then the text to fold in.

## docs/DESIGN_SYSTEM.md — Typed numbers — `DecimalInput`

In the sentence that starts "Not yet on it — still `type="number"`:", change only these entries (the others are not this package's): replace `coach/ExerciseSlotRow` (reps, seconds, weight, rest) with `coach/ExerciseSlotRow` (sets, reps, seconds, rest), replace `coach/StudentGoalsSection` with `coach/StudentGoalsSection` (sets, reps), and delete `coach/ExerciseLibrary`.

Replace the bullet that starts "**Inside a `<form>`**" with:

- **Inside a `<form>`** the `pattern` makes the browser refuse the submit with its own message. A form that shows its own alert for text that is not a number is `noValidate`. A form whose other fields rely on the browser's validation (`required`) keeps it: the browser stops text that is not a number, and an empty field that carries `required`; the submit handler stops what the `pattern` cannot see — a number outside the range — and says so itself (`coach/ExerciseLibrary`, `coach/StudentGoalsSection`).

Add after that bullet:

- **The coach's fields.** A target weight of `coach/ExerciseSlotRow` (the compact row and each per-set row) commits on blur and draws no message: text it cannot read, or a weight past 9999.99, writes nothing and the field shows the stored value again — the field is marked (`aria-invalid`, `title`) only while it is typed. The volume weight of `coach/ExerciseLibrary` (0.1 to 99.99) and the weight of a goal in `coach/StudentGoalsSection` (0 to 9999.99) are refused on submit: the field gets `invalid`, a `<p role="alert">` (`sl-mono text-[11px] text-danger`) pointed at by its `aria-describedby` says the range — `coachDecimalInputs.volumeWeightRange`, `coachDecimalInputs.goalWeightRange`, since "Enter a number" is wrong about a "0" — and both go away as soon as the field changes.

## docs/INVARIANTS.md — Coach Athletes-roster layout

Add after the bullet that starts "**The session editor locks what the athlete has trained, and how much depends on whether they confirmed.**":

- **A coach's target weight is read, not cast, and text the slot row cannot read is never written.** The weight of [ExerciseSlotRow.jsx](../src/components/coach/ExerciseSlotRow.jsx) — the compact row's and each per-set row's — is a `DecimalInput` read on blur by `parseDecimalInput` under `TARGET_WEIGHT_RULES` (9999.99 at most: `exercise_slots.weight_kg` and `set_logs.target_weight_kg` are `numeric(6,2)`), so "62,5" and "62.5" both write 62.5. Text that is not a number of that range writes nothing, and the field shows the stored value again; that restore is set in the row's local state, because the resync effects only run when the props change. In the compact row the weight is one key of the blur's `onUpdate`: an unreadable weight is left out and the sets, reps, seconds and rest of the same blur still go. **An empty field is still `null` on purpose** — no load, which the athlete sees as "BW": it is how a coach prescribes bodyweight, so it is never treated as an error. A number field read "62,5" as 625 in an English Chromium and as `""` in WebKit, and that `""` was written as `null`: the athlete saw "BW" while the coach still saw "62,5". The library's `volume_weight` (0.1 to 99.99, `numeric(4,2)`) and a goal's `target_weight_kg` (0 to 9999.99) are read the same way on submit, and nothing is sent while they are refused. Tests: `coach/ExerciseSlotRow.test.jsx` ("a target weight typed with a comma or a point"), `coach/ExerciseLibrary.test.jsx` ("the volume weight"), `coach/StudentGoalsSection.test.jsx`.

## CLAUDE.md — Feature → files map, row "Typed numbers (weights, reps: comma or point, never null for garbage)"

Add at the end of the row's file list (after the athlete's fields, if `session-decimal-input` has folded them first):

The coach's fields on it: `coach/ExerciseSlotRow` (the target weight of the compact row and of each per-set row; sets, reps, seconds and rest are still number fields), `coach/ExerciseLibrary` (an exercise's volume weight), `coach/StudentGoalsSection` (a goal's weight; its sets and reps are still number fields), fragment `coachDecimalInputs` (the range alerts of the two forms) — tests `coach/ExerciseSlotRow.test.jsx`, `coach/ExerciseLibrary.test.jsx`, `coach/StudentGoalsSection.test.jsx`
