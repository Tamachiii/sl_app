-- ============================================================
-- Street Lifting Coach — Supabase Schema
-- Apply this in the Supabase SQL Editor
-- ============================================================

-- Types
CREATE TYPE exercise_type AS ENUM ('pull', 'push');

-- ============================================================
-- TABLES
-- ============================================================

-- Profiles (mirrors auth.users, holds role)
CREATE TABLE public.profiles (
  id          uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('coach', 'student')),
  full_name   text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Students (links a student profile to a coach)
CREATE TABLE public.students (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id  uuid NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE CASCADE,
  coach_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Programs (top-level container per student). A student can have many programs
-- arranged by sort_order (for periodization blocks), but at most one is_active
-- at a time. Students only ever see the active program.
CREATE TABLE public.programs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id  uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  name        text NOT NULL,
  sort_order  int  NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT false,
  -- Trash semantics (2026_07_13): "delete" stamps deleted_at + clears
  -- is_active; every surface filters deleted_at IS NULL; restore NULLs it.
  -- Hard DELETE is blocked by trigger while logged sets exist (below).
  deleted_at  timestamptz,
  -- Phase 3.4: student program authoring. created_by is NULL for coach-authored
  -- programs; status defaults 'approved' so the coach flow is untouched. A
  -- draft can never be active (CHECK); one in-flight draft per student.
  created_by  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  status      text NOT NULL DEFAULT 'approved' CHECK (status IN ('draft', 'approved')),
  submitted_at timestamptz,
  approved_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT programs_draft_not_active CHECK (NOT (status = 'draft' AND is_active))
);
CREATE INDEX IF NOT EXISTS idx_programs_created_by ON public.programs(created_by) WHERE created_by IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS programs_one_draft_per_student
  ON public.programs(student_id) WHERE status = 'draft' AND deleted_at IS NULL;

-- Weeks
CREATE TABLE public.weeks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id  uuid NOT NULL REFERENCES public.programs(id) ON DELETE CASCADE,
  week_number int  NOT NULL,
  label       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE(program_id, week_number)
);

-- Sessions
CREATE TABLE public.sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  week_id        uuid NOT NULL REFERENCES public.weeks(id) ON DELETE CASCADE,
  -- Recommended WEEKDAY (1 = Monday … 7 = Sunday), never an ordinal position.
  -- NULL = no recommendation (2026_08_21). Advisory only: order comes from
  -- sort_order, and nothing is "missed" for being trained on another day.
  day_number     int,
  title          text,
  sort_order     int  NOT NULL DEFAULT 0,
  scheduled_date date,
  archived_at    timestamptz,
  reviewed_at    timestamptz,
  -- When the session was ACTUALLY trained. Denormalized mirror of the
  -- confirmation's performed_on, maintained by trg_sync_session_performed_at
  -- (2026_08_21). NULL = not performed. Same idiom as reviewed_at: surfaces
  -- that already walk the program tree read the date without a second join.
  performed_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- Tied sort_orders once made week duplication merge two sessions into one
  -- copy (2026_07_13). Sessions have no drag-reorder flow; if one is added
  -- it must park-then-place like the week reorder.
  CONSTRAINT sessions_week_sort_order_unique UNIQUE (week_id, sort_order)
);

CREATE INDEX IF NOT EXISTS sessions_reviewed_idx
  ON public.sessions (reviewed_at) WHERE reviewed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS sessions_performed_idx
  ON public.sessions (performed_at) WHERE performed_at IS NOT NULL;

-- Exercise library (shared per coach)
CREATE TABLE public.exercise_library (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id      uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  name          text NOT NULL,
  type          exercise_type NOT NULL,
  difficulty    int  NOT NULL CHECK (difficulty BETWEEN 1 AND 3),
  volume_weight numeric(4,2) NOT NULL DEFAULT 1.0,
  -- Loading mode for relative strength (×BW). NULL = unclassified (behaves like
  -- today: added/logged-load e1RM, no ×BW). 'full' = logged weight IS the total
  -- resistance; 'added' = logged weight is added on top of bodyweight (system
  -- load = bodyweight + added). See 2026_07_23_exercise_load_mode.sql.
  load_mode     text CHECK (load_mode IS NULL OR load_mode IN ('full','added')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Exercise slots (exercise placed in a session)
CREATE TABLE public.exercise_slots (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id       uuid NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  exercise_id      uuid NOT NULL REFERENCES public.exercise_library(id) ON DELETE RESTRICT,
  sets             int  NOT NULL CHECK (sets > 0),
  reps             int  CHECK (reps IS NULL OR reps > 0),
  duration_seconds int  CHECK (duration_seconds IS NULL OR duration_seconds > 0),
  weight_kg        numeric(6,2),
  sort_order       int  NOT NULL DEFAULT 0,
  rest_seconds     int  CHECK (rest_seconds IS NULL OR rest_seconds >= 0),
  superset_group   uuid,
  notes            text,
  record_video_set_numbers int[] NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT exercise_slots_unit_one_of CHECK ((reps IS NOT NULL) <> (duration_seconds IS NOT NULL))
);

-- Set logs (student fills these in)
-- Each row is BOTH the prescription (target_*) and the student's actuals
-- (done, rpe, weight_kg). Per-set targets let one exercise have heterogeneous
-- sets (drop sets, back-offs) without a separate slot. exercise_slots.{reps,
-- weight_kg, duration_seconds, rest_seconds} remain as deprecated mirrors of
-- set 1 — slated for removal in a follow-up migration.
CREATE TABLE public.set_logs (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exercise_slot_id         uuid NOT NULL REFERENCES public.exercise_slots(id) ON DELETE CASCADE,
  set_number               int  NOT NULL CHECK (set_number > 0),
  done                     boolean NOT NULL DEFAULT false,
  failed                   boolean NOT NULL DEFAULT false,
  rpe                      int CHECK (rpe IS NULL OR (rpe BETWEEN 1 AND 10)),
  weight_kg                numeric(6,2),
  -- Student-recorded "what I actually did" when they go off-script. NULL on
  -- either column means "followed the prescription" for that dimension, so a
  -- populated actual_* always signals an off-plan set.
  actual_reps              int,
  actual_weight_kg         numeric(6,2),
  -- Structural per-set deviations: `skipped` = the student deliberately
  -- dropped a prescribed set; `is_student_added` = a set logged beyond the
  -- prescription (target_* are NULL on those rows).
  skipped                  boolean NOT NULL DEFAULT false,
  is_student_added         boolean NOT NULL DEFAULT false,
  target_reps              int,
  target_duration_seconds  int,
  target_weight_kg         numeric(6,2),
  target_rest_seconds      int,
  logged_at                timestamptz,
  failed_at                timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE(exercise_slot_id, set_number),
  CONSTRAINT set_logs_target_unit_one_of CHECK (
    target_reps IS NULL OR target_duration_seconds IS NULL
  ),
  CONSTRAINT set_logs_done_xor_failed CHECK (NOT (done AND failed)),
  CONSTRAINT set_logs_no_rpe_when_failed CHECK (NOT (failed AND rpe IS NOT NULL)),
  CONSTRAINT set_logs_actual_reps_nonneg CHECK (actual_reps IS NULL OR actual_reps >= 0),
  CONSTRAINT set_logs_actual_weight_nonneg CHECK (actual_weight_kg IS NULL OR actual_weight_kg >= 0),
  CONSTRAINT set_logs_skipped_not_resolved CHECK (NOT (skipped AND (done OR failed)))
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX idx_students_coach_id ON public.students(coach_id);
CREATE INDEX idx_students_profile_id ON public.students(profile_id);
CREATE INDEX idx_programs_student_id ON public.programs(student_id);
CREATE UNIQUE INDEX programs_one_active_per_student
  ON public.programs(student_id) WHERE is_active;
CREATE INDEX idx_weeks_program_id ON public.weeks(program_id);
CREATE INDEX idx_sessions_week_id ON public.sessions(week_id);
CREATE INDEX idx_sessions_scheduled_date ON public.sessions(scheduled_date);
CREATE INDEX idx_sessions_archived_at ON public.sessions(archived_at);
CREATE INDEX idx_exercise_slots_session_id ON public.exercise_slots(session_id);
CREATE INDEX idx_exercise_slots_superset_group ON public.exercise_slots(superset_group);
CREATE INDEX idx_set_logs_slot_id ON public.set_logs(exercise_slot_id);
CREATE INDEX idx_exercise_library_coach_id ON public.exercise_library(coach_id);

-- ============================================================
-- HELPER FUNCTIONS
-- ============================================================

-- Walk from exercise_slot_id up to the student's profile_id
CREATE OR REPLACE FUNCTION public.student_profile_for_slot(slot_id uuid)
RETURNS uuid AS $$
  SELECT s.profile_id
  FROM public.exercise_slots es
  JOIN public.sessions sess ON sess.id = es.session_id
  JOIN public.weeks w ON w.id = sess.week_id
  JOIN public.programs p ON p.id = w.program_id
  JOIN public.students s ON s.id = p.student_id
  WHERE es.id = slot_id
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- True iff the session's parent program is still the student's active block.
-- Drives the student-side write gate on past-program sessions: once a coach
-- swaps blocks, history becomes read-only.
-- "Active for writes" folds in deleted_at (2026_07_13): a trashed program is
-- never writable regardless of is_active, so the trash flag and the write
-- gate can't drift apart.
CREATE OR REPLACE FUNCTION public.program_active_for_session(sess_id uuid)
RETURNS boolean AS $$
  SELECT p.is_active AND p.deleted_at IS NULL
  FROM public.sessions sess
  JOIN public.weeks w    ON w.id = sess.week_id
  JOIN public.programs p ON p.id = w.program_id
  WHERE sess.id = sess_id
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.program_active_for_slot(slot_id uuid)
RETURNS boolean AS $$
  SELECT public.program_active_for_session(es.session_id)
  FROM public.exercise_slots es
  WHERE es.id = slot_id
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.students ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.programs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.weeks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exercise_library ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exercise_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.set_logs ENABLE ROW LEVEL SECURITY;

-- PROFILES
CREATE POLICY "Users read own profile"
  ON public.profiles FOR SELECT
  USING (id = auth.uid());

CREATE POLICY "Coaches read their students profiles"
  ON public.profiles FOR SELECT
  USING (
    id IN (SELECT profile_id FROM public.students WHERE coach_id = auth.uid())
  );

-- Mirror of the policy above for the student → coach direction. Needed so the
-- "your coach" surface (e.g. Student Messages tab) can read coach.full_name
-- via an embedded select; without it, Supabase silently returns coach: null.
CREATE POLICY "Students read their coach profile"
  ON public.profiles FOR SELECT
  USING (
    id IN (SELECT coach_id FROM public.students WHERE profile_id = auth.uid())
  );

-- Self-rename: lets the Student Profile page update its own full_name. The
-- BEFORE UPDATE trigger below pins `id`, `role`, and `created_at` so a
-- student cannot promote themselves to coach via the same payload.
CREATE POLICY "Users update own profile"
  ON public.profiles FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- STUDENTS
CREATE POLICY "Coaches see their students"
  ON public.students FOR SELECT
  USING (coach_id = auth.uid());

CREATE POLICY "Students see own row"
  ON public.students FOR SELECT
  USING (profile_id = auth.uid());

CREATE POLICY "Coaches insert students"
  ON public.students FOR INSERT
  WITH CHECK (coach_id = auth.uid());

CREATE POLICY "Coaches update their students"
  ON public.students FOR UPDATE
  USING (coach_id = auth.uid());

CREATE POLICY "Coaches delete their students"
  ON public.students FOR DELETE
  USING (coach_id = auth.uid());

-- PROGRAMS
CREATE POLICY "Coaches manage programs"
  ON public.programs FOR ALL
  USING (
    student_id IN (SELECT id FROM public.students WHERE coach_id = auth.uid())
  );

CREATE POLICY "Students read own programs"
  ON public.programs FOR SELECT
  USING (
    student_id IN (SELECT id FROM public.students WHERE profile_id = auth.uid())
  );

-- WEEKS
CREATE POLICY "Coaches manage weeks"
  ON public.weeks FOR ALL
  USING (
    program_id IN (
      SELECT p.id FROM public.programs p
      JOIN public.students s ON s.id = p.student_id
      WHERE s.coach_id = auth.uid()
    )
  );

CREATE POLICY "Students read own weeks"
  ON public.weeks FOR SELECT
  USING (
    program_id IN (
      SELECT p.id FROM public.programs p
      JOIN public.students s ON s.id = p.student_id
      WHERE s.profile_id = auth.uid()
    )
  );

-- SESSIONS
CREATE POLICY "Coaches manage sessions"
  ON public.sessions FOR ALL
  USING (
    week_id IN (
      SELECT w.id FROM public.weeks w
      JOIN public.programs p ON p.id = w.program_id
      JOIN public.students s ON s.id = p.student_id
      WHERE s.coach_id = auth.uid()
    )
  );

CREATE POLICY "Students read own sessions"
  ON public.sessions FOR SELECT
  USING (
    week_id IN (
      SELECT w.id FROM public.weeks w
      JOIN public.programs p ON p.id = w.program_id
      JOIN public.students s ON s.id = p.student_id
      WHERE s.profile_id = auth.uid()
    )
  );

-- EXERCISE LIBRARY
CREATE POLICY "Coaches manage own library"
  ON public.exercise_library FOR ALL
  USING (coach_id = auth.uid());

CREATE POLICY "Students read their coachs library"
  ON public.exercise_library FOR SELECT
  USING (
    coach_id IN (SELECT coach_id FROM public.students WHERE profile_id = auth.uid())
  );

-- EXERCISE SLOTS
CREATE POLICY "Coaches manage exercise slots"
  ON public.exercise_slots FOR ALL
  USING (
    session_id IN (
      SELECT sess.id FROM public.sessions sess
      JOIN public.weeks w ON w.id = sess.week_id
      JOIN public.programs p ON p.id = w.program_id
      JOIN public.students s ON s.id = p.student_id
      WHERE s.coach_id = auth.uid()
    )
  );

CREATE POLICY "Students read own exercise slots"
  ON public.exercise_slots FOR SELECT
  USING (
    session_id IN (
      SELECT sess.id FROM public.sessions sess
      JOIN public.weeks w ON w.id = sess.week_id
      JOIN public.programs p ON p.id = w.program_id
      JOIN public.students s ON s.id = p.student_id
      WHERE s.profile_id = auth.uid()
    )
  );

-- SET LOGS
-- Coaches own per-set prescriptions (target_* columns) for their students'
-- slots; students own their actuals (done, rpe, weight_kg, actual_reps,
-- actual_weight_kg). The DB grants both sides FOR ALL on the same table —
-- column separation is enforced by client discipline (coach UI never writes
-- actuals; student UI never writes targets) AND hardened by the
-- pin_set_log_targets_for_student BEFORE UPDATE trigger, which reverts any
-- attempt by a student to mutate the coach-owned target_* columns. If this
-- proves insufficient we can split actuals to a child table.
CREATE POLICY "Coaches manage set log prescriptions"
  ON public.set_logs FOR ALL
  USING (
    public.student_profile_for_slot(exercise_slot_id) IN (
      SELECT profile_id FROM public.students WHERE coach_id = auth.uid()
    )
  )
  WITH CHECK (
    public.student_profile_for_slot(exercise_slot_id) IN (
      SELECT profile_id FROM public.students WHERE coach_id = auth.uid()
    )
  );

-- Students always read their own logs (so history viewed from the stats
-- calendar shows RPEs / done flags). Writes only land on slots whose parent
-- program is still active — once deactivated, historical sessions become
-- read-only at the DB level. SELECT is split out so the read gate can stay
-- permissive while the write gates restrict.
CREATE POLICY "Students read own set logs"
  ON public.set_logs FOR SELECT
  USING (public.student_profile_for_slot(exercise_slot_id) = auth.uid());

CREATE POLICY "Students insert own set logs"
  ON public.set_logs FOR INSERT
  WITH CHECK (
    public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND public.program_active_for_slot(exercise_slot_id) = true
  );

CREATE POLICY "Students update own set logs"
  ON public.set_logs FOR UPDATE
  USING (
    public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND public.program_active_for_slot(exercise_slot_id) = true
  )
  WITH CHECK (
    public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND public.program_active_for_slot(exercise_slot_id) = true
  );

-- DELETE is narrowed to student-added rows (2026_07_12): the target-pin
-- trigger only guards UPDATE, so an unrestricted DELETE would let a student
-- remove a prescribed row and re-INSERT it with forged targets.
CREATE POLICY "Students delete own set logs"
  ON public.set_logs FOR DELETE
  USING (
    public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND public.program_active_for_slot(exercise_slot_id) = true
    AND is_student_added = true
  );

-- ============================================================
-- SESSION CONFIRMATIONS
-- Students mark a session as confirmed/done; coaches can see them.
-- ============================================================
CREATE TABLE public.session_confirmations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   uuid NOT NULL UNIQUE REFERENCES public.sessions(id) ON DELETE CASCADE,
  student_id   uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  -- The local calendar date the student actually trained, computed client-side
  -- from the session's set_logs.logged_at at confirm time (2026_08_21). NULL
  -- falls back to confirmed_at. confirmed_at alone is the REPLAY time for an
  -- offline confirm, which is why this exists.
  performed_on date,
  notes        text
);

CREATE INDEX idx_session_confirmations_session_id ON public.session_confirmations(session_id);
CREATE INDEX idx_session_confirmations_student_id ON public.session_confirmations(student_id);

CREATE OR REPLACE FUNCTION public.student_profile_for_session(sess_id uuid)
RETURNS uuid AS $$
  SELECT s.profile_id
  FROM public.sessions sess
  JOIN public.weeks w   ON w.id = sess.week_id
  JOIN public.programs p ON p.id = w.program_id
  JOIN public.students s ON s.id = p.student_id
  WHERE sess.id = sess_id
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.coach_profile_for_session(sess_id uuid)
RETURNS uuid AS $$
  SELECT s.coach_id
  FROM public.sessions sess
  JOIN public.weeks w   ON w.id = sess.week_id
  JOIN public.programs p ON p.id = w.program_id
  JOIN public.students s ON s.id = p.student_id
  WHERE sess.id = sess_id
$$ LANGUAGE sql SECURITY DEFINER STABLE;

ALTER TABLE public.session_confirmations ENABLE ROW LEVEL SECURITY;

-- SELECT is permissive so students can view the timestamp / notes of their
-- own old confirmations on archived or past-program sessions. Writes are
-- gated: students cannot create / undo confirmations on archived sessions
-- OR on sessions whose parent program has been deactivated.
CREATE POLICY "Students read own session confirmations"
  ON public.session_confirmations FOR SELECT
  USING (
    student_id = auth.uid()
    AND public.student_profile_for_session(session_id) = auth.uid()
  );

CREATE POLICY "Students insert own session confirmations"
  ON public.session_confirmations FOR INSERT
  WITH CHECK (
    student_id = auth.uid()
    AND public.student_profile_for_session(session_id) = auth.uid()
    AND NOT EXISTS (
      SELECT 1 FROM public.sessions s
      WHERE s.id = session_confirmations.session_id AND s.archived_at IS NOT NULL
    )
    AND public.program_active_for_session(session_id) = true
  );

CREATE POLICY "Students update own session confirmations"
  ON public.session_confirmations FOR UPDATE
  USING (
    student_id = auth.uid()
    AND public.student_profile_for_session(session_id) = auth.uid()
    AND NOT EXISTS (
      SELECT 1 FROM public.sessions s
      WHERE s.id = session_confirmations.session_id AND s.archived_at IS NOT NULL
    )
    AND public.program_active_for_session(session_id) = true
  )
  WITH CHECK (
    student_id = auth.uid()
    AND public.student_profile_for_session(session_id) = auth.uid()
    AND NOT EXISTS (
      SELECT 1 FROM public.sessions s
      WHERE s.id = session_confirmations.session_id AND s.archived_at IS NOT NULL
    )
    AND public.program_active_for_session(session_id) = true
  );

CREATE POLICY "Students delete own session confirmations"
  ON public.session_confirmations FOR DELETE
  USING (
    student_id = auth.uid()
    AND public.student_profile_for_session(session_id) = auth.uid()
    AND NOT EXISTS (
      SELECT 1 FROM public.sessions s
      WHERE s.id = session_confirmations.session_id AND s.archived_at IS NOT NULL
    )
    AND public.program_active_for_session(session_id) = true
  );

CREATE POLICY "Coaches read confirmations for their students"
  ON public.session_confirmations FOR SELECT
  USING (
    public.coach_profile_for_session(session_id) = auth.uid()
  );

-- ============================================================
-- GOALS
-- Coach-set targets for a student (1RM or "sets x reps @ weight" format).
-- Students track attempts via goal_progress and can mark goals achieved.
-- ============================================================
DO $$ BEGIN
  CREATE TYPE goal_kind AS ENUM ('one_rm', 'format');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS public.goals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  coach_id         uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  exercise_id      uuid NOT NULL REFERENCES public.exercise_library(id) ON DELETE CASCADE,
  kind             goal_kind NOT NULL,
  target_weight_kg numeric(6,2) NOT NULL,
  target_sets      int,
  target_reps      int NOT NULL DEFAULT 1,
  notes            text,
  achieved         boolean NOT NULL DEFAULT false,
  achieved_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_goals_student_id  ON public.goals(student_id);
CREATE INDEX IF NOT EXISTS idx_goals_exercise_id ON public.goals(exercise_id);

CREATE TABLE IF NOT EXISTS public.goal_progress (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goal_id      uuid NOT NULL REFERENCES public.goals(id) ON DELETE CASCADE,
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  weight_kg    numeric(6,2) NOT NULL,
  sets         int,
  reps         int,
  notes        text
);

CREATE INDEX IF NOT EXISTS idx_goal_progress_goal_id ON public.goal_progress(goal_id);

CREATE OR REPLACE FUNCTION public.student_profile_for_goal(g uuid)
RETURNS uuid AS $$
  SELECT student_id FROM public.goals WHERE id = g
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.coach_profile_for_goal(g uuid)
RETURNS uuid AS $$
  SELECT coach_id FROM public.goals WHERE id = g
$$ LANGUAGE sql SECURITY DEFINER STABLE;

ALTER TABLE public.goals         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.goal_progress ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Students read own goals"
  ON public.goals FOR SELECT
  USING (student_id = auth.uid());

CREATE POLICY "Students mark own goals achieved"
  ON public.goals FOR UPDATE
  USING (student_id = auth.uid())
  WITH CHECK (student_id = auth.uid());

CREATE POLICY "Coaches manage goals for their students"
  ON public.goals FOR ALL
  USING (
    coach_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.students s
      WHERE s.profile_id = goals.student_id AND s.coach_id = auth.uid()
    )
  )
  WITH CHECK (
    coach_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.students s
      WHERE s.profile_id = goals.student_id AND s.coach_id = auth.uid()
    )
  );

CREATE POLICY "Students manage own goal progress"
  ON public.goal_progress FOR ALL
  USING (public.student_profile_for_goal(goal_id) = auth.uid())
  WITH CHECK (public.student_profile_for_goal(goal_id) = auth.uid());

CREATE POLICY "Coaches read goal progress for their students"
  ON public.goal_progress FOR SELECT
  USING (public.coach_profile_for_goal(goal_id) = auth.uid());

-- ============================================================
-- SLOT COMMENTS
-- Student-authored free-text note attached to a specific exercise slot,
-- readable by the student's coach.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.slot_comments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exercise_slot_id uuid NOT NULL UNIQUE REFERENCES public.exercise_slots(id) ON DELETE CASCADE,
  student_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  body             text NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_slot_comments_slot_id ON public.slot_comments(exercise_slot_id);

ALTER TABLE public.slot_comments ENABLE ROW LEVEL SECURITY;

-- SELECT permissive so students can still see their own old notes on
-- archived / past-program sessions. Writes blocked under the same gates.
CREATE POLICY "Students read own slot comments"
  ON public.slot_comments FOR SELECT
  USING (
    student_id = auth.uid()
    AND public.student_profile_for_slot(exercise_slot_id) = auth.uid()
  );

CREATE POLICY "Students insert own slot comments"
  ON public.slot_comments FOR INSERT
  WITH CHECK (
    student_id = auth.uid()
    AND public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND NOT EXISTS (
      SELECT 1 FROM public.exercise_slots es
      JOIN public.sessions s ON s.id = es.session_id
      WHERE es.id = slot_comments.exercise_slot_id AND s.archived_at IS NOT NULL
    )
    AND public.program_active_for_slot(exercise_slot_id) = true
  );

CREATE POLICY "Students update own slot comments"
  ON public.slot_comments FOR UPDATE
  USING (
    student_id = auth.uid()
    AND public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND NOT EXISTS (
      SELECT 1 FROM public.exercise_slots es
      JOIN public.sessions s ON s.id = es.session_id
      WHERE es.id = slot_comments.exercise_slot_id AND s.archived_at IS NOT NULL
    )
    AND public.program_active_for_slot(exercise_slot_id) = true
  )
  WITH CHECK (
    student_id = auth.uid()
    AND public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND NOT EXISTS (
      SELECT 1 FROM public.exercise_slots es
      JOIN public.sessions s ON s.id = es.session_id
      WHERE es.id = slot_comments.exercise_slot_id AND s.archived_at IS NOT NULL
    )
    AND public.program_active_for_slot(exercise_slot_id) = true
  );

CREATE POLICY "Students delete own slot comments"
  ON public.slot_comments FOR DELETE
  USING (
    student_id = auth.uid()
    AND public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND NOT EXISTS (
      SELECT 1 FROM public.exercise_slots es
      JOIN public.sessions s ON s.id = es.session_id
      WHERE es.id = slot_comments.exercise_slot_id AND s.archived_at IS NOT NULL
    )
    AND public.program_active_for_slot(exercise_slot_id) = true
  );

CREATE POLICY "Coaches read slot comments for their students"
  ON public.slot_comments FOR SELECT
  USING (
    public.student_profile_for_slot(exercise_slot_id) IN (
      SELECT profile_id FROM public.students WHERE coach_id = auth.uid()
    )
  );

-- ============================================================
-- SLOT DEVIATIONS — student swaps / skips a whole prescribed exercise.
-- One row per slot (UNIQUE exercise_slot_id). Substitutes are coach-library
-- only (no free-text), so analytics keep a known exercise. RLS mirrors
-- slot_comments: student owns the row (read permissive, writes gated to the
-- active, non-archived program), coach reads their students' rows. A new
-- deviation notifies the coach via notify_coach_on_slot_deviation.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.slot_deviations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exercise_slot_id       uuid NOT NULL UNIQUE REFERENCES public.exercise_slots(id) ON DELETE CASCADE,
  student_id             uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  kind                   text NOT NULL CHECK (kind IN ('swap', 'skip')),
  substitute_exercise_id uuid REFERENCES public.exercise_library(id) ON DELETE RESTRICT,
  note                   text,
  -- Phase 3.3: student's explicit "make this permanent" proposal signal.
  promote_requested_at   timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slot_deviations_swap_has_substitute CHECK (
    (kind = 'swap' AND substitute_exercise_id IS NOT NULL)
    OR (kind = 'skip' AND substitute_exercise_id IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_slot_deviations_slot_id ON public.slot_deviations(exercise_slot_id);

ALTER TABLE public.slot_deviations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Students read own slot deviations"
  ON public.slot_deviations FOR SELECT
  USING (
    student_id = auth.uid()
    AND public.student_profile_for_slot(exercise_slot_id) = auth.uid()
  );

CREATE POLICY "Students insert own slot deviations"
  ON public.slot_deviations FOR INSERT
  WITH CHECK (
    student_id = auth.uid()
    AND public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND NOT EXISTS (
      SELECT 1 FROM public.exercise_slots es
      JOIN public.sessions s ON s.id = es.session_id
      WHERE es.id = slot_deviations.exercise_slot_id AND s.archived_at IS NOT NULL
    )
    AND public.program_active_for_slot(exercise_slot_id) = true
  );

CREATE POLICY "Students update own slot deviations"
  ON public.slot_deviations FOR UPDATE
  USING (
    student_id = auth.uid()
    AND public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND public.program_active_for_slot(exercise_slot_id) = true
  )
  WITH CHECK (
    student_id = auth.uid()
    AND public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND public.program_active_for_slot(exercise_slot_id) = true
  );

CREATE POLICY "Students delete own slot deviations"
  ON public.slot_deviations FOR DELETE
  USING (
    student_id = auth.uid()
    AND public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND public.program_active_for_slot(exercise_slot_id) = true
  );

CREATE POLICY "Coaches read slot deviations for their students"
  ON public.slot_deviations FOR SELECT
  USING (
    public.student_profile_for_slot(exercise_slot_id) IN (
      SELECT profile_id FROM public.students WHERE coach_id = auth.uid()
    )
  );

-- ============================================================
-- TRIGGER: auto-create profile on signup
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, role, full_name)
  VALUES (
    NEW.id,
    -- Never trust client-supplied metadata for the role (2026_07_12): the
    -- anon key is public, so signup metadata is attacker-controlled. Coach
    -- promotion is a manual UPDATE on profiles.
    'student',
    COALESCE(NEW.raw_user_meta_data->>'full_name', '')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- ============================================================
-- TRIGGER: pin profile id/role/created_at on UPDATE
-- Defense in depth for the "Users update own profile" policy: even if a
-- payload sets `role: 'coach'`, this trigger reverts it before the row hits
-- the table, so a student can never promote themselves.
-- ============================================================
CREATE OR REPLACE FUNCTION public.profiles_pin_immutable_columns()
RETURNS trigger AS $$
BEGIN
  NEW.id := OLD.id;
  NEW.role := OLD.role;
  NEW.created_at := OLD.created_at;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER profiles_pin_immutable_columns
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.profiles_pin_immutable_columns();

-- ============================================================
-- TRIGGER: restrict student goal updates to achieved/achieved_at only
-- ============================================================
CREATE OR REPLACE FUNCTION public.restrict_student_goal_update()
RETURNS TRIGGER AS $$
BEGIN
  IF auth.uid() = NEW.student_id AND auth.uid() != OLD.coach_id THEN
    NEW.exercise_id      := OLD.exercise_id;
    NEW.kind             := OLD.kind;
    NEW.target_weight_kg := OLD.target_weight_kg;
    NEW.target_sets      := OLD.target_sets;
    NEW.target_reps      := OLD.target_reps;
    NEW.notes            := OLD.notes;
    NEW.coach_id         := OLD.coach_id;
    NEW.student_id       := OLD.student_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_restrict_student_goal_update ON public.goals;
CREATE TRIGGER trg_restrict_student_goal_update
  BEFORE UPDATE ON public.goals
  FOR EACH ROW EXECUTE FUNCTION public.restrict_student_goal_update();

-- ============================================================
-- TRIGGER: pin coach-owned target_* on student set_log updates
-- Defense in depth for the shared set_logs row: students legitimately write
-- actuals (done/failed/rpe/weight_kg/actual_*), but must never rewrite the
-- coach's prescription. When the writer is the slot's student (not the coach),
-- revert every target_* column to OLD. Coach writes resolve a different
-- auth.uid() and pass through untouched.
-- ============================================================
CREATE OR REPLACE FUNCTION public.pin_set_log_targets_for_student()
RETURNS trigger AS $$
BEGIN
  IF public.student_profile_for_slot(NEW.exercise_slot_id) = auth.uid() THEN
    NEW.target_reps             := OLD.target_reps;
    NEW.target_duration_seconds := OLD.target_duration_seconds;
    NEW.target_weight_kg        := OLD.target_weight_kg;
    NEW.target_rest_seconds     := OLD.target_rest_seconds;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_pin_set_log_targets_for_student ON public.set_logs;
CREATE TRIGGER trg_pin_set_log_targets_for_student
  BEFORE UPDATE ON public.set_logs
  FOR EACH ROW EXECUTE FUNCTION public.pin_set_log_targets_for_student();

-- ============================================================
-- SET LOG VIDEOS
-- Student-uploaded video clips, one per set_log. Files live in the
-- private 'set-videos' storage bucket, keyed by
-- <student_profile_id>/<exercise_slot_id>/<set_number>-<uuid>.<ext>
-- ============================================================
CREATE TABLE IF NOT EXISTS public.set_log_videos (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  set_log_id    uuid NOT NULL UNIQUE REFERENCES public.set_logs(id) ON DELETE CASCADE,
  storage_path  text NOT NULL,
  mime_type     text NOT NULL,
  size_bytes    int  NOT NULL CHECK (size_bytes > 0),
  duration_ms   int,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_set_log_videos_set_log
  ON public.set_log_videos(set_log_id);

CREATE OR REPLACE FUNCTION public.student_profile_for_set_log(log_id uuid)
RETURNS uuid AS $$
  SELECT public.student_profile_for_slot(sl.exercise_slot_id)
  FROM public.set_logs sl
  WHERE sl.id = log_id
$$ LANGUAGE sql SECURITY DEFINER STABLE;

ALTER TABLE public.set_log_videos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Students manage own set log videos"
  ON public.set_log_videos FOR ALL
  USING (public.student_profile_for_set_log(set_log_id) = auth.uid())
  WITH CHECK (public.student_profile_for_set_log(set_log_id) = auth.uid());

CREATE POLICY "Coaches read student set log videos"
  ON public.set_log_videos FOR SELECT
  USING (
    public.student_profile_for_set_log(set_log_id) IN (
      SELECT profile_id FROM public.students WHERE coach_id = auth.uid()
    )
  );

-- Storage bucket (private, 30 MB file cap)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'set-videos',
  'set-videos',
  false,
  31457280,
  ARRAY['video/webm', 'video/mp4', 'video/quicktime']
)
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Storage RLS: first path segment is owning student's profile_id.
CREATE POLICY "Students upload own set videos"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'set-videos'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "Students read own set videos"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'set-videos'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "Students delete own set videos"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'set-videos'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "Coaches read student set videos"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'set-videos'
    AND (storage.foldername(name))[1] IN (
      SELECT profile_id::text FROM public.students WHERE coach_id = auth.uid()
    )
  );

-- ============================================================
-- MESSAGES (coach ↔ student direct messaging)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  body         text NOT NULL CHECK (char_length(btrim(body)) > 0 AND char_length(body) <= 4000),
  -- Optional reference to a session; non-null means this message is the coach's
  -- "session feedback" attached to the end of SessionReview.
  session_id   uuid REFERENCES public.sessions(id) ON DELETE SET NULL,
  read_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT messages_no_self_send CHECK (sender_id <> recipient_id)
);

CREATE INDEX IF NOT EXISTS messages_pair_created_idx
  ON public.messages (LEAST(sender_id, recipient_id), GREATEST(sender_id, recipient_id), created_at DESC);

CREATE INDEX IF NOT EXISTS messages_recipient_unread_idx
  ON public.messages (recipient_id) WHERE read_at IS NULL;

-- UNIQUE so the DB rejects a second coach-feedback insert for the same
-- session. (See 2026_04_30_unique_session_feedback.sql.)
CREATE UNIQUE INDEX IF NOT EXISTS messages_session_idx
  ON public.messages (session_id) WHERE session_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.profiles_are_coach_student(a uuid, b uuid)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.students s
    WHERE (s.coach_id = a AND s.profile_id = b)
       OR (s.coach_id = b AND s.profile_id = a)
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Lock body/sender/recipient on UPDATE so the recipient-update policy can
-- only flip read_at (RLS can't restrict per-column otherwise).
CREATE OR REPLACE FUNCTION public.lock_message_fields_on_update()
RETURNS TRIGGER AS $$
BEGIN
  NEW.id           := OLD.id;
  NEW.sender_id    := OLD.sender_id;
  NEW.recipient_id := OLD.recipient_id;
  NEW.body         := OLD.body;
  NEW.session_id   := OLD.session_id;
  NEW.created_at   := OLD.created_at;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_lock_message_fields ON public.messages;
CREATE TRIGGER trg_lock_message_fields
  BEFORE UPDATE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.lock_message_fields_on_update();

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Read own messages"
  ON public.messages FOR SELECT
  USING (sender_id = auth.uid() OR recipient_id = auth.uid());

-- Send: must be self + the pair must be coach/student. If session_id is
-- attached, sender must be the coach for that session and recipient the
-- student — keeps "feedback link" rows from being forged into unrelated
-- threads.
CREATE POLICY "Send to coach-student counterpart"
  ON public.messages FOR INSERT
  WITH CHECK (
    sender_id = auth.uid()
    AND public.profiles_are_coach_student(sender_id, recipient_id)
    AND (
      session_id IS NULL
      OR (
        sender_id    = public.coach_profile_for_session(session_id)
        AND recipient_id = public.student_profile_for_session(session_id)
      )
    )
  );

CREATE POLICY "Recipient marks messages read"
  ON public.messages FOR UPDATE
  USING (recipient_id = auth.uid())
  WITH CHECK (recipient_id = auth.uid());

-- Sender may delete their own ordinary chat messages. Coach feedback rows
-- (session_id IS NOT NULL) are pinned so the one-shot review invariant on
-- sessions.reviewed_at and the messages_session_idx unique index hold.
CREATE POLICY "Sender deletes own message"
  ON public.messages FOR DELETE
  USING (sender_id = auth.uid() AND session_id IS NULL);

-- Realtime: broadcast inserts/updates to subscribed clients (REPLICA IDENTITY
-- FULL so UPDATEs carry the old row).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'messages'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
    END IF;
  END IF;
END $$;

ALTER TABLE public.messages REPLICA IDENTITY FULL;

-- ============================================================
-- NOTIFICATIONS (per-recipient feed of app events)
-- Generic kind+payload shape; new event types are added by writing a
-- new SECURITY DEFINER trigger that inserts here. INSERT only happens
-- via those triggers — no client-facing INSERT policy.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.notifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id  uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  kind          text NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notifications_recipient_created_idx
  ON public.notifications (recipient_id, created_at DESC);

CREATE INDEX IF NOT EXISTS notifications_recipient_unread_idx
  ON public.notifications (recipient_id) WHERE read_at IS NULL;

-- Pin every column except read_at on UPDATE so RLS scoped to "recipient
-- can update" can't be used to mutate kind/payload/etc.
CREATE OR REPLACE FUNCTION public.lock_notification_fields_on_update()
RETURNS TRIGGER AS $$
BEGIN
  NEW.id           := OLD.id;
  NEW.recipient_id := OLD.recipient_id;
  NEW.kind         := OLD.kind;
  NEW.payload      := OLD.payload;
  NEW.created_at   := OLD.created_at;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_lock_notification_fields ON public.notifications;
CREATE TRIGGER trg_lock_notification_fields
  BEFORE UPDATE ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION public.lock_notification_fields_on_update();

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Read own notifications"
  ON public.notifications FOR SELECT
  USING (recipient_id = auth.uid());

CREATE POLICY "Recipient marks notifications read"
  ON public.notifications FOR UPDATE
  USING (recipient_id = auth.uid())
  WITH CHECK (recipient_id = auth.uid());

-- Trigger: notify the coach when their student confirms a session.
CREATE OR REPLACE FUNCTION public.notify_coach_on_session_confirm()
RETURNS TRIGGER AS $$
DECLARE
  v_coach_id          uuid;
  v_student_profile   uuid;
  v_student_row_id    uuid;
  v_student_name      text;
  v_session_title     text;
  v_functions_url     text;
  v_service_key       text;
BEGIN
  v_coach_id        := public.coach_profile_for_session(NEW.session_id);
  v_student_profile := public.student_profile_for_session(NEW.session_id);

  IF v_coach_id IS NULL OR v_student_profile IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT s.id INTO v_student_row_id
    FROM public.students s
   WHERE s.profile_id = v_student_profile;

  SELECT p.full_name INTO v_student_name
    FROM public.profiles p
   WHERE p.id = v_student_profile;

  SELECT COALESCE(NULLIF(BTRIM(s.title), ''), 'Session') INTO v_session_title
    FROM public.sessions s
   WHERE s.id = NEW.session_id;

  INSERT INTO public.notifications (recipient_id, kind, payload)
  VALUES (
    v_coach_id,
    'session_completed',
    jsonb_build_object(
      'session_id', NEW.session_id,
      'session_title', v_session_title,
      'student_profile_id', v_student_profile,
      'student_row_id', v_student_row_id,
      'student_name', v_student_name,
      'confirmation_id', NEW.id
    )
  );

  -- Best-effort Web Push (same pattern as notify_coach_on_slot_deviation).
  BEGIN
    SELECT decrypted_secret INTO v_functions_url
      FROM vault.decrypted_secrets WHERE name = 'app_functions_url';
    SELECT decrypted_secret INTO v_service_key
      FROM vault.decrypted_secrets WHERE name = 'app_service_role_key';

    IF v_functions_url IS NOT NULL AND v_service_key IS NOT NULL
       AND v_functions_url <> '' AND v_service_key <> ''
    THEN
      PERFORM net.http_post(
        url := v_functions_url || '/send-push',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || v_service_key
        ),
        body := jsonb_build_object(
          'user_id', v_coach_id,
          'payload', jsonb_build_object(
            'title', 'Session completed',
            'body',  COALESCE(v_student_name, 'Your athlete')
                     || ' completed ' || v_session_title,
            'tag',   'session-confirm-' || NEW.id::text,
            'data',  jsonb_build_object(
              'url', '/sl_app/#/coach/student/' || COALESCE(v_student_row_id::text, '')
                     || '/session/' || NEW.session_id::text || '/review'
            )
          )
        )
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'send-push fan-out (session confirm) failed: %', SQLERRM;
  END;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_notify_coach_on_session_confirm ON public.session_confirmations;
CREATE TRIGGER trg_notify_coach_on_session_confirm
  AFTER INSERT ON public.session_confirmations
  FOR EACH ROW EXECUTE FUNCTION public.notify_coach_on_session_confirm();

-- Trigger: mirror the confirmation's performed date onto the session
-- (2026_08_21). Deliberately SEPARATE from notify_coach_on_session_confirm —
-- that one is the notification/Web-Push path (AFTER INSERT only, with an
-- EXCEPTION-wrapped pg_net call), and this needs the UPDATE branch (an offline
-- confirm replays as an upsert) and the DELETE branch (undo un-performs the
-- session). SECURITY DEFINER because students have no UPDATE grant on
-- `sessions`; the mirror is derived data, not a student write.
CREATE OR REPLACE FUNCTION public.sync_session_performed_at()
RETURNS TRIGGER AS $$
DECLARE
  v_performed timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE public.sessions SET performed_at = NULL WHERE id = OLD.session_id;
    RETURN OLD;
  END IF;

  v_performed := COALESCE(NEW.performed_on::timestamptz, NEW.confirmed_at);

  -- performed_on is client-supplied, so guard the one direction that can't be
  -- legitimate: a date in the future. A day of slack absorbs timezones ahead
  -- of the server. Past dates are never clamped — confirming days after
  -- training is normal and is the entire point of the column.
  IF v_performed > NEW.confirmed_at + interval '1 day' THEN
    v_performed := NEW.confirmed_at;
  END IF;

  UPDATE public.sessions SET performed_at = v_performed WHERE id = NEW.session_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_sync_session_performed_at ON public.session_confirmations;
CREATE TRIGGER trg_sync_session_performed_at
  AFTER INSERT OR DELETE OR UPDATE OF performed_on, confirmed_at
  ON public.session_confirmations
  FOR EACH ROW EXECUTE FUNCTION public.sync_session_performed_at();

-- Trigger: notify the coach the first time a student takes a slot off-script
-- (swap/skip an exercise). AFTER INSERT only — editing an existing deviation
-- does not re-notify. In-app notification + best-effort Web Push.
CREATE OR REPLACE FUNCTION public.notify_coach_on_slot_deviation()
RETURNS TRIGGER AS $$
DECLARE
  v_session_id      uuid;
  v_coach_id        uuid;
  v_student_profile uuid;
  v_student_row_id  uuid;
  v_student_name    text;
  v_session_title   text;
  v_original_name   text;
  v_substitute_name text;
  v_functions_url   text;
  v_service_key     text;
  v_body            text;
BEGIN
  SELECT es.session_id INTO v_session_id
    FROM public.exercise_slots es
   WHERE es.id = NEW.exercise_slot_id;

  v_coach_id        := public.coach_profile_for_session(v_session_id);
  v_student_profile := public.student_profile_for_session(v_session_id);

  IF v_coach_id IS NULL OR v_student_profile IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT s.id INTO v_student_row_id
    FROM public.students s WHERE s.profile_id = v_student_profile;
  SELECT p.full_name INTO v_student_name
    FROM public.profiles p WHERE p.id = v_student_profile;
  SELECT COALESCE(NULLIF(BTRIM(s.title), ''), 'Session') INTO v_session_title
    FROM public.sessions s WHERE s.id = v_session_id;
  SELECT el.name INTO v_original_name
    FROM public.exercise_slots es
    JOIN public.exercise_library el ON el.id = es.exercise_id
   WHERE es.id = NEW.exercise_slot_id;
  IF NEW.substitute_exercise_id IS NOT NULL THEN
    SELECT el.name INTO v_substitute_name
      FROM public.exercise_library el WHERE el.id = NEW.substitute_exercise_id;
  END IF;

  INSERT INTO public.notifications (recipient_id, kind, payload)
  VALUES (
    v_coach_id,
    'session_deviation',
    jsonb_build_object(
      'session_id',          v_session_id,
      'session_title',       v_session_title,
      'student_profile_id',  v_student_profile,
      'student_row_id',      v_student_row_id,
      'student_name',        v_student_name,
      'slot_id',             NEW.exercise_slot_id,
      'deviation_kind',      NEW.kind,
      'original_exercise',   v_original_name,
      'substitute_exercise', v_substitute_name
    )
  );

  -- Best-effort Web Push (same pattern as notify_student_on_session_feedback).
  BEGIN
    SELECT decrypted_secret INTO v_functions_url
      FROM vault.decrypted_secrets WHERE name = 'app_functions_url';
    SELECT decrypted_secret INTO v_service_key
      FROM vault.decrypted_secrets WHERE name = 'app_service_role_key';

    IF v_functions_url IS NOT NULL AND v_service_key IS NOT NULL
       AND v_functions_url <> '' AND v_service_key <> ''
    THEN
      IF NEW.kind = 'swap' THEN
        v_body := COALESCE(v_student_name, 'Your athlete') || ' swapped '
                  || COALESCE(v_original_name, 'an exercise') || ' → '
                  || COALESCE(v_substitute_name, 'another exercise')
                  || ' in ' || v_session_title;
      ELSE
        v_body := COALESCE(v_student_name, 'Your athlete') || ' skipped '
                  || COALESCE(v_original_name, 'an exercise')
                  || ' in ' || v_session_title;
      END IF;

      PERFORM net.http_post(
        url := v_functions_url || '/send-push',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || v_service_key
        ),
        body := jsonb_build_object(
          'user_id', v_coach_id,
          'payload', jsonb_build_object(
            'title', 'Off-plan session',
            'body',  v_body,
            'tag',   'deviation-' || NEW.id::text,
            'data',  jsonb_build_object(
              'url', '/sl_app/#/coach/student/' || COALESCE(v_student_row_id::text, '')
                     || '/session/' || v_session_id::text || '/review'
            )
          )
        )
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'send-push fan-out (slot deviation) failed: %', SQLERRM;
  END;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_notify_coach_on_slot_deviation ON public.slot_deviations;
CREATE TRIGGER trg_notify_coach_on_slot_deviation
  AFTER INSERT ON public.slot_deviations
  FOR EACH ROW EXECUTE FUNCTION public.notify_coach_on_slot_deviation();

-- Phase 3.1: adopt a student's swap into the standing prescription (forward-
-- only). Coach-only SECURITY DEFINER RPC (self-authorizes); see
-- 2026_07_18_adopt_swap.sql for the full rationale.
CREATE OR REPLACE FUNCTION public.adopt_swap(
  p_slot_id uuid,
  p_substitute_id uuid,
  p_dry_run boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session_id     uuid;
  v_original_ex    uuid;
  v_coach_id       uuid;
  v_student_prof   uuid;
  v_program_id     uuid;
  v_week_number    int;
  v_sort_order     int;
  v_slot_ids       uuid[];
  v_applied        int := 0;
  v_orig_name      text;
  v_sub_name       text;
  v_session_title  text;
  v_coach_name     text;
  v_functions_url  text;
  v_service_key    text;
BEGIN
  SELECT es.session_id, es.exercise_id
    INTO v_session_id, v_original_ex
    FROM public.exercise_slots es
   WHERE es.id = p_slot_id;
  IF v_session_id IS NULL THEN
    RAISE EXCEPTION 'slot not found';
  END IF;

  v_coach_id := public.coach_profile_for_session(v_session_id);
  IF v_coach_id IS NULL OR v_coach_id <> auth.uid() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.exercise_library el
     WHERE el.id = p_substitute_id AND el.coach_id = v_coach_id
  ) THEN
    RAISE EXCEPTION 'substitute not in coach library';
  END IF;

  SELECT w.program_id, w.week_number, s.sort_order
    INTO v_program_id, v_week_number, v_sort_order
    FROM public.sessions s
    JOIN public.weeks w ON w.id = s.week_id
   WHERE s.id = v_session_id;

  -- Forward-only via a REAL ordinal bound (strictly later in program order),
  -- not the optional "confirmed" flag: never rewrite an already-trained slot.
  SELECT array_agg(es.id)
    INTO v_slot_ids
    FROM public.exercise_slots es
    JOIN public.sessions s ON s.id = es.session_id
    JOIN public.weeks w ON w.id = s.week_id
   WHERE w.program_id = v_program_id
     AND es.exercise_id = v_original_ex
     AND s.archived_at IS NULL
     AND s.id <> v_session_id
     AND (w.week_number > v_week_number
          OR (w.week_number = v_week_number AND s.sort_order > v_sort_order))
     AND NOT EXISTS (
       SELECT 1 FROM public.session_confirmations sc WHERE sc.session_id = s.id
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.set_logs sl
        WHERE sl.exercise_slot_id = es.id
          AND (sl.done = true OR sl.skipped = true
               OR sl.actual_reps IS NOT NULL OR sl.actual_weight_kg IS NOT NULL)
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.slot_deviations d WHERE d.exercise_slot_id = es.id
     );

  v_applied := COALESCE(array_length(v_slot_ids, 1), 0);

  IF p_dry_run THEN
    RETURN jsonb_build_object('applied', v_applied, 'dry_run', true);
  END IF;

  IF v_slot_ids IS NOT NULL THEN
    UPDATE public.exercise_slots
       SET exercise_id = p_substitute_id
     WHERE id = ANY(v_slot_ids);
  END IF;

  v_student_prof := public.student_profile_for_session(v_session_id);
  IF v_student_prof IS NOT NULL AND v_applied > 0 THEN
    SELECT el.name INTO v_orig_name FROM public.exercise_library el WHERE el.id = v_original_ex;
    SELECT el.name INTO v_sub_name  FROM public.exercise_library el WHERE el.id = p_substitute_id;
    SELECT COALESCE(NULLIF(BTRIM(s.title), ''), 'Session') INTO v_session_title
      FROM public.sessions s WHERE s.id = v_session_id;
    SELECT p.full_name INTO v_coach_name FROM public.profiles p WHERE p.id = v_coach_id;

    INSERT INTO public.notifications (recipient_id, kind, payload)
    VALUES (
      v_student_prof,
      'swap_adopted',
      jsonb_build_object(
        'session_id', v_session_id,
        'session_title', v_session_title,
        'coach_name', v_coach_name,
        'original_exercise', v_orig_name,
        'substitute_exercise', v_sub_name,
        'applied_count', v_applied
      )
    );

    BEGIN
      SELECT decrypted_secret INTO v_functions_url FROM vault.decrypted_secrets WHERE name = 'app_functions_url';
      SELECT decrypted_secret INTO v_service_key   FROM vault.decrypted_secrets WHERE name = 'app_service_role_key';
      IF v_functions_url IS NOT NULL AND v_service_key IS NOT NULL
         AND v_functions_url <> '' AND v_service_key <> '' THEN
        PERFORM net.http_post(
          url := v_functions_url || '/send-push',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || v_service_key
          ),
          body := jsonb_build_object(
            'user_id', v_student_prof,
            'payload', jsonb_build_object(
              'title', 'Program updated',
              'body',  COALESCE(v_coach_name, 'Your coach') || ' adopted your swap: '
                       || COALESCE(v_orig_name, 'an exercise') || ' → '
                       || COALESCE(v_sub_name, 'another exercise'),
              'tag',   'swap-adopted-' || p_slot_id::text,
              'data',  jsonb_build_object('url', '/sl_app/#/student/session/' || v_session_id::text)
            )
          )
        );
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'send-push fan-out (swap adopted) failed: %', SQLERRM;
    END;
  END IF;

  RETURN jsonb_build_object('applied', v_applied, 'dry_run', false);
END;
$$;

REVOKE ALL ON FUNCTION public.adopt_swap(uuid, uuid, boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.adopt_swap(uuid, uuid, boolean) TO authenticated;

-- Phase 3.2: adopt a student's SKIP — drop the exercise from upcoming sessions
-- (forward-only DELETE). Same predicate as adopt_swap; see 2026_07_19_adopt_skip.sql.
CREATE OR REPLACE FUNCTION public.adopt_skip(
  p_slot_id uuid,
  p_dry_run boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session_id     uuid;
  v_original_ex    uuid;
  v_coach_id       uuid;
  v_student_prof   uuid;
  v_program_id     uuid;
  v_week_number    int;
  v_sort_order     int;
  v_slot_ids       uuid[];
  v_applied        int := 0;
  v_orig_name      text;
  v_session_title  text;
  v_coach_name     text;
  v_functions_url  text;
  v_service_key    text;
BEGIN
  SELECT es.session_id, es.exercise_id
    INTO v_session_id, v_original_ex
    FROM public.exercise_slots es
   WHERE es.id = p_slot_id;
  IF v_session_id IS NULL THEN
    RAISE EXCEPTION 'slot not found';
  END IF;

  v_coach_id := public.coach_profile_for_session(v_session_id);
  IF v_coach_id IS NULL OR v_coach_id <> auth.uid() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  SELECT w.program_id, w.week_number, s.sort_order
    INTO v_program_id, v_week_number, v_sort_order
    FROM public.sessions s
    JOIN public.weeks w ON w.id = s.week_id
   WHERE s.id = v_session_id;

  SELECT array_agg(es.id)
    INTO v_slot_ids
    FROM public.exercise_slots es
    JOIN public.sessions s ON s.id = es.session_id
    JOIN public.weeks w ON w.id = s.week_id
   WHERE w.program_id = v_program_id
     AND es.exercise_id = v_original_ex
     AND s.archived_at IS NULL
     AND s.id <> v_session_id
     AND (w.week_number > v_week_number
          OR (w.week_number = v_week_number AND s.sort_order > v_sort_order))
     AND NOT EXISTS (
       SELECT 1 FROM public.session_confirmations sc WHERE sc.session_id = s.id
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.set_logs sl
        WHERE sl.exercise_slot_id = es.id
          AND (sl.done = true OR sl.skipped = true
               OR sl.actual_reps IS NOT NULL OR sl.actual_weight_kg IS NOT NULL)
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.slot_deviations d WHERE d.exercise_slot_id = es.id
     );

  v_applied := COALESCE(array_length(v_slot_ids, 1), 0);

  IF p_dry_run THEN
    RETURN jsonb_build_object('applied', v_applied, 'dry_run', true);
  END IF;

  IF v_slot_ids IS NOT NULL THEN
    DELETE FROM public.exercise_slots WHERE id = ANY(v_slot_ids);
  END IF;

  v_student_prof := public.student_profile_for_session(v_session_id);
  IF v_student_prof IS NOT NULL AND v_applied > 0 THEN
    SELECT el.name INTO v_orig_name FROM public.exercise_library el WHERE el.id = v_original_ex;
    SELECT COALESCE(NULLIF(BTRIM(s.title), ''), 'Session') INTO v_session_title
      FROM public.sessions s WHERE s.id = v_session_id;
    SELECT p.full_name INTO v_coach_name FROM public.profiles p WHERE p.id = v_coach_id;

    INSERT INTO public.notifications (recipient_id, kind, payload)
    VALUES (
      v_student_prof,
      'skip_adopted',
      jsonb_build_object(
        'session_id', v_session_id,
        'session_title', v_session_title,
        'coach_name', v_coach_name,
        'original_exercise', v_orig_name,
        'applied_count', v_applied
      )
    );

    BEGIN
      SELECT decrypted_secret INTO v_functions_url FROM vault.decrypted_secrets WHERE name = 'app_functions_url';
      SELECT decrypted_secret INTO v_service_key   FROM vault.decrypted_secrets WHERE name = 'app_service_role_key';
      IF v_functions_url IS NOT NULL AND v_service_key IS NOT NULL
         AND v_functions_url <> '' AND v_service_key <> '' THEN
        PERFORM net.http_post(
          url := v_functions_url || '/send-push',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || v_service_key
          ),
          body := jsonb_build_object(
            'user_id', v_student_prof,
            'payload', jsonb_build_object(
              'title', 'Program updated',
              'body',  COALESCE(v_coach_name, 'Your coach') || ' dropped '
                       || COALESCE(v_orig_name, 'an exercise') || ' from your upcoming sessions',
              'tag',   'skip-adopted-' || p_slot_id::text,
              'data',  jsonb_build_object('url', '/sl_app/#/student/session/' || v_session_id::text)
            )
          )
        );
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'send-push fan-out (skip adopted) failed: %', SQLERRM;
    END;
  END IF;

  RETURN jsonb_build_object('applied', v_applied, 'dry_run', false);
END;
$$;

REVOKE ALL ON FUNCTION public.adopt_skip(uuid, boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.adopt_skip(uuid, boolean) TO authenticated;

-- Phase 3.3: student proposal loop. slot_deviations.promote_requested_at is the
-- student's "make this permanent" signal; this trigger notifies the coach on
-- the NULL→set transition. See 2026_07_20_deviation_promote_request.sql.
CREATE OR REPLACE FUNCTION public.notify_coach_on_promote_request()
RETURNS TRIGGER AS $$
DECLARE
  v_session_id      uuid;
  v_coach_id        uuid;
  v_student_prof    uuid;
  v_student_row_id  uuid;
  v_student_name    text;
  v_session_title   text;
  v_original_name   text;
  v_substitute_name text;
  v_functions_url   text;
  v_service_key     text;
  v_body            text;
BEGIN
  IF NEW.promote_requested_at IS NULL
     OR NEW.promote_requested_at IS NOT DISTINCT FROM OLD.promote_requested_at THEN
    RETURN NEW;
  END IF;

  SELECT es.session_id INTO v_session_id
    FROM public.exercise_slots es WHERE es.id = NEW.exercise_slot_id;
  v_coach_id     := public.coach_profile_for_session(v_session_id);
  v_student_prof := public.student_profile_for_session(v_session_id);
  IF v_coach_id IS NULL OR v_student_prof IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT st.id INTO v_student_row_id FROM public.students st WHERE st.profile_id = v_student_prof;
  SELECT p.full_name INTO v_student_name FROM public.profiles p WHERE p.id = v_student_prof;
  SELECT COALESCE(NULLIF(BTRIM(s.title), ''), 'Session') INTO v_session_title
    FROM public.sessions s WHERE s.id = v_session_id;
  SELECT el.name INTO v_original_name
    FROM public.exercise_slots es JOIN public.exercise_library el ON el.id = es.exercise_id
   WHERE es.id = NEW.exercise_slot_id;
  IF NEW.substitute_exercise_id IS NOT NULL THEN
    SELECT el.name INTO v_substitute_name FROM public.exercise_library el WHERE el.id = NEW.substitute_exercise_id;
  END IF;

  INSERT INTO public.notifications (recipient_id, kind, payload)
  VALUES (
    v_coach_id,
    'promote_requested',
    jsonb_build_object(
      'session_id', v_session_id,
      'session_title', v_session_title,
      'student_profile_id', v_student_prof,
      'student_row_id', v_student_row_id,
      'student_name', v_student_name,
      'slot_id', NEW.exercise_slot_id,
      'deviation_kind', NEW.kind,
      'original_exercise', v_original_name,
      'substitute_exercise', v_substitute_name
    )
  );

  BEGIN
    SELECT decrypted_secret INTO v_functions_url FROM vault.decrypted_secrets WHERE name = 'app_functions_url';
    SELECT decrypted_secret INTO v_service_key   FROM vault.decrypted_secrets WHERE name = 'app_service_role_key';
    IF v_functions_url IS NOT NULL AND v_service_key IS NOT NULL
       AND v_functions_url <> '' AND v_service_key <> '' THEN
      IF NEW.kind = 'swap' THEN
        v_body := COALESCE(v_student_name, 'Your athlete') || ' wants to keep '
                  || COALESCE(v_substitute_name, 'their swap') || ' instead of '
                  || COALESCE(v_original_name, 'the prescription');
      ELSE
        v_body := COALESCE(v_student_name, 'Your athlete') || ' wants to drop '
                  || COALESCE(v_original_name, 'an exercise') || ' going forward';
      END IF;
      PERFORM net.http_post(
        url := v_functions_url || '/send-push',
        headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_service_key),
        body := jsonb_build_object(
          'user_id', v_coach_id,
          'payload', jsonb_build_object(
            'title', 'Program change requested',
            'body',  v_body,
            'tag',   'promote-req-' || NEW.exercise_slot_id::text,
            'data',  jsonb_build_object(
              'url', '/sl_app/#/coach/student/' || COALESCE(v_student_row_id::text, '')
                     || '/session/' || v_session_id::text || '/review'
            )
          )
        )
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'send-push fan-out (promote request) failed: %', SQLERRM;
  END;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_notify_coach_on_promote_request ON public.slot_deviations;
CREATE TRIGGER trg_notify_coach_on_promote_request
  AFTER UPDATE ON public.slot_deviations
  FOR EACH ROW EXECUTE FUNCTION public.notify_coach_on_promote_request();

CREATE OR REPLACE FUNCTION public.decline_promote_request(p_slot_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session_id    uuid;
  v_coach_id      uuid;
  v_student_prof  uuid;
  v_original_name text;
  v_coach_name    text;
  v_session_title text;
  v_functions_url text;
  v_service_key   text;
  v_had_request   boolean;
BEGIN
  SELECT es.session_id INTO v_session_id
    FROM public.exercise_slots es WHERE es.id = p_slot_id;
  IF v_session_id IS NULL THEN
    RAISE EXCEPTION 'slot not found';
  END IF;

  v_coach_id := public.coach_profile_for_session(v_session_id);
  IF v_coach_id IS NULL OR v_coach_id <> auth.uid() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  UPDATE public.slot_deviations
     SET promote_requested_at = NULL
   WHERE exercise_slot_id = p_slot_id
     AND promote_requested_at IS NOT NULL;
  GET DIAGNOSTICS v_had_request = ROW_COUNT;

  IF NOT v_had_request THEN
    RETURN jsonb_build_object('declined', false);
  END IF;

  v_student_prof := public.student_profile_for_session(v_session_id);
  IF v_student_prof IS NOT NULL THEN
    SELECT el.name INTO v_original_name
      FROM public.exercise_slots es JOIN public.exercise_library el ON el.id = es.exercise_id
     WHERE es.id = p_slot_id;
    SELECT p.full_name INTO v_coach_name FROM public.profiles p WHERE p.id = v_coach_id;
    SELECT COALESCE(NULLIF(BTRIM(s.title), ''), 'Session') INTO v_session_title
      FROM public.sessions s WHERE s.id = v_session_id;

    INSERT INTO public.notifications (recipient_id, kind, payload)
    VALUES (
      v_student_prof,
      'promote_declined',
      jsonb_build_object(
        'session_id', v_session_id,
        'session_title', v_session_title,
        'coach_name', v_coach_name,
        'original_exercise', v_original_name
      )
    );

    BEGIN
      SELECT decrypted_secret INTO v_functions_url FROM vault.decrypted_secrets WHERE name = 'app_functions_url';
      SELECT decrypted_secret INTO v_service_key   FROM vault.decrypted_secrets WHERE name = 'app_service_role_key';
      IF v_functions_url IS NOT NULL AND v_service_key IS NOT NULL
         AND v_functions_url <> '' AND v_service_key <> '' THEN
        PERFORM net.http_post(
          url := v_functions_url || '/send-push',
          headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_service_key),
          body := jsonb_build_object(
            'user_id', v_student_prof,
            'payload', jsonb_build_object(
              'title', 'Coach kept your plan',
              'body',  COALESCE(v_coach_name, 'Your coach') || ' is keeping '
                       || COALESCE(v_original_name, 'the prescribed exercise') || ' in your program',
              'tag',   'promote-declined-' || p_slot_id::text,
              'data',  jsonb_build_object('url', '/sl_app/#/student/session/' || v_session_id::text)
            )
          )
        );
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'send-push fan-out (promote declined) failed: %', SQLERRM;
    END;
  END IF;

  RETURN jsonb_build_object('declined', true);
END;
$$;

REVOKE ALL ON FUNCTION public.decline_promote_request(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.decline_promote_request(uuid) TO authenticated;

-- ============================================================
-- Phase 3.4a: student program authoring (draft → coach approve). See
-- 2026_07_21_student_program_authoring.sql for the full rationale. Recursion-
-- firewall helpers (SECURITY DEFINER STABLE) + additive draft-scoped student
-- RLS + the authoring-column pin trigger + approve_program.
-- ============================================================
CREATE OR REPLACE FUNCTION public.program_is_own_draft(p_program_id uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.programs p
     WHERE p.id = p_program_id AND p.created_by = auth.uid()
       AND p.status = 'draft' AND p.deleted_at IS NULL
  );
$$;
CREATE OR REPLACE FUNCTION public.week_is_own_draft(p_week_id uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT public.program_is_own_draft((SELECT program_id FROM public.weeks WHERE id = p_week_id));
$$;
CREATE OR REPLACE FUNCTION public.session_is_own_draft(p_session_id uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT public.week_is_own_draft((SELECT week_id FROM public.sessions WHERE id = p_session_id));
$$;

DROP POLICY IF EXISTS "Students insert own draft programs" ON public.programs;
CREATE POLICY "Students insert own draft programs"
  ON public.programs FOR INSERT
  WITH CHECK (
    created_by = auth.uid() AND status = 'draft' AND is_active = false
    AND student_id IN (SELECT id FROM public.students WHERE profile_id = auth.uid())
  );
DROP POLICY IF EXISTS "Students update own draft programs" ON public.programs;
CREATE POLICY "Students update own draft programs"
  ON public.programs FOR UPDATE
  USING (created_by = auth.uid() AND status = 'draft' AND deleted_at IS NULL)
  WITH CHECK (
    created_by = auth.uid() AND status = 'draft' AND is_active = false
    AND student_id IN (SELECT id FROM public.students WHERE profile_id = auth.uid())
  );
DROP POLICY IF EXISTS "Students delete own draft programs" ON public.programs;
CREATE POLICY "Students delete own draft programs"
  ON public.programs FOR DELETE
  USING (created_by = auth.uid() AND status = 'draft');

DROP POLICY IF EXISTS "Students author own draft weeks" ON public.weeks;
CREATE POLICY "Students author own draft weeks"
  ON public.weeks FOR ALL
  USING (public.program_is_own_draft(program_id))
  WITH CHECK (public.program_is_own_draft(program_id));
DROP POLICY IF EXISTS "Students author own draft sessions" ON public.sessions;
CREATE POLICY "Students author own draft sessions"
  ON public.sessions FOR ALL
  USING (public.week_is_own_draft(week_id))
  WITH CHECK (public.week_is_own_draft(week_id));
DROP POLICY IF EXISTS "Students author own draft slots" ON public.exercise_slots;
CREATE POLICY "Students author own draft slots"
  ON public.exercise_slots FOR ALL
  USING (public.session_is_own_draft(session_id))
  WITH CHECK (
    public.session_is_own_draft(session_id)
    AND exercise_id IN (
      SELECT el.id FROM public.exercise_library el
      JOIN public.students st ON st.coach_id = el.coach_id
      WHERE st.profile_id = auth.uid()
    )
  );

CREATE OR REPLACE FUNCTION public.pin_program_authoring_columns()
RETURNS TRIGGER AS $$
BEGIN
  -- created_by + student_id immutable for everyone (tenant isolation: a draft
  -- author can never re-point their draft to another student).
  NEW.created_by := OLD.created_by;
  NEW.student_id := OLD.student_id;
  IF auth.uid() IS NOT DISTINCT FROM OLD.created_by THEN
    NEW.status := OLD.status;
    NEW.approved_at := OLD.approved_at;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
DROP TRIGGER IF EXISTS trg_pin_program_authoring_columns ON public.programs;
CREATE TRIGGER trg_pin_program_authoring_columns
  BEFORE UPDATE ON public.programs
  FOR EACH ROW EXECUTE FUNCTION public.pin_program_authoring_columns();

CREATE OR REPLACE FUNCTION public.approve_program(p_program_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_student_id   uuid;
  v_student_prof uuid;
  v_coach_id     uuid;
  v_prog_name    text;
  v_created      int := 0;
  v_functions_url text;
  v_service_key   text;
BEGIN
  SELECT p.student_id, p.name INTO v_student_id, v_prog_name
    FROM public.programs p WHERE p.id = p_program_id AND p.status = 'draft';
  IF v_student_id IS NULL THEN
    RETURN jsonb_build_object('approved', false);
  END IF;
  SELECT s.coach_id, s.profile_id INTO v_coach_id, v_student_prof
    FROM public.students s WHERE s.id = v_student_id;
  IF v_coach_id IS NULL OR v_coach_id <> auth.uid() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  INSERT INTO public.set_logs
    (exercise_slot_id, set_number, done, target_reps, target_duration_seconds, target_weight_kg, target_rest_seconds)
  SELECT es.id, gs.n, false, es.reps, es.duration_seconds, es.weight_kg, es.rest_seconds
    FROM public.exercise_slots es
    JOIN public.sessions s ON s.id = es.session_id
    JOIN public.weeks w    ON w.id = s.week_id
    CROSS JOIN LATERAL generate_series(1, GREATEST(es.sets, 1)) AS gs(n)
   WHERE w.program_id = p_program_id
     AND NOT EXISTS (SELECT 1 FROM public.set_logs sl WHERE sl.exercise_slot_id = es.id AND sl.set_number = gs.n);
  GET DIAGNOSTICS v_created = ROW_COUNT;

  UPDATE public.programs SET status = 'approved', approved_at = now(), submitted_at = NULL
   WHERE id = p_program_id;

  IF v_student_prof IS NOT NULL THEN
    INSERT INTO public.notifications (recipient_id, kind, payload)
    VALUES (v_student_prof, 'program_approved',
      jsonb_build_object('program_id', p_program_id, 'program_name', v_prog_name));
    BEGIN
      SELECT decrypted_secret INTO v_functions_url FROM vault.decrypted_secrets WHERE name = 'app_functions_url';
      SELECT decrypted_secret INTO v_service_key   FROM vault.decrypted_secrets WHERE name = 'app_service_role_key';
      IF v_functions_url IS NOT NULL AND v_service_key IS NOT NULL
         AND v_functions_url <> '' AND v_service_key <> '' THEN
        PERFORM net.http_post(
          url := v_functions_url || '/send-push',
          headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_service_key),
          body := jsonb_build_object('user_id', v_student_prof, 'payload', jsonb_build_object(
            'title', 'Program approved',
            'body',  'Your coach approved your program' || COALESCE(': ' || v_prog_name, ''),
            'tag',   'program-approved-' || p_program_id::text,
            'data',  jsonb_build_object('url', '/sl_app/#/student')))
        );
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'send-push fan-out (program approved) failed: %', SQLERRM;
    END;
  END IF;

  RETURN jsonb_build_object('approved', true, 'set_logs_created', v_created);
END;
$$;
REVOKE ALL ON FUNCTION public.approve_program(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.approve_program(uuid) TO authenticated;

-- Phase 3.4c: submit -> approve/send-back loop. See 2026_07_22_program_submit_notify.sql.
CREATE OR REPLACE FUNCTION public.notify_coach_on_program_submit()
RETURNS TRIGGER AS $$
DECLARE
  v_coach_id uuid; v_student_prof uuid; v_student_row_id uuid; v_student_name text;
  v_functions_url text; v_service_key text;
BEGIN
  -- Fire only on the NULL → set edge (blocks re-submit spam; re-fires after
  -- send_back_program resets submitted_at to NULL).
  IF NEW.status <> 'draft' OR NEW.submitted_at IS NULL
     OR OLD.submitted_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT s.coach_id, s.profile_id, s.id INTO v_coach_id, v_student_prof, v_student_row_id
    FROM public.students s WHERE s.id = NEW.student_id;
  IF v_coach_id IS NULL THEN RETURN NEW; END IF;
  SELECT p.full_name INTO v_student_name FROM public.profiles p WHERE p.id = v_student_prof;
  INSERT INTO public.notifications (recipient_id, kind, payload)
  VALUES (v_coach_id, 'program_submitted', jsonb_build_object(
    'program_id', NEW.id, 'program_name', NEW.name, 'student_profile_id', v_student_prof,
    'student_row_id', v_student_row_id, 'student_name', v_student_name));
  BEGIN
    SELECT decrypted_secret INTO v_functions_url FROM vault.decrypted_secrets WHERE name = 'app_functions_url';
    SELECT decrypted_secret INTO v_service_key   FROM vault.decrypted_secrets WHERE name = 'app_service_role_key';
    IF v_functions_url IS NOT NULL AND v_service_key IS NOT NULL AND v_functions_url <> '' AND v_service_key <> '' THEN
      PERFORM net.http_post(url := v_functions_url || '/send-push',
        headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_service_key),
        body := jsonb_build_object('user_id', v_coach_id, 'payload', jsonb_build_object(
          'title', 'Program submitted',
          'body', COALESCE(v_student_name,'Your athlete') || ' submitted a program for approval' || COALESCE(': ' || NEW.name, ''),
          'tag', 'program-submitted-' || NEW.id::text,
          'data', jsonb_build_object('url', '/sl_app/#/coach/students/' || COALESCE(v_student_row_id::text,'') || '/programming'))));
    END IF;
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'send-push (program submitted) failed: %', SQLERRM; END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
DROP TRIGGER IF EXISTS trg_notify_coach_on_program_submit ON public.programs;
CREATE TRIGGER trg_notify_coach_on_program_submit
  AFTER UPDATE ON public.programs FOR EACH ROW EXECUTE FUNCTION public.notify_coach_on_program_submit();

CREATE OR REPLACE FUNCTION public.send_back_program(p_program_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_student_id uuid; v_student_prof uuid; v_coach_id uuid; v_prog_name text;
  v_functions_url text; v_service_key text;
BEGIN
  SELECT p.student_id, p.name INTO v_student_id, v_prog_name
    FROM public.programs p WHERE p.id = p_program_id AND p.status = 'draft' AND p.submitted_at IS NOT NULL;
  IF v_student_id IS NULL THEN RETURN jsonb_build_object('sent_back', false); END IF;
  SELECT s.coach_id, s.profile_id INTO v_coach_id, v_student_prof FROM public.students s WHERE s.id = v_student_id;
  IF v_coach_id IS NULL OR v_coach_id <> auth.uid() THEN RAISE EXCEPTION 'not authorized'; END IF;
  UPDATE public.programs SET submitted_at = NULL WHERE id = p_program_id;
  IF v_student_prof IS NOT NULL THEN
    INSERT INTO public.notifications (recipient_id, kind, payload)
    VALUES (v_student_prof, 'program_sent_back', jsonb_build_object('program_id', p_program_id, 'program_name', v_prog_name));
    BEGIN
      SELECT decrypted_secret INTO v_functions_url FROM vault.decrypted_secrets WHERE name = 'app_functions_url';
      SELECT decrypted_secret INTO v_service_key   FROM vault.decrypted_secrets WHERE name = 'app_service_role_key';
      IF v_functions_url IS NOT NULL AND v_service_key IS NOT NULL AND v_functions_url <> '' AND v_service_key <> '' THEN
        PERFORM net.http_post(url := v_functions_url || '/send-push',
          headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_service_key),
          body := jsonb_build_object('user_id', v_student_prof, 'payload', jsonb_build_object(
            'title', 'Program sent back',
            'body', 'Your coach sent your program back for changes' || COALESCE(': ' || v_prog_name, ''),
            'tag', 'program-sent-back-' || p_program_id::text,
            'data', jsonb_build_object('url', '/sl_app/#/student/author'))));
      END IF;
    EXCEPTION WHEN OTHERS THEN RAISE WARNING 'send-push (program sent back) failed: %', SQLERRM; END;
  END IF;
  RETURN jsonb_build_object('sent_back', true);
END;
$$;
REVOKE ALL ON FUNCTION public.send_back_program(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.send_back_program(uuid) TO authenticated;

-- Phase 3.4d — offline authoring: idempotent whole-tree upsert. SECURITY
-- INVOKER (rides the 3.4a own-draft RLS). Children DELETE-then-reINSERT
-- (cascade), safe because a draft carries no set_logs/comments/deviations.
-- See 2026_07_24_save_draft_tree.sql for the full rationale.
CREATE OR REPLACE FUNCTION public.save_draft_tree(p_tree jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_student   uuid;
  v_pid       uuid        := (p_tree->'program'->>'id')::uuid;
  v_name      text        := COALESCE(NULLIF(trim(p_tree->'program'->>'name'), ''), 'My program');
  v_submitted timestamptz := NULLIF(p_tree->'program'->>'submitted_at','')::timestamptz;
  v_existing  text;
  v_bad       uuid;
  v_weeks int := 0; v_sessions int := 0; v_slots int := 0;
BEGIN
  IF v_pid IS NULL THEN RAISE EXCEPTION 'save_draft_tree: program id required'; END IF;
  SELECT id INTO v_student FROM public.students WHERE profile_id = auth.uid();
  IF v_student IS NULL THEN RAISE EXCEPTION 'save_draft_tree: no student profile'; END IF;

  SELECT status INTO v_existing FROM public.programs WHERE id = v_pid;
  IF v_existing IS NOT NULL AND v_existing <> 'draft' THEN
    RAISE EXCEPTION 'draft_not_editable' USING ERRCODE = 'P0001', DETAIL = 'program is no longer a draft';
  END IF;

  SELECT (s->>'exercise_id')::uuid INTO v_bad
    FROM jsonb_array_elements(COALESCE(p_tree->'slots','[]'::jsonb)) s
   WHERE (s->>'exercise_id')::uuid NOT IN (
     SELECT el.id FROM public.exercise_library el
     JOIN public.students st ON st.coach_id = el.coach_id
     WHERE st.profile_id = auth.uid())
   LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'exercise_unavailable' USING ERRCODE = 'P0001', DETAIL = v_bad::text;
  END IF;

  INSERT INTO public.programs (id, student_id, created_by, status, is_active, name, sort_order)
  VALUES (v_pid, v_student, auth.uid(), 'draft', false, v_name, 0)
  ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

  DELETE FROM public.weeks WHERE program_id = v_pid;

  INSERT INTO public.weeks (id, program_id, week_number, label)
  SELECT (w->>'id')::uuid, v_pid, (w->>'week_number')::int, NULLIF(w->>'label','')
    FROM jsonb_array_elements(COALESCE(p_tree->'weeks','[]'::jsonb)) w;
  GET DIAGNOSTICS v_weeks = ROW_COUNT;

  INSERT INTO public.sessions (id, week_id, title, day_number, sort_order)
  SELECT (s->>'id')::uuid, (s->>'week_id')::uuid,
         COALESCE(NULLIF(s->>'title',''),'Session'),
         COALESCE((s->>'day_number')::int,1),
         COALESCE((s->>'sort_order')::int,0)
    FROM jsonb_array_elements(COALESCE(p_tree->'sessions','[]'::jsonb)) s;
  GET DIAGNOSTICS v_sessions = ROW_COUNT;

  INSERT INTO public.exercise_slots
    (id, session_id, exercise_id, sets, reps, weight_kg, duration_seconds, rest_seconds, sort_order)
  SELECT (s->>'id')::uuid, (s->>'session_id')::uuid, (s->>'exercise_id')::uuid,
         COALESCE((s->>'sets')::int,3),
         COALESCE((s->>'reps')::int, CASE WHEN (s->>'duration_seconds') IS NULL THEN 1 ELSE NULL END),
         (s->>'weight_kg')::numeric,
         (s->>'duration_seconds')::int,
         (s->>'rest_seconds')::int,
         COALESCE((s->>'sort_order')::int,0)
    FROM jsonb_array_elements(COALESCE(p_tree->'slots','[]'::jsonb)) s;
  GET DIAGNOSTICS v_slots = ROW_COUNT;

  IF v_submitted IS NOT NULL THEN
    UPDATE public.programs SET submitted_at = v_submitted WHERE id = v_pid AND submitted_at IS NULL;
  END IF;

  RETURN jsonb_build_object('program_id', v_pid, 'weeks', v_weeks, 'sessions', v_sessions, 'slots', v_slots);
END;
$$;
REVOKE ALL ON FUNCTION public.save_draft_tree(jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.save_draft_tree(jsonb) TO authenticated;

-- Trigger: notify the student when their coach attaches a feedback message
-- to a reviewed session. Fires only when messages.session_id IS NOT NULL.
CREATE OR REPLACE FUNCTION public.notify_student_on_session_feedback()
RETURNS TRIGGER AS $$
DECLARE
  v_coach_name    text;
  v_session_title text;
BEGIN
  IF NEW.session_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT p.full_name INTO v_coach_name
    FROM public.profiles p
   WHERE p.id = NEW.sender_id;

  SELECT COALESCE(NULLIF(BTRIM(s.title), ''), 'Session') INTO v_session_title
    FROM public.sessions s
   WHERE s.id = NEW.session_id;

  -- Sending feedback also marks the session reviewed (idempotent).
  UPDATE public.sessions
     SET reviewed_at = NEW.created_at
   WHERE id = NEW.session_id
     AND reviewed_at IS NULL;

  INSERT INTO public.notifications (recipient_id, kind, payload)
  VALUES (
    NEW.recipient_id,
    'session_feedback',
    jsonb_build_object(
      'session_id',       NEW.session_id,
      'session_title',    v_session_title,
      'coach_profile_id', NEW.sender_id,
      'coach_name',       v_coach_name,
      'message_id',       NEW.id
    )
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_notify_student_on_session_feedback ON public.messages;
CREATE TRIGGER trg_notify_student_on_session_feedback
  AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.notify_student_on_session_feedback();

-- Realtime broadcast (REPLICA IDENTITY FULL so UPDATEs carry the old row).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'notifications'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
    END IF;
  END IF;
END $$;

ALTER TABLE public.notifications REPLICA IDENTITY FULL;
-- ============================================================
-- Web Push: rest-timer "Rest done" notification (PWA fallback for the
-- iOS Dynamic Island / Live Activity ask, which is unavailable to web).
--
-- Two tables:
--
-- 1. push_subscriptions — one row per device/browser the user has opted
--    into push on. The fields mirror the Web Push spec (endpoint, p256dh,
--    auth). Owned by the user; CRUD via RLS.
--
-- 2. scheduled_pushes — one row per pending notification to fire at
--    fire_at. The client inserts a row when a rest timer starts and
--    sets canceled_at when the timer is cleared (set undone, new set
--    started, or session left). The dispatch-rest-push Edge Function
--    reads with the service role, sleeps until fire_at, double-checks
--    canceled_at, and delivers via the web-push protocol.
--
-- There are no triggers on these tables. RLS is the only client-side
-- guardrail; the Edge Function uses the service role and bypasses RLS.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  endpoint      text NOT NULL UNIQUE,
  p256dh        text NOT NULL,
  auth          text NOT NULL,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx
  ON public.push_subscriptions (user_id);

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Read own push subscriptions" ON public.push_subscriptions;
CREATE POLICY "Read own push subscriptions"
  ON public.push_subscriptions FOR SELECT
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Insert own push subscriptions" ON public.push_subscriptions;
CREATE POLICY "Insert own push subscriptions"
  ON public.push_subscriptions FOR INSERT
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Update own push subscriptions" ON public.push_subscriptions;
CREATE POLICY "Update own push subscriptions"
  ON public.push_subscriptions FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Delete own push subscriptions" ON public.push_subscriptions;
CREATE POLICY "Delete own push subscriptions"
  ON public.push_subscriptions FOR DELETE
  USING (user_id = auth.uid());


CREATE TABLE IF NOT EXISTS public.scheduled_pushes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  fire_at       timestamptz NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'canceled', 'failed')),
  canceled_at   timestamptz,
  sent_at       timestamptz,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scheduled_pushes_user_status_idx
  ON public.scheduled_pushes (user_id, status, fire_at);

ALTER TABLE public.scheduled_pushes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Read own scheduled pushes" ON public.scheduled_pushes;
CREATE POLICY "Read own scheduled pushes"
  ON public.scheduled_pushes FOR SELECT
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Insert own scheduled pushes" ON public.scheduled_pushes;
CREATE POLICY "Insert own scheduled pushes"
  ON public.scheduled_pushes FOR INSERT
  WITH CHECK (user_id = auth.uid());

-- Update is intentionally narrow on the client side: only the row's owner
-- can mark it canceled. The Edge Function (service role) is the only
-- writer for sent_at / status='sent'. We don't bother with a column-pin
-- trigger because the worst a malicious client can do to their own row
-- is suppress their own notification.
DROP POLICY IF EXISTS "Cancel own scheduled pushes" ON public.scheduled_pushes;
CREATE POLICY "Cancel own scheduled pushes"
  ON public.scheduled_pushes FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Owner may delete their own row (e.g. opportunistic cleanup after expiry).
DROP POLICY IF EXISTS "Delete own scheduled pushes" ON public.scheduled_pushes;
CREATE POLICY "Delete own scheduled pushes"
  ON public.scheduled_pushes FOR DELETE
  USING (user_id = auth.uid());
-- ============================================================
-- Coach-feedback Web Push fan-out.
--
-- The `notify_student_on_session_feedback` trigger already runs on
-- AFTER INSERT of a coach feedback message (see 2026_04_30_notifications.sql
-- and the unique partial index on `messages.session_id`). It inserts an
-- in-app notification row and stamps `sessions.reviewed_at`. This
-- migration extends it to also fire a Web Push to the student's
-- registered devices via the `send-push` Edge Function.
--
-- pg_net is async: the HTTP call is enqueued and the trigger returns
-- immediately. If the function URL / service-role key Vault secrets
-- aren't set, the push fan-out is skipped silently — the in-app
-- notification path always runs. The block is also wrapped in EXCEPTION
-- so a transient HTTP failure can never roll back the message INSERT.
--
-- Required project secrets (run once via psql or `supabase db query`):
--
--   SELECT vault.create_secret(
--     'https://<project-ref>.supabase.co/functions/v1',
--     'app_functions_url'
--   );
--   SELECT vault.create_secret(
--     '<shared-bearer-secret>',
--     'app_service_role_key'
--   );
--
-- The value stored as `app_service_role_key` is sent verbatim as the
-- `Authorization: Bearer <…>` header to send-push, which compares it
-- to its `INTERNAL_BEARER` env var (set via `supabase secrets set
-- INTERNAL_BEARER=<…>`). The two must be the same string. Any opaque
-- secret works; the legacy service-role JWT is convenient because
-- it's already secret. We avoid SUPABASE_SERVICE_ROLE_KEY for this
-- because Supabase auto-injects an `sb_secret_*` key whose full value
-- isn't retrievable outside the dashboard, so the two ends would
-- drift on newer projects.
--
-- Rotate with:
--   UPDATE vault.secrets SET secret = '<new>'
--    WHERE name = 'app_service_role_key';
--   supabase secrets set INTERNAL_BEARER='<new>'
--
-- Vault stores the value encrypted at rest; only SECURITY DEFINER
-- functions running as `postgres` can read the decrypted view.
-- ============================================================

-- pg_net + vault ship with Supabase but only enable on demand.
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS supabase_vault;

CREATE OR REPLACE FUNCTION public.notify_student_on_session_feedback()
RETURNS TRIGGER AS $$
DECLARE
  v_coach_name      text;
  v_session_title   text;
  v_functions_url   text;
  v_service_key     text;
  v_body_preview    text;
BEGIN
  IF NEW.session_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT p.full_name INTO v_coach_name
    FROM public.profiles p
   WHERE p.id = NEW.sender_id;

  SELECT COALESCE(NULLIF(BTRIM(s.title), ''), 'Session') INTO v_session_title
    FROM public.sessions s
   WHERE s.id = NEW.session_id;

  -- Sending feedback also marks the session reviewed (idempotent).
  UPDATE public.sessions
     SET reviewed_at = NEW.created_at
   WHERE id = NEW.session_id
     AND reviewed_at IS NULL;

  -- In-app notification (existing behavior, unchanged).
  INSERT INTO public.notifications (recipient_id, kind, payload)
  VALUES (
    NEW.recipient_id,
    'session_feedback',
    jsonb_build_object(
      'session_id',       NEW.session_id,
      'session_title',    v_session_title,
      'coach_profile_id', NEW.sender_id,
      'coach_name',       v_coach_name,
      'message_id',       NEW.id
    )
  );

  -- Web Push fan-out (best-effort). Skips silently when the Vault
  -- secrets aren't configured so this migration can be applied before
  -- the project ref and service-role key are stashed, and so a project
  -- that's deliberately not using push isn't forced to.
  BEGIN
    SELECT decrypted_secret INTO v_functions_url
      FROM vault.decrypted_secrets
     WHERE name = 'app_functions_url';
    SELECT decrypted_secret INTO v_service_key
      FROM vault.decrypted_secrets
     WHERE name = 'app_service_role_key';

    IF v_functions_url IS NOT NULL
       AND v_service_key IS NOT NULL
       AND v_functions_url <> ''
       AND v_service_key <> ''
    THEN
      -- Trim to 200 chars so the encrypted push payload stays under the
      -- 4 KB Web Push limit. iOS only shows ~200 chars on the lock screen.
      v_body_preview := LEFT(BTRIM(NEW.body), 200);

      PERFORM net.http_post(
        url := v_functions_url || '/send-push',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || v_service_key
        ),
        body := jsonb_build_object(
          'user_id', NEW.recipient_id,
          'payload', jsonb_build_object(
            'title', 'Feedback from ' || COALESCE(v_coach_name, 'your coach'),
            'body',  COALESCE(NULLIF(v_body_preview, ''), 'Tap to read your coach''s feedback.'),
            'tag',   'feedback-' || NEW.id::text,
            'data',  jsonb_build_object(
              'url', '/sl_app/#/student/session/' || NEW.session_id::text
            )
          )
        )
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Push delivery must never break the in-app notification path. The
    -- coach's feedback INSERT succeeded; the bell will still light up.
    RAISE WARNING 'send-push fan-out failed: %', SQLERRM;
  END;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger already exists from 2026_04_30_notifications.sql; the function
-- replacement above takes effect without re-creating the trigger.

-- ============================================================
-- TRIGGER: Web Push for ordinary chat messages (2026_07_12)
-- Chat rows (session_id IS NULL) fire a best-effort push to the
-- recipient; no notifications row (the Messages badge is the in-app
-- surface). Tag 'chat-<sender>' collapses a burst into one entry.
-- ============================================================
CREATE OR REPLACE FUNCTION public.notify_recipient_on_chat_message()
RETURNS TRIGGER AS $$
DECLARE
  v_sender_name     text;
  v_sender_role     text;
  v_functions_url   text;
  v_service_key     text;
  v_body_preview    text;
BEGIN
  -- Feedback messages are handled by notify_student_on_session_feedback.
  IF NEW.session_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  BEGIN
    SELECT decrypted_secret INTO v_functions_url
      FROM vault.decrypted_secrets
     WHERE name = 'app_functions_url';
    SELECT decrypted_secret INTO v_service_key
      FROM vault.decrypted_secrets
     WHERE name = 'app_service_role_key';

    IF v_functions_url IS NOT NULL
       AND v_service_key IS NOT NULL
       AND v_functions_url <> ''
       AND v_service_key <> ''
    THEN
      -- One lookup covers both ends: the recipient's surface is the
      -- opposite of the sender's role, and the no-name fallback names the
      -- sender's role (blank full_name is the default after signup).
      SELECT p.full_name, p.role INTO v_sender_name, v_sender_role
        FROM public.profiles p
       WHERE p.id = NEW.sender_id;

      v_body_preview := LEFT(BTRIM(NEW.body), 200);

      PERFORM net.http_post(
        url := v_functions_url || '/send-push',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || v_service_key
        ),
        body := jsonb_build_object(
          'user_id', NEW.recipient_id,
          'payload', jsonb_build_object(
            'title', 'Message from ' || COALESCE(
                       NULLIF(BTRIM(v_sender_name), ''),
                       CASE WHEN v_sender_role = 'coach' THEN 'your coach' ELSE 'your student' END
                     ),
            'body',  COALESCE(NULLIF(v_body_preview, ''), 'Tap to read.'),
            'tag',   'chat-' || NEW.sender_id::text,
            'data',  jsonb_build_object(
              'url', '/sl_app/#/'
                     || CASE WHEN v_sender_role = 'coach' THEN 'student' ELSE 'coach' END
                     || '/messages'
            )
          )
        )
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Push delivery must never break the message INSERT; the realtime
    -- badge still updates for open tabs.
    RAISE WARNING 'chat push fan-out failed: %', SQLERRM;
  END;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_chat_message_push ON public.messages;
CREATE TRIGGER on_chat_message_push
  AFTER INSERT ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_recipient_on_chat_message();

-- ============================================================
-- TRIGGER: programs are undeletable while logged sets exist (2026_07_13)
-- Hard delete is only for scaffolding; real training history can only be
-- trashed (programs.deleted_at) and restored. Fires on cascades too, so a
-- students-row delete can't wipe logged history either. For a deliberate
-- full erasure: drop trigger, delete, recreate.
-- ============================================================
CREATE OR REPLACE FUNCTION public.block_program_delete_with_logged_sets()
RETURNS trigger AS $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count
    FROM public.set_logs sl
    JOIN public.exercise_slots es ON es.id = sl.exercise_slot_id
    JOIN public.sessions s        ON s.id = es.session_id
    JOIN public.weeks w           ON w.id = s.week_id
   WHERE w.program_id = OLD.id
     AND (
       sl.done OR sl.failed OR sl.skipped
       OR sl.rpe IS NOT NULL
       OR sl.actual_reps IS NOT NULL
       OR sl.actual_weight_kg IS NOT NULL
     );
  IF v_count > 0 THEN
    RAISE EXCEPTION
      'program % still has % logged set(s) — move it to the trash instead of deleting',
      OLD.id, v_count;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS block_program_delete_with_logged_sets ON public.programs;
CREATE TRIGGER block_program_delete_with_logged_sets
  BEFORE DELETE ON public.programs
  FOR EACH ROW
  EXECUTE FUNCTION public.block_program_delete_with_logged_sets();

-- Same guard at week + session level: WeekView deletes those directly, and
-- the cascade would otherwise wipe logged set_logs without touching the
-- program row. Coaches archive (sessions.archived_at) instead.
CREATE OR REPLACE FUNCTION public.block_week_delete_with_logged_sets()
RETURNS trigger AS $$
DECLARE v_count int;
BEGIN
  SELECT count(*) INTO v_count
    FROM public.set_logs sl
    JOIN public.exercise_slots es ON es.id = sl.exercise_slot_id
    JOIN public.sessions s        ON s.id = es.session_id
   WHERE s.week_id = OLD.id
     AND (sl.done OR sl.failed OR sl.skipped
          OR sl.rpe IS NOT NULL OR sl.actual_reps IS NOT NULL
          OR sl.actual_weight_kg IS NOT NULL);
  IF v_count > 0 THEN
    RAISE EXCEPTION 'week % still has % logged set(s) — archive it instead of deleting', OLD.id, v_count;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS block_week_delete_with_logged_sets ON public.weeks;
CREATE TRIGGER block_week_delete_with_logged_sets
  BEFORE DELETE ON public.weeks
  FOR EACH ROW
  EXECUTE FUNCTION public.block_week_delete_with_logged_sets();

CREATE OR REPLACE FUNCTION public.block_session_delete_with_logged_sets()
RETURNS trigger AS $$
DECLARE v_count int;
BEGIN
  SELECT count(*) INTO v_count
    FROM public.set_logs sl
    JOIN public.exercise_slots es ON es.id = sl.exercise_slot_id
   WHERE es.session_id = OLD.id
     AND (sl.done OR sl.failed OR sl.skipped
          OR sl.rpe IS NOT NULL OR sl.actual_reps IS NOT NULL
          OR sl.actual_weight_kg IS NOT NULL);
  IF v_count > 0 THEN
    RAISE EXCEPTION 'session % still has % logged set(s) — archive it instead of deleting', OLD.id, v_count;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS block_session_delete_with_logged_sets ON public.sessions;
CREATE TRIGGER block_session_delete_with_logged_sets
  BEFORE DELETE ON public.sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.block_session_delete_with_logged_sets();

-- ============================================================
-- Client error telemetry (2026_07_13)
-- Insert-only per authenticated user (own errors); coach-only read for
-- in-app triage. No UPDATE/DELETE — append-only. Prune with:
--   DELETE FROM public.client_errors WHERE created_at < now() - interval '90 days';
-- ============================================================
CREATE TABLE public.client_errors (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  role        text,
  message     text NOT NULL CHECK (char_length(message) <= 2000),
  stack       text CHECK (stack IS NULL OR char_length(stack) <= 8000),
  url         text CHECK (url IS NULL OR char_length(url) <= 500),
  user_agent  text CHECK (user_agent IS NULL OR char_length(user_agent) <= 500),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX client_errors_created_idx
  ON public.client_errors (created_at DESC);

ALTER TABLE public.client_errors ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users insert own client errors"
  ON public.client_errors FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND (
      role IS NULL
      OR role = (SELECT p.role FROM public.profiles p WHERE p.id = auth.uid())
    )
  );

CREATE POLICY "Coaches read client errors"
  ON public.client_errors FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
       WHERE p.id = auth.uid() AND p.role = 'coach'
    )
  );

-- ============================================================
-- Bodyweight logs (2026_07_14)
-- One row per student per day; feeds relative-strength on the PR/e1RM
-- surface. Student owns the series; coach reads their students'.
-- ============================================================
CREATE TABLE public.bodyweight_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id  uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  weight_kg   numeric(5,2) NOT NULL CHECK (weight_kg > 0 AND weight_kg < 500),
  logged_on   date NOT NULL DEFAULT current_date,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (student_id, logged_on)
);

CREATE INDEX bodyweight_logs_student_idx
  ON public.bodyweight_logs (student_id, logged_on DESC);

ALTER TABLE public.bodyweight_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Students manage own bodyweight"
  ON public.bodyweight_logs FOR ALL
  USING (student_id = auth.uid())
  WITH CHECK (student_id = auth.uid());

CREATE POLICY "Coaches read their students bodyweight"
  ON public.bodyweight_logs FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.students s
      WHERE s.profile_id = bodyweight_logs.student_id AND s.coach_id = auth.uid()
    )
  );
