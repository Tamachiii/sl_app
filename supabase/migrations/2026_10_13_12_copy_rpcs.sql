-- ============================================================
-- 12 — A session, a phase and a block are duplicated, and sessions are
--      copied into another phase, in one request each
-- wave 1 · Checkpoint A3 · required · finding P52 (the database's half)
--
-- THE HOLE. "Duplicate" and "Copy to…" are done by the app, one request per
-- row or per table (src/hooks/useDuplicate.js): the session, then its
-- exercises, then the sets of those exercises — and for a block, the same
-- again for every phase and every session of it, thirty to forty requests,
-- each one a transaction of its own.
--   * A request that is lost half-way — the network, a tab that closes —
--     leaves what the requests before it made: a session with no exercise,
--     or exercises with no set, in the block the athlete is training, where
--     they see it at once. Nothing says that the copy is not whole: the app
--     never shows how far it got.
--   * The sets are read back with one request that names every exercise of
--     the phase in its address, and answers at most 1000 rows without saying
--     that there were more.
--
-- WHAT THIS FILE DOES. Pure expand: four functions, and nothing else — no
-- table, no column, no policy, no trigger, no row.
--   1. duplicate_session(p_session_id, p_title_suffix)
--        a copy of the session, RIGHT AFTER it in its phase; the sessions
--        that follow move down by one
--   2. copy_sessions(p_session_ids, p_dest_week_id)
--        one copy per entry of the list, at the end of the phase, in the
--        order of the list
--   3. duplicate_week(p_week_id, p_dest_program_id, p_label_suffix)
--        a copy of the phase with its sessions, as the last phase of the
--        program — its own, or another one
--   4. duplicate_program(p_program_id, p_target_student_id, p_name_suffix)
--        a copy of the block with its phases and sessions, NOT active, last
--        in the list of the athlete — its own, or another one of the coach
-- A function call is one statement: the copy is whole, or it is not there.
--
-- WHAT A COPY IS. The prescription, and nothing of what was trained:
--   a session    its title and its recommended weekday. Not its recommended
--                date, not its review, not the day it was trained. A phase
--                or a block that is duplicated keeps its archived sessions
--                archived; a session that is copied on its own arrives live.
--   an exercise  everything the coach wrote: the exercise, the number of
--                sets, the slot's own numbers, its place, its superset, its
--                note, the sets to film.
--   a set        its number and its four targets. Not done, failed, skipped,
--                the RPE, the weight, the actuals, the times — and not the
--                sets the athlete added themselves.
--   never        a note or a swap of the athlete, a video, a confirmation.
-- That is what the app copies today, column for column. Two things differ:
-- the copy of a session stands right after its source instead of at the end
-- of the phase, and a phase or a block is copied with its sessions numbered
-- from 0 and its phases from 1, in their order, whatever the numbers were.
--
-- AN EXERCISE OF ANOTHER COACH'S LIBRARY is left out, and the answer says
-- how many were (slots_left_out). Since migration 05 an exercise slot takes
-- an exercise of the library of its program's coach; an athlete who changed
-- coach still has blocks written with the former coach's exercises, and
-- copying one of those would raise on its first slot. The rest of the copy
-- is made.
--
-- SECURITY INVOKER, all four, like move_session and the three functions of
-- migration 11: they are given no right their caller does not have. What is
-- copied is what the caller can READ; where it goes is where the caller can
-- WRITE. The coach's policies let the coach through, for their own athletes
-- and from one of them to another; an athlete reads their own blocks and
-- writes none of this. Executable by a signed-in user, never without a
-- session.
--
-- WHAT A CLIENT SEES. Nothing: the app that is deployed today does not call
-- them, and goes on with its own requests, which work as before. The next
-- version of the app calls them — it needs this file in the database first.
--
-- Backward compatible: yes, with every client ever deployed.
-- Audit:    supabase/audits/2026_10_13_12_copy_rpcs.audit.sql
-- Rollback: supabase/rollbacks/2026_10_13_12_copy_rpcs.down.sql
-- Runbook:  docs/runbook/migrations/12-copy-rpcs.md
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
    RAISE EXCEPTION 'migration 2026_10_13_12_copy_rpcs must be run as postgres, not as %', current_user
      USING HINT = 'Run it from the SQL editor or with `supabase db query --linked`. Nothing was changed.';
  END IF;

  -- Asked before the ledger is read: without it the answer would be
  -- "relation does not exist" instead of this one.
  IF to_regclass('app_private.app_migrations') IS NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_12_copy_rpcs needs 2026_10_13_11_activate_reorder_rpcs, which is not applied'
      USING ERRCODE = 'SLM02', HINT = 'Apply migrations 01 to 11 first. Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_13_12_copy_rpcs') THEN
    RAISE EXCEPTION 'migration 2026_10_13_12_copy_rpcs is already applied'
      USING ERRCODE = 'SLM01', HINT = 'Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_13_11_activate_reorder_rpcs') THEN
    RAISE EXCEPTION 'migration 2026_10_13_12_copy_rpcs needs 2026_10_13_11_activate_reorder_rpcs, which is not applied'
      USING ERRCODE = 'SLM02', HINT = 'Apply that file first. Nothing was changed.';
  END IF;

  -- The four functions are CREATED, not replaced. One that is there already,
  -- under one of the names — with these arguments or with others — was made
  -- by hand: the API finds a function by its name and the names of its
  -- arguments, and two of a name are a call that may reach the wrong one.
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text)
    INTO v_there
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('duplicate_session', 'copy_sessions', 'duplicate_week', 'duplicate_program');
  IF v_there IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_12_copy_rpcs would not create: % is already there', v_there
      USING HINT = 'A function of this file exists, made by hand or by a file that is not in the ledger. Nothing was changed. Stop and report.';
  END IF;

  -- The body of a function is not checked against the tables when it is
  -- created: a column that is missing would be found by the coach's first
  -- copy. Asked here instead.
  SELECT string_agg(w.tbl || '.' || w.col, ', ' ORDER BY w.tbl, w.col)
    INTO v_missing
    FROM (VALUES ('public.students',         'id'),
                 ('public.students',         'coach_id'),
                 ('public.exercise_library', 'id'),
                 ('public.exercise_library', 'coach_id'),
                 ('public.programs',         'id'),
                 ('public.programs',         'student_id'),
                 ('public.programs',         'name'),
                 ('public.programs',         'sort_order'),
                 ('public.programs',         'is_active'),
                 ('public.programs',         'status'),
                 ('public.programs',         'deleted_at'),
                 ('public.weeks',            'id'),
                 ('public.weeks',            'program_id'),
                 ('public.weeks',            'week_number'),
                 ('public.weeks',            'label'),
                 ('public.sessions',         'id'),
                 ('public.sessions',         'week_id'),
                 ('public.sessions',         'day_number'),
                 ('public.sessions',         'title'),
                 ('public.sessions',         'sort_order'),
                 ('public.sessions',         'archived_at'),
                 ('public.exercise_slots',   'id'),
                 ('public.exercise_slots',   'session_id'),
                 ('public.exercise_slots',   'exercise_id'),
                 ('public.exercise_slots',   'sets'),
                 ('public.exercise_slots',   'reps'),
                 ('public.exercise_slots',   'duration_seconds'),
                 ('public.exercise_slots',   'weight_kg'),
                 ('public.exercise_slots',   'sort_order'),
                 ('public.exercise_slots',   'rest_seconds'),
                 ('public.exercise_slots',   'superset_group'),
                 ('public.exercise_slots',   'notes'),
                 ('public.exercise_slots',   'record_video_set_numbers'),
                 ('public.set_logs',         'exercise_slot_id'),
                 ('public.set_logs',         'set_number'),
                 ('public.set_logs',         'is_student_added'),
                 ('public.set_logs',         'target_reps'),
                 ('public.set_logs',         'target_duration_seconds'),
                 ('public.set_logs',         'target_weight_kg'),
                 ('public.set_logs',         'target_rest_seconds')
         ) AS w (tbl, col)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = to_regclass(w.tbl)
        AND a.attname = w.col AND NOT a.attisdropped
   );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_12_copy_rpcs does not find the columns its functions are written with: %', v_missing
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;
END
$guard$;

-- ------------------------------------------------------------
-- HOW THE FOUR ARE WRITTEN. Each one, in this order:
--
--   finds     the thing to copy, as its caller reads it, and the place the
--             copy goes to. One the caller cannot read is "not found" —
--             somebody else's athlete and a wrong id are the same answer.
--   locks     the place: the phase and its sessions, or the program and its
--             phases, from the top down, as reorder_sessions and
--             reorder_weeks do (FOR UPDATE goes through the policies of
--             UPDATE: a caller who may only read finds no row to hold, and
--             is told "not authorized", 42501). Two copies into one place
--             wait for each other.
--   reads     everything that is copied — sessions, exercises, sets — in ONE
--             statement, so that the copy is the block as it was at one
--             instant, whatever its coach is doing to it in another tab.
--   plans     the sessions to make, in arrays: the one each is a copy of,
--             its new id, its phase, its place, its title, whether it is
--             archived. This is where the four differ.
--   copies    between the two marks `>>> the copy` and `<<< the copy`: the
--             SAME lines in the four functions, in this file and in
--             schema.sql (supabase/tests/copy-rpcs.test.js compares them).
--             Three INSERTs, written from what was read: the sessions, the
--             exercises that are in the library of the coach of the place,
--             the prescribed sets of those exercises. A column added to one
--             of the three tables is added there, or decided against, in
--             all of them at once.
--
-- They refuse with P0001 and a fixed word for a message — the API answers
-- 400 — and the sentences are in DETAIL and HINT:
--   session_not_found, week_not_found, program_not_found, student_not_found
--                         nothing with this id that the caller can read
--   not authorized        (42501) the caller reads the place and may not
--                         write it
--   copy_source_changed   what was to be copied was deleted or moved while
--                         the call waited for the place: read again, then
--                         try again
-- … and have then written nothing.
--
-- They answer a jsonb object: the id of what was made under a fixed key, how
-- much was made, and slots_left_out. Keys are added, never renamed.
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- 1. A copy of one session, right after it.
-- ------------------------------------------------------------
--   p_title_suffix   what is added to the title: ' (copy)' unless the app
--                    says otherwise (it sends the word in the coach's
--                    language). A session without a title is called
--                    'Session' first, as the app does. With '' or NULL the
--                    title is copied as it is — also when there is none.
--
--   returns   { "session_id", "week_id", "sort_order", "title",
--               "slots", "set_logs", "slots_left_out" }
--
--   refuses   session_not_found, not authorized, copy_source_changed
--
-- The copy takes the place after its source (sort_order + 1). When that
-- place is taken, every session after the source moves down by one:
-- sessions_week_sort_order_unique is not deferrable and is checked row by
-- row, so they are parked above every number the phase holds first, then
-- placed. Archived sessions are sessions of the phase like the others.
--
-- The copy is never archived, whatever its source is: it was asked for.
CREATE FUNCTION public.duplicate_session(
  p_session_id   uuid,
  p_title_suffix text DEFAULT ' (copy)'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_suffix       text := COALESCE(p_title_suffix, '');
  v_week_id      uuid;
  v_place        integer;
  v_tail         integer;
  v_top          integer;
  v_moved        integer;
  v_dest_coach   uuid;
  -- What is copied, read in one statement.
  v_sessions     public.sessions[];
  v_slots        public.exercise_slots[];
  v_sets         public.set_logs[];
  -- The sessions to make: the one each is a copy of, its id, its phase, its
  -- place, its title, whether it is archived.
  v_from         uuid[];
  v_new          uuid[];
  v_week         uuid[];
  v_order        integer[];
  v_title        text[];
  v_archived     timestamptz[];
  -- The exercises to make: their session, the one each is a copy of, its id.
  v_slot_session uuid[];
  v_slot_from    uuid[];
  v_slot_new     uuid[];
  v_made_slots   integer;
  v_made_sets    integer;
  v_left_out     integer;
BEGIN
  SELECT s.week_id INTO v_week_id
    FROM public.sessions s
   WHERE s.id = p_session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'session_not_found'
      USING DETAIL = 'No session with this id can be read by the caller.',
            HINT = 'Nothing was changed.';
  END IF;

  PERFORM 1 FROM public.weeks w WHERE w.id = v_week_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not authorized'
      USING ERRCODE = 'insufficient_privilege',
            DETAIL = 'The caller reads this session and may not write its phase.',
            HINT = 'A session is duplicated by the coach of the athlete. Nothing was changed.';
  END IF;

  PERFORM 1
     FROM public.sessions s
    WHERE s.week_id = v_week_id
    ORDER BY s.id
      FOR UPDATE;

  -- Whose library the exercises of the copy must be in.
  SELECT st.coach_id INTO v_dest_coach
    FROM public.weeks w
    JOIN public.programs p  ON p.id = w.program_id
    JOIN public.students st ON st.id = p.student_id
   WHERE w.id = v_week_id;
  IF v_dest_coach IS NULL THEN
    RAISE EXCEPTION 'not authorized'
      USING ERRCODE = 'insufficient_privilege',
            DETAIL = 'The caller cannot read whose athlete this phase belongs to.',
            HINT = 'Nothing was changed.';
  END IF;

  -- Read: the session — where it was found, now that nothing can move it —
  -- its exercises, and their prescribed sets.
  SELECT ARRAY(SELECT s FROM public.sessions s
                WHERE s.id = p_session_id AND s.week_id = v_week_id),
         ARRAY(SELECT es FROM public.exercise_slots es
                WHERE es.session_id = p_session_id),
         ARRAY(SELECT sl
                 FROM public.set_logs sl
                 JOIN public.exercise_slots es ON es.id = sl.exercise_slot_id
                WHERE es.session_id = p_session_id
                  AND NOT sl.is_student_added)
    INTO v_sessions, v_slots, v_sets;
  IF cardinality(v_sessions) = 0 THEN
    RAISE EXCEPTION 'copy_source_changed'
      USING DETAIL = 'The session was deleted or moved to another phase while the call waited.',
            HINT = 'Read the block again, then try again. Nothing was changed.';
  END IF;

  -- Make room after the source.
  v_place := (v_sessions[1]).sort_order + 1;
  IF EXISTS (SELECT 1 FROM public.sessions s
              WHERE s.week_id = v_week_id AND s.sort_order = v_place) THEN
    SELECT count(*), max(s.sort_order) INTO v_tail, v_top
      FROM public.sessions s
     WHERE s.week_id = v_week_id AND s.sort_order >= v_place;

    -- Park: above every number the phase holds, and above every place given
    -- below (the highest is v_top + 1).
    UPDATE public.sessions s
       SET sort_order = s.sort_order + (v_top - v_place + 2)
     WHERE s.week_id = v_week_id AND s.sort_order >= v_place;
    GET DIAGNOSTICS v_moved = ROW_COUNT;
    IF v_moved <> v_tail THEN
      RAISE EXCEPTION 'not authorized'
        USING ERRCODE = 'insufficient_privilege',
              DETAIL = format('The caller may write %s of the %s session(s) that follow this one.', v_moved, v_tail),
              HINT = 'Nothing was changed.';
    END IF;

    -- Place: one further down than they were.
    UPDATE public.sessions s
       SET sort_order = s.sort_order - (v_top - v_place + 2) + 1
     WHERE s.week_id = v_week_id AND s.sort_order > v_top + 1;
  END IF;

  -- Plan: one session.
  v_from     := ARRAY[p_session_id];
  v_new      := ARRAY[gen_random_uuid()];
  v_week     := ARRAY[v_week_id];
  v_order    := ARRAY[v_place];
  v_title    := ARRAY[CASE WHEN v_suffix = '' THEN (v_sessions[1]).title
                           ELSE COALESCE(NULLIF(btrim((v_sessions[1]).title), ''), 'Session') || v_suffix
                      END];
  v_archived := ARRAY[NULL::timestamptz];

  -- >>> the copy
  -- The sessions.
  INSERT INTO public.sessions (id, week_id, day_number, title, sort_order, archived_at)
  SELECT m.new_id, m.week_id, s.day_number, m.title, m.sort_order, m.archived_at
    FROM unnest(v_from, v_new, v_week, v_order, v_title, v_archived)
           AS m (from_id, new_id, week_id, sort_order, title, archived_at)
    JOIN unnest(v_sessions) AS s ON s.id = m.from_id;

  -- Their exercises: one per exercise of the source — kept when it is in the
  -- library of the coach of the place (trg_check_slot_exercise_in_coach_library
  -- would refuse the others, and the whole copy with them), counted otherwise.
  SELECT COALESCE(array_agg(k.session_id ORDER BY k.new_id) FILTER (WHERE k.kept), '{}'),
         COALESCE(array_agg(k.from_id    ORDER BY k.new_id) FILTER (WHERE k.kept), '{}'),
         COALESCE(array_agg(k.new_id     ORDER BY k.new_id) FILTER (WHERE k.kept), '{}'),
         count(*) FILTER (WHERE NOT k.kept)
    INTO v_slot_session, v_slot_from, v_slot_new, v_left_out
    FROM (
      SELECT m.new_id AS session_id, es.id AS from_id, gen_random_uuid() AS new_id,
             EXISTS (SELECT 1 FROM public.exercise_library el
                      WHERE el.id = es.exercise_id AND el.coach_id = v_dest_coach) AS kept
        FROM unnest(v_from, v_new) AS m (from_id, new_id)
        JOIN unnest(v_slots) AS es ON es.session_id = m.from_id
    ) k;

  INSERT INTO public.exercise_slots
    (id, session_id, exercise_id, sets, reps, duration_seconds, weight_kg, sort_order,
     rest_seconds, superset_group, notes, record_video_set_numbers)
  SELECT k.new_id, k.session_id, es.exercise_id, es.sets, es.reps, es.duration_seconds, es.weight_kg, es.sort_order,
         es.rest_seconds, es.superset_group, es.notes, es.record_video_set_numbers
    FROM unnest(v_slot_session, v_slot_from, v_slot_new) AS k (session_id, from_id, new_id)
    JOIN unnest(v_slots) AS es ON es.id = k.from_id;
  GET DIAGNOSTICS v_made_slots = ROW_COUNT;

  -- Their sets: the number and the targets. Nothing of what was trained.
  INSERT INTO public.set_logs
    (exercise_slot_id, set_number, target_reps, target_duration_seconds, target_weight_kg, target_rest_seconds)
  SELECT k.new_id, sl.set_number, sl.target_reps, sl.target_duration_seconds, sl.target_weight_kg, sl.target_rest_seconds
    FROM unnest(v_slot_from, v_slot_new) AS k (from_id, new_id)
    JOIN unnest(v_sets) AS sl ON sl.exercise_slot_id = k.from_id;
  GET DIAGNOSTICS v_made_sets = ROW_COUNT;
  -- <<< the copy

  RETURN jsonb_build_object(
    'session_id',     v_new[1],
    'week_id',        v_week_id,
    'sort_order',     v_place,
    'title',          v_title[1],
    'slots',          v_made_slots,
    'set_logs',       v_made_sets,
    'slots_left_out', v_left_out
  );
END;
$$;

REVOKE ALL ON FUNCTION public.duplicate_session(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.duplicate_session(uuid, text) TO authenticated;

-- ------------------------------------------------------------
-- 2. Copies of several sessions, at the end of a phase.
-- ------------------------------------------------------------
-- The coach's "reuse this work": sessions chosen on the sheet, copied into a
-- phase of the same block, of another block, or of another athlete of theirs.
--
--   p_session_ids    the sessions to copy. ONE COPY PER ENTRY, in the order
--                    of the list: a session listed twice is copied twice.
--                    An empty list, or none, copies nothing.
--   p_dest_week_id   the phase they go to
--
--   returns   { "session_ids", "week_id", "slots", "set_logs",
--               "slots_left_out" } — session_ids in the order of the list
--
--   refuses   week_not_found      the phase
--             not authorized      the caller reads the phase and may not
--                                 write it
--             session_not_found   an entry of the list is not a session the
--                                 caller can read — or is empty. The DETAIL
--                                 counts them. Nothing is copied: not the
--                                 others either.
--
-- The copies go after every session of the phase, archived ones included:
-- the highest sort_order + 1, + 2, … They keep their title as it is — no
-- suffix: they arrive somewhere else — and are never archived.
CREATE FUNCTION public.copy_sessions(
  p_session_ids  uuid[],
  p_dest_week_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ids          uuid[] := COALESCE(p_session_ids, '{}');
  v_listed       integer;
  v_unread       integer;
  v_top          integer;
  v_dest_coach   uuid;
  -- What is copied, read in one statement.
  v_sessions     public.sessions[];
  v_slots        public.exercise_slots[];
  v_sets         public.set_logs[];
  -- The sessions to make: the one each is a copy of, its id, its phase, its
  -- place, its title, whether it is archived.
  v_from         uuid[];
  v_new          uuid[];
  v_week         uuid[];
  v_order        integer[];
  v_title        text[];
  v_archived     timestamptz[];
  -- The exercises to make: their session, the one each is a copy of, its id.
  v_slot_session uuid[];
  v_slot_from    uuid[];
  v_slot_new     uuid[];
  v_made_slots   integer;
  v_made_sets    integer;
  v_left_out     integer;
BEGIN
  PERFORM 1 FROM public.weeks w WHERE w.id = p_dest_week_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'week_not_found'
      USING DETAIL = 'No phase with this id can be read by the caller.',
            HINT = 'Nothing was changed.';
  END IF;

  PERFORM 1 FROM public.weeks w WHERE w.id = p_dest_week_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not authorized'
      USING ERRCODE = 'insufficient_privilege',
            DETAIL = 'The caller reads this phase and may not write it.',
            HINT = 'Sessions are copied by the coach of the athlete they go to. Nothing was changed.';
  END IF;

  PERFORM 1
     FROM public.sessions s
    WHERE s.week_id = p_dest_week_id
    ORDER BY s.id
      FOR UPDATE;

  -- Whose library the exercises of the copies must be in.
  SELECT st.coach_id INTO v_dest_coach
    FROM public.weeks w
    JOIN public.programs p  ON p.id = w.program_id
    JOIN public.students st ON st.id = p.student_id
   WHERE w.id = p_dest_week_id;
  IF v_dest_coach IS NULL THEN
    RAISE EXCEPTION 'not authorized'
      USING ERRCODE = 'insufficient_privilege',
            DETAIL = 'The caller cannot read whose athlete this phase belongs to.',
            HINT = 'Nothing was changed.';
  END IF;

  -- Read: the sessions of the list, their exercises, and their prescribed sets.
  SELECT ARRAY(SELECT s FROM public.sessions s
                WHERE s.id = ANY (v_ids)),
         ARRAY(SELECT es FROM public.exercise_slots es
                WHERE es.session_id = ANY (v_ids)),
         ARRAY(SELECT sl
                 FROM public.set_logs sl
                 JOIN public.exercise_slots es ON es.id = sl.exercise_slot_id
                WHERE es.session_id = ANY (v_ids)
                  AND NOT sl.is_student_added)
    INTO v_sessions, v_slots, v_sets;

  SELECT count(*), count(*) FILTER (WHERE s.id IS NULL)
    INTO v_listed, v_unread
    FROM unnest(v_ids) AS t (id)
    LEFT JOIN unnest(v_sessions) AS s ON s.id = t.id;
  IF v_unread > 0 THEN
    RAISE EXCEPTION 'session_not_found'
      USING DETAIL = format('%s of the %s id(s) of the list are not sessions the caller can read.', v_unread, v_listed),
            HINT = 'Nothing was copied, the other sessions of the list included. Read the block again, then try again.';
  END IF;

  -- Plan: one session per entry, after every session the phase holds.
  SELECT COALESCE(max(s.sort_order), -1) INTO v_top
    FROM public.sessions s
   WHERE s.week_id = p_dest_week_id;

  SELECT COALESCE(array_agg(t.id                         ORDER BY t.place), '{}'),
         COALESCE(array_agg(gen_random_uuid()            ORDER BY t.place), '{}'),
         COALESCE(array_agg(p_dest_week_id               ORDER BY t.place), '{}'),
         COALESCE(array_agg((v_top + t.place)::integer   ORDER BY t.place), '{}'),
         COALESCE(array_agg(s.title                      ORDER BY t.place), '{}'),
         COALESCE(array_agg(NULL::timestamptz            ORDER BY t.place), '{}')
    INTO v_from, v_new, v_week, v_order, v_title, v_archived
    FROM unnest(v_ids) WITH ORDINALITY AS t (id, place)
    JOIN unnest(v_sessions) AS s ON s.id = t.id;

  -- >>> the copy
  -- The sessions.
  INSERT INTO public.sessions (id, week_id, day_number, title, sort_order, archived_at)
  SELECT m.new_id, m.week_id, s.day_number, m.title, m.sort_order, m.archived_at
    FROM unnest(v_from, v_new, v_week, v_order, v_title, v_archived)
           AS m (from_id, new_id, week_id, sort_order, title, archived_at)
    JOIN unnest(v_sessions) AS s ON s.id = m.from_id;

  -- Their exercises: one per exercise of the source — kept when it is in the
  -- library of the coach of the place (trg_check_slot_exercise_in_coach_library
  -- would refuse the others, and the whole copy with them), counted otherwise.
  SELECT COALESCE(array_agg(k.session_id ORDER BY k.new_id) FILTER (WHERE k.kept), '{}'),
         COALESCE(array_agg(k.from_id    ORDER BY k.new_id) FILTER (WHERE k.kept), '{}'),
         COALESCE(array_agg(k.new_id     ORDER BY k.new_id) FILTER (WHERE k.kept), '{}'),
         count(*) FILTER (WHERE NOT k.kept)
    INTO v_slot_session, v_slot_from, v_slot_new, v_left_out
    FROM (
      SELECT m.new_id AS session_id, es.id AS from_id, gen_random_uuid() AS new_id,
             EXISTS (SELECT 1 FROM public.exercise_library el
                      WHERE el.id = es.exercise_id AND el.coach_id = v_dest_coach) AS kept
        FROM unnest(v_from, v_new) AS m (from_id, new_id)
        JOIN unnest(v_slots) AS es ON es.session_id = m.from_id
    ) k;

  INSERT INTO public.exercise_slots
    (id, session_id, exercise_id, sets, reps, duration_seconds, weight_kg, sort_order,
     rest_seconds, superset_group, notes, record_video_set_numbers)
  SELECT k.new_id, k.session_id, es.exercise_id, es.sets, es.reps, es.duration_seconds, es.weight_kg, es.sort_order,
         es.rest_seconds, es.superset_group, es.notes, es.record_video_set_numbers
    FROM unnest(v_slot_session, v_slot_from, v_slot_new) AS k (session_id, from_id, new_id)
    JOIN unnest(v_slots) AS es ON es.id = k.from_id;
  GET DIAGNOSTICS v_made_slots = ROW_COUNT;

  -- Their sets: the number and the targets. Nothing of what was trained.
  INSERT INTO public.set_logs
    (exercise_slot_id, set_number, target_reps, target_duration_seconds, target_weight_kg, target_rest_seconds)
  SELECT k.new_id, sl.set_number, sl.target_reps, sl.target_duration_seconds, sl.target_weight_kg, sl.target_rest_seconds
    FROM unnest(v_slot_from, v_slot_new) AS k (from_id, new_id)
    JOIN unnest(v_sets) AS sl ON sl.exercise_slot_id = k.from_id;
  GET DIAGNOSTICS v_made_sets = ROW_COUNT;
  -- <<< the copy

  RETURN jsonb_build_object(
    'session_ids',    to_jsonb(v_new),
    'week_id',        p_dest_week_id,
    'slots',          v_made_slots,
    'set_logs',       v_made_sets,
    'slots_left_out', v_left_out
  );
END;
$$;

REVOKE ALL ON FUNCTION public.copy_sessions(uuid[], uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.copy_sessions(uuid[], uuid) TO authenticated;

-- ------------------------------------------------------------
-- 3. A copy of a phase, as the last phase of a program.
-- ------------------------------------------------------------
--   p_dest_program_id   the program the copy goes to. NULL, or left out: the
--                       program of the phase. Another one: "copy this phase
--                       to…" — another block, or a block of another athlete
--                       of the coach.
--   p_label_suffix      what is added to the name of the phase: ' (copy)'
--                       unless the app says otherwise. A phase without a
--                       name gives a copy without one.
--
--   returns   { "week_id", "program_id", "week_number", "label", "sessions",
--               "slots", "set_logs", "slots_left_out" }
--
--   refuses   week_not_found      the phase to copy
--             program_not_found   the program it goes to
--             not authorized      the caller reads that program and may not
--                                 write it
--             copy_source_changed
--
-- The copy is the last phase of the program: the highest week_number + 1.
-- Its sessions are those of the source in their order, numbered from 0, the
-- archived ones included and still archived.
CREATE FUNCTION public.duplicate_week(
  p_week_id         uuid,
  p_dest_program_id uuid DEFAULT NULL,
  p_label_suffix    text DEFAULT ' (copy)'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_suffix       text := COALESCE(p_label_suffix, '');
  v_program_id   uuid;
  v_weeks        public.weeks[];
  v_new_week     uuid := gen_random_uuid();
  v_number       integer;
  v_label        text;
  v_dest_coach   uuid;
  -- What is copied, read in one statement.
  v_sessions     public.sessions[];
  v_slots        public.exercise_slots[];
  v_sets         public.set_logs[];
  -- The sessions to make: the one each is a copy of, its id, its phase, its
  -- place, its title, whether it is archived.
  v_from         uuid[];
  v_new          uuid[];
  v_week         uuid[];
  v_order        integer[];
  v_title        text[];
  v_archived     timestamptz[];
  -- The exercises to make: their session, the one each is a copy of, its id.
  v_slot_session uuid[];
  v_slot_from    uuid[];
  v_slot_new     uuid[];
  v_made_slots   integer;
  v_made_sets    integer;
  v_left_out     integer;
BEGIN
  SELECT w.program_id INTO v_program_id
    FROM public.weeks w
   WHERE w.id = p_week_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'week_not_found'
      USING DETAIL = 'No phase with this id can be read by the caller.',
            HINT = 'Nothing was changed.';
  END IF;
  v_program_id := COALESCE(p_dest_program_id, v_program_id);

  PERFORM 1 FROM public.programs p WHERE p.id = v_program_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'program_not_found'
      USING DETAIL = 'No program with this id can be read by the caller.',
            HINT = 'Nothing was changed.';
  END IF;

  PERFORM 1 FROM public.programs p WHERE p.id = v_program_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not authorized'
      USING ERRCODE = 'insufficient_privilege',
            DETAIL = 'The caller reads this program and may not write it.',
            HINT = 'A phase is duplicated by the coach of the athlete it goes to. Nothing was changed.';
  END IF;

  PERFORM 1
     FROM public.weeks w
    WHERE w.program_id = v_program_id
    ORDER BY w.id
      FOR UPDATE;

  -- Whose library the exercises of the copy must be in.
  SELECT st.coach_id INTO v_dest_coach
    FROM public.programs p
    JOIN public.students st ON st.id = p.student_id
   WHERE p.id = v_program_id;
  IF v_dest_coach IS NULL THEN
    RAISE EXCEPTION 'not authorized'
      USING ERRCODE = 'insufficient_privilege',
            DETAIL = 'The caller cannot read whose athlete this program belongs to.',
            HINT = 'Nothing was changed.';
  END IF;

  -- Read: the phase, its sessions, their exercises, and their prescribed sets.
  SELECT ARRAY(SELECT w FROM public.weeks w
                WHERE w.id = p_week_id),
         ARRAY(SELECT s FROM public.sessions s
                WHERE s.week_id = p_week_id),
         ARRAY(SELECT es
                 FROM public.exercise_slots es
                 JOIN public.sessions s ON s.id = es.session_id
                WHERE s.week_id = p_week_id),
         ARRAY(SELECT sl
                 FROM public.set_logs sl
                 JOIN public.exercise_slots es ON es.id = sl.exercise_slot_id
                 JOIN public.sessions s        ON s.id = es.session_id
                WHERE s.week_id = p_week_id
                  AND NOT sl.is_student_added)
    INTO v_weeks, v_sessions, v_slots, v_sets;
  IF cardinality(v_weeks) = 0 THEN
    RAISE EXCEPTION 'copy_source_changed'
      USING DETAIL = 'The phase was deleted while the call waited.',
            HINT = 'Read the block again, then try again. Nothing was changed.';
  END IF;

  -- The new phase: last of its program.
  SELECT COALESCE(max(w.week_number), 0) + 1 INTO v_number
    FROM public.weeks w
   WHERE w.program_id = v_program_id;
  v_label := CASE WHEN NULLIF(btrim((v_weeks[1]).label), '') IS NULL THEN NULL
                  ELSE (v_weeks[1]).label || v_suffix
             END;

  INSERT INTO public.weeks (id, program_id, week_number, label)
  VALUES (v_new_week, v_program_id, v_number, v_label);

  -- Plan: every session of the phase, in its order, numbered from 0.
  SELECT COALESCE(array_agg(n.id                 ORDER BY n.place), '{}'),
         COALESCE(array_agg(gen_random_uuid()    ORDER BY n.place), '{}'),
         COALESCE(array_agg(v_new_week           ORDER BY n.place), '{}'),
         COALESCE(array_agg((n.place - 1)::integer ORDER BY n.place), '{}'),
         COALESCE(array_agg(n.title              ORDER BY n.place), '{}'),
         COALESCE(array_agg(n.archived_at        ORDER BY n.place), '{}')
    INTO v_from, v_new, v_week, v_order, v_title, v_archived
    FROM (
      SELECT s.id, s.title, s.archived_at,
             row_number() OVER (ORDER BY s.sort_order, s.id) AS place
        FROM unnest(v_sessions) AS s
    ) n;

  -- >>> the copy
  -- The sessions.
  INSERT INTO public.sessions (id, week_id, day_number, title, sort_order, archived_at)
  SELECT m.new_id, m.week_id, s.day_number, m.title, m.sort_order, m.archived_at
    FROM unnest(v_from, v_new, v_week, v_order, v_title, v_archived)
           AS m (from_id, new_id, week_id, sort_order, title, archived_at)
    JOIN unnest(v_sessions) AS s ON s.id = m.from_id;

  -- Their exercises: one per exercise of the source — kept when it is in the
  -- library of the coach of the place (trg_check_slot_exercise_in_coach_library
  -- would refuse the others, and the whole copy with them), counted otherwise.
  SELECT COALESCE(array_agg(k.session_id ORDER BY k.new_id) FILTER (WHERE k.kept), '{}'),
         COALESCE(array_agg(k.from_id    ORDER BY k.new_id) FILTER (WHERE k.kept), '{}'),
         COALESCE(array_agg(k.new_id     ORDER BY k.new_id) FILTER (WHERE k.kept), '{}'),
         count(*) FILTER (WHERE NOT k.kept)
    INTO v_slot_session, v_slot_from, v_slot_new, v_left_out
    FROM (
      SELECT m.new_id AS session_id, es.id AS from_id, gen_random_uuid() AS new_id,
             EXISTS (SELECT 1 FROM public.exercise_library el
                      WHERE el.id = es.exercise_id AND el.coach_id = v_dest_coach) AS kept
        FROM unnest(v_from, v_new) AS m (from_id, new_id)
        JOIN unnest(v_slots) AS es ON es.session_id = m.from_id
    ) k;

  INSERT INTO public.exercise_slots
    (id, session_id, exercise_id, sets, reps, duration_seconds, weight_kg, sort_order,
     rest_seconds, superset_group, notes, record_video_set_numbers)
  SELECT k.new_id, k.session_id, es.exercise_id, es.sets, es.reps, es.duration_seconds, es.weight_kg, es.sort_order,
         es.rest_seconds, es.superset_group, es.notes, es.record_video_set_numbers
    FROM unnest(v_slot_session, v_slot_from, v_slot_new) AS k (session_id, from_id, new_id)
    JOIN unnest(v_slots) AS es ON es.id = k.from_id;
  GET DIAGNOSTICS v_made_slots = ROW_COUNT;

  -- Their sets: the number and the targets. Nothing of what was trained.
  INSERT INTO public.set_logs
    (exercise_slot_id, set_number, target_reps, target_duration_seconds, target_weight_kg, target_rest_seconds)
  SELECT k.new_id, sl.set_number, sl.target_reps, sl.target_duration_seconds, sl.target_weight_kg, sl.target_rest_seconds
    FROM unnest(v_slot_from, v_slot_new) AS k (from_id, new_id)
    JOIN unnest(v_sets) AS sl ON sl.exercise_slot_id = k.from_id;
  GET DIAGNOSTICS v_made_sets = ROW_COUNT;
  -- <<< the copy

  RETURN jsonb_build_object(
    'week_id',        v_new_week,
    'program_id',     v_program_id,
    'week_number',    v_number,
    'label',          v_label,
    'sessions',       cardinality(v_new),
    'slots',          v_made_slots,
    'set_logs',       v_made_sets,
    'slots_left_out', v_left_out
  );
END;
$$;

REVOKE ALL ON FUNCTION public.duplicate_week(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.duplicate_week(uuid, uuid, text) TO authenticated;

-- ------------------------------------------------------------
-- 4. A copy of a whole block, for its athlete or for another one.
-- ------------------------------------------------------------
--   p_target_student_id   whose block the copy is: the id of a row of
--                         public.students — what programs.student_id holds,
--                         not a profile. NULL, or left out: the athlete of
--                         the block. Another one: an athlete of the same
--                         coach.
--   p_name_suffix         what is added to the name: ' (copy)' unless the
--                         app says otherwise. '' or NULL: the same name.
--
--   returns   { "program_id", "student_id", "name", "sort_order", "weeks",
--               "sessions", "slots", "set_logs", "slots_left_out" }
--
--   refuses   program_not_found   the block to copy
--             student_not_found   no athlete with this id that the caller
--                                 can read — somebody else's athlete and a
--                                 wrong id are the same answer
--             not authorized      the caller reads the athlete and may not
--                                 write their programs: the athlete
--                                 themselves
--             copy_source_changed
--
-- The copy is an approved program of the coach — whatever its source was: a
-- draft, a block in the trash — that is NOT active: the block the athlete is
-- training stays the one they train, and the coach sets the copy active when
-- it is time (activate_program). It goes last in the athlete's list: the
-- highest sort_order of their programs out of the trash, + 1. Its phases are
-- those of the source in their order, numbered from 1, with their names as
-- they are; its sessions as in duplicate_week.
--
-- The athlete's programs are locked first, in the order of their ids, as
-- activate_program locks them: two copies for one athlete wait for each
-- other, and do not end with the same place in the list.
CREATE FUNCTION public.duplicate_program(
  p_program_id        uuid,
  p_target_student_id uuid DEFAULT NULL,
  p_name_suffix       text DEFAULT ' (copy)'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_suffix       text := COALESCE(p_name_suffix, '');
  v_student_id   uuid;
  v_programs     public.programs[];
  v_weeks        public.weeks[];
  v_new_program  uuid := gen_random_uuid();
  v_name         text;
  v_sort         integer;
  v_week_from    uuid[];
  v_week_new     uuid[];
  v_dest_coach   uuid;
  -- What is copied, read in one statement.
  v_sessions     public.sessions[];
  v_slots        public.exercise_slots[];
  v_sets         public.set_logs[];
  -- The sessions to make: the one each is a copy of, its id, its phase, its
  -- place, its title, whether it is archived.
  v_from         uuid[];
  v_new          uuid[];
  v_week         uuid[];
  v_order        integer[];
  v_title        text[];
  v_archived     timestamptz[];
  -- The exercises to make: their session, the one each is a copy of, its id.
  v_slot_session uuid[];
  v_slot_from    uuid[];
  v_slot_new     uuid[];
  v_made_slots   integer;
  v_made_sets    integer;
  v_left_out     integer;
BEGIN
  SELECT p.student_id INTO v_student_id
    FROM public.programs p
   WHERE p.id = p_program_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'program_not_found'
      USING DETAIL = 'No program with this id can be read by the caller.',
            HINT = 'Nothing was changed.';
  END IF;
  v_student_id := COALESCE(p_target_student_id, v_student_id);

  -- Whose library the exercises of the copy must be in.
  SELECT st.coach_id INTO v_dest_coach
    FROM public.students st
   WHERE st.id = v_student_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'student_not_found'
      USING DETAIL = 'No athlete with this id can be read by the caller. The id is the one of public.students, not of a profile.',
            HINT = 'Nothing was changed.';
  END IF;

  -- The lightest lock there is, which an INSERT into programs takes on this
  -- row anyway: asked here because it goes through the policies of UPDATE.
  PERFORM 1 FROM public.students st WHERE st.id = v_student_id FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not authorized'
      USING ERRCODE = 'insufficient_privilege',
            DETAIL = 'The caller reads this athlete and may not write their programs.',
            HINT = 'A block is duplicated by the coach of the athlete it is for. Nothing was changed.';
  END IF;

  PERFORM 1
     FROM public.programs p
    WHERE p.student_id = v_student_id
    ORDER BY p.id
      FOR NO KEY UPDATE;

  -- Read: the block, its phases, their sessions, their exercises, and their
  -- prescribed sets.
  SELECT ARRAY(SELECT p FROM public.programs p
                WHERE p.id = p_program_id),
         ARRAY(SELECT w FROM public.weeks w
                WHERE w.program_id = p_program_id),
         ARRAY(SELECT s
                 FROM public.sessions s
                 JOIN public.weeks w ON w.id = s.week_id
                WHERE w.program_id = p_program_id),
         ARRAY(SELECT es
                 FROM public.exercise_slots es
                 JOIN public.sessions s ON s.id = es.session_id
                 JOIN public.weeks w    ON w.id = s.week_id
                WHERE w.program_id = p_program_id),
         ARRAY(SELECT sl
                 FROM public.set_logs sl
                 JOIN public.exercise_slots es ON es.id = sl.exercise_slot_id
                 JOIN public.sessions s        ON s.id = es.session_id
                 JOIN public.weeks w           ON w.id = s.week_id
                WHERE w.program_id = p_program_id
                  AND NOT sl.is_student_added)
    INTO v_programs, v_weeks, v_sessions, v_slots, v_sets;
  IF cardinality(v_programs) = 0 THEN
    RAISE EXCEPTION 'copy_source_changed'
      USING DETAIL = 'The program was deleted while the call waited.',
            HINT = 'Read the list of blocks again, then try again. Nothing was changed.';
  END IF;

  -- The new block: approved, not active, last in the athlete's list.
  SELECT COALESCE(max(p.sort_order), -1) + 1 INTO v_sort
    FROM public.programs p
   WHERE p.student_id = v_student_id
     AND p.deleted_at IS NULL;
  v_name := (v_programs[1]).name || v_suffix;

  INSERT INTO public.programs (id, student_id, name, sort_order, is_active, status)
  VALUES (v_new_program, v_student_id, v_name, v_sort, false, 'approved');

  -- Its phases: those of the source in their order, numbered from 1.
  SELECT COALESCE(array_agg(n.id              ORDER BY n.place), '{}'),
         COALESCE(array_agg(gen_random_uuid() ORDER BY n.place), '{}')
    INTO v_week_from, v_week_new
    FROM (
      SELECT w.id, row_number() OVER (ORDER BY w.week_number, w.id) AS place
        FROM unnest(v_weeks) AS w
    ) n;

  INSERT INTO public.weeks (id, program_id, week_number, label)
  SELECT k.new_id, v_new_program, k.place::integer, w.label
    FROM unnest(v_week_from, v_week_new) WITH ORDINALITY AS k (from_id, new_id, place)
    JOIN unnest(v_weeks) AS w ON w.id = k.from_id;

  -- Plan: every session of every phase, in its order, numbered from 0.
  SELECT COALESCE(array_agg(n.id                   ORDER BY n.new_week, n.place), '{}'),
         COALESCE(array_agg(gen_random_uuid()      ORDER BY n.new_week, n.place), '{}'),
         COALESCE(array_agg(n.new_week             ORDER BY n.new_week, n.place), '{}'),
         COALESCE(array_agg((n.place - 1)::integer ORDER BY n.new_week, n.place), '{}'),
         COALESCE(array_agg(n.title                ORDER BY n.new_week, n.place), '{}'),
         COALESCE(array_agg(n.archived_at          ORDER BY n.new_week, n.place), '{}')
    INTO v_from, v_new, v_week, v_order, v_title, v_archived
    FROM (
      SELECT s.id, s.title, s.archived_at, k.new_id AS new_week,
             row_number() OVER (PARTITION BY s.week_id ORDER BY s.sort_order, s.id) AS place
        FROM unnest(v_sessions) AS s
        JOIN unnest(v_week_from, v_week_new) AS k (from_id, new_id) ON k.from_id = s.week_id
    ) n;

  -- >>> the copy
  -- The sessions.
  INSERT INTO public.sessions (id, week_id, day_number, title, sort_order, archived_at)
  SELECT m.new_id, m.week_id, s.day_number, m.title, m.sort_order, m.archived_at
    FROM unnest(v_from, v_new, v_week, v_order, v_title, v_archived)
           AS m (from_id, new_id, week_id, sort_order, title, archived_at)
    JOIN unnest(v_sessions) AS s ON s.id = m.from_id;

  -- Their exercises: one per exercise of the source — kept when it is in the
  -- library of the coach of the place (trg_check_slot_exercise_in_coach_library
  -- would refuse the others, and the whole copy with them), counted otherwise.
  SELECT COALESCE(array_agg(k.session_id ORDER BY k.new_id) FILTER (WHERE k.kept), '{}'),
         COALESCE(array_agg(k.from_id    ORDER BY k.new_id) FILTER (WHERE k.kept), '{}'),
         COALESCE(array_agg(k.new_id     ORDER BY k.new_id) FILTER (WHERE k.kept), '{}'),
         count(*) FILTER (WHERE NOT k.kept)
    INTO v_slot_session, v_slot_from, v_slot_new, v_left_out
    FROM (
      SELECT m.new_id AS session_id, es.id AS from_id, gen_random_uuid() AS new_id,
             EXISTS (SELECT 1 FROM public.exercise_library el
                      WHERE el.id = es.exercise_id AND el.coach_id = v_dest_coach) AS kept
        FROM unnest(v_from, v_new) AS m (from_id, new_id)
        JOIN unnest(v_slots) AS es ON es.session_id = m.from_id
    ) k;

  INSERT INTO public.exercise_slots
    (id, session_id, exercise_id, sets, reps, duration_seconds, weight_kg, sort_order,
     rest_seconds, superset_group, notes, record_video_set_numbers)
  SELECT k.new_id, k.session_id, es.exercise_id, es.sets, es.reps, es.duration_seconds, es.weight_kg, es.sort_order,
         es.rest_seconds, es.superset_group, es.notes, es.record_video_set_numbers
    FROM unnest(v_slot_session, v_slot_from, v_slot_new) AS k (session_id, from_id, new_id)
    JOIN unnest(v_slots) AS es ON es.id = k.from_id;
  GET DIAGNOSTICS v_made_slots = ROW_COUNT;

  -- Their sets: the number and the targets. Nothing of what was trained.
  INSERT INTO public.set_logs
    (exercise_slot_id, set_number, target_reps, target_duration_seconds, target_weight_kg, target_rest_seconds)
  SELECT k.new_id, sl.set_number, sl.target_reps, sl.target_duration_seconds, sl.target_weight_kg, sl.target_rest_seconds
    FROM unnest(v_slot_from, v_slot_new) AS k (from_id, new_id)
    JOIN unnest(v_sets) AS sl ON sl.exercise_slot_id = k.from_id;
  GET DIAGNOSTICS v_made_sets = ROW_COUNT;
  -- <<< the copy

  RETURN jsonb_build_object(
    'program_id',     v_new_program,
    'student_id',     v_student_id,
    'name',           v_name,
    'sort_order',     v_sort,
    'weeks',          cardinality(v_week_new),
    'sessions',       cardinality(v_new),
    'slots',          v_made_slots,
    'set_logs',       v_made_sets,
    'slots_left_out', v_left_out
  );
END;
$$;

REVOKE ALL ON FUNCTION public.duplicate_program(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.duplicate_program(uuid, uuid, text) TO authenticated;

-- ------------------------------------------------------------
-- 5. Read the result back. Anything else than what was meant raises, and the
--    whole file is undone: either the database is as described, or untouched.
-- ------------------------------------------------------------
DO $verify$
DECLARE
  v_list text;
BEGIN
  -- The four functions: owned by postgres, search_path pinned, running with
  -- the rights of their caller, open to a signed-in user and closed to a
  -- request without a session.
  WITH wanted (signature) AS (
    VALUES ('public.duplicate_session(uuid, text)'),
           ('public.copy_sessions(uuid[], uuid)'),
           ('public.duplicate_week(uuid, uuid, text)'),
           ('public.duplicate_program(uuid, uuid, text)')
  ),
  found AS (
    SELECT w.signature, p.oid, p.proowner, p.proconfig, p.prosecdef, p.prorettype, p.proacl
      FROM wanted w
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(w.signature)
  )
  SELECT string_agg(f.signature || ': ' || f.wrong, '; ' ORDER BY f.signature) INTO v_list
    FROM (
      SELECT signature,
             CASE WHEN oid IS NULL THEN 'missing' ELSE concat_ws(', ',
               CASE WHEN pg_get_userbyid(proowner) <> 'postgres' THEN 'not owned by postgres' END,
               CASE WHEN prorettype <> to_regtype('jsonb') THEN 'it does not return jsonb' END,
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
    RAISE EXCEPTION 'migration 2026_10_13_12_copy_rpcs did not get the functions it meant: %', v_list
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;

  -- One function per name: the API calls by name.
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO v_list
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('duplicate_session', 'copy_sessions', 'duplicate_week', 'duplicate_program')
     AND NOT EXISTS (
       SELECT 1
         FROM unnest(ARRAY[
                'public.duplicate_session(uuid, text)',
                'public.copy_sessions(uuid[], uuid)',
                'public.duplicate_week(uuid, uuid, text)',
                'public.duplicate_program(uuid, uuid, text)'
              ]) AS known(signature)
        WHERE to_regprocedure(known.signature) = p.oid
     );
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_13_12_copy_rpcs did not get the functions it meant: % stands next to them', v_list
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;
END
$verify$;

INSERT INTO app_private.app_migrations (name)
VALUES ('2026_10_13_12_copy_rpcs')
RETURNING name, applied_at;

-- Four functions joined public: PostgREST learns of a function when its
-- schema cache is reloaded.
NOTIFY pgrst, 'reload schema';

COMMIT;
