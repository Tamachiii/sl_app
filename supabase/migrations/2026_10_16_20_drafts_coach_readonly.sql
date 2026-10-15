-- ============================================================
-- 20 — The draft an athlete is writing is theirs alone: the coach approves
--      it, sends it back, renames it, trashes it — and changes nothing in it
-- wave 3 · Checkpoint C1 · required · finding P53 (the database's half)
--
-- THE HOLE. A draft is a block its athlete writes (Phase 3.4). The policies
-- of the coach on its phases, sessions, exercises and sets ("Coaches manage
-- weeks", "… sessions", "… exercise slots", "… set log prescriptions") are
-- FOR ALL and never look at programs.status: the coach of the athlete writes
-- a draft as freely as a block of their own, and the app lets them — the
-- Program Sheet opens a draft like any block. Two things then go wrong:
--   * the coach raises "Sets" in a draft. The editor adds the rows of the new
--     sets with the targets of the last row it finds (reconcileSetLogCount),
--     and a draft has no row: every target of the new sets is empty.
--     approve_program adds only the set numbers that have no row, so those
--     rows outlive the approval, and the athlete trains sessions without reps
--     or load.
--   * the athlete's next save (save_draft_tree) deletes the phases of the
--     draft and writes them again from what the phone holds: the exercise,
--     sets, reps, load, duration, rest and order of each exercise. A note of
--     the coach, a superset, a video asked for, a target set by set — all
--     gone, without a word to either of them.
--
-- WHAT THIS FILE DOES.
--   1. Four triggers, one on each table of the tree of a block — weeks,
--      sessions, exercise_slots, set_logs — named block_draft_tree_write on
--      each. A write that carries a user id other than the author of the
--      draft (programs.created_by) is refused when the row belongs to a
--      program whose status is 'draft':
--        INSERT    the program of the new row
--        UPDATE    the program of the row as it was AND as it would be —
--                  nothing moves into a draft, nothing out of one
--        DELETE    the program of the row
--      P0001, the word draft_read_only, the sentences in DETAIL and HINT.
--      A draft in the trash is still a draft.
--   2. approve_program marks the program approved FIRST, then does what it
--      did — the four columns of its sessions cleared, the missing sets
--      added from the values of each exercise — and, in between, drops the
--      sets without a target: rows nobody logged, added or filmed that have
--      neither reps nor a duration, which no prescription is. They are
--      written again from the exercise with the other missing sets. Its
--      header, who may call it and what it answers are unchanged.
--
-- WHAT IT DOES NOT TOUCH.
--   * The row of the program. The coach approves a draft, sends it back,
--     renames it, puts it in the trash, takes it out, deletes it: every one
--     of those writes `programs`, which has no such trigger. (A new name is
--     the athlete's to keep: their next save writes the name their phone
--     holds — as before.)
--   * The author. Whoever wrote the draft writes its tree as before — the
--     save of the app (save_draft_tree), discarding it, and every write of
--     their own the policies let through.
--   * A request without a user id: the SQL editor, a migration, the service
--     role. They write a draft as before.
--   * Approved blocks, whoever wrote them: nothing changes for the coach or
--     for the athlete who trains one.
--   * A cascade. Deleting a program, a phase or a session deletes what hangs
--     under it, and a trigger then finds no parent: "no parent" is "not a
--     draft". That is how the coach still deletes a draft — in the trash or
--     not — with what is under it.
--
-- WHY approve_program CHANGES ORDER. (a) The sets it writes carry the
-- coach's user id: once the program is approved the triggers let them
-- through. (b) Its first write locks the row of the program until it
-- commits; a save of the author that arrives in that instant — its first
-- statement writes that row — waits, and is then refused (the row is no
-- longer a draft) instead of deleting the phases under the sets being
-- written. A second approval that crossed this one finds no draft any more,
-- and answers { approved: false }, as for any program that is not a draft.
--
-- WHAT A CLIENT SEES. The athlete: nothing — their draft, their save, their
-- training are what they were. The coach, in the app that is deployed (and
-- every one before it): a draft still opens in the Program Sheet, and a
-- change to it is refused with the toast "Couldn't save that. Please try
-- again." — instead of being accepted and lost at the athlete's next save.
-- Approve, Send back, rename and the trash work as before. The next app says
-- why, and offers no change on a draft (coach-editor-nav-errors).
--
-- Backward compatible: yes, with every client ever deployed.
-- Audit:    supabase/audits/2026_10_16_20_drafts_coach_readonly.audit.sql
-- Rollback: supabase/rollbacks/2026_10_16_20_drafts_coach_readonly.down.sql (reopens P53)
-- Runbook:  docs/runbook/migrations/20-drafts-coach-readonly.md
-- ============================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
DECLARE
  v_list text;
BEGIN
  -- First of all, because no other role can even look at the ledger. What is
  -- created below must belong to the role that owns the tables: the five
  -- functions run as their owner, and the default privileges that keep a new
  -- function closed (migration 03) are those of `postgres`.
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'migration 2026_10_16_20_drafts_coach_readonly must be run as postgres, not as %', current_user
      USING HINT = 'Run it from the SQL editor or with `supabase db query --linked`. Nothing was changed.';
  END IF;

  -- Asked before the ledger is read: without it the answer would be
  -- "relation does not exist" instead of this one.
  IF to_regclass('app_private.app_migrations') IS NULL THEN
    RAISE EXCEPTION 'migration 2026_10_16_20_drafts_coach_readonly needs 2026_10_13_18_retention, which is not applied'
      USING ERRCODE = 'SLM02', HINT = 'Apply migrations 01 to 18 first. Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_16_20_drafts_coach_readonly') THEN
    RAISE EXCEPTION 'migration 2026_10_16_20_drafts_coach_readonly is already applied'
      USING ERRCODE = 'SLM01', HINT = 'Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_13_18_retention') THEN
    RAISE EXCEPTION 'migration 2026_10_16_20_drafts_coach_readonly needs 2026_10_13_18_retention, which is not applied'
      USING ERRCODE = 'SLM02', HINT = 'Apply that file first. Nothing was changed.';
  END IF;

  -- The four triggers and their functions are CREATED. One that is there
  -- already, under one of those names, was made by hand.
  SELECT string_agg(w.what, ', ' ORDER BY w.what)
    INTO v_list
    FROM (
      SELECT 'the function ' || p.oid::regprocedure::text AS what
        FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace
         AND p.proname IN ('block_draft_week_write', 'block_draft_session_write',
                           'block_draft_slot_write', 'block_draft_set_log_write')
      UNION ALL
      SELECT 'the trigger ' || t.tgname || ' on ' || t.tgrelid::regclass::text
        FROM pg_trigger t
       WHERE t.tgrelid IN (to_regclass('public.weeks'), to_regclass('public.sessions'),
                           to_regclass('public.exercise_slots'), to_regclass('public.set_logs'))
         AND t.tgname = 'block_draft_tree_write' AND NOT t.tgisinternal
    ) w;
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_16_20_drafts_coach_readonly would not create: % is already there', v_list
      USING HINT = 'Made by hand or by a file that is not in the ledger. Nothing was changed. Stop and report.';
  END IF;

  -- approve_program is REPLACED. It must be the one this file was written
  -- for — the text of migration 15, compared without regard to how it is
  -- laid out (spaces, tabs and line breaks folded into one space): one that
  -- says something else was changed by hand, and replacing it would undo
  -- that without a word. And it must be the only function of that name:
  -- CREATE OR REPLACE replaces the one with the same arguments, and a copy
  -- with other arguments would stay as it is.
  SELECT CASE
           WHEN to_regprocedure('public.approve_program(uuid)') IS NULL
             THEN 'public.approve_program(uuid) is not there'
           WHEN EXISTS (SELECT 1 FROM pg_proc p
                         WHERE p.pronamespace = 'public'::regnamespace
                           AND p.proname = 'approve_program'
                           AND p.oid <> to_regprocedure('public.approve_program(uuid)'))
             THEN (SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text)
                     FROM pg_proc p
                    WHERE p.pronamespace = 'public'::regnamespace
                      AND p.proname = 'approve_program'
                      AND p.oid <> to_regprocedure('public.approve_program(uuid)'))
                  || ' stands next to public.approve_program(uuid)'
           WHEN (SELECT md5(regexp_replace(btrim(p.prosrc, E' \t\r\n'), '[[:space:]]+', ' ', 'g'))
                   FROM pg_proc p WHERE p.oid = to_regprocedure('public.approve_program(uuid)'))
                <> 'c45a0a8b10a0e9ffa3d8dc812a35d10b'
             THEN 'public.approve_program(uuid) is not the text of migration 15 (md5 of its text, spaces folded: '
                  || (SELECT md5(regexp_replace(btrim(p.prosrc, E' \t\r\n'), '[[:space:]]+', ' ', 'g'))
                        FROM pg_proc p WHERE p.oid = to_regprocedure('public.approve_program(uuid)'))
                  || ')'
         END
    INTO v_list;
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_16_20_drafts_coach_readonly would not replace approve_program: %', v_list
      USING HINT = 'It was written for the approve_program of migration 15. Nothing was changed. Stop and report the full message.';
  END IF;

  -- The body of a function is not checked against the database when it is
  -- created: a column or a function that is missing would be found by the
  -- first coach who opens a draft, or approves one. Asked here instead.
  SELECT string_agg(w.what, ', ' ORDER BY w.what)
    INTO v_list
    FROM (
      SELECT c.tbl || '.' || c.col AS what
        FROM (VALUES ('public.programs', 'status'),
                     ('public.programs', 'created_by'),
                     ('public.weeks', 'program_id'),
                     ('public.sessions', 'week_id'),
                     ('public.exercise_slots', 'session_id'),
                     ('public.set_logs', 'exercise_slot_id'),
                     ('public.set_logs', 'is_student_added'),
                     ('public.set_logs', 'target_reps'),
                     ('public.set_logs', 'target_duration_seconds'),
                     ('public.set_log_videos', 'set_log_id')
             ) AS c (tbl, col)
       WHERE NOT EXISTS (
         SELECT 1 FROM pg_attribute a
          WHERE a.attrelid = to_regclass(c.tbl)
            AND a.attname = c.col AND NOT a.attisdropped
       )
      UNION ALL
      SELECT f.signature
        FROM (VALUES ('auth.uid()'), ('public.set_log_is_logged(public.set_logs)')) AS f (signature)
       WHERE to_regprocedure(f.signature) IS NULL
    ) w;
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_16_20_drafts_coach_readonly does not find what its functions are written with: %', v_list
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;
END
$guard$;

-- ------------------------------------------------------------
-- 1. The tree of a draft is its author's.
-- ------------------------------------------------------------
--   no user id (the SQL editor, a migration, the service role)   written
--   the author of the draft (programs.created_by)                 written —
--                                                    as the policies decide
--   anybody else, on a row of a draft — old or new parent          refused
--   anybody, on a row of a program that is not a draft            written —
--                                                    as the policies decide
--   a row whose parent is not there (the cascade of a delete)      written
--
-- One function per table, because each finds the program another way; one
-- trigger name on the four, block_draft_tree_write. BEFORE triggers fire in
-- the order of their names: this one sorts before every other BEFORE trigger
-- of the four tables (block_s…, block_w…, trg_…), so on a draft the refusal
-- is the answer, before any guard or pin is asked.
--
-- "Anybody else", not "the coach": row-level security already keeps every
-- other account away from a draft; asked of the author, the rule also holds
-- for a program a coach made a draft again (created_by empty: nobody wrote
-- it, and nobody with a user id writes its tree until it is approved). One
-- consequence: an INSERT is judged by its triggers BEFORE row-level security
-- checks the row, so a stranger who sends a row into a draft is answered
-- draft_read_only instead of the message of row-level security. Refused
-- either way.
--
-- A request without a user id goes first, without reading anything: the SQL
-- editor, migration 21, the service role. Then ONE lookup by primary keys up
-- to the program — on set_logs, the table every tap of an athlete writes, the
-- only cost the rule adds to a set.
--
-- STABLE, like pin_draft_session_columns and the helpers of the author's
-- policies (program_is_own_draft): it reads the program as the statement saw
-- it when it started, as the policies do, and judges the same two columns.
-- During a cascade it runs inside the statement that deletes the children,
-- which sees the parent gone: no row, and the write goes through.
--
-- SECURITY DEFINER, like every trigger of the tree: it reads the program
-- whatever the caller may read, and must not depend on what the role whose
-- statement fires it may execute.
--
-- The refusal: P0001, a fixed word for a message, the sentences in DETAIL
-- and HINT (supabase/migrations/README.md). The app deployed today shows it
-- as "Couldn't save that. Please try again."
CREATE FUNCTION public.block_draft_week_write()
RETURNS trigger
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller  uuid := auth.uid();
  v_old     uuid;
  v_new     uuid;
  v_program uuid;
BEGIN
  IF v_caller IS NOT NULL THEN
    IF TG_OP <> 'INSERT' THEN
      v_old := OLD.program_id;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      v_new := NEW.program_id;
    END IF;

    SELECT p.id INTO v_program
      FROM public.programs p
     WHERE p.id IN (v_old, v_new)
       AND p.status = 'draft'
       AND p.created_by IS DISTINCT FROM v_caller
     LIMIT 1;

    IF v_program IS NOT NULL THEN
      RAISE EXCEPTION 'draft_read_only'
        USING ERRCODE = 'P0001',
              DETAIL = format('The phase belongs to program %s, a draft: only the account that wrote it changes its phases, sessions, exercises and sets.', v_program),
              HINT = 'Approve the draft or send it back to its athlete. Once approved, it is edited like any other block.';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.block_draft_session_write()
RETURNS trigger
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller  uuid := auth.uid();
  v_old     uuid;
  v_new     uuid;
  v_program uuid;
BEGIN
  IF v_caller IS NOT NULL THEN
    IF TG_OP <> 'INSERT' THEN
      v_old := OLD.week_id;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      v_new := NEW.week_id;
    END IF;

    SELECT p.id INTO v_program
      FROM public.weeks w
      JOIN public.programs p ON p.id = w.program_id
     WHERE w.id IN (v_old, v_new)
       AND p.status = 'draft'
       AND p.created_by IS DISTINCT FROM v_caller
     LIMIT 1;

    IF v_program IS NOT NULL THEN
      RAISE EXCEPTION 'draft_read_only'
        USING ERRCODE = 'P0001',
              DETAIL = format('The session belongs to program %s, a draft: only the account that wrote it changes its phases, sessions, exercises and sets.', v_program),
              HINT = 'Approve the draft or send it back to its athlete. Once approved, it is edited like any other block.';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.block_draft_slot_write()
RETURNS trigger
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller  uuid := auth.uid();
  v_old     uuid;
  v_new     uuid;
  v_program uuid;
BEGIN
  IF v_caller IS NOT NULL THEN
    IF TG_OP <> 'INSERT' THEN
      v_old := OLD.session_id;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      v_new := NEW.session_id;
    END IF;

    SELECT p.id INTO v_program
      FROM public.sessions s
      JOIN public.weeks w    ON w.id = s.week_id
      JOIN public.programs p ON p.id = w.program_id
     WHERE s.id IN (v_old, v_new)
       AND p.status = 'draft'
       AND p.created_by IS DISTINCT FROM v_caller
     LIMIT 1;

    IF v_program IS NOT NULL THEN
      RAISE EXCEPTION 'draft_read_only'
        USING ERRCODE = 'P0001',
              DETAIL = format('The exercise belongs to program %s, a draft: only the account that wrote it changes its phases, sessions, exercises and sets.', v_program),
              HINT = 'Approve the draft or send it back to its athlete. Once approved, it is edited like any other block.';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.block_draft_set_log_write()
RETURNS trigger
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller  uuid := auth.uid();
  v_old     uuid;
  v_new     uuid;
  v_program uuid;
BEGIN
  IF v_caller IS NOT NULL THEN
    IF TG_OP <> 'INSERT' THEN
      v_old := OLD.exercise_slot_id;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      v_new := NEW.exercise_slot_id;
    END IF;

    SELECT p.id INTO v_program
      FROM public.exercise_slots es
      JOIN public.sessions s ON s.id = es.session_id
      JOIN public.weeks w    ON w.id = s.week_id
      JOIN public.programs p ON p.id = w.program_id
     WHERE es.id IN (v_old, v_new)
       AND p.status = 'draft'
       AND p.created_by IS DISTINCT FROM v_caller
     LIMIT 1;

    IF v_program IS NOT NULL THEN
      RAISE EXCEPTION 'draft_read_only'
        USING ERRCODE = 'P0001',
              DETAIL = format('The set belongs to program %s, a draft: only the account that wrote it changes its phases, sessions, exercises and sets.', v_program),
              HINT = 'Approve the draft or send it back to its athlete. Once approved, it is edited like any other block.';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

-- Trigger functions: nobody calls them.
REVOKE ALL ON FUNCTION public.block_draft_week_write() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.block_draft_session_write() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.block_draft_slot_write() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.block_draft_set_log_write() FROM PUBLIC, anon, authenticated;

-- From the top down — the program's phases, their sessions, their exercises,
-- their sets — the order in which the functions of migrations 11 and 12 take
-- their locks. Each CREATE TRIGGER holds its table against writes until
-- COMMIT, for an instant.
CREATE TRIGGER block_draft_tree_write
  BEFORE INSERT OR UPDATE OR DELETE ON public.weeks
  FOR EACH ROW EXECUTE FUNCTION public.block_draft_week_write();

CREATE TRIGGER block_draft_tree_write
  BEFORE INSERT OR UPDATE OR DELETE ON public.sessions
  FOR EACH ROW EXECUTE FUNCTION public.block_draft_session_write();

CREATE TRIGGER block_draft_tree_write
  BEFORE INSERT OR UPDATE OR DELETE ON public.exercise_slots
  FOR EACH ROW EXECUTE FUNCTION public.block_draft_slot_write();

CREATE TRIGGER block_draft_tree_write
  BEFORE INSERT OR UPDATE OR DELETE ON public.set_logs
  FOR EACH ROW EXECUTE FUNCTION public.block_draft_set_log_write();

-- ------------------------------------------------------------
-- 2. approve_program: the status first, and every set with a target.
-- ------------------------------------------------------------
-- The text of migration 15 with two changes, said in the body: the UPDATE of
-- the program moves to the front (and asks for a draft once more, under the
-- lock), and the sets without a target are dropped before the missing sets
-- are written. The notification and its push are those of migration 15,
-- word for word.
--
-- Same header: arguments, the answer, SECURITY DEFINER, search_path —
-- CREATE OR REPLACE drops a SET clause the new text does not repeat. It keeps
-- the privileges; they are said again all the same, so that the result does
-- not depend on what they were.
CREATE OR REPLACE FUNCTION public.approve_program(p_program_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_student_id   uuid;
  v_student_prof uuid;
  v_coach_id     uuid;
  v_prog_name    text;
  v_created      int := 0;
BEGIN
  SELECT p.student_id, p.name INTO v_student_id, v_prog_name
    FROM public.programs p WHERE p.id = p_program_id AND p.status = 'draft';
  IF v_student_id IS NULL THEN
    RETURN jsonb_build_object('approved', false);
  END IF;
  SELECT s.coach_id, s.profile_id INTO v_coach_id, v_student_prof
    FROM public.students s WHERE s.id = v_student_id;
  -- auth.uid() IS NULL is tested first, and the comparison is NULL-safe: with
  -- a plain `<>` a caller without a session skipped this RAISE (review P1).
  IF auth.uid() IS NULL OR v_coach_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  -- The status FIRST (review P53). From here on the program is not a draft:
  -- the writes below carry the coach's user id, which the triggers of the
  -- tree of a draft refuse (block_draft_tree_write). And its row stays
  -- locked until the end: a save of the author that arrives now waits for
  -- it, then finds a program that is no longer a draft and is refused —
  -- instead of deleting the phases under the sets being written. Asked for a
  -- draft once more, under the lock: an approval that crossed this one has
  -- done everything already.
  UPDATE public.programs SET status = 'approved', approved_at = now(), submitted_at = NULL
   WHERE id = p_program_id AND status = 'draft';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('approved', false);
  END IF;

  -- No session of the program enters its life as reviewed, archived, trained
  -- or dated (review P13): those are written after approval, by the coach and
  -- by the athlete's confirmation.
  UPDATE public.sessions s
     SET reviewed_at = NULL, archived_at = NULL, performed_at = NULL, scheduled_date = NULL
    FROM public.weeks w
   WHERE w.id = s.week_id
     AND w.program_id = p_program_id
     AND (s.reviewed_at IS NOT NULL OR s.archived_at IS NOT NULL
          OR s.performed_at IS NOT NULL OR s.scheduled_date IS NOT NULL);

  -- A set without a target is written again from its exercise (review P53).
  -- A draft holds no set of its own: the ones it holds were added by its
  -- coach's editor before the tree of a draft was its author's, with the
  -- targets of a last row a draft does not have — no reps and no duration,
  -- which no prescription is (exercise_slots_unit_one_of). Dropped here, and
  -- added below with the other missing sets. A set with a target is kept, as
  -- before; one that was logged, added by the athlete or filmed is not
  -- touched.
  DELETE FROM public.set_logs sl
   USING public.exercise_slots es, public.sessions s, public.weeks w
   WHERE es.id = sl.exercise_slot_id
     AND s.id = es.session_id
     AND w.id = s.week_id
     AND w.program_id = p_program_id
     AND NOT sl.is_student_added
     AND sl.target_reps IS NULL
     AND sl.target_duration_seconds IS NULL
     AND NOT public.set_log_is_logged(sl)
     AND NOT EXISTS (SELECT 1 FROM public.set_log_videos v WHERE v.set_log_id = sl.id);

  INSERT INTO public.set_logs
    (exercise_slot_id, set_number, done, target_reps, target_duration_seconds, target_weight_kg, target_rest_seconds)
  SELECT es.id, gs.n, false, es.reps, es.duration_seconds, es.weight_kg, es.rest_seconds
    FROM public.exercise_slots es
    JOIN public.sessions s ON s.id = es.session_id
    JOIN public.weeks w    ON w.id = s.week_id
    CROSS JOIN LATERAL generate_series(1, GREATEST(es.sets, 1)) AS gs(n)
   WHERE w.program_id = p_program_id
     AND NOT EXISTS (SELECT 1 FROM public.set_logs sl WHERE sl.exercise_slot_id = es.id AND sl.set_number = gs.n);
  GET DIAGNOSTICS v_created = ROW_COUNT;

  IF v_student_prof IS NOT NULL THEN
    INSERT INTO public.notifications (recipient_id, kind, payload)
    VALUES (v_student_prof, 'program_approved',
      jsonb_build_object('program_id', p_program_id, 'program_name', v_prog_name));
    -- Best-effort Web Push, through send_push_event (2026_10_13_15). Whatever
    -- it raises stays a warning: a push never undoes the write that caused it.
    BEGIN
      PERFORM public.send_push_event(
        v_student_prof,
        jsonb_build_object(
          'title', 'Program approved',
          'body',  'Your coach approved your program' || COALESCE(': ' || v_prog_name, ''),
          'tag',   'program-approved-' || p_program_id::text,
          'data',  jsonb_build_object('url', '/sl_app/#/student')
        )
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'send-push fan-out (program approved) failed: %', SQLERRM;
    END;
  END IF;

  RETURN jsonb_build_object('approved', true, 'set_logs_created', v_created);
END;
$$;

REVOKE ALL ON FUNCTION public.approve_program(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.approve_program(uuid) TO authenticated;

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
      SELECT 'the trigger block_draft_tree_write on ' || t.tbl || ' is not the one meant: '
             || COALESCE((SELECT pg_get_triggerdef(tr.oid, true) || CASE tr.tgenabled WHEN 'O' THEN '' ELSE ' (not enabled)' END
                            FROM pg_trigger tr
                           WHERE tr.tgrelid = to_regclass(t.tbl)
                             AND tr.tgname = 'block_draft_tree_write' AND NOT tr.tgisinternal),
                         'it is not there') AS wrong
        FROM (VALUES ('public.weeks', 'public.block_draft_week_write()'),
                     ('public.sessions', 'public.block_draft_session_write()'),
                     ('public.exercise_slots', 'public.block_draft_slot_write()'),
                     ('public.set_logs', 'public.block_draft_set_log_write()')
             ) AS t (tbl, fn)
       WHERE NOT EXISTS (
         SELECT 1 FROM pg_trigger tr
          WHERE tr.tgrelid = to_regclass(t.tbl)
            AND tr.tgname = 'block_draft_tree_write' AND NOT tr.tgisinternal
            AND tr.tgenabled = 'O'
            AND tr.tgfoid = to_regprocedure(t.fn)
            -- a row trigger, BEFORE, on INSERT, DELETE and UPDATE, of any column
            AND tr.tgtype = 1 + 2 + 4 + 8 + 16
            AND tr.tgattr::text = ''
            AND tr.tgqual IS NULL
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
                     THEN CASE WHEN s.for_users THEN 'is not executable by a signed-in user: the coach could not approve a draft'
                               ELSE 'is executable by a signed-in user' END
                   WHEN p.provolatile <> s.volatility THEN 'is not ' || CASE s.volatility WHEN 's' THEN 'STABLE' ELSE 'VOLATILE' END
                   WHEN position(s.holds IN p.prosrc) = 0 THEN 'does not hold ' || s.holds
                 END AS wrong
            FROM (VALUES ('public.block_draft_week_write()',    false, 's', 'p.created_by IS DISTINCT FROM v_caller'),
                         ('public.block_draft_session_write()', false, 's', 'p.created_by IS DISTINCT FROM v_caller'),
                         ('public.block_draft_slot_write()',    false, 's', 'p.created_by IS DISTINCT FROM v_caller'),
                         ('public.block_draft_set_log_write()', false, 's', 'p.created_by IS DISTINCT FROM v_caller'),
                         ('public.approve_program(uuid)',       true,  'v', 'WHERE id = p_program_id AND status = ''draft'';')
                 ) AS s (signature, for_users, volatility, holds)
            LEFT JOIN pg_proc p ON p.oid = to_regprocedure(s.signature)
        ) f
       WHERE f.wrong IS NOT NULL
      UNION ALL
      -- The status before the sets: the first write of approve_program is
      -- the UPDATE of the program.
      SELECT 'public.approve_program(uuid) does not mark the program approved before it writes a set'
        FROM pg_proc p
       WHERE p.oid = to_regprocedure('public.approve_program(uuid)')
         AND NOT (position('UPDATE public.programs SET status = ''approved''' IN p.prosrc)
                    BETWEEN 1 AND least(position('UPDATE public.sessions' IN p.prosrc),
                                        position('DELETE FROM public.set_logs' IN p.prosrc),
                                        position('INSERT INTO public.set_logs' IN p.prosrc)))
    ) w;
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_16_20_drafts_coach_readonly did not get what it meant: %', v_list
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;
END
$verify$;

INSERT INTO app_private.app_migrations (name)
VALUES ('2026_10_16_20_drafts_coach_readonly')
RETURNING name, applied_at;

-- Four functions joined public: PostgREST learns of them when its schema
-- cache is reloaded.
NOTIFY pgrst, 'reload schema';

COMMIT;
