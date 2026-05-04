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
  confirmSession: ['session-confirmation', 'confirm'],
  unconfirmSession: ['session-confirmation', 'unconfirm'],
  saveSlotComment: ['slot-comment', 'save'],
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
  confirmSession: confirmSessionFn,
  unconfirmSession: unconfirmSessionFn,
  saveSlotComment: saveSlotCommentFn,
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
