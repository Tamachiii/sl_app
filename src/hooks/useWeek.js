import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';

export function useWeek(weekId) {
  return useQuery({
    queryKey: ['week', weekId],
    queryFn: async () => {
      const { data: week, error: wErr } = await supabase
        .from('weeks')
        .select('*')
        .eq('id', weekId)
        .single();
      if (wErr) throw wErr;

      const { data: sessions, error: sErr } = await supabase
        .from('sessions')
        .select(`
          *,
          exercise_slots(
            *,
            exercise:exercise_library(*)
          )
        `)
        .eq('week_id', weekId)
        .order('sort_order');
      if (sErr) throw sErr;

      // Sort exercise_slots within each session
      for (const sess of sessions) {
        sess.exercise_slots = (sess.exercise_slots || []).sort(
          (a, b) => a.sort_order - b.sort_order
        );
      }

      return { ...week, sessions };
    },
    enabled: !!weekId,
  });
}

export function useCreateSession() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ weekId, title, dayNumber, sortOrder }) => {
      const { data, error } = await supabase
        .from('sessions')
        .insert({
          week_id: weekId,
          title: title || 'New Session',
          day_number: dayNumber || 1,
          sort_order: sortOrder || 0,
        })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['week'] }),
  });
}

export function useDeleteSession() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (sessionId) => {
      const { error } = await supabase
        .from('sessions')
        .delete()
        .eq('id', sessionId);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['week'] }),
  });
}
