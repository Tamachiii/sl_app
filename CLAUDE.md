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
  lib/           supabase.js  queryClient.js  volume.js
  hooks/         useAuth  useTheme  useProgram  useWeek  useSession
                 useExerciseLibrary  useDuplicate  useStudents
                 useSetLogs  useSessionConfirmation
  components/
    auth/        LoginPage  ProtectedRoute  RoleGate
    layout/      Header  BottomNav  AppShell
    coach/       CoachHome  StudentCard  WeekTimeline  WeekView
                 SessionEditor  ExerciseSlotRow  ExerciseLibrary
                 VolumeBar  ConfirmedSessions
    student/     StudentHome  SessionView  SetRow  RpeInput
    ui/          EditableText  ThemeToggle  Dialog  Spinner  EmptyState  CopyDialog  ConfirmDialog  ErrorBoundary
  test/          setup.js  utils.jsx (renderWithProviders)
supabase/
  schema.sql
  migrations/    <dated SQL files, applied in order>
```

Tests live next to their component as `*.test.jsx`.

---

## Feature → files map

Use this to jump straight to the relevant files. **Do not load anything else** unless the task genuinely crosses boundaries.

| Feature area | Primary files | Shared deps |
|---|---|---|
| Auth / login | `auth/LoginPage`, `hooks/useAuth`, `routes.jsx` | `lib/supabase` |
| Coach student list | `coach/CoachHome`, `coach/StudentCard`, `coach/WeekTimeline`, `hooks/useStudents`, `hooks/useProgram` | `layout/Header` |
| Coach week view | `coach/WeekView`, `hooks/useWeek`, `hooks/useDuplicate`, `coach/VolumeBar`, `lib/volume` | `ui/EditableText`, `layout/Header` |
| Coach session editor | `coach/SessionEditor`, `coach/ExerciseSlotRow`, `hooks/useSession`, `hooks/useExerciseLibrary`, `hooks/useDuplicate` | `coach/VolumeBar`, `ui/EditableText` |
| Coach exercise slot notes | `coach/ExerciseSlotRow` (notes textarea), `student/SessionView` (note display) | `hooks/useSession` (`useUpdateSlot`) |
| Coach exercise library | `coach/ExerciseLibrary`, `hooks/useExerciseLibrary` | `ui/Dialog` |
| Student program | `student/StudentHome`, `hooks/useSessionConfirmation` (for badges) | `layout/Header`, `lib/supabase` |
| Student session logging | `student/SessionView`, `student/SetRow`, `student/RpeInput`, `hooks/useSession`, `hooks/useSetLogs` | — |
| Session confirmations | `hooks/useSessionConfirmation`, `student/SessionView`, `coach/WeekView` (badge), `coach/ConfirmedSessions`, `coach/SessionReview` | — |
| Goals & progress | `hooks/useGoals`, `coach/StudentGoals`, `student/MyGoals` | `hooks/useExerciseLibrary`, `layout/BottomNav` (Goals tab) |
| Theming | `hooks/useTheme`, `ui/ThemeToggle`, `index.css` | `layout/Header` |

---

## Gotchas (read once, never re-discover)

- **Tailwind 4, CSS-based config.** `@theme` and `@custom-variant` live in `src/index.css`. There's no `tailwind.config.js`.
- **Dark mode = CSS overrides, not `dark:` utilities.** Extend `src/index.css` rather than sprinkle `dark:` classes. Class-based (`.dark` on `<html>`).
- **HashRouter is intentional** (GitHub Pages). URLs contain `/#/`.
- **`useWeek.js` owns `useUpdateWeek` and `useUpdateSession`** (not `useSession.js`). Weeks-level and sessions-level write mutations are consolidated there.
- **`useTheme()` has a no-op fallback** when no provider is mounted — convenient for isolated tests. Don't rely on it in production paths.
- **Test wrapper adds `ThemeProvider`.** Use `renderWithProviders` from `src/test/utils.jsx`; it wraps `ThemeProvider` + `QueryClientProvider` + `AuthContext` + `MemoryRouter`.
- **matchMedia polyfill** is in `src/test/setup.js` — needed by `ThemeProvider` under jsdom.
- **Vite `base` is `/sl_app/`** and there's a manual-chunks split (`router`, `query`, `supabase`). Pages are lazy-loaded in `routes.jsx`.
- **React Rules of Hooks:** Never call `useMemo` or any other hook after an early return like `if (isLoading) return <Spinner/>`. Always put hooks at the top of the component.
- **RLS is strict.** When adding tables, add both student- and coach-side policies. Walk session → profile via `student_profile_for_session()` / `coach_profile_for_session()` helpers (defined in `schema.sql`).
- **Swapping `week_number` requires a 3-step update** because of the `UNIQUE(program_id, week_number)` constraint: bump A to a temp value, move B, then move A.

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
3. Add tests next to components; stub hooks with `vi.mock(...)`; use `renderWithProviders` when rendering anything with `Header`.
4. Update this file's feature table only if you introduced a new feature area.
5. Run `npm test -- --run` and `npm run build` before committing.
6. Update `README.md` and `CLAUDE.md` to reflect the new feature (domain model, feature table, gotchas, etc.) before pushing.
