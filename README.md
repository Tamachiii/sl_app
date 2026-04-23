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
  hooks/               auth · theme · i18n · program · week · session · goals · students · set-logs · confirmations · stats
  components/
    auth/              LoginPage, ProtectedRoute, RoleGate
    layout/            AppShell, BottomNav, SideNav, navItems
    coach/             CoachDashboard, CoachHome (single-student view with selector +
                       Program/Goals/Stats sections), ProgramSwitcher, StudentGoalsSection,
                       StudentStatsSection, WeekTimeline, WeekView, SessionEditor,
                       SessionReview, ExerciseSlotRow, ExerciseLibrary, VolumeBar,
                       SessionsFeed
    student/           StudentHome, StudentSessions, SessionCard, SessionView, SetRow,
                       RpeInput, StudentDashboard (Stats), MyGoals, ExerciseProgressChart
    ui/                EditableText, ThemeToggle, LanguageSelect, Dialog, Spinner,
                       EmptyState, CopyDialog, ConfirmDialog, ErrorBoundary
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
programs (id, student_id, name, sort_order, is_active)  -- periodization blocks per student
  ↓ 1:many
weeks (id, program_id, week_number, label)
  ↓ 1:many
sessions (id, week_id, title, day_number, sort_order)
  ↓ 1:many                                ↓ 1:1
exercise_slots (…, notes, record_video_set_numbers)  session_confirmations (session_id UNIQUE, student_id, confirmed_at, notes)
  → exercise_library (…)
  ↓ 1:many
set_logs (…)
  ↓ 1:1
set_log_videos (set_log_id UNIQUE, storage_path, mime_type, size_bytes)
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

### Program periodization (multiple program blocks per student)

A student can have many programs (periodization blocks) at once, but only one is **active** at a time (partial unique index `programs_one_active_per_student`). Students only ever see the active program on Home / Sessions / Stats — previous blocks stay invisible to them so the active block drives all progress aggregates. Coaches see a horizontal **ProgramSwitcher** pill row on `CoachHome` above the week timeline: each pill shows the program name + an `ACTIVE` badge; coaches can rename, set-active, delete (with confirmation), reorder via a 6-dot grip (dnd-kit, same pattern as `WeekTimeline`), and add new blocks via `+ PROGRAM`. Selected program is URL-synced as `?program=<id>`; the default is the active one. Deleting the *active* program is blocked while other programs exist — coaches must activate another first. Migration: `2026_04_23_programs_crud.sql` (adds `sort_order` + `is_active` with chronological backfill).

### Week reordering

Each week pill in `WeekTimeline` has a drag handle (6-dot grip). Coaches can drag weeks into any order; dropping commits via `useReorderWeeks`, which rewrites `week_number` in two passes (park all at temp numbers, then assign finals) to dodge the `UNIQUE(program_id, week_number)` constraint. The pill's label area still navigates to the week view — only the grip triggers drag. On touch, drag activates after a 200ms press so taps aren't captured. The local order updates optimistically for instant feedback.

### Coach exercise notes

Coaches can add a free-text note to any exercise slot while planning a session (via `ExerciseSlotRow` in `SessionEditor`). Notes are stored in `exercise_slots.notes`. Students see the note as a blue info callout above their `SlotCommentBox` when executing the session in `SessionView`. No migration needed — the column already existed in the schema.

### Record-video set flag

For any exercise, the coach can pick **any number** of sets to record on video via per-set chips in `ExerciseSlotRow` (tap a chip to toggle; "All" / "None" shortcut toggles every set at once). The selection is stored as an `int[]` in `exercise_slots.record_video_set_numbers` (migration `2026_04_20_record_video_set_numbers.sql`, defaults to `{}`). Students see an amber "Record" badge on each matching `SetRow` in `SessionView`, so it's obvious which sets they should film for coach review.

### Set video uploads

Any set flagged via `record_video_set_numbers` gets an **Upload video** CTA under it in `SetRow`. Students pick a clip via `<input type="file" accept="video/*" capture="environment">` (native camera on mobile, file picker on desktop) — the file is uploaded to the private Supabase Storage bucket `set-videos` and tracked in the `set_log_videos` table (1:1 with `set_logs`, UNIQUE on `set_log_id`). Files are keyed by `<profile_id>/<slot_id>/<set>-<uuid>.<ext>` so Storage RLS can gate on the first path segment (student owns it) or the coach's student list (coach reads it). Client caps uploads at 25 MB and surfaces a clear error if the clip is too large — no re-encoding in v1. Students can preview, replace, or delete their clips inline. On the coach side, `SessionReview` renders a row of **SET N** play chips per slot; tapping one opens the clip in a dialog via a 1-hour signed URL. Migration: `2026_04_23_set_log_videos.sql`.

---

## Roles & Flows

**Coach**
1. Logs in → redirected to `CoachDashboard` (athletes list with basic info + recent confirmations feed). Tapping an athlete opens that student's single-student page.
2. **Students tab** (`/coach/students` and `/coach/students/:studentId`) — single-student view centralising everything for one athlete: dropdown selector at top, student header, **Program** (`WeekTimeline` → `WeekView` → `SessionEditor`), **Goals** (inline list + add form), **Stats** (summary cards + weekly volume + exercise progression).
3. **Sessions tab** (`/coach/sessions`) — all students' confirmed sessions in one feed (`SessionsFeed`), newest first; tap any card to open `SessionReview`
4. **Library tab** — exercise CRUD with search + type filter

**Student**
1. Logs in → **Home tab** (`/student`) — current training week: 7-day strip (session or rest day per slot), an expandable "Next session" preview with full exercise list and Start button, the remaining upcoming sessions, and completed sessions this week
2. **Sessions tab** (`/student/sessions`) — full program by week; each session card is expandable to show all exercises (name, sets, reps, prescribed weight) — only one card can be open at a time (accordion); tap "Start session" to open `SessionView`
3. **Stats tab** (`/student/stats`) — progress stats: sessions confirmed, sets done, weekly volume bars, lift-progression sparklines, recent activity
4. **Goals tab** (`/student/goals`) — `MyGoals`

---

## Design System, Theming, and i18n

Full primitives (`sl-card`, `sl-display`, `sl-label`, `sl-mono`, `sl-pill`, `sl-btn-primary`), dark-mode rules, and the editorial page-header pattern live in [docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md).

Working notes for agents — feature → files map, gotchas, and hook ownership — live in [CLAUDE.md](CLAUDE.md). System architecture (data model, React Query invalidation, RLS) lives in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Environment setup (WSL recommended) lives in [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md).

Quick summary:

- **Theme**: `ThemeProvider` (`src/hooks/useTheme.jsx`) toggles `.dark` on `<html>`, persists to `localStorage.sl_app_theme`. CSS-override based — don't sprinkle `dark:` classes.
- **i18n**: `I18nProvider` (`src/hooks/useI18n.jsx`) with EN/FR/DE dictionaries in `src/lib/i18n/`. Title-case values, `sl-label` uppercases via CSS.
- **Toggles**: `ThemeToggle` + `LanguageSelect` live inside `ui/UserMenu` (the avatar-initials popover rendered on every top-level page — coach Dashboard/Students/Sessions/Library and student Home/Sessions/Stats/Goals), and next to the `LoginPage` kicker.

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
- **Editorial page header on every page**: back button + `sl-label` kicker + `sl-display` h1 + right-aligned `sl-pill` actions. Top-level pages render `ui/UserMenu` (avatar-initials popover → Theme / Language / Sign out) as the right-aligned action; wrap the header in `flex items-start justify-between gap-4`.
- **HashRouter** is intentional (GitHub Pages). URLs contain `/#/` — don't swap to `BrowserRouter` without switching hosting.
- **`useWeek.js` owns both `useUpdateWeek` and `useUpdateSession`** (not `useSession.js`) — consolidated to match the mutation source used by `WeekView`.
- **`useTheme()` tolerates a missing provider** (returns a light-theme no-op). Convenient for tests; don't rely on it in production paths.
