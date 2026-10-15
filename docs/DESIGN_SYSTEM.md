# Design System

An editorial, dark-first, accent-driven look. The whole thing is a handful of `sl-*` primitives defined in [src/index.css](../src/index.css) under `@layer components`, plus a small set of composition rules. Don't swap in ad-hoc `dark:` utilities or `text-gray-*` scales — use the primitives.

## Tokens

- **Fonts**: `--font-display` Archivo (headings, buttons), `--font-body` Inter, `--font-mono` JetBrains Mono (labels, meta, numbers, pills).
- **Palette**: a single warm `ink-*` scale from `ink-0` (cream) → `ink-950` (near-black). No cool gray. The scale flips class-by-class in dark mode (see "Dark mode" below).
- **Muted text**: `ink-400`, and it is the one step of the scale whose dark value sits on the token. `@theme` gives `--color-ink-400: #807a6e`; the `.dark` rule of [src/index.css](../src/index.css) sets it to `#948e82`. Every reader of the token follows — `text-ink-400`, `.sl-label`, the `.dark .text-gray-400` remap, `placeholder:text-ink-400`, an inline `var(--color-ink-400)`, the chart fills — with no class remap, which would reach the class and nothing else. The dark value is at least 4.5:1 on every ink surface the theme paints: 5.80 on the page (`ink-900`), 5.51 on a card or a dialog (`ink-850`), 5.23 on a pill or an input (`ink-800`), 4.76 on a pressed or hovered pill (`ink-700`). It stays darker than `ink-300`, the step `text-ink-500` is drawn in, so muted and secondary copy remain two levels.
- **Contrast is tested**: `src/test/contrast.test.js` recomputes the WCAG ratios from the stylesheet — the tokens of `@theme`, what `.dark` sets on top, and every `.dark` rule that paints a background of the ink scale, so a surface remapped later is held to 4.5:1 without being listed. `src/test/contrast.js` holds the arithmetic and the reader (`contrastRatio`, `readTokens`, `declared`, `resolveColour`, `AA_TEXT`) for any other test that asks whether a token can be read on a surface. `mixOver(top, alpha, bottom)` gives what a tint is on the surface behind it — `bg-push/15` on a card is `#3a2117` — for a test that asks whether a colour can be read on its own tint.
- **Accent**: `--color-accent: #ff5a1f`.
- **Semantic**: `--color-success` (lime), `--color-warn` (amber), `--color-danger` (red).

## The `sl-*` primitives

### `sl-display` — headings and numeric callouts

Archivo 800, tight leading, negative letter-spacing. Use for h1, h2, and anywhere a number is the hero.

```jsx
// ✅ Do — page title
<h1 className="sl-display text-[28px] text-gray-900">Week 3</h1>

// ✅ Do — big numeric metric
<div className="sl-display text-[40px]">128<span className="text-ink-400 text-[20px]">kg</span></div>

// ❌ Don't — don't use sl-display for long running copy; it's a display face
<p className="sl-display">This paragraph will look wrong set in Archivo 800.</p>
```

### `sl-label` — kickers and section titles

Mono 10px, uppercase, wide tracking, colored `ink-400`. **Values are stored title-case** (`"Program"`, `"Home"`); the class uppercases via CSS. Tests read the title-case DOM text; users see uppercase.

```jsx
// ✅ Do — kicker above an h1
<div className="sl-label">Program</div>
<h1 className="sl-display text-[24px]">Push / Pull Split</h1>

// ❌ Don't — don't uppercase in JS; the CSS already does it
<div className="sl-label">{t('nav.home').toUpperCase()}</div>
```

### `sl-mono` — meta, numbers, counters

JetBrains Mono with tabular figures (`font-feature-settings: "tnum"`) so numeric columns align. Use for timestamps, counters, progress text.

```jsx
// ✅ Do — numeric counter that must align across rows
<span className="sl-mono text-[11px] text-ink-400">3 of 12 sets</span>

// ❌ Don't — running body copy
<p className="sl-mono">This is just narrative prose.</p>
```

### `sl-card` — the surface

White + hairline shadow in light mode; solid `ink-850` with no shadow in dark mode. That's the *whole* recipe — no border, no ring, no manual `dark:` override needed.

```jsx
// ✅ Do
<div className="sl-card p-4">…</div>

// ❌ Don't — if you add your own bg or dark: you'll fight the class-based remap
<div className="sl-card bg-white dark:bg-zinc-900">…</div>
```

### `sl-pill` — chips, tags, small action buttons

Rounded-full, mono 10px uppercase. Use for status chips ("START", "DONE", "ARCHIVED"), filter pills, and right-aligned page-header actions.

```jsx
// ✅ Do — status pill
<span className="sl-pill" style={{ background: 'var(--color-accent)', color: 'var(--color-ink-900)' }}>
  {t('common.start')}
</span>

// ✅ Do — a pill that is a button: 44px, see "44px targets" below
<button className="sl-pill sl-pill-btn bg-ink-100 text-ink-700 hover:bg-ink-200">Edit</button>

// ❌ A bare pill as a button is 23px high
<button className="sl-pill bg-ink-100 text-ink-700 hover:bg-ink-200">Edit</button>
```

### 44px targets — `sl-pill-btn` and `sl-hit`

Anything pressed is 44px in both directions at least: the app is used one-handed between two sets. Two classes carry that size, for the two kinds of control.

**`sl-pill-btn`** — a pill that is a button grows. Beside `sl-pill`: `min-height` and `min-width` 44px, the label centred, `padding-inline: 14px`. The label stays the pill's 10px.

```jsx
// ✅ 56×44 for a short label
<button className="sl-pill sl-pill-btn bg-ink-100 text-accent hover:bg-ink-200">Undo</button>

// ✅ a one-character pill: the utility wins over the class's padding → 44×44
<button className="sl-pill sl-pill-btn bg-ink-100 text-ink-500 px-2" aria-label="Remove">✕</button>
```

**`sl-hit`** — a control that must stay as small as it is drawn (a 16px close icon, a ⋯ in a dense row) keeps its box and gets a larger area to press: a pseudo-element centred on it, 44px at least and never smaller than the control. Nothing around it moves.

```jsx
// ✅ the icon stays 16×16; a press up to 22px from its centre is a press on it
<button className="sl-hit shrink-0 text-ink-400 hover:text-gray-900" aria-label={t('common.dismiss')}>
  <svg className="w-4 h-4" …/>
</button>
```

Three things to know about `sl-hit`:

- **It uses `::after`.** Do not combine it with `after:` utilities on the same element (the stretched link of a roster card, `after:absolute after:inset-0`, is one).
- **An ancestor with `overflow: hidden` cuts the area** where it passes the ancestor's edge.
- **Two `sl-hit` controls nearer than 44px overlap**, and the later one in the document takes the press where they meet. Leave 14px between a 16px `sl-hit` icon and the next control (`gap-4`), as `ui/ToastHost` does.

Both classes stand in `@layer components` and neither is `!important`: a utility beside them (`px-2`, `w-full`, `min-w-0`) wins. `src/test/hitTargets.test.js` holds the two classes to 44px in the stylesheet — jsdom has no layout, so a component test can only check that the class is on the control.

Used by `ui/ToastHost` (the action pill and the dismiss icon).

### `sl-btn-primary` — the accent CTA

Accent-filled, Archivo 800, 16×20 padding. That's the full-width checkout CTA.

For tighter contexts (inline forms, inside cards) use the established **compact override**:

```jsx
// ✅ Do — standard full-width CTA
<button className="sl-btn-primary w-full">Confirm session</button>

// ✅ Do — compact variant (inside a card, next to other form fields)
<button
  className="sl-btn-primary text-[13px]"
  style={{ padding: '10px 16px' }}
>
  Save
</button>
```

This compact pattern is used in `SessionCard`, `ExerciseLibrary`'s `ExerciseForm`, and `SessionView`'s Confirm-session card. Don't invent new button sizes — pick the full CTA or the compact override.

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

## Dark mode — class-based remap only

**The app is dark-only — there is no toggle.** `class="dark"` ships on `<html>` in [index.html](../index.html) so the first paint is already dark, and `ThemeProvider` only re-asserts it. An installed iOS PWA colours its status bar from the manifest's single static `theme_color`, so a light theme could never match the strip once the app leaves Safari; the toggle was shipping a guaranteed mismatch for half its users.

The light utilities still matter, because dark mode is implemented as **class selectors that remap them** (see the bottom half of [src/index.css](../src/index.css)) — keep writing components against `bg-white` / `text-gray-900` and let the remap do the work:

```css
.dark .text-gray-900 { color: var(--color-ink-0) !important; }
.dark .bg-white      { background-color: var(--color-ink-850) !important; }
.dark .border-gray-200 { border-color: var(--color-ink-700) !important; }
/* …and so on for every gray-*/ink-* class the app uses */
```

This means:

- **Class-based colors flip for free.** `text-gray-900`, `text-ink-700`, `bg-white`, `border-gray-200` — all remapped.
- **Inline `style={{ color: ... }}` does NOT flip.** The `.dark` selector has nothing to target.

```jsx
// ❌ Wrong — this stays dark-on-light in dark mode
<p style={{ color: 'var(--color-ink-800)' }}>Hello</p>

// ✅ Fix — use the class
<p className="text-ink-800">Hello</p>
```

**When inline `style` is OK**: colors that intentionally stay the same in both themes (accent, success, warn, danger), or `color-mix()` backgrounds/borders that don't need flipping.

```jsx
// ✅ Fine — accent and semantic colors are identical in both themes
<div style={{ background: 'var(--color-accent)', color: 'var(--color-ink-900)' }}>…</div>

// ✅ Fine — color-mix tints read correctly on both surfaces
<div style={{ background: 'color-mix(in srgb, var(--color-success) 10%, transparent)' }}>…</div>
```

One token carries its dark value itself, and is the exception to "inline does not flip": `var(--color-ink-400)`, the muted-text step (see "Tokens"). Every other step of the scale written inline is the value of `@theme`, so `var(--color-ink-500)` and darker are never a text colour on a dark surface — `ink-500` is 2.59:1 on `ink-900`.

## Editorial page header

There is **no `<Header/>` component** — every page builds its own header from primitives. The canonical shape:

1. Back button on the left (`w-9 h-9 rounded-lg bg-ink-100 text-ink-700`), chevron inside.
2. Centered meta: `sl-label` kicker ("WEEK 1 · MON") over `sl-display` h1.
3. Right-aligned `sl-pill` action buttons (Edit, Archive, etc.) or a 9×9 spacer for balance.

```jsx
<div className="flex items-center justify-between gap-3 pt-3 pb-4">
  <button className="w-9 h-9 rounded-lg bg-ink-100 text-ink-700 flex items-center justify-center">
    <ChevronLeft />
  </button>
  <div className="min-w-0 text-center">
    <div className="sl-label truncate">Week 1 · Mon</div>
    <div className="sl-display text-[16px] text-gray-900 truncate">Upper 1</div>
  </div>
  <div className="flex items-center gap-2">
    <button className="sl-pill bg-ink-100 text-ink-700">Edit</button>
  </div>
</div>
```

Pages with a user menu instead (`StudentTraining`, `CoachHome`) swap the back button for an avatar-initials popover containing the language selector + Sign out — but the overall 3-zone rhythm is the same.

Every top-level page (both coach & student: Athletes, Sessions, Library, Training, Stats, Goals) renders `ui/UserMenu` as the right-aligned action — wrap the header in `flex items-start justify-between gap-4`.

## Responsive layout

The shell + nav structure lives in `layout/AppShell` + `SideNav` + `BottomNav`:

- **Mobile** (`< 768px`): `flex-col`, sticky `BottomNav` at the bottom.
- **`md:` and up** (`≥ 768px`): shell becomes `flex-row`. `BottomNav` gets `md:hidden`; `SideNav` (`hidden md:flex w-56`) becomes the left rail.

Both nav components share their item list via `layout/navItems.getNavItems(role, t)` — one place to edit tabs.

Content inside `main` is wrapped in `mx-auto w-full max-w-5xl` so it caps around ~1024px on wide monitors.

**Sticky inside `main` is `top: 0`.** `main` is the one box that scrolls, and it pads its top by `env(safe-area-inset-top)`. A sticky box is held inside the *content* box of its scroller, so `top: 0` is the inner edge of that padding: just below the notch, where the element already sits before any scroll. `top: 'env(safe-area-inset-top)'` adds the inset a second time and drops the element onto the page's header. [`ui/OfflineBanner`](../src/components/ui/OfflineBanner.jsx) is the one sticky element of `main`: `zIndex: 40`, over the popovers of a page (`z-10` to `z-30`) and under the toasts (`z-50`).

Per-screen roots use `p-4 pb-6 md:p-8`. Display headings scale:

- Coach h1s: `text-[28px] md:text-[40px]`
- Student h1s: `text-[32px] md:text-[44px]`

List screens (CoachHome roster, SessionsFeed, ExerciseLibrary) switch to a 2-column grid at `md:` via `space-y-* md:grid md:grid-cols-2 md:gap-* md:space-y-0`.

## Native `<dialog>` + dark mode

Native `<dialog>` follows the OS `prefers-color-scheme`, NOT the app's `.dark` class. The [ui/Dialog](../src/components/ui/Dialog.jsx) primitive has explicit `bg-white text-gray-900` on the `<dialog>` element so it routes through the class-based dark remaps in `index.css` (`.dark .bg-white` → `ink-850`, `.dark .text-gray-900` → `ink-0`).

**Don't remove these classes.** Without them, a user on a dark OS sees the dialog stay dark after flipping the app to light (and vice versa).

**The title names the dialog through an id from `useId`.** A page mounts its dialogs once and opens them later, and a closed `Dialog` still renders its `<h2>` (only `children` wait for `open`). A fixed id would be in the document once per dialog, and `aria-labelledby` would resolve to the first of them: the destructive question read out under the title of another dialog. `ui/Dialog` therefore takes one id per instance from `useId` and points `aria-labelledby` at it; without a `title` it carries no `aria-labelledby`. Anything else a dialog needs to reference inside itself gets its id the same way.

Related quirk: `disabled:bg-*` Tailwind variants generate `.disabled\:bg-gray-50:disabled`, but the dark override is on `.dark .bg-gray-50` — different selector, so the disabled element stays light in dark mode. Use `disabled:bg-ink-100` (or another `ink-*` token) for disabled-state backgrounds inside anything that lives on a dark surface (dialogs, cards).

## iOS 16px input rule

iOS Safari auto-zooms focused `<input>` / `<textarea>` / `<select>` whose font-size is `< 16px`. **Every text-entry form element in the app is 16px** for that reason. Don't drop any of them below 16px. File pickers, radios, checkboxes, and sliders aren't affected.

## Typed numbers — `DecimalInput`

A number a person types — a weight, reps, seconds — is [`DecimalInput`](../src/components/ui/DecimalInput.jsx), never `<input type="number">`. A number field reads "82,5" by the language of the **browser**: 825 in a Chromium whose UI is English, `""` in WebKit, which a caller then stores as null. `DecimalInput` is a text field (`type="text"`, `inputMode="decimal"`, a `pattern`, 16px) that keeps the text as typed, comma or point, and [`parseDecimalInput`](../src/lib/number.js) is the one reader of it.

```jsx
// The caller holds the TEXT, as with any controlled input…
const [weight, setWeight] = useState(decimalText(log.target_weight_kg));

<DecimalInput
  value={weight}
  onChange={(e) => setWeight(e.target.value)}
  aria-label={t('coach.slot.setWeightAria', { n })}
  className={inputCls}
/>

// …and reads the number when it commits.
const parsed = parseDecimalInput(weight);
if (!parsed.ok) return setError(t('uiSharedHelpers.decimalInvalid')); // never write on garbage
save(parsed.value); // null only for an empty field
```

- **Props**: `value` (the text; a number is shown as its text), `onChange(event, parsed)` — the native event, then `parseDecimalInput` of the new text under the field's rules — and the rules: `min`, `max` (inclusive), `allowEmpty` (default `true`), `integer` (whole numbers, with the numeric keypad). `invalid` marks the field from outside. Everything else reaches the `<input>`: `aria-label`, `id`, `placeholder`, `disabled`, `onBlur`, `autoFocus`, `ref`, `className`.
- **Hold the text, not the number.** A caller that stores `parsed.value` loses the separator while it is typed ("82," is 82). `decimalText(stored)` gives the text a field starts with; it is for seeding state, not for the text being typed.
- **The field draws no message.** Text that is not a number of the caller's range sets `aria-invalid="true"` and a `title` (`uiSharedHelpers.decimalInvalid`, or `uiSharedHelpers.integerInvalid`). Its callers sit in table cells and one-line rows and say what went wrong where they have room.
- **An empty field that needs an answer** (`allowEmpty={false}`) is not marked until the caller passes `invalid`.
- **Inside a `<form>`** the `pattern` makes the browser refuse the submit with its own message. A form that shows its own alert is `noValidate`.
- **`className` replaces the default look** (the app's bordered mono field); `text-[16px]` is added to it either way.

What `parseDecimalInput` accepts: one optional separator, comma or point, with digits on at least one side — "82", "82,5", "82.5", ",5", "82," — and spaces around it. It refuses "abc", "82kg", "1e3", "1,000.5", "8 2" and "-5" (`reason: 'format'`), a number outside `min`/`max` (`'range'`), and an empty field when `allowEmpty` is `false` (`'empty'`). It never repairs.

Not yet on it — still `type="number"`: `student/SetRow` (actual reps and weight), `coach/ExerciseSlotRow` (reps, seconds, weight, rest), `student/BodyweightCard`, `student/StudentProgramAuthor` (`NumberField`), `student/MyGoals`, `coach/StudentGoalsSection`, `coach/ExerciseLibrary`.

## Toasts

[`pushToast`](../src/lib/toast.js) shows a transient line at the bottom of the screen; [`ui/ToastHost`](../src/components/ui/ToastHost.jsx), mounted once in `AppShell`, draws the stack.

```js
pushToast('errors.generic');                       // an error (the default kind): role="alert"
pushToast(t('…'), { kind: 'info' });               // anything else: role="status"

pushToast(t('…'), {                                // one action
  kind: 'info',
  action: { label: 'uiSharedHelpers.undo', onClick: () => restore(set) },
});
```

- **`message` and `action.label` are an i18n key or a finished sentence.** The host resolves a key; there are no parameters, so a sentence with a value in it is translated by the caller.
- **One action per toast.** The host calls `onClick` once — a second tap before the toast is gone calls nothing — then closes the toast, also when the action throws. A toast that runs out or is dismissed calls nothing: the action is a way back, never the thing that commits.
- **A toast stops its clock while it is under the pointer or holds the focus**, and starts again with what was left, two seconds at least. It stays 6 s, 8 s with an action.
- **Plain toasts merge on (kind, message); toasts with an action never do** — two "Set removed" undo two different sets. The store keeps the three newest on screen.
- **Look**: the action is `sl-pill sl-pill-btn bg-ink-100 text-accent hover:bg-ink-200` — accent on the pill's surface is 5.46:1, 4.97:1 hovered; `ui/ToastHost.test.jsx` recomputes both. The dismiss icon is `sl-hit`.

## Inline edit — the field must occupy the button's footprint

[`EditableText`](../src/components/ui/EditableText.jsx) swaps a `<button>` for an `<input>` in place, so the swap has to be invisible in every dimension but colour. An `<input>` defaults to roughly **20 characters wide and ignores its container** — left alone it overflowed every caller (measured: 45px past its slot on a coach phase divider, 61px in the session editor), sliding the orange box under the sibling meta and the ⋯ menu.

The base input therefore carries `w-[calc(100%+0.5rem)] -mx-1 px-1`, which reproduces the resting button's own `px-1 -mx-1` bleed **exactly**: same footprint, and the text start moves by the 1px border rather than ~9px. `leading-tight` keeps the 16px floor from growing the row it sits in.

Two rules when adding a call site:

- **A heading taller than 16px must pass its own size** via `inputClassName` (e.g. `sl-display text-[20px]`), or the field falls back to the 16px floor and the title visibly shrinks on tap. `SessionEditor` and `StudentProfile` both do this.
- **Don't pass `w-full`** — it collides with the base width utility, and which one wins is decided by stylesheet order, not by the order of the strings.

## Tinted surfaces — the `color-mix` recipe

For callouts, banners, and "about-this" panels, use a **transparent tint of a semantic color over the current surface** rather than picking a new hex.

```jsx
<div style={{
  background: 'color-mix(in srgb, var(--color-accent) 10%, transparent)',
  borderLeft: '3px solid var(--color-accent)',
}}>
  …
</div>
```

Same recipe for success/warn/danger. The 10% mix reads correctly on both `bg-white` and `ink-850`, which means the panel auto-adapts to dark mode without a second rule. Use this instead of `bg-orange-50 dark:bg-orange-950` ladders.

When to reach for it:

- **Student-note callouts** on coach review screens.
- **Confirmation banners** (success-tinted).
- **Warning/archive strips** (warn-tinted).
- Anywhere you'd otherwise hand-pick a pastel.

## Exercise type badge — `TypeBadge`

The pill that says what type an exercise is comes from [`TypeBadge`](../src/components/ui/TypeBadge.jsx), and its colour and name from the list in [`lib/exerciseTypes.js`](../src/lib/exerciseTypes.js).

```jsx
// ✅ Do
<TypeBadge type={ex.type} />
<TypeBadge type={ex.type} className="shrink-0" />

// ❌ Every type that is not pull is drawn as a push, under the raw value of the column
<span className={`sl-pill ${ex.type === 'pull' ? 'bg-pull/15 text-pull' : 'bg-push/15 text-push'}`}>{ex.type}</span>
```

- A listed type is drawn in its own tint and named in the language of the app (`coach.library.typePull`, `coach.library.typePush`).
- A type the list does not have is a neutral pill (`bg-ink-100 text-ink-500`) under its own id. No type draws nothing.
- `EXERCISE_TYPES` is also the source of a type `<select>` — `exerciseTypeLabel(type.id, t)` for the option's text — and of a chart's colour (`type.color`, a `var(--color-…)`).

**Adding a type**: an entry in `EXERCISE_TYPES` with its classes written out in full (`'bg-legs/15 text-legs'` — Tailwind finds classes by reading the file as text), and its token `--color-legs` in the `@theme` of `src/index.css`. `src/lib/exerciseTypes.test.js` then holds the entry to four things: an id the `exercise_type` enum of `supabase/schema.sql` has, a name in the three languages, a token that `.dark` does not remap, and 4.5:1 for that colour on its own 15% tint over a card, a dialog row and the page (push: 4.78:1 on a card; pull: 7.42:1).

Not yet on it — still the hand-written ternary: `coach/SessionReview`, `coach/ExerciseLibrary`, `student/SlotDeviationBar`, `student/StudentProgramAuthor`.

## Quick reference

| Want | Use |
|---|---|
| h1 / h2 / big number | `sl-display` |
| kicker above a heading, section title | `sl-label` |
| counters, timestamps, meta | `sl-mono` |
| a surface | `sl-card` |
| status chip, tag, filter pill | `sl-pill` |
| a pill that is a button | `sl-pill sl-pill-btn` (44px) |
| a small icon button | `sl-hit` on the button (44px area, same box) |
| full-width primary CTA | `sl-btn-primary` |
| compact CTA inside a form/card | `sl-btn-primary text-[13px]` + `style={{ padding: '10px 16px' }}` |
| text on an accent or danger fill | `sl-on-fill` (never `text-white`, `text-ink-900` or `text-gray-900`) |
| a number a person types | `<DecimalInput>` + `parseDecimalInput` (never `type="number"`) |
| an exercise's type | `<TypeBadge type={ex.type} />` |
| a line that confirms, with a way back | `pushToast(message, { kind: 'info', action: { label, onClick } })` |
| a date, a number, a day name, a plural | `lib/i18n/format.js`, with `lang` from `useI18n` |
| a page's back button | `useBackOr(fallback)` |
| muted text color | `text-ink-400` — or `var(--color-ink-400)` inline, the one ink step whose dark value is on the token |
| primary text color | `text-gray-900` or `text-ink-800` (class, not inline) |
| callout background | `color-mix(in srgb, var(--color-accent) 10%, transparent)` |
