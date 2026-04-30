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
    coach/       CoachDashboard  CoachHome (Students-tab layout) ProgramSwitcher
                 WeekTimeline  WeekView  SessionEditor  SessionReview
                 ExerciseSlotRow  ExerciseLibrary  SessionsFeed  SlotProgress
                 StudentProfileSection  StudentProgrammingSection
                 StudentGoalsSection  StudentStatsSection  CoachMessages
    student/     StudentHome  StudentSessions  SessionCard  SessionView  SetRow
                 RpeInput  StudentDashboard(Stats)  SessionCalendar
                 ExerciseProgressChart  MyGoals  VideoUploadButton  StudentMessages
    messaging/   MessageThread  MessageComposer  ConversationList
                 UnreadMessagesBadge
    notifications/ NotificationBell
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
| Coach single-student view (tabbed) | `coach/CoachHome` (layout + tab strip), `coach/StudentProfileSection` (owns "View sessions" + "Message" actions), `coach/StudentProgrammingSection`, `coach/StudentGoalsSection`, `coach/StudentStatsSection`, `routes.jsx` (nested `/coach/students/:id/{profile,programming,goals,stats}`) |
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
| Student stats | `student/StudentDashboard`, `student/SessionCalendar`, `student/ExerciseProgressChart`, `student/ProgramScopeSelector`, `hooks/useStudentProgressStats`, `hooks/useStudentHistoricalSessions`, `hooks/useStudents` (`useMyStudentId`) |
| Student session logging | `student/SessionView`, `student/SetRow`, `student/RpeInput`, `hooks/useSession`, `hooks/useSetLogs` |
| Coach goals (per student) | `coach/StudentGoalsSection`, `hooks/useGoals` |
| Student goals | `student/MyGoals`, `hooks/useGoals` |
| User menu popover | `ui/UserMenu` (every top-level page's right-aligned header action) |
| Theming | `hooks/useTheme`, `ui/ThemeToggle`, `index.css` |
| i18n (EN/FR/DE) | `hooks/useI18n`, `lib/i18n/`, `ui/LanguageSelect` |
| Day-number helpers | `lib/day.js` |
| Messaging (coach ↔ student) | `messaging/MessageThread`, `messaging/MessageComposer`, `messaging/ConversationList`, `messaging/UnreadMessagesBadge`, `coach/CoachMessages`, `student/StudentMessages`, `hooks/useMessages`. The Coach surface enters a thread either from `/coach/messages` or via the **Message** button on the per-student Profile tab. |
| Notifications | `notifications/NotificationBell` (rendered inside `ui/UserMenu`), `hooks/useNotifications`, DB trigger `notify_coach_on_session_confirm` |

Periodization, confirmations, video storage/RLS, routing persistence, and React Query invalidation details are in `docs/ARCHITECTURE.md`. Design primitives, dark-mode rules, responsive layout, and the editorial page-header pattern are in `docs/DESIGN_SYSTEM.md`.

## Critical invariants (read once)

- **HashRouter intentional** (GitHub Pages). URLs contain `/#/`. Vite `base` is `/sl_app/`. Pages are `React.lazy`-loaded in `routes.jsx`.
- **Outer page must not scroll.** `html, body, #root` are `overflow: hidden; position: fixed; inset: 0`. `AppShell` is `h-full flex-col` (NOT `h-dvh` — iOS Safari disagrees and spawns a second scrollbar). Only `main` scrolls. Don't touch — this keeps the mobile keyboard from pushing the sticky `BottomNav` mid-page.
- **Dark mode = class-based CSS remap, not `dark:` utilities.** Extend `src/index.css`. Inline `style={{ color }}` does NOT flip — use classes. `disabled:bg-*` variants also don't pick up `.dark .bg-*` remaps; use `disabled:bg-ink-100`.
- **iOS Safari auto-zooms focused `<input>` / `<textarea>` / `<select>` < 16px.** Every text-entry form element is 16px. Don't drop below. File pickers, radios, checkboxes, sliders unaffected.
- **Tailwind 4, CSS-based config.** `@theme` + `@custom-variant` in `src/index.css`. No `tailwind.config.js`.
- **`useWeek.js` owns `useUpdateWeek` AND `useUpdateSession`** — not `useSession.js`.
- **Per-set targets live on `set_logs`, not `exercise_slots`.** Each set_log row stores both prescription (`target_reps`, `target_duration_seconds`, `target_weight_kg`, `target_rest_seconds`) and student actuals (`done`, `rpe`, `weight_kg`). The legacy `exercise_slots.{reps, weight_kg, duration_seconds, rest_seconds}` columns are kept as deprecated mirrors of set 1 — slated for removal in a follow-up migration. `useAddSlot` materializes one set_log per planned set; `useUpdateSlot` fans uniform target edits to all logs; `useUpdateSetTarget` writes to a single log; `useResetSlotToUniform` re-syncs every log to set 1. `isSlotUniform(slot)` and `formatSlotPrescription(slot)` in `lib/volume.js` decide compact vs. per-set rendering.
- **RLS is strict.** New tables need both student- and coach-side policies walking session → profile via `student_profile_for_session()` / `coach_profile_for_session()` helpers in `schema.sql`. Migrations go in `supabase/migrations/<date>_<name>.sql` *and* append to `schema.sql`.
- **Notifications are SECURITY DEFINER trigger-driven.** The `notifications` table has SELECT/UPDATE policies for the recipient only — there is **no client INSERT policy**. Events get into the table exclusively via DB triggers (currently `notify_coach_on_session_confirm` on `session_confirmations`). Adding a new event type = new trigger + new client `describeNotification` branch + new i18n key. The bell lives inside `ui/UserMenu` so every top-level page gets it for free; realtime updates are wired through `useNotificationsRealtime` mounted once in `AppShell`. Like messages, the table is in `supabase_realtime` with `REPLICA IDENTITY FULL`.
- **Messaging is realtime + RLS-scoped.** `messages` rows have `sender_id` and `recipient_id` (both `profiles.id`). RLS lets either party SELECT, only the sender INSERT (and only when the pair is coach-student via `profiles_are_coach_student()`), and only the recipient UPDATE — and a `BEFORE UPDATE` trigger pins every column except `read_at` so "mark read" can't be used to mutate the body. The table is in the `supabase_realtime` publication with `REPLICA IDENTITY FULL`; [hooks/useMessages.js](src/hooks/useMessages.js) opens **one** channel from `AppShell` (`useMessagesRealtime`) and invalidates the `[messages]` React Query subtree on INSERT/UPDATE. The Messages nav tab carries an unread-count badge fed by `useUnreadMessageCount`. Conversations roll-up is a client-side fold over recent rows — fine at coach scale, swap for an RPC if the table grows.
- **Coach Students-page layout owns the student lookup.** [CoachHome.jsx](src/components/coach/CoachHome.jsx) resolves the `:studentId` from `useStudents()` and exposes the resolved student to all four sub-tabs (Profile, Programming, Goals, Stats) via `<Outlet context={{ student }} />`. Each tab section reads it with `useOutletContext()`. `/coach/students/:id` redirects to `…/programming` (the index sub-route) to preserve the prior landing UX. The legacy `/coach/student/:id/goals` URL redirects to `…/students/:id/goals`. The legacy `…/students/:id/messaging` deep link redirects to `…/profile` (where the **Message** action now lives, alongside **View sessions**).
- **Past-program sessions are read-only on the student surface.** A session is locked iff `programs.is_active = false` OR `sessions.archived_at IS NOT NULL`. Enforced UI-side in `SessionView` via `isReadOnly` (derived from `session.program_is_active` + `archived_at`) and DB-side by student RLS on `set_logs` / `session_confirmations` / `slot_comments` (helpers `program_active_for_session`, `program_active_for_slot`). Coach writes are never gated this way.
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
