-- ============================================================
-- Allow users to UPDATE their own profile row, but only the
-- `full_name` column. The `role` column is pinned by a BEFORE
-- UPDATE trigger so a student cannot promote themselves to coach
-- by passing `role: 'coach'` in the UPDATE payload.
--
-- The Student → Profile page lets users rename themselves; this
-- is the policy + guard that backs that edit.
-- ============================================================

DROP POLICY IF EXISTS "Users update own profile" ON public.profiles;
CREATE POLICY "Users update own profile"
  ON public.profiles FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- Defense in depth: even if the policy ever loosens, this trigger
-- prevents privilege escalation by reverting role / id changes
-- silently in the same UPDATE.
CREATE OR REPLACE FUNCTION public.profiles_pin_immutable_columns()
RETURNS trigger AS $$
BEGIN
  NEW.id := OLD.id;
  NEW.role := OLD.role;
  NEW.created_at := OLD.created_at;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS profiles_pin_immutable_columns ON public.profiles;
CREATE TRIGGER profiles_pin_immutable_columns
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.profiles_pin_immutable_columns();
