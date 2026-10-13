import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, dehydrate, onlineManager, useIsRestoring } from '@tanstack/react-query';
import { AuthRetryableFetchError } from '@supabase/supabase-js';

// The workout logged in the basement, from the launch without a network to the
// request that leaves when the network is back — with everything the app puts
// around the cache: the provider that restores it, the auth provider, and
// `ClearOnUserChange`. Real client, real persister, real auth provider; the
// device (localStorage, the IndexedDB store), auth-js and the database are
// what the test says they are.
//
// This is the trace of review P5 / L4. Each piece has its own tests
// (App.test.jsx, hooks/useAuth.offline.test.jsx, lib/persistence.test.js);
// what is checked here is that together they do not throw the workout away.

// --- the device's store: one Map per test ------------------------------------------
const device = vi.hoisted(() => ({ store: new Map() }));
vi.mock('idb-keyval', () => ({
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
const SESSION_KEY = 'sb-test-auth-token';
const onDevice = () => (device.store.has(BLOB) ? JSON.parse(device.store.get(BLOB)) : undefined);

vi.mock('./lib/supabase', () => ({
  supabase: {
    from: vi.fn(),
    rpc: vi.fn(),
    auth: {
      storageKey: 'sb-test-auth-token',
      getSession: vi.fn(),
      onAuthStateChange: vi.fn(),
      signOut: vi.fn(),
    },
  },
}));
vi.mock('./lib/toast', () => ({ pushToast: vi.fn() }));
// App.jsx is imported for its providers: not the pages, not what it starts at load.
vi.mock('./routes', () => ({ routes: [] }));
vi.mock('./hooks/usePushAutoHeal', () => ({ usePushAutoHeal: () => {} }));
vi.mock('./lib/errorReporter', () => ({
  installGlobalErrorReporting: vi.fn(),
  reportError: vi.fn(),
  setErrorReporterUser: vi.fn(),
}));

const A = { id: 'u-athlete-a', email: 'a@example.test' };
const B = { id: 'u-athlete-b', email: 'b@example.test' };
const sessionOf = (user) => ({ access_token: 'jwt', refresh_token: 'r', expires_at: 1_700_000_000, user });
const profileOf = (user) => ({ id: user.id, role: 'student', full_name: 'Athlete' });

function deviceIs(online) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
}

// What account `owner` left in IndexedDB: a session it read, a set it ticked
// without signal and still owes the database.
async function workoutLoggedOffline({ owner }) {
  const { CACHE_BUSTER } = await import('./lib/persistence');
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
  device.store.set(BLOB, JSON.stringify({ buster: CACHE_BUSTER, timestamp: Date.now(), owner, clientState }));
}

// Who signed in on this device, days ago.
function signedInOnDevice(user) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(sessionOf(user)));
  localStorage.setItem('sl_profile_cache', JSON.stringify(profileOf(user)));
}

// --- the app, as a page load finds it ---------------------------------------------
let app;
async function launchApp() {
  onlineManager.setOnline(true);
  vi.resetModules();
  // The stand-in first, by itself: imported next to the modules that import it,
  // some of them get the real client.
  const { supabase } = await import('./lib/supabase');
  const [shell, client, auth, guard] = await Promise.all([
    import('./App'),
    import('./lib/queryClient'),
    import('./hooks/useAuth'),
    import('./components/auth/SignOutGuard'),
  ]);

  // auth-js: the session it can hand out right now, or none — with the error
  // it gives when a refresh got no answer.
  const authJs = { session: null, emit: null };
  supabase.auth.getSession.mockImplementation(async () =>
    authJs.session
      ? { data: { session: authJs.session }, error: null }
      : { data: { session: null }, error: new AuthRetryableFetchError('Failed to fetch', 0) },
  );
  supabase.auth.onAuthStateChange.mockImplementation((callback) => {
    authJs.emit = callback;
    return { data: { subscription: { unsubscribe: vi.fn() } } };
  });

  // The database: the set that is owed, and the profile of whoever asks.
  const setLogs = {
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: { id: 'l-1', done: true }, error: null }),
  };
  const profiles = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn(async () => ({ data: authJs.session ? profileOf(authJs.session.user) : null, error: null })),
  };
  supabase.from.mockImplementation((table) => (table === 'set_logs' ? setLogs : profiles));

  function Who() {
    const { user, role, isLoading } = auth.useAuth();
    return <output data-testid="who">{isLoading ? 'loading' : `${user?.id ?? 'nobody'} ${role ?? '-'}`}</output>;
  }
  function SignOutButton() {
    return (
      <button type="button" onClick={auth.useAuth().signOut}>
        Sign out
      </button>
    );
  }
  function Cache() {
    return <output data-testid="cache">{useIsRestoring() ? 'restoring' : 'restored'}</output>;
  }

  render(
    <shell.CacheBoundary>
      <auth.AuthProvider>
        <shell.ClearOnUserChange />
        <guard.default />
        <Who />
        <SignOutButton />
        <Cache />
      </auth.AuthProvider>
    </shell.CacheBoundary>,
  );

  app = {
    ...client,
    authJs,
    setLogs,
    who: () => screen.getByTestId('who').textContent,
    tapSignOut: () => act(async () => screen.getByRole('button', { name: 'Sign out' }).click()),
    // What the client holds: the reads, and the writes it still owes.
    held: () => ({
      reads: client.queryClient.getQueryCache().getAll().length,
      owed: client.queryClient.getMutationCache().findAll({ status: 'pending' }).length,
    }),
    // The network is back: the token is refreshed first, then auth-js says so.
    async networkReturns(user) {
      await act(async () => {
        authJs.session = sessionOf(user);
        deviceIs(true);
        window.dispatchEvent(new Event('online'));
        authJs.emit('TOKEN_REFRESHED', authJs.session);
      });
    },
  };
  // The stored blob has been read and handed to the client, and the provider
  // is saving again.
  await waitFor(() => expect(screen.getByTestId('cache')).toHaveTextContent('restored'));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return app;
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', {});
  device.store = new Map();
  localStorage.clear();
  deviceIs(false);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  app?.queryClient.clear();
  app = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  deviceIs(true);
  onlineManager.setOnline(true);
});

describe('a workout logged without signal, then the app is killed and opened again offline on an expired token', () => {
  beforeEach(async () => {
    signedInOnDevice(A);
    await workoutLoggedOffline({ owner: A.id });
  });

  it('opens signed in, on what the device holds, and sends nothing', async () => {
    await launchApp();

    expect(app.who()).toBe(`${A.id} student`);
    expect(app.held()).toEqual({ reads: 1, owed: 1 });
    expect(app.setLogs.update).not.toHaveBeenCalled();
    expect(onDevice().clientState.mutations).toHaveLength(1);
  });

  it('the network returns and the token is refreshed: the set is sent, once, and nothing was wiped on the way', async () => {
    await launchApp();

    await app.networkReturns(A);

    await waitFor(() => expect(app.setLogs.update).toHaveBeenCalledTimes(1));
    expect(app.setLogs.update.mock.calls[0][0]).toMatchObject({ done: true, failed: false });
    expect(app.setLogs.eq).toHaveBeenCalledWith('id', 'l-1');
    await waitFor(() => expect(app.held().owed).toBe(0));
    // The reads the device held are still there, and still this account's.
    expect(app.queryClient.getQueryData(['session', 's-1'])).toEqual({ id: 's-1', title: 'Legs' });
    expect(app.queryPersister.getOwner()).toBe(A.id);
    expect(app.who()).toBe(`${A.id} student`);
  });

  it('the server ended the session meanwhile, and the athlete signs in again: the set is still sent', async () => {
    await launchApp();

    // The refresh is refused: auth-js removes the stored session and says so.
    await act(async () => {
      deviceIs(true);
      window.dispatchEvent(new Event('online'));
      localStorage.removeItem(SESSION_KEY);
      app.authJs.emit('SIGNED_OUT', null);
    });
    expect(app.who()).toBe('nobody -');
    expect(app.held()).toEqual({ reads: 1, owed: 1 });
    expect(app.setLogs.update).not.toHaveBeenCalled();

    await act(async () => {
      app.authJs.session = sessionOf(A);
      app.authJs.emit('SIGNED_IN', app.authJs.session);
    });

    // A write that was waiting for its owner looks again after a delay
    // (lib/networkErrors.js): it leaves within seconds, not at once.
    await waitFor(() => expect(app.setLogs.update).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(app.queryClient.getQueryData(['session', 's-1'])).toEqual({ id: 's-1', title: 'Legs' });
  });

  it('ANOTHER account signs in instead: nothing of the first one is shown or sent', async () => {
    await launchApp();
    await act(async () => {
      deviceIs(true);
      window.dispatchEvent(new Event('online'));
      localStorage.removeItem(SESSION_KEY);
      app.authJs.emit('SIGNED_OUT', null);
    });

    await act(async () => {
      app.authJs.session = sessionOf(B);
      app.authJs.emit('SIGNED_IN', app.authJs.session);
    });

    await waitFor(() => expect(app.who()).toBe(`${B.id} student`));
    expect(app.held()).toEqual({ reads: 0, owed: 0 });
    expect(app.setLogs.update).not.toHaveBeenCalled();
    expect(app.queryPersister.getOwner()).toBe(B.id);
  });

  it('the athlete signs out offline: asked first, then the device is signed out for good and what it held is gone with the account', async () => {
    await launchApp();

    await app.tapSignOut();

    // One set is at stake: nothing happens until the athlete has said so.
    expect(screen.getByText(/1 change made on this device has not been sent yet/i)).toBeInTheDocument();
    expect(app.who()).toBe(`${A.id} student`);
    expect(app.held()).toEqual({ reads: 1, owed: 1 });

    await act(async () => screen.getByRole('button', { name: 'Sign out anyway', hidden: true }).click());

    expect(app.who()).toBe('nobody -');
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(app.held()).toEqual({ reads: 0, owed: 0 });
    await waitFor(() => expect(device.store.has(BLOB)).toBe(false));
    // And the network changes nothing about that.
    await act(async () => {
      deviceIs(true);
      window.dispatchEvent(new Event('online'));
    });
    expect(app.setLogs.update).not.toHaveBeenCalled();
  });
});

// Every device of the app deployed before the blobs were labelled holds one
// that does not say whose it is. Opened by the account the device stores, it
// is that account's (App.test.jsx). Opened by nobody, it is nobody's.
describe('the device holds a workout that does not say whose it is, and nobody is signed in on it', () => {
  beforeEach(async () => {
    await workoutLoggedOffline({ owner: undefined });
    deviceIs(true);
  });

  it('is wiped at launch, before anybody can sign in', async () => {
    await launchApp();

    expect(app.who()).toBe('nobody -');
    expect(app.held()).toEqual({ reads: 0, owed: 0 });
    expect(app.queryClient.getQueryData(['session', 's-1'])).toBeUndefined();
    await waitFor(() => expect(onDevice()?.clientState.mutations ?? []).toEqual([]));
  });

  it('an account signs in: it is shown nothing of it, and the set is not sent under its name', async () => {
    await launchApp();

    // The scope stays open for a moment: the replay the sign-in starts runs
    // before React has rendered anything — the order of a browser, where a
    // render is a task and the replay is not.
    await act(async () => {
      app.authJs.session = sessionOf(B);
      app.authJs.emit('SIGNED_IN', app.authJs.session);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    await waitFor(() => expect(app.who()).toBe(`${B.id} student`));
    expect(app.held()).toEqual({ reads: 0, owed: 0 });
    expect(app.queryClient.getQueryData(['session', 's-1'])).toBeUndefined();
    expect(app.setLogs.update).not.toHaveBeenCalled();
    expect(app.queryPersister.getOwner()).toBe(B.id);
  });
});

// No IndexedDB, no persister: the queue lives in memory, for as long as the
// page does — and the page can outlive the session of the account that filled
// it. Whose it is has to be known all the same, to the wipe and to the gate.
describe('on a browser without IndexedDB, a set waits in memory and the session of its account goes away', () => {
  beforeEach(async () => {
    vi.unstubAllGlobals();
    signedInOnDevice(A);
    deviceIs(true);
    await launchApp();
    expect(app.queryPersister).toBeNull();

    // Ticked in a place without signal.
    await act(async () => {
      deviceIs(false);
      window.dispatchEvent(new Event('offline'));
    });
    app.queryClient
      .getMutationCache()
      .build(app.queryClient, { mutationKey: ['set-log', 'toggle-done'] })
      .execute({ logId: 'l-1', done: true })
      .catch(() => {});
    // Nobody signed out: another tab did, or the server ended the session.
    await act(async () => {
      localStorage.removeItem(SESSION_KEY);
      app.authJs.emit('SIGNED_OUT', null);
    });
    expect(app.who()).toBe('nobody -');
    expect(app.held().owed).toBe(1);
  });

  // The network back and the sign-in in one scope, which stays open for a
  // moment: both replay the queue before React has rendered anything.
  const networkAndSignIn = (user) =>
    act(async () => {
      app.authJs.session = sessionOf(user);
      deviceIs(true);
      window.dispatchEvent(new Event('online'));
      app.authJs.emit('SIGNED_IN', app.authJs.session);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

  it('ANOTHER account signs in: the set is not sent under its name, and is gone', async () => {
    await networkAndSignIn(B);

    await waitFor(() => expect(app.who()).toBe(`${B.id} student`));
    expect(app.setLogs.update).not.toHaveBeenCalled();
    expect(app.held()).toEqual({ reads: 0, owed: 0 });
  });

  it('the same account signs in again: the set is sent', async () => {
    await networkAndSignIn(A);

    await waitFor(() => expect(app.setLogs.update).toHaveBeenCalledTimes(1));
    expect(app.setLogs.eq).toHaveBeenCalledWith('id', 'l-1');
    expect(app.who()).toBe(`${A.id} student`);
  });
});

describe('the device holds the workout of one account, and another one is signed in on it', () => {
  it('is wiped at launch: the set of the first account is never sent under the second one\'s name', async () => {
    signedInOnDevice(B);
    await workoutLoggedOffline({ owner: A.id });
    deviceIs(true);

    await launchApp();
    await act(async () => {
      app.authJs.session = sessionOf(B);
      app.authJs.emit('TOKEN_REFRESHED', app.authJs.session);
    });

    expect(app.who()).toBe(`${B.id} student`);
    expect(app.held()).toEqual({ reads: 0, owed: 0 });
    expect(app.setLogs.update).not.toHaveBeenCalled();
  });
});
