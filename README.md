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
npm test          # run vitest (103 tests)
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
  components/
    auth/LoginPage.jsx
    layout/
      Header.jsx               # Sticky top bar (back button, title, actions, ThemeToggle)
      BottomNav.jsx            # Role-aware bottom tabs + sign out
    coach/
      CoachHome.jsx            # Student list
      StudentCard.jsx          # Student card with WeekTimeline
      WeekTimeline.jsx         # W1/W2/... pills + "+ Week"
      WeekView.jsx             # Sessions list (inline-editable labels & titles)
      SessionEditor.jsx        # Exercise slots + add/duplicate (inline-editable title)
      ExerciseSlotRow.jsx      # Per-slot sets/reps/weight + reorder/delete
      ExerciseLibrary.jsx      # Coach's exercise CRUD
      VolumeBar.jsx            # Stacked pull/push volume bar
    student/
      StudentHome.jsx          # Today's/upcoming sessions
      SessionView.jsx          # Runs through the session (SetRow per set)
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

```
profiles (id, role: 'coach'|'student', full_name)
  ↓ 1:many (coach_id)
programs (id, coach_id, student_id, title)
  ↓ 1:many
weeks (id, program_id, week_number, label)
  ↓ 1:many
sessions (id, week_id, title, day_number, sort_order)
  ↓ 1:many                                ↓ 1:1
exercise_slots (…, notes)       session_confirmations (session_id UNIQUE, student_id, confirmed_at, notes)
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

### Coach exercise notes

Coaches can add a free-text note to any exercise slot while planning a session (via `ExerciseSlotRow` in `SessionEditor`). Notes are stored in `exercise_slots.notes`. Students see the note as a blue info callout above their `SlotCommentBox` when executing the session in `SessionView`. No migration needed — the column already existed in the schema.

---

## Roles & Flows

**Coach**
1. Logs in → `CoachHome` lists students
2. Expands a student's `WeekTimeline` → jumps into `WeekView`
3. Creates/duplicates sessions, edits labels/titles inline, opens `SessionEditor`
4. Adds/orders/tunes exercise slots; manages the `ExerciseLibrary`

**Student**
1. Logs in → `StudentHome` shows today's & upcoming sessions
2. Opens `SessionView` → ticks each `SetRow` (weight / reps / RPE / done)

---

## Theming (Light / Dark)

- `ThemeProvider` (`src/hooks/useTheme.jsx`) toggles the `dark` class on `<html>` and persists to `localStorage` key `sl_app_theme`. Initial value follows `prefers-color-scheme` if unset.
- `src/index.css` declares `@custom-variant dark (&:where(.dark, .dark *))` (Tailwind 4) and a compact set of CSS overrides that remap `bg-white`, `bg-gray-50/100/200`, `text-gray-*`, `border-gray-*`, etc. under `.dark`. This avoids adding `dark:` variants to every component.
- Toggle UI: `ThemeToggle` (sun/moon) lives in `Header`.
- `useTheme()` falls back to a no-op in the absence of a provider so components can render in isolation (tests).

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
- 103 tests across 22 files cover every interactive button, the volume helper, hook layers, and auth/nav flows.

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
- **Dark mode is CSS override–based**, not utility-based. Prefer extending overrides in `src/index.css` over adding `dark:` classes everywhere.
- **HashRouter** is intentional (GitHub Pages). URLs contain `/#/` — don't swap to `BrowserRouter` without switching hosting.
- **`useWeek.js` owns both `useUpdateWeek` and `useUpdateSession`** (not `useSession.js`) — consolidated to match the mutation source used by `WeekView`.
- **`useTheme()` tolerates a missing provider** (returns a light-theme no-op). Convenient for tests; don't rely on it in production paths.
- When adding a page that uses `<Header />` in a test, wrap with `ThemeProvider` (or use `renderWithProviders`) — `Header` renders `ThemeToggle`.
