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
-- One row per account, written by handle_new_user: the role is 'student' and
-- the name is never empty. A coach is made by the owner of the database —
-- no signed-in user changes a role (profiles_pin_immutable_columns).
CREATE TABLE public.profiles (
  id          uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('coach', 'student')),
  full_name   text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Students (links a student profile to a coach)
-- The root of the authorization model: every "Coaches …" policy below asks
-- this table who coaches whom. No signed-in user inserts or deletes a row,
-- and none moves a link; what a row may say is held by trg_check_students_link
-- (section THE COACH ↔ ATHLETE LINK, 2026_10_11_05).
--
-- The two ends are not deleted alike (2026_10_13_10). The ATHLETE's account
-- takes its own link with it, and through it their programs: CASCADE. A
-- COACH's account does not take other people's training with it: RESTRICT —
-- their athletes are moved first, with public.transfer_student().
CREATE TABLE public.students (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id  uuid NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE CASCADE,
  coach_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
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
  -- When the block was last switched off: is_active went from true to false
  -- (2026_10_13_17, review P55). NULL for the block being trained and for one
  -- that was never active. Written by trg_stamp_program_deactivated_at and by
  -- nothing else that carries a user id; read by program_active_for_session,
  -- which keeps the block open for its athlete for 72 hours from that time.
  deactivated_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT programs_draft_not_active CHECK (NOT (status = 'draft' AND is_active))
);

COMMENT ON COLUMN public.programs.deactivated_at IS
  'When is_active last went from true to false; NULL while the block is the '
  'active one, and for a block that never was. Written by '
  'trg_stamp_program_deactivated_at: a request that carries a user id cannot '
  'write it. For 72 hours from that time the athlete of the block may still '
  'write in it (program_active_for_session), so that training logged offline '
  'is saved after a switch of block (2026_10_13_17).';
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
  -- sessions_day_number_weekday holds it to 1..7 (2026_10_16_21, review B12).
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
  -- copy (2026_07_13). Not deferrable: a renumbering parks every session,
  -- then places it — reorder_sessions() and move_session() do, in one
  -- statement each.
  CONSTRAINT sessions_week_sort_order_unique UNIQUE (week_id, sort_order),
  -- A weekday, or none (2026_10_16_21, review B12). The values that were
  -- not one — positions written by the athlete's draft builder before
  -- 2026_08_22 — were cleared by that migration, with every weekday of a
  -- block an athlete wrote: the builder has no weekday control.
  CONSTRAINT sessions_day_number_weekday CHECK (day_number IS NULL OR day_number BETWEEN 1 AND 7)
);

CREATE INDEX IF NOT EXISTS sessions_reviewed_idx
  ON public.sessions (reviewed_at) WHERE reviewed_at IS NOT NULL;

COMMENT ON COLUMN public.sessions.sort_order IS
  'Position of the session within its week, 0-based and contiguous. THE source '
  'of order for both the coach sheet and the athlete queue since 2026_08_22 — '
  'day_number and scheduled_date are advisory hints that no longer sort. '
  'Renumbering must be a two-pass park-then-place: '
  'sessions_week_sort_order_unique is UNIQUE and not deferrable.';

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
  -- An exercise that a slot, a swap or a goal names cannot be deleted (three
  -- RESTRICT foreign keys): it is archived instead (2026_10_13_10). Written by
  -- its coach through "Coaches manage own library"; read by their athletes
  -- like any other column. Nothing below refuses an archived exercise — a
  -- slot that holds one is copied, a goal on one is still logged against:
  -- leaving it out of the pickers is the client's rule.
  archived_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN public.exercise_library.archived_at IS
  'When its coach archived the exercise; NULL = in use. An archived exercise '
  'is left out of the pickers and stays readable for the slots, swaps, goals '
  'and history that name it. Nothing in the database refuses one: hiding it '
  'is the client''s rule (2026_10_13_10).';

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
  -- From 1 to 10 in steps of 0.5 (2026_10_16_21, review L34):
  -- set_logs_rpe_check and set_logs_rpe_half_step. numeric(3,1) rounds what
  -- is sent to one decimal before the rules are asked.
  rpe                      numeric(3,1) CHECK (rpe IS NULL OR (rpe BETWEEN 1 AND 10)),
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
  CONSTRAINT set_logs_rpe_half_step CHECK (rpe IS NULL OR rpe * 2 = trunc(rpe * 2)),
  CONSTRAINT set_logs_actual_reps_nonneg CHECK (actual_reps IS NULL OR actual_reps >= 0),
  CONSTRAINT set_logs_actual_weight_nonneg CHECK (actual_weight_kg IS NULL OR actual_weight_kg >= 0),
  CONSTRAINT set_logs_skipped_not_resolved CHECK (NOT (skipped AND (done OR failed)))
);

-- ============================================================
-- INDEXES
-- ============================================================
-- No index repeats a unique key (2026_10_16_24, review L28): students.profile_id,
-- weeks.program_id, sessions.week_id and set_logs.exercise_slot_id are the
-- first column of a unique key of their table, which a lookup of that column
-- reads. A foreign key gets an index that starts with its column — its own,
-- or such a key: deleting the row it points at reads the table otherwise.
CREATE INDEX idx_students_coach_id ON public.students(coach_id);
CREATE INDEX idx_programs_student_id ON public.programs(student_id);
CREATE UNIQUE INDEX programs_one_active_per_student
  ON public.programs(student_id) WHERE is_active;
CREATE INDEX idx_sessions_scheduled_date ON public.sessions(scheduled_date);
CREATE INDEX idx_sessions_archived_at ON public.sessions(archived_at);
CREATE INDEX idx_exercise_slots_session_id ON public.exercise_slots(session_id);
CREATE INDEX idx_exercise_slots_superset_group ON public.exercise_slots(superset_group);
-- The foreign key to the library (2026_10_16_24): also what
-- exercise_readable_through_use() reads.
CREATE INDEX exercise_slots_exercise_idx ON public.exercise_slots (exercise_id);
CREATE INDEX idx_exercise_library_coach_id ON public.exercise_library(coach_id);

-- ============================================================
-- HELPER FUNCTIONS
--
-- Two rules for every function of this file (2026_10_11_03):
--   * it carries `SET search_path = public, pg_temp` — CREATE OR REPLACE drops
--     the clause when the new text does not repeat it;
--   * who may execute it is said in ONE place, the FUNCTION PRIVILEGES block
--     at the end of this file. A helper a policy calls must be listed there.
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
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

-- May the athlete of this session still write in its program?
-- Drives the student-side write gate on past-program sessions: once a coach
-- swaps blocks, history becomes read-only — 72 hours later (2026_10_13_17,
-- review P55). Yes while the program is the active block, and for 72 hours
-- after it was switched off (programs.deactivated_at): the app queues what an
-- athlete logs without a connection, and a workout trained while the coach
-- activated the next block is replayed against a block that is no longer the
-- active one. Without the window every set of it was refused, and lost.
--
-- The name says "active" and every caller means "open for its athlete": the
-- policies of set_logs, slot_comments, slot_deviations, set_log_videos,
-- session_confirmations and of the files of set-videos, and ensure_set_logs.
-- The window is theirs through this one function; the app goes on showing a
-- block that is not active as read-only (programs.is_active).
--
-- "Active for writes" folds in deleted_at (2026_07_13): a trashed program is
-- never writable regardless of is_active — and of the window — so the trash
-- flag and the write gate can't drift apart. A draft is never written in
-- either: it cannot be active (programs_draft_not_active), and the window is
-- for an approved program.
--
-- true or false for a session that exists, NULL for one that does not — as
-- before: a caller asks `= true` or `IS NOT TRUE`.
--
-- The 72 hours are written here and nowhere else in the database.
CREATE OR REPLACE FUNCTION public.program_active_for_session(sess_id uuid)
RETURNS boolean AS $$
  SELECT p.deleted_at IS NULL
         AND (
           p.is_active
           OR (
             p.status = 'approved'
             AND p.deactivated_at IS NOT NULL
             AND p.deactivated_at > now() - interval '72 hours'
           )
         )
  FROM public.sessions sess
  JOIN public.weeks w    ON w.id = sess.week_id
  JOIN public.programs p ON p.id = w.program_id
  WHERE sess.id = sess_id
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.program_active_for_slot(slot_id uuid)
RETURNS boolean AS $$
  SELECT public.program_active_for_session(es.session_id)
  FROM public.exercise_slots es
  WHERE es.id = slot_id
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

-- When a block was switched off (2026_10_13_17). programs.deactivated_at is
-- the time is_active last went from true to false, and it is the trigger's:
--   switched off by this statement      now() — whoever writes, and however:
--                                       the two UPDATEs of the app deployed
--                                       before wave 2, activate_program(), a
--                                       block that goes to the trash while it
--                                       is the active one
--   active (switched on, inserted       NULL — the block being trained was
--   active, or active all along)        not switched off
--   anything else, with a user id       what it was (NULL for a new row): the
--                                       column is not a signed-in user's.
--                                       Silently, like the other pins — the
--                                       rest of the write is saved
--   anything else, without a user id    what the statement says: the owner of
--                                       the database closes a window, or
--                                       opens one again, by hand (page 17 of
--                                       docs/runbook/migrations/)
--
-- Why a signed-in user may not write it. program_active_for_session reads it
-- as "the athlete may still write here". The author of a draft updates the
-- row of their draft ("Students update own draft programs"): a time written
-- there — one far in the future — would stay with the program once the coach
-- approves it, and keep it open for its athlete for good.
--
-- BEFORE triggers fire in the order of their names: on an UPDATE this one
-- comes after trg_pin_program_authoring_columns. Neither reads a column the
-- other writes.
CREATE OR REPLACE FUNCTION public.stamp_program_deactivated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.is_active OR auth.uid() IS NOT NULL THEN
      NEW.deactivated_at := NULL;
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.is_active AND NOT NEW.is_active THEN
    NEW.deactivated_at := now();
  ELSIF NEW.is_active THEN
    NEW.deactivated_at := NULL;
  ELSIF auth.uid() IS NOT NULL THEN
    NEW.deactivated_at := OLD.deactivated_at;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_stamp_program_deactivated_at ON public.programs;
CREATE TRIGGER trg_stamp_program_deactivated_at
  BEFORE INSERT OR UPDATE ON public.programs
  FOR EACH ROW EXECUTE FUNCTION public.stamp_program_deactivated_at();

-- Is this session open for its athlete? (2026_10_12_08, review P58)
-- The session's own lock, in ONE place: the coach has not archived it and has
-- not reviewed it. reviewed_at, not the confirmation: a set logged offline
-- may be replayed after the confirmation of its session.
--
-- It says nothing about the program — that is program_active_for_session /
-- program_active_for_slot above. An athlete's write asks THREE things, and a
-- policy (or a SECURITY DEFINER function that writes for an athlete) that
-- leaves one out has a hole:
--     student_profile_for_slot(x) = auth.uid()     -- the row is mine
--     AND program_active_for_slot(x) = true        -- my program is the block being trained
--     AND session_writable_for_slot(x)             -- the session is neither archived nor reviewed
--
-- Never NULL: a session that does not exist is not writable, so
-- `IF NOT public.session_writable(x) THEN RAISE` refuses what it should.
-- session_writable(session) is asked of a session id by the UPDATE and DELETE
-- policies of session_confirmations (2026_10_13_09): a confirmation is closed
-- by the review like everything else under the session. Both are in the
-- allow-list of the FUNCTION PRIVILEGES block.
CREATE OR REPLACE FUNCTION public.session_writable(sess_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE((
    SELECT s.archived_at IS NULL AND s.reviewed_at IS NULL
      FROM public.sessions s
     WHERE s.id = sess_id
  ), false)
$$;

CREATE OR REPLACE FUNCTION public.session_writable_for_slot(slot_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE((
    SELECT public.session_writable(es.session_id)
      FROM public.exercise_slots es
     WHERE es.id = slot_id
  ), false)
$$;

-- The exercise slot a set belongs to (2026_10_12_08). A video is attached to
-- a set, and the three questions are asked of its slot: the policies of
-- set_log_videos reach it through this. NULL for a set that does not exist —
-- and every question asked of NULL is answered "no".
CREATE OR REPLACE FUNCTION public.slot_for_set_log(log_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT sl.exercise_slot_id
    FROM public.set_logs sl
   WHERE sl.id = log_id
$$;

-- The exercise slot the path of a video names (2026_10_12_08):
--     <athlete's profile id>/<exercise slot id>/<set number>-<uuid>.<ext>
-- its second folder. NULL when the path has no second folder or when that
-- folder is not a uuid as PostgreSQL prints one (lower case, with dashes) —
-- so a policy answers "no" to a path of another shape instead of failing on
-- a cast. "Folder" as storage.foldername() means it: everything but the last
-- part.
CREATE OR REPLACE FUNCTION public.set_video_slot(object_name text)
RETURNS uuid
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
           WHEN cardinality(string_to_array(object_name, '/')) >= 3
            AND (string_to_array(object_name, '/'))[2]
                ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           THEN (string_to_array(object_name, '/'))[2]::uuid
         END
$$;

-- What "logged" means, in ONE place (2026_10_11_04): a set the athlete
-- recorded something on — ticked done, marked failed or skipped, rated, or
-- logged with an actual. Read by every guard of the LOGGED TRAINING IS HISTORY
-- section further down, by the pin on the targets of a logged set, and by
-- adopt_swap / adopt_skip. It takes the ROW, so a caller writes
-- set_log_is_logged(sl) and cannot leave a column out.
-- Not for the API: only SECURITY DEFINER functions of this file call it, as
-- their owner (no grant in the FUNCTION PRIVILEGES block).
CREATE OR REPLACE FUNCTION public.set_log_is_logged(sl public.set_logs)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT sl.done OR sl.failed OR sl.skipped
      OR sl.rpe IS NOT NULL
      OR sl.actual_reps IS NOT NULL
      OR sl.actual_weight_kg IS NOT NULL
$$;

-- Is the caller a coach? (2026_10_11_05)
-- The role is profiles.role, which a signed-in user cannot change
-- (profiles_pin_immutable_columns). SECURITY DEFINER because it is called
-- from policies: it must not depend on what the caller may read. It answers
-- about the caller only, who can read that row anyway.
-- In a policy it is written (SELECT public.is_coach()): asked once per
-- statement, not once per row. A policy that lets a COACH write something
-- asks for it — `coach_id = auth.uid()` alone is true for any account that
-- puts its own id in the column.
CREATE OR REPLACE FUNCTION public.is_coach()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
     WHERE p.id = auth.uid() AND p.role = 'coach'
  )
$$;

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

-- No INSERT policy and no DELETE policy (2026_10_11_05): with row-level
-- security on, that is "nobody who goes through the API as a user". A link is
-- created and removed by the owner of the database (SQL editor) or with the
-- service-role key. Do NOT add one back with `coach_id = auth.uid()`: any
-- account can put its own id there, and made itself the coach of its coach
-- that way (review P7, L2). The app only reads this table.
--
-- UPDATE stays, for the columns that are not the link (notes, today): the
-- coach of the row, who is a coach, and the row it leaves must still be
-- theirs. trg_check_students_link keeps the link itself.
CREATE POLICY "Coaches update their students"
  ON public.students FOR UPDATE
  USING (coach_id = auth.uid() AND (SELECT public.is_coach()))
  WITH CHECK (coach_id = auth.uid() AND (SELECT public.is_coach()));

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
-- USING: the owner of a row reads it and may delete it. WITH CHECK: a new or
-- edited row is written by a coach (2026_10_11_05) — without the role, any
-- account could fill a library of its own under its own id.
CREATE POLICY "Coaches manage own library"
  ON public.exercise_library FOR ALL
  USING (coach_id = auth.uid())
  WITH CHECK (coach_id = auth.uid() AND (SELECT public.is_coach()));

CREATE POLICY "Students read their coachs library"
  ON public.exercise_library FOR SELECT
  USING (
    coach_id IN (SELECT coach_id FROM public.students WHERE profile_id = auth.uid())
  );

-- A third way to read an exercise — what the caller's training uses, after a
-- change of coach — is "Users read the exercises their training uses",
-- below the tables it reads (SLOT DEVIATIONS; 2026_10_16_23).

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
-- attempt by a student to mutate the coach-owned target_* columns — and what
-- the set IS: is_student_added, exercise_slot_id, set_number (2026_10_11_06).
-- If this proves insufficient we can split actuals to a child table.
-- What the coach's FOR ALL does NOT reach (2026_10_11_04, section LOGGED
-- TRAINING IS HISTORY): a set the athlete has logged is not deleted
-- (block_set_log_delete_when_logged), and its target_* are not rewritten by a
-- signed-in user (trg_pin_logged_set_log_targets).
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
-- read-only at the DB level — and whose session the coach has neither
-- archived nor reviewed (2026_10_12_08, review P58: a second device that
-- still showed a reviewed session open kept writing its sets). SELECT is
-- split out so the read gate can stay permissive while the write gates
-- restrict.
-- The gate is reviewed_at, not the confirmation: a set logged offline may be
-- replayed after the confirmation of its session.
CREATE POLICY "Students read own set logs"
  ON public.set_logs FOR SELECT
  USING (public.student_profile_for_slot(exercise_slot_id) = auth.uid());

CREATE POLICY "Students insert own set logs"
  ON public.set_logs FOR INSERT
  WITH CHECK (
    public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND public.program_active_for_slot(exercise_slot_id) = true
    AND public.session_writable_for_slot(exercise_slot_id)
  );

CREATE POLICY "Students update own set logs"
  ON public.set_logs FOR UPDATE
  USING (
    public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND public.program_active_for_slot(exercise_slot_id) = true
    AND public.session_writable_for_slot(exercise_slot_id)
  )
  WITH CHECK (
    public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND public.program_active_for_slot(exercise_slot_id) = true
    AND public.session_writable_for_slot(exercise_slot_id)
  );

-- DELETE is narrowed to student-added rows (2026_07_12): the target-pin
-- trigger only guards UPDATE, so an unrestricted DELETE would let a student
-- remove a prescribed row and re-INSERT it with forged targets.
-- is_student_added is what this policy trusts, so the athlete's own UPDATE
-- cannot change it (pin_set_log_targets_for_student, 2026_10_11_06).
CREATE POLICY "Students delete own set logs"
  ON public.set_logs FOR DELETE
  USING (
    public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND public.program_active_for_slot(exercise_slot_id) = true
    AND public.session_writable_for_slot(exercise_slot_id)
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

CREATE INDEX idx_session_confirmations_student_id ON public.session_confirmations(student_id);

CREATE OR REPLACE FUNCTION public.student_profile_for_session(sess_id uuid)
RETURNS uuid AS $$
  SELECT s.profile_id
  FROM public.sessions sess
  JOIN public.weeks w   ON w.id = sess.week_id
  JOIN public.programs p ON p.id = w.program_id
  JOIN public.students s ON s.id = p.student_id
  WHERE sess.id = sess_id
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.coach_profile_for_session(sess_id uuid)
RETURNS uuid AS $$
  SELECT s.coach_id
  FROM public.sessions sess
  JOIN public.weeks w   ON w.id = sess.week_id
  JOIN public.programs p ON p.id = w.program_id
  JOIN public.students s ON s.id = p.student_id
  WHERE sess.id = sess_id
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

-- Has the athlete confirmed this session? (2026_10_13_09, review P57)
-- For the INSERT policy of messages: feedback, which is also the review, is
-- sent on a confirmed session. SECURITY DEFINER, like the other helpers the
-- policies are written with. Never NULL: a session that does not exist is not
-- confirmed.
-- STABLE: it answers for the database as the statement that asks saw it when
-- it started. That is what a policy needs, and NOT enough for a rule two
-- requests can cross: review_needs_confirmation, further down, reads the
-- table itself.
CREATE OR REPLACE FUNCTION public.session_is_confirmed(sess_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.session_confirmations c
     WHERE c.session_id = sess_id
  )
$$;

ALTER TABLE public.session_confirmations ENABLE ROW LEVEL SECURITY;

-- SELECT is permissive so students can view the timestamp / notes of their
-- own old confirmations on archived or past-program sessions. Writes are
-- gated: students cannot create / undo confirmations on archived sessions
-- OR on sessions whose parent program has been deactivated.
--
-- And a confirmation is CLOSED BY THE REVIEW (2026_10_13_09, review P57):
-- UPDATE and DELETE ask session_writable(session) — neither archived nor
-- reviewed. Not INSERT: a session can be reviewed and have no confirmation
-- (rows from before the rule, and what the owner does by hand), its athlete's
-- app lists it as still to do until it is confirmed, and that confirmation
-- is then final.
-- An upsert that meets an existing row (INSERT … ON CONFLICT DO UPDATE) is
-- judged by the UPDATE policy and RAISES 42501 when the row may not be
-- updated; ON CONFLICT DO NOTHING — what the app sends — is an INSERT only.
-- The policies judge the session as the statement saw it when it started;
-- block_confirmation_delete_when_reviewed (REVIEW LIFECYCLE, further down)
-- is what holds when a DELETE and a review cross.
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
    AND public.program_active_for_session(session_id) = true
    AND public.session_writable(session_id)
  )
  WITH CHECK (
    student_id = auth.uid()
    AND public.student_profile_for_session(session_id) = auth.uid()
    AND public.program_active_for_session(session_id) = true
    AND public.session_writable(session_id)
  );

CREATE POLICY "Students delete own session confirmations"
  ON public.session_confirmations FOR DELETE
  USING (
    student_id = auth.uid()
    AND public.student_profile_for_session(session_id) = auth.uid()
    AND public.program_active_for_session(session_id) = true
    AND public.session_writable(session_id)
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
--
-- What a goal points at (2026_10_13_10):
--   student_id   CASCADE — a goal is its athlete's, and goes with their account
--   coach_id     RESTRICT — a coach's account is not deleted over the goals
--                they set; public.transfer_student() hands them to the
--                athlete's new coach, together with the link
--   exercise_id  RESTRICT — like the exercise of a slot: tidying the library
--                does not delete a goal and the attempts logged against it
--                (review P18, L7). The exercise is archived instead.
-- goal_progress follows its goal (CASCADE): deleting a GOAL is its coach's
-- decision, and removes its attempts.
-- ============================================================
DO $$ BEGIN
  CREATE TYPE goal_kind AS ENUM ('one_rm', 'format');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS public.goals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  coach_id         uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  exercise_id      uuid NOT NULL REFERENCES public.exercise_library(id) ON DELETE RESTRICT,
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
CREATE INDEX IF NOT EXISTS goals_coach_idx       ON public.goals (coach_id);
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
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

-- The coach of a goal: the profile that set it, WHILE public.students links
-- that profile to the goal's athlete — NULL otherwise (2026_10_13_10, review
-- P21). It used to answer goals.coach_id alone, and a coach went on reading
-- the progress of an athlete who had moved to another one. The rule is the
-- one "Coaches manage goals for their students" asks of the goal itself:
-- coach_id = auth.uid() AND the link. A goal left with a former coach is read
-- by its athlete alone until public.transfer_student() hands it over.
CREATE OR REPLACE FUNCTION public.coach_profile_for_goal(g uuid)
RETURNS uuid AS $$
  SELECT gl.coach_id
    FROM public.goals gl
    JOIN public.students s
      ON s.profile_id = gl.student_id
     AND s.coach_id = gl.coach_id
   WHERE gl.id = g
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

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
CREATE INDEX IF NOT EXISTS slot_comments_student_idx ON public.slot_comments (student_id);

ALTER TABLE public.slot_comments ENABLE ROW LEVEL SECURITY;

-- SELECT permissive so students can still see their own old notes on
-- archived / past-program sessions. Writes ask the three questions of every
-- athlete's write (see session_writable): the note is mine, my program is the
-- block being trained, and the session is neither archived nor reviewed
-- (2026_10_12_08 — "not reviewed" was not asked).
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
    AND public.program_active_for_slot(exercise_slot_id) = true
    AND public.session_writable_for_slot(exercise_slot_id)
  );

CREATE POLICY "Students update own slot comments"
  ON public.slot_comments FOR UPDATE
  USING (
    student_id = auth.uid()
    AND public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND public.program_active_for_slot(exercise_slot_id) = true
    AND public.session_writable_for_slot(exercise_slot_id)
  )
  WITH CHECK (
    student_id = auth.uid()
    AND public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND public.program_active_for_slot(exercise_slot_id) = true
    AND public.session_writable_for_slot(exercise_slot_id)
  );

CREATE POLICY "Students delete own slot comments"
  ON public.slot_comments FOR DELETE
  USING (
    student_id = auth.uid()
    AND public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND public.program_active_for_slot(exercise_slot_id) = true
    AND public.session_writable_for_slot(exercise_slot_id)
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
-- slot_comments: student owns the row (read permissive; writes gated to the
-- active program and to a session that is neither archived nor reviewed —
-- on INSERT, UPDATE and DELETE alike since 2026_10_12_08), coach reads their
-- students' rows. The coach's writes — adopt_swap, adopt_skip,
-- decline_promote_request — are SECURITY DEFINER and do not come through
-- these policies. A new deviation notifies the coach via
-- notify_coach_on_slot_deviation; one that is removed takes its unread
-- notifications with it (retract_slot_deviation_notifications, 2026_10_13_09).
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
CREATE INDEX IF NOT EXISTS slot_deviations_student_idx ON public.slot_deviations (student_id);
CREATE INDEX IF NOT EXISTS slot_deviations_substitute_idx ON public.slot_deviations (substitute_exercise_id);

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
    AND public.program_active_for_slot(exercise_slot_id) = true
    AND public.session_writable_for_slot(exercise_slot_id)
  );

CREATE POLICY "Students update own slot deviations"
  ON public.slot_deviations FOR UPDATE
  USING (
    student_id = auth.uid()
    AND public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND public.program_active_for_slot(exercise_slot_id) = true
    AND public.session_writable_for_slot(exercise_slot_id)
  )
  WITH CHECK (
    student_id = auth.uid()
    AND public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND public.program_active_for_slot(exercise_slot_id) = true
    AND public.session_writable_for_slot(exercise_slot_id)
  );

CREATE POLICY "Students delete own slot deviations"
  ON public.slot_deviations FOR DELETE
  USING (
    student_id = auth.uid()
    AND public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND public.program_active_for_slot(exercise_slot_id) = true
    AND public.session_writable_for_slot(exercise_slot_id)
  );

CREATE POLICY "Coaches read slot deviations for their students"
  ON public.slot_deviations FOR SELECT
  USING (
    public.student_profile_for_slot(exercise_slot_id) IN (
      SELECT profile_id FROM public.students WHERE coach_id = auth.uid()
    )
  );

-- ============================================================
-- AN EXERCISE IS READ BY WHOEVER READS WHAT USES IT (2026_10_16_23, review B8)
--
-- "Coaches manage own library" and "Students read their coachs library" say
-- who reads a library. After a change of coach (transfer_student) the blocks
-- of the athlete keep the exercises of the former coach's library — a slot,
-- a swap, a goal — which neither the athlete nor the new coach would read:
-- the app embeds the exercise in every read of a session, and broke on NULL.
-- An exercise is also read by an account when something it reads names it:
--   * a slot of a program of an athlete it is, or coaches (the policies of
--     programs: students.profile_id, students.coach_id);
--   * a swap (substitute_exercise_id) on such a slot;
--   * a goal it reads: its own, or one of its athlete it holds as their coach
--     (the policy of goals).
-- SECURITY DEFINER: it reads those tables whatever the caller may read, and
-- answers true or false, never NULL. Here, below the three tables: a LANGUAGE
-- sql body is checked when it is created. The policy is named to come after
-- the two others — PostgreSQL asks permissive policies in the order of their
-- names and stops at the first yes — so an exercise of the caller's library,
-- or of their coach's, never reaches it.
-- For SELECT only: who writes an exercise, and which exercise a new slot or
-- swap may take (the library of the program's coach, migration 05), are
-- unchanged.
-- ============================================================
CREATE OR REPLACE FUNCTION public.exercise_readable_through_use(p_exercise_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
           SELECT 1
             FROM public.exercise_slots es
             JOIN public.sessions se ON se.id = es.session_id
             JOIN public.weeks w     ON w.id = se.week_id
             JOIN public.programs p  ON p.id = w.program_id
             JOIN public.students st ON st.id = p.student_id
            WHERE es.exercise_id = p_exercise_id
              AND (st.profile_id = auth.uid() OR st.coach_id = auth.uid()))
      OR EXISTS (
           SELECT 1
             FROM public.slot_deviations d
             JOIN public.exercise_slots es ON es.id = d.exercise_slot_id
             JOIN public.sessions se ON se.id = es.session_id
             JOIN public.weeks w     ON w.id = se.week_id
             JOIN public.programs p  ON p.id = w.program_id
             JOIN public.students st ON st.id = p.student_id
            WHERE d.substitute_exercise_id = p_exercise_id
              AND (st.profile_id = auth.uid() OR st.coach_id = auth.uid()))
      OR EXISTS (
           SELECT 1
             FROM public.goals g
            WHERE g.exercise_id = p_exercise_id
              AND (g.student_id = auth.uid()
                   OR (g.coach_id = auth.uid()
                       AND EXISTS (SELECT 1 FROM public.students st
                                    WHERE st.profile_id = g.student_id AND st.coach_id = auth.uid()))))
$$;
-- Who may execute it: the FUNCTION PRIVILEGES block at the end of this file.

CREATE POLICY "Users read the exercises their training uses"
  ON public.exercise_library FOR SELECT
  USING (public.exercise_readable_through_use(id));

-- ============================================================
-- TRIGGER: auto-create profile on signup
--
-- The role is always 'student'. The name is never empty (2026_10_11_07,
-- review B10), in this order:
--   * raw_user_meta_data->>'full_name' — what a sign-up form or an invitation
--     sends — without the white space around it;
--   * what stands before the @ of the e-mail address: "Add user" in the
--     dashboard asks for an address and a password and nothing else;
--   * 'Athlete' — an account without an address.
-- White space is [[:space:]], written as a class and not as \s so that the
-- text reads the same whatever standard_conforming_strings is.
--
-- It must never raise and never produce NULL: this runs inside the INSERT
-- that creates the account, and profiles.full_name is NOT NULL. Every step
-- answers NULL for a NULL — metadata that is missing, that is not an object,
-- an address that is missing.
--
-- SECURITY DEFINER: the INSERT into auth.users is made by GoTrue, which holds
-- nothing on public.
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
DECLARE
  v_name text;
BEGIN
  v_name := NULLIF(regexp_replace(NEW.raw_user_meta_data->>'full_name',
                                  '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
  IF v_name IS NULL THEN
    v_name := NULLIF(regexp_replace(split_part(NEW.email, '@', 1),
                                    '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
  END IF;

  INSERT INTO public.profiles (id, role, full_name)
  VALUES (
    NEW.id,
    -- Never trust client-supplied metadata for the role (2026_07_12): the
    -- anon key is public, so signup metadata is attacker-controlled. A coach
    -- is made by the owner of the database (profiles_pin_immutable_columns).
    'student',
    -- Never empty (review B10): an empty name passes every
    -- COALESCE(name, 'Your athlete') of the push triggers.
    COALESCE(v_name, 'Athlete')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- ============================================================
-- TRIGGER: pin profile id/created_at on UPDATE — and the role, for a request
-- that carries a user id (2026_10_11_07, review P20)
--
-- "Users update own profile" lets a signed-in user write their own row, every
-- column of it: this trigger is what keeps the role out of their hands. It is
-- keyed on the user id of the request, like the gate on public.students:
--   * with one — the app, the API, and any function called from them, a
--     SECURITY DEFINER one included — the role stays what it was. Silent: the
--     rest of the write (the name) is saved.
--   * without one — the SQL editor, `supabase db query`, the service-role
--     key — the role is written: that is how a coach is made. A request
--     without a session (anon) is not one of them: it has no policy on this
--     table and reaches no row.
-- id and created_at stay what they were for every caller.
--
-- A role that does change is held to what trg_check_students_link holds
-- every row of public.students to — a coach on one side, an athlete on the
-- other: an account that is somebody's athlete is not made a coach, and a
-- coach who has athletes does not stop being one. Raised (23514), not silent:
-- the caller is the owner, who has to know that nothing happened.
--
-- SECURITY INVOKER: the two reads of public.students are made by a caller
-- without a user id, and those who reach a row of this table without one —
-- the owner, the service role — read every row of that one.
-- ============================================================
CREATE OR REPLACE FUNCTION public.profiles_pin_immutable_columns()
RETURNS trigger AS $$
DECLARE
  v_athletes integer;
BEGIN
  NEW.id := OLD.id;
  NEW.created_at := OLD.created_at;

  -- A request with a user id: nobody gives themselves — or anybody — a role.
  IF auth.uid() IS NOT NULL THEN
    NEW.role := OLD.role;
    RETURN NEW;
  END IF;

  -- Without one, the role is the owner's to change (review P20) — as long as
  -- every link of public.students still joins a coach to an athlete.
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    IF NEW.role = 'coach' AND EXISTS (
         SELECT 1 FROM public.students s WHERE s.profile_id = OLD.id
       ) THEN
      RAISE EXCEPTION 'profile % (%) cannot be made a coach: it is the athlete of a coach', OLD.id, OLD.full_name
        USING ERRCODE = 'check_violation',
              HINT = 'An account is a coach or an athlete, not both: a coach gets an account of their own. Nothing was written.';
    END IF;
    IF NEW.role IS DISTINCT FROM 'coach' THEN
      SELECT count(*) INTO v_athletes FROM public.students s WHERE s.coach_id = OLD.id;
      IF v_athletes > 0 THEN
        RAISE EXCEPTION 'profile % (%) cannot stop being a coach: it has % athlete(s)', OLD.id, OLD.full_name, v_athletes
          USING ERRCODE = 'check_violation',
                HINT = 'Its athletes go to another coach first. Nothing was written.';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_restrict_student_goal_update ON public.goals;
CREATE TRIGGER trg_restrict_student_goal_update
  BEFORE UPDATE ON public.goals
  FOR EACH ROW EXECUTE FUNCTION public.restrict_student_goal_update();

-- ============================================================
-- TRIGGER: pin the coach-owned columns on student set_log updates
-- Defense in depth for the shared set_logs row: students legitimately write
-- what they DID on a set (done/failed/skipped/rpe/weight_kg/actual_*), but
-- must never rewrite what the set IS. When the writer is the slot's student
-- (not the coach), these go back to OLD:
--   target_*           the coach's prescription
--   is_student_added   prescribed, or an extra the athlete added — the DELETE
--                      policy trusts it: only an extra is deleted by its
--                      athlete (2026_10_11_06, review P14: flipped to true, a
--                      prescribed set could be deleted and inserted again
--                      with other targets)
--   exercise_slot_id   which exercise it belongs to
--   set_number         which set of that exercise — a set moved away leaves
--                      its place free for a forged one
-- Whose set it is, is asked of OLD: the slot is one of the columns held.
-- Silent: the rest of the write goes through. Coach writes resolve a
-- different auth.uid() and pass through untouched — the editor renumbers the
-- athlete's extra sets when the set count changes — and so does a statement
-- without a user id.
-- What it does NOT cover is the INSERT: an athlete still inserts a row with
-- targets of their choosing, because the deployed app materializes the
-- prescribed rows under the athlete's JWT (useEnsureSetLogs). The function
-- that does it for the app, ensure_set_logs, is further down (2026_10_13_13);
-- the INSERT itself is held by a contract migration, once no app inserts.
-- ============================================================
CREATE OR REPLACE FUNCTION public.pin_set_log_targets_for_student()
RETURNS trigger AS $$
BEGIN
  IF public.student_profile_for_slot(OLD.exercise_slot_id) = auth.uid() THEN
    NEW.target_reps             := OLD.target_reps;
    NEW.target_duration_seconds := OLD.target_duration_seconds;
    NEW.target_weight_kg        := OLD.target_weight_kg;
    NEW.target_rest_seconds     := OLD.target_rest_seconds;
    NEW.is_student_added        := OLD.is_student_added;
    NEW.exercise_slot_id        := OLD.exercise_slot_id;
    NEW.set_number              := OLD.set_number;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_pin_set_log_targets_for_student ON public.set_logs;
CREATE TRIGGER trg_pin_set_log_targets_for_student
  BEFORE UPDATE ON public.set_logs
  FOR EACH ROW EXECUTE FUNCTION public.pin_set_log_targets_for_student();

-- ============================================================
-- TRIGGER: the targets of a LOGGED set stay what they were (2026_10_11_04)
-- A set done as prescribed has no actual: its reps and load ARE its targets.
-- Rewriting them rewrites what the athlete lifted, in every stat and record.
--
-- Silent, on purpose: the coach's editor writes a change of reps, load or
-- rest to every set of the exercise in one statement. Raising here would
-- refuse the change for the sets still to come as well. So the logged rows
-- keep their targets and the statement goes on.
--
-- For a signed-in user only. The athlete is already pinned on every row by
-- the trigger above; this is the coach. A statement with no user id — the SQL
-- editor, the service role — is a deliberate correction.
-- ============================================================
CREATE OR REPLACE FUNCTION public.pin_logged_set_log_targets()
RETURNS trigger AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND public.set_log_is_logged(OLD) THEN
    NEW.target_reps             := OLD.target_reps;
    NEW.target_duration_seconds := OLD.target_duration_seconds;
    NEW.target_weight_kg        := OLD.target_weight_kg;
    NEW.target_rest_seconds     := OLD.target_rest_seconds;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- WHEN: an athlete ticking a set — the write this table sees most — does not
-- touch a target, and does not enter the function.
DROP TRIGGER IF EXISTS trg_pin_logged_set_log_targets ON public.set_logs;
CREATE TRIGGER trg_pin_logged_set_log_targets
  BEFORE UPDATE ON public.set_logs
  FOR EACH ROW
  WHEN (NEW.target_reps IS DISTINCT FROM OLD.target_reps
        OR NEW.target_duration_seconds IS DISTINCT FROM OLD.target_duration_seconds
        OR NEW.target_weight_kg IS DISTINCT FROM OLD.target_weight_kg
        OR NEW.target_rest_seconds IS DISTINCT FROM OLD.target_rest_seconds)
  EXECUTE FUNCTION public.pin_logged_set_log_targets();

-- ============================================================
-- THE PRESCRIBED SETS OF A SESSION, COMPLETED FOR ITS ATHLETE
-- (2026_10_13_13_ensure_claim_rpcs — review L8, P22, and what L6 needs)
--
-- A set is a row of set_logs: the coach's editor writes one per set when an
-- exercise is added, and approve_program writes them for a draft. A session
-- can still be short of some — a block copied from a draft, a request of the
-- editor that was lost — and the athlete's page shows the sets it finds. The
-- app deployed before wave 2 adds the others itself, from the number of sets
-- it has in its cache: a set the coach has removed since comes back (P22).
-- This function is given the id of the session, and nothing else.
--
--   ensure_set_logs(p_session_id)   → how many rows were added; 0 when none
--                                     was missing
--
--   adds      for every exercise of the session, every number from 1 to its
--             number of sets that has no row — whatever that row is: an
--             extra set of the athlete standing on a number is a row. A new
--             row is not done, and its targets are those of the exercise,
--             which is what the editor and approve_program write. Nothing
--             that exists is touched.
--   reads     the exercises in the database, at the moment of the call.
--   refuses   not authorized         (42501) no user id, or not the caller's
--                                    own session — somebody else's, one of
--                                    an athlete the caller coaches and no
--                                    such session are the same answer
--             program_not_active     not the block being trained: a past
--                                    block, a draft, a block in the trash
--             session_not_writable   archived or reviewed by the coach
--   … and has then written nothing.
--
-- SECURITY DEFINER, so it asks the three questions of an athlete's write
-- itself (see session_writable above), through the helpers the policies of
-- set_logs use. It has to be: its rows carry the coach's targets, which an
-- athlete's own INSERT will not be allowed to write.
--
-- THE SETTING. app.trusted_set_log_insert is 'on' while the INSERT runs and
-- 'off' again before the function returns — transaction-local, so a call
-- that fails takes it back with everything else. It is how a trigger on
-- set_logs tells these rows from an INSERT the athlete sent themselves:
-- auth.uid() is the athlete in both. NOTHING READS IT YET (the contract
-- migration that holds the athlete's INSERT will), and NOTHING ELSE MAY SET
-- IT: a function a signed-in user can execute that sets a setting named by
-- its caller would hand every athlete the same word. A re-creation of this
-- function keeps the two set_config lines around the one INSERT.
--
-- The exercises are locked FOR SHARE first, in the order of their ids: the
-- number of sets is read under that lock, so a coach who changes it in the
-- same instant waits for the rows to be there. Two calls for one session
-- wait for each other's rows (ON CONFLICT), and the second adds nothing.
-- Who may execute it: the FUNCTION PRIVILEGES block at the end of this file.
-- ============================================================
CREATE OR REPLACE FUNCTION public.ensure_set_logs(p_session_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_created integer;
BEGIN
  -- auth.uid() IS NULL is tested first, and the comparison is NULL-safe: a
  -- session that does not exist has no athlete, and neither has a caller
  -- without a session.
  IF v_uid IS NULL OR public.student_profile_for_session(p_session_id) IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'not authorized'
      USING ERRCODE = 'insufficient_privilege',
            DETAIL = 'The session is not one of the caller''s own.',
            HINT = 'The sets of a session are completed for its athlete. Nothing was changed.';
  END IF;
  IF public.program_active_for_session(p_session_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'program_not_active'
      USING DETAIL = 'The session belongs to a program that is not the block being trained: a past block, a draft, or a block in the trash.',
            HINT = 'Nothing was changed.';
  END IF;
  IF NOT public.session_writable(p_session_id) THEN
    RAISE EXCEPTION 'session_not_writable'
      USING DETAIL = 'The coach has archived or reviewed this session.',
            HINT = 'Nothing was changed.';
  END IF;

  PERFORM 1
     FROM public.exercise_slots es
    WHERE es.session_id = p_session_id
    ORDER BY es.id
      FOR SHARE;

  PERFORM set_config('app.trusted_set_log_insert', 'on', true);

  INSERT INTO public.set_logs
    (exercise_slot_id, set_number, done, target_reps, target_duration_seconds, target_weight_kg, target_rest_seconds)
  SELECT es.id, gs.n, false, es.reps, es.duration_seconds, es.weight_kg, es.rest_seconds
    FROM public.exercise_slots es
   CROSS JOIN LATERAL generate_series(1, es.sets) AS gs (n)
   WHERE es.session_id = p_session_id
     AND NOT EXISTS (
       SELECT 1 FROM public.set_logs sl
        WHERE sl.exercise_slot_id = es.id AND sl.set_number = gs.n
     )
   ORDER BY es.id, gs.n
  ON CONFLICT (exercise_slot_id, set_number) DO NOTHING;
  GET DIAGNOSTICS v_created = ROW_COUNT;

  PERFORM set_config('app.trusted_set_log_insert', 'off', true);

  RETURN v_created;
END;
$$;

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

CREATE OR REPLACE FUNCTION public.student_profile_for_set_log(log_id uuid)
RETURNS uuid AS $$
  SELECT public.student_profile_for_slot(sl.exercise_slot_id)
  FROM public.set_logs sl
  WHERE sl.id = log_id
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

ALTER TABLE public.set_log_videos ENABLE ROW LEVEL SECURITY;

-- Four policies, not one FOR ALL (2026_10_12_08, review P58). Reading stays
-- open: an athlete watches the videos of every session they ever trained.
-- Adding, changing and removing a video ask the three questions of every
-- athlete's write (see session_writable), of the slot of the set.
--
-- A row that is added or changed also says where its file is, and that is not
-- the athlete's to choose: <their id>/<the slot of this set>/<file> — where
-- the app has always stored it. The storage policies below judge a file by
-- the slot its path names; a row free to point at a file under ANOTHER slot
-- (one of a session still to come) would leave that file replaceable after
-- the review of this one.
CREATE POLICY "Students read own set log videos"
  ON public.set_log_videos FOR SELECT
  USING (public.student_profile_for_set_log(set_log_id) = auth.uid());

CREATE POLICY "Students insert own set log videos"
  ON public.set_log_videos FOR INSERT
  WITH CHECK (
    public.student_profile_for_set_log(set_log_id) = auth.uid()
    AND public.program_active_for_slot(public.slot_for_set_log(set_log_id)) = true
    AND public.session_writable_for_slot(public.slot_for_set_log(set_log_id))
    AND split_part(storage_path, '/', 1) = auth.uid()::text
    AND public.set_video_slot(storage_path) = public.slot_for_set_log(set_log_id)
  );

CREATE POLICY "Students update own set log videos"
  ON public.set_log_videos FOR UPDATE
  USING (
    public.student_profile_for_set_log(set_log_id) = auth.uid()
    AND public.program_active_for_slot(public.slot_for_set_log(set_log_id)) = true
    AND public.session_writable_for_slot(public.slot_for_set_log(set_log_id))
  )
  WITH CHECK (
    public.student_profile_for_set_log(set_log_id) = auth.uid()
    AND public.program_active_for_slot(public.slot_for_set_log(set_log_id)) = true
    AND public.session_writable_for_slot(public.slot_for_set_log(set_log_id))
    AND split_part(storage_path, '/', 1) = auth.uid()::text
    AND public.set_video_slot(storage_path) = public.slot_for_set_log(set_log_id)
  );

CREATE POLICY "Students delete own set log videos"
  ON public.set_log_videos FOR DELETE
  USING (
    public.student_profile_for_set_log(set_log_id) = auth.uid()
    AND public.program_active_for_slot(public.slot_for_set_log(set_log_id)) = true
    AND public.session_writable_for_slot(public.slot_for_set_log(set_log_id))
  );

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

-- Storage RLS: first path segment is owning student's profile_id, the second
-- the exercise slot of the set (public.set_video_slot).
-- A file is added, and removed, at <the athlete's id>/<a slot of theirs>/<file>
-- while that slot's program is the block being trained and its session is
-- neither archived nor reviewed (2026_10_12_08, review P58 and L5). So: an
-- account nobody coaches has no slot and uploads nothing; nobody uploads
-- under another athlete's exercise; and the file of a reviewed or archived
-- session stays where it is. There is no UPDATE policy: a file is not
-- overwritten or renamed. Reading is by folder, for the athlete and for the
-- coach.
CREATE POLICY "Students upload own set videos"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'set-videos'
    AND (storage.foldername(name))[1] = auth.uid()::text
    AND public.student_profile_for_slot(public.set_video_slot(name)) = auth.uid()
    AND public.program_active_for_slot(public.set_video_slot(name)) = true
    AND public.session_writable_for_slot(public.set_video_slot(name))
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
    AND public.student_profile_for_slot(public.set_video_slot(name)) = auth.uid()
    AND public.program_active_for_slot(public.set_video_slot(name)) = true
    AND public.session_writable_for_slot(public.set_video_slot(name))
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

-- A conversation read from one side, newest first (2026_10_16_24, review
-- P62); the indexes of the two foreign keys to profiles as well.
CREATE INDEX IF NOT EXISTS messages_sender_created_idx
  ON public.messages (sender_id, created_at DESC);
CREATE INDEX IF NOT EXISTS messages_recipient_created_idx
  ON public.messages (recipient_id, created_at DESC);

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
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

-- Lock body/sender/recipient on UPDATE so the recipient-update policy can
-- only flip read_at (RLS can't restrict per-column otherwise). The session
-- stays too, except when it is gone: the foreign key's ON DELETE SET NULL is
-- an UPDATE of the message, and putting the id back left a feedback message
-- naming a deleted session (2026_10_16_24, review N9).
CREATE OR REPLACE FUNCTION public.lock_message_fields_on_update()
RETURNS TRIGGER AS $$
BEGIN
  NEW.id           := OLD.id;
  NEW.sender_id    := OLD.sender_id;
  NEW.recipient_id := OLD.recipient_id;
  NEW.body         := OLD.body;
  -- The session stays — unless it is gone: then this UPDATE is the foreign
  -- key's ON DELETE SET NULL, and NULL goes through (2026_10_16_24, review N9).
  IF NOT (NEW.session_id IS NULL
          AND OLD.session_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM public.sessions s WHERE s.id = OLD.session_id)) THEN
    NEW.session_id := OLD.session_id;
  END IF;
  NEW.created_at   := OLD.created_at;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

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
-- threads. And the session must be CONFIRMED (2026_10_13_09, review P57):
-- the INSERT of a feedback message stamps the review
-- (notify_student_on_session_feedback), and a session reviewed before its
-- athlete confirmed it never came into the coach's "to review" list.
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
        AND public.session_is_confirmed(session_id)
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
-- A line its recipient read more than 90 days ago is deleted by
-- public.run_retention() (RETENTION, further down; 2026_10_13_18_retention);
-- one that was never read stays.
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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

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
-- The push is tagged by SESSION (2026_10_13_09): a confirmation that is taken
-- back and made again has a new id, and with the id of the confirmation in
-- the tag the pushes of one session stacked on the coach's lock screen. The
-- bell row of a confirmation that is taken back is removed by
-- retract_session_completed_notification (REVIEW LIFECYCLE, further down).
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

  -- Best-effort Web Push, through send_push_event (2026_10_13_15). Whatever
  -- it raises stays a warning: a push never undoes the write that caused it.
  BEGIN
    PERFORM public.send_push_event(
      v_coach_id,
      jsonb_build_object(
        'title', 'Session completed',
        'body',  COALESCE(v_student_name, 'Your athlete')
                 || ' completed ' || v_session_title,
        'tag',   'session-confirm-' || NEW.session_id::text,
        'data',  jsonb_build_object(
          'url', '/sl_app/#/coach/student/' || COALESCE(v_student_row_id::text, '')
                 || '/session/' || NEW.session_id::text || '/review'
        )
      )
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'send-push fan-out (session confirm) failed: %', SQLERRM;
  END;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

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

  -- Best-effort Web Push, through send_push_event (2026_10_13_15). Whatever
  -- it raises stays a warning: a push never undoes the write that caused it.
  BEGIN
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

    PERFORM public.send_push_event(
      v_coach_id,
      jsonb_build_object(
        'title', 'Off-plan session',
        'body',  v_body,
        'tag',   'deviation-' || NEW.id::text,
        'data',  jsonb_build_object(
          'url', '/sl_app/#/coach/student/' || COALESCE(v_student_row_id::text, '')
                 || '/session/' || v_session_id::text || '/review'
        )
      )
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'send-push fan-out (slot deviation) failed: %', SQLERRM;
  END;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_notify_coach_on_slot_deviation ON public.slot_deviations;
CREATE TRIGGER trg_notify_coach_on_slot_deviation
  AFTER INSERT ON public.slot_deviations
  FOR EACH ROW EXECUTE FUNCTION public.notify_coach_on_slot_deviation();

-- ============================================================
-- REVIEW LIFECYCLE (2026_10_13_09, review P57 and the server half of L12)
--
-- A confirmation ("I have trained this session") and a review ("I have read
-- it", with feedback or without) are tied together:
--
--   a review needs a confirmation     trg_review_needs_confirmation, and the
--                                     INSERT policy of messages
--                                     (session_is_confirmed)
--   a review closes the confirmation  the UPDATE and DELETE policies of
--                                     session_confirmations (session_writable),
--                                     and block_confirmation_delete_when_reviewed
--                                     when the two cross
--   what is taken back takes its      trg_retract_session_completed_notification,
--   unread notifications with it      trg_retract_slot_deviation_notifications
--
-- Both rules are for a request that carries a USER ID — the app, the API, a
-- SECURITY DEFINER function called from either. The owner of the database and
-- the service role are not judged: sessions reviewed without a confirmation
-- exist from before the rules, removing an account takes its confirmations
-- away, and a review is taken back by hand
-- (docs/runbook/migrations/09-review-lifecycle.md). There is no reopening in
-- the app.
-- ============================================================

-- reviewed_at goes from NULL to a value only while the session has a
-- confirmation. Both writers of the app come through here: the coach's own
-- UPDATE ("Finish without feedback") and notify_student_on_session_feedback,
-- whose UPDATE runs inside the coach's request and outside its EXCEPTION
-- block — so a refusal here undoes the INSERT of the message too.
--
-- ON THAT TRANSITION ONLY (the WHEN of the trigger): every other write of a
-- session reviewed without a confirmation — archive, restore, rename,
-- reorder, move_session, the mirror of the training date — goes through, and
-- so does taking a review back. An INSERT is not judged.
--
-- VOLATILE, AND IT MUST STAY SO — the opposite of pin_draft_session_columns.
-- A BEFORE UPDATE trigger fires once the row of the session is locked; a
-- VOLATILE function then reads session_confirmations as it is NOW, so a
-- confirmation taken back by a request that committed while this one waited
-- for the row is gone, and the review is refused. STABLE would read the table
-- as the statement saw it when it started. For the same reason it does not
-- call session_is_confirmed(), which is STABLE. No test on ONE connection
-- sees the difference; supabase/tests/review-lifecycle.test.js has them on
-- three.
--
-- THE NAME OF THE TRIGGER SORTS AFTER trg_pin_draft_session_columns, and
-- BEFORE triggers fire in the order of their names: on a session of a draft
-- the pin has already put reviewed_at back to NULL when the WHEN is asked, so
-- a draft stays silent instead of raising here.
--
-- 42501, the code of a refusal by a policy: the app shows both as
-- errors.notAllowed.
CREATE OR REPLACE FUNCTION public.review_needs_confirmation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.session_confirmations c
     WHERE c.session_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'session % is not confirmed by its athlete — it cannot be marked as reviewed', NEW.id
      USING ERRCODE = '42501',
            HINT = 'A review, with feedback or without, needs the confirmation of the session.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_review_needs_confirmation ON public.sessions;
CREATE TRIGGER trg_review_needs_confirmation
  BEFORE UPDATE ON public.sessions
  FOR EACH ROW
  WHEN (OLD.reviewed_at IS NULL AND NEW.reviewed_at IS NOT NULL)
  EXECUTE FUNCTION public.review_needs_confirmation();

-- The confirmation of a reviewed session stays, when a DELETE and a review
-- cross. The DELETE policy judges the session as the athlete's statement saw
-- it when it STARTED; a review that commits while that statement is on its
-- way is not seen by it. So the row of the session is read again here, with
-- FOR SHARE: the read waits for a review that is being written (an UPDATE
-- holds the row) and then sees it. The other order is the trigger above: a
-- review that arrives while this DELETE holds the row waits, and then finds
-- no confirmation. The coach never locks a confirmation, so the two cannot
-- wait for each other.
--
-- For a request that carries a user id. A cascade from the session itself is
-- not concerned either way: the row of the session is gone by the time its
-- confirmation follows, and a session that is not found refuses nothing.
-- It RAISES where the policy says nothing: this is the request that lost a
-- race.
-- KNOWN residual: an UPDATE of the confirmation is not read again. A note or
-- a date written in the same instant as the review breaks nothing; an UPDATE
-- that MOVES the confirmation to another session in that instant — the app
-- sends none; session_id is not held on this table — leaves this session
-- reviewed without one, which its athlete leaves by confirming.
CREATE OR REPLACE FUNCTION public.block_confirmation_delete_when_reviewed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_reviewed_at timestamptz;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN OLD;
  END IF;

  SELECT s.reviewed_at INTO v_reviewed_at
    FROM public.sessions s
   WHERE s.id = OLD.session_id
     FOR SHARE;

  IF FOUND AND v_reviewed_at IS NOT NULL THEN
    RAISE EXCEPTION 'session % has been reviewed by the coach — its confirmation cannot be taken back', OLD.session_id
      USING ERRCODE = '42501',
            HINT = 'The review was written while this request was on its way.';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS block_confirmation_delete_when_reviewed ON public.session_confirmations;
CREATE TRIGGER block_confirmation_delete_when_reviewed
  BEFORE DELETE ON public.session_confirmations
  FOR EACH ROW
  EXECUTE FUNCTION public.block_confirmation_delete_when_reviewed();

-- A confirmation that is taken back takes the unread "session completed"
-- notifications of its session with it. By session and by confirmation: a
-- session has one confirmation at most, so once it is gone every unread one
-- of that session is stale — those left by earlier rounds included.
-- UNREAD ONLY: a notification the coach has read is their history.
-- SECURITY DEFINER: the statement is the athlete's, the notification is the
-- coach's, and nobody holds a DELETE policy on notifications. It fires on a
-- cascade too (a session that is deleted): the line would lead nowhere.
-- A NEW KIND OF NOTIFICATION about a row that can be taken back gets a
-- trigger like these two, and names that row in its payload.
CREATE OR REPLACE FUNCTION public.retract_session_completed_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  DELETE FROM public.notifications n
   WHERE n.kind = 'session_completed'
     AND n.read_at IS NULL
     AND (n.payload->>'confirmation_id' = OLD.id::text
          OR n.payload->>'session_id' = OLD.session_id::text);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_retract_session_completed_notification ON public.session_confirmations;
CREATE TRIGGER trg_retract_session_completed_notification
  AFTER DELETE ON public.session_confirmations
  FOR EACH ROW
  EXECUTE FUNCTION public.retract_session_completed_notification();

-- The same for a swap or a skip (L12): "skipped Dips" (session_deviation,
-- written when the row is inserted) and "wants to drop Dips going forward"
-- (promote_requested, written when the athlete asks) both name the exercise
-- slot in their payload, and a slot holds one deviation at most.
CREATE OR REPLACE FUNCTION public.retract_slot_deviation_notifications()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  DELETE FROM public.notifications n
   WHERE n.kind IN ('session_deviation', 'promote_requested')
     AND n.read_at IS NULL
     AND n.payload->>'slot_id' = OLD.exercise_slot_id::text;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_retract_slot_deviation_notifications ON public.slot_deviations;
CREATE TRIGGER trg_retract_slot_deviation_notifications
  AFTER DELETE ON public.slot_deviations
  FOR EACH ROW
  EXECUTE FUNCTION public.retract_slot_deviation_notifications();

-- Phase 3.1: adopt a student's swap into the standing prescription (forward-
-- only). Coach-only SECURITY DEFINER RPC (self-authorizes); see
-- 2026_07_18_adopt_swap.sql for the full rationale.
--
-- The five coach-only definer RPCs — adopt_swap, adopt_skip,
-- decline_promote_request, approve_program, send_back_program — authorize
-- with the same line since 2026_10_03_02_rpc_auth_null_guard:
--   IF auth.uid() IS NULL OR v_coach_id IS DISTINCT FROM auth.uid() THEN RAISE
-- A definer bypasses RLS, so that line is the whole gate. Keep it, as written,
-- when one of them is re-created: supabase/tests/rpc-auth.test.js calls each
-- one as every kind of caller, with and without a user id.
CREATE OR REPLACE FUNCTION public.adopt_swap(
  p_slot_id uuid,
  p_substitute_id uuid,
  p_dry_run boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
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
BEGIN
  SELECT es.session_id, es.exercise_id
    INTO v_session_id, v_original_ex
    FROM public.exercise_slots es
   WHERE es.id = p_slot_id;
  IF v_session_id IS NULL THEN
    RAISE EXCEPTION 'slot not found';
  END IF;

  v_coach_id := public.coach_profile_for_session(v_session_id);
  -- auth.uid() IS NULL is tested first, and the comparison is NULL-safe: with
  -- a plain `<>` a caller without a session skipped this RAISE (review P1).
  IF auth.uid() IS NULL OR v_coach_id IS DISTINCT FROM auth.uid() THEN
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
  -- "Trained" is anything the athlete left on the slot: a logged set (the
  -- shared set_log_is_logged: done, failed, skipped, an RPE or an actual), a
  -- video, a comment, a deviation of its own (review P17).
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
          AND (public.set_log_is_logged(sl)
               OR EXISTS (SELECT 1 FROM public.set_log_videos v WHERE v.set_log_id = sl.id))
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.slot_comments c WHERE c.exercise_slot_id = es.id
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

    -- Best-effort Web Push, through send_push_event (2026_10_13_15). Whatever
    -- it raises stays a warning: a push never undoes the write that caused it.
    BEGIN
      PERFORM public.send_push_event(
        v_student_prof,
        jsonb_build_object(
          'title', 'Program updated',
          'body',  COALESCE(v_coach_name, 'Your coach') || ' adopted your swap: '
                   || COALESCE(v_orig_name, 'an exercise') || ' → '
                   || COALESCE(v_sub_name, 'another exercise'),
          'tag',   'swap-adopted-' || p_slot_id::text,
          'data',  jsonb_build_object('url', '/sl_app/#/student/session/' || v_session_id::text)
        )
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'send-push fan-out (swap adopted) failed: %', SQLERRM;
    END;
  END IF;

  RETURN jsonb_build_object('applied', v_applied, 'dry_run', false);
END;
$$;

-- Who may execute it: the FUNCTION PRIVILEGES block at the end of this file.

-- Phase 3.2: adopt a student's SKIP — drop the exercise from upcoming sessions
-- (forward-only DELETE). Same predicate as adopt_swap; see 2026_07_19_adopt_skip.sql.
CREATE OR REPLACE FUNCTION public.adopt_skip(
  p_slot_id uuid,
  p_dry_run boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
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
BEGIN
  SELECT es.session_id, es.exercise_id
    INTO v_session_id, v_original_ex
    FROM public.exercise_slots es
   WHERE es.id = p_slot_id;
  IF v_session_id IS NULL THEN
    RAISE EXCEPTION 'slot not found';
  END IF;

  v_coach_id := public.coach_profile_for_session(v_session_id);
  -- auth.uid() IS NULL is tested first, and the comparison is NULL-safe: with
  -- a plain `<>` a caller without a session skipped this RAISE (review P1).
  IF auth.uid() IS NULL OR v_coach_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  SELECT w.program_id, w.week_number, s.sort_order
    INTO v_program_id, v_week_number, v_sort_order
    FROM public.sessions s
    JOIN public.weeks w ON w.id = s.week_id
   WHERE s.id = v_session_id;

  -- The predicate of adopt_swap, word for word: what the dry run counts is
  -- what the DELETE below removes, and none of it carries a logged set, a
  -- video or a comment — so the delete guards never have to refuse it.
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
          AND (public.set_log_is_logged(sl)
               OR EXISTS (SELECT 1 FROM public.set_log_videos v WHERE v.set_log_id = sl.id))
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.slot_comments c WHERE c.exercise_slot_id = es.id
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

    -- Best-effort Web Push, through send_push_event (2026_10_13_15). Whatever
    -- it raises stays a warning: a push never undoes the write that caused it.
    BEGIN
      PERFORM public.send_push_event(
        v_student_prof,
        jsonb_build_object(
          'title', 'Program updated',
          'body',  COALESCE(v_coach_name, 'Your coach') || ' dropped '
                   || COALESCE(v_orig_name, 'an exercise') || ' from your upcoming sessions',
          'tag',   'skip-adopted-' || p_slot_id::text,
          'data',  jsonb_build_object('url', '/sl_app/#/student/session/' || v_session_id::text)
        )
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'send-push fan-out (skip adopted) failed: %', SQLERRM;
    END;
  END IF;

  RETURN jsonb_build_object('applied', v_applied, 'dry_run', false);
END;
$$;

-- Who may execute it: the FUNCTION PRIVILEGES block at the end of this file.

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

  -- Best-effort Web Push, through send_push_event (2026_10_13_15). Whatever
  -- it raises stays a warning: a push never undoes the write that caused it.
  BEGIN
    IF NEW.kind = 'swap' THEN
      v_body := COALESCE(v_student_name, 'Your athlete') || ' wants to keep '
                || COALESCE(v_substitute_name, 'their swap') || ' instead of '
                || COALESCE(v_original_name, 'the prescription');
    ELSE
      v_body := COALESCE(v_student_name, 'Your athlete') || ' wants to drop '
                || COALESCE(v_original_name, 'an exercise') || ' going forward';
    END IF;
    PERFORM public.send_push_event(
      v_coach_id,
      jsonb_build_object(
        'title', 'Program change requested',
        'body',  v_body,
        'tag',   'promote-req-' || NEW.exercise_slot_id::text,
        'data',  jsonb_build_object(
          'url', '/sl_app/#/coach/student/' || COALESCE(v_student_row_id::text, '')
                 || '/session/' || v_session_id::text || '/review'
        )
      )
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'send-push fan-out (promote request) failed: %', SQLERRM;
  END;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_notify_coach_on_promote_request ON public.slot_deviations;
CREATE TRIGGER trg_notify_coach_on_promote_request
  AFTER UPDATE ON public.slot_deviations
  FOR EACH ROW EXECUTE FUNCTION public.notify_coach_on_promote_request();

CREATE OR REPLACE FUNCTION public.decline_promote_request(p_slot_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session_id    uuid;
  v_coach_id      uuid;
  v_student_prof  uuid;
  v_original_name text;
  v_coach_name    text;
  v_session_title text;
  v_had_request   boolean;
BEGIN
  SELECT es.session_id INTO v_session_id
    FROM public.exercise_slots es WHERE es.id = p_slot_id;
  IF v_session_id IS NULL THEN
    RAISE EXCEPTION 'slot not found';
  END IF;

  v_coach_id := public.coach_profile_for_session(v_session_id);
  -- auth.uid() IS NULL is tested first, and the comparison is NULL-safe: with
  -- a plain `<>` a caller without a session skipped this RAISE (review P1).
  IF auth.uid() IS NULL OR v_coach_id IS DISTINCT FROM auth.uid() THEN
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

    -- Best-effort Web Push, through send_push_event (2026_10_13_15). Whatever
    -- it raises stays a warning: a push never undoes the write that caused it.
    BEGIN
      PERFORM public.send_push_event(
        v_student_prof,
        jsonb_build_object(
          'title', 'Coach kept your plan',
          'body',  COALESCE(v_coach_name, 'Your coach') || ' is keeping '
                   || COALESCE(v_original_name, 'the prescribed exercise') || ' in your program',
          'tag',   'promote-declined-' || p_slot_id::text,
          'data',  jsonb_build_object('url', '/sl_app/#/student/session/' || v_session_id::text)
        )
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'send-push fan-out (promote declined) failed: %', SQLERRM;
    END;
  END IF;

  RETURN jsonb_build_object('declined', true);
END;
$$;

-- Who may execute it: the FUNCTION PRIVILEGES block at the end of this file.

-- ============================================================
-- Phase 3.4a: student program authoring (draft → coach approve). See
-- 2026_07_21_student_program_authoring.sql for the full rationale. Recursion-
-- firewall helpers (SECURITY DEFINER STABLE) + additive draft-scoped student
-- RLS + the authoring-column pin trigger + the pin on the sessions of a draft
-- (2026_10_11_06) + approve_program + the triggers that keep the tree of a
-- draft its author's (2026_10_16_20): the coach of the athlete approves a
-- draft, sends it back, renames it, trashes it — and changes nothing in it.
-- ============================================================
CREATE OR REPLACE FUNCTION public.program_is_own_draft(p_program_id uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.programs p
     WHERE p.id = p_program_id AND p.created_by = auth.uid()
       AND p.status = 'draft' AND p.deleted_at IS NULL
  );
$$;
CREATE OR REPLACE FUNCTION public.week_is_own_draft(p_week_id uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp AS $$
  SELECT public.program_is_own_draft((SELECT program_id FROM public.weeks WHERE id = p_week_id));
$$;
CREATE OR REPLACE FUNCTION public.session_is_own_draft(p_session_id uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp AS $$
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
    -- Submitted once: NULL → a time is the author's, the way back is the
    -- coach's (review B4 — each new NULL → time edge notified the coach).
    IF OLD.submitted_at IS NOT NULL THEN
      NEW.submitted_at := OLD.submitted_at;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;
DROP TRIGGER IF EXISTS trg_pin_program_authoring_columns ON public.programs;
CREATE TRIGGER trg_pin_program_authoring_columns
  BEFORE UPDATE ON public.programs
  FOR EACH ROW EXECUTE FUNCTION public.pin_program_authoring_columns();

-- A session of a DRAFT carries no review, no archive, no training date and
-- no recommended date (2026_10_11_06, review P13). "Students author own draft
-- sessions" is FOR ALL: the author writes every column of the sessions of
-- their draft, and three of those are how the app knows a session was
-- reviewed by the coach, archived, trained. A draft sent in with reviewed_at
-- set gave, once approved, sessions that never reached the coach's "to
-- review" list and refused feedback as "already reviewed".
--
-- NULL while the program is a draft, for EVERY writer — not "for the
-- athlete": sessions.performed_at is written by sync_session_performed_at,
-- which runs inside the athlete's own request when they confirm a session of
-- an approved program (one they may have authored). A pin keyed on who writes
-- could not tell that write from a forged one; the status of the program
-- can: a draft is never active, and is never trained. So nobody archives or
-- dates a session of a draft — both are done after approval. (Since
-- 2026_10_16_20 the coach's write on a draft does not get this far: it is
-- refused by block_draft_tree_write, which fires first. The pin holds the
-- author, the owner of the database and the service role.)
-- A session whose week or program does not exist is not a draft's: the
-- foreign key answers for it. Silent: the rest of the write goes through.
-- approve_program, below, clears the four columns as well: whatever a draft
-- carried from before this trigger, an approved program starts without it.
--
-- STABLE, AND IT MUST STAY SO. The policy that lets the author write the
-- session (week_is_own_draft, STABLE) judges the program as the statement saw
-- it when it STARTED; a VOLATILE trigger function reads it as it is by the
-- time the row is reached. They differ when the coach approves while a stamp
-- of the author waits for a row lock: a draft for the policy, an approved
-- program for a VOLATILE pin, which holds nothing — the stamp is written on
-- the approved program. STABLE makes the pin read what the policy read. No
-- test on ONE connection sees the difference; supabase/tests/pins.test.js
-- has one on three. The price: a week created earlier in the SAME statement
-- (a data-modifying CTE) is not seen — nor by the policies, so only a caller
-- row-level security does not apply to gets a stamped session in that way.
CREATE OR REPLACE FUNCTION public.pin_draft_session_columns()
RETURNS trigger AS $$
BEGIN
  -- Nothing to hold: the write every draft save makes, and most others.
  IF NEW.reviewed_at IS NULL AND NEW.archived_at IS NULL
     AND NEW.performed_at IS NULL AND NEW.scheduled_date IS NULL THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.weeks w
      JOIN public.programs p ON p.id = w.program_id
     WHERE w.id = NEW.week_id
       AND p.status = 'draft'
  ) THEN
    NEW.reviewed_at    := NULL;
    NEW.archived_at    := NULL;
    NEW.performed_at   := NULL;
    NEW.scheduled_date := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp;
DROP TRIGGER IF EXISTS trg_pin_draft_session_columns ON public.sessions;
CREATE TRIGGER trg_pin_draft_session_columns
  BEFORE INSERT OR UPDATE ON public.sessions
  FOR EACH ROW EXECUTE FUNCTION public.pin_draft_session_columns();

CREATE OR REPLACE FUNCTION public.approve_program(p_program_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_student_id   uuid;
  v_student_prof uuid;
  v_coach_id     uuid;
  v_prog_name    text;
  v_created      int := 0;
BEGIN
  SELECT p.student_id, p.name INTO v_student_id, v_prog_name
    FROM public.programs p WHERE p.id = p_program_id AND p.status = 'draft';
  IF v_student_id IS NULL THEN
    RETURN jsonb_build_object('approved', false);
  END IF;
  SELECT s.coach_id, s.profile_id INTO v_coach_id, v_student_prof
    FROM public.students s WHERE s.id = v_student_id;
  -- auth.uid() IS NULL is tested first, and the comparison is NULL-safe: with
  -- a plain `<>` a caller without a session skipped this RAISE (review P1).
  IF auth.uid() IS NULL OR v_coach_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  -- The status FIRST (review P53). From here on the program is not a draft:
  -- the writes below carry the coach's user id, which the triggers of the
  -- tree of a draft refuse (block_draft_tree_write). And its row stays
  -- locked until the end: a save of the author that arrives now waits for
  -- it, then finds a program that is no longer a draft and is refused —
  -- instead of deleting the phases under the sets being written. Asked for a
  -- draft once more, under the lock: an approval that crossed this one has
  -- done everything already.
  UPDATE public.programs SET status = 'approved', approved_at = now(), submitted_at = NULL
   WHERE id = p_program_id AND status = 'draft';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('approved', false);
  END IF;

  -- No session of the program enters its life as reviewed, archived, trained
  -- or dated (review P13): those are written after approval, by the coach and
  -- by the athlete's confirmation.
  UPDATE public.sessions s
     SET reviewed_at = NULL, archived_at = NULL, performed_at = NULL, scheduled_date = NULL
    FROM public.weeks w
   WHERE w.id = s.week_id
     AND w.program_id = p_program_id
     AND (s.reviewed_at IS NOT NULL OR s.archived_at IS NOT NULL
          OR s.performed_at IS NOT NULL OR s.scheduled_date IS NOT NULL);

  -- A set without a target is written again from its exercise (review P53).
  -- A draft holds no set of its own: the ones it holds were added by its
  -- coach's editor before the tree of a draft was its author's, with the
  -- targets of a last row a draft does not have — no reps and no duration,
  -- which no prescription is (exercise_slots_unit_one_of). Dropped here, and
  -- added below with the other missing sets. A set with a target is kept, as
  -- before; one that was logged, added by the athlete or filmed is not
  -- touched.
  DELETE FROM public.set_logs sl
   USING public.exercise_slots es, public.sessions s, public.weeks w
   WHERE es.id = sl.exercise_slot_id
     AND s.id = es.session_id
     AND w.id = s.week_id
     AND w.program_id = p_program_id
     AND NOT sl.is_student_added
     AND sl.target_reps IS NULL
     AND sl.target_duration_seconds IS NULL
     AND NOT public.set_log_is_logged(sl)
     AND NOT EXISTS (SELECT 1 FROM public.set_log_videos v WHERE v.set_log_id = sl.id);

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

  IF v_student_prof IS NOT NULL THEN
    INSERT INTO public.notifications (recipient_id, kind, payload)
    VALUES (v_student_prof, 'program_approved',
      jsonb_build_object('program_id', p_program_id, 'program_name', v_prog_name));
    -- Best-effort Web Push, through send_push_event (2026_10_13_15). Whatever
    -- it raises stays a warning: a push never undoes the write that caused it.
    BEGIN
      PERFORM public.send_push_event(
        v_student_prof,
        jsonb_build_object(
          'title', 'Program approved',
          'body',  'Your coach approved your program' || COALESCE(': ' || v_prog_name, ''),
          'tag',   'program-approved-' || p_program_id::text,
          'data',  jsonb_build_object('url', '/sl_app/#/student')
        )
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'send-push fan-out (program approved) failed: %', SQLERRM;
    END;
  END IF;

  RETURN jsonb_build_object('approved', true, 'set_logs_created', v_created);
END;
$$;
-- Who may execute it: the FUNCTION PRIVILEGES block at the end of this file.

-- THE TREE OF A DRAFT IS ITS AUTHOR'S (2026_10_16_20, review P53). The
-- coach's policies on weeks, sessions, exercise_slots and set_logs are FOR
-- ALL and do not look at programs.status: without these triggers the coach of
-- the athlete wrote a draft like any block, and lost what they wrote at the
-- athlete's next save — save_draft_tree deletes the phases and writes them
-- again from the phone —, while the sets of a higher "Sets", written without
-- a target, outlived the approval.
--
-- block_draft_tree_write, one name on the four tables, refuses (P0001,
-- draft_read_only) a write that carries a user id other than the author of
-- the draft (programs.created_by) on a row of a program whose status is
-- 'draft' — in the trash or not; an UPDATE is judged on the parent as it was
-- and as it would be, so nothing moves into or out of a draft. What goes
-- through: a request without a user id (the SQL editor, a migration, the
-- service role); the author, as the policies decide; a row whose parent is
-- gone — the cascade of a delete, which is how the coach deletes a draft. The
-- row of the program has no such trigger: the coach approves, sends back,
-- renames, trashes and deletes a draft.
--
-- One function per table, because each finds the program another way. The
-- name sorts before every other BEFORE trigger of the four tables, so on a
-- draft the refusal is the answer before any guard or pin is asked. An INSERT
-- is judged by its triggers before row-level security checks the row: a
-- stranger who sends a row into a draft is answered draft_read_only instead
-- of the message of row-level security — refused either way.
--
-- STABLE, like pin_draft_session_columns and the author's policies
-- (program_is_own_draft): it reads the program as the statement saw it when
-- it started, as the policies do. SECURITY DEFINER: it reads the program
-- whatever the caller may read. A request without a user id reads nothing;
-- anybody else costs one lookup by primary keys up to the program — on
-- set_logs, every tap of an athlete.
CREATE OR REPLACE FUNCTION public.block_draft_week_write()
RETURNS trigger
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller  uuid := auth.uid();
  v_old     uuid;
  v_new     uuid;
  v_program uuid;
BEGIN
  IF v_caller IS NOT NULL THEN
    IF TG_OP <> 'INSERT' THEN
      v_old := OLD.program_id;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      v_new := NEW.program_id;
    END IF;

    SELECT p.id INTO v_program
      FROM public.programs p
     WHERE p.id IN (v_old, v_new)
       AND p.status = 'draft'
       AND p.created_by IS DISTINCT FROM v_caller
     LIMIT 1;

    IF v_program IS NOT NULL THEN
      RAISE EXCEPTION 'draft_read_only'
        USING ERRCODE = 'P0001',
              DETAIL = format('The phase belongs to program %s, a draft: only the account that wrote it changes its phases, sessions, exercises and sets.', v_program),
              HINT = 'Approve the draft or send it back to its athlete. Once approved, it is edited like any other block.';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.block_draft_session_write()
RETURNS trigger
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller  uuid := auth.uid();
  v_old     uuid;
  v_new     uuid;
  v_program uuid;
BEGIN
  IF v_caller IS NOT NULL THEN
    IF TG_OP <> 'INSERT' THEN
      v_old := OLD.week_id;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      v_new := NEW.week_id;
    END IF;

    SELECT p.id INTO v_program
      FROM public.weeks w
      JOIN public.programs p ON p.id = w.program_id
     WHERE w.id IN (v_old, v_new)
       AND p.status = 'draft'
       AND p.created_by IS DISTINCT FROM v_caller
     LIMIT 1;

    IF v_program IS NOT NULL THEN
      RAISE EXCEPTION 'draft_read_only'
        USING ERRCODE = 'P0001',
              DETAIL = format('The session belongs to program %s, a draft: only the account that wrote it changes its phases, sessions, exercises and sets.', v_program),
              HINT = 'Approve the draft or send it back to its athlete. Once approved, it is edited like any other block.';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.block_draft_slot_write()
RETURNS trigger
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller  uuid := auth.uid();
  v_old     uuid;
  v_new     uuid;
  v_program uuid;
BEGIN
  IF v_caller IS NOT NULL THEN
    IF TG_OP <> 'INSERT' THEN
      v_old := OLD.session_id;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      v_new := NEW.session_id;
    END IF;

    SELECT p.id INTO v_program
      FROM public.sessions s
      JOIN public.weeks w    ON w.id = s.week_id
      JOIN public.programs p ON p.id = w.program_id
     WHERE s.id IN (v_old, v_new)
       AND p.status = 'draft'
       AND p.created_by IS DISTINCT FROM v_caller
     LIMIT 1;

    IF v_program IS NOT NULL THEN
      RAISE EXCEPTION 'draft_read_only'
        USING ERRCODE = 'P0001',
              DETAIL = format('The exercise belongs to program %s, a draft: only the account that wrote it changes its phases, sessions, exercises and sets.', v_program),
              HINT = 'Approve the draft or send it back to its athlete. Once approved, it is edited like any other block.';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.block_draft_set_log_write()
RETURNS trigger
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller  uuid := auth.uid();
  v_old     uuid;
  v_new     uuid;
  v_program uuid;
BEGIN
  IF v_caller IS NOT NULL THEN
    IF TG_OP <> 'INSERT' THEN
      v_old := OLD.exercise_slot_id;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      v_new := NEW.exercise_slot_id;
    END IF;

    SELECT p.id INTO v_program
      FROM public.exercise_slots es
      JOIN public.sessions s ON s.id = es.session_id
      JOIN public.weeks w    ON w.id = s.week_id
      JOIN public.programs p ON p.id = w.program_id
     WHERE es.id IN (v_old, v_new)
       AND p.status = 'draft'
       AND p.created_by IS DISTINCT FROM v_caller
     LIMIT 1;

    IF v_program IS NOT NULL THEN
      RAISE EXCEPTION 'draft_read_only'
        USING ERRCODE = 'P0001',
              DETAIL = format('The set belongs to program %s, a draft: only the account that wrote it changes its phases, sessions, exercises and sets.', v_program),
              HINT = 'Approve the draft or send it back to its athlete. Once approved, it is edited like any other block.';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS block_draft_tree_write ON public.weeks;
CREATE TRIGGER block_draft_tree_write
  BEFORE INSERT OR UPDATE OR DELETE ON public.weeks
  FOR EACH ROW EXECUTE FUNCTION public.block_draft_week_write();
DROP TRIGGER IF EXISTS block_draft_tree_write ON public.sessions;
CREATE TRIGGER block_draft_tree_write
  BEFORE INSERT OR UPDATE OR DELETE ON public.sessions
  FOR EACH ROW EXECUTE FUNCTION public.block_draft_session_write();
DROP TRIGGER IF EXISTS block_draft_tree_write ON public.exercise_slots;
CREATE TRIGGER block_draft_tree_write
  BEFORE INSERT OR UPDATE OR DELETE ON public.exercise_slots
  FOR EACH ROW EXECUTE FUNCTION public.block_draft_slot_write();
DROP TRIGGER IF EXISTS block_draft_tree_write ON public.set_logs;
CREATE TRIGGER block_draft_tree_write
  BEFORE INSERT OR UPDATE OR DELETE ON public.set_logs
  FOR EACH ROW EXECUTE FUNCTION public.block_draft_set_log_write();
-- Who may execute them: nobody — trigger functions (the FUNCTION PRIVILEGES
-- block at the end of this file takes everything back).

-- Phase 3.4c: submit -> approve/send-back loop. See 2026_07_22_program_submit_notify.sql.
CREATE OR REPLACE FUNCTION public.notify_coach_on_program_submit()
RETURNS TRIGGER AS $$
DECLARE
  v_coach_id uuid; v_student_prof uuid; v_student_row_id uuid; v_student_name text;
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
  -- Best-effort Web Push, through send_push_event (2026_10_13_15). Whatever
  -- it raises stays a warning: a push never undoes the write that caused it.
  BEGIN
    PERFORM public.send_push_event(
      v_coach_id,
      jsonb_build_object(
        'title', 'Program submitted',
        'body', COALESCE(v_student_name,'Your athlete') || ' submitted a program for approval' || COALESCE(': ' || NEW.name, ''),
        'tag', 'program-submitted-' || NEW.id::text,
        'data', jsonb_build_object('url', '/sl_app/#/coach/students/' || COALESCE(v_student_row_id::text,'') || '/programming')
      )
    );
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'send-push fan-out (program submitted) failed: %', SQLERRM; END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;
DROP TRIGGER IF EXISTS trg_notify_coach_on_program_submit ON public.programs;
CREATE TRIGGER trg_notify_coach_on_program_submit
  AFTER UPDATE ON public.programs FOR EACH ROW EXECUTE FUNCTION public.notify_coach_on_program_submit();

CREATE OR REPLACE FUNCTION public.send_back_program(p_program_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_student_id uuid; v_student_prof uuid; v_coach_id uuid; v_prog_name text;
BEGIN
  SELECT p.student_id, p.name INTO v_student_id, v_prog_name
    FROM public.programs p WHERE p.id = p_program_id AND p.status = 'draft' AND p.submitted_at IS NOT NULL;
  IF v_student_id IS NULL THEN RETURN jsonb_build_object('sent_back', false); END IF;
  SELECT s.coach_id, s.profile_id INTO v_coach_id, v_student_prof FROM public.students s WHERE s.id = v_student_id;
  -- auth.uid() IS NULL is tested first, and the comparison is NULL-safe: with
  -- a plain `<>` a caller without a session skipped this RAISE (review P1).
  IF auth.uid() IS NULL OR v_coach_id IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'not authorized'; END IF;
  UPDATE public.programs SET submitted_at = NULL WHERE id = p_program_id;
  IF v_student_prof IS NOT NULL THEN
    INSERT INTO public.notifications (recipient_id, kind, payload)
    VALUES (v_student_prof, 'program_sent_back', jsonb_build_object('program_id', p_program_id, 'program_name', v_prog_name));
    -- Best-effort Web Push, through send_push_event (2026_10_13_15). Whatever
    -- it raises stays a warning: a push never undoes the write that caused it.
    BEGIN
      PERFORM public.send_push_event(
        v_student_prof,
        jsonb_build_object(
          'title', 'Program sent back',
          'body', 'Your coach sent your program back for changes' || COALESCE(': ' || v_prog_name, ''),
          'tag', 'program-sent-back-' || p_program_id::text,
          'data', jsonb_build_object('url', '/sl_app/#/student/author')
        )
      );
    EXCEPTION WHEN OTHERS THEN RAISE WARNING 'send-push fan-out (program sent back) failed: %', SQLERRM; END;
  END IF;
  RETURN jsonb_build_object('sent_back', true);
END;
$$;
-- Who may execute it: the FUNCTION PRIVILEGES block at the end of this file.

-- Phase 3.4d — offline authoring: idempotent whole-tree upsert. SECURITY
-- INVOKER (rides the 3.4a own-draft RLS). Children DELETE-then-reINSERT
-- (cascade), safe because a draft carries no set_logs/comments/deviations.
-- See 2026_07_24_save_draft_tree.sql for the full rationale.
CREATE OR REPLACE FUNCTION public.save_draft_tree(p_tree jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
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
         -- No weekday chosen stays NULL (2026_08_22): sort_order is the order.
         -- A number that is no weekday — what a phone that cached its draft
         -- before 2026_10_16_21 may still send — is written as none, instead
         -- of failing the whole tree on sessions_day_number_weekday.
         CASE WHEN (s->>'day_number')::int BETWEEN 1 AND 7 THEN (s->>'day_number')::int END,
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
-- Who may execute it: the FUNCTION PRIVILEGES block at the end of this file.

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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

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
-- 2. scheduled_pushes — one row per rest whose end is to ring: when
--    (fire_at), what the notification shows (payload), for which device
--    (endpoint), and what became of it (status). Written by
--    schedule_rest_push and cancel_rest_push; the app from before wave 3
--    inserts the row itself and sets canceled_at when the timer is cleared
--    (set undone, new set started, session left). Sent by whoever
--    claim_rest_push answers the row to — see THE REST PUSH, below the
--    table.
--
-- There are no triggers on these tables. RLS is the client-side guardrail,
-- with two rules on what a row may hold: the endpoint of a subscription is
-- an address at a known push service, and the endpoint of a scheduled push
-- is a device of the account that writes it. The Edge Functions use the
-- service role and bypass RLS.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  endpoint      text NOT NULL UNIQUE,
  p256dh        text NOT NULL,
  auth          text NOT NULL,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  -- An endpoint is an address at a push service, and nothing else
  -- (2026_10_13_15_push_plumbing — review B3). The account writes this
  -- column itself, and the Edge Functions POST to whatever it holds: without
  -- the rule, a row is a way to make them call any URL. https, one of the
  -- four hosts below, then a path — the host is everything between `https://`
  -- and the first `/`, so no port, no user name, no upper case.
  --     fcm.googleapis.com                  Chrome and the browsers built on it
  --     updates.push.services.mozilla.com   Firefox
  --     *.push.apple.com                    Safari, and the web apps of iOS
  --     *.notify.windows.com                Edge
  -- THE SAME LIST IS IN supabase/functions/_shared/pushHosts.js, which the
  -- functions ask before they send: a push service that is added, is added
  -- in both, by a migration that drops this constraint and adds it again.
  -- A refused write is 23514, and names the constraint.
  CONSTRAINT push_subscriptions_endpoint_known_push_service CHECK (
    endpoint ~ '^https://(fcm[.]googleapis[.]com|updates[.]push[.]services[.]mozilla[.]com|[a-z0-9.-]+[.]push[.]apple[.]com|[a-z0-9.-]+[.]notify[.]windows[.]com)/'
  )
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

-- A device belongs to the account that is signed in on it
-- (2026_10_13_13_ensure_claim_rpcs — review P15).
-- The browser keeps its push subscription across sign-outs, so the next
-- account on the same device is handed the same endpoint — and the policies
-- above let an account write its own rows only: through them the second
-- account cannot take the row over, and the first goes on receiving on that
-- device. This function is how the row changes hands.
--
--   claim_push_subscription(p_endpoint, p_p256dh, p_auth, p_user_agent)
--     → { "subscription_id", "outcome" }
--       'created'    nobody held this endpoint: a new row
--       'refreshed'  the caller held it: the keys sent are stored (and the
--                    user agent, unless it is left out), last_seen_at is now
--       'rehomed'    another account held it, with these keys: the row is
--                    the caller's now
--
--   refuses   not authorized            (42501) no user id
--             subscription_incomplete   the endpoint or a key is missing or
--                                       empty
--             endpoint_keys_mismatch    another account holds the endpoint,
--                                       and the keys sent are not the ones
--                                       stored with it
--   … and has then written nothing.
--
-- WHY THE KEYS. The row of another account is taken over on the caller's
-- word, so the caller proves they hold the subscription: `auth` is a secret
-- the browser shares with this database only, readable by the owner of the
-- row. Somebody who has learnt an endpoint and no more cannot move it to
-- their account — which would send their notifications to that device and
-- stop its owner's.
--
-- SECURITY DEFINER: the UPDATE that moves a row to the caller is one no
-- policy allows. The row is locked before it is judged; an endpoint that is
-- registered between the look and the INSERT is found by the next turn of
-- the loop. The policies above stay: the app deployed before wave 2 writes
-- the table itself.
-- Who may execute it: the FUNCTION PRIVILEGES block at the end of this file.
CREATE OR REPLACE FUNCTION public.claim_push_subscription(
  p_endpoint   text,
  p_p256dh     text,
  p_auth       text,
  p_user_agent text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_id      uuid;
  v_owner   uuid;
  v_p256dh  text;
  v_auth    text;
  v_outcome text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authorized'
      USING ERRCODE = 'insufficient_privilege',
            DETAIL = 'The request carries no user id.',
            HINT = 'A device is registered by the account that is signed in on it. Nothing was changed.';
  END IF;
  IF btrim(COALESCE(p_endpoint, '')) = ''
     OR btrim(COALESCE(p_p256dh, '')) = ''
     OR btrim(COALESCE(p_auth, '')) = '' THEN
    RAISE EXCEPTION 'subscription_incomplete'
      USING DETAIL = 'A push subscription is an endpoint and its two keys, p256dh and auth: one of the three is missing or empty.',
            HINT = 'Nothing was changed.';
  END IF;

  LOOP
    SELECT ps.id, ps.user_id, ps.p256dh, ps.auth
      INTO v_id, v_owner, v_p256dh, v_auth
      FROM public.push_subscriptions ps
     WHERE ps.endpoint = p_endpoint
       FOR UPDATE;

    IF FOUND THEN
      IF v_owner = v_uid THEN
        v_outcome := 'refreshed';
      ELSIF v_p256dh = p_p256dh AND v_auth = p_auth THEN
        v_outcome := 'rehomed';
      ELSE
        RAISE EXCEPTION 'endpoint_keys_mismatch'
          USING DETAIL = 'Another account holds this endpoint, and the keys sent are not the ones stored with it.',
                HINT = 'A device takes a subscription over by presenting the keys it was registered with. Nothing was changed.';
      END IF;

      UPDATE public.push_subscriptions ps
         SET user_id      = v_uid,
             p256dh       = p_p256dh,
             auth         = p_auth,
             user_agent   = COALESCE(p_user_agent, ps.user_agent),
             last_seen_at = now()
       WHERE ps.id = v_id;

      RETURN jsonb_build_object('subscription_id', v_id, 'outcome', v_outcome);
    END IF;

    INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, last_seen_at)
    VALUES (v_uid, p_endpoint, p_p256dh, p_auth, p_user_agent, now())
    ON CONFLICT (endpoint) DO NOTHING
    RETURNING id INTO v_id;

    IF v_id IS NOT NULL THEN
      RETURN jsonb_build_object('subscription_id', v_id, 'outcome', 'created');
    END IF;
    -- Registered by another request in the same instant, and committed by
    -- now: the next turn finds it, and judges it as a row that is there.
  END LOOP;
END;
$$;


-- What a row can say (the last two statuses and the last two columns:
-- 2026_10_13_16_rest_push_scheduling).
--   status   pending    waiting for its time
--            sending    a sender has taken it (claim_rest_push) and is
--                       sending; the sender then writes sent or failed
--            sent       at least one device got it          (sent_at)
--            failed     no device got it                    (error)
--            canceled   its athlete took it back before its time
--                       (canceled_at)
--            expired    its time is more than a minute past and nobody had
--                       sent it: a push that late is worse than none
--   endpoint       the device the push is for — the endpoint of one of the
--                  account's push_subscriptions. NULL: every device of the
--                  account, which is what a row means that the app from
--                  before wave 3 inserts.
--   dispatched_at  when dispatch_due_rest_pushes handed the row to
--                  send-push. It is what makes that happen once. NULL where
--                  the pg_cron job does not run.
-- The app from before wave 3 cancels by writing canceled_at on a row it
-- leaves 'pending': a row is canceled when its status says so OR canceled_at
-- is set, and every function below reads both.
CREATE TABLE IF NOT EXISTS public.scheduled_pushes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  fire_at       timestamptz NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'canceled', 'failed', 'expired')),
  canceled_at   timestamptz,
  sent_at       timestamptz,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  endpoint      text,
  dispatched_at timestamptz
);

CREATE INDEX IF NOT EXISTS scheduled_pushes_user_status_idx
  ON public.scheduled_pushes (user_id, status, fire_at);

ALTER TABLE public.scheduled_pushes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Read own scheduled pushes" ON public.scheduled_pushes;
CREATE POLICY "Read own scheduled pushes"
  ON public.scheduled_pushes FOR SELECT
  USING (user_id = auth.uid());

-- THE TWO POLICIES AN ACCOUNT WRITES THROUGH are for the app from before
-- wave 3, which inserts its row and sets canceled_at itself; the next app
-- goes through schedule_rest_push and cancel_rest_push, and a `contract`
-- migration drops both policies once no older app is in use.
--
-- An account names a device of its own, and no other
-- (2026_10_13_16_rest_push_scheduling): whoever sends a row reads where to
-- from it, so without the condition a row is a way to aim a push, with a
-- text of the writer's choosing, at the device of somebody else whose
-- endpoint the writer has learnt. The lookup runs with the rights of the
-- caller, who reads their own subscriptions and no others. The app from
-- before wave 3 never writes the column: its rows pass as they did.
DROP POLICY IF EXISTS "Insert own scheduled pushes" ON public.scheduled_pushes;
CREATE POLICY "Insert own scheduled pushes"
  ON public.scheduled_pushes FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND (
      endpoint IS NULL
      OR EXISTS (
        SELECT 1 FROM public.push_subscriptions ps
         WHERE ps.user_id = auth.uid()
           AND ps.endpoint = scheduled_pushes.endpoint
      )
    )
  );

-- No column-pin trigger: the worst an account can do to a row of its own is
-- to lose its own notification, or to send itself one more.
DROP POLICY IF EXISTS "Cancel own scheduled pushes" ON public.scheduled_pushes;
CREATE POLICY "Cancel own scheduled pushes"
  ON public.scheduled_pushes FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (
    user_id = auth.uid()
    AND (
      endpoint IS NULL
      OR EXISTS (
        SELECT 1 FROM public.push_subscriptions ps
         WHERE ps.user_id = auth.uid()
           AND ps.endpoint = scheduled_pushes.endpoint
      )
    )
  );

-- Owner may delete their own row (e.g. opportunistic cleanup after expiry).
DROP POLICY IF EXISTS "Delete own scheduled pushes" ON public.scheduled_pushes;
CREATE POLICY "Delete own scheduled pushes"
  ON public.scheduled_pushes FOR DELETE
  USING (user_id = auth.uid());

-- ============================================================
-- THE REST PUSH: SCHEDULED BY THE DATABASE, SENT ONCE
-- (2026_10_13_16_rest_push_scheduling — review P10, B14, and the database's
-- half of B35 and B38)
--
-- When an athlete ticks a set the app starts a rest timer, and asks for a
-- notification at its end: the one thing that reaches a locked phone.
--
--   schedule_rest_push(p_seconds, p_payload, p_endpoint)   the app, at the
--       → { id, fire_at, mode }                            start of a rest
--   cancel_rest_push(p_id) → { canceled }                  the app, when the
--                                                          rest ends early
--   claim_rest_push(p_id) → the row, or NULL               whoever SENDS
--   dispatch_due_rest_pushes() → { handed_over, expired }  the pg_cron job
--
-- WHO SENDS. Two ways, and the answer of schedule_rest_push says which:
--   mode 'cron'   a pg_cron job named sl-rest-push runs
--                 dispatch_due_rest_pushes() every ten seconds (an optional
--                 migration makes it). It hands each row due within ten
--                 seconds to the send-push Edge Function, with the time not
--                 to send before; send-push waits, then sends. The app has
--                 nothing more to do.
--   mode 'edge'   there is no such job: the app calls the dispatch-rest-push
--                 Edge Function with the id, which waits — in hops, for a
--                 long rest — and then sends.
-- The app from before wave 3 knows neither function: it inserts its row
-- (no endpoint: every device) and calls dispatch-rest-push itself, whatever
-- the mode.
--
-- ONE CLAIM. Whoever sends asks claim_rest_push(id) first, at the time of
-- the push, and sends only what it is answered. It moves the row from
-- 'pending' to 'sending' and answers it once: a row both ways picked is one
-- push, a row that was canceled is none, and so is one more than a minute
-- late. The sender then writes 'sent' (and sent_at) or 'failed' (and error)
-- on the row. A row left 'sending' is one whose sender never said.
--
-- TO WHOM. The devices of the row's user_id: all of them when endpoint is
-- NULL, the one with that endpoint otherwise — looked up in
-- push_subscriptions WITH the user id, never by the endpoint alone.
--
-- NOTHING WAITS FOR EVER. A row still 'pending' a minute after its time is
-- closed — 'expired', or 'canceled' when canceled_at is set — by the job, by
-- claim_rest_push when it is asked for that row, and by the next rest of its
-- account. An account's rows older than 7 days are deleted when it next
-- rests; those of an account that does not rest any more, or whose app still
-- inserts its rows itself, by run_retention() (RETENTION, further down).
--
-- dispatch_due_rest_pushes calls send_push_event, which is defined further
-- down: a function body is read when it runs.
-- ============================================================

-- The end of a rest, scheduled in one request.
--   p_seconds    how long the rest is, from now: 1 to 900 — what the Edge
--                Function can wait for where no job runs; the same rest is
--                refused in both modes
--   p_payload    what the notification shows — { "title", "body", "tag",
--                "data": { "url" } } — handed to the service worker as it is
--   p_endpoint   the device that asks: the endpoint of its push
--                subscription. Left out or NULL: every device of the account
--   returns      { "id", "fire_at", "mode" } — fire_at is now() + p_seconds
--                on the clock of the database, not of the phone
--   does      closes every row of the caller that is still waiting (one rest
--             at a time), deletes the caller's rows older than 7 days,
--             inserts the new one
--   refuses   not authorized (42501, no user id), rest_seconds_out_of_range,
--             payload_invalid (not a JSON object, or over 2000 bytes),
--             device_not_registered (the endpoint is not a device of the
--             caller — or, without one, the caller has none)
-- 'cron' only while cron.job holds an active job named sl-rest-push; no
-- pg_cron, no job, a job switched off or a table that cannot be read:
-- 'edge', which costs one call of the Edge Function and never a second push.
-- Two calls of one account at the same instant are served one after the
-- other (an advisory lock on the account).
-- SECURITY DEFINER: it reads the jobs of pg_cron, and it must go on working
-- once the policies above are dropped. It asks who calls first, and writes
-- rows of the caller only.
-- Who may execute it: the FUNCTION PRIVILEGES block at the end of this file.
CREATE OR REPLACE FUNCTION public.schedule_rest_push(
  p_seconds  integer,
  p_payload  jsonb,
  p_endpoint text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_id      uuid;
  v_fire_at timestamptz;
  v_mode    text := 'edge';
  v_job     boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authorized'
      USING ERRCODE = 'insufficient_privilege',
            DETAIL = 'The request carries no user id.',
            HINT = 'The end of a rest is scheduled by the account that rests. Nothing was changed.';
  END IF;
  IF p_seconds IS NULL OR p_seconds < 1 OR p_seconds > 900 THEN
    RAISE EXCEPTION 'rest_seconds_out_of_range'
      USING DETAIL = 'The end of a rest is scheduled 1 to 900 seconds ahead.',
            HINT = 'Nothing was changed.';
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR octet_length(p_payload::text) > 2000 THEN
    RAISE EXCEPTION 'payload_invalid'
      USING DETAIL = 'The payload is what the notification shows: a JSON object, of 2000 bytes at most.',
            HINT = 'Nothing was changed.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.push_subscriptions ps
     WHERE ps.user_id = v_uid
       AND (p_endpoint IS NULL OR ps.endpoint = p_endpoint)
  ) THEN
    RAISE EXCEPTION 'device_not_registered'
      USING DETAIL = 'The endpoint sent is not a device this account has switched notifications on for — or none was sent, and the account has no such device.',
            HINT = 'Nothing was changed.';
  END IF;

  -- One call at a time for an account: the next statement of a call that
  -- waited here sees the row of the one before.
  PERFORM pg_advisory_xact_lock(hashtextextended('sl_app.rest_push.' || v_uid::text, 0));

  UPDATE public.scheduled_pushes sp
     SET status      = CASE WHEN sp.canceled_at IS NULL AND sp.fire_at <= now() - interval '60 seconds'
                            THEN 'expired' ELSE 'canceled' END,
         canceled_at = CASE WHEN sp.canceled_at IS NULL AND sp.fire_at > now() - interval '60 seconds'
                            THEN now() ELSE sp.canceled_at END
   WHERE sp.user_id = v_uid
     AND sp.status = 'pending';

  DELETE FROM public.scheduled_pushes sp
   WHERE sp.user_id = v_uid
     AND sp.created_at < now() - interval '7 days';

  INSERT INTO public.scheduled_pushes (user_id, fire_at, payload, endpoint)
  VALUES (v_uid, now() + make_interval(secs => p_seconds), p_payload, p_endpoint)
  RETURNING id, fire_at INTO v_id, v_fire_at;

  -- Who will send it. The table is pg_cron's, and is not there without the
  -- extension: asked by name, and read in a statement of its own. Whatever
  -- goes wrong with the question, the rest is scheduled, and 'edge' is the
  -- answer that is always safe.
  BEGIN
    IF to_regclass('cron.job') IS NOT NULL THEN
      EXECUTE 'SELECT EXISTS (SELECT 1 FROM cron.job j WHERE j.jobname = $1 AND j.active)'
         INTO v_job
        USING 'sl-rest-push';
      IF v_job THEN
        v_mode := 'cron';
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_mode := 'edge';
  END;

  RETURN jsonb_build_object('id', v_id, 'fire_at', v_fire_at, 'mode', v_mode);
END;
$$;

-- A rest that ends early: its push is taken back.
--   returns   { "canceled": true } — the row was waiting, and is closed —
--             or false: sent or being sent, closed already, not the
--             caller's, or no row at all. Too late is not an error.
--   refuses   not authorized (42501) — no user id
-- SECURITY DEFINER, for the reason schedule_rest_push is.
-- Who may execute it: the FUNCTION PRIVILEGES block at the end of this file.
CREATE OR REPLACE FUNCTION public.cancel_rest_push(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authorized'
      USING ERRCODE = 'insufficient_privilege',
            DETAIL = 'The request carries no user id.',
            HINT = 'A rest is taken back by the account that scheduled it. Nothing was changed.';
  END IF;

  UPDATE public.scheduled_pushes sp
     SET status      = 'canceled',
         canceled_at = COALESCE(sp.canceled_at, now())
   WHERE sp.id = p_id
     AND sp.user_id = v_uid
     AND sp.status = 'pending';

  RETURN jsonb_build_object('canceled', FOUND);
END;
$$;

-- The one way a row gets sent.
--   returns   { "id", "user_id", "payload", "endpoint", "fire_at" } — the
--             row is the caller's to send, and is 'sending' from now on —
--             or NULL: somebody else took it, its athlete took it back, its
--             time is more than a minute past, or there is no such row
-- The row is locked by the UPDATE that takes it; a second caller that waited
-- for the lock finds a row that is no longer 'pending'. A row that is asked
-- for and can no longer be sent is closed here ('canceled' or 'expired').
-- NOT FOR A SIGNED-IN USER, and SECURITY INVOKER: the service role — the
-- Edge Functions — holds every row; anybody else would reach their own.
-- Who may execute it: nobody but its owner and the service role. It is NOT in
-- the FUNCTION PRIVILEGES block at the end of this file, and must not be.
CREATE OR REPLACE FUNCTION public.claim_rest_push(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row public.scheduled_pushes;
BEGIN
  UPDATE public.scheduled_pushes sp
     SET status = 'sending'
   WHERE sp.id = p_id
     AND sp.status = 'pending'
     AND sp.canceled_at IS NULL
     AND sp.fire_at > now() - interval '60 seconds'
  RETURNING sp.* INTO v_row;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'id',       v_row.id,
      'user_id',  v_row.user_id,
      'payload',  v_row.payload,
      'endpoint', v_row.endpoint,
      'fire_at',  v_row.fire_at
    );
  END IF;

  -- Not taken. If it is still 'pending', it is one that can no longer be
  -- sent: say so on the row.
  UPDATE public.scheduled_pushes sp
     SET status = CASE WHEN sp.canceled_at IS NULL THEN 'expired' ELSE 'canceled' END
   WHERE sp.id = p_id
     AND sp.status = 'pending'
     AND (sp.canceled_at IS NOT NULL OR sp.fire_at <= now() - interval '60 seconds');

  RETURN NULL;
END;
$$;

-- What the pg_cron job runs — once there is a job. Until then nothing calls
-- it.
--   returns     { "handed_over", "expired" }
--   closes      every row still 'pending' more than a minute after its time
--   hands over  every row that is waiting, not canceled, not handed over yet
--               and due within ten seconds, to send_push_event:
--                 { "user_id", "payload", "schedule_id", "not_before",
--                   "endpoint", "ttl": 60, "urgency": "high" }
--               ("endpoint" left out when the row names none), and marks it
--               (dispatched_at) in the same step — ONCE, whatever becomes of
--               the request. The row stays 'pending' until send-push takes
--               it: a rest that ends early in those ten seconds is still
--               taken back.
-- Once, because a send-push that does not know "schedule_id" — the one from
-- before wave 2 — sends what it is handed at once and marks nothing: handed
-- the same row every ten seconds, it would ring seven times.
-- The call of send_push_event stands in a net of its own: a row that cannot
-- be handed over is a warning, its mark is undone with it, and the next run
-- tries again. Rows another transaction holds are passed over, not waited
-- for.
-- SECURITY DEFINER: send_push_event has no right of its own.
-- Who may execute it: nobody but its owner and the service role. It is NOT in
-- the FUNCTION PRIVILEGES block at the end of this file, and must not be.
CREATE OR REPLACE FUNCTION public.dispatch_due_rest_pushes()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row     record;
  v_tried   uuid[] := '{}';
  v_handed  integer;
  v_expired integer;
BEGIN
  WITH late AS (
    SELECT sp.id
      FROM public.scheduled_pushes sp
     WHERE sp.status = 'pending'
       AND sp.fire_at <= now() - interval '60 seconds'
     ORDER BY sp.id
       FOR UPDATE SKIP LOCKED
  )
  UPDATE public.scheduled_pushes sp
     SET status = CASE WHEN sp.canceled_at IS NULL THEN 'expired' ELSE 'canceled' END
    FROM late
   WHERE sp.id = late.id;
  GET DIAGNOSTICS v_expired = ROW_COUNT;

  FOR v_row IN
    SELECT sp.id, sp.user_id, sp.payload, sp.endpoint, sp.fire_at
      FROM public.scheduled_pushes sp
     WHERE sp.status = 'pending'
       AND sp.canceled_at IS NULL
       AND sp.dispatched_at IS NULL
       AND sp.fire_at <= now() + interval '10 seconds'
       AND jsonb_typeof(sp.payload) = 'object'
     ORDER BY sp.fire_at, sp.id
       FOR UPDATE SKIP LOCKED
  LOOP
    v_tried := v_tried || v_row.id;
    BEGIN
      UPDATE public.scheduled_pushes sp
         SET dispatched_at = now()
       WHERE sp.id = v_row.id;
      PERFORM public.send_push_event(
        v_row.user_id,
        v_row.payload,
        jsonb_strip_nulls(jsonb_build_object(
          'schedule_id', v_row.id,
          'not_before',  v_row.fire_at,
          'endpoint',    v_row.endpoint,
          'ttl',         60,
          'urgency',     'high'
        ))
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'send-push hand-over (rest push) failed: %', SQLERRM;
    END;
  END LOOP;

  -- The rows whose mark was not undone.
  SELECT count(*) INTO v_handed
    FROM public.scheduled_pushes sp
   WHERE sp.id = ANY (v_tried)
     AND sp.dispatched_at IS NOT NULL;

  RETURN jsonb_build_object('handed_over', v_handed, 'expired', v_expired);
END;
$$;

-- ============================================================
-- WEB PUSH FOR AN EVENT: ONE WAY OUT OF THE DATABASE
-- (2026_10_13_15_push_plumbing — review P35 and B3, the database's half)
--
-- Eleven functions tell somebody that something happened: six triggers (a
-- session confirmed, an exercise swapped or skipped, "make this permanent",
-- a draft submitted, feedback on a session, a chat message) and five RPCs of
-- the coach (adopt_swap, adopt_skip, decline_promote_request,
-- approve_program, send_back_program). Each writes its bell row itself — the
-- chat message has none — and then asks send_push_event() for the push.
--
--   send_push_event(p_user, p_payload, p_options)
--     → the id pg_net gave the request, or NULL when nothing was queued
--       because the vault is not configured
--
-- It is the ONLY function of this file that reads the vault or calls pg_net
-- (supabase/tests/push-plumbing.test.js refuses a second one):
--
--   where      vault secret app_functions_url, then '/send-push' — the
--              send-push Edge Function
--   who        Authorization: Bearer <vault secret app_internal_bearer>, and
--              while the vault has none of that name, the one stored as
--              app_service_role_key. That older name is misleading: the
--              value is the INTERNAL_BEARER secret of the function, a random
--              string made for this — never the service-role key.
--   how long   10 seconds. pg_net's own default is 2 or 5, depending on its
--              version: less than a cold start of the function plus the
--              round trip to the push service, and pg_net does not try again.
--   what       { "user_id": p_user, "payload": p_payload, "ttl": 86400 }
--              plus the keys of p_options, at the top level. "ttl" is how
--              long, in seconds, the push service keeps the message for a
--              device that is offline (without it: four weeks); a caller
--              that wants another one says so in p_options. "user_id" and
--              "payload" are the two arguments, whatever p_options holds.
--              The payload goes to the service worker as it is.
--
-- pg_net queues the request and sends it once the transaction has committed:
-- a write that is rolled back sends nothing, and what send-push answers is
-- never read here. So the function raises only for what is wrong BEFORE the
-- request exists — an argument that is not what it should be, pg_net or the
-- vault out of reach — and a caller keeps its own net under it:
--
--     BEGIN
--       PERFORM public.send_push_event(v_recipient, jsonb_build_object(
--         'title', …, 'body', …, 'tag', …, 'data', jsonb_build_object('url', …)));
--     EXCEPTION WHEN OTHERS THEN
--       RAISE WARNING 'send-push fan-out (…) failed: %', SQLERRM;
--     END;
--
-- The write that caused the push is never undone for it.
--
-- NOT FOR A SIGNED-IN USER. Whoever may call it can send any text and any
-- link to any account: no EXECUTE for `authenticated` (it is not in the
-- FUNCTION PRIVILEGES block at the end of this file), and SECURITY INVOKER —
-- it is given no right its caller does not have. The eleven functions above
-- are SECURITY DEFINER and call it as their owner, who reads the vault; the
-- service role reads it too. Called from a function that runs with the
-- rights of a signed-in user, it is refused, and that function's net turns
-- the refusal into a warning: no push, and nothing on the screen says why.
--
-- The secrets are set and rotated by hand: docs/runbook/30-edge-functions.md
-- (with vault.update_secret, never UPDATE vault.secrets), and the rename of
-- app_service_role_key in docs/runbook/migrations/15-push-plumbing.md.
-- ============================================================

-- pg_net + vault ship with Supabase but only enable on demand.
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS supabase_vault;

CREATE OR REPLACE FUNCTION public.send_push_event(
  p_user    uuid,
  p_payload jsonb,
  p_options jsonb DEFAULT '{}'::jsonb
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_functions_url text;
  v_bearer        text;
  v_options       jsonb := COALESCE(p_options, '{}'::jsonb);
BEGIN
  IF p_user IS NULL OR p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'send_push_event needs a recipient and a payload that is a JSON object'
      USING ERRCODE = 'invalid_parameter_value',
            HINT = 'Nothing was queued.';
  END IF;
  IF jsonb_typeof(v_options) <> 'object' THEN
    RAISE EXCEPTION 'send_push_event takes its options as a JSON object'
      USING ERRCODE = 'invalid_parameter_value',
            HINT = 'Nothing was queued.';
  END IF;

  SELECT ds.decrypted_secret INTO v_functions_url
    FROM vault.decrypted_secrets ds
   WHERE ds.name = 'app_functions_url';

  -- The bearer under its own name; until the vault has it, under the name it
  -- was first stored with.
  SELECT ds.decrypted_secret INTO v_bearer
    FROM vault.decrypted_secrets ds
   WHERE ds.name = 'app_internal_bearer';
  IF COALESCE(v_bearer, '') = '' THEN
    SELECT ds.decrypted_secret INTO v_bearer
      FROM vault.decrypted_secrets ds
     WHERE ds.name = 'app_service_role_key';
  END IF;

  -- Not configured: no push and no error. The bell row is the caller's, and
  -- it is written either way.
  IF COALESCE(v_functions_url, '') = '' OR COALESCE(v_bearer, '') = '' THEN
    RETURN NULL;
  END IF;

  RETURN net.http_post(
    url     := rtrim(v_functions_url, '/') || '/send-push',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || v_bearer
    ),
    body    := jsonb_build_object('ttl', 86400)
               || (v_options - 'user_id'::text - 'payload'::text)
               || jsonb_build_object('user_id', p_user, 'payload', p_payload),
    timeout_milliseconds := 10000
  );
END;
$$;
-- Who may execute it: nobody but its owner and the service role. It is NOT in
-- the FUNCTION PRIVILEGES block at the end of this file, and must not be.

-- Trigger: the coach's feedback on a session. The bell row, the stamp of the
-- review (sessions.reviewed_at, once), and the push — to the athlete.
CREATE OR REPLACE FUNCTION public.notify_student_on_session_feedback()
RETURNS TRIGGER AS $$
DECLARE
  v_coach_name      text;
  v_session_title   text;
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

  -- Best-effort Web Push, through send_push_event (2026_10_13_15). Whatever
  -- it raises stays a warning: a push never undoes the write that caused it —
  -- the feedback is sent, and the bell row above is written.
  BEGIN
    -- Trim to 200 chars so the encrypted push payload stays under the
    -- 4 KB Web Push limit. iOS only shows ~200 chars on the lock screen.
    v_body_preview := LEFT(BTRIM(NEW.body), 200);

    PERFORM public.send_push_event(
      NEW.recipient_id,
      jsonb_build_object(
        'title', 'Feedback from ' || COALESCE(v_coach_name, 'your coach'),
        'body',  COALESCE(NULLIF(v_body_preview, ''), 'Tap to read your coach''s feedback.'),
        'tag',   'feedback-' || NEW.id::text,
        'data',  jsonb_build_object(
          'url', '/sl_app/#/student/session/' || NEW.session_id::text
        )
      )
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'send-push fan-out failed: %', SQLERRM;
  END;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- The trigger is the one created with the first version of this function,
-- further up (trg_notify_student_on_session_feedback): replacing the function
-- is enough.

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
  v_body_preview    text;
BEGIN
  -- Feedback messages are handled by notify_student_on_session_feedback.
  IF NEW.session_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Best-effort Web Push, through send_push_event (2026_10_13_15). Whatever
  -- it raises stays a warning: a push never undoes the write that caused it —
  -- the message is sent, and the badge of an open tab still updates.
  BEGIN
    -- One lookup covers both ends: the recipient's surface is the
    -- opposite of the sender's role, and the no-name fallback names the
    -- sender's role.
    SELECT p.full_name, p.role INTO v_sender_name, v_sender_role
      FROM public.profiles p
     WHERE p.id = NEW.sender_id;

    v_body_preview := LEFT(BTRIM(NEW.body), 200);

    PERFORM public.send_push_event(
      NEW.recipient_id,
      jsonb_build_object(
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
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'chat push fan-out failed: %', SQLERRM;
  END;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS on_chat_message_push ON public.messages;
CREATE TRIGGER on_chat_message_push
  AFTER INSERT ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_recipient_on_chat_message();

-- ============================================================
-- LOGGED TRAINING IS HISTORY (2026_07_13, completed by 2026_10_11_04)
--
-- A set the athlete logged — public.set_log_is_logged(), in the helper
-- section: done, failed, skipped, an RPE or an actual — or one that carries a
-- video can never be hard-deleted, at any level:
--
--   programs        BEFORE DELETE   trashed (programs.deleted_at) instead
--   weeks           BEFORE DELETE   )
--   sessions        BEFORE DELETE   ) archived (sessions.archived_at) instead
--   exercise_slots  BEFORE DELETE   )
--   set_logs        BEFORE DELETE   the row itself: the net under the four
--                                   above, since a row trigger fires on a
--                                   cascade too — from a students row, a
--                                   profile, an account
--   exercise_slots  BEFORE UPDATE OF sets   the count cannot go below a
--                                   logged prescribed set
--
-- Hard delete is for scaffolding: what nobody trained goes as before.
-- Every message contains 'logged set': the client maps that to
-- errors.hasLoggedTraining ("archive it instead of deleting").
--
-- ONE WAY THROUGH, for the owner of the database, inside a transaction:
--   SET LOCAL app.allow_history_delete = 'on';
-- It replaces "drop the trigger, delete, re-create it". The six guards read
-- it through history_delete_allowed(), which also requires that the statement
-- comes with NO user id — so it does nothing for a signed-in user.
-- (docs/runbook/migrations/04-logged-history-guards.md)
-- ============================================================

-- True only when BOTH hold:
--   * the transaction said  SET LOCAL app.allow_history_delete = 'on'
--   * the statement comes with no user id — the SQL editor, a migration, a
--     function called with the service-role key. A signed-in user's request
--     always carries one, so for the app the setting does nothing, whoever
--     managed to set it.
CREATE OR REPLACE FUNCTION public.history_delete_allowed()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT auth.uid() IS NULL
     AND coalesce(current_setting('app.allow_history_delete', true), '') = 'on'
$$;

CREATE OR REPLACE FUNCTION public.block_program_delete_with_logged_sets()
RETURNS trigger AS $$
DECLARE
  v_count int;
BEGIN
  IF public.history_delete_allowed() THEN
    RETURN OLD;
  END IF;
  SELECT count(*) INTO v_count
    FROM public.set_logs sl
    JOIN public.exercise_slots es ON es.id = sl.exercise_slot_id
    JOIN public.sessions s        ON s.id = es.session_id
    JOIN public.weeks w           ON w.id = s.week_id
   WHERE w.program_id = OLD.id
     AND (public.set_log_is_logged(sl)
          OR EXISTS (SELECT 1 FROM public.set_log_videos v WHERE v.set_log_id = sl.id));
  IF v_count > 0 THEN
    RAISE EXCEPTION
      'program % still has % logged set(s) — move it to the trash instead of deleting',
      OLD.id, v_count;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS block_program_delete_with_logged_sets ON public.programs;
CREATE TRIGGER block_program_delete_with_logged_sets
  BEFORE DELETE ON public.programs
  FOR EACH ROW
  EXECUTE FUNCTION public.block_program_delete_with_logged_sets();

-- Same guard at week + session level: the Program Sheet deletes those
-- directly, and the cascade would otherwise wipe logged set_logs without
-- touching the program row. Coaches archive (sessions.archived_at) instead.
CREATE OR REPLACE FUNCTION public.block_week_delete_with_logged_sets()
RETURNS trigger AS $$
DECLARE
  v_count int;
BEGIN
  IF public.history_delete_allowed() THEN
    RETURN OLD;
  END IF;
  SELECT count(*) INTO v_count
    FROM public.set_logs sl
    JOIN public.exercise_slots es ON es.id = sl.exercise_slot_id
    JOIN public.sessions s        ON s.id = es.session_id
   WHERE s.week_id = OLD.id
     AND (public.set_log_is_logged(sl)
          OR EXISTS (SELECT 1 FROM public.set_log_videos v WHERE v.set_log_id = sl.id));
  IF v_count > 0 THEN
    RAISE EXCEPTION 'week % still has % logged set(s) — archive it instead of deleting', OLD.id, v_count;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS block_week_delete_with_logged_sets ON public.weeks;
CREATE TRIGGER block_week_delete_with_logged_sets
  BEFORE DELETE ON public.weeks
  FOR EACH ROW
  EXECUTE FUNCTION public.block_week_delete_with_logged_sets();

CREATE OR REPLACE FUNCTION public.block_session_delete_with_logged_sets()
RETURNS trigger AS $$
DECLARE
  v_count int;
BEGIN
  IF public.history_delete_allowed() THEN
    RETURN OLD;
  END IF;
  SELECT count(*) INTO v_count
    FROM public.set_logs sl
    JOIN public.exercise_slots es ON es.id = sl.exercise_slot_id
   WHERE es.session_id = OLD.id
     AND (public.set_log_is_logged(sl)
          OR EXISTS (SELECT 1 FROM public.set_log_videos v WHERE v.set_log_id = sl.id));
  IF v_count > 0 THEN
    RAISE EXCEPTION 'session % still has % logged set(s) — archive it instead of deleting', OLD.id, v_count;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS block_session_delete_with_logged_sets ON public.sessions;
CREATE TRIGGER block_session_delete_with_logged_sets
  BEFORE DELETE ON public.sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.block_session_delete_with_logged_sets();

-- "Remove exercise" (2026_10_11_04). A comment or a deviation alone does not
-- hold a slot: the coach removes it on purpose, and those go with it.
CREATE OR REPLACE FUNCTION public.block_slot_delete_with_logged_sets()
RETURNS trigger AS $$
DECLARE
  v_count int;
BEGIN
  IF public.history_delete_allowed() THEN
    RETURN OLD;
  END IF;
  SELECT count(*) INTO v_count
    FROM public.set_logs sl
   WHERE sl.exercise_slot_id = OLD.id
     AND (public.set_log_is_logged(sl)
          OR EXISTS (SELECT 1 FROM public.set_log_videos v WHERE v.set_log_id = sl.id));
  IF v_count > 0 THEN
    RAISE EXCEPTION
      'exercise slot % still has % logged set(s) — archive the session instead of deleting the exercise',
      OLD.id, v_count;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS block_slot_delete_with_logged_sets ON public.exercise_slots;
CREATE TRIGGER block_slot_delete_with_logged_sets
  BEFORE DELETE ON public.exercise_slots
  FOR EACH ROW
  EXECUTE FUNCTION public.block_slot_delete_with_logged_sets();

-- The set (2026_10_11_04): the × of the coach's editor, the rows a lower
-- "Sets" drops, a DELETE sent to the API, and every cascade that reaches this
-- table.
--
-- The exception is the athlete's own extra set: they added it, they may take
-- it back, done or not. During a cascade the slot is already gone and
-- student_profile_for_slot() answers NULL: the exception cannot hide a
-- cascade.
CREATE OR REPLACE FUNCTION public.block_set_log_delete_when_logged()
RETURNS trigger AS $$
BEGIN
  IF NOT (public.set_log_is_logged(OLD)
          OR EXISTS (SELECT 1 FROM public.set_log_videos v WHERE v.set_log_id = OLD.id)) THEN
    RETURN OLD;
  END IF;
  IF OLD.is_student_added
     AND public.student_profile_for_slot(OLD.exercise_slot_id) = auth.uid() THEN
    RETURN OLD;
  END IF;
  IF public.history_delete_allowed() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'set % of exercise slot % is a logged set — it cannot be deleted',
    OLD.set_number, OLD.exercise_slot_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS block_set_log_delete_when_logged ON public.set_logs;
CREATE TRIGGER block_set_log_delete_when_logged
  BEFORE DELETE ON public.set_logs
  FOR EACH ROW
  EXECUTE FUNCTION public.block_set_log_delete_when_logged();

-- "Sets" cannot go below a logged set (2026_10_11_04). A client that lowers a
-- set count in two writes — exercise_slots.sets first, then the DELETE of the
-- prescribed rows numbered above it — would be stopped by the guard above on
-- the second and keep the first: a slot that says 3 sets and holds 5.
-- Refusing the FIRST write leaves nothing changed. Same rows as that DELETE:
-- prescribed (an athlete's extra set is not part of the count), numbered above
-- the new count, logged or with a video.
CREATE OR REPLACE FUNCTION public.block_slot_sets_below_logged_set()
RETURNS trigger AS $$
DECLARE
  v_count int;
BEGIN
  IF public.history_delete_allowed() THEN
    RETURN NEW;
  END IF;
  SELECT count(*) INTO v_count
    FROM public.set_logs sl
   WHERE sl.exercise_slot_id = NEW.id
     AND NOT sl.is_student_added
     AND sl.set_number > NEW.sets
     AND (public.set_log_is_logged(sl)
          OR EXISTS (SELECT 1 FROM public.set_log_videos v WHERE v.set_log_id = sl.id));
  IF v_count > 0 THEN
    RAISE EXCEPTION
      'exercise slot % has % logged set(s) above set % — the set count cannot go below them',
      NEW.id, v_count, NEW.sets;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS block_slot_sets_below_logged_set ON public.exercise_slots;
CREATE TRIGGER block_slot_sets_below_logged_set
  BEFORE UPDATE OF sets ON public.exercise_slots
  FOR EACH ROW
  WHEN (NEW.sets < OLD.sets)
  EXECUTE FUNCTION public.block_slot_sets_below_logged_set();

-- ============================================================
-- THE COACH ↔ ATHLETE LINK (2026_10_11_05_students_role_gate)
--
-- public.students says who coaches whom, and every "Coaches …" policy of
-- this file is written against it: a row that should not exist gives its
-- coach_id the reach of a coach over its profile_id. Three things hold it:
--
--   who writes a row     no INSERT and no DELETE policy; UPDATE for the coach
--                        of the row, who is a coach (STUDENTS, above)
--   what a row may say   trg_check_students_link, for EVERY writer — the SQL
--                        editor and the service role included
--   whose exercises      a slot, and the substitute of a swap, take an
--                        exercise of the library of the program's coach; the
--                        library itself is written by a coach (is_coach())
--
-- A new link is made by the owner of the database:
--   insert into public.students (profile_id, coach_id) values (…, …);
-- (docs/runbook/migrations/05-students-role-gate.md — "Linking an athlete to
-- a coach".)
-- ============================================================

-- What a row of students may say.
--   * a signed-in user cannot move the link: id, profile_id and coach_id stay
--     what they were. Moving an athlete to another coach is done without a
--     user id, where the new link is checked like a new row.
--   * a new link, or one that moves: two different profiles, the coach with
--     the role coach, the athlete with the role student.
--   * a row whose link does not move is not judged again, so a column next to
--     it can always be written.
-- A profile that does not exist is left to the foreign key, which says it
-- better.
CREATE OR REPLACE FUNCTION public.check_students_link()
RETURNS trigger AS $$
DECLARE
  v_role text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF auth.uid() IS NOT NULL
       AND (NEW.id IS DISTINCT FROM OLD.id
            OR NEW.profile_id IS DISTINCT FROM OLD.profile_id
            OR NEW.coach_id IS DISTINCT FROM OLD.coach_id) THEN
      RAISE EXCEPTION 'the coach-athlete link % cannot be changed from the app', OLD.id
        USING ERRCODE = 'insufficient_privilege',
              HINT = 'students.id, profile_id and coach_id are written by the owner of the database only.';
    END IF;
    IF NEW.profile_id IS NOT DISTINCT FROM OLD.profile_id
       AND NEW.coach_id IS NOT DISTINCT FROM OLD.coach_id THEN
      RETURN NEW;
    END IF;
  END IF;

  IF NEW.profile_id = NEW.coach_id THEN
    RAISE EXCEPTION 'students: profile % cannot be its own coach', NEW.coach_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT p.role INTO v_role FROM public.profiles p WHERE p.id = NEW.coach_id;
  IF v_role IS NOT NULL AND v_role <> 'coach' THEN
    RAISE EXCEPTION 'students.coach_id % is not a coach: its profile has the role %', NEW.coach_id, v_role
      USING ERRCODE = 'check_violation',
            HINT = 'Only a profile with the role coach can be given athletes.';
  END IF;

  SELECT p.role INTO v_role FROM public.profiles p WHERE p.id = NEW.profile_id;
  IF v_role IS NOT NULL AND v_role <> 'student' THEN
    RAISE EXCEPTION 'students.profile_id % is not an athlete: its profile has the role %', NEW.profile_id, v_role
      USING ERRCODE = 'check_violation',
            HINT = 'Only a profile with the role student can be linked to a coach.';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

CREATE TRIGGER trg_check_students_link
  BEFORE INSERT OR UPDATE ON public.students
  FOR EACH ROW
  EXECUTE FUNCTION public.check_students_link();

-- A slot takes an exercise of the library of its program's coach — the
-- coach_id of the athlete the program belongs to. Asked when the slot is
-- created or when its exercise changes: after an athlete changed coach, the
-- slots that still hold the former coach's exercises can be edited in every
-- other column, and take an exercise of the new library the day theirs is
-- replaced. For every writer. A session or an exercise that does not exist is
-- left to the foreign key.
CREATE OR REPLACE FUNCTION public.check_slot_exercise_in_coach_library()
RETURNS trigger AS $$
DECLARE
  v_program_coach uuid;
  v_library_coach uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.exercise_id IS NOT DISTINCT FROM OLD.exercise_id THEN
    RETURN NEW;
  END IF;

  SELECT st.coach_id INTO v_program_coach
    FROM public.sessions se
    JOIN public.weeks w     ON w.id = se.week_id
    JOIN public.programs p  ON p.id = w.program_id
    JOIN public.students st ON st.id = p.student_id
   WHERE se.id = NEW.session_id;
  SELECT el.coach_id INTO v_library_coach
    FROM public.exercise_library el
   WHERE el.id = NEW.exercise_id;

  IF v_program_coach IS NOT NULL AND v_library_coach IS NOT NULL
     AND v_library_coach <> v_program_coach THEN
    RAISE EXCEPTION 'exercise % is not in the library of the coach of this program', NEW.exercise_id
      USING ERRCODE = 'check_violation',
            HINT = 'An exercise slot takes an exercise from the library of its athlete''s coach.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

CREATE TRIGGER trg_check_slot_exercise_in_coach_library
  BEFORE INSERT OR UPDATE OF exercise_id ON public.exercise_slots
  FOR EACH ROW
  EXECUTE FUNCTION public.check_slot_exercise_in_coach_library();

-- The substitute of a swap, by the same rule. A skip has none.
--
-- The app saves a deviation as an upsert: INSERT … ON CONFLICT (exercise_slot_id)
-- DO UPDATE. PostgreSQL fires the INSERT trigger on the proposed row first,
-- whether or not the slot already has a deviation. When it has one with this
-- same substitute, the statement can only become the UPDATE of that row (or
-- fail on the unique key) and the substitute does not change: it is not asked
-- again, so that a swap made before a change of coach can still take a note.
CREATE OR REPLACE FUNCTION public.check_deviation_substitute_in_coach_library()
RETURNS trigger AS $$
DECLARE
  v_program_coach uuid;
  v_library_coach uuid;
BEGIN
  IF NEW.substitute_exercise_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.substitute_exercise_id IS NOT DISTINCT FROM OLD.substitute_exercise_id THEN
      RETURN NEW;
    END IF;
  ELSIF EXISTS (
    SELECT 1 FROM public.slot_deviations d
     WHERE d.exercise_slot_id = NEW.exercise_slot_id
       AND d.substitute_exercise_id = NEW.substitute_exercise_id
  ) THEN
    RETURN NEW;
  END IF;

  SELECT st.coach_id INTO v_program_coach
    FROM public.exercise_slots es
    JOIN public.sessions se ON se.id = es.session_id
    JOIN public.weeks w     ON w.id = se.week_id
    JOIN public.programs p  ON p.id = w.program_id
    JOIN public.students st ON st.id = p.student_id
   WHERE es.id = NEW.exercise_slot_id;
  SELECT el.coach_id INTO v_library_coach
    FROM public.exercise_library el
   WHERE el.id = NEW.substitute_exercise_id;

  IF v_program_coach IS NOT NULL AND v_library_coach IS NOT NULL
     AND v_library_coach <> v_program_coach THEN
    RAISE EXCEPTION 'substitute exercise % is not in the library of the coach of this program', NEW.substitute_exercise_id
      USING ERRCODE = 'check_violation',
            HINT = 'A swap takes an exercise from the library of the athlete''s coach.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

CREATE TRIGGER trg_check_deviation_substitute_in_coach_library
  BEFORE INSERT OR UPDATE OF substitute_exercise_id ON public.slot_deviations
  FOR EACH ROW
  EXECUTE FUNCTION public.check_deviation_substitute_in_coach_library();

-- Moving an athlete to another coach (2026_10_13_10, review P21): the link
-- and the goals, together. students.coach_id says who coaches the athlete,
-- goals.coach_id who manages each of their goals, and the policies on goals
-- and on goal_progress ask for both — moved one without the other, the goals
-- are managed by nobody.
--
--   p_student     the PROFILE id of the athlete (what auth.users, profiles
--                 and goals.student_id hold) — not the id of the students row
--   p_new_coach   the profile id of the coach they go to
--
--   select public.transfer_student(athlete.id, coach.id)
--     from auth.users athlete, auth.users coach
--    where athlete.email = '…' and coach.email = '…';
-- (docs/runbook/migrations/10-goals-fk-coach-links.md — "Moving an athlete to
-- another coach".)
--
-- Called with the coach the athlete already has, it moves no link and hands
-- over the goals that were left with a former coach.
--
-- NOT FOR A SIGNED-IN USER, three times over: no EXECUTE for `authenticated`
-- (it is not in the FUNCTION PRIVILEGES block: the owner and the service role
-- call it); its first lines refuse a request that carries a user id; and
-- trg_check_students_link, above, refuses with a user id any UPDATE that
-- moves a link. SECURITY INVOKER for the same reason: it is given no right
-- its caller does not have.
--
-- The new coach must be a profile with the role coach, and not the athlete
-- themselves: that is trg_check_students_link's to say (23514). A profile
-- that does not exist is the foreign key's (23503).
--
-- It does NOT move the exercises: the slots of the athlete's programs and
-- their goals keep pointing at the library of the former coach. A table that
-- gets a coach_id next to a student_id joins the body of this function, or
-- says why it stays with the former coach.
CREATE OR REPLACE FUNCTION public.transfer_student(p_student uuid, p_new_coach uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_link_id    uuid;
  v_from_coach uuid;
  v_goals      integer;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'an athlete is moved to another coach by the owner of the database, not from the app'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'transfer_student is called from the SQL editor or with the service-role key.';
  END IF;

  IF p_student IS NULL OR p_new_coach IS NULL THEN
    RAISE EXCEPTION 'transfer_student needs the profile id of the athlete and of the new coach'
      USING ERRCODE = 'null_value_not_allowed',
            HINT = 'One of the two is NULL: an e-mail address that is not an account gives no id.';
  END IF;

  -- The row is held until the end of the transaction: two transfers of the
  -- same athlete wait for each other.
  SELECT s.id, s.coach_id INTO v_link_id, v_from_coach
    FROM public.students s
   WHERE s.profile_id = p_student
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile % is not the athlete of a coach: there is no link to move', p_student
      USING ERRCODE = 'no_data_found',
            HINT = 'A first link is made with: insert into public.students (profile_id, coach_id) values (…, …).';
  END IF;

  IF v_from_coach IS DISTINCT FROM p_new_coach THEN
    UPDATE public.students
       SET coach_id = p_new_coach
     WHERE id = v_link_id;
  END IF;

  UPDATE public.goals
     SET coach_id = p_new_coach
   WHERE student_id = p_student
     AND coach_id IS DISTINCT FROM p_new_coach;
  GET DIAGNOSTICS v_goals = ROW_COUNT;

  RETURN jsonb_build_object(
    'student_id',    p_student,
    'from_coach_id', v_from_coach,
    'to_coach_id',   p_new_coach,
    'link_moved',    v_from_coach IS DISTINCT FROM p_new_coach,
    'goals_moved',   v_goals
  );
END;
$$;

-- ============================================================
-- Client error telemetry (2026_07_13)
-- Insert-only per authenticated user (own errors), 30 an hour at most
-- (trg_cap_client_errors). Read by its author and the coach of its author
-- for in-app triage; a line without an author — written by the database
-- (role 'database', migration 19), or of an account that was deleted — by
-- every coach (2026_10_16_22, review B6, L20). No UPDATE/DELETE —
-- append-only. Rows older than 90 days are deleted by public.run_retention()
-- (RETENTION, further down; 2026_10_13_18_retention).
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
-- The foreign key, and the hour trg_cap_client_errors counts (2026_10_16_24).
CREATE INDEX client_errors_user_created_idx
  ON public.client_errors (user_id, created_at DESC);

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

-- "Is a coach" is asked of profiles here, not with is_coach(): a SELECT goes
-- through this policy (supabase/migrations/README.md, migration 05).
CREATE POLICY "Authors and their coach read client errors"
  ON public.client_errors FOR SELECT
  USING (
    user_id = (SELECT auth.uid())
    OR user_id IN (SELECT s.profile_id FROM public.students s WHERE s.coach_id = (SELECT auth.uid()))
    OR (
      user_id IS NULL
      AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = (SELECT auth.uid()) AND p.role = 'coach')
    )
  );

-- A request that carries a user id (2026_10_16_22, review L20): the line is
-- dated when it arrives — a date sent by the client would take it out of the
-- hour counted here, and out of reach of run_retention() — and dropped
-- without a word when the caller has 30 lines of the last hour already. A
-- request without a user id is not judged: the owner, the service role, the
-- job of migration 19, a restore. Counted by auth.uid(): the INSERT policy
-- holds user_id to it. Two requests in the same instant can both pass at 29:
-- a ceiling of about 30, not a count. Nothing old is deleted here:
-- run_retention() does, in the one place that deletes by age.
-- SECURITY DEFINER: it counts the caller's lines whatever the caller may read.
CREATE OR REPLACE FUNCTION public.cap_client_errors()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  NEW.created_at := now();

  IF (SELECT count(*)
        FROM (SELECT 1
                FROM public.client_errors e
               WHERE e.user_id = auth.uid()
                 AND e.created_at > now() - interval '1 hour'
               LIMIT 30) recent) >= 30 THEN
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$$;
-- Who may execute it: nobody — a trigger function (the FUNCTION PRIVILEGES
-- block at the end of this file).

DROP TRIGGER IF EXISTS trg_cap_client_errors ON public.client_errors;
CREATE TRIGGER trg_cap_client_errors
  BEFORE INSERT ON public.client_errors
  FOR EACH ROW EXECUTE FUNCTION public.cap_client_errors();

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

-- ============================================================
-- Stage 4: moving a session BETWEEN phases (weeks) of a block.
--
-- Until now this was impossible. The editor's "copy to…" duplicated a session
-- into another week and left the original behind; nothing moved one. Once the
-- sheet renders a block as ONE list with phase dividers, dragging a session
-- across a divider is the obvious gesture — and it is two writes that must not
-- be separable: re-homing the row (`week_id`) and renumbering BOTH weeks.
--
-- Split across two client round trips, a failure between them strands the
-- session: re-homed but holding a position that collides in its new week, or
-- renumbered out of a week it no longer belongs to. One statement, one
-- transaction.
--
-- SECURITY INVOKER, deliberately: the `Coaches manage sessions` policy is FOR
-- ALL on `week_id IN (…the coach's weeks…)`, so this rides the caller's own
-- RLS and adds no trust surface. A definer would have to re-implement that
-- ownership walk, which is exactly the duplication the SECURITY DEFINER
-- helpers exist to avoid.
--
-- The caller passes the FULL ordered id list for each affected week AFTER the
-- move — the same contract as `useReorderSessions`, so the ordering logic
-- lives in one place (the client, which is holding the list).
-- ============================================================

CREATE OR REPLACE FUNCTION public.move_session(
  p_session_id   uuid,
  p_dest_week_id uuid,
  p_source_ids   uuid[],
  p_dest_ids     uuid[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_src_week uuid;
BEGIN
  SELECT week_id INTO v_src_week FROM public.sessions WHERE id = p_session_id;
  IF v_src_week IS NULL THEN
    RAISE EXCEPTION 'session_not_found';
  END IF;

  -- A block is the unit being reordered; moving a session into another
  -- athlete's program (or another block) is a COPY, not a drag.
  IF (SELECT program_id FROM public.weeks WHERE id = p_dest_week_id)
     IS DISTINCT FROM
     (SELECT program_id FROM public.weeks WHERE id = v_src_week) THEN
    RAISE EXCEPTION 'cross_program_move';
  END IF;

  -- Park every involved row at a value unique across BOTH weeks before any
  -- final position is written. A per-week offset is not enough here: the moved
  -- row changes week mid-statement, so a parked source position can land on a
  -- parked destination position that happens to share the same number.
  WITH involved AS (
    SELECT id, row_number() OVER (ORDER BY id) AS n
      FROM public.sessions
     WHERE id = ANY(p_source_ids) OR id = ANY(p_dest_ids) OR id = p_session_id
  )
  UPDATE public.sessions s
     SET sort_order = 100000 + i.n
    FROM involved i
   WHERE s.id = i.id;

  -- Re-home, then place both weeks at 0..n-1.
  UPDATE public.sessions SET week_id = p_dest_week_id WHERE id = p_session_id;

  UPDATE public.sessions s
     SET sort_order = t.idx - 1
    FROM unnest(p_source_ids) WITH ORDINALITY AS t(id, idx)
   WHERE s.id = t.id;

  UPDATE public.sessions s
     SET sort_order = t.idx - 1
    FROM unnest(p_dest_ids) WITH ORDINALITY AS t(id, idx)
   WHERE s.id = t.id;
END;
$$;

-- ============================================================
-- A block is activated, and sessions and phases are reordered, in one
-- request each (2026_10_13_11_activate_reorder_rpcs, review P16 and P51).
--
-- Each of the three was several requests of the app, and each request is a
-- transaction of its own: "Set active" switched the athlete's active program
-- off, then the chosen one on — and left the athlete with NO block when the
-- second request was lost; a reorder parked every session (or phase) at
-- 100000 + its place, then gave each its place, one request per row and per
-- pass — and left rows at 100000 and more when it was interrupted. A
-- function call is one statement: it happens completely or not at all.
--
-- SECURITY INVOKER, all three, like move_session above: they are given no
-- right their caller does not have. The coach's policies are what lets the
-- coach through; an athlete reads their own programs and writes none of
-- this.
--
-- The app that was deployed before wave 2 does not call them and goes on
-- with its own requests, which the policies still accept.
-- ============================================================

-- ------------------------------------------------------------
-- 1. One block is being trained: the one the coach chose.
-- ------------------------------------------------------------
-- programs_one_active_per_student lets an athlete have ONE active program,
-- so making another one active is two writes: the others off, this one on.
-- Here they are one statement of the caller, and so one transaction: both
-- happen, or neither.
--
--   returns   { "program_id", "student_id", "already_active", "deactivated" }
--             already_active  it was the active one: nothing was activated
--             deactivated     how many other programs were switched off
--
--   refuses   program_not_found   no program with this id that the caller can
--                                 read — somebody else's athlete and no such
--                                 program are the same answer
--             not authorized      (42501) the caller reads the program and
--                                 may not write it: its athlete
--             program_is_draft    a draft is approved first (approve_program);
--                                 it could not be active anyway
--                                 (programs_draft_not_active)
--             program_in_trash    it is restored first: every surface leaves
--                                 a program in the trash out, and an athlete
--                                 writes nothing in one
--   … and has then written nothing. Called for the program that is active
--   already, it writes nothing either and says so: a request that is sent
--   twice is not an error.
--
-- EVERY other active program of the athlete is switched off, whatever else
-- it is — also one that sits in the trash and still holds the place, which
-- no screen shows and no screen can switch off.
--
-- The programs of the athlete are locked first, in the order of their ids:
-- two activations for one athlete wait for each other. Without it the second
-- one does not see the program the first one has just made active, and ends
-- on the unique index.
--
-- SECURITY INVOKER: "Coaches manage programs" is what lets the coach write.
-- The lock is asked the way an UPDATE is (FOR NO KEY UPDATE goes through the
-- policies of UPDATE), so a caller who may only read finds no row to hold.
CREATE OR REPLACE FUNCTION public.activate_program(p_program_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_student_id  uuid;
  v_status      text;
  v_deleted_at  timestamptz;
  v_was_active  boolean;
  v_deactivated integer;
BEGIN
  SELECT p.student_id INTO v_student_id
    FROM public.programs p
   WHERE p.id = p_program_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'program_not_found'
      USING DETAIL = 'No program with this id can be read by the caller.',
            HINT = 'Nothing was changed.';
  END IF;

  PERFORM 1
     FROM public.programs p
    WHERE p.student_id = v_student_id
    ORDER BY p.id
      FOR NO KEY UPDATE;

  -- Read again, now that nothing can change it.
  SELECT p.status, p.deleted_at, p.is_active
    INTO v_status, v_deleted_at, v_was_active
    FROM public.programs p
   WHERE p.id = p_program_id
     FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not authorized'
      USING ERRCODE = 'insufficient_privilege',
            DETAIL = 'The caller reads this program and may not write it.',
            HINT = 'A program is activated by the coach of its athlete. Nothing was changed.';
  END IF;

  IF v_status = 'draft' THEN
    RAISE EXCEPTION 'program_is_draft'
      USING DETAIL = 'A draft is never the active program.',
            HINT = 'Approve it first. Nothing was changed.';
  END IF;
  IF v_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'program_in_trash'
      USING DETAIL = 'A program in the trash is never the active program.',
            HINT = 'Restore it first. Nothing was changed.';
  END IF;

  UPDATE public.programs p
     SET is_active = false
   WHERE p.student_id = v_student_id
     AND p.is_active
     AND p.id <> p_program_id;
  GET DIAGNOSTICS v_deactivated = ROW_COUNT;

  IF NOT v_was_active THEN
    UPDATE public.programs p
       SET is_active = true
     WHERE p.id = p_program_id;
  END IF;

  RETURN jsonb_build_object(
    'program_id',     p_program_id,
    'student_id',     v_student_id,
    'already_active', v_was_active,
    'deactivated',    v_deactivated
  );
END;
$$;

-- Who may execute it: the FUNCTION PRIVILEGES block at the end of this file.

-- ------------------------------------------------------------
-- 2. The sessions of a phase, in the order of a list.
-- ------------------------------------------------------------
-- sessions.sort_order is the order of a phase, for the coach's sheet and for
-- the athlete's queue, and (week_id, sort_order) is unique and NOT
-- deferrable: PostgreSQL checks it row by row, so two sessions cannot simply
-- exchange their numbers. Every session is parked above every number the
-- phase holds, then given its place — here in one statement of the caller.
--
--   p_ids     EVERY session of the phase, once each, in the order wanted —
--             the archived ones included: the unique key counts them too
--   result    sort_order 0 to n-1, in the order of the list. A phase that an
--             interrupted reorder left at 100000 and more is put right by
--             the same call.
--
--   refuses   week_not_found         no phase with this id that the caller
--                                    can read
--             not authorized         (42501) the caller reads the phase and
--                                    may not write it: its athlete
--             reorder_ids_mismatch   the list is not exactly the sessions of
--                                    the phase: one is missing, one is not of
--                                    this phase, one is there twice or is
--                                    NULL. The DETAIL counts each. It is what
--                                    a page that was loaded before a session
--                                    was added, moved or deleted sends: read
--                                    again, then try again.
--   … and has then written nothing. A list that is the order the phase has
--   already writes nothing either.
--
-- The phase is locked FOR UPDATE first: two reorders of one phase wait for
-- each other, and a session that is being added or moved INTO the phase
-- waits too (its foreign key asks for the row) — so the list is judged
-- against the sessions that are there when the numbers are written. The
-- sessions are then locked in the order of their ids: none is deleted or
-- moved away in between.
--
-- SECURITY INVOKER: "Coaches manage weeks" and "Coaches manage sessions" are
-- what lets the coach write; the author of a draft reorders it through the
-- policies of a draft.
CREATE OR REPLACE FUNCTION public.reorder_sessions(p_week_id uuid, p_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ids      uuid[] := COALESCE(p_ids, '{}');
  v_children integer;
  v_top      integer;
  v_listed   integer;
  v_distinct integer;
  v_found    integer;
  v_parked   integer;
BEGIN
  PERFORM 1 FROM public.weeks w WHERE w.id = p_week_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'week_not_found'
      USING DETAIL = 'No phase with this id can be read by the caller.',
            HINT = 'Nothing was changed.';
  END IF;

  PERFORM 1 FROM public.weeks w WHERE w.id = p_week_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not authorized'
      USING ERRCODE = 'insufficient_privilege',
            DETAIL = 'The caller reads this phase and may not write it.',
            HINT = 'Sessions are reordered by the coach of the athlete. Nothing was changed.';
  END IF;

  PERFORM 1
     FROM public.sessions s
    WHERE s.week_id = p_week_id
    ORDER BY s.id
      FOR UPDATE;

  SELECT count(*), COALESCE(max(s.sort_order), 0)
    INTO v_children, v_top
    FROM public.sessions s
   WHERE s.week_id = p_week_id;

  SELECT count(*), count(DISTINCT t.id), count(DISTINCT s.id)
    INTO v_listed, v_distinct, v_found
    FROM unnest(v_ids) AS t(id)
    LEFT JOIN public.sessions s ON s.id = t.id AND s.week_id = p_week_id;

  IF v_found <> v_children OR v_distinct <> v_found OR v_listed <> v_distinct THEN
    RAISE EXCEPTION 'reorder_ids_mismatch'
      USING DETAIL = format(
              'The phase has %s session(s), archived ones included. The list holds %s id(s): '
              || '%s session(s) of the phase are missing from it, %s id(s) are not sessions of this phase, '
              || '%s are there twice or empty.',
              v_children, v_listed, v_children - v_found, v_distinct - v_found, v_listed - v_distinct),
            HINT = 'Send every session of the phase once, archived ones included, in the order wanted. Nothing was changed.';
  END IF;

  -- Already in that order, and numbered 0 to n-1: nothing to write.
  IF NOT EXISTS (
    SELECT 1
      FROM unnest(v_ids) WITH ORDINALITY AS t(id, place)
      JOIN public.sessions s ON s.id = t.id
     WHERE s.sort_order <> t.place - 1
  ) THEN
    RETURN;
  END IF;

  -- Park: above every number the phase holds — so that no parked session
  -- meets one that has not moved yet — and above n, so that no place given
  -- below meets a session that is still parked.
  v_top := GREATEST(v_top, v_children);
  UPDATE public.sessions s
     SET sort_order = (v_top + t.place)::integer
    FROM unnest(v_ids) WITH ORDINALITY AS t(id, place)
   WHERE s.id = t.id;
  GET DIAGNOSTICS v_parked = ROW_COUNT;
  IF v_parked <> v_children THEN
    RAISE EXCEPTION 'not authorized'
      USING ERRCODE = 'insufficient_privilege',
            DETAIL = format('The caller may write %s of the %s session(s) of this phase.', v_parked, v_children),
            HINT = 'Nothing was changed.';
  END IF;

  -- Place.
  UPDATE public.sessions s
     SET sort_order = (t.place - 1)::integer
    FROM unnest(v_ids) WITH ORDINALITY AS t(id, place)
   WHERE s.id = t.id;
END;
$$;

-- Who may execute it: the FUNCTION PRIVILEGES block at the end of this file.

-- ------------------------------------------------------------
-- 3. The phases of a block, in the order of a list.
-- ------------------------------------------------------------
-- The same, one level up: weeks.week_number is the order of the phases of a
-- program (never shown; adopt_swap and adopt_skip read "later in the
-- program" off it), and (program_id, week_number) is unique and not
-- deferrable.
--
--   p_ids     EVERY phase of the program, once each, in the order wanted
--   result    week_number 1 to n, in the order of the list
--
--   refuses   program_not_found      no program with this id that the caller
--                                    can read
--             not authorized         (42501) the caller reads the program and
--                                    may not write it: its athlete
--             reorder_ids_mismatch   the list is not exactly the phases of
--                                    the program
--   … and has then written nothing.
--
-- The program is locked FOR UPDATE first — two reorders of one block wait
-- for each other, and so does a phase that is being added — then its phases,
-- in the order of their ids.
--
-- SECURITY INVOKER: "Coaches manage programs" and "Coaches manage weeks" are
-- what lets the coach write.
CREATE OR REPLACE FUNCTION public.reorder_weeks(p_program_id uuid, p_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ids      uuid[] := COALESCE(p_ids, '{}');
  v_children integer;
  v_top      integer;
  v_listed   integer;
  v_distinct integer;
  v_found    integer;
  v_parked   integer;
BEGIN
  PERFORM 1 FROM public.programs p WHERE p.id = p_program_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'program_not_found'
      USING DETAIL = 'No program with this id can be read by the caller.',
            HINT = 'Nothing was changed.';
  END IF;

  PERFORM 1 FROM public.programs p WHERE p.id = p_program_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not authorized'
      USING ERRCODE = 'insufficient_privilege',
            DETAIL = 'The caller reads this program and may not write it.',
            HINT = 'Phases are reordered by the coach of the athlete. Nothing was changed.';
  END IF;

  PERFORM 1
     FROM public.weeks w
    WHERE w.program_id = p_program_id
    ORDER BY w.id
      FOR UPDATE;

  SELECT count(*), COALESCE(max(w.week_number), 0)
    INTO v_children, v_top
    FROM public.weeks w
   WHERE w.program_id = p_program_id;

  SELECT count(*), count(DISTINCT t.id), count(DISTINCT w.id)
    INTO v_listed, v_distinct, v_found
    FROM unnest(v_ids) AS t(id)
    LEFT JOIN public.weeks w ON w.id = t.id AND w.program_id = p_program_id;

  IF v_found <> v_children OR v_distinct <> v_found OR v_listed <> v_distinct THEN
    RAISE EXCEPTION 'reorder_ids_mismatch'
      USING DETAIL = format(
              'The program has %s phase(s). The list holds %s id(s): '
              || '%s phase(s) of the program are missing from it, %s id(s) are not phases of this program, '
              || '%s are there twice or empty.',
              v_children, v_listed, v_children - v_found, v_distinct - v_found, v_listed - v_distinct),
            HINT = 'Send every phase of the program once, in the order wanted. Nothing was changed.';
  END IF;

  -- Already in that order, and numbered 1 to n: nothing to write.
  IF NOT EXISTS (
    SELECT 1
      FROM unnest(v_ids) WITH ORDINALITY AS t(id, place)
      JOIN public.weeks w ON w.id = t.id
     WHERE w.week_number <> t.place
  ) THEN
    RETURN;
  END IF;

  -- Park above every number the program holds and above n, then place.
  v_top := GREATEST(v_top, v_children);
  UPDATE public.weeks w
     SET week_number = (v_top + t.place)::integer
    FROM unnest(v_ids) WITH ORDINALITY AS t(id, place)
   WHERE w.id = t.id;
  GET DIAGNOSTICS v_parked = ROW_COUNT;
  IF v_parked <> v_children THEN
    RAISE EXCEPTION 'not authorized'
      USING ERRCODE = 'insufficient_privilege',
            DETAIL = format('The caller may write %s of the %s phase(s) of this program.', v_parked, v_children),
            HINT = 'Nothing was changed.';
  END IF;

  UPDATE public.weeks w
     SET week_number = t.place::integer
    FROM unnest(v_ids) WITH ORDINALITY AS t(id, place)
   WHERE w.id = t.id;
END;
$$;

-- Who may execute it: the FUNCTION PRIVILEGES block at the end of this file.

-- ============================================================
-- A session, a phase and a block are duplicated, and sessions are copied
-- into another phase, in one request each (2026_10_13_12_copy_rpcs, review
-- P52).
--
-- "Duplicate" and "Copy to…" were done by the app, one request per row or
-- per table — the session, then its exercises, then their sets, and for a
-- block the same again for every phase and session of it: thirty to forty
-- requests, each a transaction of its own. A request lost half-way left a
-- session with no exercise, or exercises with no set, in the block the
-- athlete trains. A function call is one statement: the copy is whole, or it
-- is not there.
--
-- WHAT A COPY IS. The prescription, and nothing of what was trained:
--   a session    its title and its recommended weekday. Not its recommended
--                date, not its review, not the day it was trained. A phase
--                or a block that is duplicated keeps its archived sessions
--                archived; a session that is copied on its own arrives live.
--   an exercise  everything the coach wrote: the exercise, the number of
--                sets, the slot's own numbers, its place, its superset, its
--                note, the sets to film.
--   a set        its number and its four targets. Not done, failed, skipped,
--                the RPE, the weight, the actuals, the times — and not the
--                sets the athlete added themselves.
--   never        a note or a swap of the athlete, a video, a confirmation.
--
-- AN EXERCISE OF ANOTHER COACH'S LIBRARY is left out, and the answer says
-- how many were (slots_left_out): a slot takes an exercise of the library of
-- its program's coach (trg_check_slot_exercise_in_coach_library, above), and
-- an athlete who changed coach still has blocks written with the former
-- coach's exercises.
--
-- SECURITY INVOKER, all four, like move_session, activate_program and the
-- two reorder functions: they are given no right their caller does not
-- have. What is copied is what the caller can READ; where it goes is where
-- the caller can WRITE.
--
-- The app that was deployed before wave 2 does not call them and goes on
-- with its own requests, which the policies still accept.
-- ============================================================

-- ------------------------------------------------------------
-- HOW THE FOUR ARE WRITTEN. Each one, in this order:
--
--   finds     the thing to copy, as its caller reads it, and the place the
--             copy goes to. One the caller cannot read is "not found" —
--             somebody else's athlete and a wrong id are the same answer.
--   locks     the place: the phase and its sessions, or the program and its
--             phases, from the top down, as reorder_sessions and
--             reorder_weeks do (FOR UPDATE goes through the policies of
--             UPDATE: a caller who may only read finds no row to hold, and
--             is told "not authorized", 42501). Two copies into one place
--             wait for each other.
--   reads     everything that is copied — sessions, exercises, sets — in ONE
--             statement, so that the copy is the block as it was at one
--             instant, whatever its coach is doing to it in another tab.
--   plans     the sessions to make, in arrays: the one each is a copy of,
--             its new id, its phase, its place, its title, whether it is
--             archived. This is where the four differ.
--   copies    between the two marks `>>> the copy` and `<<< the copy`: the
--             SAME lines in the four functions, in this file and in
--             the migration (supabase/tests/copy-rpcs.test.js compares them).
--             Three INSERTs, written from what was read: the sessions, the
--             exercises that are in the library of the coach of the place,
--             the prescribed sets of those exercises. A column added to one
--             of the three tables is added there, or decided against, in
--             all of them at once.
--
-- They refuse with P0001 and a fixed word for a message — the API answers
-- 400 — and the sentences are in DETAIL and HINT:
--   session_not_found, week_not_found, program_not_found, student_not_found
--                         nothing with this id that the caller can read
--   not authorized        (42501) the caller reads the place and may not
--                         write it
--   copy_source_changed   what was to be copied was deleted or moved while
--                         the call waited for the place: read again, then
--                         try again
-- … and have then written nothing.
--
-- They answer a jsonb object: the id of what was made under a fixed key, how
-- much was made, and slots_left_out. Keys are added, never renamed.
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- 1. A copy of one session, right after it.
-- ------------------------------------------------------------
--   p_title_suffix   what is added to the title: ' (copy)' unless the app
--                    says otherwise (it sends the word in the coach's
--                    language). A session without a title is called
--                    'Session' first, as the app does. With '' or NULL the
--                    title is copied as it is — also when there is none.
--
--   returns   { "session_id", "week_id", "sort_order", "title",
--               "slots", "set_logs", "slots_left_out" }
--
--   refuses   session_not_found, not authorized, copy_source_changed
--
-- The copy takes the place after its source (sort_order + 1). When that
-- place is taken, every session after the source moves down by one:
-- sessions_week_sort_order_unique is not deferrable and is checked row by
-- row, so they are parked above every number the phase holds first, then
-- placed. Archived sessions are sessions of the phase like the others.
--
-- The copy is never archived, whatever its source is: it was asked for.
CREATE OR REPLACE FUNCTION public.duplicate_session(
  p_session_id   uuid,
  p_title_suffix text DEFAULT ' (copy)'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_suffix       text := COALESCE(p_title_suffix, '');
  v_week_id      uuid;
  v_place        integer;
  v_tail         integer;
  v_top          integer;
  v_moved        integer;
  v_dest_coach   uuid;
  -- What is copied, read in one statement.
  v_sessions     public.sessions[];
  v_slots        public.exercise_slots[];
  v_sets         public.set_logs[];
  -- The sessions to make: the one each is a copy of, its id, its phase, its
  -- place, its title, whether it is archived.
  v_from         uuid[];
  v_new          uuid[];
  v_week         uuid[];
  v_order        integer[];
  v_title        text[];
  v_archived     timestamptz[];
  -- The exercises to make: their session, the one each is a copy of, its id.
  v_slot_session uuid[];
  v_slot_from    uuid[];
  v_slot_new     uuid[];
  v_made_slots   integer;
  v_made_sets    integer;
  v_left_out     integer;
BEGIN
  SELECT s.week_id INTO v_week_id
    FROM public.sessions s
   WHERE s.id = p_session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'session_not_found'
      USING DETAIL = 'No session with this id can be read by the caller.',
            HINT = 'Nothing was changed.';
  END IF;

  PERFORM 1 FROM public.weeks w WHERE w.id = v_week_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not authorized'
      USING ERRCODE = 'insufficient_privilege',
            DETAIL = 'The caller reads this session and may not write its phase.',
            HINT = 'A session is duplicated by the coach of the athlete. Nothing was changed.';
  END IF;

  PERFORM 1
     FROM public.sessions s
    WHERE s.week_id = v_week_id
    ORDER BY s.id
      FOR UPDATE;

  -- Whose library the exercises of the copy must be in.
  SELECT st.coach_id INTO v_dest_coach
    FROM public.weeks w
    JOIN public.programs p  ON p.id = w.program_id
    JOIN public.students st ON st.id = p.student_id
   WHERE w.id = v_week_id;
  IF v_dest_coach IS NULL THEN
    RAISE EXCEPTION 'not authorized'
      USING ERRCODE = 'insufficient_privilege',
            DETAIL = 'The caller cannot read whose athlete this phase belongs to.',
            HINT = 'Nothing was changed.';
  END IF;

  -- Read: the session — where it was found, now that nothing can move it —
  -- its exercises, and their prescribed sets.
  SELECT ARRAY(SELECT s FROM public.sessions s
                WHERE s.id = p_session_id AND s.week_id = v_week_id),
         ARRAY(SELECT es FROM public.exercise_slots es
                WHERE es.session_id = p_session_id),
         ARRAY(SELECT sl
                 FROM public.set_logs sl
                 JOIN public.exercise_slots es ON es.id = sl.exercise_slot_id
                WHERE es.session_id = p_session_id
                  AND NOT sl.is_student_added)
    INTO v_sessions, v_slots, v_sets;
  IF cardinality(v_sessions) = 0 THEN
    RAISE EXCEPTION 'copy_source_changed'
      USING DETAIL = 'The session was deleted or moved to another phase while the call waited.',
            HINT = 'Read the block again, then try again. Nothing was changed.';
  END IF;

  -- Make room after the source.
  v_place := (v_sessions[1]).sort_order + 1;
  IF EXISTS (SELECT 1 FROM public.sessions s
              WHERE s.week_id = v_week_id AND s.sort_order = v_place) THEN
    SELECT count(*), max(s.sort_order) INTO v_tail, v_top
      FROM public.sessions s
     WHERE s.week_id = v_week_id AND s.sort_order >= v_place;

    -- Park: above every number the phase holds, and above every place given
    -- below (the highest is v_top + 1).
    UPDATE public.sessions s
       SET sort_order = s.sort_order + (v_top - v_place + 2)
     WHERE s.week_id = v_week_id AND s.sort_order >= v_place;
    GET DIAGNOSTICS v_moved = ROW_COUNT;
    IF v_moved <> v_tail THEN
      RAISE EXCEPTION 'not authorized'
        USING ERRCODE = 'insufficient_privilege',
              DETAIL = format('The caller may write %s of the %s session(s) that follow this one.', v_moved, v_tail),
              HINT = 'Nothing was changed.';
    END IF;

    -- Place: one further down than they were.
    UPDATE public.sessions s
       SET sort_order = s.sort_order - (v_top - v_place + 2) + 1
     WHERE s.week_id = v_week_id AND s.sort_order > v_top + 1;
  END IF;

  -- Plan: one session.
  v_from     := ARRAY[p_session_id];
  v_new      := ARRAY[gen_random_uuid()];
  v_week     := ARRAY[v_week_id];
  v_order    := ARRAY[v_place];
  v_title    := ARRAY[CASE WHEN v_suffix = '' THEN (v_sessions[1]).title
                           ELSE COALESCE(NULLIF(btrim((v_sessions[1]).title), ''), 'Session') || v_suffix
                      END];
  v_archived := ARRAY[NULL::timestamptz];

  -- >>> the copy
  -- The sessions.
  INSERT INTO public.sessions (id, week_id, day_number, title, sort_order, archived_at)
  SELECT m.new_id, m.week_id, s.day_number, m.title, m.sort_order, m.archived_at
    FROM unnest(v_from, v_new, v_week, v_order, v_title, v_archived)
           AS m (from_id, new_id, week_id, sort_order, title, archived_at)
    JOIN unnest(v_sessions) AS s ON s.id = m.from_id;

  -- Their exercises: one per exercise of the source — kept when it is in the
  -- library of the coach of the place (trg_check_slot_exercise_in_coach_library
  -- would refuse the others, and the whole copy with them), counted otherwise.
  SELECT COALESCE(array_agg(k.session_id ORDER BY k.new_id) FILTER (WHERE k.kept), '{}'),
         COALESCE(array_agg(k.from_id    ORDER BY k.new_id) FILTER (WHERE k.kept), '{}'),
         COALESCE(array_agg(k.new_id     ORDER BY k.new_id) FILTER (WHERE k.kept), '{}'),
         count(*) FILTER (WHERE NOT k.kept)
    INTO v_slot_session, v_slot_from, v_slot_new, v_left_out
    FROM (
      SELECT m.new_id AS session_id, es.id AS from_id, gen_random_uuid() AS new_id,
             EXISTS (SELECT 1 FROM public.exercise_library el
                      WHERE el.id = es.exercise_id AND el.coach_id = v_dest_coach) AS kept
        FROM unnest(v_from, v_new) AS m (from_id, new_id)
        JOIN unnest(v_slots) AS es ON es.session_id = m.from_id
    ) k;

  INSERT INTO public.exercise_slots
    (id, session_id, exercise_id, sets, reps, duration_seconds, weight_kg, sort_order,
     rest_seconds, superset_group, notes, record_video_set_numbers)
  SELECT k.new_id, k.session_id, es.exercise_id, es.sets, es.reps, es.duration_seconds, es.weight_kg, es.sort_order,
         es.rest_seconds, es.superset_group, es.notes, es.record_video_set_numbers
    FROM unnest(v_slot_session, v_slot_from, v_slot_new) AS k (session_id, from_id, new_id)
    JOIN unnest(v_slots) AS es ON es.id = k.from_id;
  GET DIAGNOSTICS v_made_slots = ROW_COUNT;

  -- Their sets: the number and the targets. Nothing of what was trained.
  INSERT INTO public.set_logs
    (exercise_slot_id, set_number, target_reps, target_duration_seconds, target_weight_kg, target_rest_seconds)
  SELECT k.new_id, sl.set_number, sl.target_reps, sl.target_duration_seconds, sl.target_weight_kg, sl.target_rest_seconds
    FROM unnest(v_slot_from, v_slot_new) AS k (from_id, new_id)
    JOIN unnest(v_sets) AS sl ON sl.exercise_slot_id = k.from_id;
  GET DIAGNOSTICS v_made_sets = ROW_COUNT;
  -- <<< the copy

  RETURN jsonb_build_object(
    'session_id',     v_new[1],
    'week_id',        v_week_id,
    'sort_order',     v_place,
    'title',          v_title[1],
    'slots',          v_made_slots,
    'set_logs',       v_made_sets,
    'slots_left_out', v_left_out
  );
END;
$$;


-- ------------------------------------------------------------
-- 2. Copies of several sessions, at the end of a phase.
-- ------------------------------------------------------------
-- The coach's "reuse this work": sessions chosen on the sheet, copied into a
-- phase of the same block, of another block, or of another athlete of theirs.
--
--   p_session_ids    the sessions to copy. ONE COPY PER ENTRY, in the order
--                    of the list: a session listed twice is copied twice.
--                    An empty list, or none, copies nothing.
--   p_dest_week_id   the phase they go to
--
--   returns   { "session_ids", "week_id", "slots", "set_logs",
--               "slots_left_out" } — session_ids in the order of the list
--
--   refuses   week_not_found      the phase
--             not authorized      the caller reads the phase and may not
--                                 write it
--             session_not_found   an entry of the list is not a session the
--                                 caller can read — or is empty. The DETAIL
--                                 counts them. Nothing is copied: not the
--                                 others either.
--
-- The copies go after every session of the phase, archived ones included:
-- the highest sort_order + 1, + 2, … They keep their title as it is — no
-- suffix: they arrive somewhere else — and are never archived.
CREATE OR REPLACE FUNCTION public.copy_sessions(
  p_session_ids  uuid[],
  p_dest_week_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ids          uuid[] := COALESCE(p_session_ids, '{}');
  v_listed       integer;
  v_unread       integer;
  v_top          integer;
  v_dest_coach   uuid;
  -- What is copied, read in one statement.
  v_sessions     public.sessions[];
  v_slots        public.exercise_slots[];
  v_sets         public.set_logs[];
  -- The sessions to make: the one each is a copy of, its id, its phase, its
  -- place, its title, whether it is archived.
  v_from         uuid[];
  v_new          uuid[];
  v_week         uuid[];
  v_order        integer[];
  v_title        text[];
  v_archived     timestamptz[];
  -- The exercises to make: their session, the one each is a copy of, its id.
  v_slot_session uuid[];
  v_slot_from    uuid[];
  v_slot_new     uuid[];
  v_made_slots   integer;
  v_made_sets    integer;
  v_left_out     integer;
BEGIN
  PERFORM 1 FROM public.weeks w WHERE w.id = p_dest_week_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'week_not_found'
      USING DETAIL = 'No phase with this id can be read by the caller.',
            HINT = 'Nothing was changed.';
  END IF;

  PERFORM 1 FROM public.weeks w WHERE w.id = p_dest_week_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not authorized'
      USING ERRCODE = 'insufficient_privilege',
            DETAIL = 'The caller reads this phase and may not write it.',
            HINT = 'Sessions are copied by the coach of the athlete they go to. Nothing was changed.';
  END IF;

  PERFORM 1
     FROM public.sessions s
    WHERE s.week_id = p_dest_week_id
    ORDER BY s.id
      FOR UPDATE;

  -- Whose library the exercises of the copies must be in.
  SELECT st.coach_id INTO v_dest_coach
    FROM public.weeks w
    JOIN public.programs p  ON p.id = w.program_id
    JOIN public.students st ON st.id = p.student_id
   WHERE w.id = p_dest_week_id;
  IF v_dest_coach IS NULL THEN
    RAISE EXCEPTION 'not authorized'
      USING ERRCODE = 'insufficient_privilege',
            DETAIL = 'The caller cannot read whose athlete this phase belongs to.',
            HINT = 'Nothing was changed.';
  END IF;

  -- Read: the sessions of the list, their exercises, and their prescribed sets.
  SELECT ARRAY(SELECT s FROM public.sessions s
                WHERE s.id = ANY (v_ids)),
         ARRAY(SELECT es FROM public.exercise_slots es
                WHERE es.session_id = ANY (v_ids)),
         ARRAY(SELECT sl
                 FROM public.set_logs sl
                 JOIN public.exercise_slots es ON es.id = sl.exercise_slot_id
                WHERE es.session_id = ANY (v_ids)
                  AND NOT sl.is_student_added)
    INTO v_sessions, v_slots, v_sets;

  SELECT count(*), count(*) FILTER (WHERE s.id IS NULL)
    INTO v_listed, v_unread
    FROM unnest(v_ids) AS t (id)
    LEFT JOIN unnest(v_sessions) AS s ON s.id = t.id;
  IF v_unread > 0 THEN
    RAISE EXCEPTION 'session_not_found'
      USING DETAIL = format('%s of the %s id(s) of the list are not sessions the caller can read.', v_unread, v_listed),
            HINT = 'Nothing was copied, the other sessions of the list included. Read the block again, then try again.';
  END IF;

  -- Plan: one session per entry, after every session the phase holds.
  SELECT COALESCE(max(s.sort_order), -1) INTO v_top
    FROM public.sessions s
   WHERE s.week_id = p_dest_week_id;

  SELECT COALESCE(array_agg(t.id                         ORDER BY t.place), '{}'),
         COALESCE(array_agg(gen_random_uuid()            ORDER BY t.place), '{}'),
         COALESCE(array_agg(p_dest_week_id               ORDER BY t.place), '{}'),
         COALESCE(array_agg((v_top + t.place)::integer   ORDER BY t.place), '{}'),
         COALESCE(array_agg(s.title                      ORDER BY t.place), '{}'),
         COALESCE(array_agg(NULL::timestamptz            ORDER BY t.place), '{}')
    INTO v_from, v_new, v_week, v_order, v_title, v_archived
    FROM unnest(v_ids) WITH ORDINALITY AS t (id, place)
    JOIN unnest(v_sessions) AS s ON s.id = t.id;

  -- >>> the copy
  -- The sessions.
  INSERT INTO public.sessions (id, week_id, day_number, title, sort_order, archived_at)
  SELECT m.new_id, m.week_id, s.day_number, m.title, m.sort_order, m.archived_at
    FROM unnest(v_from, v_new, v_week, v_order, v_title, v_archived)
           AS m (from_id, new_id, week_id, sort_order, title, archived_at)
    JOIN unnest(v_sessions) AS s ON s.id = m.from_id;

  -- Their exercises: one per exercise of the source — kept when it is in the
  -- library of the coach of the place (trg_check_slot_exercise_in_coach_library
  -- would refuse the others, and the whole copy with them), counted otherwise.
  SELECT COALESCE(array_agg(k.session_id ORDER BY k.new_id) FILTER (WHERE k.kept), '{}'),
         COALESCE(array_agg(k.from_id    ORDER BY k.new_id) FILTER (WHERE k.kept), '{}'),
         COALESCE(array_agg(k.new_id     ORDER BY k.new_id) FILTER (WHERE k.kept), '{}'),
         count(*) FILTER (WHERE NOT k.kept)
    INTO v_slot_session, v_slot_from, v_slot_new, v_left_out
    FROM (
      SELECT m.new_id AS session_id, es.id AS from_id, gen_random_uuid() AS new_id,
             EXISTS (SELECT 1 FROM public.exercise_library el
                      WHERE el.id = es.exercise_id AND el.coach_id = v_dest_coach) AS kept
        FROM unnest(v_from, v_new) AS m (from_id, new_id)
        JOIN unnest(v_slots) AS es ON es.session_id = m.from_id
    ) k;

  INSERT INTO public.exercise_slots
    (id, session_id, exercise_id, sets, reps, duration_seconds, weight_kg, sort_order,
     rest_seconds, superset_group, notes, record_video_set_numbers)
  SELECT k.new_id, k.session_id, es.exercise_id, es.sets, es.reps, es.duration_seconds, es.weight_kg, es.sort_order,
         es.rest_seconds, es.superset_group, es.notes, es.record_video_set_numbers
    FROM unnest(v_slot_session, v_slot_from, v_slot_new) AS k (session_id, from_id, new_id)
    JOIN unnest(v_slots) AS es ON es.id = k.from_id;
  GET DIAGNOSTICS v_made_slots = ROW_COUNT;

  -- Their sets: the number and the targets. Nothing of what was trained.
  INSERT INTO public.set_logs
    (exercise_slot_id, set_number, target_reps, target_duration_seconds, target_weight_kg, target_rest_seconds)
  SELECT k.new_id, sl.set_number, sl.target_reps, sl.target_duration_seconds, sl.target_weight_kg, sl.target_rest_seconds
    FROM unnest(v_slot_from, v_slot_new) AS k (from_id, new_id)
    JOIN unnest(v_sets) AS sl ON sl.exercise_slot_id = k.from_id;
  GET DIAGNOSTICS v_made_sets = ROW_COUNT;
  -- <<< the copy

  RETURN jsonb_build_object(
    'session_ids',    to_jsonb(v_new),
    'week_id',        p_dest_week_id,
    'slots',          v_made_slots,
    'set_logs',       v_made_sets,
    'slots_left_out', v_left_out
  );
END;
$$;


-- ------------------------------------------------------------
-- 3. A copy of a phase, as the last phase of a program.
-- ------------------------------------------------------------
--   p_dest_program_id   the program the copy goes to. NULL, or left out: the
--                       program of the phase. Another one: "copy this phase
--                       to…" — another block, or a block of another athlete
--                       of the coach.
--   p_label_suffix      what is added to the name of the phase: ' (copy)'
--                       unless the app says otherwise. A phase without a
--                       name gives a copy without one.
--
--   returns   { "week_id", "program_id", "week_number", "label", "sessions",
--               "slots", "set_logs", "slots_left_out" }
--
--   refuses   week_not_found      the phase to copy
--             program_not_found   the program it goes to
--             not authorized      the caller reads that program and may not
--                                 write it
--             copy_source_changed
--
-- The copy is the last phase of the program: the highest week_number + 1.
-- Its sessions are those of the source in their order, numbered from 0, the
-- archived ones included and still archived.
CREATE OR REPLACE FUNCTION public.duplicate_week(
  p_week_id         uuid,
  p_dest_program_id uuid DEFAULT NULL,
  p_label_suffix    text DEFAULT ' (copy)'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_suffix       text := COALESCE(p_label_suffix, '');
  v_program_id   uuid;
  v_weeks        public.weeks[];
  v_new_week     uuid := gen_random_uuid();
  v_number       integer;
  v_label        text;
  v_dest_coach   uuid;
  -- What is copied, read in one statement.
  v_sessions     public.sessions[];
  v_slots        public.exercise_slots[];
  v_sets         public.set_logs[];
  -- The sessions to make: the one each is a copy of, its id, its phase, its
  -- place, its title, whether it is archived.
  v_from         uuid[];
  v_new          uuid[];
  v_week         uuid[];
  v_order        integer[];
  v_title        text[];
  v_archived     timestamptz[];
  -- The exercises to make: their session, the one each is a copy of, its id.
  v_slot_session uuid[];
  v_slot_from    uuid[];
  v_slot_new     uuid[];
  v_made_slots   integer;
  v_made_sets    integer;
  v_left_out     integer;
BEGIN
  SELECT w.program_id INTO v_program_id
    FROM public.weeks w
   WHERE w.id = p_week_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'week_not_found'
      USING DETAIL = 'No phase with this id can be read by the caller.',
            HINT = 'Nothing was changed.';
  END IF;
  v_program_id := COALESCE(p_dest_program_id, v_program_id);

  PERFORM 1 FROM public.programs p WHERE p.id = v_program_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'program_not_found'
      USING DETAIL = 'No program with this id can be read by the caller.',
            HINT = 'Nothing was changed.';
  END IF;

  PERFORM 1 FROM public.programs p WHERE p.id = v_program_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not authorized'
      USING ERRCODE = 'insufficient_privilege',
            DETAIL = 'The caller reads this program and may not write it.',
            HINT = 'A phase is duplicated by the coach of the athlete it goes to. Nothing was changed.';
  END IF;

  PERFORM 1
     FROM public.weeks w
    WHERE w.program_id = v_program_id
    ORDER BY w.id
      FOR UPDATE;

  -- Whose library the exercises of the copy must be in.
  SELECT st.coach_id INTO v_dest_coach
    FROM public.programs p
    JOIN public.students st ON st.id = p.student_id
   WHERE p.id = v_program_id;
  IF v_dest_coach IS NULL THEN
    RAISE EXCEPTION 'not authorized'
      USING ERRCODE = 'insufficient_privilege',
            DETAIL = 'The caller cannot read whose athlete this program belongs to.',
            HINT = 'Nothing was changed.';
  END IF;

  -- Read: the phase, its sessions, their exercises, and their prescribed sets.
  SELECT ARRAY(SELECT w FROM public.weeks w
                WHERE w.id = p_week_id),
         ARRAY(SELECT s FROM public.sessions s
                WHERE s.week_id = p_week_id),
         ARRAY(SELECT es
                 FROM public.exercise_slots es
                 JOIN public.sessions s ON s.id = es.session_id
                WHERE s.week_id = p_week_id),
         ARRAY(SELECT sl
                 FROM public.set_logs sl
                 JOIN public.exercise_slots es ON es.id = sl.exercise_slot_id
                 JOIN public.sessions s        ON s.id = es.session_id
                WHERE s.week_id = p_week_id
                  AND NOT sl.is_student_added)
    INTO v_weeks, v_sessions, v_slots, v_sets;
  IF cardinality(v_weeks) = 0 THEN
    RAISE EXCEPTION 'copy_source_changed'
      USING DETAIL = 'The phase was deleted while the call waited.',
            HINT = 'Read the block again, then try again. Nothing was changed.';
  END IF;

  -- The new phase: last of its program.
  SELECT COALESCE(max(w.week_number), 0) + 1 INTO v_number
    FROM public.weeks w
   WHERE w.program_id = v_program_id;
  v_label := CASE WHEN NULLIF(btrim((v_weeks[1]).label), '') IS NULL THEN NULL
                  ELSE (v_weeks[1]).label || v_suffix
             END;

  INSERT INTO public.weeks (id, program_id, week_number, label)
  VALUES (v_new_week, v_program_id, v_number, v_label);

  -- Plan: every session of the phase, in its order, numbered from 0.
  SELECT COALESCE(array_agg(n.id                 ORDER BY n.place), '{}'),
         COALESCE(array_agg(gen_random_uuid()    ORDER BY n.place), '{}'),
         COALESCE(array_agg(v_new_week           ORDER BY n.place), '{}'),
         COALESCE(array_agg((n.place - 1)::integer ORDER BY n.place), '{}'),
         COALESCE(array_agg(n.title              ORDER BY n.place), '{}'),
         COALESCE(array_agg(n.archived_at        ORDER BY n.place), '{}')
    INTO v_from, v_new, v_week, v_order, v_title, v_archived
    FROM (
      SELECT s.id, s.title, s.archived_at,
             row_number() OVER (ORDER BY s.sort_order, s.id) AS place
        FROM unnest(v_sessions) AS s
    ) n;

  -- >>> the copy
  -- The sessions.
  INSERT INTO public.sessions (id, week_id, day_number, title, sort_order, archived_at)
  SELECT m.new_id, m.week_id, s.day_number, m.title, m.sort_order, m.archived_at
    FROM unnest(v_from, v_new, v_week, v_order, v_title, v_archived)
           AS m (from_id, new_id, week_id, sort_order, title, archived_at)
    JOIN unnest(v_sessions) AS s ON s.id = m.from_id;

  -- Their exercises: one per exercise of the source — kept when it is in the
  -- library of the coach of the place (trg_check_slot_exercise_in_coach_library
  -- would refuse the others, and the whole copy with them), counted otherwise.
  SELECT COALESCE(array_agg(k.session_id ORDER BY k.new_id) FILTER (WHERE k.kept), '{}'),
         COALESCE(array_agg(k.from_id    ORDER BY k.new_id) FILTER (WHERE k.kept), '{}'),
         COALESCE(array_agg(k.new_id     ORDER BY k.new_id) FILTER (WHERE k.kept), '{}'),
         count(*) FILTER (WHERE NOT k.kept)
    INTO v_slot_session, v_slot_from, v_slot_new, v_left_out
    FROM (
      SELECT m.new_id AS session_id, es.id AS from_id, gen_random_uuid() AS new_id,
             EXISTS (SELECT 1 FROM public.exercise_library el
                      WHERE el.id = es.exercise_id AND el.coach_id = v_dest_coach) AS kept
        FROM unnest(v_from, v_new) AS m (from_id, new_id)
        JOIN unnest(v_slots) AS es ON es.session_id = m.from_id
    ) k;

  INSERT INTO public.exercise_slots
    (id, session_id, exercise_id, sets, reps, duration_seconds, weight_kg, sort_order,
     rest_seconds, superset_group, notes, record_video_set_numbers)
  SELECT k.new_id, k.session_id, es.exercise_id, es.sets, es.reps, es.duration_seconds, es.weight_kg, es.sort_order,
         es.rest_seconds, es.superset_group, es.notes, es.record_video_set_numbers
    FROM unnest(v_slot_session, v_slot_from, v_slot_new) AS k (session_id, from_id, new_id)
    JOIN unnest(v_slots) AS es ON es.id = k.from_id;
  GET DIAGNOSTICS v_made_slots = ROW_COUNT;

  -- Their sets: the number and the targets. Nothing of what was trained.
  INSERT INTO public.set_logs
    (exercise_slot_id, set_number, target_reps, target_duration_seconds, target_weight_kg, target_rest_seconds)
  SELECT k.new_id, sl.set_number, sl.target_reps, sl.target_duration_seconds, sl.target_weight_kg, sl.target_rest_seconds
    FROM unnest(v_slot_from, v_slot_new) AS k (from_id, new_id)
    JOIN unnest(v_sets) AS sl ON sl.exercise_slot_id = k.from_id;
  GET DIAGNOSTICS v_made_sets = ROW_COUNT;
  -- <<< the copy

  RETURN jsonb_build_object(
    'week_id',        v_new_week,
    'program_id',     v_program_id,
    'week_number',    v_number,
    'label',          v_label,
    'sessions',       cardinality(v_new),
    'slots',          v_made_slots,
    'set_logs',       v_made_sets,
    'slots_left_out', v_left_out
  );
END;
$$;


-- ------------------------------------------------------------
-- 4. A copy of a whole block, for its athlete or for another one.
-- ------------------------------------------------------------
--   p_target_student_id   whose block the copy is: the id of a row of
--                         public.students — what programs.student_id holds,
--                         not a profile. NULL, or left out: the athlete of
--                         the block. Another one: an athlete of the same
--                         coach.
--   p_name_suffix         what is added to the name: ' (copy)' unless the
--                         app says otherwise. '' or NULL: the same name.
--
--   returns   { "program_id", "student_id", "name", "sort_order", "weeks",
--               "sessions", "slots", "set_logs", "slots_left_out" }
--
--   refuses   program_not_found   the block to copy
--             student_not_found   no athlete with this id that the caller
--                                 can read — somebody else's athlete and a
--                                 wrong id are the same answer
--             not authorized      the caller reads the athlete and may not
--                                 write their programs: the athlete
--                                 themselves
--             copy_source_changed
--
-- The copy is an approved program of the coach — whatever its source was: a
-- draft, a block in the trash — that is NOT active: the block the athlete is
-- training stays the one they train, and the coach sets the copy active when
-- it is time (activate_program). It goes last in the athlete's list: the
-- highest sort_order of their programs out of the trash, + 1. Its phases are
-- those of the source in their order, numbered from 1, with their names as
-- they are; its sessions as in duplicate_week.
--
-- The athlete's programs are locked first, in the order of their ids, as
-- activate_program locks them: two copies for one athlete wait for each
-- other, and do not end with the same place in the list.
CREATE OR REPLACE FUNCTION public.duplicate_program(
  p_program_id        uuid,
  p_target_student_id uuid DEFAULT NULL,
  p_name_suffix       text DEFAULT ' (copy)'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_suffix       text := COALESCE(p_name_suffix, '');
  v_student_id   uuid;
  v_programs     public.programs[];
  v_weeks        public.weeks[];
  v_new_program  uuid := gen_random_uuid();
  v_name         text;
  v_sort         integer;
  v_week_from    uuid[];
  v_week_new     uuid[];
  v_dest_coach   uuid;
  -- What is copied, read in one statement.
  v_sessions     public.sessions[];
  v_slots        public.exercise_slots[];
  v_sets         public.set_logs[];
  -- The sessions to make: the one each is a copy of, its id, its phase, its
  -- place, its title, whether it is archived.
  v_from         uuid[];
  v_new          uuid[];
  v_week         uuid[];
  v_order        integer[];
  v_title        text[];
  v_archived     timestamptz[];
  -- The exercises to make: their session, the one each is a copy of, its id.
  v_slot_session uuid[];
  v_slot_from    uuid[];
  v_slot_new     uuid[];
  v_made_slots   integer;
  v_made_sets    integer;
  v_left_out     integer;
BEGIN
  SELECT p.student_id INTO v_student_id
    FROM public.programs p
   WHERE p.id = p_program_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'program_not_found'
      USING DETAIL = 'No program with this id can be read by the caller.',
            HINT = 'Nothing was changed.';
  END IF;
  v_student_id := COALESCE(p_target_student_id, v_student_id);

  -- Whose library the exercises of the copy must be in.
  SELECT st.coach_id INTO v_dest_coach
    FROM public.students st
   WHERE st.id = v_student_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'student_not_found'
      USING DETAIL = 'No athlete with this id can be read by the caller. The id is the one of public.students, not of a profile.',
            HINT = 'Nothing was changed.';
  END IF;

  -- The lightest lock there is, which an INSERT into programs takes on this
  -- row anyway: asked here because it goes through the policies of UPDATE.
  PERFORM 1 FROM public.students st WHERE st.id = v_student_id FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not authorized'
      USING ERRCODE = 'insufficient_privilege',
            DETAIL = 'The caller reads this athlete and may not write their programs.',
            HINT = 'A block is duplicated by the coach of the athlete it is for. Nothing was changed.';
  END IF;

  PERFORM 1
     FROM public.programs p
    WHERE p.student_id = v_student_id
    ORDER BY p.id
      FOR NO KEY UPDATE;

  -- Read: the block, its phases, their sessions, their exercises, and their
  -- prescribed sets.
  SELECT ARRAY(SELECT p FROM public.programs p
                WHERE p.id = p_program_id),
         ARRAY(SELECT w FROM public.weeks w
                WHERE w.program_id = p_program_id),
         ARRAY(SELECT s
                 FROM public.sessions s
                 JOIN public.weeks w ON w.id = s.week_id
                WHERE w.program_id = p_program_id),
         ARRAY(SELECT es
                 FROM public.exercise_slots es
                 JOIN public.sessions s ON s.id = es.session_id
                 JOIN public.weeks w    ON w.id = s.week_id
                WHERE w.program_id = p_program_id),
         ARRAY(SELECT sl
                 FROM public.set_logs sl
                 JOIN public.exercise_slots es ON es.id = sl.exercise_slot_id
                 JOIN public.sessions s        ON s.id = es.session_id
                 JOIN public.weeks w           ON w.id = s.week_id
                WHERE w.program_id = p_program_id
                  AND NOT sl.is_student_added)
    INTO v_programs, v_weeks, v_sessions, v_slots, v_sets;
  IF cardinality(v_programs) = 0 THEN
    RAISE EXCEPTION 'copy_source_changed'
      USING DETAIL = 'The program was deleted while the call waited.',
            HINT = 'Read the list of blocks again, then try again. Nothing was changed.';
  END IF;

  -- The new block: approved, not active, last in the athlete's list.
  SELECT COALESCE(max(p.sort_order), -1) + 1 INTO v_sort
    FROM public.programs p
   WHERE p.student_id = v_student_id
     AND p.deleted_at IS NULL;
  v_name := (v_programs[1]).name || v_suffix;

  INSERT INTO public.programs (id, student_id, name, sort_order, is_active, status)
  VALUES (v_new_program, v_student_id, v_name, v_sort, false, 'approved');

  -- Its phases: those of the source in their order, numbered from 1.
  SELECT COALESCE(array_agg(n.id              ORDER BY n.place), '{}'),
         COALESCE(array_agg(gen_random_uuid() ORDER BY n.place), '{}')
    INTO v_week_from, v_week_new
    FROM (
      SELECT w.id, row_number() OVER (ORDER BY w.week_number, w.id) AS place
        FROM unnest(v_weeks) AS w
    ) n;

  INSERT INTO public.weeks (id, program_id, week_number, label)
  SELECT k.new_id, v_new_program, k.place::integer, w.label
    FROM unnest(v_week_from, v_week_new) WITH ORDINALITY AS k (from_id, new_id, place)
    JOIN unnest(v_weeks) AS w ON w.id = k.from_id;

  -- Plan: every session of every phase, in its order, numbered from 0.
  SELECT COALESCE(array_agg(n.id                   ORDER BY n.new_week, n.place), '{}'),
         COALESCE(array_agg(gen_random_uuid()      ORDER BY n.new_week, n.place), '{}'),
         COALESCE(array_agg(n.new_week             ORDER BY n.new_week, n.place), '{}'),
         COALESCE(array_agg((n.place - 1)::integer ORDER BY n.new_week, n.place), '{}'),
         COALESCE(array_agg(n.title                ORDER BY n.new_week, n.place), '{}'),
         COALESCE(array_agg(n.archived_at          ORDER BY n.new_week, n.place), '{}')
    INTO v_from, v_new, v_week, v_order, v_title, v_archived
    FROM (
      SELECT s.id, s.title, s.archived_at, k.new_id AS new_week,
             row_number() OVER (PARTITION BY s.week_id ORDER BY s.sort_order, s.id) AS place
        FROM unnest(v_sessions) AS s
        JOIN unnest(v_week_from, v_week_new) AS k (from_id, new_id) ON k.from_id = s.week_id
    ) n;

  -- >>> the copy
  -- The sessions.
  INSERT INTO public.sessions (id, week_id, day_number, title, sort_order, archived_at)
  SELECT m.new_id, m.week_id, s.day_number, m.title, m.sort_order, m.archived_at
    FROM unnest(v_from, v_new, v_week, v_order, v_title, v_archived)
           AS m (from_id, new_id, week_id, sort_order, title, archived_at)
    JOIN unnest(v_sessions) AS s ON s.id = m.from_id;

  -- Their exercises: one per exercise of the source — kept when it is in the
  -- library of the coach of the place (trg_check_slot_exercise_in_coach_library
  -- would refuse the others, and the whole copy with them), counted otherwise.
  SELECT COALESCE(array_agg(k.session_id ORDER BY k.new_id) FILTER (WHERE k.kept), '{}'),
         COALESCE(array_agg(k.from_id    ORDER BY k.new_id) FILTER (WHERE k.kept), '{}'),
         COALESCE(array_agg(k.new_id     ORDER BY k.new_id) FILTER (WHERE k.kept), '{}'),
         count(*) FILTER (WHERE NOT k.kept)
    INTO v_slot_session, v_slot_from, v_slot_new, v_left_out
    FROM (
      SELECT m.new_id AS session_id, es.id AS from_id, gen_random_uuid() AS new_id,
             EXISTS (SELECT 1 FROM public.exercise_library el
                      WHERE el.id = es.exercise_id AND el.coach_id = v_dest_coach) AS kept
        FROM unnest(v_from, v_new) AS m (from_id, new_id)
        JOIN unnest(v_slots) AS es ON es.session_id = m.from_id
    ) k;

  INSERT INTO public.exercise_slots
    (id, session_id, exercise_id, sets, reps, duration_seconds, weight_kg, sort_order,
     rest_seconds, superset_group, notes, record_video_set_numbers)
  SELECT k.new_id, k.session_id, es.exercise_id, es.sets, es.reps, es.duration_seconds, es.weight_kg, es.sort_order,
         es.rest_seconds, es.superset_group, es.notes, es.record_video_set_numbers
    FROM unnest(v_slot_session, v_slot_from, v_slot_new) AS k (session_id, from_id, new_id)
    JOIN unnest(v_slots) AS es ON es.id = k.from_id;
  GET DIAGNOSTICS v_made_slots = ROW_COUNT;

  -- Their sets: the number and the targets. Nothing of what was trained.
  INSERT INTO public.set_logs
    (exercise_slot_id, set_number, target_reps, target_duration_seconds, target_weight_kg, target_rest_seconds)
  SELECT k.new_id, sl.set_number, sl.target_reps, sl.target_duration_seconds, sl.target_weight_kg, sl.target_rest_seconds
    FROM unnest(v_slot_from, v_slot_new) AS k (from_id, new_id)
    JOIN unnest(v_sets) AS sl ON sl.exercise_slot_id = k.from_id;
  GET DIAGNOSTICS v_made_sets = ROW_COUNT;
  -- <<< the copy

  RETURN jsonb_build_object(
    'program_id',     v_new_program,
    'student_id',     v_student_id,
    'name',           v_name,
    'sort_order',     v_sort,
    'weeks',          cardinality(v_week_new),
    'sessions',       cardinality(v_new),
    'slots',          v_made_slots,
    'set_logs',       v_made_sets,
    'slots_left_out', v_left_out
  );
END;
$$;

-- Who may execute them: the FUNCTION PRIVILEGES block at the end of this file.

-- ============================================================
-- RETENTION: THE ROWS NOBODY READS ANY MORE
-- (2026_10_13_18_retention — review L27, and the retention B14 and L20 ask
-- for)
--
-- Three tables hold rows that are of use for a while and of none afterwards:
-- scheduled_pushes (one row per rest timer), notifications (the lines of the
-- bell; the app shows the 30 most recent) and client_errors (the coach's
-- triage list; the 20 most recent). One function deletes what is past its
-- time in all three:
--
--   run_retention()
--     → { "scheduled_pushes": n, "notifications": n, "client_errors": n }
--       the rows this run deleted. Keys are added, never renamed.
--
--   REST PUSHES   created more than 7 days ago, whatever became of them. The
--                 age is the one schedule_rest_push deletes the caller's own
--                 rows at: this is the same broom, for the accounts that do
--                 not rest any more — and for every account while the app
--                 from before wave 3 is in use, which never calls that
--                 function.
--                 NEVER ONE THAT IS STILL TO BE SENT: a row that is waiting
--                 for a time still to come, or less than a minute past,
--                 belongs to a sender. "Waiting" is what it is for every
--                 function of the rest push: status 'pending' AND
--                 canceled_at NULL — a row the app from before wave 3 took
--                 back, by writing canceled_at and leaving the status, waits
--                 for nobody and goes. A rest lasts 15 minutes at most, so a
--                 row a week old is not waiting — unless the app from before
--                 wave 3 wrote it from a phone whose clock is days ahead.
--                 That row is left until its time has passed.
--   NOTIFICATIONS read more than 90 days ago — by the time they were READ,
--                 not written. A line that was never read is never deleted
--                 here: it is still on its account's bell.
--   CLIENT ERRORS reported more than 90 days ago.
--
-- WHO RUNS IT. The owner of the database, by hand, once a month
-- (docs/runbook/70-admin-procedures.md) — or, where pg_cron is switched on,
-- the nightly job of the optional migration 19. Nothing in this file calls
-- it: no trigger, no other function. Without a run nothing breaks; the rows
-- wait.
--
-- A TABLE THAT GROWS BY ITSELF — one row per event, of no use after a while —
-- gets its DELETE here, with its age, and its line in DELETED_BY_A_RUN of
-- supabase/tests/retention.test.js; every other table of public is in
-- KEPT_FOR_GOOD there, with the reason. Never a table of training: what an
-- athlete logged is kept for good.
--
-- IT WAITS FOR NOBODY. Each DELETE takes its rows through
-- FOR UPDATE SKIP LOCKED: a row another request holds at that instant is
-- passed over, and goes with the next run. A run never stands in the way of
-- the app, and never deadlocks with it.
--
-- SECURITY INVOKER, and for no client: the owner and the service role hold
-- every row; anybody else would reach what their own rights let them delete
-- — their own rest pushes, and nothing of the two other tables.
-- Who may execute it: nobody but its owner and the service role. It is NOT in
-- the FUNCTION PRIVILEGES block at the end of this file, and must not be.
-- ============================================================
CREATE OR REPLACE FUNCTION public.run_retention()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_pushes        integer;
  v_notifications integer;
  v_errors        integer;
BEGIN
  WITH old AS (
    SELECT sp.id
      FROM public.scheduled_pushes sp
     WHERE sp.created_at < now() - interval '7 days'
       AND NOT (    sp.status = 'pending'
                AND sp.canceled_at IS NULL
                AND sp.fire_at > now() - interval '60 seconds')
     ORDER BY sp.id
       FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.scheduled_pushes sp
   USING old
   WHERE sp.id = old.id;
  GET DIAGNOSTICS v_pushes = ROW_COUNT;

  WITH old AS (
    SELECT n.id
      FROM public.notifications n
     WHERE n.read_at IS NOT NULL
       AND n.read_at < now() - interval '90 days'
     ORDER BY n.id
       FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.notifications n
   USING old
   WHERE n.id = old.id;
  GET DIAGNOSTICS v_notifications = ROW_COUNT;

  WITH old AS (
    SELECT ce.id
      FROM public.client_errors ce
     WHERE ce.created_at < now() - interval '90 days'
     ORDER BY ce.id
       FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.client_errors ce
   USING old
   WHERE ce.id = old.id;
  GET DIAGNOSTICS v_errors = ROW_COUNT;

  RETURN jsonb_build_object(
    'scheduled_pushes', v_pushes,
    'notifications',    v_notifications,
    'client_errors',    v_errors
  );
END;
$$;

-- ============================================================
-- THE JOBS: WHAT RUNS ON A TIMER, WHERE pg_cron IS SWITCHED ON
-- (2026_10_13_19_pg_cron_jobs — optional; the scheduled halves of review
-- P10, L27 and P35)
--
-- EVERYTHING IN THIS SECTION EXISTS ONLY IN A PROJECT THAT HAS THE EXTENSION
-- pg_cron. Its owner switches it on, or does not: production may never have
-- it, and the database the tests run on does not. Without it the block below
-- does nothing, and nothing is missing: a rest push is sent through the
-- dispatch-rest-push Edge Function, run_retention() is run by hand once a
-- month, and a push request that failed is in the log of the send-push
-- function. That is why the function of this section is created inside the
-- block and not next to the others: a database without the extension is, to
-- the last object, production without migration 19
-- (supabase/tests/parity.test.js compares both ways).
--
-- Where the extension is there, the block makes one function and four jobs:
--
--   sl-rest-push       every 10 seconds   select public.dispatch_due_rest_pushes()
--       closes the rest pushes more than a minute late and hands each one due
--       within ten seconds to send-push, once (THE REST PUSH, further up).
--       While this job is there and switched on, schedule_rest_push answers
--       mode 'cron': the NAME of the job is that contract.
--   sl-retention       every night, 03:17 UTC   select public.run_retention()
--       RETENTION, above.
--   sl-push-failures   every hour, at :07   select public.record_push_failures()
--       below.
--   sl-cron-history    every night, 03:47 UTC
--       pg_cron keeps one row per run of a job (cron.job_run_details) and
--       deletes none itself; sl-rest-push alone writes 8,640 a day. This job
--       keeps three days of them: it finds the first run that ended within
--       the last three days and deletes every run numbered before it — by its
--       number and not by its time, because a run that never started has
--       none.
--
-- A job runs as the role that made it — postgres — in this database. It is
-- made, changed and removed through pg_cron's functions (cron.schedule,
-- cron.alter_job, cron.unschedule): postgres reads cron.job and may not
-- write it.
--
--   record_push_failures() → { "hours": n, "failed": n }
--
-- A push leaves the database as a request of pg_net to send-push
-- (send_push_event), and nobody reads what came back: pg_net keeps each
-- answer in net._http_response for six hours. This function writes ONE LINE
-- PER HOUR in which a request failed into client_errors — the list at the
-- bottom of the coach's roster:
--
--     role     'database'
--     message  'Push: 3 of 41 requests the database sent to send-push failed
--               between 2026-10-13 14:00 and 15:00 UTC — 2 × HTTP 502,
--               1 × no answer in time'
--     url      'pg_net 2026-10-13T14:00Z' — which hour; it is also what keeps
--              a second run from writing that hour again
--
-- A request failed when it was not answered with a status between 200 and
-- 299. Only hours that are over are written, so that each is counted whole
-- and once — and every such hour pg_net still holds, so that a run that was
-- missed is caught up. What send-push answered is not copied: the body may
-- name a device. SECURITY INVOKER, and for no client: the job runs it as
-- postgres.
-- Who may execute it: nobody but its owner and the service role. It is NOT in
-- the FUNCTION PRIVILEGES block at the end of this file, and must not be.
--
-- A JOB THAT IS ADDED, or whose schedule or command changes, is a migration
-- that calls cron.schedule under the same guard as this block, and names it
-- in its audit, in its rollback and in supabase/tests/cron-jobs.test.js: the
-- four definitions are held to be the same text in all of them.
-- ============================================================
DO $pg_cron_jobs$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension e WHERE e.extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron is not switched on in this project: record_push_failures() and the four jobs of migration 19 are left out';
    RETURN;
  END IF;

  EXECUTE $create$
CREATE OR REPLACE FUNCTION public.record_push_failures()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_hour   record;
  v_key    text;
  v_hours  integer := 0;
  v_failed integer := 0;
BEGIN
  -- One run at a time: a run that waited here reads the lines of the one
  -- before it, and writes none of them again.
  PERFORM pg_advisory_xact_lock(hashtextextended('sl_app.record_push_failures', 0));

  FOR v_hour IN
    WITH answered AS (
      SELECT date_trunc('hour', r.created, 'UTC') AS hour,
             CASE
               WHEN r.timed_out IS TRUE THEN 'no answer in time'
               WHEN r.status_code BETWEEN 200 AND 299 AND r.error_msg IS NULL THEN NULL
               WHEN r.status_code IS NOT NULL THEN 'HTTP ' || r.status_code
               ELSE 'no answer' || COALESCE(' (' || left(r.error_msg, 80) || ')', '')
             END AS failure
        FROM net._http_response r
       WHERE r.created < date_trunc('hour', now(), 'UTC')
    ),
    kinds AS (
      SELECT a.hour, a.failure, count(*) AS n
        FROM answered a
       WHERE a.failure IS NOT NULL
       GROUP BY a.hour, a.failure
    )
    SELECT a.hour,
           count(*) AS sent,
           count(a.failure) AS failed,
           (SELECT string_agg(k.n || ' × ' || k.failure, ', ' ORDER BY k.n DESC, k.failure)
              FROM kinds k
             WHERE k.hour = a.hour) AS kinds
      FROM answered a
     GROUP BY a.hour
    HAVING count(a.failure) > 0
     ORDER BY a.hour
  LOOP
    v_key := 'pg_net ' || to_char(v_hour.hour AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24":00Z"');
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM public.client_errors ce
       WHERE ce.role = 'database' AND ce.url = v_key
    );

    INSERT INTO public.client_errors (user_id, role, message, stack, url, user_agent)
    VALUES (
      NULL,
      'database',
      left(format(
        'Push: %s of %s requests the database sent to send-push failed between %s and %s UTC — %s',
        v_hour.failed,
        v_hour.sent,
        to_char(v_hour.hour AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI'),
        to_char((v_hour.hour + interval '1 hour') AT TIME ZONE 'UTC', 'HH24:MI'),
        v_hour.kinds
      ), 2000),
      'What each request was answered is in net._http_response for six hours, and in the log of the send-push Edge Function.',
      v_key,
      'public.record_push_failures()'
    );
    v_hours := v_hours + 1;
    v_failed := v_failed + v_hour.failed;
  END LOOP;

  RETURN jsonb_build_object('hours', v_hours, 'failed', v_failed);
END;
$$
$create$;

  PERFORM cron.schedule(j.jobname, j.schedule, j.command)
     FROM (VALUES
       ('sl-rest-push',     '10 seconds', 'select public.dispatch_due_rest_pushes()'),
       ('sl-retention',     '17 3 * * *', 'select public.run_retention()'),
       ('sl-push-failures', '7 * * * *',  'select public.record_push_failures()'),
       ('sl-cron-history',  '47 3 * * *', 'delete from cron.job_run_details where runid < (select coalesce(min(runid), 0) from cron.job_run_details where end_time >= now() - interval ''3 days'')')
     ) AS j (jobname, schedule, command);
END
$pg_cron_jobs$;

-- ============================================================
-- FUNCTION PRIVILEGES (2026_10_11_03_function_grants_lockdown)
--
-- KEEP THIS BLOCK BELOW EVERY FUNCTION OF THIS FILE: nothing after it may
-- create one. It is the one place in this file that says who may execute
-- what — a GRANT written next to a function is undone by the REVOKE below,
-- and supabase/tests/function-acl.test.js refuses one anywhere else.
--
-- Why a block and not a line per function. Supabase's default privileges give
-- `anon`, `authenticated` and `service_role` EXECUTE, by name, on every
-- function `postgres` creates in `public`, on top of the EXECUTE PostgreSQL
-- gives PUBLIC. So every function above was born callable through
-- /rest/v1/rpc/ with nothing but the anon key (review B2, L21), and
-- `REVOKE … FROM public` next to a function removes one of those four grants.
-- Here everything is taken back at once, then given to `authenticated`
-- function by function.
--
-- A NEW FUNCTION:
--   * a helper a POLICY calls, or an RPC the APP calls  → add it to the list
--     below. A policy runs with the privileges of the user who queries the
--     table: a helper missing here fails every query on that table.
--   * a TRIGGER function                                → nothing. A trigger
--     fires whatever the privileges of the user whose statement fires it.
--   * anything else (called by another function of this file that is
--     SECURITY DEFINER, by an Edge Function, by a cron job) → nothing: the
--     owner and `service_role` keep EXECUTE on everything.
--   * always: `SET search_path = public, pg_temp` in its definition, and
--     schema-qualified names in its body.
-- Its MIGRATION carries the same, for that function alone:
--     REVOKE ALL ON FUNCTION public.f(…) FROM PUBLIC, anon, authenticated;
--     GRANT EXECUTE ON FUNCTION public.f(…) TO authenticated;   -- if listed
-- and supabase/tests/function-acl.test.js lists it too.
-- ============================================================

-- What a function created AFTER this file starts with, when `postgres`
-- creates it (the SQL editor, a migration): no EXECUTE for PUBLIC in any
-- schema — global, because a per-schema default can only add to PostgreSQL's
-- built-in grant — and none for `anon` or `authenticated` in `public`.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON FUNCTIONS FROM anon, authenticated;

-- Every function above: nobody but the owner and `service_role`.
REVOKE ALL ON ALL ROUTINES IN SCHEMA public FROM PUBLIC, anon, authenticated;

-- THE ALLOW-LIST — what a signed-in user may execute.
-- The helpers the RLS policies are written with:
GRANT EXECUTE ON FUNCTION
  public.student_profile_for_slot(uuid),
  public.student_profile_for_session(uuid),
  public.student_profile_for_set_log(uuid),
  public.student_profile_for_goal(uuid),
  public.coach_profile_for_session(uuid),
  public.coach_profile_for_goal(uuid),
  public.profiles_are_coach_student(uuid, uuid),
  public.program_active_for_session(uuid),
  public.program_active_for_slot(uuid),
  public.program_is_own_draft(uuid),
  public.week_is_own_draft(uuid),
  public.session_is_own_draft(uuid),
  public.is_coach(),
  public.session_writable(uuid),
  public.session_writable_for_slot(uuid),
  public.slot_for_set_log(uuid),
  public.set_video_slot(text),
  public.session_is_confirmed(uuid),
  public.exercise_readable_through_use(uuid)
TO authenticated;

-- The RPCs the app calls. The five coach RPCs authorize the caller themselves
-- (auth.uid() IS NULL first, then IS DISTINCT FROM), and so do
-- ensure_set_logs, claim_push_subscription, schedule_rest_push and
-- cancel_rest_push, for the account that calls; save_draft_tree,
-- move_session, activate_program, reorder_sessions, reorder_weeks and the
-- four that copy (duplicate_session, copy_sessions, duplicate_week,
-- duplicate_program) are SECURITY INVOKER and ride the caller's RLS.
GRANT EXECUTE ON FUNCTION
  public.adopt_swap(uuid, uuid, boolean),
  public.adopt_skip(uuid, boolean),
  public.decline_promote_request(uuid),
  public.approve_program(uuid),
  public.send_back_program(uuid),
  public.save_draft_tree(jsonb),
  public.move_session(uuid, uuid, uuid[], uuid[]),
  public.activate_program(uuid),
  public.reorder_sessions(uuid, uuid[]),
  public.reorder_weeks(uuid, uuid[]),
  public.duplicate_session(uuid, text),
  public.copy_sessions(uuid[], uuid),
  public.duplicate_week(uuid, uuid, text),
  public.duplicate_program(uuid, uuid, text),
  public.ensure_set_logs(uuid),
  public.claim_push_subscription(text, text, text, text),
  public.schedule_rest_push(integer, jsonb, text),
  public.cancel_rest_push(uuid)
TO authenticated;

-- ============================================================
-- TABLE PRIVILEGES (2026_10_13_14_table_grants_lockdown)
--
-- KEEP THIS BLOCK BELOW EVERY TABLE, VIEW AND SEQUENCE OF `public` IN THIS
-- FILE: nothing after it may create one. It is the one place in this file
-- that says who holds what on a table, and supabase/tests/table-acl.test.js
-- refuses a GRANT or a REVOKE on a table of `public` anywhere else.
--
-- Why a block and not a line per table. Supabase's default privileges give
-- `anon`, `authenticated` and `service_role` EVERY privilege, by name, on
-- every table `postgres` creates in `public`: each table above was born
-- readable, writable and TRUNCATE-able with nothing but the anon key, and
-- row-level security was the only gate (review L24). TRUNCATE is not subject
-- to it. Here it is taken back at once, for all of them:
--
--   anon, PUBLIC     nothing — on a table, a view or a sequence
--   authenticated    SELECT, INSERT, UPDATE, DELETE on a table: the four that
--                    the policies judge row by row. USAGE on a sequence.
--   service_role     everything (the Edge Functions), and so the owner
--
-- A NEW TABLE:
--   * above this block, with `ALTER TABLE … ENABLE ROW LEVEL SECURITY` and
--     its policies next to it. The block gives it the privileges of the
--     others; without row-level security every signed-in user would read and
--     write all of it.
--   * a table on which a signed-in user must hold LESS than the four says so
--     at the end of this block, below the statements for all of them.
--   * never a GRANT to `anon`: nothing of this app is served without a
--     session.
--   * a view is created `WITH (security_invoker = true)`: without it a view
--     shows every row of its tables to whoever may read the view.
-- Its MIGRATION carries the same, for that table alone, so that the result
-- does not depend on the default privileges of the database it runs in:
--     ALTER TABLE public.t ENABLE ROW LEVEL SECURITY;
--     REVOKE ALL ON TABLE public.t FROM PUBLIC, anon, authenticated;
--     GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.t TO authenticated;
-- and supabase/tests/rls-matrix.test.js gets its insert probe.
-- ============================================================

-- What a table or a sequence created AFTER this file starts with, when
-- `postgres` creates it in `public` (the SQL editor, a migration): the same.
-- PostgreSQL itself gives PUBLIC nothing on a new table, so there is no
-- global default to take back here, unlike for functions.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLES FROM authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE SELECT, UPDATE ON SEQUENCES FROM authenticated;

-- Every table, view and sequence above. ALL TABLES is tables and views.
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM PUBLIC, anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON ALL TABLES IN SCHEMA public FROM authenticated;
REVOKE SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public FROM authenticated;

-- ============================================================
-- MIGRATION LEDGER (2026_10_03_01_migration_ledger)
--
-- app_private.app_migrations holds one row per applied migration of
-- supabase/migrations/manifest.json; a migration file inserts its own name in
-- the transaction that makes its changes, and refuses to run when the name is
-- already there or when the migration it requires is missing.
--
-- `app_private` is not exposed by the API and no API role can use it. It is
-- not `public` on purpose: a public table needs RLS, and a table with RLS and
-- no policy reads as EMPTY to a read-only role — a check of the ledger before
-- a deploy would read "nothing is applied".
-- ============================================================
CREATE SCHEMA app_private;

COMMENT ON SCHEMA app_private IS
  'Objects the API must never reach: not in the exposed schemas, no privilege '
  'for anon, authenticated or service_role. Holds the migration ledger.';

CREATE TABLE app_private.app_migrations (
  name        text PRIMARY KEY
              CHECK (name ~ '^[0-9]{4}_[0-9]{2}_[0-9]{2}_[0-9]{2}_[a-z][a-z0-9_]*$'),
  applied_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE app_private.app_migrations IS
  'One row per applied migration of supabase/migrations/manifest.json: the '
  'file name without .sql. Written by the migration itself, in its own '
  'transaction; removed by its rollback file.';

REVOKE ALL ON SCHEMA app_private FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE app_private.app_migrations FROM PUBLIC, anon, authenticated, service_role;

-- This file IS those migrations, already merged: a database installed from it
-- starts with all of them on record. A migration that is merged in above adds
-- its name here (a `contract` migration only once it is applied — until then
-- this file must keep describing production; one that needs an extension, in
-- the statement after this one). supabase/tests/parity.test.js fails when
-- this list and the manifest disagree.
INSERT INTO app_private.app_migrations (name) VALUES
  ('2026_10_03_01_migration_ledger'),
  ('2026_10_03_02_rpc_auth_null_guard'),
  ('2026_10_11_03_function_grants_lockdown'),
  ('2026_10_11_04_logged_history_guards'),
  ('2026_10_11_05_students_role_gate'),
  ('2026_10_11_06_pin_student_writes'),
  ('2026_10_11_07_profile_rules'),
  ('2026_10_12_08_session_write_gates'),
  ('2026_10_13_09_review_lifecycle'),
  ('2026_10_13_10_goals_fk_coach_links'),
  ('2026_10_13_11_activate_reorder_rpcs'),
  ('2026_10_13_12_copy_rpcs'),
  ('2026_10_13_13_ensure_claim_rpcs'),
  ('2026_10_13_14_table_grants_lockdown'),
  ('2026_10_13_15_push_plumbing'),
  ('2026_10_13_16_rest_push_scheduling'),
  ('2026_10_13_17_replay_grace_window'),
  ('2026_10_13_18_retention'),
  ('2026_10_16_20_drafts_coach_readonly'),
  ('2026_10_16_21_rpe_half_steps_day_check'),
  ('2026_10_16_22_client_errors_scope'),
  ('2026_10_16_23_library_read_follows_program'),
  ('2026_10_16_24_indexes_cleanup');

-- An optional migration that needs an extension is on record where its block
-- above ran, and nowhere else: a project that switches pg_cron on later must
-- still be able to apply the file, which refuses a name that is in the
-- ledger.
INSERT INTO app_private.app_migrations (name)
SELECT '2026_10_13_19_pg_cron_jobs'
 WHERE EXISTS (SELECT 1 FROM pg_extension e WHERE e.extname = 'pg_cron');
