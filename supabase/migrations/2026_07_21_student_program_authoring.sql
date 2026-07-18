-- ============================================================
-- Phase 3.4a — full student program authoring: DB approval gate.
--
-- A student can draft a WHOLE program (weeks → sessions → slots + slot-level
-- targets) that stays INERT until the coach approves it. Approval-gate model,
-- ONLINE-ONLY for v1 (the client gates authoring on connectivity; no offline
-- INSERT replay — see the design note in docs/INVARIANTS.md).
--
-- Fully back-compatible: status DEFAULTs to 'approved' and coach INSERTs never
-- mention it, so every existing row + the entire coach flow are untouched;
-- nothing reads on created_by, so coach programs stay created_by=NULL.
--
-- Set-log targets are NOT written during drafting (students never touch
-- set_logs) — they are materialized from the slot scalars at APPROVAL time by
-- approve_program(). So pin_set_log_targets_for_student needs no draft
-- exception, and the student write surface is 4 tables, not 5.
-- ============================================================

-- ── Columns + constraints ────────────────────────────────────────────────
ALTER TABLE public.programs
  ADD COLUMN IF NOT EXISTS created_by  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS status      text NOT NULL DEFAULT 'approved',
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_at  timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'programs_status_check') THEN
    ALTER TABLE public.programs ADD CONSTRAINT programs_status_check CHECK (status IN ('draft', 'approved'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'programs_draft_not_active') THEN
    -- A draft can never hold the one-active-per-student slot.
    ALTER TABLE public.programs ADD CONSTRAINT programs_draft_not_active CHECK (NOT (status = 'draft' AND is_active));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_programs_created_by ON public.programs(created_by) WHERE created_by IS NOT NULL;
-- One in-flight draft per student keeps the surface small for v1.
CREATE UNIQUE INDEX IF NOT EXISTS programs_one_draft_per_student
  ON public.programs(student_id) WHERE status = 'draft' AND deleted_at IS NULL;

-- ── Recursion-firewall helpers (SECURITY DEFINER STABLE) ─────────────────
-- Descendant authoring policies MUST reach `programs` through these definers,
-- never an inline subquery under the caller's RLS, or Postgres raises
-- "infinite recursion detected in policy".
CREATE OR REPLACE FUNCTION public.program_is_own_draft(p_program_id uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.programs p
     WHERE p.id = p_program_id
       AND p.created_by = auth.uid()
       AND p.status = 'draft'
       AND p.deleted_at IS NULL
  );
$$;

CREATE OR REPLACE FUNCTION public.week_is_own_draft(p_week_id uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT public.program_is_own_draft((SELECT program_id FROM public.weeks WHERE id = p_week_id));
$$;

CREATE OR REPLACE FUNCTION public.session_is_own_draft(p_session_id uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT public.week_is_own_draft((SELECT week_id FROM public.sessions WHERE id = p_session_id));
$$;

-- ── Student authoring RLS (additive; coach FOR ALL policies untouched) ────
DROP POLICY IF EXISTS "Students insert own draft programs" ON public.programs;
CREATE POLICY "Students insert own draft programs"
  ON public.programs FOR INSERT
  WITH CHECK (
    created_by = auth.uid()
    AND status = 'draft'
    AND is_active = false
    AND student_id IN (SELECT id FROM public.students WHERE profile_id = auth.uid())
  );

DROP POLICY IF EXISTS "Students update own draft programs" ON public.programs;
CREATE POLICY "Students update own draft programs"
  ON public.programs FOR UPDATE
  USING (created_by = auth.uid() AND status = 'draft' AND deleted_at IS NULL)
  WITH CHECK (created_by = auth.uid() AND status = 'draft' AND is_active = false);

DROP POLICY IF EXISTS "Students delete own draft programs" ON public.programs;
CREATE POLICY "Students delete own draft programs"
  ON public.programs FOR DELETE
  USING (created_by = auth.uid() AND status = 'draft');

DROP POLICY IF EXISTS "Students author own draft weeks" ON public.weeks;
CREATE POLICY "Students author own draft weeks"
  ON public.weeks FOR ALL
  USING (public.program_is_own_draft(program_id))
  WITH CHECK (public.program_is_own_draft(program_id));

DROP POLICY IF EXISTS "Students author own draft sessions" ON public.sessions;
CREATE POLICY "Students author own draft sessions"
  ON public.sessions FOR ALL
  USING (public.week_is_own_draft(week_id))
  WITH CHECK (public.week_is_own_draft(week_id));

DROP POLICY IF EXISTS "Students author own draft slots" ON public.exercise_slots;
CREATE POLICY "Students author own draft slots"
  ON public.exercise_slots FOR ALL
  USING (public.session_is_own_draft(session_id))
  WITH CHECK (
    public.session_is_own_draft(session_id)
    -- The chosen exercise must be one of the student's own coach's library
    -- entries (they have read access) — never a foreign/opaque exercise id.
    AND exercise_id IN (
      SELECT el.id FROM public.exercise_library el
      JOIN public.students st ON st.coach_id = el.coach_id
      WHERE st.profile_id = auth.uid()
    )
  );

-- ── Pin authoring columns (defense in depth, like profiles_pin_immutable) ──
-- created_by is immutable for everyone; the author (student) can never move
-- status — only the coach's UPDATE (auth.uid() <> created_by) may flip it.
CREATE OR REPLACE FUNCTION public.pin_program_authoring_columns()
RETURNS TRIGGER AS $$
BEGIN
  -- created_by is immutable for everyone (authorship audit).
  NEW.created_by := OLD.created_by;
  -- The author (the student, auth.uid() = created_by) can never self-approve:
  -- status and approved_at are pinned against them. submitted_at is left
  -- unpinned so the student can submit/un-submit. A coach (auth.uid() <>
  -- created_by, or created_by NULL on coach programs) is not restricted.
  IF auth.uid() IS NOT DISTINCT FROM OLD.created_by THEN
    NEW.status := OLD.status;
    NEW.approved_at := OLD.approved_at;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_pin_program_authoring_columns ON public.programs;
CREATE TRIGGER trg_pin_program_authoring_columns
  BEFORE UPDATE ON public.programs
  FOR EACH ROW EXECUTE FUNCTION public.pin_program_authoring_columns();

-- ── Coach approves a draft (SECURITY DEFINER; materializes set_logs) ──────
CREATE OR REPLACE FUNCTION public.approve_program(p_program_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_student_id   uuid;
  v_student_prof uuid;
  v_coach_id     uuid;
  v_prog_name    text;
  v_created      int := 0;
  v_functions_url text;
  v_service_key   text;
BEGIN
  SELECT p.student_id, p.name INTO v_student_id, v_prog_name
    FROM public.programs p WHERE p.id = p_program_id AND p.status = 'draft';
  -- Not a draft (already approved / gone) → idempotent no-op.
  IF v_student_id IS NULL THEN
    RETURN jsonb_build_object('approved', false);
  END IF;

  SELECT s.coach_id, s.profile_id INTO v_coach_id, v_student_prof
    FROM public.students s WHERE s.id = v_student_id;
  IF v_coach_id IS NULL OR v_coach_id <> auth.uid() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  -- Materialize one set_log per planned set from the slot scalars (uniform
  -- targets), for any slot that doesn't already have them.
  INSERT INTO public.set_logs
    (exercise_slot_id, set_number, done, target_reps, target_duration_seconds, target_weight_kg, target_rest_seconds)
  SELECT es.id, gs.n, false, es.reps, es.duration_seconds, es.weight_kg, es.rest_seconds
    FROM public.exercise_slots es
    JOIN public.sessions s ON s.id = es.session_id
    JOIN public.weeks w    ON w.id = s.week_id
    CROSS JOIN LATERAL generate_series(1, GREATEST(es.sets, 1)) AS gs(n)
   WHERE w.program_id = p_program_id
     AND NOT EXISTS (
       SELECT 1 FROM public.set_logs sl
        WHERE sl.exercise_slot_id = es.id AND sl.set_number = gs.n
     );
  GET DIAGNOSTICS v_created = ROW_COUNT;

  UPDATE public.programs
     SET status = 'approved', approved_at = now(), submitted_at = NULL
   WHERE id = p_program_id;

  IF v_student_prof IS NOT NULL THEN
    INSERT INTO public.notifications (recipient_id, kind, payload)
    VALUES (
      v_student_prof,
      'program_approved',
      jsonb_build_object('program_id', p_program_id, 'program_name', v_prog_name)
    );

    BEGIN
      SELECT decrypted_secret INTO v_functions_url FROM vault.decrypted_secrets WHERE name = 'app_functions_url';
      SELECT decrypted_secret INTO v_service_key   FROM vault.decrypted_secrets WHERE name = 'app_service_role_key';
      IF v_functions_url IS NOT NULL AND v_service_key IS NOT NULL
         AND v_functions_url <> '' AND v_service_key <> '' THEN
        PERFORM net.http_post(
          url := v_functions_url || '/send-push',
          headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_service_key),
          body := jsonb_build_object(
            'user_id', v_student_prof,
            'payload', jsonb_build_object(
              'title', 'Program approved',
              'body',  'Your coach approved your program' || COALESCE(': ' || v_prog_name, ''),
              'tag',   'program-approved-' || p_program_id::text,
              'data',  jsonb_build_object('url', '/sl_app/#/student')
            )
          )
        );
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'send-push fan-out (program approved) failed: %', SQLERRM;
    END;
  END IF;

  RETURN jsonb_build_object('approved', true, 'set_logs_created', v_created);
END;
$$;

REVOKE ALL ON FUNCTION public.approve_program(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.approve_program(uuid) TO authenticated;
