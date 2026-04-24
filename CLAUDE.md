# CLAUDE.md — Working Notes for Future Agents

Per-turn context only. Heavier docs load on demand.

## When to load the other docs

- **`docs/ARCHITECTURE.md`** — adding a DB table, changing RLS, touching React Query keys, changes spanning 3+ modules, or orienting to the data model / periodization / routing persistence. Skip for single-component edits, UI polish, tests, copy changes.
- **`docs/DESIGN_SYSTEM.md`** — creating a UI component, adding an `sl-*` primitive, changing dark-mode behavior, building a new page header, responsive layout questions. Skip for logic, data wiring, routing.
- **`README.md`** — setup, deployment, high-level overview, onboarding. Skip for day-to-day coding.

## Read-sparingly rule

For any feature, walk the dependency graph — don't scan folders:

1. Page/component the feature changes.
2. Its direct imports only (hooks, components, helpers). Not siblings.
3. `src/routes.jsx` only if adding a route or wrapper.
4. `supabase/schema.sql` or a migration only if touching the DB.
5. Tests for files in steps 1–2 only.

Prefer `Grep` over `Read` for locating symbols. Read ranges (`offset`/`limit`) for files > 200 lines. Don't re-Read a file already in context.

## Repo map

```
src/
  App.jsx  main.jsx  routes.jsx  index.css
  lib/           supabase.js  queryClient.js  volume.js  day.js  i18n/
  hooks/         auth · theme · i18n · program · week · session · goals
                 students · set-logs · set-video · confirmations · slot-comments
                 stats · exercise-library · duplicate · remember-coach-students-path
  components/
    auth/        LoginPage  ProtectedRoute  RoleGate
    layout/      AppShell  BottomNav  SideNav  navItems
    coach/       CoachDashboard  CoachHome  ProgramSwitcher  WeekTimeline
                 WeekView  SessionEditor  SessionReview  ExerciseSlotRow
                 ExerciseLibrary  SessionsFeed  SlotProgress
                 StudentGoalsSection  StudentStatsSection
    student/     StudentHome  StudentSessions  SessionCard  SessionView  SetRow
                 RpeInput  StudentDashboard(Stats)  SessionCalendar
                 ExerciseProgressChart  MyGoals  VideoUploadButton
    ui/          EditableText  ThemeToggle  LanguageSelect  UserMenu  Dialog
                 VideoPlayer  Spinner  EmptyState  CopyDialog  ConfirmDialog
                 ErrorBoundary
  test/          setup.js  utils.jsx (renderWithProviders)
supabase/        schema.sql  migrations/
docs/            ARCHITECTURE.md  DESIGN_SYSTEM.md  ENVIRONMENT.md
```

Tests live next to components as `*.test.jsx`.

## Feature → files map

Jump straight to the relevant files. For *behavior* details, open the file — the code is the spec.

| Feature | Primary files |
|---|---|
| Auth / login | `auth/LoginPage`, `hooks/useAuth`, `routes.jsx` |
| Coach dashboard | `coach/CoachDashboard`, `hooks/useStudents`, `hooks/useSessionConfirmation`, `hooks/useProgram` |
| Coach single-student view | `coach/CoachHome`, `coach/ProgramSwitcher`, `coach/StudentGoalsSection`, `coach/StudentStatsSection`, `coach/WeekTimeline`, `hooks/useProgram` |
| Coach programs CRUD | `coach/ProgramSwitcher`, `hooks/useProgram` |
| Coach week reordering | `coach/WeekTimeline`, `hooks/useWeek` (`useReorderWeeks`) |
| Coach sessions feed | `coach/SessionsFeed`, `hooks/useSessionConfirmation` |
| Coach week view | `coach/WeekView`, `hooks/useWeek`, `hooks/useDuplicate` |
| Coach session editor | `coach/SessionEditor`, `coach/ExerciseSlotRow`, `hooks/useSession`, `hooks/useExerciseLibrary` |
| Coach session review | `coach/SessionReview`, `hooks/useSession`, `hooks/useSetLogs`, `hooks/useSlotComments`, `hooks/useSessionConfirmation` |
| Set video upload/playback | `student/VideoUploadButton`, `ui/VideoPlayer`, `coach/SessionReview`, `hooks/useSetVideo` |
| Coach exercise library | `coach/ExerciseLibrary`, `hooks/useExerciseLibrary` |
| Student home | `student/StudentHome`, `student/SessionCard`, `hooks/useStudentProgramDetails`, `hooks/useSessionConfirmation` |
| Student sessions list | `student/StudentSessions`, `student/SessionCard`, `hooks/useStudentProgramDetails` |
| Student stats | `student/StudentDashboard`, `student/SessionCalendar`, `student/ExerciseProgressChart`, `hooks/useStudentProgressStats`, `hooks/useStudentHistoricalSessions` |
| Student session logging | `student/SessionView`, `student/SetRow`, `student/RpeInput`, `hooks/useSession`, `hooks/useSetLogs` |
| Coach goals (per student) | `coach/StudentGoalsSection`, `hooks/useGoals` |
| Student goals | `student/MyGoals`, `hooks/useGoals` |
| User menu popover | `ui/UserMenu` (every top-level page's right-aligned header action) |
| Theming | `hooks/useTheme`, `ui/ThemeToggle`, `index.css` |
| i18n (EN/FR/DE) | `hooks/useI18n`, `lib/i18n/`, `ui/LanguageSelect` |
| Day-number helpers | `lib/day.js` |

Periodization, confirmations, video storage/RLS, routing persistence, and React Query invalidation details are in `docs/ARCHITECTURE.md`. Design primitives, dark-mode rules, responsive layout, and the editorial page-header pattern are in `docs/DESIGN_SYSTEM.md`.

## Critical invariants (read once)

- **HashRouter intentional** (GitHub Pages). URLs contain `/#/`. Vite `base` is `/sl_app/`. Pages are `React.lazy`-loaded in `routes.jsx`.
- **Outer page must not scroll.** `html, body, #root` are `overflow: hidden; position: fixed; inset: 0`. `AppShell` is `h-full flex-col` (NOT `h-dvh` — iOS Safari disagrees and spawns a second scrollbar). Only `main` scrolls. Don't touch — this keeps the mobile keyboard from pushing the sticky `BottomNav` mid-page.
- **Dark mode = class-based CSS remap, not `dark:` utilities.** Extend `src/index.css`. Inline `style={{ color }}` does NOT flip — use classes. `disabled:bg-*` variants also don't pick up `.dark .bg-*` remaps; use `disabled:bg-ink-100`.
- **iOS Safari auto-zooms focused `<input>` / `<textarea>` / `<select>` < 16px.** Every text-entry form element is 16px. Don't drop below. File pickers, radios, checkboxes, sliders unaffected.
- **Tailwind 4, CSS-based config.** `@theme` + `@custom-variant` in `src/index.css`. No `tailwind.config.js`.
- **`useWeek.js` owns `useUpdateWeek` AND `useUpdateSession`** — not `useSession.js`.
- **RLS is strict.** New tables need both student- and coach-side policies walking session → profile via `student_profile_for_session()` / `coach_profile_for_session()` helpers in `schema.sql`. Migrations go in `supabase/migrations/<date>_<name>.sql` *and* append to `schema.sql`.
- **Rules of Hooks:** never call `useMemo` (or any hook) after an early return like `if (isLoading) return <Spinner/>`.
- **Test wrapper:** use `renderWithProviders` from `src/test/utils.jsx` (wraps ThemeProvider + QueryClientProvider + AuthContext + MemoryRouter). `matchMedia` polyfill lives in `src/test/setup.js`.

## Commands

```bash
npm run dev       # vite dev (5173)
npm run build     # dist/
npm run preview   # serve dist/ (4173)
npm test          # vitest watch
npm test -- --run # single run (CI)
npm run deploy    # gh-pages → GitHub Pages
```

Test runs are via WSL: `wsl -d Ubuntu -- bash -lc "cd /home/tamachi/sl_app && npm test -- --run"`.

## When you add a feature

1. Load only the files listed in the matching row above. Load `docs/ARCHITECTURE.md` if the change ripples.
2. DB changes → SQL in `supabase/migrations/<date>_<name>.sql` *and* append to `schema.sql`.
3. Tests next to components; stub hooks with `vi.mock(...)`; use `renderWithProviders`.
4. Update the feature-files table here only if you introduced a new feature area.
5. Run `npm test -- --run` and `npm run build` before committing.
6. Update `README.md` / `CLAUDE.md` / `docs/*` to reflect the change before pushing.
