-- ============================================================
-- Week decoupling, student-authoring path: a draft session with no chosen
-- weekday must stay NULL.
--
-- `save_draft_tree` (2026_07_24) predates 2026_08_21_day_number_optional, when
-- `sessions.day_number` was still NOT NULL and every insert had to name a
-- weekday. Since then a weekday is an advisory hint that no longer sorts, and
-- the coach path was fixed to write NULL — but this RPC kept coalescing to 1,
-- so every student-authored session came back recommending Monday, a day the
-- student never picked. The authoring UI has no weekday control at all, so
-- EVERY draft session hit that default.
--
-- Only the sessions INSERT changes; the rest of the body is carried verbatim.
-- ============================================================

CREATE OR REPLACE FUNCTION public.save_draft_tree(p_tree jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
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

  -- day_number passes through as-is: no weekday chosen stays NULL, it does not
  -- become Monday. sort_order is the order.
  INSERT INTO public.sessions (id, week_id, title, day_number, sort_order)
  SELECT (s->>'id')::uuid, (s->>'week_id')::uuid,
         COALESCE(NULLIF(s->>'title',''),'Session'),
         (s->>'day_number')::int,
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

REVOKE ALL ON FUNCTION public.save_draft_tree(jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.save_draft_tree(jsonb) TO authenticated;
