-- ============================================================
-- Let students SELECT their coach's profile row.
--
-- Without this, embedded reads like
--   .from('students').select('coach:profiles!students_coach_id_fkey(id, full_name)')
-- return `coach: null` under student RLS, even though the students row itself
-- is readable. The Student → Messages tab and any future "your coach" surface
-- need the coach's full_name, so we open up exactly that one row.
-- ============================================================

DROP POLICY IF EXISTS "Students read their coach profile" ON public.profiles;
CREATE POLICY "Students read their coach profile"
  ON public.profiles FOR SELECT
  USING (
    id IN (
      SELECT coach_id FROM public.students WHERE profile_id = auth.uid()
    )
  );
