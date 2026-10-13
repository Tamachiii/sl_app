// What dispatch-rest-push does: the notification at the end of a rest, sent
// by a function the app calls — where no pg_cron job sends it
// (schedule_rest_push answered mode 'edge'), and for every app from before
// wave 3, which calls this function whatever the mode.
//
// THE REQUEST OF THE APP
//
//   POST { "scheduleId": "<id of a row of scheduled_pushes>" }
//   Authorization: Bearer <the athlete's token>
//
// WHAT WAS WRONG (review P10). The version before waited inside the request
// until the rest was over. The platform does not let a function wait that
// long: on the free plan a worker of the runtime lives 150 seconds, and a
// rest of two and a half minutes or more never rang. It also sent a row it
// had merely read — with a second sender (the pg_cron job, through
// send-push) that is two notifications.
//
// IN HOPS. The function answers 202 at once and goes on working after its
// answer (the runtime's waitUntil). It waits a minute at most; if the rest
// is not over by then it calls ITSELF — a new request, which waits the next
// minute — and the last hop waits what is left and sends.
//
//   a rest of 60 s    one request: it waits 60 s and sends
//            180 s    three: 60 s, 60 s, then 60 s and the push
//            300 s    five
//            900 s    fifteen — the longest rest schedule_rest_push accepts
//
// WHY A MINUTE, when a worker lives 150 seconds. The 150 seconds are the
// worker's, not the request's: a worker takes every request that arrives
// during the first half of its life, so a request can land on one that is
// already 75 seconds old. The other half is all a request is promised. A hop
// is a wait of 60 seconds at most, and then the claim and the push (8
// seconds at most, 2 more where the clock and the timer disagree) or the
// hand-over (10): under 75 seconds, wherever it landed.
//
// A function that calls itself is something the platform counts: 30 calls a
// minute for one chain, beyond which the call throws. A rest makes one call
// a minute, two at most.
//
// THE LAST HOP SENDS THROUGH THE CLAIM, like every sender of a rest push:
// sendRestPush of ./push.js asks claim_rest_push at the time of the push and
// sends what the claim answered. A rest its athlete took back, one the other
// sender has sent, one whose time is more than a minute past: nothing is
// sent. A hop that finds the row no longer waiting stops the chain there.
//
// TWO WAYS TO BE LET IN. The gateway's check is off for this function
// (verify_jwt = false in supabase/config.toml): the request a hop makes has
// no user token to show — the athlete's can run out in the middle of a rest.
// So the function asks, itself, before it reads a byte of the body:
//
//   Authorization: Bearer <token>   the app. The token is checked with the
//                                   auth server, and the row must be that
//                                   user's.
//   x-internal-bearer: <secret>     a hop. The project's INTERNAL_BEARER,
//                                   compared in constant time. A request
//                                   that carries this header is judged on it
//                                   alone: a wrong value is a 401, whatever
//                                   else the request shows.
//
// A browser may call it — the app does: OPTIONS is answered, and every
// answer carries the CORS headers. They do not allow x-internal-bearer, so a
// page cannot send it.
//
// WHAT IT ANSWERS (nobody reads it: the app goes on whatever comes back, and
// a hop only tells a 2xx from the rest)
//
//   200 ok                          OPTIONS
//   405                             any other method than POST
//   401 <name>: unauthorized        no token, a token the auth server does
//                                   not accept, a wrong internal bearer
//   500 <name>: not configured      an internal bearer was shown and the
//                                   function has no INTERNAL_BEARER
//   503                             the auth server could not be asked
//   413 · 400                       a body over 8 kB · that is not a JSON
//                                   object, a scheduleId that is not a uuid
//   404 · 403                       no such row · a row of somebody else
//   200 <name>: already resolved    the row is no longer waiting
//   422                             its time is further ahead than the
//                                   longest rest
//   202 {"accepted":true}           the push will be sent at its time, or
//                                   handed to the next hop
//
// NO RETRY AND NO SWEEPER. A hand-over that fails is a rest that does not
// ring, and a line of the log. Where pg_cron is switched on, the database
// does the waiting and the app of wave 3 does not call this function at all.
//
// RUNTIME-NEUTRAL, like every module of this folder: web standards only, and
// what it works with — the auth server, the service-role client, the
// web-push library, the clock, the runtime's waitUntil, fetch — comes in as
// arguments. restPush.test.js runs it under Node.
//
// (The names are handed out in one list at the end of the file: see the same
// note in ./push.js.)

import { MAX_BODY_BYTES, bearerToken, checkSecret, readBody } from './auth.js';
import { sendRestPush } from './push.js';

/**
 * Where the lines go. `console` is one.
 *
 * @typedef {{
 *   info: (message: string) => void,
 *   warn: (message: string) => void,
 *   error: (message: string) => void,
 * }} Log
 */

// The longest wait of one request. See "WHY A MINUTE" at the top of the file.
const HOP_MS = 60000;

// What a hop that hands over leaves the next one to wait, at least. A new
// worker takes a moment to start; with half a minute in hand, that moment is
// never taken from the time of the push.
const LAST_HOP_MIN_MS = 30000;

// The longest rest schedule_rest_push accepts …
const MAX_REST_MS = 900000;
// … and what the clock of the database and the clock of the function may
// disagree by: a rest of exactly 15 minutes is not refused for a second.
const CLOCK_SLACK_MS = 30000;
// A row whose time is further ahead than this is not waited for.
const MAX_AHEAD_MS = MAX_REST_MS + CLOCK_SLACK_MS;

// The requests one rest can take, and one more. A chain that reaches the
// number stops: nothing here calls itself for ever.
const MAX_HOPS = Math.ceil(MAX_AHEAD_MS / HOP_MS) + 1;

// How long a hop waits for the next one to say it took over.
const HANDOVER_DEADLINE_MS = 10000;

// A timer counts its own seconds, and the time of a push is the clock's.
// When a wait ends and the clock says the time has not come, what is missing
// is waited for — once, and for no longer than this.
const TOP_UP_MAX_MS = 2000;

// The header a hop shows the secret in. Not `authorization`: that one is the
// athlete's, and the two never stand in for each other.
const INTERNAL_HEADER = 'x-internal-bearer';

// What a browser is told. The app calls this function from its page.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const ROW_COLUMNS = 'id, user_id, status, canceled_at, fire_at';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Three parts with dots between them: what a user's token looks like. A
// value of another shape is refused without asking the auth server.
const JWT_SHAPE = /^[\w-]+\.[\w-]+\.[\w-]+$/;

// How much of somebody else's answer goes into the log.
const LOGGED_ANSWER_CHARS = 120;

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const messageOf = (error) => {
  if (typeof error?.message === 'string' && error.message !== '') return error.message;
  return String(error);
};

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const seconds = (ms) => Math.round(ms / 1000);

// An answer in plain text that starts with the name of the function: whoever
// reads it can tell the function's own answer from the gateway's
// (docs/runbook/30-edge-functions.md).
const say = (name, status, text, headers = {}) => new Response(`${name}: ${text}`, {
  status,
  headers: { ...CORS_HEADERS, 'content-type': 'text/plain; charset=utf-8', ...headers },
});

/**
 * The address a function of the project is called at.
 *
 * @param {string} supabaseUrl  the project's URL, as the runtime gives it
 * @param {string} name         the function's name
 * @returns {string}
 */
function functionUrl(supabaseUrl, name) {
  return `${String(supabaseUrl).replace(/\/+$/, '')}/functions/v1/${name}`;
}

/**
 * What one request does with the time that is left before the push.
 *
 *   { final: true,  waitMs }   wait, then send — `waitMs` is all that is left
 *   { final: false, waitMs }   wait, then hand over to the next request
 *
 * No wait is longer than HOP_MS. A hop that hands over leaves the next one
 * LAST_HOP_MIN_MS at least, and so waits half a minute at least itself: a
 * rest takes the fewest requests that fit, and the last of them never starts
 * with less time than a worker needs to start.
 *
 * @param {number} remainingMs  the time of the push minus now; negative when
 *   the time has come
 * @returns {{ final: boolean, waitMs: number }}
 */
function planHop(remainingMs) {
  if (typeof remainingMs !== 'number' || Number.isNaN(remainingMs)) {
    throw new RangeError('planHop: the time that is left is not a number');
  }
  const remaining = Math.max(0, remainingMs);
  if (remaining <= HOP_MS) return { final: true, waitMs: remaining };
  return { final: false, waitMs: Math.min(HOP_MS, remaining - LAST_HOP_MIN_MS) };
}

/**
 * Who is calling: the app, with the token of a signed-in user, or a hop of
 * the function itself, with the project's secret. Nothing of the body is
 * read here, and no row.
 *
 * `getUser(token)` asks the auth server and resolves to what supabase-js
 * answers, `{ data: { user }, error }`. A token the auth server refuses is a
 * 401; an auth server that could not be asked is a 503 and a line of the
 * log.
 *
 * What was presented is never logged.
 *
 * @param {Request} request
 * @param {{
 *   name: string,
 *   bearer: string | null | undefined,
 *   getUser: (token: string) => Promise<any>,
 *   log?: Log,
 * }} options  `name` is the function's name, `bearer` its INTERNAL_BEARER
 * @returns {Promise<
 *   { response: Response, caller: null }
 *   | { response: null, caller: { internal: boolean, userId: string | null } }
 * >}  `response` when the caller is refused — return it as it is
 */
async function authenticate(request, { name, bearer, getUser, log = console }) {
  const refused = (status, text, headers) => ({ response: say(name, status, text, headers), caller: null });

  // A hop. The header decides the mode, not its value: a request that shows
  // one is never looked at as a user's.
  const presented = request.headers.get(INTERNAL_HEADER);
  if (presented !== null) {
    const verdict = checkSecret(presented, bearer);
    if (verdict === 'ok') return { response: null, caller: { internal: true, userId: null } };
    if (verdict === 'unset') {
      log.error(`${name}: INTERNAL_BEARER is not set: no hop is let in, and a rest longer than a minute does not ring`);
      return refused(500, 'not configured');
    }
    log.warn(`${name}: refused, ${verdict === 'missing' ? 'empty' : 'wrong'} internal bearer`);
    return refused(401, 'unauthorized');
  }

  // The app.
  const token = bearerToken(request.headers.get('authorization'));
  if (token === null) {
    log.warn(`${name}: refused, no credentials`);
    return refused(401, 'unauthorized', { 'www-authenticate': 'Bearer' });
  }
  if (!JWT_SHAPE.test(token)) {
    log.warn(`${name}: refused, not a user token`);
    return refused(401, 'unauthorized', { 'www-authenticate': 'Bearer' });
  }

  let answer;
  try {
    answer = await getUser(token);
  } catch (error) {
    answer = { data: null, error };
  }
  const userId = answer?.data?.user?.id;
  if (!answer?.error && typeof userId === 'string' && userId !== '') {
    return { response: null, caller: { internal: false, userId } };
  }
  // The auth server said no (a 4xx: the token is forged, expired, signed
  // out), or it did not answer at all.
  const status = answer?.error?.status;
  if (answer?.error && !(Number.isInteger(status) && status >= 400 && status < 500)) {
    log.error(`${name}: the token could not be checked, the auth server did not answer: ${messageOf(answer.error)}`);
    return refused(503, 'the token could not be checked');
  }
  log.warn(`${name}: refused, the token was not accepted`);
  return refused(401, 'unauthorized', { 'www-authenticate': 'Bearer' });
}

// The row, as far as a hop needs it: `{ row }` — null when there is none —
// or `{ unreadable }` with what the database said.
async function readRow(admin, scheduleId) {
  try {
    const { data, error } = await admin.from('scheduled_pushes').select(ROW_COLUMNS).eq('id', scheduleId);
    if (error) return { row: null, unreadable: messageOf(error) };
    const row = Array.isArray(data) ? data[0] : data;
    return { row: isRecord(row) ? row : null, unreadable: null };
  } catch (error) {
    return { row: null, unreadable: messageOf(error) };
  }
}

// Still to be sent. The app from before wave 3 takes a rest back by writing
// canceled_at on a row it leaves 'pending': both are read.
const isWaiting = (row) => row.status === 'pending' && !row.canceled_at;

// Calls the function itself for the next hop: null when it took over, or why
// it did not. One attempt. The secret goes to the function's own address and
// nowhere that address points to.
async function handOver({ fetch, selfUrl, bearer, scheduleId, hop }) {
  if (typeof bearer !== 'string' || bearer === '') return 'INTERNAL_BEARER is not set';
  try {
    const response = await fetch(selfUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [INTERNAL_HEADER]: bearer },
      body: JSON.stringify({ scheduleId, hop }),
      redirect: 'manual',
      signal: AbortSignal.timeout(HANDOVER_DEADLINE_MS),
    });
    const said = (await response.text()).replace(/\s+/g, ' ').trim().slice(0, LOGGED_ANSWER_CHARS);
    return response.ok ? null : `HTTP ${response.status} ${said}`.trim();
  } catch (error) {
    return messageOf(error);
  }
}

// What a request does after its answer: wait, then send or hand over.
async function runHop({ admin, webpush, scheduleId, hop, plan, fireAt, name, bearer, selfUrl, fetch, sleep, now, log }) {
  if (plan.waitMs > 0) await sleep(plan.waitMs);

  if (plan.final) {
    // The claim is asked at the time of the push, not before it: it does not
    // refuse a row that is early.
    const early = fireAt - now();
    if (early > 0) await sleep(Math.min(early, TOP_UP_MAX_MS));

    const { outcome, delivered } = await sendRestPush({ admin, webpush, scheduleId, name, log, now });
    if (outcome === 'sent') {
      log.info(`${name}: rest push ${scheduleId}: sent to ${delivered} device${delivered === 1 ? '' : 's'}`);
    }
    return;
  }

  // A minute has passed: the athlete may have started the next set, the
  // other sender may have sent it. Then the chain ends here, without a
  // request more.
  const { row, unreadable } = await readRow(admin, scheduleId);
  if (unreadable) {
    // The next hop reads the row before it takes over: let it judge.
    log.warn(`${name}: rest push ${scheduleId}: the row could not be read after hop ${hop}, handed over all the same: ${unreadable}`);
  } else if (!row || !isWaiting(row)) {
    log.info(`${name}: rest push ${scheduleId}: no longer waiting after hop ${hop} — taken back, or sent by the other sender. Not handed over`);
    return;
  }

  if (hop >= MAX_HOPS) {
    log.error(`${name}: rest push ${scheduleId}: hop ${hop} is the last one a rest may take and its time has not come — not handed over, the rest does not ring`);
    return;
  }
  const failure = await handOver({ fetch, selfUrl, bearer, scheduleId, hop: hop + 1 });
  if (failure) {
    log.error(`${name}: rest push ${scheduleId}: hop ${hop + 1} did not take over, the rest does not ring: ${failure}`);
  }
}

/**
 * Answers a request to dispatch-rest-push. See the top of the file for who
 * may call, what is answered, and what happens after the answer.
 *
 * The caller is judged first. For one that is refused nothing else runs: no
 * byte of the body is read and no client is made.
 *
 * @param {Request} request
 * @param {{
 *   name: string,
 *   bearer: string | null | undefined,
 *   selfUrl: string,
 *   getUser: (token: string) => Promise<any>,
 *   createAdmin: () => any,
 *   webpush: any,
 *   waitUntil?: ((work: Promise<unknown>) => void) | undefined,
 *   sleep?: (ms: number) => Promise<unknown>,
 *   now?: () => number,
 *   log?: Log,
 *   fetch?: (url: string, init: any) => Promise<Response>,
 * }} context  `name` is the function's name: it starts every answer in plain
 *   text and every line of the log. `bearer` is the project's
 *   INTERNAL_BEARER, `selfUrl` the address of this function (functionUrl).
 *   `getUser` asks the auth server about a token, `createAdmin` makes the
 *   service-role client — once, and only for a caller that was let in.
 *   `webpush` is the web-push library. `waitUntil` is the runtime's: what
 *   keeps the function alive after its answer. `sleep` and `now` are the
 *   clock, `fetch` is how the next hop is called.
 * @returns {Promise<Response>}
 */
async function dispatchRestPush(request, {
  name,
  bearer,
  selfUrl,
  getUser,
  createAdmin,
  webpush,
  waitUntil,
  sleep = pause,
  now = Date.now,
  log = console,
  fetch = globalThis.fetch,
}) {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (request.method !== 'POST') return say(name, 405, 'method not allowed', { allow: 'POST, OPTIONS' });

  const { response: refusal, caller } = await authenticate(request, { name, bearer, getUser, log });
  if (refusal) return refusal;

  const bytes = await readBody(request, MAX_BODY_BYTES);
  if (bytes === null) {
    log.warn(`${name}: refused, body over ${MAX_BODY_BYTES} bytes`);
    return say(name, 413, 'payload too large');
  }
  let body;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    body = null;
  }
  if (!isRecord(body)) {
    log.warn(`${name}: refused, body is not a JSON object`);
    return say(name, 400, 'bad request');
  }
  const scheduleId = body.scheduleId;
  if (typeof scheduleId !== 'string' || !UUID.test(scheduleId)) {
    log.warn(`${name}: refused, scheduleId is not a uuid`);
    return say(name, 400, 'scheduleId is not a uuid');
  }
  // Which request of the chain this is. The app's is the first, whatever its
  // body says; a hop says its own number.
  let hop = 1;
  if (caller.internal) {
    hop = body.hop;
    if (!Number.isInteger(hop) || hop < 2 || hop > MAX_HOPS) {
      log.warn(`${name}: refused, hop is not a number from 2 to ${MAX_HOPS}`);
      return say(name, 400, `hop is not a number from 2 to ${MAX_HOPS}`);
    }
  }

  try {
    const admin = createAdmin();
    const { row, unreadable } = await readRow(admin, scheduleId);
    if (unreadable) {
      log.error(`${name}: rest push ${scheduleId}: the row could not be read: ${unreadable}`);
      return say(name, 500, 'the row could not be read');
    }
    if (!row) return say(name, 404, 'no such rest push');
    // The client that read the row holds every row: whose row this is, is
    // asked here. A hop has no user — its first request was asked.
    if (!caller.internal && row.user_id !== caller.userId) {
      log.warn(`${name}: refused, rest push ${scheduleId} is not the caller's`);
      return say(name, 403, 'forbidden');
    }
    if (!isWaiting(row)) return say(name, 200, 'already resolved');

    const fireAt = typeof row.fire_at === 'string' ? Date.parse(row.fire_at) : Number.NaN;
    if (Number.isNaN(fireAt)) {
      log.error(`${name}: rest push ${scheduleId}: the row has no time that can be read`);
      return say(name, 500, 'the row has no time');
    }
    const remaining = fireAt - now();
    if (remaining > MAX_AHEAD_MS) {
      // Nothing is written: the row is closed by whoever asks the claim, by
      // the next rest of its athlete, or by the retention.
      log.warn(`${name}: refused, rest push ${scheduleId} is ${seconds(remaining)} seconds ahead, more than the ${seconds(MAX_REST_MS)} of the longest rest`);
      return say(name, 422, `more than ${seconds(MAX_REST_MS)} seconds ahead`);
    }

    const plan = planHop(remaining);
    log.info(plan.final
      ? `${name}: rest push ${scheduleId}: hop ${hop}, sends in ${seconds(plan.waitMs)} s`
      : `${name}: rest push ${scheduleId}: hop ${hop}, hands over in ${seconds(plan.waitMs)} s (${seconds(remaining)} s before its time)`);

    // Never rejects: nothing waits for it, and a rejection nobody handles
    // ends the worker.
    const work = (async () => {
      try {
        await runHop({ admin, webpush, scheduleId, hop, plan, fireAt, name, bearer, selfUrl, fetch, sleep, now, log });
      } catch (error) {
        log.error(`${name}: rest push ${scheduleId}: ${messageOf(error)}`);
      }
    })();

    // The runtime keeps the function alive for what it was handed. Without
    // one, the work is done before the answer: late for the caller, and done.
    if (typeof waitUntil === 'function') waitUntil(work);
    else await work;

    return new Response(JSON.stringify({ accepted: true }), {
      status: 202,
      headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
    });
  } catch (error) {
    log.error(`${name}: rest push ${scheduleId}: ${messageOf(error)}`);
    return say(name, 500, 'failed');
  }
}

export {
  CLOCK_SLACK_MS,
  CORS_HEADERS,
  HANDOVER_DEADLINE_MS,
  HOP_MS,
  INTERNAL_HEADER,
  LAST_HOP_MIN_MS,
  MAX_AHEAD_MS,
  MAX_HOPS,
  MAX_REST_MS,
  TOP_UP_MAX_MS,
  authenticate,
  dispatchRestPush,
  functionUrl,
  planHop,
};
