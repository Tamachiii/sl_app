-- ============================================================
-- 11 — A block is activated, and sessions and phases are reordered, in one
--      request each
-- wave 1 · Checkpoint A3 · required · findings P16, P51 (the database's half)
--
-- THE HOLES. Three things the coach does are several requests today, and
-- each request is a transaction of its own:
--   * "Set active" is two: every active program of the athlete is
--     deactivated, then the chosen one is activated
--     (src/hooks/useProgram.js, useSetActiveProgram; useCreateProgram with
--     setActive does the same around an INSERT). When the second request is
--     lost — the network, a tab that closes — the athlete has NO active
--     block: the training page says "No program assigned yet", and every set
--     they log, the ones waiting on their phone included, is refused, because
--     an athlete writes only in the block being trained (P16).
--   * reordering the sessions of a phase is two requests PER SESSION: each
--     one is parked at 100000 + its place, then each one is given its place
--     (useReorderSessions; sessions_week_sort_order_unique is not
--     deferrable). Reordering the phases of a block does the same with
--     week_number (useReorderWeeks). A request that is lost half-way, or a
--     second drag that starts before the first has finished, leaves sessions
--     numbered 100000 and more, or an order nobody chose — and since
--     2026_08_22 that number IS the athlete's queue. A phase left like that
--     can no longer be reordered by the same app: parking a session at
--     100000 + n meets the one that was left there (P51).
--
-- WHAT THIS FILE DOES. Pure expand: three functions, and nothing else — no
-- table, no column, no policy, no trigger, no row.
--   1. activate_program(p_program_id) deactivates the other programs of the
--      athlete and activates this one. It refuses a draft and a program in
--      the trash before it writes anything.
--   2. reorder_sessions(p_week_id, p_ids) gives the sessions of one phase the
--      order of the list: sort_order 0 to n-1.
--   3. reorder_weeks(p_program_id, p_ids) gives the phases of one block the
--      order of the list: week_number 1 to n.
--      Both ask for EVERY child of the parent, once each — the archived
--      sessions included, because the unique key counts them too — and
--      refuse any other list.
-- A function call is one statement: it happens completely or not at all.
--
-- SECURITY INVOKER, all three, like move_session: they are given no right
-- their caller does not have. The coach's policies ("Coaches manage
-- programs", "… weeks", "… sessions") are what lets the coach through and
-- keeps everybody else out; an athlete reads their own programs and writes
-- none of this. Executable by a signed-in user, never without a session.
--
-- WHAT A CLIENT SEES. Nothing: the app that is deployed today does not call
-- them, and goes on with its own requests, which work as before. The next
-- version of the app calls them — it needs this file in the database first.
--
-- Backward compatible: yes, with every client ever deployed.
-- Audit:    supabase/audits/2026_10_13_11_activate_reorder_rpcs.audit.sql
-- Rollback: supabase/rollbacks/2026_10_13_11_activate_reorder_rpcs.down.sql
-- Runbook:  docs/runbook/migrations/11-activate-reorder-rpcs.md
-- ============================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
DECLARE
  v_there   text;
  v_missing text;
BEGIN
  -- First of all, because no other role can even look at the ledger. What is
  -- created below must belong to the role that owns the tables: the default
  -- privileges that keep a new function closed (migration 03) are those of
  -- `postgres`.
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'migration 2026_10_13_11_activate_reorder_rpcs must be run as postgres, not as %', current_user
      USING HINT = 'Run it from the SQL editor or with `supabase db query --linked`. Nothing was changed.';
  END IF;

  -- Asked before the ledger is read: without it the answer would be
  -- "relation does not exist" instead of this one.
  IF to_regclass('app_private.app_migrations') IS NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_11_activate_reorder_rpcs needs 2026_10_13_10_goals_fk_coach_links, which is not applied'
      USING ERRCODE = 'SLM02', HINT = 'Apply migrations 01 to 10 first. Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_13_11_activate_reorder_rpcs') THEN
    RAISE EXCEPTION 'migration 2026_10_13_11_activate_reorder_rpcs is already applied'
      USING ERRCODE = 'SLM01', HINT = 'Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_13_10_goals_fk_coach_links') THEN
    RAISE EXCEPTION 'migration 2026_10_13_11_activate_reorder_rpcs needs 2026_10_13_10_goals_fk_coach_links, which is not applied'
      USING ERRCODE = 'SLM02', HINT = 'Apply that file first. Nothing was changed.';
  END IF;

  -- The three functions are CREATED, not replaced. One that is there already,
  -- under one of the names — with these arguments or with others — was made
  -- by hand: the API finds a function by its name and the names of its
  -- arguments, and two of a name are a call that may reach the wrong one.
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text)
    INTO v_there
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('activate_program', 'reorder_sessions', 'reorder_weeks');
  IF v_there IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_11_activate_reorder_rpcs would not create: % is already there', v_there
      USING HINT = 'A function of this file exists, made by hand or by a file that is not in the ledger. Nothing was changed. Stop and report.';
  END IF;

  -- The body of a function is not checked against the tables when it is
  -- created: a column that is missing would be found by the coach's first
  -- drag. Asked here instead.
  SELECT string_agg(w.tbl || '.' || w.col, ', ' ORDER BY w.tbl, w.col)
    INTO v_missing
    FROM (VALUES ('public.programs', 'id'),
                 ('public.programs', 'student_id'),
                 ('public.programs', 'status'),
                 ('public.programs', 'deleted_at'),
                 ('public.programs', 'is_active'),
                 ('public.weeks',    'id'),
                 ('public.weeks',    'program_id'),
                 ('public.weeks',    'week_number'),
                 ('public.sessions', 'id'),
                 ('public.sessions', 'week_id'),
                 ('public.sessions', 'sort_order')
         ) AS w (tbl, col)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = to_regclass(w.tbl)
        AND a.attname = w.col AND NOT a.attisdropped
   );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_11_activate_reorder_rpcs does not find the columns its functions are written with: %', v_missing
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;
END
$guard$;

-- ------------------------------------------------------------
-- 1. One block is being trained: the one the coach chose.
-- ------------------------------------------------------------
-- programs_one_active_per_student lets an athlete have ONE active program,
-- so making another one active is two writes: the others off, this one on.
-- Here they are one statement of the caller, and so one transaction: both
-- happen, or neither.
--
--   returns   { "program_id", "student_id", "already_active", "deactivated" }
--             already_active  it was the active one: nothing was activated
--             deactivated     how many other programs were switched off
--
--   refuses   program_not_found   no program with this id that the caller can
--                                 read — somebody else's athlete and no such
--                                 program are the same answer
--             not authorized      (42501) the caller reads the program and
--                                 may not write it: its athlete
--             program_is_draft    a draft is approved first (approve_program);
--                                 it could not be active anyway
--                                 (programs_draft_not_active)
--             program_in_trash    it is restored first: every surface leaves
--                                 a program in the trash out, and an athlete
--                                 writes nothing in one
--   … and has then written nothing. Called for the program that is active
--   already, it writes nothing either and says so: a request that is sent
--   twice is not an error.
--
-- EVERY other active program of the athlete is switched off, whatever else
-- it is — also one that sits in the trash and still holds the place, which
-- no screen shows and no screen can switch off.
--
-- The programs of the athlete are locked first, in the order of their ids:
-- two activations for one athlete wait for each other. Without it the second
-- one does not see the program the first one has just made active, and ends
-- on the unique index.
--
-- SECURITY INVOKER: "Coaches manage programs" is what lets the coach write.
-- The lock is asked the way an UPDATE is (FOR NO KEY UPDATE goes through the
-- policies of UPDATE), so a caller who may only read finds no row to hold.
CREATE FUNCTION public.activate_program(p_program_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_student_id  uuid;
  v_status      text;
  v_deleted_at  timestamptz;
  v_was_active  boolean;
  v_deactivated integer;
BEGIN
  SELECT p.student_id INTO v_student_id
    FROM public.programs p
   WHERE p.id = p_program_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'program_not_found'
      USING DETAIL = 'No program with this id can be read by the caller.',
            HINT = 'Nothing was changed.';
  END IF;

  PERFORM 1
     FROM public.programs p
    WHERE p.student_id = v_student_id
    ORDER BY p.id
      FOR NO KEY UPDATE;

  -- Read again, now that nothing can change it.
  SELECT p.status, p.deleted_at, p.is_active
    INTO v_status, v_deleted_at, v_was_active
    FROM public.programs p
   WHERE p.id = p_program_id
     FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not authorized'
      USING ERRCODE = 'insufficient_privilege',
            DETAIL = 'The caller reads this program and may not write it.',
            HINT = 'A program is activated by the coach of its athlete. Nothing was changed.';
  END IF;

  IF v_status = 'draft' THEN
    RAISE EXCEPTION 'program_is_draft'
      USING DETAIL = 'A draft is never the active program.',
            HINT = 'Approve it first. Nothing was changed.';
  END IF;
  IF v_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'program_in_trash'
      USING DETAIL = 'A program in the trash is never the active program.',
            HINT = 'Restore it first. Nothing was changed.';
  END IF;

  UPDATE public.programs p
     SET is_active = false
   WHERE p.student_id = v_student_id
     AND p.is_active
     AND p.id <> p_program_id;
  GET DIAGNOSTICS v_deactivated = ROW_COUNT;

  IF NOT v_was_active THEN
    UPDATE public.programs p
       SET is_active = true
     WHERE p.id = p_program_id;
  END IF;

  RETURN jsonb_build_object(
    'program_id',     p_program_id,
    'student_id',     v_student_id,
    'already_active', v_was_active,
    'deactivated',    v_deactivated
  );
END;
$$;

REVOKE ALL ON FUNCTION public.activate_program(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.activate_program(uuid) TO authenticated;

-- ------------------------------------------------------------
-- 2. The sessions of a phase, in the order of a list.
-- ------------------------------------------------------------
-- sessions.sort_order is the order of a phase, for the coach's sheet and for
-- the athlete's queue, and (week_id, sort_order) is unique and NOT
-- deferrable: PostgreSQL checks it row by row, so two sessions cannot simply
-- exchange their numbers. Every session is parked above every number the
-- phase holds, then given its place — here in one statement of the caller.
--
--   p_ids     EVERY session of the phase, once each, in the order wanted —
--             the archived ones included: the unique key counts them too
--   result    sort_order 0 to n-1, in the order of the list. A phase that an
--             interrupted reorder left at 100000 and more is put right by
--             the same call.
--
--   refuses   week_not_found         no phase with this id that the caller
--                                    can read
--             not authorized         (42501) the caller reads the phase and
--                                    may not write it: its athlete
--             reorder_ids_mismatch   the list is not exactly the sessions of
--                                    the phase: one is missing, one is not of
--                                    this phase, one is there twice or is
--                                    NULL. The DETAIL counts each. It is what
--                                    a page that was loaded before a session
--                                    was added, moved or deleted sends: read
--                                    again, then try again.
--   … and has then written nothing. A list that is the order the phase has
--   already writes nothing either.
--
-- The phase is locked FOR UPDATE first: two reorders of one phase wait for
-- each other, and a session that is being added or moved INTO the phase
-- waits too (its foreign key asks for the row) — so the list is judged
-- against the sessions that are there when the numbers are written. The
-- sessions are then locked in the order of their ids: none is deleted or
-- moved away in between.
--
-- SECURITY INVOKER: "Coaches manage weeks" and "Coaches manage sessions" are
-- what lets the coach write; the author of a draft reorders it through the
-- policies of a draft.
CREATE FUNCTION public.reorder_sessions(p_week_id uuid, p_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ids      uuid[] := COALESCE(p_ids, '{}');
  v_children integer;
  v_top      integer;
  v_listed   integer;
  v_distinct integer;
  v_found    integer;
  v_parked   integer;
BEGIN
  PERFORM 1 FROM public.weeks w WHERE w.id = p_week_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'week_not_found'
      USING DETAIL = 'No phase with this id can be read by the caller.',
            HINT = 'Nothing was changed.';
  END IF;

  PERFORM 1 FROM public.weeks w WHERE w.id = p_week_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not authorized'
      USING ERRCODE = 'insufficient_privilege',
            DETAIL = 'The caller reads this phase and may not write it.',
            HINT = 'Sessions are reordered by the coach of the athlete. Nothing was changed.';
  END IF;

  PERFORM 1
     FROM public.sessions s
    WHERE s.week_id = p_week_id
    ORDER BY s.id
      FOR UPDATE;

  SELECT count(*), COALESCE(max(s.sort_order), 0)
    INTO v_children, v_top
    FROM public.sessions s
   WHERE s.week_id = p_week_id;

  SELECT count(*), count(DISTINCT t.id), count(DISTINCT s.id)
    INTO v_listed, v_distinct, v_found
    FROM unnest(v_ids) AS t(id)
    LEFT JOIN public.sessions s ON s.id = t.id AND s.week_id = p_week_id;

  IF v_found <> v_children OR v_distinct <> v_found OR v_listed <> v_distinct THEN
    RAISE EXCEPTION 'reorder_ids_mismatch'
      USING DETAIL = format(
              'The phase has %s session(s), archived ones included. The list holds %s id(s): '
              || '%s session(s) of the phase are missing from it, %s id(s) are not sessions of this phase, '
              || '%s are there twice or empty.',
              v_children, v_listed, v_children - v_found, v_distinct - v_found, v_listed - v_distinct),
            HINT = 'Send every session of the phase once, archived ones included, in the order wanted. Nothing was changed.';
  END IF;

  -- Already in that order, and numbered 0 to n-1: nothing to write.
  IF NOT EXISTS (
    SELECT 1
      FROM unnest(v_ids) WITH ORDINALITY AS t(id, place)
      JOIN public.sessions s ON s.id = t.id
     WHERE s.sort_order <> t.place - 1
  ) THEN
    RETURN;
  END IF;

  -- Park: above every number the phase holds — so that no parked session
  -- meets one that has not moved yet — and above n, so that no place given
  -- below meets a session that is still parked.
  v_top := GREATEST(v_top, v_children);
  UPDATE public.sessions s
     SET sort_order = (v_top + t.place)::integer
    FROM unnest(v_ids) WITH ORDINALITY AS t(id, place)
   WHERE s.id = t.id;
  GET DIAGNOSTICS v_parked = ROW_COUNT;
  IF v_parked <> v_children THEN
    RAISE EXCEPTION 'not authorized'
      USING ERRCODE = 'insufficient_privilege',
            DETAIL = format('The caller may write %s of the %s session(s) of this phase.', v_parked, v_children),
            HINT = 'Nothing was changed.';
  END IF;

  -- Place.
  UPDATE public.sessions s
     SET sort_order = (t.place - 1)::integer
    FROM unnest(v_ids) WITH ORDINALITY AS t(id, place)
   WHERE s.id = t.id;
END;
$$;

REVOKE ALL ON FUNCTION public.reorder_sessions(uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reorder_sessions(uuid, uuid[]) TO authenticated;

-- ------------------------------------------------------------
-- 3. The phases of a block, in the order of a list.
-- ------------------------------------------------------------
-- The same, one level up: weeks.week_number is the order of the phases of a
-- program (never shown; adopt_swap and adopt_skip read "later in the
-- program" off it), and (program_id, week_number) is unique and not
-- deferrable.
--
--   p_ids     EVERY phase of the program, once each, in the order wanted
--   result    week_number 1 to n, in the order of the list
--
--   refuses   program_not_found      no program with this id that the caller
--                                    can read
--             not authorized         (42501) the caller reads the program and
--                                    may not write it: its athlete
--             reorder_ids_mismatch   the list is not exactly the phases of
--                                    the program
--   … and has then written nothing.
--
-- The program is locked FOR UPDATE first — two reorders of one block wait
-- for each other, and so does a phase that is being added — then its phases,
-- in the order of their ids.
--
-- SECURITY INVOKER: "Coaches manage programs" and "Coaches manage weeks" are
-- what lets the coach write.
CREATE FUNCTION public.reorder_weeks(p_program_id uuid, p_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ids      uuid[] := COALESCE(p_ids, '{}');
  v_children integer;
  v_top      integer;
  v_listed   integer;
  v_distinct integer;
  v_found    integer;
  v_parked   integer;
BEGIN
  PERFORM 1 FROM public.programs p WHERE p.id = p_program_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'program_not_found'
      USING DETAIL = 'No program with this id can be read by the caller.',
            HINT = 'Nothing was changed.';
  END IF;

  PERFORM 1 FROM public.programs p WHERE p.id = p_program_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not authorized'
      USING ERRCODE = 'insufficient_privilege',
            DETAIL = 'The caller reads this program and may not write it.',
            HINT = 'Phases are reordered by the coach of the athlete. Nothing was changed.';
  END IF;

  PERFORM 1
     FROM public.weeks w
    WHERE w.program_id = p_program_id
    ORDER BY w.id
      FOR UPDATE;

  SELECT count(*), COALESCE(max(w.week_number), 0)
    INTO v_children, v_top
    FROM public.weeks w
   WHERE w.program_id = p_program_id;

  SELECT count(*), count(DISTINCT t.id), count(DISTINCT w.id)
    INTO v_listed, v_distinct, v_found
    FROM unnest(v_ids) AS t(id)
    LEFT JOIN public.weeks w ON w.id = t.id AND w.program_id = p_program_id;

  IF v_found <> v_children OR v_distinct <> v_found OR v_listed <> v_distinct THEN
    RAISE EXCEPTION 'reorder_ids_mismatch'
      USING DETAIL = format(
              'The program has %s phase(s). The list holds %s id(s): '
              || '%s phase(s) of the program are missing from it, %s id(s) are not phases of this program, '
              || '%s are there twice or empty.',
              v_children, v_listed, v_children - v_found, v_distinct - v_found, v_listed - v_distinct),
            HINT = 'Send every phase of the program once, in the order wanted. Nothing was changed.';
  END IF;

  -- Already in that order, and numbered 1 to n: nothing to write.
  IF NOT EXISTS (
    SELECT 1
      FROM unnest(v_ids) WITH ORDINALITY AS t(id, place)
      JOIN public.weeks w ON w.id = t.id
     WHERE w.week_number <> t.place
  ) THEN
    RETURN;
  END IF;

  -- Park above every number the program holds and above n, then place.
  v_top := GREATEST(v_top, v_children);
  UPDATE public.weeks w
     SET week_number = (v_top + t.place)::integer
    FROM unnest(v_ids) WITH ORDINALITY AS t(id, place)
   WHERE w.id = t.id;
  GET DIAGNOSTICS v_parked = ROW_COUNT;
  IF v_parked <> v_children THEN
    RAISE EXCEPTION 'not authorized'
      USING ERRCODE = 'insufficient_privilege',
            DETAIL = format('The caller may write %s of the %s phase(s) of this program.', v_parked, v_children),
            HINT = 'Nothing was changed.';
  END IF;

  UPDATE public.weeks w
     SET week_number = t.place::integer
    FROM unnest(v_ids) WITH ORDINALITY AS t(id, place)
   WHERE w.id = t.id;
END;
$$;

REVOKE ALL ON FUNCTION public.reorder_weeks(uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reorder_weeks(uuid, uuid[]) TO authenticated;

-- ------------------------------------------------------------
-- 4. Read the result back. Anything else than what was meant raises, and the
--    whole file is undone: either the database is as described, or untouched.
-- ------------------------------------------------------------
DO $verify$
DECLARE
  v_list text;
BEGIN
  -- The three functions: owned by postgres, search_path pinned, running with
  -- the rights of their caller, open to a signed-in user and closed to a
  -- request without a session.
  WITH wanted (signature, answers) AS (
    VALUES ('public.activate_program(uuid)',         'jsonb'),
           ('public.reorder_sessions(uuid, uuid[])', 'void'),
           ('public.reorder_weeks(uuid, uuid[])',    'void')
  ),
  found AS (
    SELECT w.signature, w.answers, p.oid, p.proowner, p.proconfig, p.prosecdef, p.prorettype, p.proacl
      FROM wanted w
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(w.signature)
  )
  SELECT string_agg(f.signature || ': ' || f.wrong, '; ' ORDER BY f.signature) INTO v_list
    FROM (
      SELECT signature,
             CASE WHEN oid IS NULL THEN 'missing' ELSE concat_ws(', ',
               CASE WHEN pg_get_userbyid(proowner) <> 'postgres' THEN 'not owned by postgres' END,
               CASE WHEN prorettype <> to_regtype(answers) THEN 'it does not return ' || answers END,
               CASE WHEN has_function_privilege('anon', oid, 'EXECUTE') THEN 'anon may execute it' END,
               CASE WHEN EXISTS (SELECT 1 FROM aclexplode(COALESCE(proacl, acldefault('f', proowner))) a
                                  WHERE a.grantee = 0)
                    THEN 'PUBLIC may execute it' END,
               CASE WHEN NOT has_function_privilege('authenticated', oid, 'EXECUTE')
                    THEN 'a signed-in user may NOT execute it' END,
               CASE WHEN prosecdef THEN 'it runs as its owner' END,
               CASE WHEN proconfig IS NULL OR NOT ('search_path=public, pg_temp' = ANY (proconfig))
                    THEN 'search_path is not public, pg_temp' END
             ) END AS wrong
        FROM found
    ) f
   WHERE f.wrong <> '';
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_11_activate_reorder_rpcs did not get the functions it meant: %', v_list
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;

  -- One function per name: the API calls by name.
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO v_list
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('activate_program', 'reorder_sessions', 'reorder_weeks')
     AND NOT EXISTS (
       SELECT 1
         FROM unnest(ARRAY[
                'public.activate_program(uuid)',
                'public.reorder_sessions(uuid, uuid[])',
                'public.reorder_weeks(uuid, uuid[])'
              ]) AS known(signature)
        WHERE to_regprocedure(known.signature) = p.oid
     );
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_11_activate_reorder_rpcs did not get the functions it meant: % stands next to them', v_list
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;
END
$verify$;

INSERT INTO app_private.app_migrations (name)
VALUES ('2026_10_13_11_activate_reorder_rpcs')
RETURNING name, applied_at;

-- Three functions joined public: PostgREST learns of a function when its
-- schema cache is reloaded.
NOTIFY pgrst, 'reload schema';

COMMIT;
