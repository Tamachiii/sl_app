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
      return { data, weekId };
    },
    onSuccess: ({ weekId }) => {
      qc.invalidateQueries({ queryKey: ['week', weekId] });
      qc.invalidateQueries({ queryKey: ['program'] });
    },
  });
}

export function useUpdateWeek() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, ...updates }) => {
      const { data, error } = await supabase
        .from('weeks')
        .update(updates)
        .eq('id', id)
        .select()
        .single();
      if (error) throw error;
      return { data, id };
    },
    onSuccess: ({ id }) => {
      qc.invalidateQueries({ queryKey: ['week', id] });
      qc.invalidateQueries({ queryKey: ['program'] });
    },
  });
}

export function useDeleteWeek() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (weekId) => {
      const { error } = await supabase.from('weeks').delete().eq('id', weekId);
      if (error) throw error;
      return weekId;
    },
    onSuccess: (weekId) => {
      qc.invalidateQueries({ queryKey: ['program'] });
      qc.invalidateQueries({ queryKey: ['week', weekId] });
    },
  });
}

/**
 * Swap two weeks' `week_number` within the same program.
 * Three-step update to dodge the UNIQUE(program_id, week_number) constraint:
 *   1. Park A at a temp number.
 *   2. Move B into A's old slot.
 *   3. Move A into B's old slot.
 */
export function useMoveWeek() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ aId, aNumber, bId, bNumber }) => {
      const tmp = Math.max(aNumber, bNumber) + 10000;

      const s1 = await supabase.from('weeks').update({ week_number: tmp }).eq('id', aId);
      if (s1.error) throw s1.error;

      const s2 = await supabase.from('weeks').update({ week_number: aNumber }).eq('id', bId);
      if (s2.error) throw s2.error;

      const s3 = await supabase.from('weeks').update({ week_number: bNumber }).eq('id', aId);
      if (s3.error) throw s3.error;
      
      return { aId, bId };
    },
    onSuccess: ({ aId, bId }) => {
      qc.invalidateQueries({ queryKey: ['program'] });
      qc.invalidateQueries({ queryKey: ['week', aId] });
      qc.invalidateQueries({ queryKey: ['week', bId] });
    },
  });
}

export function useUpdateSession() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, ...updates }) => {
      const { data, error } = await supabase
        .from('sessions')
        .update(updates)
        .eq('id', id)
        .select()
        .single();
      if (error) throw error;
      return { data, id, weekId: data.week_id };
    },
    onSuccess: ({ id, weekId }) => {
      qc.invalidateQueries({ queryKey: ['week', weekId] });
      qc.invalidateQueries({ queryKey: ['session', id] });
    },
  });
}

/**
 * Archive or unarchive a session. Archived sessions are hidden from the
 * coach's default week view and from the Confirmed-sessions list so the
 * coach can keep the active worklist clean after reviewing.
 */
export function useArchiveSession() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ sessionId, archived }) => {
      const { data, error } = await supabase
        .from('sessions')
        .update({ archived_at: archived ? new Date().toISOString() : null })
        .eq('id', sessionId)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['week', data.week_id] });
      qc.invalidateQueries({ queryKey: ['session', data.id] });
      qc.invalidateQueries({ queryKey: ['student-confirmations'] });
    },
  });
}

export function useDeleteSession() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (sessionId) => {
      // Need week_id to invalidate properly
      const { data } = await supabase.from('sessions').select('week_id').eq('id', sessionId).single();
      const weekId = data?.week_id;
      
      const { error } = await supabase
        .from('sessions')
        .delete()
        .eq('id', sessionId);
      if (error) throw error;
      return weekId;
    },
    onSuccess: (weekId) => {
      if (weekId) qc.invalidateQueries({ queryKey: ['week', weekId] });
      else qc.invalidateQueries({ queryKey: ['week'] });
    },
  });
}
