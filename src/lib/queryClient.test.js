import { createElement } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import {
  QueryClient,
  QueryObserver,
  MutationObserver,
  dehydrate,
  hydrate,
  onlineManager,
  useQuery,
} from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';

vi.mock('./supabase', () => ({
  supabase: { from: vi.fn(), auth: { getSession: vi.fn() } },
}));
vi.mock('./toast', () => ({ pushToast: vi.fn() }));

import { supabase } from './supabase';

// --- the device ---------------------------------------------------------------
// `navigator.onLine` is what the browser knows; `onlineManager` is what React
// Query believes. The tests move the first and look at the second.
function deviceIs(online) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
}

// The app as a page load finds it: the modules are evaluated again, and React
// Query's manager is back at the value the library gives it — `true`, whatever
// the device says. (The library itself is not re-evaluated by `resetModules`,
// its manager is one object for the whole file, hence the explicit reset.)
async function launchApp() {
  onlineManager.setOnline(true);
  vi.resetModules();
  const [app, offline, errors] = await Promise.all([
    import('./queryClient'),
    import('./offlineMutations'),
    import('./networkErrors'),
  ]);
  // What <QueryClientProvider> does on mount: React Query starts listening to
  // its managers.
  app.queryClient.mount();
  mounted.push(app.queryClient);
  return { ...app, ...offline, ...errors };
}
const mounted = [];

// What the persister wrote to IndexedDB during the workout: one set ticked
// without signal, paused, then through JSON as the persister stores it.
async function queueWrittenOffline() {
  const { registerOfflineMutationDefaults, MUTATION_KEYS } = await import('./offlineMutations');
  onlineManager.setOnline(false);
  const phone = new QueryClient();
  registerOfflineMutationDefaults(phone);
  phone
    .getMutationCache()
    .build(phone, {
      mutationKey: MUTATION_KEYS.toggleDone,
      ...phone.getMutationDefaults(MUTATION_KEYS.toggleDone),
    })
    .execute({ logId: 'l-1', done: true })
    .catch(() => {});
  await new Promise((r) => setTimeout(r, 0));
  const state = JSON.parse(JSON.stringify(dehydrate(phone)));
  expect(state.mutations).toHaveLength(1);
  expect(state.mutations[0].state.isPaused).toBe(true);
  return state;
}

function setLogsAnswer() {
  const chain = {
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: { id: 'l-1', done: true }, error: null }),
  };
  supabase.from.mockReturnValue(chain);
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
  supabase.auth.getSession.mockResolvedValue({
    data: { session: { access_token: 'jwt', user: { id: 'u-1' } } },
    error: null,
  });
  deviceIs(true);
});

afterEach(() => {
  cleanup();
  while (mounted.length) {
    const client = mounted.pop();
    client.unmount();
    client.clear();
  }
  delete navigator.onLine;
  onlineManager.setOnline(true);
});

describe('the app is opened without a network', () => {
  it('React Query starts offline, as the device is', async () => {
    deviceIs(false);

    await launchApp();

    expect(onlineManager.isOnline()).toBe(false);
  });

  it('and starts online on a device that is', async () => {
    deviceIs(true);
    onlineManager.setOnline(false);

    vi.resetModules();
    await import('./queryClient');

    expect(onlineManager.isOnline()).toBe(true);
  });

  it('the queue restored from the device stays paused: nothing is sent, nothing is lost', async () => {
    const chain = setLogsAnswer();
    const stored = await queueWrittenOffline();

    // iOS killed the app; it is opened again, still in the basement.
    deviceIs(false);
    const { queryClient, resumeMutationsAndReconcileDrafts } = await launchApp();
    hydrate(queryClient, stored);
    // What the persister's onSuccess runs once the cache is restored.
    await resumeMutationsAndReconcileDrafts(queryClient);

    expect(supabase.from).not.toHaveBeenCalled();
    const [mutation] = queryClient.getMutationCache().getAll();
    expect(mutation.state.status).toBe('pending');
    expect(mutation.state.isPaused).toBe(true);
    // Still what the persister keeps (it stores paused mutations), so a second
    // kill before the network returns loses nothing either.
    expect(dehydrate(queryClient).mutations).toHaveLength(1);

    // Back upstairs.
    deviceIs(true);
    window.dispatchEvent(new Event('online'));

    await vi.waitFor(() => expect(mutation.state.status).toBe('success'));
    expect(supabase.from).toHaveBeenCalledTimes(1);
    expect(supabase.from).toHaveBeenCalledWith('set_logs');
    expect(chain.update.mock.calls[0][0]).toMatchObject({ done: true, failed: false });
  });

  it('a read is not attempted: it waits, and runs when the network returns', async () => {
    deviceIs(false);
    const { queryClient } = await launchApp();
    const queryFn = vi.fn().mockResolvedValue([{ id: 'p-1' }]);

    const observer = new QueryObserver(queryClient, {
      queryKey: ['student-program-details', 'u-1', 'active'],
      queryFn,
    });
    const unsubscribe = observer.subscribe(() => {});

    // At once — not after a first attempt has run out of retries.
    expect(queryFn).not.toHaveBeenCalled();
    expect(observer.getCurrentResult()).toMatchObject({
      status: 'pending',
      fetchStatus: 'paused',
      isPaused: true,
      // Not "loading": a page must not spin on a read that is not running.
      isLoading: false,
    });

    deviceIs(true);
    window.dispatchEvent(new Event('online'));

    await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual([{ id: 'p-1' }]));
    expect(queryFn).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('what the cache already holds is served while the read waits', async () => {
    deviceIs(false);
    const { queryClient } = await launchApp();
    // Restored from IndexedDB, and stale by now.
    queryClient.setQueryData(['session', 's-1'], { id: 's-1', title: 'Push A' }, { updatedAt: 1 });
    const queryFn = vi.fn().mockResolvedValue({ id: 's-1', title: 'Push A (edited)' });

    const observer = new QueryObserver(queryClient, { queryKey: ['session', 's-1'], queryFn });
    const unsubscribe = observer.subscribe(() => {});

    expect(queryFn).not.toHaveBeenCalled();
    expect(observer.getCurrentResult()).toMatchObject({
      status: 'success',
      fetchStatus: 'paused',
      data: { id: 's-1', title: 'Push A' },
    });
    unsubscribe();
  });
});

describe('the state follows the device, with or without an event', () => {
  it('a page shown again reads the device: iOS resumes a PWA without an online event', async () => {
    deviceIs(false);
    await launchApp();
    expect(onlineManager.isOnline()).toBe(false);

    // The phone found a network while the app was suspended. No `online` event.
    deviceIs(true);
    document.dispatchEvent(new Event('visibilitychange'));

    expect(onlineManager.isOnline()).toBe(true);
  });

  it('a page restored from the back-forward cache reads it too', async () => {
    await launchApp();

    deviceIs(false);
    window.dispatchEvent(new Event('pageshow'));
    expect(onlineManager.isOnline()).toBe(false);

    deviceIs(true);
    window.dispatchEvent(new Event('pageshow'));
    expect(onlineManager.isOnline()).toBe(true);
  });

  it('and the other way round: suspended online, resumed in the basement', async () => {
    await launchApp();
    expect(onlineManager.isOnline()).toBe(true);

    deviceIs(false);
    document.dispatchEvent(new Event('visibilitychange'));

    expect(onlineManager.isOnline()).toBe(false);
  });

  it('a queue paused by a resume without network is replayed by the next one with it', async () => {
    const chain = setLogsAnswer();
    const stored = await queueWrittenOffline();
    deviceIs(false);
    const { queryClient } = await launchApp();
    hydrate(queryClient, stored);
    const [mutation] = queryClient.getMutationCache().getAll();

    deviceIs(true);
    document.dispatchEvent(new Event('visibilitychange'));

    await vi.waitFor(() => expect(mutation.state.status).toBe('success'));
    expect(chain.single).toHaveBeenCalledTimes(1);
  });

  it('the offline event is heard before any client is mounted', async () => {
    onlineManager.setOnline(true);
    vi.resetModules();
    await import('./queryClient'); // imported, nothing mounted

    deviceIs(false);
    window.dispatchEvent(new Event('offline'));

    expect(onlineManager.isOnline()).toBe(false);
  });
});

describe('the writes of the queue, on the app\'s client', () => {
  it('carry the retry policy: every registered key, whoever names it', async () => {
    const { queryClient, MUTATION_KEYS, mutationRetry, mutationRetryDelay } = await launchApp();

    for (const key of Object.values(MUTATION_KEYS)) {
      // What a hook gets when it passes the key and its own function.
      const options = queryClient.defaultMutationOptions({ mutationKey: key, mutationFn: vi.fn() });
      expect(options.retry).toBe(mutationRetry);
      expect(options.retryDelay).toBe(mutationRetryDelay);
      expect(options.networkMode).toBe('online');
    }
  });

  it('a write outside the queue is not sent twice: a bare INSERT that got no answer may have been written', async () => {
    const { queryClient } = await launchApp();
    // What postgrest-js hands back when `fetch` failed.
    const noAnswer = { message: 'TypeError: Failed to fetch', details: '', hint: '', code: '' };
    const sendMessage = vi.fn().mockRejectedValue(noAnswer);
    const observer = new MutationObserver(queryClient, { mutationFn: sendMessage });

    await expect(observer.mutate({ body: 'hello' })).rejects.toBe(noAnswer);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(observer.getCurrentResult().status).toBe('error');
  });

  it('a write of the queue waits for a session, live as well', async () => {
    setLogsAnswer();
    supabase.auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    const { queryClient, MUTATION_KEYS, MUTATION_FNS, isAuthNotReady } = await launchApp();
    const observer = new MutationObserver(queryClient, {
      mutationKey: MUTATION_KEYS.toggleDone,
      mutationFn: MUTATION_FNS.toggleDone,
    });

    observer.mutate({ logId: 'l-1', done: true }).catch(() => {});

    await vi.waitFor(() => expect(isAuthNotReady(observer.getCurrentResult().failureReason)).toBe(true));
    expect(observer.getCurrentResult().status).toBe('pending');
    expect(supabase.from).not.toHaveBeenCalled();
  });
});

// What PersistQueryClientProvider is given as `onSuccess`. The provider lets no
// query fetch until that promise settles — wanted while the queue is being
// replayed, fatal if the replay waits.
describe('replayQueuedWrites: the pages wait for the queue while it moves, and only then', () => {
  // The persister, as far as the provider uses it: it hands back what was stored.
  const persisterHolding = (clientState) => ({
    persistClient: vi.fn(),
    removeClient: vi.fn(),
    restoreClient: async () => ({ timestamp: Date.now(), buster: '', clientState }),
  });

  const readProgram = vi.fn(async () => 'Bloc 3');
  function Training() {
    const { data, fetchStatus } = useQuery({
      queryKey: ['student-program-details', 'u-1', 'active'],
      queryFn: readProgram,
    });
    return createElement('p', null, data ?? `no program (${fetchStatus})`);
  }

  // The app as App.jsx mounts it, on a device whose IndexedDB holds `stored`.
  function mountApp({ queryClient, replayQueuedWrites }, stored) {
    render(
      createElement(
        PersistQueryClientProvider,
        { client: queryClient, persistOptions: { persister: persisterHolding(stored) }, onSuccess: replayQueuedWrites },
        createElement(Training),
      ),
    );
    return queryClient;
  }

  const restoredWrite = (queryClient) =>
    vi.waitFor(() => {
      const [mutation] = queryClient.getMutationCache().getAll();
      expect(mutation).toBeDefined();
      return mutation;
    });

  // What postgrest-js hands back when `fetch` failed.
  const noAnswer = { message: 'TypeError: Failed to fetch', details: '', hint: '', code: '' };

  beforeEach(() => readProgram.mockClear());

  it('no read is made while a queued write is on its way: it would come back without the write', async () => {
    const chain = setLogsAnswer();
    let answerTheWrite;
    chain.single.mockReturnValue(new Promise((resolve) => { answerTheWrite = resolve; }));
    const stored = await queueWrittenOffline();
    const queryClient = mountApp(await launchApp(), stored);

    const mutation = await restoredWrite(queryClient);
    await vi.waitFor(() => expect(chain.single).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(mutation.state.status).toBe('pending');
    expect(readProgram).not.toHaveBeenCalled();

    answerTheWrite({ data: { id: 'l-1', done: true }, error: null });

    expect(await screen.findByText('Bloc 3')).toBeInTheDocument();
    expect(mutation.state.status).toBe('success');
  });

  it('the pages are let go as soon as a write has to be sent again', async () => {
    const chain = setLogsAnswer();
    chain.single.mockResolvedValue({ data: null, error: noAnswer });
    const stored = await queueWrittenOffline();
    const queryClient = mountApp(await launchApp(), stored);

    // Long before the first retry (1 s), let alone the last (31 s).
    expect(await screen.findByText('Bloc 3')).toBeInTheDocument();
    const [mutation] = queryClient.getMutationCache().getAll();
    expect(mutation.state).toMatchObject({ status: 'pending', failureCount: 1 });
    expect(chain.single).toHaveBeenCalledTimes(1);
  });

  it('and at once when nobody is signed in: nothing is replayed, the queue stays paused', async () => {
    setLogsAnswer();
    supabase.auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    const stored = await queueWrittenOffline();
    const queryClient = mountApp(await launchApp(), stored);

    expect(await screen.findByText('Bloc 3')).toBeInTheDocument();
    const [mutation] = queryClient.getMutationCache().getAll();
    expect(mutation.state).toMatchObject({ status: 'pending', isPaused: true });
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('and at once without a network, whatever the session read is doing', async () => {
    setLogsAnswer();
    // An expired token, offline: auth-js keeps trying to refresh it for a
    // while before it answers.
    supabase.auth.getSession.mockReturnValue(new Promise(() => {}));
    const stored = await queueWrittenOffline();
    deviceIs(false);
    const queryClient = mountApp(await launchApp(), stored);

    // The read is released — and, offline, paused rather than attempted.
    expect(await screen.findByText('no program (paused)')).toBeInTheDocument();
    expect(readProgram).not.toHaveBeenCalled();
    const [mutation] = queryClient.getMutationCache().getAll();
    expect(mutation.state).toMatchObject({ status: 'pending', isPaused: true });
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('a write that waits for a session after all does not hold them either', async () => {
    setLogsAnswer();
    // A session when the replay starts, none when the write asks for it: the
    // token ran out in between and its refresh got no answer.
    supabase.auth.getSession
      .mockResolvedValueOnce({ data: { session: { access_token: 'jwt', user: { id: 'u-1' } } }, error: null })
      .mockResolvedValue({ data: { session: null }, error: null });
    const stored = await queueWrittenOffline();
    const app = await launchApp();
    const queryClient = mountApp(app, stored);

    expect(await screen.findByText('Bloc 3')).toBeInTheDocument();
    const [mutation] = queryClient.getMutationCache().getAll();
    expect(mutation.state.status).toBe('pending');
    expect(app.isAuthNotReady(mutation.state.failureReason)).toBe(true);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  describe('a request that hangs', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('is waited for as long as REPLAY_PATIENCE_MS, counted from the last write that settled', async () => {
      const chain = setLogsAnswer();
      let answerTheFirst;
      chain.single
        .mockReturnValueOnce(new Promise((resolve) => { answerTheFirst = resolve; }))
        .mockReturnValue(new Promise(() => {}));
      const { queryClient, replayQueuedWrites, REPLAY_PATIENCE_MS, MUTATION_KEYS } = await launchApp();
      for (const variables of [{ logId: 'l-1', done: true }, { logId: 'l-2', done: true }]) {
        hydrate(queryClient, {
          queries: [],
          mutations: [{
            mutationKey: MUTATION_KEYS.toggleDone,
            scope: { id: 'offline-writes' },
            state: { status: 'pending', isPaused: true, variables, failureCount: 0, failureReason: null, error: null, data: undefined, context: undefined, submittedAt: 1 },
          }],
        });
      }
      let settled = false;
      replayQueuedWrites().then(() => { settled = true; });

      // The first write takes four seconds, and is answered.
      await vi.advanceTimersByTimeAsync(4000);
      expect(settled).toBe(false);
      answerTheFirst({ data: { id: 'l-1', done: true }, error: null });
      await vi.advanceTimersByTimeAsync(0);
      expect(chain.single).toHaveBeenCalledTimes(2);

      // The second never is. The patience starts again from the first's answer.
      await vi.advanceTimersByTimeAsync(REPLAY_PATIENCE_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      expect(queryClient.getMutationCache().getAll()[1].state.status).toBe('pending');
    });
  });

  it('replays the restored queue when someone is signed in, and leaves it paused when nobody is', async () => {
    const chain = setLogsAnswer();
    const stored = await queueWrittenOffline();
    supabase.auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    const { queryClient, replayQueuedWrites } = await launchApp();
    hydrate(queryClient, stored);
    const [mutation] = queryClient.getMutationCache().getAll();

    await replayQueuedWrites();

    expect(supabase.from).not.toHaveBeenCalled();
    expect(mutation.state).toMatchObject({ status: 'pending', isPaused: true });

    supabase.auth.getSession.mockResolvedValue({
      data: { session: { access_token: 'jwt', user: { id: 'u-1' } } },
      error: null,
    });
    await replayQueuedWrites();

    expect(mutation.state.status).toBe('success');
    expect(chain.single).toHaveBeenCalledTimes(1);
  });

  it('stops listening to the queue once it has settled', async () => {
    setLogsAnswer();
    const { queryClient, replayQueuedWrites } = await launchApp();
    const cache = queryClient.getMutationCache();
    const listening = () => cache.hasListeners();
    expect(listening()).toBe(false);

    const replay = replayQueuedWrites();
    expect(listening()).toBe(true);
    await replay;

    expect(listening()).toBe(false);
  });
});
