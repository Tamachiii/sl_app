import { useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import {
  MUTATION_KEYS,
  MUTATION_FNS,
  patchForDone,
  patchForFailed,
  patchForSkipped,
} from '../lib/offlineMutations';

/**
 * The read of a session's sets, as an options object: `useSetLogs` mounts it,
 * and the athlete's training list hands the same object to
 * `queryClient.fetchQuery` to read the next session ahead (see
 * `sessionQueryOptions` in useSession.js, which this one follows).
 *
 * The key carries the ids of the session's exercises, sorted. Whoever reads
 * ahead must therefore pass the slots of the session row it has just cached
 * under ['session', sessionId] — the page derives its key from that row, and
 * a list of slots taken from anywhere else may be one edit behind it.
 */
export function setLogsQueryOptions(sessionId, slots) {
  const slotIds = (slots || []).map((s) => s.id).sort();
  return {
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
  };
}

export function useSetLogs(sessionId, slots) {
  return useQuery(setLogsQueryOptions(sessionId, slots));
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
// or hung request can't head-of-line-block the whole workout. A write
// restored after a reload KEEPS this scope — React Query stores it with the
// mutation — so both halves hold after a relaunch too: the sets of different
// rows leave in parallel (src/lib/persistence.test.js).
function rowScope(logId) {
  return logId ? { scope: { id: `set-log-${logId}` } } : {};
}

// The cached lists of sets, one per session: ['set-logs', sessionId, slotIds].
const SET_LOGS = ['set-logs'];
// What the five keys of MUTATION_KEYS that write a set start with.
const SET_LOG_WRITES = ['set-log'];

// The row `logId` as the cache holds it now, in whichever list has it.
function cachedRow(qc, logId) {
  for (const [, rows] of qc.getQueriesData({ queryKey: SET_LOGS })) {
    const row = Array.isArray(rows) ? rows.find((r) => r.id === logId) : undefined;
    if (row) return row;
  }
  return undefined;
}

// Merges `change(row)` onto the row `logId`, in the lists that hold it and in
// no other. An updater that answers `undefined` writes nothing — and a write,
// even of the same rows, stamps its list as read just now: the lists of the
// other sessions would look fresh after every tap of this one.
function writeRow(qc, logId, change) {
  qc.setQueriesData({ queryKey: SET_LOGS }, (rows) => {
    if (!Array.isArray(rows)) return undefined;
    const index = rows.findIndex((row) => row.id === logId);
    if (index === -1) return undefined;
    const fields = change(rows[index]);
    if (!fields || Object.keys(fields).length === 0) return undefined;
    const next = rows.slice();
    next[index] = { ...rows[index], ...fields };
    return next;
  });
}

// Is another write to the row of `variables` still on its way? React Query
// hands a handler the variables object of its own mutation, so identity tells
// this write from the others.
function hasPendingSibling(qc, variables) {
  return qc
    .getMutationCache()
    .findAll({ mutationKey: SET_LOG_WRITES, status: 'pending' })
    .some((m) => m.state.variables !== variables && m.state.variables?.logId === variables.logId);
}

// The moment of the gesture, put into the variables when `mutate` is called —
// the tap — and not when the request leaves: a set ticked without signal is
// sent hours later. The variables are what the device stores with a queued
// write, so the moment survives a relaunch. lib/offlineMutations.js builds
// `logged_at` / `failed_at` from it (`patchForDone(done, at)`).
function atTheTap(variables) {
  return { ...variables, at: variables?.at ?? new Date().toISOString() };
}

/**
 * Every single-row set-log write shares one protocol, and each step of it
 * touches ONE row — the athlete ticks the next set while the last one is still
 * on its way, so several of these writes are usually alive at once:
 *
 *   - `mutate` stamps the variables with the moment of the gesture (`at`);
 *   - `onMutate` merges `buildPatch(variables)` onto the row so the change
 *     shows at once (including while parked offline), and keeps what those
 *     fields held before — a few values, not the lists;
 *   - `onError` takes back what this write put there, field by field and only
 *     where it is still there: a newer write to the same row, and every other
 *     row, keep what they show;
 *   - `onSuccess` puts the row the database answered into the cache, unless
 *     another write to that row is still pending — its optimistic state is
 *     newer than this answer, and its own answer will carry both.
 *
 * There is NO `onSettled`: reading the sets again once the queue has drained
 * belongs to the defaults `registerOfflineMutationDefaults` registers for the
 * key, which also serve a write replayed after a relaunch, with no hook around
 * it. An option set here replaces the default of the same name — it does not
 * run next to it.
 *
 * The mutationKey / mutationFn wiring stays explicit at each call site: those
 * are what `registerOfflineMutationDefaults` looks up to revive a mutation
 * hydrated after a cold reload, whose closure-bound fn didn't survive
 * serialization.
 */
function useOptimisticSetLogMutation(logId, { mutationKey, mutationFn, buildPatch }) {
  const qc = useQueryClient();

  const mutation = useMutation({
    mutationKey,
    mutationFn,
    ...rowScope(logId),
    onMutate: async (variables) => {
      // A read on its way was sent before this write: it would land on top of it.
      await qc.cancelQueries({ queryKey: SET_LOGS });
      const written = buildPatch(variables);
      const row = cachedRow(qc, variables.logId);
      writeRow(qc, variables.logId, () => written);
      return {
        written,
        previous: row ? Object.fromEntries(Object.keys(written).map((f) => [f, row[f]])) : null,
      };
    },
    onError: (_error, variables, context) => {
      const { written, previous } = context ?? {};
      if (!written || !previous) return;
      writeRow(qc, variables.logId, (row) => {
        const undo = {};
        for (const field of Object.keys(written)) {
          if (Object.is(row[field], written[field])) undo[field] = previous[field];
        }
        return undo;
      });
    },
    onSuccess: (row, variables) => {
      if (!row?.id || hasPendingSibling(qc, variables)) return;
      writeRow(qc, row.id, () => row);
    },
  });

  const { mutate, mutateAsync } = mutation;
  const stamped = useMemo(
    () => ({
      mutate: (variables, options) => mutate(atTheTap(variables), options),
      mutateAsync: (variables, options) => mutateAsync(atTheTap(variables), options),
    }),
    [mutate, mutateAsync],
  );
  return { ...mutation, ...stamped };
}

export function useToggleSetDone(logId) {
  return useOptimisticSetLogMutation(logId, {
    mutationKey: MUTATION_KEYS.toggleDone,
    mutationFn: MUTATION_FNS.toggleDone,
    buildPatch: ({ done, at }) => patchForDone(done, at),
  });
}

export function useSetFailed(logId) {
  return useOptimisticSetLogMutation(logId, {
    mutationKey: MUTATION_KEYS.setFailed,
    mutationFn: MUTATION_FNS.setFailed,
    buildPatch: ({ failed, at }) => patchForFailed(failed, at),
  });
}

// Records the student's off-plan actuals (reps performed / load used) on a
// single set_log. Same offline-safe shape as the other set-log writes: an
// UPDATE of a pre-existing row, shown at once on that row and taken back from
// it on error. Callers pass already-normalized values (a dimension equal
// to its prescribed target is sent as null) so a stored actual_* always means
// a genuine deviation.
export function useLogActual(logId) {
  return useOptimisticSetLogMutation(logId, {
    mutationKey: MUTATION_KEYS.logActual,
    mutationFn: MUTATION_FNS.logActual,
    buildPatch: ({ actualReps, actualWeightKg }) => ({
      actual_reps: actualReps ?? null,
      actual_weight_kg: actualWeightKg ?? null,
    }),
  });
}

// Marks a prescribed set as intentionally skipped (or un-skips it). Offline-
// safe UPDATE; clears any done/failed/rpe/actual on the same patch to satisfy
// the DB CHECK that a skipped set isn't also resolved.
export function useSetSkipped(logId) {
  return useOptimisticSetLogMutation(logId, {
    mutationKey: MUTATION_KEYS.setSkipped,
    mutationFn: MUTATION_FNS.setSkipped,
    buildPatch: ({ skipped }) => patchForSkipped(skipped),
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
  return useOptimisticSetLogMutation(logId, {
    mutationKey: MUTATION_KEYS.setRpe,
    mutationFn: MUTATION_FNS.setRpe,
    buildPatch: ({ rpe }) => ({ rpe }),
  });
}

