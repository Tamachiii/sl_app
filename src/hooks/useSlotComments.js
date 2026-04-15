import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';

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

  return useMutation({
    mutationFn: async ({ sessionId, slotId, body }) => {
      const trimmed = (body || '').trim();
      if (!trimmed) {
        const { error } = await supabase
          .from('slot_comments')
          .delete()
          .eq('exercise_slot_id', slotId);
        if (error) throw error;
        return { sessionId, slotId, deleted: true };
      }
      const { data, error } = await supabase
        .from('slot_comments')
        .upsert(
          {
            exercise_slot_id: slotId,
            student_id: user.id,
            body: trimmed,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'exercise_slot_id' }
        )
        .select()
        .single();
      if (error) throw error;
      return { sessionId, data };
    },
    onSuccess: ({ sessionId }) => {
      qc.invalidateQueries({ queryKey: ['slot-comments', sessionId] });
    },
  });
}
