// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_BODY_BYTES } from './auth.js';
import { SEND_DEADLINE_MS } from './push.js';
import {
  CLOCK_SLACK_MS, CORS_HEADERS, HANDOVER_DEADLINE_MS, HOP_MS, INTERNAL_HEADER, LAST_HOP_MIN_MS, MAX_AHEAD_MS, MAX_HOPS,
  MAX_REST_MS, TOP_UP_MAX_MS, authenticate, dispatchRestPush, functionUrl, planHop,
} from './restPush.js';
import { fakeAdmin } from '../_test/harness.js';

// What dispatch-rest-push decides (review P10): who is let in, how a rest
// that is longer than a function may wait is cut into hops, when a chain of
// hops stops, and that the last hop sends through the claim and no other way.
//
// Nothing here is Deno, and nothing is real: the auth server, the
// service-role client, the web-push library, the clock and the request a hop
// makes to the function itself are handed in — that request is answered by
// the function, so a chain runs from its first request to its push.
// dispatch-rest-push/index.test.js holds the adapter that hands in the real
// ones.

const NAME = 'dispatch-rest-push';
const SELF = 'https://project.invalid/functions/v1/dispatch-rest-push';
const SECRET = 'd1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ROW = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = Date.parse('2026-10-13T20:00:00.000Z');
const REST = { title: 'Rest done', body: 'Back to the bar', tag: 'rest-timer', data: { url: '/sl_app/#/student' } };

// What a user's token looks like: three parts. Whose it is, is the auth
// server's answer, not something the function reads in it.
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJlLW9mLXRoZS11c2Vy';
const TOKEN_OF_OTHER = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvdGhlciJ9.c2lnbmF0dXJlLW9mLXRoZS1vdGhlcg';
const EXPIRED = 'eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjF9.c2lnbmF0dXJlLW9mLWFuLW9sZC10b2tlbg';

// Postgres writes a timestamptz into JSON with six decimals and an offset.
const pgTime = (ms) => new Date(ms).toISOString().replace('Z', '000+00:00');
const s = (n) => n * 1000;

const device = (id, user) => ({ id, user_id: user, endpoint: `https://fcm.googleapis.com/fcm/send/${id}`, p256dh: `p256dh-${id}`, auth: `auth-${id}` });

let t; // the clock, in ms
let tables;
let admin;
let createAdmin;
let webpush;
let getUser;
let log;
let sleep;
let handed; // what the runtime was given to keep alive, request by request
let fetchSelf; // the request a hop makes to the function itself

const row = () => tables.scheduled_pushes[0];
const lines = (level) => log[level].mock.calls.map(([line]) => line);
const everyLine = () => ['info', 'warn', 'error'].flatMap(lines).join('\n');
const claims = () => admin.calls.filter((entry) => entry.rpc === 'claim_rest_push');
const writes = () => admin.calls.filter(({ op }) => op === 'update' || op === 'delete');
const sentTo = () => webpush.sendNotification.mock.calls.map(([sub]) => sub.endpoint);
// The hops, as the requests they were: who they showed and what they said.
const hops = () => fetchSelf.mock.calls.map(([url, init]) => ({
  url, method: init.method, headers: init.headers, body: JSON.parse(init.body), redirect: init.redirect,
}));

function request({ method = 'POST', token = TOKEN, internal, body = { scheduleId: ROW }, headers = {} } = {}) {
  return new Request(SELF, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(internal === undefined ? {} : { [INTERNAL_HEADER]: internal }),
      ...headers,
    },
    ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
}

const context = (extra = {}) => ({
  name: NAME,
  bearer: SECRET,
  selfUrl: SELF,
  getUser,
  createAdmin,
  webpush,
  waitUntil: (work) => { handed.push(work); },
  sleep,
  now: () => t,
  log,
  fetch: fetchSelf,
  ...extra,
});

const dispatch = (options, extra) => dispatchRestPush(request(options), context(extra));

// A rest that ends `ms` from now, started by the app: the row and the call.
function rest(ms, more = {}) {
  Object.assign(row(), { fire_at: pgTime(t + ms), ...more });
}

// Everything the runtime was handed, hops included, to its end.
async function settled() {
  for (let i = 0; i < handed.length; i += 1) await handed[i];
}

// A clock that stands still: a wait ends when the test says so. `waiting`
// holds the waits that are going on, oldest first; calling one ends it.
function heldClock() {
  const waiting = [];
  sleep.mockImplementation((ms) => new Promise((resolve) => {
    waiting.push(() => { t += ms; resolve(); });
  }));
  return waiting;
}

beforeEach(() => {
  t = NOW;
  handed = [];
  tables = {
    push_subscriptions: [device('d1', USER), device('d2', USER), device('d3', OTHER)],
    scheduled_pushes: [{
      id: ROW, user_id: USER, status: 'pending', canceled_at: null, fire_at: pgTime(NOW + s(60)),
      payload: REST, endpoint: null, sent_at: null, error: null,
    }],
  };
  // claim_rest_push as migration 16 has it: a row that is waiting and not
  // more than a minute late, once; a row that can no longer be sent is closed.
  admin = fakeAdmin(tables, {
    rpc: {
      claim_rest_push: ({ p_id }) => {
        const found = tables.scheduled_pushes.find(({ id }) => id === p_id);
        if (!found || found.status !== 'pending') return { data: null };
        const late = Date.parse(found.fire_at) <= t - s(60);
        if (found.canceled_at || late) {
          found.status = found.canceled_at ? 'canceled' : 'expired';
          return { data: null };
        }
        found.status = 'sending';
        return { data: { id: found.id, user_id: found.user_id, payload: found.payload, endpoint: found.endpoint, fire_at: found.fire_at } };
      },
    },
  });
  createAdmin = vi.fn(() => admin);
  webpush = { sendNotification: vi.fn(async () => ({ statusCode: 201 })) };
  // The auth server, as supabase-js answers for it.
  const owners = { [TOKEN]: USER, [TOKEN_OF_OTHER]: OTHER };
  getUser = vi.fn(async (token) => (owners[token]
    ? { data: { user: { id: owners[token] } }, error: null }
    : { data: { user: null }, error: Object.assign(new Error('invalid JWT: token is expired'), { status: 403 }) }));
  log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  sleep = vi.fn(async (ms) => { t += ms; });
  fetchSelf = vi.fn(async (url, init) => dispatchRestPush(new Request(url, init), context()));
});

// A request that was answered 202 goes on working: nothing of one test is
// left running into the next.
afterEach(async () => {
  await settled();
  vi.useRealTimers();
});

describe('planHop: a rest is cut into waits of a minute at most', () => {
  // The waits of the requests a rest takes, when a hand-over takes no time.
  function waitsFor(remaining) {
    const waits = [];
    let left = remaining;
    for (;;) {
      const plan = planHop(left);
      waits.push(plan.waitMs);
      if (plan.final) return waits;
      left -= plan.waitMs;
    }
  }

  it('has a hop fit in what a request is promised: half the 150 seconds of a worker', () => {
    expect(HOP_MS).toBe(60000);
    // A worker takes requests during the first 75 seconds of its 150: a
    // request that lands on it at the last moment has the other 75.
    const promised = 150000 / 2;
    expect(HOP_MS + TOP_UP_MAX_MS + SEND_DEADLINE_MS).toBeLessThan(promised);
    expect(HOP_MS + HANDOVER_DEADLINE_MS).toBeLessThan(promised);
    // The limit the owner's answers set, whatever else changes.
    expect(HOP_MS).toBeLessThanOrEqual(120000);
  });

  it('sends a rest of a minute or less from the request that was called', () => {
    expect(planHop(s(60))).toEqual({ final: true, waitMs: 60000 });
    expect(planHop(s(45))).toEqual({ final: true, waitMs: 45000 });
    expect(planHop(1)).toEqual({ final: true, waitMs: 1 });
    expect(waitsFor(s(60))).toEqual([60000]);
  });

  it('sends at once what is due, or past', () => {
    expect(planHop(0)).toEqual({ final: true, waitMs: 0 });
    expect(planHop(-1)).toEqual({ final: true, waitMs: 0 });
    expect(planHop(-s(59))).toEqual({ final: true, waitMs: 0 });
  });

  it('takes three requests for 180 s, five for 300 s and fifteen for 900 s', () => {
    expect(waitsFor(s(180))).toEqual([60000, 60000, 60000]);
    expect(waitsFor(s(300))).toEqual([60000, 60000, 60000, 60000, 60000]);
    expect(waitsFor(s(900))).toEqual(Array(15).fill(60000));
    expect(waitsFor(s(120))).toEqual([60000, 60000]);
  });

  // One millisecond over a minute is not a hop of a minute and one of a
  // millisecond: the next request may land on a worker that has to start.
  it('leaves the last request half a minute at least once there is a hand-over', () => {
    expect(LAST_HOP_MIN_MS).toBe(30000);
    expect(planHop(60001)).toEqual({ final: false, waitMs: 30001 });
    expect(waitsFor(60001)).toEqual([30001, 30000]);
    expect(waitsFor(s(75))).toEqual([45000, 30000]);
    expect(waitsFor(s(90))).toEqual([60000, 30000]);
    expect(waitsFor(s(91))).toEqual([60000, 31000]);
    expect(waitsFor(s(121))).toEqual([60000, 31000, 30000]);
  });

  // The platform counts the calls a function makes to functions of its
  // project: 30 in 60 seconds for one chain, and the next one throws.
  it('makes two calls to itself in any minute at most', () => {
    for (let remaining = HOP_MS; remaining <= MAX_AHEAD_MS; remaining += 997) {
      const waits = waitsFor(remaining);
      // A hand-over follows every wait but the last; between two of them
      // lies a whole wait, and no wait before a hand-over is under half a minute.
      for (const wait of waits.slice(1, -1)) expect(wait, `${remaining} ms`).toBeGreaterThanOrEqual(30000);
    }
    expect(HOP_MS - LAST_HOP_MIN_MS).toBeGreaterThanOrEqual(30000);
  });

  it('never waits more than a minute, never loses a millisecond, and takes the fewest requests that fit', () => {
    for (let remaining = 0; remaining <= MAX_AHEAD_MS; remaining += 499) {
      const waits = waitsFor(remaining);
      const label = `${remaining} ms`;
      expect(waits.reduce((sum, wait) => sum + wait, 0), label).toBe(remaining);
      expect(Math.max(...waits), label).toBeLessThanOrEqual(HOP_MS);
      expect(waits, label).toHaveLength(Math.max(1, Math.ceil(remaining / HOP_MS)));
      if (waits.length > 1) {
        expect(waits.at(-1), label).toBeGreaterThanOrEqual(LAST_HOP_MIN_MS);
        expect(Math.min(...waits), label).toBeGreaterThanOrEqual(HOP_MS - LAST_HOP_MIN_MS);
      }
    }
  });

  it('keeps the longest rest, and a clock that is off, under the number of requests a chain may take', () => {
    expect(MAX_REST_MS).toBe(900000);
    expect(MAX_AHEAD_MS).toBe(MAX_REST_MS + CLOCK_SLACK_MS);
    expect(waitsFor(MAX_AHEAD_MS).length).toBeLessThan(MAX_HOPS);
    expect(MAX_HOPS).toBe(17);
  });

  it('refuses a time that is not a number rather than send at once', () => {
    for (const value of [Number.NaN, undefined, null, '60000', {}]) {
      expect(() => planHop(value), String(value)).toThrow(RangeError);
    }
    expect(planHop(Number.POSITIVE_INFINITY)).toEqual({ final: false, waitMs: HOP_MS });
  });
});

describe('functionUrl', () => {
  it('is where the gateway serves a function, whatever the end of the project URL', () => {
    expect(functionUrl('https://project.invalid', NAME)).toBe(SELF);
    expect(functionUrl('https://project.invalid/', NAME)).toBe(SELF);
    expect(functionUrl('http://kong:8000', 'send-push')).toBe('http://kong:8000/functions/v1/send-push');
  });
});

describe('dispatch-rest-push: who is let in', () => {
  // A caller that is refused: nothing was made, nothing was read — not a
  // row, and not a byte of what was sent.
  const untouched = (sent) => {
    expect(createAdmin).not.toHaveBeenCalled();
    expect(admin.calls).toEqual([]);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
    expect(handed).toEqual([]);
    expect(fetchSelf).not.toHaveBeenCalled();
    if (sent) expect(sent.bodyUsed).toBe(false);
  };

  it('lets the app in with the token of the athlete whose row it is', async () => {
    const response = await dispatch();
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(getUser.mock.calls).toEqual([[TOKEN]]);
    expect(createAdmin).toHaveBeenCalledTimes(1);
  });

  it('refuses a call that shows nothing, before anything else happens', async () => {
    const sent = request({ token: null });
    const response = await dispatchRestPush(sent, context());
    expect(response.status).toBe(401);
    expect(await response.text()).toBe('dispatch-rest-push: unauthorized');
    expect(getUser).not.toHaveBeenCalled();
    expect(lines('warn')).toEqual(['dispatch-rest-push: refused, no credentials']);
    untouched(sent);
  });

  it('refuses a token the auth server does not accept: expired, forged, the anon key', async () => {
    for (const token of [EXPIRED, TOKEN.replace(/.$/, 'x'), 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.YW5vbi1rZXk']) {
      const sent = request({ token });
      const response = await dispatchRestPush(sent, context());
      expect(response.status, token).toBe(401);
      expect(await response.text()).toBe('dispatch-rest-push: unauthorized');
      untouched(sent);
    }
    expect(getUser).toHaveBeenCalledTimes(3);
    expect(lines('warn')).toEqual(Array(3).fill('dispatch-rest-push: refused, the token was not accepted'));
  });

  // The secret of the project, a new-style API key, a word: none of them is
  // a user's token, and the auth server is not asked about them.
  it('refuses what does not look like a token without asking the auth server', async () => {
    for (const options of [
      { token: 'garbage' },
      { token: SECRET },
      { token: 'sb_publishable_0123456789abcdef' },
      { token: null, headers: { authorization: `Basic ${TOKEN}` } },
      { token: null, headers: { authorization: TOKEN } },
      { token: null, headers: { apikey: TOKEN } },
    ]) {
      const sent = request(options);
      const response = await dispatchRestPush(sent, context());
      expect(response.status, JSON.stringify(options)).toBe(401);
      untouched(sent);
    }
    expect(getUser).not.toHaveBeenCalled();
  });

  it('answers 503, and says so in the log, when the auth server could not be asked', async () => {
    const down = [
      async () => { throw new TypeError('fetch failed'); },
      async () => ({ data: { user: null }, error: Object.assign(new Error('Bad Gateway'), { status: 502 }) }),
      async () => ({ data: { user: null }, error: Object.assign(new Error('network error'), { status: 0 }) }),
    ];
    for (const answer of down) {
      const sent = request();
      const response = await dispatchRestPush(sent, context({ getUser: answer }));
      expect(response.status).toBe(503);
      expect(await response.text()).toBe('dispatch-rest-push: the token could not be checked');
      untouched(sent);
    }
    expect(lines('error')).toEqual([
      'dispatch-rest-push: the token could not be checked, the auth server did not answer: fetch failed',
      'dispatch-rest-push: the token could not be checked, the auth server did not answer: Bad Gateway',
      'dispatch-rest-push: the token could not be checked, the auth server did not answer: network error',
    ]);
  });

  it('refuses an answer of the auth server that names no user', async () => {
    for (const answer of [undefined, null, {}, { data: null }, { data: { user: null }, error: null }, { data: { user: { id: '' } }, error: null }]) {
      const response = await dispatch({}, { getUser: async () => answer });
      expect(response.status, JSON.stringify(answer)).toBe(401);
    }
    untouched();
  });

  it('refuses the row of somebody else, whose token is as good as any', async () => {
    const response = await dispatch({ token: TOKEN_OF_OTHER });
    expect(response.status).toBe(403);
    expect(await response.text()).toBe('dispatch-rest-push: forbidden');
    expect(handed).toEqual([]);
    expect(claims()).toEqual([]);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
    expect(lines('warn')).toEqual([`dispatch-rest-push: refused, rest push ${ROW} is not the caller's`]);
  });

  it('lets a hop in with the secret of the project, and asks the auth server nothing', async () => {
    const response = await dispatch({ token: null, internal: SECRET, body: { scheduleId: ROW, hop: 2 } });
    expect(response.status).toBe(202);
    expect(getUser).not.toHaveBeenCalled();
    await settled();
    expect(row().status).toBe('sent');
  });

  it('judges a request that shows the internal header on that header alone', async () => {
    // A good token next to a wrong secret is not let in as the user …
    for (const internal of [`${SECRET.slice(0, -1)}0`, SECRET.slice(0, -1), `${SECRET}0`, '', 'undefined', TOKEN]) {
      const sent = request({ internal, body: { scheduleId: ROW, hop: 2 } });
      const response = await dispatchRestPush(sent, context());
      expect(response.status, JSON.stringify(internal)).toBe(401);
      expect(await response.text()).toBe('dispatch-rest-push: unauthorized');
      untouched(sent);
    }
    expect(getUser).not.toHaveBeenCalled();
    expect(lines('warn')).toContain('dispatch-rest-push: refused, wrong internal bearer');
    expect(lines('warn')).toContain('dispatch-rest-push: refused, empty internal bearer');

    // … and a good secret next to a token of somebody else is a hop.
    const response = await dispatch({ token: TOKEN_OF_OTHER, internal: SECRET, body: { scheduleId: ROW, hop: 2 } });
    expect(response.status).toBe(202);
    expect(getUser).not.toHaveBeenCalled();
  });

  it('does not take the secret in the header of the user, nor a token in the header of the hop', async () => {
    expect((await dispatch({ token: SECRET })).status).toBe(401);
    expect((await dispatch({ token: null, internal: TOKEN })).status).toBe(401);
    untouched();
  });

  it('lets no hop in while INTERNAL_BEARER is not set, and still serves the app', async () => {
    for (const bearer of [undefined, null, '']) {
      for (const internal of [SECRET, '', 'undefined', 'null']) {
        const sent = request({ token: null, internal, body: { scheduleId: ROW, hop: 2 } });
        const response = await dispatchRestPush(sent, context({ bearer }));
        expect(response.status, `${bearer} / ${internal}`).toBe(500);
        expect(await response.text()).toBe('dispatch-rest-push: not configured');
        untouched(sent);
      }
    }
    expect(lines('error')[0]).toBe('dispatch-rest-push: INTERNAL_BEARER is not set: no hop is let in, and a rest longer than a minute does not ring');

    const response = await dispatch({}, { bearer: undefined });
    expect(response.status).toBe(202);
    await settled();
    expect(row().status).toBe('sent');
  });

  it('never writes what it was shown in the log', async () => {
    await dispatch({ token: EXPIRED });
    await dispatch({ token: null, internal: 'a-wrong-secret-of-the-right-length-0123456789abcdef0123456789abcd' });
    await dispatch({ token: 'garbage-that-is-not-a-token' });
    rest(s(180));
    await dispatch();
    await settled();
    const written = everyLine();
    for (const shown of [EXPIRED, TOKEN, SECRET, 'a-wrong-secret', 'garbage-that']) expect(written).not.toContain(shown);
  });

  describe('authenticate, on its own', () => {
    const ask = (options) => authenticate(request(options), { name: NAME, bearer: SECRET, getUser, log });

    it('answers who calls, or the refusal to return', async () => {
      expect(await ask()).toEqual({ response: null, caller: { internal: false, userId: USER } });
      expect(await ask({ token: null, internal: SECRET })).toEqual({ response: null, caller: { internal: true, userId: null } });
      const refused = await ask({ token: null });
      expect(refused.caller).toBeNull();
      expect(refused.response.status).toBe(401);
      expect(refused.response.headers.get('www-authenticate')).toBe('Bearer');
    });
  });
});

describe('dispatch-rest-push: a browser may call it, and cannot be a hop', () => {
  it('answers a preflight, and lets a page send the headers the app sends — not the internal one', async () => {
    const response = await dispatch({ method: 'OPTIONS', token: null, headers: { origin: 'https://tamachiii.github.io', 'access-control-request-method': 'POST' } });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS');
    const allowed = response.headers.get('access-control-allow-headers').split(',').map((name) => name.trim());
    expect(allowed).toEqual(['authorization', 'x-client-info', 'apikey', 'content-type']);
    expect(allowed).not.toContain(INTERNAL_HEADER);
    expect(INTERNAL_HEADER).toBe('x-internal-bearer');
    expect(getUser).not.toHaveBeenCalled();
    expect(createAdmin).not.toHaveBeenCalled();
  });

  it('refuses every other method than POST', async () => {
    for (const method of ['GET', 'PUT', 'DELETE', 'HEAD']) {
      const response = await dispatch({ method });
      expect(response.status, method).toBe(405);
      expect(response.headers.get('allow')).toBe('POST, OPTIONS');
    }
    expect(getUser).not.toHaveBeenCalled();
  });

  it('carries the CORS headers on every answer, so the app can read a refusal', async () => {
    const answers = [
      [405, () => dispatch({ method: 'GET' })],
      [401, () => dispatch({ token: null })],
      [503, () => dispatch({}, { getUser: async () => { throw new TypeError('fetch failed'); } })],
      [500, () => dispatch({ token: null, internal: SECRET }, { bearer: undefined })],
      [413, () => dispatch({ body: JSON.stringify({ scheduleId: ROW, pad: 'x'.repeat(MAX_BODY_BYTES) }) })],
      [400, () => dispatch({ body: 'not json' })],
      [404, () => dispatch({ body: { scheduleId: ROW.replace(/a/g, 'b') } })],
      [403, () => dispatch({ token: TOKEN_OF_OTHER })],
      [422, () => { rest(MAX_AHEAD_MS + 1); return dispatch(); }],
      [200, () => { rest(s(60), { status: 'sent' }); return dispatch(); }],
      [202, () => { rest(s(60), { status: 'pending' }); return dispatch(); }],
    ];
    for (const [status, ask] of answers) {
      const response = await ask();
      expect(response.status, `HTTP ${status}`).toBe(status);
      for (const [header, value] of Object.entries(CORS_HEADERS)) {
        expect(response.headers.get(header), `HTTP ${status} ${header}`).toBe(value);
      }
    }
  });
});

describe('dispatch-rest-push: the request of a caller that was let in', () => {
  it('refuses a body that is not a JSON object, or names no row', async () => {
    const bodies = ['not json', '', '[]', '"a word"', 'null', '{}', { scheduleId: 42 }, { scheduleId: null }, { scheduleId: 'not-a-uuid' },
      { scheduleId: `${ROW}; drop table` }, { scheduleId: [ROW] }, { schedule_id: ROW }];
    for (const body of bodies) {
      const response = await dispatch({ body });
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.text()).toMatch(/^dispatch-rest-push: (bad request|scheduleId is not a uuid)$/);
    }
    expect(createAdmin).not.toHaveBeenCalled();
    expect(handed).toEqual([]);
  });

  it('refuses a body over 8 kB', async () => {
    const response = await dispatch({ body: JSON.stringify({ scheduleId: ROW, pad: 'x'.repeat(MAX_BODY_BYTES) }) });
    expect(response.status).toBe(413);
    expect(await response.text()).toBe('dispatch-rest-push: payload too large');
    expect(createAdmin).not.toHaveBeenCalled();
  });

  it('answers 404 for a row that is not there, and 500 when the rows cannot be read', async () => {
    const absent = await dispatch({ body: { scheduleId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } });
    expect(absent.status).toBe(404);
    expect(await absent.text()).toBe('dispatch-rest-push: no such rest push');

    admin.error = 'canceling statement due to statement timeout';
    const unread = await dispatch();
    expect(unread.status).toBe(500);
    expect(await unread.text()).toBe('dispatch-rest-push: the row could not be read');
    expect(lines('error')).toEqual([`dispatch-rest-push: rest push ${ROW}: the row could not be read: canceling statement due to statement timeout`]);
    expect(handed).toEqual([]);
  });

  it('reads the row by its id, and only the columns it needs', async () => {
    const select = vi.fn(() => ({ eq: async () => ({ data: [row()], error: null }) }));
    const from = admin.from.bind(admin);
    admin.from = (table) => (table === 'scheduled_pushes' ? { ...from(table), select } : from(table));
    await dispatch();
    // Columns the table has had since it was made: the function also runs
    // against a database migration 16 has not reached.
    expect(select).toHaveBeenCalledWith('id, user_id, status, canceled_at, fire_at');
  });

  // The app's request is the first of its chain, whatever it says; a hop
  // says which one it is, and is not believed beyond what a rest can take.
  it('takes the number of a hop from a hop only, from 2 to the most a rest can take', async () => {
    for (const hop of [undefined, null, 0, 1, 1.5, '2', -3, MAX_HOPS + 1, 1e9]) {
      const response = await dispatch({ token: null, internal: SECRET, body: { scheduleId: ROW, hop } });
      expect(response.status, JSON.stringify(hop)).toBe(400);
      expect(await response.text()).toBe(`dispatch-rest-push: hop is not a number from 2 to ${MAX_HOPS}`);
    }
    expect(createAdmin).not.toHaveBeenCalled();
    expect((await dispatch({ token: null, internal: SECRET, body: { scheduleId: ROW, hop: MAX_HOPS } })).status).toBe(202);
    await settled();

    rest(s(180), { status: 'pending' });
    await dispatch({ body: { scheduleId: ROW, hop: 9 } });
    await settled();
    expect(hops().map(({ body }) => body)).toEqual([{ scheduleId: ROW, hop: 2 }, { scheduleId: ROW, hop: 3 }]);
  });
});

describe('dispatch-rest-push: a rest of a minute or less is one request', () => {
  it('answers 202 at once, waits for the time of the push, claims the row, sends and records', async () => {
    rest(s(45));
    const waiting = heldClock();
    const response = await dispatch();
    expect(response.status).toBe(202);
    // Answered while the wait goes on: the runtime holds what is left to do.
    expect(handed).toHaveLength(1);
    expect(sleep.mock.calls).toEqual([[45000]]);
    expect(claims()).toEqual([]);
    expect(row().status).toBe('pending');

    waiting.shift()();
    await settled();
    expect(fetchSelf).not.toHaveBeenCalled();
    expect(claims()).toEqual([{ rpc: 'claim_rest_push', args: { p_id: ROW } }]);
    // Kept for a minute, urgency high, to the devices of the athlete only.
    const options = { TTL: 60, urgency: 'high', timeout: 5000 };
    expect(webpush.sendNotification.mock.calls).toEqual([
      [{ endpoint: 'https://fcm.googleapis.com/fcm/send/d1', keys: { p256dh: 'p256dh-d1', auth: 'auth-d1' } }, JSON.stringify(REST), options],
      [{ endpoint: 'https://fcm.googleapis.com/fcm/send/d2', keys: { p256dh: 'p256dh-d2', auth: 'auth-d2' } }, JSON.stringify(REST), options],
    ]);
    expect(row()).toMatchObject({ status: 'sent', sent_at: new Date(NOW + s(45)).toISOString(), error: null });
    expect(lines('info')).toEqual([
      `dispatch-rest-push: rest push ${ROW}: hop 1, sends in 45 s`,
      `dispatch-rest-push: rest push ${ROW}: sent to 2 devices`,
    ]);
    expect(lines('error')).toEqual([]);
  });

  it('sends to the device the row names, where it names one', async () => {
    rest(s(30), { endpoint: 'https://fcm.googleapis.com/fcm/send/d2' });
    await dispatch();
    await settled();
    expect(sentTo()).toEqual(['https://fcm.googleapis.com/fcm/send/d2']);
    expect(lines('info').at(-1)).toBe(`dispatch-rest-push: rest push ${ROW}: sent to 1 device`);
  });

  it('sends at once a row whose time has come, up to a minute ago', async () => {
    for (const ago of [0, 1, s(59)]) {
      rest(-ago, { status: 'pending' });
      webpush.sendNotification.mockClear();
      sleep.mockClear();
      expect((await dispatch()).status).toBe(202);
      await settled();
      expect(sleep, `${ago} ms ago`).not.toHaveBeenCalled();
      expect(sentTo(), `${ago} ms ago`).toHaveLength(2);
      expect(row().status).toBe('sent');
    }
  });

  // A timer counts seconds of its own; the time of the push is the clock's.
  // Seen on a machine whose clock was being set right: a wait of 30.7 s that
  // ended when the clock had moved by 30.0 s. The claim does not refuse a row
  // that is early, so the function looks at the clock again.
  it('waits for what is missing when its timer ends before the clock says the time has come', async () => {
    rest(s(45));
    const fireAt = t + s(45);
    // The clock moves by 98 % of what a timer counts.
    sleep.mockImplementation(async (ms) => { t += Math.floor(ms * 0.98); });
    let claimedAt = null;
    const rpc = admin.rpc.bind(admin);
    admin.rpc = async (name, args) => { claimedAt = t; return rpc(name, args); };

    await dispatch();
    await settled();
    expect(sleep.mock.calls).toEqual([[45000], [900]]);
    expect(claimedAt).toBeGreaterThanOrEqual(fireAt - 20);
    expect(row().status).toBe('sent');
  });

  it('looks at the clock once, and not for long: a clock that stands still does not hold a push for ever', async () => {
    rest(s(45));
    sleep.mockImplementation(async () => {});
    await dispatch();
    await settled();
    expect(sleep.mock.calls).toEqual([[45000], [TOP_UP_MAX_MS]]);
    expect(TOP_UP_MAX_MS).toBe(2000);
    expect(row().status).toBe('sent');
  });

  // More than a minute late, a push is worse than none: the claim says so,
  // and closes the row itself.
  it('sends nothing for a row whose time is more than a minute past, and writes nothing itself', async () => {
    rest(-s(61));
    expect((await dispatch()).status).toBe(202);
    await settled();
    expect(claims()).toHaveLength(1);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
    expect(row().status).toBe('expired');
  });
});

describe('dispatch-rest-push: a longer rest is a chain of hops', () => {
  it('rings a rest of 300 s: the app\'s request, four hops with the secret and no token, one claim, one push per device', async () => {
    rest(s(300));
    const fireAt = t + s(300);
    const response = await dispatch();
    expect(response.status).toBe(202);
    await settled();

    // Five requests, each waiting a minute.
    expect(handed).toHaveLength(5);
    expect(sleep.mock.calls).toEqual([[60000], [60000], [60000], [60000], [60000]]);
    // The four it made itself: to its own address, with the secret in its
    // own header, and nothing of the athlete.
    expect(hops()).toEqual([2, 3, 4, 5].map((hop) => ({
      url: SELF,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-bearer': SECRET },
      body: { scheduleId: ROW, hop },
      redirect: 'manual',
    })));
    // The token was looked at once, by the request that carried it.
    expect(getUser.mock.calls).toEqual([[TOKEN]]);
    expect(createAdmin).toHaveBeenCalledTimes(5);

    // One claim, at the time of the push and not before; one push a device.
    expect(claims()).toEqual([{ rpc: 'claim_rest_push', args: { p_id: ROW } }]);
    expect(t).toBe(fireAt);
    expect(sentTo()).toEqual(['https://fcm.googleapis.com/fcm/send/d1', 'https://fcm.googleapis.com/fcm/send/d2']);
    expect(row()).toMatchObject({ status: 'sent', sent_at: new Date(fireAt).toISOString() });
    expect(lines('info')).toEqual([
      `dispatch-rest-push: rest push ${ROW}: hop 1, hands over in 60 s (300 s before its time)`,
      `dispatch-rest-push: rest push ${ROW}: hop 2, hands over in 60 s (240 s before its time)`,
      `dispatch-rest-push: rest push ${ROW}: hop 3, hands over in 60 s (180 s before its time)`,
      `dispatch-rest-push: rest push ${ROW}: hop 4, hands over in 60 s (120 s before its time)`,
      `dispatch-rest-push: rest push ${ROW}: hop 5, sends in 60 s`,
      `dispatch-rest-push: rest push ${ROW}: sent to 2 devices`,
    ]);
    expect(lines('warn')).toEqual([]);
    expect(lines('error')).toEqual([]);
  });

  it('rings a rest of 180 s in three requests and one of 900 s in fifteen', async () => {
    rest(s(180));
    await dispatch();
    await settled();
    expect(sleep.mock.calls).toEqual([[60000], [60000], [60000]]);
    expect(hops().map(({ body }) => body.hop)).toEqual([2, 3]);
    expect(row().status).toBe('sent');

    rest(s(900), { status: 'pending' });
    handed.length = 0;
    sleep.mockClear();
    fetchSelf.mockClear();
    webpush.sendNotification.mockClear();
    await dispatch();
    await settled();
    expect(sleep.mock.calls).toEqual(Array(15).fill([60000]));
    expect(hops().map(({ body }) => body.hop)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(webpush.sendNotification).toHaveBeenCalledTimes(2);
    expect(row().status).toBe('sent');
  });

  // The time is the row's: each hop reads it again and waits for what is
  // left, so the seconds a hand-over takes are not added to the rest.
  it('takes the time a hand-over costs out of the next wait, not out of the push', async () => {
    rest(s(150));
    const fireAt = t + s(150);
    fetchSelf.mockImplementation(async (url, init) => {
      t += 1500; // a worker that had to start
      return dispatchRestPush(new Request(url, init), context());
    });
    await dispatch();
    await settled();
    expect(sleep.mock.calls).toEqual([[60000], [58500], [28500]]);
    expect(t).toBe(fireAt);
    expect(row().sent_at).toBe(new Date(fireAt).toISOString());
  });

  it('answers each hop before that hop has waited', async () => {
    rest(s(180));
    const waiting = heldClock();
    const answered = [];
    fetchSelf.mockImplementation(async (url, init) => {
      const response = await dispatchRestPush(new Request(url, init), context());
      // The hop that answers has started its wait, and is still in it.
      answered.push({ status: response.status, started: sleep.mock.calls.length, goingOn: waiting.length, minutes: (t - NOW) / 60000 });
      return response;
    });
    await dispatch();
    for (let i = 0; i < handed.length; i += 1) {
      waiting.shift()();
      await handed[i];
    }
    expect(answered).toEqual([
      { status: 202, started: 2, goingOn: 1, minutes: 1 },
      { status: 202, started: 3, goingOn: 1, minutes: 2 },
    ]);
    expect(row().status).toBe('sent');
  });
});

describe('dispatch-rest-push: a row is sent once, and never once it was taken back', () => {
  it('answers "already resolved" for a row that is no longer waiting, and starts nothing', async () => {
    for (const state of [
      { status: 'sending' }, { status: 'sent' }, { status: 'failed' }, { status: 'canceled' }, { status: 'expired' },
      // The app from before wave 3 takes a rest back like this.
      { status: 'pending', canceled_at: pgTime(NOW - s(3)) },
    ]) {
      rest(s(90), { canceled_at: null, ...state });
      const response = await dispatch();
      expect(response.status, JSON.stringify(state)).toBe(200);
      expect(await response.text()).toBe('dispatch-rest-push: already resolved');
    }
    expect(handed).toEqual([]);
    expect(sleep).not.toHaveBeenCalled();
    expect(claims()).toEqual([]);
    expect(writes()).toEqual([]);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  // The other sender — the pg_cron job, through send-push — took the row
  // while this one waited: the claim answers nothing.
  it('skips a row somebody else has claimed: nothing is sent and nothing is written', async () => {
    rest(s(40));
    sleep.mockImplementation(async (ms) => { t += ms; row().status = 'sending'; });
    await dispatch();
    await settled();
    expect(claims()).toHaveLength(1);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
    expect(row().status).toBe('sending');
    expect(lines('info').at(-1)).toMatch(new RegExp(`^dispatch-rest-push: rest push ${ROW}: not sent`));
    expect(lines('error')).toEqual([]);
  });

  it('sends a row once when the app calls twice for it', async () => {
    rest(s(20));
    const waiting = heldClock();
    expect((await dispatch()).status).toBe(202);
    expect((await dispatch()).status).toBe(202);
    // Both wait for the same instant, and both ask.
    expect(waiting).toHaveLength(2);
    for (const end of waiting.splice(0)) end();
    await settled();
    expect(claims()).toHaveLength(2);
    expect(webpush.sendNotification).toHaveBeenCalledTimes(2);
    expect(writes().filter(({ table }) => table === 'scheduled_pushes')).toHaveLength(1);
  });

  it('never sends a rest that is taken back while the last hop waits', async () => {
    for (const takenBack of [
      () => { row().canceled_at = pgTime(t); }, // the app before wave 3
      () => { Object.assign(row(), { status: 'canceled', canceled_at: pgTime(t) }); }, // cancel_rest_push
    ]) {
      rest(s(50), { status: 'pending', canceled_at: null });
      sleep.mockImplementation(async (ms) => { t += ms; takenBack(); });
      await dispatch();
      await settled();
      expect(webpush.sendNotification).not.toHaveBeenCalled();
      expect(writes()).toEqual([]);
      expect(row().status).toBe('canceled');
    }
  });

  it('stops the chain at the hop that finds the rest taken back, without a request more', async () => {
    const states = {
      'canceled_at, as the app before wave 3 writes it': () => { row().canceled_at = pgTime(t); },
      'status canceled, as cancel_rest_push writes it': () => { Object.assign(row(), { status: 'canceled', canceled_at: pgTime(t) }); },
      'sent, by the other sender': () => { Object.assign(row(), { status: 'sent', sent_at: pgTime(t) }); },
      'no row any more': () => { tables.scheduled_pushes = []; },
    };
    for (const [name, change] of Object.entries(states)) {
      tables.scheduled_pushes = [{ id: ROW, user_id: USER, status: 'pending', canceled_at: null, fire_at: pgTime(t + s(300)), payload: REST, endpoint: null, sent_at: null, error: null }];
      handed.length = 0;
      fetchSelf.mockClear();
      log.info.mockClear();
      // The athlete starts the next set during the second minute.
      let waits = 0;
      sleep.mockImplementation(async (ms) => { t += ms; waits += 1; if (waits === 2) change(); });

      await dispatch();
      await settled();
      expect(waits, name).toBe(2);
      expect(hops().map(({ body }) => body.hop), name).toEqual([2]);
      expect(claims(), name).toEqual([]);
      expect(writes(), name).toEqual([]);
      expect(webpush.sendNotification, name).not.toHaveBeenCalled();
      expect(lines('info').at(-1), name).toBe(`dispatch-rest-push: rest push ${ROW}: no longer waiting after hop 2 — taken back, or sent by the other sender. Not handed over`);
    }
    expect(lines('error')).toEqual([]);
  });

  // A rest taken back in the instant between the look of one hop and the
  // request of the next: the next hop looks too, before it takes over.
  it('has the next hop refuse a rest that was taken back during the hand-over', async () => {
    rest(s(180));
    fetchSelf.mockImplementation(async (url, init) => {
      row().canceled_at = pgTime(t);
      const response = await dispatchRestPush(new Request(url, init), context());
      expect(response.status).toBe(200);
      return response;
    });
    await dispatch();
    await settled();
    expect(fetchSelf).toHaveBeenCalledTimes(1);
    expect(handed).toHaveLength(1);
    expect(claims()).toEqual([]);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
    // A hop that was answered 200 was taken note of: no error.
    expect(lines('error')).toEqual([]);
  });
});

describe('dispatch-rest-push: a hand-over that fails is a rest that does not ring, and a line of the log', () => {
  const failed = (reason) => `dispatch-rest-push: rest push ${ROW}: hop 2 did not take over, the rest does not ring: ${reason}`;

  it('tries once, says why, and writes nothing on the row', async () => {
    const answers = {
      'fetch failed': async () => { throw new TypeError('fetch failed'); },
      'The operation was aborted due to timeout': async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); },
      'HTTP 503 {"code":"BOOT_ERROR","message":"Function failed to start (please check logs)"}': async () => Response.json({ code: 'BOOT_ERROR', message: 'Function failed to start (please check logs)' }, { status: 503 }),
      'HTTP 302': async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } }),
    };
    for (const [reason, answer] of Object.entries(answers)) {
      rest(s(180));
      handed.length = 0;
      fetchSelf.mockReset();
      fetchSelf.mockImplementation(answer);
      log.error.mockClear();
      await dispatch();
      await settled();
      expect(fetchSelf, reason).toHaveBeenCalledTimes(1);
      expect(lines('error'), reason).toEqual([failed(reason)]);
      expect(claims(), reason).toEqual([]);
      expect(writes(), reason).toEqual([]);
      expect(webpush.sendNotification, reason).not.toHaveBeenCalled();
      expect(row().status, reason).toBe('pending');
    }
  });

  // Deployed with JWT verification on, the gateway answers a hop — which
  // shows no user token — before the function runs. This line of the log is
  // the only place that says so.
  it('quotes the gateway when the function is deployed with JWT verification on', async () => {
    rest(s(180));
    fetchSelf.mockImplementation(async () => Response.json({ code: 401, message: 'Missing authorization header' }, { status: 401 }));
    await dispatch();
    await settled();
    expect(lines('error')).toEqual([failed('HTTP 401 {"code":401,"message":"Missing authorization header"}')]);
  });

  it('cuts a long answer short and gives the request a time limit', async () => {
    rest(s(180));
    fetchSelf.mockImplementation(async () => new Response(`<html>\n  ${'x'.repeat(5000)}`, { status: 500 }));
    await dispatch();
    await settled();
    expect(lines('error')[0]).toBe(failed(`HTTP 500 <html> ${'x'.repeat(113)}`));
    const [, init] = fetchSelf.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(HANDOVER_DEADLINE_MS).toBe(10000);
  });

  it('says so, and calls nothing, when a rest needs a hop and the function has no INTERNAL_BEARER', async () => {
    rest(s(180));
    const response = await dispatch({}, { bearer: undefined });
    expect(response.status).toBe(202);
    await settled();
    expect(fetchSelf).not.toHaveBeenCalled();
    expect(lines('error')).toEqual([failed('INTERNAL_BEARER is not set')]);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  it('hands over all the same when the row cannot be read after the wait: the next hop asks again', async () => {
    rest(s(180));
    let reads = 0;
    const from = admin.from.bind(admin);
    admin.from = (table) => {
      if (table !== 'scheduled_pushes') return from(table);
      const real = from(table);
      return {
        ...real,
        select: () => ({
          eq: async (column, value) => {
            reads += 1;
            if (reads === 2) return { data: null, error: { message: 'connection reset' } };
            return real.select().eq(column, value);
          },
        }),
      };
    };
    await dispatch();
    await settled();
    expect(lines('warn')).toEqual([`dispatch-rest-push: rest push ${ROW}: the row could not be read after hop 1, handed over all the same: connection reset`]);
    expect(row().status).toBe('sent');
  });

  it('stops a chain at the number of requests a rest can take', async () => {
    // A row a hop was told is its last, and whose time has still not come.
    rest(s(200));
    const response = await dispatch({ token: null, internal: SECRET, body: { scheduleId: ROW, hop: MAX_HOPS } });
    expect(response.status).toBe(202);
    await settled();
    expect(fetchSelf).not.toHaveBeenCalled();
    expect(lines('error')).toEqual([
      `dispatch-rest-push: rest push ${ROW}: hop ${MAX_HOPS} is the last one a rest may take and its time has not come — not handed over, the rest does not ring`,
    ]);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });
});

describe('dispatch-rest-push: how far ahead a rest may be', () => {
  it('waits for the longest rest the database accepts, and for a clock that is off by less than half a minute', async () => {
    for (const ahead of [MAX_REST_MS, MAX_REST_MS + 1, MAX_AHEAD_MS]) {
      rest(ahead);
      const response = await dispatch();
      expect(response.status, `${ahead} ms`).toBe(202);
    }
    expect(CLOCK_SLACK_MS).toBe(30000);
  });

  it('refuses a row further ahead, waits for nothing and writes nothing', async () => {
    for (const ahead of [MAX_AHEAD_MS + 1, s(3600), s(86400 * 365)]) {
      rest(ahead);
      const response = await dispatch();
      expect(response.status, `${ahead} ms`).toBe(422);
      expect(await response.text()).toBe('dispatch-rest-push: more than 900 seconds ahead');
    }
    expect(handed).toEqual([]);
    expect(sleep).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
    expect(row().status).toBe('pending');
    expect(lines('warn')[0]).toBe(`dispatch-rest-push: refused, rest push ${ROW} is 930 seconds ahead, more than the 900 of the longest rest`);
  });

  it('answers 500 for a row whose time cannot be read, rather than send it at once', async () => {
    for (const fire_at of [null, undefined, 'soon', 1760385600000]) {
      Object.assign(row(), { fire_at });
      const response = await dispatch();
      expect(response.status, JSON.stringify(fire_at)).toBe(500);
    }
    expect(handed).toEqual([]);
    expect(claims()).toEqual([]);
  });
});

describe('dispatch-rest-push: what the runtime is handed', () => {
  // Deno alone, a test: no waitUntil. The work is then done before the
  // answer — late for the caller, and done.
  it('does the work before it answers where there is no runtime to hand it to', async () => {
    rest(s(30));
    const order = [];
    sleep.mockImplementation(async (ms) => { t += ms; order.push('waited'); });
    const response = await dispatch({}, { waitUntil: undefined });
    order.push('answered');
    expect(response.status).toBe(202);
    expect(order).toEqual(['waited', 'answered']);
    expect(row().status).toBe('sent');
  });

  it('never hands the runtime a promise that rejects', async () => {
    rest(s(30));
    sleep.mockImplementation(async () => { throw new Error('the timer broke'); });
    const response = await dispatch();
    expect(response.status).toBe(202);
    await expect(handed[0]).resolves.toBeUndefined();
    expect(claims()).toEqual([]);
    expect(lines('error')).toEqual([`dispatch-rest-push: rest push ${ROW}: the timer broke`]);
  });

  it('answers 500, and hands nothing over, when the client cannot be made', async () => {
    const response = await dispatch({}, { createAdmin: () => { throw new Error('supabaseKey is required.'); } });
    expect(response.status).toBe(500);
    expect(handed).toEqual([]);
    expect(lines('error')).toEqual([`dispatch-rest-push: rest push ${ROW}: supabaseKey is required.`]);
  });

  it('waits on the real clock when it is given none', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(NOW);
    Object.assign(row(), { fire_at: pgTime(NOW + 7000) });
    const { sleep: _sleep, now: _now, ...rest7 } = context();
    const response = await dispatchRestPush(request(), rest7);
    expect(response.status).toBe(202);
    await vi.advanceTimersByTimeAsync(6999);
    expect(claims()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await handed[0];
    expect(row()).toMatchObject({ status: 'sent', sent_at: '2026-10-13T20:00:07.000Z' });
  });
});
