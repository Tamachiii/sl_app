import { QueryClient } from '@tanstack/react-query';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { createStore, get, set, del } from 'idb-keyval';
import { registerOfflineMutationDefaults } from './offlineMutations';

// Only persist the query subtrees the student needs offline. Keeping the
// allow-list narrow avoids blowing up IndexedDB with messages/notifications
// chatter and prevents leaking coach-only fanout queries (`all-confirmations`,
// the dashboard programs roll-up) to the persisted blob.
const PERSISTED_QUERY_ROOTS = new Set([
  'session',
  'set-logs',
  'slot-comments',
  'session-confirmation',
  'set-videos',
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
  // Only persist successfully-resolved queries; an errored query has no useful
  // offline value and would survive reloads as a stale failure.
  return query.state.status === 'success';
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 2,
      retry: 1,
      // offlineFirst lets cached queries resolve while offline (pull from the
      // persisted IndexedDB blob) and pauses any refetch attempts until online.
      networkMode: 'offlineFirst',
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
