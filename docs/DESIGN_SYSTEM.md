# Design System

An editorial, dark-first, accent-driven look. The whole thing is a handful of `sl-*` primitives defined in [src/index.css](../src/index.css) under `@layer components`, plus a small set of composition rules. Don't swap in ad-hoc `dark:` utilities or `text-gray-*` scales — use the primitives.

## Tokens

- **Fonts**: `--font-display` Archivo (headings, buttons), `--font-body` Inter, `--font-mono` JetBrains Mono (labels, meta, numbers, pills).
- **Palette**: a single warm `ink-*` scale from `ink-0` (cream) → `ink-950` (near-black). No cool gray. The scale flips class-by-class in dark mode (see "Dark mode" below).
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

// ✅ Do — action button in a page header
<button className="sl-pill bg-ink-100 text-ink-700 hover:bg-ink-200">Edit</button>
```

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

### Variants need their own remap line

The remap matches a **class name**, and Tailwind compiles every variant to a
*different* class name. `hover:bg-gray-50` is not `.bg-gray-50` — it is
`.hover\:bg-gray-50:hover`, which `.dark .bg-gray-50` cannot match. So a variant
of an otherwise-remapped utility silently keeps Tailwind's raw **light** value
and paints a near-white plate on a dark surface:

```jsx
// ❌ Wrong — the bare class is remapped, the hover variant is not.
//    Measured 1.02:1 under the pointer (UserMenu's sign-out row).
<button className="bg-white text-gray-900 hover:bg-gray-50">Sign out</button>

// ✅ Right — `hover:bg-ink-100` has a `.dark .hover\:bg-ink-100:hover` line. 16.04:1.
<button className="bg-white text-gray-900 hover:bg-ink-100">Sign out</button>
```

This bites `hover:`, `group-hover:` and `disabled:` alike — `disabled:bg-gray-50`
rendered a white dropdown on dark in `CopyDialog`. The **text** variants are the
nastier half: `hover:text-ink-700` *darkens* text on an already-dark surface, so
the label drops to 1.16:1 and disappears exactly when you point at it.

**The rule: a variant remaps to exactly what its bare class remaps to**, and the
line lives beside the bare rules at the bottom of [src/index.css](../src/index.css):

```css
.dark .bg-gray-50 { background-color: var(--color-ink-900) !important; }              /* bare */
.dark .hover\:bg-gray-50:hover { background-color: var(--color-ink-900) !important; } /* variant */
```

Two things are **not** covered, by design:

- **Opacity modifiers mint another class again** — `hover:bg-ink-50/50` compiles
  to `.hover\:bg-ink-50\/50:hover`. `CoachMessages` and `ConversationList` pair
  those with an explicit `dark:hover:bg-ink-800` companion instead.
- **Accent/semantic variants** (`hover:text-danger`, `focus:ring-primary`) are
  identical in both themes and need nothing.

When you add a `.dark .<utility>` line, grep `src` for that utility behind a
variant prefix and add the matching line in the same commit.

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

Per-screen roots use `p-4 pb-6 md:p-8`. Display headings scale:

- Coach h1s: `text-[28px] md:text-[40px]`
- Student h1s: `text-[32px] md:text-[44px]`

List screens (CoachHome roster, SessionsFeed, ExerciseLibrary) switch to a 2-column grid at `md:` via `space-y-* md:grid md:grid-cols-2 md:gap-* md:space-y-0`.

## Native `<dialog>` + dark mode

Native `<dialog>` follows the OS `prefers-color-scheme`, NOT the app's `.dark` class. The [ui/Dialog](../src/components/ui/Dialog.jsx) primitive has explicit `bg-white text-gray-900` on the `<dialog>` element so it routes through the class-based dark remaps in `index.css` (`.dark .bg-white` → `ink-850`, `.dark .text-gray-900` → `ink-0`).

**Don't remove these classes.** Without them, a user on a dark OS sees the dialog stay dark after flipping the app to light (and vice versa).

Related quirk: `disabled:bg-*` Tailwind variants generate `.disabled\:bg-gray-50:disabled`, but the dark override is on `.dark .bg-gray-50` — different selector, so the disabled element stays light in dark mode. Use `disabled:bg-ink-100` (or another `ink-*` token) for disabled-state backgrounds inside anything that lives on a dark surface (dialogs, cards).

## iOS 16px input rule

iOS Safari auto-zooms focused `<input>` / `<textarea>` / `<select>` whose font-size is `< 16px`. **Every text-entry form element in the app is 16px** for that reason. Don't drop any of them below 16px. File pickers, radios, checkboxes, and sliders aren't affected.

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

## Quick reference

| Want | Use |
|---|---|
| h1 / h2 / big number | `sl-display` |
| kicker above a heading, section title | `sl-label` |
| counters, timestamps, meta | `sl-mono` |
| a surface | `sl-card` |
| status chip or compact action | `sl-pill` |
| full-width primary CTA | `sl-btn-primary` |
| compact CTA inside a form/card | `sl-btn-primary text-[13px]` + `style={{ padding: '10px 16px' }}` |
| muted text color | `text-ink-400` (class, not inline) |
| primary text color | `text-gray-900` or `text-ink-800` (class, not inline) |
| callout background | `color-mix(in srgb, var(--color-accent) 10%, transparent)` |
