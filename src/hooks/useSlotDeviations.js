import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';
import { MUTATION_KEYS, MUTATION_FNS } from '../lib/offlineMutations';

/**
 * Fetch all slot_deviations (exercise swaps / skips) for a session's slots in
 * one round-trip. Returns an array; callers index by exercise_slot_id.
 */
export function useSlotDeviations(sessionId, slots) {
  return useQuery({
    queryKey: ['slot-deviations', sessionId],
    queryFn: async () => {
      const slotIds = (slots || []).map((s) => s.id);
      if (slotIds.length === 0) return [];
      const { data, error } = await supabase
        .from('slot_deviations')
        .select('*')
        .in('exercise_slot_id', slotIds);
      if (error) throw error;
      return data || [];
    },
    enabled: !!sessionId && !!slots && slots.length > 0,
  });
}

/**
 * Upsert (or clear, when `kind` is falsy) the student's swap/skip deviation on
 * a slot. Offline-safe: an UPSERT/DELETE keyed on exercise_slot_id, optimistic
 * into the ['slot-deviations', sessionId] cache so it shows immediately even
 * while the write is parked offline, with rollback on error.
 */
export function useSaveSlotDeviation() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const studentId = user?.id;

  const m = useMutation({
    mutationKey: MUTATION_KEYS.saveSlotDeviation,
    mutationFn: MUTATION_FNS.saveSlotDeviation,
    onMutate: async ({ sessionId, slotId, studentId: sid, kind, substituteExerciseId, note }) => {
      const key = ['slot-deviations', sessionId];
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData(key);
      qc.setQueryData(key, (old) => {
        const rows = (old || []).filter((d) => d.exercise_slot_id !== slotId);
        if (!kind) return rows;
        return [
          ...rows,
          {
            exercise_slot_id: slotId,
            student_id: sid,
            kind,
            substitute_exercise_id: kind === 'swap' ? (substituteExerciseId ?? null) : null,
            note: note ?? null,
          },
        ];
      });
      return { previous, sessionId };
    },
    onError: (_err, _vars, context) => {
      if (context?.sessionId) {
        qc.setQueryData(['slot-deviations', context.sessionId], context.previous);
      }
    },
    onSettled: (_data, _err, vars) => {
      qc.invalidateQueries({ queryKey: ['slot-deviations', vars?.sessionId] });
    },
  });

  return {
    ...m,
    mutate: (vars, options) => m.mutate({ ...vars, studentId }, options),
    mutateAsync: (vars, options) => m.mutateAsync({ ...vars, studentId }, options),
  };
}
