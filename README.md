# Street Lifting Coach (sl_app)

A mobile-first React application for coaches and students to plan, track, and execute street-lifting / calisthenics training programs. Coaches design multi-week programs (weeks → sessions → exercise slots); students log sets, reps, weight, RPE, and completion.

Deployed to GitHub Pages: https://tamachiii.github.io/sl_app/

---

## Tech Stack

| Layer | Library |
|---|---|
| UI framework | React 19 |
| Build tool | Vite 6 |
| Styling | Tailwind CSS 4 (`@tailwindcss/vite`) |
| Routing | React Router 7 (`HashRouter` — works on GitHub Pages without server rewrites) |
| Data layer | TanStack React Query 5 |
| Backend | Supabase (Postgres + Auth + RLS) |
| Testing | Vitest + @testing-library/react + jsdom |
| Deployment | `gh-pages` → GitHub Pages (base path `/sl_app/`) |

---

## Quick Start

### 1. Install
```bash
npm install
```

### 2. Configure env
Create `.env` (gitignored):
```
VITE_SUPABASE_URL=https://<project>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon-key>
```
See `.env.example`.

### 3. Database
Apply `supabase/schema.sql` to a fresh Supabase project (creates tables, RLS policies, and a trigger that auto-creates a `profiles` row on signup).

### 4. Run
```bash
npm run dev       # dev server
npm run build     # production build → dist/
npm run preview   # serve dist/
npm test          # run vitest (~130 tests)
npm run deploy    # publishes dist/ to gh-pages branch
```

---

## Directory Structure

```
src/
  App.jsx                      # Top-level providers (Theme, QueryClient, Auth, Router)
  main.jsx                     # Entry point
  routes.jsx                   # React.lazy + Suspense route table
  index.css                    # Tailwind import + dark-theme CSS overrides
  lib/
    supabase.js                # Supabase client (singleton)
    queryClient.js             # Shared React Query client
    volume.js                  # computeSessionVolume() — aggregates pull/push volume
  hooks/
    useAuth.jsx                # AuthProvider + useAuth (session, profile, role)
    useTheme.jsx               # ThemeProvider + useTheme (light/dark, localStorage-backed)
    useProgram.js              # Student → program/weeks queries + mutations
    useWeek.js                 # Week + sessions (incl. useUpdateWeek, useUpdateSession)
    useSession.js              # Session + exercise_slots queries/mutations
    useExerciseLibrary.js      # CRUD for coach's exercise library
    useDuplicate.js            # Duplicate week / duplicate session server-side logic
    useStudents.js             # Coach's student list
    useSetLogs.js              # Student set-logging mutations
    useSessionConfirmation.js  # Confirmations (student + coach hooks incl. useAllConfirmations)
    useStudentProgressStats.js # Aggregated stats for the Student Dashboard
  components/
    auth/LoginPage.jsx
    layout/
      Header.jsx               # Sticky top bar (back button, title, actions, ThemeToggle)
      BottomNav.jsx            # Role-aware bottom tabs + sign out
    coach/
      CoachHome.jsx            # Student list (greeting card with role+name tooltip)
      StudentCard.jsx          # Student card with WeekTimeline
      WeekTimeline.jsx         # W1/W2/... pills + "+ Week" (drag-and-drop reordering via @dnd-kit)
      WeekView.jsx             # Sessions list (inline-editable labels & titles)
      SessionEditor.jsx        # Exercise slots + add/duplicate (inline-editable title)
      ExerciseSlotRow.jsx      # Per-slot sets/reps/weight + reorder/delete
      ExerciseLibrary.jsx      # Coach's exercise CRUD
      VolumeBar.jsx            # Stacked pull/push volume bar
    student/
      StudentHome.jsx          # Home tab: greeting card (role+name tooltip, today status) + 7-day strip + next session preview + upcoming/completed
      SessionCard.jsx          # Expandable session card (used by Home & Sessions)
      StudentSessions.jsx      # Sessions tab: full program session picker
      StudentDashboard.jsx     # Stats tab (/student/stats): progress + per-exercise weekly tonnage chart
      ExerciseProgressChart.jsx # SVG line/bar chart of Σ(sets×reps×weight) per week for a selected exercise
      SessionView.jsx          # Runs through the session (SetRow per set); exercises in collapsible cards
      SetRow.jsx               # Weight/reps/RPE/done per set
      RpeInput.jsx             # 1-10 RPE picker
    ui/
      EditableText.jsx         # Click-to-edit text (Enter/blur commit, Esc cancel)
      ThemeToggle.jsx          # Sun/moon button
      Dialog.jsx, Spinner.jsx, EmptyState.jsx
      CopyDialog.jsx           # Shared dialog for copying weeks/sessions
      ConfirmDialog.jsx        # Shared confirmation dialog
      ErrorBoundary.jsx        # React ErrorBoundary wrapper
  test/
    setup.js                   # jest-dom + matchMedia polyfill
    utils.jsx                  # renderWithProviders() — wraps Theme + Query + Auth + Router
supabase/schema.sql            # Tables, RLS, signup trigger
public/
  manifest.json                # PWA manifest
  favicon.svg
```

---

## Domain Model

### Coach Dashboard

`CoachDashboard` is the coach's landing page (`/coach/dashboard`). It shows:
- **Students** — compact list; each row links to the per-student confirmation history.
- **Recent Activity** — the 5 most recent non-archived confirmed sessions across all students, linking directly to `SessionReview`.

### Sessions feed

`SessionsFeed` (`/coach/sessions`) aggregates confirmed sessions from all students in a single reverse-chronological list. Each card shows the student's name, session title, week/day context, timestamp and optional notes. Archived sessions are hidden behind a toggle. Data comes from `useAllConfirmations` (three Supabase round-trips, RLS-scoped to the coach).

---

## Domain Model

```
profiles (id, role: 'coach'|'student', full_name)
  ↓ 1:many (coach_id)
programs (id, coach_id, student_id, title)
  ↓ 1:many
weeks (id, program_id, week_number, label)
  ↓ 1:many
sessions (id, week_id, title, day_number, sort_order)
  ↓ 1:many                                ↓ 1:1
exercise_slots (…, notes, record_video_set_numbers)  session_confirmations (session_id UNIQUE, student_id, confirmed_at, notes)
  → exercise_library (…)
  ↓ 1:many
set_logs (…)
```

RLS:
- Coaches read/write their own rows; students read the program/weeks/sessions assigned to them and write their own `set_logs`.
- `session_confirmations`: students manage only their own confirmations for their own sessions; coaches have read-only access to confirmations for sessions in their students' programs.

### Session confirmations

Students tap **Confirm session** at the bottom of `SessionView` (with an optional note) to mark a session as completed. Coaches see a green "Confirmed" badge on the session card in `WeekView`, and can open **Confirmed sessions** from any student card for a chronological list with notes and timestamps. Students can undo a confirmation; coaches cannot edit confirmations (read-only).

### Exercise Library search & filter

The Library tab (`ExerciseLibrary`) shows a **search bar** and **type filter pills** (All / Pull / Push) whenever the library has at least one exercise. Both filters are applied client-side via `useMemo` — no extra queries. When no exercises match, an "No exercises match your search" empty state is shown. The search bar and pills are hidden on an empty library to keep the add-first flow clean.

### Student Dashboard

`StudentDashboard` (`/student/dashboard`) gives the student a one-page view of their own progress, fed by a single `useStudentProgressStats` hook that joins programs → weeks → sessions → slots → exercise library with their set logs and confirmations:

- **Summary cards**: sessions confirmed / total (with %), sets done / prescribed, weeks active / total, average RPE across logged sets.
- **Calendar**: month grid (Monday-first) with prev/next arrows, green dot for completed sessions and orange dot for upcoming on days with a `scheduled_date`. Tapping a day opens its first session.
- **Weekly volume**: per-week stacked pull/push bar scaled to the busiest week. Uses `computeSessionVolume` from `lib/volume`.
- **Recent activity**: last 5 confirmations, each linking back to the session.

An "Empty state" is shown when no program is assigned yet. The tab lives alongside Home and Goals on the student bottom nav.

### Week reordering

Each week pill in `WeekTimeline` has a drag handle (6-dot grip). Coaches can drag weeks into any order; dropping commits via `useReorderWeeks`, which rewrites `week_number` in two passes (park all at temp numbers, then assign finals) to dodge the `UNIQUE(program_id, week_number)` constraint. The pill's label area still navigates to the week view — only the grip triggers drag. On touch, drag activates after a 200ms press so taps aren't captured. The local order updates optimistically for instant feedback.

### Coach exercise notes

Coaches can add a free-text note to any exercise slot while planning a session (via `ExerciseSlotRow` in `SessionEditor`). Notes are stored in `exercise_slots.notes`. Students see the note as a blue info callout above their `SlotCommentBox` when executing the session in `SessionView`. No migration needed — the column already existed in the schema.

### Record-video set flag

For any exercise, the coach can pick **any number** of sets to record on video via per-set chips in `ExerciseSlotRow` (tap a chip to toggle; "All" / "None" shortcut toggles every set at once). The selection is stored as an `int[]` in `exercise_slots.record_video_set_numbers` (migration `2026_04_20_record_video_set_numbers.sql`, defaults to `{}`). Students see an amber "Record" badge on each matching `SetRow` in `SessionView`, so it's obvious which sets they should film for coach review.

---

## Roles & Flows

**Coach**
1. Logs in → redirected to `CoachDashboard` (student list + recent confirmations feed)
2. **Students tab** (`/coach/students`) — student cards with `WeekTimeline`; tap a week → `WeekView`; create/duplicate sessions; open `SessionEditor` to manage exercise slots; manage `ExerciseLibrary`
3. **Sessions tab** (`/coach/sessions`) — all students' confirmed sessions in one feed (`SessionsFeed`), newest first; tap any card to open `SessionReview`
4. **Library tab** — exercise CRUD with search + type filter

**Student**
1. Logs in → **Home tab** (`/student`) — current training week: 7-day strip (session or rest day per slot), an expandable "Next session" preview with full exercise list and Start button, the remaining upcoming sessions, and completed sessions this week
2. **Sessions tab** (`/student/sessions`) — full program by week; each session card is expandable to show all exercises (name, sets, reps, prescribed weight) — only one card can be open at a time (accordion); tap "Start session" to open `SessionView`
3. **Stats tab** (`/student/stats`) — progress stats: sessions confirmed, sets done, weekly volume bars, lift-progression sparklines, recent activity
4. **Goals tab** (`/student/goals`) — `MyGoals`

---

## Design System (athletic · editorial · dark-first)

The UI uses a custom editorial design language instead of raw Tailwind utilities for the common cases. All primitives live in `src/index.css`:

- **Fonts** (loaded in `index.html`): **Archivo** (`--font-display`) for headings, buttons, numeric callouts · **Inter** (`--font-body`) for body text · **JetBrains Mono** (`--font-mono`) for labels, meta, and numbers (tabular figures always on).
- **Palette**: a warm `ink-*` scale (`ink-0` cream → `ink-950` near-black) replaces `gray-*`. Accent is `#ff5a1f` (high-vis orange). Semantic tokens: `--color-success`, `--color-warn`, `--color-danger`.
- **Utilities** (`@layer components`):
  - `sl-display` — display headings (Archivo 800, tight leading).
  - `sl-label` — mono uppercase 10px kicker (`"PROGRAM" / "WEEK 1" / "REVIEW"`).
  - `sl-mono` — tabular-figure meta/numbers.
  - `sl-card` — surface primitive (white + hairline → solid `ink-850` in dark mode).
  - `sl-pill` — small uppercase chip for tags and secondary buttons.
  - `sl-btn-primary` — accent CTA with display font; override `padding`/`text-[…]` inline for compact variants (see `SessionCard`, `ExerciseLibrary` ExerciseForm).
- **Editorial page header pattern**: back button + `sl-label` kicker + `sl-display` h1 + right-aligned `sl-pill` actions. Used across `SessionEditor`, `WeekView`, `SessionReview`, etc. `layout/Header` is now only used by `StudentGoals`; new pages should follow the editorial pattern instead.
- **Tinted surfaces** use `color-mix(in srgb, var(--color-accent) 10%, transparent)` (and success/warn/danger) so they adapt to both themes.

## Theming (Light / Dark)

- `ThemeProvider` (`src/hooks/useTheme.jsx`) toggles the `dark` class on `<html>` and persists to `localStorage` key `sl_app_theme`. Initial value follows `prefers-color-scheme` if unset.
- `src/index.css` declares `@custom-variant dark (&:where(.dark, .dark *))` (Tailwind 4) and a compact set of CSS overrides that remap `bg-white`, `bg-gray-50/100/200`, `text-gray-*`, `border-gray-*`, and the full `ink-*` scale under `.dark`. This avoids adding `dark:` variants to every component.
- **Class-based remap only**: inline `style={{ color: 'var(--color-ink-800)' }}` does NOT flip. Use `text-gray-*` / `text-ink-*` classes for any text that needs to invert.
- Toggle UI: `ThemeToggle` (sun/moon) lives inside the top-right avatar popover on `StudentHome` and `CoachDashboard`, and in `Header` on the Goals route.
- `useTheme()` falls back to a no-op in the absence of a provider so components can render in isolation (tests).

---

## Internationalization (EN / FR / DE)

- `I18nProvider` (`src/hooks/useI18n.jsx`) resolves initial language from `localStorage.sl_app_lang`, falling back to `navigator.language`, then `'en'`. Persists writes and mirrors to `<html lang>`.
- Locale dictionaries live in `src/lib/i18n/{en,fr,de}.js` (nested keys like `student.home.nextSession`). `getMessage(lang, key, params)` supports `{token}` interpolation with English fallback for missing keys.
- `LanguageSelect` (`src/components/ui/LanguageSelect.jsx`) is a compact EN/FR/DE button group. Rendered inside the `StudentHome` and `CoachDashboard` avatar popovers, next to the `LoginPage` kicker, and in `Header` (Goals route).
- `useI18n()` has a no-op English fallback when no provider is mounted — same isolated-test pattern as `useTheme`.
- Label values are stored title-case (`'Home'`); the `sl-label` utility uppercases visually via CSS.

---

## Inline Title Editing

`EditableText` (`src/components/ui/EditableText.jsx`) is a controlled click-to-edit component: renders a button showing `value` or `placeholder`, becomes an input on click, commits on Enter/blur, cancels on Escape. Used for:
- Week label (`WeekView` header) — saves via `useUpdateWeek`
- Session title per session card (`WeekView`) and session editor header (`SessionEditor`) — saves via `useUpdateSession`

Both mutations invalidate `['week']`, `['program']`, and/or `['session']` so list views and detail views stay in sync.

---

## Testing Conventions

- Tests live alongside components as `*.test.jsx` / `*.test.js`.
- `src/test/utils.jsx` exports `renderWithProviders(ui, { auth, route, queryClient })` which wraps with `ThemeProvider` + `QueryClientProvider` + `AuthContext` + `MemoryRouter`.
- Mocks: child hooks are stubbed with `vi.mock('../../hooks/useX', () => ({ ... }))` per file.
- ~130 tests across 24 files cover every interactive button, the volume helper, hook layers, and auth/nav flows.

Run:
```bash
npm test                 # watch mode
npm test -- --run        # single run (CI)
```

---

## Performance & Accessibility (Lighthouse)

- Aggressive rendering optimization using `React.memo` and `useMemo` on high-frequency components (e.g., SetRow, VolumeBar, RpeInput).
- Optimistic updates to UI state on mutations (like toggling sets complete) via TanStack query manipulation for instant feedback.
- Precise query invalidation scoping to prevent over-fetching on related views.
- Route-level code splitting via `React.lazy` + `Suspense` (`src/routes.jsx`).
- Vite manual chunks for `router`, `query`, `supabase` (`vite.config.js`) — vendor caching.
- `index.html`: meta description, theme-color, manifest, favicon, Supabase `preconnect`.
- `public/manifest.json` + `favicon.svg` for PWA/installability.
- A11y: `aria-label`/`aria-pressed`/`aria-modal`/`role="status"` on Spinner, Dialog, SetRow, RpeInput, ExerciseSlotRow, WeekView, ExerciseLibrary, BottomNav, LoginPage.

---

## Deployment

```bash
npm run deploy
```
Uses `gh-pages` to push `dist/` to the `gh-pages` branch. Vite `base` is `/sl_app/`; the router uses `HashRouter` so deep links survive static hosting. GitHub Actions workflow lives in `.github/workflows/`.

Supabase env vars are passed in at build time — ensure the GitHub Actions secrets `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are set.

---

## Bug Fixes

### Tab highlight stays active on sub-routes (fixed)

`BottomNav` uses React Router `NavLink`. By default, a `NavLink` is active when the URL **starts with** its `to` path, so `/coach` stayed highlighted on `/coach/week/123` and `/student` stayed highlighted on `/student/session/abc`. Fixed by passing the `end` prop to the "Students" and "Home" nav items, which requires an exact path match for the active state.

---

## Notes for Future Agents

- **Tailwind 4**: config is in CSS (`@theme` / `@custom-variant` in `src/index.css`), not a `tailwind.config.js`.
- **Dark mode is CSS override–based**, not utility-based. Prefer extending overrides in `src/index.css` over adding `dark:` classes everywhere. Only *className*-based colors flip — inline `style={{ color: … }}` does not.
- **Prefer the design system** (`sl-display`, `sl-label`, `sl-mono`, `sl-card`, `sl-pill`, `sl-btn-primary`) and the warm `ink-*` scale over raw `gray-*` / `dark:` utilities on new code.
- **`layout/Header` is deprecated on most pages** — only `StudentGoals` still uses it. New pages should use the editorial header pattern (back button + sl-label kicker + sl-display h1 + sl-pill actions). `StudentHome` + `CoachDashboard` embed the theme toggle / sign-out inside an avatar-initials popover instead.
- **HashRouter** is intentional (GitHub Pages). URLs contain `/#/` — don't swap to `BrowserRouter` without switching hosting.
- **`useWeek.js` owns both `useUpdateWeek` and `useUpdateSession`** (not `useSession.js`) — consolidated to match the mutation source used by `WeekView`.
- **`useTheme()` tolerates a missing provider** (returns a light-theme no-op). Convenient for tests; don't rely on it in production paths.
- When adding a page that uses `<Header />` in a test, wrap with `ThemeProvider` (or use `renderWithProviders`) — `Header` renders `ThemeToggle`.
