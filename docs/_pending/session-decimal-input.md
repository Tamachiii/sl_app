# session-decimal-input — docs to fold (wave 3, items P31)

Each block: target doc, section, then the text to fold in.

## docs/DESIGN_SYSTEM.md — Typed numbers — `DecimalInput`

Delete, from the sentence that starts "Not yet on it — still `type="number"`:", these three entries (the rest of the list is not this package's): `student/SetRow` (actual reps and weight), `student/BodyweightCard`, `student/StudentProgramAuthor` (`NumberField`).

Add after the bullet that starts "**Inside a `<form>`**":

- **A refused value is said where the field is, and nothing is written.** The athlete's fields show it the same way: an inline `<p role="alert">` under the line (`sl-mono text-[11px] text-danger`), pointed at by the field it is about (`aria-describedby`) — the Actual editor of `student/SetRow` while the text cannot be read, with Save disabled; `student/BodyweightCard` on submit, in a `noValidate` form; a slot of `student/StudentProgramAuthor` on the blur that would have committed it, until the field is put right. A field whose rule is "1 or more" says so (`sessionDecimalInput.wholeNumberAtLeastOne`): "Enter a whole number" is wrong about a 0.

## docs/INVARIANTS.md — `set_logs` — per-set targets, outcomes, RPE

Add at the end of the bullet that starts "**Students log off-plan actuals on `set_logs.actual_reps` / `actual_weight_kg`":

The two inputs are `DecimalInput` fields read by `parseDecimalInput` — the reps a whole number, the weight with a comma or a point, both inside what their columns hold (`int`, `numeric(6,2)`: `ACTUAL_REPS_RULES` / `ACTUAL_WEIGHT_RULES` in [SetRow.jsx](../src/components/student/SetRow.jsx)). **Text the editor cannot read is refused, never read as an empty field**: Save is disabled, an inline alert says why (`uiSharedHelpers.integerInvalid` / `decimalInvalid`), no `useLogActual` write is sent and the editor stays open on the text. Only a field left empty is null — "as prescribed" on a set of the exercise as the coach wrote it, no load (`0`) on a swapped exercise or an extra set — so garbage read as empty erased the actual a set held, or stored 0 kg. `patchForActual` writes `?? null`: the guard is the editor's, before the normalisation against the targets. Tests: `src/components/student/SetRow.test.jsx`.

## docs/INVARIANTS.md — Stats

Replace, in the bullet that starts "**Personal records + bodyweight** (2026_07_14).", the words "bodyweight logging is online-only (new-row insert can't queue offline)." with:

bodyweight logging is online-only (new-row insert can't queue offline), and `BodyweightCard` reads the weight with `parseDecimalInput` between 1 and 499.99 — `bodyweight_logs.weight_kg` is a `numeric(5,2)` with `CHECK (weight_kg > 0 AND weight_kg < 500)`, so 500 itself is refused before the request.

## CLAUDE.md — Feature → files map, row "Typed numbers (weights, reps: comma or point, never null for garbage)"

Replace the row's file list with:

`lib/number.js` (`parseDecimalInput` → `{ ok, value }` or `{ ok: false, reason }`; `decimalText`; `decimalPattern`), `ui/DecimalInput` (text field with the decimal keypad; the caller holds the text), fragment keys `uiSharedHelpers.decimalInvalid` / `integerInvalid`; tests `lib/number.test.js`, `ui/DecimalInput.test.jsx`. The athlete's fields on it: `student/SetRow` (the Actual editor's reps and weight), `student/BodyweightCard`, `student/StudentProgramAuthor` (a slot's sets, reps and kg; `sessionDecimalInput.wholeNumberAtLeastOne`) — tests `student/SetRow.test.jsx`, `student/BodyweightCard.test.jsx`, `student/StudentProgramAuthor.test.jsx`

## CLAUDE.md — Feature → files map, row "Student program authoring (Phase 3.4, OFFLINE-capable)"

Replace "`student/StudentProgramAuthor` (lean self-contained draft builder — weeks/sessions/slots + slot targets; English-only)" with:

`student/StudentProgramAuthor` (lean self-contained draft builder — weeks/sessions/slots + slot targets, typed in `ui/DecimalInput` fields, a slot not written while one of them is wrong; the exercise picker offers active exercises only (`isActiveExercise`) under `ui/TypeBadge`; English-only but for the fields' alerts)
