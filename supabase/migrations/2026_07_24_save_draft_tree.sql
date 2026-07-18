-- ============================================================
-- Phase 3.4d — offline program authoring: one idempotent, declarative
-- whole-tree upsert. The client edits the draft in an optimistic cache with
-- client-minted uuids and syncs the ENTIRE tree as one snapshot; replaying the
-- same snapshot N times converges to exactly that state (no dup rows, no
-- transient UNIQUE collisions).
--
-- SECURITY INVOKER: rides the shipped 3.4a own-draft RLS (own-draft helpers +
-- exercise-in-coach-library WITH CHECK + pin_program_authoring_columns), adding
-- zero new trust surface. Child levels are DELETE-then-reINSERT (weeks cascade →
-- sessions/slots), which is uniquely safe for a DRAFT: it carries NO set_logs
-- (approve_program materializes those only at approval) and no
-- slot_comments/deviations, so the cascade is inert and the whole-tree replace
-- is reorder-proof.
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

  -- Approval race: coach approved (or removed) the draft mid-queue. Raise a
  -- recognizable code so the client reconciles to the approved state instead of
  -- corrupting it.
  SELECT status INTO v_existing FROM public.programs WHERE id = v_pid;
  IF v_existing IS NOT NULL AND v_existing <> 'draft' THEN
    RAISE EXCEPTION 'draft_not_editable' USING ERRCODE = 'P0001',
      DETAIL = 'program is no longer a draft';
  END IF;

  -- Specific, actionable error if a slot's exercise was removed from the coach
  -- library between offline authoring and sync (the INVOKER WITH CHECK would
  -- reject it anyway, but opaquely). Names the offending exercise id.
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

  -- 1) Program row: UPSERT, never delete. submitted_at is intentionally OMITTED
  --    so the upsert never fabricates a NULL->set edge; the explicit stamp
  --    (step 3) owns that edge so notify_coach_on_program_submit fires once.
  INSERT INTO public.programs (id, student_id, created_by, status, is_active, name, sort_order)
  VALUES (v_pid, v_student, auth.uid(), 'draft', false, v_name, 0)
  ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

  -- 2) Children: declarative replace, parent-first, client-minted ids.
  DELETE FROM public.weeks WHERE program_id = v_pid;

  INSERT INTO public.weeks (id, program_id, week_number, label)
  SELECT (w->>'id')::uuid, v_pid, (w->>'week_number')::int, NULLIF(w->>'label','')
    FROM jsonb_array_elements(COALESCE(p_tree->'weeks','[]'::jsonb)) w;
  GET DIAGNOSTICS v_weeks = ROW_COUNT;

  INSERT INTO public.sessions (id, week_id, title, day_number, sort_order)
  SELECT (s->>'id')::uuid, (s->>'week_id')::uuid,
         COALESCE(NULLIF(s->>'title',''),'Session'),
         COALESCE((s->>'day_number')::int,1),
         COALESCE((s->>'sort_order')::int,0)
    FROM jsonb_array_elements(COALESCE(p_tree->'sessions','[]'::jsonb)) s;
  GET DIAGNOSTICS v_sessions = ROW_COUNT;

  INSERT INTO public.exercise_slots
    (id, session_id, exercise_id, sets, reps, weight_kg, duration_seconds, rest_seconds, sort_order)
  SELECT (s->>'id')::uuid, (s->>'session_id')::uuid, (s->>'exercise_id')::uuid,
         COALESCE((s->>'sets')::int,3),
         -- XOR safety net: if reps absent AND no duration, force reps=1 so a
         -- stale snapshot can never abort the whole tree on the CHECK at replay.
         COALESCE((s->>'reps')::int,
                  CASE WHEN (s->>'duration_seconds') IS NULL THEN 1 ELSE NULL END),
         (s->>'weight_kg')::numeric,
         (s->>'duration_seconds')::int,
         (s->>'rest_seconds')::int,
         COALESCE((s->>'sort_order')::int,0)
    FROM jsonb_array_elements(COALESCE(p_tree->'slots','[]'::jsonb)) s;
  GET DIAGNOSTICS v_slots = ROW_COUNT;

  -- 3) Submit edge as a REAL update so the AFTER UPDATE notify trigger fires
  --    once, even when the program was just inserted in this same transaction.
  IF v_submitted IS NOT NULL THEN
    UPDATE public.programs SET submitted_at = v_submitted
     WHERE id = v_pid AND submitted_at IS NULL;
  END IF;

  RETURN jsonb_build_object('program_id', v_pid,
    'weeks', v_weeks, 'sessions', v_sessions, 'slots', v_slots);
END;
$$;

REVOKE ALL ON FUNCTION public.save_draft_tree(jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.save_draft_tree(jsonb) TO authenticated;
