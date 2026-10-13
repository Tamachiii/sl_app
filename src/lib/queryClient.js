import { QueryClient, MutationCache, onlineManager } from '@tanstack/react-query';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { createStore, get, set, del } from 'idb-keyval';
import { registerOfflineMutationDefaults } from './offlineMutations';
import { pushToast } from './toast';
import { mutationErrorKey } from './mutationErrors';

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

// Only persist the query subtrees the student needs offline. Keeping the
// allow-list narrow avoids blowing up IndexedDB with messages/notifications
// chatter and prevents leaking coach-only fanout queries (`all-confirmations`,
// the dashboard programs roll-up) to the persisted blob.
const PERSISTED_QUERY_ROOTS = new Set([
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
    })
  : null;

export function shouldPersistQuery(query) {
  const root = Array.isArray(query.queryKey) ? query.queryKey[0] : null;
  if (typeof root !== 'string') return false;
  if (!PERSISTED_QUERY_ROOTS.has(root)) return false;
  // Only the 'active' program-details variant is persisted: the 'all'
  // variant (Sessions-page history) can run to hundreds of KB, and the
  // persister re-serializes the WHOLE cache blob on every (1s-throttled)
  // cache event — offline cold-start only needs the active block anyway.
  if (root === 'student-program-details' && query.queryKey[2] !== 'active') {
    return false;
  }
  // Only persist successfully-resolved queries; an errored query has no useful
  // offline value and would survive reloads as a stale failure.
  return query.state.status === 'success';
}

// Global safety net so no mutation failure is silent. A mutation can opt out
// of the toast (it surfaces the error itself) by setting
// meta: { skipErrorToast: true } — used by composers that render inline
// errors. Offline replays that fail transiently still toast (the write was
// rejected, the user should know); the OfflineBanner covers the still-paused
// case separately.
const mutationCache = new MutationCache({
  onError: (error, _vars, _ctx, mutation) => {
    if (mutation.options.meta?.skipErrorToast) return;
    pushToast(mutationErrorKey(error), { kind: 'error' });
  },
});

export const queryClient = new QueryClient({
  mutationCache,
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 2,
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
      retry: 0,
      // 'online' (the default) parks the mutation as paused while offline so
      // resumePausedMutations() can replay it on reconnect. We tried
      // 'offlineFirst' first but that runs the fn once even when offline and
      // simply fails it (since retry=0), which would lose queued writes.
      networkMode: 'online',
    },
  },
});

registerOfflineMutationDefaults(queryClient);
