// The rows nobody reads any more are deleted by one function — review finding
// L27, closed by migration 2026_10_13_18_retention, which is also the
// retention that B14 and L20 ask for.
//
// Three tables hold rows that are of use for a while and of none afterwards,
// and nothing ever deleted one of them: scheduled_pushes (one row per rest
// timer), notifications (the lines of the bell) and client_errors (the list
// at the bottom of the coach's roster). pg_cron, which would run a job, is not
// installed and may never be. Since the migration:
//
//   run_retention()   deletes the rest pushes written more than 7 days ago —
//                     never one that is still to be sent —, the notifications
//                     their recipient read more than 90 days ago — never one
//                     that was not read —, the client errors older than 90
//                     days, and answers how many of each. For the owner of the
//                     database and the service role, with the rights of its
//                     caller, and it waits for nobody.
//   who runs it       the owner, once a month
//                     (docs/runbook/70-admin-procedures.md) — or the nightly
//                     job of the optional migration 19. Nothing else.
//
// A test cannot wait 90 days: it writes rows with the dates of the past, as
// the owner of the database. Inside a scenario() everything is one
// transaction, so now() is one instant and "exactly 7 days ago" is exact.
//
// The first blocks run against schema.sql. The requests of the app that is
// DEPLOYED are written out as it sends them (src/hooks/useNotifications.js,
// useClientErrors.js): a run happens while that app is live. The last block
// applies the migration file itself to the frozen production baseline, with
// the checks of its runbook page and the monthly routine of page 70 read off
// the pages.

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  asAdmin, asAnon, asService, asUser, attempt, createUser, repoRoot, scenario, scratchDatabase, seed,
} from './harness.js';
import { catalogSnapshot, diffCatalogs } from './catalog.js';
import { LEDGER, loadManifest, REFUSAL } from '../migrations/manifest.js';

const MIGRATION = '2026_10_13_18_retention';
const manifest = loadManifest();
const migration = manifest.migrations.find((m) => m.name === MIGRATION);
const read = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8');
const ADMIN_PAGE = 'docs/runbook/70-admin-procedures.md';

// ------------------------------------------------------------
// WHAT IS KEPT — every table of `public`, in one of two lists.
//
// A table that grows by itself — one row per event, of no use after a while —
// gets its DELETE in run_retention(), with its age, and its line in
// DELETED_BY_A_RUN. Every other table is kept for good, and says why in
// KEPT_FOR_GOOD. A new table joins one of the two, or the first test below
// fails: nobody decides by forgetting.
// ------------------------------------------------------------
const DELETED_BY_A_RUN = {
  scheduled_pushes: '7 days after it was written — never one that is still to be sent',
  notifications: '90 days after its recipient read it — never one that was not read',
  client_errors: '90 days after it was reported',
};
const KEPT_FOR_GOOD = {
  profiles: 'an account',
  students: 'who coaches whom',
  programs: 'a block: training that was planned, and trained',
  weeks: 'part of a block',
  sessions: 'part of a block',
  exercise_slots: 'part of a block',
  set_logs: 'what an athlete trained — never deleted by age',
  session_confirmations: 'what an athlete trained',
  slot_comments: 'what an athlete said about what they trained',
  slot_deviations: 'what an athlete trained instead',
  set_log_videos: 'what an athlete filmed — removed by its athlete',
  exercise_library: 'the exercises of a coach — archived, not deleted',
  goals: 'what a coach set for an athlete',
  goal_progress: 'the attempts at a goal',
  bodyweight_logs: 'the series every relative strength is computed from',
  messages: 'a conversation: both sides read all of it',
  push_subscriptions: 'a device — removed by its account, and by send-push when the push service says it is gone',
};

// seed(): coach Carla with her athletes Alex (A) and Billie (B). Next to them:
//   una   an account that stopped training: nobody's athlete, no device
//   rae   an athlete for the requests that cross: those tests commit
// Alex and Rae each have a phone: an account without a device schedules no rest.
const PHONE = 'https://fcm.googleapis.com/fcm/send/alex-s-phone';
const PHONE_OF_RAE = 'https://fcm.googleapis.com/fcm/send/rae-s-phone';
const PAYLOAD = JSON.stringify({ title: 'Rest done', body: 'Time for your next set.', tag: 'rest-timer' });

let ids;
let una;
let rae;

beforeAll(async () => {
  ids = await seed();
  una = await createUser({ email: 'una@sl.test', fullName: 'Una Gone' });
  rae = await createUser({ email: 'rae@sl.test', fullName: 'Rae Racer', coach: ids.coach });
  await asAdmin(async (q) => {
    for (const [user, endpoint] of [[ids.studentA, PHONE], [rae, PHONE_OF_RAE]]) {
      await q(`insert into push_subscriptions (user_id, endpoint, p256dh, auth) values ($1, $2, 'key', 'secret')`, [user.id, endpoint]);
    }
  }, { commit: true });
});

// ------------------------------------------------------------
// The function, and what is in the three tables
// ------------------------------------------------------------
const run = (q) => q.value(`select public.run_retention()`);
/** What a run answers. */
const ran = (pushes, lines = 0, errors = 0) => ({ scheduled_pushes: pushes, notifications: lines, client_errors: errors });
const NOTHING = ran(0);
const schedule = (c) => c.value(`select public.schedule_rest_push(60, $1)`, [PAYLOAD]);

const STATUSES = ['pending', 'sending', 'sent', 'canceled', 'failed', 'expired'];

/**
 * A rest push of `user`, put there by the owner: written `age` ago, due `due`
 * from now (negative: its time is past), `takenBack` the way the app from
 * before wave 3 does it — canceled_at, whatever the status says.
 */
const push = (q, user, { age = '0', due = '-1 hour', status = 'sent', takenBack = false } = {}) => q.value(
  `insert into public.scheduled_pushes (user_id, created_at, fire_at, status, canceled_at)
   values ($1, now() - $2::interval, now() + $3::interval, $4, case when $5 then now() - $2::interval end)
   returning id`,
  [user.id, age, due, status, takenBack],
);
/** A line of the bell of `user`: written `written` ago, read `read` ago — or never. */
const line = (q, user, { written = '0', read = null, kind = 'session_feedback' } = {}) => q.value(
  `insert into public.notifications (recipient_id, kind, created_at, read_at)
   values ($1, $2, now() - $3::interval, now() - $4::interval)
   returning id`,
  [user.id, kind, written, read],
);
/** What the app reported `age` ago, as `user` — or as an account that is gone since (null). */
const report = (q, user, age = '0') => q.value(
  `insert into public.client_errors (user_id, role, message, url, created_at)
   values ($1, $2, 'TypeError: x is undefined', '#/student', now() - $3::interval)
   returning id`,
  [user?.id ?? null, user?.role ?? null, age],
);
/** Of the rows `planted` — `{ label: id }` — the labels of the ones that are still there, in their order. */
const left = async (q, table, planted) => {
  const found = new Set(
    (await q.rows(`select id from public.${table} where id = any($1)`, [Object.values(planted)])).map((row) => row.id),
  );
  return Object.keys(planted).filter((label) => found.has(planted[label]));
};
/** `{ label: options }` → `{ label: id }`, planted in order. */
const plant = async (make, spec) => {
  const planted = {};
  for (const [label, options] of Object.entries(spec)) planted[label] = await make(options);
  return planted;
};
const tablesOfPublic = async (q) => (await q.rows(
  `select c.relname as name from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') order by 1`,
)).map((row) => row.name);

// ============================================================
// PERMANENT — the function, against schema.sql
// ============================================================
describe('what is kept, and what a run deletes', () => {
  it('every table of public is kept for good, or has its age in run_retention — a new table joins one of the two lists', () => asAdmin(async (q) => {
    expect(Object.keys(DELETED_BY_A_RUN).filter((table) => table in KEPT_FOR_GOOD)).toEqual([]);
    expect(await tablesOfPublic(q)).toEqual([...Object.keys(KEPT_FOR_GOOD), ...Object.keys(DELETED_BY_A_RUN)].sort());

    // The function names the tables of its list, and no other…
    const body = await q.value(`select prosrc from pg_proc where oid = 'public.run_retention()'::regprocedure`);
    expect([...body.matchAll(/DELETE FROM public\.(\w+)/g)].map(([, table]) => table).sort())
      .toEqual(Object.keys(DELETED_BY_A_RUN).sort());
    // …each through rows it did not have to wait for…
    expect(body.match(/FOR UPDATE SKIP LOCKED/g)).toHaveLength(Object.keys(DELETED_BY_A_RUN).length);
    // …and writes nothing else: three DELETEs, no statement put together at run time.
    expect(body.replace(/FOR UPDATE SKIP LOCKED/g, '').match(/\b(DELETE|INSERT|UPDATE|TRUNCATE|EXECUTE|PERFORM|DROP|ALTER)\b/gi))
      .toEqual(['DELETE', 'DELETE', 'DELETE']);
    // It answers one number per table of its list.
    expect(Object.keys(await run(q)).sort()).toEqual(Object.keys(DELETED_BY_A_RUN).sort());
  }));

  it('rest pushes: written more than 7 days ago they go, whatever became of them — to the second', () => scenario(async (q) => {
    const planted = {};
    for (const status of STATUSES) {
      planted[`${status}, 8 days old`] = await push(q, ids.studentA, { age: '8 days', due: '-8 days', status });
      planted[`${status}, 6 days old`] = await push(q, ids.studentA, { age: '6 days', due: '-6 days', status });
    }
    Object.assign(planted, await plant((options) => push(q, una, options), {
      'of an account that stopped training, a year old': { age: '1 year' },
      '7 days and a second old': { age: '7 days 1 second' },
      'exactly 7 days old': { age: '7 days' },
      'of a moment ago': {},
      'of a rest that is running': { status: 'pending', due: '90 seconds' },
    }));

    expect(await run(q)).toEqual(ran(8));
    expect(await left(q, 'scheduled_pushes', planted)).toEqual([
      ...STATUSES.map((status) => `${status}, 6 days old`),
      'exactly 7 days old', 'of a moment ago', 'of a rest that is running',
    ]);
  }));

  // "A migration that closes or deletes rest pushes leaves the ones that are
  // running alone" — and what is running is what claim_rest_push would still
  // hand to a sender: pending, not taken back, less than a minute late.
  it('never one that is still to be sent: a week-old row a sender could still take stays, and goes once its time has passed', () => scenario(async (q) => {
    const planted = await plant((options) => push(q, ids.studentA, { age: '8 days', ...options }), {
      'waiting for a time two days ahead': { status: 'pending', due: '2 days' },
      'waiting, 59 seconds past its time': { status: 'pending', due: '-59 seconds' },
      'waiting, a minute past its time': { status: 'pending', due: '-60 seconds' },
      'waiting, an hour past its time': { status: 'pending', due: '-1 hour' },
      'taken back by the app from before wave 3, its time two days ahead': { status: 'pending', due: '2 days', takenBack: true },
      'taken back through cancel_rest_push, its time two days ahead': { status: 'canceled', due: '2 days', takenBack: true },
      'taken by a sender that never said, its time two days ahead': { status: 'sending', due: '2 days' },
    });

    // What a sender would be answered for each, asked and undone.
    const toBeSent = [];
    for (const [label, id] of Object.entries(planted)) {
      const answered = await asService((s) => s.dryRun(`select public.claim_rest_push($1) as taken`, [id]));
      if (answered.rows[0].taken) toBeSent.push(label);
    }
    expect(toBeSent).toEqual(['waiting for a time two days ahead', 'waiting, 59 seconds past its time']);

    expect(await run(q)).toEqual(ran(5));
    expect(await left(q, 'scheduled_pushes', planted)).toEqual(toBeSent);
    // A second run changes nothing about them…
    expect(await run(q)).toEqual(NOTHING);
    // …until their time has passed.
    await q(`update public.scheduled_pushes set fire_at = now() - interval '61 seconds' where id = any($1)`,
      [toBeSent.map((label) => planted[label])]);
    expect(await run(q)).toEqual(ran(2));
    expect(await left(q, 'scheduled_pushes', planted)).toEqual([]);
  }));

  // The age is written twice: here, and in schedule_rest_push, which deletes
  // the caller's own rows when they next rest.
  it('the 7 days are those of schedule_rest_push: what the next rest of an account deletes of its own rows, a run deletes of everybody\'s', async () => {
    const closed = STATUSES.filter((status) => status !== 'pending');
    const AGES = { 'a year old': '1 year', '7 days and a second old': '7 days 1 second', 'exactly 7 days old': '7 days', '6 days old': '6 days' };
    const plantThem = async (q) => {
      const planted = {};
      for (const status of closed) {
        for (const [label, age] of Object.entries(AGES)) planted[`${status}, ${label}`] = await push(q, ids.studentA, { age, status });
      }
      return planted;
    };
    const afterARun = await scenario(async (q) => {
      const planted = await plantThem(q);
      await run(q);
      return left(q, 'scheduled_pushes', planted);
    });
    const afterTheNextRest = await scenario(async (q) => {
      const planted = await plantThem(q);
      await asUser(ids.studentA, (c) => schedule(c));
      return left(q, 'scheduled_pushes', planted);
    });
    expect(afterARun).toEqual(closed.flatMap((status) => [`${status}, exactly 7 days old`, `${status}, 6 days old`]));
    expect(afterTheNextRest).toEqual(afterARun);
  });

  it('notifications: read more than 90 days ago they go — counted from when they were READ; one that was never read stays, however old', () => scenario(async (q) => {
    const planted = await plant((options) => line(q, ids.coach, options), {
      'read 91 days ago': { written: '91 days', read: '91 days', kind: 'session_completed' },
      'read 91 days ago, a year old': { written: '1 year', read: '91 days', kind: 'program_submitted' },
      'read 90 days and a second ago': { written: '100 days', read: '90 days 1 second', kind: 'session_deviation' },
      'read exactly 90 days ago': { written: '100 days', read: '90 days' },
      'read 89 days ago, a year old': { written: '1 year', read: '89 days' },
      'read today, a year old': { written: '1 year', read: '0' },
      'never read, a year old': { written: '1 year', kind: 'session_completed' },
      'never read, of today': {},
    });
    // Whoever the line is for: an athlete, an account that stopped training.
    const others = {
      'of Alex, read 200 days ago': await line(q, ids.studentA, { written: '201 days', read: '200 days' }),
      'of Una, read 200 days ago': await line(q, una, { written: '201 days', read: '200 days' }),
      'of Una, never read, 200 days old': await line(q, una, { written: '200 days' }),
    };
    const unread = (user) => q.value(`select count(*) from public.notifications where recipient_id = $1 and read_at is null`, [user.id]);
    expect([await unread(ids.coach), await unread(una)]).toEqual([2, 1]);

    expect(await run(q)).toEqual(ran(0, 5));
    expect(await left(q, 'notifications', planted)).toEqual([
      'read exactly 90 days ago', 'read 89 days ago, a year old', 'read today, a year old',
      'never read, a year old', 'never read, of today',
    ]);
    expect(await left(q, 'notifications', others)).toEqual(['of Una, never read, 200 days old']);
    // The number on the bell is the unread lines: none of them went.
    expect([await unread(ids.coach), await unread(una)]).toEqual([2, 1]);
  }));

  it('client errors: reported more than 90 days ago they go, whoever reported them', () => scenario(async (q) => {
    const planted = {
      'of 91 days ago': await report(q, ids.studentA, '91 days'),
      'of 90 days and a second ago': await report(q, ids.studentB, '90 days 1 second'),
      'of exactly 90 days ago': await report(q, ids.studentA, '90 days'),
      'of 89 days ago': await report(q, ids.studentA, '89 days'),
      'of today': await report(q, ids.studentA),
      'of the coach, a year old': await report(q, ids.coach, '1 year'),
      'of an account that is gone since, a year old': await report(q, null, '1 year'),
      'of an account that is gone since, of today': await report(q, null),
    };
    expect(await run(q)).toEqual(ran(0, 0, 4));
    expect(await left(q, 'client_errors', planted)).toEqual([
      'of exactly 90 days ago', 'of 89 days ago', 'of today', 'of an account that is gone since, of today',
    ]);
  }));

  it('answers how many rows of each table it deleted — three times 0 when nothing is past its time, and a second run finds nothing', () => scenario(async (q) => {
    expect(await run(q)).toEqual(NOTHING);

    for (const user of [ids.studentA, ids.studentB, una]) await push(q, user, { age: '30 days' });
    await push(q, ids.studentA);
    for (const user of [ids.coach, ids.studentA]) await line(q, user, { written: '120 days', read: '100 days' });
    await line(q, ids.coach);
    await report(q, ids.studentB, '200 days');
    await report(q, ids.studentB);

    expect(await run(q)).toEqual({ scheduled_pushes: 3, notifications: 2, client_errors: 1 });
    expect(await run(q)).toEqual(NOTHING);
    expect(await q.one(
      `select (select count(*) from public.scheduled_pushes) as pushes, (select count(*) from public.notifications) as lines,
              (select count(*) from public.client_errors) as errors`,
    )).toEqual({ pushes: 1, lines: 1, errors: 1 });
  }));

  it('touches nothing else: every table that is kept has the rows it had, the oldest included', () => scenario(async (q) => {
    // Something old in the tables that are kept: training of a year ago, a message, a device, a weight.
    await q(`update public.set_logs set done = true, logged_at = now() - interval '1 year'`);
    await q(
      `insert into public.messages (sender_id, recipient_id, body, created_at, read_at)
       values ($1, $2, 'See you on Monday.', now() - interval '1 year', now() - interval '1 year')`,
      [ids.coach.id, ids.studentA.id],
    );
    await q(`update public.push_subscriptions set created_at = now() - interval '1 year', last_seen_at = now() - interval '1 year'`);
    await q(
      `insert into public.bodyweight_logs (student_id, weight_kg, logged_on, created_at)
       values ($1, 80, current_date - 365, now() - interval '1 year')`,
      [ids.studentA.id],
    );
    for (const user of [ids.studentA, una]) {
      await push(q, user, { age: '1 year' });
      await line(q, user, { written: '1 year', read: '1 year' });
      await report(q, user, '1 year');
    }

    const counts = async () => {
      const out = {};
      for (const table of await tablesOfPublic(q)) out[table] = await q.value(`select count(*) from public.${table}`);
      return out;
    };
    const only = (all, list) => Object.fromEntries(Object.keys(list).map((table) => [table, all[table]]));
    const before = await counts();
    // The tables that are kept are not empty ones.
    expect(Object.keys(KEPT_FOR_GOOD).filter((table) => before[table] > 0)).toEqual(expect.arrayContaining(
      ['profiles', 'students', 'programs', 'weeks', 'sessions', 'exercise_slots', 'set_logs', 'exercise_library', 'messages',
        'push_subscriptions', 'bodyweight_logs'],
    ));
    expect(only(before, DELETED_BY_A_RUN)).toEqual(ran(2, 2, 2));

    expect(await run(q)).toEqual(ran(2, 2, 2));
    const after = await counts();
    expect(only(after, KEPT_FOR_GOOD)).toEqual(only(before, KEPT_FOR_GOOD));
    expect(only(after, DELETED_BY_A_RUN)).toEqual(NOTHING);
    expect(await q.value(`select count(*) from public.set_logs where done and logged_at < now() - interval '90 days'`))
      .toBe(before.set_logs);
  }));
});

// ============================================================
// Who runs it
// ============================================================
describe('who runs it', () => {
  const DENIED = ['permission denied for function run_retention', '42501'];
  const refusal = async (fn) => {
    const tried = await attempt(fn);
    return tried.ok ? 'it went through' : [tried.error.message, tried.error.code];
  };
  const everything = async (q) => ({
    pushes: await plant((user) => push(q, user, { age: '8 days' }), { 'of Alex': ids.studentA, 'of Billie': ids.studentB }),
    lines: await plant((user) => line(q, user, { written: '91 days', read: '91 days' }), { 'of Alex': ids.studentA, 'of the coach': ids.coach }),
    errors: await plant((user) => report(q, user, '91 days'), { 'of Alex': ids.studentA, 'of the coach': ids.coach }),
  });
  const leftOf = async (q, planted) => ({
    pushes: await left(q, 'scheduled_pushes', planted.pushes),
    lines: await left(q, 'notifications', planted.lines),
    errors: await left(q, 'client_errors', planted.errors),
  });
  const ALL = { pushes: ['of Alex', 'of Billie'], lines: ['of Alex', 'of the coach'], errors: ['of Alex', 'of the coach'] };
  const NONE = { pushes: [], lines: [], errors: [] };

  it('the owner of the database and the service role; nobody else gets in — no session, an athlete, the coach', () => scenario(async (q) => {
    const planted = await everything(q);
    expect(await refusal(() => asAnon((c) => run(c)))).toEqual(DENIED);
    for (const user of [ids.studentA, ids.studentB, ids.coach, una]) {
      expect(await refusal(() => asUser(user, (c) => run(c))), user.email).toEqual(DENIED);
    }
    expect(await leftOf(q, planted)).toEqual(ALL);
    // What page 70 says the owner reads when the command ran as somebody else.
    expect(read(ADMIN_PAGE)).toContain(`| \`${DENIED[0]}\` | the command did not run as \`postgres\` |`);

    // The service role — asked and undone —, then the owner.
    expect((await asService((s) => s.dryRun(`select public.run_retention() as ran`))).rows[0].ran).toEqual(ran(2, 2, 2));
    expect(await leftOf(q, planted)).toEqual(ALL);
    expect(await run(q)).toEqual(ran(2, 2, 2));
    expect(await leftOf(q, planted)).toEqual(NONE);
  }));

  // SECURITY INVOKER: a grant made by mistake is not the whole table.
  it('has no right of its own: given to a signed-in user by mistake, it deletes that user\'s own rest pushes and nothing else', () => scenario(async (q) => {
    const planted = await everything(q);
    await q(`grant execute on function public.run_retention() to authenticated`);

    // The coach reads every client error, and deletes none; has no rest push.
    expect(await asUser(ids.coach, (c) => run(c))).toEqual(NOTHING);
    expect(await leftOf(q, planted)).toEqual(ALL);
    // Alex: the one row the policy "Delete own scheduled pushes" gives.
    expect(await asUser(ids.studentA, (c) => run(c))).toEqual(ran(1));
    expect(await leftOf(q, planted)).toEqual({ ...ALL, pushes: ['of Billie'] });
    // Still nobody without a session.
    expect(await refusal(() => asAnon((c) => run(c)))).toEqual(DENIED);
  }));

  it('nothing calls it: no function of public names it, and it is nobody\'s trigger', () => asAdmin(async (q) => {
    expect(await q.rows(
      `select p.oid::regprocedure::text as function from pg_proc p
        where p.pronamespace = 'public'::regnamespace and p.prosrc ~* 'run_retention'`,
    )).toEqual([]);
    expect(await q.one(
      `select p.prorettype::regtype::text as answers, p.prosecdef as runs_as_its_owner, p.proconfig as settings,
              pg_get_userbyid(p.proowner) as owner, p.pronargs as arguments,
              (select count(*) from pg_proc o where o.pronamespace = p.pronamespace and o.proname = p.proname) as of_that_name
         from pg_proc p where p.oid = 'public.run_retention()'::regprocedure`,
    )).toEqual({
      answers: 'jsonb', runs_as_its_owner: false, settings: ['search_path=public, pg_temp'], owner: 'postgres', arguments: 0, of_that_name: 1,
    });
  }));
});

// ============================================================
// A run while the app is in use
// ============================================================
// Two requests that cross: one is held open, uncommitted, while the other
// arrives.
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
/** `second` arrives while `first` is held open, and is shown to WAIT for it. */
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
/** `during` runs while `first` is held open, and must NOT wait for it: its answer, or 'it waited'. */
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

describe('a run while the app is in use: it waits for nobody', () => {
  afterEach(() => owner(async (q) => {
    await q(`delete from public.scheduled_pushes`);
    await q(`delete from public.notifications`);
    await q(`delete from public.client_errors`);
  }));

  const oldRowsOf = (q, user) => plant((make) => make(), {
    push: () => push(q, user, { age: '8 days' }),
    line: () => line(q, user, { written: '91 days', read: '91 days' }),
    error: () => report(q, user, '91 days'),
  });
  const pushes = () => asAdmin((q) => q.rows(
    `select pr.full_name as account, sp.status, sp.created_at < now() - interval '7 days' as old
       from public.scheduled_pushes sp join public.profiles pr on pr.id = sp.user_id order by 1, 3`,
  ));

  it('a row another request holds is passed over, not waited for — and goes with the next run', async () => {
    const held = await owner((q) => oldRowsOf(q, rae));
    await owner((q) => oldRowsOf(q, una));

    const during = await whileHeld({
      first: (hold) => owner(async (q) => {
        await q(`select id from public.scheduled_pushes where id = $1 for update`, [held.push]);
        await q(`select id from public.notifications where id = $1 for update`, [held.line]);
        await q(`select id from public.client_errors where id = $1 for update`, [held.error]);
        await hold();
      }),
      during: () => service((s) => run(s)),
    });
    expect(during).toEqual(ran(1, 1, 1));
    expect(await asAdmin(async (q) => [
      await left(q, 'scheduled_pushes', held), await left(q, 'notifications', held), await left(q, 'client_errors', held),
    ])).toEqual([['push'], ['line'], ['error']]);
    // What page 70 says of an answer that is smaller than its line of the audit.
    expect(read(ADMIN_PAGE)).toContain('another request held those rows at that instant');

    expect(await service((s) => run(s))).toEqual(ran(1, 1, 1));
    expect(await service((s) => run(s))).toEqual(NOTHING);
  });

  // schedule_rest_push deletes the caller's rows older than 7 days: the two
  // brooms meet on the same rows.
  it('an account that starts a rest while a run is under way waits for it, and finds its old rows gone', async () => {
    await owner(async (q) => { await push(q, rae, { age: '8 days' }); await push(q, una, { age: '8 days' }); });
    let answered;
    const scheduled = await cross({
      what: 'schedule_rest_push',
      first: (hold) => owner(async (q) => { answered = await run(q); await hold(); }),
      second: () => committed(rae, (c) => schedule(c)),
    });
    expect(answered).toEqual(ran(2));
    expect(scheduled.error?.message).toBeUndefined();
    expect(scheduled.value).toEqual({ id: expect.any(String), fire_at: expect.any(String), mode: 'edge' });
    expect(await pushes()).toEqual([{ account: 'Rae Racer', status: 'pending', old: false }]);
  });

  it('a run that starts while an account starts a rest does not wait: it leaves that account\'s rows to it and takes the others — each row goes once', async () => {
    await owner(async (q) => { await push(q, rae, { age: '8 days' }); await push(q, una, { age: '8 days' }); });
    const during = await whileHeld({
      first: (hold) => committed(rae, async (c) => { await schedule(c); await hold(); }),
      during: () => service((s) => run(s)),
    });
    expect(during).toEqual(ran(1));
    expect(await pushes()).toEqual([{ account: 'Rae Racer', status: 'pending', old: false }]);
    expect(await service((s) => run(s))).toEqual(NOTHING);
  });
});

// ============================================================
// The app that is deployed, after a run
// ============================================================
describe('the app that is deployed, after a run', () => {
  // src/hooks/useNotifications.js: the 30 most recent lines, and the count of
  // the unread ones for the number on the bell.
  const bell = (user) => asUser(user, async (c) => ({
    lines: (await c.rows(
      `select id, kind, payload, read_at, created_at from notifications
        where recipient_id = $1 order by created_at desc limit 30`,
      [user.id],
    )).map((row) => row.id),
    unread: await c.value(`select count(*) from notifications where recipient_id = $1 and read_at is null`, [user.id]),
  }));
  // src/hooks/useClientErrors.js: the 20 most recent, for a coach.
  const triage = () => asUser(ids.coach, async (c) => (await c.rows(
    `select id, user_id, role, message, url, created_at from client_errors order by created_at desc limit 20`,
  )).map((row) => row.id));

  it('the bell: an account with 30 newer lines sees what it saw; one with fewer loses the lines it read long ago — and the number on the bell does not move', () => scenario(async (q) => {
    // Alex: a line a day for 30 days, every second one read; five read a hundred days ago; two never read, 300 days old.
    for (let day = 0; day < 30; day += 1) {
      await line(q, ids.studentA, { written: `${day} days`, read: day % 2 ? `${day} days` : null });
    }
    for (let n = 0; n < 5; n += 1) await line(q, ids.studentA, { written: `${200 + n} days`, read: '100 days' });
    for (let n = 0; n < 2; n += 1) await line(q, ids.studentA, { written: `${300 + n} days` });
    // Billie: three lines.
    const ofBillie = await plant((options) => line(q, ids.studentB, options), {
      'read yesterday': { written: '2 days', read: '1 day' },
      'read 100 days ago': { written: '101 days', read: '100 days' },
      'never read, 200 days old': { written: '200 days' },
    });

    const before = { alex: await bell(ids.studentA), billie: await bell(ids.studentB) };
    expect(before.alex.lines).toHaveLength(30);
    expect([before.alex.unread, before.billie.unread]).toEqual([17, 1]);
    expect(before.billie.lines).toEqual([ofBillie['read yesterday'], ofBillie['read 100 days ago'], ofBillie['never read, 200 days old']]);

    expect(await run(q)).toEqual(ran(0, 6));

    expect(await bell(ids.studentA)).toEqual(before.alex);
    expect(await bell(ids.studentB)).toEqual({
      lines: [ofBillie['read yesterday'], ofBillie['never read, 200 days old']], unread: 1,
    });
    // A line that is opened today stays 90 days from today, however old it is.
    await asUser(ids.studentB, (c) => c(
      `update notifications set read_at = now() where id = $1 and recipient_id = $2`, [ofBillie['never read, 200 days old'], ids.studentB.id],
    ));
    expect(await run(q)).toEqual(NOTHING);
    expect((await bell(ids.studentB)).lines).toHaveLength(2);
  }));

  it('the coach\'s list of errors: the 20 most recent are what they were; a shorter list loses the ones older than 90 days', async () => {
    await scenario(async (q) => {
      for (let day = 0; day < 22; day += 1) await report(q, ids.studentA, `${day} days`);
      for (let n = 0; n < 3; n += 1) await report(q, ids.studentB, `${100 + n} days`);
      const before = await triage();
      expect(before).toHaveLength(20);
      expect(await run(q)).toEqual(ran(0, 0, 3));
      expect(await triage()).toEqual(before);
    });
    await scenario(async (q) => {
      const planted = {
        'of today': await report(q, ids.studentA),
        'of 89 days ago': await report(q, ids.studentA, '89 days'),
        'of 91 days ago': await report(q, ids.studentB, '91 days'),
        'of a year ago': await report(q, ids.coach, '1 year'),
      };
      expect(await triage()).toEqual(Object.values(planted));
      expect(await run(q)).toEqual(ran(0, 0, 2));
      expect(await triage()).toEqual([planted['of today'], planted['of 89 days ago']]);
    });
  });
});

// ============================================================
// The two pages lead somewhere
// ============================================================
describe('docs/runbook/70-admin-procedures.md and the page of migration 18', () => {
  // The anchor GitHub gives a heading.
  const anchorOf = (heading) => heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
  const linksOf = (file) => [...read(file).matchAll(/\]\(([^)#\s]*)(?:#([^)\s]+))?\)/g)].map(([, to, anchor]) => ({
    file: to ? path.join(path.dirname(file), to) : file, anchor: anchor ?? null,
  }));
  const anchorsOf = (file) => read(file).split('\n').filter((row) => /^#{1,6} /.test(row)).map((row) => anchorOf(row.replace(/^#+ /, '')));

  it.each([ADMIN_PAGE, migration.paths.runbook])('every link of %s leads to a page, and to a heading of it', (file) => {
    const links = linksOf(file);
    expect(links.length).toBeGreaterThan(3);
    const broken = links.filter((link) => !fs.existsSync(path.join(repoRoot, link.file))
      || (link.anchor && !anchorsOf(link.file).includes(link.anchor)));
    expect(broken).toEqual([]);
  });

  it('page 70 sends the owner to the page of each migration that gave him a statement to run by hand', () => {
    const page = read(ADMIN_PAGE);
    const rows = page.split('\n').map((row) => /^\| (.+?) \| (.+?) \| (.+?) \|$/.exec(row)).filter(Boolean)
      .map(([, what, where, from]) => ({ what, where, from }))
      .filter((row) => /^(\d{2}(, \d{2})*|—)$/.test(row.from));
    expect(rows.length).toBeGreaterThan(10);
    // A procedure of a migration is written on that migration's page — or, for
    // the one routine, on page 70 itself.
    const pages = manifest.migrations.map((m) => path.basename(m.paths.runbook));
    for (const row of rows.filter((r) => r.from !== '—')) {
      const linked = [...row.where.matchAll(/\]\(([^)#]*)/g)].map(([, to]) => path.basename(to)).filter(Boolean);
      const numbers = row.from.split(', ');
      expect(linked.filter((file) => !pages.includes(file)), row.what).toEqual([]);
      expect(numbers.every((n) => manifest.migrations.some((m) => m.order === Number(n))), row.what).toBe(true);
    }
    expect(rows.at(-1)).toMatchObject({ what: 'delete what nobody reads any more', from: '18' });
  });
});

// ============================================================
// The migration file, against the production baseline
// ============================================================
describe('migration 2026_10_13_18_retention', () => {
  const COACH = '00000000-0000-4000-8000-00000000c0ac';
  const ATHLETE = '00000000-0000-4000-8000-0000000000a1';
  const GONE = '00000000-0000-4000-8000-0000000000a2';
  const LINK = '00000000-0000-4000-8000-000000000101';
  const id = (kind, n) => `00000000-0000-4000-8000-0000000${kind}${String(n).padStart(2, '0')}`;
  const TO_COME = '2099_01_01_99_a_migration_to_come';

  // What production holds on the day of the migration, in small: a coach, an
  // athlete, an account that stopped training — and rows of every age.
  const PUSHES = {
    'sent a month ago, its account gone quiet': id('070', 1),
    'taken back 9 days ago': id('070', 2),
    'never sent, 10 days old': id('070', 3),
    'failed 8 days ago': id('070', 4),
    'sent 2 days ago': id('070', 5),
    'of a rest that is running': id('070', 6),
  };
  const LINES = {
    'read 200 days ago': id('080', 1),
    'read 10 days ago, 300 days old': id('080', 2),
    'never read, 300 days old': id('080', 3),
    'never read, of today': id('080', 4),
  };
  const ERRORS = {
    'of 120 days ago': id('090', 1),
    'of 100 days ago, its account gone': id('090', 2),
    'of 3 days ago': id('090', 3),
  };
  const ago = (days) => `now() - interval '${days} days'`;
  const WORLD = `
    insert into auth.users (id, email, aud, role, email_confirmed_at, raw_user_meta_data) values
      ('${COACH}',   'coach@sl.test', 'authenticated', 'authenticated', now(), '{"full_name": "Coach Carla"}'),
      ('${ATHLETE}', 'alex@sl.test',  'authenticated', 'authenticated', now(), '{"full_name": "Alex"}'),
      ('${GONE}',    'una@sl.test',   'authenticated', 'authenticated', now(), '{"full_name": "Una"}');
    BEGIN;
    SET LOCAL session_replication_role = replica;
    update public.profiles set role = 'coach' where id = '${COACH}';
    COMMIT;
    insert into public.students (id, profile_id, coach_id) values ('${LINK}', '${ATHLETE}', '${COACH}');

    insert into public.scheduled_pushes (id, user_id, created_at, fire_at, status, canceled_at, sent_at) values
      ('${PUSHES['sent a month ago, its account gone quiet']}', '${GONE}', ${ago(30)}, ${ago(30)}, 'sent', null, ${ago(30)}),
      ('${PUSHES['taken back 9 days ago']}',   '${ATHLETE}', ${ago(9)},  ${ago(9)},  'canceled', ${ago(9)}, null),
      ('${PUSHES['never sent, 10 days old']}', '${ATHLETE}', ${ago(10)}, ${ago(10)}, 'pending',  null, null),
      ('${PUSHES['failed 8 days ago']}',       '${ATHLETE}', ${ago(8)},  ${ago(8)},  'failed',   null, null),
      ('${PUSHES['sent 2 days ago']}',         '${ATHLETE}', ${ago(2)},  ${ago(2)},  'sent',     null, ${ago(2)}),
      ('${PUSHES['of a rest that is running']}', '${ATHLETE}', now(), now() + interval '10 minutes', 'pending', null, null);
    insert into public.notifications (id, recipient_id, kind, created_at, read_at) values
      ('${LINES['read 200 days ago']}',              '${ATHLETE}', 'session_feedback',  ${ago(201)}, ${ago(200)}),
      ('${LINES['read 10 days ago, 300 days old']}', '${ATHLETE}', 'session_feedback',  ${ago(300)}, ${ago(10)}),
      ('${LINES['never read, 300 days old']}',       '${COACH}',   'program_submitted', ${ago(300)}, null),
      ('${LINES['never read, of today']}',           '${COACH}',   'program_submitted', now(),       null);
    insert into public.client_errors (id, user_id, role, message, created_at) values
      ('${ERRORS['of 120 days ago']}',                   '${ATHLETE}', 'student', 'TypeError: x is undefined', ${ago(120)}),
      ('${ERRORS['of 100 days ago, its account gone']}', null,         null,      'ChunkLoadError',            ${ago(100)}),
      ('${ERRORS['of 3 days ago']}',                     '${COACH}',   'coach',   'TypeError: y is null',      ${ago(3)});
  `;

  /** The frozen baseline with that world in it and the migrations before 18 applied. */
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

  const rowsOf = async (db) => ({
    pushes: await left(db.query, 'scheduled_pushes', PUSHES),
    lines: await left(db.query, 'notifications', LINES),
    errors: await left(db.query, 'client_errors', ERRORS),
  });
  const ALL = { pushes: Object.keys(PUSHES), lines: Object.keys(LINES), errors: Object.keys(ERRORS) };
  const AFTER_A_RUN = {
    pushes: ['sent 2 days ago', 'of a rest that is running'],
    lines: ['read 10 days ago, 300 days old', 'never read, 300 days old', 'never read, of today'],
    errors: ['of 3 days ago'],
  };
  const THE_FIRST_RUN = { scheduled_pushes: 4, notifications: 1, client_errors: 2 };
  const others = (db) => db.query.one(
    `select (select count(*) from auth.users) as accounts, (select count(*) from public.profiles) as profiles,
            (select count(*) from public.students) as links,
            current_user::text as role, coalesce(current_setting('request.jwt.claims', true), '') as claims`,
  );
  const OTHERS = { accounts: 3, profiles: 3, links: 1, role: 'postgres', claims: '' };

  // The two pages, which are what the person who runs the commands reads.
  const page = read(migration.paths.runbook);
  const adminPage = read(ADMIN_PAGE);
  // The fenced blocks of a page, without the indent of the list item they stand in.
  const fences = (text, lang) => [...text.matchAll(new RegExp(`^( *)\`\`\`${lang}\\n([\\s\\S]*?)\\n\\1\`\`\`$`, 'gm'))]
    .map(([, indent, body]) => body.split('\n').map((row) => row.slice(indent.length)).join('\n'));
  const commands = fences(page, 'bash');
  const [pageCheck] = commands
    .map((command) => /^supabase db query --linked '(do \$check\$[\s\S]+\$check\$)'$/.exec(command)?.[1])
    .filter(Boolean);
  const quotedIn = (list, start) => list
    .map((command) => /^supabase db query --linked "(.+)"$/.exec(command)?.[1])
    .find((sql) => sql?.startsWith(start));
  const listKept = quotedIn(commands, 'select pr.full_name as account, sp.created_at::date as written_on');
  const takeBack = quotedIn(commands, 'update public.scheduled_pushes set status');
  // The monthly routine: its two commands.
  const routine = fences(adminPage, 'bash');
  const theRun = quotedIn(routine, 'select public.run_retention()');

  const printedAudit = async (db) => {
    const [result] = await db.readOnly(read(migration.paths.audit), 'audit');
    return Object.fromEntries(result.rows.map((row) => [row.check, row.value]));
  };
  const LINE = {
    there: 'the rows nobody reads any more are deleted by one function (run_retention, L27)',
    strangers: 'functions of that name that the migration does not know',
    who: 'who may execute it, besides its owner',
    rights: 'it runs with the rights of',
    path: 'its search_path',
    pushes: 'rest pushes',
    oldPushes: 'rest pushes created more than 7 days ago: what a run deletes',
    oldest: '… the oldest of them is from',
    keptPushes: 'rest pushes created more than 7 days ago that are still to be sent: kept',
    lines: 'notifications',
    oldLines: 'notifications read more than 90 days ago: what a run deletes',
    unread: 'notifications never read that are older than 90 days: kept',
    errors: 'client errors',
    oldErrors: 'client errors older than 90 days: what a run deletes',
    runner: 'who runs it',
  };
  const NOBODY = 'nobody by itself: the owner, once a month (pg_cron is not installed)';
  const untouched = async (db, before) => {
    expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
    expect(await db.query.value(`select count(*) from ${LEDGER} where name = $1`, [MIGRATION])).toBe(0);
  };
  const refusalOf = async (db, attemptIt = () => db.runFile(migration.paths.migration)) => {
    const before = await catalogSnapshot(db.query);
    const refused = await attempt(attemptIt);
    await untouched(db, before);
    return refused.error?.message ?? 'it ran';
  };

  it('nothing deletes those rows before; after it a run deletes what is past its time and no more; after the rollback nothing does again — and neither file deletes a row', async () => {
    const db = await production();
    expect(theRun, 'page 70 no longer gives the command that runs it').toBe('select public.run_retention()');
    expect(await rowsOf(db)).toEqual(ALL);
    // Migration 16 closed the one that had been waiting for ten days: nothing had deleted it.
    expect(await db.query.value(`select status from public.scheduled_pushes where id = $1`, [PUSHES['never sent, 10 days old']]))
      .toBe('expired');
    const NOT_THERE = 'function public.run_retention() does not exist';
    expect((await attempt(() => db.query(theRun))).error?.message).toBe(NOT_THERE);
    expect(adminPage).toContain(`| \`${NOT_THERE}\` | migration 18 is not in this database | read the ledger |`);

    await db.runFile(migration.paths.migration);
    // The file itself deletes nothing.
    expect(await rowsOf(db)).toEqual(ALL);
    expect(page).toContain('**The migration creates one function and deletes no row.**');

    // The first run, with the command of page 70.
    expect(await db.query.value(theRun)).toEqual(THE_FIRST_RUN);
    expect(await rowsOf(db)).toEqual(AFTER_A_RUN);
    expect(await db.query.value(theRun)).toEqual({ scheduled_pushes: 0, notifications: 0, client_errors: 0 });
    expect(await others(db)).toEqual(OTHERS);

    await db.runFile(migration.paths.rollback);
    // What a run deleted does not come back, and nothing else went with the function.
    expect(await rowsOf(db)).toEqual(AFTER_A_RUN);
    expect(await others(db)).toEqual(OTHERS);
    expect((await attempt(() => db.query(theRun))).error?.message).toBe(NOT_THERE);
    expect(page).toContain('**What a run deleted does not come back.**');
    expect(page).toContain('**It reopens L27**');

    // Applied again: the function is back, and finds nothing left to delete.
    await db.runFile(migration.paths.migration);
    expect(await db.query.value(theRun)).toEqual({ scheduled_pushes: 0, notifications: 0, client_errors: 0 });
    expect(await rowsOf(db)).toEqual(AFTER_A_RUN);
    await db.drop();
  });

  it('adds 1 function and signs the ledger — no table, no column, no policy, no trigger, no privilege of what was there', async () => {
    const db = await production();
    const before = await catalogSnapshot(db.query);
    await db.runFile(migration.paths.migration);
    const after = await catalogSnapshot(db.query);

    const lines = diffCatalogs(before, after, { left: 'before', right: 'after' });
    const only = (side) => lines.filter((row) => row.endsWith(`: only in ${side}`))
      .map((row) => row.slice(0, -`: only in ${side}`.length));
    const RUN = 'public.run_retention()';
    expect(only('after')).toEqual([`functions ${RUN}`]);
    expect(only('before')).toEqual([]);
    expect(lines.filter((row) => !/: only in (before|after)$/.test(row)).map((row) => /^(.*?): (\w+): /.exec(row).slice(1, 3).join(' → ')))
      .toEqual(['data rows of app_private.app_migrations → rows']);

    // Its owner and the service role, nobody else; the rights of its caller; the search_path pinned.
    expect(after.functions[RUN].privileges).toEqual(['postgres: EXECUTE', 'service_role: EXECUTE']);
    expect(after.functions[RUN].owner).toBe('postgres');
    const header = after.functions[RUN].definition.split(/\nAS /)[0];
    expect(header).toContain('\n RETURNS jsonb\n');
    expect(header).not.toContain('SECURITY DEFINER');
    expect(header).toContain(`\n SET search_path TO 'public', 'pg_temp'`);
    // The ages, as the page gives them.
    expect(after.functions[RUN].definition.match(/interval '[^']+'/g)).toEqual(
      [`interval '7 days'`, `interval '60 seconds'`, `interval '90 days'`, `interval '90 days'`],
    );

    // The ledger, as the page says it reads.
    expect(await db.query.rows(`select name from ${LEDGER} order by name`)).toHaveLength(18);
    expect(await db.query.value(`select name from ${LEDGER} order by name desc limit 1`)).toBe(MIGRATION);
    expect(page).toContain(`Expected: eighteen rows, the last one \`${MIGRATION}\`.`);
    expect(page).toContain('| Kind | required · adds 1 function; no table, no column, no policy, no trigger, and no row written or deleted |');
    await db.drop();
  });

  // The runbook page tells the person applying the file what the audit prints
  // before and after. This is that table, read off the page.
  it('its audit prints the "before" and "after" columns of the runbook page, with the same rows before and after', async () => {
    const db = await production();
    const audit = read(migration.paths.audit);
    const printed = async () => {
      const [result] = await db.readOnly(audit, 'audit');
      return result.rows.map((row) => [row.check, row.value]);
    };
    const table = page.split('\n')
      .map((row) => /^\| (\d+) \| (.+?) \| (.+?) \| (.+?) \|$/.exec(row))
      .filter(Boolean)
      .map(([, n, check, before, after]) => ({ n: Number(n), check, before, after }));
    expect(table.map((row) => row.n)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
    // Written between back-ticks: a value the page gives exactly. The others
    // are what production holds, "the same" before and after.
    const exact = table.filter((row) => /^`.+`$/.test(row.before) && /^`.+`$/.test(row.after))
      .map((row) => ({ ...row, before: row.before.slice(1, -1), after: row.after.slice(1, -1) }));
    expect(exact.map((row) => row.check)).toEqual([
      'running as', LINE.there, LINE.strangers, LINE.who, LINE.rights, LINE.path, LINE.keptPushes,
    ]);
    const held = table.filter((row) => !exact.some((e) => e.n === row.n));
    for (const row of held) expect(row.after, row.check).toMatch(/^the same /);
    const oldest = await db.query.value(
      `select created_at::date::text from public.scheduled_pushes where id = $1`, [PUSHES['sent a month ago, its account gone quiet']],
    );
    const THE_ROWS = {
      [LINE.pushes]: '6',
      [LINE.oldPushes]: '4',
      [LINE.oldest]: oldest,
      [LINE.lines]: '4, 2 of them read',
      [LINE.oldLines]: '1',
      [LINE.unread]: '1',
      [LINE.errors]: '3',
      [LINE.oldErrors]: '2',
      [LINE.runner]: NOBODY,
    };
    expect(held.map((row) => row.check)).toEqual(Object.keys(THE_ROWS));
    const onPage = (column) => table.map((row) => [row.check, exact.find((e) => e.n === row.n)?.[column] ?? THE_ROWS[row.check]]);

    expect(await printed()).toEqual(onPage('before'));
    await db.runFile(migration.paths.migration);
    expect(await printed()).toEqual(onPage('after'));
    // …and the header of the audit file says the same.
    const header = audit.split('\n').filter((row) => row.startsWith('--')).join('\n');
    for (const { check, before, after } of exact) {
      expect(header, check).toContain(check);
      expect(header).toContain(before);
      expect(header).toContain(after);
    }
    for (const { check } of held) expect(header, check).toContain(check);
    await db.runFile(migration.paths.rollback);
    expect(await printed()).toEqual(onPage('before'));

    // Where pg_cron is switched on, the last line says so.
    await db.query(`create schema cron`);
    await db.query(`create table cron.job (jobid bigserial primary key, jobname text, active boolean)`);
    expect((await printedAudit(db))[LINE.runner]).toMatch(/^pg_cron is installed: the nightly job of migration 19 once it is there/);
    expect(page).toContain('- **16** reads `pg_cron is installed: …`');
    await db.drop();
  });

  // docs/runbook/70-admin-procedures.md, "Once a month".
  it('the monthly routine of page 70 — look, run, look again — with the numbers the audit announced', async () => {
    const db = await production();
    await db.runFile(migration.paths.migration);
    // Its two commands: the audit of this migration, and the run.
    expect(routine).toEqual([
      `supabase db query --linked --file ${migration.paths.audit}`,
      `supabase db query --linked "${theRun}"`,
    ]);

    // 1. Look at what would go.
    const first = await printedAudit(db);
    expect([first[LINE.oldPushes], first[LINE.oldLines], first[LINE.oldErrors], first[LINE.keptPushes]]).toEqual(['4', '1', '2', '0']);
    expect(first[LINE.runner]).toBe(NOBODY);
    expect(adminPage).toContain('while it reads `nobody by itself: …`, this routine is the only thing that deletes those rows');
    // 2. Run it: "the numbers of lines 15, 12 and 8".
    const answer = await db.query.value(theRun);
    expect(answer).toEqual({
      client_errors: Number(first[LINE.oldErrors]),
      notifications: Number(first[LINE.oldLines]),
      scheduled_pushes: Number(first[LINE.oldPushes]),
    });
    expect(adminPage).toContain('`{"client_errors": …, "notifications": …, "scheduled_pushes": …}` — the numbers of lines 15, 12 and 8.');
    // 3. Look again: "lines 8, 12 and 15 read `0`, and lines 7, 11 and 14 are smaller by what was deleted".
    const second = await printedAudit(db);
    expect(second).toEqual({
      ...first,
      [LINE.pushes]: '2', [LINE.oldPushes]: '0', [LINE.oldest]: 'none',
      [LINE.lines]: '3, 1 of them read', [LINE.oldLines]: '0',
      [LINE.errors]: '1', [LINE.oldErrors]: '0',
    });
    expect(await rowsOf(db)).toEqual(AFTER_A_RUN);
    // A month in which nothing is past its time: three times 0.
    expect(await db.query.value(theRun)).toEqual({ scheduled_pushes: 0, notifications: 0, client_errors: 0 });
    expect(adminPage).toContain('| three times `0` | nothing was past its time | nothing |');
    await db.drop();
  });

  it('the page\'s check answers NOT THERE before and "in place" after, names what is wrong when something is — and neither writes nor deletes anything', async () => {
    const db = await production();
    expect(pageCheck, 'the page no longer gives the check').toBeTruthy();
    // Pasted between single quotes in a shell: it may not hold one.
    expect(pageCheck).not.toContain("'");
    const checked = async () => {
      const tried = await attempt(() => db.runSql(pageCheck, 'page check'));
      expect(tried.ok, 'the check must always fail: that is what undoes it').toBe(false);
      return (tried.error.cause ?? tried.error).message;
    };
    const answer = (said) => `check only, nothing was written: ${said}`;
    const IN_PLACE = answer('in place: a run deletes the rest pushes older than 7 days, the notifications read more than 90 days ago '
      + 'and the client errors older than 90 days; it keeps what is more recent, a rest push that is still to be sent and '
      + 'a notification that was never read; a signed-in user cannot run it');
    const NOT_THERE = answer('NOT THERE: the function run_retention is not in the database');

    expect(await checked()).toBe(NOT_THERE);
    expect(await rowsOf(db)).toEqual(ALL);
    expect(await others(db)).toEqual(OTHERS);

    await db.runFile(migration.paths.migration);
    expect(await checked()).toBe(IN_PLACE);
    // The check ran the function for real — and what that run deleted is back.
    expect(await rowsOf(db)).toEqual(ALL);
    expect(await others(db)).toEqual(OTHERS);
    expect(await db.query.value(`select count(*) from public.scheduled_pushes`)).toBe(6);
    // What the page says the command prints.
    expect(page).toContain(`\`${IN_PLACE}\``);
    expect(page).toContain('`… NOT THERE: the function run_retention is not in the database`');

    // Each part made wrong by hand, one at a time: the answer nobody wants.
    const RUN = 'public.run_retention()';
    const withWrong = async (change) => {
      const was = await db.query.value(`select pg_get_functiondef($1::regprocedure)`, [RUN]);
      // (A function for a replacement: `$$` in a replacement string is one `$`.)
      const wrong = change(was);
      expect(wrong).not.toBe(was);
      await db.query(wrong);
      const said = await checked();
      await db.query(was);
      expect(await checked(), 'put back').toBe(IN_PLACE);
      return said;
    };
    // Given to every signed-in user.
    await db.query(`grant execute on function ${RUN} to authenticated`);
    expect(await checked()).toBe(answer('NOT PROTECTED: a signed-in user ran the function'));
    await db.query(`revoke execute on function ${RUN} from authenticated`);
    // An age that is too short, a rest that is running, a line nobody has read.
    expect(await withWrong((was) => was.replace(`interval '7 days'`, `interval '5 days'`)))
      .toBe(answer('NOT PROTECTED: the run deleted the rest push of 6 days ago'));
    expect(await withWrong((was) => was.replace(`sp.fire_at > now() - interval '60 seconds'`, 'false')))
      .toBe(answer('NOT PROTECTED: the run deleted the rest push that is still to be sent'));
    expect(await withWrong((was) => was.replace(/WHERE n\.read_at IS NOT NULL\s+AND n\.read_at </, () => 'WHERE n.created_at <')))
      .toBe(answer('NOT PROTECTED: the run deleted the notification read 89 days ago, the notification that was never read'));
    // An age that is too long, and an answer without its numbers.
    expect(await withWrong((was) => was.replace(`ce.created_at < now() - interval '90 days'`, `ce.created_at < now() - interval '900 days'`)))
      .toBe(answer('BROKEN: the run left the client error of 91 days ago'));
    expect(await withWrong((was) => was.replace(`'scheduled_pushes', v_pushes`, `'pushes', v_pushes`)))
      .toBe(answer('BROKEN: run_retention did not answer how many rows of each table it deleted'));
    expect(page).toContain('- `… NOT PROTECTED: …` or `… BROKEN: …` — the function does not do what this page says: **roll back, and do not run it**.');

    expect(await rowsOf(db)).toEqual(ALL);
    expect(await others(db)).toEqual(OTHERS);
    await db.drop();
  });

  // Line 10 of the audit, and the section of the page that answers it.
  it('a rest push that is kept: counted by the audit, listed and taken back with the page\'s statements, and gone with the run after', async () => {
    const db = await production();
    for (const statement of [listKept, takeBack]) {
      expect(statement, 'the page no longer gives one of its statements').toBeTruthy();
      // Pasted between double quotes in a shell.
      expect(statement).not.toMatch(/["$`!\\]/);
    }
    await db.runFile(migration.paths.migration);
    // A phone whose clock is a month ahead, with the app from before wave 3:
    // a rest that "ends" in 30 days — and one more, which that app took back.
    const AHEAD = id('070', 7);
    const AHEAD_TAKEN_BACK = id('070', 8);
    await db.query(
      `insert into public.scheduled_pushes (id, user_id, created_at, fire_at, status, canceled_at) values
         ($1, $3, now() - interval '8 days', now() + interval '30 days', 'pending', null),
         ($2, $3, now() - interval '8 days', now() + interval '30 days', 'pending', now() - interval '8 days')`,
      [AHEAD, AHEAD_TAKEN_BACK, ATHLETE],
    );
    expect(await printedAudit(db)).toMatchObject({ [LINE.keptPushes]: '1', [LINE.oldPushes]: '5', [LINE.pushes]: '8' });
    expect(page).toContain('- **10** is not `0` — it does not stop the migration: [A rest push that is kept](#a-rest-push-that-is-kept).');

    // The list of the page: whose it is, when it was written, when it is due.
    const listed = await db.query.rows(listKept);
    expect(listed).toEqual([{ account: 'Alex', written_on: expect.any(String), due: expect.any(Date), rest_push_id: AHEAD }]);

    // A run leaves it alone.
    expect(await db.query.value(theRun)).toEqual({ ...THE_FIRST_RUN, scheduled_pushes: 5 });
    expect(await db.query.value(`select status from public.scheduled_pushes where id = $1`, [AHEAD])).toBe('pending');

    // Taken back with the statement of the page: it answers the id once.
    const forIt = takeBack.replace('<id of the rest push>', AHEAD);
    expect(forIt).not.toBe(takeBack);
    expect(await db.query.rows(forIt)).toEqual([{ id: AHEAD }]);
    expect(await db.query.rows(forIt)).toEqual([]);
    expect(await db.query.rows(listKept)).toEqual([]);
    expect(await printedAudit(db)).toMatchObject({ [LINE.keptPushes]: '0', [LINE.oldPushes]: '1' });
    // Nobody sends it any more, and the next run takes it.
    expect(await db.query.value(`select public.claim_rest_push($1)`, [AHEAD])).toBeNull();
    expect(await db.query.value(theRun)).toEqual({ scheduled_pushes: 1, notifications: 0, client_errors: 0 });
    expect(await rowsOf(db)).toEqual(AFTER_A_RUN);
    await db.drop();
  });

  it('without migration 17 it says so (SLM02), and its rollback says there is nothing to undo (SLM03)', async () => {
    const db = await scratchDatabase();
    await db.runFile(manifest.baseline);
    const refusals = async () => {
      const before = await catalogSnapshot(db.query);
      const refused = await attempt(() => db.runFile(migration.paths.migration));
      const undone = await attempt(() => db.runFile(migration.paths.rollback));
      expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
      return [refused.error?.code, refused.error?.message, undone.error?.code];
    };
    // Without a ledger at all, then with the ledger and the migrations before 17 only.
    const needs = 'needs 2026_10_13_17_replay_grace_window, which is not applied';
    let [code, message, undone] = await refusals();
    expect([code, undone]).toEqual([REFUSAL.predecessorMissing, REFUSAL.notApplied]);
    expect(message).toContain(needs);
    for (const earlier of manifest.migrations.slice(0, 16)) await db.runFile(earlier.paths.migration);
    expect(await db.query.value(`select name from ${LEDGER} order by name desc limit 1`)).toBe('2026_10_13_16_rest_push_scheduling');
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
    expect(page).toContain('| `must be run as postgres` |');
    await db.drop();
  });

  it('refuses to run next to a function of its name, or without a column its function is written with — and changes nothing', async () => {
    const db = await production();

    // Made by hand, without arguments: the migration would have replaced it.
    await db.query(`create function public.run_retention() returns integer language sql as 'select 1'`);
    expect(await refusalOf(db)).toContain(`migration ${MIGRATION} would not create: run_retention() is already there`);
    expect(await printedAudit(db)).toMatchObject({ [LINE.there]: 'yes', [LINE.strangers]: 'none', [LINE.path]: 'NOT SET' });
    expect(page).toContain('- **2 already reads `yes`** — read the ledger (below).');
    await db.query(`drop function public.run_retention()`);

    // With arguments: it would stay next to the new one, and a call by name may reach it.
    await db.query(`create function public.run_retention(days integer) returns integer language sql as 'select 1'`);
    expect(await refusalOf(db)).toContain(`migration ${MIGRATION} would not create: run_retention(integer) is already there`);
    expect(await printedAudit(db)).toMatchObject({ [LINE.there]: 'no', [LINE.strangers]: 'run_retention(integer)' });
    expect(page).toContain('- **3** is not `none` — **stop and report the line.**');
    expect(page).toContain('| `would not create: … is already there` |');
    await db.query(`drop function public.run_retention(integer)`);

    // A column under another name: the body would be found wrong by the first run, a month later.
    for (const [table, column] of [['notifications', 'read_at'], ['scheduled_pushes', 'canceled_at'], ['client_errors', 'created_at']]) {
      await db.query(`alter table public.${table} rename column ${column} to renamed`);
      expect(await refusalOf(db), `${table}.${column}`).toContain(
        `migration ${MIGRATION} does not find the columns its function is written with: public.${table}.${column}`,
      );
      await db.query(`alter table public.${table} rename column renamed to ${column}`);
    }
    expect(page).toContain('| `does not find the columns its function is written with: …` |');

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

  // The file reads its own result back: a copy of it that got a part wrong
  // undoes itself.
  it('a file that got a part wrong says so, and changes nothing', async () => {
    const db = await production();
    const text = read(migration.paths.migration);
    const wrong = async (changed) => {
      expect(changed).not.toBe(text);
      return refusalOf(db, () => db.runSql(changed, 'migration'));
    };
    const MEANT = `migration ${MIGRATION} did not get the function it meant: public.run_retention(): `;
    expect(await wrong(text.replace(
      'GRANT EXECUTE ON FUNCTION public.run_retention() TO service_role;', 'GRANT EXECUTE ON FUNCTION public.run_retention() TO authenticated;',
    ))).toContain(`${MEANT}a signed-in user may execute it`);
    expect(await wrong(text.replace(
      'GRANT EXECUTE ON FUNCTION public.run_retention() TO service_role;', 'REVOKE ALL ON FUNCTION public.run_retention() FROM service_role;',
    ))).toContain(`${MEANT}the service role may NOT execute it`);
    expect(await wrong(text.replace('LANGUAGE plpgsql\nSECURITY INVOKER\n', 'LANGUAGE plpgsql\nSECURITY DEFINER\n')))
      .toContain(`${MEANT}it runs as its owner`);
    expect(await wrong(text.replace('SECURITY INVOKER\nSET search_path = public, pg_temp\n', 'SECURITY INVOKER\n')))
      .toContain(`${MEANT}search_path is not public, pg_temp`);
    expect(await wrong(text.replace('CREATE FUNCTION public.run_retention()\nRETURNS jsonb\n', 'CREATE FUNCTION public.run_retention()\nRETURNS text\n')))
      .toContain(`${MEANT}it does not return jsonb`);
    expect(page).toContain('| `did not get the function it meant: …` |');
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
    // The function is still there, and still runs.
    expect(await db.query.value(theRun)).toEqual(THE_FIRST_RUN);
    expect(page).toContain('It is refused (code `SLM04`) once a later migration is in the ledger');
    await db.drop();
  });
});
