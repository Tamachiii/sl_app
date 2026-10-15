-- ============================================================
-- 21 — An RPE in half steps; the weekday of a session is a weekday, or none
-- wave 3 · Checkpoint C1 · required · findings L34, B12
--
-- L34. set_logs.rpe is an integer from 1 to 10: an athlete who felt 7.5 has
-- to say 7 or 8, and a client that sends 7.5 is refused (22P02). From this
-- file on it is numeric(3,1), from 1 to 10 in steps of 0.5:
--   * set_logs_rpe_check (1 to 10) is kept, written again for the new type;
--   * set_logs_rpe_half_step is added: rpe * 2 is a whole number. numeric(3,1)
--     rounds what is sent to one decimal first — 7.04 is stored as 7.0, 7.26
--     as 7.3, which the rule refuses (23514);
--   * set_logs_no_rpe_when_failed is unchanged.
-- Every RPE logged so far keeps its value (8 reads 8.0). The API hands it to
-- the app as a JSON number, which JavaScript reads as 8: the app that is
-- deployed reads and writes whole numbers as before.
--
-- B12. sessions.day_number is the weekday a session is advised for (1 =
-- Monday … 7 = Sunday), or none. The draft builder of the athlete has no
-- weekday control: what its sessions hold was written by older code — a
-- position (the 9th session of a phase said 9), or Monday for every session
-- (save_draft_tree coalesced to 1 until 2026_08_22). Nothing checked the
-- range. This file:
--   1. clears day_number where it is not a weekday (outside 1 to 7), and on
--      every session of a block an athlete wrote (programs.created_by is
--      set): drafts and approved blocks, trained and reviewed sessions
--      included. The runbook page lists them first. Run in a session that
--      said `SET app.day_number_clearing = 'drafts'` before, it clears the
--      sessions of the drafts only, and keeps the weekdays of the approved
--      blocks an athlete wrote (the page gives that command). The values do
--      not come back with the rollback;
--   2. adds sessions_day_number_weekday: NULL or 1 to 7;
--   3. replaces save_draft_tree so that a number outside 1 to 7 is written
--      as no weekday instead of failing the whole tree on the new rule. A
--      phone that cached its draft before this file still sends what the
--      draft held then — and the athlete's next save would be refused, and
--      what it carried lost. Nothing else in the function changes.
-- The coach's editor writes 1 to 7 or nothing (lib/day.js, useWeek.js);
-- the four copy functions copy a value that is now always a weekday.
--
-- Locks: sessions and set_logs, from the top of the tree down, for the
-- time it takes to write set_logs again with the new type. A tick of an
-- athlete in that instant waits for it.
--
-- Backward compatible: yes, with every client ever deployed.
-- Audit:    supabase/audits/2026_10_16_21_rpe_half_steps_day_check.audit.sql
-- Rollback: supabase/rollbacks/2026_10_16_21_rpe_half_steps_day_check.down.sql
--           (an RPE of 7.5 becomes 8; the weekdays cleared stay cleared)
-- Runbook:  docs/runbook/migrations/21-rpe-half-steps-day-check.md
-- ============================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
DECLARE
  v_clearing text := coalesce(nullif(current_setting('app.day_number_clearing', true), ''), 'all');
  v_found text;
BEGIN
  -- First of all, because no other role can even look at the ledger. What is
  -- altered below belongs to `postgres`.
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'migration 2026_10_16_21_rpe_half_steps_day_check must be run as postgres, not as %', current_user
      USING HINT = 'Run it from the SQL editor or with `supabase db query --linked`. Nothing was changed.';
  END IF;

  IF to_regclass('app_private.app_migrations') IS NULL THEN
    RAISE EXCEPTION 'migration 2026_10_16_21_rpe_half_steps_day_check needs 2026_10_16_20_drafts_coach_readonly, which is not applied'
      USING ERRCODE = 'SLM02', HINT = 'Apply migrations 01 to 20 first. Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_16_21_rpe_half_steps_day_check') THEN
    RAISE EXCEPTION 'migration 2026_10_16_21_rpe_half_steps_day_check is already applied'
      USING ERRCODE = 'SLM01', HINT = 'Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.app_migrations WHERE name = '2026_10_16_20_drafts_coach_readonly') THEN
    RAISE EXCEPTION 'migration 2026_10_16_21_rpe_half_steps_day_check needs 2026_10_16_20_drafts_coach_readonly, which is not applied'
      USING ERRCODE = 'SLM02', HINT = 'Apply that file first. Nothing was changed.';
  END IF;

  -- The choice of the page, when one was made: 'all' (or nothing said) or
  -- 'drafts'. Anything else is a typing mistake, not a third choice.
  IF v_clearing NOT IN ('all', 'drafts') THEN
    RAISE EXCEPTION 'migration 2026_10_16_21_rpe_half_steps_day_check does not know app.day_number_clearing = %', v_clearing
      USING HINT = 'all (or nothing) clears every weekday of the blocks an athlete wrote; drafts, those of their drafts only. Nothing was changed.';
  END IF;

  -- set_logs.rpe as every migration so far left it.
  SELECT format_type(a.atttypid, a.atttypmod) INTO v_found
    FROM pg_attribute a
   WHERE a.attrelid = 'public.set_logs'::regclass AND a.attname = 'rpe' AND NOT a.attisdropped;
  IF v_found IS DISTINCT FROM 'integer' THEN
    RAISE EXCEPTION 'migration 2026_10_16_21_rpe_half_steps_day_check would not change set_logs.rpe: it is %, not integer', coalesce(v_found, 'not there')
      USING HINT = 'Changed by hand or by a file that is not in the ledger. Nothing was changed. Stop and report.';
  END IF;
  SELECT pg_get_constraintdef(c.oid) INTO v_found
    FROM pg_constraint c
   WHERE c.conrelid = 'public.set_logs'::regclass AND c.conname = 'set_logs_rpe_check';
  IF v_found IS DISTINCT FROM 'CHECK (((rpe IS NULL) OR ((rpe >= 1) AND (rpe <= 10))))' THEN
    RAISE EXCEPTION 'migration 2026_10_16_21_rpe_half_steps_day_check would not change set_logs.rpe: set_logs_rpe_check is %', coalesce(v_found, 'not there')
      USING HINT = 'Changed by hand or by a file that is not in the ledger. Nothing was changed. Stop and report.';
  END IF;

  -- The two rules are CREATED.
  SELECT string_agg(c.conname || ' on ' || c.conrelid::regclass::text, ', ' ORDER BY c.conname) INTO v_found
    FROM pg_constraint c
   WHERE (c.conrelid = 'public.set_logs'::regclass AND c.conname = 'set_logs_rpe_half_step')
      OR (c.conrelid = 'public.sessions'::regclass AND c.conname = 'sessions_day_number_weekday');
  IF v_found IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_16_21_rpe_half_steps_day_check would not create: % is already there', v_found
      USING HINT = 'Made by hand or by a file that is not in the ledger. Nothing was changed. Stop and report.';
  END IF;

  -- save_draft_tree is REPLACED. It must be the one this file was written
  -- for — the text of 2026_08_22_draft_day_number_optional.sql — and the
  -- only function of that name. The text is compared without its `--`
  -- comments and without regard to how it is laid out: production was given
  -- the text of that file, schema.sql and the frozen baseline hold the same
  -- code with another comment (finding L29), and both are the function of
  -- August.
  SELECT CASE
           WHEN to_regprocedure('public.save_draft_tree(jsonb)') IS NULL
             THEN 'public.save_draft_tree(jsonb) is not there'
           WHEN EXISTS (SELECT 1 FROM pg_proc p
                         WHERE p.pronamespace = 'public'::regnamespace
                           AND p.proname = 'save_draft_tree'
                           AND p.oid <> to_regprocedure('public.save_draft_tree(jsonb)'))
             THEN 'another function of that name stands next to public.save_draft_tree(jsonb)'
           WHEN (SELECT md5(btrim(regexp_replace(regexp_replace(p.prosrc, '-{2}.*', '', 'gn'), '[[:space:]]+', ' ', 'g')))
                   FROM pg_proc p WHERE p.oid = to_regprocedure('public.save_draft_tree(jsonb)'))
                <> 'd1fd47e42496f84dd91a2310bce043a5'
             THEN 'public.save_draft_tree(jsonb) is not the text of 2026_08_22 (md5 of its text, comments left out and spaces folded: '
                  || (SELECT md5(btrim(regexp_replace(regexp_replace(p.prosrc, '-{2}.*', '', 'gn'), '[[:space:]]+', ' ', 'g')))
                        FROM pg_proc p WHERE p.oid = to_regprocedure('public.save_draft_tree(jsonb)'))
                  || ')'
         END
    INTO v_found;
  IF v_found IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_16_21_rpe_half_steps_day_check would not replace save_draft_tree: %', v_found
      USING HINT = 'It was written for the save_draft_tree of 2026_08_22. Nothing was changed. Stop and report the full message.';
  END IF;
END
$guard$;

-- The two tables, from the top of the tree down: the order of a cascade, so
-- that a delete of the app that holds a session and waits for its sets
-- cannot hold what this file waits for.
LOCK TABLE public.sessions, public.set_logs IN ACCESS EXCLUSIVE MODE;

-- ------------------------------------------------------------
-- 1. L34 — the RPE in half steps.
-- ------------------------------------------------------------
-- The range rule is dropped and written again rather than carried over by
-- ALTER TYPE: what it reads like afterwards is then the text below, as in
-- schema.sql.
ALTER TABLE public.set_logs
  DROP CONSTRAINT set_logs_rpe_check,
  ALTER COLUMN rpe TYPE numeric(3,1),
  ADD CONSTRAINT set_logs_rpe_check CHECK (rpe IS NULL OR (rpe BETWEEN 1 AND 10)),
  ADD CONSTRAINT set_logs_rpe_half_step CHECK (rpe IS NULL OR rpe * 2 = trunc(rpe * 2));

-- ------------------------------------------------------------
-- 2. B12 — the weekdays that are not one, and those of the blocks an athlete
--    wrote. As the owner: no user id, so block_draft_tree_write (migration
--    20) lets the sessions of a draft through, and the pins of migration 06
--    have nothing to put back (a session of a draft carries none of the
--    four dates).
-- ------------------------------------------------------------
-- >>> the clearing
UPDATE public.sessions s
   SET day_number = NULL
  FROM public.weeks w
  JOIN public.programs p ON p.id = w.program_id
 WHERE w.id = s.week_id
   AND s.day_number IS NOT NULL
   AND (s.day_number NOT BETWEEN 1 AND 7
        OR (p.created_by IS NOT NULL
            AND (p.status = 'draft'
                 OR coalesce(nullif(current_setting('app.day_number_clearing', true), ''), 'all') = 'all')));
-- <<< the clearing

-- No row is in the way any more: the rule is added validated.
ALTER TABLE public.sessions
  ADD CONSTRAINT sessions_day_number_weekday CHECK (day_number IS NULL OR day_number BETWEEN 1 AND 7);

-- ------------------------------------------------------------
-- 3. save_draft_tree: a number that is no weekday is written as none.
--    The text of 2026_08_22, one expression changed.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.save_draft_tree(p_tree jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_student   uuid;
  v_pid       uuid        := (p_tree->'program'->>'id')::uuid;
  v_name      text        := COALESCE(NULLIF(trim(p_tree->'program'->>'name'), ''), 'My program');
  v_submitted timestamptz := NULLIF(p_tree->'program'->>'submitted_at','')::timestamptz;
  v_existing  text;
  v_bad       uuid;
  v_weeks int := 0; v_sessions int := 0; v_slots int := 0;
BEGIN
  IF v_pid IS NULL THEN RAISE EXCEPTION 'save_draft_tree: program id required'; END IF;
  SELECT id INTO v_student FROM public.students WHERE profile_id = auth.uid();
  IF v_student IS NULL THEN RAISE EXCEPTION 'save_draft_tree: no student profile'; END IF;

  SELECT status INTO v_existing FROM public.programs WHERE id = v_pid;
  IF v_existing IS NOT NULL AND v_existing <> 'draft' THEN
    RAISE EXCEPTION 'draft_not_editable' USING ERRCODE = 'P0001', DETAIL = 'program is no longer a draft';
  END IF;

  SELECT (s->>'exercise_id')::uuid INTO v_bad
    FROM jsonb_array_elements(COALESCE(p_tree->'slots','[]'::jsonb)) s
   WHERE (s->>'exercise_id')::uuid NOT IN (
     SELECT el.id FROM public.exercise_library el
     JOIN public.students st ON st.coach_id = el.coach_id
     WHERE st.profile_id = auth.uid())
   LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'exercise_unavailable' USING ERRCODE = 'P0001', DETAIL = v_bad::text;
  END IF;

  INSERT INTO public.programs (id, student_id, created_by, status, is_active, name, sort_order)
  VALUES (v_pid, v_student, auth.uid(), 'draft', false, v_name, 0)
  ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

  DELETE FROM public.weeks WHERE program_id = v_pid;

  INSERT INTO public.weeks (id, program_id, week_number, label)
  SELECT (w->>'id')::uuid, v_pid, (w->>'week_number')::int, NULLIF(w->>'label','')
    FROM jsonb_array_elements(COALESCE(p_tree->'weeks','[]'::jsonb)) w;
  GET DIAGNOSTICS v_weeks = ROW_COUNT;

  INSERT INTO public.sessions (id, week_id, title, day_number, sort_order)
  SELECT (s->>'id')::uuid, (s->>'week_id')::uuid,
         COALESCE(NULLIF(s->>'title',''),'Session'),
         -- No weekday chosen stays NULL (2026_08_22): sort_order is the order.
         -- A number that is no weekday — what a phone that cached its draft
         -- before 2026_10_16_21 may still send — is written as none, instead
         -- of failing the whole tree on sessions_day_number_weekday.
         CASE WHEN (s->>'day_number')::int BETWEEN 1 AND 7 THEN (s->>'day_number')::int END,
         COALESCE((s->>'sort_order')::int,0)
    FROM jsonb_array_elements(COALESCE(p_tree->'sessions','[]'::jsonb)) s;
  GET DIAGNOSTICS v_sessions = ROW_COUNT;

  INSERT INTO public.exercise_slots
    (id, session_id, exercise_id, sets, reps, weight_kg, duration_seconds, rest_seconds, sort_order)
  SELECT (s->>'id')::uuid, (s->>'session_id')::uuid, (s->>'exercise_id')::uuid,
         COALESCE((s->>'sets')::int,3),
         COALESCE((s->>'reps')::int, CASE WHEN (s->>'duration_seconds') IS NULL THEN 1 ELSE NULL END),
         (s->>'weight_kg')::numeric,
         (s->>'duration_seconds')::int,
         (s->>'rest_seconds')::int,
         COALESCE((s->>'sort_order')::int,0)
    FROM jsonb_array_elements(COALESCE(p_tree->'slots','[]'::jsonb)) s;
  GET DIAGNOSTICS v_slots = ROW_COUNT;

  IF v_submitted IS NOT NULL THEN
    UPDATE public.programs SET submitted_at = v_submitted WHERE id = v_pid AND submitted_at IS NULL;
  END IF;

  RETURN jsonb_build_object('program_id', v_pid, 'weeks', v_weeks, 'sessions', v_sessions, 'slots', v_slots);
END;
$$;

REVOKE ALL ON FUNCTION public.save_draft_tree(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_draft_tree(jsonb) TO authenticated;

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
      SELECT 'set_logs.rpe is ' || format_type(a.atttypid, a.atttypmod) AS wrong
        FROM pg_attribute a
       WHERE a.attrelid = 'public.set_logs'::regclass AND a.attname = 'rpe'
         AND format_type(a.atttypid, a.atttypmod) <> 'numeric(3,1)'
      UNION ALL
      SELECT r.conname || ' is not there, or not validated'
        FROM (VALUES ('public.set_logs', 'set_logs_rpe_check'),
                     ('public.set_logs', 'set_logs_rpe_half_step'),
                     ('public.set_logs', 'set_logs_no_rpe_when_failed'),
                     ('public.sessions', 'sessions_day_number_weekday')) AS r (tbl, conname)
       WHERE NOT EXISTS (SELECT 1 FROM pg_constraint c
                          WHERE c.conrelid = to_regclass(r.tbl) AND c.conname = r.conname
                            AND c.contype = 'c' AND c.convalidated)
      UNION ALL
      SELECT 'save_draft_tree(jsonb) does not hold the weekday guard'
        FROM pg_proc p
       WHERE p.oid = to_regprocedure('public.save_draft_tree(jsonb)')
         AND (position('CASE WHEN (s->>''day_number'')::int BETWEEN 1 AND 7 THEN (s->>''day_number'')::int END' IN p.prosrc) = 0
              OR p.prosecdef
              OR NOT ('search_path=public, pg_temp' = ANY (coalesce(p.proconfig, '{}')))
              OR has_function_privilege('anon', p.oid, 'EXECUTE')
              OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE'))
    ) w;
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'migration 2026_10_16_21_rpe_half_steps_day_check did not get what it meant: %', v_list
      USING HINT = 'Nothing was changed. Stop and report the full message.';
  END IF;
END
$verify$;

INSERT INTO app_private.app_migrations (name)
VALUES ('2026_10_16_21_rpe_half_steps_day_check')
RETURNING name, applied_at;

-- A column of public changed its type: PostgREST learns of it when its
-- schema cache is reloaded.
NOTIFY pgrst, 'reload schema';

COMMIT;
