import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryObserver, dehydrate, hydrate, onlineManager } from '@tanstack/react-query';

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
  const [{ queryClient }, offline] = await Promise.all([
    import('./queryClient'),
    import('./offlineMutations'),
  ]);
  // What <QueryClientProvider> does on mount: React Query starts listening to
  // its managers.
  queryClient.mount();
  mounted.push(queryClient);
  return { queryClient, ...offline };
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
