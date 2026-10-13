// A block is activated, and sessions and phases are reordered, in one request
// each — the database's half of review findings P16 and P51, added by
// migration 2026_10_13_11_activate_reorder_rpcs.
//
// Three things the coach does were several requests of the app, each one a
// transaction of its own:
//
//   Set active       the athlete's active program off, then the chosen one on.
//                    The second request lost: the athlete has NO block, and
//                    every set they log is refused (P16)
//   reorder          every session of a phase parked at 100000 + its place,
//                    then every one given its place — one request per session
//                    and per pass; the same for the phases of a block. One
//                    request lost: sessions left at 100000 and more, in a
//                    phase the same app can no longer reorder (P51)
//
// The migration adds one function for each, SECURITY INVOKER like
// move_session — no right the caller does not have:
//
//   activate_program(p_program_id)    the others off, this one on. Refuses a
//                                     draft and a program in the trash
//   reorder_sessions(p_week_id, p_ids)   sort_order 0 to n-1, in the order of
//                                     the list
//   reorder_weeks(p_program_id, p_ids)   week_number 1 to n
//                                     Both ask for EVERY child of the parent,
//                                     archived sessions included
//
// A function call is one statement: complete, or not at all. The first blocks
// run against schema.sql, as the callers there are, next to the requests of
// the app that is DEPLOYED today (src/hooks/useProgram.js, useWeek.js) — the
// migration is applied while that app is live, and that app goes on with its
// own requests. A request that is lost half-way is a trigger that raises on
// the write it would have made. Two requests that cross need two connections.
// The last block applies the migration file itself to the frozen production
// baseline, with the checks and the statements of its runbook page read off
// the page.

import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  asAdmin, asAnon, asService, asUser, attempt, createDraftProgram, createProgram, createUser, repoRoot,
  scenario, scratchDatabase, seed,
} from './harness.js';
import { catalogSnapshot, diffCatalogs } from './catalog.js';
import { LEDGER, loadManifest, REFUSAL } from '../migrations/manifest.js';

const MIGRATION = '2026_10_13_11_activate_reorder_rpcs';
const manifest = loadManifest();
const migration = manifest.migrations.find((m) => m.name === MIGRATION);
const read = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8');

// seed(): coach Carla with athletes Alex (A) — "Block A", active, two phases
// of two sessions — and Billie (B), "Block B", active. Next to them:
//   next      "Block A2" of Alex: approved, not active, three phases of three
//             sessions — the block the coach is preparing
//   trashed   "Old block" of Alex, in the trash
//   draft     a draft Alex is writing (one phase, two sessions)
//   olga      a second coach, with her athlete Casey and "Block C" (active)
//   rae       an athlete of Carla for the requests that cross — "Race A"
//             (active), "Race B" (two phases of three sessions), "Race C".
//             Those tests COMMIT: nothing else reads her blocks.
let ids;
let next;
let trashed;
let draft;
let olga;
let casey;
let blockC;
let rae;
let raceA;
let raceB;
let raceC;

beforeAll(async () => {
  ids = await seed();
  next = await createProgram({ student: ids.studentA, name: 'Block A2', weeks: 3, sessions: 3, sets: 1 });
  trashed = await createProgram({ student: ids.studentA, name: 'Old block', sets: 1 });
  await asAdmin((q) => q(`update programs set deleted_at = now() where id = $1`, [trashed.id]), { commit: true });
  draft = await createDraftProgram(ids.studentA, { sessions: 2 });

  olga = await createUser({ email: 'olga@sl.test', fullName: 'Coach Olga', role: 'coach' });
  casey = await createUser({ email: 'casey@sl.test', fullName: 'Casey Athlete', coach: olga });
  const row = await asAdmin((q) => q.value(
    `insert into exercise_library (coach_id, name, type, difficulty) values ($1, 'Row', 'pull', 1) returning id`,
    [olga.id],
  ), { commit: true });
  blockC = await createProgram({ student: casey, name: 'Block C', exercises: [row], sessions: 2, active: true });

  rae = await createUser({ email: 'rae@sl.test', fullName: 'Rae Racer', coach: ids.coach });
  raceA = await createProgram({ student: rae, name: 'Race A', sets: 1, active: true });
  raceB = await createProgram({ student: rae, name: 'Race B', weeks: 2, sessions: 3, sets: 1 });
  raceC = await createProgram({ student: rae, name: 'Race C', sets: 1 });
});

// ------------------------------------------------------------
// The three functions, and what they say
// ------------------------------------------------------------
const activate = (as, programId) => as((c) => c.value(`select public.activate_program($1)`, [programId]));
const reorderSessions = (as, weekId, list) => as((c) => c(`select public.reorder_sessions($1, $2)`, [weekId, list]));
const reorderWeeks = (as, programId, list) => as((c) => c(`select public.reorder_weeks($1, $2)`, [programId, list]));

const coach = (fn, options) => asUser(ids.coach, fn, options);
const alex = (fn, options) => asUser(ids.studentA, fn, options);

const P0001 = 'P0001';
const DENIED = '42501';
const MISMATCH = 'reorder_ids_mismatch';
const sessionsDetail = (has, listed, missing, foreign, twice) => `The phase has ${has} session(s), archived ones included. `
  + `The list holds ${listed} id(s): ${missing} session(s) of the phase are missing from it, `
  + `${foreign} id(s) are not sessions of this phase, ${twice} are there twice or empty.`;
const weeksDetail = (has, listed, missing, foreign, twice) => `The program has ${has} phase(s). `
  + `The list holds ${listed} id(s): ${missing} phase(s) of the program are missing from it, `
  + `${foreign} id(s) are not phases of this program, ${twice} are there twice or empty.`;

/** `[message, SQLSTATE]` of what `fn` raised — or `'it went through'`. */
const refusal = async (fn) => {
  const tried = await attempt(fn);
  return tried.ok ? 'it went through' : [tried.error.message, tried.error.code];
};

// ------------------------------------------------------------
// What is in the database
// ------------------------------------------------------------
/** The programs of an athlete that are active, by name. */
const activeOf = async (q, student) => (await q.rows(
  `select name from programs where student_id = $1 and is_active order by name`, [student.studentRowId],
)).map((p) => p.name);
/** The sessions of a phase in their order: `[[id, sort_order], …]`. */
const orderOf = async (q, weekId) => (await q.rows(
  `select id, sort_order from sessions where week_id = $1 order by sort_order, id`, [weekId],
)).map((s) => [s.id, s.sort_order]);
/** The phases of a block in their order: `[[id, week_number], …]`. */
const phasesOf = async (q, programId) => (await q.rows(
  `select id, week_number from weeks where program_id = $1 order by week_number, id`, [programId],
)).map((w) => [w.id, w.week_number]);
const numbered = (list, from = 0) => list.map((id, i) => [id, i + from]);
/** Where each row of a table physically is: a row that is written again moves. */
const versions = (q, table, where, params) => q.rows(`select id, ctid::text as version from ${table} where ${where} order by id`, params);

// ------------------------------------------------------------
// The app that is deployed (src/hooks/useProgram.js, src/hooks/useWeek.js),
// one request per call.
// ------------------------------------------------------------
const app = {
  // useSetActiveProgram, request 1 and request 2.
  switchOff: (q, studentRowId) => q(
    `update programs set is_active = false where student_id = $1 and is_active = true`, [studentRowId],
  ),
  switchOn: (q, programId) => q(`update programs set is_active = true where id = $1 returning id`, [programId]),
  // useReorderSessions / useReorderWeeks: one request per row, in two passes.
  placeSession: (q, id, n) => q(`update sessions set sort_order = $2 where id = $1`, [id, n]),
  placeWeek: (q, id, n) => q(`update weeks set week_number = $2 where id = $1`, [id, n]),
  // An athlete ticks a set (useToggleSetDone): accepted in the block being trained only.
  tick: (q, setLogId) => q(`update set_logs set done = true, logged_at = now() where id = $1`, [setLogId]),
};
const TMP_BASE = 100000;

/**
 * From here on, in this transaction, a write that fits `condition` (written
 * over OLD and NEW) is a request that never arrives: it raises. The trigger
 * goes with the scenario.
 */
const LOST = 'the connection was lost';
async function loseTheRequestThat(q, table, condition) {
  await q(`create function public.test_lost_request() returns trigger language plpgsql as $f$
    begin
      if ${condition} then raise exception '${LOST}'; end if;
      return NEW;
    end $f$`);
  await q(`create trigger zz_test_lost_request before update on public.${table}
    for each row execute function public.test_lost_request()`);
}

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
// activate_program (P16)
// ============================================================
describe('activate_program: the others off, this one on, in one statement (P16)', () => {
  it('the coach sets another block active: it is the one active block of the athlete, and the athlete trains it', () => scenario(async (q) => {
    expect(await activeOf(q, ids.studentA)).toEqual(['Block A']);

    expect(await activate(coach, next.id)).toEqual({
      program_id: next.id, student_id: ids.studentA.studentRowId, already_active: false, deactivated: 1,
    });
    expect(await activeOf(q, ids.studentA)).toEqual(['Block A2']);
    // Nobody else's block moved.
    expect(await activeOf(q, ids.studentB)).toEqual(['Block B']);
    expect(await activeOf(q, casey)).toEqual(['Block C']);

    // The athlete writes in the block that is being trained, and in no other.
    expect((await alex((a) => app.tick(a, next.setLogs[0]))).rowCount).toBe(1);
    expect((await alex((a) => app.tick(a, ids.programA.setLogs[0]))).rowCount).toBe(0);
  }));

  it('sent a second time, it says the block is active already and writes nothing', () => scenario(async (q) => {
    await activate(coach, next.id);
    const before = await versions(q, 'programs', 'student_id = $1', [ids.studentA.studentRowId]);

    expect(await activate(coach, next.id)).toEqual({
      program_id: next.id, student_id: ids.studentA.studentRowId, already_active: true, deactivated: 0,
    });
    expect(await versions(q, 'programs', 'student_id = $1', [ids.studentA.studentRowId])).toEqual(before);
    expect(await activeOf(q, ids.studentA)).toEqual(['Block A2']);
  }));

  // The finding. Each `q()` is one request, as each PostgREST call is.
  it('the app that is deployed, its second request lost: the athlete has no block and their sets are refused', () => scenario(async (q) => {
    expect((await coach((c) => app.switchOff(c, ids.studentA.studentRowId))).rowCount).toBe(1);
    // … and "switch the chosen one on" never arrives.
    expect(await activeOf(q, ids.studentA)).toEqual([]);
    expect((await alex((a) => app.tick(a, ids.programA.setLogs[0]))).rowCount).toBe(0);
    expect((await alex((a) => app.tick(a, next.setLogs[0]))).rowCount).toBe(0);
  }));

  it('a write that fails half-way: the function leaves the athlete their block, the two requests of the app do not', () => scenario(async (q) => {
    await loseTheRequestThat(q, 'programs', 'NEW.is_active and not OLD.is_active');

    // One statement: the block that was switched off is switched on again with the failure.
    expect(await refusal(() => activate(coach, next.id))).toEqual([LOST, P0001]);
    expect(await activeOf(q, ids.studentA)).toEqual(['Block A']);
    expect((await alex((a) => app.tick(a, ids.programA.setLogs[0]))).rowCount).toBe(1);

    // Two requests: the first one stays.
    await coach((c) => app.switchOff(c, ids.studentA.studentRowId));
    expect(await refusal(() => coach((c) => app.switchOn(c, next.id)))).toEqual([LOST, P0001]);
    expect(await activeOf(q, ids.studentA)).toEqual([]);
  }));

  it('refuses a draft and a block in the trash before anything is written', () => scenario(async (q) => {
    const before = await versions(q, 'programs', 'student_id = $1', [ids.studentA.studentRowId]);

    expect(await refusal(() => activate(coach, draft.id))).toEqual(['program_is_draft', P0001]);
    expect(await refusal(() => activate(coach, trashed.id))).toEqual(['program_in_trash', P0001]);
    // The author of the draft may write it — and is told the same.
    expect(await refusal(() => activate(alex, draft.id))).toEqual(['program_is_draft', P0001]);

    expect(await versions(q, 'programs', 'student_id = $1', [ids.studentA.studentRowId])).toEqual(before);
    expect(await activeOf(q, ids.studentA)).toEqual(['Block A']);

    // What the two requests of the app do with the same two blocks: the
    // draft is refused by its constraint AFTER the block in training was
    // switched off, and a block in the trash is made the active one.
    await coach((c) => app.switchOff(c, ids.studentA.studentRowId));
    const refused = await attempt(() => coach((c) => app.switchOn(c, draft.id)));
    expect(refused.error?.message).toContain('programs_draft_not_active');
    expect(await activeOf(q, ids.studentA)).toEqual([]);
    expect((await coach((c) => app.switchOn(c, trashed.id))).rowCount).toBe(1);
    expect(await activeOf(q, ids.studentA)).toEqual(['Old block']);
  }));

  it('a block in the trash that still holds the active place is switched off with the rest', () => scenario(async (q) => {
    // Left there by the two requests above, or by hand.
    await q(`update programs set is_active = false where id = $1`, [ids.programA.id]);
    await q(`update programs set is_active = true where id = $1`, [trashed.id]);

    expect(await activate(coach, next.id)).toMatchObject({ already_active: false, deactivated: 1 });
    expect(await activeOf(q, ids.studentA)).toEqual(['Block A2']);
  }));

  it('only the coach of the athlete: everybody else is refused, and nothing is written', () => scenario(async (q) => {
    const before = await versions(q, 'programs', 'true');
    const nobody = await q.value(`select gen_random_uuid()`);

    // Somebody else's athlete, and a block that does not exist: the same answer.
    for (const [who, as] of [
      ['another coach', (fn) => asUser(olga, fn)],
      ['an athlete of another coach', (fn) => asUser(casey, fn)],
      ['another athlete of the same coach', (fn) => asUser(ids.studentB, fn)],
      ['a token that names no user', (fn) => asUser(ids.coach, fn, { claims: { sub: null } })],
    ]) {
      expect(await refusal(() => activate(as, next.id)), who).toEqual(['program_not_found', P0001]);
    }
    expect(await refusal(() => activate(coach, nobody))).toEqual(['program_not_found', P0001]);
    expect(await refusal(() => activate(coach, null))).toEqual(['program_not_found', P0001]);
    expect(await refusal(() => activate(coach, blockC.id))).toEqual(['program_not_found', P0001]);

    // The athlete reads their blocks, and writes none.
    const asked = await attempt(() => activate(alex, next.id));
    expect([asked.error?.message, asked.error?.code]).toEqual(['not authorized', DENIED]);
    expect(asked.error.detail).toBe('The caller reads this program and may not write it.');
    // Their own block that is active already: no "already active" for them either.
    expect(await refusal(() => activate(alex, ids.programA.id))).toEqual(['not authorized', DENIED]);

    // Without a session the function is not entered.
    expect(await refusal(() => activate(asAnon, next.id))).toEqual(['permission denied for function activate_program', DENIED]);

    expect(await versions(q, 'programs', 'true')).toEqual(before);
  }));

  it('gives no right of its own: the owner and the service role, whom row-level security does not hold, get through', () => scenario(async (q) => {
    expect(await activate(asService, next.id)).toMatchObject({ already_active: false, deactivated: 1 });
    expect(await activeOf(q, ids.studentA)).toEqual(['Block A2']);
    expect(await activate(asAdmin, ids.programA.id)).toMatchObject({ already_active: false, deactivated: 1 });
    expect(await activeOf(q, ids.studentA)).toEqual(['Block A']);
    // The refusals are the same for them.
    expect(await refusal(() => activate(asService, draft.id))).toEqual(['program_is_draft', P0001]);
    expect(await refusal(() => activate(asAdmin, trashed.id))).toEqual(['program_in_trash', P0001]);
  }));

  // Without the lock on the athlete's programs, the second request does not
  // see the block the first one has just switched on: it switches nothing
  // off, and ends on programs_one_active_per_student.
  it('two blocks set active for one athlete in the same instant: the second waits, and both happen in turn', async () => {
    const second = await cross({
      what: 'the second activation',
      first: (hold) => committed(ids.coach, async (c) => {
        expect(await c.value(`select public.activate_program($1)`, [raceB.id])).toMatchObject({ deactivated: 1 });
        await hold();
      }),
      second: () => committed(ids.coach, (c) => c.value(`select public.activate_program($1)`, [raceC.id])),
    });
    expect(second.error?.message).toBeUndefined();
    expect(second.value).toEqual({
      program_id: raceC.id, student_id: rae.studentRowId, already_active: false, deactivated: 1,
    });
    expect(await asAdmin((q) => activeOf(q, rae))).toEqual(['Race C']);
    expect(await asAdmin((q) => q.value(`select count(*) from programs where student_id = $1`, [rae.studentRowId]))).toBe(3);
    expect(raceA.studentRowId).toBe(rae.studentRowId);
  });
});

// ============================================================
// reorder_sessions (P51)
// ============================================================
describe('reorder_sessions: the sessions of a phase in the order of a list, in one statement (P51)', () => {
  const phase = () => next.tree[0];
  const [a, b, c] = [0, 1, 2].map((i) => () => phase().sessions[i].id);

  it('the coach gives a phase a new order: 0 to n-1 in the order of the list, the other phases as they were', () => scenario(async (q) => {
    const others = await q.rows(
      `select s.id, s.week_id, s.sort_order from sessions s where s.week_id <> $1 order by s.id`, [phase().id],
    );
    expect(await orderOf(q, phase().id)).toEqual(numbered([a(), b(), c()]));

    await reorderSessions(coach, phase().id, [c(), a(), b()]);
    expect(await orderOf(q, phase().id)).toEqual(numbered([c(), a(), b()]));
    await reorderSessions(coach, phase().id, [a(), c(), b()]);
    expect(await orderOf(q, phase().id)).toEqual(numbered([a(), c(), b()]));

    expect(await q.rows(
      `select s.id, s.week_id, s.sort_order from sessions s where s.week_id <> $1 order by s.id`, [phase().id],
    )).toEqual(others);
    // The sessions are the ones they were: only their number moved.
    expect(await q.value(`select count(*) from exercise_slots where session_id = any($1)`, [[a(), b(), c()]])).toBe(6);
  }));

  it('archived sessions are part of the phase: a list without them is refused, with them they are numbered too', () => scenario(async (q) => {
    await q(`update sessions set archived_at = now() where id = $1`, [b()]);

    const without = await attempt(() => reorderSessions(coach, phase().id, [c(), a()]));
    expect([without.error?.message, without.error?.code]).toEqual([MISMATCH, P0001]);
    expect(without.error.detail).toBe(sessionsDetail(3, 2, 1, 0, 0));
    expect(await orderOf(q, phase().id)).toEqual(numbered([a(), b(), c()]));

    await reorderSessions(coach, phase().id, [c(), a(), b()]);
    expect(await orderOf(q, phase().id)).toEqual(numbered([c(), a(), b()]));
  }));

  it('a list that is not exactly the sessions of the phase is refused, and nothing moves', () => scenario(async (q) => {
    const before = await versions(q, 'sessions', 'true');
    const otherPhase = next.tree[1].sessions[0].id;
    const otherAthlete = ids.programB.sessions[0];
    const nobody = await q.value(`select gen_random_uuid()`);

    for (const [what, list, detail] of [
      ['one session is left out', [a(), b()], sessionsDetail(3, 2, 1, 0, 0)],
      ['a session of another phase of the block takes its place', [a(), b(), otherPhase], sessionsDetail(3, 3, 1, 1, 0)],
      ['a session of another athlete is added', [a(), b(), c(), otherAthlete], sessionsDetail(3, 4, 0, 1, 0)],
      ['an id that is no session is added', [a(), b(), c(), nobody], sessionsDetail(3, 4, 0, 1, 0)],
      ['a session is there twice', [a(), b(), c(), a()], sessionsDetail(3, 4, 0, 0, 1)],
      ['a session is there twice in place of another', [a(), b(), b()], sessionsDetail(3, 3, 1, 0, 1)],
      ['an entry is empty', [a(), b(), c(), null], sessionsDetail(3, 4, 0, 0, 1)],
      ['the list is empty', [], sessionsDetail(3, 0, 3, 0, 0)],
      ['there is no list', null, sessionsDetail(3, 0, 3, 0, 0)],
    ]) {
      const tried = await attempt(() => reorderSessions(coach, phase().id, list));
      expect([tried.error?.message, tried.error?.code], what).toEqual([MISMATCH, P0001]);
      expect(tried.error.detail, what).toBe(detail);
    }
    expect(await versions(q, 'sessions', 'true')).toEqual(before);
  }));

  it('the order the phase has already, and a phase with no session: nothing is written', () => scenario(async (q) => {
    const before = await versions(q, 'sessions', 'week_id = $1', [phase().id]);
    await reorderSessions(coach, phase().id, [a(), b(), c()]);
    expect(await versions(q, 'sessions', 'week_id = $1', [phase().id])).toEqual(before);

    const empty = await q.value(`insert into weeks (program_id, week_number) values ($1, 9) returning id`, [next.id]);
    await reorderSessions(coach, empty, []);
    await reorderSessions(coach, empty, null);
    expect(await refusal(() => reorderSessions(coach, empty, [a()]))).toEqual([MISMATCH, P0001]);
  }));

  // The finding: a reorder of the deployed app is two passes of one request
  // per session. Here the second pass never arrives.
  it('a phase the app left parked at 100000 and more: the app can no longer reorder it, the function puts it right', () => scenario(async (q) => {
    const wanted = [c(), a(), b()];
    for (const [i, id] of wanted.entries()) await coach((k) => app.placeSession(k, id, TMP_BASE + i));
    expect(await orderOf(q, phase().id)).toEqual(numbered(wanted, TMP_BASE));

    // The coach drags again. The first pass parks a at 100000 — where c was left.
    const again = await attempt(() => coach((k) => app.placeSession(k, a(), TMP_BASE)));
    expect(again.error?.code).toBe('23505');
    expect(again.error.message).toContain('sessions_week_sort_order_unique');

    await reorderSessions(coach, phase().id, [a(), b(), c()]);
    expect(await orderOf(q, phase().id)).toEqual(numbered([a(), b(), c()]));
    // … and a session is dragged out of the phase again (move_session parks at
    // 100000 + n too: on a phase left parked it goes through or not, as the
    // ids fall).
    const second = next.tree[1].sessions.map((s) => s.id);
    await coach((k) => k(`select public.move_session($1, $2, $3, $4)`, [a(), next.weeks[1], [b(), c()], [...second, a()]]));
    expect(await orderOf(q, phase().id)).toEqual(numbered([b(), c()]));
    expect(await orderOf(q, next.weeks[1])).toEqual(numbered([...second, a()]));
  }));

  it('numbers that are not 0 to n-1 — a gap, a negative one — are no obstacle, and are put right', () => scenario(async (q) => {
    await q(`update sessions set sort_order = -5 where id = $1`, [a()]);
    await q(`update sessions set sort_order = 7 where id = $1`, [c()]);
    // In that order already, and not numbered from 0: it is written.
    await reorderSessions(coach, phase().id, [a(), b(), c()]);
    expect(await orderOf(q, phase().id)).toEqual(numbered([a(), b(), c()]));

    // One session left just above the others, at n + 1: the number a park at
    // n + place would have given the first of the list. Parked above every
    // number the phase holds, nothing meets it.
    await q(`update sessions set sort_order = 4 where id = $1`, [a()]);
    await reorderSessions(coach, phase().id, [b(), a(), c()]);
    expect(await orderOf(q, phase().id)).toEqual(numbered([b(), a(), c()]));
  }));

  it('a write that fails half-way: the function leaves the phase as it was, the requests of the app leave it parked', () => scenario(async (q) => {
    // The request that gives the second place is lost.
    await loseTheRequestThat(q, 'sessions', 'NEW.sort_order = 1 and OLD.sort_order > 2');
    const before = await versions(q, 'sessions', 'week_id = $1', [phase().id]);
    const wanted = [c(), a(), b()];

    expect(await refusal(() => reorderSessions(coach, phase().id, wanted))).toEqual([LOST, P0001]);
    expect(await orderOf(q, phase().id)).toEqual(numbered([a(), b(), c()]));
    expect(await versions(q, 'sessions', 'week_id = $1', [phase().id])).toEqual(before);

    // The app: the first pass, then the second up to the request that is lost.
    for (const [i, id] of wanted.entries()) await coach((k) => app.placeSession(k, id, TMP_BASE + i));
    await coach((k) => app.placeSession(k, wanted[0], 0));
    expect(await refusal(() => coach((k) => app.placeSession(k, wanted[1], 1)))).toEqual([LOST, P0001]);
    expect(await orderOf(q, phase().id)).toEqual([[c(), 0], [a(), TMP_BASE + 1], [b(), TMP_BASE + 2]]);
  }));

  it('only the coach of the athlete: everybody else is refused, and nothing moves', () => scenario(async (q) => {
    const before = await versions(q, 'sessions', 'true');
    const list = [c(), a(), b()];
    const nobody = await q.value(`select gen_random_uuid()`);

    for (const [who, as] of [
      ['another coach', (fn) => asUser(olga, fn)],
      ['an athlete of another coach', (fn) => asUser(casey, fn)],
      ['another athlete of the same coach', (fn) => asUser(ids.studentB, fn)],
      ['a token that names no user', (fn) => asUser(ids.coach, fn, { claims: { sub: null } })],
    ]) {
      expect(await refusal(() => reorderSessions(as, phase().id, list)), who).toEqual(['week_not_found', P0001]);
    }
    expect(await refusal(() => reorderSessions(coach, nobody, []))).toEqual(['week_not_found', P0001]);
    expect(await refusal(() => reorderSessions(coach, null, null))).toEqual(['week_not_found', P0001]);
    // A phase of another coach's athlete, with its own sessions in the list.
    expect(await refusal(() => reorderSessions(coach, blockC.weeks[0], [...blockC.sessions].reverse())))
      .toEqual(['week_not_found', P0001]);

    // The athlete reads the phase — in the block being trained and in the next one — and reorders neither.
    const asked = await attempt(() => reorderSessions(alex, phase().id, list));
    expect([asked.error?.message, asked.error?.code]).toEqual(['not authorized', DENIED]);
    expect(asked.error.detail).toBe('The caller reads this phase and may not write it.');
    expect(await refusal(() => reorderSessions(alex, ids.programA.weeks[0], [...ids.programA.tree[0].sessions].reverse().map((s) => s.id))))
      .toEqual(['not authorized', DENIED]);

    expect(await refusal(() => reorderSessions(asAnon, phase().id, list)))
      .toEqual(['permission denied for function reorder_sessions', DENIED]);

    expect(await versions(q, 'sessions', 'true')).toEqual(before);
  }));

  it('rides the rights the caller has: the author of a draft reorders it, the service role any phase', () => scenario(async (q) => {
    const [first, second] = draft.sessions;
    await reorderSessions(alex, draft.weeks[0], [second, first]);
    expect(await orderOf(q, draft.weeks[0])).toEqual(numbered([second, first]));
    // … their own draft, and nothing else: not the block they train.
    expect(await refusal(() => reorderSessions(alex, ids.programA.weeks[1], ids.programA.tree[1].sessions.map((s) => s.id))))
      .toEqual(['not authorized', DENIED]);

    await reorderSessions(asService, phase().id, [b(), c(), a()]);
    expect(await orderOf(q, phase().id)).toEqual(numbered([b(), c(), a()]));
  }));

  // The list is judged against the sessions that are there when the numbers
  // are written: the phase is locked first, and a session that is being added
  // holds it. Without that lock the reorder does not wait — it does not see
  // the new session, and goes through on a list that is one short.
  it('a session added while a reorder is on its way: the reorder waits, and is refused on a list that is no longer the phase', async () => {
    const week = raceB.tree[0];
    const list = week.sessions.map((s) => s.id).reverse();

    const reorder = await cross({
      what: 'the reorder',
      first: (hold) => committed(ids.coach, async (k) => {
        await k(`insert into sessions (week_id, title, sort_order) values ($1, 'Added meanwhile', 3)`, [week.id]);
        await hold();
      }),
      second: () => committed(ids.coach, (k) => k(`select public.reorder_sessions($1, $2)`, [week.id, list])),
    });
    expect([reorder.error?.message, reorder.error?.code]).toEqual([MISMATCH, P0001]);
    expect(reorder.error.detail).toBe(sessionsDetail(4, 3, 1, 0, 0));
    expect((await asAdmin((q) => orderOf(q, week.id))).map(([, n]) => n)).toEqual([0, 1, 2, 3]);
    expect((await asAdmin((q) => orderOf(q, week.id))).slice(0, 3).map(([id]) => id)).toEqual(week.sessions.map((s) => s.id));
  });

  it('two reorders of one phase in the same instant: the second waits, and its order is the one that stays', async () => {
    const week = raceB.tree[1];
    const [x, y, z] = week.sessions.map((s) => s.id);

    const second = await cross({
      what: 'the second reorder',
      first: (hold) => committed(ids.coach, async (k) => {
        await k(`select public.reorder_sessions($1, $2)`, [week.id, [z, x, y]]);
        await hold();
      }),
      second: () => committed(ids.coach, (k) => k(`select public.reorder_sessions($1, $2)`, [week.id, [y, z, x]])),
    });
    expect(second.error?.message).toBeUndefined();
    expect(await asAdmin((q) => orderOf(q, week.id))).toEqual(numbered([y, z, x]));
  });
});

// ============================================================
// reorder_weeks (P51)
// ============================================================
describe('reorder_weeks: the phases of a block in the order of a list, in one statement (P51)', () => {
  const [w1, w2, w3] = [0, 1, 2].map((i) => () => next.weeks[i]);

  it('the coach gives the phases a new order: 1 to n in the order of the list, each phase with its sessions', () => scenario(async (q) => {
    const sessions = await q.rows(
      `select s.id, s.week_id, s.sort_order from sessions s join weeks w on w.id = s.week_id where w.program_id = $1 order by s.id`,
      [next.id],
    );
    expect(await phasesOf(q, next.id)).toEqual(numbered([w1(), w2(), w3()], 1));

    await reorderWeeks(coach, next.id, [w3(), w1(), w2()]);
    expect(await phasesOf(q, next.id)).toEqual(numbered([w3(), w1(), w2()], 1));
    await reorderWeeks(coach, next.id, [w2(), w3(), w1()]);
    expect(await phasesOf(q, next.id)).toEqual(numbered([w2(), w3(), w1()], 1));

    expect(await q.rows(
      `select s.id, s.week_id, s.sort_order from sessions s join weeks w on w.id = s.week_id where w.program_id = $1 order by s.id`,
      [next.id],
    )).toEqual(sessions);
    // The other blocks of the athlete, and everybody else's, are where they were.
    expect(await phasesOf(q, ids.programA.id)).toEqual(numbered(ids.programA.weeks, 1));
  }));

  it('a list that is not exactly the phases of the block is refused, and nothing moves', () => scenario(async (q) => {
    const before = await versions(q, 'weeks', 'true');
    const otherBlock = ids.programA.weeks[0];
    const nobody = await q.value(`select gen_random_uuid()`);

    for (const [what, list, detail] of [
      ['one phase is left out', [w1(), w2()], weeksDetail(3, 2, 1, 0, 0)],
      ['a phase of another block of the athlete takes its place', [w1(), w2(), otherBlock], weeksDetail(3, 3, 1, 1, 0)],
      ['an id that is no phase is added', [w1(), w2(), w3(), nobody], weeksDetail(3, 4, 0, 1, 0)],
      ['a phase is there twice', [w1(), w2(), w3(), w3()], weeksDetail(3, 4, 0, 0, 1)],
      ['an entry is empty', [w1(), null, w2(), w3()], weeksDetail(3, 4, 0, 0, 1)],
      ['the list is empty', [], weeksDetail(3, 0, 3, 0, 0)],
      ['there is no list', null, weeksDetail(3, 0, 3, 0, 0)],
    ]) {
      const tried = await attempt(() => reorderWeeks(coach, next.id, list));
      expect([tried.error?.message, tried.error?.code], what).toEqual([MISMATCH, P0001]);
      expect(tried.error.detail, what).toBe(detail);
    }
    expect(await versions(q, 'weeks', 'true')).toEqual(before);
  }));

  it('the order the block has already, and a block with no phase: nothing is written', () => scenario(async (q) => {
    const before = await versions(q, 'weeks', 'program_id = $1', [next.id]);
    await reorderWeeks(coach, next.id, [w1(), w2(), w3()]);
    expect(await versions(q, 'weeks', 'program_id = $1', [next.id])).toEqual(before);

    const empty = await q.value(
      `insert into programs (student_id, name) values ($1, 'Empty block') returning id`, [ids.studentA.studentRowId],
    );
    await reorderWeeks(coach, empty, []);
    expect(await refusal(() => reorderWeeks(coach, empty, [w1()]))).toEqual([MISMATCH, P0001]);
  }));

  it('a block the app left parked at 100000 and more: the app can no longer reorder it, the function puts it right', () => scenario(async (q) => {
    const wanted = [w3(), w1(), w2()];
    for (const [i, id] of wanted.entries()) await coach((k) => app.placeWeek(k, id, TMP_BASE + i));
    expect(await phasesOf(q, next.id)).toEqual(numbered(wanted, TMP_BASE));

    const again = await attempt(() => coach((k) => app.placeWeek(k, w1(), TMP_BASE)));
    expect(again.error?.code).toBe('23505');
    expect(again.error.message).toContain('weeks_program_id_week_number_key');

    await reorderWeeks(coach, next.id, [w1(), w2(), w3()]);
    expect(await phasesOf(q, next.id)).toEqual(numbered([w1(), w2(), w3()], 1));
  }));

  it('a write that fails half-way: the function leaves the block as it was, the requests of the app leave it parked', () => scenario(async (q) => {
    await loseTheRequestThat(q, 'weeks', 'NEW.week_number = 2 and OLD.week_number > 3');
    const before = await versions(q, 'weeks', 'program_id = $1', [next.id]);
    const wanted = [w3(), w1(), w2()];

    expect(await refusal(() => reorderWeeks(coach, next.id, wanted))).toEqual([LOST, P0001]);
    expect(await phasesOf(q, next.id)).toEqual(numbered([w1(), w2(), w3()], 1));
    expect(await versions(q, 'weeks', 'program_id = $1', [next.id])).toEqual(before);

    for (const [i, id] of wanted.entries()) await coach((k) => app.placeWeek(k, id, TMP_BASE + i));
    await coach((k) => app.placeWeek(k, wanted[0], 1));
    expect(await refusal(() => coach((k) => app.placeWeek(k, wanted[1], 2)))).toEqual([LOST, P0001]);
    expect(await phasesOf(q, next.id)).toEqual([[w3(), 1], [w1(), TMP_BASE + 1], [w2(), TMP_BASE + 2]]);
  }));

  it('only the coach of the athlete: everybody else is refused, and nothing moves', () => scenario(async (q) => {
    const before = await versions(q, 'weeks', 'true');
    const list = [w3(), w1(), w2()];

    for (const [who, as] of [
      ['another coach', (fn) => asUser(olga, fn)],
      ['an athlete of another coach', (fn) => asUser(casey, fn)],
      ['another athlete of the same coach', (fn) => asUser(ids.studentB, fn)],
      ['a token that names no user', (fn) => asUser(ids.coach, fn, { claims: { sub: null } })],
    ]) {
      expect(await refusal(() => reorderWeeks(as, next.id, list)), who).toEqual(['program_not_found', P0001]);
    }
    expect(await refusal(() => reorderWeeks(coach, null, null))).toEqual(['program_not_found', P0001]);
    expect(await refusal(() => reorderWeeks(coach, blockC.id, blockC.weeks))).toEqual(['program_not_found', P0001]);

    const asked = await attempt(() => reorderWeeks(alex, next.id, list));
    expect([asked.error?.message, asked.error?.code]).toEqual(['not authorized', DENIED]);
    expect(asked.error.detail).toBe('The caller reads this program and may not write it.');

    expect(await refusal(() => reorderWeeks(asAnon, next.id, list)))
      .toEqual(['permission denied for function reorder_weeks', DENIED]);

    expect(await versions(q, 'weeks', 'true')).toEqual(before);
  }));

  it('rides the rights the caller has: the service role reorders any block, a block in the trash is reordered by its coach', () => scenario(async (q) => {
    await reorderWeeks(asService, next.id, [w2(), w1(), w3()]);
    expect(await phasesOf(q, next.id)).toEqual(numbered([w2(), w1(), w3()], 1));

    // In the trash, a block is still the coach's: it comes back as it was left.
    const second = await q.value(`insert into weeks (program_id, week_number) values ($1, 2) returning id`, [trashed.id]);
    await reorderWeeks(coach, trashed.id, [second, trashed.weeks[0]]);
    expect(await phasesOf(q, trashed.id)).toEqual(numbered([second, trashed.weeks[0]], 1));
  }));
});

// ============================================================
// The app that is deployed
// ============================================================
describe('next to them, the app that is deployed goes on with its own requests', () => {
  it('Set active in two requests, a reorder in two passes: accepted as before', () => scenario(async (q) => {
    await coach((c) => app.switchOff(c, ids.studentA.studentRowId));
    expect((await coach((c) => app.switchOn(c, next.id))).rowCount).toBe(1);
    expect(await activeOf(q, ids.studentA)).toEqual(['Block A2']);

    const wanted = [...next.tree[0].sessions].reverse().map((s) => s.id);
    for (const [i, id] of wanted.entries()) await coach((k) => app.placeSession(k, id, TMP_BASE + i));
    for (const [i, id] of wanted.entries()) await coach((k) => app.placeSession(k, id, i));
    expect(await orderOf(q, next.tree[0].id)).toEqual(numbered(wanted));

    const phases = [...next.weeks].reverse();
    for (const [i, id] of phases.entries()) await coach((k) => app.placeWeek(k, id, TMP_BASE + i));
    for (const [i, id] of phases.entries()) await coach((k) => app.placeWeek(k, id, i + 1));
    expect(await phasesOf(q, next.id)).toEqual(numbered(phases, 1));
  }));
});

// ============================================================
// The migration file, on production as it is
// ============================================================
describe('migration 11 applied to the production baseline', () => {
  const COACH = '00000000-0000-4000-8000-00000000c0ac';
  const OLGA = '00000000-0000-4000-8000-00000000c0b0';
  const ATHLETE = '00000000-0000-4000-8000-0000000000a1';
  const RESTING = '00000000-0000-4000-8000-0000000000a2';
  const LINK = '00000000-0000-4000-8000-000000000101';
  const LINK_RESTING = '00000000-0000-4000-8000-000000000102';
  const BLOCK = '00000000-0000-4000-8000-000000000301';
  const NEXT = '00000000-0000-4000-8000-000000000302';
  const FINISHED = '00000000-0000-4000-8000-000000000303';
  const W0 = '00000000-0000-4000-8000-000000000400';
  const W1 = '00000000-0000-4000-8000-000000000401';
  const W2 = '00000000-0000-4000-8000-000000000402';
  const S0 = '00000000-0000-4000-8000-000000000450';
  const S1 = '00000000-0000-4000-8000-000000000451';
  const S2 = '00000000-0000-4000-8000-000000000452';
  const S3 = '00000000-0000-4000-8000-000000000453';
  const S4 = '00000000-0000-4000-8000-000000000454';
  const TO_COME = '2099_01_01_99_a_migration_to_come';

  // Two coaches and two athletes of the first one. Alex trains "Block" (one
  // phase, one session) and has "Next block" waiting: two phases, three
  // sessions in the first. Billie has finished her block and has none active.
  // The roles are set the way a dump restore sets them: on the baseline the
  // documented `update profiles set role = 'coach'` is undone for every
  // caller (finding P20, closed by migration 07).
  const WORLD = `
    insert into auth.users (id, email, aud, role, email_confirmed_at, raw_user_meta_data) values
      ('${COACH}',   'coach@sl.test',  'authenticated', 'authenticated', now(), '{"full_name": "Coach Carla"}'),
      ('${OLGA}',    'olga@sl.test',   'authenticated', 'authenticated', now(), '{"full_name": "Coach Olga"}'),
      ('${ATHLETE}', 'alex@sl.test',   'authenticated', 'authenticated', now(), '{"full_name": "Alex"}'),
      ('${RESTING}', 'billie@sl.test', 'authenticated', 'authenticated', now(), '{"full_name": "Billie"}');
    BEGIN;
    SET LOCAL session_replication_role = replica;
    update public.profiles set role = 'coach' where id in ('${COACH}', '${OLGA}');
    COMMIT;
    insert into public.students (id, profile_id, coach_id) values
      ('${LINK}', '${ATHLETE}', '${COACH}'), ('${LINK_RESTING}', '${RESTING}', '${COACH}');
    insert into public.programs (id, student_id, name, is_active) values
      ('${BLOCK}', '${LINK}', 'Block', true),
      ('${NEXT}', '${LINK}', 'Next block', false),
      ('${FINISHED}', '${LINK_RESTING}', 'Finished block', false);
    insert into public.weeks (id, program_id, week_number) values
      ('${W0}', '${BLOCK}', 1), ('${W1}', '${NEXT}', 1), ('${W2}', '${NEXT}', 2);
    insert into public.sessions (id, week_id, title, sort_order) values
      ('${S0}', '${W0}', 'S0', 0),
      ('${S1}', '${W1}', 'S1', 0), ('${S2}', '${W1}', 'S2', 1), ('${S3}', '${W1}', 'S3', 2),
      ('${S4}', '${W2}', 'S4', 0);
  `;

  /** The frozen baseline with that world in it and the migrations before 11 applied. */
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
  const NOBODY = { role: 'anon', claims: { role: 'anon' } };
  const story = async (db, ...steps) => {
    const statements = steps.map((step) => (typeof step === 'string' ? step
      : `select set_config('role', '${step.role}', true), set_config('request.jwt.claims', '${JSON.stringify(step.claims)}', true)`));
    const tried = await attempt(() => db.runSql(`BEGIN;\n${statements.join(';\n')};\nROLLBACK;`, 'request'));
    if (!tried.ok) return (tried.error.cause ?? tried.error).message;
    const [found] = tried.value.at(-2).rows;
    return found ? Object.values(found)[0] : null;
  };

  const activateNext = `select public.activate_program('${NEXT}')`;
  const reorderFirstPhase = `select public.reorder_sessions('${W1}', array['${S3}', '${S1}', '${S2}']::uuid[])`;
  const reorderPhases = `select public.reorder_weeks('${NEXT}', array['${W2}', '${W1}']::uuid[])`;
  const activeBlocks = `select string_agg(name, ', ' order by name) from public.programs where student_id = '${LINK}' and is_active`;
  const firstPhase = `select string_agg(title, ' ' order by sort_order) from public.sessions where week_id = '${W1}'`;
  const phases = `select string_agg(id::text, ' ' order by week_number) from public.weeks where program_id = '${NEXT}'`;

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
  const listWithoutBlock = quoted('select pr.full_name as athlete, coach.full_name as coach');
  const listTrashActive = quoted('select pr.full_name as athlete, p.name as block, p.deleted_at');
  const switchTrashOff = quoted('update public.programs set is_active = false');
  const listParkedSessions = quoted('select pr.full_name as athlete, p.name as block, w.week_number as phase_number');
  const listParkedPhases = quoted('select pr.full_name as athlete, p.name as block, count(*) as phases');
  const renumberSessions = quoted('select w.id as phase, public.reorder_sessions');
  const renumberPhases = quoted('select p.id as block, public.reorder_weeks');

  const printedAudit = async (db) => {
    const [result] = await db.readOnly(read(migration.paths.audit), 'audit');
    return Object.fromEntries(result.rows.map((line) => [line.check, line.value]));
  };
  const LINE = {
    activate: 'a block is activated in one request (activate_program, P16)',
    sessions: 'the sessions of a phase are reordered in one request (reorder_sessions, P51)',
    weeks: 'the phases of a block are reordered in one request (reorder_weeks, P51)',
    strangers: 'functions of these names that the migration does not know',
    anon: 'functions of this migration a request without a session may execute',
    users: 'functions of this migration a signed-in user may execute',
    withoutBlock: 'athletes with a block and none active',
    trashActive: 'active blocks that are in the trash',
    parkedSessions: 'sessions numbered 100000 or more',
    parkedPhases: 'phases numbered 100000 or more',
  };
  const THE_THREE = 'activate_program(uuid); reorder_sessions(uuid, uuid[]); reorder_weeks(uuid, uuid[])';
  const untouched = async (db, before) => {
    expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
    expect(await db.query.value(`select count(*) from ${LEDGER} where name = $1`, [MIGRATION])).toBe(0);
  };
  const rows = (db) => db.query.one(
    `select (select string_agg(name, ', ' order by name) from public.programs where is_active) as active,
            (select string_agg(title || '=' || sort_order, ' ' order by title) from public.sessions) as sessions,
            (select string_agg(week_number::text, ' ' order by id) from public.weeks) as phases`,
  );
  const AS_IT_WAS = { active: 'Block', sessions: 'S0=0 S1=0 S2=1 S3=2 S4=0', phases: '1 1 2' };

  it('the three functions are not there before, are the coach\'s after, and are gone after the rollback — no row is written by either file', async () => {
    const db = await production();
    const missing = (name, args) => `function public.${name}(${args}) does not exist`;

    expect(await story(db, THE_COACH, activateNext)).toBe(missing('activate_program', 'unknown'));
    expect(await story(db, THE_COACH, reorderFirstPhase)).toBe(missing('reorder_sessions', 'unknown, uuid[]'));
    expect(await story(db, THE_COACH, reorderPhases)).toBe(missing('reorder_weeks', 'unknown, uuid[]'));

    await db.runFile(migration.paths.migration);

    expect(await story(db, THE_COACH, activateNext)).toEqual({
      program_id: NEXT, student_id: LINK, already_active: false, deactivated: 1,
    });
    expect(await story(db, THE_COACH, activateNext, activeBlocks)).toBe('Next block');
    expect(await story(db, THE_COACH, reorderFirstPhase, firstPhase)).toBe('S3 S1 S2');
    expect(await story(db, THE_COACH, reorderPhases, phases)).toBe(`${W2} ${W1}`);
    // Everybody else, as the page says.
    expect(await story(db, THE_OTHER_COACH, activateNext)).toBe('program_not_found');
    expect(await story(db, THE_OTHER_COACH, reorderFirstPhase)).toBe('week_not_found');
    expect(await story(db, THE_OTHER_COACH, reorderPhases)).toBe('program_not_found');
    for (const call of [activateNext, reorderFirstPhase, reorderPhases]) {
      expect(await story(db, THE_ATHLETE, call), call).toBe('not authorized');
    }
    expect(await story(db, NOBODY, activateNext)).toBe('permission denied for function activate_program');
    expect(await story(db, NOBODY, reorderFirstPhase)).toBe('permission denied for function reorder_sessions');
    expect(await story(db, NOBODY, reorderPhases)).toBe('permission denied for function reorder_weeks');
    expect(await story(db, THE_COACH, `select public.reorder_sessions('${W1}', array['${S1}', '${S2}']::uuid[])`)).toBe('reorder_ids_mismatch');
    for (const said of ['`program_not_found`; for a phase, `week_not_found`', '| the athlete of the block | `not authorized` |',
      '`permission denied for function activate_program`', '`program_is_draft` / `program_in_trash`', '`reorder_ids_mismatch`']) {
      expect(page).toContain(said);
    }

    // The app that is deployed, as the coach: its own requests, as before.
    expect(await story(db, THE_COACH,
      `update public.programs set is_active = false where student_id = '${LINK}' and is_active = true`,
      `update public.programs set is_active = true where id = '${NEXT}'`, activeBlocks)).toBe('Next block');
    expect(await story(db, THE_COACH,
      `update public.sessions set sort_order = 100000 where id = '${S2}'`, `update public.sessions set sort_order = 100001 where id = '${S1}'`,
      `update public.sessions set sort_order = 0 where id = '${S2}'`, `update public.sessions set sort_order = 1 where id = '${S1}'`,
      firstPhase)).toBe('S2 S1 S3');
    // Nothing above was kept, and the migration itself touches no row.
    expect(await rows(db)).toEqual(AS_IT_WAS);

    await db.runFile(migration.paths.rollback);
    expect(await story(db, THE_COACH, activateNext)).toBe(missing('activate_program', 'unknown'));
    expect(await story(db, THE_COACH, reorderFirstPhase)).toBe(missing('reorder_sessions', 'unknown, uuid[]'));
    expect(await story(db, THE_COACH, reorderPhases)).toBe(missing('reorder_weeks', 'unknown, uuid[]'));
    expect(await rows(db)).toEqual(AS_IT_WAS);
    await db.drop();
  });

  it('adds 3 functions and signs the ledger — no table, no column, no policy, no trigger, no privilege of what was there', async () => {
    const db = await production();
    const before = await catalogSnapshot(db.query);
    await db.runFile(migration.paths.migration);
    const after = await catalogSnapshot(db.query);

    const lines = diffCatalogs(before, after, { left: 'before', right: 'after' });
    const only = (side) => lines.filter((line) => line.endsWith(`: only in ${side}`))
      .map((line) => line.slice(0, -`: only in ${side}`.length));
    const ACTIVATE = 'public.activate_program(p_program_id uuid)';
    const SESSIONS = 'public.reorder_sessions(p_week_id uuid, p_ids uuid[])';
    const WEEKS = 'public.reorder_weeks(p_program_id uuid, p_ids uuid[])';
    expect(only('after').sort()).toEqual([`functions ${ACTIVATE}`, `functions ${SESSIONS}`, `functions ${WEEKS}`]);
    expect(only('before')).toEqual([]);
    expect(lines.filter((line) => !/: only in (before|after)$/.test(line)).map((line) => /^(.*?): (\w+): /.exec(line).slice(1, 3).join(' → ')))
      .toEqual(['data rows of app_private.app_migrations → rows']);

    // Each of the three: its owner, the service role and a signed-in user;
    // the rights of whoever calls; the search_path pinned. The names of the
    // arguments are what the API calls them by.
    const header = (key) => after.functions[key].definition.split(/\nAS /)[0];
    for (const [key, answers] of [[ACTIVATE, 'jsonb'], [SESSIONS, 'void'], [WEEKS, 'void']]) {
      expect(after.functions[key].privileges, key).toEqual(['authenticated: EXECUTE', 'postgres: EXECUTE', 'service_role: EXECUTE']);
      expect(after.functions[key].owner, key).toBe('postgres');
      expect(header(key), key).not.toContain('SECURITY DEFINER');
      expect(header(key), key).toContain(`\n RETURNS ${answers}\n`);
      expect(header(key), key).toContain(`\n SET search_path TO 'public', 'pg_temp'`);
    }

    // The ledger, as the page says it reads.
    expect(await db.query.rows(`select name from ${LEDGER} order by name`)).toHaveLength(11);
    expect(await db.query.value(`select name from ${LEDGER} order by name desc limit 1`)).toBe(MIGRATION);
    expect(page).toContain(`Expected: eleven rows, the last one \`${MIGRATION}\`.`);
    expect(page).toContain('| Kind | required · expand: adds 3 functions; no table, no column, no policy, no trigger, no row |');
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
    expect(table.map((line) => line.n)).toEqual(Array.from({ length: 13 }, (_, i) => i + 1));
    // Written between back-ticks: a value the page gives exactly. The other
    // one is a sentence about what production holds.
    const exact = table.filter((line) => /^`.+`$/.test(line.before) && /^`.+`$/.test(line.after))
      .map((line) => ({ ...line, before: line.before.slice(1, -1), after: line.after.slice(1, -1) }));
    expect(table.filter((line) => !exact.some((e) => e.n === line.n)).map((line) => line.check)).toEqual([LINE.withoutBlock]);
    const onPage = (column) => [
      ...exact.map((line) => [line.n, line.check, line[column]]),
      // Billie: a finished block, and none active.
      [10, LINE.withoutBlock, '1'],
    ].sort((x, y) => x[0] - y[0]).map(([, check, value]) => [check, value]);

    expect(await printed()).toEqual(onPage('before'));
    await db.runFile(migration.paths.migration);
    expect(await printed()).toEqual(onPage('after'));
    expect(Object.fromEntries(await printed())[LINE.users]).toBe(THE_THREE);
    // …and the header of the audit file says the same.
    const header = audit.split('\n').filter((line) => line.startsWith('--')).join('\n');
    for (const { check, before, after } of exact) {
      expect(header, check).toContain(check);
      expect(header).toContain(before);
      expect(header).toContain(after);
    }
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
              (select count(*) from public.students) as links, (select count(*) from public.programs) as programs,
              (select count(*) from public.weeks) as phases, (select count(*) from public.sessions) as sessions,
              current_user::text as role, coalesce(current_setting('request.jwt.claims', true), '') as claims`,
    );
    const UNTOUCHED = { accounts: 4, profiles: 4, links: 2, programs: 3, phases: 3, sessions: 5, role: 'postgres', claims: '' };
    const answer = (said) => `check only, nothing was written: ${said}`;
    const IN_PLACE = answer('in place: a coach sets a block active and reorders its sessions and its phases in one request each, '
      + 'and an athlete does not');

    expect(await checked()).toBe(answer('NOT THERE: the three functions are not in the database'));
    expect(await state()).toEqual(UNTOUCHED);

    await db.runFile(migration.paths.migration);
    expect(await checked()).toBe(IN_PLACE);
    expect(await state()).toEqual(UNTOUCHED);
    expect(await rows(db)).toEqual(AS_IT_WAS);
    // What the page says the command prints.
    expect(page).toContain(`\`${IN_PLACE}\``);
    expect(page).toContain('`… NOT THERE: the three functions are not in the database`');

    // Each function made wrong by hand, one at a time: the answer nobody wants.
    const replace = async (signature, body, restore) => {
      const was = await db.query.value(`select pg_get_functiondef($1::regprocedure)`, [signature]);
      await db.query(body);
      const said = await checked();
      await db.query(was);
      expect(await checked(), `${restore} put back`).toBe(IN_PLACE);
      return said;
    };
    // One that lets everybody through.
    expect(await replace('public.activate_program(uuid)',
      `create or replace function public.activate_program(p_program_id uuid) returns jsonb language plpgsql
         set search_path = public, pg_temp as $$ begin return '{}'::jsonb; end $$`,
      'activate_program')).toBe(answer('NOT PROTECTED: an athlete set a block active'));
    expect(await replace('public.reorder_sessions(uuid, uuid[])',
      `create or replace function public.reorder_sessions(p_week_id uuid, p_ids uuid[]) returns void language plpgsql
         set search_path = public, pg_temp as $$ begin null; end $$`,
      'reorder_sessions')).toBe(answer('BROKEN: a list that leaves a session out was accepted'));
    expect(await replace('public.reorder_weeks(uuid, uuid[])',
      `create or replace function public.reorder_weeks(p_program_id uuid, p_ids uuid[]) returns void language plpgsql
         set search_path = public, pg_temp as $$ begin null; end $$`,
      'reorder_weeks')).toBe(answer('BROKEN: after reorder_weeks the phases are not in the order of the list'));
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

  // Lines 10 to 13 of the audit, and the three sections of the page that
  // answer them.
  it('what a lost request left behind: counted by the audit, listed and put right with the page\'s statements', async () => {
    const db = await production();
    for (const statement of [listWithoutBlock, listTrashActive, switchTrashOff, listParkedSessions, listParkedPhases,
      renumberSessions, renumberPhases]) {
      expect(statement, 'the page no longer gives one of its statements').toBeTruthy();
      // Pasted between double quotes in a shell.
      expect(statement).not.toMatch(/["$`!\\]/);
    }
    const clean = await printedAudit(db);
    expect(clean).toMatchObject({
      [LINE.withoutBlock]: '1', [LINE.trashActive]: '0', [LINE.parkedSessions]: '0', [LINE.parkedPhases]: '0',
    });
    expect(await db.query.rows(listWithoutBlock)).toMatchObject([{ athlete: 'Billie', coach: 'Coach Carla', blocks: 1 }]);
    for (const list of [listTrashActive, listParkedSessions, listParkedPhases]) expect(await db.query.rows(list)).toEqual([]);

    // A reorder of the first phase of "Next block" to S3 S1 S2 that lost its
    // second pass; a reorder of its phases likewise; Alex's "Set active" that
    // lost its second request; and Billie's finished block, in the trash and
    // active.
    await db.query(`update public.sessions set sort_order = case id when '${S3}' then 100000 when '${S1}' then 100001 else 100002 end
                     where week_id = '${W1}'`);
    await db.query(`update public.weeks set week_number = case id when '${W2}' then 100000 else 100001 end where program_id = '${NEXT}'`);
    await db.query(`update public.programs set is_active = false where id = '${BLOCK}'`);
    await db.query(`update public.programs set is_active = true, deleted_at = now() where id = '${FINISHED}'`);

    const LEFT_BEHIND = {
      [LINE.withoutBlock]: '1', [LINE.trashActive]: '1', [LINE.parkedSessions]: '3', [LINE.parkedPhases]: '2',
    };
    expect(await printedAudit(db)).toMatchObject(LEFT_BEHIND);
    expect(await db.query.rows(listWithoutBlock)).toMatchObject([{ athlete: 'Alex', coach: 'Coach Carla', blocks: 2 }]);
    expect(await db.query.rows(listTrashActive)).toMatchObject([{ athlete: 'Billie', block: 'Finished block' }]);
    expect(await db.query.rows(listParkedSessions))
      .toEqual([{ athlete: 'Alex', block: 'Next block', phase_number: 100001, sessions: 3, parked: 3 }]);
    expect(await db.query.rows(listParkedPhases)).toEqual([{ athlete: 'Alex', block: 'Next block', phases: 2, parked: 2 }]);
    // The app that is deployed, on that phase: its first pass meets what was left there.
    expect(await story(db, THE_COACH, `update public.sessions set sort_order = 100000 where id = '${S1}'`))
      .toBe('duplicate key value violates unique constraint "sessions_week_sort_order_unique"');
    const toast = /\bsessionOrder: '([^']+)'/.exec(read('src/lib/i18n/en.js'))?.[1];
    expect(toast).toBeTruthy();
    expect(page).toContain(`it answers *${toast}* every time`);

    // None of it stops the migration, and the migration changes none of it.
    await db.runFile(migration.paths.migration);
    expect(await printedAudit(db)).toMatchObject(LEFT_BEHIND);

    // The block in the trash: switched off, and still in the trash.
    expect(await db.query.rows(switchTrashOff)).toEqual([{ name: 'Finished block' }]);
    expect(await db.query.one(`select is_active, deleted_at is not null as in_trash from public.programs where id = '${FINISHED}'`))
      .toEqual({ is_active: false, in_trash: true });
    expect(await db.query.rows(switchTrashOff)).toEqual([]);

    // The parked sessions and phases: the order that is on screen, numbered again.
    expect(await db.query.rows(renumberSessions)).toEqual([{ phase: W1, renumbered: '' }]);
    expect(await db.query.rows(renumberPhases)).toEqual([{ block: NEXT, renumbered: '' }]);
    expect(await rows(db)).toEqual({ active: null, sessions: 'S0=0 S1=1 S2=2 S3=0 S4=0', phases: '1 2 1' });
    expect(await db.query.value(firstPhase)).toBe('S3 S1 S2');
    expect(await db.query.value(phases)).toBe(`${W2} ${W1}`);
    // Run again, each finds nothing to renumber.
    expect(await db.query.rows(renumberSessions)).toEqual([]);
    expect(await db.query.rows(renumberPhases)).toEqual([]);

    expect(await printedAudit(db)).toMatchObject({
      [LINE.withoutBlock]: '1', [LINE.trashActive]: '0', [LINE.parkedSessions]: '0', [LINE.parkedPhases]: '0',
    });
    // Alex is still without a block: that one is the coach's to decide — and with the function, one request.
    expect(await story(db, THE_COACH, `select public.activate_program('${BLOCK}')`, activeBlocks)).toBe('Block');
    await db.drop();
  });

  it('a block in the trash that is still active is switched off by Set active on another one, with the app that is deployed and with the function alike', async () => {
    const db = await production();
    await db.runFile(migration.paths.migration);
    const TRASHED = '00000000-0000-4000-8000-000000000304';
    await db.query(`update public.programs set is_active = false where id = '${BLOCK}'`);
    await db.query(`insert into public.programs (id, student_id, name, is_active, deleted_at)
                    values ('${TRASHED}', '${LINK}', 'In the trash', true, now())`);
    expect(await printedAudit(db)).toMatchObject({ [LINE.trashActive]: '1' });

    expect(await story(db, THE_COACH, activateNext, activeBlocks)).toBe('Next block');
    expect(await story(db, THE_COACH,
      `update public.programs set is_active = false where student_id = '${LINK}' and is_active = true`,
      `update public.programs set is_active = true where id = '${NEXT}'`, activeBlocks)).toBe('Next block');
    expect(page).toContain('both switch off every other block of the athlete, the one in the trash included');
    await db.drop();
  });

  it('without migration 10 it says so (SLM02), and its rollback says there is nothing to undo (SLM03)', async () => {
    const db = await scratchDatabase();
    await db.runFile(manifest.baseline);
    const refusals = async () => {
      const before = await catalogSnapshot(db.query);
      const refused = await attempt(() => db.runFile(migration.paths.migration));
      const undone = await attempt(() => db.runFile(migration.paths.rollback));
      expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
      return [refused.error?.code, refused.error?.message, undone.error?.code];
    };
    // Without a ledger at all, then with the ledger and the migrations before 10 only.
    const needs = 'needs 2026_10_13_10_goals_fk_coach_links, which is not applied';
    let [code, message, undone] = await refusals();
    expect([code, undone]).toEqual([REFUSAL.predecessorMissing, REFUSAL.notApplied]);
    expect(message).toContain(needs);
    for (const earlier of manifest.migrations.slice(0, 9)) await db.runFile(earlier.paths.migration);
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
  it('refuses to run when a function of one of the three names is there already, and changes nothing', async () => {
    const db = await production();
    const refusalOf = async () => {
      const before = await catalogSnapshot(db.query);
      const refused = await attempt(() => db.runFile(migration.paths.migration));
      await untouched(db, before);
      return refused.error?.message ?? 'it ran';
    };

    // With other arguments: it would stay next to the new one.
    await db.query(`create function public.reorder_sessions(p_ids uuid[]) returns void language sql as 'select'`);
    expect(await refusalOf()).toContain(`migration ${MIGRATION} would not create: reorder_sessions(uuid[]) is already there`);
    expect(await printedAudit(db)).toMatchObject({ [LINE.strangers]: 'reorder_sessions(uuid[])', [LINE.sessions]: 'no' });
    expect(page).toContain('- **5** is not `none` — **stop and report the line.**');
    await db.query(`drop function public.reorder_sessions(uuid[])`);

    // With the same arguments: the audit reads `yes`, and the ledger does not know why.
    await db.query(`create function public.activate_program(p_program_id uuid) returns jsonb language sql as 'select null::jsonb'`);
    expect(await refusalOf()).toContain(`migration ${MIGRATION} would not create: activate_program(uuid) is already there`);
    expect(await printedAudit(db)).toMatchObject({ [LINE.strangers]: 'none', [LINE.activate]: 'yes', [LINE.weeks]: 'no' });
    expect(page).toContain('If it is not, a function of that name was made by hand: stop and report.');
    expect(page).toContain('| `would not create: … is already there` |');
    await db.query(`drop function public.activate_program(uuid)`);

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

  // The body of a function is not checked against the tables when it is
  // created: a column that is not there would be found by the first call.
  it('refuses to run when a column its functions are written with is not there', async () => {
    const db = await production();
    await db.query(`alter table public.sessions rename column sort_order to position`);
    await db.query(`alter table public.programs rename column deleted_at to trashed_at`);
    const before = await catalogSnapshot(db.query);
    const refused = await attempt(() => db.runFile(migration.paths.migration));
    expect(refused.error?.message).toContain(
      `migration ${MIGRATION} does not find the columns its functions are written with: public.programs.deleted_at, public.sessions.sort_order`,
    );
    await untouched(db, before);
    expect(page).toContain('| `does not find the columns its functions are written with: …` |');

    await db.query(`alter table public.sessions rename column position to sort_order`);
    await db.query(`alter table public.programs rename column trashed_at to deleted_at`);
    await db.runFile(migration.paths.migration);
    await db.drop();
  });

  // The privileges stand next to each function: what a new function is born
  // with is not this file's to rely on.
  it('applied where a new function is born open to everybody, the three are still closed to a request without a session', async () => {
    const db = await production();
    // Supabase's own defaults, as they were before migration 03.
    await db.query(`alter default privileges for role postgres grant execute on functions to public`);
    await db.query(`alter default privileges for role postgres in schema public grant execute on functions to anon, authenticated`);
    await db.runFile(migration.paths.migration);
    expect(await printedAudit(db)).toMatchObject({ [LINE.anon]: 'none', [LINE.users]: THE_THREE });
    expect(await story(db, NOBODY, activateNext)).toBe('permission denied for function activate_program');
    await db.runFile(migration.paths.rollback);

    // … and a file that forgot one of them reads its own result back, and undoes itself.
    const text = read(migration.paths.migration);
    const forgot = text.replace('REVOKE ALL ON FUNCTION public.reorder_weeks(uuid, uuid[]) FROM PUBLIC, anon, authenticated;\n', '');
    expect(forgot).not.toBe(text);
    const before = await catalogSnapshot(db.query);
    const refused = await attempt(() => db.runSql(forgot, 'migration'));
    expect(refused.error?.message).toContain(
      `migration ${MIGRATION} did not get the functions it meant: public.reorder_weeks(uuid, uuid[]): anon may execute it, PUBLIC may execute it`,
    );
    await untouched(db, before);
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
    expect(await story(db, THE_COACH, activateNext, activeBlocks)).toBe('Next block');
    await db.drop();
  });

  // What the rollback page says of what happened while the migration was in place.
  it('rolled back: a block that was set active stays active, and sessions and phases keep the order they were given', async () => {
    const db = await production();
    await db.runFile(migration.paths.migration);
    const asCoach = (sql) => db.runSql(
      `BEGIN;
       select set_config('role', 'authenticated', true), set_config('request.jwt.claims', '${JSON.stringify(THE_COACH.claims)}', true);
       ${sql};
       COMMIT;`, 'request',
    );
    await asCoach(activateNext);
    await asCoach(reorderFirstPhase);
    await asCoach(reorderPhases);
    const GIVEN = { active: 'Next block', sessions: 'S0=0 S1=1 S2=2 S3=0 S4=0', phases: '1 2 1' };
    expect(await rows(db)).toEqual(GIVEN);

    await db.runFile(migration.paths.rollback);
    expect(await rows(db)).toEqual(GIVEN);
    expect(await printedAudit(db)).toMatchObject({ [LINE.activate]: 'no', [LINE.sessions]: 'no', [LINE.weeks]: 'no', [LINE.users]: 'none' });
    expect(page).toContain('a block that was set active stays active, and sessions and phases keep the order they were given');

    // A function of one of the names made AFTERWARDS, with other arguments, is not the rollback's to drop.
    await db.runFile(migration.paths.migration);
    await db.query(`create function public.reorder_weeks(p_ids uuid[]) returns void language sql as 'select'`);
    await db.runFile(migration.paths.rollback);
    expect(await db.query.value(`select to_regprocedure('public.reorder_weeks(uuid[])') is not null`)).toBe(true);
    await db.query(`drop function public.reorder_weeks(uuid[])`);
    // …and the migration applies again on what the rollback left.
    await db.runFile(migration.paths.migration);
    expect(await story(db, THE_COACH, `select public.activate_program('${BLOCK}')`, activeBlocks)).toBe('Block');
    await db.drop();
  });
});
