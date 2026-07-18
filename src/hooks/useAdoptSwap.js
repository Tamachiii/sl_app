import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';

/**
 * Coach adopts a student's exercise SWAP into the standing prescription: every
 * UPCOMING occurrence of the original exercise in the same program flips to the
 * substitute (forward-only — the reviewed session keeps its honest history).
 *
 * Backed by the adopt_swap SECURITY DEFINER RPC (coach-only self-auth, atomic
 * multi-slot rewrite). ONLINE-ONLY: an atomic server-side rewrite can't be
 * queued offline, and the coach adopts at their desk. The substitute id the
 * coach SAW is passed explicitly, so a concurrent student-undo can't blank it.
 */
export function useAdoptSwap() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ slotId, substituteId }) => {
      const { data, error } = await supabase.rpc('adopt_swap', {
        p_slot_id: slotId,
        p_substitute_id: substituteId,
        p_dry_run: false,
      });
      if (error) throw error;
      return data; // { applied, dry_run: false }
    },
    onSuccess: (_data, { sessionId }) => {
      // The rewrite flips exercise_id on UPCOMING slots — which live in OTHER
      // ['session', X] caches, not the reviewed one — so invalidate the whole
      // 'session' subtree, plus the student-facing views and swap-aware stats.
      qc.invalidateQueries({ queryKey: ['session'] });
      if (sessionId) {
        qc.invalidateQueries({ queryKey: ['slot-deviations', sessionId] });
      }
      qc.invalidateQueries({ queryKey: ['week'] });
      qc.invalidateQueries({ queryKey: ['program'] });
      qc.invalidateQueries({ queryKey: ['student-program-details'] });
      qc.invalidateQueries({ queryKey: ['student-progress-stats'] });
    },
  });
}

/**
 * Blast-radius preview for the confirm dialog: how many upcoming slots the
 * adopt would rewrite, via the same RPC in dry-run mode (no writes).
 */
export function useAdoptSwapPreview(slotId, substituteId, enabled) {
  return useQuery({
    queryKey: ['adopt-swap-preview', slotId, substituteId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('adopt_swap', {
        p_slot_id: slotId,
        p_substitute_id: substituteId,
        p_dry_run: true,
      });
      if (error) throw error;
      return data?.applied ?? 0;
    },
    enabled: !!enabled && !!slotId && !!substituteId,
    staleTime: 0,
  });
}

/**
 * Coach adopts a student's SKIP: the exercise is dropped from every UPCOMING
 * occurrence in the program (forward-only DELETE via the adopt_skip RPC). Same
 * online-only, coach-only, atomic shape as useAdoptSwap.
 */
export function useAdoptSkip() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ slotId }) => {
      const { data, error } = await supabase.rpc('adopt_skip', {
        p_slot_id: slotId,
        p_dry_run: false,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (_data, { sessionId }) => {
      qc.invalidateQueries({ queryKey: ['session'] });
      if (sessionId) {
        qc.invalidateQueries({ queryKey: ['slot-deviations', sessionId] });
      }
      qc.invalidateQueries({ queryKey: ['week'] });
      qc.invalidateQueries({ queryKey: ['program'] });
      qc.invalidateQueries({ queryKey: ['student-program-details'] });
      qc.invalidateQueries({ queryKey: ['student-progress-stats'] });
    },
  });
}

/** Blast-radius preview for the skip-adopt (how many upcoming slots get dropped). */
export function useAdoptSkipPreview(slotId, enabled) {
  return useQuery({
    queryKey: ['adopt-skip-preview', slotId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('adopt_skip', {
        p_slot_id: slotId,
        p_dry_run: true,
      });
      if (error) throw error;
      return data?.applied ?? 0;
    },
    enabled: !!enabled && !!slotId,
    staleTime: 0,
  });
}

/**
 * Coach DECLINES a student's "make this permanent" request (Phase 3.3): clears
 * slot_deviations.promote_requested_at and notifies the student, via the
 * decline_promote_request coach-only RPC. The deviation itself stays (the
 * student still did Y this session); only the standing plan is left unchanged.
 */
export function useDeclinePromote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ slotId }) => {
      const { data, error } = await supabase.rpc('decline_promote_request', { p_slot_id: slotId });
      if (error) throw error;
      return data;
    },
    onSuccess: (_data, { sessionId }) => {
      if (sessionId) qc.invalidateQueries({ queryKey: ['slot-deviations', sessionId] });
    },
  });
}
