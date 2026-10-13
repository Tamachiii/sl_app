import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { createClient } from '@supabase/supabase-js';

// The provider on the REAL supabase-js client. Everything the provider does
// about a session rests on what auth-js does with an expired token: how long
// it tries, what it answers, which events it emits, when it removes what it
// stored. The other test files of the provider say those things themselves
// (their stand-in answers what the test tells it to); here auth-js says them,
// and only the network is this file's — a function instead of `fetch`.
//
// Time is the test's as well: auth-js retries a refresh for half a minute and
// ticks every thirty seconds.

const device = vi.hoisted(() => ({ client: null, network: null, requests: [] }));

// lib/supabase.js exports one client for the life of the page; each "launch"
// here builds a new one.
vi.mock('../lib/supabase', () => ({
  get supabase() {
    return device.client;
  },
}));
vi.mock('../lib/queryClient', () => ({ replayQueuedWrites: vi.fn() }));

import { AuthProvider, useAuth } from './useAuth';
import { replayQueuedWrites } from '../lib/queryClient';
import { PROFILE_CACHE_KEY } from '../lib/profileCache';

const USER = { id: 'u-athlete', email: 'athlete@example.test', aud: 'authenticated', role: 'authenticated' };
const PROFILE = { id: USER.id, role: 'student', full_name: 'Ada', created_at: '2026-01-01T00:00:00+00:00' };
// Somebody else who uses the same device.
const OTHER = { id: 'u-other', email: 'other@example.test', aud: 'authenticated', role: 'authenticated' };
const OTHER_PROFILE = { id: OTHER.id, role: 'student', full_name: 'Bea', created_at: '2026-01-02T00:00:00+00:00' };
const ACCOUNTS = [
  { user: USER, profile: PROFILE, password: 'password-of-ada' },
  { user: OTHER, profile: OTHER_PROFILE, password: 'password-of-bea' },
];
const SESSION_KEY = 'sb-device-test-auth-token';

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function tokenAnswer(user) {
  const part = (value) => btoa(JSON.stringify(value)).replace(/=+$/, '');
  const now = Math.floor(Date.now() / 1000);
  return json(200, {
    access_token: `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ sub: user.id, exp: now + 3600 })}.signature`,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: now + 3600,
    refresh_token: `refresh-${user.id}-${now}`,
    user,
  });
}
// The refresh token says whose session it is: `refresh-<user id>…`.
const accountOfRefresh = (token) => ACCOUNTS.find(({ user }) => String(token).startsWith(`refresh-${user.id}`));

// --- the network -------------------------------------------------------------------
const NETWORKS = {
  // Everything answers.
  up: (url, body) => {
    if (url.includes('grant_type=refresh_token')) return tokenAnswer(accountOfRefresh(body.refresh_token).user);
    if (url.includes('grant_type=password')) {
      const account = ACCOUNTS.find(({ user }) => user.email === body.email);
      return account?.password === body.password
        ? tokenAnswer(account.user)
        : json(400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
    }
    if (url.includes('/auth/v1/logout')) return new Response(null, { status: 204 });
    if (url.includes('/rest/v1/profiles')) {
      return json(200, ACCOUNTS.find(({ user }) => url.includes(`id=eq.${user.id}`)).profile);
    }
    return json(404, { message: `no stand-in for ${url}` });
  },
  // Nothing does.
  down: () => Promise.reject(new TypeError('Failed to fetch')),
  // The auth server answers, and refuses the refresh token.
  refusing: (url, body) =>
    url.includes('grant_type=refresh_token')
      ? json(400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token: Already Used' })
      : NETWORKS.up(url, body),
};
function networkIs(name) {
  device.network = NETWORKS[name];
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => name !== 'down' });
  if (name !== 'down') window.dispatchEvent(new Event('online'));
}
const requestsTo = (part) => device.requests.filter((url) => url.includes(part)).length;

// --- the device ----------------------------------------------------------------------
// What supabase-js stored at the last sign-in or refresh, `tokenAge` seconds
// ago; an access token lives for an hour.
function deviceStoresSession({ tokenAge, rememberedRole = true }) {
  localStorage.setItem(
    SESSION_KEY,
    JSON.stringify({
      access_token: 'stored.jwt.value',
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) - tokenAge + 3600,
      refresh_token: `refresh-${USER.id}-old`,
      user: USER,
    }),
  );
  if (rememberedRole) {
    localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify({ id: USER.id, role: 'student', full_name: 'Ada' }));
  }
}
// The app was last used hours ago: the token has run out.
const signedInHoursAgo = (options) => deviceStoresSession({ tokenAge: 2 * 3600, ...options });
// The app was used ten minutes ago: the token is still good.
const signedInMinutesAgo = (options) => deviceStoresSession({ tokenAge: 600, ...options });
const sessionOnDevice = () => localStorage.getItem(SESSION_KEY);

// --- the app ---------------------------------------------------------------------------
const launched = [];
const wrapper = ({ children }) => <AuthProvider>{children}</AuthProvider>;
// A page load: the client is built on what the device stores, then the
// provider mounts. Same call as lib/supabase.js, but for the transport.
function launch() {
  device.client = createClient('https://device-test.supabase.co', 'anon-key', {
    global: {
      fetch: async (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        device.requests.push(url);
        return device.network(url, typeof init?.body === 'string' ? JSON.parse(init.body) : undefined);
      },
    },
  });
  launched.push(device.client);
  const events = [];
  device.client.auth.onAuthStateChange((event) => events.push(event));
  const view = renderHook(() => useAuth(), { wrapper });
  return { ...view, events, now: () => view.result.current };
}
const wait = (ms) => act(async () => vi.advanceTimersByTimeAsync(ms));

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  localStorage.clear();
  device.requests = [];
  networkIs('up');
  // auth-js logs each refresh it could not make; the provider each profile it
  // could not read.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  await Promise.all(launched.splice(0).map((client) => client.auth.stopAutoRefresh()));
  device.client = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
});

describe('the app is opened on a token that is still good', () => {
  it('with a network: one request for the profile, whatever auth-js emits at start-up', async () => {
    signedInMinutesAgo();

    const app = launch();
    expect(app.now()).toMatchObject({ user: USER, role: 'student', isLoading: false });
    const before = app.now().user;
    await wait(5_000);

    // The start-up of auth-js: a session read from storage, announced.
    expect(app.events).toContain('INITIAL_SESSION');
    expect(requestsTo('/rest/v1/profiles')).toBe(1);
    expect(requestsTo('/auth/v1/token')).toBe(0);
    expect(app.now().user).toBe(before);
    expect(app.now().profile).toEqual(PROFILE);
  });

  it('without a network: signed in, in the remembered role, and not one request', async () => {
    signedInMinutesAgo();
    networkIs('down');

    const app = launch();
    await wait(60_000);

    expect(app.now()).toMatchObject({ user: USER, role: 'student', isLoading: false });
    expect(device.requests).toEqual([]);
  });
});

describe('the app is opened on an expired token, without a network', () => {
  it('is signed in at once, stays signed in while auth-js tries and after it gave up, and is never told SIGNED_OUT', async () => {
    signedInHoursAgo();
    networkIs('down');

    const app = launch();

    expect(app.now()).toMatchObject({ user: USER, role: 'student', isLoading: false });

    // Two minutes: the initialisation, getSession() and the first event have
    // each tried for their half minute.
    await wait(120_000);

    expect(app.now()).toMatchObject({ user: USER, role: 'student', isLoading: false });
    expect(app.events).not.toContain('SIGNED_OUT');
    // What auth-js itself says at that point — the answer the provider used
    // to take for a sign-out.
    expect(app.events).toContain('INITIAL_SESSION');
    expect(sessionOnDevice()).not.toBeNull();
    expect(requestsTo('/rest/v1/profiles')).toBe(0);
  });

  it('the network returns: auth-js refreshes the token, the queue is replayed, the profile is read once, and the user object did not change', async () => {
    signedInHoursAgo();
    networkIs('down');
    const app = launch();
    await wait(120_000);
    const before = app.now().user;
    expect(replayQueuedWrites).not.toHaveBeenCalled();

    await act(async () => networkIs('up'));
    // The next tick of auth-js's own refresh timer.
    await wait(40_000);

    expect(app.events).toContain('TOKEN_REFRESHED');
    expect(replayQueuedWrites).toHaveBeenCalled();
    expect(app.now().user).toBe(before);
    expect(app.now().profile).toEqual(PROFILE);
    expect(requestsTo('/rest/v1/profiles')).toBe(1);
  });

  it('an account whose role the device never read: the pages are let through, and the role arrives with the network', async () => {
    signedInHoursAgo({ rememberedRole: false });
    networkIs('down');

    const app = launch();
    expect(app.now()).toMatchObject({ user: USER, role: null, isLoading: false });
    await wait(120_000);
    expect(app.now()).toMatchObject({ user: USER, role: null, isLoading: false });

    await act(async () => networkIs('up'));
    await wait(40_000);

    expect(app.now()).toMatchObject({ user: USER, role: 'student' });
    expect(JSON.parse(localStorage.getItem(PROFILE_CACHE_KEY))).toEqual({ id: USER.id, role: 'student', full_name: 'Ada' });
  });
});

describe('the app is opened on an expired token, and the server refuses to refresh it', () => {
  it('auth-js removes the session and says SIGNED_OUT: the user is signed out, and that is not a sign-out of theirs', async () => {
    signedInHoursAgo();
    networkIs('refusing');

    const app = launch();
    expect(app.now().user).toEqual(USER);
    await wait(5_000);

    expect(app.events).toContain('SIGNED_OUT');
    expect(app.now()).toMatchObject({ user: null, role: null, isLoading: false, signOuts: 0 });
    expect(sessionOnDevice()).toBeNull();
  });
});

describe('signing out', () => {
  it('with a network: the server is told, and the device holds no session', async () => {
    signedInHoursAgo();
    const app = launch();
    await wait(5_000);
    expect(app.now().user).toEqual(USER);

    await act(async () => {
      await app.now().signOut();
    });

    expect(requestsTo('/auth/v1/logout')).toBe(1);
    expect(app.now()).toMatchObject({ user: null, signOuts: 1 });
    expect(sessionOnDevice()).toBeNull();
  });

  it('without a network: no request, and neither this page nor the next launch finds a session', async () => {
    signedInHoursAgo();
    const app = launch();
    await wait(5_000);
    networkIs('down');
    device.requests = [];

    await act(async () => {
      await app.now().signOut();
    });

    expect(device.requests).toEqual([]);
    expect(app.now()).toMatchObject({ user: null, signOuts: 1 });
    expect((await device.client.auth.getSession()).data.session).toBeNull();

    app.unmount();
    const next = launch();
    await wait(5_000);
    expect(next.now()).toMatchObject({ user: null, isLoading: false });
  });

  // Without a network and on an expired token, auth-js is nearly always in the
  // middle of an attempt to refresh it: each lasts some 25 seconds, and the
  // next one starts when the last gave up. An attempt that is out when the
  // device signs out comes back with a session if the network does, and
  // auth-js stores it and announces it — differently for each attempt. The
  // moments below fall into four of them, as auth-js 2.103 runs them here.
  const AN_ATTEMPT_IS_OUT = [
    [10, 'the attempt of auth-js\'s initialisation is out'],
    [30, 'the attempt of the provider\'s getSession() is out'],
    [60, 'the attempt behind the first event of the provider\'s listener is out (the event then carries the session too)'],
    [100, 'an attempt of auth-js\'s refresh timer is out'],
  ];
  // The app was opened without a network `seconds` ago; the user signs out.
  async function signOutOffline(seconds) {
    signedInHoursAgo();
    networkIs('down');
    const app = launch();
    await wait(seconds * 1000);
    expect(app.now().user).toEqual(USER);

    await act(async () => {
      await app.now().signOut();
    });
    expect(app.now().user).toBeNull();
    return app;
  }
  const signInAs = (app, email, password) =>
    act(async () => {
      const { error } = await app.now().signIn(email, password);
      return error;
    });
  // What auth-js itself answers when asked who is signed in.
  async function sessionOfAuthJs() {
    let answer;
    device.client.auth.getSession().then((result) => {
      answer = result;
    });
    await wait(1_000);
    return answer.data.session;
  }

  describe.each(AN_ATTEMPT_IS_OUT)('without a network, %i s after the launch — %s', (seconds) => {
    it('and then the network returns: the device stays signed out', async () => {
      const app = await signOutOffline(seconds);

      // The attempt that was on its way gets its answer.
      await act(async () => networkIs('up'));
      await wait(120_000);

      expect(app.events).toContain('TOKEN_REFRESHED');
      expect(app.now()).toMatchObject({ user: null, role: null, isLoading: false, signOuts: 1 });
      expect(sessionOnDevice()).toBeNull();
      expect(replayQueuedWrites).not.toHaveBeenCalled();
      // And auth-js agrees: nobody is signed in on this device.
      expect(await sessionOfAuthJs()).toBeNull();
    });

    it('and a sign-in that fails before the attempt lands does not let it through', async () => {
      const app = await signOutOffline(seconds);
      await act(async () => networkIs('up'));

      const error = await signInAs(app, USER.email, 'not-the-password');
      expect(error).toMatchObject({ code: 'invalid_credentials' });
      expect(app.events).not.toContain('TOKEN_REFRESHED');
      await wait(120_000);

      expect(app.events).toContain('TOKEN_REFRESHED');
      expect(app.events).not.toContain('SIGNED_IN');
      expect(app.now()).toMatchObject({ user: null, role: null, isLoading: false, signOuts: 1 });
      expect(sessionOnDevice()).toBeNull();
      expect(replayQueuedWrites).not.toHaveBeenCalled();
      expect(await sessionOfAuthJs()).toBeNull();
    });

    // auth-js stores what the attempt comes back with over the session of
    // whoever signed in meanwhile: that one's session is lost either way.
    it('and somebody else signs in before the attempt lands: they are not handed the account that left', async () => {
      const app = await signOutOffline(seconds);
      await act(async () => networkIs('up'));

      expect(await signInAs(app, OTHER.email, 'password-of-bea')).toBeNull();
      expect(app.now().user).toEqual(OTHER);
      expect(app.events).not.toContain('TOKEN_REFRESHED');
      await wait(120_000);

      // The attempt landed. Nobody is signed in — not the account that left,
      // on the page or on the device — and that was not a sign-out of theirs.
      expect(app.events).toContain('TOKEN_REFRESHED');
      expect(app.now()).toMatchObject({ user: null, role: null, isLoading: false, signOuts: 1 });
      expect(sessionOnDevice()).toBeNull();
      expect(await sessionOfAuthJs()).toBeNull();

      // They sign in again, and from then on the device is theirs.
      expect(await signInAs(app, OTHER.email, 'password-of-bea')).toBeNull();
      await wait(300_000);
      expect(app.now()).toMatchObject({ user: OTHER, role: 'student', isLoading: false, signOuts: 1 });
      expect(JSON.parse(sessionOnDevice()).user).toEqual(OTHER);
    });
  });
});
