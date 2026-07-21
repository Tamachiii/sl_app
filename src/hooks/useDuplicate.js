import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { invalidateCoachDashboard } from './useProgram';

// Copies the per-set targets from each source slot's set_logs into fresh
// rows on the destination slots. Actuals (done/rpe/weight_kg/logged_at) are
// intentionally NOT carried over — duplication produces a clean session.
// Student-added extra sets (is_student_added) are a structural deviation, not
// part of the coach's prescription (their target_* are all NULL) — excluding
// them keeps the copy a clean prescription instead of baking a phantom
// empty set into every duplicated slot. Skipped prescribed sets DO carry
// targets and are correctly restored (reset to done:false by the map below).
async function copySetLogTargets(slotIdMap) {
  const sourceIds = Object.keys(slotIdMap);
  if (sourceIds.length === 0) return;
  const { data: srcLogs, error } = await supabase
    .from('set_logs')
    .select('exercise_slot_id, set_number, target_reps, target_duration_seconds, target_weight_kg, target_rest_seconds')
    .eq('is_student_added', false)
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

/**
 * Copy `sourceSlots` (pre-sorted by sort_order) onto `destSessionId` and return
 * the old→new slot id map. Owns the field list for a slot copy so week and
 * session duplication can't drift apart on it — a divergence here previously
 * dropped `record_video_set_numbers` and silently disabled the coach's per-set
 * video requests on every propagated week.
 *
 * Deliberately does NOT touch set_logs: week duplication batches ONE
 * copySetLogTargets call for the whole week, so that stays the caller's job.
 * `errorContext` prefixes the count-mismatch error so the failing operation is
 * still identifiable.
 */
async function copySlotsInto(destSessionId, sourceSlots, errorContext) {
  if (sourceSlots.length === 0) return {};
  const slotRows = sourceSlots.map((sl) => ({
    session_id: destSessionId,
    exercise_id: sl.exercise_id,
    sets: sl.sets,
    reps: sl.reps,
    weight_kg: sl.weight_kg,
    sort_order: sl.sort_order,
    notes: sl.notes,
    duration_seconds: sl.duration_seconds,
    superset_group: sl.superset_group,
    rest_seconds: sl.rest_seconds,
    // Part of the prescription, not a rendering detail — see above.
    record_video_set_numbers: sl.record_video_set_numbers,
  }));
  const { data: newSlots, error } = await supabase
    .from('exercise_slots')
    .insert(slotRows)
    .select('id');
  if (error) throw error;
  // Index-based pairing, not sort_order: legacy rows can carry ties.
  if ((newSlots || []).length !== sourceSlots.length) {
    throw new Error(`${errorContext}: slot copy count mismatch`);
  }
  const slotIdMap = {};
  sourceSlots.forEach((src, j) => {
    slotIdMap[src.id] = newSlots[j].id;
  });
  return slotIdMap;
}

// Copy a source week's sessions → slots → set_log TARGETS into an already-
// created destination week. Actuals (done/rpe/weight_kg/logged_at) and per-
// session scheduling (scheduled_date/reviewed_at) are intentionally NOT
// carried — a duplicate is a clean prescription. archived_at IS preserved so
// a coach's worklist cleanup survives the copy. Shared by useDuplicateWeek
// and useDuplicateProgram so both walk one audited copy path.
async function copyWeekTree(srcWeekId, destWeekId) {
  const { data: sessions, error: sErr } = await supabase
    .from('sessions')
    .select('*, exercise_slots(*)')
    .eq('week_id', srcWeekId)
    .order('sort_order');
  if (sErr) throw sErr;

  if ((sessions || []).length === 0) return;

  const sessionRows = sessions.map((sess) => ({
    week_id: destWeekId,
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
  // Map old→new by matching sort_order, NOT by RETURNING/array order. The
  // destination week is brand-new and UNIQUE(week_id, sort_order) (2026_07_13)
  // guarantees these values are distinct, so this is an exact bijection
  // independent of the order Postgres returns rows in — sort_order pairing was
  // only unsafe before, when ties could exist.
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
    Object.assign(slotIdMap, await copySlotsInto(newSessId, sourceSlots, 'Week duplication failed'));
  }
  await copySetLogTargets(slotIdMap);
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

      await copyWeekTree(weekId, newWeek.id);

      return newWeek;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['program'] });
      qc.invalidateQueries({ queryKey: ['week'] });
      qc.invalidateQueries({ queryKey: ['set-logs'] });
      invalidateCoachDashboard(qc);
    },
  });
}

/**
 * Duplicate an ENTIRE program for the same student — every week, session,
 * slot, and per-set target — to seed the next block from a finished one.
 *
 * The copy is ALWAYS created inactive (like a restored program), so it can
 * never bump the student's current active block off the one-active-per-student
 * slot; the coach activates it explicitly when ready. Week numbers and labels
 * are preserved verbatim (unlike single-week duplication, which suffixes
 * "(copy)" and appends). Student actuals are never carried — see copyWeekTree.
 */
export function useDuplicateProgram() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ programId }) => {
      const { data: srcProgram, error: pErr } = await supabase
        .from('programs')
        .select('id, student_id, name, weeks(id, week_number, label)')
        .eq('id', programId)
        .single();
      if (pErr) throw pErr;

      // Next sort_order among the student's live programs (trashed rows keep
      // their sort_order but never collide — sort_order has no unique index).
      const { data: existing, error: listErr } = await supabase
        .from('programs')
        .select('sort_order')
        .eq('student_id', srcProgram.student_id)
        .is('deleted_at', null)
        .order('sort_order', { ascending: false })
        .limit(1);
      if (listErr) throw listErr;
      const nextSort = (existing?.[0]?.sort_order ?? -1) + 1;

      const { data: newProgram, error: npErr } = await supabase
        .from('programs')
        .insert({
          student_id: srcProgram.student_id,
          name: `${srcProgram.name} (copy)`,
          sort_order: nextSort,
          is_active: false,
        })
        .select()
        .single();
      if (npErr) throw npErr;

      // No client transaction in supabase-js, so the week/session/slot/target
      // inserts below aren't atomic. If one fails partway, best-effort delete
      // the half-copied program so a failure never strands an orphan block in
      // the coach's switcher. The copy has no logged sets, so the
      // block_*_delete_with_logged_sets trigger permits the cleanup; if the
      // cleanup itself fails we still surface the original copy error.
      try {
        const weeks = (srcProgram.weeks || [])
          .slice()
          .sort((a, b) => a.week_number - b.week_number);
        for (const w of weeks) {
          const { data: newWeek, error: wErr } = await supabase
            .from('weeks')
            .insert({
              program_id: newProgram.id,
              week_number: w.week_number,
              label: w.label,
            })
            .select('id')
            .single();
          if (wErr) throw wErr;
          await copyWeekTree(w.id, newWeek.id);
        }
      } catch (copyErr) {
        try {
          await supabase.from('programs').delete().eq('id', newProgram.id);
        } catch {
          // swallow — surfacing the original copy failure matters more
        }
        throw copyErr;
      }

      return newProgram;
    },
    onSuccess: (newProgram, vars) => {
      const studentId = vars.studentId ?? newProgram?.student_id;
      // Seed the list cache synchronously so the parent's onSelect(newProgram.id)
      // sees the copy before the refetch lands (mirrors useCreateProgram —
      // otherwise CoachHome's stale-?program cleanup strips it). Real week
      // count arrives with the invalidation refetch.
      if (studentId && newProgram?.id) {
        qc.setQueryData(['programs', studentId], (old) =>
          Array.isArray(old) ? [...old, { ...newProgram, weeks: [] }] : old
        );
      }
      qc.invalidateQueries({ queryKey: ['programs', studentId] });
      qc.invalidateQueries({ queryKey: ['program'] });
      qc.invalidateQueries({ queryKey: ['week'] });
      qc.invalidateQueries({ queryKey: ['set-logs'] });
      invalidateCoachDashboard(qc);
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
      const slotIdMap = await copySlotsInto(
        newSess.id,
        sourceSlots,
        'Session duplication failed',
      );
      await copySetLogTargets(slotIdMap);

      return newSess;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['week'] });
      qc.invalidateQueries({ queryKey: ['session'] });
      qc.invalidateQueries({ queryKey: ['set-logs'] });
      qc.invalidateQueries({ queryKey: ['program'] });
      invalidateCoachDashboard(qc);
    },
  });
}
