// What this device stores of the app, and what it takes back from the store.
//
// React Query's persister writes the cache to IndexedDB as one blob: the reads
// (`clientState.queries`) and the writes that have not reached the database
// (`clientState.mutations` — the queue). The library treats the two alike. This
// module is where they stop being alike: a read can always be made again, a
// queued write is the only copy of what the athlete did.
//
// Two rules follow, each in one place below:
//   - WHICH writes are stored: the ones of the queue, all of them that have
//     not settled, and nothing else (`isQueuedWrite`);
//   - HOW a write is stored, and taken back: as one that waits (`asWaiting`).

import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { MUTATION_KEYS } from './offlineMutations';

// The version of the stored blob: one written under another value is not read.
export const CACHE_BUSTER = 'sl-app-cache-v1';

const QUEUE_KEYS = Object.values(MUTATION_KEYS);

/**
 * True for the key of a write of the queue: one of `MUTATION_KEYS`, part for
 * part. Compared and not hashed: this is asked of every mutation of the app at
 * every save, and a key that cannot be serialised must not stop the save.
 */
export function isQueueKey(mutationKey) {
  if (!Array.isArray(mutationKey)) return false;
  return QUEUE_KEYS.some(
    (key) => key.length === mutationKey.length && key.every((part, index) => part === mutationKey[index]),
  );
}

/**
 * A write this device still owes the database: made under a key of the queue,
 * and not settled. It is the one definition of "waiting to sync" — what the
 * persister stores (`shouldDehydrateMutation`) and what the offline banner
 * counts.
 *
 * The key is what makes a write replayable. A mutation restored from the store
 * is a key, its variables and nothing else: the function comes from the
 * defaults registered under that key (`registerOfflineMutationDefaults`).
 * Stored without one — the library's default stores whatever is paused — a
 * mutation comes back after a relaunch with no function at all, fails with
 * "No mutationFn found", and tells an athlete who had only OPENED a session
 * without signal that something could not be saved.
 *
 * "Not settled" is wider than "paused", which is all the library stores. A
 * write is paused while the device is offline. On a network that does not
 * answer it is not: its request is out, for as long as the phone lets it hang,
 * or it sleeps between two attempts — and while nobody is signed in it sleeps
 * and looks again for as long as it takes. An app killed in one of those
 * moments, the usual end of an app on a phone, used to lose the write.
 */
export function isQueuedWrite(mutation) {
  return mutation.state.status === 'pending' && isQueueKey(mutation.options.mutationKey);
}

// The same test on a mutation as it is stored.
const isStoredWrite = (stored) => stored?.state?.status === 'pending' && isQueueKey(stored.mutationKey);

// A write as it is stored, and as it is taken back: waiting, and nothing more.
//
// `isPaused` is what `resumePausedMutations` looks for. A write stored while it
// was running or between two attempts would come back as "pending, not
// paused": never resumed, and — being the first pending one of its scope —
// in the way of every write behind it, for good.
//
// What the attempt left behind goes: the failure count and its reason start
// again with the attempts, and `context` is the snapshot a hook took for its
// rollback — every cached set of the athlete, once per queued set. A restored
// write has no hook around it to roll anything back, and that snapshot was
// most of the blob the persister re-writes at each change of the cache.
function asWaiting(stored) {
  return {
    ...stored,
    state: {
      ...stored.state,
      isPaused: true,
      context: undefined,
      data: undefined,
      error: null,
      failureCount: 0,
      failureReason: null,
    },
  };
}

// The queue, in the order the writes were made: the library stores and
// restores the mutations in that order, and with the `scope` each one ran in,
// which is what keeps two writes of the same scope in order when they are
// replayed.
function queueOf(mutations) {
  return Array.isArray(mutations) ? mutations.filter(isStoredWrite).map(asWaiting) : [];
}

/**
 * The persisted cache of the app: the `persistOptions` of
 * PersistQueryClientProvider, as one object so that the persister and the
 * options that go with it cannot be given apart.
 *
 * `persister` is the library's async-storage persister behind the rules of
 * this file.
 */
export function createCachePersistence({
  storage,
  key,
  maxAge,
  shouldPersistQuery,
  serialize,
  throttleTime = 1000,
  buster = CACHE_BUSTER,
}) {
  const store = createAsyncStoragePersister({ storage, key, throttleTime, serialize });

  const persister = {
    persistClient(persistedClient) {
      return store.persistClient({
        ...persistedClient,
        clientState: {
          ...persistedClient.clientState,
          mutations: queueOf(persistedClient.clientState?.mutations),
        },
      });
    },

    // Only the writes of the queue come back, whatever the blob holds: one
    // written by a build that stored every paused mutation would hand back
    // the ones that have no function to run.
    async restoreClient() {
      const found = await store.restoreClient();
      if (!found || typeof found !== 'object') return undefined;
      return {
        ...found,
        clientState: { ...found.clientState, mutations: queueOf(found.clientState?.mutations) },
      };
    },

    removeClient: () => store.removeClient(),
  };

  return {
    persister,
    maxAge,
    buster,
    dehydrateOptions: {
      shouldDehydrateQuery: shouldPersistQuery,
      shouldDehydrateMutation: isQueuedWrite,
    },
  };
}
