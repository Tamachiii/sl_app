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
 * Rewrite week_number for an ordered list of weeks within the same program.
 * Two-pass update to dodge the UNIQUE(program_id, week_number) constraint:
 *   1. Park every week at a temp number (base + idx, far above normal range).
 *   2. Assign each its final week_number (idx + 1).
 * `orderedIds` is the desired order; index 0 becomes week 1.
 */
export function useReorderWeeks() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ programId, orderedIds }) => {
      const TMP_BASE = 100000;

      for (let i = 0; i < orderedIds.length; i++) {
        const { error } = await supabase
          .from('weeks')
          .update({ week_number: TMP_BASE + i })
          .eq('id', orderedIds[i]);
        if (error) throw error;
      }

      for (let i = 0; i < orderedIds.length; i++) {
        const { error } = await supabase
          .from('weeks')
          .update({ week_number: i + 1 })
          .eq('id', orderedIds[i]);
        if (error) throw error;
      }

      return { programId };
    },
    onMutate: async ({ programId, orderedIds }) => {
      await qc.cancelQueries({ queryKey: ['program'] });
      const snapshots = qc.getQueriesData({ queryKey: ['program'] });
      for (const [key, prog] of snapshots) {
        if (!prog || prog.id !== programId) continue;
        const byId = new Map((prog.weeks || []).map((w) => [w.id, w]));
        const reordered = orderedIds
          .map((id, idx) => {
            const w = byId.get(id);
            return w ? { ...w, week_number: idx + 1 } : null;
          })
          .filter(Boolean);
        qc.setQueryData(key, { ...prog, weeks: reordered });
      }
      return { snapshots };
    },
    onError: (_err, _vars, ctx) => {
      if (!ctx) return;
      for (const [key, data] of ctx.snapshots) {
        qc.setQueryData(key, data);
      }
    },
    onSettled: (_d, _e, { programId }) => {
      qc.invalidateQueries({ queryKey: ['program'] });
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
