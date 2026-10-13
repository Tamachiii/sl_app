// What this device stores of the app, and what it takes back from the store.
//
// React Query's persister writes the cache to IndexedDB as one blob: the reads
// (`clientState.queries`) and the writes that have not reached the database
// (`clientState.mutations` — the queue). The library treats the two alike. This
// module is where they stop being alike: a read can always be made again, a
// queued write is the only copy of what the athlete did.
//
// Three rules follow, each in one place below:
//   - WHICH writes are stored: the ones of the queue, all of them that have
//     not settled, and nothing else (`isQueuedWrite`);
//   - HOW a write is stored: as one that waits (`asWaiting`);
//   - WHAT a stored blob gives back when it is too old or of another version:
//     no read, and every write (`restoreClient`).
//
// The blob also says whose it is (`owner`), so that the app can tell the cache
// of the account that is signed in from one left by another account.

import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { MUTATION_KEYS } from './offlineMutations';
import { isUnsyncedDraft } from './draftTree';

// The version of what is stored of the READS. A blob written under another
// value gives back no read: change it when the shape of a persisted query
// changes in a way the pages cannot read (docs/INVARIANTS.md has the rule).
//
// It is not the version of the queue. A queued write goes through a change of
// this value untouched, and is then replayed by the function registered under
// its key — so a write whose VARIABLES change shape gets a new key in
// `MUTATION_KEYS`, and the old key stays registered, with its old function, for
// as long as a device may still hold a write made under it.
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

// The reads no request can make again: a draft that is ahead of the server
// (lib/draftTree.js) and the pointer to it. They are kept wherever the queue
// is — a save that failed for good leaves no queued write behind, only the
// marked tree, which is sent again at the next launch.
function unsyncedDrafts(queries) {
  const trees = queries.filter((query) => query?.queryKey?.[0] === 'draft-tree' && isUnsyncedDraft(query.state?.data));
  const ids = new Set(trees.map((query) => query.queryKey[1]));
  const pointers = queries.filter((query) => query?.queryKey?.[0] === 'my-draft' && ids.has(query.state?.data?.id));
  return [...pointers, ...trees];
}

/**
 * The persisted cache of the app: the `persistOptions` of
 * PersistQueryClientProvider, as one object so that the persister and the
 * options that go with it cannot be given apart.
 *
 * `persister` is the library's async-storage persister behind the three rules
 * of this file, plus `getOwner()` / `setOwner(userId)`.
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

  // The account whose reads and writes the cache holds, as far as this device
  // knows: read off the blob at launch, then said by the app once it knows who
  // is signed in. Null is "nobody's" or "not known" (a blob written before the
  // blobs said).
  let owner = null;
  // The last state handed over for saving. Nothing changes in the cache without
  // an event, and every event saves, so this is the cache as it is.
  let lastSaved = null;

  const persister = {
    persistClient(persistedClient) {
      lastSaved = {
        ...persistedClient,
        // Of the moment the state was taken, not of the moment it is written:
        // the write is throttled, and the owner may change in between.
        owner,
        clientState: {
          ...persistedClient.clientState,
          mutations: queueOf(persistedClient.clientState?.mutations),
        },
      };
      return store.persistClient(lastSaved);
    },

    /**
     * What the stored blob gives back. The library would throw the WHOLE blob
     * away when it is older than `maxAge` or was written under another
     * `buster` — the queue with it: the one documented way to handle a change
     * of shape deleted the unsynced workout of every device it reached, and so
     * did two weeks without opening the app.
     *
     * So both tests are made here, on the reads alone, and what is handed to
     * the library always passes its own: a blob that is too old or of another
     * version gives back no read, and every write it holds. So does one
     * written by a build that stored more than the queue (a paused mutation
     * without a key): only the writes of the queue come back.
     */
    async restoreClient() {
      const found = await store.restoreClient();
      if (!found || typeof found !== 'object') return undefined;

      const state = found.clientState ?? {};
      const queries = Array.isArray(state.queries) ? state.queries : [];
      // No timestamp is "too old": the comparison with NaN is false.
      const current = found.buster === buster && Date.now() - found.timestamp <= maxAge;
      const clientState = {
        queries: current ? queries : unsyncedDrafts(queries),
        mutations: queueOf(state.mutations),
      };

      const holdsSomething = clientState.queries.length > 0 || clientState.mutations.length > 0;
      owner = holdsSomething && typeof found.owner === 'string' ? found.owner : null;
      return { ...found, buster, timestamp: Date.now(), owner, clientState };
    },

    removeClient() {
      owner = null;
      lastSaved = null;
      return store.removeClient();
    },

    /** The account the cache belongs to, or null — see `owner` above. */
    getOwner: () => owner,

    /**
     * Say whose cache this is. It only labels: a cache that holds another
     * account's data is cleared first, by whoever knows that the account
     * changed (`ClearOnUserChange` in App.jsx).
     */
    setOwner(userId) {
      const next = userId ?? null;
      if (next === owner) return;
      owner = next;
      // Written now, not at the next change of the cache: the label must not
      // depend on something else happening to be saved.
      if (!lastSaved) return;
      lastSaved = { ...lastSaved, owner };
      store.persistClient(lastSaved);
    },
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
