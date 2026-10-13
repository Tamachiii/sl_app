-- Rollback of 2026_10_13_17_replay_grace_window: puts back the rule "an
-- athlete writes only in the block that is the active one", and drops the
-- trigger, its function and the column programs.deactivated_at.
--
-- !! THIS REOPENS FINDING P55. From this file on, training that was logged
-- !! without a connection while the coach activated the next block is
-- !! refused when the phone sends it, and lost — as before the migration.
-- !! And it closes, at once, every block that is inside its 72 hours: what
-- !! is waiting on a phone for one of them is refused when it arrives.
--
-- Every app works without the migration as it did before it: none reads the
-- column, and a block that is not active is shown as read-only either way.
-- There is no reason to run this file other than the check of the page
-- answering NOT PROTECTED or BROKEN, or a migration applied to the wrong
-- project (docs/runbook/migrations/17-replay-grace-window.md).
--
-- THE TIMES DO NOT COME BACK. programs.deactivated_at goes with its column:
-- applied again, the migration starts with no block on record, and a block
-- that was switched off before then gets no window. No row is deleted, and no
-- set that was saved inside a window is touched.
--
-- Refused (SLM04) while the ledger records a later migration: those build on
-- this one. Roll the later ones back first, last applied first.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
DECLARE
  v_later text;
BEGIN
  -- Two questions, in this order: the second cannot be asked without a ledger.
  IF to_regclass('app_private.app_migrations') IS NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_17_replay_grace_window is not applied: there is no app_private.app_migrations'
      USING ERRCODE = 'SLM03', HINT = 'Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_13_17_replay_grace_window') THEN
    RAISE EXCEPTION 'migration 2026_10_13_17_replay_grace_window is not applied'
      USING ERRCODE = 'SLM03', HINT = 'Nothing was changed.';
  END IF;

  SELECT string_agg(name, ', ' ORDER BY name) INTO v_later
    FROM app_private.app_migrations
   WHERE substring(name from '^[0-9]{4}_[0-9]{2}_[0-9]{2}_([0-9]{2})_')::int > 17;
  IF v_later IS NOT NULL THEN
    RAISE EXCEPTION 'the ledger still records later migrations: %', v_later
      USING ERRCODE = 'SLM04', HINT = 'Roll those back first. Nothing was changed.';
  END IF;
END
$guard$;

-- The rule as it was (2026_07_13, with the search_path of migration 03): the
-- program is the active one, and out of the trash. First, while the column
-- the newer text reads is still there. CREATE OR REPLACE keeps the
-- privileges: a signed-in user goes on executing it, as the policies need.
CREATE OR REPLACE FUNCTION public.program_active_for_session(sess_id uuid)
RETURNS boolean AS $$
  SELECT p.is_active AND p.deleted_at IS NULL
  FROM public.sessions sess
  JOIN public.weeks w    ON w.id = sess.week_id
  JOIN public.programs p ON p.id = w.program_id
  WHERE sess.id = sess_id
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.program_active_for_session(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.program_active_for_session(uuid) TO authenticated;

DROP TRIGGER IF EXISTS trg_stamp_program_deactivated_at ON public.programs;
DROP FUNCTION IF EXISTS public.stamp_program_deactivated_at();

-- The times go with it.
ALTER TABLE public.programs
  DROP COLUMN deactivated_at;

DELETE FROM app_private.app_migrations WHERE name = '2026_10_13_17_replay_grace_window';

-- A column left public.programs: PostgREST must forget it.
NOTIFY pgrst, 'reload schema';

COMMIT;
