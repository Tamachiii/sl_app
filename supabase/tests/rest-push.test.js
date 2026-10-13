// The end of a rest is scheduled by the database, and a rest push is sent
// once — review findings P10 and B14, and the database's half of B35 and B38;
// migration 2026_10_13_16_rest_push_scheduling.
//
// THE HOLES
//   P10  The app writes a row of scheduled_pushes and calls the
//        dispatch-rest-push Edge Function, which waits inside that request
//        until the time has come. The platform ends a request after 150
//        seconds: a rest that long never rings.
//   B14  Nothing deletes a row, and a row whose function died stays
//        'pending' for ever.
//   B35  The time of the row is written by the app, from the clock of the
//        phone.
//   B38  A row does not say which device asked: every device rings.
//
// THE RULES, each held below:
//   schedule_rest_push(p_seconds, p_payload, p_endpoint)
//                     one request of the account that rests: the time is the
//                     server's, what the caller had waiting is closed, the
//                     caller's rows older than 7 days are deleted, and the
//                     answer says who sends — { id, fire_at, mode }, 'cron'
//                     while an active pg_cron job named sl-rest-push exists
//   cancel_rest_push(p_id)
//                     closes a row of the caller that is still waiting
//   claim_rest_push(p_id)
//                     THE ONE WAY A ROW GETS SENT: pending to sending, once.
//                     Never a row that was canceled — either way of
//                     canceling — never one more than a minute late. For the
//                     service role.
//   dispatch_due_rest_pushes()
//                     what the job runs: closes the late rows, hands each row
//                     due within ten seconds to send-push — once — and leaves
//                     it 'pending' for whoever claims it at its time. Nothing
//                     calls it until there is a job.
//   an account names a device of its own only, through the functions and
//   through the two policies the app from before wave 3 writes with.
//
// The first blocks run against schema.sql, next to the requests of the app
// and of the Edge Function that are DEPLOYED today (src/hooks/
// useRestTimerPush.js, supabase/functions/dispatch-rest-push/index.ts): the
// migration is applied while both are live. Two requests that cross need two
// connections, and those tests COMMIT — on the rows of one account, Rae,
// which they delete again. The last block applies the migration file itself
// to the frozen production baseline, with the checks and the statements of
// its runbook page read off the page.
//
// SHIM LIMITS: pg_net is a stub that records a request and never sends it,
// and pg_cron is not there at all — the tests that need its table make one.

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  asAdmin, asAnon, asService, asUser, attempt, createUser, enablePush, httpCalls, repoRoot,
  scenario, scratchDatabase, seed,
} from './harness.js';
import { catalogSnapshot, diffCatalogs } from './catalog.js';
import { LEDGER, loadManifest, REFUSAL } from '../migrations/manifest.js';

const MIGRATION = '2026_10_13_16_rest_push_scheduling';
const manifest = loadManifest();
const migration = manifest.migrations.find((m) => m.name === MIGRATION);
const read = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8');

// seed(): coach Carla with athletes Alex (A) and Billie (B). Next to them:
//   una   an account that never switched notifications on
//   rae   an athlete for the requests that cross: those tests commit
// Alex has two devices, a phone and a laptop; Billie, the coach and Rae one.
const PHONE = 'https://fcm.googleapis.com/fcm/send/alex-s-phone';
const LAPTOP = 'https://updates.push.services.mozilla.com/wpush/v2/alex-s-laptop';
const PHONE_OF_BILLIE = 'https://web.push.apple.com/billie-s-phone';
const PHONE_OF_THE_COACH = 'https://fcm.googleapis.com/fcm/send/the-coach-s-phone';
const PHONE_OF_RAE = 'https://fcm.googleapis.com/fcm/send/rae-s-phone';
const NOBODY_S_PHONE = 'https://fcm.googleapis.com/fcm/send/a-device-nobody-registered';

let ids;
let una;
let rae;

beforeAll(async () => {
  ids = await seed();
  una = await createUser({ email: 'una@sl.test', fullName: 'Una Unregistered' });
  rae = await createUser({ email: 'rae@sl.test', fullName: 'Rae Racer', coach: ids.coach });
  await asAdmin(async (q) => {
    for (const [user, endpoint] of [
      [ids.studentA, PHONE], [ids.studentA, LAPTOP], [ids.studentB, PHONE_OF_BILLIE],
      [ids.coach, PHONE_OF_THE_COACH], [rae, PHONE_OF_RAE],
    ]) {
      await q(`insert into push_subscriptions (user_id, endpoint, p256dh, auth) values ($1, $2, 'key', 'secret')`, [user.id, endpoint]);
    }
  }, { commit: true });
});

// ------------------------------------------------------------
// The four functions, and what they say
// ------------------------------------------------------------
const PAYLOAD = { title: 'Rest done', body: 'Time for your next set.', tag: 'rest-timer', data: { url: '/sl_app/#/student/session/abc' } };
// An object is sent as JSON; a string is sent as it is (`'null'`, `'[1]'`);
// null is SQL NULL.
const json = (value) => (value === null || typeof value === 'string' ? value : JSON.stringify(value));
const schedule = (c, seconds, payload = PAYLOAD, endpoint = undefined) => (endpoint === undefined
  ? c.value(`select public.schedule_rest_push($1, $2)`, [seconds, json(payload)])
  : c.value(`select public.schedule_rest_push($1, $2, $3)`, [seconds, json(payload), endpoint]));
const cancel = (c, id) => c.value(`select public.cancel_rest_push($1)`, [id]);
const claim = (c, id) => c.value(`select public.claim_rest_push($1)`, [id]);
const dispatch = (c) => c.value(`select public.dispatch_due_rest_pushes()`);

const alex = (fn, options) => asUser(ids.studentA, fn, options);
const billie = (fn, options) => asUser(ids.studentB, fn, options);
const noUser = (fn) => asUser(ids.studentA, fn, { claims: { sub: null } });

const P0001 = 'P0001';
const DENIED = '42501';
const NOT_AUTHORIZED = ['not authorized', DENIED];
const RLS = /row-level security policy for table "scheduled_pushes"/;
const denied = (name) => [`permission denied for function ${name}`, DENIED];

/** `[message, SQLSTATE]` of what `fn` raised — or `'it went through'`. */
const refusal = async (fn) => {
  const tried = await attempt(fn);
  return tried.ok ? 'it went through' : [tried.error.message, tried.error.code];
};

// ------------------------------------------------------------
// What is in the table
// ------------------------------------------------------------
/**
 * A row put there by the owner, due `at` seconds from now (negative: past).
 * `more`: status, takenBack (canceled_at is set), endpoint, handedOver
 * (dispatched_at is set), daysOld (created that long ago), payload.
 */
const plant = (q, user, at, more = {}) => q.value(
  `insert into scheduled_pushes (user_id, fire_at, payload, status, canceled_at, endpoint, dispatched_at, created_at)
   values ($1, now() + make_interval(secs => $2), $3, $4, case when $5 then now() end, $6,
           case when $7 then now() end, now() - make_interval(days => $8))
   returning id`,
  [user.id, at, json(more.payload ?? PAYLOAD), more.status ?? 'pending', more.takenBack ?? false, more.endpoint ?? null,
    more.handedOver ?? false, more.daysOld ?? 0],
);
/** What a row says: `'pending'`, `'canceled taken-back'`, `'pending handed-over'`, … — `'gone'` when it is not there. */
const stateOf = async (q, id) => {
  const row = await q.one(
    `select status, canceled_at is not null as taken_back, dispatched_at is not null as handed_over from scheduled_pushes where id = $1`, [id],
  );
  if (!row) return 'gone';
  return [row.status, row.taken_back ? 'taken-back' : null, row.handed_over ? 'handed-over' : null].filter(Boolean).join(' ');
};
const statesOf = async (q, list) => {
  const out = [];
  for (const id of list) out.push(await stateOf(q, id));
  return out;
};
const countOf = (q, user) => q.value(`select count(*) from scheduled_pushes where user_id = $1`, [user.id]);

// ------------------------------------------------------------
// The app and the Edge Function that are deployed, one request per call.
// ------------------------------------------------------------
const app = {
  // hooks/useRestTimerPush.js, scheduleRestPush — `.insert({ user_id, fire_at,
  // payload }).select('id')`: the time is the phone's.
  schedule: (c, user, at, payload = PAYLOAD) => c.value(
    `insert into scheduled_pushes (user_id, fire_at, payload) values ($1, now() + make_interval(secs => $2), $3) returning id`,
    [user.id, at, json(payload)],
  ),
  // hooks/useRestTimerPush.js, cancelRestPush — canceled_at, and the status is left alone.
  cancel: (c, id) => c(`update scheduled_pushes set canceled_at = now() where id = $1 and status = 'pending'`, [id]),
};
// supabase/functions/dispatch-rest-push/index.ts as deployed, with the service-role key.
const deployedFunction = {
  load: (s, id) => s.one(`select * from scheduled_pushes where id = $1`, [id]),
  recheck: (s, id) => s.one(`select status, canceled_at from scheduled_pushes where id = $1`, [id]),
  markCanceled: (s, id) => s(`update scheduled_pushes set status = 'canceled' where id = $1 and status = 'pending'`, [id]),
  markSent: (s, id) => s(`update scheduled_pushes set status = 'sent', sent_at = now(), error = null where id = $1`, [id]),
  markFailed: (s, id, error) => s(`update scheduled_pushes set status = 'failed', error = $2 where id = $1`, [id, error]),
};

// pg_cron's table of jobs, as far as schedule_rest_push reads it.
const makeCron = async (q) => {
  await q(`create schema cron`);
  await q(`create table cron.job (jobid bigserial primary key, schedule text not null, command text not null,
                                  username text not null default current_user, active boolean not null default true, jobname text)`);
};
const job = (q, name, active = true) => q(
  `insert into cron.job (schedule, command, active, jobname) values ('10 seconds', 'select public.dispatch_due_rest_pushes()', $2, $1)`,
  [name, active],
);

// ------------------------------------------------------------
// Two requests that cross: one is held open, uncommitted, while the other
// arrives — and is shown to WAIT for it.
// ------------------------------------------------------------
const lockWaits = () => asAdmin((q) => q.value(
  `select count(*) from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
));
const untilItWaits = async (what) => {
  for (let tries = 0; await lockWaits() === 0; tries += 1) {
    if (tries === 500) throw new Error(`${what} never waited`);
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
};
const committed = (who, fn) => asUser(who, fn, { commit: true });
const service = (fn) => asService(fn, { commit: true });
const owner = (fn) => asAdmin(fn, { commit: true });
async function cross({ first, second, what }) {
  let letGo;
  const untilLetGo = new Promise((resolve) => { letGo = resolve; });
  let isHeld;
  const held = new Promise((resolve) => { isHeld = resolve; });
  const holder = first(async () => { isHeld(); await untilLetGo; });
  let waiter;
  try {
    await Promise.race([held, holder]);
    let answered = false;
    waiter = second().finally(() => { answered = true; });
    waiter.catch(() => {});
    await untilItWaits(what);
    expect(answered, `${what} had answered before the first request was committed: nothing crossed`).toBe(false);
    letGo();
    await holder;
    return await attempt(() => waiter);
  } finally {
    letGo();
    await Promise.allSettled([holder, waiter]);
  }
}

// The other way round: `during` runs while the first request is held open,
// uncommitted, and must NOT wait for it. Resolves to what `during` answered,
// or to 'it waited'.
async function whileHeld({ first, during }) {
  let letGo;
  const untilLetGo = new Promise((resolve) => { letGo = resolve; });
  let isHeld;
  const held = new Promise((resolve) => { isHeld = resolve; });
  const holder = first(async () => { isHeld(); await untilLetGo; });
  let timer;
  try {
    await Promise.race([held, holder]);
    return await Promise.race([
      during(),
      new Promise((resolve) => { timer = setTimeout(() => resolve('it waited'), 5000); }),
    ]);
  } finally {
    clearTimeout(timer);
    letGo();
    await holder;
  }
}

// ============================================================
// PERMANENT — the table, against schema.sql
// ============================================================
describe('scheduled_pushes: what a row can say', () => {
  it('its status is one of six', () => scenario(async (q) => {
    for (const status of ['pending', 'sending', 'sent', 'canceled', 'failed', 'expired']) {
      expect(await stateOf(q, await plant(q, ids.studentA, 60, { status })), status).toBe(status);
    }
    for (const status of ['dispatched', 'cancelled', 'PENDING', '']) {
      const tried = await attempt(() => plant(q, ids.studentA, 60, { status }));
      expect(tried.error?.constraint, JSON.stringify(status)).toBe('scheduled_pushes_status_check');
      expect(tried.error.code).toBe('23514');
    }
  }));

  it('a row written without them names no device and was handed to nobody', () => scenario(async (q) => {
    const id = await q.value(`insert into scheduled_pushes (user_id, fire_at) values ($1, now()) returning id`, [ids.studentA.id]);
    expect(await q.one(`select status, endpoint, dispatched_at, canceled_at, sent_at, error, payload from scheduled_pushes where id = $1`, [id]))
      .toEqual({ status: 'pending', endpoint: null, dispatched_at: null, canceled_at: null, sent_at: null, error: null, payload: {} });
  }));
});

// ============================================================
// PERMANENT — schedule_rest_push (P10, B35, B38, B14)
// ============================================================
describe('schedule_rest_push: the end of a rest, in one request', () => {
  it('the row is the caller\'s, due at the time of the server plus the seconds asked for, for the device that asked', () => scenario(async (q) => {
    const due = await q.value(`select to_jsonb(now() + interval '90 seconds') #>> '{}'`);
    const answer = await alex((c) => schedule(c, 90, PAYLOAD, PHONE));
    expect(answer).toEqual({ id: expect.any(String), fire_at: due, mode: 'edge' });
    expect(await q.one(
      `select user_id, payload, status, endpoint, canceled_at, sent_at, error, dispatched_at,
              fire_at = now() + interval '90 seconds' as on_time, created_at = now() as made_now
         from scheduled_pushes where id = $1`, [answer.id],
    )).toEqual({
      user_id: ids.studentA.id, payload: PAYLOAD, status: 'pending', endpoint: PHONE,
      canceled_at: null, sent_at: null, error: null, dispatched_at: null, on_time: true, made_now: true,
    });
    expect(await countOf(q, ids.studentA)).toBe(1);
    // …and its athlete reads it back, as before.
    expect(await alex((c) => c.value(`select status from scheduled_pushes where id = $1`, [answer.id]))).toBe('pending');
    expect(await billie((c) => c.value(`select count(*) from scheduled_pushes`))).toBe(0);
  }));

  it('from one second to fifteen minutes, on any device of the account — or on all of them when none is named', () => scenario(async (q) => {
    const one = await alex((c) => schedule(c, 1, PAYLOAD, LAPTOP));
    expect(await q.one(`select endpoint, fire_at = now() + interval '1 second' as on_time from scheduled_pushes where id = $1`, [one.id]))
      .toEqual({ endpoint: LAPTOP, on_time: true });
    const longest = await alex((c) => schedule(c, 900, PAYLOAD, PHONE));
    expect(await q.value(`select fire_at = now() + interval '15 minutes' from scheduled_pushes where id = $1`, [longest.id])).toBe(true);
    // Left out, and NULL: every device, which is what a row of the app from before wave 3 means.
    const leftOut = await alex((c) => schedule(c, 60));
    const asNull = await alex((c) => schedule(c, 60, PAYLOAD, null));
    expect(await q.rows(`select endpoint from scheduled_pushes where id in ($1, $2)`, [leftOut.id, asNull.id]))
      .toEqual([{ endpoint: null }, { endpoint: null }]);
    // Every signed-in account rests: the coach too.
    const theCoach = await asUser(ids.coach, (c) => schedule(c, 60, PAYLOAD, PHONE_OF_THE_COACH));
    expect(await stateOf(q, theCoach.id)).toBe('pending');
  }));

  it('one rest at a time: what the caller still had waiting is closed — canceled, or expired when nobody had sent it a minute after its time', () => scenario(async (q) => {
    const A = ids.studentA;
    const mine = {
      running: await plant(q, A, 45, { endpoint: PHONE }),
      justPast: await plant(q, A, -59),
      lost: await plant(q, A, -61),
      lostLongAgo: await plant(q, A, -86400 * 3),
      takenBackTheOldWay: await plant(q, A, 45, { takenBack: true }),
      takenBackAndLate: await plant(q, A, -600, { takenBack: true }),
      handedOver: await plant(q, A, 5, { handedOver: true }),
      sending: await plant(q, A, -2, { status: 'sending' }),
      sent: await plant(q, A, -300, { status: 'sent' }),
      failed: await plant(q, A, -300, { status: 'failed' }),
      canceled: await plant(q, A, -300, { status: 'canceled', takenBack: true }),
      expired: await plant(q, A, -300, { status: 'expired' }),
    };
    const theirs = [await plant(q, ids.studentB, 45), await plant(q, ids.studentB, -600)];

    const next = await alex((c) => schedule(c, 120, PAYLOAD, PHONE));

    expect(Object.fromEntries(await Promise.all(Object.entries(mine).map(async ([name, id]) => [name, await stateOf(q, id)])))).toEqual({
      running: 'canceled taken-back',
      justPast: 'canceled taken-back',
      lost: 'expired',
      lostLongAgo: 'expired',
      takenBackTheOldWay: 'canceled taken-back',
      takenBackAndLate: 'canceled taken-back',
      handedOver: 'canceled taken-back handed-over',
      // A sender has it: not the caller's to close any more.
      sending: 'sending',
      sent: 'sent',
      failed: 'failed',
      canceled: 'canceled taken-back',
      expired: 'expired',
    });
    expect(await stateOf(q, next.id)).toBe('pending');
    expect(await q.value(`select count(*) from scheduled_pushes where user_id = $1 and status = 'pending'`, [A.id])).toBe(1);
    // A row that was closed late keeps the moment its athlete had asked; one closed now is stamped now.
    expect(await q.rows(
      `select canceled_at = now() as now from scheduled_pushes where id = any($1) order by array_position($1, id)`,
      [[mine.running, mine.justPast, mine.handedOver]],
    )).toEqual([{ now: true }, { now: true }, { now: true }]);
    // Nobody else's.
    expect(await statesOf(q, theirs)).toEqual(['pending', 'pending']);
  }));

  it('the caller\'s rows older than 7 days are deleted, whatever became of them — and nobody else\'s (B14)', () => scenario(async (q) => {
    const A = ids.studentA;
    const old = [
      await plant(q, A, -86400 * 8, { status: 'sent', daysOld: 8 }),
      await plant(q, A, -86400 * 30, { status: 'canceled', daysOld: 30 }),
      await plant(q, A, -86400 * 30, { status: 'failed', daysOld: 30 }),
      await plant(q, A, -86400 * 30, { status: 'expired', daysOld: 30 }),
      await plant(q, A, -86400 * 30, { status: 'sending', daysOld: 30 }),
      await plant(q, A, -86400 * 30, { daysOld: 30 }),
    ];
    const recent = [
      await plant(q, A, -86400 * 6, { status: 'sent', daysOld: 6 }),
      await plant(q, A, -3600, { status: 'failed' }),
    ];
    const theirs = await plant(q, ids.studentB, -86400 * 30, { status: 'sent', daysOld: 30 });

    await alex((c) => schedule(c, 60, PAYLOAD, PHONE));

    expect(await statesOf(q, old)).toEqual(['gone', 'gone', 'gone', 'gone', 'gone', 'gone']);
    expect(await statesOf(q, recent)).toEqual(['sent', 'failed']);
    expect(await stateOf(q, theirs)).toBe('sent');
    expect(await countOf(q, A)).toBe(3);
  }));

  it('refuses a rest that is not 1 to 900 seconds, a payload that is not a small JSON object, and a device that is not the caller\'s — and writes nothing', () => scenario(async (q) => {
    const waiting = await plant(q, ids.studentA, 45);
    const SECONDS = ['rest_seconds_out_of_range', P0001];
    const INVALID = ['payload_invalid', P0001];
    const NO_DEVICE = ['device_not_registered', P0001];
    for (const seconds of [null, 0, -30, 901, 86400]) {
      expect(await refusal(() => alex((c) => schedule(c, seconds, PAYLOAD, PHONE))), `${seconds} seconds`).toEqual(SECONDS);
    }
    for (const payload of [null, 'null', '"Rest done"', '[{"title": "Rest done"}]', '42', { title: 'x'.repeat(2000) }]) {
      expect(await refusal(() => alex((c) => schedule(c, 60, payload, PHONE))), JSON.stringify(payload).slice(0, 40)).toEqual(INVALID);
    }
    // 2000 bytes is what it may be.
    const largest = { title: 'x'.repeat(2000 - '{"title": ""}'.length) };
    expect((await q.dryRun(`select octet_length($1::jsonb::text) as bytes`, [JSON.stringify(largest)])).rows[0].bytes).toBe(2000);

    // The device of another account, one nobody registered — and no device at all.
    for (const endpoint of [PHONE_OF_BILLIE, PHONE_OF_THE_COACH, NOBODY_S_PHONE, '', `${PHONE}/`]) {
      expect(await refusal(() => alex((c) => schedule(c, 60, PAYLOAD, endpoint))), endpoint).toEqual(NO_DEVICE);
    }
    expect(await refusal(() => asUser(una, (c) => schedule(c, 60)))).toEqual(NO_DEVICE);
    expect(await refusal(() => asUser(una, (c) => schedule(c, 60, PAYLOAD, PHONE)))).toEqual(NO_DEVICE);

    // Nothing was written, and what was waiting still is.
    expect(await stateOf(q, waiting)).toBe('pending');
    expect(await q.value(`select count(*) from scheduled_pushes`)).toBe(1);
    // …and then the largest payload goes through.
    expect((await alex((c) => schedule(c, 60, largest, PHONE))).mode).toBe('edge');
  }));

  it('for the account that is signed in: without a user id nothing is scheduled, and without a session the function is not entered', () => scenario(async (q) => {
    expect(await refusal(() => noUser((c) => schedule(c, 60, PAYLOAD, PHONE)))).toEqual(NOT_AUTHORIZED);
    expect(await refusal(() => asService((s) => schedule(s, 60, PAYLOAD, PHONE)))).toEqual(NOT_AUTHORIZED);
    expect(await refusal(() => schedule(q, 60, PAYLOAD, PHONE))).toEqual(NOT_AUTHORIZED);
    expect(await refusal(() => asAnon((c) => schedule(c, 60, PAYLOAD, PHONE)))).toEqual(denied('schedule_rest_push'));
    expect(await q.value(`select count(*) from scheduled_pushes`)).toBe(0);
  }));

  // "mode is 'cron' only when an active sl-rest-push job exists."
  it('says who sends: edge without pg_cron, without the job or with the job switched off — cron while a job named sl-rest-push is active', () => scenario(async (q) => {
    const mode = async () => (await alex((c) => schedule(c, 60, PAYLOAD, PHONE))).mode;
    // No pg_cron: the table of its jobs is not there.
    expect(await q.value(`select to_regclass('cron.job') is null`)).toBe(true);
    expect(await mode()).toBe('edge');

    await makeCron(q);
    expect(await mode()).toBe('edge');
    // Other jobs, and its name on a job that is switched off.
    await job(q, 'sl-retention');
    await job(q, 'SL-REST-PUSH');
    await job(q, null);
    await job(q, 'sl-rest-push', false);
    expect(await mode()).toBe('edge');

    await q(`update cron.job set active = true where jobname = 'sl-rest-push'`);
    expect(await mode()).toBe('cron');
    // …for every account, and it is the only thing the answer changes.
    const answer = await billie((c) => schedule(c, 30, PAYLOAD, PHONE_OF_BILLIE));
    expect(answer).toEqual({ id: expect.any(String), fire_at: expect.any(String), mode: 'cron' });
    expect(await stateOf(q, answer.id)).toBe('pending');

    await q(`update cron.job set active = false where jobname = 'sl-rest-push'`);
    expect(await mode()).toBe('edge');
    await q(`delete from cron.job`);
    expect(await mode()).toBe('edge');
  }));

  it('a table of jobs it cannot read is no job: edge, and the rest is scheduled all the same', () => scenario(async (q) => {
    await q(`create schema cron`);
    // Not pg_cron's table: no jobname, no active.
    await q(`create table cron.job (id int)`);
    const answer = await alex((c) => schedule(c, 60, PAYLOAD, PHONE));
    expect(answer.mode).toBe('edge');
    expect(await stateOf(q, answer.id)).toBe('pending');

    // pg_cron's table, with the job — in a schema the owner of the function may not look into.
    await q(`drop schema cron cascade`);
    await makeCron(q);
    await job(q, 'sl-rest-push');
    expect((await alex((c) => schedule(c, 60, PAYLOAD, PHONE))).mode).toBe('cron');
    await q(`revoke all on schema cron from postgres`);
    expect((await attempt(() => q(`select to_regclass('cron.job')`))).error?.message).toBe('permission denied for schema cron');
    const closed = await alex((c) => schedule(c, 60, PAYLOAD, PHONE));
    expect(closed.mode).toBe('edge');
    expect(await stateOf(q, closed.id)).toBe('pending');
    await q(`grant all on schema cron to postgres`);
    expect((await alex((c) => schedule(c, 60, PAYLOAD, PHONE))).mode).toBe('cron');
  }));
});

// ============================================================
// PERMANENT — cancel_rest_push
// ============================================================
describe('cancel_rest_push: a rest that ends early', () => {
  it('closes the row of the caller that is waiting — once', () => scenario(async (q) => {
    const { id } = await alex((c) => schedule(c, 90, PAYLOAD, PHONE));
    expect(await alex((c) => cancel(c, id))).toEqual({ canceled: true });
    expect(await stateOf(q, id)).toBe('canceled taken-back');
    expect(await q.value(`select canceled_at = now() from scheduled_pushes where id = $1`, [id])).toBe(true);
    expect(await alex((c) => cancel(c, id))).toEqual({ canceled: false });
    // No sender gets it.
    expect(await asService((s) => claim(s, id))).toBeNull();
  }));

  it('a row the app from before wave 3 had canceled its own way is closed too, and keeps the moment that was written', () => scenario(async (q) => {
    const id = await alex((c) => app.schedule(c, ids.studentA, 90));
    await q(`update scheduled_pushes set canceled_at = now() - interval '10 seconds' where id = $1`, [id]);
    expect(await stateOf(q, id)).toBe('pending taken-back');
    expect(await alex((c) => cancel(c, id))).toEqual({ canceled: true });
    expect(await q.one(`select status, canceled_at = now() - interval '10 seconds' as kept from scheduled_pushes where id = $1`, [id]))
      .toEqual({ status: 'canceled', kept: true });
  }));

  it('there is nothing to take back from a row that is sent or being sent, closed, somebody else\'s or not there — and that is not an error', () => scenario(async (q) => {
    const A = ids.studentA;
    const rows = {
      sending: await plant(q, A, 0, { status: 'sending' }),
      sent: await plant(q, A, -5, { status: 'sent' }),
      failed: await plant(q, A, -5, { status: 'failed' }),
      canceled: await plant(q, A, 30, { status: 'canceled', takenBack: true }),
      expired: await plant(q, A, -90, { status: 'expired' }),
    };
    const ofBillie = await plant(q, ids.studentB, 90);
    for (const [name, id] of Object.entries(rows)) {
      expect(await alex((c) => cancel(c, id)), name).toEqual({ canceled: false });
      expect((await stateOf(q, id)).split(' ')[0], name).toBe(name);
    }
    expect(await alex((c) => cancel(c, ofBillie))).toEqual({ canceled: false });
    expect(await asUser(ids.coach, (c) => cancel(c, ofBillie))).toEqual({ canceled: false });
    expect(await stateOf(q, ofBillie)).toBe('pending');
    expect(await alex((c) => cancel(c, ids.studentA.id))).toEqual({ canceled: false });
    expect(await alex((c) => cancel(c, null))).toEqual({ canceled: false });
  }));

  it('for the account that is signed in: without a user id nothing is taken back, and without a session the function is not entered', () => scenario(async (q) => {
    const id = await plant(q, ids.studentA, 90);
    expect(await refusal(() => noUser((c) => cancel(c, id)))).toEqual(NOT_AUTHORIZED);
    expect(await refusal(() => asService((s) => cancel(s, id)))).toEqual(NOT_AUTHORIZED);
    expect(await refusal(() => asAnon((c) => cancel(c, id)))).toEqual(denied('cancel_rest_push'));
    expect(await stateOf(q, id)).toBe('pending');
  }));
});

// ============================================================
// PERMANENT — claim_rest_push: one atomic claim
// ============================================================
describe('claim_rest_push: the one way a row gets sent', () => {
  it('answers the row — whose it is, what to show, for which device — once, and it is sending from then on', () => scenario(async (q) => {
    const { id, fire_at: fireAt } = await alex((c) => schedule(c, 30, PAYLOAD, LAPTOP));
    expect(await asService((s) => claim(s, id))).toEqual({
      id, user_id: ids.studentA.id, payload: PAYLOAD, endpoint: LAPTOP, fire_at: fireAt,
    });
    expect(await stateOf(q, id)).toBe('sending');
    // A second sender, and the first one asking again.
    expect(await asService((s) => claim(s, id))).toBeNull();
    expect(await claim(q, id)).toBeNull();
    expect(await stateOf(q, id)).toBe('sending');
    // Too late to take back: the row is the sender's now.
    expect(await alex((c) => cancel(c, id))).toEqual({ canceled: false });
  }));

  it('a row the app from before wave 3 inserted is answered like any other: for every device', () => scenario(async (q) => {
    const id = await alex((c) => app.schedule(c, ids.studentA, 0));
    const answered = await asService((s) => claim(s, id));
    expect(answered).toMatchObject({ id, user_id: ids.studentA.id, payload: PAYLOAD, endpoint: null });
    expect(Object.keys(answered).sort()).toEqual(['endpoint', 'fire_at', 'id', 'payload', 'user_id']);
    expect(await stateOf(q, id)).toBe('sending');
  }));

  it('a canceled row is never answered — taken back through the function, by the next rest, or the way the app from before wave 3 does it', () => scenario(async (q) => {
    const first = await alex((c) => schedule(c, 30, PAYLOAD, PHONE));
    await alex((c) => cancel(c, first.id));
    const second = await alex((c) => schedule(c, 30, PAYLOAD, PHONE));
    const third = await alex((c) => schedule(c, 30, PAYLOAD, PHONE));
    // The app that is deployed: canceled_at on a row that stays 'pending'.
    const theOldWay = await billie((c) => app.schedule(c, ids.studentB, 30));
    expect((await billie((c) => app.cancel(c, theOldWay))).rowCount).toBe(1);
    expect(await stateOf(q, theOldWay)).toBe('pending taken-back');

    for (const id of [first.id, second.id, theOldWay]) expect(await asService((s) => claim(s, id)), id).toBeNull();
    // …and the one asked for is closed, so that it does not wait for ever.
    expect(await statesOf(q, [first.id, second.id, theOldWay])).toEqual(['canceled taken-back', 'canceled taken-back', 'canceled taken-back']);
    // The rest that is running is still there to send.
    expect(await asService((s) => claim(s, third.id))).toMatchObject({ id: third.id });
  }));

  it('a row more than a minute late is never answered, and is closed as expired; one 59 seconds late still rings', () => scenario(async (q) => {
    const A = ids.studentA;
    const justInTime = await plant(q, A, -59);
    const justTooLate = await plant(q, A, -60);
    const longAgo = await plant(q, A, -86400);
    const lateAndTakenBack = await plant(q, A, -600, { takenBack: true });
    expect(await asService((s) => claim(s, justInTime))).toMatchObject({ id: justInTime });
    for (const id of [justTooLate, longAgo, lateAndTakenBack]) expect(await asService((s) => claim(s, id)), id).toBeNull();
    expect(await statesOf(q, [justInTime, justTooLate, longAgo, lateAndTakenBack]))
      .toEqual(['sending', 'expired', 'expired', 'canceled taken-back']);
    // Asked again, a closed row stays what it is.
    expect(await asService((s) => claim(s, longAgo))).toBeNull();
    expect(await stateOf(q, longAgo)).toBe('expired');
  }));

  it('only a row that is waiting: not one that is sending, sent, failed, canceled or expired — and no row is no answer', () => scenario(async (q) => {
    for (const status of ['sending', 'sent', 'failed', 'canceled', 'expired']) {
      const id = await plant(q, ids.studentA, 0, { status });
      expect(await asService((s) => claim(s, id)), status).toBeNull();
      expect(await stateOf(q, id), status).toBe(status);
    }
    expect(await asService((s) => claim(s, ids.studentA.id))).toBeNull();
    expect(await asService((s) => claim(s, null))).toBeNull();
  }));

  it('is for whoever sends — the service role: a signed-in user and a request without a session are refused before it is entered', () => scenario(async (q) => {
    const id = await plant(q, ids.studentA, 0);
    for (const [who, as] of [['its athlete', alex], ['another athlete', billie], ['the coach', (fn) => asUser(ids.coach, fn)], ['nobody', asAnon]]) {
      expect(await refusal(() => as((c) => claim(c, id))), who).toEqual(denied('claim_rest_push'));
    }
    expect(await stateOf(q, id)).toBe('pending');
  }));

  it('has no right of its own: handed to a signed-in user by mistake, it reaches their own rows and no others', () => scenario(async (q) => {
    expect(await q.one(
      `select p.prosecdef as runs_as_owner, p.proconfig as settings, format_type(p.prorettype, null) as answers,
              (select array_agg(g.name order by g.name collate "C")
                 from (select pg_get_userbyid(a.grantee)::text as name
                         from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a) g) as grantees
         from pg_proc p where p.oid = 'public.claim_rest_push(uuid)'::regprocedure`,
    )).toEqual({ runs_as_owner: false, settings: ['search_path=public, pg_temp'], answers: 'jsonb', grantees: ['postgres', 'service_role'] });

    const ofAlex = await plant(q, ids.studentA, 0);
    const ofBillie = await plant(q, ids.studentB, 0);
    await q(`grant execute on function public.claim_rest_push(uuid) to authenticated`);
    expect(await billie((c) => claim(c, ofAlex))).toBeNull();
    expect(await stateOf(q, ofAlex)).toBe('pending');
    // Their own: they can stop their own notification, which they could before.
    expect(await billie((c) => claim(c, ofBillie))).toMatchObject({ id: ofBillie });
  }));
});

// ============================================================
// PERMANENT — dispatch_due_rest_pushes: what the job runs
// ============================================================
describe('dispatch_due_rest_pushes: what the job runs every ten seconds', () => {
  const URL = 'https://functions.sl.test/functions/v1';
  const sorted = (rows) => [...rows].sort((a, b) => a.schedule_id.localeCompare(b.schedule_id));

  it('hands each row due within ten seconds to send-push: who, what, when, for which device, kept a minute, urgent', () => scenario(async (q) => {
    await enablePush();
    const A = ids.studentA;
    const B = ids.studentB;
    const due = {
      inFive: await plant(q, A, 5, { endpoint: PHONE }),
      inTen: await plant(q, B, 10, { endpoint: PHONE_OF_BILLIE, payload: { title: 'Billie rests' } }),
      // The app from before wave 3: no device named.
      now: await plant(q, B, 0),
      // A run that came late: still less than a minute past.
      halfAMinutePast: await plant(q, A, -30, { endpoint: LAPTOP }),
    };
    const notDue = {
      inEleven: await plant(q, A, 11, { endpoint: PHONE }),
      inTenMinutes: await plant(q, A, 600, { endpoint: PHONE }),
    };
    const notItsToHandOver = {
      takenBack: await plant(q, A, 3, { status: 'canceled', takenBack: true }),
      takenBackTheOldWay: await plant(q, A, 3, { takenBack: true }),
      handedOverBefore: await plant(q, A, 3, { handedOver: true }),
      sending: await plant(q, A, 0, { status: 'sending' }),
      sent: await plant(q, A, -5, { status: 'sent' }),
      failed: await plant(q, A, -5, { status: 'failed' }),
      expired: await plant(q, A, -120, { status: 'expired' }),
    };
    const fireAt = Object.fromEntries((await q.rows(
      `select id, to_jsonb(fire_at) #>> '{}' as fire_at from scheduled_pushes where id = any($1)`, [Object.values(due)],
    )).map((row) => [row.id, row.fire_at]));

    expect(await asService((s) => dispatch(s))).toEqual({ handed_over: 4, expired: 0 });

    const calls = await httpCalls();
    for (const call of calls) {
      expect(call).toMatchObject({
        method: 'POST',
        url: `${URL}/send-push`,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-internal-bearer' },
        timeout_milliseconds: 10000,
      });
    }
    const options = (id) => ({ schedule_id: id, not_before: fireAt[id], ttl: 60, urgency: 'high' });
    expect(sorted(calls.map((call) => call.body))).toEqual(sorted([
      { user_id: A.id, payload: PAYLOAD, endpoint: PHONE, ...options(due.inFive) },
      { user_id: B.id, payload: { title: 'Billie rests' }, endpoint: PHONE_OF_BILLIE, ...options(due.inTen) },
      // No device named: the key is left out, and send-push sends to every device.
      { user_id: B.id, payload: PAYLOAD, ...options(due.now) },
      { user_id: A.id, payload: PAYLOAD, endpoint: LAPTOP, ...options(due.halfAMinutePast) },
    ]));
    // In the order of their time.
    expect(calls.map((call) => call.body.schedule_id)).toEqual([due.halfAMinutePast, due.now, due.inFive, due.inTen]);

    // Handed over, and still waiting: the claim is taken at the time of the push, by whoever sends.
    expect(await statesOf(q, Object.values(due))).toEqual(Array(4).fill('pending handed-over'));
    expect(await q.value(`select count(*) from scheduled_pushes where id = any($1) and dispatched_at = now()`, [Object.values(due)])).toBe(4);
    expect(await statesOf(q, Object.values(notDue))).toEqual(['pending', 'pending']);
    expect(await statesOf(q, Object.values(notItsToHandOver))).toEqual([
      'canceled taken-back', 'pending taken-back', 'pending handed-over', 'sending', 'sent', 'failed', 'expired',
    ]);
  }));

  it('once: the next run hands none of them over again, whatever became of the request', () => scenario(async (q) => {
    await enablePush();
    const id = await plant(q, ids.studentA, 8, { endpoint: PHONE });
    expect(await asService((s) => dispatch(s))).toEqual({ handed_over: 1, expired: 0 });
    for (let run = 0; run < 3; run += 1) expect(await asService((s) => dispatch(s))).toEqual({ handed_over: 0, expired: 0 });
    // The owner — the job — as well.
    expect(await dispatch(q)).toEqual({ handed_over: 0, expired: 0 });
    expect((await httpCalls()).map((call) => call.body.schedule_id)).toEqual([id]);
  }));

  it('closes every row still waiting more than a minute after its time: expired, or canceled where its athlete had asked (B14)', () => scenario(async (q) => {
    await enablePush();
    const A = ids.studentA;
    const late = [
      await plant(q, A, -60),
      await plant(q, A, -86400 * 40, { daysOld: 40 }),
      await plant(q, A, -3600, { handedOver: true }),
      await plant(q, ids.studentB, -61, { takenBack: true }),
    ];
    const notLate = await plant(q, A, -59);
    expect(await asService((s) => dispatch(s))).toEqual({ handed_over: 1, expired: 4 });
    expect(await statesOf(q, late)).toEqual(['expired', 'expired', 'expired handed-over', 'canceled taken-back']);
    expect(await stateOf(q, notLate)).toBe('pending handed-over');
    // None of them was handed to anybody, and none is deleted.
    expect((await httpCalls()).map((call) => call.body.schedule_id)).toEqual([notLate]);
    expect(await q.value(`select count(*) from scheduled_pushes`)).toBe(5);
    // …and no sender gets one afterwards.
    for (const id of late) expect(await asService((s) => claim(s, id))).toBeNull();
  }));

  it('a row it handed over is still its athlete\'s to take back, and still one claim', () => scenario(async (q) => {
    await enablePush();
    const { id: early } = await alex((c) => schedule(c, 8, PAYLOAD, PHONE));
    const { id: onTime } = await billie((c) => schedule(c, 8, PAYLOAD, PHONE_OF_BILLIE));
    expect(await asService((s) => dispatch(s))).toEqual({ handed_over: 2, expired: 0 });

    // Alex starts the next set five seconds early: send-push, at the time, gets nothing.
    expect(await alex((c) => cancel(c, early))).toEqual({ canceled: true });
    expect(await asService((s) => claim(s, early))).toBeNull();
    // Billie rests to the end: send-push takes the row — and dispatch-rest-push, called by an app from before wave 3, does not.
    expect(await asService((s) => claim(s, onTime))).toMatchObject({ id: onTime, endpoint: PHONE_OF_BILLIE });
    expect(await asService((s) => claim(s, onTime))).toBeNull();
    expect(await statesOf(q, [early, onTime])).toEqual(['canceled taken-back handed-over', 'sending handed-over']);
  }));

  it('a row that cannot be handed over is a warning: its mark is undone, the others go, and the next run tries again', () => scenario(async (q) => {
    await enablePush();
    const id = await plant(q, ids.studentA, 5, { endpoint: PHONE });
    await q(`select set_config('shim.http_post_fails', 'on', true)`);
    expect(await asService((s) => dispatch(s))).toEqual({ handed_over: 0, expired: 0 });
    expect(await stateOf(q, id)).toBe('pending');
    expect(await httpCalls()).toEqual([]);

    await q(`select set_config('shim.http_post_fails', 'off', true)`);
    expect(await asService((s) => dispatch(s))).toEqual({ handed_over: 1, expired: 0 });
    expect(await stateOf(q, id)).toBe('pending handed-over');
    expect((await httpCalls()).map((call) => call.body.schedule_id)).toEqual([id]);
  }));

  it('a payload that is not an object is handed to nobody, and the row expires like any other', () => scenario(async (q) => {
    await enablePush();
    const junk = [
      await plant(q, ids.studentA, 5, { payload: '"just a title"' }),
      await plant(q, ids.studentA, 5, { payload: '[1, 2]' }),
    ];
    const fine = await plant(q, ids.studentA, 5);
    expect(await asService((s) => dispatch(s))).toEqual({ handed_over: 1, expired: 0 });
    expect(await statesOf(q, [...junk, fine])).toEqual(['pending', 'pending', 'pending handed-over']);
    await q(`update scheduled_pushes set fire_at = now() - interval '2 minutes' where id = any($1)`, [junk]);
    expect(await asService((s) => dispatch(s))).toEqual({ handed_over: 0, expired: 2 });
  }));

  it('where the vault has no secret nothing is queued, and nothing fails', () => scenario(async (q) => {
    const id = await plant(q, ids.studentA, 5, { endpoint: PHONE });
    const late = await plant(q, ids.studentA, -90);
    expect(await asService((s) => dispatch(s))).toEqual({ handed_over: 1, expired: 1 });
    expect(await httpCalls()).toEqual([]);
    expect(await statesOf(q, [id, late])).toEqual(['pending handed-over', 'expired']);
  }));

  it('is for the job and the service role: a signed-in user and a request without a session are refused before it is entered', () => scenario(async (q) => {
    await enablePush();
    const id = await plant(q, ids.studentA, 5);
    for (const [who, as] of [['an athlete', alex], ['the coach', (fn) => asUser(ids.coach, fn)], ['nobody', asAnon]]) {
      expect(await refusal(() => as((c) => dispatch(c))), who).toEqual(denied('dispatch_due_rest_pushes'));
    }
    expect(await stateOf(q, id)).toBe('pending');
    expect(await httpCalls()).toEqual([]);
  }));

  // "inert until scheduled"
  it('nothing in schema.sql calls it: no other function, no trigger', async () => {
    const callers = await asAdmin((q) => q.rows(
      `select p.proname::text as name from pg_proc p
        where p.pronamespace = 'public'::regnamespace
          and p.prosrc like '%dispatch_due_rest_pushes%' and p.proname <> 'dispatch_due_rest_pushes'`,
    ));
    expect(callers).toEqual([]);
    expect(await asAdmin((q) => q.value(
      `select count(*) from pg_trigger t where not t.tgisinternal and t.tgrelid in ('public.scheduled_pushes'::regclass, 'public.push_subscriptions'::regclass)`,
    ))).toBe(0);
  });
});

// ============================================================
// PERMANENT — the app and the Edge Function that are deployed
// ============================================================
describe('next to them, the app and the dispatch-rest-push that are deployed go on as before', () => {
  it('the app inserts its row, cancels it its own way and reads it back; the function reads, re-reads and records it', () => scenario(async (q) => {
    const A = ids.studentA;
    // A rest that runs to its end.
    const id = await alex((c) => app.schedule(c, A, 45));
    const loaded = await asService((s) => deployedFunction.load(s, id));
    expect(loaded).toMatchObject({ id, user_id: A.id, status: 'pending', canceled_at: null, payload: PAYLOAD });
    expect(await asService((s) => deployedFunction.recheck(s, id))).toEqual({ status: 'pending', canceled_at: null });
    expect((await asService((s) => deployedFunction.markSent(s, id))).rowCount).toBe(1);
    expect(await q.one(`select status, sent_at is not null as stamped from scheduled_pushes where id = $1`, [id])).toEqual({ status: 'sent', stamped: true });

    // One that is taken back while the function waits.
    const second = await alex((c) => app.schedule(c, A, 45));
    expect((await alex((c) => app.cancel(c, second))).rowCount).toBe(1);
    expect((await asService((s) => deployedFunction.recheck(s, second))).canceled_at).not.toBeNull();
    expect((await asService((s) => deployedFunction.markCanceled(s, second))).rowCount).toBe(1);
    expect(await stateOf(q, second)).toBe('canceled taken-back');

    // One nobody is subscribed for.
    const third = await alex((c) => app.schedule(c, A, 45));
    await asService((s) => deployedFunction.markFailed(s, third, 'no_subscriptions'));
    expect(await q.value(`select error from scheduled_pushes where id = $1`, [third])).toBe('no_subscriptions');

    // The athlete reads their own, and nobody else's.
    expect(await alex((c) => c.value(`select count(*) from scheduled_pushes`))).toBe(3);
    expect(await billie((c) => c.value(`select count(*) from scheduled_pushes`))).toBe(0);
    expect((await alex((c) => c(`delete from scheduled_pushes where id = $1`, [third]))).rowCount).toBe(1);
  }));

  it('a row of the app that one of the new senders took is one the deployed function no longer sends', () => scenario(async (q) => {
    const id = await alex((c) => app.schedule(c, ids.studentA, 0));
    expect(await asService((s) => claim(s, id))).toMatchObject({ id });
    // Its last look before it sends: not 'pending' any more.
    expect(await asService((s) => deployedFunction.recheck(s, id))).toEqual({ status: 'sending', canceled_at: null });
    expect((await asService((s) => deployedFunction.markCanceled(s, id))).rowCount).toBe(0);
    // …and the cancel of the app comes too late, as it would for a row that is sent.
    expect((await alex((c) => app.cancel(c, id))).rowCount).toBe(0);
    expect(await stateOf(q, id)).toBe('sending');
  }));

  // B3, for the new column: whoever sends a row reads where to from it.
  it('an account names a device of its own only: the endpoint of somebody else, or of nobody, is refused on an INSERT and on an UPDATE', () => scenario(async (q) => {
    const A = ids.studentA;
    const insert = (c, endpoint) => c.value(
      `insert into scheduled_pushes (user_id, fire_at, payload, endpoint) values ($1, now() + interval '45 seconds', '{}', $2) returning id`,
      [A.id, endpoint],
    );
    const own = await alex((c) => insert(c, LAPTOP));
    expect(await stateOf(q, own)).toBe('pending');
    for (const endpoint of [PHONE_OF_BILLIE, PHONE_OF_THE_COACH, NOBODY_S_PHONE, '']) {
      const tried = await attempt(() => alex((c) => insert(c, endpoint)));
      expect(tried.error?.message, endpoint).toMatch(RLS);
      expect(tried.error.code).toBe(DENIED);
      const moved = await attempt(() => alex((c) => c(`update scheduled_pushes set endpoint = $2 where id = $1`, [own, endpoint])));
      expect(moved.error?.message, endpoint).toMatch(RLS);
    }
    expect(await q.rows(`select endpoint from scheduled_pushes where user_id = $1`, [A.id])).toEqual([{ endpoint: LAPTOP }]);
    // To another device of their own, or to none: their row.
    await alex((c) => c(`update scheduled_pushes set endpoint = $2 where id = $1`, [own, PHONE]));
    await alex((c) => c(`update scheduled_pushes set endpoint = null, canceled_at = now() where id = $1`, [own]));
    expect(await stateOf(q, own)).toBe('pending taken-back');

    // A device that has changed hands since: the row can still be canceled through the function, not rewritten by hand.
    const { id } = await alex((c) => schedule(c, 60, PAYLOAD, PHONE));
    await q(`update push_subscriptions set user_id = $1 where endpoint = $2`, [ids.studentB.id, PHONE]);
    expect((await attempt(() => alex((c) => app.cancel(c, id)))).error?.message).toMatch(RLS);
    expect(await alex((c) => cancel(c, id))).toEqual({ canceled: true });
  }));
});

// ============================================================
// Two requests that cross
// ============================================================
describe('two requests that cross', () => {
  afterEach(() => owner((q) => q(`delete from scheduled_pushes where user_id = $1`, [rae.id])));

  // "two concurrent claims, one winner"
  it('two senders take one row in the same instant: the second waits, and gets nothing', async () => {
    const id = await owner((q) => plant(q, rae, 0, { endpoint: PHONE_OF_RAE }));
    let won;
    const second = await cross({
      what: 'the second claim',
      first: (hold) => service(async (s) => { won = await claim(s, id); await hold(); }),
      second: () => service((s) => claim(s, id)),
    });
    expect(won).toMatchObject({ id, endpoint: PHONE_OF_RAE });
    expect(second.error?.message).toBeUndefined();
    expect(second.value).toBeNull();
    expect(await asAdmin((q) => stateOf(q, id))).toBe('sending');
  });

  it('a sender that fails before it has the row leaves it to the next', async () => {
    const id = await owner((q) => plant(q, rae, 0));
    const second = await cross({
      what: 'the second claim',
      first: (hold) => attempt(() => service(async (s) => {
        await claim(s, id);
        await hold();
        throw new Error('the connection of the first sender is lost');
      })),
      second: () => service((s) => claim(s, id)),
    });
    expect(second.value).toMatchObject({ id });
    expect(await asAdmin((q) => stateOf(q, id))).toBe('sending');
  });

  it('a rest is taken back while a sender takes it: whichever comes first, the other finds nothing to do', async () => {
    // The cancel first: no push.
    const early = await owner((q) => plant(q, rae, 0));
    const claimed = await cross({
      what: 'the claim',
      first: (hold) => committed(rae, async (c) => { expect(await cancel(c, early)).toEqual({ canceled: true }); await hold(); }),
      second: () => service((s) => claim(s, early)),
    });
    expect(claimed.value).toBeNull();
    expect(await asAdmin((q) => stateOf(q, early))).toBe('canceled taken-back');

    // The sender first: the push leaves, and the cancel says so.
    const late = await owner((q) => plant(q, rae, 0));
    const canceled = await cross({
      what: 'the cancel',
      first: (hold) => service(async (s) => { expect(await claim(s, late)).toMatchObject({ id: late }); await hold(); }),
      second: () => committed(rae, (c) => cancel(c, late)),
    });
    expect(canceled.value).toEqual({ canceled: false });
    expect(await asAdmin((q) => stateOf(q, late))).toBe('sending');

    // …and the cancel of the app from before wave 3, the same.
    const theOldWay = await owner((q) => plant(q, rae, 0));
    const written = await cross({
      what: 'the UPDATE of the app',
      first: (hold) => service(async (s) => { await claim(s, theOldWay); await hold(); }),
      second: () => committed(rae, (c) => app.cancel(c, theOldWay)),
    });
    expect(written.value.rowCount).toBe(0);
    expect(await asAdmin((q) => stateOf(q, theOldWay))).toBe('sending');
  });

  it('two rests of one account scheduled in the same instant: the second waits, and closes the row of the first', async () => {
    let first;
    const second = await cross({
      what: 'the second rest',
      first: (hold) => committed(rae, async (c) => { first = await schedule(c, 60, PAYLOAD, PHONE_OF_RAE); await hold(); }),
      second: () => committed(rae, (c) => schedule(c, 120, PAYLOAD, PHONE_OF_RAE)),
    });
    expect(second.error?.message).toBeUndefined();
    expect(await asAdmin((q) => statesOf(q, [first.id, second.value.id]))).toEqual(['canceled taken-back', 'pending']);
  });

  it('…and the rest of another account does not wait for it', async () => {
    const elsewhere = await whileHeld({
      first: (hold) => committed(rae, async (c) => { await schedule(c, 60, PAYLOAD, PHONE_OF_RAE); await hold(); }),
      during: () => committed(ids.studentB, (c) => schedule(c, 60, PAYLOAD, PHONE_OF_BILLIE)),
    });
    expect(elsewhere).toMatchObject({ mode: 'edge' });
    await owner((q) => q(`delete from scheduled_pushes where id = $1`, [elsewhere.id]));
  });

  it('the job passes over a row another request holds, and does not wait for it', async () => {
    const [held, free, lateAndHeld] = await owner(async (q) => [await plant(q, rae, 5), await plant(q, rae, 5), await plant(q, rae, -300)]);
    const ran = await whileHeld({
      // The app from before wave 3 takes two rests back, and its request is slow to end.
      first: (hold) => committed(rae, async (c) => { await app.cancel(c, held); await app.cancel(c, lateAndHeld); await hold(); }),
      during: () => service((s) => dispatch(s)),
    });
    expect(ran).toEqual({ handed_over: 1, expired: 0 });
    expect(await asAdmin((q) => statesOf(q, [held, free, lateAndHeld]))).toEqual(['pending taken-back', 'pending handed-over', 'pending taken-back']);
    // The next run finds the late one free, and closes it as what its athlete had asked for.
    expect(await service((s) => dispatch(s))).toEqual({ handed_over: 0, expired: 1 });
    expect(await asAdmin((q) => stateOf(q, lateAndHeld))).toBe('canceled taken-back');
  });
});

// ============================================================
// The migration file, on production as it was frozen.
// ============================================================
describe('migration 16 applied to the production baseline', () => {
  const COACH = '00000000-0000-4000-8000-00000000c0ac';
  const ATHLETE = '00000000-0000-4000-8000-0000000000a1';
  const SECOND = '00000000-0000-4000-8000-0000000000a2';
  const LINK = '00000000-0000-4000-8000-000000000101';
  const LINK_SECOND = '00000000-0000-4000-8000-000000000102';
  const R_SENT = '00000000-0000-4000-8000-000000000901';
  const R_CANCELED = '00000000-0000-4000-8000-000000000902';
  const R_FAILED = '00000000-0000-4000-8000-000000000903';
  const R_LOST = '00000000-0000-4000-8000-000000000904';
  const R_LOST_LONG_AGO = '00000000-0000-4000-8000-000000000905';
  const R_TAKEN_BACK = '00000000-0000-4000-8000-000000000906';
  const R_OF_BILLIE = '00000000-0000-4000-8000-000000000907';
  const R_RUNNING = '00000000-0000-4000-8000-000000000908';
  const R_JUST_PAST = '00000000-0000-4000-8000-000000000909';
  const ALEX_PHONE = 'https://fcm.googleapis.com/fcm/send/alex-s-phone';
  const ALEX_LAPTOP = 'https://updates.push.services.mozilla.com/wpush/v2/alex-s-laptop';
  const BILLIE_PHONE = 'https://web.push.apple.com/billie-s-phone';
  const TO_COME = '2099_01_01_99_a_migration_to_come';

  // A coach and two athletes with notifications switched on — Alex on a
  // phone and a laptop — and the table as months of the app have left it: a
  // rest that rang, one that was taken back in time, one nobody was
  // subscribed for; four rows that have been waiting since their function
  // died — two long rests of Alex (one of them three weeks ago), one he had
  // taken back, one of Billie; and two rests that are running: one with five
  // minutes to go, one that ended five seconds ago and is being sent.
  // The role is set the way a dump restore sets it: on the baseline the
  // documented `update profiles set role = 'coach'` is undone for every
  // caller (finding P20, closed by migration 07).
  const WORLD = `
    insert into auth.users (id, email, aud, role, email_confirmed_at, raw_user_meta_data) values
      ('${COACH}',   'coach@sl.test',  'authenticated', 'authenticated', now(), '{"full_name": "Coach Carla"}'),
      ('${ATHLETE}', 'alex@sl.test',   'authenticated', 'authenticated', now(), '{"full_name": "Alex"}'),
      ('${SECOND}',  'billie@sl.test', 'authenticated', 'authenticated', now(), '{"full_name": "Billie"}');
    BEGIN;
    SET LOCAL session_replication_role = replica;
    update public.profiles set role = 'coach' where id = '${COACH}';
    COMMIT;
    insert into public.students (id, profile_id, coach_id) values
      ('${LINK}', '${ATHLETE}', '${COACH}'), ('${LINK_SECOND}', '${SECOND}', '${COACH}');
    insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent) values
      ('${ATHLETE}', '${ALEX_PHONE}', 'k', 's', 'Chrome on a phone'),
      ('${ATHLETE}', '${ALEX_LAPTOP}', 'k', 's', 'Firefox on a laptop'),
      ('${SECOND}',  '${BILLIE_PHONE}', 'k', 's', 'Safari on a phone');
    insert into public.scheduled_pushes (id, user_id, fire_at, status, canceled_at, sent_at, error, created_at) values
      ('${R_SENT}',          '${ATHLETE}', now() - interval '1 day',     'sent',     null, now() - interval '1 day', null, now() - interval '1 day'),
      ('${R_CANCELED}',      '${ATHLETE}', now() - interval '1 day',     'canceled', now() - interval '1 day', null, null, now() - interval '1 day'),
      ('${R_FAILED}',        '${SECOND}',  now() - interval '2 days',    'failed',   null, null, 'no_subscriptions', now() - interval '2 days'),
      ('${R_LOST}',          '${ATHLETE}', now() - interval '3 days',    'pending',  null, null, null, now() - interval '3 days'),
      ('${R_LOST_LONG_AGO}', '${ATHLETE}', now() - interval '20 days',   'pending',  null, null, null, now() - interval '20 days'),
      ('${R_TAKEN_BACK}',    '${ATHLETE}', now() - interval '2 days',    'pending',  now() - interval '2 days', null, null, now() - interval '2 days'),
      ('${R_OF_BILLIE}',     '${SECOND}',  now() - interval '5 hours',   'pending',  null, null, null, now() - interval '5 hours'),
      ('${R_RUNNING}',       '${ATHLETE}', now() + interval '5 minutes', 'pending',  null, null, null, now()),
      ('${R_JUST_PAST}',     '${SECOND}',  now() - interval '5 seconds', 'pending',  null, null, null, now() - interval '2 minutes');
    update public.scheduled_pushes set payload = '{"title": "Rest done", "tag": "rest-timer"}';
  `;

  /** The frozen baseline with that world in it and the migrations before 16 applied. */
  const production = async () => {
    const db = await scratchDatabase();
    await db.runFile(manifest.baseline);
    await db.runSql(WORLD, 'world');
    for (const earlier of manifest.migrations) {
      if (earlier.name === MIGRATION) break;
      await db.runFile(earlier.paths.migration);
    }
    return db;
  };

  // One transaction, always undone. Each step is a statement, or an actor:
  // from there on the statements are a request of that user of the API, role
  // and claims set the way PostgREST sets them. Before the first actor they
  // are the owner's — the SQL editor. The answer is the first value of the
  // last statement, or the message of the statement that raised.
  const user = (sub) => ({ role: 'authenticated', claims: { role: 'authenticated', sub } });
  const THE_ATHLETE = user(ATHLETE);
  const THE_SECOND = user(SECOND);
  const THE_COACH = user(COACH);
  const NOBODY = { role: 'anon', claims: { role: 'anon' } };
  const THE_SERVICE_ROLE = { role: 'service_role', claims: { role: 'service_role' } };
  const THE_OWNER = { role: 'postgres', claims: null };
  const actor = (step) => `select set_config('role', '${step.role}', true), set_config('request.jwt.claims', '${step.claims ? JSON.stringify(step.claims) : ''}', true)`;
  const story = async (db, ...steps) => {
    const statements = steps.map((step) => (typeof step === 'string' ? step : actor(step)));
    const tried = await attempt(() => db.runSql(`BEGIN;\n${statements.join(';\n')};\nROLLBACK;`, 'request'));
    if (!tried.ok) return (tried.error.cause ?? tried.error).message;
    const [found] = tried.value.at(-2).rows;
    return found ? Object.values(found)[0] : null;
  };
  /** The same, kept: a request of that user that is committed. */
  const request = (db, who, sql) => db.runSql(`BEGIN;\n${actor(who)};\n${sql};\nCOMMIT;`, 'request');

  const scheduleOn = (endpoint, seconds = 90) => `select public.schedule_rest_push(${seconds}, '{"title": "Rest done"}', ${endpoint ? `'${endpoint}'` : 'null'})`;
  const cancelOf = (id) => `select public.cancel_rest_push('${id}')`;
  const claimOf = (id) => `select public.claim_rest_push('${id}')`;
  const runTheJob = `select public.dispatch_due_rest_pushes()`;
  const statusOf = (id) => `select status from public.scheduled_pushes where id = '${id}'`;

  // The runbook page, which is what the person applying the file reads.
  const page = read(migration.paths.runbook);
  // Its fenced blocks, without the indent of the list item they stand in.
  const fences = (lang) => [...page.matchAll(new RegExp(`^( *)\`\`\`${lang}\\n([\\s\\S]*?)\\n\\1\`\`\`$`, 'gm'))]
    .map(([, indent, body]) => body.split('\n').map((line) => line.slice(indent.length)).join('\n'));
  const commands = fences('bash');
  const [pageCheck] = commands
    .map((command) => /^supabase db query --linked '(do \$check\$[\s\S]+\$check\$)'$/.exec(command)?.[1])
    .filter(Boolean);
  const quoted = (start) => commands
    .map((command) => /^supabase db query --linked "(.+)"$/.exec(command)?.[1])
    .find((sql) => sql?.startsWith(start));
  const listLeftWaiting = quoted('select pr.role, pr.full_name as account, count(*) as left_waiting');
  const listByDay = quoted('select sp.fire_at::date as day, count(*) filter');

  const printedAudit = async (db) => {
    const [result] = await db.readOnly(read(migration.paths.audit), 'audit');
    return Object.fromEntries(result.rows.map((line) => [line.check, line.value]));
  };
  const LINE = {
    scheduled: 'the end of a rest is scheduled by the database (schedule_rest_push, P10)',
    strangers: 'functions of these names that the migration does not know',
    anon: 'functions of this migration a request without a session may execute',
    users: 'functions of this migration a signed-in user may execute',
    asOwner: 'functions of this migration that run as their owner',
    statuses: 'what the status of a rest push can be',
    columns: 'a rest push says which device it is for, and when it was handed over (endpoint, dispatched_at)',
    policies: 'an account names a device of its own only (the two policies it writes through)',
    helper: 'the function a rest push is handed to send-push with (send_push_event, migration 15)',
    byStatus: 'rest pushes, by status',
    backlog: 'rest pushes still waiting more than a minute after their time (the backlog, B14)',
    takenBack: '… of which their athlete had taken back',
    oldest: '… the oldest of them was due on',
    running: 'rest pushes waiting for a time still to come, or less than a minute past',
    old: 'rest pushes older than 7 days',
    who: 'who sends a rest push',
  };
  const FOR_USERS = 'cancel_rest_push(uuid); schedule_rest_push(integer, jsonb, text)';
  const AS_OWNER = 'cancel_rest_push(uuid); dispatch_due_rest_pushes(); schedule_rest_push(integer, jsonb, text)';
  const BY_THE_APP = 'the app, by calling dispatch-rest-push (pg_cron is not installed: schedule_rest_push answers mode edge)';
  const untouched = async (db, before) => {
    expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
    expect(await db.query.value(`select count(*) from ${LEDGER} where name = $1`, [MIGRATION])).toBe(0);
  };
  const refusalOf = async (db, run = () => db.runFile(migration.paths.migration)) => {
    const before = await catalogSnapshot(db.query);
    const refused = await attempt(run);
    await untouched(db, before);
    return refused.error?.message ?? 'it ran';
  };
  /** The nine rows, in the order they are listed above: `status`, with ` taken-back` where canceled_at is set. */
  const rows = async (db) => (await db.query.rows(
    `select status || case when canceled_at is not null then ' taken-back' else '' end as state
       from public.scheduled_pushes where id::text like '00000000-0000-4000-8000-0000000009%' order by id`,
  )).map((row) => row.state);
  const AS_FOUND = [
    'sent', 'canceled taken-back', 'failed', 'pending', 'pending', 'pending taken-back', 'pending', 'pending', 'pending',
  ];
  const AS_LEFT = [
    'sent', 'canceled taken-back', 'failed', 'expired', 'expired', 'canceled taken-back', 'expired', 'pending', 'pending',
  ];

  it('the four functions are not there before, do what the page says after, and are gone after the rollback', async () => {
    const db = await production();
    const missing = (name, args) => `function public.${name}(${args}) does not exist`;
    const allMissing = async () => {
      expect(await story(db, THE_ATHLETE, scheduleOn(ALEX_PHONE))).toBe(missing('schedule_rest_push', 'integer, unknown, unknown'));
      expect(await story(db, THE_ATHLETE, cancelOf(R_RUNNING))).toBe(missing('cancel_rest_push', 'unknown'));
      expect(await story(db, THE_SERVICE_ROLE, claimOf(R_RUNNING))).toBe(missing('claim_rest_push', 'unknown'));
      expect(await story(db, THE_SERVICE_ROLE, runTheJob)).toBe(missing('dispatch_due_rest_pushes', ''));
    };
    await allMissing();

    await db.runFile(migration.paths.migration);

    // The next app: one request, and the rest that was running is closed by the one that starts.
    const answer = await story(db, THE_ATHLETE, scheduleOn(ALEX_LAPTOP));
    expect(answer).toEqual({ id: expect.any(String), fire_at: expect.any(String), mode: 'edge' });
    expect(await story(db, THE_ATHLETE, scheduleOn(ALEX_LAPTOP), THE_OWNER, statusOf(R_RUNNING))).toBe('canceled');
    expect(await story(db, THE_ATHLETE, scheduleOn(ALEX_LAPTOP), THE_OWNER,
      `select endpoint || ' in ' || (fire_at - now())::text from public.scheduled_pushes where status = 'pending' and user_id = '${ATHLETE}'`))
      .toBe(`${ALEX_LAPTOP} in 00:01:30`);
    expect(await story(db, THE_ATHLETE, cancelOf(R_RUNNING))).toEqual({ canceled: true });
    // The senders: once, never a row that was taken back, never one that is late.
    expect(await story(db, THE_SERVICE_ROLE, claimOf(R_JUST_PAST))).toMatchObject({ id: R_JUST_PAST, user_id: SECOND, endpoint: null });
    expect(await story(db, THE_SERVICE_ROLE, claimOf(R_JUST_PAST), claimOf(R_JUST_PAST))).toBeNull();
    expect(await story(db, THE_ATHLETE, cancelOf(R_RUNNING), THE_SERVICE_ROLE, claimOf(R_RUNNING))).toBeNull();
    expect(await story(db, THE_SERVICE_ROLE, claimOf(R_LOST))).toBeNull();
    expect(await story(db, THE_SERVICE_ROLE, runTheJob)).toEqual({ handed_over: 1, expired: 0 });

    // Everybody else, as the page says.
    expect(await story(db, NOBODY, scheduleOn(ALEX_PHONE))).toBe('permission denied for function schedule_rest_push');
    expect(await story(db, NOBODY, cancelOf(R_RUNNING))).toBe('permission denied for function cancel_rest_push');
    for (const who of [NOBODY, THE_ATHLETE, THE_COACH]) {
      expect(await story(db, who, claimOf(R_RUNNING))).toBe('permission denied for function claim_rest_push');
      expect(await story(db, who, runTheJob)).toBe('permission denied for function dispatch_due_rest_pushes');
    }
    expect(await story(db, THE_ATHLETE, scheduleOn(ALEX_PHONE, 0))).toBe('rest_seconds_out_of_range');
    expect(await story(db, THE_ATHLETE, scheduleOn(ALEX_PHONE, 901))).toBe('rest_seconds_out_of_range');
    expect(await story(db, THE_ATHLETE, `select public.schedule_rest_push(60, '[1]', '${ALEX_PHONE}')`)).toBe('payload_invalid');
    expect(await story(db, THE_ATHLETE, scheduleOn(BILLIE_PHONE))).toBe('device_not_registered');
    expect(await story(db, THE_COACH, scheduleOn(null))).toBe('device_not_registered');
    expect(await story(db, THE_SECOND, cancelOf(R_RUNNING))).toEqual({ canceled: false });
    expect(await story(db, THE_ATHLETE,
      `insert into public.scheduled_pushes (user_id, fire_at, endpoint) values ('${ATHLETE}', now(), '${BILLIE_PHONE}')`))
      .toBe('new row violates row-level security policy for table "scheduled_pushes"');
    for (const said of ['`permission denied for function schedule_rest_push` (or the name of the one called)',
      '`permission denied for function claim_rest_push` (or `dispatch_due_rest_pushes`)', '| `rest_seconds_out_of_range` |',
      '| `payload_invalid` |', '| `device_not_registered` |', '`new row violates row-level security policy for table "scheduled_pushes"`',
      '| `{"canceled": false}` — not an error |']) {
      expect(page).toContain(said);
    }

    // Nothing above was kept.
    expect(await rows(db)).toEqual(AS_LEFT);

    await db.runFile(migration.paths.rollback);
    await allMissing();
    await db.drop();
  });

  // "Old client keeps inserting rows directly": the two requests of the app
  // and the statements of the function that are deployed, before the file,
  // after it, and after its rollback.
  it('the app and the dispatch-rest-push that are deployed do what they did: before, after, and after the rollback', async () => {
    const db = await production();
    const NEW = '00000000-0000-4000-8000-000000000999';
    const deployed = () => story(db,
      THE_ATHLETE,
      `insert into public.scheduled_pushes (id, user_id, fire_at, payload) values ('${NEW}', '${ATHLETE}', now() + interval '45 seconds', '{"title": "Rest done"}') returning id`,
      THE_SERVICE_ROLE,
      `select * from public.scheduled_pushes where id = '${NEW}'`,
      `select status, canceled_at from public.scheduled_pushes where id = '${NEW}'`,
      `update public.scheduled_pushes set status = 'sent', sent_at = now(), error = null where id = '${NEW}'`,
      // The next rest, taken back by the app before its time.
      THE_ATHLETE,
      `update public.scheduled_pushes set canceled_at = now() where id = '${R_RUNNING}' and status = 'pending'`,
      THE_SERVICE_ROLE,
      `update public.scheduled_pushes set status = 'canceled' where id = '${R_RUNNING}' and status = 'pending'`,
      THE_ATHLETE,
      `select string_agg(status, ' ' order by fire_at) from public.scheduled_pushes where id in ('${NEW}', '${R_RUNNING}')`);
    const AS_BEFORE = 'sent canceled';

    expect(await deployed()).toBe(AS_BEFORE);
    await db.runFile(migration.paths.migration);
    expect(await deployed()).toBe(AS_BEFORE);
    await db.runFile(migration.paths.rollback);
    expect(await deployed()).toBe(AS_BEFORE);
    await db.drop();
  });

  it('adds 4 functions and 2 columns, replaces 1 rule, adds a condition to 2 policies and signs the ledger — no table, no trigger, no index, no privilege of what was there', async () => {
    const db = await production();
    const before = await catalogSnapshot(db.query);
    await db.runFile(migration.paths.migration);
    const after = await catalogSnapshot(db.query);

    const lines = diffCatalogs(before, after, { left: 'before', right: 'after' });
    const only = (side) => lines.filter((line) => line.endsWith(`: only in ${side}`))
      .map((line) => line.slice(0, -`: only in ${side}`.length));
    // The names of the arguments are what the API calls them by.
    const SCHEDULE = 'public.schedule_rest_push(p_seconds integer, p_payload jsonb, p_endpoint text)';
    const CANCEL = 'public.cancel_rest_push(p_id uuid)';
    const CLAIM = 'public.claim_rest_push(p_id uuid)';
    const DISPATCH = 'public.dispatch_due_rest_pushes()';
    expect(only('after').sort()).toEqual([
      'columns public.scheduled_pushes.dispatched_at', 'columns public.scheduled_pushes.endpoint',
      `functions ${CANCEL}`, `functions ${CLAIM}`, `functions ${DISPATCH}`, `functions ${SCHEDULE}`,
    ]);
    expect(only('before')).toEqual([]);
    expect(lines.filter((line) => !/: only in (before|after)$/.test(line)).map((line) => /^(.*?): (\w+): /.exec(line).slice(1, 3).join(' → ')))
      .toEqual([
        'constraints public.scheduled_pushes.scheduled_pushes_status_check → definition',
        'policies public.scheduled_pushes.Cancel own scheduled pushes → with_check',
        'policies public.scheduled_pushes.Insert own scheduled pushes → with_check',
        'data rows of app_private.app_migrations → rows',
      ]);

    expect(after.columns['public.scheduled_pushes.endpoint']).toMatchObject({ type: 'text', not_null: false, default: null });
    expect(after.columns['public.scheduled_pushes.dispatched_at']).toMatchObject({ type: 'timestamp with time zone', not_null: false, default: null });
    expect(after.constraints['public.scheduled_pushes.scheduled_pushes_status_check']).toMatchObject({ kind: 'check', validated: true });

    // Two for a signed-in user, two for the service role alone; three with
    // the rights of their owner, the claim with those of its caller.
    const header = (key) => after.functions[key].definition.split(/\nAS /)[0];
    for (const [key, forUsers, definer] of [[SCHEDULE, true, true], [CANCEL, true, true], [CLAIM, false, false], [DISPATCH, false, true]]) {
      expect(after.functions[key].privileges, key).toEqual([
        ...(forUsers ? ['authenticated: EXECUTE'] : []), 'postgres: EXECUTE', 'service_role: EXECUTE',
      ]);
      expect(after.functions[key].owner, key).toBe('postgres');
      expect(header(key).includes('\n SECURITY DEFINER\n'), key).toBe(definer);
      expect(header(key), key).toContain('\n RETURNS jsonb\n');
      expect(header(key), key).toContain(`\n SET search_path TO 'public', 'pg_temp'`);
    }
    // What the app may leave out when it calls.
    expect(header(SCHEDULE)).toContain('p_payload jsonb, p_endpoint text DEFAULT NULL::text');

    // The ledger, as the page says it reads.
    expect(await db.query.rows(`select name from ${LEDGER} order by name`)).toHaveLength(16);
    expect(await db.query.value(`select name from ${LEDGER} order by name desc limit 1`)).toBe(MIGRATION);
    expect(page).toContain(`Expected: sixteen rows, the last one \`${MIGRATION}\`.`);
    expect(page).toContain('| Kind | required · adds 4 functions and 2 columns, replaces 1 rule on a column, adds a condition to 2 policies, closes the rest pushes left waiting; no table, no trigger, no row deleted |');
    await db.drop();
  });

  // The runbook page tells the person applying the file what the audit prints
  // before and after. This is that table, read off the page.
  it('its audit prints the "before" and "after" columns of the runbook page', async () => {
    const db = await production();
    const audit = read(migration.paths.audit);
    const printed = async () => {
      const [result] = await db.readOnly(audit, 'audit');
      return result.rows.map((line) => [line.check, line.value]);
    };
    const table = page.split('\n')
      .map((line) => /^\| (\d+) \| (.+?) \| (.+?) \| (.+?) \|$/.exec(line))
      .filter(Boolean)
      .map(([, n, check, before, after]) => ({ n: Number(n), check, before, after }));
    expect(table.map((line) => line.n)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
    // Written between back-ticks: a value the page gives exactly. The other
    // ones are sentences about what production holds.
    const exact = table.filter((line) => /^`.+`$/.test(line.before) && /^`.+`$/.test(line.after))
      .map((line) => ({ ...line, before: line.before.slice(1, -1), after: line.after.slice(1, -1) }));
    expect(exact.map((line) => line.n)).toEqual(Array.from({ length: 11 }, (_, i) => i + 1));
    const threeWeeksAgo = await db.query.value(`select (now() - interval '20 days')::date::text`);
    const onPage = (column, theRows) => [
      ...exact.map((line) => [line.n, line.check, line[column]]),
      ...theRows.map((value, i) => [12 + i, table[11 + i].check, value]),
    ].sort((x, y) => x[0] - y[0]).map(([, check, value]) => [check, value]);
    // Lines 12 to 18: by status, the backlog, taken back, the oldest, running, older than 7 days, who sends.
    const BEFORE = ['canceled 1, failed 1, pending 6, sent 1', '4', '1', threeWeeksAgo, '2', '1', BY_THE_APP];
    const AFTER = ['canceled 2, expired 3, failed 1, pending 2, sent 1', '0', '0', 'none', '2', '1', BY_THE_APP];
    expect(table.slice(11).map((line) => line.check)).toEqual([
      LINE.byStatus, LINE.backlog, LINE.takenBack, LINE.oldest, LINE.running, LINE.old, LINE.who,
    ]);
    // What the page promises of those lines, where it is exact.
    expect(table.slice(12, 15).map((line) => line.after)).toEqual(['`0`', '`0`', '`none`']);

    expect(await printed()).toEqual(onPage('before', BEFORE));
    await db.runFile(migration.paths.migration);
    expect(await printed()).toEqual(onPage('after', AFTER));
    expect(Object.fromEntries(await printed())).toMatchObject({ [LINE.users]: FOR_USERS, [LINE.asOwner]: AS_OWNER });
    // …and the header of the audit file says the same.
    const header = audit.split('\n').filter((line) => line.startsWith('--')).join('\n');
    for (const { check, before, after } of exact) {
      expect(header, check).toContain(check);
      expect(header).toContain(before);
      expect(header).toContain(after);
    }
    for (const { check } of table.slice(11)) expect(header).toContain(check);

    await db.runFile(migration.paths.rollback);
    // The rows the migration closed stay closed: the rule of four statuses holds them as failed.
    expect(await printed()).toEqual(onPage('before', ['canceled 2, failed 4, pending 2, sent 1', '0', '0', 'none', '2', '1', BY_THE_APP]));
    await db.drop();
  });

  it('the page\'s check answers NOT THERE before and "in place" after — and writes nothing either way', async () => {
    const db = await production();
    expect(pageCheck, 'the page no longer gives the check').toBeTruthy();
    // Pasted between single quotes in a shell: it may not hold one.
    expect(pageCheck).not.toContain("'");
    const checked = async () => {
      const tried = await attempt(() => db.runSql(pageCheck, 'page check'));
      expect(tried.ok, 'the check must always fail: that is what undoes it').toBe(false);
      return (tried.error.cause ?? tried.error).message;
    };
    const state = () => db.query.one(
      `select (select count(*) from auth.users) as accounts, (select count(*) from public.profiles) as profiles,
              (select count(*) from public.push_subscriptions) as devices, (select count(*) from public.scheduled_pushes) as rest_pushes,
              (select count(*) from net.http_request_queue) as requests,
              current_user::text as role, coalesce(current_setting('request.jwt.claims', true), '') as claims`,
    );
    const UNTOUCHED = { accounts: 3, profiles: 3, devices: 3, rest_pushes: 9, requests: 0, role: 'postgres', claims: '' };
    const answer = (said) => `check only, nothing was written: ${said}`;
    const SENTENCE = 'a rest push is scheduled at the time of the server for a device of its account, taken back by its account only, '
      + 'and handed to a sender once — never after it was taken back, never more than a minute late';
    const IN_PLACE = answer(`in place, mode edge: ${SENTENCE}`);

    expect(await checked()).toBe(answer('NOT THERE: the four functions are not in the database'));
    expect(await state()).toEqual(UNTOUCHED);

    await db.runFile(migration.paths.migration);
    expect(await checked()).toBe(IN_PLACE);
    expect(await state()).toEqual(UNTOUCHED);
    expect(await rows(db)).toEqual(AS_LEFT);
    // What the page says the command prints.
    expect(page).toContain(`\`${IN_PLACE}\``);
    expect(page).toContain('`… NOT THERE: the four functions are not in the database`');

    // Each function made wrong by hand, one way at a time: the answer nobody wants.
    const replace = async (signature, rewrite) => {
      const was = await db.query.value(`select pg_get_functiondef($1::regprocedure)`, [signature]);
      const wrong = rewrite(was);
      expect(wrong, `${signature}: the text to make wrong is no longer in the function`).not.toBe(was);
      await db.query(wrong);
      const said = await checked();
      await db.query(was);
      expect(await checked(), `${signature} put back`).toBe(IN_PLACE);
      return said;
    };
    const SCHEDULE = 'public.schedule_rest_push(integer, jsonb, text)';
    const CANCEL = 'public.cancel_rest_push(uuid)';
    const CLAIM = 'public.claim_rest_push(uuid)';
    // One that takes the time from somewhere else.
    expect(await replace(SCHEDULE, (was) => was.replace('now() + make_interval(secs => p_seconds)', 'clock_timestamp() + make_interval(secs => p_seconds + 1)')))
      .toBe(answer('BROKEN: schedule_rest_push did not answer the time of the server plus the seconds asked for'));
    // One that schedules for any device.
    expect(await replace(SCHEDULE, (was) => was.replace('AND (p_endpoint IS NULL OR ps.endpoint = p_endpoint)', '')))
      .toBe(answer('NOT PROTECTED: a rest push was scheduled for a device its account has not registered'));
    // One that does not say who sends.
    expect(await replace(SCHEDULE, (was) => was.replace(`'mode', v_mode`, `'mode', 'later'`)))
      .toBe(answer('BROKEN: schedule_rest_push did not say who sends'));
    // One that leaves the rest before waiting.
    expect(await replace(SCHEDULE, (was) => was.replace(`WHERE sp.user_id = v_uid\n     AND sp.status = 'pending';`, `WHERE false;`)))
      .toBe(answer('NOT PROTECTED: a rest push that was taken back was handed to a sender'));
    // One that takes back for anybody.
    expect(await replace(CANCEL, (was) => was.replace('AND sp.user_id = v_uid', '')))
      .toBe(answer('NOT PROTECTED: an account took back the rest push of another one'));
    // One that takes back what a sender has.
    expect(await replace(CANCEL, (was) => was.replace(`AND sp.status = 'pending';`, `AND sp.status IN ('pending', 'sending');`)))
      .toBe(answer('BROKEN: a rest push that a sender had taken was taken back'));
    // One that answers a row as often as it is asked.
    expect(await replace(CLAIM, (was) => was.replace(`AND sp.status = 'pending'\n     AND sp.canceled_at IS NULL`, `AND sp.status IN ('pending', 'sending')\n     AND sp.canceled_at IS NULL`)))
      .toBe(answer('NOT PROTECTED: a rest push was handed to a sender twice'));
    // One that answers a row whatever its time.
    expect(await replace(CLAIM, (was) => was.replace(`AND sp.fire_at > now() - interval '60 seconds'\n  RETURNING`, 'RETURNING')))
      .toBe(answer('NOT PROTECTED: a rest push more than a minute late was handed to a sender'));
    // One that does not say for which device.
    expect(await replace(CLAIM, (was) => was.replace(`'endpoint', v_row.endpoint,`, `'endpoint', NULL,`)))
      .toBe(answer('BROKEN: claim_rest_push did not answer the rest push with its account and its device'));
    // One that leaves a late row waiting.
    expect(await replace(CLAIM, (was) => was.replace(`SET status = CASE WHEN sp.canceled_at IS NULL THEN 'expired' ELSE 'canceled' END`, `SET status = 'pending'`)))
      .toBe(answer('BROKEN: the four rest pushes are not canceled, sending, sending and expired'));
    expect(page).toContain('- `… NOT PROTECTED: …` or `… BROKEN: …` — a function does not do what this page says: **roll back**, and report the full message.');

    // The two that are not for an account, handed to one by mistake.
    await db.query(`grant execute on function ${CLAIM} to authenticated`);
    expect(await checked()).toBe(answer('NOT PROTECTED: a signed-in user took a rest push to send'));
    await db.query(`revoke execute on function ${CLAIM} from authenticated`);
    await db.query(`grant execute on function public.dispatch_due_rest_pushes() to authenticated`);
    expect(await checked()).toBe(answer('NOT PROTECTED: a signed-in user ran the job'));
    await db.query(`revoke execute on function public.dispatch_due_rest_pushes() from authenticated`);

    // With the job of migration 19: the same answer, and the mode says so.
    await db.query(`create schema cron`);
    await db.query(`create table cron.job (jobid bigserial primary key, jobname text, active boolean not null default true)`);
    await db.query(`insert into cron.job (jobname) values ('sl-rest-push')`);
    expect(await checked()).toBe(answer(`in place, mode cron: ${SENTENCE}`));
    expect(page).toContain('the same command says `in place, mode cron: …`');
    await db.query(`drop schema cron cascade`);

    expect(await state()).toEqual(UNTOUCHED);
    await db.drop();
  });

  // B14: "The migration expires the existing backlog."
  it('the rows left waiting: counted by the audit, listed with the page\'s statement, closed by the migration — and a rest that is running is left alone', async () => {
    const db = await production();
    for (const statement of [listLeftWaiting, listByDay]) {
      expect(statement, 'the page no longer gives one of its statements').toBeTruthy();
      // Pasted between double quotes in a shell.
      expect(statement).not.toMatch(/["$`!\\]/);
    }
    expect(await rows(db)).toEqual(AS_FOUND);
    expect(await printedAudit(db)).toMatchObject({ [LINE.backlog]: '4', [LINE.takenBack]: '1', [LINE.running]: '2' });
    const leftWaiting = async () => (await db.query.rows(listLeftWaiting))
      .map((line) => `${line.role} ${line.account}: ${line.left_waiting} left waiting, ${line.taken_back} taken back`);
    expect(await leftWaiting()).toEqual(['student Alex: 3 left waiting, 1 taken back', 'student Billie: 1 left waiting, 0 taken back']);

    await db.runFile(migration.paths.migration);

    expect(await rows(db)).toEqual(AS_LEFT);
    expect(await leftWaiting()).toEqual([]);
    expect(await printedAudit(db)).toMatchObject({ [LINE.backlog]: '0', [LINE.takenBack]: '0', [LINE.running]: '2' });
    // Nothing else about them was written: no stamp, no error, no device — and no row is gone.
    expect(await db.query.one(
      `select count(*) as there, count(*) filter (where endpoint is not null or dispatched_at is not null) as marked,
              count(*) filter (where status in ('expired', 'canceled') and (sent_at is not null or error is not null)) as stamped,
              count(*) filter (where status = 'canceled' and canceled_at is null) as canceled_without_its_moment
         from public.scheduled_pushes`,
    )).toEqual({ there: 9, marked: 0, stamped: 0, canceled_without_its_moment: 0 });
    // By day, as the page's second statement shows them.
    const byDay = await db.query.rows(listByDay);
    expect(byDay.reduce((sum, day) => ({
      sent: sum.sent + day.sent, taken_back: sum.taken_back + day.taken_back, never_sent: sum.never_sent + day.never_sent,
      failed: sum.failed + day.failed, never_reported: sum.never_reported + day.never_reported, waiting: sum.waiting + day.waiting,
    }), { sent: 0, taken_back: 0, never_sent: 0, failed: 0, never_reported: 0, waiting: 0 }))
      .toEqual({ sent: 1, taken_back: 2, never_sent: 3, failed: 1, never_reported: 0, waiting: 2 });

    // No sender is handed one of them — and the two rests that are running are still theirs to send.
    for (const id of [R_LOST, R_LOST_LONG_AGO, R_TAKEN_BACK, R_OF_BILLIE]) expect(await story(db, THE_SERVICE_ROLE, claimOf(id))).toBeNull();
    for (const id of [R_RUNNING, R_JUST_PAST]) expect(await story(db, THE_SERVICE_ROLE, claimOf(id))).toMatchObject({ id });
    expect(page).toContain('No row is deleted, and a rest that is running while the migration is applied is not touched.');
    await db.drop();
  });

  it('without migration 15 it says so (SLM02), and its rollback says there is nothing to undo (SLM03)', async () => {
    const db = await scratchDatabase();
    await db.runFile(manifest.baseline);
    const refusals = async () => {
      const before = await catalogSnapshot(db.query);
      const refused = await attempt(() => db.runFile(migration.paths.migration));
      const undone = await attempt(() => db.runFile(migration.paths.rollback));
      expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
      return [refused.error?.code, refused.error?.message, undone.error?.code];
    };
    // Without a ledger at all, then with the ledger and the migrations before 15 only.
    const needs = 'needs 2026_10_13_15_push_plumbing, which is not applied';
    let [code, message, undone] = await refusals();
    expect([code, undone]).toEqual([REFUSAL.predecessorMissing, REFUSAL.notApplied]);
    expect(message).toContain(needs);
    for (const earlier of manifest.migrations.slice(0, 14)) await db.runFile(earlier.paths.migration);
    expect(await db.query.value(`select name from ${LEDGER} order by name desc limit 1`)).toBe('2026_10_13_14_table_grants_lockdown');
    [code, message, undone] = await refusals();
    expect([code, undone]).toEqual([REFUSAL.predecessorMissing, REFUSAL.notApplied]);
    expect(message).toContain(needs);
    expect(page).toContain(`| \`${needs}\` (code \`SLM02\`) |`);
    await db.drop();
  });

  it('refuses to run as another role than postgres', async () => {
    const db = await production();
    const text = read(migration.paths.migration);
    const asServiceRole = text.replace(`SET LOCAL lock_timeout = '5s';`, `SET LOCAL lock_timeout = '5s';\nSET LOCAL ROLE service_role;`);
    expect(asServiceRole).not.toBe(text);
    expect(await refusalOf(db, () => db.runSql(asServiceRole, 'migration')))
      .toContain(`migration ${MIGRATION} must be run as postgres, not as service_role`);
    expect(await db.query.value(`select current_user::text`)).toBe('postgres');
    await db.drop();
  });

  it('refuses to run next to a function or a column of its names, and changes nothing', async () => {
    const db = await production();

    // A function with other arguments: it would stay next to the new one.
    await db.query(`create function public.cancel_rest_push(p_id text) returns void language sql as 'select'`);
    expect(await refusalOf(db)).toContain(`migration ${MIGRATION} would not create: cancel_rest_push(text) is already there`);
    expect(await printedAudit(db)).toMatchObject({ [LINE.strangers]: 'cancel_rest_push(text)', [LINE.scheduled]: 'no' });
    expect(page).toContain('- **3** is not `none` — **stop and report the line.**');
    await db.query(`drop function public.cancel_rest_push(text)`);

    // With the same arguments: the audit reads `yes`, and the ledger does not know why.
    await db.query(`create function public.schedule_rest_push(p_seconds integer, p_payload jsonb, p_endpoint text) returns jsonb language sql as 'select null::jsonb'`);
    expect(await refusalOf(db)).toContain(`migration ${MIGRATION} would not create: schedule_rest_push(integer,jsonb,text) is already there`);
    expect(await printedAudit(db)).toMatchObject({ [LINE.strangers]: 'none', [LINE.scheduled]: 'yes' });
    expect(page).toContain('| `would not create: … is already there` |');
    await db.query(`drop function public.schedule_rest_push(integer, jsonb, text)`);

    // A column of one of the two names.
    await db.query(`alter table public.scheduled_pushes add column endpoint text`);
    expect(await refusalOf(db)).toContain(`migration ${MIGRATION} would not add: public.scheduled_pushes.endpoint is already there`);
    expect(await printedAudit(db)).toMatchObject({ [LINE.columns]: 'one of the two only' });
    expect(page).toContain('| `would not add: … is already there` |');
    await db.query(`alter table public.scheduled_pushes drop column endpoint`);

    // Whoever runs it, and with whatever search_path: applied that way, it is
    // the same database as applied the usual way.
    const text = read(migration.paths.migration);
    const elsewhere = text.replace(`SET LOCAL lock_timeout = '5s';`, `SET LOCAL lock_timeout = '5s';\nSET LOCAL search_path = pg_catalog;`);
    expect(elsewhere).not.toBe(text);
    await db.runSql(elsewhere, 'migration');
    const other = await production();
    await other.runFile(migration.paths.migration);
    expect(diffCatalogs(await catalogSnapshot(other.query), await catalogSnapshot(db.query), { left: 'usual', right: 'pg_catalog' }))
      .toEqual([]);
    await other.drop();
    await db.drop();
  });

  // The body of a function is not checked against the database when it is
  // created, and the rule and the policies are replaced by name.
  it('refuses to run when a column, the function, the rule or a policy it is written for is not what it expects', async () => {
    const db = await production();

    await db.query(`alter table public.scheduled_pushes rename column canceled_at to cancelled_at`);
    await db.query(`alter table public.push_subscriptions rename column endpoint to address`);
    expect(await refusalOf(db)).toContain(
      `migration ${MIGRATION} does not find the columns its functions are written with: public.push_subscriptions.endpoint, public.scheduled_pushes.canceled_at`,
    );
    expect(page).toContain('| `does not find the columns its functions are written with: …` |');
    await db.query(`alter table public.scheduled_pushes rename column cancelled_at to canceled_at`);
    await db.query(`alter table public.push_subscriptions rename column address to endpoint`);

    await db.query(`alter function public.send_push_event(uuid, jsonb, jsonb) rename to send_a_push`);
    expect(await refusalOf(db)).toContain(
      `migration ${MIGRATION} does not find the function its functions call: public.send_push_event(uuid, jsonb, jsonb)`,
    );
    expect(await printedAudit(db)).toMatchObject({ [LINE.helper]: 'no' });
    expect(page).toContain('| `does not find the function its functions call: …` |');
    await db.query(`alter function public.send_a_push(uuid, jsonb, jsonb) rename to send_push_event`);

    // The rule on the status, changed by hand: one status more, then under another name.
    const RULE = `check (status in ('pending', 'sent', 'canceled', 'failed'))`;
    await db.query(`alter table public.scheduled_pushes drop constraint scheduled_pushes_status_check,
      add constraint scheduled_pushes_status_check check (status in ('pending', 'sent', 'canceled', 'failed', 'retry'))`);
    expect(await refusalOf(db)).toContain(
      `migration ${MIGRATION} would not replace the rule on public.scheduled_pushes.status: the constraint scheduled_pushes_status_check reads CHECK (`,
    );
    expect(await printedAudit(db)).toMatchObject({ [LINE.statuses]: 'canceled, failed, pending, retry, sent' });
    await db.query(`alter table public.scheduled_pushes drop constraint scheduled_pushes_status_check, add constraint status_is_known ${RULE}`);
    expect(await refusalOf(db)).toContain(
      `migration ${MIGRATION} would not replace the rule on public.scheduled_pushes.status: the constraint scheduled_pushes_status_check is not there`,
    );
    expect(await printedAudit(db)).toMatchObject({ [LINE.statuses]: 'NOT THERE: no constraint scheduled_pushes_status_check' });
    expect(page).toContain('| `would not replace the rule on public.scheduled_pushes.status: …` |');
    expect(page).toContain('- **8** is not `canceled, failed, pending, sent` — stop and report the line.');
    await db.query(`alter table public.scheduled_pushes drop constraint status_is_known, add constraint scheduled_pushes_status_check ${RULE}`);

    // A policy under another name, and one for another command.
    await db.query(`alter policy "Cancel own scheduled pushes" on public.scheduled_pushes rename to "Cancel mine"`);
    expect(await refusalOf(db)).toContain(
      `migration ${MIGRATION} does not find the policies of public.scheduled_pushes it adds a condition to: Cancel own scheduled pushes (UPDATE)`,
    );
    expect(await printedAudit(db)).toMatchObject({ [LINE.policies]: 'NOT THERE: the two policies are not both there' });
    expect(page).toContain('| `does not find the policies of public.scheduled_pushes it adds a condition to: …` |');
    await db.query(`alter policy "Cancel mine" on public.scheduled_pushes rename to "Cancel own scheduled pushes"`);

    await db.runFile(migration.paths.migration);
    expect(await story(db, THE_ATHLETE, scheduleOn(ALEX_PHONE))).toMatchObject({ mode: 'edge' });
    await db.drop();
  });

  // The privileges stand next to each function: what a new function is born
  // with is not this file's to rely on.
  it('applied where a new function is born open to everybody, the four are still closed to whom they are not for', async () => {
    const db = await production();
    // Supabase's own defaults, as they were before migration 03.
    await db.query(`alter default privileges for role postgres grant execute on functions to public`);
    await db.query(`alter default privileges for role postgres in schema public grant execute on functions to anon, authenticated`);
    await db.runFile(migration.paths.migration);
    expect(await printedAudit(db)).toMatchObject({ [LINE.anon]: 'none', [LINE.users]: FOR_USERS });
    expect(await story(db, NOBODY, scheduleOn(ALEX_PHONE))).toBe('permission denied for function schedule_rest_push');
    expect(await story(db, THE_ATHLETE, claimOf(R_RUNNING))).toBe('permission denied for function claim_rest_push');
    expect(await story(db, THE_ATHLETE, runTheJob)).toBe('permission denied for function dispatch_due_rest_pushes');
    await db.runFile(migration.paths.rollback);

    // … and a file that forgot one of them, or that made the claim run with
    // the rights of its owner, reads its own result back and undoes itself.
    const text = read(migration.paths.migration);
    const wrong = async (changed) => {
      expect(changed).not.toBe(text);
      return refusalOf(db, () => db.runSql(changed, 'migration'));
    };
    expect(await wrong(text.replace('REVOKE ALL ON FUNCTION public.claim_rest_push(uuid) FROM PUBLIC, anon, authenticated;\n', ''))).toContain(
      `migration ${MIGRATION} did not get the functions it meant: public.claim_rest_push(uuid): anon may execute it, PUBLIC may execute it, a signed-in user may execute it`,
    );
    expect(await wrong(text.replace('RETURNS jsonb\nLANGUAGE plpgsql\nSECURITY INVOKER', 'RETURNS jsonb\nLANGUAGE plpgsql\nSECURITY DEFINER')))
      .toContain(`migration ${MIGRATION} did not get the functions it meant: public.claim_rest_push(uuid): it runs as its owner`);
    expect(await wrong(text.replace('GRANT EXECUTE ON FUNCTION public.cancel_rest_push(uuid) TO authenticated;\n', '')))
      .toContain(`migration ${MIGRATION} did not get the functions it meant: public.cancel_rest_push(uuid): a signed-in user may NOT execute it`);
    expect(page).toContain('| `did not get the functions it meant: …` or `did not get the table it meant: …` |');
    await db.drop();
  });

  it('its rollback is refused while the ledger records a later migration, and changes nothing', async () => {
    const db = await production();
    await db.runFile(migration.paths.migration);
    await db.query(`insert into ${LEDGER} (name) values ($1)`, [TO_COME]);
    const before = await catalogSnapshot(db.query);

    const refused = await attempt(() => db.runFile(migration.paths.rollback));
    expect(refused.error?.code).toBe(REFUSAL.stillNeeded);
    expect(refused.error.message).toContain(`the ledger still records later migrations: ${TO_COME}`);
    expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
    expect(await rows(db)).toEqual(AS_LEFT);
    await db.drop();
  });

  // What the rollback page says of what happened while the migration was in place.
  it('rolled back: a row that is expired or sending becomes failed with a word that says which, no row is deleted or reopened, and the file applies again', async () => {
    const db = await production();
    await db.runFile(migration.paths.migration);
    // A rest of Billie that a sender has taken, and her next one, scheduled by the next app for her phone.
    await request(db, THE_SERVICE_ROLE, claimOf(R_JUST_PAST));
    await request(db, THE_SECOND, scheduleOn(BILLIE_PHONE, 300));
    expect(await rows(db)).toEqual([...AS_LEFT.slice(0, 8), 'sending']);
    const count = () => db.query.value(`select count(*) from public.scheduled_pushes`);
    expect(await count()).toBe(10);

    await db.runFile(migration.paths.rollback);

    expect(await rows(db)).toEqual(['sent', 'canceled taken-back', 'failed', 'failed', 'failed', 'canceled taken-back', 'failed', 'pending', 'failed']);
    expect(await db.query.rows(`select error, count(*) as n from public.scheduled_pushes where status = 'failed' group by error order by error`)).toEqual([
      { error: 'expired: nobody had sent it a minute after its time', n: 3 },
      { error: 'no_subscriptions', n: 1 },
      { error: 'sending: its sender had not said what became of it', n: 1 },
    ]);
    expect(await count()).toBe(10);
    // The rest of Billie that was waiting still is — for every device again: the column is gone.
    expect(await db.query.value(`select count(*) from public.scheduled_pushes where status = 'pending' and user_id = $1`, [SECOND])).toBe(1);
    expect(await printedAudit(db)).toMatchObject({
      [LINE.scheduled]: 'no', [LINE.users]: 'none', [LINE.asOwner]: 'none', [LINE.statuses]: 'canceled, failed, pending, sent',
      [LINE.columns]: 'no', [LINE.policies]: 'no', [LINE.backlog]: '0',
    });
    expect(page).toContain('both become `failed`, with a sentence in `error` that says which it was');
    expect(page).toContain('They are not made `pending` again');

    // A function of one of the names made AFTERWARDS, with other arguments, is not the rollback's to drop.
    await db.runFile(migration.paths.migration);
    await db.query(`create function public.claim_rest_push(p_ids uuid[]) returns jsonb language sql as 'select null::jsonb'`);
    await db.runFile(migration.paths.rollback);
    expect(await db.query.value(`select to_regprocedure('public.claim_rest_push(uuid[])') is not null`)).toBe(true);
    await db.query(`drop function public.claim_rest_push(uuid[])`);
    // …and the migration applies again on what the rollback left.
    await db.runFile(migration.paths.migration);
    expect(await story(db, THE_ATHLETE, scheduleOn(ALEX_PHONE))).toMatchObject({ mode: 'edge' });
    expect(await count()).toBe(10);
    await db.drop();
  });
});
