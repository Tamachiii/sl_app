import { QueryClient, MutationCache, focusManager, onlineManager } from '@tanstack/react-query';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { createStore, get, set, del } from 'idb-keyval';
import {
  registerOfflineMutationDefaults,
  resumeMutationsAndReconcileDrafts,
} from './offlineMutations';
import { pushToast } from './toast';
import { mutationErrorKey, isRefusedReplay } from './mutationErrors';
import { isUnsyncedDraft } from './draftTree';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// React Query's idea of "online" is `onlineManager`, and left alone it is wrong
// in the one situation the offline layer exists for. It starts at `true` and
// only moves on a window `online` / `offline` EVENT: no event fires at launch,
// so an app opened without signal believed it was online. The queue restored
// from IndexedDB was then replayed at once, every request failed, and a failed
// mutation is not persisted again — the sets and the confirmation logged in
// the basement were gone on the next launch.
//
// So the state is READ from `navigator.onLine`: once here, before anything can
// run, and again whenever the page is shown — iOS resumes a suspended PWA
// without firing either event, and a manager stuck on "offline" would hold
// every request back. `online` / `offline` are listened to here as well, as
// React Query only listens while a client is mounted.
//
// `navigator.onLine === false` is the reliable half of that property (no
// network interface at all). `true` promises nothing: a request can still fail,
// which is what the retry policy of the queued writes is for.
function syncOnlineManager() {
  onlineManager.setOnline(typeof navigator === 'undefined' ? true : navigator.onLine !== false);
}

syncOnlineManager();
if (typeof window !== 'undefined') {
  for (const type of ['online', 'offline', 'pageshow']) {
    window.addEventListener(type, syncOnlineManager);
  }
  document.addEventListener('visibilitychange', syncOnlineManager);
}

// How long this device keeps what it has read. One number, because three
// things have to agree on it:
//   - `maxAge` of the persisted cache (App.jsx): a cache that was not written
//     for that long is thrown away as a whole;
//   - `gcTime` of the persisted roots (below): how long an entry nobody
//     observes stays in memory — and what leaves memory is written out of
//     IndexedDB on the next save;
//   - the age at which `shouldPersistQuery` stops storing one entry.
// The second was the client's default, five minutes. A session opened at home
// was out of the device before the athlete reached the gym, and the list of
// confirmed sessions — observed by the training list only — was gone five
// minutes into any workout, which is what makes the list start again from
// week 1 on the next launch without a network.
export const PERSIST_MAX_AGE_MS = 14 * DAY;

// The entries of a session that is finished are stored for this long after its
// confirmation: time to read the coach's feedback without a network. With
// nothing collected for fourteen days, they would otherwise pile up in what is
// written to the device on every change of the cache.
export const CONFIRMED_SESSION_KEPT_MS = 7 * DAY;

// Only persist the query subtrees the student needs offline. Keeping the
// allow-list narrow avoids blowing up IndexedDB with messages/notifications
// chatter and prevents leaking coach-only fanout queries (`all-confirmations`,
// the dashboard programs roll-up) to the persisted blob.
export const PERSISTED_QUERY_ROOTS = Object.freeze([
  'session',
  'set-logs',
  'slot-comments',
  'slot-deviations',
  'session-confirmation',
  'set-videos',
  // The StudentTraining list source — without these two an offline cold start
  // dead-ends on a spinner (program details) or renders WRONG data
  // (confirmations missing → Home regresses to week 1, adherence reads 0/N).
  // Both cache plain arrays/objects, so they survive JSON persistence;
  // useMyConfirmedSessionIds derives its Set via `select`, not in the cache.
  'student-program-details',
  'my-confirmed-session-ids',
  // The "last time" hint on the logging surface. Its cached value is the small
  // reduced object from buildLastPerformance (not the 20k-row scan behind it),
  // and the surface is student-only — so a gym with no signal still shows the
  // student a number to beat.
  'last-performance',
  // Phase 3.4d — offline program authoring. The optimistic draft tree +
  // "my draft" pointer must survive a cold offline reload so a student can keep
  // building with no connection; 'exercise-library' rides along so the picker
  // and slot names still render offline. All three cache plain JSON, and a
  // purely-offline setQueryData tree has status 'success' → persisted.
  'my-draft',
  'draft-tree',
  'exercise-library',
]);

const PERSISTED = new Set(PERSISTED_QUERY_ROOTS);

// The roots whose entries belong to ONE session, and where its id sits in
// their key.
const SESSION_ID_AT = {
  session: 1,
  'set-logs': 1,
  'slot-comments': 1,
  'slot-deviations': 1,
  'session-confirmation': 1,
  'set-videos': 1,
  // ['last-performance', <athlete>, sessionId, exerciseIds]
  'last-performance': 2,
};

const idbStore =
  typeof indexedDB !== 'undefined'
    ? createStore('sl-app-rq-cache', 'queries')
    : null;

// idb-keyval falls back to throwing when indexedDB is missing (older Safari,
// some test runners); guard the storage shim so the queryClient still imports
// cleanly. PersistQueryClientProvider treats undefined persister as a no-op.
const queryStorage = idbStore
  ? {
      getItem: (key) => get(key, idbStore),
      setItem: (key, value) => set(key, value, idbStore),
      removeItem: (key) => del(key, idbStore),
    }
  : null;

export const queryPersister = queryStorage
  ? createAsyncStoragePersister({
      storage: queryStorage,
      key: 'sl-app-rq-cache',
      throttleTime: 1000,
      serialize: serializeCache,
    })
  : null;

// A draft whose edits the database does not have (lib/draftTree.js): the tree
// that carries the marker, and the pointer to it — for a draft created without
// a network the server has no row at all, and without the pointer the builder
// would say "no draft".
function holdsUnsyncedDraft(root, data) {
  if (root === 'draft-tree') return isUnsyncedDraft(data);
  if (root === 'my-draft') {
    return !!data?.id && isUnsyncedDraft(queryClient.getQueryData(['draft-tree', data.id]));
  }
  return false;
}

// Read off the confirmation this device holds for the session. A session whose
// confirmation is not in the cache is not known to be finished: its entries
// stay until they are too old themselves.
function confirmedLongAgo(sessionId, now) {
  if (!sessionId) return false;
  const confirmation = queryClient.getQueryData(['session-confirmation', sessionId]);
  const confirmedAt = Date.parse(confirmation?.confirmed_at ?? '');
  return Number.isFinite(confirmedAt) && now - confirmedAt > CONFIRMED_SESSION_KEPT_MS;
}

/**
 * Whether an entry of the cache is written to the device. Asked for every
 * entry each time the cache is saved (`dehydrateOptions` in App.jsx).
 *
 * It is also what takes entries OFF the device. With `gcTime` at
 * PERSIST_MAX_AGE_MS nothing is collected in an app that is opened every day —
 * the timers start again at each launch — so an entry that is left out here is
 * simply not there after the next launch. Two rules do that: an entry that was
 * not read or written for PERSIST_MAX_AGE_MS, and the entries of a session
 * confirmed more than CONFIRMED_SESSION_KEPT_MS ago.
 */
export function shouldPersistQuery(query, now = Date.now()) {
  const key = Array.isArray(query.queryKey) ? query.queryKey : [];
  const root = key[0];
  if (typeof root !== 'string' || !PERSISTED.has(root)) return false;
  // Only the 'active' program-details variant is persisted: the 'all'
  // variant (Sessions-page history) can run to hundreds of KB, and the
  // persister re-serializes the WHOLE cache blob on every (1s-throttled)
  // cache event — offline cold-start only needs the active block anyway.
  if (root === 'student-program-details' && key[2] !== 'active') return false;

  const { status, data, dataUpdatedAt } = query.state;
  // Whatever holds data, whether or not the last attempt to refresh it worked.
  // A refresh that fails leaves the data in place and the status on 'error' —
  // one request lost in a basement — and storing only 'success' took the
  // session off the device at that moment. A read that never succeeded has
  // nothing to store.
  if (status !== 'success' && data === undefined) return false;

  // The only copy of what the athlete wrote: never left out, whatever its age.
  if (holdsUnsyncedDraft(root, data)) return true;

  if (dataUpdatedAt > 0 && now - dataUpdatedAt > PERSIST_MAX_AGE_MS) return false;

  const sessionIdAt = SESSION_ID_AT[root];
  if (sessionIdAt !== undefined && confirmedLongAgo(key[sessionIdAt], now)) return false;

  return true;
}

// An entry as it is stored: what was read, and nothing about the attempt that
// failed after it. React Query restores a status as it finds it, so an entry
// stored as 'error' would come back as a failed read at the next launch —
// which, without a network, it stays: a page that asks `isError` first would
// show a failure in front of the workout the device holds. `isInvalidated` is
// kept (a failed fetch sets it): the entry is read again as soon as it can be.
function asLastRead(dehydratedQuery) {
  const { state } = dehydratedQuery;
  if (state.status !== 'error' || state.data === undefined) return dehydratedQuery;
  return {
    ...dehydratedQuery,
    state: { ...state, status: 'success', error: null, fetchFailureCount: 0, fetchFailureReason: null },
  };
}

/** What the persister writes to IndexedDB: the saved cache, as a string. */
export function serializeCache(persistedClient) {
  const { clientState } = persistedClient;
  return JSON.stringify({
    ...persistedClient,
    clientState: { ...clientState, queries: (clientState?.queries ?? []).map(asLastRead) },
  });
}

// Global safety net so no mutation failure is silent. A mutation can opt out
// of the toast (it surfaces the error itself) by setting
// meta: { skipErrorToast: true } — used by composers that render inline
// errors. Offline replays that fail transiently still toast (the write was
// rejected, the user should know); the OfflineBanner covers the still-paused
// case separately.
//
// One failure has been spoken for by the time it gets here: a write of the
// workout that waited for the network and was then refused because its
// session was closed in between. `lib/offlineMutations.js` says it once for
// the whole queue — twenty sets are one message, not twenty toasts.
const mutationCache = new MutationCache({
  onError: (error, _vars, _ctx, mutation) => {
    if (isRefusedReplay(error)) return;
    if (mutation.options.meta?.skipErrorToast) return;
    pushToast(mutationErrorKey(error), { kind: 'error' });
  },
});

export const queryClient = new QueryClient({
  mutationCache,
  defaultOptions: {
    queries: {
      staleTime: 2 * MINUTE,
      retry: 1,
      // 'online': without a network a read is not attempted, it waits
      // (`fetchStatus: 'paused'`) and runs when the device is back — React
      // Query continues paused reads on the manager's offline → online step.
      // What the cache holds is rendered either way: data restored from
      // IndexedDB does not depend on this mode.
      //
      // It was 'offlineFirst', which always makes the first attempt. Nothing
      // can answer it — the service worker caches no API response — and
      // postgrest-js re-sends a failed GET after 1 s, 2 s and 4 s before it
      // gives up, so every read of an offline launch held its spinner for
      // 7 s, twice with `retry: 1`, and then ended as an ERROR. An errored
      // read is not picked up when the network returns unless the manager was
      // offline in between, and it never was (see `syncOnlineManager`).
      networkMode: 'online',
    },
    mutations: {
      // No blind retry as a default. A write that got no answer may still have
      // reached the database, and most writes outside the offline queue are
      // bare INSERTs (a message, a copied session, an extra set): sent twice,
      // they are two rows. The writes of the queue are idempotent and carry a
      // retry policy of their own, per mutation key — see
      // `registerOfflineMutationDefaults` and lib/networkErrors.js.
      retry: 0,
      // 'online' (the default) parks the mutation as paused while offline so
      // resumePausedMutations() can replay it on reconnect.
      networkMode: 'online',
    },
  },
});

registerOfflineMutationDefaults(queryClient);

// One call per root: defaults registered twice under the same key replace each
// other. The `gcTime` is for every persisted root — see PERSIST_MAX_AGE_MS; for
// the two draft roots it is also what keeps the only copy of a draft that is
// ahead of the server (lib/draftTree.js) in the cache while the athlete is on
// another page.
for (const root of PERSISTED_QUERY_ROOTS) {
  queryClient.setQueryDefaults([root], { gcTime: PERSIST_MAX_AGE_MS });
}

// The athlete comes back to the app. A draft in sync is read again — that is
// how one the coach sent back, or approved, shows up without a reload — and
// one that is ahead of the server is sent again instead: the same call as on
// reconnect, which decides between the two (and replays the queue first).
// React Query's manager says "focused" when the page becomes visible.
focusManager.subscribe((focused) => {
  if (!focused) return;
  // Nobody is waiting for this, and a write that fails has its own handling.
  resumeMutationsAndReconcileDrafts(queryClient).catch(() => {});
});

// How long the replay of the queue may make no progress before whoever waits
// for it stops waiting.
export const REPLAY_PATIENCE_MS = 5000;

/**
 * Replay the writes queued on this device, on the app's client. Run when the
 * cache has been restored from IndexedDB (`App.jsx`) and when a session
 * appears (`useAuth`); without a session it replays nothing.
 *
 * The promise it returns is for PersistQueryClientProvider, which lets no
 * query fetch until the promise of its `onSuccess` settles. That wait has a
 * purpose: a read that came back BEFORE the queued writes reached the database
 * would replace the ticked sets on screen with the rows as they were. And it
 * needs a limit: the promise of `resumeMutationsAndReconcileDrafts` settles
 * when the replay has, which is after the retries of a write on a bad network,
 * and never while one waits for someone to sign in — every page would sit on
 * its spinner behind one queued set.
 *
 * So this promise settles when the queue has been replayed, or as soon as the
 * replay has to wait: the device is offline, an attempt failed and will be
 * made again (no answer, no session), or nothing has settled for
 * REPLAY_PATIENCE_MS (a request that hangs — the token refresh included). It
 * never rejects for a write that failed.
 */
export function replayQueuedWrites() {
  let stopWaiting;
  const hasToWait = new Promise((resolve) => {
    stopWaiting = resolve;
  });
  // Offline nothing can move, and reading the session alone may take auth-js
  // half a minute of refresh attempts.
  if (!onlineManager.isOnline()) stopWaiting();
  let patience = setTimeout(stopWaiting, REPLAY_PATIENCE_MS);
  const unsubscribe = queryClient.getMutationCache().subscribe((event) => {
    if (event.type !== 'updated') return;
    const step = event.action.type;
    if (step === 'failed') {
      // An attempt failed and a retry is scheduled.
      stopWaiting();
    } else if (step === 'success' || step === 'error') {
      // A write settled: the queue is moving.
      clearTimeout(patience);
      patience = setTimeout(stopWaiting, REPLAY_PATIENCE_MS);
    }
  });
  return Promise.race([resumeMutationsAndReconcileDrafts(queryClient), hasToWait]).finally(() => {
    clearTimeout(patience);
    unsubscribe();
  });
}
