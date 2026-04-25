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
            exercise:exercise_library(*),
            set_logs(id, set_number, done, rpe, weight_kg, target_reps, target_duration_seconds, target_weight_kg, target_rest_seconds)
          )
        `)
        .eq('id', sessionId)
        .single();
      if (error) throw error;
      data.exercise_slots = (data.exercise_slots || [])
        .map((sl) => ({
          ...sl,
          set_logs: (sl.set_logs || []).slice().sort(
            (a, b) => a.set_number - b.set_number
          ),
        }))
        .sort((a, b) => a.sort_order - b.sort_order);
      return data;
    },
    enabled: !!sessionId,
  });
}

// Slot-level fields the coach sets directly via useUpdateSlot. Anything outside
// this list (reps, weight_kg, duration_seconds, rest_seconds) is a *target* —
// it's now per-set and lives on set_logs, so updating it fan-writes through
// fanOutTargetUpdate below.
const SLOT_DIRECT_FIELDS = new Set([
  'sets',
  'sort_order',
  'superset_group',
  'notes',
  'record_video_set_numbers',
]);

const TARGET_FIELDS = {
  reps: 'target_reps',
  duration_seconds: 'target_duration_seconds',
  weight_kg: 'target_weight_kg',
  rest_seconds: 'target_rest_seconds',
};

export function useAddSlot() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ sessionId, exerciseId, sets, reps, durationSeconds, weightKg, sortOrder, supersetGroup, restSeconds }) => {
      // Mirror the slot-level scalars (reps/weight/rest) so the deprecated
      // exercise_slots columns stay consistent during the transition.
      const repsValue = durationSeconds ? null : reps;
      const durValue = durationSeconds || null;
      const weightValue = weightKg || null;
      const restValue = restSeconds ?? null;
      const { data: slot, error } = await supabase
        .from('exercise_slots')
        .insert({
          session_id: sessionId,
          exercise_id: exerciseId,
          sets,
          reps: repsValue,
          duration_seconds: durValue,
          weight_kg: weightValue,
          sort_order: sortOrder || 0,
          superset_group: supersetGroup || null,
          rest_seconds: restValue,
        })
        .select('*, exercise:exercise_library(*)')
        .single();
      if (error) throw error;

      // Materialize one set_log per planned set, all sharing the slot's
      // uniform targets. Future per-set edits write straight to these rows.
      const logs = Array.from({ length: sets }, (_, i) => ({
        exercise_slot_id: slot.id,
        set_number: i + 1,
        done: false,
        target_reps: repsValue,
        target_duration_seconds: durValue,
        target_weight_kg: weightValue,
        target_rest_seconds: restValue,
      }));
      if (logs.length > 0) {
        const { error: logErr } = await supabase.from('set_logs').insert(logs);
        if (logErr) throw logErr;
      }
      return slot;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['session', vars.sessionId] });
      qc.invalidateQueries({ queryKey: ['set-logs'] });
      qc.invalidateQueries({ queryKey: ['week'] });
    },
  });
}

// Fan a uniform target change (reps/weight/rest/duration) out to every
// set_log row for the slot. Used by useUpdateSlot below and by the coach UI
// when in uniform mode. Returns the touched columns for caller awareness.
async function fanOutTargetUpdate(slotId, slotUpdates) {
  const targetUpdate = {};
  for (const [slotKey, logKey] of Object.entries(TARGET_FIELDS)) {
    if (slotKey in slotUpdates) targetUpdate[logKey] = slotUpdates[slotKey];
  }
  if (Object.keys(targetUpdate).length === 0) return;
  const { error } = await supabase
    .from('set_logs')
    .update(targetUpdate)
    .eq('exercise_slot_id', slotId);
  if (error) throw error;
}

// When the coach increases `sets`, materialize new set_logs duplicating the
// last existing log's targets. When they decrease, drop the now-orphan rows.
async function reconcileSetLogCount(slotId, nextSets) {
  const { data: existing, error: exErr } = await supabase
    .from('set_logs')
    .select('id, set_number, target_reps, target_duration_seconds, target_weight_kg, target_rest_seconds')
    .eq('exercise_slot_id', slotId)
    .order('set_number');
  if (exErr) throw exErr;

  const currentCount = existing.length;
  if (nextSets === currentCount) return;

  if (nextSets < currentCount) {
    const drop = existing.filter((l) => l.set_number > nextSets).map((l) => l.id);
    if (drop.length > 0) {
      const { error } = await supabase.from('set_logs').delete().in('id', drop);
      if (error) throw error;
    }
    return;
  }

  const template = existing[existing.length - 1] || {};
  const inserts = [];
  for (let n = currentCount + 1; n <= nextSets; n++) {
    inserts.push({
      exercise_slot_id: slotId,
      set_number: n,
      done: false,
      target_reps: template.target_reps ?? null,
      target_duration_seconds: template.target_duration_seconds ?? null,
      target_weight_kg: template.target_weight_kg ?? null,
      target_rest_seconds: template.target_rest_seconds ?? null,
    });
  }
  if (inserts.length > 0) {
    const { error } = await supabase.from('set_logs').insert(inserts);
    if (error) throw error;
  }
}

export function useUpdateSlot() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, sessionId, ...updates }) => {
      // Split slot-direct vs. fanned-out target updates. Targets still get
      // mirrored to the deprecated slot columns for read-back compatibility.
      const slotUpdate = {};
      const targetUpdate = {};
      for (const [k, v] of Object.entries(updates)) {
        if (SLOT_DIRECT_FIELDS.has(k)) slotUpdate[k] = v;
        else if (k in TARGET_FIELDS) {
          slotUpdate[k] = v;
          targetUpdate[k] = v;
        } else {
          slotUpdate[k] = v;
        }
      }
      let data = null;
      if (Object.keys(slotUpdate).length > 0) {
        const res = await supabase
          .from('exercise_slots')
          .update(slotUpdate)
          .eq('id', id)
          .select('*, exercise:exercise_library(*)')
          .single();
        if (res.error) throw res.error;
        data = res.data;
      }
      if (Object.keys(targetUpdate).length > 0) {
        await fanOutTargetUpdate(id, targetUpdate);
      }
      if ('sets' in slotUpdate) {
        await reconcileSetLogCount(id, slotUpdate.sets);
      }
      return { data, sessionId };
    },
    onSuccess: ({ sessionId }) => {
      qc.invalidateQueries({ queryKey: ['session', sessionId] });
      qc.invalidateQueries({ queryKey: ['set-logs'] });
      qc.invalidateQueries({ queryKey: ['week'] });
    },
  });
}

// Per-set target update — writes only to the chosen set_log row, not the
// slot. Used when the coach is in "Customize sets" mode.
export function useUpdateSetTarget() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ logId, sessionId, ...updates }) => {
      const payload = {};
      for (const [slotKey, logKey] of Object.entries(TARGET_FIELDS)) {
        if (slotKey in updates) payload[logKey] = updates[slotKey];
      }
      if (Object.keys(payload).length === 0) return { sessionId };
      const { error } = await supabase
        .from('set_logs')
        .update(payload)
        .eq('id', logId);
      if (error) throw error;
      return { sessionId };
    },
    onSuccess: ({ sessionId }) => {
      qc.invalidateQueries({ queryKey: ['set-logs'] });
      if (sessionId) qc.invalidateQueries({ queryKey: ['session', sessionId] });
    },
  });
}

// Targeted removal of one set (any position). Deletes the chosen log,
// renumbers later rows down by 1 with a two-pass park-and-place to dodge
// the UNIQUE(exercise_slot_id, set_number) constraint, prunes
// record_video_set_numbers (drop the removed N, decrement anything above
// it), then decrements exercise_slots.sets. Refuses to remove the last
// remaining set since exercise_slots.sets has CHECK (sets > 0).
export function useRemoveSet() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ slotId, setNumber, sessionId }) => {
      const { data: slot, error: sErr } = await supabase
        .from('exercise_slots')
        .select('sets, record_video_set_numbers')
        .eq('id', slotId)
        .single();
      if (sErr) throw sErr;
      if (slot.sets <= 1) throw new Error('Cannot remove the last set.');

      const { error: dErr } = await supabase
        .from('set_logs')
        .delete()
        .eq('exercise_slot_id', slotId)
        .eq('set_number', setNumber);
      if (dErr) throw dErr;

      const { data: above, error: aErr } = await supabase
        .from('set_logs')
        .select('id, set_number')
        .eq('exercise_slot_id', slotId)
        .gt('set_number', setNumber)
        .order('set_number');
      if (aErr) throw aErr;

      // Pass 1: park into a high range.
      await Promise.all(
        above.map((row) =>
          supabase
            .from('set_logs')
            .update({ set_number: row.set_number + 100000 })
            .eq('id', row.id)
            .then(({ error }) => { if (error) throw error; })
        )
      );
      // Pass 2: drop down by 1.
      await Promise.all(
        above.map((row) =>
          supabase
            .from('set_logs')
            .update({ set_number: row.set_number - 1 })
            .eq('id', row.id)
            .then(({ error }) => { if (error) throw error; })
        )
      );

      const newVideoSets = (slot.record_video_set_numbers || [])
        .filter((n) => n !== setNumber)
        .map((n) => (n > setNumber ? n - 1 : n));

      const { error: uErr } = await supabase
        .from('exercise_slots')
        .update({
          sets: slot.sets - 1,
          record_video_set_numbers: newVideoSets,
        })
        .eq('id', slotId);
      if (uErr) throw uErr;

      return { sessionId };
    },
    onSuccess: ({ sessionId }) => {
      qc.invalidateQueries({ queryKey: ['set-logs'] });
      if (sessionId) qc.invalidateQueries({ queryKey: ['session', sessionId] });
      qc.invalidateQueries({ queryKey: ['week'] });
    },
  });
}

// Reset every set_log row's targets to match set 1's. Used by the coach
// "back to uniform" action, since a uniform compact view requires uniformity.
export function useResetSlotToUniform() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ slotId, sessionId }) => {
      const { data: rows, error: fErr } = await supabase
        .from('set_logs')
        .select('id, set_number, target_reps, target_duration_seconds, target_weight_kg, target_rest_seconds')
        .eq('exercise_slot_id', slotId)
        .order('set_number');
      if (fErr) throw fErr;
      const head = rows[0];
      if (!head) return { sessionId };
      const payload = {
        target_reps: head.target_reps,
        target_duration_seconds: head.target_duration_seconds,
        target_weight_kg: head.target_weight_kg,
        target_rest_seconds: head.target_rest_seconds,
      };
      const { error } = await supabase
        .from('set_logs')
        .update(payload)
        .eq('exercise_slot_id', slotId);
      if (error) throw error;
      // Mirror to deprecated slot columns so legacy reads stay consistent.
      const slotMirror = {
        reps: head.target_reps,
        duration_seconds: head.target_duration_seconds,
        weight_kg: head.target_weight_kg,
        rest_seconds: head.target_rest_seconds,
      };
      const { error: slotErr } = await supabase
        .from('exercise_slots')
        .update(slotMirror)
        .eq('id', slotId);
      if (slotErr) throw slotErr;
      return { sessionId };
    },
    onSuccess: ({ sessionId }) => {
      qc.invalidateQueries({ queryKey: ['set-logs'] });
      if (sessionId) qc.invalidateQueries({ queryKey: ['session', sessionId] });
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
