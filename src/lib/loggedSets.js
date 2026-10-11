// "Logged" is the athlete's half of a set_logs row: any outcome or measurement
// they recorded on it. ONE definition for the coach surfaces, and it is the
// database's own — the predicate of the block_*_delete_with_logged_sets
// triggers in schema.sql. A row is logged as soon as ONE of these is set, not
// only when it is done: an RPE left on an un-ticked set is still something the
// athlete wrote.
//
// Why it lives here and not in a hook file: the editor's components need the
// predicate to render a lock, and a component importing a helper from
// hooks/useSession would drag the whole hook module into every test that
// stubs it.

/** The columns a read must select for `isLoggedSet` to be meaningful. */
export const LOGGED_SET_COLUMNS = 'done, failed, skipped, rpe, actual_reps, actual_weight_kg';

/** The same predicate as a PostgREST `or=` filter on `set_logs`. */
export const LOGGED_SET_OR_FILTER =
  'done.eq.true,failed.eq.true,skipped.eq.true,rpe.not.is.null,actual_reps.not.is.null,actual_weight_kg.not.is.null';

export function isLoggedSet(log) {
  if (!log) return false;
  return (
    !!log.done ||
    !!log.failed ||
    !!log.skipped ||
    log.rpe != null ||
    log.actual_reps != null ||
    log.actual_weight_kg != null
  );
}

// A video belongs to a set even when the athlete never ticked it. The embed
// `set_log_videos(id)` comes back as an object (the FK is UNIQUE, so the
// relation is to-one) or, on an older PostgREST, as an array.
export function hasSetVideo(log) {
  const v = log?.set_log_videos;
  return Array.isArray(v) ? v.length > 0 : !!v;
}

/** A row the coach's editor must neither delete nor rewrite. */
export function isProtectedSet(log) {
  return isLoggedSet(log) || hasSetVideo(log);
}

/**
 * Narrow an UPDATE on `set_logs` to the rows the athlete has not touched —
 * the exact inverse of `isLoggedSet`, so a target edit can never change what
 * a logged set says the athlete was asked to do.
 */
export function onlyPendingSets(query) {
  return query
    .eq('done', false)
    .eq('failed', false)
    .eq('skipped', false)
    .is('rpe', null)
    .is('actual_reps', null)
    .is('actual_weight_kg', null);
}

export const LOGGED_SETS_ERROR_CODE = 'HAS_LOGGED_SETS';

/**
 * What a coach mutation throws instead of deleting logged training.
 *
 * The WORDING is the contract: lib/mutationErrors maps any message containing
 * "logged set" to `errors.hasLoggedTraining`, which is also what the database
 * guards raise — so the coach reads the same line whichever side refuses. The
 * `code` keeps it out of any "retry what looks like a network error" policy.
 */
export function loggedSetsError() {
  const err = new Error('this still has logged set(s) — archive the session instead of deleting');
  err.code = LOGGED_SETS_ERROR_CODE;
  return err;
}
