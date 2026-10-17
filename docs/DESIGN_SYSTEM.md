# Design System

The app is drawn with **Parc**, the design system in [`design/parc/`](../design/parc/). This page only says where it is; the rules are there.

- [`design/parc/README.md`](../design/parc/README.md) — the rules: type, colour, spacing, the components and how a screen is put together. Read it before any UI change.
- [`design/parc/tokens.json`](../design/parc/tokens.json) — every value. Nothing is written by hand that a token gives.
- [`design/parc/components/`](../design/parc/components/) — one README per component, and `bundle.css`, the `pk-*` classes.
- [`design/parc/screens/`](../design/parc/screens/) — the mocks (`.dc.html`), a visual reference and not code to copy. A screen with no mock is built from the README and the primitives.

## In the code

- `src/styles/parc-tokens.css` and `src/styles/bundle.css` are copies of the design system's files; `src/index.css` imports them and gives the tokens to Tailwind (`@theme inline`: `bg-ground`, `text-ink-2`, `rounded-group`…). `src/test/parcTokens.test.js` holds the copy to `tokens.json`.
- `src/styles/parc-app.css` holds what a README or a mock describes without a `pk-*` class (the sheet as a bottom `<dialog>`, the toast, the segmented control, the side nav).
- `src/components/parc/` holds the primitives, one file per component (`index.js` exports them all).

## What the app holds itself to

- **44px** for anything pressed (`src/test/hitTargets.test.js`) and **4.5:1** for any text.
- **Every string through the i18n**, in en, fr and de; sentence case, no capitals, no middle dots, no emoji. Each component folder has a `hardcoded.test.js`.
- **A field is 16px or more** (iOS zooms the page on a smaller one), and a typed number is `ui/DecimalInput` read by `parseDecimalInput` — `docs/INVARIANTS.md`, "Shell, routing, viewport".
- **A text that changes every second is never in a live region** nor in a changing `aria-label`; the events are announced instead, from a region that is in the page before its text (`student/RestTimerHost`).
- **A toast** comes from `pushToast` (`lib/toast.js`), with one action at most, which is a way back and never what commits.
