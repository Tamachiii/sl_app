import { useEffect, useMemo, useRef } from 'react';
import { useQuery, useMutation, useQueryClient, onlineManager } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useOnlineStatus } from './useOnlineStatus';
import {
  MUTATION_KEYS,
  MUTATION_FNS,
  patchForDone,
  patchForFailed,
  patchForSkipped,
} from '../lib/offlineMutations';

// The cached lists of sets, one per session: ['set-logs', sessionId, slotIds].
const SET_LOGS = ['set-logs'];
// What the five keys of MUTATION_KEYS that write a set start with.
const SET_LOG_WRITES = ['set-log'];

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

// The prescribed sets that have no row among `rows`: for every exercise, every
// number from 1 to its number of sets — whatever the row on a number is, so an
// extra set of the athlete standing on one counts as there. It is the rule of
// `ensure_set_logs` in the database, word for word, and the two must stay one:
// a set the device counts missing and the database does not is a call sent at
// every opening of the session.
function missingSets(slots, rows) {
  const there = new Set((rows || []).map((row) => `${row.exercise_slot_id}:${row.set_number}`));
  const missing = [];
  for (const slot of slots || []) {
    for (let setNumber = 1; setNumber <= (slot.sets ?? 0); setNumber++) {
      if (!there.has(`${slot.id}:${setNumber}`)) missing.push({ slot, setNumber });
    }
  }
  return missing;
}

// What PostgREST answers when it knows no function of that name and those
// arguments: a database that does not have migration 2026_10_13_13.
const NO_SUCH_FUNCTION = 'PGRST202';

// What `ensure_set_logs` does, for a database without the function: the
// exercises of the session and the sets they have are read THERE, then the
// missing ones are inserted with the targets of their exercise — under the
// athlete's own policies, which refuse a session that is closed. Nothing of it
// comes from the device's cache either.
async function insertMissingSetLogs(sessionId) {
  const { data: slots, error: slotsError } = await supabase
    .from('exercise_slots')
    .select('id, sets, reps, duration_seconds, weight_kg, rest_seconds')
    .eq('session_id', sessionId);
  if (slotsError) throw slotsError;
  if (!slots?.length) return 0;

  const { data: existing, error: existingError } = await supabase
    .from('set_logs')
    .select('exercise_slot_id, set_number')
    .in('exercise_slot_id', slots.map((slot) => slot.id));
  if (existingError) throw existingError;

  const rows = missingSets(slots, existing).map(({ slot, setNumber }) => ({
    exercise_slot_id: slot.id,
    set_number: setNumber,
    done: false,
    target_reps: slot.reps ?? null,
    target_duration_seconds: slot.duration_seconds ?? null,
    target_weight_kg: slot.weight_kg ?? null,
    target_rest_seconds: slot.rest_seconds ?? null,
  }));
  if (rows.length === 0) return 0;

  const { error } = await supabase.from('set_logs').insert(rows);
  if (error) throw error;
  return rows.length;
}

/**
 * Completes the sets of a session the athlete has open: a prescribed set
 * without its row — an exercise written before sets were rows, a request of
 * the coach's editor that was lost — is added, by the database.
 *
 * The page calls it with what it shows: the session's exercises and the sets
 * it has read (`logs`, `undefined` until they are). The hook decides by itself
 * whether there is anything to ask:
 *
 *   - NOTHING IS SENT WHEN NOTHING IS MISSING, which is every opening of every
 *     session but a handful. It used to cost each of them a read and a refresh
 *     of the sets.
 *   - NOTHING IS STARTED WITHOUT A NETWORK. A mutation started offline does not
 *     fail: it is parked, counted as "1 change waiting to sync" over a workout
 *     in which nothing was entered, stored with the queue, and — having no key
 *     the queue knows — ends as "Couldn't save that" at the next launch. So
 *     this one is not a write of the queue and never waits: it runs when the
 *     device is online and something is missing, and again when the network
 *     returns. `onlineManager` is asked as well as the device, because it is
 *     the one that parks.
 *   - THE DEVICE ONLY SAYS WHETHER TO ASK. `ensure_set_logs(p_session_id)` is
 *     given the id of the session and reads the exercises in the database, so
 *     a set the coach has removed since this device read the session does not
 *     come back. The function adds the rows, with the coach's targets, and
 *     answers how many.
 *
 * Its answer is what is read again. More than 0: the sets, which have new
 * rows. 0: the database is short of nothing where the device counted a set
 * missing, so the device's copy is behind — the session (its numbers of sets)
 * and the sets are both asked again. A read of the sets is left to the one
 * that follows the last set-log write when such a write is on its way
 * (lib/offlineMutations.js): made in between, it comes back without it.
 *
 * A refusal says nothing to the athlete (`skipErrorToast`): they asked for
 * nothing, and the sets that are there are on screen. Each list of missing
 * sets is asked for once per opening of the page — an answer that changes
 * nothing on the device must not be asked for again — and once more when the
 * network returns.
 *
 * `enabled: false` is for a session the page shows read-only (the function
 * refuses it) and for reads that are still on their way.
 */
export function useEnsureSetLogs(sessionId, slots, logs, { enabled = true } = {}) {
  const qc = useQueryClient();
  const online = useOnlineStatus();

  const mutation = useMutation({
    mutationFn: async ({ sessionId: id }) => {
      const { data, error } = await supabase.rpc('ensure_set_logs', { p_session_id: id });
      if (!error) return data ?? 0;
      if (error.code === NO_SUCH_FUNCTION) return insertMissingSetLogs(id);
      throw error;
    },
    meta: { skipErrorToast: true },
    onSuccess: (added, { sessionId: id }) => {
      if (!(added > 0)) qc.invalidateQueries({ queryKey: ['session', id] });
      if (qc.isMutating({ mutationKey: SET_LOG_WRITES }) > 0) return;
      qc.invalidateQueries({ queryKey: ['set-logs', id] });
    },
  });
  const { mutate } = mutation;

  // What there is to ask for, as a string: the effect below runs when it
  // changes, not each time the page is handed the same sets again.
  const wanted = useMemo(() => {
    if (!enabled || !sessionId || logs === undefined) return null;
    const missing = missingSets(slots, logs);
    if (missing.length === 0) return null;
    return `${sessionId}|${missing.map(({ slot, setNumber }) => `${slot.id}:${setNumber}`).join(',')}`;
  }, [enabled, sessionId, slots, logs]);

  // The lists already asked for since the page was opened.
  const asked = useRef(new Set());
  useEffect(() => {
    if (!online || !onlineManager.isOnline()) {
      // What was asked before the network went is asked again when it returns.
      asked.current.clear();
      return;
    }
    if (!wanted || asked.current.has(wanted)) return;
    asked.current.add(wanted);
    mutate({ sessionId });
  }, [wanted, online, sessionId, mutate]);

  return mutation;
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

