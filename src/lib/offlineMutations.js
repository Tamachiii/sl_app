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
};

/**
 * Register each offline-safe mutation under a stable key so resumed-after-
 * reload mutations (whose closure-bound mutationFn didn't survive JSON
 * persistence) can still execute. The optimistic onMutate / invalidation
 * handlers stay in the hooks — for a hydrated mutation the optimistic patch
 * was already applied pre-reload, so the in-flight resume only needs the fn.
 */
export function registerOfflineMutationDefaults(queryClient) {
  for (const [name, key] of Object.entries(MUTATION_KEYS)) {
    queryClient.setMutationDefaults(key, {
      mutationFn: MUTATION_FNS[name],
      // 'online' pauses the mutation while offline so resumePausedMutations
      // can replay it on reconnect. 'offlineFirst' would try-once-and-fail
      // with retry: 0 — that would silently drop queued writes.
      networkMode: 'online',
    });
  }
}
