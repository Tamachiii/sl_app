// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_BODY_BYTES } from '../_shared/auth.js';
import { fakeAdmin, loadFunction } from '../_test/harness.js';

// send-push/index.ts itself, run under Node: the Deno global and the two
// remote imports are replaced, the rest is the file that gets deployed.
//
// The gate has its own tests (../_shared/auth.test.js), and so has what the
// function does behind it (../_shared/push.test.js). What is held here is
// the wiring: the gate comes first and nothing runs for a caller it refuses —
// no client is built, no row is read, no push is sent — and behind it the
// request reaches the shared module with the real clients' stand-ins, the
// secrets of the environment and the runtime's waitUntil.

const SECRET = 'c0ffee5f2b7c1e9a4d4e0c8b6a3f1d2c7e9b0a5f2b7c1e9a4d4e0c8b6a3f1d2c';
const ENDPOINT = 'http://functions.invalid/functions/v1/send-push';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const PAYLOAD = { title: 'Feedback from Coach', body: 'Great session', tag: 'feedback-1', data: { url: '/sl_app/#/student' } };
const ROW = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REST = { title: 'Rest done', body: 'Back to the bar', tag: 'rest-timer' };

const ENV = {
  SUPABASE_URL: 'https://project.invalid',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-of-the-test',
  INTERNAL_BEARER: SECRET,
  VAPID_PUBLIC_KEY: 'vapid-public',
  VAPID_PRIVATE_KEY: 'vapid-private',
  VAPID_SUBJECT: 'mailto:owner@sl.test',
};

// At a push service of the list: the function sends nowhere else.
const sub = (id, user) => ({ id, user_id: user, endpoint: `https://fcm.googleapis.com/fcm/send/${id}`, p256dh: `p256dh-${id}`, auth: `auth-${id}` });

let admin;
let createClient;
let webpush;

async function load(env = ENV) {
  return loadFunction('send-push', {
    env,
    modules: {
      'jsr:@supabase/supabase-js@2': { createClient },
      'npm:web-push@3.6.7': { default: webpush },
    },
  });
}

const call = (handler, { method = 'POST', bearer = SECRET, body = { user_id: USER, payload: PAYLOAD }, headers = {} } = {}) => (
  handler(new Request(ENDPOINT, {
    method,
    headers: { ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }), ...headers },
    ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  }))
);

const corsHeaders = (response) => [...response.headers.keys()].filter((name) => name.startsWith('access-control-'));

let tables;

beforeEach(() => {
  tables = {
    push_subscriptions: [sub('s1', USER), sub('s2', USER), sub('s3', OTHER)],
    scheduled_pushes: [{ id: ROW, user_id: USER, status: 'pending', sent_at: null, error: null }],
  };
  admin = fakeAdmin(tables, {
    rpc: {
      claim_rest_push: ({ p_id }) => {
        const row = tables.scheduled_pushes.find(({ id, status }) => id === p_id && status === 'pending');
        if (!row) return { data: null };
        row.status = 'sending';
        return { data: { id: row.id, user_id: row.user_id, payload: REST, endpoint: null, fire_at: '2026-10-13T20:00:00+00:00' } };
      },
    },
  });
  createClient = vi.fn(() => admin);
  webpush = { setVapidDetails: vi.fn(), sendNotification: vi.fn(async () => ({ statusCode: 201 })) };
  // The gate and the fan-out log every refusal and every push that was not
  // taken; that is their job, not noise for this run.
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('send-push: nobody but the project gets past the gate', () => {
  const untouched = () => {
    expect(createClient).not.toHaveBeenCalled();
    expect(admin.calls).toEqual([]);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  };

  it('refuses a call without a bearer, before anything else happens', async () => {
    const response = await call(await load(), { bearer: null });
    expect(response.status).toBe(401);
    expect(await response.text()).toBe('send-push: unauthorized');
    untouched();
  });

  it('refuses a wrong bearer, the service-role key and the anon-style apikey header', async () => {
    const handler = await load();
    for (const options of [
      { bearer: `${SECRET.slice(0, -1)}0` },
      { bearer: SECRET.slice(0, -1) },
      { bearer: ENV.SUPABASE_SERVICE_ROLE_KEY },
      { bearer: null, headers: { apikey: SECRET } },
    ]) {
      const response = await call(handler, options);
      expect(response.status, JSON.stringify(options)).toBe(401);
    }
    untouched();
  });

  it('refuses everyone while INTERNAL_BEARER is not set, "Bearer undefined" included', async () => {
    const { INTERNAL_BEARER: _unset, ...env } = ENV;
    const handler = await load(env);
    for (const bearer of [null, 'undefined', 'null', '', SECRET]) {
      const response = await call(handler, { bearer });
      expect(response.status, JSON.stringify(bearer)).toBe(500);
      expect(await response.text()).toBe('send-push: not configured');
    }
    expect(console.error).toHaveBeenCalledWith('send-push: INTERNAL_BEARER is not set, every call is refused');
    untouched();
  });

  // The deployed version answered OPTIONS with 200 and every request with
  // `Access-Control-Allow-Origin: *`: any page could call it from a browser.
  it('gives a browser no permission: no preflight, no CORS header on any answer', async () => {
    const handler = await load();
    const origin = { origin: 'https://tamachiii.github.io' };

    const preflight = await call(handler, {
      method: 'OPTIONS', bearer: null, headers: { ...origin, 'access-control-request-method': 'POST' },
    });
    expect(preflight.status).toBe(405);
    expect(corsHeaders(preflight)).toEqual([]);
    untouched();

    const answers = [
      await call(handler, { method: 'GET', headers: origin }),
      await call(handler, { bearer: null, headers: origin }),
      await call(handler, { body: { user_id: USER }, headers: origin }),
      await call(handler, { body: { user_id: OTHER.replace('2', '9'), payload: PAYLOAD }, headers: origin }),
      await call(handler, { headers: origin }),
      await call(handler, { body: { user_id: USER, payload: REST, schedule_id: ROW, not_before: '2026-10-13T20:00:00+00:00' }, headers: origin }),
      await call(handler, { body: { user_id: USER, payload: REST, schedule_id: ROW, not_before: 'soon' }, headers: origin }),
    ];
    webpush.sendNotification.mockRejectedValue(Object.assign(new Error('forbidden'), { statusCode: 403, body: 'Forbidden' }));
    answers.push(await call(handler, { headers: origin }));
    expect(answers.map((response) => response.status)).toEqual([405, 401, 400, 200, 200, 202, 400, 502]);
    for (const response of answers) expect(corsHeaders(response), `HTTP ${response.status}`).toEqual([]);
  });

  it('refuses a body over 8 kB without reading a row', async () => {
    const handler = await load();
    const body = JSON.stringify({ user_id: USER, payload: { ...PAYLOAD, body: 'x'.repeat(MAX_BODY_BYTES) } });
    const response = await call(handler, { body });
    expect(response.status).toBe(413);
    expect(await response.text()).toBe('send-push: payload too large');
    untouched();
  });

  it('refuses a body that is not JSON, or lacks the user or the payload', async () => {
    const handler = await load();
    for (const body of ['not json', '[]', '{}', { user_id: USER }, { payload: PAYLOAD }, { user_id: '', payload: PAYLOAD }]) {
      const response = await call(handler, { body });
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.text()).toMatch(/^send-push: /);
    }
    untouched();
  });
});

describe('send-push: behind the gate, an event goes to the devices of its user', () => {
  it('builds its client with the service-role key and signs with the VAPID secrets', async () => {
    await call(await load());
    expect(webpush.setVapidDetails).toHaveBeenCalledWith('mailto:owner@sl.test', 'vapid-public', 'vapid-private');
    expect(createClient).toHaveBeenCalledWith('https://project.invalid', 'service-role-key-of-the-test');
  });

  it('sends the payload, as it came, to every device of that user and of nobody else', async () => {
    const response = await call(await load());
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ delivered: 2 });

    // Kept for a day and not for the library's four weeks, with a time limit.
    const options = { TTL: 86400, urgency: 'normal', timeout: 5000 };
    expect(webpush.sendNotification.mock.calls).toEqual([
      [{ endpoint: 'https://fcm.googleapis.com/fcm/send/s1', keys: { p256dh: 'p256dh-s1', auth: 'auth-s1' } }, JSON.stringify(PAYLOAD), options],
      [{ endpoint: 'https://fcm.googleapis.com/fcm/send/s2', keys: { p256dh: 'p256dh-s2', auth: 'auth-s2' } }, JSON.stringify(PAYLOAD), options],
    ]);
    expect(admin.calls[0]).toEqual({ table: 'push_subscriptions', op: 'select', column: 'user_id', value: USER });
    const seen = admin.calls.filter(({ op }) => op === 'update');
    expect(seen.map(({ value }) => value).sort()).toEqual(['s1', 's2']);
    for (const { values } of seen) expect(Object.keys(values)).toEqual(['last_seen_at']);
  });

  // What the runbook's check after a deploy relies on: a user id nobody has.
  it('answers 200 and delivered 0 for a user without a device, and sends nothing', async () => {
    const response = await call(await load(), {
      body: { user_id: '00000000-0000-0000-0000-000000000000', payload: { title: 'deploy check' } },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"delivered":0}');
    expect(webpush.sendNotification).not.toHaveBeenCalled();
    expect(admin.calls.filter(({ op }) => op !== 'select')).toEqual([]);
  });

  it('takes how long the push is kept, and how urgent it is, from the request of the database', async () => {
    await call(await load(), { body: { user_id: USER, payload: PAYLOAD, ttl: 3600, urgency: 'high' } });
    expect(webpush.sendNotification.mock.calls.map(([, , options]) => options)).toEqual([
      { TTL: 3600, urgency: 'high', timeout: 5000 },
      { TTL: 3600, urgency: 'high', timeout: 5000 },
    ]);
  });

  // The version before answered 200 {"delivered":0} here, and wrote nothing:
  // a VAPID key the push services refuse was a silence (review P35).
  it('answers 502 and writes a line per device when there were devices and none took the push', async () => {
    const gone = Object.assign(new Error('gone'), { statusCode: 410, body: 'push subscription has unsubscribed or expired.\n' });
    const busy = Object.assign(new Error('too many requests'), { statusCode: 429, body: 'Too Many Requests' });
    webpush.sendNotification = vi.fn(async ({ endpoint }) => {
      if (endpoint.endsWith('/s1')) throw gone;
      if (endpoint.endsWith('/s2')) throw busy;
      return { statusCode: 201 };
    });
    const response = await call(await load());
    expect(response.status).toBe(502);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ delivered: 0, failed: 1 });

    // The subscription the push service calls gone is dropped, the one that
    // failed otherwise is kept.
    expect(admin.calls.filter(({ op }) => op === 'delete')).toEqual([
      { table: 'push_subscriptions', op: 'delete', column: 'id', value: 's1' },
    ]);
    expect(admin.calls.filter(({ op }) => op === 'update')).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith('send-push: push failed status=410 host=fcm.googleapis.com subscription=s1 body="push subscription has unsubscribed or expired."');
    expect(console.error).toHaveBeenCalledWith('send-push: push failed status=429 host=fcm.googleapis.com subscription=s2 body="Too Many Requests"');
    expect(console.error).toHaveBeenCalledWith('send-push: no device got the push (1 failed, 1 gone)');
  });

  it('calls no address that is not at a push service, whatever a row holds', async () => {
    tables.push_subscriptions = [{ ...sub('s1', USER), endpoint: 'https://attacker.example/collect/s1' }];
    const response = await call(await load());
    expect(response.status).toBe(502);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
    expect(admin.calls.filter(({ op }) => op !== 'select')).toEqual([]);
    expect(console.error).toHaveBeenCalledWith('send-push: push not sent host=attacker.example subscription=s1 reason="not an address at a push service of the list"');
  });

  it('answers 500 with the message when the subscriptions cannot be read', async () => {
    admin.error = 'permission denied for table push_subscriptions';
    const response = await call(await load());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'permission denied for table push_subscriptions' });
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });
});

// A rest push that the job of the database hands over: `schedule_id` and the
// time not to send before. The answer comes first; the push is sent by what
// the runtime keeps alive after it.
describe('send-push: a rest push is answered at once and sent by the runtime\'s waitUntil', () => {
  const body = (extra = {}) => ({
    user_id: USER, payload: REST, schedule_id: ROW, not_before: '2026-10-13T20:00:00+00:00', ttl: 60, urgency: 'high', ...extra,
  });

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

  it('answers 202, hands the work over, and the work claims the row, sends and records', async () => {
    const { handed, waitUntil } = edgeRuntime();
    const response = await call(await load(), { body: body() });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    expect(waitUntil).toHaveBeenCalledTimes(1);

    await Promise.all(handed);
    expect(admin.calls[0]).toEqual({ rpc: 'claim_rest_push', args: { p_id: ROW } });
    const options = { TTL: 60, urgency: 'high', timeout: 5000 };
    expect(webpush.sendNotification.mock.calls).toEqual([
      [{ endpoint: 'https://fcm.googleapis.com/fcm/send/s1', keys: { p256dh: 'p256dh-s1', auth: 'auth-s1' } }, JSON.stringify(REST), options],
      [{ endpoint: 'https://fcm.googleapis.com/fcm/send/s2', keys: { p256dh: 'p256dh-s2', auth: 'auth-s2' } }, JSON.stringify(REST), options],
    ]);
    expect(tables.scheduled_pushes[0]).toMatchObject({ status: 'sent', error: null });
    expect(tables.scheduled_pushes[0].sent_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(createClient).toHaveBeenCalledWith('https://project.invalid', 'service-role-key-of-the-test');
  });

  it('reads the runtime when the request comes in, not when the function starts', async () => {
    const handler = await load();
    const { handed, waitUntil } = edgeRuntime();
    expect((await call(handler, { body: body() })).status).toBe(202);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await Promise.all(handed);
  });

  it('sends a row that is handed over twice once', async () => {
    const { handed } = edgeRuntime();
    const handler = await load();
    await call(handler, { body: body() });
    await call(handler, { body: body() });
    await Promise.all(handed);
    expect(webpush.sendNotification).toHaveBeenCalledTimes(2);
    expect(admin.calls.filter((entry) => entry.rpc)).toHaveLength(2);
    expect(admin.calls.filter(({ table }) => table === 'scheduled_pushes')).toHaveLength(1);
  });

  // Deno alone — `supabase functions serve` of an old CLI, a test — has no
  // EdgeRuntime. The push is then sent before the answer, not dropped.
  it('still sends where there is no such runtime, before it answers', async () => {
    const response = await call(await load(), { body: body() });
    expect(response.status).toBe(202);
    expect(tables.scheduled_pushes[0].status).toBe('sent');
    expect(webpush.sendNotification).toHaveBeenCalledTimes(2);
  });

  it('never sends a request that names a row the other way: at once, to every device', async () => {
    const { handed } = edgeRuntime();
    const handler = await load();
    for (const extra of [{ schedule_id: 'not-a-uuid' }, { schedule_id: null }, { not_before: undefined }, { not_before: '2099-01-01T00:00:00Z' }]) {
      const response = await call(handler, { body: body(extra) });
      expect(response.status, JSON.stringify(extra)).toBe(400);
      expect(await response.text()).toMatch(/^send-push: /);
    }
    expect(handed).toEqual([]);
    expect(createClient).not.toHaveBeenCalled();
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });
});
