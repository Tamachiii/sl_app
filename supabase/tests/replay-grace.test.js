// A block stays open for its athlete for 72 hours after it is switched off —
// review finding P55, closed by migration 2026_10_13_17_replay_grace_window.
//
// The app queues what an athlete logs without a connection and sends it when
// the connection is back. An athlete writes only in the block being trained
// (program_active_for_session, asked by every policy an athlete's write goes
// through), so when the coach activated the next block in between, the whole
// workout was replayed against a block that was no longer the active one:
// every set reached no row, the confirmation and the notes were refused, and
// nothing could be sent again. Since the migration:
//
//   programs.deactivated_at   when is_active last went from true to false.
//                             Written by trg_stamp_program_deactivated_at,
//                             whichever way a block is switched off; not by a
//                             request that carries a user id.
//   the window                program_active_for_session answers yes for a
//                             program out of the trash that is the active one
//                             OR was switched off less than 72 hours ago.
//
// The lock of a SESSION (archived, reviewed) is session-gates.test.js and
// review-lifecycle.test.js, and holds inside the window too.
//
// A test cannot wait 73 hours: it moves the time of the switch back instead,
// as the owner of the database — the one caller the column can be written by
// (pastBlock() of the harness). Inside a scenario() everything is one
// transaction, so now() is one instant: a block switched off there was
// switched off "0 hours ago", exactly.
//
// The first blocks run against schema.sql, as the callers the app has. The
// requests of the app that is DEPLOYED are written out as it sends them
// (src/hooks/useProgram.js for the coach, src/lib/offlineMutations.js for the
// athlete's queue): the migration is applied while that app is live. The last
// block applies the migration file itself to the frozen production baseline,
// with the checks of its runbook page read off the page.

import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  asAdmin, asService, asUser, attempt, createDraftProgram, createProgram, pastBlock, repoRoot, scenario,
  scratchDatabase, seed,
} from './harness.js';
import { catalogSnapshot, diffCatalogs } from './catalog.js';
import { LEDGER, loadManifest, REFUSAL } from '../migrations/manifest.js';

const MIGRATION = '2026_10_13_17_replay_grace_window';
const manifest = loadManifest();
const migration = manifest.migrations.find((m) => m.name === MIGRATION);
const read = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8');

// seed(): coach Carla; Alex (athlete A) trains "Block A" — 2 weeks × 2
// sessions, each a pull-up slot and a dip slot of 3 sets; Billie (athlete B)
// trains "Block B". Next to them:
//   next    "Block A2" of Alex: two sessions, never the active block
//   draft   "My draft", which Alex is writing
let ids;
let next;
let draft;
beforeAll(async () => {
  ids = await seed();
  const used = [ids.exercises.pullUp, ids.exercises.dip];
  next = await createProgram({ student: ids.studentA, name: 'Block A2', exercises: used, sessions: 2 });
  draft = await createDraftProgram(ids.studentA, { exercises: used });
});

const coach = (fn) => asUser(ids.coach, fn);
const alex = (fn) => asUser(ids.studentA, fn);
const sessionsOfA = () => ids.programA.tree.flatMap((week) => week.sessions);
/** Session n of Block A: `{ id, pullUp, dip }`, each `{ id, setLogs: [id × 3] }`. */
const session = (n) => {
  const { id, slots: [pullUp, dip] } = sessionsOfA()[n];
  return { id, pullUp, dip };
};
/** The same for the first session of "Block A2". */
const sessionOfNext = () => {
  const { id, slots: [pullUp, dip] } = next.tree[0].sessions[0];
  return { id, pullUp, dip };
};

/**
 * How long ago the block was switched off, in hours, on the clock of the
 * transaction: 0 for "by a request of this scenario", null for "no time".
 */
const switchedOff = (q, programId) => q.value(
  `select (extract(epoch from now() - deactivated_at) / 3600)::numeric(12, 2) from programs where id = $1`, [programId],
);
/** The same for every block of Alex, by name. */
const times = async (q) => Object.fromEntries((await q.rows(
  `select name, (extract(epoch from now() - deactivated_at) / 3600)::numeric(12, 2) as hours
     from programs where student_id = $1`, [ids.studentA.studentRowId],
)).map((row) => [row.name, row.hours]));
const NO_TIME = { 'Block A': null, 'Block A2': null, 'My draft': null };
const activeOf = async (q, athlete = ids.studentA) => (await q.rows(
  `select name from programs where student_id = $1 and is_active order by name`, [athlete.studentRowId],
)).map((row) => row.name);
/** program_active_for_session: may the athlete of this session still write in its program. */
const open = (q, sessionId) => q.value(`select public.program_active_for_session($1)`, [sessionId]);

// ------------------------------------------------------------
// The coach's app, as SQL: one entry per request.
// ------------------------------------------------------------
const coachApp = {
  // hooks/useProgram.js, useSetActiveProgram — the app that is deployed: the
  // block that is trained off, then the chosen one on. Two requests.
  switchOff: (c, athlete = ids.studentA) => c(
    `update programs set is_active = false where student_id = $1 and is_active = true`, [athlete.studentRowId],
  ),
  switchOn: (c, programId) => c(`update programs set is_active = true where id = $1 returning id`, [programId]),
  // useCreateProgram: with `setActive` the request above goes first.
  create: (c, name, active) => c.value(
    `insert into programs (student_id, name, sort_order, is_active) values ($1, $2, 7, $3) returning id`,
    [ids.studentA.studentRowId, name, active],
  ),
  rename: (c, programId, name) => c(`update programs set name = $2 where id = $1 returning id`, [programId, name]),
  // useDeleteProgram, useRestoreProgram.
  trash: (c, programId) => c(`update programs set deleted_at = now(), is_active = false where id = $1`, [programId]),
  restore: (c, programId) => c(`update programs set deleted_at = null where id = $1`, [programId]),
  // The function of migration 11, which the next app calls.
  activate: (c, programId) => c.value(`select public.activate_program($1)`, [programId]),
};
/** "Set active", as the app that is deployed sends it. */
const setActiveAsDeployed = async (programId) => {
  await coach((c) => coachApp.switchOff(c));
  await coach((c) => coachApp.switchOn(c, programId));
};

// ------------------------------------------------------------
// The athlete's queue, as SQL: the nine writes the app keeps while it has no
// connection (lib/offlineMutations.js, MUTATION_KEYS). PostgREST turns
// `.update().eq().select().single()` into UPDATE … RETURNING, and
// `.upsert(…, { onConflict })` into INSERT … ON CONFLICT DO UPDATE SET every
// column it was given — DO NOTHING with `ignoreDuplicates`.
// ------------------------------------------------------------
const TAPPED = '2026-10-10T16:05:00.000Z';
const queue = {
  toggleDone: (a, set) => a(
    `update set_logs set done = true, failed = false, logged_at = $2, failed_at = null where id = $1 returning id`, [set, TAPPED],
  ),
  setFailed: (a, set) => a(
    `update set_logs set failed = true, done = false, failed_at = $2, logged_at = null, rpe = null where id = $1 returning id`, [set, TAPPED],
  ),
  setRpe: (a, set) => a(`update set_logs set rpe = 8 where id = $1 returning id`, [set]),
  logActual: (a, set) => a(`update set_logs set actual_reps = 4, actual_weight_kg = 22.5 where id = $1 returning id`, [set]),
  setSkipped: (a, set) => a(
    `update set_logs set skipped = true, done = false, failed = false, rpe = null, logged_at = null, failed_at = null,
                         actual_reps = null, actual_weight_kg = null
      where id = $1 returning id`, [set],
  ),
  saveSlotComment: (a, slot, body) => a(
    `insert into slot_comments (exercise_slot_id, student_id, body, updated_at) values ($1, $2, $3, now())
     on conflict (exercise_slot_id) do update
       set student_id = excluded.student_id, body = excluded.body, updated_at = excluded.updated_at
     returning id`, [slot.id, ids.studentA.id, body],
  ),
  saveSlotDeviation: (a, slot, kind, substitute = null) => a(
    `insert into slot_deviations (exercise_slot_id, student_id, kind, substitute_exercise_id, note, updated_at)
     values ($1, $2, $3, $4, null, now())
     on conflict (exercise_slot_id) do update
       set student_id = excluded.student_id, kind = excluded.kind,
           substitute_exercise_id = excluded.substitute_exercise_id, note = excluded.note, updated_at = excluded.updated_at
     returning id`, [slot.id, ids.studentA.id, kind, substitute],
  ),
  // The app of wave 1: insert or nothing. `performed_on` is the day the
  // athlete trained, computed on the phone when they confirmed.
  confirmSession: (a, sessionId) => a(
    `insert into session_confirmations (session_id, student_id, notes, performed_on) values ($1, $2, 'Good one', '2026-10-10')
     on conflict (session_id) do nothing returning id`, [sessionId, ids.studentA.id],
  ),
  // The app before wave 1: an upsert that updates.
  confirmSessionAsBefore: (a, sessionId) => a(
    `insert into session_confirmations (session_id, student_id, notes, performed_on) values ($1, $2, 'Good one', '2026-10-10')
     on conflict (session_id) do update
       set student_id = excluded.student_id, notes = excluded.notes, performed_on = excluded.performed_on
     returning id`, [sessionId, ids.studentA.id],
  ),
  unconfirmSession: (a, sessionId) => a(`delete from session_confirmations where session_id = $1`, [sessionId]),
};

/**
 * A workout, as the queue holds it: `[what, kind, run]` — kind 'insert'
 * raises when it is refused, 'write' reaches no row. In the order of the taps,
 * so that they can be sent one after the other.
 */
const workout = (s) => [
  ['set 1: done', 'write', (a) => queue.toggleDone(a, s.pullUp.setLogs[0])],
  ['set 1: its RPE', 'write', (a) => queue.setRpe(a, s.pullUp.setLogs[0])],
  ['set 2: other reps and load', 'write', (a) => queue.logActual(a, s.pullUp.setLogs[1])],
  ['set 2: done', 'write', (a) => queue.toggleDone(a, s.pullUp.setLogs[1])],
  ['set 3: failed', 'write', (a) => queue.setFailed(a, s.pullUp.setLogs[2])],
  ['a set of the next exercise: skipped', 'write', (a) => queue.setSkipped(a, s.dip.setLogs[0])],
  ['a note on an exercise', 'insert', (a) => queue.saveSlotComment(a, s.pullUp, 'Felt heavy')],
  ['the note, rewritten', 'insert', (a) => queue.saveSlotComment(a, s.pullUp, 'Felt fine')],
  ['an exercise skipped', 'insert', (a) => queue.saveSlotDeviation(a, s.dip, 'skip')],
  ['… swapped instead', 'insert', (a) => queue.saveSlotDeviation(a, s.dip, 'swap', ids.exercises.squat)],
  ['the confirmation', 'insert', (a) => queue.confirmSession(a, s.id)],
  ['the confirmation, taken back', 'write', (a) => queue.unconfirmSession(a, s.id)],
  ['the confirmation, as the app before wave 1 sends it', 'insert', (a) => queue.confirmSessionAsBefore(a, s.id)],
];
const withoutTheConfirmation = (writes) => writes.filter(([what]) => !what.startsWith('the confirmation'));

/** How a write ended: `1 row`, `0 rows`, or what refused it. */
const outcome = async (run) => {
  const tried = await attempt(run);
  if (tried.ok) return `${tried.value.rowCount} row${tried.value.rowCount === 1 ? '' : 's'}`;
  const { code, message } = tried.error;
  return code === '42501' && /row-level security/.test(message) ? 'refused' : `${code}: ${message}`;
};
/** All of them, one after the other, each one kept — the phone, back online. */
const send = async (writes, athlete = ids.studentA) => {
  const out = {};
  for (const [what, , run] of writes) out[what] = await outcome(() => asUser(athlete, run));
  return out;
};
const all = (writes, answer) => Object.fromEntries(writes.map(([what, kind]) => [what, answer(kind)]));
const SAVED = (writes) => all(writes, () => '1 row');
// As before the migration, and in the shapes of session-gates.test.js.
const REFUSED = (writes) => all(writes, (kind) => (kind === 'insert' ? 'refused' : '0 rows'));

/** What the athlete left in a session, as the owner reads it. */
const trained = (q, s) => q.one(
  `select
     (select string_agg(sl.set_number || ' ' || case when sl.done then 'done' when sl.failed then 'failed'
                                                  when sl.skipped then 'skipped' else 'to do' end
                        || coalesce(' rpe ' || sl.rpe, '') || coalesce(' did ' || sl.actual_reps || '@' || sl.actual_weight_kg, ''),
                        ', ' order by sl.set_number)
        from set_logs sl where sl.exercise_slot_id = $2) as pull_up,
     (select string_agg(sl.set_number || ' ' || case when sl.done then 'done' when sl.failed then 'failed'
                                                  when sl.skipped then 'skipped' else 'to do' end, ', ' order by sl.set_number)
        from set_logs sl where sl.exercise_slot_id = $3) as dip,
     (select string_agg(c.body, ' | ') from slot_comments c where c.exercise_slot_id in ($2, $3)) as notes,
     (select string_agg(d.kind, ' | ') from slot_deviations d where d.exercise_slot_id in ($2, $3)) as deviations,
     (select string_agg(sc.performed_on::text, ' | ') from session_confirmations sc where sc.session_id = $1) as confirmed_for,
     (select se.performed_at is not null from sessions se where se.id = $1) as dated`,
  [s.id, s.pullUp.id, s.dip.id],
);
const NOT_TRAINED = {
  pull_up: '1 to do, 2 to do, 3 to do', dip: '1 to do, 2 to do, 3 to do', notes: null, deviations: null, confirmed_for: null, dated: false,
};
const THE_WORKOUT = {
  // numeric(3,1) since 2026_10_16_21: an RPE of 8 prints as 8.0.
  pull_up: '1 done rpe 8.0, 2 done did 4@22.50, 3 failed',
  dip: '1 skipped, 2 to do, 3 to do',
  notes: 'Felt fine',
  deviations: 'swap',
  // The day the athlete trained, not the day the phone got through.
  confirmed_for: '2026-10-10',
  dated: true,
};
/** What the coach's bell holds about Alex's training. */
const bell = async (q) => (await q.rows(
  `select kind, count(*) as n from notifications where recipient_id = $1 and kind in ('session_completed', 'session_deviation')
    group by kind order by kind`, [ids.coach.id],
)).map((row) => `${row.n} ${row.kind}`);

// ============================================================
// The time
// ============================================================
describe('programs.deactivated_at: a block says when it was switched off', () => {
  it('nothing has a time to start with: the blocks that are trained, a block that never was, a draft', () => asAdmin(async (q) => {
    expect(await times(q)).toEqual(NO_TIME);
    expect(await switchedOff(q, ids.programB.id)).toBeNull();
  }));

  it('"Set active" as the app that is deployed sends it — two requests: the block that was trained says when, the one that is trained says nothing', () => scenario(async (q) => {
    await coach((c) => coachApp.switchOff(c));
    // The first request alone: the athlete has no active block for a moment,
    // and the block they had says since when.
    expect(await activeOf(q)).toEqual([]);
    expect(await times(q)).toEqual({ ...NO_TIME, 'Block A': 0 });

    await coach((c) => coachApp.switchOn(c, next.id));
    expect(await activeOf(q)).toEqual(['Block A2']);
    expect(await times(q)).toEqual({ ...NO_TIME, 'Block A': 0 });
    // Nobody else's block was touched.
    expect(await switchedOff(q, ids.programB.id)).toBeNull();
    expect(await activeOf(q, ids.studentB)).toEqual(['Block B']);
  }));

  it('activate_program: the same — and switching back empties the one and writes the other', () => scenario(async (q) => {
    expect(await coach((c) => coachApp.activate(c, next.id))).toMatchObject({ already_active: false, deactivated: 1 });
    expect(await times(q)).toEqual({ ...NO_TIME, 'Block A': 0 });
    // Sent again, it writes nothing — the time included.
    await pastBlock(q, ids.programA.id, '5 hours');
    expect(await coach((c) => coachApp.activate(c, next.id))).toMatchObject({ already_active: true, deactivated: 0 });
    expect(await times(q)).toEqual({ ...NO_TIME, 'Block A': 5 });

    expect(await coach((c) => coachApp.activate(c, ids.programA.id))).toMatchObject({ already_active: false, deactivated: 1 });
    expect(await activeOf(q)).toEqual(['Block A']);
    expect(await times(q)).toEqual({ ...NO_TIME, 'Block A2': 0 });
  }));

  it('"New block, set active": the block that was trained says when, the new one starts without a time', () => scenario(async (q) => {
    await coach((c) => coachApp.switchOff(c));
    await coach((c) => coachApp.create(c, 'Block A3', true));
    expect(await activeOf(q)).toEqual(['Block A3']);
    expect(await times(q)).toEqual({ ...NO_TIME, 'Block A': 0, 'Block A3': null });
  }));

  // The app does not offer it — the block being trained cannot be deleted
  // there — and the API does not refuse it.
  it('the block that is trained goes to the trash: it says when, and is closed all the same', () => scenario(async (q) => {
    await coach((c) => coachApp.trash(c, ids.programA.id));
    expect(await times(q)).toEqual({ ...NO_TIME, 'Block A': 0 });
    expect(await open(q, session(0).id)).toBe(false);
  }));

  it('a block that never was the active one has no time, and nothing but a switch writes one: a new block, a copy, an approved draft, a rename, the trash and back', () => scenario(async (q) => {
    const made = await coach((c) => coachApp.create(c, 'Block A3', false));
    const copy = await coach((c) => c.value(`select public.duplicate_program($1)`, [ids.programA.id]));
    await coach((c) => c.value(`select public.approve_program($1)`, [draft.id]));
    await coach((c) => coachApp.rename(c, next.id, 'Block A2, renamed'));
    await coach((c) => c(`update programs set sort_order = 3 where id = $1`, [next.id]));
    await coach((c) => coachApp.trash(c, next.id));
    await coach((c) => coachApp.restore(c, next.id));
    // …and the block that is trained, written without being switched.
    await coach((c) => coachApp.rename(c, ids.programA.id, 'Block A, renamed'));

    expect(await q.rows(
      `select name, status, is_active, deactivated_at from programs where student_id = $1 order by name`, [ids.studentA.studentRowId],
    )).toEqual([
      { name: 'Block A (copy)', status: 'approved', is_active: false, deactivated_at: null },
      { name: 'Block A, renamed', status: 'approved', is_active: true, deactivated_at: null },
      { name: 'Block A2, renamed', status: 'approved', is_active: false, deactivated_at: null },
      { name: 'Block A3', status: 'approved', is_active: false, deactivated_at: null },
      { name: 'My draft', status: 'approved', is_active: false, deactivated_at: null },
    ]);
    expect([made, copy.program_id].every(Boolean)).toBe(true);
    // None of them is open for Alex but the one he trains.
    expect(await open(q, session(0).id)).toBe(true);
    expect(await open(q, sessionOfNext().id)).toBe(false);
    expect(await open(q, draft.sessions[0])).toBe(false);
  }));

  it('once written it stays what it was — a rename, the trash and back — until the block is switched on again', () => scenario(async (q) => {
    await setActiveAsDeployed(next.id);
    await pastBlock(q, ids.programA.id, '5 hours');

    await coach((c) => coachApp.rename(c, ids.programA.id, 'Block A'));
    await coach((c) => coachApp.trash(c, ids.programA.id));
    expect(await times(q)).toEqual({ ...NO_TIME, 'Block A': 5 });
    await coach((c) => coachApp.restore(c, ids.programA.id));
    expect(await times(q)).toEqual({ ...NO_TIME, 'Block A': 5 });

    await setActiveAsDeployed(ids.programA.id);
    expect(await times(q)).toEqual({ ...NO_TIME, 'Block A2': 0 });
    // Switched off a second time, it says the second time.
    await setActiveAsDeployed(next.id);
    expect(await times(q)).toEqual({ ...NO_TIME, 'Block A': 0 });
  }));
});

// ============================================================
// Who writes the time
// ============================================================
describe('the time is the trigger\'s: a request that carries a user id does not write it', () => {
  const state = (q, programId) => q.one(
    `select name, (extract(epoch from now() - deactivated_at) / 3600)::numeric(12, 2) as hours from programs where id = $1`, [programId],
  );

  it('the coach: a time sent with an update is left out, silently, and the rest of the update is saved', () => scenario(async (q) => {
    await setActiveAsDeployed(next.id);
    await pastBlock(q, ids.programA.id, '5 hours');

    // On a block that was switched off: not moved ahead, not moved back, not emptied.
    for (const [sent, name] of [[`now() + interval '240 hours'`, 'ahead'], [`now() - interval '100 hours'`, 'back'], ['null', 'emptied']]) {
      const answered = await coach((c) => c.one(
        `update programs set deactivated_at = ${sent}, name = $2 where id = $1
         returning name, (extract(epoch from now() - deactivated_at) / 3600)::numeric(12, 2) as hours`, [ids.programA.id, name],
      ));
      // No error, and RETURNING answers the row as it is stored.
      expect(answered, name).toEqual({ name, hours: 5 });
      expect(await state(q, ids.programA.id), name).toEqual({ name, hours: 5 });
    }
    // On the block that is trained, and on one that never was.
    await coach((c) => c(`update programs set deactivated_at = now() where id = any($1)`, [[next.id, draft.id]]));
    expect(await times(q)).toEqual({ emptied: 5, 'Block A2': null, 'My draft': null });
  }));

  it('the coach: a block inserted with a time starts without one, and an upsert does not write it either', () => scenario(async (q) => {
    const made = await coach((c) => c.value(
      `insert into programs (student_id, name, is_active, deactivated_at) values ($1, 'Block A3', false, now()) returning id`,
      [ids.studentA.studentRowId],
    ));
    expect(await state(q, made)).toEqual({ name: 'Block A3', hours: null });

    await coach((c) => c(
      `insert into programs (id, student_id, name, deactivated_at) values ($1, $2, 'Block A2', now() + interval '240 hours')
       on conflict (id) do update set deactivated_at = excluded.deactivated_at, name = 'Upserted'`,
      [next.id, ids.studentA.studentRowId],
    ));
    expect(await state(q, next.id)).toEqual({ name: 'Upserted', hours: null });
  }));

  // The hole the rule is there for. The author of a draft writes the row of
  // their draft, and program_active_for_session reads the column as "the
  // athlete may still write here": a time put there before the coach approves
  // would keep the block open for its athlete for good.
  it('the author of a draft: a time written on the draft is left out, and the block is closed once it is approved', () => scenario(async (q) => {
    const answered = await alex((a) => a.one(
      `update programs set deactivated_at = now() + interval '240 hours', name = 'Mine' where id = $1
       returning name, deactivated_at`, [draft.id],
    ));
    expect(answered).toEqual({ name: 'Mine', deactivated_at: null });
    expect(await state(q, draft.id)).toEqual({ name: 'Mine', hours: null });
    // Through the function the app saves a draft with: it writes the name, and nothing of the rest.
    await alex((a) => a.value(`select public.save_draft_tree($1)`, [{
      program: { id: draft.id, name: 'Mine, saved', deactivated_at: '2099-01-01T00:00:00Z' }, weeks: [], sessions: [], slots: [],
    }]));
    expect(await state(q, draft.id)).toEqual({ name: 'Mine, saved', hours: null });

    // A draft that is inserted with a time — Billie has none yet — starts without one.
    const billies = await asUser(ids.studentB, (b) => b.one(
      `insert into programs (student_id, name, status, is_active, created_by, deactivated_at)
       values ($1, 'Billie writes one', 'draft', false, $2, now() + interval '240 hours') returning id, deactivated_at`,
      [ids.studentB.studentRowId, ids.studentB.id],
    ));
    expect(billies.deactivated_at).toBeNull();
    expect(await state(q, billies.id)).toEqual({ name: 'Billie writes one', hours: null });

    await coach((c) => c.value(`select public.approve_program($1)`, [draft.id]));
    expect(await state(q, draft.id)).toEqual({ name: 'Mine, saved', hours: null });
    // An athlete writes no row of a block that is not their draft, this column or another.
    expect((await alex((a) => a(`update programs set deactivated_at = now() where id = $1`, [draft.id]))).rowCount).toBe(0);
    expect((await alex((a) => a(`update programs set deactivated_at = now() where id = $1`, [next.id]))).rowCount).toBe(0);
    expect(await times(q)).toEqual({ 'Block A': null, 'Block A2': null, 'Mine, saved': null });
  }));

  // The owner of the database (the SQL editor) and the service role (an Edge
  // Function): that is how a window is closed early, or opened again
  // (docs/runbook/migrations/17-replay-grace-window.md).
  for (const [who, as] of [
    ['the owner of the database', (fn) => asAdmin(fn)],
    ['the service role', (fn) => asService(fn)],
  ]) {
    it(`${who}: writes it as the statement says on a block that is not active — never on the active one, and a switch always says now`, () => scenario(async (q) => {
      // A block that is not active: opened, moved, closed.
      await as((s) => s(`update programs set deactivated_at = now() - interval '2 hours' where id = $1`, [next.id]));
      expect(await times(q)).toEqual({ ...NO_TIME, 'Block A2': 2 });
      expect(await open(q, sessionOfNext().id)).toBe(true);
      await as((s) => s(`update programs set deactivated_at = null where id = $1`, [next.id]));
      expect(await times(q)).toEqual(NO_TIME);
      expect(await open(q, sessionOfNext().id)).toBe(false);
      // A new one, not active, comes with the time it is given…
      const restored = await as((s) => s.value(
        `insert into programs (student_id, name, is_active, deactivated_at) values ($1, 'Restored', false, now() - interval '3 hours') returning id`,
        [ids.studentA.studentRowId],
      ));
      expect(await switchedOff(q, restored)).toBe(3);

      // The block that is trained: never.
      await as((s) => s(`update programs set deactivated_at = now() - interval '2 hours' where id = $1`, [ids.programA.id]));
      expect(await switchedOff(q, ids.programA.id)).toBeNull();
      // …and one that is switched off by the statement: now, whatever it says.
      await as((s) => s(`update programs set is_active = false, deactivated_at = now() - interval '9 hours' where id = $1`, [ids.programA.id]));
      expect(await switchedOff(q, ids.programA.id)).toBe(0);
      // Inserted active with a time: without one.
      const active = await as((s) => s.value(
        `insert into programs (student_id, name, is_active, deactivated_at) values ($1, 'Active', true, now()) returning id`,
        [ids.studentA.studentRowId],
      ));
      expect(await switchedOff(q, active)).toBeNull();
    }));
  }
});

// ============================================================
// The window
// ============================================================
describe('program_active_for_session: the active block, and for 72 hours the one that was switched off', () => {
  it('yes up to the last second of the 72 hours, no from then on — by session and by slot', () => scenario(async (q) => {
    const s = session(0);
    const both = () => q.one(
      `select public.program_active_for_session($1) as session, public.program_active_for_slot($2) as slot`, [s.id, s.pullUp.id],
    );
    const YES = { session: true, slot: true };
    const NO = { session: false, slot: false };

    expect(await both()).toEqual(YES);
    for (const [ago, answer] of [
      ['0 seconds', YES], ['1 hour', YES], ['71 hours 59 minutes 59 seconds', YES],
      ['72 hours', NO], ['72 hours 1 second', NO], ['73 hours', NO], ['30 days', NO],
    ]) {
      await pastBlock(q, ids.programA.id, ago);
      expect(await both(), ago).toEqual(answer);
    }
    // Switched on again: open, and the time is gone with the switch.
    await coach((c) => coachApp.activate(c, ids.programA.id));
    expect(await both()).toEqual(YES);
    expect(await switchedOff(q, ids.programA.id)).toBeNull();
  }));

  it('no for a block without a time: never the active one, or switched off before there was a column — false, not NULL', () => scenario(async (q) => {
    expect(await open(q, sessionOfNext().id)).toBe(false);
    await pastBlock(q, ids.programA.id, '1 hour');
    await q(`update programs set deactivated_at = null where id = $1`, [ids.programA.id]);
    expect(await q.one(
      `select public.program_active_for_session($1) as session, public.program_active_for_slot($2) as slot`,
      [session(0).id, session(0).pullUp.id],
    )).toEqual({ session: false, slot: false });
    // A session, a slot that does not exist: NULL, as before — a caller asks `= true` or `IS NOT TRUE`.
    const nowhere = '00000000-0000-4000-8000-00000000dead';
    expect(await q.one(
      `select public.program_active_for_session($1) as session, public.program_active_for_slot($1) as slot`, [nowhere],
    )).toEqual({ session: null, slot: null });
  }));

  it('no for a block in the trash, inside its 72 hours too — and yes again for what is left of them once it is taken out', () => scenario(async (q) => {
    const s = session(0);
    await setActiveAsDeployed(next.id);
    await pastBlock(q, ids.programA.id, '70 hours');
    expect(await open(q, s.id)).toBe(true);

    await coach((c) => coachApp.trash(c, ids.programA.id));
    expect(await open(q, s.id)).toBe(false);
    await coach((c) => coachApp.restore(c, ids.programA.id));
    expect(await open(q, s.id)).toBe(true);
    // The time is the one of the switch: the trash did not start the 72 hours again.
    expect(await switchedOff(q, ids.programA.id)).toBe(70);
    await pastBlock(q, ids.programA.id, '72 hours');
    expect(await open(q, s.id)).toBe(false);
  }));

  // A draft cannot be active, so the trigger never gives it a time. One the
  // owner writes by hand is not read.
  it('no for a draft, whatever time it holds', () => scenario(async (q) => {
    await q(`update programs set deactivated_at = now() - interval '1 hour' where id = $1`, [draft.id]);
    expect(await switchedOff(q, draft.id)).toBe(1);
    expect(await open(q, draft.sessions[0])).toBe(false);
    // Approved with that time on it — which only the owner could have written — it is a block like another.
    await q(`update programs set status = 'approved' where id = $1`, [draft.id]);
    expect(await open(q, draft.sessions[0])).toBe(true);
  }));

  it('answers the same whoever asks', () => scenario(async (q) => {
    await setActiveAsDeployed(next.id);
    for (const who of [ids.studentA, ids.studentB, ids.coach]) {
      expect(await asUser(who, (user) => user.value(`select public.program_active_for_slot($1)`, [session(0).pullUp.id]))).toBe(true);
    }
    await pastBlock(q, ids.programA.id);
    for (const who of [ids.studentA, ids.studentB, ids.coach]) {
      expect(await asUser(who, (user) => user.value(`select public.program_active_for_slot($1)`, [session(0).pullUp.id]))).toBe(false);
    }
  }));
});

// ============================================================
// The finding
// ============================================================
describe('a workout logged without a connection, sent after the coach has switched blocks (P55)', () => {
  it('inside the 72 hours every write of the queue is saved, in the session it was logged in — and the coach is told', () => scenario(async (q) => {
    const s = session(0);
    const writes = workout(s);
    const before = await bell(q);
    // Alex trains session 1 of Block A in a gym without a connection: nothing
    // reaches the database. Meanwhile the coach, with the app that is deployed:
    await setActiveAsDeployed(next.id);
    expect(await activeOf(q)).toEqual(['Block A2']);
    expect(await trained(q, s)).toEqual(NOT_TRAINED);

    // The phone is back.
    expect(await send(writes)).toEqual(SAVED(writes));
    expect(await trained(q, s)).toEqual(THE_WORKOUT);
    // The coach's bell: the session — once, the confirmation that was taken
    // back took its line with it — and the exercise that was not done as written.
    expect(before).toEqual([]);
    expect(await bell(q)).toEqual(['1 session_completed', '1 session_deviation']);
    // Block A2 is still the one block Alex trains, and its time is still the switch.
    expect(await activeOf(q)).toEqual(['Block A2']);
    expect(await times(q)).toEqual({ ...NO_TIME, 'Block A': 0 });
  }));

  it('the same after activate_program, and one hour, two days later', () => scenario(async (q) => {
    await coach((c) => coachApp.activate(c, next.id));
    for (const [n, ago] of [[0, '0 seconds'], [1, '1 hour'], [2, '48 hours']]) {
      await pastBlock(q, ids.programA.id, ago);
      const writes = workout(session(n));
      expect(await send(writes), ago).toEqual(SAVED(writes));
      expect(await trained(q, session(n)), ago).toEqual(THE_WORKOUT);
    }
  }));

  it('after the 72 hours every one is refused, as before — and nothing is written', () => scenario(async (q) => {
    const s = session(0);
    const writes = workout(s);
    await setActiveAsDeployed(next.id);
    await pastBlock(q, ids.programA.id);

    expect(await send(writes)).toEqual(REFUSED(writes));
    expect(await trained(q, s)).toEqual(NOT_TRAINED);
    expect(await bell(q)).toEqual([]);
    // Reading is what it was: Alex sees the block, its sessions and its sets.
    expect(await alex((a) => a.value(
      `select count(*) from set_logs sl join exercise_slots es on es.id = sl.exercise_slot_id where es.session_id = $1`, [s.id],
    ))).toBe(6);
  }));

  it('a block that went to the trash inside its 72 hours: refused; taken out again: saved', () => scenario(async (q) => {
    const s = session(0);
    const writes = workout(s);
    await setActiveAsDeployed(next.id);
    await coach((c) => coachApp.trash(c, ids.programA.id));

    expect(await send(writes)).toEqual(REFUSED(writes));
    expect(await trained(q, s)).toEqual(NOT_TRAINED);

    await coach((c) => coachApp.restore(c, ids.programA.id));
    expect(await send(writes)).toEqual(SAVED(writes));
    expect(await trained(q, s)).toEqual(THE_WORKOUT);
  }));

  // The third question of an athlete's write is untouched (migration 08).
  it('the lock of a session holds inside the window: one the coach reviewed or archived is closed', () => scenario(async (q) => {
    const reviewed = session(1);
    const archived = session(2);
    await alex((a) => queue.confirmSession(a, reviewed.id));
    await coach((c) => c(`update sessions set reviewed_at = now() where id = $1`, [reviewed.id]));
    await coach((c) => c(`update sessions set archived_at = now() where id = $1`, [archived.id]));
    await setActiveAsDeployed(next.id);

    for (const s of [reviewed, archived]) {
      const writes = withoutTheConfirmation(workout(s));
      expect(await send(writes)).toEqual(REFUSED(writes));
      expect(await trained(q, s)).toMatchObject({ pull_up: NOT_TRAINED.pull_up, dip: NOT_TRAINED.dip, notes: null, deviations: null });
    }
    // …while the session next to them, of the same block, is written.
    const writes = workout(session(0));
    expect(await send(writes)).toEqual(SAVED(writes));
  }));

  it('the window is the block\'s, not the queue\'s: the writes the app makes online go through as well', () => scenario(async (q) => {
    const s = session(0);
    const clip = `${ids.studentA.id}/${s.pullUp.id}/1-clip.mp4`;
    const others = [
      // hooks/useSetLogs.js: the prescribed row the deployed app adds when one is missing, and an extra set.
      ['a prescribed set that was missing', 'insert', (a) => a(
        `insert into set_logs (exercise_slot_id, set_number, done, target_reps, target_duration_seconds, target_weight_kg, target_rest_seconds)
         values ($1, 4, false, 5, null, 20, 120) returning id`, [s.dip.id],
      )],
      ['an extra set', 'insert', (a) => a(
        `insert into set_logs (exercise_slot_id, set_number, is_student_added, done, failed) values ($1, 5, true, false, false) returning id`,
        [s.dip.id],
      )],
      // hooks/useSetVideo.js: the file, then its row.
      ['the file of a video', 'insert', (a) => a(`insert into storage.objects (bucket_id, name, owner) values ('set-videos', $1, auth.uid())`, [clip])],
      ['its video', 'insert', (a) => a(
        `insert into set_log_videos (set_log_id, storage_path, mime_type, size_bytes) values ($1, $2, 'video/mp4', 1000) returning id`,
        [s.pullUp.setLogs[0], clip],
      )],
    ];
    const ensure = (sessionId) => attempt(() => alex((a) => a.value(`select public.ensure_set_logs($1)`, [sessionId])));
    await setActiveAsDeployed(next.id);

    // After the 72 hours first: each is refused, and ensure_set_logs says why.
    await pastBlock(q, ids.programA.id);
    await q(`delete from set_logs where exercise_slot_id = $1 and set_number = 3`, [s.pullUp.id]);
    expect(await send(others)).toEqual(REFUSED(others));
    expect((await ensure(s.id)).error?.message).toBe('program_not_active');

    await pastBlock(q, ids.programA.id, '1 hour');
    expect(await send(others)).toEqual(SAVED(others));
    expect((await ensure(s.id)).value).toBe(1);
  }));

  it('two blocks are open at once: the one that is trained and the one that was switched off — and no third', () => scenario(async (q) => {
    await setActiveAsDeployed(next.id);
    const third = await createProgram({ student: ids.studentA, name: 'Block A0', exercises: [ids.exercises.pullUp] });
    const tick = (set) => outcome(() => alex((a) => queue.toggleDone(a, set)));

    expect(await tick(sessionOfNext().pullUp.setLogs[0])).toBe('1 row');
    expect(await tick(session(0).pullUp.setLogs[0])).toBe('1 row');
    // A block that never was the active one: closed, as before.
    expect(await tick(third.setLogs[0])).toBe('0 rows');
    // A second switch inside the 72 hours: both former blocks are open, each from its own switch.
    await setActiveAsDeployed(third.id);
    await pastBlock(q, ids.programA.id, '71 hours');
    expect(await tick(third.setLogs[0])).toBe('1 row');
    expect(await tick(sessionOfNext().pullUp.setLogs[1])).toBe('1 row');
    expect(await tick(session(0).pullUp.setLogs[1])).toBe('1 row');
    await pastBlock(q, ids.programA.id, '72 hours');
    expect(await tick(session(0).pullUp.setLogs[2])).toBe('0 rows');
    expect(await tick(sessionOfNext().pullUp.setLogs[2])).toBe('1 row');
  }));

  it('the window opens nothing for anybody else, and holds the coach to nothing', () => scenario(async (q) => {
    const s = session(0);
    await setActiveAsDeployed(next.id);
    // Whose row it is, is still the first question.
    const writes = workout(s);
    const asBillie = await send(withoutTheConfirmation(writes).filter(([, kind]) => kind === 'write'), ids.studentB);
    expect(Object.values(asBillie).every((answer) => answer === '0 rows')).toBe(true);
    expect(await trained(q, s)).toEqual(NOT_TRAINED);
    // The coach writes a past block as before, window or not.
    await pastBlock(q, ids.programA.id);
    expect((await coach((c) => c(`update set_logs set target_reps = 6 where id = $1`, [s.pullUp.setLogs[0]]))).rowCount).toBe(1);
  }));
});

// ============================================================
// The migration file, on the frozen production baseline
// ============================================================
describe('migration 2026_10_13_17_replay_grace_window', () => {
  const COACH = '00000000-0000-4000-8000-00000000c0ac';
  const ATHLETE = '00000000-0000-4000-8000-0000000000a1';
  const LINK = '00000000-0000-4000-8000-000000000101';
  const PULL_UP = '00000000-0000-4000-8000-000000000201';
  const BLOCK = '00000000-0000-4000-8000-000000000301';
  const NEXT = '00000000-0000-4000-8000-000000000302';
  const OLD = '00000000-0000-4000-8000-000000000303';
  const TRASHED = '00000000-0000-4000-8000-000000000304';
  const DRAFT = '00000000-0000-4000-8000-000000000305';
  const W_BLOCK = '00000000-0000-4000-8000-000000000401';
  const W_OLD = '00000000-0000-4000-8000-000000000403';
  const S_BLOCK = '00000000-0000-4000-8000-000000000451';
  const S_OLD = '00000000-0000-4000-8000-000000000453';
  const SLOT_BLOCK = '00000000-0000-4000-8000-000000000501';
  const SLOT_OLD = '00000000-0000-4000-8000-000000000503';
  const SET_BLOCK = '00000000-0000-4000-8000-000000000601';
  const SET_OLD = '00000000-0000-4000-8000-000000000603';
  const TO_COME = '2099_01_01_99_a_migration_to_come';

  // A coach and their athlete. Alex trains "Block" (one session, one set) and
  // has "Next block" waiting. "Old block" was switched off some day before
  // the migration — nothing says when —, "Thrown away" is in the trash, and
  // "My draft" is Alex's. The coach's role is set the way a dump restore sets
  // it: on the baseline the documented `update profiles set role = 'coach'`
  // is undone for every caller (finding P20, closed by migration 07).
  const WORLD = `
    insert into auth.users (id, email, aud, role, email_confirmed_at, raw_user_meta_data) values
      ('${COACH}',   'coach@sl.test', 'authenticated', 'authenticated', now(), '{"full_name": "Coach Carla"}'),
      ('${ATHLETE}', 'alex@sl.test',  'authenticated', 'authenticated', now(), '{"full_name": "Alex"}');
    BEGIN;
    SET LOCAL session_replication_role = replica;
    update public.profiles set role = 'coach' where id = '${COACH}';
    COMMIT;
    insert into public.students (id, profile_id, coach_id) values ('${LINK}', '${ATHLETE}', '${COACH}');
    insert into public.exercise_library (id, coach_id, name, type, difficulty)
      values ('${PULL_UP}', '${COACH}', 'Pull-up', 'pull', 2);

    insert into public.programs (id, student_id, name, is_active, deleted_at) values
      ('${BLOCK}',   '${LINK}', 'Block',       true,  null),
      ('${NEXT}',    '${LINK}', 'Next block',  false, null),
      ('${OLD}',     '${LINK}', 'Old block',   false, null),
      ('${TRASHED}', '${LINK}', 'Thrown away', false, '2026-09-01 10:00+00');
    insert into public.programs (id, student_id, name, status, is_active, created_by)
      values ('${DRAFT}', '${LINK}', 'My draft', 'draft', false, '${ATHLETE}');
    insert into public.weeks (id, program_id, week_number) values ('${W_BLOCK}', '${BLOCK}', 1), ('${W_OLD}', '${OLD}', 1);
    insert into public.sessions (id, week_id, title, sort_order) values
      ('${S_BLOCK}', '${W_BLOCK}', 'S1', 0), ('${S_OLD}', '${W_OLD}', 'S1', 0);
    insert into public.exercise_slots (id, session_id, exercise_id, sets, reps, weight_kg, sort_order) values
      ('${SLOT_BLOCK}', '${S_BLOCK}', '${PULL_UP}', 1, 5, 20, 0),
      ('${SLOT_OLD}',   '${S_OLD}',   '${PULL_UP}', 1, 5, 20, 0);
    insert into public.set_logs (id, exercise_slot_id, set_number, target_reps, target_weight_kg) values
      ('${SET_BLOCK}', '${SLOT_BLOCK}', 1, 5, 20),
      ('${SET_OLD}',   '${SLOT_OLD}',   1, 5, 20);
  `;

  /** The frozen baseline with that world in it and the migrations before 17 applied. */
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
  // and claims set the way PostgREST sets them — or the owner's again, the
  // SQL editor. Before the first actor they are the owner's. The answer is
  // the first value of the last statement, or the message of the statement
  // that raised.
  const user = (sub) => ({ role: 'authenticated', claims: JSON.stringify({ role: 'authenticated', sub }) });
  const THE_COACH = user(COACH);
  const THE_ATHLETE = user(ATHLETE);
  const THE_OWNER = { role: 'postgres', claims: '' };
  const actor = ({ role, claims }) => `select set_config('role', '${role}', true), set_config('request.jwt.claims', '${claims}', true)`;
  const statements = (steps) => steps.map((step) => (typeof step === 'string' ? step : actor(step))).join(';\n');
  const story = async (db, ...steps) => {
    const tried = await attempt(() => db.runSql(`BEGIN;\n${statements(steps)};\nROLLBACK;`, 'request'));
    if (!tried.ok) return (tried.error.cause ?? tried.error).message;
    const [found] = tried.value.at(-2).rows;
    return found ? Object.values(found)[0] : null;
  };
  /** The same, kept. */
  const committed = (db, ...steps) => db.runSql(`BEGIN;\n${statements(steps)};\nCOMMIT;`, 'request');

  // The app that is deployed: the coach's two requests, and three of the
  // athlete's queue.
  const switchOff = `update public.programs set is_active = false where student_id = '${LINK}' and is_active = true`;
  const switchOn = (id) => `update public.programs set is_active = true where id = '${id}'`;
  const activate = (id) => `select public.activate_program('${id}')`;
  const tick = (set) => `update public.set_logs set done = true, failed = false, logged_at = now(), failed_at = null
                          where id = '${set}' returning 'saved'`;
  const confirm = `insert into public.session_confirmations (session_id, student_id, notes, performed_on)
                   values ('${S_BLOCK}', '${ATHLETE}', null, current_date)
                   on conflict (session_id) do nothing returning 'saved'`;
  const note = `insert into public.slot_comments (exercise_slot_id, student_id, body, updated_at)
                values ('${SLOT_BLOCK}', '${ATHLETE}', 'Felt heavy', now())
                on conflict (exercise_slot_id) do update
                  set student_id = excluded.student_id, body = excluded.body, updated_at = excluded.updated_at
                returning 'saved'`;
  const moveBack = (id, ago) => `update public.programs set deactivated_at = now() - interval '${ago}' where id = '${id}'`;
  const RLS = (table) => `new row violates row-level security policy for table "${table}"`;

  /** The finding: the coach switches to the next block, then the phone sends what it held. */
  const afterTheSwitch = (db, write) => story(db, THE_COACH, switchOff, switchOn(NEXT), THE_ATHLETE, write);
  const finding = async (db) => ({
    set: await afterTheSwitch(db, tick(SET_BLOCK)),
    confirmation: await afterTheSwitch(db, confirm),
    note: await afterTheSwitch(db, note),
  });
  const LOST = { set: null, confirmation: RLS('session_confirmations'), note: RLS('slot_comments') };
  const KEPT = { set: 'saved', confirmation: 'saved', note: 'saved' };

  const rows = (db) => db.query.one(
    `select (select string_agg(name, ', ' order by name) from public.programs where is_active) as active,
            (select count(*) from public.programs) as blocks,
            (select count(*) from public.set_logs where done) as done,
            (select count(*) from public.session_confirmations) as confirmations,
            (select count(*) from public.slot_comments) as notes`,
  );
  const AS_IT_WAS = { active: 'Block', blocks: 5, done: 0, confirmations: 0, notes: 0 };
  const timesOf = async (db) => Object.fromEntries((await db.query.rows(
    `select name, deactivated_at is not null as has_a_time from public.programs order by name`,
  )).filter((row) => row.has_a_time).map((row) => [row.name, true]));

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
  const listOpen = quoted('select pr.full_name as athlete, p.name as block, to_char(p.deactivated_at');
  const closeNow = quoted('update public.programs set deactivated_at = null');
  const openAgain = quoted('update public.programs set deactivated_at = now()');
  const listOdd = quoted('select pr.full_name as athlete, p.name as block, p.is_active, p.status, p.deactivated_at');
  const forBlock = (statement, id) => statement.replace('<id of the block>', id);

  const printedAudit = async (db) => {
    const [result] = await db.readOnly(read(migration.paths.audit), 'audit');
    return Object.fromEntries(result.rows.map((line) => [line.check, line.value]));
  };
  const LINE = {
    rule: 'when an athlete may write in a block (program_active_for_session, P55)',
    column: 'a block says when it was switched off (programs.deactivated_at)',
    trigger: 'the trigger that writes that time (trg_stamp_program_deactivated_at)',
    strangers: 'functions of these names that the migration does not know',
    users: 'functions of this migration a signed-in user may execute',
    asOwner: 'functions of this migration that run as their owner',
    blocks: 'blocks out of the trash',
    trash: 'blocks in the trash',
    open: 'blocks that are not active and that their athlete may still write in (switched off less than 72 hours ago)',
    closes: '… the last of them closes on',
    openInTrash: 'blocks switched off less than 72 hours ago that are closed all the same: in the trash',
    odd: 'blocks that hold a time of switching off and should not: the active one, a draft, or a time still to come',
  };
  const BEFORE = 'while it is the active one';
  const AFTER = 'while it is the active one, and for 72 hours after it was switched off';
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

  it('the workout sent after a switch of block is lost before, saved after, and lost again after the rollback — no row is written by either file', async () => {
    const db = await production();
    expect(await finding(db)).toEqual(LOST);

    await db.runFile(migration.paths.migration);
    // No block got a time from the file itself…
    expect(await timesOf(db)).toEqual({});
    // …so the one that was switched off before it stays closed, as it was.
    expect(await story(db, THE_ATHLETE, tick(SET_OLD))).toBeNull();
    expect(page).toContain('- **A block that was switched off before the migration gets no window**');

    // The app that is deployed: the coach's two requests, then the queue.
    expect(await finding(db)).toEqual(KEPT);
    expect(await story(db, THE_COACH, switchOff, switchOn(NEXT),
      `select name || ': ' || (deactivated_at = now()) from public.programs where id = '${BLOCK}'`)).toBe('Block: true');
    // The function of migration 11.
    expect(await story(db, THE_COACH, activate(NEXT), THE_ATHLETE, tick(SET_BLOCK))).toBe('saved');
    // 71 hours later, and 73.
    expect(await story(db, THE_COACH, switchOff, switchOn(NEXT), THE_OWNER, moveBack(BLOCK, '71 hours'), THE_ATHLETE, tick(SET_BLOCK)))
      .toBe('saved');
    expect(await story(db, THE_COACH, switchOff, switchOn(NEXT), THE_OWNER, moveBack(BLOCK, '73 hours'), THE_ATHLETE, tick(SET_BLOCK)))
      .toBeNull();
    // In the trash.
    expect(await story(db, THE_COACH, switchOff, switchOn(NEXT),
      `update public.programs set deleted_at = now(), is_active = false where id = '${BLOCK}'`, THE_ATHLETE, tick(SET_BLOCK))).toBeNull();
    // A signed-in user does not write the time: the coach's value is left out, and the name is saved.
    expect(await story(db, THE_COACH, `update public.programs set deactivated_at = now(), name = 'Renamed' where id = '${OLD}'`,
      `select name || ': ' || coalesce(deactivated_at::text, 'no time') from public.programs where id = '${OLD}'`)).toBe('Renamed: no time');
    expect(await story(db, THE_ATHLETE, `update public.programs set deactivated_at = now() where id = '${DRAFT}'`,
      `select coalesce(deactivated_at::text, 'no time') from public.programs where id = '${DRAFT}'`)).toBe('no time');
    // The block that is trained is written as before.
    expect(await story(db, THE_ATHLETE, tick(SET_BLOCK))).toBe('saved');
    // What the deployed app reads of a block: the columns it names, and `*` with one more.
    expect(await story(db, THE_COACH,
      `select string_agg(name, ', ' order by sort_order, name) from (
         select id, student_id, name, sort_order, is_active, status, submitted_at, created_at from public.programs where deleted_at is null) p`))
      .toBe('Block, My draft, Next block, Old block');
    // Nothing above was kept, and the migration itself touches no row.
    expect(await rows(db)).toEqual(AS_IT_WAS);

    await db.runFile(migration.paths.rollback);
    expect(await finding(db)).toEqual(LOST);
    expect(await rows(db)).toEqual(AS_IT_WAS);
    await db.drop();
  });

  it('adds 1 column, 1 trigger and its function, replaces 1 function and signs the ledger — no table, no policy, no privilege of what was there', async () => {
    const db = await production();
    const before = await catalogSnapshot(db.query);
    await db.runFile(migration.paths.migration);
    const after = await catalogSnapshot(db.query);

    const lines = diffCatalogs(before, after, { left: 'before', right: 'after' });
    const only = (side) => lines.filter((line) => line.endsWith(`: only in ${side}`))
      .map((line) => line.slice(0, -`: only in ${side}`.length)).sort();
    const RULE = 'public.program_active_for_session(sess_id uuid)';
    const STAMP = 'public.stamp_program_deactivated_at()';
    expect(only('after')).toEqual([
      'columns public.programs.deactivated_at',
      'comments table column public.programs.deactivated_at',
      `functions ${STAMP}`,
      'triggers public.programs.trg_stamp_program_deactivated_at',
    ]);
    expect(only('before')).toEqual([]);
    expect(lines.filter((line) => !/: only in (before|after)$/.test(line)).map((line) => /^(.*?): (\w+): /.exec(line).slice(1, 3).join(' → ')))
      .toEqual([`functions ${RULE} → definition`, 'data rows of app_private.app_migrations → rows']);

    // The column: a time that may be missing, and no default.
    expect(after.columns['public.programs.deactivated_at']).toMatchObject({
      type: 'timestamp with time zone', not_null: false, default: null,
    });
    // The trigger: on every insert and every update of a block, before the row is written.
    expect(after.triggers['public.programs.trg_stamp_program_deactivated_at']).toEqual({
      definition: 'CREATE TRIGGER trg_stamp_program_deactivated_at BEFORE INSERT OR UPDATE ON programs '
        + 'FOR EACH ROW EXECUTE FUNCTION stamp_program_deactivated_at()',
      state: 'enabled',
    });
    // The rule keeps its header and who may ask it; the trigger function is nobody's to call.
    const header = (key) => after.functions[key].definition.split(/\nAS /)[0];
    expect(header(RULE)).toBe(before.functions[RULE].definition.split(/\nAS /)[0]);
    expect(after.functions[RULE].privileges).toEqual(['authenticated: EXECUTE', 'postgres: EXECUTE', 'service_role: EXECUTE']);
    expect(after.functions[RULE].privileges).toEqual(before.functions[RULE].privileges);
    expect(after.functions[STAMP].privileges).toEqual(['postgres: EXECUTE', 'service_role: EXECUTE']);
    expect(after.functions[STAMP].owner).toBe('postgres');
    expect(header(STAMP)).toContain('SECURITY DEFINER');
    expect(header(STAMP)).toContain(`\n SET search_path TO 'public', 'pg_temp'`);
    // The 72 hours are written once.
    expect(after.functions[RULE].definition.match(/72 hours/g)).toHaveLength(1);
    expect(Object.values(after.functions).filter((fn) => /interval '72 hours'/.test(fn.definition ?? ''))).toHaveLength(1);

    // The ledger, as the page says it reads.
    expect(await db.query.rows(`select name from ${LEDGER} order by name`)).toHaveLength(17);
    expect(await db.query.value(`select name from ${LEDGER} order by name desc limit 1`)).toBe(MIGRATION);
    expect(page).toContain(`Expected: seventeen rows, the last one \`${MIGRATION}\`.`);
    expect(page).toContain('| Kind | required · adds 1 column, 1 trigger and its function, replaces 1 function; no table, no policy, no row |');
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
    expect(table.map((line) => line.n)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    // Written between back-ticks: a value the page gives exactly. The two
    // others are what production holds.
    const exact = table.filter((line) => /^`.+`$/.test(line.before) && /^`.+`$/.test(line.after))
      .map((line) => ({ ...line, before: line.before.slice(1, -1), after: line.after.slice(1, -1) }));
    expect(table.filter((line) => !exact.some((e) => e.n === line.n)).map((line) => line.check)).toEqual([LINE.blocks, LINE.trash]);
    const onPage = (column) => [
      ...exact.map((line) => [line.n, line.check, line[column]]),
      // "Block"; "Next block" and "Old block"; Alex's draft. "Thrown away".
      [10, LINE.blocks, '1 being trained, 2 not active, 1 drafts'],
      [11, LINE.trash, '1'],
    ].sort((x, y) => x[0] - y[0]).map(([, check, value]) => [check, value]);

    expect(await printed()).toEqual(onPage('before'));
    await db.runFile(migration.paths.migration);
    expect(await printed()).toEqual(onPage('after'));
    expect(Object.fromEntries(await printed())).toMatchObject({ [LINE.rule]: AFTER, [LINE.column]: 'yes', [LINE.trigger]: 'yes' });
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

  it('the page\'s check answers NOT THERE before and "in place" after, names what is wrong when something is — and writes nothing', async () => {
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
              (select count(*) from public.students) as links, (select count(*) from public.programs) as blocks,
              (select count(*) from public.set_logs) as sets, (select count(*) from public.exercise_library) as exercises,
              current_user::text as role, coalesce(current_setting('request.jwt.claims', true), '') as claims`,
    );
    const UNTOUCHED = { accounts: 2, profiles: 2, links: 1, blocks: 5, sets: 2, exercises: 1, role: 'postgres', claims: '' };
    const answer = (said) => `check only, nothing was written: ${said}`;
    const IN_PLACE = answer('in place: a block says when it was switched off, by the two requests of the app and by activate_program alike; '
      + 'its athlete writes in it for 72 hours, no longer, and never once it is in the trash; a signed-in user does not write that time');

    expect(await checked()).toBe(answer('NOT THERE: a block does not say when it was switched off'));
    expect(await state()).toEqual(UNTOUCHED);

    await db.runFile(migration.paths.migration);
    expect(await checked()).toBe(IN_PLACE);
    expect(await state()).toEqual(UNTOUCHED);
    expect(await rows(db)).toEqual(AS_IT_WAS);
    expect(await timesOf(db)).toEqual({});
    // What the page says the command prints.
    expect(page).toContain(`\`${IN_PLACE}\``);
    expect(page).toContain('`… NOT THERE: a block does not say when it was switched off`');

    // Each part made wrong by hand, one at a time: the answer nobody wants.
    const RULE = 'public.program_active_for_session(uuid)';
    const STAMP = 'public.stamp_program_deactivated_at()';
    const withWrong = async (signature, change) => {
      const was = await db.query.value(`select pg_get_functiondef($1::regprocedure)`, [signature]);
      expect(change(was), signature).not.toBe(was);
      await db.query(change(was));
      const said = await checked();
      await db.query(was);
      expect(await checked(), `${signature} put back`).toBe(IN_PLACE);
      return said;
    };
    // The trigger switched off: no block gets a time.
    await db.query(`alter table public.programs disable trigger trg_stamp_program_deactivated_at`);
    expect(await checked()).toBe(answer('BROKEN: a block switched off by the two requests of the app does not say when'));
    expect((await printedAudit(db))[LINE.trigger]).toBe('THERE, AND SWITCHED OFF');
    expect(page).toContain('- **4** reads `THERE, AND SWITCHED OFF`');
    await db.query(`alter table public.programs enable trigger trg_stamp_program_deactivated_at`);
    // A trigger that lets a signed-in user write the time.
    expect(await withWrong(STAMP, (was) => was.replace('ELSIF auth.uid() IS NOT NULL THEN', 'ELSIF false THEN')))
      .toBe(answer('NOT PROTECTED: a signed-in user wrote the time a block was switched off'));
    // The rule of before, a window that is too long, and one that forgets the trash.
    expect(await withWrong(RULE, (was) => was.replace(`now() - interval '72 hours'`, `now() + interval '72 hours'`)))
      .toBe(answer('BROKEN: the athlete cannot write a set of a block that was switched off a moment ago'));
    expect(await withWrong(RULE, (was) => was.replace(`interval '72 hours'`, `interval '720 hours'`)))
      .toBe(answer('NOT PROTECTED: the athlete wrote a set of a block switched off 73 hours ago'));
    expect(await withWrong(RULE, (was) => was.replace('p.deleted_at IS NULL', 'true')))
      .toBe(answer('NOT PROTECTED: the athlete wrote a set of a block in the trash'));
    // A trigger that keeps the time of a block that is switched on again.
    expect(await withWrong(STAMP, (was) => was.replace('ELSIF NEW.is_active THEN', 'ELSIF false THEN')))
      .toBe(answer('BROKEN: activate_program did not empty the time of the block it switched on and write the time of the one it switched off'));
    expect(page).toContain('- `… NOT PROTECTED: …` or `… BROKEN: …` — the window does not do what this page says: **roll back**, and report the full message.');
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
    expect(await db.query.value(`select count(*) from auth.users`)).toBe(2);
    await db.drop();
  });

  // Lines 12 to 15 of the audit, and the three sections of the page that
  // answer them. Here the switch is committed: the times are real ones.
  it('the blocks that are still open: counted by the audit, listed, closed early and opened again with the page\'s statements', async () => {
    const db = await production();
    for (const statement of [listOpen, closeNow, openAgain, listOdd]) {
      expect(statement, 'the page no longer gives one of its statements').toBeTruthy();
      // Pasted between double quotes in a shell.
      expect(statement).not.toMatch(/["$`!\\]/);
    }
    await db.runFile(migration.paths.migration);
    const audit = async () => {
      const printed = await printedAudit(db);
      return { open: printed[LINE.open], closes: printed[LINE.closes], inTrash: printed[LINE.openInTrash], odd: printed[LINE.odd] };
    };
    const NONE = { open: '0', closes: 'none', inTrash: '0', odd: '0' };
    const athleteWrites = () => story(db, THE_ATHLETE, tick(SET_BLOCK));
    expect(await audit()).toEqual(NONE);
    expect((await db.query(listOpen)).rows).toEqual([]);

    // The coach switches to the next block, with the app that is deployed.
    await committed(db, THE_COACH, switchOff, switchOn(NEXT));
    const open = (await db.query(listOpen)).rows;
    expect(open).toEqual([{
      athlete: 'Alex', block: 'Block', switched_off_utc: open[0].switched_off_utc, open_until_utc: open[0].open_until_utc,
      open_for_its_athlete: 'yes', block_id: BLOCK,
    }]);
    expect(Date.parse(`${open[0].open_until_utc.replace(' ', 'T')}Z`) - Date.parse(`${open[0].switched_off_utc.replace(' ', 'T')}Z`))
      .toBe(72 * 3600 * 1000);
    expect(await audit()).toEqual({ ...NONE, open: '1', closes: `${open[0].open_until_utc} UTC` });
    expect(await athleteWrites()).toBe('saved');

    // Closed early: the name comes back, and the block is closed at once.
    expect((await db.query(forBlock(closeNow, BLOCK))).rows).toEqual([{ name: 'Block' }]);
    expect(await athleteWrites()).toBeNull();
    expect(await audit()).toEqual(NONE);
    expect((await db.query(listOpen)).rows).toEqual([]);
    // Opened again, for 72 hours from now.
    expect((await db.query(forBlock(openAgain, BLOCK))).rows).toEqual([{ name: 'Block' }]);
    expect(await athleteWrites()).toBe('saved');
    expect((await audit()).open).toBe('1');
    // Neither does anything to the block that is trained, nor opens one that is in the trash.
    expect((await db.query(forBlock(closeNow, NEXT))).rows).toEqual([]);
    expect((await db.query(forBlock(openAgain, NEXT))).rows).toEqual([]);
    expect((await db.query(forBlock(openAgain, TRASHED))).rows).toEqual([]);
    expect(await timesOf(db)).toEqual({ Block: true });
    expect(page).toContain('or no row: the id is the block being trained, or no block at all — or, for the second statement, a block in the trash.');

    // In the trash inside its 72 hours: listed as closed, counted on its own line.
    await committed(db, THE_COACH, `update public.programs set deleted_at = now(), is_active = false where id = '${BLOCK}'`);
    expect((await db.query(listOpen)).rows).toMatchObject([{ block: 'Block', open_for_its_athlete: 'no: in the trash' }]);
    expect(await audit()).toEqual({ ...NONE, inTrash: '1' });
    expect(await athleteWrites()).toBeNull();
    await committed(db, THE_COACH, `update public.programs set deleted_at = null where id = '${BLOCK}'`);
    expect(await athleteWrites()).toBe('saved');

    // Line 15: a time written by hand where the trigger never leaves one.
    expect((await db.query(listOdd)).rows).toEqual([]);
    await db.query(`update public.programs set deactivated_at = now() - interval '1 hour' where id = '${DRAFT}'`);
    await db.query(`update public.programs set deactivated_at = now() + interval '10 days' where id = '${OLD}'`);
    expect((await audit()).odd).toBe('2');
    expect((await db.query(listOdd)).rows.map((row) => [row.block, row.status, row.block_id])).toEqual([
      ['My draft', 'draft', DRAFT], ['Old block', 'approved', OLD],
    ]);
    // The draft is not open for all that; the block with a time still to come is.
    expect(await story(db, THE_ATHLETE, `select public.program_active_for_session('${S_OLD}')`)).toBe(true);
    expect((await db.query(listOpen)).rows.map((row) => [row.block, row.open_for_its_athlete])).toEqual([
      ['Old block', 'yes'], ['Block', 'yes'], ['My draft', 'no: a draft'],
    ]);
    for (const id of [DRAFT, OLD]) expect((await db.query(forBlock(closeNow, id))).rowCount).toBe(1);
    expect((await audit()).odd).toBe('0');
    expect(await story(db, THE_ATHLETE, `select public.program_active_for_session('${S_OLD}')`)).toBe(false);
    await db.drop();
  });

  it('without migration 16 it says so (SLM02), and its rollback says there is nothing to undo (SLM03)', async () => {
    const db = await scratchDatabase();
    await db.runFile(manifest.baseline);
    const refusals = async () => {
      const before = await catalogSnapshot(db.query);
      const refused = await attempt(() => db.runFile(migration.paths.migration));
      const undone = await attempt(() => db.runFile(migration.paths.rollback));
      expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
      return [refused.error?.code, refused.error?.message, undone.error?.code];
    };
    // Without a ledger at all, then with the ledger and the migrations before 16 only.
    const needs = 'needs 2026_10_13_16_rest_push_scheduling, which is not applied';
    let [code, message, undone] = await refusals();
    expect([code, undone]).toEqual([REFUSAL.predecessorMissing, REFUSAL.notApplied]);
    expect(message).toContain(needs);
    for (const earlier of manifest.migrations.slice(0, 15)) await db.runFile(earlier.paths.migration);
    expect(await db.query.value(`select name from ${LEDGER} order by name desc limit 1`)).toBe('2026_10_13_15_push_plumbing');
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

  it('refuses to run next to a column, a trigger or a function of its names, and changes nothing', async () => {
    const db = await production();

    await db.query(`alter table public.programs add column deactivated_at date`);
    expect(await refusalOf(db)).toContain(`migration ${MIGRATION} would not add: public.programs.deactivated_at is already there`);
    expect(await printedAudit(db)).toMatchObject({ [LINE.column]: 'yes', [LINE.rule]: BEFORE });
    expect(page).toContain('| `would not add: public.programs.deactivated_at is already there` |');
    await db.query(`alter table public.programs drop column deactivated_at`);

    // The function, then a trigger of that name that calls another one.
    await db.query(`create function public.stamp_program_deactivated_at() returns trigger language plpgsql as 'begin return new; end'`);
    expect(await refusalOf(db)).toContain(
      `migration ${MIGRATION} would not create: the function stamp_program_deactivated_at() is already there`,
    );
    await db.query(`create trigger trg_stamp_program_deactivated_at before update on public.programs
                    for each row execute function public.stamp_program_deactivated_at()`);
    expect(await refusalOf(db)).toContain(
      `migration ${MIGRATION} would not create: the function stamp_program_deactivated_at(), `
      + 'the trigger trg_stamp_program_deactivated_at on public.programs is already there',
    );
    expect(await printedAudit(db)).toMatchObject({ [LINE.trigger]: 'yes', [LINE.column]: 'no' });
    expect(page).toContain('| `would not create: … is already there` |');
    await db.query(`drop trigger trg_stamp_program_deactivated_at on public.programs`);
    await db.query(`drop function public.stamp_program_deactivated_at()`);

    // A second function under the name of the rule: it would stay next to the new one.
    await db.query(`create function public.program_active_for_session(sess_id uuid, at timestamptz) returns boolean language sql as 'select true'`);
    expect(await refusalOf(db)).toContain(
      `migration ${MIGRATION} would not replace: program_active_for_session(uuid,timestamp with time zone)`,
    );
    expect(await printedAudit(db)).toMatchObject({ [LINE.strangers]: 'program_active_for_session(uuid, timestamp with time zone)' });
    expect(page).toContain('- **5** is not `none` — **stop and report the line.**');
    expect(page).toContain('| `would not replace: …` |');
    await db.query(`drop function public.program_active_for_session(uuid, timestamptz)`);

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

  // The rule is replaced by name: it must be the one the file was written for.
  it('refuses to replace a rule that is not the one it was written for — and takes the same rule laid out another way', async () => {
    const db = await production();
    const THE_RULE = await db.query.value(`select pg_get_functiondef('public.program_active_for_session(uuid)'::regprocedure)`);

    // Changed by hand: an athlete writes in every block that is not in the trash.
    await db.query(THE_RULE.replace('p.is_active AND p.deleted_at IS NULL', 'p.deleted_at IS NULL'));
    expect(await refusalOf(db)).toContain(
      `migration ${MIGRATION} would not replace the rule on when an athlete writes in a block: public.program_active_for_session(uuid) reads: `
      + 'SELECT p.deleted_at IS NULL FROM public.sessions sess JOIN public.weeks w ON w.id = sess.week_id '
      + 'JOIN public.programs p ON p.id = w.program_id WHERE sess.id = sess_id',
    );
    expect((await printedAudit(db))[LINE.rule]).toMatch(/^SOMETHING ELSE: SELECT p\.deleted_at IS NULL FROM public\.sessions sess /);
    expect(page).toContain('- **2** starts with `SOMETHING ELSE:` or `NOT THERE:` — **stop and report the line.**');
    expect(page).toContain('| `would not replace the rule on when an athlete writes in a block: …` |');

    // Not there at all.
    await db.query(`alter function public.program_active_for_session(uuid) rename to program_is_active_for_session`);
    expect(await refusalOf(db)).toContain(
      `migration ${MIGRATION} would not replace the rule on when an athlete writes in a block: public.program_active_for_session(uuid) is not there`,
    );
    expect((await printedAudit(db))[LINE.rule]).toBe('NOT THERE: no function program_active_for_session(uuid)');
    await db.query(`alter function public.program_is_active_for_session(uuid) rename to program_active_for_session`);

    // A column the trigger is written with, under another name.
    await db.query(THE_RULE);
    await db.query(`alter table public.programs rename column status to state`);
    expect(await refusalOf(db)).toContain(`migration ${MIGRATION} does not find what its functions are written with: public.programs.status`);
    expect(page).toContain('| `does not find what its functions are written with: …` |');
    await db.query(`alter table public.programs rename column state to status`);

    // The same rule, pasted with other line breaks and tabs: it is the rule.
    await db.query(THE_RULE.replace(/\n\s+(FROM|JOIN|WHERE)/g, '\r\n\t$1'));
    expect((await printedAudit(db))[LINE.rule]).toBe(BEFORE);
    await db.runFile(migration.paths.migration);
    expect((await printedAudit(db))[LINE.rule]).toBe(AFTER);
    await db.drop();
  });

  // The file reads its own result back: a copy of it that forgot a part
  // undoes itself.
  it('a file that left a part out says so, and changes nothing', async () => {
    const db = await production();
    const text = read(migration.paths.migration);
    const wrong = async (changed) => {
      expect(changed).not.toBe(text);
      return refusalOf(db, () => db.runSql(changed, 'migration'));
    };
    expect(await wrong(text.replace('GRANT EXECUTE ON FUNCTION public.program_active_for_session(uuid) TO authenticated;\n', ''))).toContain(
      `migration ${MIGRATION} did not get what it meant: public.program_active_for_session(uuid) is not executable by a signed-in user: every write of an athlete would be refused`,
    );
    expect(await wrong(text.replace('REVOKE ALL ON FUNCTION public.stamp_program_deactivated_at() FROM PUBLIC, anon, authenticated;\n', '')
      .replace('LANGUAGE plpgsql\nSECURITY DEFINER\n', 'LANGUAGE plpgsql\n'))).toContain(
      `migration ${MIGRATION} did not get what it meant: public.stamp_program_deactivated_at() does not run as its owner`,
    );
    expect(await wrong(text.replace('  BEFORE INSERT OR UPDATE ON public.programs\n', '  BEFORE UPDATE OF is_active ON public.programs\n'))).toContain(
      `migration ${MIGRATION} did not get what it meant: the trigger trg_stamp_program_deactivated_at is not the one meant: `
      + 'CREATE TRIGGER trg_stamp_program_deactivated_at BEFORE UPDATE OF is_active ON programs',
    );
    // (A function for a replacement: `$$` in a replacement string is one `$`.)
    expect(await wrong(text.replace(
      'LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;\n\nREVOKE ALL ON FUNCTION public.program_active_for_session',
      () => 'LANGUAGE sql SECURITY DEFINER STABLE;\n\nREVOKE ALL ON FUNCTION public.program_active_for_session',
    ))).toContain(
      `migration ${MIGRATION} did not get what it meant: public.program_active_for_session(uuid) has no search_path = public, pg_temp`,
    );
    expect(page).toContain('| `did not get what it meant: …` |');
    await db.drop();
  });

  it('its rollback is refused while the ledger records a later migration, and changes nothing', async () => {
    const db = await production();
    await db.runFile(migration.paths.migration);
    await committed(db, THE_COACH, switchOff, switchOn(NEXT));
    await db.query(`insert into ${LEDGER} (name) values ($1)`, [TO_COME]);
    const before = await catalogSnapshot(db.query);

    const refused = await attempt(() => db.runFile(migration.paths.rollback));
    expect(refused.error?.code).toBe(REFUSAL.stillNeeded);
    expect(refused.error.message).toContain(`the ledger still records later migrations: ${TO_COME}`);
    expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
    expect(await timesOf(db)).toEqual({ Block: true });
    expect(await story(db, THE_ATHLETE, tick(SET_BLOCK))).toBe('saved');
    await db.drop();
  });

  // What the rollback section of the page says.
  it('rolled back: every open window closes at once and what was saved inside one stays; applied again, no block has a time', async () => {
    const db = await production();
    await db.runFile(migration.paths.migration);
    await committed(db, THE_COACH, switchOff, switchOn(NEXT));
    // What a phone sent inside the window is kept.
    await committed(db, THE_ATHLETE, tick(SET_BLOCK), confirm);
    const KEPT_ROWS = { active: 'Next block', blocks: 5, done: 1, confirmations: 1, notes: 0 };
    expect(await rows(db)).toEqual(KEPT_ROWS);
    expect(await story(db, THE_ATHLETE, note)).toBe('saved');

    await db.runFile(migration.paths.rollback);

    expect(await rows(db)).toEqual(KEPT_ROWS);
    expect(await story(db, THE_ATHLETE, note)).toBe(RLS('slot_comments'));
    expect(await story(db, THE_ATHLETE, `update public.set_logs set rpe = 8 where id = '${SET_BLOCK}' returning 'saved'`)).toBeNull();
    expect(await printedAudit(db)).toMatchObject({
      [LINE.rule]: BEFORE, [LINE.column]: 'no', [LINE.trigger]: 'no', [LINE.asOwner]: 'program_active_for_session(uuid)',
      [LINE.users]: 'program_active_for_session(uuid)', [LINE.open]: '0', [LINE.odd]: '0',
    });
    expect(page).toContain('**It reopens P55, and it closes every open window at once**');
    // The block that is trained is written as ever.
    expect(await story(db, THE_COACH, switchOff, switchOn(BLOCK), THE_ATHLETE, note)).toBe('saved');

    // Applied again: the times did not come back, and the next switch is the first with a window.
    await db.runFile(migration.paths.migration);
    expect(await timesOf(db)).toEqual({});
    expect(await story(db, THE_ATHLETE, note)).toBe(RLS('slot_comments'));
    expect(page).toContain('The times do not come back: applied again, the migration starts with no block on record.');
    await committed(db, THE_COACH, switchOff, switchOn(BLOCK));
    await committed(db, THE_COACH, switchOff, switchOn(NEXT));
    expect(await timesOf(db)).toEqual({ Block: true });
    expect(await story(db, THE_ATHLETE, note)).toBe('saved');
    expect(await rows(db)).toEqual(KEPT_ROWS);
    await db.drop();
  });
});
