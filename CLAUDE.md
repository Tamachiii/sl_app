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
    layout/      AppShell  BottomNav  SideNav  navItems
    coach/       CoachDashboard  CoachHome  StudentCard  ProgramSwitcher
                 WeekTimeline  WeekView  SessionEditor  SessionReview
                 ExerciseSlotRow  ExerciseLibrary  SessionsFeed
                 StudentGoals  SlotProgress
    student/     StudentHome  StudentSessions  SessionCard  SessionView  SetRow
                 RpeInput  StudentDashboard(Stats)  SessionCalendar
                 ExerciseProgressChart  MyGoals
    ui/          EditableText  ThemeToggle  LanguageSelect  UserMenu  Dialog
                 Spinner  EmptyState  CopyDialog  ConfirmDialog  ErrorBoundary
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
| Coach dashboard | `coach/CoachDashboard` (flat editorial h1 + `ui/UserMenu`; Students list → `/coach/students/:id`; Recent Activity cards), `hooks/useStudents`, `hooks/useSessionConfirmation` (`useAllConfirmations`) | `ui/UserMenu` |
| Coach single-student view | `coach/CoachHome` (dropdown selector + student header + `ProgramSwitcher` + Program/Goals/Stats sections; routes `/coach/students` and `/coach/students/:studentId`; selected program id lives in URL as `?program=:id`), `coach/ProgramSwitcher`, `coach/StudentGoalsSection`, `coach/StudentStatsSection`, `coach/WeekTimeline`, `hooks/useStudents`, `hooks/useProgram` (`useProgramsForStudent`, `useProgram`, `useEnsureProgram`) | `ui/UserMenu`, `hooks/useStudentProgressStats`, `hooks/useGoals` |
| Coach programs CRUD (periodization) | `coach/ProgramSwitcher` (dropdown-style selector: trigger shows selected program + active badge + week count; popover listbox with dnd-kit vertical reorder; sibling `+` and `⋮` buttons for add/manage-selected; Manage dialog for rename/set-active/delete). Rendered inside the Program card in `coach/CoachHome.jsx` (`ProgramCard`) together with `WeekTimeline`, separated by an `sl-hairline`. `hooks/useProgram` (`useCreateProgram`, `useRenameProgram`, `useDeleteProgram`, `useSetActiveProgram`, `useReorderPrograms`, `useActiveProgram`) | `ui/Dialog`, `@dnd-kit/core`, `@dnd-kit/sortable` |
| Coach week reordering | `coach/WeekTimeline` (dnd-kit sortable), `hooks/useWeek` (`useReorderWeeks`) | `@dnd-kit/core`, `@dnd-kit/sortable` |
| Coach sessions feed | `coach/SessionsFeed` (with `?student=:id` filter, editorial h1), `hooks/useSessionConfirmation` (`useAllConfirmations`) | `ui/UserMenu`, `ui/EmptyState` |
| Coach week view | `coach/WeekView` (editorial top bar + single-line sl-card session rows — open a session for volume/detail), `hooks/useWeek`, `hooks/useDuplicate` | `ui/EditableText` |
| Coach session editor | `coach/SessionEditor` (editorial top bar + sl-pill actions), `coach/ExerciseSlotRow`, `hooks/useSession`, `hooks/useExerciseLibrary`, `hooks/useDuplicate` | `ui/EditableText` |
| Coach session review | `coach/SessionReview` (editorial top bar + archive sl-pill + student-note tinted callout), `hooks/useSession`, `hooks/useSetLogs`, `hooks/useSlotComments`, `hooks/useSessionConfirmation`, `hooks/useWeek` (`useArchiveSession`) | `coach/SlotProgress`, `lib/volume` |
| Coach exercise slot notes | `coach/ExerciseSlotRow` (notes textarea), `student/SessionView` (note display) | `hooks/useSession` (`useUpdateSlot`) |
| Record-video set flag | `coach/ExerciseSlotRow` (set chips → `record_video_set_numbers` int[]), `student/SetRow` (camera badge), `student/SessionView` (passes prop) | `hooks/useSession`, `hooks/useStudentProgramDetails` |
| Set video upload/playback | `student/VideoUploadButton` (inside `SetRow` under each flagged set), `ui/VideoPlayer` (signed URL + `<video>`), `coach/SessionReview` (SET N play chips per slot), `hooks/useSetVideo` (`useSetVideos`, `useUploadSetVideo`, `useDeleteSetVideo`, `useSetVideoSignedUrl`) | `set_log_videos` table + `set-videos` storage bucket |
| Coach exercise library | `coach/ExerciseLibrary` (editorial h1 + search-bar row with inline `+ ADD` button + filter pills), `hooks/useExerciseLibrary` | `ui/UserMenu`, `ui/Dialog`, `ui/EmptyState` |
| Student home | `student/StudentHome` (editorial Greeting with `ui/UserMenu`; vertical-written day-strip titles), `student/SessionCard`, `hooks/useStudentProgramDetails`, `hooks/useSessionConfirmation`, `hooks/useAuth` | `ui/UserMenu` |
| Student sessions list | `student/StudentSessions` (editorial h1 + accordion — only one `SessionCard` open at a time — + compact Start/Review CTA), `student/SessionCard`, `hooks/useStudentProgramDetails`, `hooks/useSessionConfirmation` | `ui/UserMenu`, `lib/volume` |
| Student stats | `student/StudentDashboard` (route: /student/stats), `student/SessionCalendar`, `student/ExerciseProgressChart` (per-exercise weekly tonnage), `hooks/useStudentProgressStats`, `hooks/useStudentHistoricalSessions` (calendar overlay for previous non-active program blocks — muted ink-400 dot, separate query from stats so aggregates stay block-local) | `ui/UserMenu`, `lib/volume`, `ui/EmptyState` |
| Student session logging | `student/SessionView` (collapsible exercise cards — auto-open incomplete, auto-collapse completed; supersets collapse as one unit), `student/SetRow`, `student/RpeInput`, `hooks/useSession`, `hooks/useSetLogs` | — |
| Session confirmations | `hooks/useSessionConfirmation`, `student/SessionView`, `coach/WeekView` (badge), `coach/SessionsFeed`, `coach/SessionReview` | — |
| Coach goals (per student) | `coach/StudentGoalsSection` (rendered inside `coach/CoachHome`; inline goal list + form), `hooks/useGoals` | `hooks/useExerciseLibrary` |
| Student goals | `student/MyGoals` (sl-card rows, per-goal log/toggle-achieved), `hooks/useGoals` | `ui/UserMenu`, `layout/BottomNav` (Goals tab) |
| User menu popover | `ui/UserMenu` (avatar-initials button → popover with Theme / Language / Sign out). Used on every top-level page (both coach & student) as the right-aligned header action. | `ui/ThemeToggle`, `ui/LanguageSelect`, `hooks/useI18n` |
| Theming | `hooks/useTheme`, `ui/ThemeToggle`, `index.css` | `ui/UserMenu` |
| i18n (EN/FR/DE) | `hooks/useI18n`, `lib/i18n/{en,fr,de,index}.js`, `ui/LanguageSelect` | `auth/LoginPage`, `ui/UserMenu` |
| Day-number helpers | `lib/day.js` (`DAY_LABELS`, `DAY_FULL`, `todayDayNumber`) | `student/StudentHome`, `student/SessionView` |

---

## Design system

Full primitives, dark-mode rules, and the editorial page-header pattern are in [docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md). Short version for agents:

- **Do not** swap in `dark:` utilities or `text-gray-*` ad-hoc. Use `sl-card` / `sl-display` / `sl-label` / `sl-mono` / `sl-pill` / `sl-btn-primary` + the warm `ink-*` scale.
- **Editorial page header** on every screen: back button (`w-9 h-9 rounded-lg bg-ink-100`) + `sl-label` kicker + `sl-display` h1 + right-aligned `sl-pill` action buttons. Every top-level page (both coach & student) additionally renders `ui/UserMenu` (avatar-initials popover → Theme / Language / Sign out) as the right-aligned action; wrap the header in `flex items-start justify-between gap-4`.
- **Compact CTA**: override `sl-btn-primary` with `className="… text-[13px]" style={{ padding: '10px 16px' }}` (see `SessionCard`, `ExerciseLibrary` ExerciseForm).
- **Tinted surfaces** use `color-mix(in srgb, var(--color-accent) 10%, transparent)` (and success/warn/danger) so they adapt to both themes.
- **Day-strip session titles** on `StudentHome` use `writing-mode: vertical-rl; transform: rotate(180deg)` to read top-to-bottom without wrapping in the narrow 7-column grid.
- **Responsive layout** lives in `layout/AppShell` + `SideNav` + `BottomNav`. Mobile is `flex-col` with a sticky `BottomNav`; from `md:` up (`≥ 768px`) the shell becomes `flex-row`, `BottomNav` gets `md:hidden`, and `SideNav` (`hidden md:flex w-56`) becomes the left rail. Both nav components share their item list via `layout/navItems.getNavItems(role, t)` so there's exactly one place to edit tabs. Content in `main` is wrapped in `mx-auto w-full max-w-5xl` so it caps around ~1024px on wide monitors. Per-screen roots use `p-4 pb-6 md:p-8`; display headings scale `text-[28px] md:text-[40px]` (coach h1s) or `text-[32px] md:text-[44px]` (student h1s). List screens (CoachHome, CoachDashboard activity, SessionsFeed, ExerciseLibrary) switch to a 2-column grid at `md:` via `space-y-* md:grid md:grid-cols-2 md:gap-* md:space-y-0`.

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
- **SessionCalendar history overlay.** `useStudentHistoricalSessions` fetches dated sessions from the student's NON-active programs (`is_active=false`). `StudentDashboard` merges them into the array passed to `SessionCalendar`, flagged `historical: true`. In `SessionCalendar`, a day shows the history dot (muted `--color-ink-400`) ONLY when it has no active-program sessions — active takes visual priority when both exist on the same day. Historical days are still wrapped in the `<Link>` since the "Students read own sessions" RLS policy is scoped to program ownership, not `is_active`, so students can re-open past sessions read-only. Keep the query separate from `useStudentProgressStats` so stats aggregates (tonnage, sessions/sets, RPE, chart data) stay scoped to the active block.
- **Programs are periodization blocks.** `programs` has `sort_order int` and `is_active boolean` (migration `2026_04_23_programs_crud.sql`). A partial unique index `programs_one_active_per_student ON programs(student_id) WHERE is_active` enforces at-most-one-active per student. Students only see the active program: `useStudentProgramDetails` + `useStudentProgressStats` both filter `.eq('is_active', true)`. Coaches browse all programs via `useProgramsForStudent(studentId)` (list w/o weeks) and open one via `useProgram(programId)` (detail w/ weeks). `useActiveProgram(studentId)` is the convenience resolver for "the student's current block" and backs `CopyDialog`'s destination. **`useProgram` now takes `programId`, not `studentId`** — this was a breaking rename during the periodization refactor. `useSetActiveProgram` deactivates the current active program first (else the partial unique index rejects the insert); `useCreateProgram` with `setActive: true` does the same. `useEnsureProgram` explicitly inserts `is_active: true` since the column default is now `false`.
- **Reordering weeks uses `useReorderWeeks`** — a two-pass update (park all at `100000+idx`, then assign `idx+1`) to dodge the `UNIQUE(program_id, week_number)` constraint. Triggered from `WeekTimeline` drag-and-drop. `useReorderPrograms` mirrors the same two-pass pattern for programs (even though `sort_order` has no unique constraint) so the code reads identically.
- **WeekTimeline is dnd-kit sortable.** Each week pill has a separate drag handle (6-dot grip) — the label area still navigates on click. Touch drag needs a 200ms press delay (`TouchSensor` activation) so taps don't trigger drags. Tests that render `WeekTimeline` (directly or via `CoachHome`) must mock `useReorderWeeks` from `hooks/useWeek`.
- **Coach single-student page.** `/coach/students` shows the dropdown selector with no student picked (empty-state prompt). `/coach/students/:studentId` resolves the URL param to a student and renders Program / Goals / Stats in one scroll. Dashboard student cards and legacy `/coach/student/:studentId/goals` redirect into this page (`RedirectToStudent` in `routes.jsx` interpolates the param — plain `<Navigate to="/foo/:id" />` does NOT). Weeks / session-editor / review routes still live at `/coach/student/:studentId/...` and use `navigate(-1)` to return here.
- **`useStudentProgressStats(studentId?)`** accepts an optional `students.id` row id. Omit for the signed-in student (self-stats), pass it to stat another student from the coach view. `StudentStatsSection` wraps it for the coach single-student page; `StudentDashboard` (student Stats page) calls it with no arg.
- **Exercise Library filtering is client-side.** Search and type-filter state live in `ExerciseLibrary` and are applied with `useMemo` over the already-fetched list — no extra Supabase queries.
- **`NavLink` `end` prop on root tabs.** `BottomNav`'s "Students" (`/coach/students`) and "Home" (`/student`) links use `end` so they only highlight on exact route matches — without it they stay active on all child routes.
- **`StudentDashboard.jsx` is the Stats page.** The file is named `StudentDashboard` but rendered at `/student/stats` (imported as `StudentStats` in routes). The old `/student/dashboard` redirects to `/student/stats`. Don't rename the file — just be aware of the mismatch.
- **`useStudentProgramDetails`** fetches weeks → sessions → exercise_slots → exercise library for the Sessions page. Lighter than `useStudentProgressStats` (no set_log or confirmation queries). Use it whenever you need full slot structure without aggregation.
- **`SessionCard` supports controlled and uncontrolled open state.** Pass `open` + `onToggle` to control it from the parent (this is how `StudentSessions` enforces single-open accordion behavior — only one card expanded at a time). Omit them and the card falls back to its own `useState(defaultOpen)` — this is what `StudentHome`'s standalone upcoming-session card relies on.
- **`SessionView` exercise cards auto-open only the first incomplete group.** Every other group (whether complete or still pending) starts collapsed, so the student always sees exactly one "current exercise". As soon as the last set of group N is marked done, group N collapses and group N+1 opens. Manual taps still win per-group via `manualOpen[groupKey]`, so a student can peek at a later exercise without closing the current one. Supersets collapse as a single unit (grouping from `groupSlotsBySuperset`) since sets alternate across slots.
- **`day_number` on sessions**: 1=Monday … 7=Sunday. `StudentHome` maps these to the 7-day week strip. Sessions with `day_number` outside 1–7 don't appear in the strip but still show in the Upcoming/Completed lists.
- **`record_video_set_numbers` on `exercise_slots`** (`int[]`, defaults to `{}`): coach flags any subset of sets of an exercise for video recording. Student sees an amber "Record" badge on each matching `SetRow`. If the coach reduces `sets` below a picked number, stale entries just don't match any row (no crash). `commitVideoSets` in `ExerciseSlotRow` sorts + dedupes + filters before persisting.
- **Set video uploads** live in `set_log_videos` (1:1 with `set_logs`) + private storage bucket `set-videos`. Path convention: `<profile_id>/<slot_id>/<set>-<uuid>.<ext>`. Storage RLS gates on the first path segment (must equal `auth.uid()` for student ops, or must be a profile_id owned by the coach for coach read). Client caps uploads at 25 MB (bucket caps at 30 MB). Signed URLs have 1h TTL — keyed by `storage_path` in the query cache so they're reused across players. No client-side re-encoding in v1; students see a clear size-limit error if their clip is too large. Replacement uploads delete the old object + row first, so `UNIQUE(set_log_id)` stays clean.

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
