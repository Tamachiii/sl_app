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

// Next free sort_order in a week — max over ALL sessions, archived included,
// so the insert can never collide with UNIQUE(week_id, sort_order).
async function nextSessionSortOrder(weekId) {
  const { data, error } = await supabase
    .from('sessions')
    .select('sort_order')
    .eq('week_id', weekId)
    .order('sort_order', { ascending: false })
    .limit(1);
  if (error) throw error;
  return (data?.[0]?.sort_order ?? -1) + 1;
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
        // Carry the archived state so a coach's worklist cleanup isn't undone
        // — a copy of an archived session must not reappear as active.
        archived_at: sess.archived_at,
      }));
      const { data: newSessions, error: nsErr } = await supabase
        .from('sessions')
        .insert(sessionRows)
        .select('id, sort_order');
      if (nsErr) throw nsErr;
      if ((newSessions || []).length !== sessions.length) {
        throw new Error('Week duplication failed: session copy count mismatch');
      }
      // Map old→new by matching sort_order, NOT by RETURNING/array order.
      // The destination week is brand-new and UNIQUE(week_id, sort_order)
      // (2026_07_13) guarantees these values are distinct, so this is an
      // exact bijection independent of the order Postgres returns rows in —
      // sort_order pairing was only unsafe before, when ties could exist.
      const newSessBySort = new Map(newSessions.map((ns) => [ns.sort_order, ns.id]));

      const slotIdMap = {};
      for (let i = 0; i < sessions.length; i++) {
        const sess = sessions[i];
        const newSessId = newSessBySort.get(sess.sort_order);
        if (!newSessId) {
          throw new Error('Week duplication failed: session sort_order mapping gap');
        }
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
          // The coach's per-set video requests are part of the prescription —
          // dropping them here silently disabled recording on every
          // propagated week.
          record_video_set_numbers: sl.record_video_set_numbers,
        }));
        const { data: newSlots, error: slErr } = await supabase
          .from('exercise_slots')
          .insert(slotRows)
          .select('id');
        if (slErr) throw slErr;
        if ((newSlots || []).length !== sourceSlots.length) {
          throw new Error('Week duplication failed: slot copy count mismatch');
        }
        sourceSlots.forEach((src, j) => {
          slotIdMap[src.id] = newSlots[j].id;
        });
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

      const destWeekId = weekId || src.week_id;
      // Append at the end of the destination week — `src.sort_order + 1` is
      // usually already taken there, which UNIQUE(week_id, sort_order) now
      // rejects instead of letting two sessions share a position.
      const destSortOrder = sortOrder ?? (await nextSessionSortOrder(destWeekId));

      const { data: newSess, error: nsErr } = await supabase
        .from('sessions')
        .insert({
          week_id: destWeekId,
          day_number: src.day_number,
          title: src.title ? `${src.title} (copy)` : 'Session (copy)',
          sort_order: destSortOrder,
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
          record_video_set_numbers: sl.record_video_set_numbers,
        }));
        const { data: newSlots, error: slErr } = await supabase
          .from('exercise_slots')
          .insert(slotRows)
          .select('id');
        if (slErr) throw slErr;
        // Index-based mapping — see useDuplicateWeek for why sort_order
        // pairing is unsafe on legacy data.
        if ((newSlots || []).length !== sourceSlots.length) {
          throw new Error('Session duplication failed: slot copy count mismatch');
        }
        const slotIdMap = {};
        sourceSlots.forEach((s, j) => {
          slotIdMap[s.id] = newSlots[j].id;
        });
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
