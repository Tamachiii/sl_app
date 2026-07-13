import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import {
  MUTATION_KEYS,
  MUTATION_FNS,
  patchForDone,
  patchForFailed,
  patchForSkipped,
} from '../lib/offlineMutations';

export function useSetLogs(sessionId, slots) {
  const slotIds = (slots || []).map((s) => s.id).sort();
  return useQuery({
    queryKey: ['set-logs', sessionId, slotIds],
    queryFn: async () => {
      if (slotIds.length === 0) return [];

      const { data, error } = await supabase
        .from('set_logs')
        .select('*')
        .in('exercise_slot_id', slotIds)
        .order('set_number');
      if (error) throw error;
      return data;
    },
    enabled: !!sessionId && slotIds.length > 0,
  });
}

// Safety net for legacy slots that pre-date the per-set-targets migration:
// inserts any missing set_log rows and seeds them with the slot's uniform
// targets. New slots created via useAddSlot already materialize their logs,
// so this is mostly a no-op now.
export function useEnsureSetLogs() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ sessionId, slots }) => {
      const slotIds = slots.map((s) => s.id);
      const { data: existing, error: existErr } = await supabase
        .from('set_logs')
        .select('exercise_slot_id, set_number')
        .in('exercise_slot_id', slotIds);
      if (existErr) throw existErr;

      const existingSet = new Set(
        (existing || []).map((l) => `${l.exercise_slot_id}-${l.set_number}`)
      );

      const toInsert = [];
      for (const slot of slots) {
        for (let i = 1; i <= slot.sets; i++) {
          if (!existingSet.has(`${slot.id}-${i}`)) {
            toInsert.push({
              exercise_slot_id: slot.id,
              set_number: i,
              done: false,
              target_reps: slot.reps ?? null,
              target_duration_seconds: slot.duration_seconds ?? null,
              target_weight_kg: slot.weight_kg ?? null,
              target_rest_seconds: slot.rest_seconds ?? null,
            });
          }
        }
      }

      if (toInsert.length > 0) {
        const { error } = await supabase.from('set_logs').insert(toInsert);
        if (error) throw error;
      }
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['set-logs', vars.sessionId] });
    },
  });
}

// Per-row mutation scope: writes to the SAME set_log run strictly FIFO (a
// done → un-done pair queued offline can never land out of order), while
// writes to different rows still run in parallel when online — so one slow
// or hung request can't head-of-line-block the whole workout. Mutations
// hydrated after a reload lose this option and fall back to the global
// 'offline-writes' scope from registerOfflineMutationDefaults, which is
// strictly serial — conservative and equally correct.
function rowScope(logId) {
  return logId ? { scope: { id: `set-log-${logId}` } } : {};
}

export function useToggleSetDone(logId) {
  const qc = useQueryClient();

  return useMutation({
    mutationKey: MUTATION_KEYS.toggleDone,
    mutationFn: MUTATION_FNS.toggleDone,
    ...rowScope(logId),
    onMutate: async ({ logId, done }) => {
      await qc.cancelQueries({ queryKey: ['set-logs'] });
      const previousQueries = qc.getQueriesData({ queryKey: ['set-logs'] });
      const patch = patchForDone(done);
      qc.setQueriesData({ queryKey: ['set-logs'] }, (old) => {
        if (!old) return old;
        return old.map((log) => (log.id === logId ? { ...log, ...patch } : log));
      });
      return { previousQueries };
    },
    onError: (err, newLog, context) => {
      context?.previousQueries?.forEach(([queryKey, oldData]) => {
        qc.setQueryData(queryKey, oldData);
      });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['set-logs'] });
    },
  });
}

export function useSetFailed(logId) {
  const qc = useQueryClient();

  return useMutation({
    mutationKey: MUTATION_KEYS.setFailed,
    mutationFn: MUTATION_FNS.setFailed,
    ...rowScope(logId),
    onMutate: async ({ logId, failed }) => {
      await qc.cancelQueries({ queryKey: ['set-logs'] });
      const previousQueries = qc.getQueriesData({ queryKey: ['set-logs'] });
      const patch = patchForFailed(failed);
      qc.setQueriesData({ queryKey: ['set-logs'] }, (old) => {
        if (!old) return old;
        return old.map((log) => (log.id === logId ? { ...log, ...patch } : log));
      });
      return { previousQueries };
    },
    onError: (err, newLog, context) => {
      context?.previousQueries?.forEach(([queryKey, oldData]) => {
        qc.setQueryData(queryKey, oldData);
      });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['set-logs'] });
    },
  });
}

// Records the student's off-plan actuals (reps performed / load used) on a
// single set_log. Same offline-safe shape as the other set-log writes: an
// UPDATE of a pre-existing row, optimistic patch into every ['set-logs'] cache,
// rollback on error. Callers pass already-normalized values (a dimension equal
// to its prescribed target is sent as null) so a stored actual_* always means
// a genuine deviation.
export function useLogActual(logId) {
  const qc = useQueryClient();

  return useMutation({
    mutationKey: MUTATION_KEYS.logActual,
    mutationFn: MUTATION_FNS.logActual,
    ...rowScope(logId),
    onMutate: async ({ logId, actualReps, actualWeightKg }) => {
      await qc.cancelQueries({ queryKey: ['set-logs'] });
      const previousQueries = qc.getQueriesData({ queryKey: ['set-logs'] });
      qc.setQueriesData({ queryKey: ['set-logs'] }, (old) => {
        if (!old) return old;
        return old.map((log) =>
          log.id === logId
            ? { ...log, actual_reps: actualReps ?? null, actual_weight_kg: actualWeightKg ?? null }
            : log,
        );
      });
      return { previousQueries };
    },
    onError: (_err, _vars, context) => {
      context?.previousQueries?.forEach(([queryKey, oldData]) => {
        qc.setQueryData(queryKey, oldData);
      });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['set-logs'] }),
  });
}

// Marks a prescribed set as intentionally skipped (or un-skips it). Offline-
// safe UPDATE; clears any done/failed/rpe/actual on the same patch to satisfy
// the DB CHECK that a skipped set isn't also resolved.
export function useSetSkipped(logId) {
  const qc = useQueryClient();

  return useMutation({
    mutationKey: MUTATION_KEYS.setSkipped,
    mutationFn: MUTATION_FNS.setSkipped,
    ...rowScope(logId),
    onMutate: async ({ logId, skipped }) => {
      await qc.cancelQueries({ queryKey: ['set-logs'] });
      const previousQueries = qc.getQueriesData({ queryKey: ['set-logs'] });
      const patch = patchForSkipped(skipped);
      qc.setQueriesData({ queryKey: ['set-logs'] }, (old) => {
        if (!old) return old;
        return old.map((log) => (log.id === logId ? { ...log, ...patch } : log));
      });
      return { previousQueries };
    },
    onError: (_err, _vars, context) => {
      context?.previousQueries?.forEach(([queryKey, oldData]) => {
        qc.setQueryData(queryKey, oldData);
      });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['set-logs'] }),
  });
}

// Appends an extra set the student did beyond the prescription (NULL targets,
// is_student_added=true). ONLINE-ONLY: a brand-new-row INSERT can't be safely
// queued offline (the offline lane only UPDATE/UPSERT/DELETEs existing rows,
// and two offline adds would collide on UNIQUE(exercise_slot_id, set_number)).
// The UI gates the affordance on connectivity, mirroring VideoUploadButton.
export function useAddStudentSet() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ slotId, setNumber }) => {
      const { data, error } = await supabase
        .from('set_logs')
        .insert({
          exercise_slot_id: slotId,
          set_number: setNumber,
          is_student_added: true,
          done: false,
          failed: false,
        })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['set-logs'] }),
  });
}

// Removes a student-added extra set. Online-only for symmetry with the add.
export function useRemoveStudentSet() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ logId }) => {
      const { error } = await supabase
        .from('set_logs')
        .delete()
        .eq('id', logId)
        .eq('is_student_added', true);
      if (error) throw error;
      return { logId };
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['set-logs'] }),
  });
}

export function useSetRpe(logId) {
  const qc = useQueryClient();

  return useMutation({
    mutationKey: MUTATION_KEYS.setRpe,
    mutationFn: MUTATION_FNS.setRpe,
    ...rowScope(logId),
    onMutate: async ({ logId, rpe }) => {
      await qc.cancelQueries({ queryKey: ['set-logs'] });
      const previousQueries = qc.getQueriesData({ queryKey: ['set-logs'] });
      qc.setQueriesData({ queryKey: ['set-logs'] }, (old) => {
        if (!old) return old;
        return old.map((log) => (log.id === logId ? { ...log, rpe } : log));
      });
      return { previousQueries };
    },
    onError: (_err, _vars, context) => {
      context?.previousQueries?.forEach(([queryKey, oldData]) => {
        qc.setQueryData(queryKey, oldData);
      });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['set-logs'] }),
  });
}

