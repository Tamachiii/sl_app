-- Student-uploaded video clips, one per set_log.
-- Files live in the private 'set-videos' storage bucket, keyed by
-- <student_profile_id>/<exercise_slot_id>/<set_number>-<uuid>.<ext>

-- ============================================================
-- TABLE
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

-- ============================================================
-- HELPER
-- ============================================================
CREATE OR REPLACE FUNCTION public.student_profile_for_set_log(log_id uuid)
RETURNS uuid AS $$
  SELECT public.student_profile_for_slot(sl.exercise_slot_id)
  FROM public.set_logs sl
  WHERE sl.id = log_id
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- ============================================================
-- RLS on the table
-- ============================================================
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

-- ============================================================
-- STORAGE BUCKET
-- Private, 30 MB file cap. Common mobile capture formats allowed.
-- ============================================================
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

-- ============================================================
-- STORAGE RLS
-- Path convention: <profile_id>/<slot_id>/<set>-<uuid>.<ext>
-- First path segment == owning student's profile_id.
-- ============================================================
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
