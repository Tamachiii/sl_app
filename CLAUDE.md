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
    coach/       CoachDashboard  StudentWeekStrip  CoachHome (Students-tab layout) ProgramSwitcher
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
| Coach dashboard | `coach/CoachDashboard`, `coach/StudentWeekStrip`, `hooks/useStudents`, `hooks/useSessionConfirmation`, `hooks/useProgram` |
| Coach single-student view (tabbed) | `coach/CoachHome` (layout + tab strip), `coach/StudentProfileSection` (owns "View sessions" + "Message" actions), `coach/StudentProgrammingSection`, `coach/StudentGoalsSection`, `coach/StudentStatsSection`, `routes.jsx` (nested `/coach/students/:id/{profile,programming,goals,stats}`) |
| Coach programs CRUD | `coach/ProgramSwitcher`, `hooks/useProgram` |
| Coach week reordering | `coach/WeekTimeline`, `hooks/useWeek` (`useReorderWeeks`) |
| Coach sessions feed | `coach/SessionsFeed`, `hooks/useSessionConfirmation` |
| Coach week view | `coach/WeekView`, `hooks/useWeek`, `hooks/useDuplicate` |
| Coach session editor | `coach/SessionEditor`, `coach/ExerciseSlotRow`, `hooks/useSession`, `hooks/useExerciseLibrary` |
| Coach session review | `coach/SessionReview`, `coach/SessionFeedbackComposer`, `coach/SessionFeedbackSent`, `coach/SessionReviewedNoFeedback`, `hooks/useSession` (`useMarkSessionReviewed`), `hooks/useSetLogs`, `hooks/useSlotComments`, `hooks/useSessionConfirmation`, `hooks/useMessages` (`useSessionFeedback`) |
| Set video upload/playback | `student/VideoUploadButton`, `ui/VideoPlayer`, `coach/SessionReview`, `hooks/useSetVideo` |
| Coach exercise library | `coach/ExerciseLibrary`, `hooks/useExerciseLibrary` |
| Student home | `student/StudentHome`, `student/SessionCard`, `hooks/useStudentProgramDetails`, `hooks/useSessionConfirmation` |
| Student sessions list | `student/StudentSessions`, `student/SessionCard`, `hooks/useStudentProgramDetails` |
| Student stats | `student/StudentDashboard`, `student/SessionCalendar`, `student/ExerciseProgressChart`, `student/ProgramScopeSelector`, `lib/statsPrefs.js` (program-scope + exercise-selection persistence), `hooks/useStudentProgressStats`, `hooks/useStudentHistoricalSessions`, `hooks/useStudents` (`useMyStudentId`) |
| Student session logging | `student/SessionView`, `student/SetRow`, `student/RpeInput`, `hooks/useSession`, `hooks/useSetLogs` |
| Coach goals (per student) | `coach/StudentGoalsSection`, `hooks/useGoals` |
| Student goals | `student/MyGoals`, `hooks/useGoals` |
| User menu popover | `ui/UserMenu` (every top-level page's right-aligned header action) |
| Theming | `hooks/useTheme`, `ui/ThemeToggle`, `index.css` |
| i18n (EN/FR/DE) | `hooks/useI18n`, `lib/i18n/`, `ui/LanguageSelect` |
| Day-number helpers | `lib/day.js` |
| Messaging (coach ↔ student) | `messaging/MessageThread`, `messaging/MessageComposer`, `messaging/ConversationList`, `messaging/UnreadMessagesBadge`, `messaging/SessionReferenceCard`, `coach/CoachMessages`, `student/StudentMessages`, `hooks/useMessages`. The Coach surface enters a thread either from `/coach/messages` or via the **Message** button on the per-student Profile tab. Coach-authored messages with `session_id` set render a tappable "Re: <session>" reference card above the bubble — coach-side it deep-links to `/coach/student/:studentId/session/:sessionId/review`, student-side to `/student/session/:sessionId`. |
| Notifications | `notifications/NotificationBell` (rendered inside `ui/UserMenu`), `hooks/useNotifications`, DB trigger `notify_coach_on_session_confirm` |

Periodization, confirmations, video storage/RLS, routing persistence, and React Query invalidation details are in `docs/ARCHITECTURE.md`. Design primitives, dark-mode rules, responsive layout, and the editorial page-header pattern are in `docs/DESIGN_SYSTEM.md`.

## Critical invariants (read once)

- **HashRouter intentional** (GitHub Pages). URLs contain `/#/`. Vite `base` is `/sl_app/`. Pages are `React.lazy`-loaded in `routes.jsx`.
- **Outer page must not scroll.** `html, body, #root` are `overflow: hidden; position: fixed; inset: 0`. `AppShell` is `h-full flex-col` (NOT `h-dvh` — iOS Safari disagrees and spawns a second scrollbar). Only `main` scrolls. Don't touch — this keeps the mobile keyboard from pushing the sticky `BottomNav` mid-page.
- **Dark mode = class-based CSS remap, not `dark:` utilities.** Extend `src/index.css`. Inline `style={{ color }}` does NOT flip — use classes. `disabled:bg-*` variants also don't pick up `.dark .bg-*` remaps; use `disabled:bg-ink-100`.
- **iOS Safari auto-zooms focused `<input>` / `<textarea>` / `<select>` < 16px.** Every text-entry form element is 16px. Don't drop below. File pickers, radios, checkboxes, sliders unaffected.
- **Tailwind 4, CSS-based config.** `@theme` + `@custom-variant` in `src/index.css`. No `tailwind.config.js`.
- **`useWeek.js` owns `useUpdateWeek` AND `useUpdateSession`** — not `useSession.js`.
- **Per-set targets live on `set_logs`, not `exercise_slots`.** Each set_log row stores both prescription (`target_reps`, `target_duration_seconds`, `target_weight_kg`, `target_rest_seconds`) and student actuals (`done`, `failed`, `rpe`, `weight_kg`). The legacy `exercise_slots.{reps, weight_kg, duration_seconds, rest_seconds}` columns are kept as deprecated mirrors of set 1 — slated for removal in a follow-up migration. `useAddSlot` materializes one set_log per planned set; `useUpdateSlot` fans uniform target edits to all logs; `useUpdateSetTarget` writes to a single log; `useResetSlotToUniform` re-syncs every log to set 1. `isSlotUniform(slot)` and `formatSlotPrescription(slot)` in `lib/volume.js` decide compact vs. per-set rendering.
- **A set_log has three outcome states: pending, done, failed.** `done` and `failed` are mutually exclusive (DB CHECK `set_logs_done_xor_failed`). `useToggleSetDone` and `useSetFailed` each clear the opposite flag in the same patch so a swipe between outcomes never trips the constraint. A failed set may not carry an `rpe` value either (DB CHECK `set_logs_no_rpe_when_failed`); `useSetFailed` nulls `rpe` in the same patch so a student who rated a set then later marked it failed doesn't leave an orphan rating. UI: on mobile, [SetRow.jsx](src/components/student/SetRow.jsx) commits a swipe right-to-left as done and left-to-right as failed (commit threshold 64px, gated on horizontal-dominant motion so vertical scroll still wins); tapping the indicator returns the set to pending from any state. Failed sets disable the RPE input (rating a set you didn't finish isn't meaningful). On the done transition the RPE selector auto-expands so the student can rate without an extra tap; failed sets never auto-expand because RPE is locked. Stats in [useStudentProgressStats.js](src/hooks/useStudentProgressStats.js) only count true `done`; group auto-progression in [SessionView.jsx](src/components/student/SessionView.jsx) treats a set as **resolved** iff `failed OR (done AND rpe != null)` — a done-without-RPE set keeps the group open so the auto-expanded RPE panel survives long enough for the student to record a value. Failed bypasses (no RPE required).
- **Rest timer is an app-wide singleton with one rendering site.** [hooks/useRestTimer.js](src/hooks/useRestTimer.js) holds one `{ logId, endsAt }` in module-scope and exposes it via `useSyncExternalStore`. Validating a new set calls `startRestTimer(logId, seconds)` which **replaces** the previous timer. Remaining seconds are derived from `endsAt - Date.now()` (timestamp-based, not a tick counter), and the hook listens to `visibilitychange` + `focus` so the timer stays correct after the tab is backgrounded or the phone is locked. `clearRestTimer(logId)` is a no-op unless the active timer matches — undoing a stale set never kills the current rest. Rendering lives in **one** place: [RestTimerBanner.jsx](src/components/student/RestTimerBanner.jsx) — a sticky pill mounted in `SessionView` just below the top bar — so the indicator survives exercise-card transitions. SetRow only writes to the singleton on done/undone transitions; it never reads or renders remaining time. The banner shows `Rest m:ss` while running, flashes "Rest done" on expiry, and auto-hides ~5s later.
- **RLS is strict.** New tables need both student- and coach-side policies walking session → profile via `student_profile_for_session()` / `coach_profile_for_session()` helpers in `schema.sql`. Migrations go in `supabase/migrations/<date>_<name>.sql` *and* append to `schema.sql`.
- **Notifications are SECURITY DEFINER trigger-driven.** The `notifications` table has SELECT/UPDATE policies for the recipient only — there is **no client INSERT policy**. Events get into the table exclusively via DB triggers (`notify_coach_on_session_confirm` on `session_confirmations`; `notify_student_on_session_feedback` on `messages` when `session_id IS NOT NULL`). Adding a new event type = new trigger + new client `describeNotification` branch + new i18n key. The bell lives inside `ui/UserMenu` so every top-level page gets it for free; realtime updates are wired through `useNotificationsRealtime` mounted once in `AppShell`. Like messages, the table is in `supabase_realtime` with `REPLICA IDENTITY FULL`.
- **Messaging is realtime + RLS-scoped.** `messages` rows have `sender_id`, `recipient_id` (both `profiles.id`), and an optional `session_id` (FK to `sessions`, ON DELETE SET NULL) used by the coach-feedback flow. RLS lets either party SELECT, only the sender INSERT (and only when the pair is coach-student via `profiles_are_coach_student()`); when `session_id` is non-null the policy also requires sender = `coach_profile_for_session(session_id)` and recipient = `student_profile_for_session(session_id)` so the link can't be forged. Only the recipient UPDATEs — the `BEFORE UPDATE` trigger pins every column except `read_at` (including `session_id`). The table is in `supabase_realtime` with `REPLICA IDENTITY FULL`; [hooks/useMessages.js](src/hooks/useMessages.js) opens **one** channel from `AppShell` (`useMessagesRealtime`) and invalidates the `[messages]` subtree on INSERT/UPDATE. `useSessionRefsForMessages` does a single batched fetch of titles/dates for the unique `session_id`s referenced by the visible thread. The Messages nav tab carries an unread-count badge fed by `useUnreadMessageCount`. Conversations roll-up is a client-side fold over recent rows — fine at coach scale, swap for an RPC if the table grows.
- **Coach session review is one-shot per session.** A session can be reviewed at most once — whether the coach left feedback or not. State lives on `sessions.reviewed_at timestamptz`. Two write paths set it: (1) the `notify_student_on_session_feedback` trigger stamps `reviewed_at = NEW.created_at` when a feedback message is inserted (idempotent — `WHERE reviewed_at IS NULL`), and (2) [`useMarkSessionReviewed`](src/hooks/useSession.js) UPDATEs the row directly when the coach clicks "Finish without feedback". The top-of-page back arrow does NOT mark reviewed — it's a "leave and come back" gesture; only Send-feedback and Finish-without-feedback are completion gestures. [SessionReview.jsx](src/components/coach/SessionReview.jsx) renders three branches: [SessionFeedbackSent.jsx](src/components/coach/SessionFeedbackSent.jsx) (feedback exists), [SessionReviewedNoFeedback.jsx](src/components/coach/SessionReviewedNoFeedback.jsx) (`reviewed_at` set but no feedback), or [SessionFeedbackComposer.jsx](src/components/coach/SessionFeedbackComposer.jsx) (not yet reviewed). [SessionsFeed.jsx](src/components/coach/SessionsFeed.jsx) shows a green "Reviewed" pill on cards whose session has `reviewed_at` set; [`useAllConfirmations`](src/hooks/useSessionConfirmation.js) surfaces it. Feedback itself remains one-shot independently — a UNIQUE partial index on `messages(session_id) WHERE session_id IS NOT NULL` guarantees ≤ 1 feedback row per session, and the messages UPDATE trigger pins `body` + `session_id` so feedback is immutable once sent.
- **Coach dashboard week-strip data is folded into one query.** [useCoachDashboardPrograms](src/hooks/useProgram.js) returns, per student, `{ programName, activeWeek, weekDays }` where `weekDays` is a 7-slot M..S array of `{ dayNumber, session, confirmed }`. Day-mapping uses `sessionDayNumber()` from [lib/day.js](src/lib/day.js) (prefers `scheduled_date` over `day_number`) and prefers an active session over an archived sibling on the same day. [StudentWeekStrip.jsx](src/components/coach/StudentWeekStrip.jsx) renders the strip purely from `weekDays` + `todayDayNumber()` — status mapping (completed / today / upcoming / missed / rest) is local to the component, no extra fetches per card.
- **Coach Students-page layout owns the student lookup.** [CoachHome.jsx](src/components/coach/CoachHome.jsx) resolves the `:studentId` from `useStudents()` and exposes the resolved student to all four sub-tabs (Profile, Programming, Goals, Stats) via `<Outlet context={{ student }} />`. Each tab section reads it with `useOutletContext()`. `/coach/students/:id` redirects to `…/programming` (the index sub-route) to preserve the prior landing UX. The legacy `/coach/student/:id/goals` URL redirects to `…/students/:id/goals`. The legacy `…/students/:id/messaging` deep link redirects to `…/profile` (where the **Message** action now lives, alongside **View sessions**).
- **Stats page selections are persisted in URL + localStorage.** Program scope lives in the URL (`?scope=` on `/student/stats`, `?statsScope=` on `/coach/students/:id/stats`) so a refresh holds — but a tab switch drops the search params, so [lib/statsPrefs.js](src/lib/statsPrefs.js) mirrors `{ scope, exerciseId }` to localStorage too. On mount, if the URL has no scope param, the parent hydrates it from localStorage. The exercise selection inside [ExerciseProgressChart.jsx](src/components/student/ExerciseProgressChart.jsx) reads/writes its own `localStorage` slot via the `storageKey` prop. Keys are namespaced per surface — `sl_stats_prefs:self` for the student, `sl_stats_prefs:coach:<studentId>` for each coach view — so a coach hopping between students never drags one student's selection onto another. Stale ids fall back gracefully via the existing `scopeIsValid` and `exercises.some(...)` checks.
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
