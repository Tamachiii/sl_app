-- Replace the single-value record-video flag with a multi-set array.
ALTER TABLE public.exercise_slots
  DROP COLUMN IF EXISTS record_video_set_number;

ALTER TABLE public.exercise_slots
  ADD COLUMN record_video_set_numbers int[] NOT NULL DEFAULT '{}';
