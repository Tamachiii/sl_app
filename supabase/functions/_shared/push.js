// What send-push does with a request its gate has let in: who gets the push,
// with which options, what is written down when a push service says no, and
// what the caller is answered.
//
// The caller is the database, through pg_net, and it does not read the
// answer (the optional job of migration 19 counts, once an hour, the answers
// that were not a 2xx). So whatever goes wrong is said twice: in the status
// of the answer, and in a line of the function's log — which is the only
// trace there is where that job does not run.
//
// TWO KINDS OF REQUEST
//
//   an event      { user_id, payload, ttl?, urgency? }
//
//     Sent now, to every device of the user.
//       200 {"delivered":N}             N devices took it. Also with N = 0:
//                                       the user has no device, or had only
//                                       devices their push service calls
//                                       gone (404, 410) — those rows are
//                                       deleted, and no device is no error.
//       502 {"delivered":0,"failed":N}  there were devices, none took it, and
//                                       at least one for another reason than
//                                       being gone: a VAPID key the push
//                                       service refuses, a service that is
//                                       down, an address that is not one.
//       500 {"error":…}                 the devices could not be read.
//
//   a rest push   { user_id, payload, schedule_id, not_before, ttl?, urgency? }
//
//     A row of scheduled_pushes, handed over a few seconds before its time
//     by the job that runs dispatch_due_rest_pushes(). Answered 202 at once
//     — the caller waits ten seconds at most, and the rest is not over —
//     and then, in the background: wait until not_before, ask
//     claim_rest_push(schedule_id), send what THE CLAIM answered (its user,
//     its payload, its device: not the request's), and write on the row what
//     became of it.
//       202 {"accepted":true}
//       400                             a schedule_id that is not a uuid, a
//                                       not_before that is not a time, or
//                                       one further ahead than a function
//                                       may wait.
//
//   Both: 400 without a user_id or without a payload that is an object.
//
// EVERY PUSH THAT WAS NOT TAKEN IS A LINE OF THE LOG — the status the push
// service answered, what it said (cut short), and its HOST. Never the path
// of the endpoint, which is the device's own address, and never a key.
//
// RUNTIME-NEUTRAL, like every module of this folder: web standards only, and
// what it works with — the web-push library, the service-role client, the
// clock, the runtime's waitUntil — comes in as arguments. push.test.js runs
// it under Node.
//
// (The names are handed out in one list at the end of the file: the CLI that
// uploads a function reads a quoted word after that keyword as a file to
// upload — ../deploy.test.js.)

import { isPushEndpoint, pushHost } from './pushHosts.js';

/**
 * A supabase-js client made with the service-role key. What is used of it:
 * `from(table).select(columns).eq(column, value)`, `.update(values).eq(…)`,
 * `.delete().eq(…)` and `rpc(name, args)`, each answering `{ data, error }`.
 *
 * @typedef {any} AdminClient
 */

/**
 * The part of the web-push library that sends: it resolves when the push
 * service took the message, and rejects otherwise — with `statusCode` and
 * `body` when the service answered, without them when it did not.
 *
 * @typedef {{
 *   sendNotification: (
 *     subscription: { endpoint: string, keys: { p256dh: string, auth: string } },
 *     message: string,
 *     options: SendOptions,
 *   ) => Promise<unknown>,
 * }} PushSender
 */

/**
 * What a push is sent with, in the words of the web-push library.
 *
 * @typedef {{ TTL: number, urgency: 'very-low' | 'low' | 'normal' | 'high', timeout: number }} SendOptions
 */

/**
 * Where the lines go. `console` is one.
 *
 * @typedef {{
 *   info: (message: string) => void,
 *   warn: (message: string) => void,
 *   error: (message: string) => void,
 * }} Log
 */

/**
 * A row of push_subscriptions, as far as a send needs it.
 *
 * @typedef {{ id: string, endpoint: string, p256dh: string, auth: string }} Device
 */

// How long a push service keeps a message for a device that is offline, in
// seconds. An event — feedback, a message, a session confirmed — is worth
// reading for a day; the library's own default is four weeks. The end of a
// rest is worth a minute: later than that it is worse than nothing.
const EVENT_TTL_SECONDS = 86400;
const REST_TTL_SECONDS = 60;
// Four weeks: what the push services accept.
const MAX_TTL_SECONDS = 2419200;

// RFC 8030. With anything below `high`, a phone that is saving its battery
// may hold the message back.
const URGENCIES = ['very-low', 'low', 'normal', 'high'];
const EVENT_URGENCY = 'normal';
const REST_URGENCY = 'high';

// The library gives up on a connection that stays silent this long …
const SEND_TIMEOUT_MS = 5000;
// … and whatever it does, a send is over after this long: the caller waits
// ten seconds for the answer of the function.
const SEND_DEADLINE_MS = 8000;

// How far ahead a not_before may be. A function may run for 150 seconds; the
// job hands a row over ten seconds before its time.
const MAX_WAIT_MS = 120000;

// How much of a push service's answer goes into the log.
const LOGGED_ANSWER_CHARS = 200;

// What is written in scheduled_pushes.error. The first two are the words the
// rest push has always used.
const NO_SUBSCRIPTIONS = 'no_subscriptions';
const ALL_SUBSCRIPTIONS_FAILED = 'all_subscriptions_failed';
const SENDER_FAILED = 'sender_failed';

const DEVICE_COLUMNS = 'id, endpoint, p256dh, auth';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A date, a time, and whatever follows: what Postgres writes for a
// timestamptz in JSON. `Date.parse` alone also reads "2026" and "1".
const ISO_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const messageOf = (error) => {
  if (typeof error?.message === 'string' && error.message !== '') return error.message;
  return String(error);
};

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

// A refusal of the request itself. Plain text that starts with the name of
// the function, like the refusals of the gate; and a line of the log,
// because the caller does not read the answer.
function refuse(name, log, text) {
  log.warn(`${name}: refused, ${text}`);
  return new Response(`${name}: ${text}`, {
    status: 400,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

/**
 * The options of a send: what the request asks for where it asks for
 * something the push services take, and `fallback` otherwise. A value that
 * cannot be used is a line of the log and never a lost push — the library
 * would refuse to send at all.
 *
 * @param {{ ttl?: unknown, urgency?: unknown }} asked  the body of the request
 * @param {{ ttl: number, urgency: 'very-low' | 'low' | 'normal' | 'high' }} fallback
 * @param {{ name: string, log?: Log }} context
 * @returns {SendOptions}
 */
function sendOptions(asked, fallback, { name, log = console }) {
  const shown = (value) => String(JSON.stringify(value)).slice(0, 40);
  let { ttl, urgency } = fallback;

  if (asked.ttl !== undefined && asked.ttl !== null) {
    if (Number.isInteger(asked.ttl) && asked.ttl >= 0 && asked.ttl <= MAX_TTL_SECONDS) {
      ttl = asked.ttl;
    } else {
      log.warn(`${name}: ttl ${shown(asked.ttl)} is not a whole number of seconds from 0 to ${MAX_TTL_SECONDS}, ${fallback.ttl} is used`);
    }
  }
  if (asked.urgency !== undefined && asked.urgency !== null) {
    if (URGENCIES.includes(asked.urgency)) {
      urgency = asked.urgency;
    } else {
      log.warn(`${name}: urgency ${shown(asked.urgency)} is not one of ${URGENCIES.join(', ')}, ${fallback.urgency} is used`);
    }
  }
  return { TTL: ttl, urgency, timeout: SEND_TIMEOUT_MS };
}

/** What a rest push is sent with when nothing else is asked. */
const restSendOptions = () => ({ TTL: REST_TTL_SECONDS, urgency: REST_URGENCY, timeout: SEND_TIMEOUT_MS });

// What must not be read in a log: the address of the device — whole, its
// path, the token at its end or in its query — and its two keys.
function privateParts(device) {
  const parts = [device.p256dh, device.auth];
  if (typeof device.endpoint === 'string') {
    parts.push(device.endpoint);
    try {
      const url = new URL(device.endpoint);
      parts.push(`${url.pathname}${url.search}`, url.pathname.split('/').pop(), ...url.searchParams.values());
    } catch {
      // Not a URL: the text itself is in the list.
    }
  }
  return parts
    .filter((part) => typeof part === 'string' && part.length >= 12)
    .sort((a, b) => b.length - a.length);
}

// A text somebody else wrote — the answer of a push service, the message of
// an error — as one quoted word of a log line.
function quoted(text, device) {
  let shown = typeof text === 'string' ? text : String(text ?? '');
  for (const part of privateParts(device)) shown = shown.split(part).join('[removed]');
  return JSON.stringify(shown.replace(/\s+/g, ' ').trim().slice(0, LOGGED_ANSWER_CHARS));
}

const statusOf = (error) => (Number.isInteger(error?.statusCode) ? error.statusCode : null);

/**
 * The line of the log for a push that was not taken:
 *
 *   <name>: push failed status=403 host=fcm.googleapis.com subscription=<id> body="…"
 *   <name>: push failed status=none host=fcm.googleapis.com subscription=<id> error="…"
 *
 * `status=none` is a push service that did not answer: `error` is what the
 * library said instead. docs/runbook/30-edge-functions.md quotes both, and
 * ../runbook.test.js holds the page to this function.
 *
 * @param {string} name
 * @param {Device} device
 * @param {unknown} error  what `sendNotification` rejected with
 * @returns {string}
 */
function failureLine(name, device, error) {
  const status = statusOf(error);
  const said = status === null
    ? `error=${quoted(messageOf(error), device)}`
    : `body=${quoted(/** @type {{ body?: unknown }} */ (error).body, device)}`;
  return `${name}: push failed status=${status ?? 'none'} host=${pushHost(device.endpoint)} subscription=${device.id} ${said}`;
}

// A promise that is over after `ms` at the latest. The request behind it is
// not taken back: a message that arrives after all is counted as failed.
function within(ms, work) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer from the push service in ${ms} ms`)), ms);
  });
  return Promise.race([work(), late]).finally(() => clearTimeout(timer));
}

// A write that must not decide what became of the push: null, or why not.
async function written(request) {
  try {
    const { error } = await request();
    return error ? messageOf(error) : null;
  } catch (error) {
    return messageOf(error);
  }
}

// One device: 'delivered', 'gone' (its push service no longer knows it: the
// row is deleted) or 'failed' (everything else: the row stays).
async function sendToDevice({ webpush, admin, device, message, options, name, log, now }) {
  // Before anything is sent: a row is not a way to have the function call an
  // address of somebody's choosing. The row is left where it is — only a
  // push service's "gone" deletes one.
  if (!isPushEndpoint(device.endpoint)) {
    log.error(`${name}: push not sent host=${pushHost(device.endpoint)} subscription=${device.id} reason="not an address at a push service of the list"`);
    return 'failed';
  }

  try {
    await within(SEND_DEADLINE_MS, async () => webpush.sendNotification(
      { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
      message,
      options,
    ));
  } catch (error) {
    const status = statusOf(error);
    if (status === 404 || status === 410) {
      // Expected now and then: the app was removed, the permission taken
      // back. Said as a warning, and the row goes.
      log.warn(failureLine(name, device, error));
      const failure = await written(() => admin.from('push_subscriptions').delete().eq('id', device.id));
      if (failure) log.error(`${name}: subscription ${device.id} is gone and its row could not be deleted: ${failure}`);
      return 'gone';
    }
    log.error(failureLine(name, device, error));
    return 'failed';
  }

  const failure = await written(() => (
    admin.from('push_subscriptions').update({ last_seen_at: new Date(now()).toISOString() }).eq('id', device.id)
  ));
  if (failure) log.warn(`${name}: last_seen_at of subscription ${device.id} was not written: ${failure}`);
  return 'delivered';
}

/**
 * Sends one payload to a list of devices, all at once, and says what became
 * of each: a line of the log for every one that did not take it, the row
 * deleted where the push service calls the device gone, `last_seen_at`
 * where it was taken. Never rejects.
 *
 * It does not choose the devices: the caller read them from
 * push_subscriptions, BY USER ID.
 *
 * @param {{
 *   webpush: PushSender,
 *   admin: AdminClient,
 *   devices: Device[],
 *   payload: Record<string, unknown>,
 *   options: SendOptions,
 *   name: string,
 *   log?: Log,
 *   now?: () => number,
 * }} input  `name` is the function's name: it starts every line of the log
 * @returns {Promise<{ delivered: number, gone: number, failed: number }>}
 */
async function sendToDevices({ webpush, admin, devices, payload, options, name, log = console, now = Date.now }) {
  const message = JSON.stringify(payload);
  const counts = { delivered: 0, gone: 0, failed: 0 };
  await Promise.all(devices.map(async (device) => {
    let outcome = 'failed';
    try {
      outcome = await sendToDevice({ webpush, admin, device, message, options, name, log, now });
    } catch (error) {
      log.error(`${name}: push failed status=none host=${pushHost(device?.endpoint)} subscription=${device?.id} error=${quoted(messageOf(error), device ?? {})}`);
    }
    counts[outcome] += 1;
  }));
  return counts;
}

// The devices of one account: `{ devices }`, or `{ unreadable }` with what the
// database said. Always by the user id, never by an endpoint alone: an
// endpoint that has changed hands is somebody else's device.
async function devicesOf(admin, userId) {
  const { data, error } = await admin.from('push_subscriptions').select(DEVICE_COLUMNS).eq('user_id', userId);
  if (error) return { devices: [], unreadable: messageOf(error) };
  return { devices: data ?? [], unreadable: null };
}

/**
 * Sends a rest push that is due: asks `claim_rest_push`, sends what it
 * answered, and writes on the row what became of it. Never rejects.
 *
 * THE CLAIM IS THE ONE WAY A ROW GETS SENT. It answers a row once: two
 * senders that were handed the same row are one push, and a row its athlete
 * took back, or whose time is more than a minute past, is answered to
 * nobody. So this is called AT the time of the push, not before — and the
 * user, the payload and the device are the claim's, whatever the caller was
 * told earlier.
 *
 *   'not_claimed'   somebody else sent it, it was taken back, it is too
 *                   late, or there is no such row: nothing is sent, nothing
 *                   is written.
 *   'claim_failed'  the database could not be asked. The same.
 *   'sent'          at least one device took it: status 'sent', sent_at.
 *   'failed'        none did: status 'failed', and in `error` either
 *                   no_subscriptions (the account has no device, or no
 *                   longer the one the row names), all_subscriptions_failed,
 *                   or sender_failed (this function failed after the claim —
 *                   the row is still closed, or it would read 'sending' for
 *                   ever).
 *
 * @param {{
 *   admin: AdminClient,
 *   webpush: PushSender,
 *   scheduleId: string,
 *   options?: SendOptions,
 *   name: string,
 *   log?: Log,
 *   now?: () => number,
 * }} input  `options`, left out, is what a rest push is sent with: kept for a
 *   minute, urgency high
 * @returns {Promise<{ outcome: 'sent' | 'failed' | 'not_claimed' | 'claim_failed', delivered: number, error: string | null }>}
 */
async function sendRestPush({ admin, webpush, scheduleId, options = restSendOptions(), name, log = console, now = Date.now }) {
  let claim;
  try {
    const { data, error } = await admin.rpc('claim_rest_push', { p_id: scheduleId });
    if (error) throw new Error(messageOf(error));
    claim = data;
  } catch (error) {
    log.error(`${name}: rest push ${scheduleId}: claim_rest_push could not be asked, nothing is sent: ${messageOf(error)}`);
    return { outcome: 'claim_failed', delivered: 0, error: null };
  }
  if (!isRecord(claim)) {
    log.info(`${name}: rest push ${scheduleId}: not sent — another sender took it, it was taken back, or its time is more than a minute past`);
    return { outcome: 'not_claimed', delivered: 0, error: null };
  }

  // From here on the row is this call's, and reads 'sending' until this call
  // says otherwise: whatever happens below, it is closed.
  let delivered = 0;
  let failure = SENDER_FAILED;
  try {
    if (typeof claim.user_id !== 'string' || claim.user_id === '' || !isRecord(claim.payload)) {
      throw new Error('the claim answered a row without a user or without a payload');
    }
    const { devices: all, unreadable } = await devicesOf(admin, claim.user_id);
    if (unreadable) throw new Error(`push_subscriptions could not be read: ${unreadable}`);
    // The device the row names, where it names one — and only while it is
    // still a device of this account.
    const devices = typeof claim.endpoint === 'string'
      ? all.filter((device) => device.endpoint === claim.endpoint)
      : all;
    if (devices.length === 0) {
      failure = NO_SUBSCRIPTIONS;
      log.warn(`${name}: rest push ${scheduleId}: no device to send to (${NO_SUBSCRIPTIONS})`);
    } else {
      failure = ALL_SUBSCRIPTIONS_FAILED;
      const counts = await sendToDevices({ webpush, admin, devices, payload: claim.payload, options, name, log, now });
      delivered = counts.delivered;
      if (delivered === 0) log.error(`${name}: rest push ${scheduleId}: no device got it (${counts.failed} failed, ${counts.gone} gone)`);
    }
  } catch (error) {
    delivered = 0;
    failure = SENDER_FAILED;
    log.error(`${name}: rest push ${scheduleId}: ${messageOf(error)}`);
  }

  const sent = delivered > 0;
  const unwritten = await written(() => admin.from('scheduled_pushes').update({
    status: sent ? 'sent' : 'failed',
    sent_at: sent ? new Date(now()).toISOString() : null,
    error: sent ? null : failure,
  }).eq('id', scheduleId));
  if (unwritten) log.error(`${name}: rest push ${scheduleId}: what became of it could not be written, the row stays 'sending': ${unwritten}`);

  return { outcome: sent ? 'sent' : 'failed', delivered, error: sent ? null : failure };
}

// An event: now, to every device of the user.
async function answerEvent(body, { name, webpush, createAdmin, log, now }) {
  const options = sendOptions(body, { ttl: EVENT_TTL_SECONDS, urgency: EVENT_URGENCY }, { name, log });
  const admin = createAdmin();

  const { devices, unreadable } = await devicesOf(admin, body.user_id);
  if (unreadable) {
    log.error(`${name}: push_subscriptions could not be read: ${unreadable}`);
    return json({ error: unreadable }, 500);
  }
  if (devices.length === 0) return json({ delivered: 0 });

  const sent = await sendToDevices({ webpush, admin, devices, payload: body.payload, options, name, log, now });
  // Nobody got it, and not because every device was gone: the one answer
  // that tells the caller, and whoever counts its answers, that pushes are
  // not arriving.
  if (sent.delivered === 0 && sent.failed > 0) {
    log.error(`${name}: no device got the push (${sent.failed} failed, ${sent.gone} gone)`);
    return json({ delivered: 0, failed: sent.failed }, 502);
  }
  return json({ delivered: sent.delivered });
}

// A rest push: the answer first, the push at its time.
async function answerRestPush(body, { name, webpush, createAdmin, waitUntil, sleep, log, now }) {
  const scheduleId = body.schedule_id;
  if (typeof scheduleId !== 'string' || !UUID.test(scheduleId)) {
    return refuse(name, log, 'schedule_id is not a uuid');
  }
  const notBefore = typeof body.not_before === 'string' && ISO_TIME.test(body.not_before)
    ? Date.parse(body.not_before)
    : Number.NaN;
  if (Number.isNaN(notBefore)) {
    return refuse(name, log, 'not_before is not a time');
  }
  const wait = notBefore - now();
  if (wait > MAX_WAIT_MS) {
    return refuse(name, log, `not_before is more than ${MAX_WAIT_MS / 1000} seconds ahead`);
  }

  const options = sendOptions(body, { ttl: REST_TTL_SECONDS, urgency: REST_URGENCY }, { name, log });
  const admin = createAdmin();

  // Never rejects: nothing waits for it, and a rejection nobody handles ends
  // the worker.
  const work = (async () => {
    try {
      if (wait > 0) await sleep(wait);
      await sendRestPush({ admin, webpush, scheduleId, options, name, log, now });
    } catch (error) {
      log.error(`${name}: rest push ${scheduleId}: ${messageOf(error)}`);
    }
  })();

  // The runtime keeps the function alive for what it was handed. Without
  // one, the work is done before the answer: late for the caller, and sent.
  if (typeof waitUntil === 'function') waitUntil(work);
  else await work;

  return json({ accepted: true }, 202);
}

/**
 * Answers a request the gate has let in. See the top of the file for the two
 * kinds of request and what each is answered.
 *
 * The service-role client is made by `createAdmin`, once, and only for a
 * request that is going to be served: a body that is refused costs nothing.
 *
 * @param {Record<string, unknown>} body  the JSON object of the request
 * @param {{
 *   name: string,
 *   webpush: PushSender,
 *   createAdmin: () => AdminClient,
 *   waitUntil?: ((work: Promise<unknown>) => void) | undefined,
 *   sleep?: (ms: number) => Promise<unknown>,
 *   now?: () => number,
 *   log?: Log,
 * }} context  `name` is the function's name: it starts every refusal and
 *   every line of the log. `waitUntil` is the runtime's: what keeps the
 *   function alive after its answer. `sleep` and `now` are the clock.
 * @returns {Promise<Response>}
 */
async function answerPush(body, { name, webpush, createAdmin, waitUntil, sleep = pause, now = Date.now, log = console }) {
  if (typeof body.user_id !== 'string' || body.user_id === '' || !isRecord(body.payload)) {
    return refuse(name, log, 'missing user_id or payload');
  }
  try {
    // A request that names a row is a rest push, whatever else it says: it
    // is never sent at once to every device.
    if (body.schedule_id !== undefined) {
      return await answerRestPush(body, { name, webpush, createAdmin, waitUntil, sleep, log, now });
    }
    return await answerEvent(body, { name, webpush, createAdmin, log, now });
  } catch (error) {
    log.error(`${name}: ${messageOf(error)}`);
    return json({ error: messageOf(error) }, 500);
  }
}

export {
  ALL_SUBSCRIPTIONS_FAILED,
  EVENT_TTL_SECONDS,
  MAX_WAIT_MS,
  NO_SUBSCRIPTIONS,
  REST_TTL_SECONDS,
  SENDER_FAILED,
  SEND_DEADLINE_MS,
  SEND_TIMEOUT_MS,
  answerPush,
  failureLine,
  restSendOptions,
  sendOptions,
  sendRestPush,
  sendToDevices,
};
