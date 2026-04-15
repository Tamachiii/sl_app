-- Student-authored free-text comment attached to a specific exercise slot,
-- visible to the student's coach. One comment per slot (upsert on slot id).
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

-- Students manage their own comment on a slot belonging to their program.
-- Blocked once the parent session is archived (mirrors the confirmation lock).
CREATE POLICY "Students manage own slot comments"
  ON public.slot_comments FOR ALL
  USING (
    student_id = auth.uid()
    AND public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND NOT EXISTS (
      SELECT 1 FROM public.exercise_slots es
      JOIN public.sessions s ON s.id = es.session_id
      WHERE es.id = slot_comments.exercise_slot_id AND s.archived_at IS NOT NULL
    )
  )
  WITH CHECK (
    student_id = auth.uid()
    AND public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND NOT EXISTS (
      SELECT 1 FROM public.exercise_slots es
      JOIN public.sessions s ON s.id = es.session_id
      WHERE es.id = slot_comments.exercise_slot_id AND s.archived_at IS NOT NULL
    )
  );

CREATE POLICY "Coaches read slot comments for their students"
  ON public.slot_comments FOR SELECT
  USING (
    public.student_profile_for_slot(exercise_slot_id) IN (
      SELECT profile_id FROM public.students WHERE coach_id = auth.uid()
    )
  );
