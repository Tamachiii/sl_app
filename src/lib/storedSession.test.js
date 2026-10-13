import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// lib/storedSession.js reads and removes what supabase-js stores, without
// going through it. That only holds while the two agree on WHERE the session
// is stored, in WHICH shape, and on what its absence means — so the file is
// run here against the real client: the one of lib/supabase.js in everything
// but its transport, which is a function of this file instead of the network.

const device = vi.hoisted(() => ({ client: null, answer: null, requests: [] }));

// lib/supabase.js exports one client for the life of the page. Here each
// "launch" builds a new one, and the module hands out the current one.
vi.mock('./supabase', () => ({
  get supabase() {
    return device.client;
  },
}));

import { createClient } from '@supabase/supabase-js';
import { readStoredUser, forgetStoredSession } from './storedSession';

const USER = { id: 'u-athlete', email: 'athlete@example.test', aud: 'authenticated', role: 'authenticated' };
const STORAGE_KEY = 'sb-device-test-auth-token';

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const noNetwork = () => Promise.reject(new TypeError('Failed to fetch'));

// What the auth server answers to a sign-in or to a refresh that it accepts.
function tokenAnswer({ expiresIn = 3600 } = {}) {
  const part = (value) => btoa(JSON.stringify(value)).replace(/=+$/, '');
  const now = Math.floor(Date.now() / 1000);
  return json(200, {
    access_token: `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ sub: USER.id, exp: now + expiresIn })}.signature`,
    token_type: 'bearer',
    expires_in: expiresIn,
    expires_at: now + expiresIn,
    refresh_token: 'refresh-token',
    user: USER,
  });
}

// A launch of the app: the client is built again, as a page load builds it,
// on whatever the device stores. Same call as lib/supabase.js — a URL, the
// anonymous key, the library's defaults for everything about the session.
const launched = [];
function launch() {
  const fetchFromTest = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    device.requests.push({ url, method: init?.method ?? 'GET' });
    return device.answer(url, init);
  };
  device.client = createClient('https://device-test.supabase.co', 'anon-key', { global: { fetch: fetchFromTest } });
  launched.push(device.client);
  return device.client;
}

beforeEach(() => {
  localStorage.clear();
  device.requests = [];
  device.answer = () => tokenAnswer();
  // The library logs each refresh it could not make, and each second client.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  // Each client keeps a timer for the token refresh.
  await Promise.all(launched.splice(0).map((client) => client.auth.stopAutoRefresh()));
  device.client = null;
});

async function signedInDevice() {
  const client = launch();
  const { error } = await client.auth.signInWithPassword({ email: USER.email, password: 'pw' });
  expect(error).toBeNull();
  return client;
}

describe('where supabase-js stores the session, and in which shape', () => {
  it('a sign-in is stored under the key the client names, and read back as the same user', async () => {
    const client = await signedInDevice();

    expect(client.auth.storageKey).toBe(STORAGE_KEY);
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
    expect(readStoredUser()).toEqual(USER);
    // And it is the user the library itself hands out.
    const { data } = await client.auth.getSession();
    expect(readStoredUser()).toEqual(data.session.user);
  });

  it('a device that stores nothing has nobody signed in', async () => {
    const client = launch();

    expect(readStoredUser()).toBeNull();
    expect((await client.auth.getSession()).data.session).toBeNull();
  });

  it('something else under the key is nobody', async () => {
    launch();

    for (const stored of ['not json', 'null', '"text"', '{}', '{"access_token":"a","refresh_token":"r"}']) {
      localStorage.setItem(STORAGE_KEY, stored);
      expect(readStoredUser()).toBeNull();
    }
    // A session whose user is missing names nobody either.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_at: 1 }));
    expect(readStoredUser()).toBeNull();
  });
});

describe('the next launch, with a token that has expired', () => {
  // The token of the stored session ran out while the app was closed.
  async function closedForHours() {
    await signedInDevice();
    const session = JSON.parse(localStorage.getItem(STORAGE_KEY));
    session.expires_at = Math.floor(Date.now() / 1000) - 3600;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  }

  it('without a network: the library answers "no session" after its attempts, and the device still knows who is signed in', async () => {
    await closedForHours();
    device.answer = noNetwork;
    vi.useFakeTimers();

    const client = launch();
    // Known at once, before the library has said anything.
    expect(readStoredUser()).toEqual(USER);

    let answer;
    client.auth.getSession().then((result) => {
      answer = result;
    });
    // Half a minute in: still attempting the refresh, still no answer.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(answer).toBeUndefined();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(answer.data.session).toBeNull();
    expect(answer.error?.name).toBe('AuthRetryableFetchError');
    // The session was not removed: it is refreshed when the network is back.
    expect(readStoredUser()).toEqual(USER);
  });

  it('with a server that refuses the refresh: the library removes the stored session itself', async () => {
    await closedForHours();
    device.answer = () => json(400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token' });

    const client = launch();
    const events = [];
    client.auth.onAuthStateChange((event) => events.push(event));
    const { data, error } = await client.auth.getSession();

    expect(data.session).toBeNull();
    expect(error?.name).not.toBe('AuthRetryableFetchError');
    expect(readStoredUser()).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    // And says so: this is the one event that signs the user out (useAuth).
    expect(events).toContain('SIGNED_OUT');
  });
});

describe('signing out a device', () => {
  it('auth.signOut() without a network leaves the device signed in — with scope "local" as well', async () => {
    const client = await signedInDevice();
    device.answer = noNetwork;

    const { error } = await client.auth.signOut({ scope: 'local' });

    expect(error?.name).toBe('AuthRetryableFetchError');
    expect(readStoredUser()).toEqual(USER);
    expect((await client.auth.getSession()).data.session).not.toBeNull();
  });

  it('forgetStoredSession() signs it out: this page and the next launch find no session, and no request was needed', async () => {
    const client = await signedInDevice();
    device.answer = noNetwork;
    device.requests = [];

    forgetStoredSession();

    expect(readStoredUser()).toBeNull();
    expect(await client.auth.getSession()).toEqual({ data: { session: null }, error: null });
    expect(await launch().auth.getSession()).toEqual({ data: { session: null }, error: null });
    expect(device.requests).toEqual([]);
  });
});

describe('a client that does not say where it stores the session', () => {
  it('reads nobody and removes nothing — the stand-in for lib/supabase of most tests', () => {
    device.client = { auth: { getSession: vi.fn() } };
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_at: 1, user: USER }));

    expect(readStoredUser()).toBeNull();
    forgetStoredSession();
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
  });
});
