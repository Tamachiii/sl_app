import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';

export function useDuplicateWeek() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ weekId, newWeekNumber }) => {
      // Fetch the source week with sessions and slots
      const { data: srcWeek, error: wErr } = await supabase
        .from('weeks')
        .select('*')
        .eq('id', weekId)
        .single();
      if (wErr) throw wErr;

      // Create the new week
      const { data: newWeek, error: nwErr } = await supabase
        .from('weeks')
        .insert({
          program_id: srcWeek.program_id,
          week_number: newWeekNumber,
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

      // Duplicate each session and its slots
      for (const sess of sessions) {
        const { data: newSess, error: nsErr } = await supabase
          .from('sessions')
          .insert({
            week_id: newWeek.id,
            day_number: sess.day_number,
            title: sess.title,
            sort_order: sess.sort_order,
          })
          .select()
          .single();
        if (nsErr) throw nsErr;

        const slots = (sess.exercise_slots || []).map((sl) => ({
          session_id: newSess.id,
          exercise_id: sl.exercise_id,
          sets: sl.sets,
          reps: sl.reps,
          weight_kg: sl.weight_kg,
          sort_order: sl.sort_order,
          notes: sl.notes,
        }));

        if (slots.length > 0) {
          const { error: slErr } = await supabase
            .from('exercise_slots')
            .insert(slots);
          if (slErr) throw slErr;
        }
      }

      return newWeek;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['program'] });
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
    },
  });
}
