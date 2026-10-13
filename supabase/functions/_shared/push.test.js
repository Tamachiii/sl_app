// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeAdmin } from '../_test/harness.js';
import {
  ALL_SUBSCRIPTIONS_FAILED, EVENT_TTL_SECONDS, MAX_WAIT_MS, NO_SUBSCRIPTIONS, REST_TTL_SECONDS, SENDER_FAILED,
  SEND_DEADLINE_MS, SEND_TIMEOUT_MS, answerPush, failureLine, restSendOptions, sendOptions, sendRestPush, sendToDevices,
} from './push.js';

// What send-push decides once its gate has let a request in (review P35):
// who gets the push and with which options, what is written in the log when
// a push service says no, what the caller is answered — and, for a rest
// push, the wait, the claim and what is written on the row.
//
// Nothing here is Deno, and nothing is real: the web-push library, the
// service-role client and the clock are handed in. send-push/index.test.js
// holds the adapter that hands in the real ones.

const NAME = 'send-push';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const NOBODY = '00000000-0000-0000-0000-000000000000';
const ROW = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = Date.parse('2026-10-13T20:00:00.000Z');
const PAYLOAD = { title: 'Feedback from Coach', body: 'Great session', tag: 'feedback-1', data: { url: '/sl_app/#/student' } };
const REST_PAYLOAD = { title: 'Rest done', body: 'Back to the bar', tag: 'rest-timer', data: { url: '/sl_app/#/student' } };

// Postgres writes a timestamptz into JSON with six decimals and an offset.
const pgTime = (ms) => new Date(ms).toISOString().replace('Z', '000+00:00');

// A row of push_subscriptions. The token and the keys are long, as the real
// ones are, and are what a log must never show.
const device = (id, user, base = 'https://fcm.googleapis.com/fcm/send/') => ({
  id,
  user_id: user,
  endpoint: `${base}token-of-${id}-dQw4w9WgXcQ`,
  p256dh: `p256dh-of-${id}-BNcRdreALRFXTkOOUHK1`,
  auth: `auth-of-${id}-tBHItJI5svbpez7KI4`,
});
const subscription = ({ endpoint, p256dh, auth }) => ({ endpoint, keys: { p256dh, auth } });

// What the web-push library rejects with when a push service answers
// something that is not a 2xx. It carries the address of the device.
const refusedBy = (statusCode, body) => (sub) => Object.assign(new Error('Received unexpected response code'), {
  statusCode, body, headers: {}, endpoint: sub.endpoint,
});

let tables;
let admin;
let createAdmin;
let webpush;
let log;
let claim;

// The push services, device by device: `answers[id]` makes what the library
// rejects with for that device; a device that is not named takes the push.
function pushServices(answers) {
  webpush.sendNotification = vi.fn(async (sub) => {
    const answer = answers[/token-of-([a-z0-9]+)-/.exec(sub.endpoint)?.[1]];
    if (answer) throw answer(sub);
    return { statusCode: 201 };
  });
}

const lines = (level) => log[level].mock.calls.map(([line]) => line);
const everyLine = () => ['info', 'warn', 'error'].flatMap(lines).join('\n');
const writes = () => admin.calls.filter(({ op }) => op === 'update' || op === 'delete');
const sentTo = () => webpush.sendNotification.mock.calls.map(([sub]) => sub.endpoint);

const push = (body = {}, context = {}) => answerPush(
  { user_id: USER, payload: PAYLOAD, ...body },
  { name: NAME, webpush, createAdmin, log, now: () => NOW, ...context },
);

beforeEach(() => {
  tables = {
    push_subscriptions: [device('d1', USER), device('d2', USER), device('d3', OTHER)],
    scheduled_pushes: [{ id: ROW, user_id: USER, status: 'pending', sent_at: null, error: null }],
  };
  claim = { id: ROW, user_id: USER, payload: REST_PAYLOAD, endpoint: null, fire_at: pgTime(NOW) };
  admin = fakeAdmin(tables, {
    rpc: {
      // The row is answered once, and reads 'sending' from then on.
      claim_rest_push: ({ p_id }) => {
        const row = tables.scheduled_pushes.find(({ id, status }) => id === p_id && status === 'pending');
        if (!row || !claim) return { data: null };
        row.status = 'sending';
        return { data: claim };
      },
    },
  });
  createAdmin = vi.fn(() => admin);
  webpush = { sendNotification: vi.fn(async () => ({ statusCode: 201 })) };
  log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('an event: sent now, to every device of the user', () => {
  it('sends the payload as it came, kept for a day, urgency normal, with a time limit', async () => {
    const response = await push();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.text()).toBe('{"delivered":2}');

    const options = { TTL: 86400, urgency: 'normal', timeout: 5000 };
    expect(webpush.sendNotification.mock.calls).toEqual([
      [subscription(tables.push_subscriptions[0]), JSON.stringify(PAYLOAD), options],
      [subscription(tables.push_subscriptions[1]), JSON.stringify(PAYLOAD), options],
    ]);
    expect(options).toEqual({ TTL: EVENT_TTL_SECONDS, urgency: 'normal', timeout: SEND_TIMEOUT_MS });
    expect(createAdmin).toHaveBeenCalledTimes(1);
    expect(admin.calls[0]).toEqual({ table: 'push_subscriptions', op: 'select', column: 'user_id', value: USER });
    expect(everyLine()).toBe('');
  });

  it('notes on each device that took the push when it was last reached', async () => {
    await push();
    const seen = { last_seen_at: '2026-10-13T20:00:00.000Z' };
    expect(writes()).toEqual([
      { table: 'push_subscriptions', op: 'update', column: 'id', value: 'd1', values: seen },
      { table: 'push_subscriptions', op: 'update', column: 'id', value: 'd2', values: seen },
    ]);
  });

  // The check of the runbook after a deploy relies on this answer, to the
  // character, for a user id nobody has.
  it('answers 200 {"delivered":0} for a user without a device, and does nothing', async () => {
    const response = await push({ user_id: NOBODY });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"delivered":0}');
    expect(webpush.sendNotification).not.toHaveBeenCalled();
    expect(admin.calls).toEqual([{ table: 'push_subscriptions', op: 'select', column: 'user_id', value: NOBODY }]);
    expect(everyLine()).toBe('');
  });

  it('answers 400 without a user or without a payload that is an object, before a client is made', async () => {
    for (const body of [
      { user_id: undefined }, { user_id: '' }, { user_id: 7 }, { user_id: null },
      { payload: undefined }, { payload: null }, { payload: 'Rest done' }, { payload: [PAYLOAD] },
    ]) {
      const response = await push(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.text()).toBe('send-push: missing user_id or payload');
    }
    expect(createAdmin).not.toHaveBeenCalled();
    expect(webpush.sendNotification).not.toHaveBeenCalled();
    expect(lines('warn')).toContain('send-push: refused, missing user_id or payload');
  });

  it('answers 500 with what the database said when the devices cannot be read', async () => {
    admin.error = 'permission denied for table push_subscriptions';
    const response = await push();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'permission denied for table push_subscriptions' });
    expect(webpush.sendNotification).not.toHaveBeenCalled();
    expect(lines('error')).toEqual(['send-push: push_subscriptions could not be read: permission denied for table push_subscriptions']);
  });
});

// The version before answered 200 {"delivered":0} whatever had happened, and
// wrote nothing: a VAPID key the push services refuse stopped every push of
// the app without a trace.
describe('a push that was not taken is said: in the answer and in the log', () => {
  it('answers 502 when there were devices and none took it, with one line per device', async () => {
    pushServices({
      d1: refusedBy(403, 'the VAPID credentials in the authorization header do not correspond to the credentials used to create the subscriptions.\n'),
      d2: refusedBy(403, '{"code":403,"errno":109,"message":"Request did not validate"}'),
    });
    const response = await push();
    expect(response.status).toBe(502);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ delivered: 0, failed: 2 });

    expect(lines('error')).toEqual([
      'send-push: push failed status=403 host=fcm.googleapis.com subscription=d1 body="the VAPID credentials in the authorization header do not correspond to the credentials used to create the subscriptions."',
      'send-push: push failed status=403 host=fcm.googleapis.com subscription=d2 body="{\\"code\\":403,\\"errno\\":109,\\"message\\":\\"Request did not validate\\"}"',
      'send-push: no device got the push (2 failed, 0 gone)',
    ]);
    // Nothing is deleted for a refusal that is not "gone", and nothing noted.
    expect(writes()).toEqual([]);
    expect(tables.push_subscriptions).toHaveLength(3);
  });

  it('says so too when a push service does not answer at all', async () => {
    pushServices({ d1: () => new Error('Socket timeout'), d2: () => new Error('getaddrinfo ENOTFOUND fcm.googleapis.com') });
    const response = await push();
    expect(response.status).toBe(502);
    expect(lines('error').slice(0, 2)).toEqual([
      'send-push: push failed status=none host=fcm.googleapis.com subscription=d1 error="Socket timeout"',
      'send-push: push failed status=none host=fcm.googleapis.com subscription=d2 error="getaddrinfo ENOTFOUND fcm.googleapis.com"',
    ]);
  });

  it('answers 200 with the number that took it when one of two fails, and still writes the line', async () => {
    pushServices({ d2: refusedBy(500, 'Internal Server Error') });
    const response = await push();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"delivered":1}');
    expect(lines('error')).toEqual([
      'send-push: push failed status=500 host=fcm.googleapis.com subscription=d2 body="Internal Server Error"',
    ]);
    expect(writes().map(({ op, value }) => `${op} ${value}`)).toEqual(['update d1']);
  });

  it('counts a library that throws instead of rejecting as a failed push', async () => {
    webpush.sendNotification = vi.fn(() => { throw new Error('To send a message with a payload, the subscription must have \'auth\' and \'p256dh\' keys.'); });
    const response = await push();
    expect(response.status).toBe(502);
    expect(lines('error')[0]).toMatch(/^send-push: push failed status=none host=fcm\.googleapis\.com subscription=d1 error="To send a message/);
  });

  // The host says which push service answered. The path is the device's own
  // address: whoever has it and the VAPID key can write to that phone.
  it('never writes the path of an endpoint or a key, whatever the push service or the library echo', async () => {
    const echo = (sub) => `error sending request for url (${sub.endpoint}): keys ${sub.keys.p256dh} ${sub.keys.auth}`;
    tables.push_subscriptions.push(device('d4', USER, 'https://wns2-by3p.notify.windows.com/w/?token='));
    pushServices({
      d1: (sub) => refusedBy(400, `<html>\n  <body>Invalid   token: ${new URL(sub.endpoint).pathname}</body>\n</html>`)(sub),
      d2: (sub) => new Error(echo(sub)),
      d4: (sub) => refusedBy(410, `Gone: ${new URL(sub.endpoint).searchParams.get('token')}`)(sub),
    });
    await push();

    expect(lines('error').slice(0, 2)).toEqual([
      'send-push: push failed status=400 host=fcm.googleapis.com subscription=d1 body="<html> <body>Invalid token: [removed]</body> </html>"',
      'send-push: push failed status=none host=fcm.googleapis.com subscription=d2 error="error sending request for url ([removed]): keys [removed] [removed]"',
    ]);
    expect(lines('warn')).toEqual([
      'send-push: push failed status=410 host=wns2-by3p.notify.windows.com subscription=d4 body="Gone: [removed]"',
    ]);
    for (const secret of ['token-of-', 'p256dh-of-', 'auth-of-', '/fcm/send/', '?token=']) {
      expect(everyLine(), secret).not.toContain(secret);
    }
  });

  it('cuts what a push service said at 200 characters', async () => {
    pushServices({ d1: refusedBy(503, 'x'.repeat(5000)), d2: refusedBy(503, undefined) });
    await push();
    expect(lines('error').slice(0, 2)).toEqual([
      `send-push: push failed status=503 host=fcm.googleapis.com subscription=d1 body="${'x'.repeat(200)}"`,
      'send-push: push failed status=503 host=fcm.googleapis.com subscription=d2 body=""',
    ]);
  });

  it('gives a push service eight seconds, whatever the library does, and leaves no timer behind', async () => {
    vi.useFakeTimers();
    await push();
    expect(vi.getTimerCount()).toBe(0);

    webpush.sendNotification = vi.fn(() => new Promise(() => {}));
    const pending = push();
    await vi.advanceTimersByTimeAsync(SEND_DEADLINE_MS - 1);
    expect(lines('error')).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    const response = await pending;
    expect(response.status).toBe(502);
    expect(lines('error')[0]).toBe('send-push: push failed status=none host=fcm.googleapis.com subscription=d1 error="no answer from the push service in 8000 ms"');
    expect(vi.getTimerCount()).toBe(0);
    // Under the ten seconds the database waits for the answer.
    expect(SEND_DEADLINE_MS).toBeLessThan(10000);
  });

  it('does not take a note that could not be written for a push that failed', async () => {
    const from = admin.from.bind(admin);
    admin.from = (table) => ({ ...from(table), update: () => ({ eq: async () => ({ data: null, error: { message: 'canceling statement due to statement timeout' } }) }) });
    const response = await push();
    expect(await response.text()).toBe('{"delivered":2}');
    expect(lines('error')).toEqual([]);
    expect(lines('warn')).toEqual([
      'send-push: last_seen_at of subscription d1 was not written: canceling statement due to statement timeout',
      'send-push: last_seen_at of subscription d2 was not written: canceling statement due to statement timeout',
    ]);
  });
});

describe('a device its push service calls gone is removed, and is not an error', () => {
  it('deletes the row on 410 and on 404, and keeps the one that failed otherwise', async () => {
    tables.push_subscriptions.push(device('d4', USER, 'https://updates.push.services.mozilla.com/wpush/v2/'));
    pushServices({
      d1: refusedBy(410, 'push subscription has unsubscribed or expired.\n'),
      d2: refusedBy(404, 'Not Found'),
      d4: refusedBy(429, 'Too Many Requests'),
    });
    const response = await push();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ delivered: 0, failed: 1 });

    expect(writes()).toEqual([
      { table: 'push_subscriptions', op: 'delete', column: 'id', value: 'd1' },
      { table: 'push_subscriptions', op: 'delete', column: 'id', value: 'd2' },
    ]);
    expect(tables.push_subscriptions.map(({ id }) => id)).toEqual(['d3', 'd4']);
    // Gone is a warning: it happens whenever somebody removes the app.
    expect(lines('warn')).toEqual([
      'send-push: push failed status=410 host=fcm.googleapis.com subscription=d1 body="push subscription has unsubscribed or expired."',
      'send-push: push failed status=404 host=fcm.googleapis.com subscription=d2 body="Not Found"',
    ]);
    expect(lines('error')).toEqual([
      'send-push: push failed status=429 host=updates.push.services.mozilla.com subscription=d4 body="Too Many Requests"',
      'send-push: no device got the push (1 failed, 2 gone)',
    ]);
  });

  // The rule of the finding: 502 is for devices that should have got it. A
  // user whose every device is gone is a user without a device.
  it('answers 200 {"delivered":0} when every device was gone', async () => {
    pushServices({ d1: refusedBy(410, 'Gone'), d2: refusedBy(404, 'Not Found') });
    const response = await push();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"delivered":0}');
    expect(tables.push_subscriptions.map(({ id }) => id)).toEqual(['d3']);
    expect(lines('error')).toEqual([]);
    expect(lines('warn')).toHaveLength(2);
  });

  it('says when the row of a device that is gone could not be deleted', async () => {
    pushServices({ d1: refusedBy(410, 'Gone') });
    const from = admin.from.bind(admin);
    admin.from = (table) => ({ ...from(table), delete: () => ({ eq: async () => { throw new Error('connection reset'); } }) });
    const response = await push();
    expect(await response.text()).toBe('{"delivered":1}');
    expect(lines('error')).toEqual(['send-push: subscription d1 is gone and its row could not be deleted: connection reset']);
  });
});

// Without this a row of push_subscriptions is a way to have the function
// call any address (review B3). The database has the same list as a check
// constraint; the function does not go by what a table promises.
describe('an endpoint that is not at a push service is never called', () => {
  const ELSEWHERE = [
    'https://attacker.example/collect/',
    'http://fcm.googleapis.com/fcm/send/',
    'https://fcm.googleapis.com.attacker.example/fcm/send/',
    'https://fcm.googleapis.com@attacker.example/fcm/send/',
    'https://abcdefghijklmnopqrst.supabase.co/functions/v1/send-push?',
    'https://127.0.0.1/fcm/send/',
  ];

  it('refuses it before anything is sent, keeps the row, and counts it as failed', async () => {
    tables.push_subscriptions = ELSEWHERE.map((base, at) => device(`e${at}`, USER, base));
    const response = await push();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ delivered: 0, failed: ELSEWHERE.length });
    expect(webpush.sendNotification).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
    expect(tables.push_subscriptions).toHaveLength(ELSEWHERE.length);

    const reason = 'reason="not an address at a push service of the list"';
    expect(lines('error')).toEqual([
      `send-push: push not sent host=attacker.example subscription=e0 ${reason}`,
      `send-push: push not sent host=fcm.googleapis.com subscription=e1 ${reason}`,
      `send-push: push not sent host=fcm.googleapis.com.attacker.example subscription=e2 ${reason}`,
      `send-push: push not sent host=attacker.example subscription=e3 ${reason}`,
      `send-push: push not sent host=abcdefghijklmnopqrst.supabase.co subscription=e4 ${reason}`,
      `send-push: push not sent host=127.0.0.1 subscription=e5 ${reason}`,
      `send-push: no device got the push (${ELSEWHERE.length} failed, 0 gone)`,
    ]);
    expect(everyLine()).not.toContain('token-of-');
  });

  it('still sends to the devices that are at one', async () => {
    tables.push_subscriptions.push(device('e0', USER, ELSEWHERE[0]), {
      ...device('e1', USER), endpoint: null,
    });
    const response = await push();
    expect(await response.text()).toBe('{"delivered":2}');
    expect(sentTo()).toEqual([tables.push_subscriptions[0].endpoint, tables.push_subscriptions[1].endpoint]);
    expect(lines('error')).toEqual([
      'send-push: push not sent host=attacker.example subscription=e0 reason="not an address at a push service of the list"',
      'send-push: push not sent host=not-a-url subscription=e1 reason="not an address at a push service of the list"',
    ]);
  });

  it('sends to each of the four push services', async () => {
    tables.push_subscriptions = [
      device('chrome', USER),
      device('firefox', USER, 'https://updates.push.services.mozilla.com/wpush/v2/'),
      device('safari', USER, 'https://web.push.apple.com/'),
      device('edge', USER, 'https://wns2-by3p.notify.windows.com/w/?token='),
    ];
    expect(await (await push()).text()).toBe('{"delivered":4}');
  });
});

// The library sends with four weeks to live and urgency normal unless told
// otherwise, and refuses to send at all when told something it cannot use.
describe('how long a push is kept, and how urgent it is', () => {
  const sentWith = () => webpush.sendNotification.mock.calls.map(([, , options]) => options);

  it('takes ttl and urgency from the request', async () => {
    await push({ ttl: 60, urgency: 'high' });
    await push({ ttl: 0, urgency: 'very-low' });
    await push({ ttl: 2419200, urgency: 'low' });
    expect(sentWith().filter((_, at) => at % 2 === 0)).toEqual([
      { TTL: 60, urgency: 'high', timeout: 5000 },
      { TTL: 0, urgency: 'very-low', timeout: 5000 },
      { TTL: 2419200, urgency: 'low', timeout: 5000 },
    ]);
    expect(everyLine()).toBe('');
  });

  it('keeps a push for a day, urgency normal, when the request says nothing — as the database before migration 15 does', async () => {
    await push({ ttl: undefined, urgency: undefined });
    await push({ ttl: null, urgency: null });
    expect(new Set(sentWith().map((options) => JSON.stringify(options)))).toEqual(new Set(['{"TTL":86400,"urgency":"normal","timeout":5000}']));
    expect(everyLine()).toBe('');
  });

  it('sends with the usual values, and says so, when the request asks for something that cannot be used', async () => {
    for (const ttl of [-1, 1.5, '60', 2419201, true, {}, []]) {
      webpush.sendNotification.mockClear();
      log.warn.mockClear();
      const response = await push({ ttl, urgency: 'high' });
      expect(await response.text(), JSON.stringify(ttl)).toBe('{"delivered":2}');
      expect(sentWith()[0], JSON.stringify(ttl)).toEqual({ TTL: 86400, urgency: 'high', timeout: 5000 });
      expect(lines('warn'), JSON.stringify(ttl)).toHaveLength(1);
    }
    expect(lines('warn')).toEqual(['send-push: ttl [] is not a whole number of seconds from 0 to 2419200, 86400 is used']);

    for (const urgency of ['HIGH', 'urgent', '', 5, ['high']]) {
      webpush.sendNotification.mockClear();
      log.warn.mockClear();
      const response = await push({ ttl: 60, urgency });
      expect(await response.text(), JSON.stringify(urgency)).toBe('{"delivered":2}');
      expect(sentWith()[0], JSON.stringify(urgency)).toEqual({ TTL: 60, urgency: 'normal', timeout: 5000 });
      expect(lines('warn'), JSON.stringify(urgency)).toHaveLength(1);
    }
    expect(lines('warn')).toEqual(['send-push: urgency ["high"] is not one of very-low, low, normal, high, normal is used']);
  });

  it('gives the options on their own, for another sender', () => {
    expect(sendOptions({ ttl: 30 }, { ttl: 60, urgency: 'high' }, { name: 'dispatch-rest-push', log })).toEqual({ TTL: 30, urgency: 'high', timeout: 5000 });
    expect(restSendOptions()).toEqual({ TTL: REST_TTL_SECONDS, urgency: 'high', timeout: SEND_TIMEOUT_MS });
    expect(REST_TTL_SECONDS).toBe(60);
  });
});

// ------------------------------------------------------------
// A rest push: a row of scheduled_pushes that the job of the database hands
// over a few seconds before its time, with the time not to send before.
// ------------------------------------------------------------
describe('a rest push: answered at once, sent at its time, by one claim', () => {
  // Answers the request the job sends, and collects what the function hands
  // to the runtime to go on with.
  async function rest(body = {}, context = {}) {
    const handed = [];
    const sleep = vi.fn(async () => {});
    const response = await answerPush(
      { user_id: USER, payload: REST_PAYLOAD, schedule_id: ROW, not_before: pgTime(NOW + 7000), ttl: 60, urgency: 'high', ...body },
      { name: NAME, webpush, createAdmin, log, now: () => NOW, sleep, waitUntil: (work) => { handed.push(work); }, ...context },
    );
    return { response, handed, sleep, done: () => Promise.all(handed) };
  }

  const row = () => tables.scheduled_pushes[0];
  const claims = () => admin.calls.filter((call) => call.rpc);
  const recorded = () => admin.calls.filter(({ table }) => table === 'scheduled_pushes');

  it('answers 202 before the wait is over, and hands the rest to the runtime', async () => {
    let wake;
    const sleep = vi.fn(() => new Promise((resolve) => { wake = resolve; }));
    const { response, handed } = await rest({}, { sleep });

    expect(response.status).toBe(202);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.text()).toBe('{"accepted":true}');
    expect(handed).toHaveLength(1);
    expect(handed[0]).toBeInstanceOf(Promise);
    // Nothing has been asked of the database, and nothing sent: the rest is
    // not over, and it may still be taken back.
    expect(admin.calls).toEqual([]);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
    expect(row().status).toBe('pending');

    wake();
    await handed[0];
    expect(row().status).toBe('sent');
  });

  it('waits until not_before, to the millisecond, and not at all for a time that has come', async () => {
    const waited = async (not_before) => {
      const { sleep, done } = await rest(not_before === undefined ? {} : { not_before });
      await done();
      return sleep.mock.calls;
    };
    expect(pgTime(NOW + 7000)).toBe('2026-10-13T20:00:07.000000+00:00');
    expect(await waited()).toEqual([[7000]]);
    expect(await waited(pgTime(NOW + 1))).toEqual([[1]]);
    expect(await waited('2026-10-13T20:00:09.5Z')).toEqual([[9500]]);
    expect(await waited('2026-10-13T22:00:03+02:00')).toEqual([[3000]]);
    expect(await waited(pgTime(NOW))).toEqual([]);
    expect(await waited(pgTime(NOW - 45000))).toEqual([]);
  });

  it('asks the claim once, for that row, after the wait and before anything else', async () => {
    const order = [];
    const sleep = vi.fn(async () => { order.push('waited'); });
    const { done } = await rest({}, { sleep });
    await done();
    expect(claims()).toEqual([{ rpc: 'claim_rest_push', args: { p_id: ROW } }]);
    expect(admin.calls[0]).toEqual({ rpc: 'claim_rest_push', args: { p_id: ROW } });
    expect(order).toEqual(['waited']);
    expect(admin.calls.map((call) => call.rpc ?? `${call.op} ${call.table}`)).toEqual([
      'claim_rest_push', 'select push_subscriptions', 'update push_subscriptions', 'update push_subscriptions', 'update scheduled_pushes',
    ]);
  });

  it('sends what the claim answered — its user, its payload — and not what the request said', async () => {
    const { done } = await rest({ user_id: OTHER, payload: { title: 'written by somebody else' } });
    await done();
    const options = { TTL: 60, urgency: 'high', timeout: 5000 };
    expect(webpush.sendNotification.mock.calls).toEqual([
      [subscription(tables.push_subscriptions[0]), JSON.stringify(REST_PAYLOAD), options],
      [subscription(tables.push_subscriptions[1]), JSON.stringify(REST_PAYLOAD), options],
    ]);
    expect(admin.calls[1]).toEqual({ table: 'push_subscriptions', op: 'select', column: 'user_id', value: USER });
  });

  it('sends to the device the claim names, and to no other', async () => {
    const [d1, d2] = tables.push_subscriptions;
    claim.endpoint = d2.endpoint;
    const { done } = await rest({ endpoint: d1.endpoint });
    await done();
    expect(sentTo()).toEqual([d2.endpoint]);
    expect(row()).toMatchObject({ status: 'sent', error: null });
  });

  // The devices are read with the user id, never by the endpoint alone: a
  // phone that has changed hands since the rest began is another account's.
  it('sends nothing to a device that is no longer this account\'s', async () => {
    claim.endpoint = tables.push_subscriptions[2].endpoint;
    const { done } = await rest();
    await done();
    expect(webpush.sendNotification).not.toHaveBeenCalled();
    expect(admin.calls.filter(({ op }) => op === 'select')).toEqual([
      { table: 'push_subscriptions', op: 'select', column: 'user_id', value: USER },
    ]);
    expect(row()).toMatchObject({ status: 'failed', error: 'no_subscriptions' });
  });

  it('writes sent, and when, once a device took it — one of two is enough', async () => {
    pushServices({ d1: refusedBy(500, 'Internal Server Error') });
    const { done } = await rest();
    await done();
    expect(recorded()).toEqual([{
      table: 'scheduled_pushes', op: 'update', column: 'id', value: ROW,
      values: { status: 'sent', sent_at: '2026-10-13T20:00:00.000Z', error: null },
    }]);
    expect(row()).toMatchObject({ status: 'sent', sent_at: '2026-10-13T20:00:00.000Z', error: null });
  });

  it('writes failed and no_subscriptions when the account has no device', async () => {
    tables.push_subscriptions = [tables.push_subscriptions[2]];
    const { done } = await rest();
    await done();
    expect(recorded()).toEqual([{
      table: 'scheduled_pushes', op: 'update', column: 'id', value: ROW,
      values: { status: 'failed', sent_at: null, error: 'no_subscriptions' },
    }]);
    expect(NO_SUBSCRIPTIONS).toBe('no_subscriptions');
    expect(lines('warn')).toEqual(['send-push: rest push aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa: no device to send to (no_subscriptions)']);
  });

  it('writes failed and all_subscriptions_failed when no device took it', async () => {
    pushServices({ d1: refusedBy(403, 'Forbidden'), d2: refusedBy(410, 'Gone') });
    const { done } = await rest();
    await done();
    expect(recorded()).toEqual([{
      table: 'scheduled_pushes', op: 'update', column: 'id', value: ROW,
      values: { status: 'failed', sent_at: null, error: 'all_subscriptions_failed' },
    }]);
    expect(ALL_SUBSCRIPTIONS_FAILED).toBe('all_subscriptions_failed');
    expect(lines('error')).toEqual([
      'send-push: push failed status=403 host=fcm.googleapis.com subscription=d1 body="Forbidden"',
      `send-push: rest push ${ROW}: no device got it (1 failed, 1 gone)`,
    ]);
    // The device that is gone is removed here too.
    expect(tables.push_subscriptions.map(({ id }) => id)).toEqual(['d1', 'd3']);
  });

  // Somebody else sent it, its athlete took it back, it is a minute late, or
  // there is no such row: the claim answers nothing, and that is the end.
  it('sends nothing and writes nothing when the claim answers nothing', async () => {
    claim = null;
    const { response, done } = await rest();
    await done();
    expect(response.status).toBe(202);
    expect(admin.calls).toEqual([{ rpc: 'claim_rest_push', args: { p_id: ROW } }]);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
    expect(row().status).toBe('pending');
    expect(lines('info')).toHaveLength(1);
    expect(lines('info')[0]).toMatch(new RegExp(`^send-push: rest push ${ROW}: not sent`));
    expect(lines('error')).toEqual([]);
  });

  it('sends a row once when it is handed over twice', async () => {
    const first = await rest();
    const second = await rest();
    await Promise.all([first.done(), second.done()]);
    expect(claims()).toHaveLength(2);
    expect(webpush.sendNotification).toHaveBeenCalledTimes(2);
    expect(recorded()).toHaveLength(1);
  });

  it('sends nothing and writes nothing when the claim cannot be asked', async () => {
    for (const answer of [
      () => ({ data: null, error: { message: 'permission denied for function claim_rest_push' } }),
      () => { throw new TypeError('fetch failed'); },
    ]) {
      admin = fakeAdmin(tables, { rpc: { claim_rest_push: answer } });
      log.error.mockClear();
      const { done } = await rest();
      await done();
      expect(admin.calls).toEqual([{ rpc: 'claim_rest_push', args: { p_id: ROW } }]);
      expect(webpush.sendNotification).not.toHaveBeenCalled();
      expect(lines('error')).toHaveLength(1);
      expect(lines('error')[0]).toMatch(new RegExp(`^send-push: rest push ${ROW}: claim_rest_push could not be asked, nothing is sent: `));
    }
    // Before migration 16 there is no such function: the same.
    admin = fakeAdmin(tables);
    const { done } = await rest();
    await done();
    expect(webpush.sendNotification).not.toHaveBeenCalled();
    expect(recorded()).toEqual([]);
  });

  // A row that was claimed reads 'sending' until its sender says otherwise.
  // Whatever goes wrong after the claim, the row is closed.
  it('still writes failed when something breaks after the claim', async () => {
    const closed = { status: 'failed', sent_at: null, error: 'sender_failed' };
    const cases = {
      'the devices cannot be read': () => { admin.error = 'canceling statement due to statement timeout'; },
      'the client throws': () => {
        const from = admin.from.bind(admin);
        admin.from = (table) => { if (table === 'push_subscriptions') throw new Error('connection reset'); return from(table); };
      },
      'the claim answered a row without a payload': () => { claim = { ...claim, payload: null }; },
      'the claim answered a row without a user': () => { claim = { ...claim, user_id: null }; },
    };
    for (const [name, breakIt] of Object.entries(cases)) {
      row().status = 'pending';
      admin.error = null;
      admin.calls.length = 0;
      log.error.mockClear();
      const from = admin.from;
      const was = claim;
      breakIt();
      const { done } = await rest();
      await done();
      expect(recorded().map(({ values }) => values), name).toEqual([closed]);
      expect(row(), name).toMatchObject(closed);
      expect(webpush.sendNotification, name).not.toHaveBeenCalled();
      expect(lines('error'), name).toHaveLength(1);
      admin.from = from;
      claim = was;
    }
    expect(SENDER_FAILED).toBe('sender_failed');
  });

  it('says when what became of the push could not be written', async () => {
    const from = admin.from.bind(admin);
    admin.from = (table) => (table === 'scheduled_pushes'
      ? { update: () => ({ eq: async () => ({ data: null, error: { message: 'connection reset' } }) }) }
      : from(table));
    const { done } = await rest();
    await done();
    expect(webpush.sendNotification).toHaveBeenCalledTimes(2);
    expect(lines('error')).toEqual([
      `send-push: rest push ${ROW}: what became of it could not be written, the row stays 'sending': connection reset`,
    ]);
  });

  // A function may run for 150 seconds. The job hands a row over ten seconds
  // before its time; anything much further ahead is not this function's.
  it('refuses a time more than two minutes ahead, or that is not a time, without waiting', async () => {
    expect(MAX_WAIT_MS).toBe(120000);
    const refused = {
      'not_before is more than 120 seconds ahead': [pgTime(NOW + MAX_WAIT_MS + 1), pgTime(NOW + 3600000), '2027-01-01T00:00:00Z'],
      'not_before is not a time': ['soon', '', '2026', '1', 'T20:00:00Z', '2026-13-45T99:99:99Z', NOW + 5000, null, undefined, {}],
    };
    for (const [text, values] of Object.entries(refused)) {
      for (const not_before of values) {
        const { response, handed, sleep } = await rest({ not_before });
        expect(response.status, JSON.stringify(not_before)).toBe(400);
        expect(await response.text(), JSON.stringify(not_before)).toBe(`send-push: ${text}`);
        expect(handed).toEqual([]);
        expect(sleep).not.toHaveBeenCalled();
      }
      expect(lines('warn')).toContain(`send-push: refused, ${text}`);
    }
    expect(createAdmin).not.toHaveBeenCalled();
    expect(webpush.sendNotification).not.toHaveBeenCalled();

    // Exactly two minutes is still waited for.
    const { response, sleep } = await rest({ not_before: pgTime(NOW + MAX_WAIT_MS) });
    expect(response.status).toBe(202);
    expect(sleep.mock.calls).toEqual([[120000]]);
  });

  // A request that names a row is never sent the other way — at once, to
  // every device: that is the push ten seconds early the claim exists for.
  it('refuses a schedule_id that is not a uuid, and sends nothing at once', async () => {
    for (const schedule_id of ['', 'not-a-uuid', `${ROW}; drop table`, 42, null, true, [ROW], { id: ROW }]) {
      const { response, handed, sleep } = await rest({ schedule_id });
      expect(response.status, JSON.stringify(schedule_id)).toBe(400);
      expect(await response.text()).toBe('send-push: schedule_id is not a uuid');
      expect(handed).toEqual([]);
      expect(sleep).not.toHaveBeenCalled();
    }
    expect(createAdmin).not.toHaveBeenCalled();
    expect(webpush.sendNotification).not.toHaveBeenCalled();
    expect(lines('warn')).toContain('send-push: refused, schedule_id is not a uuid');
  });

  it('refuses a rest push without a user or a payload like any other request', async () => {
    const { response, handed } = await rest({ payload: undefined });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('send-push: missing user_id or payload');
    expect(handed).toEqual([]);
  });

  it('keeps a rest push for a minute, urgency high, unless the request asks for something it can use', async () => {
    const sentWith = () => webpush.sendNotification.mock.calls.at(-1)[2];
    await (await rest({ ttl: undefined, urgency: undefined })).done();
    expect(sentWith()).toEqual({ TTL: 60, urgency: 'high', timeout: 5000 });
    row().status = 'pending';
    await (await rest({ ttl: 30, urgency: 'normal' })).done();
    expect(sentWith()).toEqual({ TTL: 30, urgency: 'normal', timeout: 5000 });
    row().status = 'pending';
    await (await rest({ ttl: '60', urgency: 'now' })).done();
    expect(sentWith()).toEqual({ TTL: 60, urgency: 'high', timeout: 5000 });
    expect(lines('warn')).toHaveLength(2);
  });

  it('does the work before it answers where there is no runtime to hand it to', async () => {
    const order = [];
    const sleep = vi.fn(async () => { order.push('waited'); });
    const { response, handed } = await rest({}, { waitUntil: undefined, sleep });
    expect(handed).toEqual([]);
    expect(response.status).toBe(202);
    expect(order).toEqual(['waited']);
    expect(row().status).toBe('sent');
  });

  it('never hands the runtime a promise that rejects', async () => {
    const sleep = vi.fn(async () => { throw new Error('the timer broke'); });
    const { response, handed } = await rest({}, { sleep });
    expect(response.status).toBe(202);
    await expect(handed[0]).resolves.toBeUndefined();
    expect(admin.calls).toEqual([]);
    expect(lines('error')).toEqual([`send-push: rest push ${ROW}: the timer broke`]);
  });

  it('waits on the real clock when it is given none', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const handed = [];
    const response = await answerPush(
      { user_id: USER, payload: REST_PAYLOAD, schedule_id: ROW, not_before: pgTime(NOW + 7000) },
      { name: NAME, webpush, createAdmin, log, waitUntil: (work) => { handed.push(work); } },
    );
    expect(response.status).toBe(202);
    await vi.advanceTimersByTimeAsync(6999);
    expect(admin.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await handed[0];
    expect(row()).toMatchObject({ status: 'sent', sent_at: '2026-10-13T20:00:07.000Z' });
  });
});

// The other sender of a rest push — dispatch-rest-push, called by the app —
// does its own waiting and then asks the same claim. This is what it calls.
describe('sendRestPush: the claim, the push and the row, for any sender', () => {
  const send = (input = {}) => sendRestPush({ admin, webpush, scheduleId: ROW, name: 'dispatch-rest-push', log, now: () => NOW, ...input });

  it('claims, sends with what a rest push is worth, records, and says what became of it', async () => {
    expect(await send()).toEqual({ outcome: 'sent', delivered: 2, error: null });
    expect(webpush.sendNotification.mock.calls.map(([, , options]) => options)).toEqual([
      { TTL: 60, urgency: 'high', timeout: 5000 },
      { TTL: 60, urgency: 'high', timeout: 5000 },
    ]);
    expect(tables.scheduled_pushes[0]).toMatchObject({ status: 'sent', sent_at: '2026-10-13T20:00:00.000Z', error: null });
  });

  it('answers each way a push can end, and starts its lines with the name it was given', async () => {
    expect(await send()).toMatchObject({ outcome: 'sent' });
    expect(await send()).toEqual({ outcome: 'not_claimed', delivered: 0, error: null });

    tables.scheduled_pushes[0].status = 'pending';
    pushServices({ d1: refusedBy(401, 'Unauthorized'), d2: refusedBy(401, 'Unauthorized') });
    expect(await send()).toEqual({ outcome: 'failed', delivered: 0, error: 'all_subscriptions_failed' });

    tables.scheduled_pushes[0].status = 'pending';
    tables.push_subscriptions = [];
    expect(await send()).toEqual({ outcome: 'failed', delivered: 0, error: 'no_subscriptions' });

    expect(await send({ admin: fakeAdmin(tables) })).toEqual({ outcome: 'claim_failed', delivered: 0, error: null });
    for (const line of everyLine().split('\n')) expect(line).toMatch(/^dispatch-rest-push: /);
  });
});

describe('sendToDevices and failureLine, on their own', () => {
  it('counts what became of each device and never rejects', async () => {
    const devices = [device('d1', USER), device('d2', USER), device('d4', USER), device('e0', USER, 'https://attacker.example/')];
    tables.push_subscriptions = devices;
    pushServices({ d2: refusedBy(410, 'Gone'), d4: refusedBy(500, 'no') });
    const counts = await sendToDevices({
      webpush, admin, devices, payload: PAYLOAD, options: restSendOptions(), name: NAME, log, now: () => NOW,
    });
    expect(counts).toEqual({ delivered: 1, gone: 1, failed: 2 });
  });

  it('writes the two lines the runbook quotes', () => {
    const d1 = device('d1', USER, 'https://web.push.apple.com/');
    expect(failureLine('send-push', d1, refusedBy(403, '{"reason":"BadJwtToken"}')(d1)))
      .toBe('send-push: push failed status=403 host=web.push.apple.com subscription=d1 body="{\\"reason\\":\\"BadJwtToken\\"}"');
    expect(failureLine('send-push', d1, new Error('Socket timeout')))
      .toBe('send-push: push failed status=none host=web.push.apple.com subscription=d1 error="Socket timeout"');
    expect(failureLine('send-push', d1, 'a string was thrown'))
      .toBe('send-push: push failed status=none host=web.push.apple.com subscription=d1 error="a string was thrown"');
  });
});
