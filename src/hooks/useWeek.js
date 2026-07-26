import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { invalidateCoachDashboard } from './useProgram';

export function useWeek(weekId) {
  return useQuery({
    queryKey: ['week', weekId],
    queryFn: async () => {
      // One nested read, not a week fetch followed by a dependent session
      // fetch. Both levels are sorted here rather than via `order` on the
      // embed, so the ordering doesn't depend on PostgREST's referenced-table
      // ordering behaviour.
      const { data: week, error } = await supabase
        .from('weeks')
        .select(`
          *,
          sessions(
            *,
            exercise_slots(
              *,
              exercise:exercise_library(*)
            )
          )
        `)
        .eq('id', weekId)
        .single();
      if (error) throw error;

      const sessions = (week.sessions || [])
        .slice()
        .sort((a, b) => a.sort_order - b.sort_order);
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

/**
 * Just the owning program id for a week. Deliberately separate from `useWeek`
 * (which pulls the whole session + slot tree) so surfaces that only need to
 * answer "which program is this week in?" — e.g. CopyDialog's same-athlete
 * mode — don't pay for the heavy read.
 */
export function useProgramIdForWeek(weekId) {
  return useQuery({
    queryKey: ['week-program-id', weekId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('weeks')
        .select('program_id')
        .eq('id', weekId)
        .single();
      if (error) throw error;
      return data.program_id;
    },
    enabled: !!weekId,
  });
}

export function useCreateWeek() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ programId, weekNumber, label }) => {
      const { data, error } = await supabase
        .from('weeks')
        .insert({ program_id: programId, week_number: weekNumber, label })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['program'] });
      qc.invalidateQueries({ queryKey: ['programs'] });
      qc.invalidateQueries({ queryKey: ['active-program'] });
      // The student's Home/Sessions views read the program tree too.
      qc.invalidateQueries({ queryKey: ['student-program-details'] });
      invalidateCoachDashboard(qc);
    },
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
      invalidateCoachDashboard(qc);
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
      // A week edit can move week_number, which the roster strip renders.
      invalidateCoachDashboard(qc);
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
      invalidateCoachDashboard(qc);
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

      // The two passes must stay ordered relative to each other (that is what
      // dodges the UNIQUE), but the writes WITHIN a pass are independent —
      // every row gets a distinct number — so they go out together instead of
      // costing one round trip each.
      async function writeAll(numberFor) {
        const results = await Promise.all(
          orderedIds.map((id, i) =>
            supabase.from('weeks').update({ week_number: numberFor(i) }).eq('id', id),
          ),
        );
        for (const { error } of results) if (error) throw error;
      }

      await writeAll((i) => TMP_BASE + i);
      await writeAll((i) => i + 1);

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
      // Reordering rewrites week_number, which the Athletes roster renders
      // ("W3 · Program") — without this it keeps the pre-reorder numbers.
      invalidateCoachDashboard(qc);
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
      // The Program Sheet renders session titles and day pills straight from
      // ['program'] — without this a rename or a day move writes through to the
      // DB but the sheet keeps showing the old value until it refetches.
      qc.invalidateQueries({ queryKey: ['program'] });
      // Title/day_number ride along in the coach's Confirmed-feed payload and
      // in the dashboard strip, so both go stale on a rename or a day move.
      qc.invalidateQueries({ queryKey: ['all-confirmations'] });
      invalidateCoachDashboard(qc);
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
      // Archiving moves the session between the sheet's active list and its
      // "N archived" drawer, both of which read ['program'].
      qc.invalidateQueries({ queryKey: ['program'] });
      // Archiving hides the session from the coach's Confirmed feed.
      qc.invalidateQueries({ queryKey: ['all-confirmations'] });
      invalidateCoachDashboard(qc);
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
      // The deleted row must leave the Program Sheet's week list too.
      qc.invalidateQueries({ queryKey: ['program'] });
      qc.invalidateQueries({ queryKey: ['all-confirmations'] });
      invalidateCoachDashboard(qc);
    },
  });
}
