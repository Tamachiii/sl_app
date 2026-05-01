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
  created_at  timestamptz NOT NULL DEFAULT now()
);

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
  day_number     int  NOT NULL,
  title          text,
  sort_order     int  NOT NULL DEFAULT 0,
  scheduled_date date,
  archived_at    timestamptz,
  reviewed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sessions_reviewed_idx
  ON public.sessions (reviewed_at) WHERE reviewed_at IS NOT NULL;

-- Exercise library (shared per coach)
CREATE TABLE public.exercise_library (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id      uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  name          text NOT NULL,
  type          exercise_type NOT NULL,
  difficulty    int  NOT NULL CHECK (difficulty BETWEEN 1 AND 3),
  volume_weight numeric(4,2) NOT NULL DEFAULT 1.0,
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
  CONSTRAINT set_logs_no_rpe_when_failed CHECK (NOT (failed AND rpe IS NOT NULL))
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
CREATE OR REPLACE FUNCTION public.program_active_for_session(sess_id uuid)
RETURNS boolean AS $$
  SELECT p.is_active
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
-- slots; students own their actuals (done, rpe, weight_kg). The DB grants
-- both sides FOR ALL on the same table — column separation is enforced by
-- client discipline (coach UI never writes actuals; student UI never writes
-- targets). If this proves insufficient we can split actuals to a child
-- table.
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

CREATE POLICY "Students delete own set logs"
  ON public.set_logs FOR DELETE
  USING (
    public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND public.program_active_for_slot(exercise_slot_id) = true
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
-- TRIGGER: auto-create profile on signup
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, role, full_name)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'role', 'student'),
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

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_notify_coach_on_session_confirm ON public.session_confirmations;
CREATE TRIGGER trg_notify_coach_on_session_confirm
  AFTER INSERT ON public.session_confirmations
  FOR EACH ROW EXECUTE FUNCTION public.notify_coach_on_session_confirm();

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
