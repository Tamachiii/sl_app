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
// deviation / confirmation) and small. Set logs, comments and deviations are
// last-writer-wins. A confirmation is the exception — the FIRST one stays and
// a second confirm writes nothing (see `confirmSessionFn`). Per-set DB CHECKs
// (`set_logs_done_xor_failed`, `set_logs_no_rpe_when_failed`) are encoded in
// the patch helpers below — replays remain constraint-safe.
//
// Failure policy (`lib/networkErrors.js` has the three cases): a write the
// database REFUSED fails once; one that got NO ANSWER is sent again, five
// times at most; and while NOBODY IS SIGNED IN nothing is sent at all, the
// write waits. All three rest on every function here being idempotent — a
// retry re-sends a request whose first copy may have reached the database.
//
// Three more things are decided here and not in the hooks, because a write
// restored from IndexedDB after a relaunch has no hook around it — only the
// defaults registered at the bottom of this file:
//   - WHEN a set was done: the moment of the tap, not of the request
//     (`tapTime`);
//   - which caches a settled write refreshes (`refreshAfter`);
//   - what becomes of a write the database closed while it waited (`waited`,
//     `refuseReplay`).
//
// The draft an athlete writes has a section of its own further down: a tree
// that is ahead of the server says so itself, is never replaced by a read, and
// is sent again until the database has it.

import { onlineManager } from '@tanstack/react-query';
import { supabase } from './supabase';
import { pushToast } from './toast';
import { buildSnapshot, isUnsyncedDraft, markSynced, markUnsynced, unsyncedRev } from './draftTree';
import {
  AuthNotReadyError,
  isTransientError,
  rankTransientFailure,
  mutationRetry,
  mutationRetryDelay,
} from './networkErrors';
import {
  REPLAY_REFUSED_KEY,
  isClosedToAthlete,
  markRefusedReplay,
  recordRejectedWrite,
} from './mutationErrors';

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

// Authoring writes ride a DEDICATED FIFO scope so a hung draft sync can't
// head-of-line-block a workout set_log replay (or vice-versa). Every other
// write of the queue is a write of the workout.
const DRAFT_MUTATIONS = new Set(['saveDraftTree', 'discardDraft']);

// --- when the set was done ------------------------------------------------------
//
// `logged_at` and `failed_at` say when the athlete did the set. They used to be
// read from the clock inside the mutation function — the moment the REQUEST is
// built. For a set ticked in a basement that is the moment the phone found a
// network again: the evening, or the next day. `performed_on` (the earliest
// `logged_at` of the session), "N days ago", the recent personal records and
// the bodyweight a ×BW ratio is read against all moved with it.
//
// The moment of the tap travels with the write instead. A set-log hook puts it
// in the variables as `at` (ISO), where its own optimistic patch reads it too,
// and the variables are what the persister stores. A write that carries none —
// queued by a build older than this rule — still has the moment its mutation
// was made (`state.submittedAt`, set on the tap and persisted with it), which
// `queuedWrite` hands over as `madeAt`. Only a call that knows neither falls
// back on the clock.
//
// Each candidate is a string, a number of milliseconds or a Date; anything that
// is not a date is skipped rather than sent — one unreadable value must not
// turn a set into a row the database refuses.
function tapTime(...candidates) {
  for (const candidate of candidates) {
    if (candidate == null || candidate === '' || candidate === 0) continue;
    const date = new Date(candidate);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return new Date().toISOString();
}

export function patchForDone(done, at) {
  return done
    ? { done: true, failed: false, logged_at: tapTime(at), failed_at: null }
    : { done: false, logged_at: null };
}

export function patchForFailed(failed, at) {
  // RPE is meaningless on a set the student didn't complete; null it out on
  // the same write so a student who rated then later marked failed doesn't
  // leave an orphan rating. The DB CHECK enforces this server-side too.
  return failed
    ? { failed: true, done: false, failed_at: tapTime(at), logged_at: null, rpe: null }
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

async function toggleDoneFn({ logId, done, at }, { madeAt } = {}) {
  const { data, error } = await supabase
    .from('set_logs')
    .update(patchForDone(done, tapTime(at, madeAt)))
    .eq('id', logId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function setFailedFn({ logId, failed, at }, { madeAt } = {}) {
  const { data, error } = await supabase
    .from('set_logs')
    .update(patchForFailed(failed, tapTime(at, madeAt)))
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

// Insert-or-nothing: INSERT ... ON CONFLICT (session_id) DO NOTHING. The first
// confirmation of a session is the one that stays.
//
// `ignoreDuplicates` is what makes it "nothing". Without it PostgREST turns the
// same call into DO UPDATE on every column of the payload, so a second confirm
// — a replay whose first attempt did reach the server, or a second device still
// showing the session as unconfirmed — replaced the athlete's check-in note
// with its own (usually NULL) and moved `performed_on` to whatever that device
// computed, after the coach may have read both. DO NOTHING also never reaches
// the UPDATE policies, so such a replay is not refused once the coach has
// reviewed the session and its confirmation is locked.
//
// Resolves the inserted row, or `null` when the session was already confirmed:
// a statement that wrote no row returns none, hence `maybeSingle` — `single()`
// would turn that empty answer into a PGRST116 error and the replay would fail
// with a toast. Callers must not read the result as "the confirmation"; the
// hook refetches it. Changing the note of an existing confirmation is undo,
// then confirm again (DELETE, then a fresh INSERT).
//
// `performedOn` is computed by the CALLER at confirm time (see
// `performedOnFromLogs`) and rides in the serialized variables, which is the
// whole point: a confirm queued offline and replayed two days later still
// records the day the student trained, whereas the server's `confirmed_at`
// default would record the replay.
async function confirmSessionFn({ sessionId, studentId, notes, performedOn }) {
  const { data, error } = await supabase
    .from('session_confirmations')
    .upsert(
      {
        session_id: sessionId,
        student_id: studentId,
        notes: notes || null,
        performed_on: performedOn || null,
      },
      { onConflict: 'session_id', ignoreDuplicates: true }
    )
    .select()
    .maybeSingle();
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

// --- the session gate ----------------------------------------------------------
//
// supabase-js puts the session's access token on every request — and the
// ANONYMOUS key when it has no session to take one from. "No session" is not
// only "signed out": `auth.getSession()` also answers null while the token has
// expired and cannot be refreshed, which is the state of a phone that comes
// back to a network that does not answer yet, or is opened offline after a
// long pause. A queued write sent in that state reaches the database as an
// anonymous request. RLS hides the row, and the answer is a refusal WITH A
// CODE (PGRST116 for an update, 42501 for an insert) — indistinguishable from
// a real one, final, and the set is lost.
//
// So a write first requires a session. Without one it throws AuthNotReadyError
// before anything is sent, and the retry policy treats that as "wait", for as
// long as it takes: a write is never dropped because nobody is signed in.
// (supabase-js reads the session once more for the request itself, a few
// milliseconds later. Only a token crossing its expiry margin in exactly that
// gap, with a refresh that then fails, gets past — and what gets past is the
// refusal described above, not a wrong write.)
//
// The gate works on the clients `registerOfflineMutationDefaults` ran on — the
// app's one. That registration is what gives a write the retry policy that
// turns AuthNotReadyError into a wait; on a bare QueryClient (the hooks' own
// tests build one, with `retry: false`) the same error would be the permanent
// failure the gate exists to prevent, so there the write is sent as before.
// React Query hands its client to the mutation function, live or replayed.
const queueClients = new WeakSet();

// "A session" is not enough: it has to be the session of the account the
// queue belongs to. The persisted cache says whose it is (lib/persistence.js),
// and a blob left by one account can be what another account's launch
// restores — the app was killed between a sign-out elsewhere and its own
// clean-up. Its queued writes would then leave under the wrong name: refused
// by the database, taken off the queue, and reported to the wrong person.
//
// So a client can be told how to ask for the owner of its queue
// (`registerOfflineMutationDefaults(client, { queueOwner })`), and while that
// answers another account than the one signed in, a write waits exactly as it
// does without a session. It does not wait long: `ClearOnUserChange` in
// App.jsx wipes a cache that is not the signed-in account's, and a wiped
// write never runs (`abandoned`). An owner that is not known — null: nothing
// was restored, or the blob predates the label — holds nothing back. That is
// why the same component does not let such a cache wait for a sign-in: opened
// by a signed-in account it is labelled as theirs, opened by nobody it is
// wiped there and then.
const queueOwners = new WeakMap();

function ownsQueue(client, session) {
  const owner = queueOwners.get(client)?.() ?? null;
  return owner === null || owner === (session.user?.id ?? null);
}

// The session as supabase-js would use it for the next request: null when
// there is none, or when the token could not be refreshed. `getSession()`
// waits for the client's own start-up, so it can be asked at any moment. It
// can also reject (lock time-out, storage refused): "cannot tell" is "not
// ready".
//
// The call itself is outside the `try` on purpose. A client without
// `auth.getSession` is not a device without a session: it is a test whose
// mock of lib/supabase builds the app's client (`registerOfflineMutationDefaults`)
// and forgot auth. That must fail, loudly and at once — taken for "no session"
// it would be a write that waits for ever and a test that times out.
async function readSession() {
  const reading = supabase.auth.getSession();
  try {
    const { data } = await reading;
    return data?.session ?? null;
  } catch {
    return null;
  }
}

// The mutation a running write belongs to, or undefined when its client no
// longer holds it. React Query gives the function the variables object of its
// mutation, the very one the cache entry holds, so identity finds it.
//
// "No longer holds it" is `queryClient.clear()` — what the app does when the
// account changes. It empties the mutation cache but cannot stop a mutation
// that is asleep between two attempts: that one would wake up and send one
// account's write with the next account's session.
function mutationOf(client, variables) {
  const held = client.getMutationCache().getAll().filter((m) => m.state.variables === variables);
  // The running one, should a caller have handed the same object to two.
  return held.find((m) => m.state.status === 'pending') ?? held[0];
}

// The fate of a write whose queue was cleared: it never settles. No request,
// and no onError / onSettled either — the hooks' rollbacks would write the
// previous account's rows back into the cache that was just emptied for the
// next one.
const abandoned = () => new Promise(() => {});

// How many attempts of a mutation got no answer. Counted apart from React
// Query's own failure count, so that waiting for a session does not use up the
// retries — see `rankTransientFailure` in lib/networkErrors.js.
const unanswered = new WeakMap();

// --- a write that waited, and was refused ---------------------------------------
//
// The database accepts an athlete's write while their program is the block
// being trained and the session is neither archived nor reviewed. A workout
// logged without signal is sent hours later, and the coach may have moved on
// in between: the next block activated (past the 72 hours the database still
// allows), the session reviewed, a set removed. Every write of that workout
// then comes back with PGRST116 or 42501 (`isClosedToAthlete`).
//
// Treated like any failure, that was one generic toast per set, then a
// refetch — and for the mutations restored after a relaunch no rollback
// either: the screen showed the workout as logged, the reads replaced it with
// the empty rows, and nothing anywhere still said what the athlete had done.
//
// So a write that WAITED and is refused this way is handled apart:
//   - one message for the whole queue, which says what happened;
//   - its variables go to the journal of lib/mutationErrors.js — what the
//     athlete did stays on the device, readable;
//   - the reads are not refreshed (`refusing`), so the mutation layer does not
//     take off the screen what the athlete sees there.
//
// "Waited" is the whole difference. A tick turned down while the athlete is
// looking at the set is an ordinary failure: the hook takes it back and the
// usual toast says so. A write waited when it could not go out as it was
// made — the three cases below. Only the first two are seen from outside the
// write, by `watchQueue`.
const waited = new WeakSet();

// The clients whose replay has met a refusal, from the first one until nothing
// of the workout is left to send. One replay, one message: counting on the
// toast still being on screen would not do, it leaves after six seconds and a
// queue on a slow network takes longer.
const refusing = new WeakSet();

const WORKOUT_KEY_ROOTS = new Set(
  Object.entries(MUTATION_KEYS)
    .filter(([name]) => !DRAFT_MUTATIONS.has(name))
    .map(([, key]) => key[0])
);

function isPendingWorkoutWrite(mutation) {
  const key = mutation.options.mutationKey;
  return mutation.state.status === 'pending' && Array.isArray(key) && WORKOUT_KEY_ROOTS.has(key[0]);
}

function watchQueue(queryClient) {
  const cache = queryClient.getMutationCache();
  cache.subscribe((event) => {
    const { mutation } = event;
    if (event.type === 'added') {
      // 1. Restored from IndexedDB: the only mutations that are built with a
      //    state. A new one starts idle.
      if (mutation.state.status !== 'idle') waited.add(mutation);
    } else if (event.type === 'updated') {
      // 2. Held back because the device was offline — at the tap, or when a
      //    retry came due. The test on the device matters: React Query also
      //    calls a mutation paused while it stands behind another one of its
      //    scope, a few hundred milliseconds on a perfectly good network.
      const { action } = event;
      const heldBack = action.type === 'pause' || (action.type === 'pending' && action.isPaused);
      if (heldBack && !onlineManager.isOnline()) waited.add(mutation);
    }
    // The replay is over once nothing of the workout is left to send. Read on
    // every event rather than on the settling of a write: `clear()` empties
    // the queue without settling anything.
    if (refusing.has(queryClient) && !cache.getAll().some(isPendingWorkoutWrite)) {
      refusing.delete(queryClient);
    }
  });
}

function refuseReplay(client, mutation, name, error, userId) {
  markRefusedReplay(error);
  recordRejectedWrite({
    refused_at: new Date().toISOString(),
    made_at: mutation.state.submittedAt ? new Date(mutation.state.submittedAt).toISOString() : null,
    user_id: userId ?? null,
    write: name,
    variables: mutation.state.variables,
    code: error.code,
    message: error.message ?? null,
  });
  if (refusing.has(client)) return;
  refusing.add(client);
  pushToast(REPLAY_REFUSED_KEY, { kind: 'error' });
}

function queuedWrite(name, send) {
  return async function write(variables, context) {
    const client = context?.client;
    const gated = !!client && queueClients.has(client);
    let madeAt;
    let userId;
    if (gated) {
      const mutation = mutationOf(client, variables);
      if (!mutation) return abandoned();
      // When the athlete made this write — see `tapTime`.
      madeAt = mutation.state.submittedAt;
      const session = await readSession();
      if (!session || !ownsQueue(client, session)) {
        // 3. Kept waiting for its owner to be signed in.
        waited.add(mutation);
        throw new AuthNotReadyError();
      }
      userId = session.user?.id;
      // Reading the session can last as long as a token refresh does.
      if (!mutationOf(client, variables)) return abandoned();
    }
    try {
      return await send(variables, { madeAt });
    } catch (error) {
      const mutation = gated ? mutationOf(client, variables) : undefined;
      if (mutation && isTransientError(error)) {
        const rank = (unanswered.get(mutation) ?? 0) + 1;
        unanswered.set(mutation, rank);
        rankTransientFailure(error, rank);
      } else if (mutation && waited.has(mutation) && !DRAFT_MUTATIONS.has(name) && isClosedToAthlete(error)) {
        // A draft has its own answer to 42501 — see `draftSaveErrorHandler`.
        refuseReplay(client, mutation, name, error, userId);
      }
      throw error;
    }
  };
}

export const MUTATION_FNS = {
  toggleDone: queuedWrite('toggleDone', toggleDoneFn),
  setFailed: queuedWrite('setFailed', setFailedFn),
  setRpe: queuedWrite('setRpe', setRpeFn),
  logActual: queuedWrite('logActual', logActualFn),
  setSkipped: queuedWrite('setSkipped', setSkippedFn),
  confirmSession: queuedWrite('confirmSession', confirmSessionFn),
  unconfirmSession: queuedWrite('unconfirmSession', unconfirmSessionFn),
  saveSlotComment: queuedWrite('saveSlotComment', saveSlotCommentFn),
  saveSlotDeviation: queuedWrite('saveSlotDeviation', saveSlotDeviationFn),
  saveDraftTree: queuedWrite('saveDraftTree', saveDraftTreeFn),
  discardDraft: queuedWrite('discardDraft', discardDraftFn),
};

// --- a draft that is ahead of the server -------------------------------------------
//
// The tree in `['draft-tree', programId]` carries a marker while it holds edits
// the database has not accepted (lib/draftTree.js has the marker itself). Here
// is where a save settles it, and what is done with a tree that still has one.
//
// A save that failed used to leave nothing behind. Its mutation ends in
// `error`, which the persister does not store, and the next read of the server
// put the tree of BEFORE the edits back in the cache: the reconcile below after
// a relaunch, or any refetch once the cache was two minutes old. For a draft
// created without a network the server has no row at all, so the read answered
// "no draft" and the whole of it was gone — right after a toast had said "it's
// saved on this device". And nothing sent it again before the next edit; a
// draft that was SUBMITTED cannot be edited, so that one was never sent.

const DRAFT_TREE = 'draft-tree';
const MY_DRAFT = 'my-draft';

const draftIdOf = (variables) => variables?.tree?.program?.id ?? null;

// The saves of the queue that have not settled: running, waiting for a retry,
// paused offline or behind another one of their scope.
function pendingDraftSaves(queryClient) {
  return queryClient
    .getMutationCache()
    .findAll({ mutationKey: MUTATION_KEYS.saveDraftTree, status: 'pending' });
}

// The snapshots the database has turned down, by rev, per client. The same
// tree would be turned down again, so it is not sent a second time: it waits
// for the athlete's next edit, which makes a new rev. Kept in memory and not in
// the marker on purpose — after a relaunch the tree is tried once more, which
// is how a refusal that was lifted in the meantime (the coach put the exercise
// back in the library) ends without the athlete having to touch the draft, and
// how one that was not is said again.
const turnedDown = new WeakMap();

function refusedRevs(queryClient) {
  let revs = turnedDown.get(queryClient);
  if (!revs) turnedDown.set(queryClient, (revs = new Set()));
  return revs;
}

// The database holds the snapshot this save carried. The tree is in sync if it
// is still that one. After a later edit it is not: that edit has a save of its
// own, which settles the marker when its answer comes.
function draftSaved(queryClient, variables) {
  const programId = draftIdOf(variables);
  const rev = variables?.rev ?? null;
  if (programId === null || rev === null) return;
  const key = [DRAFT_TREE, programId];
  const tree = queryClient.getQueryData(key);
  if (unsyncedRev(tree) === rev) queryClient.setQueryData(key, markSynced(tree));
}

// The save failed and the tree stays: it is ahead of the server, and marked so.
//
// Only the tree this save was built from is touched. One with another rev has
// been edited since, and that edit's save is on its way. One with no marker
// after a save that had a rev was reconciled to the server in between.
// (Neither has a rev when the save was queued by a build older than the
// marker: that tree gets its marker here.)
//
// `refused`: the database answered, and said no to this snapshot. Two more
// things then. The rev is remembered, so that the same tree is not sent again
// by itself. And a submission the snapshot carried is taken back on this
// device: the save is one transaction, so the database has not recorded it,
// and a submitted draft cannot be edited — it would stay locked on a tree the
// athlete has to change before it can be accepted.
function keepDraft(queryClient, variables, { refused }) {
  const programId = draftIdOf(variables);
  if (programId === null) return;
  const key = [DRAFT_TREE, programId];
  const tree = queryClient.getQueryData(key);
  if (!tree || unsyncedRev(tree) !== (variables.rev ?? null)) return;

  const unsubmit = refused && !!tree.submitted_at;
  let kept = isUnsyncedDraft(tree) ? tree : markUnsynced(tree);
  if (unsubmit) kept = { ...kept, submitted_at: null };
  if (kept !== tree) queryClient.setQueryData(key, kept);
  if (!refused) return;

  refusedRevs(queryClient).add(unsyncedRev(kept));
  if (unsubmit) {
    queryClient.setQueriesData({ queryKey: [MY_DRAFT] }, (mine) =>
      mine?.id === programId && mine.submitted_at ? { ...mine, submitted_at: null } : mine
    );
  }
}

/**
 * What a failed draft save leaves behind, applied via mutation DEFAULTS so a
 * LIVE save and a HYDRATED (post-cold-reload) one behave identically — neither
 * is silent, and neither loses the edits it carried:
 *   - exercise_unavailable → a slot's exercise left the coach library: keep the
 *     tree (so it can be fixed) + a specific toast.
 *   - draft_not_editable / 23505 / 42501 → coach approved/removed it, or a second
 *     device owns the one draft: the server's version is the one that counts.
 *     The marker goes first — it is what keeps a read of the server out.
 *   - no answer (after the retries of the queue) → keep the tree, marked: it is
 *     sent again on reconnect and on return to the app. Said once; the attempts
 *     that follow by themselves are silent.
 *   - any other refusal → keep the tree + the plain toast; like the first case
 *     it waits for the next edit.
 */
function draftSaveErrorHandler(queryClient, error, variables) {
  const code = error?.code;
  const msg = error?.message || '';
  if (/exercise_unavailable/.test(msg)) {
    keepDraft(queryClient, variables, { refused: true });
    pushToast('One exercise is no longer in your coach’s library — remove or replace it.', { kind: 'error' });
    return;
  }
  if (code === '23505' || code === '42501' || /draft_not_editable/.test(msg)) {
    const programId = draftIdOf(variables);
    const tree = programId === null ? undefined : queryClient.getQueryData([DRAFT_TREE, programId]);
    if (isUnsyncedDraft(tree)) queryClient.setQueryData([DRAFT_TREE, programId], markSynced(tree));
    queryClient.invalidateQueries({ queryKey: [MY_DRAFT] });
    queryClient.invalidateQueries({ queryKey: [DRAFT_TREE] });
    return;
  }
  const noAnswer = isTransientError(error);
  keepDraft(queryClient, variables, { refused: !noAnswer });
  if (noAnswer && variables?.resend) return;
  pushToast('Couldn’t sync your draft — it’s saved on this device.', { kind: 'error' });
}

/**
 * True while this device holds draft edits the database does not: a tree in
 * the cache carries the marker, or a draft write is still on its way. The
 * second covers a save queued by a build older than the marker, and a discard
 * — the server still has the draft the athlete has just thrown away, and a
 * read would put it back on the screen until the discard lands.
 *
 * The reconcile below MUST skip its refetch in that case — and the reads of
 * hooks/useAuthoring.js answer a marked tree from the cache for the same
 * reason. A save that ended in error is not asked about: what it left is on
 * the tree (`keepDraft`), or the server already won (the reconcile codes).
 */
export function hasUnsyncedDraft(queryClient) {
  const ahead = queryClient
    .getQueryCache()
    .findAll({ queryKey: [DRAFT_TREE] })
    .some((query) => isUnsyncedDraft(query.state.data));
  if (ahead) return true;
  // Both draft keys start with 'draft-tree': the save and the discard.
  const [root] = MUTATION_KEYS.saveDraftTree;
  return queryClient.getMutationCache().findAll({ mutationKey: [root], status: 'pending' }).length > 0;
}

// Send again every marked tree that nothing is carrying to the database: the
// save of its last edit failed for good (a write that ended in error is not
// stored), or the app was killed before that save was written to the device.
// The snapshot is built from the tree as it is now and goes through the queue
// like any other save — same key, same scope, same retries — so it waits
// behind a save that is already there, pauses without a network and is stored
// with the queue.
function sendUnsyncedDrafts(queryClient) {
  const sending = pendingDraftSaves(queryClient);
  const refused = turnedDown.get(queryClient);
  for (const query of queryClient.getQueryCache().findAll({ queryKey: [DRAFT_TREE] })) {
    const tree = query.state.data;
    const rev = unsyncedRev(tree);
    if (rev === null || refused?.has(rev)) continue;
    if (sending.some((mutation) => mutation.state.variables?.rev === rev)) continue;
    queryClient
      .getMutationCache()
      .build(queryClient, { mutationKey: MUTATION_KEYS.saveDraftTree })
      .execute({ tree: buildSnapshot(tree), rev, resend: true })
      // Settled by the defaults of the key, like every save.
      .catch(() => {});
  }
}

/**
 * Replay mutations queued offline, send again a draft the database does not
 * have, then reconcile the draft caches to the canonical server rows so a coach
 * approval or send-back that happened in the meantime is observed. Client-minted
 * ids echo back, so the reconcile is flicker-free.
 *
 * Nothing happens without a session, or with the session of another account
 * than the one the queue belongs to (`ownsQueue`). The replay would only start
 * each write's wait (see the session gate), and the reconcile would read the
 * drafts as an anonymous request — or as the wrong person. The queue stays
 * paused, which is the state the persister keeps; `useAuth` calls this again
 * when a session appears.
 *
 * The `hasUnsyncedDraft` guard is load-bearing, not defensive: a read of the
 * server while the device is ahead of it would replace the tree that holds the
 * ONLY copy of the unsynced edits — and for a draft created offline the server
 * row doesn't exist yet, so `my-draft` would refetch to null and the whole
 * session's work would disappear. So either the draft is in sync and is read
 * again, or it is not and is sent again; never both.
 *
 * Called from four places that need the exact same semantics: the persister's
 * hydration `onSuccess` and the auth listener (both through
 * `replayQueuedWrites` in lib/queryClient.js), the window `online` listener
 * (AppShell), and the return to the app (the focus listener of
 * lib/queryClient.js).
 *
 * The promise settles when the replay has: with a write waiting for a retry or
 * for a session that can be long, or never. Await it in a test; in the app,
 * never hand it to something that waits (PersistQueryClientProvider holds
 * every query back until the promise of its `onSuccess` settles) — that is
 * what `replayQueuedWrites` is for.
 */
export async function resumeMutationsAndReconcileDrafts(queryClient) {
  const session = await readSession();
  if (!session || !ownsQueue(queryClient, session)) return;
  sendUnsyncedDrafts(queryClient);
  await queryClient.resumePausedMutations();
  if (hasUnsyncedDraft(queryClient)) return;
  queryClient.invalidateQueries({ queryKey: [MY_DRAFT] });
  queryClient.invalidateQueries({ queryKey: [DRAFT_TREE] });
}

// --- what a settled write refreshes ----------------------------------------------
//
// The reads a write makes stale, refreshed when the write settles — accepted
// or not: after a failure the read is what shows the row as it really is. The
// one exception is a replay that met a refusal (`refusing`).
//
// This list used to live in each hook's `onSettled`. A hook only exists while
// its page does. A workout logged without signal is usually sent after the app
// was killed and opened again; the mutations restored from IndexedDB then have
// nothing but the defaults of their key, so nothing refreshed anything: the
// training list kept "Next" on a session whose confirmation had just reached
// the database (or kept it "Done" after a refused one), until a stale timer
// happened to fire. Registered as the `onSettled` of each key, the same list
// serves the write made live and the one replayed after a relaunch.
//
// The consequence for a hook: it adds the optimistic update and its rollback
// (`onMutate`, `onError`) and NO `onSettled` — an option set by the hook
// replaces the default of the same name, it does not run next to it.
//
// The refresh is started and not waited for: `onSettled` holds its mutation
// in `pending` for as long as the promise it returns, and the next write of a
// FIFO scope with it. A write is settled when the database has answered, not
// when the reads it triggers have come back.

// Everything that reads "is this session confirmed", and the three roll-ups a
// confirmation moves: adherence, tonnage and lifetime totals are reduced over
// set_logs inside their query functions, so nothing about their keys changes
// when a session is confirmed. Confirmation is the right moment for those —
// set-log and deviation writes fire on every tap of a workout and would
// re-run the same heavy scans each time.
const CONFIRMATION_READS = [
  'session-confirmation',
  'my-confirmed-session-ids',
  'week-confirmed-session-ids',
  'program-confirmed-session-ids',
  'student-progress-stats',
  'student-records',
  'student-lifetime-stats',
];

/**
 * A confirmation, or its undo, also changes the "Last time" hints — of every
 * session but its own, which a hint never looks at. The athlete's hints are
 * held as fresh for hours (`hintStaleTime` in lib/queryClient.js) because on
 * this device nothing else changes what they are picked from; without this the
 * hint of the next session would show the workout before the one just
 * trained until those hours had passed — across relaunches, the entry is
 * stored.
 *
 * They are FLAGGED, not read again: deriving a hint is a read of the athlete's
 * whole done-set history, and a confirmation must not cost that. A flagged
 * hint is derived when its session is opened, or on the next return to a page
 * that shows it.
 */
function flagLastTimeHints(queryClient, exceptSessionId) {
  queryClient.invalidateQueries({
    queryKey: ['last-performance'],
    refetchType: 'none',
    // ['last-performance', <athlete>, sessionId, exerciseIds]
    predicate: (query) => !exceptSessionId || query.queryKey[2] !== exceptSessionId,
  });
}

// The set-log writes whose `onSettled` has run: settled in all but name, since
// React Query only moves a mutation out of `pending` after that handler.
const settling = new WeakSet();

function refreshAfter(name, queryClient, variables) {
  const refresh = (queryKey) => {
    queryClient.invalidateQueries({ queryKey });
  };
  // The caches of notes and deviations are keyed by session. A write that
  // does not name its session refreshes the whole root: `[root, undefined]`
  // would match nothing.
  const ofSession = (root) => (variables?.sessionId ? [root, variables.sessionId] : [root]);

  switch (name) {
    case 'confirmSession':
    case 'unconfirmSession':
      CONFIRMATION_READS.forEach((root) => refresh([root]));
      flagLastTimeHints(queryClient, variables?.sessionId);
      return;
    case 'saveSlotComment':
      refresh(ofSession('slot-comments'));
      return;
    case 'saveSlotDeviation':
      refresh(ofSession('slot-deviations'));
      return;
    default: {
      // A set-log write. One read for a queue of sets, when the last of them
      // settles: a read made between two queued writes comes back without the
      // second and takes its tick off the screen until that one lands.
      //
      // "The last" is not "the only one still pending". Sets restored after a
      // relaunch keep the per-row scope of their hook and leave together; when
      // two answers arrive in the same turn each write still sees the other as
      // pending, and neither would refresh. So the ones already in this
      // handler are counted out.
      const mine = mutationOf(queryClient, variables);
      if (mine) settling.add(mine);
      const unsettled = queryClient
        .getMutationCache()
        .findAll({ mutationKey: ['set-log'], status: 'pending' })
        .some((mutation) => !settling.has(mutation));
      if (unsettled) return;
      refresh(['set-logs']);
    }
  }
}

/**
 * Register each offline-safe mutation under a stable key so resumed-after-
 * reload mutations (whose closure-bound mutationFn didn't survive JSON
 * persistence) can still execute. A hook keeps the optimistic `onMutate` and
 * its rollback — for a hydrated mutation the optimistic patch was already
 * applied pre-reload — and everything else comes from here.
 *
 * A hook that names one of these keys inherits everything it does not set
 * itself, live as well: the retry policy below is the one a tick made in the
 * gym gets, not only a replay, and so is the refresh of `refreshAfter`.
 *
 * `queueOwner`, when given, answers the id of the account the client's queue
 * belongs to, or null when that is not known — see `ownsQueue`.
 */
export function registerOfflineMutationDefaults(queryClient, { queueOwner } = {}) {
  // From here on this client's writes wait for a session (see the gate), and
  // its queue is watched for the writes that wait (see `waited`).
  if (!queueClients.has(queryClient)) watchQueue(queryClient);
  queueClients.add(queryClient);
  if (queueOwner) queueOwners.set(queryClient, queueOwner);

  for (const [name, key] of Object.entries(MUTATION_KEYS)) {
    const defaults = {
      mutationFn: MUTATION_FNS[name],
      // 'online' pauses the mutation while offline so resumePausedMutations
      // can replay it on reconnect. 'offlineFirst' would run it once without
      // a network: a failed attempt and a second of delay before the pause.
      networkMode: 'online',
      // Wait for a session without limit; re-send up to five times a write
      // that got no answer; never re-send one the database refused. A retry
      // that comes due offline pauses the mutation instead of failing it. Set
      // HERE, per key, and not as the client's default: only these writes are
      // known to be idempotent, and a bare INSERT re-sent after an answer got
      // lost on the way back is a duplicate row.
      retry: mutationRetry,
      retryDelay: mutationRetryDelay,
      // Shared scope serializes queued writes into FIFO order on replay.
      // Without it resumePausedMutations() is a parallel Promise.all, so two
      // opposite writes (confirm → undo queued offline) could settle in
      // whichever order the network finishes them. This global scope is what
      // a write gets whose hook sets none: the confirmation, a note, a
      // deviation. The set-log hooks set a per-row scope instead (see
      // useSetLogs.rowScope), so unrelated rows don't head-of-line-block each
      // other — and React Query stores a mutation's scope with it, so a set
      // restored after a reload is back in its row's scope, not in this one:
      // after a relaunch the sets of different rows leave in parallel.
      // Authoring rides its OWN scope so a stuck draft sync and a stuck
      // workout write stay isolated.
      scope: { id: DRAFT_MUTATIONS.has(name) ? 'draft-tree' : 'offline-writes' },
    };
    if (!DRAFT_MUTATIONS.has(name)) {
      // A write of the workout: the reads it makes stale are refreshed when it
      // settles, live or replayed — see `refreshAfter`. Not while a replay is
      // being refused: those reads would come back with the rows as the
      // database kept them, in place of the workout the athlete is looking at.
      defaults.onSettled = (_data, _error, variables) => {
        if (refusing.has(queryClient)) return;
        refreshAfter(name, queryClient, variables);
      };
    }
    if (name === 'saveDraftTree') {
      // The authoring snapshot save carries its reconcile/toast onError, the
      // my-draft invalidation onSuccess, and skipErrorToast HERE (in defaults)
      // so a hydrated resume behaves exactly like a live save — the review
      // caught that a hydrated failure would otherwise be silent, and that the
      // hook-only onError didn't cover the resumed path. The marker of the
      // tree is settled here for the same reason: a save sent again after a
      // relaunch has no hook around it either.
      Object.assign(defaults, {
        meta: { skipErrorToast: true },
        onSuccess: (_data, variables) => {
          // The marker first: it is what would answer the read below from
          // the cache. And the read is started, not returned — a save is
          // settled when the database has answered, and the next one of the
          // scope must not wait for a refetch (see `refreshAfter`).
          draftSaved(queryClient, variables);
          queryClient.invalidateQueries({ queryKey: [MY_DRAFT] });
        },
        onError: (error, variables) => draftSaveErrorHandler(queryClient, error, variables),
      });
    }
    if (name === 'discardDraft') {
      // Same reasoning as the save above: put the cache refresh in the
      // DEFAULTS so a discard that was queued offline and replayed after a
      // reload clears 'my-draft' exactly like a live one. It keeps the generic
      // error toast — a failed discard is worth telling the student about.
      Object.assign(defaults, {
        onSettled: () => queryClient.invalidateQueries({ queryKey: [MY_DRAFT] }),
      });
    }
    queryClient.setMutationDefaults(key, defaults);
  }
}
