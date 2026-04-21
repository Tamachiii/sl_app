# CLAUDE.md — Working Notes for Future Agents

Read this before anything else. It tells you **which files to load for a given task** so you don't waste tokens scanning the whole tree.

---

## Read-sparingly rule

For any feature, walk the dependency graph — don't scan the folder:

1. **Page/component** the feature changes.
2. **Its direct imports** only (hooks, components, helpers). Not siblings.
3. **Route entry** (`src/routes.jsx`) only if adding a route or wrapper.
4. **Schema** (`supabase/schema.sql` or a specific migration) only if touching the DB.
5. **Tests** for files in steps 1–2 only.

**Prefer `Grep` over `Read`** for locating symbols. **Read ranges** (`offset`/`limit`) for files >200 lines. **Don't re-Read** a file you already have in context.

When a change might ripple (e.g. editing a shared component like `Header`), `Grep` for importers and load only those that use the symbol you changed.

---

## Repo map

```
src/
  App.jsx, main.jsx, routes.jsx, index.css
  lib/           supabase.js  queryClient.js  volume.js  day.js  i18n/
  hooks/         useAuth  useTheme  useI18n  useProgram  useWeek  useSession
                 useExerciseLibrary  useDuplicate  useStudents  useGoals
                 useSetLogs  useSessionConfirmation  useSlotComments
                 useStudentProgressStats  useStudentProgramDetails
  components/
    auth/        LoginPage  ProtectedRoute  RoleGate
    layout/      BottomNav  AppShell
    coach/       CoachDashboard  CoachHome  StudentCard  WeekTimeline  WeekView
                 SessionEditor  SessionReview  ExerciseSlotRow  ExerciseLibrary
                 VolumeBar  SessionsFeed  StudentGoals  SlotProgress
    student/     StudentHome  StudentSessions  SessionCard  SessionView  SetRow
                 RpeInput  StudentDashboard(Stats)  SessionCalendar
                 ExerciseProgressChart  MyGoals
    ui/          EditableText  ThemeToggle  LanguageSelect  Dialog  Spinner
                 EmptyState  CopyDialog  ConfirmDialog  ErrorBoundary
  test/          setup.js  utils.jsx (renderWithProviders)
supabase/
  schema.sql
  migrations/    <dated SQL files, applied in order>
docs/            ARCHITECTURE.md  DESIGN_SYSTEM.md  ENVIRONMENT.md
```

Tests live next to their component as `*.test.jsx`.

---

## Feature → files map

Use this to jump straight to the relevant files. **Do not load anything else** unless the task genuinely crosses boundaries.

| Feature area | Primary files | Shared deps |
|---|---|---|
| Auth / login | `auth/LoginPage` (editorial sl-card form), `hooks/useAuth`, `routes.jsx` | `lib/supabase` |
| Coach dashboard | `coach/CoachDashboard` (editorial h1 + inline `UserMenu` avatar popover with Theme + Sign out; recent-activity cards only — athlete list lives under the Students tab), `hooks/useSessionConfirmation` (`useAllConfirmations`) | — |
| Coach student list | `coach/CoachHome`, `coach/StudentCard`, `coach/WeekTimeline`, `hooks/useStudents`, `hooks/useProgram`, `hooks/useAuth` | — |
| Coach week reordering | `coach/WeekTimeline` (dnd-kit sortable), `hooks/useWeek` (`useReorderWeeks`) | `@dnd-kit/core`, `@dnd-kit/sortable` |
| Coach sessions feed | `coach/SessionsFeed` (with `?student=:id` filter, editorial h1), `hooks/useSessionConfirmation` (`useAllConfirmations`) | `ui/EmptyState` |
| Coach week view | `coach/WeekView` (editorial top bar + single-line sl-card session rows — open a session for volume/detail), `hooks/useWeek`, `hooks/useDuplicate` | `ui/EditableText` |
| Coach session editor | `coach/SessionEditor` (editorial top bar + sl-pill actions), `coach/ExerciseSlotRow`, `hooks/useSession`, `hooks/useExerciseLibrary`, `hooks/useDuplicate` | `coach/VolumeBar`, `ui/EditableText` |
| Coach session review | `coach/SessionReview` (editorial top bar + archive sl-pill + student-note tinted callout), `hooks/useSession`, `hooks/useSetLogs`, `hooks/useSlotComments`, `hooks/useSessionConfirmation`, `hooks/useWeek` (`useArchiveSession`) | `coach/SlotProgress`, `lib/volume` |
| Coach exercise slot notes | `coach/ExerciseSlotRow` (notes textarea), `student/SessionView` (note display) | `hooks/useSession` (`useUpdateSlot`) |
| Record-video set flag | `coach/ExerciseSlotRow` (set chips → `record_video_set_numbers` int[]), `student/SetRow` (camera badge), `student/SessionView` (passes prop) | `hooks/useSession`, `hooks/useStudentProgramDetails` |
| Coach exercise library | `coach/ExerciseLibrary` (editorial h1 + filter pills + compact Save CTA), `hooks/useExerciseLibrary` | `ui/Dialog`, `ui/EmptyState` |
| Student home | `student/StudentHome` (editorial Greeting card with inline `UserMenu` avatar popover — Theme + Sign out; vertical-written day-strip titles), `student/SessionCard`, `hooks/useStudentProgramDetails`, `hooks/useSessionConfirmation`, `hooks/useAuth` | — |
| Student sessions list | `student/StudentSessions` (editorial h1 + accordion — only one `SessionCard` open at a time — + compact Start/Review CTA), `student/SessionCard`, `hooks/useStudentProgramDetails`, `hooks/useSessionConfirmation` | `lib/volume` |
| Student stats | `student/StudentDashboard` (route: /student/stats), `student/SessionCalendar`, `student/ExerciseProgressChart` (per-exercise weekly tonnage), `hooks/useStudentProgressStats` | `lib/volume`, `ui/EmptyState` |
| Student session logging | `student/SessionView` (collapsible exercise cards — auto-open incomplete, auto-collapse completed; supersets collapse as one unit), `student/SetRow`, `student/RpeInput`, `hooks/useSession`, `hooks/useSetLogs` | — |
| Session confirmations | `hooks/useSessionConfirmation`, `student/SessionView`, `coach/WeekView` (badge), `coach/SessionsFeed`, `coach/SessionReview` | — |
| Coach goals (per student) | `coach/StudentGoals` (editorial back-button header + sl-card goal rows + compact Save CTA), `hooks/useGoals` | `hooks/useExerciseLibrary`, `layout/BottomNav` |
| Student goals | `student/MyGoals` (sl-card rows, per-goal log/toggle-achieved), `hooks/useGoals` | `layout/BottomNav` (Goals tab) |
| Theming | `hooks/useTheme`, `ui/ThemeToggle`, `index.css` | `coach/CoachDashboard` `UserMenu`, `student/StudentHome` `Greeting` |
| i18n (EN/FR/DE) | `hooks/useI18n`, `lib/i18n/{en,fr,de,index}.js`, `ui/LanguageSelect` | `auth/LoginPage`, both `UserMenu` popovers |
| Day-number helpers | `lib/day.js` (`DAY_LABELS`, `DAY_FULL`, `todayDayNumber`) | `student/StudentHome`, `student/SessionView` |

---

## Design system

Full primitives, dark-mode rules, and the editorial page-header pattern are in [docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md). Short version for agents:

- **Do not** swap in `dark:` utilities or `text-gray-*` ad-hoc. Use `sl-card` / `sl-display` / `sl-label` / `sl-mono` / `sl-pill` / `sl-btn-primary` + the warm `ink-*` scale.
- **Editorial page header** on every screen: back button (`w-9 h-9 rounded-lg bg-ink-100`) + `sl-label` kicker + `sl-display` h1 + right-aligned `sl-pill` action buttons. `StudentHome` / `CoachDashboard` use an inline avatar-initials popover instead of a shared header.
- **Compact CTA**: override `sl-btn-primary` with `className="… text-[13px]" style={{ padding: '10px 16px' }}` (see `SessionCard`, `ExerciseLibrary` ExerciseForm).
- **Tinted surfaces** use `color-mix(in srgb, var(--color-accent) 10%, transparent)` (and success/warn/danger) so they adapt to both themes.
- **Day-strip session titles** on `StudentHome` use `writing-mode: vertical-rl; transform: rotate(180deg)` to read top-to-bottom without wrapping in the narrow 7-column grid.

## Gotchas (read once, never re-discover)

- **i18n lives in `src/lib/i18n/` + `hooks/useI18n`.** Three locales (EN/FR/DE) with deep-key resolution and English fallback. `t(key, params)` supports `{token}` interpolation. Language persists in `localStorage.sl_app_lang` and mirrors to `<html lang>`. `useI18n()` has a no-op English fallback for isolated tests (same pattern as `useTheme`). **Label values are stored title-case** (`'Home'`, `'Dashboard'`) — the `sl-label` utility uppercases them via CSS. Tests read DOM text (title case), rendered UI displays uppercase.
- **Tailwind 4, CSS-based config.** `@theme` and `@custom-variant` live in `src/index.css`. There's no `tailwind.config.js`.
- **Dark mode = CSS overrides, not `dark:` utilities.** Extend `src/index.css` rather than sprinkle `dark:` classes. Class-based (`.dark` on `<html>`).
- **Dark-mode remap only applies to class-based colors.** `.dark .text-gray-900`, `.dark .text-ink-700`, etc. flip via className selectors. An inline `style={{ color: 'var(--color-ink-800)' }}` will NOT flip. Use `text-gray-900` / `text-ink-*` classes for any text that needs to invert — reserve inline `style` for colors that stay the same in both themes (accent, success, warn, danger) or for `color-mix()` backgrounds/borders that don't need flipping.
- **HashRouter is intentional** (GitHub Pages). URLs contain `/#/`.
- **`useWeek.js` owns `useUpdateWeek` and `useUpdateSession`** (not `useSession.js`). Weeks-level and sessions-level write mutations are consolidated there.
- **`useTheme()` has a no-op fallback** when no provider is mounted — convenient for isolated tests. Don't rely on it in production paths.
- **Test wrapper adds `ThemeProvider`.** Use `renderWithProviders` from `src/test/utils.jsx`; it wraps `ThemeProvider` + `QueryClientProvider` + `AuthContext` + `MemoryRouter`.
- **matchMedia polyfill** is in `src/test/setup.js` — needed by `ThemeProvider` under jsdom.
- **Outer page must not scroll.** `html, body, #root` have `overflow: hidden` + `position: fixed; inset: 0` (in `src/index.css`), and `AppShell` is `h-full flex-col` (NOT `h-dvh` — on iOS Safari, dvh disagrees with 100% and the body ends up scrollable with a second scrollbar). `main` is the only scroll container. Don't touch this — it prevents mobile keyboard focus (e.g. the Confirm-session textarea) from pushing the sticky `BottomNav` mid-page.
- **Vite `base` is `/sl_app/`** and there's a manual-chunks split (`router`, `query`, `supabase`). Pages are lazy-loaded in `routes.jsx`.
- **React Rules of Hooks:** Never call `useMemo` or any other hook after an early return like `if (isLoading) return <Spinner/>`. Always put hooks at the top of the component.
- **RLS is strict.** When adding tables, add both student- and coach-side policies. Walk session → profile via `student_profile_for_session()` / `coach_profile_for_session()` helpers (defined in `schema.sql`).
- **Reordering weeks uses `useReorderWeeks`** — a two-pass update (park all at `100000+idx`, then assign `idx+1`) to dodge the `UNIQUE(program_id, week_number)` constraint. Triggered from `WeekTimeline` drag-and-drop.
- **WeekTimeline is dnd-kit sortable.** Each week pill has a separate drag handle (6-dot grip) — the label area still navigates on click. Touch drag needs a 200ms press delay (`TouchSensor` activation) so taps don't trigger drags. Tests that render `WeekTimeline` (directly or via `StudentCard`) must mock `useReorderWeeks` from `hooks/useWeek`.
- **Exercise Library filtering is client-side.** Search and type-filter state live in `ExerciseLibrary` and are applied with `useMemo` over the already-fetched list — no extra Supabase queries.
- **`NavLink` `end` prop on root tabs.** `BottomNav`'s "Students" (`/coach/students`) and "Home" (`/student`) links use `end` so they only highlight on exact route matches — without it they stay active on all child routes.
- **`StudentDashboard.jsx` is the Stats page.** The file is named `StudentDashboard` but rendered at `/student/stats` (imported as `StudentStats` in routes). The old `/student/dashboard` redirects to `/student/stats`. Don't rename the file — just be aware of the mismatch.
- **`useStudentProgramDetails`** fetches weeks → sessions → exercise_slots → exercise library for the Sessions page. Lighter than `useStudentProgressStats` (no set_log or confirmation queries). Use it whenever you need full slot structure without aggregation.
- **`SessionCard` supports controlled and uncontrolled open state.** Pass `open` + `onToggle` to control it from the parent (this is how `StudentSessions` enforces single-open accordion behavior — only one card expanded at a time). Omit them and the card falls back to its own `useState(defaultOpen)` — this is what `StudentHome`'s standalone upcoming-session card relies on.
- **`SessionView` exercise cards collapse per slot-group** with independent toggles (not accordion — you can peek at the next exercise without closing the current). Default open-state is derived from set-log completion on first render (open if any set is incomplete, or if logs haven't been ensured yet); once the user toggles a group, `manualOpen[groupKey]` wins. Supersets collapse as a single unit (grouping from `groupSlotsBySuperset`) since sets alternate across slots — collapsing an individual slot inside a superset wouldn't make sense.
- **`day_number` on sessions**: 1=Monday … 7=Sunday. `StudentHome` maps these to the 7-day week strip. Sessions with `day_number` outside 1–7 don't appear in the strip but still show in the Upcoming/Completed lists.
- **`record_video_set_numbers` on `exercise_slots`** (`int[]`, defaults to `{}`): coach flags any subset of sets of an exercise for video recording. Student sees an amber "Record" badge on each matching `SetRow`. If the coach reduces `sets` below a picked number, stale entries just don't match any row (no crash). `commitVideoSets` in `ExerciseSlotRow` sorts + dedupes + filters before persisting.

---

## Commands

```bash
npm run dev       # vite dev (port 5173)
npm run build     # production build → dist/
npm run preview   # serve dist/ (port 4173)
npm test          # vitest (watch)
npm test -- --run # vitest single run (CI)
npm run deploy    # gh-pages → GitHub Pages
```

Test runs are via WSL: `wsl -d Ubuntu -- bash -lc "cd /home/tamachi/sl_app && npm test -- --run"`.

---

## When you add a feature

1. Load only the files listed in the matching row of the feature table above.
2. If the feature adds a DB table/column, put the SQL in `supabase/migrations/<date>_<name>.sql` **and** append it to `schema.sql`.
3. Add tests next to components; stub hooks with `vi.mock(...)`; use `renderWithProviders` from [src/test/utils.jsx](src/test/utils.jsx) for anything that needs Theme / QueryClient / Auth / Router.
4. Update this file's feature table only if you introduced a new feature area.
5. Run `npm test -- --run` and `npm run build` before committing.
6. Update `README.md` and `CLAUDE.md` to reflect the new feature (domain model, feature table, gotchas, etc.) before pushing.
