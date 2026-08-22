-- ============================================================
-- Stage 4: moving a session BETWEEN phases (weeks) of a block.
--
-- Until now this was impossible. The editor's "copy to…" duplicated a session
-- into another week and left the original behind; nothing moved one. Once the
-- sheet renders a block as ONE list with phase dividers, dragging a session
-- across a divider is the obvious gesture — and it is two writes that must not
-- be separable: re-homing the row (`week_id`) and renumbering BOTH weeks.
--
-- Split across two client round trips, a failure between them strands the
-- session: re-homed but holding a position that collides in its new week, or
-- renumbered out of a week it no longer belongs to. One statement, one
-- transaction.
--
-- SECURITY INVOKER, deliberately: the `Coaches manage sessions` policy is FOR
-- ALL on `week_id IN (…the coach's weeks…)`, so this rides the caller's own
-- RLS and adds no trust surface. A definer would have to re-implement that
-- ownership walk, which is exactly the duplication the SECURITY DEFINER
-- helpers exist to avoid.
--
-- The caller passes the FULL ordered id list for each affected week AFTER the
-- move — the same contract as `useReorderSessions`, so the ordering logic
-- lives in one place (the client, which is holding the list).
-- ============================================================

CREATE OR REPLACE FUNCTION public.move_session(
  p_session_id   uuid,
  p_dest_week_id uuid,
  p_source_ids   uuid[],
  p_dest_ids     uuid[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_src_week uuid;
BEGIN
  SELECT week_id INTO v_src_week FROM public.sessions WHERE id = p_session_id;
  IF v_src_week IS NULL THEN
    RAISE EXCEPTION 'session_not_found';
  END IF;

  -- A block is the unit being reordered; moving a session into another
  -- athlete's program (or another block) is a COPY, not a drag.
  IF (SELECT program_id FROM public.weeks WHERE id = p_dest_week_id)
     IS DISTINCT FROM
     (SELECT program_id FROM public.weeks WHERE id = v_src_week) THEN
    RAISE EXCEPTION 'cross_program_move';
  END IF;

  -- Park every involved row at a value unique across BOTH weeks before any
  -- final position is written. A per-week offset is not enough here: the moved
  -- row changes week mid-statement, so a parked source position can land on a
  -- parked destination position that happens to share the same number.
  WITH involved AS (
    SELECT id, row_number() OVER (ORDER BY id) AS n
      FROM public.sessions
     WHERE id = ANY(p_source_ids) OR id = ANY(p_dest_ids) OR id = p_session_id
  )
  UPDATE public.sessions s
     SET sort_order = 100000 + i.n
    FROM involved i
   WHERE s.id = i.id;

  -- Re-home, then place both weeks at 0..n-1.
  UPDATE public.sessions SET week_id = p_dest_week_id WHERE id = p_session_id;

  UPDATE public.sessions s
     SET sort_order = t.idx - 1
    FROM unnest(p_source_ids) WITH ORDINALITY AS t(id, idx)
   WHERE s.id = t.id;

  UPDATE public.sessions s
     SET sort_order = t.idx - 1
    FROM unnest(p_dest_ids) WITH ORDINALITY AS t(id, idx)
   WHERE s.id = t.id;
END;
$$;
