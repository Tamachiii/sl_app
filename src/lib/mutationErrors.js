// Map a Supabase/Postgres error into a friendly i18n key for the global
// error toast. Coach mutations used to fail silently — a constraint rejection
// (delete an in-use exercise, set sets to 0) did nothing, leaving stale UI.
// This turns the raw error into one readable line.
//
// Matching is on Postgres SQLSTATE codes where available (stable) plus
// constraint-name / message substrings (our own names, also stable). Anything
// unrecognized falls back to a generic "couldn't save" key so no failure is
// ever fully silent.

const CONSTRAINT_KEYS = {
  // Our named CHECK/؜UNIQUE constraints (see schema.sql).
  set_logs_done_xor_failed: 'errors.constraint.setState',
  set_logs_no_rpe_when_failed: 'errors.constraint.setState',
  set_logs_skipped_not_resolved: 'errors.constraint.setState',
  exercise_slots_unit_one_of: 'errors.constraint.slotUnit',
  slot_deviations_swap_has_substitute: 'errors.constraint.deviation',
  sessions_week_sort_order_unique: 'errors.constraint.sessionOrder',
  programs_one_active_per_student: 'errors.constraint.oneActive',
};

export function mutationErrorKey(error) {
  if (!error) return 'errors.generic';
  // Said once for a whole replay by lib/offlineMutations.js; whoever asks for
  // the line of such an error gets the same one.
  if (isRefusedReplay(error)) return REPLAY_REFUSED_KEY;
  const code = error.code || error.details?.code;
  const msg = `${error.message || ''} ${error.details || ''} ${error.hint || ''}`.toLowerCase();

  // The DB triggers (program/week/session) RAISE "… still has N logged
  // set(s) …" (SQLSTATE P0001), and useHardDeleteProgram throws the same-
  // meaning sentinel. Both map to one generic "archive instead" line — the
  // global toast fires for week/session deletes; the program hard-delete
  // opts out (skipErrorToast) and shows its own inline copy.
  if (error.code === 'PROGRAM_HAS_LOGGED_SETS') return 'errors.hasLoggedTraining';
  if (msg.includes('logged set')) return 'errors.hasLoggedTraining';

  // Foreign-key violation: the row is still referenced (e.g. deleting a
  // library exercise that a slot or goal points at).
  if (code === '23503' || msg.includes('foreign key') || msg.includes('still referenced')) {
    return 'errors.inUse';
  }
  // Check-constraint violation (23514) — sets ≤ 0, bad unit, etc.
  if (code === '23514') {
    for (const [name, key] of Object.entries(CONSTRAINT_KEYS)) {
      if (msg.includes(name)) return key;
    }
    return 'errors.constraint.generic';
  }
  // Unique violation (23505).
  if (code === '23505') {
    for (const [name, key] of Object.entries(CONSTRAINT_KEYS)) {
      if (msg.includes(name)) return key;
    }
    return 'errors.duplicate';
  }
  // RLS / permission.
  if (code === '42501' || msg.includes('row-level security') || msg.includes('permission denied')) {
    return 'errors.notAllowed';
  }
  // Named constraint mentioned without a recognized code.
  for (const [name, key] of Object.entries(CONSTRAINT_KEYS)) {
    if (msg.includes(name)) return key;
  }
  return 'errors.generic';
}

// --- a write the database closed while it waited ------------------------------
//
// An athlete's write is accepted while three things hold: the row is theirs,
// their program is the block being trained, and the session is neither
// archived nor reviewed. A write made in the gym without signal is sent hours
// later, and the coach may have moved on in between — activated the next
// block, reviewed the session, removed the set. The database then answers with
// one of two codes, and no other:
//
//   PGRST116  an UPDATE that is read back with `.single()` and matched no row
//             the athlete may write (every set-log write);
//   42501     an INSERT or an upsert a policy turned down (the confirmation, a
//             note, a swap), or a trigger that says so (undoing the
//             confirmation of a reviewed session).
//
// Sent again, it gets the same answer. What `lib/offlineMutations.js` does with
// such a write — one message for the whole queue, the caches left as the
// athlete made them, the write kept in the journal below — is decided there,
// because "was this write held back?" is a question about the mutation. This
// file holds what is about the error.

/** The line shown once for a replay with refused writes (i18n key). */
export const REPLAY_REFUSED_KEY = 'offlineReplay.refused';

const CLOSED_CODES = new Set(['PGRST116', '42501']);

/** True for the two codes by which the database closes a row to its athlete. */
export function isClosedToAthlete(error) {
  const code = error?.code;
  return typeof code === 'string' && CLOSED_CODES.has(code.trim());
}

// The errors `lib/offlineMutations.js` recognised as the refusal of a write
// that had waited. By identity: the mark is read in the same tick, by the
// handlers of the mutation that is failing, and need not outlive the object.
const refusedReplays = new WeakSet();

export function markRefusedReplay(error) {
  if (error !== null && typeof error === 'object') refusedReplays.add(error);
  return error;
}

export function isRefusedReplay(error) {
  return error !== null && typeof error === 'object' && refusedReplays.has(error);
}

// --- the journal of refused writes ---------------------------------------------
//
// A refused replay has no way back into the database from the app, and a
// mutation restored after a relaunch has no screen left to show what it
// carried. So its variables are appended here before the mutation is dropped:
// what the athlete did — which set, done or failed, the RPE, the load, the
// note, the moment — stays on the device, in a form someone can read back and
// enter by hand.
//
// localStorage, not the query cache: the cache is emptied when the account
// changes and is rewritten on every event; this is written a few times in the
// life of an installation. Capped, oldest entries first out.

export const REJECTED_WRITES_KEY = 'sl_rejected_writes';
/** About three full workouts of writes. */
export const REJECTED_WRITES_CAP = 300;

/** The journal, oldest entry first. Never throws: no storage is an empty journal. */
export function readRejectedWrites() {
  try {
    const stored = JSON.parse(localStorage.getItem(REJECTED_WRITES_KEY) || '[]');
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}

/**
 * Append one refused write. `entry` is plain JSON:
 * `{ refused_at, made_at, user_id, write, variables, code, message }`.
 * Returns false when the device would not store it (private mode, quota) —
 * the journal is a last resort and must never fail the code that calls it.
 */
export function recordRejectedWrite(entry) {
  try {
    const journal = [...readRejectedWrites(), entry].slice(-REJECTED_WRITES_CAP);
    localStorage.setItem(REJECTED_WRITES_KEY, JSON.stringify(journal));
    return true;
  } catch {
    return false;
  }
}

/** Empty the journal (its entries were dealt with, or belong to someone else). */
export function clearRejectedWrites() {
  try {
    localStorage.removeItem(REJECTED_WRITES_KEY);
  } catch {
    // nothing to clear where nothing can be stored
  }
}
