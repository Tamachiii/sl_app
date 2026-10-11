// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_BODY_BYTES } from '../_shared/auth.js';
import { fakeAdmin, loadFunction } from '../_test/harness.js';

// send-push/index.ts itself, run under Node: the Deno global and the two
// remote imports are replaced, the rest is the file that gets deployed.
//
// The gate has its own tests (../_shared/auth.test.js). What is held here is
// the wiring: the gate comes first and nothing runs for a caller it refuses —
// no client is built, no row is read, no push is sent — and behind it the
// fan-out still does what the deployed version did.

const SECRET = 'c0ffee5f2b7c1e9a4d4e0c8b6a3f1d2c7e9b0a5f2b7c1e9a4d4e0c8b6a3f1d2c';
const ENDPOINT = 'http://functions.invalid/functions/v1/send-push';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const PAYLOAD = { title: 'Feedback from Coach', body: 'Great session', tag: 'feedback-1', data: { url: '/sl_app/#/student' } };

const ENV = {
  SUPABASE_URL: 'https://project.invalid',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-of-the-test',
  INTERNAL_BEARER: SECRET,
  VAPID_PUBLIC_KEY: 'vapid-public',
  VAPID_PRIVATE_KEY: 'vapid-private',
  VAPID_SUBJECT: 'mailto:owner@sl.test',
};

const sub = (id, user) => ({ id, user_id: user, endpoint: `https://push.invalid/${id}`, p256dh: `p256dh-${id}`, auth: `auth-${id}` });

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

beforeEach(() => {
  admin = fakeAdmin({ push_subscriptions: [sub('s1', USER), sub('s2', USER), sub('s3', OTHER)] });
  createClient = vi.fn(() => admin);
  webpush = { setVapidDetails: vi.fn(), sendNotification: vi.fn(async () => ({ statusCode: 201 })) };
  // The gate logs every refusal; that is its job, not noise for this run.
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
    ];
    expect(answers.map((response) => response.status)).toEqual([405, 401, 400, 200, 200]);
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

describe('send-push: behind the gate, the fan-out is the one that was deployed', () => {
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

    expect(webpush.sendNotification.mock.calls).toEqual([
      [{ endpoint: 'https://push.invalid/s1', keys: { p256dh: 'p256dh-s1', auth: 'auth-s1' } }, JSON.stringify(PAYLOAD)],
      [{ endpoint: 'https://push.invalid/s2', keys: { p256dh: 'p256dh-s2', auth: 'auth-s2' } }, JSON.stringify(PAYLOAD)],
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

  it('drops a subscription the push service calls gone, and keeps one that failed otherwise', async () => {
    const gone = Object.assign(new Error('gone'), { statusCode: 410 });
    const busy = Object.assign(new Error('too many requests'), { statusCode: 429 });
    webpush.sendNotification = vi.fn(async ({ endpoint }) => {
      if (endpoint.endsWith('/s1')) throw gone;
      if (endpoint.endsWith('/s2')) throw busy;
      return { statusCode: 201 };
    });
    const response = await call(await load());
    expect(await response.json()).toEqual({ delivered: 0 });
    expect(admin.calls.filter(({ op }) => op === 'delete')).toEqual([
      { table: 'push_subscriptions', op: 'delete', column: 'id', value: 's1' },
    ]);
    expect(admin.calls.filter(({ op }) => op === 'update')).toEqual([]);
  });

  it('answers 500 with the message when the subscriptions cannot be read', async () => {
    admin.error = 'permission denied for table push_subscriptions';
    const response = await call(await load());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'permission denied for table push_subscriptions' });
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });
});
