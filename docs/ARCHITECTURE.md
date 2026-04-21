# Architecture

A tour of how `sl_app` is wired — data model, client-side caching, auth/RLS boundaries, and routing. Start here when a change could ripple across layers. For working notes and the file-by-file feature map, see [CLAUDE.md](../CLAUDE.md).

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
programs (id, coach_id, student_id, title)
  │
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
  │ exercise_id                                    │
  ▼                                                ▼
exercises (library:  name, type 'pull'|'push',   slot_comments (student-authored
           difficulty, volume_weight)             comments per slot per session)
  │
  ▼
set_logs (exercise_slot_id, set_number, weight, reps, rpe, done)
```

Side tables:

- **`goals`** + `goal_progress` — student-chosen target lifts, coach can also author them. See [src/hooks/useGoals.js](../src/hooks/useGoals.js).
- **`exercises`** — each coach owns a library; slots reference by `exercise_id`.

Volume helper [src/lib/volume.js](../src/lib/volume.js) aggregates `difficulty × sets × reps × volume_weight` per `type` across a session, skipping time-under-tension slots.

## React Query — who owns which key

Invalidation is scoped intentionally to avoid over-fetching. When you add a mutation, mirror the nearest existing hook.

| Hook | Reads | Writes invalidate |
|---|---|---|
| [useProgram](../src/hooks/useProgram.js) | `['program', studentId]` | `['program', studentId]` on changes; `['program']` broad on add/delete |
| [useWeek](../src/hooks/useWeek.js) | `['week', weekId]` | `['week', weekId]` + `['program']`; session-level writes also hit `['session', id]`; session-archive additionally invalidates `['student-confirmations']` |
| [useSession](../src/hooks/useSession.js) | `['session', sessionId]` | `['session', sessionId]` + `['week']` (broad) |
| [useSetLogs](../src/hooks/useSetLogs.js) | `['set-logs', sessionId, slotIds]` | `['set-logs']` (broad), optimistically updated in `onMutate` |
| [useSessionConfirmation](../src/hooks/useSessionConfirmation.js) | `['session-confirmation', sessionId]`, `['all-confirmations', userId]`, `['my-confirmed-session-ids', userId]`, `['week-confirmed-session-ids', weekId]` | `invalidateConfirmationCaches(qc)` hits all four prefixes + `['student-confirmations']` |
| [useSlotComments](../src/hooks/useSlotComments.js) | `['slot-comments', sessionId]` | `['slot-comments', sessionId]` |
| [useExerciseLibrary](../src/hooks/useExerciseLibrary.js) | `['exercise-library']` | `['exercise-library']` |
| [useStudents](../src/hooks/useStudents.js) | `['students']` | n/a |
| [useGoals](../src/hooks/useGoals.js) | `['goals', 'student', studentProfileId]`, `['goals', 'mine', userId]`, `['student-profile-id', studentRowId]` | `['goals']` (broad) |
| [useStudentProgramDetails](../src/hooks/useStudentProgramDetails.js) | `['student-program-details', userId]` | read-only |
| [useStudentProgressStats](../src/hooks/useStudentProgressStats.js) | `['student-progress-stats', userId]` | read-only |
| [useDuplicate](../src/hooks/useDuplicate.js) | n/a | `['program']`, `['week']`, `['session']`, `['student-weeks']` |

Week reordering (`useReorderWeeks`) does an **optimistic two-pass write**: park all weeks at `week_number = 100000 + idx`, then set them to `idx + 1`. The two-pass dodges the `UNIQUE(program_id, week_number)` constraint mid-update.

## Auth and Row-Level Security

**Client auth**: [src/hooks/useAuth.jsx](../src/hooks/useAuth.jsx) wraps Supabase's `auth.onAuthStateChange`. It exposes `{ user, profile, role, isLoading, signIn, signOut }`. `profile.role` is the single gate for coach-only vs student-only surfaces.

**Route guards** (in [src/routes.jsx](../src/routes.jsx)): `ProtectedRoute` redirects unauthenticated users to `/login`; `RoleGate allowed="coach|student"` redirects on role mismatch. The guards protect paths — the database enforces access.

**RLS policies** (in [supabase/schema.sql](../supabase/schema.sql)): coach and student policies walk the session → program relationship via two helpers:

- `student_profile_for_session(sess_id)` — returns the assigned student's profile id.
- `coach_profile_for_session(sess_id)` — returns the owning coach's profile id.

Tables like `set_logs`, `session_confirmations`, `slot_comments`, and `exercise_slots` all use these helpers so a policy boils down to `auth.uid() = student_profile_for_session(…)` (student side) or `auth.uid() = coach_profile_for_session(…)` (coach side).

**When you add a table**, add:

1. Both student-side and coach-side policies using these helpers (or equivalents).
2. Migration SQL under [supabase/migrations/](../supabase/migrations/) *and* append the same statements to [supabase/schema.sql](../supabase/schema.sql).

## Routing

[src/routes.jsx](../src/routes.jsx) is the single source of truth. Each screen is `React.lazy`-loaded behind a `<Suspense fallback={<Spinner/>}>` wrapper. Every route goes through `ProtectedRoute` → `AppShell` → `RoleGate` (coach or student) → page.

Notable URLs:

- Coach:  `/coach/dashboard`, `/coach/students`, `/coach/sessions`, `/coach/student/:studentId/week/:weekId`, `/coach/student/:studentId/week/:weekId/session/:sessionId`, `/coach/student/:studentId/session/:sessionId/review`, `/coach/exercises`, `/coach/student/:studentId/goals`.
- Student: `/student`, `/student/sessions`, `/student/stats`, `/student/session/:sessionId`, `/student/goals`.
- Legacy: `/student/dashboard` → redirects to `/student/stats`. `/coach` → `/coach/dashboard`.

Vite `base` is `/sl_app/` and `vite.config.js` declares manual chunks for `router`, `query`, `supabase` — vendor caching survives deploys.

## Where the scroll lives

Only `main` (inside `AppShell`) scrolls. `html, body, #root` are `overflow: hidden; position: fixed; inset: 0;` so the mobile keyboard can focus a textarea (e.g. the Confirm-session note) without pushing the sticky `BottomNav` mid-page. `AppShell` is `h-full flex-col`, **not** `h-dvh` — on iOS Safari the two disagree and a second scrollbar appears on `body`.

## Testing

Unit tests live next to components as `*.test.jsx`. The shared wrapper [src/test/utils.jsx](../src/test/utils.jsx) stacks `ThemeProvider` + `QueryClientProvider` + a lightweight `AuthContext` + `MemoryRouter`. Hooks are stubbed per-file with `vi.mock(...)`. The `useI18n` + `useTheme` hooks both tolerate a missing provider and return no-op English/light defaults — so a component can render in isolation without pulling the whole tree in.

Run the suite from WSL (see [docs/ENVIRONMENT.md](ENVIRONMENT.md)):

```bash
npm test -- --run     # single pass, CI-style
npm test              # watch mode
```
