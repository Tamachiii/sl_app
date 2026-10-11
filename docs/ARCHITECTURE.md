# Architecture

A tour of how `sl_app` is wired — data model, client-side caching, auth/RLS boundaries, routing, and the app-specific patterns that aren't obvious from reading one file. Start here when a change could ripple across layers. For per-turn working notes and the file-by-file feature map, see [CLAUDE.md](../CLAUDE.md).

## Stack

- **React 19** + **Vite 6** (base `/sl_app/`).
- **React Router 7 HashRouter** — GitHub Pages hosts static files; `/#/` lets deep links survive.
- **TanStack React Query 5** for server state and optimistic updates.
- **Supabase** for auth + Postgres + Row-Level Security.
- **Tailwind 4** (CSS-based config, `@theme` in `src/index.css`).

## Data model

```
profiles (id PK, role: 'coach'|'student', full_name)
  │ coach_id
  ▼
programs (id, coach_id, student_id, title, sort_order, is_active)
  │   -- periodization blocks per student; ≤1 active via partial unique index
  ▼
weeks (id, program_id, week_number UNIQUE(program_id, week_number), label)
  │
  ▼
sessions (id, week_id, title, day_number 1..7, scheduled_date, sort_order, archived_at)
  │                                                  │
  ▼                                                  ▼
exercise_slots (…, sets, reps, weight_kg,        session_confirmations
                rest_seconds, superset_group,     (session_id UNIQUE, student_id,
                notes, record_video_set_numbers)   confirmed_at, notes)
  │ exercise_id    -- reps/weight_kg/duration_seconds/rest_seconds are now
  │                -- DEPRECATED mirrors of set 1; per-set targets live on set_logs
  ▼                                                │
exercises (library:  name, type 'pull'|'push',   slot_comments (student-authored
           difficulty, volume_weight)             comments per slot per session)
  │
  ▼
set_logs (exercise_slot_id, set_number,
          target_reps, target_duration_seconds, target_weight_kg, target_rest_seconds,
          weight_kg, rpe, done, logged_at)
  │
  ▼ 1:1
set_log_videos (set_log_id UNIQUE, storage_path, mime_type, size_bytes)
```

Side tables:

- **`goals`** + `goal_progress` — student-chosen target lifts, coach can also author them. See [src/hooks/useGoals.js](../src/hooks/useGoals.js).
- **`exercises`** — each coach owns a library; slots reference by `exercise_id`.

Volume helper [src/lib/volume.js](../src/lib/volume.js) aggregates `difficulty × Σ(target_reps) × volume_weight` per `type` across a session, summing per-set targets out of `set_logs`. Time-under-tension entries (`target_duration_seconds` set, `target_reps` null) are skipped. Slots with no per-set logs yet fall back to `slot.sets × slot.reps`.

## Per-set targets

Prescription used to live on `exercise_slots` as a single `{sets, reps, weight_kg, rest_seconds}` row that multiplied across every set. As of migration `2026_04_25_per_set_targets.sql`, each `set_logs` row carries both the prescription (`target_reps`, `target_duration_seconds`, `target_weight_kg`, `target_rest_seconds`) and the student's actuals (`done`, `rpe`, `weight_kg`). One exercise card can now hold heterogeneous sets — drop sets, back-offs, ramped weight — without spawning multiple slots.

- The legacy `exercise_slots.{reps, weight_kg, duration_seconds, rest_seconds}` columns are kept as deprecated mirrors of set 1, slated for removal in a follow-up migration.
- The reps/seconds **unit** is still slot-level — `exercise_slots_unit_one_of` enforces exactly one of the deprecated mirror columns is set, and a parallel `set_logs_target_unit_one_of` enforces it per-row.
- `useAddSlot` materializes one `set_logs` row per planned set with uniform targets. `useUpdateSlot` fans uniform target edits out to every log; changing `sets` reconciles count by inserting from the last row's targets or deleting orphans. `useUpdateSetTarget` writes to a single log. `useResetSlotToUniform` re-syncs every log to set 1's values.
- `useDuplicate` copies `set_logs` targets across (not actuals) — a duplicated session arrives clean.
- `lib/volume.js` exports `isSlotUniform(slot)`, `formatSlotPrescription(slot)`, `formatSetTarget(log)`, `getSlotTargetWeight(slot)`, `getSlotTargetRest(slot)`. Compact "3 × 10 @ 80kg" rendering only fires when uniform; the heterogeneous case shows a per-set list. All helpers fall back to slot scalars when set_logs lack target_* (legacy / mocks).
- Coach editor (`ExerciseSlotRow`) auto-expands the per-set table when targets diverge. "Reset to uniform" requires explicit click — there is no implicit "if matching, collapse"; the coach controls when to leave custom mode.

`day_number` on sessions: a **recommended** weekday, `1=Monday … 7=Sunday`, **nullable** since `2026_08_21_day_number_optional.sql` (NULL = no recommendation). `sessions.scheduled_date` (nullable date) is a recommended DATE and wins over `day_number` for display. Neither is a commitment: order inside a block comes from `sort_order`, and `sessions.performed_at` records the day the athlete actually trained. The student surface has no day strip at all — see the queue section of INVARIANTS.md.

## Program periodization (multiple blocks per student)

A student can have many programs but only one is **active** at a time, enforced by partial unique index:

```sql
CREATE UNIQUE INDEX programs_one_active_per_student
  ON programs(student_id) WHERE is_active;
```

(Migration: `supabase/migrations/2026_04_23_programs_crud.sql`.)

- **The one training surface spans all programs; the QUEUE is active-only.** `StudentTraining` calls `useStudentProgramDetails(userId, { allPrograms: true })` so finished blocks render below as read-only history, but `buildQueue` runs over the ACTIVE block's weeks only — a past block's unfinished sessions are work the athlete moved on from, not work still due.
- **Coaches browse all programs** via `useProgramsForStudent(studentId)` (list without weeks) and open one via `useProgram(programId)` (detail with weeks). `useActiveProgram(studentId)` resolves "the student's current block" and backs `CopyDialog`'s destination.
- **`useProgram` takes `programId`, not `studentId`** — breaking rename during the periodization refactor.
- `useSetActiveProgram` deactivates the current active program first (else the partial unique index rejects the insert). `useCreateProgram` with `setActive: true` does the same. `useEnsureProgram` explicitly inserts `is_active: true` since the column default is `false`.
- Deleting the *active* program is blocked while other programs exist — the coach must activate another first.
- **`useStudentProgramDetails`** is the lighter stats-free fetch (weeks → sessions → slots → library) for the Sessions page. Use it when you need full slot structure without aggregation. **`useStudentProgressStats(studentId?, scope='all')`** is the heavy aggregate fetch; omit `studentId` for self-stats, pass it from the coach view, and pass `scope` to choose 'all' programs, only the 'active' one, or a specific program id.

### SessionCalendar history overlay

`useStudentHistoricalSessions` fetches dated sessions from the student's NON-active programs (`is_active=false`). When `scope === 'active'`, `StudentDashboard` merges them into the calendar payload flagged `historical: true`. In `SessionCalendar`, a day shows the history dot (muted `--color-ink-400`) ONLY when it has no active-program sessions — active takes visual priority. Historical days are still wrapped in the `<Link>` since the "Students read own sessions" RLS policy is scoped to program ownership, not `is_active`, so students can re-open past sessions read-only.

Under any other scope (`'all'` or a specific past program), the history overlay is suppressed — `useStudentProgressStats` already returns every in-scope session, so layering historical sessions on top would be redundant noise. The hook stays separate because it's the lightest possible fetch (no aggregation) and is fast to skip when not needed.

### Read-only gate on past-program sessions

A session is read-only on the student surface iff `programs.is_active = false` OR `sessions.archived_at IS NOT NULL`. Both conditions are enforced at two layers:

- **UI gate** — `useSession` hydrates `session.program_is_active` from the embedded `weeks(programs(is_active))`. `SessionView` derives `isReadOnly` from that and `archived_at`, then hides Confirm / Undo, swaps in a "From a past program — read-only." (or "Archived by your coach — read-only.") banner, and locks `SetRow` toggles + `SlotCommentBox`. `VideoUploadButton` inherits via the same `locked` prop.
- **RLS gate** — student-side policies on `set_logs`, `session_confirmations`, and `slot_comments` are split: SELECT is permissive (own-row ownership only) so students can still read their own RPEs, done flags, slot comments, and old confirmation timestamps when they re-open a past session via the calendar; INSERT / UPDATE / DELETE are blocked when the parent program is inactive (or the session is archived). Helpers `program_active_for_session(sess_id)` and `program_active_for_slot(slot_id)` walk session → week → program. Migration: `2026_04_26_lock_inactive_program_writes.sql`. Coach-side policies are unchanged so coaches can still edit past blocks.
- **Why a SELECT/write split, not `FOR ALL`** — Postgres applies the policy's USING clause to SELECT too, so a single `FOR ALL` policy with a write gate would also block reads. That's the exact regression we want to avoid: the student must always be able to *view* their history, even on past programs.
- **Backfill** — `useAddSlot` materializes one set_log per planned set since the per-set-targets migration; older slots relied on the client-side `useEnsureSetLogs` safety-net to lazy-fill missing rows on SessionView mount. Once the lock-inactive-program-writes migration ships, that safety-net INSERT is rejected on past-program slots — so any legacy session that never had its logs materialized while still active becomes visually empty. `2026_04_26_backfill_missing_set_logs.sql` runs once at deploy time to fill in those missing rows from the slot's deprecated mirror columns; SessionView additionally skips the lazy materialization on read-only sessions to keep the console clean.

This is the boundary that keeps history immutable when a coach swaps the active program — without it, a student can open an old confirmed session via Stats → Calendar and re-write its `confirmed_at`, distorting recent-confirmations ordering and any timestamp-driven aggregates.

## React Query — who owns which key

Invalidation is scoped intentionally to avoid over-fetching. When you add a mutation, mirror the nearest existing hook.

| Hook | Reads | Writes invalidate |
|---|---|---|
| [useProgram](../src/hooks/useProgram.js) | `['program', studentId]`, `['programs', studentId]`, `['active-program', studentId]`, `['coach-dashboard-programs']` | `['program', studentId]` on changes; `['program']` broad on add/delete; every program write also drops `['coach-dashboard-programs']` via the exported `invalidateCoachDashboard` |
| [useWeek](../src/hooks/useWeek.js) | `['week', weekId]` | `['week', weekId]` + `['program']`; session-level writes also hit `['session', id]`; writes that move, rename, archive or delete a session also drop `['all-confirmations']` (the coach's Confirmed feed carries the session payload) and `['coach-dashboard-programs']` (the strip) |
| [useSession](../src/hooks/useSession.js) | `['session', sessionId]` | `['session', sessionId]` + `['week']` (broad) |
| [useSetLogs](../src/hooks/useSetLogs.js) | `['set-logs', sessionId, slotIds]` | `['set-logs']` (broad), optimistically updated in `onMutate` |
| [useSetVideo](../src/hooks/useSetVideo.js) | `['set-videos', sessionId]`, `['set-video-signed-url', storagePath]` | `['set-videos', sessionId]` |
| [useSessionConfirmation](../src/hooks/useSessionConfirmation.js) | `['session-confirmation', sessionId]`, `['all-confirmations', userId]`, `['my-confirmed-session-ids', userId]`, `['week-confirmed-session-ids', weekId]` | `invalidateConfirmationQueries(qc)` hits the student-side prefixes. It deliberately does NOT drop `['all-confirmations']`: that is the coach's feed and this mutation runs on the student's device. |
| [useSlotComments](../src/hooks/useSlotComments.js) | `['slot-comments', sessionId]` | `['slot-comments', sessionId]` |
| [useExerciseLibrary](../src/hooks/useExerciseLibrary.js) | `['exercise-library']` | `['exercise-library']` |
| [useStudents](../src/hooks/useStudents.js) | `['students']` | n/a |
| [useGoals](../src/hooks/useGoals.js) | `['goals', 'student', studentProfileId]`, `['goals', 'mine', userId]`, `['student-profile-id', studentRowId]` | `['goals']` (broad) |
| [useStudentProgramDetails](../src/hooks/useStudentProgramDetails.js) | `['student-program-details', userId, 'active' \| 'all']` | read-only |
| [useStudentProgressStats](../src/hooks/useStudentProgressStats.js) | `['student-progress-stats', userId]` | read-only |
| [useStudentHistoricalSessions](../src/hooks/useStudentHistoricalSessions.js) | `['student-historical-sessions', userId]` | read-only |
| [useDuplicate](../src/hooks/useDuplicate.js) | n/a | `['program']`, `['week']`, `['session']`, `['set-logs']`, `['coach-dashboard-programs']` |

### Two-pass reorder writes

Week reordering (`useReorderWeeks`) does an **optimistic two-pass write**: park all weeks at `week_number = 100000 + idx`, then set them to `idx + 1`. The two-pass dodges the `UNIQUE(program_id, week_number)` constraint mid-update. `useReorderPrograms` mirrors the same two-pass pattern for programs (even though `sort_order` has no unique constraint) so the code reads identically.

`ProgramSheet` is dnd-kit sortable at two levels behind **two explicit modes**, because dragging and vertical scrolling compete for the same axis: the drag handles (6-dot grip) exist only while reordering, and every other control steps out of the way so a drag can't be a mis-tap. **Reorder** (footer) makes the session rows draggable across the whole block — including across a phase divider, which MOVES the session into that phase; each divider is also a `useDroppable`, the only way to reach a phase with no sessions to aim at. **Reorder phases** (a divider's ⋯ menu) makes the dividers draggable and hides the sessions, so a phase is dragged as a whole rather than past twenty of its own rows. One `DndContext` serves both — dnd-kit supports many sortable lists inside one context — and `handleDragEnd` dispatches on which mode is active. Touch drag still needs the 200ms press delay (`TouchSensor` activation) so taps don't trigger drags. Tests that render `ProgramSheet` (directly or via `CoachHome`) must mock `useReorderWeeks`, `useReorderSessions` and `useMoveSession` from `hooks/useWeek`.

## Auth and Row-Level Security

**Client auth**: [src/hooks/useAuth.jsx](../src/hooks/useAuth.jsx) wraps Supabase's `auth.onAuthStateChange`. It exposes `{ user, profile, role, isLoading, signIn, signOut }`. `profile.role` is the single gate for coach-only vs student-only surfaces.

**Route guards** (in [src/routes.jsx](../src/routes.jsx)): `ProtectedRoute` redirects unauthenticated users to `/login`; `RoleGate allowed="coach|student"` redirects on role mismatch. The guards protect paths — the database enforces access.

**RLS policies** (in [supabase/schema.sql](../supabase/schema.sql)): coach and student policies walk the session → program relationship via two helpers:

- `student_profile_for_session(sess_id)` — returns the assigned student's profile id.
- `coach_profile_for_session(sess_id)` — returns the owning coach's profile id.

Tables like `set_logs`, `session_confirmations`, `slot_comments`, `exercise_slots`, and `set_log_videos` all use these helpers so a policy boils down to `auth.uid() = student_profile_for_session(…)` (student side) or `auth.uid() = coach_profile_for_session(…)` (coach side).

**When you add a table**, add:

1. Both student-side and coach-side policies using these helpers (or equivalents).
2. A migration in the format of [supabase/migrations/README.md](../supabase/migrations/README.md) (file, audit, rollback, runbook page, manifest entry) *and* the same statements merged into [supabase/schema.sql](../supabase/schema.sql).
3. An insert probe for the table in `insertProbes()` of `supabase/tests/rls-matrix.test.js` — the test fails until the table has one.

## Migrations and the ledger

Production gets its SQL by hand, one file at a time; the database tests load `supabase/schema.sql`. Three pieces keep the two the same database.

**The manifest.** `supabase/migrations/manifest.json` lists the migrations that follow the format, in apply order, each with a `kind` (`required`, `optional`, `contract`), its wave and checkpoint, and whether its rollback is exact (`reversible`). `supabase/migrations/manifest.js` reads it and derives, from the name `YYYY_MM_DD_NN_<name>`, the four files of a migration: `supabase/migrations/<name>.sql`, `supabase/audits/<name>.audit.sql` (one read-only query), `supabase/rollbacks/<name>.down.sql` and `docs/runbook/migrations/NN-<name>.md`. The files dated before `2026_10` are history: they cannot be replayed and nothing reads them.

**The ledger.** `app_private.app_migrations (name, applied_at)`, created by migration 01. A migration file is one transaction — `BEGIN`, `SET LOCAL lock_timeout`, a guard, the change, the ledger insert, `NOTIFY pgrst, 'reload schema'` when the API surface changes (a table, a column, a primary, unique or foreign key, a function header of `public` — in the rollback file too), `COMMIT` — and its guard refuses a second run (`SLM01`) and a run before the migration it requires (`SLM02`). What a migration requires is the nearest `required` migration before it; a `contract` one requires the nearest `required` or `contract` one (`predecessorOf`). `schema.sql` ends with the same schema and table and an `INSERT` of the names of the migrations merged into it.

**The tests** (`npm run test:db`). `postgres.js` builds two templates per run: `sl_bare` (`shim.sql` only — a Supabase project before any user SQL) and `sl_template` (`sl_bare` + `schema.sql`). `scratchDatabase()` in `harness.js` clones either one for a test that loads SQL files itself.

- `parity.test.js`: `sl_bare` + `fixtures/prod_baseline_2026_09_30.sql` (`schema.sql` as it was compared with production on 2026-09-30, frozen, SHA-256 pinned) + the `required` and `optional` migrations must have the catalog of `schema.sql`. `catalog.js` reads a catalog as data (`catalogSnapshot`) and lists the differences one line per object (`diffCatalogs`); `catalog.test.js` makes each kind of change, on objects of its own, and checks it is seen.
- `migration-conventions.test.js`: the rules of the format, on the text (`staticProblems`) and by running each migration on the baseline, in order (`checkMigration` in `migration-checks.js`): audit read-only → refused without the migration it requires → applied → refused twice → rolled back (catalog equal to before) → refused twice → applied again (catalog equal to the first time). A second pass on the baseline applies every migration that is not `optional` (`withoutOptionalProblems`): none may need an optional one. The same code is run on deliberately wrong migrations, and the judge of the manifest (`manifestProblems`) on a temporary folder of its own.
- `migration-ledger.test.js`: no API role can read, write or reach `app_private`; the rollback of migration 01 refuses (`SLM04`) while the ledger records a later migration.
- `rls-matrix.test.js`: what six callers can do to every table, against `snapshots/rls-matrix.txt`.
- `rpc-auth.test.js` and `auth-accounts.test.js`: the commands and queries the runbook pages give, read off the page and run.

**The hand-over.** Applying a migration to production is the owner's step. [RUNBOOK.md](RUNBOOK.md) is the index: the rules, the table of checkpoints (which migrations, what else by hand, whether the app is published afterwards) and the sequence of each checkpoint that is ready. [runbook/00-before-you-start.md](runbook/00-before-you-start.md) says how a file is run and what each refusal means, and every migration has its page under `docs/runbook/migrations/`. `src/test/runbookIndex.test.js` holds the index to the manifest (a migration under the checkpoint its entry names; each one audited, applied, audited again, in order; its rollback and page named; the ledger read last) and to the pages (the index repeats their commands and introduces none).

## Set video uploads

Set videos live in `set_log_videos` (1:1 with `set_logs`, `UNIQUE(set_log_id)`) + private Supabase Storage bucket `set-videos`. Migration: `2026_04_23_set_log_videos.sql`.

- **Path convention**: `<profile_id>/<slot_id>/<set>-<uuid>.<ext>`. Storage RLS gates on the first path segment — must equal `auth.uid()` for student ops, or must be a profile_id owned by the coach for coach read.
- **Client caps uploads at 25 MB** (bucket caps at 30 MB). Students see a clear size-limit error if the clip is too large. No client-side re-encoding in v1.
- **Signed URLs** have 1h TTL, keyed by `storage_path` in the query cache so they're reused across players.
- **Replacement uploads** delete the old object + row first so `UNIQUE(set_log_id)` stays clean.
- **`record_video_set_numbers`** on `exercise_slots` (int[], default `{}`): coach flags any subset of sets per exercise. Student sees an amber "Record" badge on each matching `SetRow`. If the coach reduces `sets` below a picked number, stale entries just don't match any row (no crash). `commitVideoSets` in `ExerciseSlotRow` sorts + dedupes + filters before persisting.

## Routing

[src/routes.jsx](../src/routes.jsx) is the single source of truth. Each screen is `React.lazy`-loaded behind a `<Suspense fallback={<Spinner/>}>` wrapper. Every route goes through `ProtectedRoute` → `AppShell` → `RoleGate` (coach or student) → page.

Notable URLs:

- **Coach**: `/coach/students` (the Athletes roster — coach home), `/coach/students/:studentId`, `/coach/sessions`, `/coach/student/:studentId/week/:weekId`, `/coach/student/:studentId/week/:weekId/session/:sessionId`, `/coach/student/:studentId/session/:sessionId/review`, `/coach/exercises`.
- **Student**: `/student`, `/student/sessions`, `/student/stats`, `/student/messages`, `/student/session/:sessionId`, `/student/goals`, `/student/profile`. The bottom nav surfaces only Home / Sessions / Stats / Messages — `/student/goals` is reached from the Profile page's "Active goal" card, and `/student/profile` from the avatar in any header.
- **Legacy redirects**: `/student/dashboard` → `/student/stats`. `/coach` → `/coach/students`. `/coach/dashboard` → `/coach/students` (Dashboard merged into the Athletes roster). `/coach/student/:studentId/goals` → `/coach/students/:studentId` (via `RedirectToStudent` in `routes.jsx` — a plain `<Navigate to="/foo/:id" />` does not interpolate params; the wrapper does).

`StudentDashboard.jsx` is the Stats page — the file is named `StudentDashboard` but imported as `StudentStats` and rendered at `/student/stats`. Don't rename the file.

Vite `base` is `/sl_app/` and `vite.config.js` declares manual chunks for `router`, `query`, `supabase` — vendor caching survives deploys.

### Coach-section persistence across tab switches

Two flows drive "pick up where you left off" via three localStorage keys:

- **`sl_last_coach_students_path`** — full pathname (+ search) of the coach's last Athletes-tab view: the athlete page, or the session editor beneath it. Written by `useRememberCoachStudentsPath()` ([src/hooks/useRememberCoachStudentsPath.jsx](../src/hooks/useRememberCoachStudentsPath.jsx)), called once in `CoachHome` — which is the route element for the athlete page *and* the parent of `s/:sessionId`, so one call covers the editor too. The bare roster path is on a skip-write list and can never become the restore target. Read by `CoachHome`'s restore effect when the route is `/coach/students` with no `:studentId`: it validates the saved athlete is still on the roster, then `navigate(saved, { replace: true })`. **Cleared by the "‹ All athletes" header link** — the coach's explicit "I want the roster" signal. Without that clear the restore effect would bounce them straight back into the athlete they just left, making the roster unreachable from an athlete page.
- **`sl_last_coach_session`** — `JSON.stringify({ studentId, sessionId })` for the last-open `SessionReview`. Read by `SessionsFeed`'s mount effect (redirects into the saved review). Cleared by the review's back button.
- **`sl_last_coach_sessions_student`** — the student-id the coach last picked in `SessionsFeed`'s filter dropdown. Written by `handleFilterChange` (removed when the coach picks "All students"). On mount, a dedicated effect copies the saved id back into the `?student=` search param when the URL has none. The filter lives in the URL — localStorage just repopulates it on return to `/coach/sessions`.

### Back-button routing in coach deep views

Because these deep views are reachable from several entry points (a roster card, a week view, the sessions feed), the previous history entry is unpredictable, so `navigate(-1)` can land somewhere unexpected. Use logical parents instead:

- `SessionEditor` back → `/coach/students/:studentId`
- `SessionReview` back → `/coach/sessions`

### Nav tab active-state overrides

`BottomNav`'s "Athletes" (`/coach/students`) and "Home" (`/student`) links use `NavLink`'s `end` prop so they only match on exact routes — without it they stay active on all child routes.

The single-student view has **no tab strip** — the athlete is one page of collapsible sections at `/coach/students/:studentId`, with session editing as its only child route (`…/s/:sessionId`). `AppShell` restores each route's scroll offset instead of hard-resetting to top, so stepping into a session and back keeps the coach's place; see the persistence invariant in [INVARIANTS.md](INVARIANTS.md).

For coach tabs, **Students** and **Sessions** both live under the shared `/coach/student/:sid/…` prefix, so a plain `end: false` NavLink would light up BOTH tabs on any deep route. Each tab in `layout/navItems` instead declares a `matches(pathname)` predicate:

- **Students** matches `/coach/students*` OR `/coach/student/:sid/week/…`
- **Sessions** matches `/coach/sessions*` OR `/coach/student/:sid/session/…/review`

`BottomNav` / `SideNav` call `useLocation()` and use `customActive ?? navLinkIsActive`.

## Scroll container

Only `main` (inside `AppShell`) scrolls. `html, body, #root` are `overflow: hidden; position: fixed; inset: 0;` so the mobile keyboard can focus a textarea (e.g. the Confirm-session note) without pushing the sticky `BottomNav` mid-page. `AppShell` is `h-full flex-col`, **not** `h-dvh` — on iOS Safari the two disagree and a second scrollbar appears on `body`.

## Session & UI behavior patterns

- **`SessionView` exercise cards** auto-open only the first incomplete group. Every other group (complete or still pending) starts collapsed, so the student always sees exactly one "current exercise". As the last set of group N is marked done, group N collapses and group N+1 opens. Manual taps still win per-group via `manualOpen[groupKey]`. Supersets collapse as a single unit (grouping from `groupSlotsBySuperset`) since sets alternate across slots.
- **`SessionCard`** supports controlled and uncontrolled open state. Pass `open` + `onToggle` to control from the parent (this is how `StudentTraining` enforces single-open accordion behavior). Omit them and the card falls back to its own `useState(defaultOpen)`. `collapsible={false}` pins it open — used for the next-up card. `locked` drops the start affordance for a past block's read-only sessions.
- **Exercise Library filtering is client-side.** Search and type-filter state live in `ExerciseLibrary` and are applied with `useMemo` over the already-fetched list — no extra Supabase queries. Search bar + pills are hidden on an empty library to keep the add-first flow clean.

## i18n: dictionaries and fragments

`src/lib/i18n/en.js`, `fr.js` and `de.js` are the base dictionaries. `src/lib/i18n/index.js` exports `messages` — each base dictionary plus that language's **fragments** — and `getMessage(lang, key, params)`, which looks a dotted key up in `lang`, then in English, then returns the key itself.

A fragment is how a package adds strings without editing the three dictionaries: `src/lib/i18n/fragments/<package-id>.<lang>.js`, default-exporting an object with one new top-level namespace. `index.js` loads them with one `import.meta.glob` per language (`fragmentModules`) and `mergeFragments` (`src/lib/i18n/mergeFragments.js`) merges them. The base dictionary always wins: a fragment can add a namespace, never replace one. One glob per language is deliberate, so a language loaded on demand takes its fragments with it.

The integrator folds the fragments into the dictionaries at the end of waves 4 and 9 (copy the namespace, delete the three files); call sites do not change. The rules are in `src/lib/i18n/fragments/README.md` and enforced by `src/lib/i18n/parity.test.js`: three languages with identical keys, a camelCase namespace that exists neither in the base dictionaries nor in another package, non-empty string values, and no file in the folder that no language loads. `src/lib/i18n/usage.test.js` checks every literal `t('a.b')` call in `src/components` and `src/hooks` against the merged English dictionary. Both tests also run on a fixture package (`src/lib/i18n/__fixtures__/fragments/`), so the rules stay tested while the real folder is empty.

## Testing

Unit tests live next to components as `*.test.jsx`. The shared wrapper [src/test/utils.jsx](../src/test/utils.jsx) stacks `ThemeProvider` + `QueryClientProvider` + a lightweight `AuthContext` + `MemoryRouter`. Hooks are stubbed per-file with `vi.mock(...)`. The `useI18n` + `useTheme` hooks both tolerate a missing provider and return no-op English/light defaults — so a component can render in isolation without pulling the whole tree in.

There are three suites, each with its own command and config. `npm test` (`vite.config.js`, jsdom) is the unit suite and excludes `supabase/tests/**` and `docs/**`. `npm run test:db` (`vitest.db.config.js`) is the database suite. `npm run test:docs` (`vitest.docs.config.js`, node) runs the tests under `docs/`; it has no test yet and passes empty. `src/test/docsSuite.test.js` keeps the three apart and checks the format of the snippets in `docs/_pending/`.

`src/test/hardcodedScan.js` is test support for the per-folder "no hard-coded text" tests: `scanHardcoded({ root, allow })` parses every source file of a folder with ESLint's parser and lists JSX text, strings rendered as a JSX child and the literal values of text attributes (`aria-label`, `title`, `placeholder`, `alt`, and props such as `label`, `message` or `confirmLabel`). `allow.files` exempts whole files, `allow.text` exact strings or patterns, and `unused` names the allow-list entries that no longer exempt anything. It does not see a string that reaches the screen through a variable, an object or a function call.

Run the suite from WSL (see [docs/ENVIRONMENT.md](ENVIRONMENT.md)):

```bash
npm test -- --run     # single pass, CI-style
npm test              # watch mode
```
