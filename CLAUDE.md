# CLAUDE.md — Working Notes for Future Agents

Per-turn context only. Heavier docs load on demand.

## When to load the other docs

- **`docs/INVARIANTS.md`** — touching: routing/scroll-shell, dark mode, RLS, `set_logs` schema, rest timer (in-app or Web Push), messaging/notifications triggers, offline mutations, service worker, coach session review, stats persistence, role-aware `UserMenu`. **Load before any DB or hook change.** Skip for pure UI polish, copy, or component-local edits.
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
  sw.js          custom service worker (vite-plugin-pwa injectManifest mode):
                 push + notificationclick handlers for rest-timer Web Push
  lib/           supabase.js  queryClient.js  volume.js  day.js  preload.js  i18n/
                 pushNotifications.js
  hooks/         auth · theme · i18n · program · week · session · goals
                 students · set-logs · set-video · confirmations · slot-comments
                 stats · exercise-library · duplicate · remember-coach-students-path
                 rest-timer (singleton) · rest-timer-effects (wake lock + audio)
                 rest-timer-push (Web Push bridge) · push-subscription (toggle)
  components/
    auth/        LoginPage  ProtectedRoute  RoleGate
    layout/      AppShell  BottomNav  SideNav  navItems
    coach/       CoachHome (Athletes roster + single-student tabs)  StudentWeekStrip  ProgramSwitcher
                 ProgramSheet  SessionEditor  SessionReview
                 ProgramManageDialog  ProgramTrashDialog  ProgramBadges
                 ExerciseSlotRow  ExerciseLibrary  SessionsFeed  SlotProgress
                 StudentOverview  PreviousSessionPanel
                 StudentProgrammingSection  StudentGoalsSection
                 StudentStatsSection  CoachMessages
    student/     StudentHome  StudentSessions  SessionCard  SessionView  SetRow
                 RpeInput  StudentDashboard(Stats)  SessionCalendar
                 ExerciseProgressChart  MyGoals  VideoUploadButton  StudentMessages
                 StudentProfile
    messaging/   MessageThread  MessageComposer  ConversationList
                 UnreadMessagesBadge
    notifications/ NotificationBell
    ui/          EditableText  LanguageSelect  UserMenu  Dialog
                 VideoPlayer  Spinner  EmptyState  CopyDialog  ConfirmDialog
                 ErrorBoundary  NotFound
  test/          setup.js  utils.jsx (createTestQueryClient)
supabase/        schema.sql  migrations/  functions/dispatch-rest-push/
docs/            INVARIANTS.md  ARCHITECTURE.md  DESIGN_SYSTEM.md  ENVIRONMENT.md
```

Tests live next to components as `*.test.jsx`.

## Feature → files map

Jump straight to the relevant files. For *behavior* details, open the file — the code is the spec.

| Feature | Primary files |
|---|---|
| Auth / login | `auth/LoginPage`, `hooks/useAuth`, `routes.jsx` |
| Coach Athletes roster (attention-first list; merged Dashboard + Students into one tab) | `coach/CoachHome` (roster landing + single-student tab host), `coach/StudentWeekStrip`, `lib/coachRoster` (`buildRoster` — pure), `lib/day` (`statusOf`/`deriveWeekStats`), `hooks/useStudents`, `hooks/useSessionConfirmation` (`useAllConfirmations`), `hooks/useProgram` (`useCoachDashboardPrograms`), `hooks/useClientErrors`. Search + per-athlete attention chips (to-review / missed / no-program), all derived client-side from already-loaded coach-wide queries; ordered attention-first then A–Z; card → single-student tabs. `/coach/dashboard` now redirects here |
| Coach single-student view (ONE page, no tabs) | `coach/CoachHome` (on an athlete route its own page header BECOMES the athlete — "‹ All athletes" in the kicker slot, the name as the `h1`; there is no separate identity block and `StudentHeader` is deleted), `coach/StudentOverview` (collapsible Programming / Goals / Stats sections; open state in `localStorage` under `sl_coach_student_sections`; collapsed sections are **unmounted**, so they cost no query), `routes.jsx`. The athlete lives at `/coach/students/:studentId`; session editing is the only child (`s/:sessionId`). Every former tab URL (`programming`, `progress`, `profile`, `goals`, `stats`, `messaging`) redirects to the page |
| Session "Last time" reference | `coach/PreviousSessionPanel` (exported `findPreviousSession` matches the same weekday in week N−1, falling back to sort_order; skips archived). Collapsed by default and only fetches the slot tree once opened, so writing week N against week N−1 costs no navigation |
| Coach programs CRUD | `coach/ProgramSwitcher` (picker + reorder; the trigger is the program NAME across the row — no pill, no week count, ACTIVE reduced to an `ActiveDot` — and both list-level actions, "+ PROGRAM" and Trash, live in the dropdown footer rather than beside the name), `coach/ProgramManageDialog` (rename / set active / duplicate / trash / draft approve-send back), `coach/ProgramTrashDialog`, `coach/ProgramBadges`, `hooks/useProgram`. `useTrashedPrograms` takes `{ enabled }` and only fires while the picker is open |
| Program duplicate (whole-block copy, same student) | `coach/ProgramSwitcher` (ManageProgramDialog "Duplicate program"), `hooks/useDuplicate` (`useDuplicateProgram` + shared `copyWeekTree` helper). Copy is inactive, week numbers/labels preserved, prescription-only (no student actuals) |
| Coach week reordering | `coach/ProgramSheet` ("Reorder weeks" toggle → dnd-kit vertical sort), `hooks/useWeek` (`useReorderWeeks`) |
| Coach sessions feed | `coach/SessionsFeed`, `hooks/useSessionConfirmation` |
| Coach Program Sheet (the Programming tab — whole block on one page) | `coach/ProgramSheet` (week cards listing their sessions inline: day pill + title + N ex + confirmed ✓ + archived drawer; week ⋯ menu = duplicate / copy to… / reorder / delete; session delete lives in the editor, not on the rows), `coach/StudentProgrammingSection`, `hooks/useProgram` (`useProgram` carries weeks→sessions→slot ids), `hooks/useSessionConfirmation` (`useProgramConfirmedSessionIds`), `hooks/useWeek`, `hooks/useDuplicate`, `lib/day` (`nextFreeDayNumber`, `compareSessions` — sessions list by weekday, not creation order). **Replaced `WeekTimeline` + the `WeekView` page** — editing an exercise is now 1 navigation, not 3 |
| Coach session editor | `coach/SessionEditor` (renders INSIDE the athlete shell at `/coach/students/:studentId/programming/s/:sessionId` — no page padding of its own), `coach/ExerciseSlotRow`, `hooks/useSession`, `hooks/useExerciseLibrary` |
| Coach session review | `coach/SessionReview`, `coach/SessionFeedbackComposer`, `coach/SessionFeedbackSent`, `coach/SessionReviewedNoFeedback`, `hooks/useSession`, `hooks/useSetLogs`, `hooks/useSlotComments`, `hooks/useSessionConfirmation`, `hooks/useMessages` |
| Set video upload/playback | `student/VideoUploadButton`, `ui/VideoPlayer`, `coach/SessionReview`, `hooks/useSetVideo` |
| Coach exercise library | `coach/ExerciseLibrary`, `hooks/useExerciseLibrary` |
| Student home | `student/StudentHome`, `student/SessionCard`, `hooks/useStudentProgramDetails`, `hooks/useSessionConfirmation`, `hooks/useMessages` (`useMyFeedbackSessionIds`) |
| Student sessions list | `student/StudentSessions`, `student/SessionCard`, `hooks/useStudentProgramDetails`, `hooks/useMessages` (`useMyFeedbackSessionIds`) |
| Student stats | `student/StudentDashboard`, `student/SessionCalendar`, `student/ExerciseProgressChart`, `student/ProgramScopeSelector`, `lib/statsPrefs.js`, `hooks/useStudentProgressStats`, `hooks/useStudentHistoricalSessions`, `hooks/useStudents` |
| Student session logging | `student/SessionView`, `student/SetRow`, `student/RpeInput`, `hooks/useSession`, `hooks/useSetLogs`, `hooks/useMessages` (`useSessionFeedback` for the inline coach-feedback card) |
| "Last time" hint (prior performance at point of logging) | `student/SlotGroupCard` (`LastTimeHint` inside the expanded card), `hooks/useLastPerformance` (student-only, RLS-scoped; no `students.id` resolve), `lib/lastPerformance` (`buildLastPerformance`/`formatLastPerformance`/`daysSince`), `lib/records` (`effectiveWeight`/`effectiveReps`), wired in `student/SessionView` |
| Off-plan deviation logging (student records actual reps/load) | `student/SetRow` (Actual pill + editor), `hooks/useSetLogs` (`useLogActual`), `lib/offlineMutations` (`logActual`), `lib/volume` (`hasLoggedActual`/`formatActual`), `coach/SessionReview` (Off-plan band), migration `2026_06_28_set_log_actuals.sql` (`set_logs.actual_*` + `pin_set_log_targets_for_student` trigger) |
| Structural deviations (swap/skip exercise, skip/add set) | `student/SlotDeviationBar` (swap/skip + library picker), `student/SetRow` (skip/extra-set), `student/SlotGroupCard` (add-set), `hooks/useSlotDeviations`, `hooks/useSetLogs` (`useSetSkipped`/`useAddStudentSet`/`useRemoveStudentSet`), `lib/offlineMutations` (`saveSlotDeviation`/`setSkipped`), `coach/SessionReview` + `coach/SlotProgress` (banner + skipped/extra pills), `hooks/useNotifications` (`session_deviation`), migration `2026_06_28_slot_deviations.sql` (`slot_deviations` table + `set_logs.skipped`/`is_student_added` + `notify_coach_on_slot_deviation` trigger) |
| Student program authoring (Phase 3.4, OFFLINE-capable) | `student/StudentProgramAuthor` (lean self-contained draft builder — weeks/sessions/slots + slot targets; English-only), `hooks/useAuthoring`: `useMyDraft`/`useDraftTree` (queries) + `useDraftActions(programId)` (optimistic-cache editors with client-minted `crypto.randomUUID()` ids) + `useCreateDraft` + the two keyed offline mutations `useSaveDraftTree`/`useDiscardDraft`. Every edit syncs the WHOLE tree as one idempotent snapshot via the `save_draft_tree` RPC (`2026_07_24_save_draft_tree.sql`, SECURITY INVOKER, declarative full-replace). **No set_logs** (materialized by `approve_program` at approval). Persisted roots `my-draft`/`draft-tree`/`exercise-library`; dedicated `draft-tree` FIFO scope; resume-then-reconcile in `App.jsx`/`AppShell`. Route `/student/author` + CTA on `student/StudentProfile`. DB gate + `approve_program` in `2026_07_21_student_program_authoring.sql` (see the Phase 3.4 INVARIANTS entry) |
| Coach approve / send-back of a submitted draft (Phase 3.4c) | `coach/ProgramSwitcher` (ManageProgramDialog draft banner with Approve / Send back + `DraftBadge` DRAFT/SUBMITTED chips in the list & trigger), `hooks/useProgram` (`useApproveProgram` → rpc `approve_program`, `useSendBackProgram` → rpc `send_back_program`; `useProgramsForStudent` selects `status, submitted_at`), migration `2026_07_22_program_submit_notify.sql` (`notify_coach_on_program_submit` AFTER UPDATE trigger on submitted_at NULL→set + `send_back_program` coach-only RPC), notifications `program_submitted` (coach) / `program_approved` / `program_sent_back` (student) in `hooks/useNotifications` + i18n. Approve materializes set_logs and flips `status='approved'` **inactive** — the coach then Sets active |
| Student proposal loop (Phase 3.3) | `student/SlotDeviationBar` ("Ask coach to make this permanent" → `hooks/useSlotDeviations` `useRequestPromote`, online-only), `coach/SessionReview` (★ request highlight + Decline → `hooks/useAdoptSwap` `useDeclinePromote`), migration `2026_07_20_deviation_promote_request.sql` (`slot_deviations.promote_requested_at` + `notify_coach_on_promote_request` AFTER UPDATE trigger + `decline_promote_request` RPC). Approve = the adopt RPCs; notifications `promote_requested`/`promote_declined` |
| Adopt deviation → program edit (Phase 3.1/3.2) | `coach/SessionReview` ("Adopt into program" on the swap banner / "Remove from upcoming" on the skip banner) + `coach/AdoptSwapDialog` + `coach/RemoveExerciseDialog` (blast-radius confirm), `hooks/useAdoptSwap` (`useAdoptSwap`/`useAdoptSwapPreview` + `useAdoptSkip`/`useAdoptSkipPreview` dry-runs), migrations `2026_07_18_adopt_swap.sql` (`adopt_swap` — flips `exercise_id` X→Y) + `2026_07_19_adopt_skip.sql` (`adopt_skip` — DELETEs upcoming X slots). Both SECURITY DEFINER, coach self-auth, **forward-only** via a strict ordinal + performed-history predicate (never rewrites a trained/reviewed session), keep `target_*` as a seed, notify the student (`swap_adopted`/`skip_adopted`). Coach-only, online-only |
| Coach goals (per student) | `coach/StudentGoalsSection` (rendered as the Goals section of the Progress tab, not a tab of its own), `hooks/useGoals` |
| Student goals | `student/MyGoals`, `hooks/useGoals` |
| Student profile | `student/StudentProfile`, `hooks/useStudentLifetimeStats`, `hooks/useAuth`, `hooks/useStudents` (`useMyCoach`), `hooks/useGoals` (`useMyGoals`) |
| Personal records + bodyweight | `student/PersonalRecords` (list is COLLAPSED behind an "N records" row; open state in `localStorage` under `sl_student_records_open`, fresh-PR badge mirrored onto the collapsed row), `student/BodyweightCard`, `hooks/useStudentRecords`, `hooks/useBodyweight`, `lib/records.js` (Epley e1RM + `systemLoad`), migration `2026_07_14_bodyweight_logs.sql` |
| Relative strength (×BW) | `exercise_library.load_mode` (`full`/`added`/NULL-unclassified, migration `2026_07_23_exercise_load_mode.sql`), coach sets it in `coach/ExerciseLibrary` (`ExerciseForm` select + `· +BW`/`· FULL` meta tag), `lib/records.js` `buildRecords` takes a `bodyweightAt` resolver and emits `relStrength` (the PEAK system-load-e1RM ÷ bodyweight across sets — a true max, not derived from the added-load PR set) + `bwAtBest`; the est-1RM **headline stays the added-load e1RM** (PR selection/sort unchanged). `hooks/useStudentRecords` fetches the `bodyweight_logs` series (coach flow resolves `profile_id`; `useLogBodyweight` invalidates `['student-records']` so a fresh weight unlocks the pill), `student/PersonalRecords` shows the ×BW pill (`toFixed(1)`) + graceful degrade + log-bodyweight nudge. Tonnage/volume stay BW-blind by design |
| Performance-aware stats | `hooks/useStudentProgressStats` (performed vs planned volume/tonnage + adherence; **swap-aware** — an exercise swap credits PERFORMED volume/tonnage to the substitute via a `slot_deviations` fetch, PLANNED stays on the coach's original), `student/WeeklyVolumePanel` (shared with coach), `student/ExerciseProgressChart`. `hooks/useStudentRecords` (PRs) + `hooks/useLastPerformance` ("last time" hint) are **also swap-aware** now — each fetches the student's `slot_deviations` swaps and credits a swapped set to the substitute exercise using ONLY the logged actuals (the pinned `target_*` are the original's, foreign to the substitute); `useLastPerformance` also keys the open-session hint on a current-session swap substitute |
| User menu popover | `ui/UserMenu` (every top-level page's right-aligned header action) |
| Theming (DARK-ONLY — no toggle) | `hooks/useTheme` (provider forces dark; `toggleTheme`/`setTheme` are no-ops), `index.html` (`class="dark"` on `<html>` so there's no light flash), `index.css` (the `.dark` remaps all stay). `ui/ThemeToggle` is **deleted** — an installed iOS PWA colours its status bar from the manifest's single static `theme_color`, so a light theme could never match the strip |
| i18n (EN/FR/DE) | `hooks/useI18n`, `lib/i18n/`, `ui/LanguageSelect` |
| Day-number helpers | `lib/day.js` |
| Messaging (coach ↔ student) | `messaging/MessageThread`, `messaging/MessageComposer`, `messaging/ConversationList`, `messaging/UnreadMessagesBadge`, `messaging/SessionReferenceCard`, `coach/CoachMessages`, `student/StudentMessages`, `hooks/useMessages` |
| Notifications (in-app bell) | `notifications/NotificationBell` (rendered inside `ui/UserMenu`), `hooks/useNotifications`, DB triggers `notify_coach_on_session_confirm` + `notify_student_on_session_feedback` |
| Rest timer (in-app cues + Web Push) | `hooks/useRestTimer`, `hooks/useRestTimerEffects`, `hooks/useRestTimerPush`, `student/RestTimerBanner`, `student/SessionView`, `supabase/functions/dispatch-rest-push/` |
| Web Push subscription toggle | `lib/pushNotifications`, `hooks/usePushSubscription`, `student/StudentProfile` (student rest-timer toggle), `ui/UserMenu` (`PushToggleRow` — coach popover toggle), `src/sw.js` |
| Push subscription self-healing | `lib/pushNotifications` (`reconcilePushSubscription` — upsert-only, permission-gated), `hooks/usePushAutoHeal` (reconcile on load + tab focus, mounted app-wide in `App.jsx`), `src/sw.js` (`pushsubscriptionchange` re-subscribe). Heals a rotated endpoint that `send-push`'s 410-cleanup would otherwise silently drop |
| Event push fan-out (send-push Edge Function via pg_net) | `supabase/functions/send-push/`. Triggers that call it, all Vault-gated + EXCEPTION-wrapped: `notify_student_on_session_feedback` (`2026_05_12_feedback_push.sql`), `notify_coach_on_session_confirm` (`2026_07_17_session_confirm_push.sql`), `notify_coach_on_slot_deviation` (in `2026_06_28_slot_deviations.sql`). Coach pushes require the coach to have opted in via the `ui/UserMenu` toggle |
| Chat message push (no bell row) | `supabase/migrations/2026_07_12_chat_message_push.sql` (`notify_recipient_on_chat_message` → send-push), online-only gates in `messaging/MessageComposer` + `coach/SessionFeedbackComposer` |
| Offline support (student writes) | `lib/queryClient.js`, `lib/offlineMutations.js`, `hooks/useOnlineStatus.js`, `components/ui/OfflineBanner.jsx`, `vite.config.js`, `main.jsx`, `App.jsx` |
| Program trash / archive-first delete | `hooks/useProgram` (`useDeleteProgram`/`useTrashedPrograms`/`useRestoreProgram`/`useHardDeleteProgram`), `coach/ProgramSwitcher` (TrashDialog), migration `2026_07_13_programs_soft_delete.sql` (`programs.deleted_at` + `block_*_delete_with_logged_sets` triggers) |
| Mutation error toast | `lib/toast.js`, `lib/mutationErrors.js`, `ui/ToastHost` (in `AppShell`), `queryClient.js` (MutationCache onError) |
| Error telemetry | `lib/errorReporter.js`, `ui/ErrorBoundary`, `hooks/useClientErrors`, `coach/CoachHome` (collapsible triage list at the bottom of the Athletes roster), migration `2026_07_13_client_errors.sql` |
| CI & deploys | `.github/workflows/test.yml` (reusable suite: lint + tests + build on dev pushes/PRs), `.github/workflows/deploy.yml` (test-gated gh-pages publish), `eslint.config.js` |
| Nightly DB backups | `.github/workflows/backup.yml` (encrypted dump artifact), `BACKUPS.md` (secrets setup + restore drill) |

Periodization, confirmations, video storage/RLS, routing persistence, and React Query invalidation details are in `docs/ARCHITECTURE.md`. Design primitives, dark-mode rules, responsive layout, and the editorial page-header pattern are in `docs/DESIGN_SYSTEM.md`.

## Critical invariants

Behavioral rules and schema gotchas live in [`docs/INVARIANTS.md`](docs/INVARIANTS.md). Load it before any DB, hook, RLS, routing, or `set_logs`/messaging/notifications change.

## Commands

```bash
npm run dev       # vite dev (5173)
npm run build     # dist/
npm run preview   # serve dist/ (4173)
npm run lint      # eslint (correctness-only; rides the CI gate)
npm test          # vitest watch
npm test -- --run # single run (CI)
npm run deploy    # emergency-only manual publish — bypasses the CI test gate.
                  # The normal path is the CI deploy from main.
```

Test runs are via WSL: `wsl -d Ubuntu -- bash -lc "cd /home/tamachi/sl_app && npm test -- --run"`.

## When you add a feature

1. Load only the files listed in the matching row above. Load `docs/INVARIANTS.md` if the change touches DB / hooks / RLS / routing / messaging / `set_logs`. Load `docs/ARCHITECTURE.md` if the change ripples across modules.
2. DB changes → SQL in `supabase/migrations/2026_MM_DD_<name>.sql` *and* append to `schema.sql`. (One historical outlier, `20260416_set_logs_weight_kg.sql`, uses the 8-digit form — it is already applied, so leave it be rather than renaming it.)
3. Tests next to components; stub the hook layer with `vi.mock(...)` and render directly. `useAuth`'s context is module-private, so a test can only control auth by mocking the hook — never by wrapping in a provider.
4. Update the feature-files table here only if you introduced a new feature area.
5. Run `npm test -- --run` and `npm run build` before committing.
6. Update `README.md` / `CLAUDE.md` / `docs/*` to reflect the change before pushing.
