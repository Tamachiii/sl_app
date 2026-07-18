// Mutation payloads for student-side writes that must work offline.
//
// Each mutation is keyed so it can be persisted by react-query-persist-client,
// hydrated after a cold reload, and resumed when connectivity returns. The
// hooks consume `MUTATION_FNS[key]` inline for the live-firing path; the same
// functions are registered via `queryClient.setMutationDefaults` in
// `lib/queryClient.js` so a hydrated mutation (whose mutationFn closure was
// lost to JSON serialization) still has an executor on resume.
//
// Conflict policy: every write here is row-targeted (one set_log / comment /
// confirmation) and small, so last-writer-wins is safe. Per-set DB CHECKs
// (`set_logs_done_xor_failed`, `set_logs_no_rpe_when_failed`) are encoded in
// the patch helpers below — replays remain constraint-safe.

import { supabase } from './supabase';
import { pushToast } from './toast';

export const MUTATION_KEYS = {
  toggleDone: ['set-log', 'toggle-done'],
  setFailed: ['set-log', 'set-failed'],
  setRpe: ['set-log', 'set-rpe'],
  logActual: ['set-log', 'log-actual'],
  setSkipped: ['set-log', 'set-skipped'],
  confirmSession: ['session-confirmation', 'confirm'],
  unconfirmSession: ['session-confirmation', 'unconfirm'],
  saveSlotComment: ['slot-comment', 'save'],
  saveSlotDeviation: ['slot-deviation', 'save'],
  // Phase 3.4d — offline program authoring. The whole draft syncs as ONE
  // idempotent snapshot (save_draft_tree RPC), so authoring never queues a
  // fragile stream of per-node INSERTs.
  saveDraftTree: ['draft-tree', 'save'],
  discardDraft: ['draft-tree', 'discard'],
};

export function patchForDone(done) {
  return done
    ? { done: true, failed: false, logged_at: new Date().toISOString(), failed_at: null }
    : { done: false, logged_at: null };
}

export function patchForFailed(failed) {
  // RPE is meaningless on a set the student didn't complete; null it out on
  // the same write so a student who rated then later marked failed doesn't
  // leave an orphan rating. The DB CHECK enforces this server-side too.
  return failed
    ? { failed: true, done: false, failed_at: new Date().toISOString(), logged_at: null, rpe: null }
    : { failed: false, failed_at: null };
}

export function patchForSkipped(skipped) {
  // A skipped set is neither done nor failed (DB CHECK set_logs_skipped_not_
  // _resolved). Clear every outcome + actual so the row reads as a clean skip;
  // un-skipping just drops the flag and returns the set to pending.
  return skipped
    ? {
        skipped: true,
        done: false,
        failed: false,
        rpe: null,
        logged_at: null,
        failed_at: null,
        actual_reps: null,
        actual_weight_kg: null,
      }
    : { skipped: false };
}

async function toggleDoneFn({ logId, done }) {
  const { data, error } = await supabase
    .from('set_logs')
    .update(patchForDone(done))
    .eq('id', logId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function setFailedFn({ logId, failed }) {
  const { data, error } = await supabase
    .from('set_logs')
    .update(patchForFailed(failed))
    .eq('id', logId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function setRpeFn({ logId, rpe }) {
  const { data, error } = await supabase
    .from('set_logs')
    .update({ rpe })
    .eq('id', logId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Records the student's off-plan actuals. Pass null on a dimension to mean
// "did it as prescribed" — callers normalize a value equal to the target down
// to null so a stored actual_* always denotes a real deviation. An UPDATE on a
// pre-existing row, so it parks-and-replays offline like the other set_log
// writes; the coach-owned target_* columns are never in the payload (and the
// pin_set_log_targets_for_student trigger would revert them anyway).
async function logActualFn({ logId, actualReps, actualWeightKg }) {
  const { data, error } = await supabase
    .from('set_logs')
    .update({
      actual_reps: actualReps ?? null,
      actual_weight_kg: actualWeightKg ?? null,
    })
    .eq('id', logId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function setSkippedFn({ logId, skipped }) {
  const { data, error } = await supabase
    .from('set_logs')
    .update(patchForSkipped(skipped))
    .eq('id', logId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Upsert the student's swap/skip deviation for a slot. Passing kind=null (or a
// falsy kind) clears the deviation so the slot reverts to the prescription —
// mirrors saveSlotComment's empty-body delete. Upsert on the UNIQUE
// exercise_slot_id keeps offline replay idempotent.
async function saveSlotDeviationFn({ slotId, studentId, kind, substituteExerciseId, note }) {
  if (!kind) {
    const { error } = await supabase
      .from('slot_deviations')
      .delete()
      .eq('exercise_slot_id', slotId);
    if (error) throw error;
    return { slotId, deleted: true };
  }
  const { data, error } = await supabase
    .from('slot_deviations')
    .upsert(
      {
        exercise_slot_id: slotId,
        student_id: studentId,
        kind,
        substitute_exercise_id: kind === 'swap' ? (substituteExerciseId ?? null) : null,
        note: note ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'exercise_slot_id' }
    )
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Upsert (not insert) so that a queued confirm replayed against an already-
// confirmed session no-ops instead of tripping the UNIQUE(session_id) constraint
// — keeps offline replay idempotent.
async function confirmSessionFn({ sessionId, studentId, notes }) {
  const { data, error } = await supabase
    .from('session_confirmations')
    .upsert(
      { session_id: sessionId, student_id: studentId, notes: notes || null },
      { onConflict: 'session_id' }
    )
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function unconfirmSessionFn({ sessionId }) {
  const { error } = await supabase
    .from('session_confirmations')
    .delete()
    .eq('session_id', sessionId);
  if (error) throw error;
}

async function saveSlotCommentFn({ slotId, studentId, body }) {
  const trimmed = (body || '').trim();
  if (!trimmed) {
    const { error } = await supabase
      .from('slot_comments')
      .delete()
      .eq('exercise_slot_id', slotId);
    if (error) throw error;
    return { slotId, deleted: true };
  }
  const { data, error } = await supabase
    .from('slot_comments')
    .upsert(
      {
        exercise_slot_id: slotId,
        student_id: studentId,
        body: trimmed,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'exercise_slot_id' }
    )
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Whole draft tree → one declarative, idempotent server upsert. Re-running the
// same snapshot converges (the RPC replaces children by client-minted id), so a
// FIFO replay of stacked snapshots or a double-run after a cold reload can never
// duplicate rows.
async function saveDraftTreeFn({ tree }) {
  const { data, error } = await supabase.rpc('save_draft_tree', { p_tree: tree });
  if (error) throw error;
  return data;
}
async function discardDraftFn({ programId }) {
  const { error } = await supabase.from('programs').delete().eq('id', programId);
  if (error) throw error;
  return { programId, deleted: true };
}

export const MUTATION_FNS = {
  toggleDone: toggleDoneFn,
  setFailed: setFailedFn,
  setRpe: setRpeFn,
  logActual: logActualFn,
  setSkipped: setSkippedFn,
  confirmSession: confirmSessionFn,
  unconfirmSession: unconfirmSessionFn,
  saveSlotComment: saveSlotCommentFn,
  saveSlotDeviation: saveSlotDeviationFn,
  saveDraftTree: saveDraftTreeFn,
  discardDraft: discardDraftFn,
};

// Authoring writes ride a DEDICATED FIFO scope so a hung draft sync can't
// head-of-line-block a workout set_log replay (or vice-versa).
const DRAFT_MUTATIONS = new Set(['saveDraftTree', 'discardDraft']);

/**
 * Error handling for a draft-tree snapshot save, applied via mutation DEFAULTS
 * so a LIVE save and a HYDRATED (post-cold-reload) save behave identically —
 * neither is silent, and neither clobbers unsynced local edits:
 *   - exercise_unavailable → a slot's exercise left the coach library: keep the
 *     local tree (so it can be fixed) + a specific toast.
 *   - draft_not_editable / 23505 / 42501 → coach approved/removed it, or a second
 *     device owns the one draft: reconcile to the canonical server state.
 *   - anything else (transient) → keep the local tree + a plain toast; the next
 *     edit re-sends the whole snapshot.
 */
function draftSaveErrorHandler(queryClient, error) {
  const code = error?.code;
  const msg = error?.message || '';
  if (/exercise_unavailable/.test(msg)) {
    pushToast('One exercise is no longer in your coach’s library — remove or replace it.', { kind: 'error' });
    return;
  }
  if (code === '23505' || code === '42501' || /draft_not_editable/.test(msg)) {
    queryClient.invalidateQueries({ queryKey: ['my-draft'] });
    queryClient.invalidateQueries({ queryKey: ['draft-tree'] });
    return;
  }
  pushToast('Couldn’t sync your draft — it’s saved on this device.', { kind: 'error' });
}

/**
 * True when any draft-tree save is still un-synced (paused, pending, or errored).
 * The resume-time reconcile MUST skip its refetch in that case: refetching a
 * draft the local optimistic cache holds edits the server doesn't have would
 * clobber them (and for an offline-CREATED draft the server row doesn't exist
 * yet, so my-draft would refetch to null and the whole draft would vanish).
 */
export function hasUnsyncedDraftSave(queryClient) {
  return queryClient.getMutationCache().getAll().some((m) => {
    const key = m.options.mutationKey;
    if (!Array.isArray(key) || key[0] !== 'draft-tree' || key[1] !== 'save') return false;
    return m.state.isPaused || m.state.status === 'pending' || m.state.status === 'error';
  });
}

/**
 * Register each offline-safe mutation under a stable key so resumed-after-
 * reload mutations (whose closure-bound mutationFn didn't survive JSON
 * persistence) can still execute. The optimistic onMutate / invalidation
 * handlers stay in the hooks — for a hydrated mutation the optimistic patch
 * was already applied pre-reload, so the in-flight resume only needs the fn.
 */
export function registerOfflineMutationDefaults(queryClient) {
  for (const [name, key] of Object.entries(MUTATION_KEYS)) {
    if (name === 'saveDraftTree') {
      // The authoring snapshot save carries its reconcile/toast onError, the
      // my-draft invalidation onSuccess, and skipErrorToast HERE (in defaults)
      // so a hydrated resume behaves exactly like a live save — the review
      // caught that a hydrated failure would otherwise be silent, and that the
      // hook-only onError didn't cover the resumed path.
      queryClient.setMutationDefaults(key, {
        mutationFn: MUTATION_FNS[name],
        networkMode: 'online',
        scope: { id: 'draft-tree' },
        meta: { skipErrorToast: true },
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['my-draft'] }),
        onError: (error) => draftSaveErrorHandler(queryClient, error),
      });
      continue;
    }
    queryClient.setMutationDefaults(key, {
      mutationFn: MUTATION_FNS[name],
      // 'online' pauses the mutation while offline so resumePausedMutations
      // can replay it on reconnect. 'offlineFirst' would try-once-and-fail
      // with retry: 0 — that would silently drop queued writes.
      networkMode: 'online',
      // Shared scope serializes queued writes into FIFO order on replay.
      // Without it resumePausedMutations() is a parallel Promise.all, so two
      // opposite writes to the same row (done → un-done queued offline) could
      // settle in whichever order the network finishes them. This global
      // scope is the fallback for mutations HYDRATED after a reload (their
      // options come from these defaults); live set-log hooks override it
      // with a per-row scope (see useSetLogs.rowScope) so unrelated rows
      // don't head-of-line-block each other while online. Authoring rides its
      // OWN scope so a stuck draft sync and a stuck workout write stay isolated.
      scope: { id: DRAFT_MUTATIONS.has(name) ? 'draft-tree' : 'offline-writes' },
    });
  }
}
