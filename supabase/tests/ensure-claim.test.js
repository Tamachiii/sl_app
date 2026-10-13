// The missing sets of a session are added by the database, and a device's
// push subscription follows the account that signs in — the database's half of
// review findings L8, P22 and P15, and what L6 needs later; added by migration
// 2026_10_13_13_ensure_claim_rpcs.
//
// Two things an account does for itself were done by the app with the rights
// row-level security gives it, and those rights do not fit:
//
//   the sets      an exercise that has fewer rows of set_logs than its number
//                 of sets is completed by the athlete's app when the session
//                 is opened — from the number of sets in its CACHE. A set the
//                 coach removed since comes back (P22). And since the app
//                 inserts prescribed sets, an athlete may insert one with the
//                 targets of their choosing (L6)
//   the device    a push subscription belongs to whoever registered it first.
//                 The next account on the same device is handed the same
//                 endpoint by the browser and may not take the row over: it
//                 never gets a notification, the first account goes on
//                 getting them there (P15)
//
// The migration adds one function for each, SECURITY DEFINER — each asks who
// calls before it does anything:
//
//   ensure_set_logs(p_session_id)   adds the missing prescribed sets of ONE
//                                   session of the caller, read from the
//                                   exercises as they are in the database;
//                                   answers how many. Marks its INSERT with
//                                   app.trusted_set_log_insert = 'on', and
//                                   takes the mark back before it returns
//   claim_push_subscription(p_endpoint, p_p256dh, p_auth, p_user_agent)
//                                   creates the endpoint, refreshes the
//                                   caller's own, or takes it over from
//                                   another account — only with the two keys
//                                   that are stored with it
//
// The first blocks run against schema.sql, as the callers there are, next to
// the requests of the app that is DEPLOYED today (src/hooks/useSetLogs.js,
// src/lib/pushNotifications.js) — the migration is applied while that app is
// live, and that app goes on with its own requests. Two requests that cross
// need two connections. The last block applies the migration file itself to
// the frozen production baseline, with the checks and the statements of its
// runbook page read off the page.

import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  asAdmin, asAnon, asService, asUser, attempt, createDraftProgram, createProgram, createUser, repoRoot,
  scenario, scratchDatabase, seed,
} from './harness.js';
import { catalogSnapshot, diffCatalogs } from './catalog.js';
import { LEDGER, loadManifest, REFUSAL } from '../migrations/manifest.js';

const MIGRATION = '2026_10_13_13_ensure_claim_rpcs';
const manifest = loadManifest();
const migration = manifest.migrations.find((m) => m.name === MIGRATION);
const read = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8');

// seed(): coach Carla with athletes Alex (A) — "Block A", active, two phases
// of two sessions, each a pull-up and a dip of 3 sets, every set in the
// database — and Billie (B), "Block B", active. Next to them:
//   past      "Past block" of Alex: approved, not active, its sets never written
//   draft     a draft Alex is writing — a draft has no set
//   olga      a second coach, with her athlete Casey and "Block C" (active)
//   una       an account nobody coaches
//   rae       an athlete of Carla for the requests that cross — "Race", active,
//             four sessions whose sets were never written. Those tests COMMIT:
//             nothing else reads her block, and the devices they register are
//             hers and Casey's, whose devices no other test counts.
let ids;
let past;
let draft;
let olga;
let casey;
let blockC;
let una;
let rae;
let race;

beforeAll(async () => {
  ids = await seed();
  past = await createProgram({ student: ids.studentA, name: 'Past block', setLogs: false });
  draft = await createDraftProgram(ids.studentA);

  olga = await createUser({ email: 'olga@sl.test', fullName: 'Coach Olga', role: 'coach' });
  casey = await createUser({ email: 'casey@sl.test', fullName: 'Casey Athlete', coach: olga });
  const row = await asAdmin((q) => q.value(
    `insert into exercise_library (coach_id, name, type, difficulty) values ($1, 'Row', 'pull', 1) returning id`,
    [olga.id],
  ), { commit: true });
  blockC = await createProgram({ student: casey, name: 'Block C', exercises: [row], active: true });

  una = await createUser({ email: 'una@sl.test', fullName: 'Una Unlinked' });

  rae = await createUser({ email: 'rae@sl.test', fullName: 'Rae Racer', coach: ids.coach });
  race = await createProgram({ student: rae, name: 'Race', sessions: 4, active: true, setLogs: false });
});

// ------------------------------------------------------------
// The two functions, and what they say
// ------------------------------------------------------------
const ensure = (as, sessionId) => as((c) => c.value(`select public.ensure_set_logs($1)`, [sessionId]));
const claim = (as, endpoint, p256dh, auth, userAgent) => as((c) => (userAgent === undefined
  ? c.value(`select public.claim_push_subscription($1, $2, $3)`, [endpoint, p256dh, auth])
  : c.value(`select public.claim_push_subscription($1, $2, $3, $4)`, [endpoint, p256dh, auth, userAgent])));

const coach = (fn, options) => asUser(ids.coach, fn, options);
const alex = (fn, options) => asUser(ids.studentA, fn, options);
const billie = (fn, options) => asUser(ids.studentB, fn, options);
const noUser = (fn) => asUser(ids.studentA, fn, { claims: { sub: null } });

const P0001 = 'P0001';
const DENIED = '42501';
const NOT_YOURS = ['not authorized', DENIED];
const RLS = (table) => new RegExp(`row-level security policy.* for table "${table}"`);

/** `[message, SQLSTATE]` of what `fn` raised — or `'it went through'`. */
const refusal = async (fn) => {
  const tried = await attempt(fn);
  return tried.ok ? 'it went through' : [tried.error.message, tried.error.code];
};

// ------------------------------------------------------------
// What is in the database
// ------------------------------------------------------------
/** Session n of Alex's block: `{ id, pullUp, dip }`, each `{ id, setLogs: [id × 3] }`. */
const sessionOfA = (n) => {
  const { id, slots: [pullUp, dip] } = ids.programA.tree.flatMap((week) => week.sessions)[n];
  return { id, pullUp, dip };
};
/** The sets of an exercise: `['1:5@20/120', '2:5@20/120 done', '4:-@-/- extra', …]` — number:target@load/rest. */
const setsOf = async (q, slotId) => (await q.rows(
  `select set_number, target_reps, target_duration_seconds, target_weight_kg, target_rest_seconds, done, is_student_added,
          failed or skipped or rpe is not null or weight_kg is not null or actual_reps is not null
            or actual_weight_kg is not null or logged_at is not null or failed_at is not null as touched
     from set_logs where exercise_slot_id = $1 order by set_number`, [slotId],
)).map((s) => `${s.set_number}:${s.target_reps ?? (s.target_duration_seconds ? `${s.target_duration_seconds}s` : '-')}`
  + `@${s.target_weight_kg ?? '-'}/${s.target_rest_seconds ?? '-'}`
  + `${s.done ? ' done' : ''}${s.is_student_added ? ' extra' : ''}${s.touched && !s.done ? ' touched' : ''}`);
const AS_PRESCRIBED = ['1:5@20/120', '2:5@20/120', '3:5@20/120'];
/** How many sets a session holds. */
const countOf = (q, sessionId) => q.value(
  `select count(*) from set_logs sl join exercise_slots es on es.id = sl.exercise_slot_id where es.session_id = $1`, [sessionId],
);
/** Where each row of a table physically is: a row that is written again moves. */
const versions = (q, table, where, params) => q.rows(`select id, ctid::text as version from ${table} where ${where} order by id`, params);
/** The sets of a session are no longer there: what a lost request of the editor, or a copy of a draft, leaves. */
const dropSets = (q, slotId, from = 1) => q(`delete from set_logs where exercise_slot_id = $1 and set_number >= $2`, [slotId, from]);
/** Who holds an endpoint, and with what. */
const deviceOf = (q, endpoint) => q.one(
  `select id, user_id, p256dh, auth, user_agent from push_subscriptions where endpoint = $1`, [endpoint],
);
const devicesSeenBy = (as) => as(async (c) => (await c.rows(`select endpoint from push_subscriptions order by endpoint`)).map((d) => d.endpoint));

// ------------------------------------------------------------
// The app that is deployed, one request per call.
// ------------------------------------------------------------
const app = {
  // hooks/useSetLogs.js, useEnsureSetLogs — which sets exist, then ONE insert
  // of the others. `slots` is what the app has in its cache: `{ id, sets,
  // reps, weight_kg, rest_seconds }`, up to fourteen days old.
  ensure: async (q, slots) => {
    const existing = await q.rows(
      `select exercise_slot_id, set_number from set_logs where exercise_slot_id = any($1)`, [slots.map((slot) => slot.id)],
    );
    const there = new Set(existing.map((log) => `${log.exercise_slot_id}-${log.set_number}`));
    const missing = slots.flatMap((slot) => Array.from({ length: slot.sets }, (_, i) => i + 1)
      .filter((n) => !there.has(`${slot.id}-${n}`))
      .map((n) => ({ slot: slot.id, n, reps: slot.reps ?? null, weight: slot.weight_kg ?? null, rest: slot.rest_seconds ?? null })));
    if (missing.length === 0) return 0;
    const inserted = await q(
      `insert into set_logs (exercise_slot_id, set_number, done, target_reps, target_duration_seconds, target_weight_kg, target_rest_seconds)
       select t.slot, t.n, false, t.reps, null, t.weight, t.rest
         from unnest($1::uuid[], $2::int[], $3::int[], $4::numeric[], $5::int[]) as t (slot, n, reps, weight, rest)`,
      [missing.map((m) => m.slot), missing.map((m) => m.n), missing.map((m) => m.reps), missing.map((m) => m.weight),
        missing.map((m) => m.rest)],
    );
    return inserted.rowCount;
  },
  // hooks/useSetLogs.js — an extra set, and a set ticked.
  addExtraSet: (q, slotId, n) => q(
    `insert into set_logs (exercise_slot_id, set_number, is_student_added, done, failed) values ($1, $2, true, false, false) returning id`,
    [slotId, n],
  ),
  tick: (q, setLogId) => q(`update set_logs set done = true, logged_at = now() where id = $1`, [setLogId]),
  // lib/offlineMutations.js — the confirmation, as the app before wave 1 sends it.
  confirm: (q, athlete, sessionId) => q(
    `insert into session_confirmations (session_id, student_id, notes, performed_on) values ($1, $2, null, current_date)
     on conflict (session_id) do update
       set student_id = excluded.student_id, notes = excluded.notes, performed_on = excluded.performed_on`, [sessionId, athlete.id],
  ),
  // The coach's editor lowers the number of sets: the count first, then the rows (hooks/useSession.js, useUpdateSlot).
  lowerSets: (q, slotId, sets) => q(`update exercise_slots set sets = $2 where id = $1`, [slotId, sets]),
  removeSetsAbove: (q, slotId, sets) => q(
    `delete from set_logs where exercise_slot_id = $1 and set_number > $2 and is_student_added = false`, [slotId, sets],
  ),
  // lib/pushNotifications.js, upsertSubscriptionRow — `.upsert(row, { onConflict: 'endpoint' })`.
  subscribe: (q, user, endpoint, p256dh, auth, userAgent = 'A browser') => q(
    `insert into push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, last_seen_at) values ($1, $2, $3, $4, $5, now())
     on conflict (endpoint) do update
       set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
           user_agent = excluded.user_agent, last_seen_at = excluded.last_seen_at
     returning id`, [user.id, endpoint, p256dh, auth, userAgent],
  ),
  // lib/pushNotifications.js, disablePush.
  unsubscribe: (q, user, endpoint) => q(`delete from push_subscriptions where user_id = $1 and endpoint = $2`, [user.id, endpoint]),
};

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

// ============================================================
// ensure_set_logs (L8, P22)
// ============================================================
// A set the function adds is the prescription of its exercise, not done, and
// nothing else. Every column of set_logs is in one of the two lists: a column
// that is added later fails the first test below until somebody decides
// whether a new set carries it — a target the coach prescribes is written
// (from the exercise), what the athlete does with a set is left to its
// default.
const WHAT_A_NEW_SET_IS = {
  written: [
    'exercise_slot_id', 'set_number', 'done',
    'target_reps', 'target_duration_seconds', 'target_weight_kg', 'target_rest_seconds',
  ],
  left: [
    'id', 'created_at',
    // what the athlete does with it
    'failed', 'skipped', 'rpe', 'weight_kg', 'actual_reps', 'actual_weight_kg', 'logged_at', 'failed_at',
    // false: an extra set is the athlete's to add, not the function's
    'is_student_added',
  ],
};

describe('ensure_set_logs: the prescribed sets that are missing in a session, added for its athlete', () => {
  it('every column of set_logs is written by the function, or left to its default on purpose', () => asAdmin(async (q) => {
    const columns = (await q.rows(
      `select attname::text as name from pg_attribute
        where attrelid = 'public.set_logs'::regclass and attnum > 0 and not attisdropped order by 1`,
    )).map((column) => column.name);
    expect(
      [...WHAT_A_NEW_SET_IS.written, ...WHAT_A_NEW_SET_IS.left].sort(),
      'a column of set_logs that WHAT_A_NEW_SET_IS does not list, or one it lists that is gone: decide whether '
      + 'ensure_set_logs writes it (supabase/migrations/README.md, "A migration that writes a set for an athlete")',
    ).toEqual(columns);

    const body = await q.value(`select pg_get_functiondef('public.ensure_set_logs(uuid)'::regprocedure)`);
    const inserts = [...body.matchAll(/INSERT INTO public\.set_logs\s*\(([^)]*)\)/g)].map((m) => m[1].split(',').map((name) => name.trim()));
    // ONE insert, between the two lines that set the mark and take it back.
    expect(inserts).toEqual([WHAT_A_NEW_SET_IS.written]);
    const marks = [...body.matchAll(/set_config\('app\.trusted_set_log_insert', '(\w+)', true\)/g)].map((m) => [m[1], m.index]);
    expect(marks.map(([value]) => value)).toEqual(['on', 'off']);
    const at = body.indexOf('INSERT INTO public.set_logs');
    expect(marks[0][1] < at && at < marks[1][1]).toBe(true);
    // …and nothing else is written while the mark is on.
    expect(body.slice(marks[0][1], marks[1][1]).match(/\b(INSERT|UPDATE|DELETE|EXECUTE)\b/g)).toEqual(['INSERT']);
  }));

  it('adds every missing set with the targets of its exercise, and touches nothing that is there', () => scenario(async (q) => {
    const { id, pullUp, dip } = sessionOfA(0);
    // Alex has done the first pull-up set; the two others were never written.
    // Since then the coach has changed the exercise: 6 reps at 22.5 kg, 90 s.
    await alex((a) => app.tick(a, pullUp.setLogs[0]));
    await dropSets(q, pullUp.id, 2);
    await q(`update exercise_slots set reps = 6, weight_kg = 22.5, rest_seconds = 90 where id = $1`, [pullUp.id]);
    // The dip is held for time, without a load, and has no set at all.
    await dropSets(q, dip.id);
    await q(`update exercise_slots set reps = null, duration_seconds = 30, weight_kg = null, rest_seconds = null where id = $1`, [dip.id]);
    const kept = await versions(q, 'set_logs', 'id = $1', [pullUp.setLogs[0]]);

    expect(await ensure(alex, id)).toBe(5);

    expect(await setsOf(q, pullUp.id)).toEqual(['1:5@20/120 done', '2:6@22.5/90', '3:6@22.5/90']);
    expect(await setsOf(q, dip.id)).toEqual(['1:30s@-/-', '2:30s@-/-', '3:30s@-/-']);
    // The set that was there is the row it was.
    expect(await versions(q, 'set_logs', 'id = $1', [pullUp.setLogs[0]])).toEqual(kept);
    // Alex's other sessions, and everybody else's, are as they were.
    expect(await countOf(q, sessionOfA(1).id)).toBe(6);
    expect(await countOf(q, ids.programB.sessions[0])).toBe(6);
    // What was added is a set like any other: the athlete ticks it.
    const added = await q.value(`select id from set_logs where exercise_slot_id = $1 and set_number = 2`, [pullUp.id]);
    expect((await alex((a) => app.tick(a, added))).rowCount).toBe(1);
  }));

  it('sent a second time, and for a session that misses nothing: it answers 0 and writes nothing', () => scenario(async (q) => {
    const { id, pullUp } = sessionOfA(0);
    const whole = await versions(q, 'set_logs', 'true');
    expect(await ensure(alex, id)).toBe(0);
    expect(await versions(q, 'set_logs', 'true')).toEqual(whole);

    await dropSets(q, pullUp.id, 3);
    expect(await ensure(alex, id)).toBe(1);
    const completed = await versions(q, 'set_logs', 'true');
    expect(await ensure(alex, id)).toBe(0);
    expect(await versions(q, 'set_logs', 'true')).toEqual(completed);
    expect(await setsOf(q, pullUp.id)).toEqual(AS_PRESCRIBED);
  }));

  // The finding (P22). The app completes a session from the exercises it has
  // in its cache; the function is given the id of the session and nothing
  // else.
  it('the number of sets is read in the database: a set the coach removed stays removed — the insert of the app brings it back', () => scenario(async (q) => {
    const { id, pullUp, dip } = sessionOfA(0);
    const cached = [pullUp, dip].map((slot) => ({ id: slot.id, sets: 3, reps: 5, weight_kg: 20, rest_seconds: 120 }));
    // The coach takes the third pull-up set away: the count, then the row.
    await coach((c) => app.lowerSets(c, pullUp.id, 2));
    expect((await coach((c) => app.removeSetsAbove(c, pullUp.id, 2))).rowCount).toBe(1);

    expect(await ensure(alex, id)).toBe(0);
    expect(await setsOf(q, pullUp.id)).toEqual(['1:5@20/120', '2:5@20/120']);

    // The app that is deployed, with the exercise as it was when it last read it.
    expect(await alex((a) => app.ensure(a, cached))).toBe(1);
    expect(await setsOf(q, pullUp.id)).toEqual(AS_PRESCRIBED);
    expect(await q.value(`select sets from exercise_slots where id = $1`, [pullUp.id])).toBe(2);
  }));

  it('an extra set of the athlete that stands on a number of the exercise is a row: nothing is added over it, nothing fails', () => scenario(async (q) => {
    const { id, pullUp } = sessionOfA(0);
    await dropSets(q, pullUp.id, 2);
    // With one set in the database, the extra set the athlete adds is number 2.
    await alex((a) => app.addExtraSet(a, pullUp.id, 2));

    expect(await ensure(alex, id)).toBe(1);
    expect(await setsOf(q, pullUp.id)).toEqual(['1:5@20/120', '2:-@-/- extra', '3:5@20/120']);
  }));

  it('for the athlete of the session only: everybody else is refused, and nothing is written', () => scenario(async (q) => {
    const { id, pullUp } = sessionOfA(0);
    await dropSets(q, pullUp.id, 2);
    const before = await versions(q, 'set_logs', 'true');
    const nothing = await q.value(`select gen_random_uuid()`);

    // Somebody else's session, the session of an athlete one coaches, and no
    // session at all: the same answer.
    for (const [who, as] of [
      ['another athlete of the same coach', billie],
      ['an athlete of another coach', (fn) => asUser(casey, fn)],
      ['the coach of the athlete', coach],
      ['another coach', (fn) => asUser(olga, fn)],
      ['an account nobody coaches', (fn) => asUser(una, fn)],
      ['a token that names no user', noUser],
    ]) {
      expect(await refusal(() => ensure(as, id)), who).toEqual(NOT_YOURS);
    }
    expect(await refusal(() => ensure(alex, nothing))).toEqual(NOT_YOURS);
    expect(await refusal(() => ensure(alex, null))).toEqual(NOT_YOURS);
    expect(await refusal(() => ensure(alex, blockC.sessions[0]))).toEqual(NOT_YOURS);
    const asked = await attempt(() => ensure(billie, id));
    expect(asked.error.detail).toBe('The session is not one of the caller\'s own.');
    expect(asked.error.hint).toBe('The sets of a session are completed for its athlete. Nothing was changed.');

    // It is the athlete's call, not the owner's: without a user id there is nobody to complete a session for.
    expect(await refusal(() => ensure(asService, id))).toEqual(NOT_YOURS);
    expect(await refusal(() => ensure(asAdmin, id))).toEqual(NOT_YOURS);
    // …and "nobody" is not the athlete of a session that has none.
    expect(await refusal(() => ensure(asService, nothing))).toEqual(NOT_YOURS);
    expect(await refusal(() => ensure(noUser, null))).toEqual(NOT_YOURS);
    // Without a session the function is not entered.
    expect(await refusal(() => ensure(asAnon, id))).toEqual(['permission denied for function ensure_set_logs', DENIED]);

    expect(await versions(q, 'set_logs', 'true')).toEqual(before);
    // The athlete, for their own session: the two that were missing.
    expect(await ensure(alex, id)).toBe(2);
  }));

  // The three questions of migration 08, asked by the function itself: it
  // runs as the owner of the tables, whom the policies do not hold.
  it('only where an athlete may write: not in a past block, a draft or a block in the trash, not in a session archived or reviewed', () => scenario(async (q) => {
    const { id, pullUp } = sessionOfA(0);
    const reviewed = sessionOfA(1);
    const archived = sessionOfA(2);
    for (const slot of [pullUp, reviewed.pullUp, archived.pullUp]) await dropSets(q, slot.id, 2);
    await q(`update sessions set reviewed_at = now() where id = $1`, [reviewed.id]);
    await q(`update sessions set archived_at = now() where id = $1`, [archived.id]);
    const before = await versions(q, 'set_logs', 'true');

    const NOT_WRITABLE = ['session_not_writable', P0001];
    const NOT_ACTIVE = ['program_not_active', P0001];
    expect(await refusal(() => ensure(alex, reviewed.id))).toEqual(NOT_WRITABLE);
    expect(await refusal(() => ensure(alex, archived.id))).toEqual(NOT_WRITABLE);
    expect(await refusal(() => ensure(alex, past.sessions[0]))).toEqual(NOT_ACTIVE);
    expect(await refusal(() => ensure(alex, draft.sessions[0]))).toEqual(NOT_ACTIVE);
    const locked = await attempt(() => ensure(alex, reviewed.id));
    expect([locked.error.detail, locked.error.hint]).toEqual(['The coach has archived or reviewed this session.', 'Nothing was changed.']);
    const closed = await attempt(() => ensure(alex, past.sessions[0]));
    expect(closed.error.detail).toBe(
      'The session belongs to a program that is not the block being trained: a past block, a draft, or a block in the trash.',
    );
    expect(await versions(q, 'set_logs', 'true')).toEqual(before);
    // A draft has no set until it is approved, and gets none here.
    expect(await countOf(q, draft.sessions[0])).toBe(0);
    expect(await countOf(q, past.sessions[0])).toBe(0);

    // The lock is the review, not the confirmation: a session the athlete has
    // confirmed is still completed, as its sets are still written.
    await alex((a) => app.confirm(a, ids.studentA, id));
    expect(await ensure(alex, id)).toBe(2);

    // The block being trained, once it is in the trash: closed like a past one.
    await q(`update programs set deleted_at = now() where id = $1`, [ids.programA.id]);
    await dropSets(q, pullUp.id, 3);
    expect(await refusal(() => ensure(alex, id))).toEqual(NOT_ACTIVE);
    expect(await setsOf(q, pullUp.id)).toEqual(['1:5@20/120', '2:5@20/120']);
  }));

  it('next to it, the app that is deployed goes on with its own insert — where an athlete may write', () => scenario(async (q) => {
    const { id, pullUp, dip } = sessionOfA(0);
    const reviewed = sessionOfA(1);
    const cached = (session) => [session.pullUp, session.dip].map((slot) => ({ id: slot.id, sets: 3, reps: 5, weight_kg: 20, rest_seconds: 120 }));
    await dropSets(q, pullUp.id, 2);
    await dropSets(q, dip.id);
    await dropSets(q, reviewed.pullUp.id, 3);
    await q(`update sessions set reviewed_at = now() where id = $1`, [reviewed.id]);

    expect(await alex((a) => app.ensure(a, cached({ pullUp, dip })))).toBe(5);
    expect(await setsOf(q, pullUp.id)).toEqual(AS_PRESCRIBED);
    expect(await countOf(q, id)).toBe(6);
    // …and is refused where the function refuses, by the policy of migration 08.
    const refused = await attempt(() => alex((a) => app.ensure(a, cached(reviewed))));
    expect(refused.error?.message).toMatch(RLS('set_logs'));
    // Both at once: whichever comes second finds nothing to add.
    expect(await ensure(alex, id)).toBe(0);
  }));
});

// ============================================================
// The mark on the rows of ensure_set_logs (what L6 needs)
// ============================================================
describe('ensure_set_logs marks its INSERT, and takes the mark back', () => {
  const SETTING = 'app.trusted_set_log_insert';
  const settingNow = (q) => q.value(`select coalesce(current_setting('${SETTING}', true), '')`);

  /** From here on, in this transaction, every set that is inserted is written down with the mark it came with. */
  async function watchInserts(q) {
    await q(`create table public.test_inserted_sets (set_number int, mark text, by uuid)`);
    await q(`create function public.test_watch_insert() returns trigger language plpgsql security definer
      set search_path = public, pg_temp as $f$
      begin
        insert into public.test_inserted_sets values (NEW.set_number, coalesce(current_setting('${SETTING}', true), ''), auth.uid());
        return NEW;
      end $f$`);
    await q(`create trigger zz_test_watch_insert before insert on public.set_logs
      for each row execute function public.test_watch_insert()`);
  }
  const watched = async (q) => (await q.rows(`select set_number, mark, by from public.test_inserted_sets order by set_number`))
    .map((seen) => [seen.set_number, seen.mark, seen.by]);

  it('the mark is on while the function inserts, off when it returns, and never on for an insert the athlete sends', () => scenario(async (q) => {
    const { id, pullUp } = sessionOfA(0);
    await dropSets(q, pullUp.id, 2);
    await watchInserts(q);
    const A = ids.studentA.id;

    // The athlete's own insert, before: no mark.
    await alex((a) => app.addExtraSet(a, pullUp.id, 4));
    expect(await watched(q)).toEqual([[4, '', A]]);

    // The same transaction, as one request of the athlete after the other.
    await alex(async (a) => {
      expect(await settingNow(a)).toBe('');
      expect(await a.value(`select public.ensure_set_logs($1)`, [id])).toBe(2);
      expect(await settingNow(a)).toBe('off');
      // …and after: no mark either.
      await app.addExtraSet(a, pullUp.id, 5);
      // A call that has nothing to add leaves no mark behind either.
      expect(await a.value(`select public.ensure_set_logs($1)`, [id])).toBe(0);
      expect(await settingNow(a)).toBe('off');
    });
    // The two rows of the function carry the mark — and the athlete's user id, like the others.
    expect(await watched(q)).toEqual([[2, 'on', A], [3, 'on', A], [4, '', A], [5, 'off', A]]);
  }));

  it('a call that fails takes the mark back with everything else, also for a caller who goes on', () => scenario(async (q) => {
    const { id, pullUp } = sessionOfA(0);
    await dropSets(q, pullUp.id, 2);
    await q(`create function public.test_refuse_third() returns trigger language plpgsql as $f$
      begin
        if NEW.set_number = 3 then raise exception 'the third set is refused'; end if;
        return NEW;
      end $f$`);
    await q(`create trigger zz_test_refuse_third before insert on public.set_logs
      for each row execute function public.test_refuse_third()`);

    await alex(async (a) => {
      expect(await refusal(() => a.value(`select public.ensure_set_logs($1)`, [id]))).toEqual(['the third set is refused', P0001]);
      expect(await settingNow(a)).not.toBe('on');
    });
    expect(await setsOf(q, pullUp.id)).toEqual(['1:5@20/120']);

    // Inside one statement: a block that catches the failure and goes on reads the setting as it was before the call.
    await q(`create function public.test_call_and_go_on(p_session uuid) returns text language plpgsql as $f$
      begin
        begin
          perform public.ensure_set_logs(p_session);
          return 'it went through';
        exception when raise_exception then
          return coalesce(current_setting('${SETTING}', true), '');
        end;
      end $f$`);
    await q(`grant execute on function public.test_call_and_go_on(uuid) to authenticated`);
    expect(await alex((a) => a.value(`select public.test_call_and_go_on($1)`, [id]))).not.toBe('on');
    expect(await setsOf(q, pullUp.id)).toEqual(['1:5@20/120']);
  }));

  // What the mark is for. The contract migration of Checkpoint Z is not
  // written yet; this is the trigger it describes, in its smallest form: an
  // INSERT of the athlete of the exercise is an extra set without targets,
  // unless it carries the mark.
  it('with a pin on the athlete\'s INSERT, a forged set comes out as an extra set and the function still adds prescribed ones', () => scenario(async (q) => {
    const { id, pullUp, dip } = sessionOfA(0);
    await dropSets(q, pullUp.id, 2);
    await q(`create function public.test_pin_insert() returns trigger language plpgsql security definer
      set search_path = public, pg_temp as $f$
      begin
        if public.student_profile_for_slot(NEW.exercise_slot_id) = auth.uid()
           and coalesce(current_setting('${SETTING}', true), '') <> 'on' then
          NEW.is_student_added        := true;
          NEW.target_reps             := null;
          NEW.target_duration_seconds := null;
          NEW.target_weight_kg        := null;
          NEW.target_rest_seconds     := null;
        end if;
        return NEW;
      end $f$`);
    await q(`create trigger zz_test_pin_insert before insert on public.set_logs
      for each row execute function public.test_pin_insert()`);
    const forge = (a, slotId, n) => a(
      `insert into set_logs (exercise_slot_id, set_number, done, target_reps, target_weight_kg, target_rest_seconds)
       values ($1, $2, false, 1, 500, 5)`, [slotId, n],
    );

    await alex(async (a) => {
      await forge(a, dip.id, 4);
      expect(await a.value(`select public.ensure_set_logs($1)`, [id])).toBe(2);
      // The mark does not outlast the call: the next forged set is held like the first.
      await forge(a, dip.id, 5);
    });
    expect(await setsOf(q, pullUp.id)).toEqual(['1:5@20/120', '2:5@20/120', '3:5@20/120']);
    expect(await setsOf(q, dip.id)).toEqual([...AS_PRESCRIBED, '4:-@-/- extra', '5:-@-/- extra']);
    // The coach's editor writes a set with its targets as before: it is not the athlete.
    await coach((c) => c(
      `insert into set_logs (exercise_slot_id, set_number, done, target_reps, target_weight_kg, target_rest_seconds)
       values ($1, 6, false, 3, 40, 180)`, [dip.id],
    ));
    expect((await setsOf(q, dip.id)).at(-1)).toBe('6:3@40/180');
  }));
});

// ============================================================
// ensure_set_logs, when requests cross
// ============================================================
describe('ensure_set_logs: two requests that cross', () => {
  const sessionOfRae = (n) => race.tree[0].sessions[n];
  const asRae = (c, sessionId) => c.value(`select public.ensure_set_logs($1)`, [sessionId]);

  // A page that mounts twice, a phone and a tablet: without ON CONFLICT the
  // second request ends on the unique key of set_logs.
  it('one session completed twice in the same instant: the second waits for the rows of the first, and adds none', async () => {
    const session = sessionOfRae(0);
    const second = await cross({
      what: 'the second call',
      first: (hold) => committed(rae, async (c) => {
        expect(await asRae(c, session.id)).toBe(6);
        await hold();
      }),
      second: () => committed(rae, (c) => asRae(c, session.id)),
    });
    expect(second.error?.message).toBeUndefined();
    expect(second.value).toBe(0);
    expect(await asAdmin((q) => countOf(q, session.id))).toBe(6);
  });

  // The number of sets is read under a lock on the exercises: the editor's
  // write of the count waits for the rows to be there, and its clean-up — the
  // editor's next request — then sees the one that is over.
  it('the coach lowers the number of sets while a call is on its way: the coach waits, and the clean-up of the editor finds the set', async () => {
    const session = sessionOfRae(1);
    const [slot] = session.slots;
    const lowered = await cross({
      what: 'the coach\'s write of the number of sets',
      first: (hold) => committed(rae, async (c) => {
        expect(await asRae(c, session.id)).toBe(6);
        await hold();
      }),
      second: () => committed(ids.coach, (c) => app.lowerSets(c, slot.id, 2)),
    });
    expect(lowered.error?.message).toBeUndefined();
    expect((await committed(ids.coach, (c) => app.removeSetsAbove(c, slot.id, 2))).rowCount).toBe(1);
    expect(await asAdmin((q) => setsOf(q, slot.id))).toEqual(['1:5@20/120', '2:5@20/120']);
  });

  it('a call that arrives while the coach lowers the number of sets waits, and adds the sets of the new number', async () => {
    const session = sessionOfRae(2);
    const [slot, other] = session.slots;
    const completed = await cross({
      what: 'the call',
      first: (hold) => committed(ids.coach, async (c) => {
        await app.lowerSets(c, slot.id, 2);
        await hold();
      }),
      second: () => committed(rae, (c) => asRae(c, session.id)),
    });
    expect(completed.error?.message).toBeUndefined();
    expect(completed.value).toBe(5);
    expect(await asAdmin((q) => setsOf(q, slot.id))).toEqual(['1:5@20/120', '2:5@20/120']);
    expect(await asAdmin((q) => setsOf(q, other.id))).toEqual(AS_PRESCRIBED);
  });
});

// ============================================================
// claim_push_subscription (P15)
// ============================================================
describe('claim_push_subscription: a device belongs to the account that is signed in on it', () => {
  const PHONE = 'https://fcm.googleapis.com/fcm/send/the-shared-phone';
  const KEYS = ['p256dh-of-the-phone', 'auth-of-the-phone'];
  const MISMATCH = ['endpoint_keys_mismatch', P0001];
  const INCOMPLETE = ['subscription_incomplete', P0001];

  it('an endpoint nobody holds is created for the caller — an athlete, a coach, an account nobody coaches', () => scenario(async (q) => {
    for (const [who, user] of [['an athlete', ids.studentA], ['a coach', ids.coach], ['an account nobody coaches', una]]) {
      const endpoint = `${PHONE}/${user.id}`;
      const answer = await claim((fn) => asUser(user, fn), endpoint, ...KEYS, 'Safari on a phone');
      const row = await deviceOf(q, endpoint);
      expect(answer, who).toEqual({ subscription_id: row.id, outcome: 'created' });
      expect(row, who).toMatchObject({ user_id: user.id, p256dh: KEYS[0], auth: KEYS[1], user_agent: 'Safari on a phone' });
      // It is theirs like one the app registered: they read it, and nobody else does.
      expect(await devicesSeenBy((fn) => asUser(user, fn))).toEqual([endpoint]);
    }
    expect(await devicesSeenBy(billie)).toEqual([]);
  }));

  it('the caller\'s own endpoint is refreshed: one row, the keys that were sent, and the user agent unless it is left out', () => scenario(async (q) => {
    const first = await claim(alex, PHONE, ...KEYS, 'Safari 17');
    await q(`update push_subscriptions set last_seen_at = now() - interval '3 days' where endpoint = $1`, [PHONE]);

    // The app, every time it is opened: the same subscription again. The user agent is left out of this call.
    expect(await claim(alex, PHONE, ...KEYS)).toEqual({ subscription_id: first.subscription_id, outcome: 'refreshed' });
    expect(await deviceOf(q, PHONE)).toMatchObject({ id: first.subscription_id, user_id: ids.studentA.id, user_agent: 'Safari 17' });
    expect(await q.value(`select last_seen_at = now() from push_subscriptions where endpoint = $1`, [PHONE])).toBe(true);

    // Its own row needs no proof: other keys and another user agent are stored.
    expect(await claim(alex, PHONE, 'new-p256dh', 'new-auth', 'Safari 18')).toMatchObject({ outcome: 'refreshed' });
    expect(await deviceOf(q, PHONE)).toMatchObject({
      id: first.subscription_id, user_id: ids.studentA.id, p256dh: 'new-p256dh', auth: 'new-auth', user_agent: 'Safari 18',
    });
    expect(await q.value(`select count(*) from push_subscriptions where endpoint = $1`, [PHONE])).toBe(1);
  }));

  // The finding. The coach has switched notifications on, on a phone; then
  // the athlete signs in on the same phone, and the browser hands the app the
  // same subscription.
  it('a device two accounts use: the app that is deployed leaves it with the first and refuses the second — the function moves it', () => scenario(async (q) => {
    const registered = (await coach((c) => app.subscribe(c, ids.coach, PHONE, ...KEYS, 'The shared phone'))).rows[0].id;

    const refused = await attempt(() => alex((a) => app.subscribe(a, ids.studentA, PHONE, ...KEYS)));
    expect(refused.error?.code).toBe(DENIED);
    expect(refused.error.message).toMatch(RLS('push_subscriptions'));
    // The phone is still the coach's: their notifications go on arriving on it, and the athlete has none.
    expect(await deviceOf(q, PHONE)).toMatchObject({ id: registered, user_id: ids.coach.id });
    expect(await devicesSeenBy(alex)).toEqual([]);

    expect(await claim(alex, PHONE, ...KEYS, 'The shared phone')).toEqual({ subscription_id: registered, outcome: 'rehomed' });
    expect(await deviceOf(q, PHONE)).toMatchObject({
      id: registered, user_id: ids.studentA.id, p256dh: KEYS[0], auth: KEYS[1], user_agent: 'The shared phone',
    });
    expect(await devicesSeenBy(alex)).toEqual([PHONE]);
    expect(await devicesSeenBy(coach)).toEqual([]);
    expect(await q.value(`select count(*) from push_subscriptions where endpoint = $1`, [PHONE])).toBe(1);

    // …and back, when the coach signs in on it again.
    expect(await claim(coach, PHONE, ...KEYS)).toEqual({ subscription_id: registered, outcome: 'rehomed' });
    expect(await deviceOf(q, PHONE)).toMatchObject({ user_id: ids.coach.id, user_agent: 'The shared phone' });
  }));

  // Somebody who has learnt the address of a device — and nothing else —
  // would send their own notifications to it, and stop its owner's.
  it('without both keys, the device of another account is not taken, and stays as it is', () => scenario(async (q) => {
    await coach((c) => app.subscribe(c, ids.coach, PHONE, ...KEYS));
    const before = await versions(q, 'push_subscriptions', 'true');

    for (const [what, p256dh, auth] of [
      ['another secret', KEYS[0], 'a guess'],
      ['another public key', 'a guess', KEYS[1]],
      ['neither', 'a guess', 'a guess'],
      ['the two keys the wrong way round', KEYS[1], KEYS[0]],
      ['the keys in another case', KEYS[0].toUpperCase(), KEYS[1].toUpperCase()],
    ]) {
      expect(await refusal(() => claim(alex, PHONE, p256dh, auth)), what).toEqual(MISMATCH);
    }
    const asked = await attempt(() => claim(alex, PHONE, KEYS[0], 'a guess'));
    expect(asked.error.detail).toBe('Another account holds this endpoint, and the keys sent are not the ones stored with it.');
    expect(asked.error.hint).toBe('A device takes a subscription over by presenting the keys it was registered with. Nothing was changed.');

    expect(await versions(q, 'push_subscriptions', 'true')).toEqual(before);
    expect(await deviceOf(q, PHONE)).toMatchObject({ user_id: ids.coach.id, p256dh: KEYS[0], auth: KEYS[1] });
    expect(await devicesSeenBy(alex)).toEqual([]);
  }));

  it('a subscription is an endpoint and its two keys: one that is missing or empty is refused, and nothing is written', () => scenario(async (q) => {
    for (const [what, args] of [
      ['no endpoint', [null, ...KEYS]],
      ['an empty endpoint', ['', ...KEYS]],
      ['a blank endpoint', ['   ', ...KEYS]],
      ['no p256dh', [PHONE, null, KEYS[1]]],
      ['an empty p256dh', [PHONE, '', KEYS[1]]],
      ['no auth', [PHONE, KEYS[0], null]],
      ['a blank auth', [PHONE, KEYS[0], ' ']],
    ]) {
      expect(await refusal(() => claim(alex, ...args)), what).toEqual(INCOMPLETE);
    }
    const asked = await attempt(() => claim(alex, PHONE, null, null));
    expect(asked.error.detail)
      .toBe('A push subscription is an endpoint and its two keys, p256dh and auth: one of the three is missing or empty.');
    expect(await q.value(`select count(*) from push_subscriptions where endpoint = $1`, [PHONE])).toBe(0);
  }));

  it('for the account that is signed in: without a user id nothing is registered, and without a session the function is not entered', () => scenario(async (q) => {
    for (const [who, as] of [['a token that names no user', noUser], ['the service role', asService], ['the owner', asAdmin]]) {
      const asked = await attempt(() => claim(as, PHONE, ...KEYS));
      expect([asked.error?.message, asked.error?.code], who).toEqual(NOT_YOURS);
      expect(asked.error.detail, who).toBe('The request carries no user id.');
    }
    expect(await refusal(() => claim(asAnon, PHONE, ...KEYS)))
      .toEqual(['permission denied for function claim_push_subscription', DENIED]);
    expect(await q.value(`select count(*) from push_subscriptions where endpoint = $1`, [PHONE])).toBe(0);
  }));

  it('next to it, the app that is deployed goes on with its own upsert and its own delete', () => scenario(async (q) => {
    const id = (await alex((a) => app.subscribe(a, ids.studentA, PHONE, ...KEYS, 'Safari 17'))).rows[0].id;
    expect((await alex((a) => app.subscribe(a, ids.studentA, PHONE, ...KEYS, 'Safari 18'))).rows[0].id).toBe(id);
    expect(await deviceOf(q, PHONE)).toMatchObject({ user_id: ids.studentA.id, user_agent: 'Safari 18' });
    // A device the function registered is switched off like one the app registered.
    const other = `${PHONE}/a-tablet`;
    await claim(alex, other, 'p256dh-of-the-tablet', 'auth-of-the-tablet');
    expect((await alex((a) => app.unsubscribe(a, ids.studentA, other))).rowCount).toBe(1);
    expect(await devicesSeenBy(alex)).toEqual([PHONE]);
  }));

  // Two accounts on two tabs of one browser, or the app that heals its
  // subscription while its toggle is pressed: the second request finds
  // nothing to lock, and meets the row of the first on the unique key.
  it('one new endpoint claimed twice in the same instant: the second waits, and is judged against the row of the first', async () => {
    const tablet = `${PHONE}/a-tablet-two-accounts-use`;
    const second = await cross({
      what: 'the second claim',
      first: (hold) => committed(rae, async (c) => {
        expect(await c.value(`select public.claim_push_subscription($1, $2, $3)`, [tablet, ...KEYS])).toMatchObject({ outcome: 'created' });
        await hold();
      }),
      second: () => committed(casey, (c) => c.value(`select public.claim_push_subscription($1, $2, $3)`, [tablet, ...KEYS])),
    });
    expect(second.error?.message).toBeUndefined();
    expect(second.value).toMatchObject({ outcome: 'rehomed' });
    const rows = await asAdmin((q) => q.rows(`select id, user_id from push_subscriptions where endpoint = $1`, [tablet]));
    expect(rows).toEqual([{ id: second.value.subscription_id, user_id: casey.id }]);
  });

  it('…and without the keys of the first, the second is refused once it has waited', async () => {
    const watch = `${PHONE}/a-watch`;
    const second = await cross({
      what: 'the second claim',
      first: (hold) => committed(rae, async (c) => {
        await c.value(`select public.claim_push_subscription($1, $2, $3)`, [watch, ...KEYS]);
        await hold();
      }),
      second: () => committed(casey, (c) => c.value(`select public.claim_push_subscription($1, $2, $3)`, [watch, KEYS[0], 'a guess'])),
    });
    expect([second.error?.message, second.error?.code]).toEqual(MISMATCH);
    expect(await asAdmin((q) => q.rows(`select user_id, auth from push_subscriptions where endpoint = $1`, [watch])))
      .toEqual([{ user_id: rae.id, auth: KEYS[1] }]);
  });
});

// ============================================================
// The migration file, on production as it is
// ============================================================
describe('migration 13 applied to the production baseline', () => {
  const COACH = '00000000-0000-4000-8000-00000000c0ac';
  const OLGA = '00000000-0000-4000-8000-00000000c0b0';
  const ATHLETE = '00000000-0000-4000-8000-0000000000a1';
  const SECOND = '00000000-0000-4000-8000-0000000000a2';
  const LINK = '00000000-0000-4000-8000-000000000101';
  const LINK_SECOND = '00000000-0000-4000-8000-000000000102';
  const EXERCISE = '00000000-0000-4000-8000-000000000201';
  const BLOCK = '00000000-0000-4000-8000-000000000301';
  const PAST = '00000000-0000-4000-8000-000000000302';
  const W1 = '00000000-0000-4000-8000-000000000401';
  const W9 = '00000000-0000-4000-8000-000000000409';
  const S1 = '00000000-0000-4000-8000-000000000451';
  const S2 = '00000000-0000-4000-8000-000000000452';
  const S9 = '00000000-0000-4000-8000-000000000459';
  const SLOT1 = '00000000-0000-4000-8000-000000000501';
  const SLOT2 = '00000000-0000-4000-8000-000000000502';
  const SLOT9 = '00000000-0000-4000-8000-000000000509';
  const DEVICE = '00000000-0000-4000-8000-000000000601';
  const PHONE = 'https://fcm.googleapis.com/fcm/send/the-shared-phone';
  const TO_COME = '2099_01_01_99_a_migration_to_come';

  // Two coaches and two athletes of the first one. Alex trains "Block": one
  // phase of two sessions. "One" holds a pull-up of three sets, of which the
  // first is in the database — done, with targets of its own; "Reviewed"
  // holds one of two sets that were never written, and the coach has reviewed
  // it. His "Past block" holds a session whose sets were never written
  // either. The coach has switched notifications on, on a phone that Alex
  // uses too.
  // The roles are set the way a dump restore sets them: on the baseline the
  // documented `update profiles set role = 'coach'` is undone for every
  // caller (finding P20, closed by migration 07).
  const WORLD = `
    insert into auth.users (id, email, aud, role, email_confirmed_at, raw_user_meta_data) values
      ('${COACH}',   'coach@sl.test',  'authenticated', 'authenticated', now(), '{"full_name": "Coach Carla"}'),
      ('${OLGA}',    'olga@sl.test',   'authenticated', 'authenticated', now(), '{"full_name": "Coach Olga"}'),
      ('${ATHLETE}', 'alex@sl.test',   'authenticated', 'authenticated', now(), '{"full_name": "Alex"}'),
      ('${SECOND}',  'billie@sl.test', 'authenticated', 'authenticated', now(), '{"full_name": "Billie"}');
    BEGIN;
    SET LOCAL session_replication_role = replica;
    update public.profiles set role = 'coach' where id in ('${COACH}', '${OLGA}');
    COMMIT;
    insert into public.students (id, profile_id, coach_id) values
      ('${LINK}', '${ATHLETE}', '${COACH}'), ('${LINK_SECOND}', '${SECOND}', '${COACH}');
    insert into public.exercise_library (id, coach_id, name, type, difficulty) values ('${EXERCISE}', '${COACH}', 'Pull-up', 'pull', 2);
    insert into public.programs (id, student_id, name, is_active) values
      ('${BLOCK}', '${LINK}', 'Block', true), ('${PAST}', '${LINK}', 'Past block', false);
    insert into public.weeks (id, program_id, week_number) values ('${W1}', '${BLOCK}', 1), ('${W9}', '${PAST}', 1);
    insert into public.sessions (id, week_id, title, sort_order, reviewed_at) values
      ('${S1}', '${W1}', 'One', 0, null), ('${S2}', '${W1}', 'Reviewed', 1, now()), ('${S9}', '${W9}', 'Past', 0, null);
    insert into public.exercise_slots (id, session_id, exercise_id, sets, reps, sort_order) values
      ('${SLOT1}', '${S1}', '${EXERCISE}', 3, 5, 0), ('${SLOT2}', '${S2}', '${EXERCISE}', 2, 5, 0),
      ('${SLOT9}', '${S9}', '${EXERCISE}', 2, 5, 0);
    insert into public.set_logs (exercise_slot_id, set_number, target_reps, done, rpe, logged_at) values
      ('${SLOT1}', 1, 8, true, 8, now());
    insert into public.push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent) values
      ('${DEVICE}', '${COACH}', '${PHONE}', 'p256dh-of-the-phone', 'auth-of-the-phone', 'The shared phone');
  `;

  /** The frozen baseline with that world in it and the migrations before 13 applied. */
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
  const THE_COACH = user(COACH);
  const THE_OTHER_COACH = user(OLGA);
  const THE_ATHLETE = user(ATHLETE);
  const THE_SECOND = user(SECOND);
  const NOBODY = { role: 'anon', claims: { role: 'anon' } };
  const actor = (step) => `select set_config('role', '${step.role}', true), set_config('request.jwt.claims', '${JSON.stringify(step.claims)}', true)`;
  const story = async (db, ...steps) => {
    const statements = steps.map((step) => (typeof step === 'string' ? step : actor(step)));
    const tried = await attempt(() => db.runSql(`BEGIN;\n${statements.join(';\n')};\nROLLBACK;`, 'request'));
    if (!tried.ok) return (tried.error.cause ?? tried.error).message;
    const [found] = tried.value.at(-2).rows;
    return found ? Object.values(found)[0] : null;
  };
  /** The same, kept: a request of that user that is committed. */
  const request = (db, who, sql) => db.runSql(`BEGIN;\n${actor(who)};\n${sql};\nCOMMIT;`, 'request');

  const ensureOne = `select public.ensure_set_logs('${S1}')`;
  const claimPhone = (p256dh = 'p256dh-of-the-phone', auth = 'auth-of-the-phone') => (
    `select public.claim_push_subscription('${PHONE}', '${p256dh}', '${auth}')`);
  const setsOfOne = `select string_agg(set_number || 'x' || target_reps, ' ' order by set_number) from public.set_logs where exercise_slot_id = '${SLOT1}'`;
  const myDevices = `select count(*) from public.push_subscriptions`;

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
  const listMissingSets = quoted('select pr.full_name as athlete, p.name as block, coalesce(s.title');
  const listDevices = quoted('select pr.role, pr.full_name as account, count(ps.id) as devices');

  const printedAudit = async (db) => {
    const [result] = await db.readOnly(read(migration.paths.audit), 'audit');
    return Object.fromEntries(result.rows.map((line) => [line.check, line.value]));
  };
  const LINE = {
    ensure: 'the missing sets of a session are added by the database (ensure_set_logs, L8)',
    claim: 'a device\'s push subscription follows the account that signs in (claim_push_subscription, P15)',
    strangers: 'functions of these names that the migration does not know',
    anon: 'functions of this migration a request without a session may execute',
    users: 'functions of this migration a signed-in user may execute',
    asOwner: 'functions of this migration that run as their owner',
    missingSets: 'exercises of a session in progress that miss a set',
    devices: 'devices registered for notifications',
  };
  const THE_TWO = 'claim_push_subscription(text, text, text, text); ensure_set_logs(uuid)';
  const untouched = async (db, before) => {
    expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
    expect(await db.query.value(`select count(*) from ${LEDGER} where name = $1`, [MIGRATION])).toBe(0);
  };
  const rows = (db) => db.query.one(
    `select (select string_agg(es.sets || ' prescribed, ' || (select count(*) from public.set_logs sl where sl.exercise_slot_id = es.id) || ' there',
                               '; ' order by es.id) from public.exercise_slots es) as sets,
            (select string_agg(pr.full_name, ', ' order by pr.full_name)
               from public.push_subscriptions ps join public.profiles pr on pr.id = ps.user_id) as devices`,
  );
  const AS_IT_WAS = { sets: '3 prescribed, 1 there; 2 prescribed, 0 there; 2 prescribed, 0 there', devices: 'Coach Carla' };

  it('the two functions are not there before, are the caller\'s after, and are gone after the rollback — no row is written by either file', async () => {
    const db = await production();
    const missing = (name, args) => `function public.${name}(${args}) does not exist`;
    const allMissing = async () => {
      expect(await story(db, THE_ATHLETE, ensureOne)).toBe(missing('ensure_set_logs', 'unknown'));
      expect(await story(db, THE_ATHLETE, claimPhone())).toBe(missing('claim_push_subscription', 'unknown, unknown, unknown'));
    };
    await allMissing();

    await db.runFile(migration.paths.migration);

    // The sets of a session, for its athlete.
    expect(await story(db, THE_ATHLETE, ensureOne)).toBe(2);
    expect(await story(db, THE_ATHLETE, ensureOne, ensureOne)).toBe(0);
    expect(await story(db, THE_ATHLETE, ensureOne, setsOfOne)).toBe('1x8 2x5 3x5');
    // Everybody else, as the page says.
    for (const who of [THE_SECOND, THE_COACH, THE_OTHER_COACH]) expect(await story(db, who, ensureOne)).toBe('not authorized');
    expect(await story(db, THE_ATHLETE, `select public.ensure_set_logs('${LINK}')`)).toBe('not authorized');
    expect(await story(db, THE_ATHLETE, `select public.ensure_set_logs('${S9}')`)).toBe('program_not_active');
    expect(await story(db, THE_ATHLETE, `select public.ensure_set_logs('${S2}')`)).toBe('session_not_writable');
    expect(await story(db, NOBODY, ensureOne)).toBe('permission denied for function ensure_set_logs');

    // The phone, for the account that presents its keys.
    expect(await story(db, THE_ATHLETE, myDevices)).toBe(0);
    expect(await story(db, THE_ATHLETE, claimPhone())).toEqual({ subscription_id: DEVICE, outcome: 'rehomed' });
    expect(await story(db, THE_ATHLETE, claimPhone(), myDevices)).toBe(1);
    expect(await story(db, THE_ATHLETE, claimPhone(), THE_COACH, myDevices)).toBe(0);
    expect(await story(db, THE_COACH, claimPhone())).toEqual({ subscription_id: DEVICE, outcome: 'refreshed' });
    expect(await story(db, THE_ATHLETE, claimPhone('p256dh-of-the-phone', 'a guess'))).toBe('endpoint_keys_mismatch');
    expect(await story(db, THE_ATHLETE, claimPhone('', 'auth-of-the-phone'))).toBe('subscription_incomplete');
    expect(await story(db, NOBODY, claimPhone())).toBe('permission denied for function claim_push_subscription');
    for (const said of ['`permission denied for function ensure_set_logs` (or `claim_push_subscription`)', '| `not authorized` |',
      '| `program_not_active` |', '| `session_not_writable` |', '| `subscription_incomplete` |', '| `endpoint_keys_mismatch` |']) {
      expect(page).toContain(said);
    }

    // The app that is deployed, as the athlete: its own requests, as before.
    expect(await story(db, THE_ATHLETE,
      `insert into public.set_logs (exercise_slot_id, set_number, done, target_reps) values ('${SLOT1}', 2, false, 5), ('${SLOT1}', 3, false, 5)`,
      setsOfOne)).toBe('1x8 2x5 3x5');
    expect(await story(db, THE_ATHLETE,
      `insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values ('${ATHLETE}', '${PHONE}/own', 'k', 's')
       on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
      myDevices)).toBe(1);
    expect(await story(db, THE_ATHLETE,
      `insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values ('${ATHLETE}', '${PHONE}', 'p256dh-of-the-phone', 'auth-of-the-phone')
       on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`))
      .toMatch(/row-level security policy.* for table "push_subscriptions"/);
    // Nothing above was kept, and the migration itself touches no row.
    expect(await rows(db)).toEqual(AS_IT_WAS);

    await db.runFile(migration.paths.rollback);
    await allMissing();
    expect(await rows(db)).toEqual(AS_IT_WAS);
    await db.drop();
  });

  it('adds 2 functions and signs the ledger — no table, no column, no policy, no trigger, no privilege of what was there', async () => {
    const db = await production();
    const before = await catalogSnapshot(db.query);
    await db.runFile(migration.paths.migration);
    const after = await catalogSnapshot(db.query);

    const lines = diffCatalogs(before, after, { left: 'before', right: 'after' });
    const only = (side) => lines.filter((line) => line.endsWith(`: only in ${side}`))
      .map((line) => line.slice(0, -`: only in ${side}`.length));
    // The names of the arguments are what the API calls them by.
    const CLAIM = 'public.claim_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_user_agent text)';
    const ENSURE = 'public.ensure_set_logs(p_session_id uuid)';
    expect(only('after').sort()).toEqual([`functions ${CLAIM}`, `functions ${ENSURE}`]);
    expect(only('before')).toEqual([]);
    expect(lines.filter((line) => !/: only in (before|after)$/.test(line)).map((line) => /^(.*?): (\w+): /.exec(line).slice(1, 3).join(' → ')))
      .toEqual(['data rows of app_private.app_migrations → rows']);

    // Each of the two: its owner, the service role and a signed-in user; the
    // rights of its owner, with the search_path pinned.
    const header = (key) => after.functions[key].definition.split(/\nAS /)[0];
    for (const [key, answers] of [[CLAIM, 'jsonb'], [ENSURE, 'integer']]) {
      expect(after.functions[key].privileges, key).toEqual(['authenticated: EXECUTE', 'postgres: EXECUTE', 'service_role: EXECUTE']);
      expect(after.functions[key].owner, key).toBe('postgres');
      expect(header(key), key).toContain('\n SECURITY DEFINER\n');
      expect(header(key), key).toContain(`\n RETURNS ${answers}\n`);
      expect(header(key), key).toContain(`\n SET search_path TO 'public', 'pg_temp'`);
    }
    // What the app may leave out when it calls.
    expect(header(CLAIM)).toContain('p_auth text, p_user_agent text DEFAULT NULL::text');
    expect(header(ENSURE)).not.toContain('DEFAULT');

    // The ledger, as the page says it reads.
    expect(await db.query.rows(`select name from ${LEDGER} order by name`)).toHaveLength(13);
    expect(await db.query.value(`select name from ${LEDGER} order by name desc limit 1`)).toBe(MIGRATION);
    expect(page).toContain(`Expected: thirteen rows, the last one \`${MIGRATION}\`.`);
    expect(page).toContain('| Kind | required · expand: adds 2 functions; no table, no column, no policy, no trigger, no row |');
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
    expect(table.map((line) => line.n)).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
    // Written between back-ticks: a value the page gives exactly. The other
    // ones are sentences about what production holds.
    const exact = table.filter((line) => /^`.+`$/.test(line.before) && /^`.+`$/.test(line.after))
      .map((line) => ({ ...line, before: line.before.slice(1, -1), after: line.after.slice(1, -1) }));
    expect(table.filter((line) => !exact.some((e) => e.n === line.n)).map((line) => line.check)).toEqual([LINE.missingSets, LINE.devices]);
    const onPage = (column) => [
      ...exact.map((line) => [line.n, line.check, line[column]]),
      // The pull-up of "One": the exercises of the reviewed session and of the past block are not counted.
      [9, LINE.missingSets, '1'],
      // The coach's phone.
      [10, LINE.devices, '1'],
    ].sort((x, y) => x[0] - y[0]).map(([, check, value]) => [check, value]);

    expect(await printed()).toEqual(onPage('before'));
    await db.runFile(migration.paths.migration);
    expect(await printed()).toEqual(onPage('after'));
    expect(Object.fromEntries(await printed())).toMatchObject({ [LINE.users]: THE_TWO, [LINE.asOwner]: THE_TWO });
    // …and the header of the audit file says the same.
    const header = audit.split('\n').filter((line) => line.startsWith('--')).join('\n');
    for (const { check, before, after } of exact) {
      expect(header, check).toContain(check);
      expect(header).toContain(before);
      expect(header).toContain(after);
    }
    for (const check of [LINE.missingSets, LINE.devices]) expect(header).toContain(check);
    await db.runFile(migration.paths.rollback);
    expect(await printed()).toEqual(onPage('before'));
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
              (select count(*) from public.students) as links, (select count(*) from public.exercise_library) as exercises,
              (select count(*) from public.programs) as programs, (select count(*) from public.sessions) as sessions,
              (select count(*) from public.exercise_slots) as slots, (select count(*) from public.set_logs) as set_logs,
              (select count(*) from public.push_subscriptions) as devices,
              current_user::text as role, coalesce(current_setting('request.jwt.claims', true), '') as claims,
              coalesce(current_setting('app.trusted_set_log_insert', true), '') as mark`,
    );
    const UNTOUCHED = {
      accounts: 4, profiles: 4, links: 2, exercises: 1, programs: 2, sessions: 3, slots: 3, set_logs: 1, devices: 1,
      role: 'postgres', claims: '', mark: '',
    };
    const answer = (said) => `check only, nothing was written: ${said}`;
    const IN_PLACE = answer('in place: the missing sets of a session are added for its athlete and for nobody else, '
      + 'and a device moves to the account that presents its keys and to no other');

    expect(await checked()).toBe(answer('NOT THERE: the two functions are not in the database'));
    expect(await state()).toEqual(UNTOUCHED);

    await db.runFile(migration.paths.migration);
    expect(await checked()).toBe(IN_PLACE);
    expect(await state()).toEqual(UNTOUCHED);
    expect(await rows(db)).toEqual(AS_IT_WAS);
    // What the page says the command prints.
    expect(page).toContain(`\`${IN_PLACE}\``);
    expect(page).toContain('`… NOT THERE: the two functions are not in the database`');

    // Each function made wrong by hand, one way at a time: the answer nobody wants.
    const replace = async (signature, rewrite) => {
      const was = await db.query.value(`select pg_get_functiondef($1::regprocedure)`, [signature]);
      const wrong = typeof rewrite === 'function' ? rewrite(was) : rewrite;
      expect(wrong, `${signature}: the text to make wrong is no longer in the function`).not.toBe(was);
      await db.query(wrong);
      const said = await checked();
      await db.query(was);
      expect(await checked(), `${signature} put back`).toBe(IN_PLACE);
      return said;
    };
    const ENSURE = 'public.ensure_set_logs(uuid)';
    const CLAIM = 'public.claim_push_subscription(text, text, text, text)';
    // One that completes any session for anybody.
    expect(await replace(ENSURE, (was) => was.replace(
      'IF v_uid IS NULL OR public.student_profile_for_session(p_session_id) IS DISTINCT FROM v_uid THEN', 'IF false THEN',
    ))).toBe(answer('NOT PROTECTED: an athlete added sets to the session of another one'));
    // One that leaves its mark on.
    expect(await replace(ENSURE, (was) => was.replace(
      `PERFORM set_config('app.trusted_set_log_insert', 'off', true);`, '',
    ))).toBe(answer('BROKEN: the mark of ensure_set_logs is still on after the call'));
    // One that adds the sets it is told of, not the ones of the exercise.
    expect(await replace(ENSURE, (was) => was.replace('generate_series(1, es.sets)', 'generate_series(1, 2)')))
      .toBe(answer('BROKEN: ensure_set_logs did not add the two missing sets, once'));
    // One that writes other targets than those of the exercise.
    expect(await replace(ENSURE, (was) => was.replace('SELECT es.id, gs.n, false, es.reps,', 'SELECT es.id, gs.n, false, 1,')))
      .toBe(answer('BROKEN: after ensure_set_logs the sets are not the one that was there and the two of the exercise'));
    // One that hands a device to whoever asks.
    expect(await replace(CLAIM, (was) => was.replace('ELSIF v_p256dh = p_p256dh AND v_auth = p_auth THEN', 'ELSIF true THEN')))
      .toBe(answer('NOT PROTECTED: a device was taken over by an account that did not have its keys'));
    // One that says it moved the device, and did not.
    expect(await replace(CLAIM, (was) => was.replace('SET user_id      = v_uid,', 'SET user_id      = ps.user_id,')))
      .toBe(answer('BROKEN: after claim_push_subscription the device is not with the account that presented its keys'));
    // One that refuses to move it at all.
    expect(await replace(CLAIM, (was) => was.replace(`v_outcome := 'rehomed';`, `v_outcome := 'refreshed';`)))
      .toBe(answer('BROKEN: claim_push_subscription did not create the device, then move it'));
    expect(page).toContain('- `… NOT PROTECTED: …` or `… BROKEN: …` — a function does not do what this page says: **roll back**, and report the full message.');
    expect(await state()).toEqual(UNTOUCHED);
    await db.drop();
  });

  it('where nobody can be made a coach, the page\'s check says NOT TRIED', async () => {
    const db = await production();
    await db.runFile(migration.paths.migration);
    // Migration 07 undone by hand: the role is put back for every caller.
    await db.query(`create or replace function public.profiles_pin_immutable_columns() returns trigger
      language plpgsql set search_path = public, pg_temp as $$ begin NEW.role := OLD.role; return NEW; end $$`);
    const tried = await attempt(() => db.runSql(pageCheck, 'page check'));
    expect((tried.error.cause ?? tried.error).message)
      .toBe('check only, nothing was written: NOT TRIED: the account made for the check could not be made a coach');
    expect(page).toContain('- `… NOT TRIED: the account made for the check could not be made a coach` — migration 07 is not in the database');
    expect(await db.query.value(`select count(*) from auth.users`)).toBe(4);
    await db.drop();
  });

  // Lines 9 and 10 of the audit, and the two sections of the page that
  // answer them.
  it('what the two functions work on: counted by the audit, listed with the page\'s statements, and changed by the calls only', async () => {
    const db = await production();
    for (const statement of [listMissingSets, listDevices]) {
      expect(statement, 'the page no longer gives one of its statements').toBeTruthy();
      // Pasted between double quotes in a shell.
      expect(statement).not.toMatch(/["$`!\\]/);
    }
    const AS_FOUND = { [LINE.missingSets]: '1', [LINE.devices]: '1' };
    const MISSING = [{ athlete: 'Alex', block: 'Block', session: 'One', exercise: 'Pull-up', prescribed: 3, there: 1 }];
    const devices = async () => (await db.query.rows(listDevices)).map((d) => `${d.role} ${d.account}: ${d.devices}`);
    const WITH_THE_COACH = ['coach Coach Carla: 1', 'coach Coach Olga: 0', 'student Alex: 0', 'student Billie: 0'];
    expect(await printedAudit(db)).toMatchObject(AS_FOUND);
    expect(await db.query.rows(listMissingSets)).toEqual(MISSING);
    expect(await devices()).toEqual(WITH_THE_COACH);

    // Neither stops the migration, and the migration changes neither.
    await db.runFile(migration.paths.migration);
    expect(await printedAudit(db)).toMatchObject(AS_FOUND);
    expect(await db.query.rows(listMissingSets)).toEqual(MISSING);
    expect(await devices()).toEqual(WITH_THE_COACH);

    // Alex opens the session with the next version of the app, and switches notifications on, on the phone.
    await request(db, THE_ATHLETE, ensureOne);
    await request(db, THE_ATHLETE, claimPhone());
    expect(await printedAudit(db)).toMatchObject({ [LINE.missingSets]: '0', [LINE.devices]: '1' });
    expect(await db.query.rows(listMissingSets)).toEqual([]);
    expect(await devices()).toEqual(['coach Coach Carla: 0', 'coach Coach Olga: 0', 'student Alex: 1', 'student Billie: 0']);
    expect(await db.query.value(`select current_user::text`)).toBe('postgres');
    await db.drop();
  });

  it('without migration 12 it says so (SLM02), and its rollback says there is nothing to undo (SLM03)', async () => {
    const db = await scratchDatabase();
    await db.runFile(manifest.baseline);
    const refusals = async () => {
      const before = await catalogSnapshot(db.query);
      const refused = await attempt(() => db.runFile(migration.paths.migration));
      const undone = await attempt(() => db.runFile(migration.paths.rollback));
      expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
      return [refused.error?.code, refused.error?.message, undone.error?.code];
    };
    // Without a ledger at all, then with the ledger and the migrations before 12 only.
    const needs = 'needs 2026_10_13_12_copy_rpcs, which is not applied';
    let [code, message, undone] = await refusals();
    expect([code, undone]).toEqual([REFUSAL.predecessorMissing, REFUSAL.notApplied]);
    expect(message).toContain(needs);
    for (const earlier of manifest.migrations.slice(0, 11)) await db.runFile(earlier.paths.migration);
    expect(await db.query.value(`select name from ${LEDGER} order by name desc limit 1`)).toBe('2026_10_13_11_activate_reorder_rpcs');
    [code, message, undone] = await refusals();
    expect([code, undone]).toEqual([REFUSAL.predecessorMissing, REFUSAL.notApplied]);
    expect(message).toContain(needs);
    expect(page).toContain(`| \`${needs}\` (code \`SLM02\`) |`);
    await db.drop();
  });

  it('refuses to run as another role than postgres', async () => {
    const db = await production();
    const before = await catalogSnapshot(db.query);
    const text = read(migration.paths.migration);
    const asServiceRole = text.replace(`SET LOCAL lock_timeout = '5s';`, `SET LOCAL lock_timeout = '5s';\nSET LOCAL ROLE service_role;`);
    expect(asServiceRole).not.toBe(text);
    const refused = await attempt(() => db.runSql(asServiceRole, 'migration'));
    expect(refused.error?.message).toContain(`migration ${MIGRATION} must be run as postgres, not as service_role`);
    expect(await db.query.value(`select current_user::text`)).toBe('postgres');
    await untouched(db, before);
    await db.drop();
  });

  // The functions are created, not replaced: the API calls a function by its
  // name and the names of its arguments, and one made by hand under the same
  // name is a call that may reach the wrong one.
  it('refuses to run when a function of one of the two names is there already, and changes nothing', async () => {
    const db = await production();
    const refusalOf = async () => {
      const before = await catalogSnapshot(db.query);
      const refused = await attempt(() => db.runFile(migration.paths.migration));
      await untouched(db, before);
      return refused.error?.message ?? 'it ran';
    };

    // With other arguments: it would stay next to the new one.
    await db.query(`create function public.claim_push_subscription(p_endpoint text) returns void language sql as 'select'`);
    expect(await refusalOf()).toContain(`migration ${MIGRATION} would not create: claim_push_subscription(text) is already there`);
    expect(await printedAudit(db)).toMatchObject({ [LINE.strangers]: 'claim_push_subscription(text)', [LINE.claim]: 'no' });
    expect(page).toContain('- **4** is not `none` — **stop and report the line.**');
    await db.query(`drop function public.claim_push_subscription(text)`);

    // With the same arguments: the audit reads `yes`, and the ledger does not know why.
    await db.query(`create function public.ensure_set_logs(p_session_id uuid) returns integer language sql as 'select 0'`);
    expect(await refusalOf()).toContain(`migration ${MIGRATION} would not create: ensure_set_logs(uuid) is already there`);
    expect(await printedAudit(db)).toMatchObject({ [LINE.strangers]: 'none', [LINE.ensure]: 'yes', [LINE.claim]: 'no' });
    expect(page).toContain('If it is not, a function of that name was made by hand: stop and report.');
    expect(page).toContain('| `would not create: … is already there` |');
    await db.query(`drop function public.ensure_set_logs(uuid)`);

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
  // created: a column, a helper or a unique key that is not there would be
  // found by the first athlete who opens a session.
  it('refuses to run when a column, a helper or a unique key its functions are written with is not there', async () => {
    const db = await production();
    const refusalOf = async () => {
      const before = await catalogSnapshot(db.query);
      const refused = await attempt(() => db.runFile(migration.paths.migration));
      await untouched(db, before);
      return refused.error?.message ?? 'it ran';
    };

    await db.query(`alter table public.exercise_slots rename column sets to set_count`);
    await db.query(`alter table public.push_subscriptions rename column auth to secret`);
    expect(await refusalOf()).toContain(
      `migration ${MIGRATION} does not find the columns its functions are written with: public.exercise_slots.sets, public.push_subscriptions.auth`,
    );
    expect(page).toContain('| `does not find the columns its functions are written with: …` |');
    await db.query(`alter table public.exercise_slots rename column set_count to sets`);
    await db.query(`alter table public.push_subscriptions rename column secret to auth`);

    await db.query(`alter function public.session_writable(uuid) rename to session_open`);
    expect(await refusalOf()).toContain(
      `migration ${MIGRATION} does not find the functions its functions call: public.session_writable(uuid)`,
    );
    expect(page).toContain('| `does not find the functions its functions call: …` |');
    await db.query(`alter function public.session_open(uuid) rename to session_writable`);

    // One row per endpoint, and one per exercise and number: what ON CONFLICT is written on.
    const keyOf = (table) => db.query.value(
      `select conname from pg_constraint where conrelid = $1::regclass and contype = 'u'`, [table],
    );
    const [endpointKey, setKey] = [await keyOf('public.push_subscriptions'), await keyOf('public.set_logs')];
    await db.query(`alter table public.push_subscriptions drop constraint ${endpointKey}`);
    expect(await refusalOf()).toContain(
      `migration ${MIGRATION} does not find the unique keys its functions are written with: public.push_subscriptions (endpoint)`,
    );
    // A key that holds for some rows only, or on more columns, is not that key.
    await db.query(`alter table public.set_logs drop constraint ${setKey}`);
    await db.query(`create unique index test_some_sets on public.set_logs (exercise_slot_id, set_number) where not is_student_added`);
    await db.query(`create unique index test_wider on public.set_logs (exercise_slot_id, set_number, done)`);
    expect(await refusalOf()).toContain(
      'does not find the unique keys its functions are written with: public.push_subscriptions (endpoint); '
      + 'public.set_logs (exercise_slot_id, set_number)',
    );
    expect(page).toContain('| `does not find the unique keys its functions are written with: …` |');
    await db.query(`drop index public.test_some_sets, public.test_wider`);
    await db.query(`alter table public.set_logs add constraint ${setKey} unique (exercise_slot_id, set_number)`);
    await db.query(`alter table public.push_subscriptions add constraint ${endpointKey} unique (endpoint)`);

    await db.runFile(migration.paths.migration);
    expect(await story(db, THE_ATHLETE, ensureOne)).toBe(2);
    await db.drop();
  });

  // The privileges stand next to each function: what a new function is born
  // with is not this file's to rely on.
  it('applied where a new function is born open to everybody, the two are still closed to a request without a session', async () => {
    const db = await production();
    // Supabase's own defaults, as they were before migration 03.
    await db.query(`alter default privileges for role postgres grant execute on functions to public`);
    await db.query(`alter default privileges for role postgres in schema public grant execute on functions to anon, authenticated`);
    await db.runFile(migration.paths.migration);
    expect(await printedAudit(db)).toMatchObject({ [LINE.anon]: 'none', [LINE.users]: THE_TWO });
    expect(await story(db, NOBODY, ensureOne)).toBe('permission denied for function ensure_set_logs');
    expect(await story(db, NOBODY, claimPhone())).toBe('permission denied for function claim_push_subscription');
    await db.runFile(migration.paths.rollback);

    // … and a file that forgot one of them, or that made one run with the
    // rights of its caller, reads its own result back and undoes itself.
    const text = read(migration.paths.migration);
    const refusalOf = async (wrong) => {
      expect(wrong).not.toBe(text);
      const before = await catalogSnapshot(db.query);
      const refused = await attempt(() => db.runSql(wrong, 'migration'));
      await untouched(db, before);
      return refused.error?.message ?? 'it ran';
    };
    expect(await refusalOf(text.replace(
      'REVOKE ALL ON FUNCTION public.claim_push_subscription(text, text, text, text) FROM PUBLIC, anon, authenticated;\n', '',
    ))).toContain(
      `migration ${MIGRATION} did not get the functions it meant: public.claim_push_subscription(text, text, text, text): `
      + 'anon may execute it, PUBLIC may execute it',
    );
    expect(await refusalOf(text.replace('RETURNS integer\nLANGUAGE plpgsql\nSECURITY DEFINER', 'RETURNS integer\nLANGUAGE plpgsql\nSECURITY INVOKER')))
      .toContain(`migration ${MIGRATION} did not get the functions it meant: public.ensure_set_logs(uuid): it does not run as its owner`);
    expect(page).toContain('| `did not get the functions it meant: …` |');
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
    expect(await story(db, THE_ATHLETE, ensureOne)).toBe(2);
    await db.drop();
  });

  // What the rollback page says of what happened while the migration was in place.
  it('rolled back: the sets that were added stay, and a device stays with the account it was registered for last', async () => {
    const db = await production();
    await db.runFile(migration.paths.migration);
    await request(db, THE_ATHLETE, ensureOne);
    await request(db, THE_ATHLETE, claimPhone());
    const GIVEN = { sets: '3 prescribed, 3 there; 2 prescribed, 0 there; 2 prescribed, 0 there', devices: 'Alex' };
    expect(await rows(db)).toEqual(GIVEN);

    await db.runFile(migration.paths.rollback);
    expect(await rows(db)).toEqual(GIVEN);
    expect(await printedAudit(db)).toMatchObject({ [LINE.ensure]: 'no', [LINE.claim]: 'no', [LINE.users]: 'none', [LINE.asOwner]: 'none' });
    expect(page).toContain('the sets that were added stay, and a device stays with the account it was registered for last');

    // A function of one of the names made AFTERWARDS, with other arguments, is not the rollback's to drop.
    await db.runFile(migration.paths.migration);
    await db.query(`create function public.ensure_set_logs(p_ids uuid[]) returns integer language sql as 'select 0'`);
    await db.runFile(migration.paths.rollback);
    expect(await db.query.value(`select to_regprocedure('public.ensure_set_logs(uuid[])') is not null`)).toBe(true);
    await db.query(`drop function public.ensure_set_logs(uuid[])`);
    // …and the migration applies again on what the rollback left.
    await db.runFile(migration.paths.migration);
    expect(await story(db, THE_COACH, claimPhone())).toEqual({ subscription_id: DEVICE, outcome: 'rehomed' });
    await db.drop();
  });
});
