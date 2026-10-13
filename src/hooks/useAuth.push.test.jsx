import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

// A SIGN-OUT ON A DEVICE THAT RECEIVES NOTIFICATIONS (review P15).
//
// The real provider and the real lib/pushNotifications.js, on a device that is
// faked where the browser is: the service worker registration and the push
// subscription it holds. The database is a stand-in that writes down what it
// is asked, in the order it is asked — next to what the browser and auth-js
// are asked, because the order is the point: the row of the device belongs to
// the account that leaves, and only its session can delete it.

const STORAGE_KEY = 'sb-test-auth-token';

const world = vi.hoisted(() => ({
  // Everything that was asked of the database, the browser and auth-js.
  log: [],
  // What the database answers to the delete of the device's row.
  rowDeleted: null,
}));

vi.mock('../lib/supabase', () => ({
  supabase: {
    auth: {
      storageKey: 'sb-test-auth-token',
      getSession: vi.fn(),
      onAuthStateChange: vi.fn(),
      signInWithPassword: vi.fn(),
      signOut: vi.fn(),
    },
    from: vi.fn(),
  },
}));
vi.mock('../lib/queryClient', () => ({ replayQueuedWrites: vi.fn() }));

import { AuthProvider, useAuth } from './useAuth';
import { supabase } from '../lib/supabase';
import { RELEASE_TIMEOUT_MS } from '../lib/pushNotifications';
import { PROFILE_CACHE_KEY } from '../lib/profileCache';

const A = { id: 'u-a', email: 'a@example.test' };
const ROW_A = { id: 'u-a', role: 'coach', full_name: 'Ada', created_at: '2026-01-01T00:00:00Z' };
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/this-device';

// --- the device --------------------------------------------------------------
function deviceIs(online) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
}

// The browser's push subscription for the app, or none.
let subscription;
function deviceHolds(sub) {
  subscription = sub;
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      // `ready` never settles where no worker took control: nothing may wait for it.
      ready: new Promise(() => {}),
      getRegistration: vi.fn(async () => ({
        pushManager: { getSubscription: vi.fn(async () => subscription) },
      })),
    },
  });
}
function aSubscription() {
  return {
    endpoint: ENDPOINT,
    unsubscribe: vi.fn(async () => {
      world.log.push('browser: unsubscribe');
      subscription = null;
      return true;
    }),
  };
}

// --- the database --------------------------------------------------------------
function database() {
  supabase.from.mockImplementation((table) => {
    if (table === 'profiles') {
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: ROW_A, error: null }),
      };
    }
    return {
      delete: () => {
        const filters = {};
        const request = {
          eq(column, value) {
            filters[column] = value;
            return request;
          },
          then(resolve, reject) {
            world.log.push(`database: delete ${table} ${JSON.stringify(filters)}`);
            return Promise.resolve(world.rowDeleted()).then((answer) => {
              world.log.push('database: answered');
              return answer;
            }).then(resolve, reject);
          },
        };
        return request;
      },
    };
  });
}

// --- the app -------------------------------------------------------------------
const wrapper = ({ children }) => <AuthProvider>{children}</AuthProvider>;

async function openAsA() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ access_token: 'jwt', refresh_token: 'r', expires_at: 4102444800, user: A }),
  );
  localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(ROW_A));
  const view = renderHook(() => useAuth(), { wrapper });
  await waitFor(() => expect(view.result.current.isLoading).toBe(false));
  expect(view.result.current.user).toMatchObject({ id: 'u-a' });
  return { ...view, now: () => view.result.current };
}
const signOut = (app) =>
  act(async () => {
    await app.now().signOut();
  });
const sessionOnDevice = () => localStorage.getItem(STORAGE_KEY);
const rowRequests = () => world.log.filter((line) => line.startsWith('database: delete'));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  world.log.length = 0;
  world.rowDeleted = () => ({ data: null, error: null });
  deviceIs(true);
  deviceHolds(aSubscription());
  database();
  supabase.auth.onAuthStateChange.mockImplementation(() => ({ data: { subscription: { unsubscribe: vi.fn() } } }));
  supabase.auth.getSession.mockResolvedValue({
    data: { session: { access_token: 'jwt', refresh_token: 'r', expires_at: 4102444800, user: A } },
    error: null,
  });
  supabase.auth.signOut.mockImplementation(async () => {
    world.log.push('auth-js: signOut');
    return { error: null };
  });
});

afterEach(() => {
  vi.useRealTimers();
  delete navigator.serviceWorker;
  delete navigator.onLine;
});

describe('a sign-out releases the device before the session ends', () => {
  it('the row of this device is deleted, the browser gives its subscription up, and only then is the session ended', async () => {
    const app = await openAsA();
    const held = subscription;

    await signOut(app);

    // The two halves of the release go at the same time, in no order that
    // matters; the end of the session comes after both.
    expect(world.log.at(-1)).toBe('auth-js: signOut');
    expect(world.log.slice(0, -1).sort()).toEqual([
      'browser: unsubscribe',
      'database: answered',
      `database: delete push_subscriptions {"endpoint":"${ENDPOINT}"}`,
    ]);
    expect(world.log.indexOf('database: answered')).toBeGreaterThan(
      world.log.indexOf(`database: delete push_subscriptions {"endpoint":"${ENDPOINT}"}`),
    );
    expect(held.unsubscribe).toHaveBeenCalledTimes(1);
    expect(app.now()).toMatchObject({ user: null, signOuts: 1 });
  });

  it('auth-js is not asked while the delete is still out: it would leave without the session that owns the row', async () => {
    let answer;
    world.rowDeleted = () => new Promise((resolve) => {
      answer = resolve;
    });
    const app = await openAsA();

    let done;
    await act(async () => {
      done = app.now().signOut();
      await waitFor(() => expect(rowRequests()).toHaveLength(1));
    });
    expect(supabase.auth.signOut).not.toHaveBeenCalled();
    expect(app.now().user).toMatchObject({ id: 'u-a' });

    await act(async () => {
      answer({ data: null, error: null });
      await done;
    });

    expect(supabase.auth.signOut).toHaveBeenCalledTimes(1);
    expect(app.now().user).toBeNull();
  });

  it('only THIS device: the row is found by the address of the browser\'s subscription, not by the account', async () => {
    const app = await openAsA();

    await signOut(app);

    // `delete().eq('user_id', …)` would switch every phone of the account off.
    expect(rowRequests()).toEqual([`database: delete push_subscriptions {"endpoint":"${ENDPOINT}"}`]);
  });

  it('a device that receives nothing is signed out as before: no request, no wait', async () => {
    deviceHolds(null);
    const app = await openAsA();

    await signOut(app);

    expect(world.log).toEqual(['auth-js: signOut']);
    expect(app.now()).toMatchObject({ user: null, signOuts: 1 });
  });

  it('a sign-out that is held back releases nothing', async () => {
    const app = await openAsA();
    const held = subscription;
    act(() => {
      app.now().guardSignOut(() => false);
    });

    await signOut(app);

    expect(world.log).toEqual([]);
    expect(held.unsubscribe).not.toHaveBeenCalled();
    expect(app.now().user).toMatchObject({ id: 'u-a' });
  });
});

describe('and it completes whatever becomes of the release', () => {
  it('without a network: the row is not asked for, the browser gives the subscription up, the device forgets the session', async () => {
    const app = await openAsA();
    const held = subscription;
    deviceIs(false);

    await signOut(app);

    expect(world.log).toEqual(['browser: unsubscribe']);
    expect(held.unsubscribe).toHaveBeenCalledTimes(1);
    expect(supabase.auth.signOut).not.toHaveBeenCalled();
    expect(sessionOnDevice()).toBeNull();
    expect(app.now()).toMatchObject({ user: null, profile: null, signOuts: 1 });
  });

  it('a database that does not answer: the browser gave the subscription up at once, and the sign-out goes on after the wait', async () => {
    world.rowDeleted = () => new Promise(() => {});
    const app = await openAsA();
    const held = subscription;
    vi.useFakeTimers();

    let done;
    await act(async () => {
      done = app.now().signOut();
      await vi.advanceTimersByTimeAsync(RELEASE_TIMEOUT_MS - 1);
    });
    expect(held.unsubscribe).toHaveBeenCalledTimes(1);
    expect(supabase.auth.signOut).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await done;
    });

    expect(supabase.auth.signOut).toHaveBeenCalledTimes(1);
    expect(app.now()).toMatchObject({ user: null, signOuts: 1 });
  });

  it('a browser that does not answer either', async () => {
    world.rowDeleted = () => new Promise(() => {});
    const app = await openAsA();
    subscription.unsubscribe.mockImplementation(() => new Promise(() => {}));
    vi.useFakeTimers();

    await act(async () => {
      const done = app.now().signOut();
      await vi.advanceTimersByTimeAsync(RELEASE_TIMEOUT_MS);
      await done;
    });

    expect(app.now()).toMatchObject({ user: null, signOuts: 1 });
  });

  it('a row the database refuses to delete, and a browser that refuses to unsubscribe', async () => {
    world.rowDeleted = () => ({ data: null, error: { code: '42501', message: 'permission denied' } });
    const app = await openAsA();
    subscription.unsubscribe.mockRejectedValue(new Error('push service unreachable'));

    await signOut(app);

    expect(supabase.auth.signOut).toHaveBeenCalledTimes(1);
    expect(app.now()).toMatchObject({ user: null, signOuts: 1 });
  });

  it('a request that throws before it is sent', async () => {
    const app = await openAsA();
    const held = subscription;
    supabase.from.mockImplementation(() => {
      throw new Error('client gone');
    });

    await signOut(app);

    // The other half still happened.
    expect(held.unsubscribe).toHaveBeenCalledTimes(1);
    expect(app.now()).toMatchObject({ user: null, signOuts: 1 });
  });

  it('a browser whose service worker cannot be asked', async () => {
    const app = await openAsA();
    navigator.serviceWorker.getRegistration.mockRejectedValue(new Error('SecurityError'));

    await signOut(app);

    expect(world.log).toEqual(['auth-js: signOut']);
    expect(app.now()).toMatchObject({ user: null, signOuts: 1 });
  });

  it('a browser without service workers at all', async () => {
    delete navigator.serviceWorker;
    const app = await openAsA();

    await signOut(app);

    expect(world.log).toEqual(['auth-js: signOut']);
    expect(app.now()).toMatchObject({ user: null, signOuts: 1 });
  });
});
