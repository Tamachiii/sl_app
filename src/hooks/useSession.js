import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';

export function useSession(sessionId) {
  return useQuery({
    queryKey: ['session', sessionId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('sessions')
        .select(`
          *,
          exercise_slots(
            *,
            exercise:exercise_library(*)
          )
        `)
        .eq('id', sessionId)
        .single();
      if (error) throw error;
      data.exercise_slots = (data.exercise_slots || []).sort(
        (a, b) => a.sort_order - b.sort_order
      );
      return data;
    },
    enabled: !!sessionId,
  });
}

export function useAddSlot() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ sessionId, exerciseId, sets, reps, durationSeconds, weightKg, sortOrder, supersetGroup, restSeconds }) => {
      const { data, error } = await supabase
        .from('exercise_slots')
        .insert({
          session_id: sessionId,
          exercise_id: exerciseId,
          sets,
          reps: durationSeconds ? null : reps,
          duration_seconds: durationSeconds || null,
          weight_kg: weightKg || null,
          sort_order: sortOrder || 0,
          superset_group: supersetGroup || null,
          rest_seconds: restSeconds ?? null,
        })
        .select('*, exercise:exercise_library(*)')
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['session', vars.sessionId] });
      qc.invalidateQueries({ queryKey: ['week'] });
    },
  });
}

export function useUpdateSlot() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, sessionId, ...updates }) => {
      const { data, error } = await supabase
        .from('exercise_slots')
        .update(updates)
        .eq('id', id)
        .select('*, exercise:exercise_library(*)')
        .single();
      if (error) throw error;
      return { data, sessionId };
    },
    onSuccess: ({ sessionId }) => {
      qc.invalidateQueries({ queryKey: ['session', sessionId] });
      qc.invalidateQueries({ queryKey: ['week'] });
    },
  });
}

export function useDeleteSlot() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, sessionId }) => {
      const { error } = await supabase
        .from('exercise_slots')
        .delete()
        .eq('id', id);
      if (error) throw error;
      return { sessionId };
    },
    onSuccess: ({ sessionId }) => {
      if (sessionId) {
        qc.invalidateQueries({ queryKey: ['session', sessionId] });
      } else {
        qc.invalidateQueries({ queryKey: ['session'] });
      }
      qc.invalidateQueries({ queryKey: ['week'] });
    },
  });
}
