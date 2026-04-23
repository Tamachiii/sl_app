-- Programs CRUD (periodization)
-- Adds `sort_order` for coach-controlled arrangement and `is_active` so students
-- only see one program at a time while coaches can prep the next block.

ALTER TABLE public.programs
  ADD COLUMN IF NOT EXISTS sort_order int NOT NULL DEFAULT 0;

ALTER TABLE public.programs
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT false;

-- Backfill sort_order chronologically within each student (zero-based).
WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY student_id ORDER BY created_at, id) AS rn
  FROM public.programs
)
UPDATE public.programs p
SET sort_order = r.rn - 1
FROM ranked r
WHERE p.id = r.id;

-- Backfill is_active: the most-recently-created existing program per student
-- becomes the active one (since pre-migration semantics already showed "programs[0]").
WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY student_id ORDER BY created_at DESC, id) AS rn
  FROM public.programs
)
UPDATE public.programs p
SET is_active = true
FROM ranked r
WHERE p.id = r.id AND r.rn = 1;

-- At most one active program per student.
CREATE UNIQUE INDEX IF NOT EXISTS programs_one_active_per_student
  ON public.programs(student_id) WHERE is_active;
