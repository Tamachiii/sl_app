import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';
import { MUTATION_KEYS, MUTATION_FNS } from '../lib/offlineMutations';

/**
 * Fetch all slot_comments for a session's slots in a single round-trip.
 * Returns an array; callers typically index by exercise_slot_id.
 */
export function useSlotComments(sessionId, slots) {
  return useQuery({
    queryKey: ['slot-comments', sessionId],
    queryFn: async () => {
      const slotIds = (slots || []).map((s) => s.id);
      if (slotIds.length === 0) return [];
      const { data, error } = await supabase
        .from('slot_comments')
        .select('*')
        .in('exercise_slot_id', slotIds);
      if (error) throw error;
      return data || [];
    },
    enabled: !!sessionId && !!slots && slots.length > 0,
  });
}

/**
 * Upsert the student's comment on a slot. An empty body deletes the row so
 * the coach doesn't see an empty bubble.
 */
export function useSaveSlotComment() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const studentId = user?.id;

  const m = useMutation({
    mutationKey: MUTATION_KEYS.saveSlotComment,
    mutationFn: MUTATION_FNS.saveSlotComment,
    onSettled: (_data, _err, vars) => {
      qc.invalidateQueries({ queryKey: ['slot-comments', vars?.sessionId] });
    },
  });
  return {
    ...m,
    mutate: (vars, options) => m.mutate({ ...vars, studentId }, options),
    mutateAsync: (vars, options) => m.mutateAsync({ ...vars, studentId }, options),
  };
}
