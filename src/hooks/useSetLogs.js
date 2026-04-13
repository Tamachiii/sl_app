import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';

export function useSetLogs(sessionId, slots) {
  return useQuery({
    queryKey: ['set-logs', sessionId],
    queryFn: async () => {
      if (!slots || slots.length === 0) return [];

      const slotIds = slots.map((s) => s.id);
      const { data, error } = await supabase
        .from('set_logs')
        .select('*')
        .in('exercise_slot_id', slotIds)
        .order('set_number');
      if (error) throw error;
      return data;
    },
    enabled: !!sessionId && !!slots && slots.length > 0,
  });
}

export function useEnsureSetLogs() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ sessionId, slots }) => {
      // For each slot, check if set_logs exist; if not, create them
      const slotIds = slots.map((s) => s.id);
      const { data: existing } = await supabase
        .from('set_logs')
        .select('exercise_slot_id, set_number')
        .in('exercise_slot_id', slotIds);

      const existingSet = new Set(
        (existing || []).map((l) => `${l.exercise_slot_id}-${l.set_number}`)
      );

      const toInsert = [];
      for (const slot of slots) {
        for (let i = 1; i <= slot.sets; i++) {
          if (!existingSet.has(`${slot.id}-${i}`)) {
            toInsert.push({
              exercise_slot_id: slot.id,
              set_number: i,
              done: false,
            });
          }
        }
      }

      if (toInsert.length > 0) {
        const { error } = await supabase.from('set_logs').insert(toInsert);
        if (error) throw error;
      }
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['set-logs', vars.sessionId] });
    },
  });
}

export function useToggleSetDone() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ logId, done }) => {
      const { data, error } = await supabase
        .from('set_logs')
        .update({
          done,
          logged_at: done ? new Date().toISOString() : null,
        })
        .eq('id', logId)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['set-logs'] }),
  });
}

export function useSetRpe() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ logId, rpe }) => {
      const { data, error } = await supabase
        .from('set_logs')
        .update({ rpe })
        .eq('id', logId)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['set-logs'] }),
  });
}
