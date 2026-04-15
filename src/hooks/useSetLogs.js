import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';

export function useSetLogs(sessionId, slots) {
  const slotIds = (slots || []).map((s) => s.id).sort();
  return useQuery({
    queryKey: ['set-logs', sessionId, slotIds],
    queryFn: async () => {
      if (slotIds.length === 0) return [];

      const { data, error } = await supabase
        .from('set_logs')
        .select('*')
        .in('exercise_slot_id', slotIds)
        .order('set_number');
      if (error) throw error;
      return data;
    },
    enabled: !!sessionId && slotIds.length > 0,
  });
}

export function useEnsureSetLogs() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ sessionId, slots }) => {
      // For each slot, check if set_logs exist; if not, create them
      const slotIds = slots.map((s) => s.id);
      const { data: existing, error: existErr } = await supabase
        .from('set_logs')
        .select('exercise_slot_id, set_number')
        .in('exercise_slot_id', slotIds);
      if (existErr) throw existErr;

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
    onMutate: async ({ logId, done }) => {
      // Cancel any outgoing refetches so they don't overwrite optimistic update
      await qc.cancelQueries({ queryKey: ['set-logs'] });
      
      // We don't have the exact query key (which includes sessionId and slotIds),
      // so we iterate over all matching caches.
      const previousQueries = qc.getQueriesData({ queryKey: ['set-logs'] });
      
      qc.setQueriesData({ queryKey: ['set-logs'] }, (old) => {
        if (!old) return old;
        return old.map((log) => 
          log.id === logId ? { ...log, done, logged_at: done ? new Date().toISOString() : null } : log
        );
      });
      
      return { previousQueries };
    },
    onError: (err, newLog, context) => {
      context.previousQueries.forEach(([queryKey, oldData]) => {
        qc.setQueryData(queryKey, oldData);
      });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['set-logs'] });
    },
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
