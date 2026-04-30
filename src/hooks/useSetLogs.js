import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';

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

// done and failed are mutually exclusive (DB CHECK set_logs_done_xor_failed).
// Marking a set done clears any prior failed flag, and vice versa, so the
// student can flip outcomes via swipe without having to "reset" first.
function patchForDone(done) {
  return done
    ? { done: true, failed: false, logged_at: new Date().toISOString(), failed_at: null }
    : { done: false, logged_at: null };
}

function patchForFailed(failed) {
  // RPE is meaningless on a set the student didn't complete — null it out on
  // the same write so a student who rated then later marked failed doesn't
  // leave an orphan rating. The DB CHECK set_logs_no_rpe_when_failed enforces
  // this server-side too.
  return failed
    ? { failed: true, done: false, failed_at: new Date().toISOString(), logged_at: null, rpe: null }
    : { failed: false, failed_at: null };
}

export function useToggleSetDone() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ logId, done }) => {
      const { data, error } = await supabase
        .from('set_logs')
        .update(patchForDone(done))
        .eq('id', logId)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
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
      context.previousQueries.forEach(([queryKey, oldData]) => {
        qc.setQueryData(queryKey, oldData);
      });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['set-logs'] });
    },
  });
}

export function useSetFailed() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ logId, failed }) => {
      const { data, error } = await supabase
        .from('set_logs')
        .update(patchForFailed(failed))
        .eq('id', logId)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
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
      context.previousQueries.forEach(([queryKey, oldData]) => {
        qc.setQueryData(queryKey, oldData);
      });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['set-logs'] });
    },
  });
}

export function useSetRpe() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ logId, rpe }) => {
      const { data, error } = await supabase
        .from('set_logs')
        .update({ rpe })
        .eq('id', logId)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['set-logs'] }),
  });
}

