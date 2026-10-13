-- ============================================================
-- 17 — A block stays open for its athlete for 72 hours after it is switched
--      off, so that training logged offline is saved after a switch of block
-- wave 2 · Checkpoint B · required · finding P55 (the database's half)
--
-- THE HOLE. An athlete writes only in the block being trained: every policy
-- an athlete's write goes through asks program_active_for_session, which
-- answered "the program is the active one, and out of the trash". The app
-- queues what an athlete logs without a connection — in a gym, mostly — and
-- sends it when the connection is back. When the coach activates the next
-- block in between, the whole workout is replayed against a block that is no
-- longer the active one:
--   * each set reaches no row (the app reads that as an error, PGRST116),
--   * the confirmation, a note, a swap or a skip are refused (42501),
-- and nothing can be tried again: the block will not be active again. The
-- session the athlete trained is lost, and the coach never sees it. It takes
-- no fault of anybody: a coach who prepares the next block on Sunday evening
-- and an athlete whose phone was offline on Sunday afternoon.
--
-- WHAT THIS FILE DOES.
--   1. programs.deactivated_at: when the block was last switched off — the
--      time is_active went from true to false. NULL for the block being
--      trained and for a block that never was.
--   2. trg_stamp_program_deactivated_at writes it, and nothing else that
--      carries a user id can: now() when a statement switches a block off —
--      the two UPDATEs of the app that is deployed, activate_program(), a
--      block that goes to the trash while it is active —, NULL when one
--      switches it on. Any other write of a signed-in user leaves the column
--      as it was, silently. A request without a user id — the SQL editor —
--      writes it as it likes on a block that is not active: that is how a
--      window is closed early, or opened again, by hand.
--   3. program_active_for_session answers yes for a program out of the trash
--      that is the active one OR was switched off less than 72 hours ago
--      (and is not a draft). program_active_for_slot asks it, and so do the
--      policies of set_logs, slot_comments, slot_deviations, set_log_videos,
--      session_confirmations and of the files of set-videos, and
--      ensure_set_logs: one function, and the window is everywhere an athlete
--      writes.
--
-- WHAT IT DOES NOT DO.
--   * The lock of a SESSION is untouched: a session the coach archived or
--     reviewed is closed for its athlete, window or not (session_writable).
--   * A block in the trash is closed, window or not.
--   * A block that was switched off BEFORE this file is applied has no time
--     on record, and gets no window: nothing says when it was switched off.
--     No row is written by this file.
--   * Nothing is opened for anybody else: whose row it is, is still asked
--     first.
--
-- WHY 72 HOURS, AND WHY HERE. A phone that was offline through a weekend. The
-- number is written in program_active_for_session and nowhere else in the
-- database.
--
-- WHAT A CLIENT SEES. The app that is deployed, and every one before it, go
-- on as they were: a block that is not active is shown as a past block,
-- read-only. The one thing that changes is the thing this is for — what was
-- waiting on a phone when the block was switched off is saved when it is
-- sent, for three days, instead of failing with "Couldn't save that." A
-- request sent by hand writes in such a block for the same three days.
--
-- Backward compatible: yes, with every client ever deployed.
-- Audit:    supabase/audits/2026_10_13_17_replay_grace_window.audit.sql
-- Rollback: supabase/rollbacks/2026_10_13_17_replay_grace_window.down.sql (reopens P55)
-- Runbook:  docs/runbook/migrations/17-replay-grace-window.md
-- ============================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
DECLARE
  v_list text;
BEGIN
  -- First of all, because no other role can even look at the ledger. What is
  -- created below must belong to the role that owns the tables: both
  -- functions run as their owner, and the default privileges that keep a new
  -- function closed (migration 03) are those of `postgres`.
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'migration 2026_10_13_17_replay_grace_window must be run as postgres, not as %', current_user
      USING HINT = 'Run it from the SQL editor or with `supabase db query --linked`. Nothing was changed.';
  END IF;

  -- Asked before the ledger is read: without it the answer would be
  -- "relation does not exist" instead of this one.
  IF to_regclass('app_private.app_migrations') IS NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_17_replay_grace_window needs 2026_10_13_16_rest_push_scheduling, which is not applied'
      USING ERRCODE = 'SLM02', HINT = 'Apply migrations 01 to 16 first. Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_13_17_replay_grace_window') THEN
    RAISE EXCEPTION 'migration 2026_10_13_17_replay_grace_window is already applied'
      USING ERRCODE = 'SLM01', HINT = 'Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_13_16_rest_push_scheduling') THEN
    RAISE EXCEPTION 'migration 2026_10_13_17_replay_grace_window needs 2026_10_13_16_rest_push_scheduling, which is not applied'
      USING ERRCODE = 'SLM02', HINT = 'Apply that file first. Nothing was changed.';
  END IF;

  -- The column is ADDED. One of that name that is there already was made by
  -- hand, and may hold something else.
  IF EXISTS (
    SELECT 1 FROM pg_attribute a
     WHERE a.attrelid = to_regclass('public.programs')
       AND a.attname = 'deactivated_at' AND NOT a.attisdropped
  ) THEN
    RAISE EXCEPTION 'migration 2026_10_13_17_replay_grace_window would not add: public.programs.deactivated_at is already there'
      USING HINT = 'A column of this file exists, made by hand or by a file that is not in the ledger. Nothing was changed. Stop and report.';
  END IF;

  -- The trigger and its function are CREATED. One that is there already,
  -- under that name, was made by hand.
  SELECT string_agg(w.what, ', ' ORDER BY w.what)
    INTO v_list
    FROM (
      SELECT 'the function ' || p.oid::regprocedure::text AS what
        FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace
         AND p.proname = 'stamp_program_deactivated_at'
      UNION ALL
      SELECT 'the trigger ' || t.tgname || ' on public.programs'
        FROM pg_trigger t
       WHERE t.tgrelid = to_regclass('public.programs')
         AND t.tgname = 'trg_stamp_program_deactivated_at' AND NOT t.tgisinternal
    ) w;
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_17_replay_grace_window would not create: % is already there', v_list
      USING HINT = 'Made by hand or by a file that is not in the ledger. Nothing was changed. Stop and report.';
  END IF;

  -- CREATE OR REPLACE replaces a function with the SAME argument types. A
  -- copy of program_active_for_session with other arguments would stay next
  -- to the new one, and nothing would say so.
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text)
    INTO v_list
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = 'program_active_for_session'
     AND p.oid IS DISTINCT FROM to_regprocedure('public.program_active_for_session(uuid)');
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_17_replay_grace_window would not replace: %', v_list
      USING HINT = 'A function of this file exists with other arguments. Nothing was changed. Stop and report.';
  END IF;

  -- The rule is REPLACED by one that knows the window. It must be the rule
  -- this file was written for — the program is the active one and out of the
  -- trash: one that says something else was changed by hand, and replacing
  -- it would undo that without a word. Compared without regard to how the
  -- text is laid out.
  SELECT CASE
           WHEN count(*) = 0 THEN 'public.program_active_for_session(uuid) is not there'
           WHEN max(regexp_replace(btrim(p.prosrc, E' \t\r\n'), '[[:space:]]+', ' ', 'g'))
                <> 'SELECT p.is_active AND p.deleted_at IS NULL FROM public.sessions sess JOIN public.weeks w ON w.id = sess.week_id JOIN public.programs p ON p.id = w.program_id WHERE sess.id = sess_id'
             THEN 'public.program_active_for_session(uuid) reads: '
                  || max(regexp_replace(btrim(p.prosrc, E' \t\r\n'), '[[:space:]]+', ' ', 'g'))
         END
    INTO v_list
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.program_active_for_session(uuid)');
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_17_replay_grace_window would not replace the rule on when an athlete writes in a block: %', v_list
      USING HINT = 'It was written for a rule that reads: the program is the active one and is not in the trash. Nothing was changed. Stop and report the full message.';
  END IF;

  -- The body of a trigger function is not checked against the database when
  -- it is created: a column or a function that is missing would be found by
  -- the first coach who switches a block. Asked here instead.
  SELECT string_agg(w.what, ', ' ORDER BY w.what)
    INTO v_list
    FROM (
      SELECT c.tbl || '.' || c.col AS what
        FROM (VALUES ('public.programs', 'is_active'),
                     ('public.programs', 'deleted_at'),
                     ('public.programs', 'status')
             ) AS c (tbl, col)
       WHERE NOT EXISTS (
         SELECT 1 FROM pg_attribute a
          WHERE a.attrelid = to_regclass(c.tbl)
            AND a.attname = c.col AND NOT a.attisdropped
       )
      UNION ALL
      SELECT 'auth.uid()' WHERE to_regprocedure('auth.uid()') IS NULL
    ) w;
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_17_replay_grace_window does not find what its functions are written with: %', v_list
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;
END
$guard$;

-- ------------------------------------------------------------
-- 1. A block says when it was switched off.
-- ------------------------------------------------------------
-- No default and no backfill: a block that is not active today has no time on
-- record, and nothing in the database says when it stopped being the active
-- one. Such a block gets no window — it stays closed, as it is now.
--
-- Adding a column that may be NULL rewrites nothing: the table is held for an
-- instant.
ALTER TABLE public.programs
  ADD COLUMN deactivated_at timestamptz;

COMMENT ON COLUMN public.programs.deactivated_at IS
  'When is_active last went from true to false; NULL while the block is the '
  'active one, and for a block that never was. Written by '
  'trg_stamp_program_deactivated_at: a request that carries a user id cannot '
  'write it. For 72 hours from that time the athlete of the block may still '
  'write in it (program_active_for_session), so that training logged offline '
  'is saved after a switch of block (2026_10_13_17).';

-- ------------------------------------------------------------
-- 2. The trigger that writes it — and nobody with a user id.
-- ------------------------------------------------------------
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
--                                       opens one again, by hand
--
-- A TRIGGER, NOT A LINE IN activate_program: the app that is deployed
-- switches blocks with two UPDATEs of its own, and so does "new block, set
-- active". A trigger on the row sees all of them.
--
-- WHY A SIGNED-IN USER MAY NOT WRITE IT. program_active_for_session reads the
-- column as "the athlete may still write here". The author of a draft
-- updates the row of their draft ("Students update own draft programs"), and
-- the pin on that row (pin_program_authoring_columns) holds the columns that
-- existed when it was written. A time put there — one far in the future —
-- would stay with the program once the coach approves it, and keep it open
-- for its athlete for good. The coach is held the same way: a coach who
-- wants an athlete to write in a block activates it.
--
-- now() is the time the request started — the clock program_active_for_session
-- compares with.
--
-- SECURITY DEFINER, like the pin on the same table: it must not depend on
-- what the role whose statement fires it may execute. It reads no table.
--
-- BEFORE triggers fire in the order of their names: on an UPDATE this one
-- comes after trg_pin_program_authoring_columns. Neither reads a column the
-- other writes.
CREATE FUNCTION public.stamp_program_deactivated_at()
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

-- A trigger function: nobody calls it.
REVOKE ALL ON FUNCTION public.stamp_program_deactivated_at() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trg_stamp_program_deactivated_at
  BEFORE INSERT OR UPDATE ON public.programs
  FOR EACH ROW EXECUTE FUNCTION public.stamp_program_deactivated_at();

-- ------------------------------------------------------------
-- 3. The window: 72 hours after a block is switched off.
-- ------------------------------------------------------------
-- The one function every write of an athlete asks about the PROGRAM — through
-- program_active_for_slot, in the policies of set_logs, slot_comments,
-- slot_deviations, set_log_videos and of the files of set-videos; directly,
-- in the policies of session_confirmations and in ensure_set_logs. None of
-- them is touched: the window is theirs through this function.
--
--   out of the trash, and …
--     the active block                               yes
--     approved, switched off less than 72 hours ago  yes   <- new
--     anything else                                  no
--   in the trash                                     no — window or not
--   no such session                                  NULL, as before
--
-- "approved": a draft cannot be active (programs_draft_not_active), so a
-- draft has no time of its own; the word keeps a program that was made a
-- draft again from being trained in.
--
-- true or false for a session that exists — never NULL because the time is:
-- a caller asks `= true` or `IS NOT TRUE`, and a test or an audit compares
-- with false.
--
-- Same header as before: arguments, STABLE, SECURITY DEFINER, search_path —
-- CREATE OR REPLACE drops a SET clause the new text does not repeat. It
-- keeps the privileges; they are said again all the same, so that the result
-- does not depend on what they were.
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

REVOKE ALL ON FUNCTION public.program_active_for_session(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.program_active_for_session(uuid) TO authenticated;

-- ------------------------------------------------------------
-- The file reads its own result back.
-- ------------------------------------------------------------
DO $verify$
DECLARE
  v_list text;
BEGIN
  SELECT string_agg(w.wrong, '; ' ORDER BY w.wrong)
    INTO v_list
    FROM (
      SELECT 'public.programs.deactivated_at is not a timestamp with time zone that may be NULL, without a default' AS wrong
       WHERE NOT EXISTS (
         SELECT 1 FROM pg_attribute a
          WHERE a.attrelid = 'public.programs'::regclass
            AND a.attname = 'deactivated_at' AND NOT a.attisdropped
            AND format_type(a.atttypid, a.atttypmod) = 'timestamp with time zone'
            AND NOT a.attnotnull AND NOT a.atthasdef
       )
      UNION ALL
      SELECT 'the trigger trg_stamp_program_deactivated_at is not the one meant: '
             || COALESCE((SELECT pg_get_triggerdef(t.oid, true) || CASE t.tgenabled WHEN 'O' THEN '' ELSE ' (not enabled)' END
                            FROM pg_trigger t
                           WHERE t.tgrelid = 'public.programs'::regclass
                             AND t.tgname = 'trg_stamp_program_deactivated_at' AND NOT t.tgisinternal),
                         'it is not there')
       WHERE NOT EXISTS (
         SELECT 1 FROM pg_trigger t
          WHERE t.tgrelid = 'public.programs'::regclass
            AND t.tgname = 'trg_stamp_program_deactivated_at' AND NOT t.tgisinternal
            AND t.tgenabled = 'O'
            AND t.tgfoid = to_regprocedure('public.stamp_program_deactivated_at()')
            -- a row trigger, BEFORE, on INSERT and UPDATE, of any column
            AND t.tgtype = 1 + 2 + 4 + 16
            AND t.tgattr::text = ''
       )
      UNION ALL
      SELECT f.signature || ' ' || f.wrong
        FROM (
          SELECT s.signature,
                 CASE
                   WHEN p.oid IS NULL THEN 'is not there'
                   WHEN pg_get_userbyid(p.proowner) <> 'postgres' THEN 'is not owned by postgres'
                   WHEN NOT p.prosecdef THEN 'does not run as its owner'
                   WHEN NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) AS setting
                                     WHERE setting = 'search_path=public, pg_temp')
                     THEN 'has no search_path = public, pg_temp'
                   WHEN has_function_privilege('anon', p.oid, 'EXECUTE')
                     THEN 'is executable without a session'
                   WHEN has_function_privilege('authenticated', p.oid, 'EXECUTE') IS DISTINCT FROM s.for_users
                     THEN CASE WHEN s.for_users THEN 'is not executable by a signed-in user: every write of an athlete would be refused'
                               ELSE 'is executable by a signed-in user' END
                   WHEN s.stable AND p.provolatile <> 's' THEN 'is not STABLE'
                   WHEN position(s.holds IN p.prosrc) = 0 THEN 'does not read ' || s.holds
                 END AS wrong
            FROM (VALUES ('public.program_active_for_session(uuid)', true,  true,  'p.deactivated_at > now() - interval ''72 hours'''),
                         ('public.stamp_program_deactivated_at()',   false, false, 'NEW.deactivated_at := now();')
                 ) AS s (signature, for_users, stable, holds)
            LEFT JOIN pg_proc p ON p.oid = to_regprocedure(s.signature)
        ) f
       WHERE f.wrong IS NOT NULL
    ) w;
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_17_replay_grace_window did not get what it meant: %', v_list
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;
END
$verify$;

INSERT INTO app_private.app_migrations (name)
VALUES ('2026_10_13_17_replay_grace_window')
RETURNING name, applied_at;

-- A column joined public.programs: PostgREST learns of it when its schema
-- cache is reloaded.
NOTIFY pgrst, 'reload schema';

COMMIT;
