import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';

// Copies the per-set targets from each source slot's set_logs into fresh
// rows on the destination slots. Actuals (done/rpe/weight_kg/logged_at) are
// intentionally NOT carried over — duplication produces a clean session.
async function copySetLogTargets(slotIdMap) {
  const sourceIds = Object.keys(slotIdMap);
  if (sourceIds.length === 0) return;
  const { data: srcLogs, error } = await supabase
    .from('set_logs')
    .select('exercise_slot_id, set_number, target_reps, target_duration_seconds, target_weight_kg, target_rest_seconds')
    .in('exercise_slot_id', sourceIds);
  if (error) throw error;
  const rows = (srcLogs || []).map((l) => ({
    exercise_slot_id: slotIdMap[l.exercise_slot_id],
    set_number: l.set_number,
    done: false,
    target_reps: l.target_reps,
    target_duration_seconds: l.target_duration_seconds,
    target_weight_kg: l.target_weight_kg,
    target_rest_seconds: l.target_rest_seconds,
  }));
  if (rows.length > 0) {
    const { error: insErr } = await supabase.from('set_logs').insert(rows);
    if (insErr) throw insErr;
  }
}

export function useDuplicateWeek() {
  const qc = useQueryClient();

  return useMutation({
    // `programId` is optional — when provided, the week is copied into a
    // different program (e.g. another student's). `newWeekNumber` is optional
    // too; when omitted we pick max(week_number)+1 in the destination program.
    mutationFn: async ({ weekId, newWeekNumber, programId }) => {
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

      const { data: sessions, error: sErr } = await supabase
        .from('sessions')
        .select('*, exercise_slots(*)')
        .eq('week_id', weekId)
        .order('sort_order');
      if (sErr) throw sErr;

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

      const newBySort = new Map(newSessions.map((ns) => [ns.sort_order, ns.id]));

      // Insert slots one source-session at a time so we can map old→new ids
      // by sort_order within the session, then copy set_log targets across.
      const slotIdMap = {};
      for (const sess of sessions) {
        const newSessId = newBySort.get(sess.sort_order);
        const sourceSlots = (sess.exercise_slots || []).slice().sort(
          (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)
        );
        if (sourceSlots.length === 0) continue;
        const slotRows = sourceSlots.map((sl) => ({
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
        }));
        const { data: newSlots, error: slErr } = await supabase
          .from('exercise_slots')
          .insert(slotRows)
          .select('id, sort_order');
        if (slErr) throw slErr;
        const newBySortOrder = new Map(newSlots.map((s) => [s.sort_order, s.id]));
        for (const src of sourceSlots) {
          const destId = newBySortOrder.get(src.sort_order);
          if (destId) slotIdMap[src.id] = destId;
        }
      }
      await copySetLogTargets(slotIdMap);

      return newWeek;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['program'] });
      qc.invalidateQueries({ queryKey: ['week'] });
      qc.invalidateQueries({ queryKey: ['set-logs'] });
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

      const sourceSlots = (src.exercise_slots || []).slice().sort(
        (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)
      );
      if (sourceSlots.length > 0) {
        const slotRows = sourceSlots.map((sl) => ({
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
        const { data: newSlots, error: slErr } = await supabase
          .from('exercise_slots')
          .insert(slotRows)
          .select('id, sort_order');
        if (slErr) throw slErr;
        const newBySortOrder = new Map(newSlots.map((s) => [s.sort_order, s.id]));
        const slotIdMap = {};
        for (const src of sourceSlots) {
          const destId = newBySortOrder.get(src.sort_order);
          if (destId) slotIdMap[src.id] = destId;
        }
        await copySetLogTargets(slotIdMap);
      }

      return newSess;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['week'] });
      qc.invalidateQueries({ queryKey: ['session'] });
      qc.invalidateQueries({ queryKey: ['set-logs'] });
      qc.invalidateQueries({ queryKey: ['program'] });
      qc.invalidateQueries({ queryKey: ['student-weeks'] });
    },
  });
}
