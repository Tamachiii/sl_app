# CLAUDE.md — Working Notes for Future Agents

Per-turn context only. Heavier docs load on demand.

## When to load the other docs

- **`docs/INVARIANTS.md`** — touching: routing/scroll-shell, dark mode, RLS, `set_logs` schema, rest timer (in-app or Web Push), messaging/notifications triggers, offline mutations, service worker, coach session review, stats persistence, role-aware `UserMenu`, the session QUEUE / training dates / day strips. **Load before any DB or hook change.** Skip for pure UI polish, copy, or component-local edits.
- **`docs/ARCHITECTURE.md`** — adding a DB table, changing RLS, touching React Query keys, changes spanning 3+ modules, or orienting to the data model / periodization / routing persistence. Skip for single-component edits, UI polish, tests, copy changes.
- **`docs/DESIGN_SYSTEM.md`** — creating a UI component, adding an `sl-*` primitive, changing dark-mode behavior, building a new page header, responsive layout questions. Skip for logic, data wiring, routing.
- **`README.md`** — setup, deployment, high-level overview, onboarding. Skip for day-to-day coding.
- **`docs/RUNBOOK.md`** (+ `docs/runbook/`) — what the owner does by hand in production, and when: the checkpoints, which migrations each one applies, the Auth dashboard steps. Load when writing a migration's runbook page or changing anything the user must do by hand. Its commands target production: an agent writes and tests them, the user runs them.
- **`supabase/migrations/README.md`** — the format of a migration (file, audit, rollback, runbook page, manifest entry). Load before any DB change.

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
  lib/           supabase.js  queryClient.js  volume.js  day.js  preload.js
                 i18n/ (en · fr · de dictionaries, index.js, mergeFragments.js,
                 fragments/<package-id>.<lang>.js — strings of packages not yet folded)
                 pushNotifications.js  sessionQueue.js (buildQueue/buildDayStrip —
                 the shared "what's next" + strip placement model)
  hooks/         auth · theme · i18n · program · week · session · goals
                 students · set-logs · set-video · confirmations · slot-comments
                 stats · exercise-library · duplicate · remember-coach-students-path
                 rest-timer (singleton) · rest-timer-effects (wake lock + audio)
                 rest-timer-push (Web Push bridge) · push-subscription (toggle)
  components/
    auth/        LoginPage  ProtectedRoute  RoleGate
    layout/      AppShell  BottomNav  SideNav  navItems
    coach/       CoachHome (Athletes roster + single-student tabs)  StudentWeekStrip  ProgramSwitcher
                 ProgramSheet  PhaseDivider  SessionRow  SessionEditor  SessionReview
                 ProgramManageDialog  ProgramTrashDialog  ProgramBadges
                 ExerciseSlotRow  ExerciseLibrary  SessionsFeed  SlotProgress
                 StudentOverview  PreviousSessionPanel
                 StudentProgrammingSection  StudentGoalsSection
                 StudentStatsSection  CoachMessages
    student/     StudentTraining (the one list)  SessionCard  SessionView  SetRow
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
                 hardcodedScan.js (lists hard-coded JSX text of a folder)
                 static guards: ciGuardrails · docsSuite · authConfig · runbookIndex (.test.js)
supabase/        schema.sql (install path, and what the DB tests load)
                 migrations/ (manifest.json + manifest.js, README.md = the format;
                 files before 2026_10 are history)
                 audits/  rollbacks/ (one file per migration of the manifest)
                 functions/dispatch-rest-push/  functions/send-push/
                 tests/ (DB suite: harness.js, sql.js, catalog.js, migration-checks.js,
                 fixtures/prod_baseline_2026_09_30.sql, snapshots/rls-matrix.txt)
docs/            INVARIANTS.md  ARCHITECTURE.md  DESIGN_SYSTEM.md  ENVIRONMENT.md
                 RUNBOOK.md (the owner's index: rules, checkpoints, first-push checklist)
                 runbook/ (00-before-you-start.md  20-auth-config.md  migrations/NN-<name>.md)
                 _pending/ (doc snippets waiting for the end-of-wave fold)
vitest.db.config.js  vitest.docs.config.js   the database and docs suites
```

Tests live next to components as `*.test.jsx`.

## Feature → files map

Jump straight to the relevant files. For *behavior* details, open the file — the code is the spec.

| Feature | Primary files |
|---|---|
| Auth / login | `auth/LoginPage`, `hooks/useAuth`, `routes.jsx` |
| Supabase Auth settings (dashboard-only: sign-up off, site URL, redirect list, password length) | `docs/runbook/20-auth-config.md` (the owner's steps, the read-only check of `/auth/v1/settings`, the list of accounts, what to leave alone), `docs/ENVIRONMENT.md` (the values), `src/test/authConfig.test.js` (the page's check run against a stand-in server; a `supabase/config.toml` carries function flags only; nothing runs `supabase config push`), `supabase/tests/auth-accounts.test.js` (the page's account query on forged and self-made accounts) |
| Coach Athletes roster (attention-first list; merged Dashboard + Students into one tab) | `coach/CoachHome` (roster landing + single-student tab host), `coach/StudentWeekStrip`, `lib/coachRoster` (`buildRoster` — pure, + `STALE_AFTER_DAYS`), `lib/sessionQueue` (`buildQueue`/`buildDayStrip`), `hooks/useStudents`, `hooks/useSessionConfirmation` (`useAllConfirmations`), `hooks/useProgram` (`useCoachDashboardPrograms`), `hooks/useClientErrors`. Search + per-athlete attention chips (to-review / **quiet Nd** / no-program), all derived client-side from already-loaded coach-wide queries; ordered attention-first then A–Z; card subtitle is the queue position ("Session 7/24"), not an ordinal week. `/coach/dashboard` now redirects here |
| Coach single-student view (ONE page, no tabs) | `coach/CoachHome` (on an athlete route its own page header BECOMES the athlete — "‹ All athletes" in the kicker slot, the name as the `h1`; there is no separate identity block and `StudentHeader` is deleted), `coach/StudentOverview` (collapsible Programming / Goals / Stats sections; open state in `localStorage` under `sl_coach_student_sections`; collapsed sections are **unmounted**, so they cost no query), `routes.jsx`. The athlete lives at `/coach/students/:studentId`; session editing is the only child (`s/:sessionId`). Every former tab URL (`programming`, `progress`, `profile`, `goals`, `stats`, `messaging`) redirects to the page |
| Session "Last time" reference | `coach/PreviousSessionPanel` — for each exercise of the session being written, what the athlete ACTUALLY lifted, via `hooks/useLastPerformance` (now role-aware: pass a `studentRowId` and both reads filter through the program join, or omit it and RLS scopes to the signed-in student). Reads the SAME hook as the athlete's own "Last time" hint, so the two cannot drift. It used to list the coach's past PRESCRIPTION from "the same weekday in week N−1", which vanished entirely in a one-week block and matched the wrong session once `day_number` became optional |
| Coach programs CRUD | `coach/ProgramSwitcher` (picker + reorder; the trigger is the program NAME across the row — no pill, no week count, ACTIVE reduced to an `ActiveDot` — and both list-level actions, "+ PROGRAM" and Trash, live in the dropdown footer rather than beside the name), `coach/ProgramManageDialog` (rename / set active / duplicate / trash / draft approve-send back), `coach/ProgramTrashDialog`, `coach/ProgramBadges`, `hooks/useProgram`. `useTrashedPrograms` takes `{ enabled }` and only fires while the picker is open |
| Program duplicate (whole-block copy, same student) | `coach/ProgramSwitcher` (ManageProgramDialog "Duplicate program"), `hooks/useDuplicate` (`useDuplicateProgram` + shared `copyWeekTree` helper). Copy is inactive, week numbers/labels preserved, prescription-only (no student actuals) |
| Coach phase reordering | `coach/PhaseDivider` (`SortablePhaseDivider`), `coach/ProgramSheet` ("Reorder phases" in a divider ⋯ menu → dnd-kit vertical sort, sessions hidden), `hooks/useWeek` (`useReorderWeeks`) |
| Coach sessions feed | `coach/SessionsFeed`, `hooks/useSessionConfirmation` |
| Coach Program Sheet (the Programming tab — the whole block as ONE list) | `coach/ProgramSheet` (**no accordion, no flat/nested split** — every session of the block is visible at once, numbered across phases. Weeks render as `coach/PhaseDivider`: a free-text name, **never a number**, drawn even when unnamed because the boundary is real; divider ⋯ menu = add session / duplicate / copy to… / reorder phases / delete phase. `coach/SessionRow` holds the row itself: day pill + title + N ex + confirmed ✓ + duplicate; session delete lives in the editor, not on the rows. One footer for the block — + Session / Select / Reorder — and both reorder modes hide it, the top banner carrying the only Done. An empty block's CTA adds a SESSION and creates phase 1 implicitly), `coach/StudentProgrammingSection`, `hooks/useProgram` (`useProgram` carries weeks→sessions→slot ids), `hooks/useSessionConfirmation` (`useProgramConfirmedSessionIds`), `hooks/useWeek` (`useReorderSessions` — drag-reorder as an explicit mode; `useMoveSession` — dragging a session **across a divider** re-homes it into that phase via the `move_session` RPC; `useArchiveSessions` — bulk archive from a selection that spans phases, with restore-in-place in ONE block-level archived drawer), `hooks/useDuplicate` (`useDuplicateSession` per row, `useCopySessions` for a selection), `ui/CopyDialog` (athlete → BLOCK → week), `lib/day` (`compareSessions` — **position, not weekday**, since the 2026_08_22 backfill), `lib/sessionMove` (`planSessionDrag` — the pure reorder-vs-move decision + the full id lists both weeks need). **Replaced `WeekTimeline` + the `WeekView` page** — editing an exercise is now 1 navigation, not 3 |
| Coach session editor | `coach/SessionEditor` (header is ONE row — back, title, recommended date; duplicate and copy-to were removed as second doors onto actions the sheet already carries, and delete moved to the bottom as the app's only delete path. Renders INSIDE the athlete shell at `/coach/students/:studentId/programming/s/:sessionId` — no page padding of its own), `coach/ExerciseSlotRow`, `hooks/useSession`, `hooks/useExerciseLibrary` |
| Coach session review | `coach/SessionReview`, `coach/SessionFeedbackComposer`, `coach/SessionFeedbackSent`, `coach/SessionReviewedNoFeedback`, `hooks/useSession`, `hooks/useSetLogs`, `hooks/useSlotComments`, `hooks/useSessionConfirmation`, `hooks/useMessages` |
| Set video upload/playback | `student/VideoUploadButton`, `ui/VideoPlayer`, `coach/SessionReview`, `hooks/useSetVideo` |
| Coach exercise library | `coach/ExerciseLibrary`, `hooks/useExerciseLibrary` |
| Real training dates (`performed_on` / `performed_at`) | `lib/day` (`performedOnFromLogs`/`performedDate`), `lib/offlineMutations` (`confirmSessionFn` sends `performed_on`), `hooks/useSessionConfirmation`, `student/SessionView` (pins the date at confirm time), `coach/SessionsFeed`, `coach/PreviousSessionPanel`, migration `2026_08_21_session_performed_on.sql` (+ `sync_session_performed_at` trigger). The date comes from the session's `set_logs.logged_at`, NOT from `confirmed_at` — which is the replay moment for an offline confirm |
| Student training surface (ONE page: was Home + Sessions) | `student/StudentTraining` (the block as a single ordered list — next session open at the top with a **Next** badge and the block position beside the program name — collapsible like every other card, so opening another one shrinks it, remaining work below it in program order, then TWO CLOSED DRAWERS — this block's finished sessions ("Done · N sessions", ordered by **real training date, newest first**) and one per past block, opening as read-only history. `Drawer` takes `renderBody` as a function so a closed drawer builds nothing), `student/SessionCard` (`locked` suppresses the start affordance on past-block sessions), `lib/sessionQueue` (`buildQueue`/`flattenSessions` — pure), `hooks/useStudentProgramDetails` (`allPrograms: true`), `hooks/useSessionConfirmation`, `hooks/useMessages` (`useMyFeedbackSessionIds`). **No Mon–Sun day strip**: a 7-column grid with week arrows IS the calendar week. `/student/sessions` redirects to `/student`; the student nav is 3 tabs |
| Student stats (bucketed by REAL calendar weeks) | `student/StudentDashboard`, `student/SessionCalendar`, `student/WeeklyVolumePanel` (`formatBucketRange` — rows are date ranges), `student/ExerciseProgressChart` (one point per SESSION on a date axis), `student/ProgramScopeSelector`, `lib/statsPrefs.js`, `hooks/useStudentProgressStats` (buckets on `sessions.performed_at`; `backlogSessions` holds undated work), `hooks/useStudentHistoricalSessions`, `hooks/useStudents` |
| Student session logging | `student/SessionView`, `student/SetRow`, `student/RpeInput`, `hooks/useSession`, `hooks/useSetLogs`, `hooks/useMessages` (`useSessionFeedback` for the inline coach-feedback card) |
| "Last time" hint (prior performance at point of logging) | `student/SlotGroupCard` (`LastTimeHint` inside the expanded card), `hooks/useLastPerformance` (student-only, RLS-scoped; no `students.id` resolve), `lib/lastPerformance` (`buildLastPerformance`/`formatLastPerformance`/`daysSince`), `lib/records` (`effectiveWeight`/`effectiveReps`), wired in `student/SessionView` |
| Off-plan deviation logging (student records actual reps/load) | `student/SetRow` (Actual pill + editor), `hooks/useSetLogs` (`useLogActual`), `lib/offlineMutations` (`logActual`), `lib/volume` (`hasLoggedActual`/`formatActual`), `coach/SessionReview` (Off-plan band), migration `2026_06_28_set_log_actuals.sql` (`set_logs.actual_*` + `pin_set_log_targets_for_student` trigger) |
| Structural deviations (swap/skip exercise, skip/add set) | `student/SlotDeviationBar` (swap/skip + library picker), `student/SetRow` (skip/extra-set), `student/SlotGroupCard` (add-set), `hooks/useSlotDeviations`, `hooks/useSetLogs` (`useSetSkipped`/`useAddStudentSet`/`useRemoveStudentSet`), `lib/offlineMutations` (`saveSlotDeviation`/`setSkipped`), `coach/SessionReview` + `coach/SlotProgress` (banner + skipped/extra pills), `hooks/useNotifications` (`session_deviation`), migration `2026_06_28_slot_deviations.sql` (`slot_deviations` table + `set_logs.skipped`/`is_student_added` + `notify_coach_on_slot_deviation` trigger) |
| Student program authoring (Phase 3.4, OFFLINE-capable) | `student/StudentProgramAuthor` (lean self-contained draft builder — weeks/sessions/slots + slot targets; English-only), `hooks/useAuthoring`: `useMyDraft`/`useDraftTree` (queries) + `useDraftActions(programId)` (optimistic-cache editors with client-minted `crypto.randomUUID()` ids) + `useCreateDraft` + the two keyed offline mutations `useSaveDraftTree`/`useDiscardDraft`. Every edit syncs the WHOLE tree as one idempotent snapshot via the `save_draft_tree` RPC (`2026_07_24_save_draft_tree.sql`, SECURITY INVOKER, declarative full-replace; `2026_08_22_draft_day_number_optional.sql` stopped it coalescing an unset `day_number` to Monday). **No set_logs** (materialized by `approve_program` at approval). Persisted roots `my-draft`/`draft-tree`/`exercise-library`; dedicated `draft-tree` FIFO scope; resume-then-reconcile in `App.jsx`/`AppShell`. Route `/student/author` + CTA on `student/StudentProfile`. DB gate + `approve_program` in `2026_07_21_student_program_authoring.sql` (see the Phase 3.4 INVARIANTS entry) |
| Coach approve / send-back of a submitted draft (Phase 3.4c) | `coach/ProgramSwitcher` (ManageProgramDialog draft banner with Approve / Send back + `DraftBadge` DRAFT/SUBMITTED chips in the list & trigger), `hooks/useProgram` (`useApproveProgram` → rpc `approve_program`, `useSendBackProgram` → rpc `send_back_program`; `useProgramsForStudent` selects `status, submitted_at`), migration `2026_07_22_program_submit_notify.sql` (`notify_coach_on_program_submit` AFTER UPDATE trigger on submitted_at NULL→set + `send_back_program` coach-only RPC), notifications `program_submitted` (coach) / `program_approved` / `program_sent_back` (student) in `hooks/useNotifications` + i18n. Approve materializes set_logs and flips `status='approved'` **inactive** — the coach then Sets active |
| Student proposal loop (Phase 3.3) | `student/SlotDeviationBar` ("Ask coach to make this permanent" → `hooks/useSlotDeviations` `useRequestPromote`, online-only), `coach/SessionReview` (★ request highlight + Decline → `hooks/useAdoptSwap` `useDeclinePromote`), migration `2026_07_20_deviation_promote_request.sql` (`slot_deviations.promote_requested_at` + `notify_coach_on_promote_request` AFTER UPDATE trigger + `decline_promote_request` RPC). Approve = the adopt RPCs; notifications `promote_requested`/`promote_declined` |
| Adopt deviation → program edit (Phase 3.1/3.2) | `coach/SessionReview` ("Adopt into program" on the swap banner / "Remove from upcoming" on the skip banner) + `coach/AdoptSwapDialog` + `coach/RemoveExerciseDialog` (blast-radius confirm), `hooks/useAdoptSwap` (`useAdoptSwap`/`useAdoptSwapPreview` + `useAdoptSkip`/`useAdoptSkipPreview` dry-runs), migrations `2026_07_18_adopt_swap.sql` (`adopt_swap` — flips `exercise_id` X→Y) + `2026_07_19_adopt_skip.sql` (`adopt_skip` — DELETEs upcoming X slots). Both SECURITY DEFINER, coach self-auth (`auth.uid() IS NULL OR v_coach_id IS DISTINCT FROM auth.uid()` — migration `2026_10_03_02_rpc_auth_null_guard.sql`, tests in `supabase/tests/rpc-auth.test.js`), **forward-only** via a strict ordinal + performed-history predicate (never rewrites a trained/reviewed session), keep `target_*` as a seed, notify the student (`swap_adopted`/`skip_adopted`). Coach-only, online-only |
| Coach goals (per student) | `coach/StudentGoalsSection` (rendered as the Goals section of the Progress tab, not a tab of its own), `hooks/useGoals` |
| Student goals | `student/MyGoals`, `hooks/useGoals` |
| Student profile | `student/StudentProfile`, `hooks/useStudentLifetimeStats`, `hooks/useAuth`, `hooks/useStudents` (`useMyCoach`), `hooks/useGoals` (`useMyGoals`) |
| Personal records + bodyweight | `student/PersonalRecords` (list is COLLAPSED behind an "N records" row; open state in `localStorage` under `sl_student_records_open`, fresh-PR badge mirrored onto the collapsed row), `student/BodyweightCard`, `hooks/useStudentRecords`, `hooks/useBodyweight`, `lib/records.js` (Epley e1RM + `systemLoad`), migration `2026_07_14_bodyweight_logs.sql` |
| Relative strength (×BW) | `exercise_library.load_mode` (`full`/`added`/NULL-unclassified, migration `2026_07_23_exercise_load_mode.sql`), coach sets it in `coach/ExerciseLibrary` (`ExerciseForm` select + `· +BW`/`· FULL` meta tag), `lib/records.js` `buildRecords` takes a `bodyweightAt` resolver and emits `relStrength` (the PEAK system-load-e1RM ÷ bodyweight across sets — a true max, not derived from the added-load PR set) + `bwAtBest`; the est-1RM **headline stays the added-load e1RM** (PR selection/sort unchanged). `hooks/useStudentRecords` fetches the `bodyweight_logs` series (coach flow resolves `profile_id`; `useLogBodyweight` invalidates `['student-records']` so a fresh weight unlocks the pill), `student/PersonalRecords` shows the ×BW pill (`toFixed(1)`) + graceful degrade + log-bodyweight nudge. Tonnage/volume stay BW-blind by design |
| Performance-aware stats | `hooks/useStudentProgressStats` (performed vs planned volume/tonnage + adherence; **swap-aware** — an exercise swap credits PERFORMED volume/tonnage to the substitute via a `slot_deviations` fetch, PLANNED stays on the coach's original), `student/WeeklyVolumePanel` (shared with coach), `student/ExerciseProgressChart`. `hooks/useStudentRecords` (PRs) + `hooks/useLastPerformance` ("last time" hint) are **also swap-aware** now — each fetches the student's `slot_deviations` swaps and credits a swapped set to the substitute exercise using ONLY the logged actuals (the pinned `target_*` are the original's, foreign to the substitute); `useLastPerformance` also keys the open-session hint on a current-session swap substitute |
| User menu popover | `ui/UserMenu` (every top-level page's right-aligned header action) |
| Theming (DARK-ONLY — no toggle) | `hooks/useTheme` (provider forces dark; `toggleTheme`/`setTheme` are no-ops), `index.html` (`class="dark"` on `<html>` so there's no light flash), `index.css` (the `.dark` remaps all stay). `ui/ThemeToggle` is **deleted** — an installed iOS PWA colours its status bar from the manifest's single static `theme_color`, so a light theme could never match the strip |
| i18n (EN/FR/DE) | `hooks/useI18n`, `lib/i18n/` (`index.js` exports the merged `messages` and `getMessage`; `mergeFragments.js`; `fragments/<package-id>.<lang>.js` + `fragments/README.md`; `parity.test.js` and `usage.test.js` hold the rules), `ui/LanguageSelect`, `test/hardcodedScan.js` (hard-coded text scanner for the per-folder tests) |
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
| DB / RLS test suite (`npm run test:db`) | `supabase/tests/`: `harness.js` (`asAnon`/`asUser`/`asService`/`asAdmin`/`scenario`/`attempt` + `seed`/`createUser`/`createProgram`/`createDraftProgram` + `enablePush`/`httpCalls` — the API is documented in the file), `shim.sql` (what Supabase provides before user SQL: roles, `auth`, `storage`, `pg_net`/Vault stubs, default privileges), `postgres.js` + `global-setup.js` (embedded PG 17.6, template database, one clone per test file), `smoke.test.js`, `known-holes.test.js` (open review findings as `it.fails` — delete `.fails` to work on one), `vitest.db.config.js`. `schema.sql` is loaded UNMODIFIED; `npm test` excludes this folder. Also: `scratchDatabase()` in `harness.js` (a database a test builds from SQL files, from `sl_bare` = `shim.sql` only) and `q.dryRun` (run one statement and undo it); `sql.js` (`runSql`/`runSqlFile`/`splitStatements`) + `sql.test.js`; `catalog.js` (`catalogSnapshot`/`diffCatalogs` — the catalog of a database as data) + `catalog.test.js`; `rls-matrix.test.js` + `snapshots/rls-matrix.txt` (what six callers can do to every table); `rpc-auth.test.js` (the five coach-only SECURITY DEFINER RPCs called by every kind of caller, with and without a user id; migration `2026_10_03_02_rpc_auth_null_guard.sql` tried on the frozen baseline — hole before, closed after, back after its rollback; its audit); `auth-accounts.test.js` (the "who has an account" query of `docs/runbook/20-auth-config.md`, read off the page; read-only, and refused to `anon` and `authenticated`). The migration tests are the next row. README → Database Tests for how to write one and the shim's limits |
| Migrations + ledger (how a DB change is written and tracked) | `supabase/migrations/README.md` (the format), `supabase/migrations/manifest.json` + `manifest.js` (`loadManifest`/`pathsOf`/`predecessorOf`/`manifestProblems`, refusal codes `SLM01`–`SLM04`), `supabase/audits/`, `supabase/rollbacks/`, `docs/runbook/00-before-you-start.md` + `docs/runbook/migrations/`, ledger table `app_private.app_migrations` (migration `2026_10_03_01_migration_ledger.sql`), tests `supabase/tests/parity.test.js` (frozen `fixtures/prod_baseline_2026_09_30.sql` + the manifest's migrations = `schema.sql`) + `migration-checks.js` / `migration-conventions.test.js` (every migration: refused out of order, applied, refused twice, rolled back, applied again; then the list without the optional ones) + `migration-ledger.test.js` |
| Production hand-over (the user applies SQL and dashboard settings; nothing in the repo does) | `docs/RUNBOOK.md` (the index: rules, the checkpoint table A0…Z, the sequence of each checkpoint that is **ready**, first-push checklist), `docs/runbook/` (one page per subject and per migration, written by the lane that owns it), `src/test/runbookIndex.test.js` (the index against `manifest.json` and the pages: a migration under the checkpoint its entry names; audited, applied, audited again, in order; rollback and page named; no command that a page does not give) |
| CI & deploys | `.github/workflows/test.yml` (reusable gate, three jobs: `test` = install, production audit, lint with its ceiling, unit suite, build; `db` = `npm run test:db`; `functions` = `deno check` over `supabase/functions/*/index.ts`), `.github/workflows/deploy.yml` (test-gated gh-pages publish), `.github/workflows/backup.yml`, `eslint.config.js`, `src/test/ciGuardrails.test.js` (static guards over the three workflows and the lint script), `src/routes.test.jsx` (the whole route table against the installed router) |
| Nightly DB backups (**never ran; the set-up does not work as written** — until it is corrected the backup is the manual dump of `docs/runbook/00-before-you-start.md` §2) | `.github/workflows/backup.yml` (encrypted dump artifact; skips without its two secrets), `BACKUPS.md` (the set-up with the notice that says why it fails, + restore drill), `src/test/runbookIndex.test.js` (holds the runbook, the 00 page and `BACKUPS.md` to the same statement) |

Periodization, confirmations, video storage/RLS, routing persistence, and React Query invalidation details are in `docs/ARCHITECTURE.md`. Design primitives, dark-mode rules, responsive layout, and the editorial page-header pattern are in `docs/DESIGN_SYSTEM.md`.

## Critical invariants

Behavioral rules and schema gotchas live in [`docs/INVARIANTS.md`](docs/INVARIANTS.md). Load it before any DB, hook, RLS, routing, or `set_logs`/messaging/notifications change.

## Commands

```bash
npm run dev       # vite dev (5173)
npm run build     # dist/
npm run preview   # serve dist/ (4173)
npm run lint      # eslint with a warning ceiling (--max-warnings 26): one NEW warning fails the gate
npm test          # vitest watch
npm test -- --run # single run (CI)
npm run test:db   # DB suite on an embedded Postgres 17: RLS as anon/student/coach, baseline + migrations = schema.sql, every migration up/down/up, the RLS matrix (~9 s)
npm run test:docs # docs suite (tests under docs/); empty and green until wave 4
npm audit --omit=dev --audit-level=high   # what CI runs after the install; must print "found 0 vulnerabilities"
npm run deploy    # emergency-only manual publish — bypasses the CI test gate.
                  # The normal path is the CI deploy from main.
```

The lint ceiling is a ratchet. Lower the number in `package.json` when a warning is fixed; never raise it. A new warning is fixed, or disabled inline with the reason.

Test runs are via WSL: `wsl -d Ubuntu -- bash -lc "cd /home/tamachi/sl_app && npm test -- --run"`.

## When you add a feature

1. Load only the files listed in the matching row above. Load `docs/INVARIANTS.md` if the change touches DB / hooks / RLS / routing / messaging / `set_logs`. Load `docs/ARCHITECTURE.md` if the change ripples across modules.
2. DB changes → a migration in the format of `supabase/migrations/README.md`, in one commit: `supabase/migrations/YYYY_MM_DD_NN_<name>.sql` (`DD` = commit day, `NN` = global order), its audit in `supabase/audits/`, its rollback in `supabase/rollbacks/`, its page in `docs/runbook/migrations/`, an entry in `supabase/migrations/manifest.json`, **and** the same change merged into `supabase/schema.sql` with the migration's name added to the ledger `INSERT` at the end of that file. Then `npm run test:db`: `parity.test.js` fails when the migration and `schema.sql` disagree, `migration-conventions.test.js` when the file breaks the format, `rls-matrix.test.js` when what a role can do changed (regenerate `supabase/tests/snapshots/rls-matrix.txt` with `-u` and commit the diff). Never edit `supabase/tests/fixtures/prod_baseline_2026_09_30.sql` or a file dated before `2026_10` (those are history, already applied — the 8-digit outlier `20260416_set_logs_weight_kg.sql` included). Nothing here applies SQL to production: the user does, following `docs/RUNBOOK.md`.
3. Tests next to components; stub the hook layer with `vi.mock(...)` and render directly. `useAuth`'s context is module-private, so a test can only control auth by mocking the hook — never by wrapping in a provider.
   - New UI strings: do not edit `src/lib/i18n/en.js`, `fr.js` or `de.js`. Add `src/lib/i18n/fragments/<package-id>.en.js`, `.fr.js` and `.de.js` with one new camelCase namespace (rules in `src/lib/i18n/fragments/README.md`), then run `npx vitest run src/lib/i18n --maxWorkers=2`.
   - A new route or redirect gets a row in `src/routes.test.jsx`.
   - A new Edge Function is a directory under `supabase/functions/` with an `index.ts`; shared modules live in a directory whose name starts with `_`. `src/test/ciGuardrails.test.js` fails otherwise, because the CI glob would skip the function.
   - A command or a query that a runbook page asks the owner to run is tested by reading it off the page (`src/test/authConfig.test.js`, `supabase/tests/auth-accounts.test.js`, `supabase/tests/rpc-auth.test.js`). Changing the command means changing the page, and the test follows the page.
4. Update the feature-files table here only if you introduced a new feature area.
5. Run `npm test -- --run` and `npm run build` before committing.
6. Update `README.md` / `CLAUDE.md` / `docs/*` to reflect the change before pushing. While the 2026-09 review plan is running (branch `fix/review-2026-09`), a feature package does that through a snippet: it writes `docs/_pending/<package-id>.md` in the format of `docs/_pending/README.md` and leaves `CLAUDE.md`, `README.md` and `docs/*.md` alone; the integrator folds the snippets into those files at the end of the wave, before anything is pushed. Runbook pages under `docs/runbook/` are written directly by the lane that owns them; `docs/RUNBOOK.md` is the integrator's.
7. Dependencies change only in wave 0 and wave 9 of that plan. `@fontsource-variable/inter`, `@fontsource-variable/archivo`, `@fontsource-variable/jetbrains-mono` and `axe-core` are installed and not yet imported.
