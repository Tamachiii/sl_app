import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { AuthRetryableFetchError } from '@supabase/supabase-js';

// The provider on a DEVICE: what localStorage holds when the app is opened —
// the session supabase-js stored, the profile the app remembered — and what
// auth-js and the database then answer, late, with an error, or never.
// (lib/storedSession.test.js holds the two files that read the device to the
// real library; here the library is a stand-in that says where it stores.)

const STORAGE_KEY = 'sb-test-auth-token';

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

import { AuthProvider, useAuth, ROLE_RETRY_MS } from './useAuth';
import { supabase } from '../lib/supabase';
import { PROFILE_CACHE_KEY } from '../lib/profileCache';

const A = { id: 'u-a', email: 'a@example.test' };
const B = { id: 'u-b', email: 'b@example.test' };
const ROW_A = { id: 'u-a', role: 'student', full_name: 'Ada', created_at: '2026-01-01T00:00:00Z' };
const ROW_B = { id: 'u-b', role: 'coach', full_name: 'Bea', created_at: '2026-01-02T00:00:00Z' };
const sessionOf = (user) => ({ access_token: 'jwt', refresh_token: 'r', expires_at: 4102444800, user });

// --- the device --------------------------------------------------------------------
function deviceStores({ user, profile } = {}) {
  if (user) localStorage.setItem(STORAGE_KEY, JSON.stringify(sessionOf(user)));
  if (profile) localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(profile));
}
const cachedProfile = () => JSON.parse(localStorage.getItem(PROFILE_CACHE_KEY));
function deviceIs(online) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
}
function networkReturns() {
  deviceIs(true);
  window.dispatchEvent(new Event('online'));
}

// --- auth-js -----------------------------------------------------------------------
// The token had expired and the refresh got no answer: what `getSession()`
// resolves with after its attempts. The stored session is left in place.
const COULD_NOT_REFRESH = { data: { session: null }, error: new AuthRetryableFetchError('Failed to fetch', 0) };
const NO_SESSION = { data: { session: null }, error: null };
const sessionAnswer = (user) => ({ data: { session: sessionOf(user) }, error: null });

let authChangeCallback;
// `getSession()` has not answered — as while it attempts, for half a minute
// and more, to refresh a token without a network.
function getSessionIsPending() {
  supabase.auth.getSession.mockImplementation(() => new Promise(() => {}));
}
const emit = (event, session) =>
  act(async () => {
    authChangeCallback(event, session);
  });

// --- the database --------------------------------------------------------------------
// Each read of `profiles` takes the next answer; the last one repeats.
function profileReads(...answers) {
  let call = 0;
  supabase.from.mockImplementation(() => ({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn(() => {
      const answer = answers[Math.min(call, answers.length - 1)];
      call += 1;
      return typeof answer === 'function' ? answer() : Promise.resolve(answer);
    }),
  }));
}
const row = (data) => ({ data, error: null });
const FAILED = { data: null, error: { message: 'TypeError: Failed to fetch' } };

// --- the app -------------------------------------------------------------------------
const wrapper = ({ children }) => <AuthProvider>{children}</AuthProvider>;
// `seen` is what each render of a consumer was handed.
function openApp() {
  const seen = [];
  const view = renderHook(
    () => {
      const auth = useAuth();
      seen.push(auth);
      return auth;
    },
    { wrapper },
  );
  return { ...view, seen, now: () => view.result.current };
}
// The first render, before any effect or promise has run.
const firstRender = (app) => app.seen[0];

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  deviceIs(true);
  supabase.auth.onAuthStateChange.mockImplementation((cb) => {
    authChangeCallback = cb;
    return { data: { subscription: { unsubscribe: vi.fn() } } };
  });
  supabase.auth.getSession.mockResolvedValue(NO_SESSION);
  profileReads(FAILED);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  deviceIs(true);
});

describe('an app opened by the account that is signed in on the device', () => {
  it('is signed in, in the role the device remembers, from the first render — auth-js has not answered', () => {
    deviceStores({ user: A, profile: ROW_A });
    getSessionIsPending();
    profileReads(() => new Promise(() => {}));

    const app = openApp();

    expect(firstRender(app)).toMatchObject({ user: A, role: 'student', isLoading: false });
    expect(app.now().profile).toEqual({ id: 'u-a', role: 'student', full_name: 'Ada' });
  });

  it('without a network: no request for the profile, and nothing to wait for', async () => {
    deviceIs(false);
    deviceStores({ user: A, profile: ROW_A });
    getSessionIsPending();

    const app = openApp();
    await act(async () => {});

    expect(app.now()).toMatchObject({ user: A, role: 'student', isLoading: false });
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('stays signed in when auth-js gives up on a token it could not refresh', async () => {
    deviceIs(false);
    deviceStores({ user: A, profile: ROW_A });
    supabase.auth.getSession.mockResolvedValue(COULD_NOT_REFRESH);

    const app = openApp();
    await act(async () => {});
    // What auth-js emits at the end of such a start-up.
    await emit('INITIAL_SESSION', null);

    expect(app.now()).toMatchObject({ user: A, role: 'student', isLoading: false });
    expect(cachedProfile()).toMatchObject({ id: 'u-a', role: 'student' });
  });

  it('stays signed in when auth-js cannot answer at all', async () => {
    deviceStores({ user: A, profile: ROW_A });
    supabase.auth.getSession.mockRejectedValue(new Error('lock stolen'));

    const app = openApp();
    await act(async () => {});

    expect(app.now()).toMatchObject({ user: A, role: 'student', isLoading: false });
  });

  it('reads the profile once: the answer of getSession and the two events of a start-up are one request', async () => {
    deviceStores({ user: A, profile: ROW_A });
    supabase.auth.getSession.mockResolvedValue(sessionAnswer(A));
    profileReads(row(ROW_A));

    const app = openApp();
    await emit('SIGNED_IN', sessionOf({ ...A }));
    await emit('INITIAL_SESSION', sessionOf({ ...A }));
    await waitFor(() => expect(app.now().profile).toEqual(ROW_A));

    expect(supabase.from).toHaveBeenCalledTimes(1);
  });

  it('takes what the database says over what the device remembered, and remembers that', async () => {
    deviceStores({ user: A, profile: { id: 'u-a', role: 'student', full_name: 'Old name' } });
    supabase.auth.getSession.mockResolvedValue(sessionAnswer(A));
    profileReads(row({ ...ROW_A, role: 'coach', full_name: 'New name' }));

    const app = openApp();
    expect(firstRender(app).role).toBe('student');

    await waitFor(() => expect(app.now().role).toBe('coach'));
    expect(app.now().profile.full_name).toBe('New name');
    expect(cachedProfile()).toEqual({ id: 'u-a', role: 'coach', full_name: 'New name' });
  });
});

describe('an event about the account that is already signed in', () => {
  async function openAsA() {
    deviceStores({ user: A, profile: ROW_A });
    supabase.auth.getSession.mockResolvedValue(sessionAnswer(A));
    profileReads(row(ROW_A));
    const app = openApp();
    await waitFor(() => expect(app.now().profile).toEqual(ROW_A));
    return app;
  }

  it('a return to the tab and a token refresh render nothing again and ask nothing', async () => {
    const app = await openAsA();
    const before = { user: app.now().user, profile: app.now().profile, renders: app.seen.length };

    // auth-js parses the stored session anew for each of these.
    await emit('SIGNED_IN', sessionOf({ ...A }));
    await emit('TOKEN_REFRESHED', sessionOf({ ...A }));
    await emit('SIGNED_IN', sessionOf({ ...A }));

    expect(app.now().user).toBe(before.user);
    expect(app.now().profile).toBe(before.profile);
    expect(app.seen.length).toBe(before.renders);
    expect(supabase.from).toHaveBeenCalledTimes(1);
  });

  it('a change of the user itself — a new address — is taken', async () => {
    const app = await openAsA();

    await emit('USER_UPDATED', sessionOf({ ...A, email: 'new@example.test' }));

    expect(app.now().user.email).toBe('new@example.test');
    expect(app.now().role).toBe('student');
    expect(supabase.from).toHaveBeenCalledTimes(1);
  });
});

describe('a profile read that fails', () => {
  it('keeps the profile that is known', async () => {
    deviceStores({ user: A, profile: ROW_A });
    supabase.auth.getSession.mockResolvedValue(sessionAnswer(A));
    profileReads(FAILED);

    const app = openApp();
    await waitFor(() => expect(supabase.from).toHaveBeenCalledTimes(1));
    await act(async () => {});

    expect(app.now()).toMatchObject({ user: A, role: 'student' });
    expect(app.now().profile.full_name).toBe('Ada');
    expect(cachedProfile()).toMatchObject({ id: 'u-a', role: 'student' });
  });

  it('is made again when the network returns, and at the next event of auth-js', async () => {
    deviceStores({ user: A, profile: ROW_A });
    getSessionIsPending();
    profileReads(FAILED, FAILED, row({ ...ROW_A, full_name: 'Ada L.' }));

    const app = openApp();
    await waitFor(() => expect(supabase.from).toHaveBeenCalledTimes(1));
    await act(async () => {});

    await act(async () => networkReturns());
    expect(supabase.from).toHaveBeenCalledTimes(2);

    await emit('TOKEN_REFRESHED', sessionOf(A));
    await waitFor(() => expect(app.now().profile.full_name).toBe('Ada L.'));
    expect(supabase.from).toHaveBeenCalledTimes(3);

    // Read: nothing asks again.
    await emit('SIGNED_IN', sessionOf(A));
    await act(async () => networkReturns());
    expect(supabase.from).toHaveBeenCalledTimes(3);
  });
});

describe('signed in, but the device has never read the role (the first launch after this update)', () => {
  it('without a network: the pages are not held back, and the role is read when the network returns', async () => {
    deviceIs(false);
    deviceStores({ user: A });
    getSessionIsPending();
    profileReads(row(ROW_A));

    const app = openApp();

    expect(firstRender(app)).toMatchObject({ user: A, role: null, isLoading: false });
    await act(async () => {});
    expect(supabase.from).not.toHaveBeenCalled();

    await act(async () => networkReturns());

    await waitFor(() => expect(app.now().role).toBe('student'));
    expect(cachedProfile()).toEqual({ id: 'u-a', role: 'student', full_name: 'Ada' });
  });

  it('with a network: the pages wait for the role, once', async () => {
    deviceStores({ user: A });
    getSessionIsPending();
    let answer;
    profileReads(() => new Promise((resolve) => (answer = resolve)));

    const app = openApp();
    expect(firstRender(app)).toMatchObject({ user: A, role: null, isLoading: true });

    await act(async () => answer(row(ROW_A)));

    expect(app.now()).toMatchObject({ user: A, role: 'student', isLoading: false });
  });

  it('a read that fails lets the pages through, and the role is asked for again until it is known', async () => {
    vi.useFakeTimers();
    deviceStores({ user: A });
    getSessionIsPending();
    profileReads(FAILED, FAILED, row(ROW_A));

    const app = openApp();
    await act(async () => {});
    expect(app.now()).toMatchObject({ user: A, role: null, isLoading: false });
    expect(supabase.from).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(ROLE_RETRY_MS));
    expect(supabase.from).toHaveBeenCalledTimes(2);
    expect(app.now().role).toBeNull();

    await act(async () => vi.advanceTimersByTimeAsync(ROLE_RETRY_MS));
    expect(app.now().role).toBe('student');

    // Known: the asking stops.
    await act(async () => vi.advanceTimersByTimeAsync(5 * ROLE_RETRY_MS));
    expect(supabase.from).toHaveBeenCalledTimes(3);
  });
});

describe('what signs the user out', () => {
  it('auth-js finds no session on the device: nobody is signed in, and the remembered profile goes', async () => {
    // The profile of an account that signed out while the app was closed.
    deviceStores({ profile: ROW_A });
    supabase.auth.getSession.mockResolvedValue(NO_SESSION);

    const app = openApp();
    expect(firstRender(app)).toMatchObject({ user: null, isLoading: true });
    await waitFor(() => expect(app.now().isLoading).toBe(false));

    expect(app.now()).toMatchObject({ user: null, profile: null, role: null });
    expect(localStorage.getItem(PROFILE_CACHE_KEY)).toBeNull();
  });

  it('the SIGNED_OUT event — also the one auth-js emits when the server refused the refresh', async () => {
    deviceStores({ user: A, profile: ROW_A });
    supabase.auth.getSession.mockResolvedValue(sessionAnswer(A));
    profileReads(row(ROW_A));
    const app = openApp();
    await waitFor(() => expect(app.now().profile).toEqual(ROW_A));

    await emit('SIGNED_OUT', null);

    expect(app.now()).toMatchObject({ user: null, profile: null, role: null, isLoading: false });
    expect(localStorage.getItem(PROFILE_CACHE_KEY)).toBeNull();
  });

  it('a refused refresh at start-up: auth-js has removed the stored session by the time it answers', async () => {
    deviceStores({ user: A, profile: ROW_A });
    supabase.auth.getSession.mockImplementation(async () => {
      localStorage.removeItem(STORAGE_KEY);
      return { data: { session: null }, error: { name: 'AuthApiError', message: 'Invalid Refresh Token', status: 400 } };
    });

    const app = openApp();
    await waitFor(() => expect(app.now().user).toBeNull());

    expect(app.now()).toMatchObject({ profile: null, role: null, isLoading: false });
  });

  it('nothing on the device and no answer from auth-js: the app does not wait for ever', async () => {
    supabase.auth.getSession.mockRejectedValue(new Error('lock stolen'));

    const app = openApp();
    await waitFor(() => expect(app.now().isLoading).toBe(false));

    expect(app.now().user).toBeNull();
  });
});

describe('signing out of the device', () => {
  async function openAsA() {
    deviceStores({ user: A, profile: ROW_A });
    supabase.auth.getSession.mockResolvedValue(sessionAnswer(A));
    profileReads(row(ROW_A));
    const app = openApp();
    await waitFor(() => expect(app.now().profile).toEqual(ROW_A));
    return app;
  }
  const sessionOnDevice = () => localStorage.getItem(STORAGE_KEY);
  const signOut = (app) =>
    act(async () => {
      await app.now().signOut();
    });

  it('with a server that answers: auth-js ends the session, and the sign-out is counted', async () => {
    supabase.auth.signOut.mockResolvedValue({ error: null });
    const app = await openAsA();
    expect(app.now().signOuts).toBe(0);

    await signOut(app);

    expect(supabase.auth.signOut).toHaveBeenCalledTimes(1);
    expect(app.now()).toMatchObject({ user: null, profile: null, role: null, signOuts: 1 });
    expect(localStorage.getItem(PROFILE_CACHE_KEY)).toBeNull();
  });

  it('without a network: the server is not asked, and the device forgets the session itself', async () => {
    const app = await openAsA();
    deviceIs(false);

    await signOut(app);

    expect(supabase.auth.signOut).not.toHaveBeenCalled();
    expect(sessionOnDevice()).toBeNull();
    expect(app.now()).toMatchObject({ user: null, profile: null, signOuts: 1 });
  });

  it('with a server that does not answer: auth-js leaves the session, the device forgets it', async () => {
    // What auth-js returns when the logout request got no answer. The stored
    // session is still there at that point (lib/storedSession.test.js).
    supabase.auth.signOut.mockResolvedValue({ error: new AuthRetryableFetchError('Failed to fetch', 0) });
    const app = await openAsA();

    await signOut(app);

    expect(sessionOnDevice()).toBeNull();
    expect(app.now()).toMatchObject({ user: null, signOuts: 1 });
  });

  it('with an auth-js that throws: signed out all the same', async () => {
    supabase.auth.signOut.mockRejectedValue(new Error('lock stolen'));
    const app = await openAsA();

    await signOut(app);

    expect(sessionOnDevice()).toBeNull();
    expect(app.now()).toMatchObject({ user: null, signOuts: 1 });
  });

  it('the next launch of a device signed out offline finds nobody — not the account that "signed out"', async () => {
    const app = await openAsA();
    deviceIs(false);
    await signOut(app);
    app.unmount();

    // auth-js reads the same storage: nothing there.
    supabase.auth.getSession.mockResolvedValue(NO_SESSION);
    const next = openApp();

    expect(firstRender(next)).toMatchObject({ user: null, role: null });
    await waitFor(() => expect(next.now().isLoading).toBe(false));
    expect(next.now().user).toBeNull();
  });

  it('a session that goes away by itself is not a sign-out', async () => {
    const app = await openAsA();

    await emit('SIGNED_OUT', null);

    expect(app.now()).toMatchObject({ user: null, signOuts: 0 });
  });
});

describe('another account signs in', () => {
  it('is never shown the profile of the previous one', async () => {
    deviceStores({ user: A, profile: ROW_A });
    supabase.auth.getSession.mockResolvedValue(sessionAnswer(A));
    let answerB;
    profileReads(row(ROW_A), () => new Promise((resolve) => (answerB = resolve)));
    const app = openApp();
    await waitFor(() => expect(app.now().profile).toEqual(ROW_A));

    await emit('SIGNED_IN', sessionOf(B));

    expect(app.now()).toMatchObject({ user: B, profile: null, role: null });

    await act(async () => answerB(row(ROW_B)));
    expect(app.now()).toMatchObject({ user: B, role: 'coach' });
    expect(cachedProfile()).toEqual({ id: 'u-b', role: 'coach', full_name: 'Bea' });
  });

  it('an answer about the previous account that arrives late is dropped', async () => {
    deviceStores({ user: A });
    supabase.auth.getSession.mockResolvedValue(sessionAnswer(A));
    let answerA;
    profileReads(() => new Promise((resolve) => (answerA = resolve)), row(ROW_B));
    const app = openApp();
    await waitFor(() => expect(supabase.from).toHaveBeenCalledTimes(1));

    await emit('SIGNED_IN', sessionOf(B));
    await waitFor(() => expect(app.now().role).toBe('coach'));
    await act(async () => answerA(row(ROW_A)));

    expect(app.now()).toMatchObject({ user: B, role: 'coach' });
    expect(app.now().profile).toEqual(ROW_B);
    expect(cachedProfile()).toMatchObject({ id: 'u-b' });
  });

  it('the same account again after a sign-out reads its profile again', async () => {
    deviceStores({ user: A, profile: ROW_A });
    supabase.auth.getSession.mockResolvedValue(sessionAnswer(A));
    profileReads(row(ROW_A));
    const app = openApp();
    await waitFor(() => expect(app.now().profile).toEqual(ROW_A));

    await emit('SIGNED_OUT', null);
    await emit('SIGNED_IN', sessionOf(A));

    await waitFor(() => expect(app.now().role).toBe('student'));
    expect(supabase.from).toHaveBeenCalledTimes(2);
  });
});

describe('updateProfile', () => {
  it('remembers the row it wrote: the next launch without a network shows the new name', async () => {
    deviceStores({ user: A, profile: ROW_A });
    supabase.auth.getSession.mockResolvedValue(sessionAnswer(A));
    const written = { ...ROW_A, full_name: 'Ada King' };
    supabase.from.mockImplementation(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue(row(written)),
    }));
    const app = openApp();
    await act(async () => {});

    await act(async () => {
      expect(await app.now().updateProfile({ full_name: 'Ada King' })).toEqual({ error: null });
    });

    expect(app.now().profile.full_name).toBe('Ada King');
    expect(cachedProfile()).toEqual({ id: 'u-a', role: 'student', full_name: 'Ada King' });
  });
});
