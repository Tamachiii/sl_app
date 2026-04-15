import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';

export function useDuplicateWeek() {
  const qc = useQueryClient();

  return useMutation({
    // `programId` is optional — when provided, the week is copied into a
    // different program (e.g. another student's). `newWeekNumber` is optional
    // too; when omitted we pick max(week_number)+1 in the destination program.
    mutationFn: async ({ weekId, newWeekNumber, programId }) => {
      // Fetch the source week with sessions and slots
      const { data: srcWeek, error: wErr } = await supabase
        .from('weeks')
        .select('*')
        .eq('id', weekId)
        .single();
      if (wErr) throw wErr;

      const destProgramId = programId || srcWeek.program_id;

      let destWeekNumber = newWeekNumber;
      if (destWeekNumber == null) {
        const { data: existing, error: eErr } = await supabase
          .from('weeks')
          .select('week_number')
          .eq('program_id', destProgramId)
          .order('week_number', { ascending: false })
          .limit(1);
        if (eErr) throw eErr;
        destWeekNumber = (existing?.[0]?.week_number ?? 0) + 1;
      }

      // Create the new week
      const { data: newWeek, error: nwErr } = await supabase
        .from('weeks')
        .insert({
          program_id: destProgramId,
          week_number: destWeekNumber,
          label: srcWeek.label ? `${srcWeek.label} (copy)` : null,
        })
        .select()
        .single();
      if (nwErr) throw nwErr;

      // Fetch sessions for source week
      const { data: sessions, error: sErr } = await supabase
        .from('sessions')
        .select('*, exercise_slots(*)')
        .eq('week_id', weekId)
        .order('sort_order');
      if (sErr) throw sErr;

      // Batch-insert all sessions at once
      if (sessions.length === 0) return newWeek;

      const sessionRows = sessions.map((sess) => ({
        week_id: newWeek.id,
        day_number: sess.day_number,
        title: sess.title,
        sort_order: sess.sort_order,
      }));
      const { data: newSessions, error: nsErr } = await supabase
        .from('sessions')
        .insert(sessionRows)
        .select();
      if (nsErr) throw nsErr;

      // Map old session IDs to new session IDs via sort_order
      const newBySort = new Map(newSessions.map((ns) => [ns.sort_order, ns.id]));

      // Batch-insert all slots across all sessions
      const allSlots = [];
      for (const sess of sessions) {
        const newSessId = newBySort.get(sess.sort_order);
        for (const sl of sess.exercise_slots || []) {
          allSlots.push({
            session_id: newSessId,
            exercise_id: sl.exercise_id,
            sets: sl.sets,
            reps: sl.reps,
            weight_kg: sl.weight_kg,
            sort_order: sl.sort_order,
            notes: sl.notes,
            duration_seconds: sl.duration_seconds,
            superset_group: sl.superset_group,
            rest_seconds: sl.rest_seconds,
          });
        }
      }
      if (allSlots.length > 0) {
        const { error: slErr } = await supabase
          .from('exercise_slots')
          .insert(allSlots);
        if (slErr) throw slErr;
      }

      return newWeek;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['program'] });
      qc.invalidateQueries({ queryKey: ['week'] });
      qc.invalidateQueries({ queryKey: ['student-weeks'] });
    },
  });
}

export function useDuplicateSession() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ sessionId, weekId, sortOrder }) => {
      const { data: src, error: sErr } = await supabase
        .from('sessions')
        .select('*, exercise_slots(*)')
        .eq('id', sessionId)
        .single();
      if (sErr) throw sErr;

      const { data: newSess, error: nsErr } = await supabase
        .from('sessions')
        .insert({
          week_id: weekId || src.week_id,
          day_number: src.day_number,
          title: src.title ? `${src.title} (copy)` : 'Session (copy)',
          sort_order: sortOrder ?? src.sort_order + 1,
        })
        .select()
        .single();
      if (nsErr) throw nsErr;

      const slots = (src.exercise_slots || []).map((sl) => ({
        session_id: newSess.id,
        exercise_id: sl.exercise_id,
        sets: sl.sets,
        reps: sl.reps,
        weight_kg: sl.weight_kg,
        sort_order: sl.sort_order,
        notes: sl.notes,
        duration_seconds: sl.duration_seconds,
        superset_group: sl.superset_group,
        rest_seconds: sl.rest_seconds,
      }));

      if (slots.length > 0) {
        const { error: slErr } = await supabase
          .from('exercise_slots')
          .insert(slots);
        if (slErr) throw slErr;
      }

      return newSess;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['week'] });
      qc.invalidateQueries({ queryKey: ['session'] });
      qc.invalidateQueries({ queryKey: ['program'] });
      qc.invalidateQueries({ queryKey: ['student-weeks'] });
    },
  });
}
