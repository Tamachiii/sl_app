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

-- Programs (top-level container per student)
CREATE TABLE public.programs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id  uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  name        text NOT NULL,
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
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  week_id     uuid NOT NULL REFERENCES public.weeks(id) ON DELETE CASCADE,
  day_number  int  NOT NULL,
  title       text,
  sort_order  int  NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

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
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    uuid NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  exercise_id   uuid NOT NULL REFERENCES public.exercise_library(id) ON DELETE RESTRICT,
  sets          int  NOT NULL CHECK (sets > 0),
  reps          int  NOT NULL CHECK (reps > 0),
  weight_kg     numeric(6,2),
  sort_order    int  NOT NULL DEFAULT 0,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Set logs (student fills these in)
CREATE TABLE public.set_logs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exercise_slot_id uuid NOT NULL REFERENCES public.exercise_slots(id) ON DELETE CASCADE,
  set_number       int  NOT NULL CHECK (set_number > 0),
  done             boolean NOT NULL DEFAULT false,
  rpe              int CHECK (rpe IS NULL OR (rpe BETWEEN 1 AND 10)),
  logged_at        timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE(exercise_slot_id, set_number)
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX idx_students_coach_id ON public.students(coach_id);
CREATE INDEX idx_students_profile_id ON public.students(profile_id);
CREATE INDEX idx_programs_student_id ON public.programs(student_id);
CREATE INDEX idx_weeks_program_id ON public.weeks(program_id);
CREATE INDEX idx_sessions_week_id ON public.sessions(week_id);
CREATE INDEX idx_exercise_slots_session_id ON public.exercise_slots(session_id);
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
CREATE POLICY "Coaches read set logs"
  ON public.set_logs FOR SELECT
  USING (
    public.student_profile_for_slot(exercise_slot_id) IN (
      SELECT profile_id FROM public.students WHERE coach_id = auth.uid()
    )
  );

CREATE POLICY "Students manage own set logs"
  ON public.set_logs FOR ALL
  USING (
    public.student_profile_for_slot(exercise_slot_id) = auth.uid()
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
