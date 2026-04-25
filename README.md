# Street Lifting Coach (sl_app)

A responsive React application for coaches and students to plan, track, and execute street-lifting / calisthenics training programs. Mobile-first design with a bottom tab bar; on desktop (≥ 768px) the nav promotes to a left sidebar and content caps at `max-w-5xl`. Coaches design multi-week programs (weeks → sessions → exercise slots); students log sets, reps, weight, RPE, and completion.

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

Top level only — see [CLAUDE.md](CLAUDE.md) for the feature → files table that maps each area (coach dashboard, student home, week editor, etc.) to its primary files.

```
src/
  App.jsx  main.jsx  routes.jsx  index.css
  lib/                 supabase, queryClient, volume, day, i18n
  hooks/               auth · theme · i18n · program · week · session · goals
                       students · set-logs · set-video · confirmations · slot-comments · stats
  components/
    auth/              LoginPage, ProtectedRoute, RoleGate
    layout/            AppShell, BottomNav, SideNav, navItems
    coach/             CoachDashboard, CoachHome, ProgramSwitcher,
                       StudentGoalsSection, StudentStatsSection,
                       WeekTimeline, WeekView, SessionEditor, SessionReview,
                       ExerciseSlotRow, ExerciseLibrary, SessionsFeed, SlotProgress
    student/           StudentHome, StudentSessions, SessionCard, SessionView, SetRow,
                       RpeInput, StudentDashboard (Stats), SessionCalendar,
                       ExerciseProgressChart, MyGoals, VideoUploadButton
    ui/                EditableText, ThemeToggle, LanguageSelect, UserMenu, Dialog,
                       VideoPlayer, Spinner, EmptyState, CopyDialog, ConfirmDialog,
                       ErrorBoundary
  test/                setup.js, utils.jsx (renderWithProviders)
supabase/
  schema.sql           Tables, RLS, signup trigger
  migrations/          Dated SQL files, applied in order
public/                manifest.json, favicon.svg
docs/                  ARCHITECTURE.md, DESIGN_SYSTEM.md, ENVIRONMENT.md
```

---

## Domain Model

```
profiles (id, role: 'coach'|'student', full_name)
  ↓ 1:many (coach_id)
programs (id, student_id, name, sort_order, is_active)  -- periodization blocks; ≤1 active per student
  ↓ 1:many
weeks (id, program_id, week_number, label)
  ↓ 1:many
sessions (id, week_id, title, day_number, sort_order)
  ↓ 1:many                                ↓ 1:1
exercise_slots (…, notes,               session_confirmations (session_id UNIQUE, student_id,
  record_video_set_numbers)               confirmed_at, notes)
  → exercise_library (…)
  ↓ 1:many
set_logs (…)
  ↓ 1:1
set_log_videos (set_log_id UNIQUE, storage_path, mime_type, size_bytes)
```

Each coach has their own exercise library; each student can have many **programs** (periodization blocks) but only one is active at a time. Students see only the active program; coaches browse all.

`set_logs` doubles as both prescription and log: each row carries the coach's per-set targets (`target_reps`, `target_duration_seconds`, `target_weight_kg`, `target_rest_seconds`) alongside the student's actuals (`done`, `rpe`, `weight_kg`). The compact "3 × 10 @ 80kg" UI is shown when every set's target matches; otherwise a per-set list appears (drop sets, back-offs). Coaches toggle "Customize sets" in the editor to expose a per-set table; "Reset to uniform" syncs every row back to set 1.

Deep architectural details — RLS helpers, React Query invalidation, routing/persistence, set-video storage, calendar history overlay — live in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Roles & Flows

**Coach**
1. Logs in → `CoachDashboard` — athletes list + recent confirmations feed. Tap an athlete to open their single-student view.
2. **Students tab** (`/coach/students`, `/coach/students/:studentId`) — dropdown selector + **Program** (`WeekTimeline` → `WeekView` → `SessionEditor`), **Goals**, **Stats** in one scroll.
3. **Sessions tab** (`/coach/sessions`) — all students' confirmed sessions in one feed; tap a card to open `SessionReview`.
4. **Library tab** — exercise CRUD with search + type filter.

**Student**
1. Logs in → **Home tab** (`/student`) — current training week: 7-day strip and an always-expanded "Next session" preview (full exercise list visible by default; no collapse) with a Start CTA.
2. **Sessions tab** (`/student/sessions`) — full program by week; accordion session cards (one open at a time); tap "Start session" to open `SessionView`.
3. **Stats tab** (`/student/stats`) — sessions confirmed, sets done, weekly volume bars, per-exercise progression, calendar (active block + muted history dots).
4. **Goals tab** (`/student/goals`) — `MyGoals`.

---

## Design System, Theming, and i18n

Full primitives (`sl-card`, `sl-display`, `sl-label`, `sl-mono`, `sl-pill`, `sl-btn-primary`), dark-mode rules, responsive layout, and the editorial page-header pattern live in [docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md). Working notes for agents live in [CLAUDE.md](CLAUDE.md). System architecture (data model, React Query invalidation, RLS, routing persistence) lives in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Environment setup (WSL recommended) lives in [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md).

Quick summary:

- **Theme**: `ThemeProvider` (`src/hooks/useTheme.jsx`) toggles `.dark` on `<html>`, persists to `localStorage.sl_app_theme`. CSS-override based — don't sprinkle `dark:` classes.
- **i18n**: `I18nProvider` (`src/hooks/useI18n.jsx`) with EN/FR/DE dictionaries in `src/lib/i18n/`. Title-case values; `sl-label` uppercases via CSS. Language persists in `localStorage.sl_app_lang` and mirrors to `<html lang>`. `useI18n()` has a no-op English fallback for isolated tests.
- **Toggles**: `ThemeToggle` + `LanguageSelect` live inside `ui/UserMenu` (the avatar-initials popover rendered on every top-level page), and next to the `LoginPage` kicker.

---

## Inline Title Editing

`EditableText` (`src/components/ui/EditableText.jsx`) is a controlled click-to-edit component: renders a button showing `value` or `placeholder`, becomes an input on click, commits on Enter/blur, cancels on Escape. Used for week labels and session titles — saves via `useUpdateWeek` / `useUpdateSession` (both owned by `useWeek.js`). Mutations invalidate `['week']`, `['program']`, and/or `['session']` so list and detail views stay in sync.

---

## Testing Conventions

- Tests live alongside components as `*.test.jsx` / `*.test.js`.
- `src/test/utils.jsx` exports `renderWithProviders(ui, { auth, route, queryClient })` which wraps with `ThemeProvider` + `QueryClientProvider` + `AuthContext` + `MemoryRouter`.
- Mocks: child hooks are stubbed with `vi.mock('../../hooks/useX', () => ({ ... }))` per file.
- 172 tests across 24 files cover every interactive button, the volume helper, hook layers, and auth/nav flows.

Run:
```bash
npm test                 # watch mode
npm test -- --run        # single run (CI)
```

---

## Performance & Accessibility (Lighthouse)

- `React.memo` + `useMemo` on high-frequency components (SetRow, VolumeBar, RpeInput).
- Optimistic updates on mutations (e.g. toggling sets complete) via TanStack Query manipulation for instant feedback.
- Scoped query invalidation to prevent over-fetching on related views.
- Route-level code splitting via `React.lazy` + `Suspense` (`src/routes.jsx`).
- Vite manual chunks for `router`, `query`, `supabase` (`vite.config.js`) — vendor caching survives deploys.
- `index.html`: meta description, theme-color, manifest, favicon, Supabase `preconnect`.
- `public/manifest.json` + `favicon.svg` for PWA/installability.
- A11y: `aria-label` / `aria-pressed` / `aria-modal` / `role="status"` on Spinner, Dialog, SetRow, RpeInput, ExerciseSlotRow, WeekView, ExerciseLibrary, BottomNav, LoginPage.

---

## Deployment

```bash
npm run deploy
```

Uses `gh-pages` to push `dist/` to the `gh-pages` branch. Vite `base` is `/sl_app/`; the router uses `HashRouter` so deep links survive static hosting. GitHub Actions workflow lives in `.github/workflows/`.

Supabase env vars are passed in at build time — ensure GitHub Actions secrets `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are set.
