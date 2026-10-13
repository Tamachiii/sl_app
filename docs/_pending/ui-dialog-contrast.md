# ui-dialog-contrast — docs to fold (wave 2, items P42, P43, B44)

Each block: target doc, section, then the text to fold in.

## docs/DESIGN_SYSTEM.md — Tokens

Add after the bullet that starts "**Palette**":

- **Muted text**: `ink-400`, and it is the one step of the scale whose dark value sits on the token. `@theme` gives `--color-ink-400: #807a6e`; the `.dark` rule of [src/index.css](../src/index.css) sets it to `#948e82`. Every reader of the token follows — `text-ink-400`, `.sl-label`, the `.dark .text-gray-400` remap, `placeholder:text-ink-400`, an inline `var(--color-ink-400)`, the chart fills — with no class remap, which would reach the class and nothing else. The dark value is at least 4.5:1 on every ink surface the theme paints: 5.80 on the page (`ink-900`), 5.51 on a card or a dialog (`ink-850`), 5.23 on a pill or an input (`ink-800`), 4.76 on a pressed or hovered pill (`ink-700`). It stays darker than `ink-300`, the step `text-ink-500` is drawn in, so muted and secondary copy remain two levels.
- **Contrast is tested**: `src/test/contrast.test.js` recomputes the WCAG ratios from the stylesheet — the tokens of `@theme`, what `.dark` sets on top, and every `.dark` rule that paints a background of the ink scale, so a surface remapped later is held to 4.5:1 without being listed. `src/test/contrast.js` holds the arithmetic and the reader (`contrastRatio`, `readTokens`, `declared`, `resolveColour`, `AA_TEXT`) for any other test that asks whether a token can be read on a surface.

## docs/DESIGN_SYSTEM.md — The `sl-*` primitives

Add after the subsection "`sl-btn-primary` — the accent CTA":

````markdown
### `sl-on-fill` — text on an accent or danger fill

`color: var(--color-ink-900)`, in both themes: 6.06:1 on `--color-accent` and 5.64:1 on `--color-danger`. It is the colour `sl-btn-primary` writes, as a class of its own for a button that is a fill without being the CTA.

```jsx
// ✅ Do
<button className="rounded-lg py-2.5 sl-display text-[13px] sl-on-fill" style={{ background: 'var(--color-danger)' }}>
  Delete
</button>

// ❌ White is 3.35:1 on danger and 3.12:1 on accent
<button className="… text-white" style={{ background: 'var(--color-danger)' }}>Delete</button>

// ❌ Reads like the same colour, and is cream in the dark theme: 2.94:1 on accent
<button className="bg-accent text-ink-900">Done</button>
```

`text-ink-900` and `text-gray-900` are remapped by `.dark` to `ink-0`, which is what makes them right on a card and wrong on a fill. The class is `!important` inside `@layer components`, and an `!important` inside a layer outranks one outside every layer: neither the remap nor a `text-white` left beside the class takes the colour back.

Used by `ui/ConfirmDialog` (the confirm button, on danger or on accent). Not yet on it:

- white on a fill — `coach/ProgramManageDialog` (move to trash), `coach/ProgramTrashDialog` (delete forever), `coach/RemoveExerciseDialog`, `coach/ExerciseDeleteDialog`, `coach/SlotProgress` (the failed pill), `student/SessionView` (the confirm-session button), `student/StudentProgramAuthor` (discard), `student/SetRow` (the failed mark);
- `bg-accent text-ink-900`, cream in the dark theme — `coach/SessionsFeed` (the filter pill that is on), `coach/SessionRow` (the chosen cell of the day picker), `coach/StudentWeekStrip` (a performed day), `student/RpeInput` (the chosen value), `student/SetRow` (the done mark, and Save in the actual editor).
````

## docs/DESIGN_SYSTEM.md — Dark mode — class-based remap only

Add after the code block that ends with "color-mix tints read correctly on both surfaces":

One token carries its dark value itself, and is the exception to "inline does not flip": `var(--color-ink-400)`, the muted-text step (see "Tokens"). Every other step of the scale written inline is the value of `@theme`, so `var(--color-ink-500)` and darker are never a text colour on a dark surface — `ink-500` is 2.59:1 on `ink-900`.

## docs/DESIGN_SYSTEM.md — Native `<dialog>` + dark mode

Add after the paragraph that starts "**Don't remove these classes.**":

**The title names the dialog through an id from `useId`.** A page mounts its dialogs once and opens them later, and a closed `Dialog` still renders its `<h2>` (only `children` wait for `open`). A fixed id would be in the document once per dialog, and `aria-labelledby` would resolve to the first of them: the destructive question read out under the title of another dialog. `ui/Dialog` therefore takes one id per instance from `useId` and points `aria-labelledby` at it; without a `title` it carries no `aria-labelledby`. Anything else a dialog needs to reference inside itself gets its id the same way.

## docs/DESIGN_SYSTEM.md — Quick reference

Replace the row "muted text color" with:

| muted text color | `text-ink-400` — or `var(--color-ink-400)` inline, the one ink step whose dark value is on the token |

Add after the row "compact CTA inside a form/card":

| text on an accent or danger fill | `sl-on-fill` (never `text-white`, `text-ink-900` or `text-gray-900`) |

## docs/INVARIANTS.md — Shell, routing, viewport

Add after the bullet that starts "**Dark mode = class-based CSS remap, not `dark:` utilities.**":

- **Text on an accent or danger fill is `sl-on-fill` — not `text-white`, and not `text-ink-900` or `text-gray-900`.** White is 3.12:1 on `--color-accent` and 3.35:1 on `--color-danger`. The two dark text classes look right in the source and are not: `.dark .text-ink-900` and `.dark .text-gray-900` turn them into `ink-0`, cream, 2.94:1 on accent. `.sl-on-fill` (`src/index.css`, `@layer components`) is `var(--color-ink-900) !important`, which a layer makes stronger than the unlayered `!important` of the remaps; an inline `color: 'var(--color-ink-900)'` is the other spelling that holds. `src/test/contrast.test.js` recomputes the class against both fills, and `ui/ConfirmDialog.test.jsx` fails when the confirm button carries any other text colour.
- **Muted text is the token `--color-ink-400`, and its dark value lives in the `.dark` rule — never in a `.dark .text-ink-400` remap.** The token is read by the class, by `.sl-label`, by the `gray-400` remap, by inline styles and by chart fills; a class remap would move the first and leave the rest on `#807a6e`, which is under 4.5:1 on every dark surface. `src/test/contrast.test.js` fails on such a remap, and on any `.dark` rule that paints an ink background the token does not reach 4.5:1 on. A step darker than `ink-400` written inline (`var(--color-ink-500)` and beyond) is not remapped by anything and is not a text colour: `auth/LoginPage.test.jsx` holds the login page to that.
- **An id inside a component that can be mounted twice comes from `useId`.** `ui/Dialog` is mounted once per dialog of a page and renders its title whether it is open or not, so a literal id there is a duplicate id and `aria-labelledby` names the dialog after the first title in the document. `ui/Dialog.test.jsx` mounts two and three dialogs and fails on a shared id.

## CLAUDE.md — Repo map

Replace the line "static guards: ciGuardrails · docsSuite · authConfig · runbookIndex (.test.js)" with:

```
                 contrast.js (WCAG ratio of two colours; tokens and rules read from index.css)
                 static guards: ciGuardrails · docsSuite · authConfig · runbookIndex · contrast (.test.js)
```

## CLAUDE.md — Feature → files map, row "Theming (DARK-ONLY — no toggle)"

Add at the end of the row's cell:

Contrast: the dark value of the muted-text token (`--color-ink-400`, set in the `.dark` rule) and the text colour of an accent or danger fill (`.sl-on-fill`) are recomputed against the surfaces of `index.css` by `test/contrast.test.js`, with the helpers of `test/contrast.js`

## CLAUDE.md — When you add a feature

Add to the end of step 3, as a new sub-bullet:

   - A new `.dark` rule that paints a background of the ink scale is picked up by `src/test/contrast.test.js` by itself and must leave muted text (`ink-400`) at 4.5:1. A button that is an accent or danger fill writes its label with `sl-on-fill`; a component that can be mounted more than once takes its ids from `useId`. Run `npx vitest run src/test/contrast.test.js src/components/ui --maxWorkers=2`.
