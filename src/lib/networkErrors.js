// What a failed write means, and whether sending it again can help.
//
// A write of the offline queue that fails has met one of three things, and the
// queue must not confuse them:
//
//   refused      Postgres or PostgREST read the request and said no — a policy,
//                a constraint, a trigger. The error carries a `code`. The same
//                request gets the same answer: it is not sent again.
//   unanswered   The database never judged the request. It did not leave the
//                phone, its answer did not come back, a proxy answered in its
//                place, or the database said it cannot take a request right
//                now. Sent again a little later, it may well pass: retried a
//                few times, further and further apart.
//   not ready    Nobody is signed in on this device at the moment
//                (`AuthNotReadyError`). Nothing was sent at all, and nothing
//                may be: supabase-js falls back to the anonymous key when it
//                has no session, and the database REFUSES an anonymous write —
//                with a code, like any refusal. The write waits for its owner,
//                as long as it takes.
//
// The shapes below are the ones supabase-js 2.x really produces; the tests of
// this file make them with the real client and a `fetch` that fails.

/**
 * Thrown INSTEAD of sending a queued write while no session can be read: the
 * access token has expired and cannot be refreshed (no network, or a network
 * that does not answer), or the user is signed out. Never a failure of the
 * write — see `mutationRetry`.
 */
export class AuthNotReadyError extends Error {
  constructor(message = 'No session on this device right now: the write waits for its owner') {
    super(message);
    // An own property, so it survives the JSON the persister stores a
    // mutation's `failureReason` as (a class is lost there, a name is not).
    this.name = 'AuthNotReadyError';
  }
}

export function isAuthNotReady(error) {
  return error instanceof AuthNotReadyError || error?.name === 'AuthNotReadyError';
}

// The code of an answer: an SQLSTATE ('42501'), a PostgREST code ('PGRST116')
// or a sentinel of the app's own. Always a string — the numeric `code` of a
// DOMException (20 for AbortError, 23 for TimeoutError) is not one.
function codeOf(error) {
  const code = error?.code;
  return typeof code === 'string' ? code.trim() : '';
}

// Errors thrown as such (not handed back as `{ error }`) that say "the request
// got no answer". The names are the fetch standard's and supabase-js's own.
const UNANSWERED_NAMES = new Set([
  'AbortError',
  'TimeoutError',
  'NetworkError',
  'AuthRetryableFetchError', // auth-js: fetch failed, or the gateway answered 502/503/504
  'FunctionsFetchError', // functions-js: fetch failed
]);

// What the three engines (and Node, and React Native) put in the TypeError of
// a failed fetch. Only used for an error THROWN by fetch: Safari words some of
// them in the language of the phone, which is why the test for what
// postgrest-js hands back does not read the message at all.
const FETCH_FAILED = /failed to fetch|load failed|networkerror|network error|fetch failed|network request failed/i;

/**
 * True when nothing that speaks PostgREST answered the request.
 *
 * - postgrest-js catches a `fetch` that rejects (no network, DNS, TLS, a
 *   connection cut mid-answer, an abort) and a body it cannot parse (a captive
 *   portal's page), and hands back `{ message: 'TypeError: …', code: '' }`:
 *   an EMPTY code, which no answer of the database has.
 * - a gateway that answers in the API's place (a 502 page, a rate limit, the
 *   project waking up) gives `{ message }` with no code at all.
 * - an error thrown by `fetch` itself, or by auth-js around it, is recognised
 *   by its name.
 *
 * False for anything that carries a code (the database or PostgREST answered),
 * for `AuthNotReadyError` (nothing was sent), and for an `Error` that is none
 * of the above — a bug in the app is not a network failure, and re-running it
 * five times helps nobody.
 */
export function isNetworkError(error) {
  if (error === null || typeof error !== 'object') return false;
  if (isAuthNotReady(error)) return false;
  if (error instanceof Error) {
    if (UNANSWERED_NAMES.has(error.name)) return true;
    if (codeOf(error)) return false;
    return error.name === 'TypeError' && FETCH_FAILED.test(error.message || '');
  }
  // A plain object is what supabase-js hands back as `error`. Without a code,
  // the answer did not come from PostgREST.
  return !codeOf(error);
}

// The few codes by which the database, or PostgREST in front of it, says "not
// now" rather than "no":
//   PGRST000–003  PostgREST cannot reach its database, is rebuilding its schema
//                 cache (the `NOTIFY pgrst, 'reload schema'` that ends a
//                 migration), or ran out of pooled connections
//   08xxx         connection exception
//   53xxx         insufficient resources (too many connections, out of memory)
//   57P01–57P03   the server is shutting down, crashed or is starting up
//   57014, 55P03  statement timeout, lock timeout — a migration holding a lock
//   40001, 40P01  serialization failure, deadlock
// Every other code is a refusal.
const BUSY_CODE = /^(?:PGRST00[0-3]|08[0-9A-Z]{3}|53[0-9A-Z]{3}|57P0[1-3]|57014|55P03|40001|40P01)$/;

/** True when the database answered that it cannot take a request right now. */
export function isDatabaseBusy(error) {
  return BUSY_CODE.test(codeOf(error));
}

/** Unanswered, in the sense of the header: sending the same write again can help. */
export function isTransientError(error) {
  return isNetworkError(error) || isDatabaseBusy(error);
}

// --- the retry policy of the queued writes -----------------------------------

/** A transient failure is retried this many times (six attempts in all). */
export const MAX_TRANSIENT_RETRIES = 5;
/** 1 s, 2 s, 4 s, 8 s, 16 s between those attempts: half a minute of bad network. */
export const TRANSIENT_RETRY_CAP_MS = 30_000;
/** A write waiting for a session looks again at most this far apart. */
export const AUTH_WAIT_CAP_MS = 15_000;

const backoff = (n, cap) => Math.min(1000 * 2 ** n, cap);

// React Query hands a retry function ONE number: how many attempts of the
// write have failed so far, whatever the reason. Waiting for a session is not
// a failed send, and must not use up the five retries — it is exactly on a
// network that keeps dropping that the token refresh fails a few times first
// and the write itself fails right after. So `lib/offlineMutations.js` counts
// the transient failures of each write and ranks the error it rethrows (first
// transient failure of this write = 1). An error nobody ranked falls back on
// React Query's count.
const rankOf = new WeakMap();

export function rankTransientFailure(error, rank) {
  if (error !== null && typeof error === 'object') rankOf.set(error, rank);
  return error;
}

function transientFailuresBefore(error, failureCount) {
  const rank = error !== null && typeof error === 'object' ? rankOf.get(error) : undefined;
  return rank === undefined ? failureCount : rank - 1;
}

/**
 * `retry` of the queued writes (set per mutation key by
 * `registerOfflineMutationDefaults`, never as a client-wide default: a write
 * that is not idempotent must not be re-sent blindly).
 *
 * - not ready  → always: the write is never dropped for lack of a session.
 * - unanswered → up to MAX_TRANSIENT_RETRIES times.
 * - refused    → never.
 *
 * With `networkMode: 'online'` a retry that comes due while the device is
 * offline, or the page hidden, does not run and does not fail: React Query
 * pauses the mutation, which is the state the persister keeps and the next
 * `online` event resumes.
 */
export function mutationRetry(failureCount, error) {
  if (isAuthNotReady(error)) return true;
  if (!isTransientError(error)) return false;
  return transientFailuresBefore(error, failureCount) < MAX_TRANSIENT_RETRIES;
}

/** `retryDelay` that goes with `mutationRetry`. */
export function mutationRetryDelay(failureCount, error) {
  if (isAuthNotReady(error)) return backoff(failureCount, AUTH_WAIT_CAP_MS);
  return backoff(transientFailuresBefore(error, failureCount), TRANSIENT_RETRY_CAP_MS);
}
