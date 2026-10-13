import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { IsRestoringProvider, QueryClient, QueryClientProvider, dehydrate } from '@tanstack/react-query';
import { persistQueryClientRestore, persistQueryClientSave } from '@tanstack/react-query-persist-client';

// `ClearOnUserChange`: the one thing between what an account left on a device
// and the next account that uses it. Tested on the app's real client and its
// real persister — what is asserted is what is in memory and what is in the
// store, not which function was called. (The provider of the same file,
// `CacheBoundary`, is in lib/persistence.test.js with the queue it stores.)

// --- the device's store: one Map per test ------------------------------------------
const device = vi.hoisted(() => ({ store: new Map() }));
vi.mock('idb-keyval', () => ({
  // Each launch of the app opens the store of the test it was launched in.
  createStore: () => device.store,
  get: async (key, store) => store.get(key),
  set: async (key, value, store) => {
    store.set(key, value);
  },
  del: async (key, store) => {
    store.delete(key);
  },
}));
const BLOB = 'sl-app-rq-cache';
const onDevice = () => (device.store.has(BLOB) ? JSON.parse(device.store.get(BLOB)) : undefined);

// --- who is signed in, as useAuth says it ------------------------------------------
const auth = vi.hoisted(() => ({ now: { user: null, isLoading: true } }));
vi.mock('./hooks/useAuth', () => ({
  useAuth: () => auth.now,
  AuthProvider: ({ children }) => children,
}));

vi.mock('./lib/supabase', () => ({
  supabase: {
    from: vi.fn(),
    rpc: vi.fn(),
    auth: { getSession: vi.fn(async () => ({ data: { session: null }, error: null })) },
  },
}));
vi.mock('./lib/toast', () => ({ pushToast: vi.fn() }));
// App.jsx is imported for one component: not the pages, not what it starts at load.
vi.mock('./routes', () => ({ routes: [] }));
vi.mock('./hooks/usePushAutoHeal', () => ({ usePushAutoHeal: () => {} }));
vi.mock('./lib/errorReporter', () => ({
  installGlobalErrorReporting: vi.fn(),
  reportError: vi.fn(),
  setErrorReporterUser: vi.fn(),
}));

const A = 'u-athlete-a';
const B = 'u-athlete-b';
const signedIn = (id) => ({ user: { id }, isLoading: false });
const signedOut = { user: null, isLoading: false };
const loading = { user: null, isLoading: true };

// The app as a page load finds it, on a browser that has IndexedDB.
async function launchApp() {
  vi.resetModules();
  const [{ ClearOnUserChange }, client, persistence] = await Promise.all([
    import('./App'),
    import('./lib/queryClient'),
    import('./lib/persistence'),
  ]);
  return { ClearOnUserChange, ...client, ...persistence };
}

// What an account leaves on a device: a session it read, a set it still owes.
function leftOnDevice({ owner, buster }) {
  const phone = new QueryClient();
  phone.setQueryData(['session', 's-1'], { id: 's-1', title: 'Legs' });
  const clientState = JSON.parse(JSON.stringify(dehydrate(phone)));
  clientState.mutations = [
    {
      mutationKey: ['set-log', 'toggle-done'],
      scope: { id: 'set-log-l-1' },
      state: {
        status: 'pending',
        isPaused: true,
        variables: { logId: 'l-1', done: true },
        submittedAt: Date.now(),
        failureCount: 0,
        failureReason: null,
        error: null,
      },
    },
  ];
  phone.clear();
  device.store.set(
    BLOB,
    JSON.stringify({ buster, timestamp: Date.now(), ...(owner ? { owner } : {}), clientState }),
  );
}

// What PersistQueryClientProvider does at mount, and on a change of the cache.
const restore = (app) => persistQueryClientRestore({ queryClient: app.queryClient, ...app.persistOptions });
const save = (app) => persistQueryClientSave({ queryClient: app.queryClient, ...app.persistOptions });

// The component where App.jsx mounts it: under the cache provider, which says
// whether the stored blob is still being read.
function mount(app, { restoring = false } = {}) {
  const tree = (isRestoring) => (
    <QueryClientProvider client={app.queryClient}>
      <IsRestoringProvider value={isRestoring}>
        <app.ClearOnUserChange />
      </IsRestoringProvider>
    </QueryClientProvider>
  );
  const view = render(tree(restoring));
  let current = restoring;
  return {
    // useAuth hands over something new: the component renders again.
    auth(next) {
      auth.now = next;
      view.rerender(tree(current));
    },
    restored() {
      current = false;
      view.rerender(tree(false));
    },
  };
}

// The app opened on what was left on the device, by whoever is signed in.
async function openOn({ owner, as }) {
  const { CACHE_BUSTER } = await import('./lib/persistence');
  leftOnDevice({ owner, buster: CACHE_BUSTER });
  auth.now = as;
  const app = await launchApp();
  const view = mount(app, { restoring: true });
  await restore(app);
  view.restored();
  return { app, view };
}

const inMemory = (app) => ({
  reads: app.queryClient.getQueryCache().getAll().length,
  writes: app.queryClient.getMutationCache().getAll().length,
});
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.stubGlobal('indexedDB', {});
  device.store = new Map();
  auth.now = loading;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the app is opened on what a device holds', () => {
  it('by the account that left it: the reads and the queued set are there', async () => {
    const { app } = await openOn({ owner: A, as: signedIn(A) });
    await turn();

    expect(inMemory(app)).toEqual({ reads: 1, writes: 1 });
    expect(device.store.has(BLOB)).toBe(true);
    expect(app.queryPersister.getOwner()).toBe(A);
  });

  it('by another account: memory and device are wiped, and nothing of the first one is left to show or to send', async () => {
    const { app } = await openOn({ owner: A, as: signedIn(B) });
    await turn();

    expect(inMemory(app)).toEqual({ reads: 0, writes: 0 });
    expect(device.store.has(BLOB)).toBe(false);
    expect(app.queryPersister.getOwner()).toBe(B);
  });

  it('by nobody — the token could not be refreshed: the cache waits, and is still its owner\'s', async () => {
    const { app } = await openOn({ owner: A, as: signedOut });
    await turn();

    expect(inMemory(app)).toEqual({ reads: 1, writes: 1 });
    expect(device.store.has(BLOB)).toBe(true);
    // Not relabelled as nobody's: the next launch still knows whose it is.
    expect(app.queryPersister.getOwner()).toBe(A);
    await save(app);
    expect(onDevice().owner).toBe(A);
  });

  it('a blob that does not say whose it is is kept, as before, and labelled with the account that opens it', async () => {
    const { app } = await openOn({ owner: undefined, as: signedIn(A) });
    await turn();

    expect(inMemory(app)).toEqual({ reads: 1, writes: 1 });
    expect(app.queryPersister.getOwner()).toBe(A);
    await save(app);
    expect(onDevice().owner).toBe(A);
    expect(onDevice().clientState.mutations).toHaveLength(1);
  });

  it('nothing is decided while auth is still loading, and the first account it reports is not a change', async () => {
    const { app, view } = await openOn({ owner: A, as: loading });
    await turn();
    expect(inMemory(app)).toEqual({ reads: 1, writes: 1 });

    view.auth(signedIn(A));
    await turn();

    expect(inMemory(app)).toEqual({ reads: 1, writes: 1 });
    expect(device.store.has(BLOB)).toBe(true);
  });
});

describe('the signed-in user changes while the app is open', () => {
  it('sign-out: memory and device are wiped, and what is stored next is nobody\'s', async () => {
    const { app, view } = await openOn({ owner: A, as: signedIn(A) });

    view.auth(signedOut);
    await turn();

    expect(inMemory(app)).toEqual({ reads: 0, writes: 0 });
    expect(device.store.has(BLOB)).toBe(false);
    expect(app.queryPersister.getOwner()).toBeNull();
  });

  it('then another account signs in: it starts from nothing, and what it reads is stored under its name', async () => {
    const { app, view } = await openOn({ owner: A, as: signedIn(A) });
    view.auth(signedOut);
    await turn();

    view.auth(signedIn(B));
    app.queryClient.setQueryData(['session', 's-9'], { id: 's-9', title: 'Pull' });
    await save(app);

    expect(app.queryPersister.getOwner()).toBe(B);
    expect(onDevice().owner).toBe(B);
    expect(onDevice().clientState.queries.map((query) => query.queryKey)).toEqual([['session', 's-9']]);
    expect(onDevice().clientState.mutations).toEqual([]);
  });

  it('one account straight after the other, without a sign-out in between: wiped all the same', async () => {
    const { app, view } = await openOn({ owner: A, as: signedIn(A) });

    view.auth(signedIn(B));
    await turn();

    expect(inMemory(app)).toEqual({ reads: 0, writes: 0 });
    expect(device.store.has(BLOB)).toBe(false);
    expect(app.queryPersister.getOwner()).toBe(B);
  });

  it('the same account again is not a change: a token refresh or a return to the tab hands over a new user object', async () => {
    const { app, view } = await openOn({ owner: A, as: signedIn(A) });

    view.auth(signedIn(A));
    view.auth({ ...signedIn(A), isLoading: true });
    view.auth(signedIn(A));
    await turn();

    expect(inMemory(app)).toEqual({ reads: 1, writes: 1 });
    expect(device.store.has(BLOB)).toBe(true);
    expect(app.queryPersister.getOwner()).toBe(A);
  });

  it('a change seen while the stored blob is still being read is acted on once it is there: the restore cannot bring back what the wipe was for', async () => {
    const { CACHE_BUSTER } = await import('./lib/persistence');
    leftOnDevice({ owner: A, buster: CACHE_BUSTER });
    auth.now = signedIn(A);
    const app = await launchApp();
    const view = mount(app, { restoring: true });

    // Signed out before the blob has been read: there is nothing to wipe yet…
    view.auth(signedOut);
    await turn();
    expect(device.store.has(BLOB)).toBe(true);
    // …and the restore then puts the account's cache in memory.
    await restore(app);
    expect(inMemory(app)).toEqual({ reads: 1, writes: 1 });

    view.restored();
    await turn();

    expect(inMemory(app)).toEqual({ reads: 0, writes: 0 });
    expect(device.store.has(BLOB)).toBe(false);
  });
});

describe('on a browser without IndexedDB', () => {
  it('there is no persister, and a change of user still empties the cache in memory', async () => {
    vi.unstubAllGlobals();
    auth.now = signedIn(A);
    const app = await launchApp();
    expect(app.queryPersister).toBeNull();
    app.queryClient.setQueryData(['session', 's-1'], { id: 's-1' });
    const view = mount(app);

    view.auth(signedIn(B));

    expect(inMemory(app)).toEqual({ reads: 0, writes: 0 });
  });
});
