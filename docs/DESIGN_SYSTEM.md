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

Dark mode is a `.dark` class on `<html>`, and the theme is implemented as **class selectors that remap common utilities** (see the bottom half of [src/index.css](../src/index.css)):

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

Pages with a user menu instead (`StudentHome`, `CoachDashboard`) swap the back button for an avatar-initials popover containing `ThemeToggle` + Sign out — but the overall 3-zone rhythm is the same.

Every top-level page (both coach & student: Dashboard, Students, Sessions, Library, Home, Stats, Goals) renders `ui/UserMenu` as the right-aligned action — wrap the header in `flex items-start justify-between gap-4`.

## Responsive layout

The shell + nav structure lives in `layout/AppShell` + `SideNav` + `BottomNav`:

- **Mobile** (`< 768px`): `flex-col`, sticky `BottomNav` at the bottom.
- **`md:` and up** (`≥ 768px`): shell becomes `flex-row`. `BottomNav` gets `md:hidden`; `SideNav` (`hidden md:flex w-56`) becomes the left rail.

Both nav components share their item list via `layout/navItems.getNavItems(role, t)` — one place to edit tabs.

Content inside `main` is wrapped in `mx-auto w-full max-w-5xl` so it caps around ~1024px on wide monitors.

Per-screen roots use `p-4 pb-6 md:p-8`. Display headings scale:

- Coach h1s: `text-[28px] md:text-[40px]`
- Student h1s: `text-[32px] md:text-[44px]`

List screens (CoachHome, CoachDashboard activity, SessionsFeed, ExerciseLibrary) switch to a 2-column grid at `md:` via `space-y-* md:grid md:grid-cols-2 md:gap-* md:space-y-0`.

## Day-strip vertical titles

`StudentHome`'s 7-column day strip is narrow enough that horizontal session titles wrap. The strip titles use:

```css
writing-mode: vertical-rl;
transform: rotate(180deg);
```

…so titles read top-to-bottom without wrapping.

## Native `<dialog>` + dark mode

Native `<dialog>` follows the OS `prefers-color-scheme`, NOT the app's `.dark` class. The [ui/Dialog](../src/components/ui/Dialog.jsx) primitive has explicit `bg-white text-gray-900` on the `<dialog>` element so it routes through the class-based dark remaps in `index.css` (`.dark .bg-white` → `ink-850`, `.dark .text-gray-900` → `ink-0`).

**Don't remove these classes.** Without them, a user on a dark OS sees the dialog stay dark after flipping the app to light (and vice versa).

Related quirk: `disabled:bg-*` Tailwind variants generate `.disabled\:bg-gray-50:disabled`, but the dark override is on `.dark .bg-gray-50` — different selector, so the disabled element stays light in dark mode. Use `disabled:bg-ink-100` (or another `ink-*` token) for disabled-state backgrounds inside anything that lives on a dark surface (dialogs, cards).

## iOS 16px input rule

iOS Safari auto-zooms focused `<input>` / `<textarea>` / `<select>` whose font-size is `< 16px`. **Every text-entry form element in the app is 16px** for that reason. Don't drop any of them below 16px. File pickers, radios, checkboxes, and sliders aren't affected.

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
