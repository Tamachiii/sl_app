-- Rollback of 2026_10_11_07_profile_rules: gives two functions back the text
-- they had before.
--
-- !! IT REOPENS FINDINGS P20 AND B10. After this file an account created
-- !! without a name has an empty one again — the pushes to the coach about it
-- !! read " completed Session 3" — and `update public.profiles set role = …`
-- !! answers "UPDATE 1" and changes nothing, for every caller: no coach can
-- !! be made, and none can be unmade.
--
-- There is one reason to run it: after the migration, creating an account
-- fails (Dashboard → Authentication → Users → Add user answers "Database
-- error saving new user"), or the app can no longer save a name in Profile.
-- Report what was being done, and re-apply the migration as soon as it is
-- understood (docs/runbook/migrations/07-profile-rules.md).
--
-- What it does:
--   * gives handle_new_user and profiles_pin_immutable_columns the text they
--     had after migration 06. Their triggers — on auth.users and on
--     public.profiles — stay: they were there before.
-- No table and no row is touched. The accounts that got a name from the
-- migration keep it, and a profile that was made a coach while it was in
-- place stays a coach: after this file nobody can change that role — re-apply
-- the migration to do it.
--
-- Refused (SLM04) while the ledger records a later migration: those build on
-- these functions. Roll the later ones back first, last applied first.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
DECLARE
  v_later text;
BEGIN
  -- Two questions, in this order: the second cannot be asked without a ledger.
  IF to_regclass('app_private.app_migrations') IS NULL THEN
    RAISE EXCEPTION 'migration 2026_10_11_07_profile_rules is not applied: there is no app_private.app_migrations'
      USING ERRCODE = 'SLM03', HINT = 'Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_11_07_profile_rules') THEN
    RAISE EXCEPTION 'migration 2026_10_11_07_profile_rules is not applied'
      USING ERRCODE = 'SLM03', HINT = 'Nothing was changed.';
  END IF;

  SELECT string_agg(name, ', ' ORDER BY name) INTO v_later
    FROM app_private.app_migrations
   WHERE substring(name from '^[0-9]{4}_[0-9]{2}_[0-9]{2}_([0-9]{2})_')::int > 7;
  IF v_later IS NOT NULL THEN
    RAISE EXCEPTION 'the ledger still records later migrations: %', v_later
      USING ERRCODE = 'SLM04', HINT = 'Roll those back first. Nothing was changed.';
  END IF;
END
$guard$;

-- ------------------------------------------------------------
-- The two functions the migration re-created, as they were. CREATE OR REPLACE
-- keeps their grants; the search_path is repeated because it would be dropped
-- otherwise, and SECURITY DEFINER for the same reason.
-- ------------------------------------------------------------
-- The name the account was created with, or an empty one.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, role, full_name)
  VALUES (
    NEW.id,
    -- Never trust client-supplied metadata for the role (2026_07_12): the
    -- anon key is public, so signup metadata is attacker-controlled. Coach
    -- promotion is a manual UPDATE on profiles.
    'student',
    COALESCE(NEW.raw_user_meta_data->>'full_name', '')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- The role, put back for every caller.
CREATE OR REPLACE FUNCTION public.profiles_pin_immutable_columns()
RETURNS trigger AS $$
BEGIN
  NEW.id := OLD.id;
  NEW.role := OLD.role;
  NEW.created_at := OLD.created_at;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DELETE FROM app_private.app_migrations WHERE name = '2026_10_11_07_profile_rules';

-- No NOTIFY: two function bodies, as in the migration.

COMMIT;
