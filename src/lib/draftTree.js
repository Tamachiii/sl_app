// The draft an athlete is writing, as this device holds it.
//
// The builder edits a tree in the query cache (`['draft-tree', programId]`)
// and each edit sends the WHOLE tree to `save_draft_tree`. Between the edit and
// the answer of the database the cache is ahead of the server, and it is the
// only place where the edit exists. That can last: no network, a network that
// does not answer, the app killed before the request left.
//
// So the tree says so itself. An edit puts a marker on it:
//
//   tree.unsynced = { rev }
//
// and the marker stays until the database has accepted a snapshot of exactly
// that tree. It is part of the cached DATA, on purpose: the persister stores
// the data, so the marker is still there after the app was killed and opened
// again — which a mutation that failed is not (lib/persistence.js stores the
// writes that have not settled, and no other).
//
// Three things read it (lib/offlineMutations.js, hooks/useAuthoring.js):
//   - a read of the server never replaces a marked tree;
//   - a marked tree that no queued save carries is sent again when the device
//     reconnects, when the app is opened and when the athlete comes back to it;
//   - a tree without a marker is read again on those same occasions, which is
//     how a draft the coach sent back shows up.
//
// `rev` names one state of the tree. The save of an edit carries the rev of
// the tree it was built from, and only clears a marker that still has that
// rev: two edits in a row are two saves, and the answer to the first one says
// nothing about the second.

let lastRev = 0;

/**
 * A rev no earlier call has returned, larger than any before it. Read off the
 * clock so that it keeps growing across launches too; the counter covers two
 * edits in the same millisecond.
 */
export function nextDraftRev() {
  lastRev = Math.max(Date.now(), lastRev + 1);
  return lastRev;
}

/** The rev of the edits the server does not have yet, or null for a tree in sync. */
export function unsyncedRev(tree) {
  return tree?.unsynced?.rev ?? null;
}

export function isUnsyncedDraft(tree) {
  return unsyncedRev(tree) !== null;
}

/** The same tree, marked as holding edits the server does not have. */
export function markUnsynced(tree, rev = nextDraftRev()) {
  return { ...tree, unsynced: { rev } };
}

/** The same tree without its marker: what the server holds too. */
export function markSynced(tree) {
  if (!tree || !('unsynced' in tree)) return tree;
  const { unsynced: _marker, ...rest } = tree;
  return rest;
}

/**
 * Flatten the nested draft-tree cache into the flat snapshot the RPC expects.
 * Field by field: nothing the cache keeps for itself (the marker above, the
 * `exercise` meta of a slot) reaches the database.
 *
 * XOR guard: exercise_slots require exactly one of reps/duration — the authoring
 * UI only sets reps, so force reps ≥ 1 whenever no duration is present (a blank
 * reps field must never sync as both-null and abort the whole tree at replay).
 */
export function buildSnapshot(tree) {
  const program = { id: tree.id, name: tree.name, submitted_at: tree.submitted_at ?? null };
  const weeks = [];
  const sessions = [];
  const slots = [];
  for (const w of tree.weeks || []) {
    weeks.push({ id: w.id, program_id: tree.id, week_number: w.week_number, label: w.label ?? null });
    for (const s of w.sessions || []) {
      sessions.push({ id: s.id, week_id: w.id, title: s.title, day_number: s.day_number, sort_order: s.sort_order });
      for (const sl of s.exercise_slots || []) {
        const hasDuration = sl.duration_seconds != null;
        slots.push({
          id: sl.id,
          session_id: s.id,
          exercise_id: sl.exercise_id,
          sets: sl.sets ?? 3,
          reps: hasDuration ? (sl.reps ?? null) : (sl.reps ?? 1),
          weight_kg: sl.weight_kg ?? null,
          duration_seconds: sl.duration_seconds ?? null,
          rest_seconds: sl.rest_seconds ?? null,
          sort_order: sl.sort_order ?? 0,
        });
      }
    }
  }
  return { program, weeks, sessions, slots };
}
