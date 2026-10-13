import { createElement } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import {
  MutationObserver,
  QueryClient,
  QueryClientProvider,
  focusManager,
  onlineManager,
} from '@tanstack/react-query';
import { persistQueryClientRestore, persistQueryClientSave } from '@tanstack/react-query-persist-client';

// The whole way round, nothing of the app in between mocked: the app's client
// and its options, the real hooks, the library's own save and restore — the
// two functions PersistQueryClientProvider calls — and the string that ends up
// in IndexedDB. Only the two ends are stand-ins: the store (a Map) and the
// database (a list of the requests that reached it).
//
// Every test here has two lives of the app in it: the one that is killed, and
// the one that is opened afterwards on what the first one left on the device.

// --- the device's store ----------------------------------------------------------
// One Map per test. Each launch of the app opens the store once, and what a
// launch wrote stays; what it has not written when it is killed never is — the
// persister writes at most once a second, and a real process that is gone
// writes nothing.
const device = vi.hoisted(() => ({ store: new Map(), opened: [] }));
vi.mock('idb-keyval', () => ({
  createStore: () => {
    const handle = { map: device.store, alive: true };
    device.opened.push(handle);
    return handle;
  },
  get: async (key, handle) => handle.map.get(key),
  set: async (key, value, handle) => {
    if (handle.alive) handle.map.set(key, value);
  },
  del: async (key, handle) => {
    if (handle.alive) handle.map.delete(key);
  },
}));
const BLOB = 'sl-app-rq-cache';
const onDevice = () => (device.store.has(BLOB) ? JSON.parse(device.store.get(BLOB)) : undefined);
const putOnDevice = (blob) => device.store.set(BLOB, JSON.stringify(blob));

// --- the database ----------------------------------------------------------------
// Each request is noted when it is SENT, in the order it left, and answered by
// `db.answer` — at once and with a row unless a test says otherwise.
const db = vi.hoisted(() => {
  const state = { sent: [], session: null, answer: null };
  const send = (request) => {
    state.sent.push(request);
    return state.answer(request);
  };
  function from(table) {
    const request = { table, op: null, payload: undefined, where: {} };
    let answered;
    const run = () => (answered ??= send(request));
    const builder = {
      update(payload) {
        Object.assign(request, { op: 'update', payload });
        return builder;
      },
      upsert(payload, options) {
        Object.assign(request, { op: 'upsert', payload, options });
        return builder;
      },
      insert(payload) {
        Object.assign(request, { op: 'insert', payload });
        return builder;
      },
      delete() {
        request.op = 'delete';
        return builder;
      },
      select: () => builder,
      eq(column, value) {
        request.where[column] = value;
        return builder;
      },
      single: run,
      maybeSingle: run,
      // `await supabase.from(…).delete().eq(…)`
      then: (onFulfilled, onRejected) => run().then(onFulfilled, onRejected),
    };
    return builder;
  }
  const supabase = {
    from,
    rpc: (fn, args) => send({ table: null, op: 'rpc', fn, payload: args, where: {} }),
    auth: { getSession: async () => ({ data: { session: state.session }, error: null }) },
  };
  return { state, supabase };
});
vi.mock('./supabase', () => ({ supabase: db.supabase }));
vi.mock('./toast', () => ({ pushToast: vi.fn() }));
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u-1' } }) }));

import { pushToast } from './toast';

const accepted = async () => ({ data: { id: 'row' }, error: null });
// What postgrest-js hands back when `fetch` failed.
const noAnswer = async () => ({
  data: null,
  error: { message: 'TypeError: Failed to fetch', details: '', hint: '', code: '' },
});
// The requests as a list one can read: "update set_logs l-1 done=true".
const wire = () =>
  db.state.sent.map(({ table, op, fn, payload, where }) => {
    if (op === 'rpc') return `rpc ${fn}`;
    const target = where.id ?? where.session_id ?? where.exercise_slot_id ?? payload?.session_id ?? payload?.exercise_slot_id;
    const what = payload && 'done' in payload ? ` done=${payload.done}` : '';
    return `${op} ${table} ${target}${what}`;
  });

const SESSION = { access_token: 'jwt', user: { id: 'u-1' } };
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function deviceIs(online) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
}

// --- the app ---------------------------------------------------------------------
// As a page load finds it: its modules evaluated again, on a browser that has
// IndexedDB. React Query itself is not evaluated again — its managers are one
// object for the whole file.
const running = [];
async function launchApp() {
  onlineManager.setOnline(true);
  vi.resetModules();
  const [client, offline, persistence] = await Promise.all([
    import('./queryClient'),
    import('./offlineMutations'),
    import('./persistence'),
  ]);
  client.queryClient.mount();
  const app = { ...client, ...offline, ...persistence, storage: device.opened.at(-1) };
  running.push(app);
  return app;
}

// The real hooks, of the same evaluation of the modules as the app they are
// rendered in.
async function hooksOf() {
  const [setLogs, confirmation, comments] = await Promise.all([
    import('../hooks/useSetLogs'),
    import('../hooks/useSessionConfirmation'),
    import('../hooks/useSlotComments'),
  ]);
  return { ...setLogs, ...confirmation, ...comments };
}

function rendered(app, useHook) {
  const wrapper = ({ children }) => createElement(QueryClientProvider, { client: app.queryClient }, children);
  return renderHook(useHook, { wrapper }).result;
}

// iOS takes the app out of memory. Nothing of it runs any more: no listener, no
// retry that wakes up, no mutation left to resume.
function kill(app) {
  cleanup();
  app.storage.alive = false;
  app.queryClient.unmount();
  app.queryClient.clear();
  running.splice(running.indexOf(app), 1);
}

// What PersistQueryClientProvider does on a change of the cache, and at mount.
const save = (app) => persistQueryClientSave({ queryClient: app.queryClient, ...app.persistOptions });
const restore = (app) => persistQueryClientRestore({ queryClient: app.queryClient, ...app.persistOptions });

// The app killed, then opened again on what it left on the device.
async function relaunch(app, { online = true } = {}) {
  if (app) kill(app);
  deviceIs(online);
  const next = await launchApp();
  await restore(next);
  return next;
}

const queue = (app) => app.queryClient.getMutationCache().getAll();
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

// A write as a hook makes it, for the keys that have no hook to themselves here.
function enqueue(app, mutationKey, variables) {
  const mutation = app.queryClient.getMutationCache().build(app.queryClient, { mutationKey });
  mutation.execute(variables).catch(() => {});
  return mutation;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('indexedDB', {});
  device.store = new Map();
  device.opened = [];
  db.state.sent = [];
  db.state.session = SESSION;
  db.state.answer = accepted;
  deviceIs(true);
});

afterEach(() => {
  cleanup();
  while (running.length) kill(running[0]);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete navigator.onLine;
  onlineManager.setOnline(true);
  focusManager.setFocused(undefined);
});

// A set ticked in the basement: the app's client, the real hook, no network.
async function tickOffline({ logId = 'l-1', done = true } = {}) {
  deviceIs(false);
  const app = await launchApp();
  const { useToggleSetDone } = await hooksOf();
  // What the logging page shows, so that the hook has something to roll back.
  app.queryClient.setQueryData(['set-logs', 's-1', ['slot-1']], [{ id: logId, done: !done }]);
  const toggle = rendered(app, () => useToggleSetDone(logId));
  await act(async () => {
    toggle.current.mutate({ logId, done });
    await vi.waitFor(() => expect(queue(app).map((m) => m.state.isPaused)).toEqual([true]));
    // The hook has patched the list and taken its snapshot for a rollback.
    await vi.waitFor(() => expect(queue(app)[0].state.context).toBeDefined());
  });
  return { app, toggle, mutation: queue(app)[0] };
}

// --- P22: which writes are stored, and how -----------------------------------------

describe('what the device stores of a write', () => {
  it('the key, the scope, the variables and the moment of the tap — and not the snapshot its hook took', async () => {
    const { app, mutation } = await tickOffline();
    // The hook's rollback: every cached list of sets, as it was before the tap.
    expect(mutation.state.context).toBeDefined();

    await save(app);

    const { mutations, queries } = onDevice().clientState;
    expect(mutations).toHaveLength(1);
    expect(mutations[0].mutationKey).toEqual(app.MUTATION_KEYS.toggleDone);
    expect(mutations[0].scope).toEqual(mutation.options.scope);
    expect(mutations[0].state).toMatchObject({
      status: 'pending',
      isPaused: true,
      variables: { logId: 'l-1', done: true },
      submittedAt: mutation.state.submittedAt,
    });
    expect(mutations[0].state).not.toHaveProperty('context');
    // The tick itself is on the device: the page restored after a kill shows it.
    expect(queries.find((query) => query.queryKey[0] === 'set-logs').state.data).toEqual([
      expect.objectContaining({ id: 'l-1', done: true }),
    ]);
  });

  it('saving changes nothing in the mutation that is running: its hook still has what it needs to roll back', async () => {
    db.state.answer = () => new Promise(() => {});
    const app = await launchApp();
    const { useToggleSetDone } = await hooksOf();
    app.queryClient.setQueryData(['set-logs', 's-1', ['slot-1']], [{ id: 'l-1', done: false }]);
    const toggle = rendered(app, () => useToggleSetDone('l-1'));
    act(() => toggle.current.mutate({ logId: 'l-1', done: true }));
    await vi.waitFor(() => expect(db.state.sent).toHaveLength(1));
    const [mutation] = queue(app);
    const before = mutation.state;
    expect(before.context).toBeDefined();

    await save(app);

    expect(onDevice().clientState.mutations[0].state.isPaused).toBe(true);
    expect(onDevice().clientState.mutations[0].state).not.toHaveProperty('context');
    expect(mutation.state).toBe(before);
    expect(mutation.state.isPaused).toBe(false);
  });

  it('a mutation without a key of the queue is not stored: restored, it would have no function to run', async () => {
    deviceIs(false);
    const app = await launchApp();
    // What a page does when it opens: a housekeeping write, no key at all.
    const housekeeping = new MutationObserver(app.queryClient, { mutationFn: async () => 'done' });
    housekeeping.mutate({ sessionId: 's-1' }).catch(() => {});
    // And a keyed one that is not a write of the queue.
    enqueue(app, ['messages', 'mark-read'], 'coach-1');
    await vi.waitFor(() => expect(queue(app).map((m) => m.state.isPaused)).toEqual([true, true]));

    await save(app);

    expect(onDevice().clientState.mutations).toEqual([]);
    // After a relaunch there is nothing to fail, and nothing is said.
    const next = await relaunch(app);
    await next.replayQueuedWrites();
    expect(queue(next)).toEqual([]);
    expect(pushToast).not.toHaveBeenCalled();
  });

  it('a blob written by the build that stored them gives none of them back: no "Couldn\'t save that" for a session that was only opened', async () => {
    // As the app published on 2026-10-13 writes it: everything that is paused.
    const { app, mutation } = await tickOffline();
    const tick = { mutationKey: mutation.options.mutationKey, scope: mutation.options.scope, state: mutation.state };
    const ensureLogs = { state: { ...mutation.state, variables: { sessionId: 's-1', slots: [] } } };
    const markRead = { mutationKey: ['paused-elsewhere'], state: { ...mutation.state, variables: 'coach-1' } };
    putOnDevice({
      buster: app.CACHE_BUSTER,
      timestamp: Date.now(),
      clientState: { queries: [], mutations: [ensureLogs, tick, markRead] },
    });

    const next = await relaunch(app);

    expect(queue(next).map((m) => m.options.mutationKey)).toEqual([next.MUTATION_KEYS.toggleDone]);
    await next.replayQueuedWrites();
    expect(wire()).toEqual(['update set_logs l-1 done=true']);
    expect(pushToast).not.toHaveBeenCalled();
  });

  it('a write that settled is not stored: accepted or refused, the device owes nothing', async () => {
    const app = await launchApp();
    const accepted_ = enqueue(app, app.MUTATION_KEYS.toggleDone, { logId: 'l-1', done: true });
    await vi.waitFor(() => expect(accepted_.state.status).toBe('success'));
    db.state.answer = async () => ({ data: null, error: { code: '42501', message: 'new row violates row-level security policy' } });
    const refused = enqueue(app, app.MUTATION_KEYS.saveSlotComment, { slotId: 'slot-1', studentId: 'u-1', body: 'heavy' });
    await vi.waitFor(() => expect(refused.state.status).toBe('error'));

    await save(app);

    expect(onDevice().clientState.mutations).toEqual([]);
  });
});

describe('a write that is not paused when the app is killed', () => {
  it('its request is out and no answer comes: the write is stored as waiting, and sent again at the next launch', async () => {
    db.state.answer = () => new Promise(() => {});
    const app = await launchApp();
    const mutation = enqueue(app, app.MUTATION_KEYS.toggleDone, { logId: 'l-1', done: true });
    await vi.waitFor(() => expect(db.state.sent).toHaveLength(1));
    // Not what the library stores: it keeps the mutations that are paused.
    expect(mutation.state).toMatchObject({ status: 'pending', isPaused: false });

    await save(app);
    expect(onDevice().clientState.mutations).toHaveLength(1);
    expect(onDevice().clientState.mutations[0].state).toMatchObject({ status: 'pending', isPaused: true });

    db.state.answer = accepted;
    const next = await relaunch(app);
    await next.replayQueuedWrites();

    expect(wire()).toEqual(['update set_logs l-1 done=true', 'update set_logs l-1 done=true']);
    expect(queue(next)[0].state.status).toBe('success');
  });

  it('it sleeps between two attempts on a network that does not answer: stored, with its attempts to make again', async () => {
    db.state.answer = noAnswer;
    const app = await launchApp();
    const mutation = enqueue(app, app.MUTATION_KEYS.toggleDone, { logId: 'l-1', done: true });
    await vi.waitFor(() => expect(mutation.state.failureCount).toBe(1));
    expect(mutation.state).toMatchObject({ status: 'pending', isPaused: false });

    await save(app);
    expect(onDevice().clientState.mutations[0].state).toMatchObject({
      status: 'pending',
      isPaused: true,
      failureCount: 0,
      failureReason: null,
      variables: { logId: 'l-1', done: true },
    });

    db.state.answer = accepted;
    const next = await relaunch(app);
    await next.replayQueuedWrites();

    expect(db.state.sent).toHaveLength(2);
    expect(queue(next)[0].state.status).toBe('success');
  });

  it('it waits for someone to sign in: stored, kept through a launch without a session, sent when there is one', async () => {
    db.state.session = null;
    const app = await launchApp();
    const mutation = enqueue(app, app.MUTATION_KEYS.toggleDone, { logId: 'l-1', done: true });
    await vi.waitFor(() => expect(mutation.state.failureCount).toBe(1));
    expect(mutation.state.isPaused).toBe(false);
    await save(app);

    // Opened again, the token still cannot be refreshed.
    const second = await relaunch(app);
    await second.replayQueuedWrites();
    expect(db.state.sent).toEqual([]);
    expect(queue(second)).toHaveLength(1);
    await save(second);
    expect(onDevice().clientState.mutations).toHaveLength(1);

    // And once more, signed in.
    db.state.session = SESSION;
    const third = await relaunch(second);
    await third.replayQueuedWrites();

    expect(wire()).toEqual(['update set_logs l-1 done=true']);
    expect(queue(third)[0].state.status).toBe('success');
  });

  it('whatever state a stored write is found in, it comes back as one that waits: nothing stays in the way of its scope', async () => {
    // A blob in which a write is "pending, not paused": never resumed by the
    // library, and the first pending one of its scope for good.
    const { app, mutation } = await tickOffline();
    const stuck = {
      mutationKey: mutation.options.mutationKey,
      scope: mutation.options.scope,
      state: { ...mutation.state, isPaused: false, failureCount: 3 },
    };
    const behind = {
      mutationKey: mutation.options.mutationKey,
      scope: mutation.options.scope,
      state: { ...mutation.state, variables: { logId: 'l-1', done: false } },
    };
    // And one that had ended: refused or accepted, it is not owed, and
    // restored it would be neither resumed nor ever collected as waiting.
    const ended = {
      mutationKey: mutation.options.mutationKey,
      scope: mutation.options.scope,
      state: { ...mutation.state, status: 'error', isPaused: false, variables: { logId: 'l-9', done: true } },
    };
    putOnDevice({
      buster: app.CACHE_BUSTER,
      timestamp: Date.now(),
      clientState: { queries: [], mutations: [stuck, ended, behind] },
    });

    const next = await relaunch(app);
    expect(queue(next).map((m) => m.state)).toEqual([
      expect.objectContaining({
        isPaused: true,
        failureCount: 0,
        variables: expect.objectContaining({ logId: 'l-1', done: true }),
      }),
      expect.objectContaining({ isPaused: true, variables: { logId: 'l-1', done: false } }),
    ]);
    await next.replayQueuedWrites();

    expect(wire()).toEqual(['update set_logs l-1 done=true', 'update set_logs l-1 done=false']);
  });
});

// --- P66: a blob of another version, or too old ------------------------------------

describe('a blob the reads of which are no longer wanted', () => {
  // The device after a workout without signal: what was read, and what is owed.
  async function workoutOnDevice() {
    const { app } = await tickOffline();
    app.queryClient.setQueryData(['session', 's-1'], { id: 's-1', title: 'Legs' });
    await save(app);
    expect(onDevice().clientState.queries.map((query) => query.queryKey[0]).sort()).toEqual(['session', 'set-logs']);
    return app;
  }

  it('a change of CACHE_BUSTER drops what was read and keeps what is owed', async () => {
    const app = await workoutOnDevice();
    // The blob as an older build left it.
    putOnDevice({ ...onDevice(), buster: 'sl-app-cache-v0' });

    const next = await relaunch(app);

    expect(next.queryClient.getQueryCache().getAll()).toEqual([]);
    expect(queue(next).map((m) => m.state.variables)).toEqual([expect.objectContaining({ logId: 'l-1', done: true })]);
    await next.replayQueuedWrites();
    expect(wire()).toEqual(['update set_logs l-1 done=true']);
    // And the blob is not thrown away behind the app's back either.
    expect(device.store.has(BLOB)).toBe(true);
  });

  it('the same, said with two builds: one writes under a buster, the next one reads under another', async () => {
    const { createCachePersistence } = await launchApp();
    const { registerOfflineMutationDefaults, MUTATION_KEYS } = await import('./offlineMutations');
    const storage = {
      getItem: async (key) => device.store.get(key),
      setItem: async (key, value) => void device.store.set(key, value),
      removeItem: async (key) => void device.store.delete(key),
    };
    const build = (buster) => {
      const queryClient = new QueryClient();
      registerOfflineMutationDefaults(queryClient);
      const persistOptions = createCachePersistence({
        storage,
        key: BLOB,
        maxAge: 14 * DAY,
        buster,
        shouldPersistQuery: () => true,
      });
      return { queryClient, persistOptions };
    };

    onlineManager.setOnline(false);
    const before = build('v1');
    before.queryClient.setQueryData(['session', 's-1'], { id: 's-1' });
    before.queryClient
      .getMutationCache()
      .build(before.queryClient, { mutationKey: MUTATION_KEYS.confirmSession })
      .execute({ sessionId: 's-1', studentId: 'u-1', notes: null, performedOn: '2026-10-13' })
      .catch(() => {});
    await turn();
    await save(before);
    expect(onDevice()).toMatchObject({ buster: 'v1' });

    const same = build('v1');
    await restore(same);
    expect(same.queryClient.getQueryData(['session', 's-1'])).toEqual({ id: 's-1' });
    expect(same.queryClient.getMutationCache().getAll()).toHaveLength(1);

    const bumped = build('v2');
    await restore(bumped);
    expect(bumped.queryClient.getQueryData(['session', 's-1'])).toBeUndefined();
    expect(bumped.queryClient.getMutationCache().getAll().map((m) => m.state.variables.sessionId)).toEqual(['s-1']);
    before.queryClient.clear();
    same.queryClient.clear();
    bumped.queryClient.clear();
  });

  it('two weeks without opening the app: the reads are gone, the workout is still sent', async () => {
    const app = await workoutOnDevice();
    putOnDevice({ ...onDevice(), timestamp: Date.now() - app.PERSIST_MAX_AGE_MS - MINUTE });

    const next = await relaunch(app);

    expect(next.queryClient.getQueryCache().getAll()).toEqual([]);
    await next.replayQueuedWrites();
    expect(wire()).toEqual(['update set_logs l-1 done=true']);
  });

  it('a blob one minute younger than that gives everything back', async () => {
    const app = await workoutOnDevice();
    putOnDevice({ ...onDevice(), timestamp: Date.now() - app.PERSIST_MAX_AGE_MS + MINUTE });

    const next = await relaunch(app);

    expect(next.queryClient.getQueryData(['session', 's-1'])).toEqual({ id: 's-1', title: 'Legs' });
    expect(queue(next)).toHaveLength(1);
  });

  it('a blob without a date is too old', async () => {
    const app = await workoutOnDevice();
    const { timestamp: _none, ...undated } = onDevice();
    putOnDevice(undated);

    const next = await relaunch(app);

    expect(next.queryClient.getQueryCache().getAll()).toEqual([]);
    expect(queue(next)).toHaveLength(1);
  });

  it('a draft that is ahead of the server goes through with the queue, and the pointer to it: it is the only copy', async () => {
    const app = await launchApp();
    const ahead = { id: 'p-1', name: 'My block', weeks: [], unsynced: { rev: 7 } };
    const inSync = { id: 'p-2', name: 'Sent back', weeks: [] };
    app.queryClient.setQueryData(['draft-tree', 'p-1'], ahead);
    app.queryClient.setQueryData(['my-draft', 'u-1'], { id: 'p-1', name: 'My block' });
    app.queryClient.setQueryData(['draft-tree', 'p-2'], inSync);
    app.queryClient.setQueryData(['session', 's-1'], { id: 's-1' });
    await save(app);
    putOnDevice({ ...onDevice(), buster: 'sl-app-cache-v0' });

    const next = await relaunch(app, { online: false });

    expect(next.queryClient.getQueryCache().getAll().map((query) => query.queryKey).sort()).toEqual([
      ['draft-tree', 'p-1'],
      ['my-draft', 'u-1'],
    ]);
    expect(next.queryClient.getQueryData(['draft-tree', 'p-1'])).toEqual(ahead);
    expect(next.hasUnsyncedDraft(next.queryClient)).toBe(true);
  });

  it('what is on the device is not a blob at all: the app starts empty, and says nothing', async () => {
    const app = await launchApp();
    device.store.set(BLOB, 'null');
    await restore(app);
    device.store.set(BLOB, '42');
    await restore(app);
    device.store.set(BLOB, JSON.stringify({ buster: app.CACHE_BUSTER, timestamp: Date.now(), clientState: 'x' }));
    await restore(app);

    expect(queue(app)).toEqual([]);
    expect(app.queryClient.getQueryCache().getAll()).toEqual([]);
  });

  it('the keys a device may hold a write under are the registered ones — a key that is retired takes the writes made under it along', async () => {
    const { MUTATION_KEYS, isQueueKey } = await launchApp();

    // The queue goes through every change of CACHE_BUSTER, so a write made
    // under one of these keys by ANY earlier build is replayed by the function
    // registered under it today. A key that leaves this list is a workout
    // thrown away at the next launch of a phone that still holds one. So:
    // never remove or rename a key; a write whose variables change shape gets
    // a NEW key next to the old one, and the old function stays.
    expect(Object.values(MUTATION_KEYS).map((key) => key.join(' / ')).sort()).toEqual([
      'draft-tree / discard',
      'draft-tree / save',
      'session-confirmation / confirm',
      'session-confirmation / unconfirm',
      'set-log / log-actual',
      'set-log / set-failed',
      'set-log / set-rpe',
      'set-log / set-skipped',
      'set-log / toggle-done',
      'slot-comment / save',
      'slot-deviation / save',
    ]);
    // Exactly those: a longer or a shorter key is another mutation.
    expect(isQueueKey(['set-log', 'toggle-done'])).toBe(true);
    expect(isQueueKey(['set-log'])).toBe(false);
    expect(isQueueKey(['set-log', 'toggle-done', 'l-1'])).toBe(false);
    expect(isQueueKey('set-log')).toBe(false);
    expect(isQueueKey(undefined)).toBe(false);
  });
});

// --- B19: whose cache it is --------------------------------------------------------

describe('the blob says whose it is', () => {
  it('nobody\'s until the app says: a blob is not labelled with an account nobody named', async () => {
    const { app } = await tickOffline();
    await save(app);

    expect(onDevice().owner).toBeNull();
    expect(app.queryPersister.getOwner()).toBeNull();
  });

  it('the account the app names is written with the next save, and read back at the next launch', async () => {
    const { app } = await tickOffline();
    app.queryPersister.setOwner('u-1');
    await save(app);
    expect(onDevice().owner).toBe('u-1');

    const next = await relaunch(app);

    expect(next.queryPersister.getOwner()).toBe('u-1');
  });

  it('named after the last change of the cache, it is written all the same', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const app = await launchApp();
    app.queryClient.setQueryData(['session', 's-1'], { id: 's-1' });
    await save(app);
    expect(onDevice().owner).toBeNull();

    // Nothing else happens in the cache; the persister writes once a second.
    app.queryPersister.setOwner('u-1');
    await vi.advanceTimersByTimeAsync(1000);

    expect(onDevice().owner).toBe('u-1');
    expect(onDevice().clientState.queries).toHaveLength(1);
  });

  it('a state taken for one account and written after the wipe still says whose it was', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const app = await launchApp();
    app.queryPersister.setOwner('u-1');
    app.queryClient.setQueryData(['session', 's-1'], { id: 's-1' });
    await save(app);
    // A second save inside the same second waits for the throttle…
    app.queryClient.setQueryData(['session', 's-2'], { id: 's-2' });
    const late = save(app);
    // …the account signs out, the device is wiped, another account signs in…
    app.queryClient.clear();
    await app.queryPersister.removeClient();
    app.queryPersister.setOwner('u-2');
    // …and the write of the first account's state lands after all.
    await vi.advanceTimersByTimeAsync(1000);
    await late;

    // It is on the device under the first account's name, not the second's:
    // the next launch can tell that it is not the cache of who is signed in.
    expect(onDevice().clientState.queries).toHaveLength(2);
    expect(onDevice().owner).toBe('u-1');
    expect(app.queryPersister.getOwner()).toBe('u-2');
  });

  it('removeClient forgets the owner with the blob', async () => {
    const { app } = await tickOffline();
    app.queryPersister.setOwner('u-1');
    await save(app);

    await app.queryPersister.removeClient();

    expect(device.store.has(BLOB)).toBe(false);
    expect(app.queryPersister.getOwner()).toBeNull();
  });

  it('a blob written before the blobs said whose they were has no owner', async () => {
    const { app } = await tickOffline();
    await save(app);
    const { owner: _unknown, ...legacy } = onDevice();
    putOnDevice(legacy);

    const next = await relaunch(app);

    expect(next.queryPersister.getOwner()).toBeNull();
    expect(queue(next)).toHaveLength(1);
  });

  it('the queue of one account is not replayed under the session of another: it stays as it is, and leaves when its owner is back', async () => {
    const { app } = await tickOffline();
    app.queryPersister.setOwner('u-someone-else');
    await save(app);

    // Opened with a network, by 'u-1'.
    const next = await relaunch(app);
    await next.replayQueuedWrites();

    expect(db.state.sent).toEqual([]);
    expect(queue(next)[0].state).toMatchObject({ status: 'pending', isPaused: true });

    db.state.session = { access_token: 'jwt', user: { id: 'u-someone-else' } };
    await next.replayQueuedWrites();

    expect(wire()).toEqual(['update set_logs l-1 done=true']);
  });

  it('nor is a write that is already on its way: asked again at each attempt, it waits like a write without a session', async () => {
    const app = await launchApp();
    app.queryPersister.setOwner('u-someone-else');
    const mutation = enqueue(app, app.MUTATION_KEYS.toggleDone, { logId: 'l-1', done: true });

    await vi.waitFor(() => expect(mutation.state.failureCount).toBe(1));
    expect(mutation.state.status).toBe('pending');
    expect(db.state.sent).toEqual([]);

    // The account the queue belongs to signs in: the next attempt goes out.
    db.state.session = { access_token: 'jwt', user: { id: 'u-someone-else' } };
    await vi.waitFor(() => expect(mutation.state.status).toBe('success'), { timeout: 3000 });
    expect(wire()).toEqual(['update set_logs l-1 done=true']);
  });

  it('a queue whose owner is not known is replayed by whoever is signed in, as before', async () => {
    const { app } = await tickOffline();
    await save(app);
    expect(onDevice().owner).toBeNull();

    const next = await relaunch(app);
    await next.replayQueuedWrites();

    expect(wire()).toEqual(['update set_logs l-1 done=true']);
  });

  it('the queue kept through a change of version is still its owner\'s; a blob that gives nothing back is nobody\'s', async () => {
    const { app } = await tickOffline();
    app.queryPersister.setOwner('u-1');
    await save(app);
    putOnDevice({ ...onDevice(), buster: 'sl-app-cache-v0' });
    const withQueue = await relaunch(app);
    expect(withQueue.queryPersister.getOwner()).toBe('u-1');

    putOnDevice({ ...onDevice(), buster: 'sl-app-cache-v0', clientState: { queries: onDevice().clientState.queries, mutations: [] } });
    const withNothing = await relaunch(withQueue);
    expect(withNothing.queryPersister.getOwner()).toBeNull();
  });
});
