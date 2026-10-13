// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_BODY_BYTES } from '../_shared/auth.js';
import { fakeAdmin, loadFunction } from '../_test/harness.js';

// dispatch-rest-push/index.ts itself, run under Node: the Deno global and the
// two remote imports are replaced, the rest is the file that gets deployed.
//
// What the function decides has its own tests (../_shared/restPush.test.js).
// What is held here is the wiring. The gateway does not guard this function,
// so its own check comes first and nothing runs for a caller it refuses — no
// client is made, no row is read. Behind it: a user's token goes to the auth
// server with the anon key, the rows are read with the service-role key, the
// work goes to the runtime's waitUntil, and a hop is a request to the
// function's own address with the project's secret.

const SECRET = 'feedc0de2b7c1e9a4d4e0c8b6a3f1d2c7e9b0a5f2b7c1e9a4d4e0c8b6a3f1d2c';
const ENDPOINT = 'http://functions.invalid/functions/v1/dispatch-rest-push';
const SELF = 'https://project.invalid/functions/v1/dispatch-rest-push';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ROW = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = Date.parse('2026-10-13T20:00:00.000Z');
const REST = { title: 'Rest done', body: 'Back to the bar', tag: 'rest-timer' };
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJlLW9mLXRoZS11c2Vy';
const TOKEN_OF_OTHER = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvdGhlciJ9.c2lnbmF0dXJlLW9mLXRoZS1vdGhlcg';

const ENV = {
  SUPABASE_URL: 'https://project.invalid',
  SUPABASE_ANON_KEY: 'anon-key-of-the-test',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-of-the-test',
  INTERNAL_BEARER: SECRET,
  VAPID_PUBLIC_KEY: 'vapid-public',
  VAPID_PRIVATE_KEY: 'vapid-private',
  VAPID_SUBJECT: 'mailto:owner@sl.test',
};

const pgTime = (ms) => new Date(ms).toISOString().replace('Z', '000+00:00');
const sub = (id, user) => ({ id, user_id: user, endpoint: `https://fcm.googleapis.com/fcm/send/${id}`, p256dh: `p256dh-${id}`, auth: `auth-${id}` });

let tables;
let admin;
let createClient;
let authServer; // what the anon client's auth.getUser was asked, and answers
let webpush;

async function load(env = ENV) {
  return loadFunction('dispatch-rest-push', {
    env,
    modules: {
      'jsr:@supabase/supabase-js@2': { createClient },
      'npm:web-push@3.6.7': { default: webpush },
    },
  });
}

const call = (handler, { method = 'POST', token = TOKEN, internal, body = { scheduleId: ROW }, headers = {} } = {}) => (
  handler(new Request(ENDPOINT, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(internal === undefined ? {} : { 'x-internal-bearer': internal }),
      ...headers,
    },
    ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  }))
);

const row = () => tables.scheduled_pushes[0];
const builtWith = () => createClient.mock.calls.map(([, key]) => key);

// What Supabase's runtime has and Deno has not.
function edgeRuntime() {
  const handed = [];
  const waitUntil = vi.fn(function waitUntil(work) {
    // Called as a method of the runtime, as the real one must be.
    if (this !== runtime) throw new TypeError('Illegal invocation');
    handed.push(work);
  });
  const runtime = { waitUntil };
  vi.stubGlobal('EdgeRuntime', runtime);
  return { handed, waitUntil };
}

beforeEach(() => {
  tables = {
    push_subscriptions: [sub('s1', USER), sub('s2', USER), sub('s3', OTHER)],
    // Due now: sent without a wait, unless a test moves its time.
    scheduled_pushes: [{ id: ROW, user_id: USER, status: 'pending', canceled_at: null, fire_at: pgTime(Date.now()), payload: REST, endpoint: null, sent_at: null, error: null }],
  };
  admin = fakeAdmin(tables, {
    rpc: {
      claim_rest_push: ({ p_id }) => {
        const found = tables.scheduled_pushes.find(({ id, status, canceled_at }) => id === p_id && status === 'pending' && !canceled_at);
        if (!found) return { data: null };
        found.status = 'sending';
        return { data: { id: found.id, user_id: found.user_id, payload: found.payload, endpoint: found.endpoint, fire_at: found.fire_at } };
      },
    },
  });
  const owners = { [TOKEN]: USER, [TOKEN_OF_OTHER]: OTHER };
  authServer = vi.fn(async (token) => (owners[token]
    ? { data: { user: { id: owners[token] } }, error: null }
    : { data: { user: null }, error: Object.assign(new Error('invalid JWT'), { status: 403 }) }));
  // supabase-js: the client made with the anon key is the one that asks the
  // auth server; the one made with the service-role key holds the rows.
  createClient = vi.fn((url, key) => {
    if (key === ENV.SUPABASE_ANON_KEY) return { auth: { getUser: authServer } };
    if (key === ENV.SUPABASE_SERVICE_ROLE_KEY) return admin;
    throw new Error(`createClient: a key the function must not use: ${key}`);
  });
  webpush = { setVapidDetails: vi.fn(), sendNotification: vi.fn(async () => ({ statusCode: 201 })) };
  // Every refusal and every hop is a line of the log; that is their job, not
  // noise for this run.
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('dispatch-rest-push: the gateway does not guard it, its own check comes first', () => {
  const untouched = () => {
    expect(createClient).not.toHaveBeenCalled();
    expect(admin.calls).toEqual([]);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  };

  it('refuses a call that shows nothing, before anything else happens', async () => {
    const response = await call(await load(), { token: null });
    expect(response.status).toBe(401);
    // What the check of the runbook reads: the function's own refusal.
    expect(await response.text()).toBe('dispatch-rest-push: unauthorized');
    untouched();
  });

  it('refuses a wrong internal bearer, with or without a good token next to it', async () => {
    const handler = await load();
    for (const options of [
      { token: null, internal: `${SECRET.slice(0, -1)}0` },
      { internal: `${SECRET.slice(0, -1)}0` },
      { token: null, internal: ENV.SUPABASE_SERVICE_ROLE_KEY },
      { token: null, internal: '' },
    ]) {
      const response = await call(handler, { ...options, body: { scheduleId: ROW, hop: 2 } });
      expect(response.status, JSON.stringify(options)).toBe(401);
      expect(await response.text()).toBe('dispatch-rest-push: unauthorized');
    }
    untouched();
  });

  it('refuses the secret of the project and the keys of the project shown as a token', async () => {
    const handler = await load();
    for (const token of [SECRET, ENV.SUPABASE_SERVICE_ROLE_KEY, ENV.SUPABASE_ANON_KEY]) {
      expect((await call(handler, { token })).status, token).toBe(401);
    }
    untouched();
  });

  it('asks the auth server about a token, with the anon key, and refuses the one it does not accept', async () => {
    const forged = TOKEN.replace(/.$/, 'x');
    const response = await call(await load(), { token: forged });
    expect(response.status).toBe(401);
    expect(createClient.mock.calls).toEqual([
      ['https://project.invalid', 'anon-key-of-the-test', { global: { headers: { Authorization: `Bearer ${forged}` } } }],
    ]);
    expect(authServer.mock.calls).toEqual([[forged]]);
    // The client that holds every row was not made for it.
    expect(builtWith()).not.toContain(ENV.SUPABASE_SERVICE_ROLE_KEY);
    expect(admin.calls).toEqual([]);
  });

  it('lets no hop in while INTERNAL_BEARER is not set, "undefined" included, and still serves the app', async () => {
    const { INTERNAL_BEARER: _unset, ...env } = ENV;
    const handler = await load(env);
    for (const internal of ['undefined', 'null', '', SECRET]) {
      const response = await call(handler, { token: null, internal, body: { scheduleId: ROW, hop: 2 } });
      expect(response.status, JSON.stringify(internal)).toBe(500);
      expect(await response.text()).toBe('dispatch-rest-push: not configured');
    }
    untouched();
    expect(console.error).toHaveBeenCalledWith('dispatch-rest-push: INTERNAL_BEARER is not set: no hop is let in, and a rest longer than a minute does not ring');

    const response = await call(handler);
    expect(response.status).toBe(202);
    expect(row().status).toBe('sent');
  });

  it('refuses a body over 8 kB, and one that names no row, without reading a row', async () => {
    const handler = await load();
    const large = await call(handler, { body: JSON.stringify({ scheduleId: ROW, pad: 'x'.repeat(MAX_BODY_BYTES) }) });
    expect(large.status).toBe(413);
    expect(await large.text()).toBe('dispatch-rest-push: payload too large');
    for (const body of ['not json', '[]', '{}', { scheduleId: 'not-a-uuid' }]) {
      const response = await call(handler, { body });
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.text()).toMatch(/^dispatch-rest-push: /);
    }
    expect(builtWith()).not.toContain(ENV.SUPABASE_SERVICE_ROLE_KEY);
    expect(admin.calls).toEqual([]);
  });
});

// The app calls this function from a page: unlike send-push, it answers a
// preflight, and every answer may be read by the page.
describe('dispatch-rest-push: the app calls it from a browser', () => {
  it('answers a preflight without asking who calls', async () => {
    const response = await call(await load(), {
      method: 'OPTIONS', token: null, headers: { origin: 'https://tamachiii.github.io', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, x-client-info, apikey, content-type' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-headers')).toBe('authorization, x-client-info, apikey, content-type');
    expect(createClient).not.toHaveBeenCalled();
  });

  it('carries the CORS headers on what it answers the app, refusals included', async () => {
    const handler = await load();
    const answers = [
      await call(handler, { method: 'GET' }),
      await call(handler, { token: null }),
      await call(handler, { body: {} }),
      await call(handler, { body: { scheduleId: ROW.replace(/a/g, 'c') } }),
      await call(handler, { token: TOKEN_OF_OTHER }),
      await call(handler),
      await call(handler),
    ];
    expect(answers.map((response) => response.status)).toEqual([405, 401, 400, 404, 403, 202, 200]);
    for (const response of answers) {
      expect(response.headers.get('access-control-allow-origin'), `HTTP ${response.status}`).toBe('*');
    }
    // The row of somebody else was neither sent nor touched by them.
    expect(webpush.sendNotification).toHaveBeenCalledTimes(2);
  });
});

describe('dispatch-rest-push: behind its check, the row is sent by the runtime\'s waitUntil', () => {
  it('signs with the VAPID secrets, reads the rows with the service-role key, and asks whose row it is', async () => {
    const handler = await load();
    expect(webpush.setVapidDetails).toHaveBeenCalledWith('mailto:owner@sl.test', 'vapid-public', 'vapid-private');

    expect((await call(handler, { token: TOKEN_OF_OTHER })).status).toBe(403);
    expect(createClient.mock.calls).toEqual([
      ['https://project.invalid', 'anon-key-of-the-test', { global: { headers: { Authorization: `Bearer ${TOKEN_OF_OTHER}` } } }],
      ['https://project.invalid', 'service-role-key-of-the-test'],
    ]);
    expect(authServer.mock.calls).toEqual([[TOKEN_OF_OTHER]]);
    expect(admin.calls).toEqual([{ table: 'scheduled_pushes', op: 'select', column: 'id', value: ROW }]);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  it('answers 202, hands the work over, and the work claims the row, sends and records', async () => {
    const { handed, waitUntil } = edgeRuntime();
    const response = await call(await load());
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    expect(waitUntil).toHaveBeenCalledTimes(1);

    await Promise.all(handed);
    expect(admin.calls.filter((entry) => entry.rpc)).toEqual([{ rpc: 'claim_rest_push', args: { p_id: ROW } }]);
    const options = { TTL: 60, urgency: 'high', timeout: 5000 };
    expect(webpush.sendNotification.mock.calls).toEqual([
      [{ endpoint: 'https://fcm.googleapis.com/fcm/send/s1', keys: { p256dh: 'p256dh-s1', auth: 'auth-s1' } }, JSON.stringify(REST), options],
      [{ endpoint: 'https://fcm.googleapis.com/fcm/send/s2', keys: { p256dh: 'p256dh-s2', auth: 'auth-s2' } }, JSON.stringify(REST), options],
    ]);
    expect(row()).toMatchObject({ status: 'sent', error: null });
    expect(row().sent_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('reads the runtime when the request comes in, not when the function starts', async () => {
    const handler = await load();
    const { handed, waitUntil } = edgeRuntime();
    expect((await call(handler)).status).toBe(202);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await Promise.all(handed);
  });

  // Deno alone — a test, an old `supabase functions serve` — has no
  // EdgeRuntime. The push is then sent before the answer, not dropped.
  it('still sends where there is no such runtime, before it answers', async () => {
    const response = await call(await load());
    expect(response.status).toBe(202);
    expect(row().status).toBe('sent');
    expect(webpush.sendNotification).toHaveBeenCalledTimes(2);
  });

  it('sends a row the app calls twice for once', async () => {
    const { handed } = edgeRuntime();
    const handler = await load();
    await call(handler);
    await call(handler);
    await Promise.all(handed);
    expect(webpush.sendNotification).toHaveBeenCalledTimes(2);
    expect(admin.calls.filter(({ op, table }) => op === 'update' && table === 'scheduled_pushes')).toHaveLength(1);
  });
});

// A rest longer than a minute: the function calls its own address. Here the
// address is answered by the function itself, and the clock is the test's.
describe('dispatch-rest-push: a hop is a request to its own address, with the secret and without the token', () => {
  it('rings a rest of 180 s in three requests, and asks the auth server once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(NOW);
    Object.assign(row(), { fire_at: pgTime(NOW + 180000) });
    const { handed } = edgeRuntime();
    const handler = await load();
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      requests.push({ url, method: init.method, headers: { ...init.headers }, body: JSON.parse(init.body), redirect: init.redirect });
      return handler(new Request(url, init));
    }));

    expect((await call(handler)).status).toBe(202);
    await vi.advanceTimersByTimeAsync(59999);
    expect(requests).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(requests).toEqual([{
      url: SELF,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-bearer': SECRET },
      body: { scheduleId: ROW, hop: 2 },
      redirect: 'manual',
    }]);
    await vi.advanceTimersByTimeAsync(60000);
    expect(requests.map(({ body }) => body.hop)).toEqual([2, 3]);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
    expect(admin.calls.filter((entry) => entry.rpc)).toEqual([]);

    await vi.advanceTimersByTimeAsync(59999);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all(handed);
    expect(handed).toHaveLength(3);
    expect(webpush.sendNotification).toHaveBeenCalledTimes(2);
    expect(row()).toMatchObject({ status: 'sent', sent_at: '2026-10-13T20:03:00.000Z' });

    // The athlete's token went to the auth server once, and to no hop.
    expect(authServer.mock.calls).toEqual([[TOKEN]]);
    expect(builtWith().filter((key) => key === ENV.SUPABASE_ANON_KEY)).toHaveLength(1);
    expect(JSON.stringify(requests)).not.toContain(TOKEN);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('says in its log when the next hop is refused, and sends nothing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(NOW);
    Object.assign(row(), { fire_at: pgTime(NOW + 180000) });
    const { handed } = edgeRuntime();
    // Deployed with JWT verification on: the gateway answers the hop.
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 401, message: 'Missing authorization header' }, { status: 401 })));

    expect((await call(await load())).status).toBe(202);
    await vi.advanceTimersByTimeAsync(60000);
    await Promise.all(handed);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(
      `dispatch-rest-push: rest push ${ROW}: hop 2 did not take over, the rest does not ring: HTTP 401 {"code":401,"message":"Missing authorization header"}`,
    );
    expect(webpush.sendNotification).not.toHaveBeenCalled();
    expect(row().status).toBe('pending');
  });
});
