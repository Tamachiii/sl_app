-- ============================================================
-- Trust-boundary hardening, part 1 of the v2 Phase-1 sweep.
--
-- 1) handle_new_user no longer reads `role` from client-supplied signup
--    metadata. supabase.auth.signUp lets the CALLER set raw_user_meta_data,
--    and the anon key ships in the public bundle — so with email signups
--    enabled (the Supabase default) anyone could self-provision a
--    coach-privileged account. Every signup now lands as 'student';
--    promoting a coach is a deliberate manual act:
--
--      UPDATE public.profiles SET role = 'coach' WHERE id = '<profile-uuid>';
--
--    (Run in the SQL editor / via supabase db query. Also consider
--    disabling public email signups under Auth → Providers if the app
--    is invite-only, which it currently is.)
--
-- 2) The student DELETE policy on set_logs is narrowed to rows the student
--    added themselves (is_student_added = true). The pin_set_log_targets_
--    for_student trigger protects target_* on UPDATE only; an unrestricted
--    DELETE let a student remove a coach-prescribed row and re-INSERT the
--    same set_number with forged targets. The client already only deletes
--    is_student_added rows (useRemoveStudentSet), so no app behavior
--    changes.
--
--    KNOWN RESIDUAL GAP: the student INSERT policy still accepts arbitrary
--    target_* values and is_student_added=false — it must, because the
--    legacy useEnsureSetLogs safety net materializes prescribed rows (with
--    targets) under the STUDENT's JWT. Fully pinning the INSERT path
--    requires moving that materialization server-side first; it is a
--    scheduled Phase-1 hardening item, not covered here.
-- ============================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, role, full_name)
  VALUES (
    NEW.id,
    -- Never trust client-supplied metadata for the role: coach is the
    -- highest-privilege fact in the model and is granted manually.
    'student',
    COALESCE(NEW.raw_user_meta_data->>'full_name', '')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger on_auth_user_created already exists; the function replacement
-- above takes effect without re-creating it.

DROP POLICY IF EXISTS "Students delete own set logs" ON public.set_logs;
CREATE POLICY "Students delete own set logs"
  ON public.set_logs FOR DELETE
  USING (
    public.student_profile_for_slot(exercise_slot_id) = auth.uid()
    AND public.program_active_for_slot(exercise_slot_id) = true
    AND is_student_added = true
  );
