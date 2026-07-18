-- ============================================================
-- Phase 3.1 — "promote deviation → program edit": adopt a student's swap.
--
-- When a student SWAPS exercise X for Y (a slot_deviations row, kind='swap'),
-- the coach can now promote that into the standing prescription: every UPCOMING
-- occurrence of X in the SAME program flips to Y, so the student stops having to
-- re-swap every week.
--
-- Delivered as a single SECURITY DEFINER RPC because coaches have only a SELECT
-- policy on slot_deviations (no write), and because the multi-slot rewrite must
-- be atomic. The function SELF-AUTHORIZES (definer bypasses RLS) — it asserts
-- the caller is the session's coach and that the substitute is the coach's own
-- library exercise.
--
-- Design decisions (see the design panel / roadmap):
--   * FORWARD-ONLY. The reviewed session's slot is never rewritten — it's
--     confirmed (or carries the deviation being adopted), so the "upcoming
--     unconfirmed, no-deviation" filter excludes it. History stays honest:
--     "prescribed X, did Y" remains true for the past session.
--   * Scope is the reviewed slot's OWN program (never an abstract active one).
--   * SKIP future slots that already carry their own (newer) deviation — a
--     later student choice isn't silently overwritten.
--   * target_* (X's per-set numbers) are carried onto Y as a starting seed;
--     the coach retunes with the normal slot editor. No set_logs are touched.
--   * The substitute id is passed in explicitly (what the coach saw), so a
--     concurrent student-undo of the swap can't blank the adoption.
--   * p_dry_run=true reports the blast-radius count without mutating (feeds the
--     coach's confirm dialog); double-submit is a graceful 0-count no-op.
--   * Notifies the student (bell + best-effort Web Push, Vault-gated).
-- ============================================================

CREATE OR REPLACE FUNCTION public.adopt_swap(
  p_slot_id uuid,
  p_substitute_id uuid,
  p_dry_run boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session_id     uuid;
  v_original_ex    uuid;
  v_coach_id       uuid;
  v_student_prof   uuid;
  v_program_id     uuid;
  v_week_number    int;
  v_sort_order     int;
  v_slot_ids       uuid[];
  v_applied        int := 0;
  v_orig_name      text;
  v_sub_name       text;
  v_session_title  text;
  v_coach_name     text;
  v_functions_url  text;
  v_service_key    text;
BEGIN
  -- Reviewed slot → its session + currently-prescribed exercise.
  SELECT es.session_id, es.exercise_id
    INTO v_session_id, v_original_ex
    FROM public.exercise_slots es
   WHERE es.id = p_slot_id;
  IF v_session_id IS NULL THEN
    RAISE EXCEPTION 'slot not found';
  END IF;

  -- AuthZ: caller must be this session's coach (definer bypasses RLS).
  v_coach_id := public.coach_profile_for_session(v_session_id);
  IF v_coach_id IS NULL OR v_coach_id <> auth.uid() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  -- The substitute must be one of the coach's OWN library exercises.
  IF NOT EXISTS (
    SELECT 1 FROM public.exercise_library el
     WHERE el.id = p_substitute_id AND el.coach_id = v_coach_id
  ) THEN
    RAISE EXCEPTION 'substitute not in coach library';
  END IF;

  -- Scope strictly to the reviewed slot's own program + its ordinal position.
  SELECT w.program_id, w.week_number, s.sort_order
    INTO v_program_id, v_week_number, v_sort_order
    FROM public.sessions s
    JOIN public.weeks w ON w.id = s.week_id
   WHERE s.id = v_session_id;

  -- Forward-only target set. "Upcoming" is a REAL ordinal bound (strictly later
  -- in program order than the reviewed session), NOT the "unconfirmed" proxy —
  -- confirmation is optional, so an unconfirmed-but-already-trained past session
  -- must never be rewritten. Layered guards, all required:
  --   * same program, still prescribing X, not archived;
  --   * a DIFFERENT session than the reviewed one (protect sibling X slots);
  --   * strictly later week_number / sort_order (the literal "upcoming");
  --   * no confirmation AND no performed set_logs (never touch trained work);
  --   * no existing deviation (don't overwrite a newer student choice).
  SELECT array_agg(es.id)
    INTO v_slot_ids
    FROM public.exercise_slots es
    JOIN public.sessions s ON s.id = es.session_id
    JOIN public.weeks w ON w.id = s.week_id
   WHERE w.program_id = v_program_id
     AND es.exercise_id = v_original_ex
     AND s.archived_at IS NULL
     AND s.id <> v_session_id
     AND (w.week_number > v_week_number
          OR (w.week_number = v_week_number AND s.sort_order > v_sort_order))
     AND NOT EXISTS (
       SELECT 1 FROM public.session_confirmations sc WHERE sc.session_id = s.id
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.set_logs sl
        WHERE sl.exercise_slot_id = es.id
          AND (sl.done = true OR sl.skipped = true
               OR sl.actual_reps IS NOT NULL OR sl.actual_weight_kg IS NOT NULL)
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.slot_deviations d WHERE d.exercise_slot_id = es.id
     );

  v_applied := COALESCE(array_length(v_slot_ids, 1), 0);

  -- Dry run: blast-radius count only, no writes, no notification.
  IF p_dry_run THEN
    RETURN jsonb_build_object('applied', v_applied, 'dry_run', true);
  END IF;

  IF v_slot_ids IS NOT NULL THEN
    UPDATE public.exercise_slots
       SET exercise_id = p_substitute_id
     WHERE id = ANY(v_slot_ids);
  END IF;

  -- Notify the student their swap became the plan (best-effort, only if we
  -- actually changed something forward).
  v_student_prof := public.student_profile_for_session(v_session_id);
  IF v_student_prof IS NOT NULL AND v_applied > 0 THEN
    SELECT el.name INTO v_orig_name FROM public.exercise_library el WHERE el.id = v_original_ex;
    SELECT el.name INTO v_sub_name  FROM public.exercise_library el WHERE el.id = p_substitute_id;
    SELECT COALESCE(NULLIF(BTRIM(s.title), ''), 'Session') INTO v_session_title
      FROM public.sessions s WHERE s.id = v_session_id;
    SELECT p.full_name INTO v_coach_name FROM public.profiles p WHERE p.id = v_coach_id;

    INSERT INTO public.notifications (recipient_id, kind, payload)
    VALUES (
      v_student_prof,
      'swap_adopted',
      jsonb_build_object(
        'session_id', v_session_id,
        'session_title', v_session_title,
        'coach_name', v_coach_name,
        'original_exercise', v_orig_name,
        'substitute_exercise', v_sub_name,
        'applied_count', v_applied
      )
    );

    BEGIN
      SELECT decrypted_secret INTO v_functions_url FROM vault.decrypted_secrets WHERE name = 'app_functions_url';
      SELECT decrypted_secret INTO v_service_key   FROM vault.decrypted_secrets WHERE name = 'app_service_role_key';
      IF v_functions_url IS NOT NULL AND v_service_key IS NOT NULL
         AND v_functions_url <> '' AND v_service_key <> '' THEN
        PERFORM net.http_post(
          url := v_functions_url || '/send-push',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || v_service_key
          ),
          body := jsonb_build_object(
            'user_id', v_student_prof,
            'payload', jsonb_build_object(
              'title', 'Program updated',
              'body',  COALESCE(v_coach_name, 'Your coach') || ' adopted your swap: '
                       || COALESCE(v_orig_name, 'an exercise') || ' → '
                       || COALESCE(v_sub_name, 'another exercise'),
              'tag',   'swap-adopted-' || p_slot_id::text,
              'data',  jsonb_build_object('url', '/sl_app/#/student/session/' || v_session_id::text)
            )
          )
        );
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'send-push fan-out (swap adopted) failed: %', SQLERRM;
    END;
  END IF;

  RETURN jsonb_build_object('applied', v_applied, 'dry_run', false);
END;
$$;

REVOKE ALL ON FUNCTION public.adopt_swap(uuid, uuid, boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.adopt_swap(uuid, uuid, boolean) TO authenticated;
