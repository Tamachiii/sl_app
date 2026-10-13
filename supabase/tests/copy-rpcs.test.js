// A session, a phase and a block are duplicated, and sessions are copied into
// another phase, in one request each — the database's half of review finding
// P52, added by migration 2026_10_13_12_copy_rpcs.
//
// "Duplicate" and "Copy to…" were done by the app, one request per row or per
// table (src/hooks/useDuplicate.js): the session, then its exercises, then
// their sets, and for a block the same again for every phase and session of
// it. A request that is lost half-way leaves a session with no exercise, or
// exercises with no set, in the block the athlete trains.
//
// The migration adds one function for each gesture, SECURITY INVOKER like
// move_session — no right the caller does not have:
//
//   duplicate_session(p_session_id, p_title_suffix)      the copy right after
//                                                        its source
//   copy_sessions(p_session_ids, p_dest_week_id)         one copy per entry,
//                                                        at the end of a phase
//   duplicate_week(p_week_id, p_dest_program_id, p_label_suffix)
//                                                        the last phase of a
//                                                        program
//   duplicate_program(p_program_id, p_target_student_id, p_name_suffix)
//                                                        an inactive block,
//                                                        for the athlete or
//                                                        for another one
//
// A copy is the prescription and nothing of what was trained, and a function
// call is one statement: whole, or not there. The first blocks run against
// schema.sql, next to the requests of the app that is DEPLOYED today, written
// here as that app sends them: the migration is applied while that app is
// live, and what the functions give is held to what those requests give. A
// request that is lost half-way is a trigger that raises on the write it
// would have made. Two requests that cross need two connections. The last
// block applies the migration file itself to the frozen production baseline,
// with the checks and the statements of its runbook page read off the page.

import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  asAdmin, asAnon, asService, asUser, attempt, createDraftProgram, createProgram, createUser, repoRoot,
  scenario, scratchDatabase, seed,
} from './harness.js';
import { catalogSnapshot, diffCatalogs } from './catalog.js';
import { LEDGER, loadManifest, REFUSAL } from '../migrations/manifest.js';

const MIGRATION = '2026_10_13_12_copy_rpcs';
const manifest = loadManifest();
const migration = manifest.migrations.find((m) => m.name === MIGRATION);
const read = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8');

const SIGNATURES = [
  'public.duplicate_session(uuid, text)',
  'public.copy_sessions(uuid[], uuid)',
  'public.duplicate_week(uuid, uuid, text)',
  'public.duplicate_program(uuid, uuid, text)',
];

// ------------------------------------------------------------
// What a copy is, column by column. A column added to one of the five tables
// joins one of the two lists of its table — and, when it is copied, the
// INSERT between the marks `>>> the copy` and `<<< the copy` of the four
// functions, in the migration that adds it and in schema.sql. The first test
// below fails until it has.
//   copied   the value of the source (a title may get a suffix, a place a new
//            number)
//   left     the copy starts without it: an id, a parent, a date of creation
//            — and everything that says what happened to the source
// ------------------------------------------------------------
const WHAT_A_COPY_IS = {
  programs: {
    copied: ['name'],
    left: ['id', 'student_id', 'sort_order', 'is_active', 'deleted_at', 'created_by', 'status', 'submitted_at',
      'approved_at', 'created_at'],
  },
  weeks: {
    copied: ['week_number', 'label'],
    left: ['id', 'program_id', 'created_at'],
  },
  sessions: {
    copied: ['day_number', 'title', 'sort_order', 'archived_at'],
    left: ['id', 'week_id', 'scheduled_date', 'reviewed_at', 'performed_at', 'created_at'],
  },
  exercise_slots: {
    copied: ['exercise_id', 'sets', 'reps', 'duration_seconds', 'weight_kg', 'sort_order', 'rest_seconds',
      'superset_group', 'notes', 'record_video_set_numbers'],
    left: ['id', 'session_id', 'created_at'],
  },
  set_logs: {
    copied: ['set_number', 'target_reps', 'target_duration_seconds', 'target_weight_kg', 'target_rest_seconds'],
    left: ['id', 'exercise_slot_id', 'done', 'failed', 'rpe', 'weight_kg', 'actual_reps', 'actual_weight_kg',
      'skipped', 'is_student_added', 'logged_at', 'failed_at', 'created_at'],
  },
};

// seed(): coach Carla with athletes Alex (A) — "Block A", active, two phases
// of two sessions — and Billie (B), "Block B", active, one session. Block A is
// then DRESSED: something in every column, and a first session that was
// trained, confirmed and reviewed, so that what a copy carries and what it
// leaves can both be seen.
//   phase 1 "Base"   Pull      Monday, dated, trained, confirmed, reviewed.
//                              Pull-up: a note, a superset, sets 1 and 3 to
//                              film; set 1 done with an RPE, set 2 failed
//                              with actuals, set 3 skipped and heavier, and a
//                              fourth set the athlete added. Dip: for time, in
//                              the same superset, skipped as a whole. A note
//                              of the athlete on the pull-up.
//                    Old push  Wednesday, archived
//   phase 2 (no name)  a session without a title, and "W2 · S2"
// Next to it:
//   next      "Block N" of Alex: one phase of four sessions, not active
//   trashed   "Old block" of Alex, in the trash
//   draft     a draft Alex is writing (one phase, two sessions, no set)
//   authored  "Billie wrote it": a block Billie wrote as a draft and the coach
//             approved — it names its author and the day it was approved
//   olga      a second coach, with her athlete Casey and "Block C"
//   tess      an athlete who was Olga's and is Carla's now: "Olga block"
//             (two sessions) still holds Olga's exercise, and its first
//             session one of Carla's, added since
//   rae       an athlete of Carla for the requests that cross — "Race", two
//             phases of three sessions. Those tests COMMIT: nothing else
//             reads her block.
const GROUP = '00000000-0000-4000-8000-00000000aaaa';
let ids;
let block;
let pull;
let oldPush;
let untitled;
let plain;
let next;
let trashed;
let draft;
let authored;
let olga;
let casey;
let row;
let blockC;
let tess;
let olgaBlock;
let rae;
let race;

beforeAll(async () => {
  ids = await seed();
  block = ids.programA;
  [pull, oldPush, untitled, plain] = block.sessions;
  const [pullUp, dip] = block.tree[0].sessions[0].slots;
  await asAdmin(async (q) => {
    await q(`update programs set sort_order = 2 where id = $1`, [block.id]);
    await q(`update weeks set label = 'Base' where id = $1`, [block.weeks[0]]);
    await q(`update sessions set title = 'Pull', day_number = 1, scheduled_date = '2026-10-05' where id = $1`, [pull]);
    await q(`update sessions set title = 'Old push', day_number = 3, archived_at = '2026-10-01 10:00+00' where id = $1`, [oldPush]);
    await q(`update sessions set title = null where id = $1`, [untitled]);
    await q(
      `update exercise_slots set notes = 'Slow negatives', superset_group = $2, record_video_set_numbers = '{1,3}', rest_seconds = 90
        where id = $1`, [pullUp.id, GROUP],
    );
    await q(
      `update exercise_slots set reps = null, duration_seconds = 45, weight_kg = null, superset_group = $2 where id = $1`,
      [dip.id, GROUP],
    );
    await q(
      `update set_logs set target_reps = null, target_duration_seconds = 45, target_weight_kg = null where exercise_slot_id = $1`,
      [dip.id],
    );
    // What Alex trained.
    await q(`update set_logs set done = true, rpe = 8, weight_kg = 20, logged_at = '2026-10-05 18:00+00' where id = $1`, [pullUp.setLogs[0]]);
    await q(
      `update set_logs set failed = true, failed_at = '2026-10-05 18:05+00', actual_reps = 3, actual_weight_kg = 18 where id = $1`,
      [pullUp.setLogs[1]],
    );
    await q(
      `update set_logs set target_reps = 3, target_weight_kg = 25, target_rest_seconds = 180, skipped = true where id = $1`,
      [pullUp.setLogs[2]],
    );
    await q(
      `insert into set_logs (exercise_slot_id, set_number, is_student_added, done, weight_kg, logged_at)
       values ($1, 4, true, true, 15, '2026-10-05 18:10+00')`, [pullUp.id],
    );
    await q(`insert into slot_comments (exercise_slot_id, student_id, body) values ($1, $2, 'Felt heavy')`, [pullUp.id, ids.studentA.id]);
    await q(`insert into slot_deviations (exercise_slot_id, student_id, kind) values ($1, $2, 'skip')`, [dip.id, ids.studentA.id]);
    await q(
      `insert into session_confirmations (session_id, student_id, performed_on) values ($1, $2, '2026-10-05')`,
      [pull, ids.studentA.id],
    );
    await q(`update sessions set reviewed_at = '2026-10-06 09:00+00' where id = $1`, [pull]);
  }, { commit: true });

  next = await createProgram({ student: ids.studentA, name: 'Block N', sessions: 4, sets: 1 });
  trashed = await createProgram({ student: ids.studentA, name: 'Old block', sets: 1 });
  await asAdmin((q) => q(`update programs set deleted_at = now(), sort_order = 9 where id = $1`, [trashed.id]), { commit: true });
  draft = await createDraftProgram(ids.studentA, { sessions: 2 });
  authored = await createDraftProgram(ids.studentB, { name: 'Billie wrote it' });
  expect(await asUser(ids.coach, (c) => c.value(`select public.approve_program($1)`, [authored.id]), { commit: true }))
    .toEqual({ approved: true, set_logs_created: 6 });

  olga = await createUser({ email: 'olga@sl.test', fullName: 'Coach Olga', role: 'coach' });
  casey = await createUser({ email: 'casey@sl.test', fullName: 'Casey Athlete', coach: olga });
  row = await asAdmin((q) => q.value(
    `insert into exercise_library (coach_id, name, type, difficulty) values ($1, 'Row', 'pull', 1) returning id`,
    [olga.id],
  ), { commit: true });
  blockC = await createProgram({ student: casey, name: 'Block C', exercises: [row], sessions: 2, active: true });

  tess = await createUser({ email: 'tess@sl.test', fullName: 'Tess Transferred', coach: olga });
  olgaBlock = await createProgram({ student: tess, name: 'Olga block', exercises: [row], sessions: 2, sets: 2, active: true });
  await asAdmin(async (q) => {
    await q(`select public.transfer_student($1, $2)`, [tess.id, ids.coach.id]);
    const added = await q.value(
      `insert into exercise_slots (session_id, exercise_id, sets, reps, sort_order) values ($1, $2, 2, 5, 1) returning id`,
      [olgaBlock.sessions[0], ids.exercises.pullUp],
    );
    await q(`insert into set_logs (exercise_slot_id, set_number, target_reps) values ($1, 1, 5), ($1, 2, 5)`, [added]);
  }, { commit: true });

  rae = await createUser({ email: 'rae@sl.test', fullName: 'Rae Racer', coach: ids.coach });
  race = await createProgram({ student: rae, name: 'Race', weeks: 2, sessions: 3, sets: 1, active: true });
});

// ------------------------------------------------------------
// The four functions, called the way the API calls them: by the names of
// their arguments, the ones with a default left out when they are.
// ------------------------------------------------------------
const rpc = (as, fn, args) => {
  const keys = Object.keys(args);
  return as((c) => c.value(
    `select public.${fn}(${keys.map((key, i) => `${key} => $${i + 1}`).join(', ')})`, Object.values(args),
  ));
};
const duplicateSession = (as, sessionId, more = {}) => rpc(as, 'duplicate_session', { p_session_id: sessionId, ...more });
const copySessions = (as, list, weekId) => rpc(as, 'copy_sessions', { p_session_ids: list, p_dest_week_id: weekId });
const duplicateWeek = (as, weekId, more = {}) => rpc(as, 'duplicate_week', { p_week_id: weekId, ...more });
const duplicateProgram = (as, programId, more = {}) => rpc(as, 'duplicate_program', { p_program_id: programId, ...more });

const coach = (fn, options) => asUser(ids.coach, fn, options);
const alex = (fn, options) => asUser(ids.studentA, fn, options);

const P0001 = 'P0001';
const DENIED = '42501';

/** `[message, SQLSTATE]` of what `fn` raised — or `'it went through'`. */
const refusal = async (fn) => {
  const tried = await attempt(fn);
  return tried.ok ? 'it went through' : [tried.error.message, tried.error.code];
};

// ------------------------------------------------------------
// What is in the database
// ------------------------------------------------------------
// A whole row as JSON, without what is never the same in two rows.
const without = (alias, ...keys) => keys.reduce((sql, key) => `${sql} - '${key}'::text`, `to_jsonb(${alias})`);
const SETS_JSON = `(select coalesce(jsonb_agg(${without('sl', 'id', 'exercise_slot_id', 'created_at')} order by sl.set_number), '[]'::jsonb)
                      from set_logs sl where sl.exercise_slot_id = es.id)`;
const SLOTS_JSON = `(select coalesce(jsonb_agg((${without('es', 'id', 'session_id', 'created_at')}) || jsonb_build_object(
                         'set_logs', ${SETS_JSON},
                         'notes_of_the_athlete', (select count(*) from slot_comments sc where sc.exercise_slot_id = es.id),
                         'deviations', (select count(*) from slot_deviations sd where sd.exercise_slot_id = es.id))
                       order by es.sort_order, es.exercise_id), '[]'::jsonb)
                       from exercise_slots es where es.session_id = s.id)`;
const SESSION_JSON = `(${without('s', 'id', 'week_id', 'created_at')}) || jsonb_build_object(
                        'slots', ${SLOTS_JSON},
                        'confirmations', (select count(*) from session_confirmations c where c.session_id = s.id))`;
const WEEK_JSON = `(${without('w', 'id', 'program_id', 'created_at')}) || jsonb_build_object(
                     'sessions', (select coalesce(jsonb_agg(${SESSION_JSON} order by s.sort_order, s.id), '[]'::jsonb)
                                    from sessions s where s.week_id = w.id))`;
/** One session with everything under it — every column, no id. */
const sessionOf = (q, id) => q.value(`select ${SESSION_JSON} from sessions s where s.id = $1`, [id]);
const weekOf = (q, id) => q.value(`select ${WEEK_JSON} from weeks w where w.id = $1`, [id]);
const programOf = (q, id) => q.value(
  `select (${without('p', 'id', 'created_at')}) || jsonb_build_object(
            'weeks', (select coalesce(jsonb_agg(${WEEK_JSON} order by w.week_number, w.id), '[]'::jsonb)
                        from weeks w where w.program_id = p.id))
     from programs p where p.id = $1`, [id],
);

/** What a session is once copied: the prescription, and nothing of what was trained. */
const NOT_TRAINED = {
  done: false, failed: false, rpe: null, weight_kg: null, actual_reps: null, actual_weight_kg: null,
  skipped: false, logged_at: null, failed_at: null,
};
const prescribed = (session, { keepArchived = false, ...given } = {}) => ({
  ...session,
  scheduled_date: null,
  reviewed_at: null,
  performed_at: null,
  archived_at: keepArchived ? session.archived_at : null,
  confirmations: 0,
  slots: session.slots.map((slot) => ({
    ...slot,
    notes_of_the_athlete: 0,
    deviations: 0,
    set_logs: slot.set_logs.filter((set) => !set.is_student_added).map((set) => ({ ...set, ...NOT_TRAINED })),
  })),
  ...given,
});

/** How many rows the five tables hold. */
const census = (q) => q.one(
  `select (select count(*) from programs) as programs, (select count(*) from weeks) as weeks,
          (select count(*) from sessions) as sessions, (select count(*) from exercise_slots) as slots,
          (select count(*) from set_logs) as set_logs`,
);
/** Where each row of a table physically is: a row that is written again moves. */
const versions = (q, table, where, params) => q.rows(`select id, ctid::text as version from ${table} where ${where} order by id`, params);
/** The sessions of a phase in their order: `[[id, sort_order], …]`. */
const orderOf = async (q, weekId) => (await q.rows(
  `select id, sort_order from sessions where week_id = $1 order by sort_order, id`, [weekId],
)).map((s) => [s.id, s.sort_order]);
const numbered = (list, from = 0) => list.map((id, i) => [id, i + from]);
/** The titles of a phase in their order, archived ones in brackets. */
const titlesOf = async (q, weekId) => (await q.rows(
  `select case when archived_at is null then coalesce(title, '-') else '[' || coalesce(title, '-') || ']' end as title
     from sessions where week_id = $1 order by sort_order, id`, [weekId],
)).map((s) => s.title);
const activeOf = async (q, student) => (await q.rows(
  `select name from programs where student_id = $1 and is_active order by name`, [student.studentRowId],
)).map((p) => p.name);

// ------------------------------------------------------------
// The app that is deployed (src/hooks/useDuplicate.js), request by request:
// each `q()` is one request, as each PostgREST call is, and its own
// transaction. (useDuplicateProgram also tries to delete the half-made block
// when a request fails; that request can be lost like any other, and the test
// that needs it sends it itself.)
// ------------------------------------------------------------
const app = {
  // nextSessionSortOrder
  nextSortOrder: async (q, weekId) => (await q.value(
    `select sort_order from sessions where week_id = $1 order by sort_order desc limit 1`, [weekId],
  ) ?? -1) + 1,
  // copySlotsInto: the exercises of one session, with the old → new map.
  async copySlotsInto(q, destSessionId, sourceSessionId) {
    const slots = await q.rows(`select * from exercise_slots where session_id = $1 order by sort_order, id`, [sourceSessionId]);
    const map = new Map();
    for (const sl of slots) {
      map.set(sl.id, await q.value(
        `insert into exercise_slots (session_id, exercise_id, sets, reps, weight_kg, sort_order, notes, duration_seconds,
                                     superset_group, rest_seconds, record_video_set_numbers)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
        [destSessionId, sl.exercise_id, sl.sets, sl.reps, sl.weight_kg, sl.sort_order, sl.notes, sl.duration_seconds,
          sl.superset_group, sl.rest_seconds, sl.record_video_set_numbers],
      ));
    }
    return map;
  },
  // copySetLogTargets: the targets of every prescribed set, in one request.
  copySetLogTargets: (q, map) => q(
    `insert into set_logs (exercise_slot_id, set_number, done, target_reps, target_duration_seconds, target_weight_kg, target_rest_seconds)
     select m.new_id, sl.set_number, false, sl.target_reps, sl.target_duration_seconds, sl.target_weight_kg, sl.target_rest_seconds
       from set_logs sl
       join unnest($1::uuid[], $2::uuid[]) as m (from_id, new_id) on m.from_id = sl.exercise_slot_id
      where sl.is_student_added = false`,
    [[...map.keys()], [...map.values()]],
  ),
  // useDuplicateSession
  async duplicateSession(q, sessionId) {
    const src = await q.one(`select * from sessions where id = $1`, [sessionId]);
    const id = await q.value(
      `insert into sessions (week_id, day_number, title, sort_order) values ($1, $2, $3, $4) returning id`,
      [src.week_id, src.day_number, src.title ? `${src.title} (copy)` : 'Session (copy)', await app.nextSortOrder(q, src.week_id)],
    );
    await app.copySetLogTargets(q, await app.copySlotsInto(q, id, sessionId));
    return id;
  },
  // useCopySessions
  async copySessions(q, sessionIds, weekId) {
    const made = [];
    for (const sessionId of sessionIds) {
      const src = await q.one(`select * from sessions where id = $1`, [sessionId]);
      const id = await q.value(
        `insert into sessions (week_id, day_number, title, sort_order) values ($1, $2, $3, $4) returning id`,
        [weekId, src.day_number, src.title, await app.nextSortOrder(q, weekId)],
      );
      made.push(id);
      await app.copySetLogTargets(q, await app.copySlotsInto(q, id, sessionId));
    }
    return made;
  },
  // copyWeekTree: the sessions, then the exercises of each, then every set.
  async copyWeekTree(q, sourceWeekId, destWeekId) {
    const sessions = await q.rows(`select * from sessions where week_id = $1 order by sort_order`, [sourceWeekId]);
    const made = [];
    for (const s of sessions) {
      made.push([s.id, await q.value(
        `insert into sessions (week_id, day_number, title, sort_order, archived_at) values ($1, $2, $3, $4, $5) returning id`,
        [destWeekId, s.day_number, s.title, s.sort_order, s.archived_at],
      )]);
    }
    const map = new Map();
    for (const [from, to] of made) {
      for (const [slotFrom, slotTo] of await app.copySlotsInto(q, to, from)) map.set(slotFrom, slotTo);
    }
    await app.copySetLogTargets(q, map);
  },
  // useDuplicateWeek
  async duplicateWeek(q, weekId, programId) {
    const src = await q.one(`select * from weeks where id = $1`, [weekId]);
    const dest = programId ?? src.program_id;
    const number = (await q.value(
      `select week_number from weeks where program_id = $1 order by week_number desc limit 1`, [dest],
    ) ?? 0) + 1;
    const id = await q.value(
      `insert into weeks (program_id, week_number, label) values ($1, $2, $3) returning id`,
      [dest, number, src.label ? `${src.label} (copy)` : null],
    );
    await app.copyWeekTree(q, weekId, id);
    return id;
  },
  // useDuplicateProgram
  async duplicateProgram(q, programId) {
    const src = await q.one(`select id, student_id, name from programs where id = $1`, [programId]);
    const sort = (await q.value(
      `select sort_order from programs where student_id = $1 and deleted_at is null order by sort_order desc limit 1`,
      [src.student_id],
    ) ?? -1) + 1;
    const id = await q.value(
      `insert into programs (student_id, name, sort_order, is_active) values ($1, $2, $3, false) returning id`,
      [src.student_id, `${src.name} (copy)`, sort],
    );
    for (const w of await q.rows(`select id, week_number, label from weeks where program_id = $1 order by week_number`, [programId])) {
      const weekId = await q.value(
        `insert into weeks (program_id, week_number, label) values ($1, $2, $3) returning id`, [id, w.week_number, w.label],
      );
      await app.copyWeekTree(q, w.id, weekId);
    }
    return id;
  },
};

/**
 * From here on, in this transaction, an INSERT into `table` that fits
 * `condition` (written over NEW) is a request that never arrives: it raises.
 * The trigger goes with the scenario.
 */
const LOST = 'the connection was lost';
async function loseTheInsertThat(q, table, condition) {
  await q(`create function public.test_lost_${table}() returns trigger language plpgsql as $f$
    begin
      if ${condition} then raise exception '${LOST}'; end if;
      return NEW;
    end $f$`);
  await q(`create trigger zz_test_lost_request before insert on public.${table}
    for each row execute function public.test_lost_${table}()`);
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
// What a copy is
// ============================================================
describe('a copy is the prescription, and nothing of what was trained', () => {
  it('every column of the five tables is copied or left behind on purpose, and the functions write the copied ones', () => asAdmin(async (q) => {
    for (const [table, { copied, left }] of Object.entries(WHAT_A_COPY_IS)) {
      const columns = (await q.rows(
        `select attname from pg_attribute where attrelid = $1::regclass and attnum > 0 and not attisdropped`, [`public.${table}`],
      )).map((c) => c.attname).sort();
      expect(
        [...copied, ...left].sort(),
        `public.${table} has a column WHAT_A_COPY_IS does not know: decide whether a copy carries it, list it, and — when it `
        + 'does — add it to the INSERT between the marks of the four copy functions, in the migration and in schema.sql',
      ).toEqual(columns);
    }

    // What each function writes, read off its definition in the database.
    const written = {};
    for (const signature of SIGNATURES) {
      const text = await q.value(`select pg_get_functiondef($1::regprocedure)`, [signature]);
      const name = /public\.(\w+)\(/.exec(signature)[1];
      written[name] = {};
      for (const [, table, list] of text.matchAll(/INSERT INTO public\.(\w+)\s*\(([^)]*)\)/g)) {
        (written[name][table] ??= []).push(list.split(',').map((column) => column.trim()).sort());
      }
    }
    const tree = {
      sessions: [['id', 'week_id', ...WHAT_A_COPY_IS.sessions.copied].sort()],
      exercise_slots: [['id', 'session_id', ...WHAT_A_COPY_IS.exercise_slots.copied].sort()],
      set_logs: [['exercise_slot_id', ...WHAT_A_COPY_IS.set_logs.copied].sort()],
    };
    const weeks = [['id', 'program_id', ...WHAT_A_COPY_IS.weeks.copied].sort()];
    expect(written).toEqual({
      duplicate_session: tree,
      copy_sessions: tree,
      duplicate_week: { ...tree, weeks },
      // A new program: the athlete it is for, its place in their list, not active, approved.
      duplicate_program: { ...tree, weeks, programs: [['id', 'is_active', 'name', 'sort_order', 'status', 'student_id']] },
    });
  }));

  it('the four functions hold the same lines between the marks, in the migration and in schema.sql', () => {
    const blocks = (file) => [...read(file).matchAll(/-- >>> the copy\n([\s\S]*?)\n *-- <<< the copy/g)].map((m) => m[1]);
    const inMigration = blocks(migration.paths.migration);
    const inSchema = blocks('supabase/schema.sql');
    expect(inMigration).toHaveLength(4);
    expect(inSchema).toHaveLength(4);
    const [first] = inMigration;
    for (const table of ['sessions', 'exercise_slots', 'set_logs']) expect(first).toContain(`INSERT INTO public.${table}`);
    for (const [i, one] of [...inMigration, ...inSchema].entries()) {
      expect(one, `block ${i + 1} of 8 (the migration's four, then schema.sql's)`).toBe(first);
    }
  });

  // A column that is NULL in the source is NULL in a copy whether it is
  // copied or not: the block the tests copy holds something in each.
  it('the block these tests copy holds something in every column', () => asAdmin(async (q) => {
    const rows = {
      programs: await q.rows(`select to_jsonb(p) as r from programs p where p.id = $1`, [block.id]),
      weeks: await q.rows(`select to_jsonb(w) as r from weeks w where w.program_id = $1`, [block.id]),
      sessions: await q.rows(`select to_jsonb(s) as r from sessions s where s.id = any($1)`, [block.sessions]),
      exercise_slots: await q.rows(`select to_jsonb(es) as r from exercise_slots es where es.session_id = any($1)`, [block.sessions]),
      set_logs: await q.rows(
        `select to_jsonb(sl) as r from set_logs sl join exercise_slots es on es.id = sl.exercise_slot_id where es.session_id = any($1)`,
        [block.sessions],
      ),
    };
    const holds = (value) => value !== null && value !== false && value !== 0 && !(Array.isArray(value) && value.length === 0);
    const empty = Object.entries(WHAT_A_COPY_IS).flatMap(([table, { copied, left }]) => [...copied, ...left]
      .filter((column) => !rows[table].some(({ r }) => holds(r[column])))
      .map((column) => `${table}.${column}`));
    // The four that say where a block comes from and whether it is in the
    // trash: a block the coach wrote and the athlete trains has none of them.
    // "a draft, a block in the trash, a block its athlete wrote" below copies
    // the blocks that have.
    expect(empty).toEqual(['programs.deleted_at', 'programs.created_by', 'programs.submitted_at', 'programs.approved_at']);
  }));

  it('duplicate_session: the session with its exercises and the targets of its sets, called "(copy)", live, right after it', () => scenario(async (q) => {
    const source = await sessionOf(q, pull);
    expect(source).toMatchObject({ title: 'Pull', day_number: 1, scheduled_date: '2026-10-05', sort_order: 0, confirmations: 1 });
    expect(source.reviewed_at).not.toBeNull();
    expect(source.performed_at).not.toBeNull();
    expect(source.slots.map((slot) => slot.set_logs.length)).toEqual([4, 3]);

    const made = await duplicateSession(coach, pull);
    expect(made).toEqual({
      session_id: made.session_id, week_id: block.weeks[0], sort_order: 1, title: 'Pull (copy)', slots: 2, set_logs: 6, slots_left_out: 0,
    });

    const copy = await sessionOf(q, made.session_id);
    expect(copy).toEqual(prescribed(source, { title: 'Pull (copy)', sort_order: 1 }));
    // Spelled out once: what the athlete's set 3 looks like in the copy — the
    // coach's heavier target, and not skipped.
    expect(copy.slots[0].set_logs[2]).toMatchObject({ set_number: 3, target_reps: 3, target_weight_kg: 25, target_rest_seconds: 180, skipped: false });
    expect(copy.slots[0]).toMatchObject({ notes: 'Slow negatives', superset_group: GROUP, record_video_set_numbers: [1, 3], rest_seconds: 90 });
    expect(copy.slots[1]).toMatchObject({ reps: null, duration_seconds: 45, superset_group: GROUP });
    expect(copy.slots[1].set_logs.map((set) => set.target_duration_seconds)).toEqual([45, 45, 45]);

    // The source is as it was, with everything Alex did in it.
    expect(await sessionOf(q, pull)).toEqual(source);
    expect(await titlesOf(q, block.weeks[0])).toEqual(['Pull', 'Pull (copy)', '[Old push]']);
  }));

  it('duplicate_week and duplicate_program: every session of the source, the archived one still archived, numbered again', () => scenario(async (q) => {
    const source = await programOf(q, block.id);
    expect(source).toMatchObject({ name: 'Block A', is_active: true, sort_order: 2 });

    const week = await duplicateWeek(coach, block.weeks[0]);
    expect(week).toEqual({
      week_id: week.week_id, program_id: block.id, week_number: 3, label: 'Base (copy)', sessions: 2, slots: 4, set_logs: 12, slots_left_out: 0,
    });
    expect(await weekOf(q, week.week_id)).toEqual({
      week_number: 3,
      label: 'Base (copy)',
      sessions: source.weeks[0].sessions.map((session) => prescribed(session, { keepArchived: true })),
    });
    expect(await titlesOf(q, week.week_id)).toEqual(['Pull', '[Old push]']);

    // The block as it is now: three phases.
    const now = await programOf(q, block.id);
    const made = await duplicateProgram(coach, block.id);
    expect(made).toEqual({
      program_id: made.program_id, student_id: ids.studentA.studentRowId, name: 'Block A (copy)', sort_order: 3,
      weeks: 3, sessions: 6, slots: 12, set_logs: 36, slots_left_out: 0,
    });
    expect(await programOf(q, made.program_id)).toEqual({
      student_id: ids.studentA.studentRowId,
      name: 'Block A (copy)',
      // Last of Alex's blocks out of the trash (0, 0 and 2); the one in the trash holds 9.
      sort_order: 3,
      is_active: false,
      deleted_at: null,
      // The coach's, approved from the start: nobody wrote it as a draft.
      created_by: null,
      status: 'approved',
      submitted_at: null,
      approved_at: null,
      weeks: now.weeks.map((phase) => ({
        ...phase, sessions: phase.sessions.map((session) => prescribed(session, { keepArchived: true })),
      })),
    });
    // The block Alex trains is still the one he trains.
    expect(await activeOf(q, ids.studentA)).toEqual(['Block A']);
    expect(await programOf(q, block.id)).toEqual(now);
  }));

  it('copy_sessions: one copy per entry at the end of the phase, in the order of the list — titles as they are, none archived', () => scenario(async (q) => {
    const [destination] = ids.programB.weeks;
    const sources = { [plain]: await sessionOf(q, plain), [oldPush]: await sessionOf(q, oldPush), [pull]: await sessionOf(q, pull) };
    // An archived session of Billie, with the highest number of her phase.
    await q(`insert into sessions (week_id, title, sort_order, archived_at) values ($1, 'Archived', 7, now())`, [destination]);

    const list = [plain, oldPush, pull, plain];
    const made = await copySessions(coach, list, destination);
    expect(made).toEqual({ session_ids: made.session_ids, week_id: destination, slots: 8, set_logs: 24, slots_left_out: 0 });
    expect(made.session_ids).toHaveLength(4);
    expect(new Set(made.session_ids).size).toBe(4);

    for (const [i, id] of made.session_ids.entries()) {
      expect(await sessionOf(q, id), `entry ${i + 1}`).toEqual(prescribed(sources[list[i]], { sort_order: 8 + i }));
    }
    expect(await titlesOf(q, destination)).toEqual(['W1 · S1', '[Archived]', 'W2 · S2', 'Old push', 'Pull', 'W2 · S2']);
    // Billie trains her block: the copies are hers to log.
    expect(await asUser(ids.studentB, (b) => b.value(
      `select count(*) from set_logs sl join exercise_slots es on es.id = sl.exercise_slot_id where es.session_id = any($1)`,
      [made.session_ids],
    ))).toBe(24);
    expect((await asUser(ids.studentB, (b) => b(
      `update set_logs sl set done = true, logged_at = now() from exercise_slots es
        where es.id = sl.exercise_slot_id and es.session_id = any($1)`, [made.session_ids],
    ))).rowCount).toBe(24);
  }));

  // What the functions replace: the same block, copied by the requests of the
  // app that is deployed. Each side in a transaction of its own, so that both
  // copies get the same places.
  it('gives what the requests of the app that is deployed give — the place of a duplicated session apart', async () => {
    const both = async (byFunction, byApp, readCopy) => [
      await scenario(async (q) => readCopy(q, await byFunction())),
      await scenario(async (q) => readCopy(q, await coach((c) => byApp(c)))),
    ];
    const same = async (what, ...sides) => {
      const [fromFunction, fromApp] = await both(...sides);
      expect(fromFunction, what).toEqual(fromApp);
      return fromFunction;
    };

    // A block, and it is not a small one.
    const program = await same('duplicate_program',
      async () => (await duplicateProgram(coach, block.id)).program_id, (c) => app.duplicateProgram(c, block.id), programOf);
    expect(program.weeks.flatMap((phase) => phase.sessions).flatMap((session) => session.slots)).toHaveLength(8);

    // A phase: in its own block, and in a block of another athlete.
    await same('duplicate_week',
      async () => (await duplicateWeek(coach, block.weeks[0])).week_id, (c) => app.duplicateWeek(c, block.weeks[0]), weekOf);
    await same('duplicate_week, to another block',
      async () => (await duplicateWeek(coach, block.weeks[0], { p_dest_program_id: ids.programB.id })).week_id,
      (c) => app.duplicateWeek(c, block.weeks[0], ids.programB.id), weekOf);

    // Sessions, to another athlete.
    const readAll = (q, list) => Promise.all(list.map((id) => sessionOf(q, id)));
    await same('copy_sessions',
      async () => (await copySessions(coach, [pull, oldPush, untitled], ids.programB.weeks[0])).session_ids,
      (c) => app.copySessions(c, [pull, oldPush, untitled], ids.programB.weeks[0]), readAll);

    // One session. The last of its phase — an archived one, a plain one: the
    // same place too.
    for (const [what, id] of [['the last of its phase', plain], ['an archived one, the last of its phase', oldPush]]) {
      const copy = await same(`duplicate_session, ${what}`,
        async () => (await duplicateSession(coach, id)).session_id, (c) => app.duplicateSession(c, id), sessionOf);
      expect(copy.archived_at, what).toBeNull();
    }
    // The first of its phase — the one that was trained, the one without a
    // title: the app puts the copy at the end of the phase, the function right
    // after its source. Everything else is the same.
    for (const [what, id, title] of [['the one that was trained', pull, 'Pull (copy)'], ['one without a title', untitled, 'Session (copy)']]) {
      const [fromFunction, fromApp] = await both(
        async () => (await duplicateSession(coach, id)).session_id, (c) => app.duplicateSession(c, id), sessionOf,
      );
      expect([fromFunction.sort_order, fromApp.sort_order], what).toEqual([1, 2]);
      expect({ ...fromFunction, sort_order: null }, what).toEqual({ ...fromApp, sort_order: null });
      expect(fromFunction.title, what).toBe(title);
    }
  });

  it('the name given to a copy: the suffix the app sends, or none', () => scenario(async (q) => {
    const titleOf = async (made) => (await sessionOf(q, made.session_id)).title;
    expect(await titleOf(await duplicateSession(coach, pull, { p_title_suffix: ' (copie)' }))).toBe('Pull (copie)');
    expect(await titleOf(await duplicateSession(coach, untitled, { p_title_suffix: ' (Kopie)' }))).toBe('Session (Kopie)');
    // No suffix: the title as it is — also when there is none.
    expect(await titleOf(await duplicateSession(coach, pull, { p_title_suffix: '' }))).toBe('Pull');
    expect(await titleOf(await duplicateSession(coach, pull, { p_title_suffix: null }))).toBe('Pull');
    expect(await titleOf(await duplicateSession(coach, untitled, { p_title_suffix: '' }))).toBeNull();

    const labelOf = async (made) => (await weekOf(q, made.week_id)).label;
    expect(await labelOf(await duplicateWeek(coach, block.weeks[0], { p_label_suffix: ' (copie)' }))).toBe('Base (copie)');
    expect(await labelOf(await duplicateWeek(coach, block.weeks[0], { p_label_suffix: null }))).toBe('Base');
    // A phase without a name gives a copy without one, whatever the suffix.
    expect(await labelOf(await duplicateWeek(coach, block.weeks[1]))).toBeNull();
    expect(await labelOf(await duplicateWeek(coach, block.weeks[1], { p_label_suffix: ' (copie)' }))).toBeNull();

    expect((await duplicateProgram(coach, next.id, { p_name_suffix: ' — suite' })).name).toBe('Block N — suite');
    expect((await duplicateProgram(coach, next.id, { p_name_suffix: '' })).name).toBe('Block N');
    expect((await duplicateProgram(coach, next.id, { p_name_suffix: null })).name).toBe('Block N');
    expect((await duplicateProgram(coach, next.id, { p_target_student_id: null })).name).toBe('Block N (copy)');
  }));
});

// ============================================================
// Whole, or not there
// ============================================================
describe('a copy is whole, or it is not there (P52)', () => {
  const calls = () => [
    ['duplicate_session', () => duplicateSession(coach, pull)],
    ['copy_sessions', () => copySessions(coach, [plain, pull], ids.programB.weeks[0])],
    ['duplicate_week', () => duplicateWeek(coach, block.weeks[0])],
    ['duplicate_program', () => duplicateProgram(coach, block.id)],
  ];

  // The finding. The request that writes the sets never arrives.
  it('the sets are lost on the way: the functions leave nothing, the requests of the app a session whose exercises have no set', () => scenario(async (q) => {
    await loseTheInsertThat(q, 'set_logs', 'NEW.set_number = 2');
    const before = await census(q);
    const rows = await versions(q, 'sessions', 'true');

    for (const [name, call] of calls()) {
      expect(await refusal(call), name).toEqual([LOST, P0001]);
      expect(await census(q), name).toEqual(before);
    }
    // Not even the sessions that had moved down to make room.
    expect(await versions(q, 'sessions', 'true')).toEqual(rows);

    // The app: the session and its exercises are saved by then.
    expect(await refusal(() => coach((c) => app.duplicateSession(c, pull)))).toEqual([LOST, P0001]);
    expect(await census(q)).toEqual({ ...before, sessions: before.sessions + 1, slots: before.slots + 2 });
    // Alex opens his block, and finds it.
    expect(await alex((a) => a.rows(
      `select s.title, (select count(*) from exercise_slots es where es.session_id = s.id) as exercises,
              (select count(*) from set_logs sl join exercise_slots es on es.id = sl.exercise_slot_id where es.session_id = s.id) as sets
         from sessions s where s.title like '%(copy)'`,
    ))).toEqual([{ title: 'Pull (copy)', exercises: 2, sets: 0 }]);

    // A phase, the same way: its three sessions by now, their six exercises, no set.
    expect(await refusal(() => coach((c) => app.duplicateWeek(c, block.weeks[0])))).toEqual([LOST, P0001]);
    expect(await census(q)).toEqual({
      ...before, weeks: before.weeks + 1, sessions: before.sessions + 1 + 3, slots: before.slots + 2 + 6,
    });
  }));

  it('the exercises are lost on the way: the functions leave nothing, the requests of the app a session with no exercise', () => scenario(async (q) => {
    await loseTheInsertThat(q, 'exercise_slots', 'true');
    const before = await census(q);

    for (const [name, call] of calls()) {
      expect(await refusal(call), name).toEqual([LOST, P0001]);
      expect(await census(q), name).toEqual(before);
    }

    expect(await refusal(() => coach((c) => app.copySessions(c, [plain, pull], ids.programB.weeks[0])))).toEqual([LOST, P0001]);
    // The first of the two, empty; the second was never started.
    expect(await census(q)).toEqual({ ...before, sessions: before.sessions + 1 });
    expect(await titlesOf(q, ids.programB.weeks[0])).toEqual(['W1 · S1', 'W2 · S2']);

    // A block: the block, its first phase and the sessions of that phase …
    expect(await refusal(() => coach((c) => app.duplicateProgram(c, block.id)))).toEqual([LOST, P0001]);
    expect(await census(q)).toEqual({
      ...before, programs: before.programs + 1, weeks: before.weeks + 1, sessions: before.sessions + 3,
    });
    // … until the request by which the app takes a half-made block back
    // arrives. When what lost the first request loses that one too — a tab
    // that closes, no network — the block stays, not active, in the coach's list.
    expect((await coach((c) => c(`delete from programs where name = 'Block A (copy)'`))).rowCount).toBe(1);
    expect(await census(q)).toEqual({ ...before, sessions: before.sessions + 1 });
  }));

  // The app reads the sets of a phase back in one request, and the API
  // answers 1000 rows at most without saying that there were more. Inside the
  // database nothing is cut.
  it('a block of more than 1000 sets is copied with every one of them', () => scenario(async (q) => {
    const big = await createProgram({ student: ids.studentB, name: 'Big block', sessions: 9, sets: 60 });
    expect(big.setLogs).toHaveLength(1080);
    const made = await duplicateProgram(coach, big.id);
    expect(made).toMatchObject({ weeks: 1, sessions: 9, slots: 18, set_logs: 1080, slots_left_out: 0 });
    expect(await q.value(
      `select count(*) from set_logs sl join exercise_slots es on es.id = sl.exercise_slot_id
         join sessions s on s.id = es.session_id join weeks w on w.id = s.week_id where w.program_id = $1`, [made.program_id],
    )).toBe(1080);
  }));

  // What is copied is read once, before the first write. Here the block
  // changes between two writes of the copy — as it does when its coach edits
  // it in another tab: the note of an exercise is rewritten and the sets of
  // another one are taken away while the copy of the session is being saved.
  it('is the block as it was at one instant: an edit that lands while the copy is written is not half in it', () => scenario(async (q) => {
    const source = await sessionOf(q, pull);
    const [pullUp, dip] = block.tree[0].sessions[0].slots;
    await q(`create function public.test_edit_meanwhile() returns trigger language plpgsql as $f$
      begin
        if NEW.title = 'Pull (copy)' then
          update public.exercise_slots set notes = 'Rewritten meanwhile', sets = 5 where id = '${pullUp.id}';
          delete from public.set_logs where exercise_slot_id = '${dip.id}';
        end if;
        return NEW;
      end $f$`);
    await q(`create trigger zz_test_edit_meanwhile before insert on public.sessions
      for each row execute function public.test_edit_meanwhile()`);

    const made = await duplicateSession(coach, pull);
    expect(made).toMatchObject({ slots: 2, set_logs: 6 });
    // The edit happened …
    const edited = await sessionOf(q, pull);
    expect(edited.slots[0]).toMatchObject({ notes: 'Rewritten meanwhile', sets: 5 });
    expect(edited.slots[1].set_logs).toEqual([]);
    // … and the copy is the session as it was read.
    expect(await sessionOf(q, made.session_id)).toEqual(prescribed(source, { title: 'Pull (copy)', sort_order: 1 }));
  }));
});

// ============================================================
// Where a copy goes
// ============================================================
describe('where a copy goes', () => {
  const phase = () => next.weeks[0];
  const [a, b, c, d] = [0, 1, 2, 3].map((i) => () => next.sessions[i]);

  it('duplicate_session: right after its source, and the sessions that follow move down by one', () => scenario(async (q) => {
    expect(await orderOf(q, phase())).toEqual(numbered([a(), b(), c(), d()]));

    const first = await duplicateSession(coach, b());
    expect(first).toMatchObject({ week_id: phase(), sort_order: 2 });
    expect(await orderOf(q, phase())).toEqual(numbered([a(), b(), first.session_id, c(), d()]));

    // The first of the phase, then the copy that was just made.
    const second = await duplicateSession(coach, a());
    const third = await duplicateSession(coach, first.session_id);
    expect(await orderOf(q, phase()))
      .toEqual(numbered([a(), second.session_id, b(), first.session_id, third.session_id, c(), d()]));
    expect(third.title).toBe('W1 · S2 (copy) (copy)');
    // Nobody else's phase moved.
    expect(await orderOf(q, block.weeks[0])).toEqual(numbered([pull, oldPush]));
  }));

  it('duplicate_session: the last session of a phase, and a place that is free — nothing else is written', () => scenario(async (q) => {
    const before = await versions(q, 'sessions', 'week_id = $1', [phase()]);
    const last = await duplicateSession(coach, d());
    expect(last.sort_order).toBe(4);
    expect(await versions(q, 'sessions', 'week_id = $1 and id <> $2', [phase(), last.session_id])).toEqual(before);

    // A gap after b: a and b at 0 and 1, c and d at 5 and 6.
    await q(`update sessions set sort_order = sort_order + 10 where id = any($1)`, [[c(), d(), last.session_id]]);
    const spaced = await versions(q, 'sessions', 'week_id = $1', [phase()]);
    const inTheGap = await duplicateSession(coach, b());
    expect(await orderOf(q, phase()))
      .toEqual([[a(), 0], [b(), 1], [inTheGap.session_id, 2], [c(), 12], [d(), 13], [last.session_id, 14]]);
    expect(await versions(q, 'sessions', 'week_id = $1 and id <> $2', [phase(), inTheGap.session_id])).toEqual(spaced);
  }));

  it('duplicate_session: archived sessions are sessions of the phase like the others, and a copy is never archived', () => scenario(async (q) => {
    await q(`update sessions set archived_at = now() where id = any($1)`, [[b(), c()]]);

    const afterA = await duplicateSession(coach, a());
    expect(await titlesOf(q, phase())).toEqual(['W1 · S1', 'W1 · S1 (copy)', '[W1 · S2]', '[W1 · S3]', 'W1 · S4']);
    expect(await orderOf(q, phase())).toEqual(numbered([a(), afterA.session_id, b(), c(), d()]));

    // The copy of an archived session was asked for: it is live.
    const ofArchived = await duplicateSession(coach, b());
    expect(await titlesOf(q, phase()))
      .toEqual(['W1 · S1', 'W1 · S1 (copy)', '[W1 · S2]', 'W1 · S2 (copy)', '[W1 · S3]', 'W1 · S4']);
    expect(ofArchived.sort_order).toBe(3);
  }));

  // What migration 11 found: a phase an interrupted reorder of the app left
  // numbered 100000 and more. The sessions that follow are parked above every
  // number the phase holds, so the copy is made there too.
  it('duplicate_session: in a phase left parked at 100000 and more, and next to numbers that are not 0 to n-1', () => scenario(async (q) => {
    await q(`update sessions set sort_order = sort_order + 100000 where week_id = $1`, [phase()]);
    const parked = await duplicateSession(coach, a());
    expect(await orderOf(q, phase()))
      .toEqual(numbered([a(), parked.session_id, b(), c(), d()], 100000));

    await q(`update sessions set sort_order = sort_order - 100003 where week_id = $1`, [phase()]);
    expect((await orderOf(q, phase())).map(([, n]) => n)).toEqual([-3, -2, -1, 0, 1]);
    const negative = await duplicateSession(coach, parked.session_id);
    expect(await orderOf(q, phase()))
      .toEqual(numbered([a(), parked.session_id, negative.session_id, b(), c(), d()], -3));
  }));

  it('copy_sessions: after every session the phase holds; an empty list, or none, copies nothing', () => scenario(async (q) => {
    const before = await census(q);
    for (const list of [[], null]) {
      expect(await copySessions(coach, list, phase())).toEqual({ session_ids: [], week_id: phase(), slots: 0, set_logs: 0, slots_left_out: 0 });
    }
    expect(await census(q)).toEqual(before);

    // Into its own phase, and into a phase with no session.
    const own = await copySessions(coach, [d(), a()], phase());
    expect(await orderOf(q, phase())).toEqual(numbered([a(), b(), c(), d(), ...own.session_ids]));
    expect(await titlesOf(q, phase())).toEqual(['W1 · S1', 'W1 · S2', 'W1 · S3', 'W1 · S4', 'W1 · S4', 'W1 · S1']);
    const empty = await q.value(`insert into weeks (program_id, week_number) values ($1, 2) returning id`, [next.id]);
    const first = await copySessions(coach, [c()], empty);
    expect(await orderOf(q, empty)).toEqual([[first.session_ids[0], 0]]);
  }));

  it('duplicate_week: the last phase of its block, or of another one; its sessions in their order, numbered from 0', () => scenario(async (q) => {
    // The source as an interrupted reorder, a delete and an archive left it.
    await q(`update sessions set sort_order = case id when $1 then 100002 when $2 then 100000 when $3 then 7 else 3 end where week_id = $4`,
      [a(), b(), c(), phase()]);
    await q(`update sessions set archived_at = now() where id = $1`, [c()]);
    await q(`update weeks set week_number = 4 where id = $1`, [phase()]);

    const own = await duplicateWeek(coach, phase());
    expect(own).toMatchObject({ program_id: next.id, week_number: 5, label: null, sessions: 4 });
    expect(await titlesOf(q, own.week_id)).toEqual(['W1 · S4', '[W1 · S3]', 'W1 · S2', 'W1 · S1']);
    expect((await orderOf(q, own.week_id)).map(([, n]) => n)).toEqual([0, 1, 2, 3]);
    // The source keeps its numbers.
    expect(await orderOf(q, phase())).toEqual([[d(), 3], [c(), 7], [b(), 100000], [a(), 100002]]);

    // To a block of another athlete of the coach, which has one phase.
    const theirs = await duplicateWeek(coach, phase(), { p_dest_program_id: ids.programB.id });
    expect(theirs).toMatchObject({ program_id: ids.programB.id, week_number: 2, sessions: 4, slots: 8, set_logs: 8 });
    // To a block with no phase at all.
    const fresh = await q.value(`insert into programs (student_id, name) values ($1, 'Empty') returning id`, [ids.studentB.studentRowId]);
    expect(await duplicateWeek(coach, phase(), { p_dest_program_id: fresh })).toMatchObject({ program_id: fresh, week_number: 1 });
    // A phase with no session.
    const empty = await q.value(`insert into weeks (program_id, week_number, label) values ($1, 9, 'Deload') returning id`, [next.id]);
    expect(await duplicateWeek(coach, empty)).toMatchObject({ week_number: 10, label: 'Deload (copy)', sessions: 0, slots: 0, set_logs: 0 });
  }));

  it('duplicate_program: last in the list of the athlete it is for, not active; its phases in their order, numbered from 1', () => scenario(async (q) => {
    const listOf = async (student) => (await q.rows(
      `select name, sort_order, is_active from programs where student_id = $1 and deleted_at is null and status = 'approved'
        order by sort_order, name`, [student.studentRowId],
    )).map((p) => `${p.sort_order} ${p.name}${p.is_active ? ' (active)' : ''}`);
    expect(await listOf(ids.studentA)).toEqual(['0 Block N', '2 Block A (active)']);

    // For its own athlete: after the 2 of Block A — the 9 of the block in the trash does not count.
    const own = await duplicateProgram(coach, next.id);
    expect(await listOf(ids.studentA)).toEqual(['0 Block N', '2 Block A (active)', '3 Block N (copy)']);
    expect(own.student_id).toBe(ids.studentA.studentRowId);

    // For another athlete of the coach, with the same name.
    const theirs = await duplicateProgram(coach, block.id, { p_target_student_id: ids.studentB.studentRowId, p_name_suffix: '' });
    expect(theirs).toMatchObject({ student_id: ids.studentB.studentRowId, name: 'Block A', sort_order: 1, weeks: 2, sessions: 4 });
    expect(await listOf(ids.studentB)).toEqual(['0 Billie wrote it', '0 Block B (active)', '1 Block A']);
    expect(await activeOf(q, ids.studentB)).toEqual(['Block B']);
    // … and Billie reads it, and logs nothing in it until it is set active.
    expect(await asUser(ids.studentB, (billie) => billie.value(
      `select count(*) from sessions s join weeks w on w.id = s.week_id where w.program_id = $1`, [theirs.program_id],
    ))).toBe(4);
    expect((await asUser(ids.studentB, (billie) => billie(
      `update set_logs sl set done = true from exercise_slots es join sessions s on s.id = es.session_id join weeks w on w.id = s.week_id
        where es.id = sl.exercise_slot_id and w.program_id = $1`, [theirs.program_id],
    ))).rowCount).toBe(0);

    // An athlete with no block at all, and a block whose phases were left at 100000 and more.
    const fresh = await createUser({ email: 'fresh@sl.test', fullName: 'Fresh Athlete', coach: ids.coach });
    await q(`update weeks set week_number = case id when $1 then 100001 else 100000 end where program_id = $2`, [block.weeks[0], block.id]);
    const first = await duplicateProgram(coach, block.id, { p_target_student_id: fresh.studentRowId });
    expect(first).toMatchObject({ sort_order: 0, weeks: 2 });
    expect((await programOf(q, first.program_id)).weeks.map((w) => [w.week_number, w.label])).toEqual([[1, null], [2, 'Base']]);
    // A block with no phase.
    const empty = await q.value(`insert into programs (student_id, name) values ($1, 'Empty') returning id`, [fresh.studentRowId]);
    expect(await duplicateProgram(coach, empty)).toMatchObject({ name: 'Empty (copy)', weeks: 0, sessions: 0, slots: 0, set_logs: 0 });
  }));
});

// ============================================================
// Who copies what, and where to
// ============================================================
describe('what is copied is what the caller reads, where it goes is where the caller writes', () => {
  const others = () => [
    ['another coach', (fn) => asUser(olga, fn)],
    ['an athlete of another coach', (fn) => asUser(casey, fn)],
    ['another athlete of the same coach', (fn) => asUser(ids.studentB, fn)],
    ['a token that names no user', (fn) => asUser(ids.coach, fn, { claims: { sub: null } })],
  ];

  it('somebody else\'s athlete, and an id that is nothing: not found, and nothing is written', () => scenario(async (q) => {
    const before = await census(q);
    const rows = await versions(q, 'sessions', 'true');
    const nobody = await q.value(`select gen_random_uuid()`);

    for (const [who, as] of others()) {
      expect(await refusal(() => duplicateSession(as, pull)), who).toEqual(['session_not_found', P0001]);
      expect(await refusal(() => copySessions(as, [pull], block.weeks[1])), who).toEqual(['week_not_found', P0001]);
      expect(await refusal(() => duplicateWeek(as, block.weeks[0])), who).toEqual(['week_not_found', P0001]);
      expect(await refusal(() => duplicateProgram(as, block.id)), who).toEqual(['program_not_found', P0001]);
    }
    for (const id of [nobody, null]) {
      expect(await refusal(() => duplicateSession(coach, id))).toEqual(['session_not_found', P0001]);
      expect(await refusal(() => copySessions(coach, [pull], id))).toEqual(['week_not_found', P0001]);
      expect(await refusal(() => duplicateWeek(coach, id))).toEqual(['week_not_found', P0001]);
      expect(await refusal(() => duplicateProgram(coach, id))).toEqual(['program_not_found', P0001]);
    }
    expect(await refusal(() => duplicateWeek(coach, block.weeks[0], { p_dest_program_id: nobody }))).toEqual(['program_not_found', P0001]);
    expect(await refusal(() => duplicateProgram(coach, block.id, { p_target_student_id: nobody }))).toEqual(['student_not_found', P0001]);
    // The id of an athlete is the one of their link, not of their account.
    const asked = await attempt(() => duplicateProgram(coach, block.id, { p_target_student_id: ids.studentB.id }));
    expect([asked.error?.message, asked.error?.code]).toEqual(['student_not_found', P0001]);
    expect(asked.error.detail).toBe('No athlete with this id can be read by the caller. The id is the one of public.students, not of a profile.');

    expect(await census(q)).toEqual(before);
    expect(await versions(q, 'sessions', 'true')).toEqual(rows);
  }));

  it('from one coach to another, in either direction: the half the caller cannot read or write is not found', () => scenario(async (q) => {
    const before = await census(q);
    const olgas = (fn) => asUser(olga, fn);

    // Carla, into a phase, a block, an athlete of Olga.
    expect(await refusal(() => copySessions(coach, [pull], blockC.weeks[0]))).toEqual(['week_not_found', P0001]);
    expect(await refusal(() => duplicateWeek(coach, block.weeks[0], { p_dest_program_id: blockC.id }))).toEqual(['program_not_found', P0001]);
    expect(await refusal(() => duplicateProgram(coach, block.id, { p_target_student_id: casey.studentRowId })))
      .toEqual(['student_not_found', P0001]);
    // Carla, out of a block of Olga's athlete.
    expect(await refusal(() => duplicateSession(coach, blockC.sessions[0]))).toEqual(['session_not_found', P0001]);
    expect(await refusal(() => duplicateWeek(coach, blockC.weeks[0], { p_dest_program_id: block.id }))).toEqual(['week_not_found', P0001]);
    expect(await refusal(() => duplicateProgram(coach, blockC.id, { p_target_student_id: ids.studentA.studentRowId })))
      .toEqual(['program_not_found', P0001]);

    // Olga, with her own sessions next to one of Carla's athlete: none of the list is copied.
    const mixed = await attempt(() => copySessions(olgas, [blockC.sessions[0], pull, blockC.sessions[1], null], blockC.weeks[0]));
    expect([mixed.error?.message, mixed.error?.code]).toEqual(['session_not_found', P0001]);
    expect(mixed.error.detail).toBe('2 of the 4 id(s) of the list are not sessions the caller can read.');
    // Olga, her own block for an athlete of Carla.
    expect(await refusal(() => duplicateProgram(olgas, blockC.id, { p_target_student_id: ids.studentA.studentRowId })))
      .toEqual(['student_not_found', P0001]);
    expect(await census(q)).toEqual(before);

    // Her own, for her own athlete: through.
    expect(await copySessions(olgas, [blockC.sessions[1], blockC.sessions[0]], blockC.weeks[0])).toMatchObject({ slots: 2, set_logs: 6 });
    expect(await duplicateProgram(olgas, blockC.id)).toMatchObject({ student_id: casey.studentRowId, name: 'Block C (copy)', slots_left_out: 0 });
  }));

  it('the athlete reads their block and copies nothing in it — and without a session the functions are not entered', () => scenario(async (q) => {
    const before = await census(q);
    const rows = await versions(q, 'sessions', 'true');

    for (const [name, call, detail] of [
      ['duplicate_session', () => duplicateSession(alex, pull), 'The caller reads this session and may not write its phase.'],
      ['copy_sessions', () => copySessions(alex, [pull], block.weeks[1]), 'The caller reads this phase and may not write it.'],
      ['duplicate_week', () => duplicateWeek(alex, block.weeks[0]), 'The caller reads this program and may not write it.'],
      ['duplicate_program', () => duplicateProgram(alex, block.id), 'The caller reads this athlete and may not write their programs.'],
      // A block that is not the one they train is no different.
      ['duplicate_session, in the next block', () => duplicateSession(alex, next.sessions[0]), 'The caller reads this session and may not write its phase.'],
      ['duplicate_program, of the next block', () => duplicateProgram(alex, next.id, { p_target_student_id: ids.studentA.studentRowId }),
        'The caller reads this athlete and may not write their programs.'],
    ]) {
      const asked = await attempt(call);
      expect([asked.error?.message, asked.error?.code], name).toEqual(['not authorized', DENIED]);
      expect(asked.error.detail, name).toBe(detail);
    }

    expect(await refusal(() => duplicateSession(asAnon, pull))).toEqual(['permission denied for function duplicate_session', DENIED]);
    expect(await refusal(() => copySessions(asAnon, [pull], block.weeks[1]))).toEqual(['permission denied for function copy_sessions', DENIED]);
    expect(await refusal(() => duplicateWeek(asAnon, block.weeks[0]))).toEqual(['permission denied for function duplicate_week', DENIED]);
    expect(await refusal(() => duplicateProgram(asAnon, block.id))).toEqual(['permission denied for function duplicate_program', DENIED]);

    expect(await census(q)).toEqual(before);
    expect(await versions(q, 'sessions', 'true')).toEqual(rows);
  }));

  it('give no right of their own: the owner and the service role, whom row-level security does not hold, get through', () => scenario(async (q) => {
    expect(await duplicateSession(asService, pull)).toMatchObject({ sort_order: 1, slots: 2, set_logs: 6 });
    expect(await copySessions(asAdmin, [blockC.sessions[0]], blockC.weeks[0])).toMatchObject({ slots: 1, set_logs: 3 });
    expect(await duplicateWeek(asService, blockC.weeks[0])).toMatchObject({ program_id: blockC.id, week_number: 2 });
    expect(await duplicateProgram(asAdmin, block.id)).toMatchObject({ name: 'Block A (copy)', weeks: 2 });
    // From a coach to another: for them the library decides alone (below).
    // Block A holds five sessions by now.
    expect(await duplicateProgram(asService, block.id, { p_target_student_id: casey.studentRowId }))
      .toMatchObject({ student_id: casey.studentRowId, sessions: 5, slots: 0, set_logs: 0, slots_left_out: 10 });
    // The refusals are the same for them.
    expect(await refusal(() => duplicateSession(asService, null))).toEqual(['session_not_found', P0001]);
    expect(await q.value(`select count(*) from programs where name = 'Block A (copy)'`)).toBe(2);
  }));
});

// ============================================================
// An exercise of another coach's library
// ============================================================
describe('an exercise that is not in the library of the coach the copy is for is left out, and counted', () => {
  it('a block written by the former coach of an athlete: the sessions, the exercises of the new library, and how many were left out', () => scenario(async (q) => {
    // Tess is Carla's athlete now; Olga no longer reads her block.
    expect(await refusal(() => duplicateProgram((fn) => asUser(olga, fn), olgaBlock.id))).toEqual(['program_not_found', P0001]);

    const made = await duplicateProgram(coach, olgaBlock.id);
    expect(made).toMatchObject({
      student_id: tess.studentRowId, name: 'Olga block (copy)', weeks: 1, sessions: 2, slots: 1, set_logs: 2, slots_left_out: 2,
    });
    const copy = await programOf(q, made.program_id);
    expect(copy.weeks[0].sessions.map((session) => session.slots.map((slot) => slot.exercise_id)))
      .toEqual([[ids.exercises.pullUp], []]);
    expect(copy.weeks[0].sessions[0].slots[0]).toMatchObject({ sets: 2, sort_order: 1 });
    expect(copy.weeks[0].sessions[0].slots[0].set_logs).toHaveLength(2);

    // The three others, on the same sessions.
    expect(await duplicateSession(coach, olgaBlock.sessions[0])).toMatchObject({ slots: 1, set_logs: 2, slots_left_out: 1 });
    expect(await duplicateSession(coach, olgaBlock.sessions[1])).toMatchObject({ slots: 0, set_logs: 0, slots_left_out: 1 });
    // The phase holds four sessions by now, and two exercises of each library.
    expect(await duplicateWeek(coach, olgaBlock.weeks[0])).toMatchObject({ sessions: 4, slots: 2, set_logs: 4, slots_left_out: 2 });
    // To another athlete of Carla: twice the first session, once the second.
    expect(await copySessions(coach, [olgaBlock.sessions[0], olgaBlock.sessions[1], olgaBlock.sessions[0]], block.weeks[1]))
      .toMatchObject({ slots: 2, set_logs: 4, slots_left_out: 3 });
    // Nothing of Olga's library is in a block of Carla's athletes that was not there before.
    expect(await q.value(`select count(*) from exercise_slots where exercise_id = $1`, [row])).toBe(2 + 2);
  }));

  // The rule the functions go around (migration 05): a slot takes an exercise
  // of the library of its program's coach. The app copies slot by slot, and
  // stops at the first one that is refused.
  it('the requests of the app, on the same block: refused at the first such exercise, the session left empty', () => scenario(async (q) => {
    const before = await census(q);
    const tried = await attempt(() => coach((c) => app.duplicateSession(c, olgaBlock.sessions[0])));
    expect(tried.error?.code).toBe('23514');
    expect(tried.error.message).toContain('is not in the library of the coach of this program');
    expect(await census(q)).toEqual({ ...before, sessions: before.sessions + 1 });
  }));
});

// ============================================================
// A draft, a block in the trash
// ============================================================
describe('a draft, a block in the trash, a block its athlete wrote, the block that is trained', () => {
  it('the copy of a block is an approved block of the coach, out of the trash and not active — whatever its source is', () => scenario(async (q) => {
    const state = async (id) => q.one(
      `select status, created_by, submitted_at is not null as submitted, deleted_at is not null as in_trash, is_active
         from programs where id = $1`, [id],
    );
    const A_COPY = { status: 'approved', created_by: null, submitted: false, in_trash: false, is_active: false };
    await q(`update programs set submitted_at = now() where id = $1`, [draft.id]);
    expect(await state(draft.id)).toEqual({ status: 'draft', created_by: ids.studentA.id, submitted: true, in_trash: false, is_active: false });
    expect(await state(trashed.id)).toMatchObject({ in_trash: true });

    // A draft holds no set before it is approved, and neither does its copy.
    const ofDraft = await duplicateProgram(coach, draft.id);
    expect(ofDraft).toMatchObject({ name: 'My draft (copy)', weeks: 1, sessions: 2, slots: 4, set_logs: 0 });
    expect(await state(ofDraft.program_id)).toEqual(A_COPY);
    // Alex still has his one draft, as it was.
    expect(await q.value(`select count(*) from programs where student_id = $1 and status = 'draft'`, [ids.studentA.studentRowId])).toBe(1);

    const ofTrashed = await duplicateProgram(coach, trashed.id);
    expect(await state(ofTrashed.program_id)).toEqual(A_COPY);
    // A block its athlete wrote and the coach approved: the copy is the coach's, and was never approved.
    expect(await q.one(`select created_by, approved_at is not null as approved from programs where id = $1`, [authored.id]))
      .toEqual({ created_by: ids.studentB.id, approved: true });
    const ofAuthored = await duplicateProgram(coach, authored.id);
    expect(ofAuthored).toMatchObject({ name: 'Billie wrote it (copy)', slots: 2, set_logs: 6 });
    expect(await state(ofAuthored.program_id)).toEqual(A_COPY);
    expect(await q.value(`select approved_at from programs where id = $1`, [ofAuthored.program_id])).toBeNull();
    expect(await state((await duplicateProgram(coach, block.id)).program_id)).toEqual(A_COPY);
    expect(await activeOf(q, ids.studentA)).toEqual(['Block A']);
  }));

  it('into a draft: a session arrives with its sets, as the app copies it, and is not archived there', () => scenario(async (q) => {
    const made = await duplicateWeek(coach, block.weeks[0], { p_dest_program_id: draft.id });
    expect(made).toMatchObject({ program_id: draft.id, week_number: 2, sessions: 2, slots: 4, set_logs: 12 });
    // The session that is archived in its block: a session of a draft carries
    // no archive (pin_draft_session_columns, migration 06).
    expect(await titlesOf(q, made.week_id)).toEqual(['Pull', 'Old push']);
  }));

  it('ride the rights the caller has: the author of a draft duplicates a session of it, and copies nothing out of the block they train', () => scenario(async (q) => {
    const [first, second] = draft.sessions;
    const made = await duplicateSession(alex, first);
    expect(made).toMatchObject({ sort_order: 1, slots: 2, set_logs: 0, slots_left_out: 0 });
    expect(await orderOf(q, draft.weeks[0])).toEqual(numbered([first, made.session_id, second]));
    expect(await duplicateWeek(alex, draft.weeks[0])).toMatchObject({ program_id: draft.id, week_number: 2, sessions: 3, slots: 6, set_logs: 0 });

    // A session of the block they train holds sets, and an athlete writes no
    // set in a draft: the policy of set_logs refuses, and nothing of the copy stays.
    const before = await census(q);
    const refused = await attempt(() => copySessions(alex, [pull], draft.weeks[0]));
    expect(refused.error?.code).toBe(DENIED);
    expect(refused.error.message).toContain('row-level security policy for table "set_logs"');
    expect(await census(q)).toEqual(before);
    // … and a block of their own is the coach's to make.
    expect(await refusal(() => duplicateProgram(alex, draft.id))).toEqual(['not authorized', DENIED]);
  }));
});

// ============================================================
// Two requests at once
// ============================================================
describe('two requests that cross wait for each other', () => {
  // Without the lock on the phase the second does not see the copy the first
  // has made: both take the place after the source, and the second ends on
  // sessions_week_sort_order_unique.
  it('one session duplicated twice in the same instant: the second waits, and both copies stand after it', async () => {
    const [week] = race.weeks;
    const [x, y, z] = race.tree[0].sessions.map((s) => s.id);
    let first;

    const second = await cross({
      what: 'the second duplicate',
      first: (hold) => committed(ids.coach, async (c) => {
        first = await c.value(`select public.duplicate_session($1)`, [x]);
        await hold();
      }),
      second: () => committed(ids.coach, (c) => c.value(`select public.duplicate_session($1)`, [x])),
    });
    expect(second.error?.message).toBeUndefined();
    expect([first.sort_order, second.value.sort_order]).toEqual([1, 1]);
    expect(await asAdmin((q) => orderOf(q, week))).toEqual(numbered([x, second.value.session_id, first.session_id, y, z]));
  });

  // The same lock as reorder_sessions takes: the list a reorder was sent with
  // is judged against the phase as the copy left it.
  it('a session duplicated while a reorder of its phase is on its way: the reorder waits, and is refused on a list that is one short', async () => {
    const [, week] = race.weeks;
    const [x, y, z] = race.tree[1].sessions.map((s) => s.id);

    const reorder = await cross({
      what: 'the reorder',
      first: (hold) => committed(ids.coach, async (c) => {
        await c.value(`select public.duplicate_session($1)`, [y]);
        await hold();
      }),
      second: () => committed(ids.coach, (c) => c(`select public.reorder_sessions($1, $2)`, [week, [z, y, x]])),
    });
    expect([reorder.error?.message, reorder.error?.code]).toEqual(['reorder_ids_mismatch', P0001]);
    expect((await asAdmin((q) => titlesOf(q, week)))).toEqual(['W2 · S1', 'W2 · S2', 'W2 · S2 (copy)', 'W2 · S3']);
  });

  // Without the lock on the athlete's programs both read the same last place.
  it('one block duplicated twice in the same instant: the second waits, and the two copies have each their place in the list', async () => {
    const second = await cross({
      what: 'the second duplicate',
      first: (hold) => committed(ids.coach, async (c) => {
        expect(await c.value(`select public.duplicate_program($1)`, [race.id])).toMatchObject({ sort_order: 1 });
        await hold();
      }),
      second: () => committed(ids.coach, (c) => c.value(`select public.duplicate_program($1)`, [race.id])),
    });
    expect(second.error?.message).toBeUndefined();
    expect(second.value).toMatchObject({ name: 'Race (copy)', sort_order: 2 });
    expect(await asAdmin((q) => q.rows(
      `select name, sort_order, is_active from programs where student_id = $1 order by sort_order`, [rae.studentRowId],
    ))).toEqual([
      { name: 'Race', sort_order: 0, is_active: true },
      { name: 'Race (copy)', sort_order: 1, is_active: false },
      { name: 'Race (copy)', sort_order: 2, is_active: false },
    ]);
  });

  // The session is found, the call waits for its phase — and by the time it
  // has it, the session is no longer there. Nothing of it was read yet.
  it('a session deleted, or moved to another phase, while its duplicate waits: the call says so and writes nothing', async () => {
    const [first, week] = race.weeks;
    const [x, , z] = race.tree[1].sessions.map((s) => s.id);
    const before = await asAdmin((q) => census(q));

    const ofDeleted = await cross({
      what: 'the duplicate',
      first: (hold) => committed(ids.coach, async (c) => {
        expect((await c(`delete from sessions where id = $1`, [z])).rowCount).toBe(1);
        await hold();
      }),
      second: () => committed(ids.coach, (c) => c.value(`select public.duplicate_session($1)`, [z])),
    });
    expect([ofDeleted.error?.message, ofDeleted.error?.code]).toEqual(['copy_source_changed', P0001]);
    expect(ofDeleted.error.detail).toBe('The session was deleted or moved to another phase while the call waited.');
    expect(ofDeleted.error.hint).toBe('Read the block again, then try again. Nothing was changed.');

    const others = await asAdmin((q) => orderOf(q, first));
    const ofMoved = await cross({
      what: 'the duplicate',
      first: (hold) => committed(ids.coach, async (c) => {
        const stay = (await orderOf(c, week)).map(([id]) => id).filter((id) => id !== x);
        await c(`select public.move_session($1, $2, $3, $4)`, [x, first, stay, [...others.map(([id]) => id), x]]);
        await hold();
      }),
      second: () => committed(ids.coach, (c) => c.value(`select public.duplicate_session($1)`, [x])),
    });
    expect([ofMoved.error?.message, ofMoved.error?.code]).toEqual(['copy_source_changed', P0001]);

    // One session fewer, with its two exercises and their sets: the one that was deleted. No copy.
    expect(await asAdmin((q) => census(q))).toEqual({
      ...before, sessions: before.sessions - 1, slots: before.slots - 2, set_logs: before.set_logs - 2,
    });
    expect(await asAdmin((q) => titlesOf(q, week))).toEqual(['W2 · S2', 'W2 · S2 (copy)']);
    // Asked again, where it is now, it is duplicated.
    expect(await committed(ids.coach, (c) => c.value(`select public.duplicate_session($1)`, [x]))).toMatchObject({ week_id: first, title: 'W2 · S1 (copy)' });
  });
});

// ============================================================
// The migration file, on production as it is
// ============================================================
describe('migration 12 applied to the production baseline', () => {
  const COACH = '00000000-0000-4000-8000-00000000c0ac';
  const OLGA = '00000000-0000-4000-8000-00000000c0b0';
  const ATHLETE = '00000000-0000-4000-8000-0000000000a1';
  const SECOND = '00000000-0000-4000-8000-0000000000a2';
  const LINK = '00000000-0000-4000-8000-000000000101';
  const LINK_SECOND = '00000000-0000-4000-8000-000000000102';
  const EXERCISE = '00000000-0000-4000-8000-000000000201';
  const BLOCK = '00000000-0000-4000-8000-000000000301';
  const THEIRS = '00000000-0000-4000-8000-000000000302';
  const W1 = '00000000-0000-4000-8000-000000000401';
  const W9 = '00000000-0000-4000-8000-000000000409';
  const S1 = '00000000-0000-4000-8000-000000000451';
  const S2 = '00000000-0000-4000-8000-000000000452';
  const S9 = '00000000-0000-4000-8000-000000000459';
  const SLOT1 = '00000000-0000-4000-8000-000000000501';
  const SLOT9 = '00000000-0000-4000-8000-000000000509';
  const TO_COME = '2099_01_01_99_a_migration_to_come';

  // Two coaches and two athletes of the first one. Alex trains "Block": one
  // phase, "Base", of two sessions — "One" holds an exercise of two sets, the
  // first of which he has done; "Two" holds nothing yet. Billie trains "Their
  // block": one phase without a name, one session, one exercise, one set.
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
      ('${BLOCK}', '${LINK}', 'Block', true), ('${THEIRS}', '${LINK_SECOND}', 'Their block', true);
    insert into public.weeks (id, program_id, week_number, label) values
      ('${W1}', '${BLOCK}', 1, 'Base'), ('${W9}', '${THEIRS}', 1, null);
    insert into public.sessions (id, week_id, title, sort_order) values
      ('${S1}', '${W1}', 'One', 0), ('${S2}', '${W1}', 'Two', 1), ('${S9}', '${W9}', 'Theirs', 0);
    insert into public.exercise_slots (id, session_id, exercise_id, sets, reps, sort_order) values
      ('${SLOT1}', '${S1}', '${EXERCISE}', 2, 5, 0), ('${SLOT9}', '${S9}', '${EXERCISE}', 1, 5, 0);
    insert into public.set_logs (exercise_slot_id, set_number, target_reps, done, rpe, logged_at) values
      ('${SLOT1}', 1, 5, true, 8, now()), ('${SLOT1}', 2, 4, false, null, null), ('${SLOT9}', 1, 5, false, null, null);
  `;

  /** The frozen baseline with that world in it and the migrations before 12 applied. */
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

  const dupSession = `select public.duplicate_session('${S1}')`;
  const copyToTheirs = `select public.copy_sessions(array['${S2}', '${S1}']::uuid[], '${W9}')`;
  const dupWeek = `select public.duplicate_week('${W1}')`;
  const dupProgram = `select public.duplicate_program('${BLOCK}', '${LINK_SECOND}')`;
  const titles = (week) => `select string_agg(title, ', ' order by sort_order) from public.sessions where week_id = '${week}'`;
  const phases = `select string_agg(coalesce(label, '-'), ', ' order by week_number) from public.weeks where program_id = '${BLOCK}'`;
  const theirBlocks = `select string_agg(name || case when is_active then ' (active)' else '' end, ', ' order by sort_order, name)
                         from public.programs where student_id = '${LINK_SECOND}'`;

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
  const listEmptySessions = quoted('select pr.full_name as athlete, p.name as block, coalesce(s.title');
  const listWithoutSets = quoted('select pr.full_name as athlete, p.name as block, count(distinct s.id) as sessions');
  const listOtherLibrary = quoted('select pr.full_name as athlete, coach.full_name as coach, owner.full_name as library_of');

  const printedAudit = async (db) => {
    const [result] = await db.readOnly(read(migration.paths.audit), 'audit');
    return Object.fromEntries(result.rows.map((line) => [line.check, line.value]));
  };
  const LINE = {
    session: 'a session is duplicated in one request (duplicate_session, P52)',
    sessions: 'sessions are copied into a phase in one request (copy_sessions, P52)',
    week: 'a phase is duplicated in one request (duplicate_week, P52)',
    program: 'a block is duplicated in one request (duplicate_program, P52)',
    strangers: 'functions of these names that the migration does not know',
    anon: 'functions of this migration a request without a session may execute',
    users: 'functions of this migration a signed-in user may execute',
    emptySessions: 'sessions without an exercise',
    withoutSets: 'exercises without a set',
    otherLibrary: 'exercises that are not in the library of their athlete\'s coach',
  };
  const THE_FOUR = 'copy_sessions(uuid[], uuid); duplicate_program(uuid, uuid, text); duplicate_session(uuid, text); duplicate_week(uuid, uuid, text)';
  const untouched = async (db, before) => {
    expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
    expect(await db.query.value(`select count(*) from ${LEDGER} where name = $1`, [MIGRATION])).toBe(0);
  };
  const rows = (db) => db.query.one(
    `select (select count(*) from public.programs) as programs, (select count(*) from public.weeks) as weeks,
            (select count(*) from public.sessions) as sessions, (select count(*) from public.exercise_slots) as slots,
            (select count(*) from public.set_logs) as set_logs`,
  );
  const AS_IT_WAS = { programs: 2, weeks: 2, sessions: 3, slots: 2, set_logs: 3 };

  it('the four functions are not there before, are the coach\'s after, and are gone after the rollback — no row is written by either file', async () => {
    const db = await production();
    const missing = (name, args) => `function public.${name}(${args}) does not exist`;
    const allMissing = async () => {
      expect(await story(db, THE_COACH, dupSession)).toBe(missing('duplicate_session', 'unknown'));
      expect(await story(db, THE_COACH, copyToTheirs)).toBe(missing('copy_sessions', 'uuid[], unknown'));
      expect(await story(db, THE_COACH, dupWeek)).toBe(missing('duplicate_week', 'unknown'));
      expect(await story(db, THE_COACH, dupProgram)).toBe(missing('duplicate_program', 'unknown, unknown'));
    };
    await allMissing();

    await db.runFile(migration.paths.migration);

    expect(await story(db, THE_COACH, dupSession)).toMatchObject({ week_id: W1, sort_order: 1, title: 'One (copy)', slots: 1, set_logs: 2, slots_left_out: 0 });
    expect(await story(db, THE_COACH, dupSession, titles(W1))).toBe('One, One (copy), Two');
    expect(await story(db, THE_COACH, copyToTheirs, titles(W9))).toBe('Theirs, Two, One');
    expect(await story(db, THE_COACH, dupWeek, phases)).toBe('Base, Base (copy)');
    expect(await story(db, THE_COACH, dupProgram, theirBlocks)).toBe('Their block (active), Block (copy)');
    // What the coach copied holds the targets, and nothing Alex did.
    expect(await story(db, THE_COACH, dupSession, dupWeek, dupProgram,
      `select count(*) || ' sets, ' || count(*) filter (where done or rpe is not null or logged_at is not null) || ' trained' from public.set_logs`))
      .toBe('17 sets, 1 trained');

    // Everybody else, as the page says.
    expect(await story(db, THE_OTHER_COACH, dupSession)).toBe('session_not_found');
    expect(await story(db, THE_OTHER_COACH, copyToTheirs)).toBe('week_not_found');
    expect(await story(db, THE_OTHER_COACH, dupWeek)).toBe('week_not_found');
    expect(await story(db, THE_OTHER_COACH, dupProgram)).toBe('program_not_found');
    expect(await story(db, THE_COACH, `select public.duplicate_program('${BLOCK}', '${SECOND}')`)).toBe('student_not_found');
    expect(await story(db, THE_COACH, `select public.copy_sessions(array['${S1}', '${W1}']::uuid[], '${W9}')`)).toBe('session_not_found');
    for (const call of [dupSession, `select public.copy_sessions(array['${S1}']::uuid[], '${W1}')`, dupWeek, `select public.duplicate_program('${BLOCK}')`]) {
      expect(await story(db, THE_ATHLETE, call), call).toBe('not authorized');
    }
    expect(await story(db, NOBODY, dupSession)).toBe('permission denied for function duplicate_session');
    expect(await story(db, NOBODY, copyToTheirs)).toBe('permission denied for function copy_sessions');
    expect(await story(db, NOBODY, dupWeek)).toBe('permission denied for function duplicate_week');
    expect(await story(db, NOBODY, dupProgram)).toBe('permission denied for function duplicate_program');
    for (const said of [
      '| nobody signed in | `permission denied for function duplicate_session` (or `copy_sessions`, `duplicate_week`, `duplicate_program`) |',
      '`session_not_found`, `week_not_found` or `program_not_found`',
      '| a coach, for an athlete of another coach | `student_not_found` |',
      '| the athlete of the block | `not authorized` |',
      '`copy_source_changed`',
    ]) {
      expect(page).toContain(said);
    }

    // The app that is deployed, as the coach: its own requests, as before.
    expect(await story(db, THE_COACH,
      `insert into public.sessions (week_id, title, sort_order) values ('${W1}', 'One (copy)', 2)`,
      `insert into public.exercise_slots (session_id, exercise_id, sets, reps, sort_order)
       select s.id, '${EXERCISE}', 2, 5, 0 from public.sessions s where s.week_id = '${W1}' and s.title = 'One (copy)'`,
      `insert into public.set_logs (exercise_slot_id, set_number, target_reps)
       select es.id, n, 5 from public.exercise_slots es join public.sessions s on s.id = es.session_id, generate_series(1, 2) n
        where s.title = 'One (copy)'`,
      `select count(*) from public.set_logs`)).toBe(5);
    // Nothing above was kept, and the migration itself touches no row.
    expect(await rows(db)).toEqual(AS_IT_WAS);

    await db.runFile(migration.paths.rollback);
    await allMissing();
    expect(await rows(db)).toEqual(AS_IT_WAS);
    await db.drop();
  });

  it('adds 4 functions and signs the ledger — no table, no column, no policy, no trigger, no privilege of what was there', async () => {
    const db = await production();
    const before = await catalogSnapshot(db.query);
    await db.runFile(migration.paths.migration);
    const after = await catalogSnapshot(db.query);

    const lines = diffCatalogs(before, after, { left: 'before', right: 'after' });
    const only = (side) => lines.filter((line) => line.endsWith(`: only in ${side}`))
      .map((line) => line.slice(0, -`: only in ${side}`.length));
    // The names of the arguments are what the API calls them by.
    const KEYS = [
      'public.copy_sessions(p_session_ids uuid[], p_dest_week_id uuid)',
      'public.duplicate_program(p_program_id uuid, p_target_student_id uuid, p_name_suffix text)',
      'public.duplicate_session(p_session_id uuid, p_title_suffix text)',
      'public.duplicate_week(p_week_id uuid, p_dest_program_id uuid, p_label_suffix text)',
    ];
    expect(only('after').sort()).toEqual(KEYS.map((key) => `functions ${key}`));
    expect(only('before')).toEqual([]);
    expect(lines.filter((line) => !/: only in (before|after)$/.test(line)).map((line) => /^(.*?): (\w+): /.exec(line).slice(1, 3).join(' → ')))
      .toEqual(['data rows of app_private.app_migrations → rows']);

    // Each of the four: its owner, the service role and a signed-in user; the
    // rights of whoever calls; the search_path pinned; an object for an answer.
    const header = (key) => after.functions[key].definition.split(/\nAS /)[0];
    for (const key of KEYS) {
      expect(after.functions[key].privileges, key).toEqual(['authenticated: EXECUTE', 'postgres: EXECUTE', 'service_role: EXECUTE']);
      expect(after.functions[key].owner, key).toBe('postgres');
      expect(header(key), key).not.toContain('SECURITY DEFINER');
      expect(header(key), key).toContain('\n RETURNS jsonb\n');
      expect(header(key), key).toContain(`\n SET search_path TO 'public', 'pg_temp'`);
    }
    // What the app may leave out when it calls.
    expect(header(KEYS[0])).not.toContain('DEFAULT');
    expect(header(KEYS[1])).toContain(`p_target_student_id uuid DEFAULT NULL::uuid, p_name_suffix text DEFAULT ' (copy)'::text`);
    expect(header(KEYS[2])).toContain(`p_title_suffix text DEFAULT ' (copy)'::text`);
    expect(header(KEYS[3])).toContain(`p_dest_program_id uuid DEFAULT NULL::uuid, p_label_suffix text DEFAULT ' (copy)'::text`);

    // The ledger, as the page says it reads.
    expect(await db.query.rows(`select name from ${LEDGER} order by name`)).toHaveLength(12);
    expect(await db.query.value(`select name from ${LEDGER} order by name desc limit 1`)).toBe(MIGRATION);
    expect(page).toContain(`Expected: twelve rows, the last one \`${MIGRATION}\`.`);
    expect(page).toContain('| Kind | required · expand: adds 4 functions; no table, no column, no policy, no trigger, no row |');
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
    // Written between back-ticks: a value the page gives exactly. The others
    // are a sentence about what production holds.
    const exact = table.filter((line) => /^`.+`$/.test(line.before) && /^`.+`$/.test(line.after))
      .map((line) => ({ ...line, before: line.before.slice(1, -1), after: line.after.slice(1, -1) }));
    expect(table.filter((line) => !exact.some((e) => e.n === line.n)).map((line) => line.check))
      .toEqual([LINE.emptySessions, LINE.withoutSets]);
    const onPage = (column) => [
      ...exact.map((line) => [line.n, line.check, line[column]]),
      // "Two", which the coach has not written yet; and every exercise has its sets.
      [11, LINE.emptySessions, '1'],
      [12, LINE.withoutSets, '0'],
    ].sort((x, y) => x[0] - y[0]).map(([, check, value]) => [check, value]);

    expect(await printed()).toEqual(onPage('before'));
    await db.runFile(migration.paths.migration);
    expect(await printed()).toEqual(onPage('after'));
    expect(Object.fromEntries(await printed())[LINE.users]).toBe(THE_FOUR);
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
              (select count(*) from public.students) as links, (select count(*) from public.exercise_library) as exercises,
              (select count(*) from public.programs) as programs, (select count(*) from public.weeks) as phases,
              (select count(*) from public.sessions) as sessions, (select count(*) from public.set_logs) as set_logs,
              current_user::text as role, coalesce(current_setting('request.jwt.claims', true), '') as claims`,
    );
    const UNTOUCHED = {
      accounts: 4, profiles: 4, links: 2, exercises: 1, programs: 2, phases: 2, sessions: 3, set_logs: 3, role: 'postgres', claims: '',
    };
    const answer = (said) => `check only, nothing was written: ${said}`;
    const IN_PLACE = answer('in place: a coach duplicates a session, a phase and a block and copies sessions to another athlete '
      + 'in one request each, a copy holds the targets and nothing that was trained, and an athlete does not');

    expect(await checked()).toBe(answer('NOT THERE: the four functions are not in the database'));
    expect(await state()).toEqual(UNTOUCHED);

    await db.runFile(migration.paths.migration);
    expect(await checked()).toBe(IN_PLACE);
    expect(await state()).toEqual(UNTOUCHED);
    // What the page says the command prints.
    expect(page).toContain(`\`${IN_PLACE}\``);
    expect(page).toContain('`… NOT THERE: the four functions are not in the database`');

    // Each function made wrong by hand, one at a time: the answer nobody wants.
    const replace = async (signature, body) => {
      const was = await db.query.value(`select pg_get_functiondef($1::regprocedure)`, [signature]);
      await db.query(body);
      const said = await checked();
      await db.query(was);
      expect(await checked(), `${signature} put back`).toBe(IN_PLACE);
      return said;
    };
    const HEAD = {
      session: `create or replace function public.duplicate_session(p_session_id uuid, p_title_suffix text default ' (copy)')
                returns jsonb language plpgsql set search_path = public, pg_temp as`,
      sessions: `create or replace function public.copy_sessions(p_session_ids uuid[], p_dest_week_id uuid)
                 returns jsonb language plpgsql set search_path = public, pg_temp as`,
      week: `create or replace function public.duplicate_week(p_week_id uuid, p_dest_program_id uuid default null, p_label_suffix text default ' (copy)')
             returns jsonb language plpgsql set search_path = public, pg_temp as`,
      program: `create or replace function public.duplicate_program(p_program_id uuid, p_target_student_id uuid default null, p_name_suffix text default ' (copy)')
                returns jsonb language plpgsql set search_path = public, pg_temp as`,
    };
    const NOTHING = `$$ begin return '{}'::jsonb; end $$`;
    // One that lets everybody through.
    expect(await replace(SIGNATURES[0], `${HEAD.session} ${NOTHING}`))
      .toBe(answer('NOT PROTECTED: an athlete duplicated a session of their block'));
    // One that puts the copy at the end of the phase, as the app does.
    expect(await replace(SIGNATURES[0], `${HEAD.session} $$
      declare v_week uuid;
      begin
        select s.week_id into v_week from public.sessions s join public.weeks w on w.id = s.week_id where s.id = p_session_id for update of w;
        if not found then raise exception 'not authorized' using errcode = 'insufficient_privilege'; end if;
        insert into public.sessions (week_id, title, sort_order)
        select v_week, s.title || p_title_suffix, (select max(o.sort_order) + 1 from public.sessions o where o.week_id = v_week)
          from public.sessions s where s.id = p_session_id;
        return '{}'::jsonb;
      end $$`)).toBe(answer('BROKEN: after duplicate_session the copy is not right after its source'));
    expect(await replace(SIGNATURES[1], `${HEAD.sessions} ${NOTHING}`))
      .toBe(answer('BROKEN: after copy_sessions the copies are not at the end of the phase, in the order of the list'));
    expect(await replace(SIGNATURES[2], `${HEAD.week} ${NOTHING}`))
      .toBe(answer('BROKEN: after duplicate_week the copy is not the last phase of the block'));
    expect(await replace(SIGNATURES[3], `${HEAD.program} ${NOTHING}`))
      .toBe(answer('BROKEN: after duplicate_program the other athlete has no inactive copy of the block'));
    // One that copies the sessions and forgets what is in them — what a lost request of the app leaves.
    expect(await replace(SIGNATURES[1], `${HEAD.sessions} $$
      begin
        insert into public.sessions (week_id, title, sort_order)
        select p_dest_week_id, s.title, t.place from unnest(p_session_ids) with ordinality as t (id, place) join public.sessions s on s.id = t.id;
        return '{}'::jsonb;
      end $$`)).toBe(answer('BROKEN: a copy does not hold the sets of its source'));
    // One that copies the sets as the athlete left them.
    expect(await replace(SIGNATURES[0], `${HEAD.session} $$
      declare v_week uuid; v_place integer; v_new uuid := gen_random_uuid(); v_slot uuid; r record;
      begin
        select s.week_id, s.sort_order + 1 into v_week, v_place
          from public.sessions s join public.weeks w on w.id = s.week_id where s.id = p_session_id for update of w;
        if not found then raise exception 'not authorized' using errcode = 'insufficient_privilege'; end if;
        update public.sessions set sort_order = sort_order + 1000 where week_id = v_week and sort_order >= v_place;
        insert into public.sessions (id, week_id, title, sort_order)
        select v_new, v_week, s.title || p_title_suffix, v_place from public.sessions s where s.id = p_session_id;
        for r in select * from public.exercise_slots where session_id = p_session_id loop
          insert into public.exercise_slots (session_id, exercise_id, sets, reps, sort_order)
          values (v_new, r.exercise_id, r.sets, r.reps, r.sort_order) returning id into v_slot;
          insert into public.set_logs (exercise_slot_id, set_number, target_reps, done, rpe, logged_at)
          select v_slot, sl.set_number, sl.target_reps, sl.done, sl.rpe, sl.logged_at from public.set_logs sl where sl.exercise_slot_id = r.id;
        end loop;
        return '{}'::jsonb;
      end $$`)).toBe(answer('BROKEN: a copy holds what the athlete trained'));
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

  // Lines 11 to 13 of the audit, and the three sections of the page that
  // answer them.
  it('what a lost request and a change of coach leave behind: counted by the audit, and listed with the page\'s statements', async () => {
    const db = await production();
    for (const statement of [listEmptySessions, listWithoutSets, listOtherLibrary]) {
      expect(statement, 'the page no longer gives one of its statements').toBeTruthy();
      // Pasted between double quotes in a shell.
      expect(statement).not.toMatch(/["$`!\\]/);
    }
    expect(await printedAudit(db)).toMatchObject({ [LINE.emptySessions]: '1', [LINE.withoutSets]: '0', [LINE.otherLibrary]: '0' });
    expect(await db.query.rows(listEmptySessions)).toMatchObject([{ athlete: 'Alex', block: 'Block', session: 'Two' }]);
    expect(await db.query.rows(listWithoutSets)).toEqual([]);
    expect(await db.query.rows(listOtherLibrary)).toEqual([]);

    // The coach duplicates "One" with the app that is deployed, and the
    // request that carries its exercise is lost; then "Their block" is copied
    // for Alex, and the request that carries the sets is lost. An archived
    // session with no exercise, a session without a title, and an empty
    // session in a block in the trash, for the list.
    const asCoach = (sql) => db.runSql(
      `BEGIN;
       select set_config('role', 'authenticated', true), set_config('request.jwt.claims', '${JSON.stringify(THE_COACH.claims)}', true);
       ${sql};
       COMMIT;`, 'request',
    );
    await asCoach(`insert into public.sessions (week_id, title, sort_order) values ('${W1}', 'One (copy)', 2)`);
    await asCoach(`insert into public.sessions (week_id, title, sort_order, archived_at) values ('${W1}', 'Archived', 3, now()), ('${W1}', null, 4, null)`);
    await asCoach(`insert into public.programs (id, student_id, name, sort_order, is_active)
                   values ('00000000-0000-4000-8000-000000000303', '${LINK}', 'Their block (copy)', 1, false),
                          ('00000000-0000-4000-8000-000000000304', '${LINK}', 'In the trash', 2, false)`);
    await asCoach(`update public.programs set deleted_at = now() where id = '00000000-0000-4000-8000-000000000304'`);
    await asCoach(`insert into public.weeks (id, program_id, week_number) values
                     ('00000000-0000-4000-8000-000000000403', '00000000-0000-4000-8000-000000000303', 1),
                     ('00000000-0000-4000-8000-000000000404', '00000000-0000-4000-8000-000000000304', 1)`);
    await asCoach(`insert into public.sessions (id, week_id, title, sort_order) values
                     ('00000000-0000-4000-8000-000000000453', '00000000-0000-4000-8000-000000000403', 'Theirs', 0),
                     ('00000000-0000-4000-8000-000000000454', '00000000-0000-4000-8000-000000000404', 'Trashed', 0)`);
    await asCoach(`insert into public.exercise_slots (session_id, exercise_id, sets, reps, sort_order)
                   values ('00000000-0000-4000-8000-000000000453', '${EXERCISE}', 1, 5, 0)`);

    const LEFT_BEHIND = { [LINE.emptySessions]: '3', [LINE.withoutSets]: '1', [LINE.otherLibrary]: '0' };
    expect(await printedAudit(db)).toMatchObject(LEFT_BEHIND);
    expect((await db.query.rows(listEmptySessions)).map((line) => `${line.athlete} / ${line.block} / ${line.session}`))
      .toEqual(['Alex / Block / Two', 'Alex / Block / One (copy)', 'Alex / Block / (no title)']);
    expect(await db.query.rows(listWithoutSets)).toEqual([{ athlete: 'Alex', block: 'Their block (copy)', sessions: 1, exercises: 1 }]);
    expect(page).toContain('a title that ends in *(copy)* is a copy that did not finish');

    // None of it stops the migration, and the migration changes none of it.
    await db.runFile(migration.paths.migration);
    expect(await printedAudit(db)).toMatchObject(LEFT_BEHIND);

    // What the page says of line 12: the athlete's app adds the missing sets
    // when the session is opened (useEnsureSetLogs) — every set alike.
    expect(read('src/hooks/useSetLogs.js')).toContain('export function useEnsureSetLogs()');
    expect(page).toContain('the athlete\'s app adds the missing sets when the session is opened');
    // A copy made by the function adds nothing to either line.
    await asCoach(`select public.duplicate_program('${BLOCK}')`);
    await asCoach(`select public.duplicate_session('${S1}')`);
    // "Two" and its two copies hold nothing — and neither did their source.
    expect(await printedAudit(db)).toMatchObject({ [LINE.emptySessions]: '6', [LINE.withoutSets]: '1' });
    expect(await db.query.value(
      `select count(*) from public.sessions s where s.title like 'One%' and s.title <> 'One (copy)'
          and not exists (select 1 from public.set_logs sl join public.exercise_slots es on es.id = sl.exercise_slot_id where es.session_id = s.id)`,
    )).toBe(0);

    // Billie changes coach. Her block still names an exercise of Carla.
    await db.query(`select public.transfer_student('${SECOND}', '${OLGA}')`);
    expect(await printedAudit(db)).toMatchObject({ [LINE.otherLibrary]: '1' });
    expect(await db.query.rows(listOtherLibrary)).toEqual([{ athlete: 'Billie', coach: 'Coach Olga', library_of: 'Coach Carla', exercises: 1 }]);
    // Olga duplicates it: the session, without the exercise, and the answer says so.
    expect(await story(db, THE_OTHER_COACH, `select public.duplicate_program('${THEIRS}')`))
      .toMatchObject({ name: 'Their block (copy)', sessions: 1, slots: 0, set_logs: 0, slots_left_out: 1 });
    // With the app that is deployed she gets the session, and a refusal for its exercise.
    expect(await story(db, THE_OTHER_COACH,
      `insert into public.sessions (id, week_id, title, sort_order) values ('00000000-0000-4000-8000-000000000455', '${W9}', 'Theirs (copy)', 1)`,
      `insert into public.exercise_slots (session_id, exercise_id, sets, reps, sort_order)
       values ('00000000-0000-4000-8000-000000000455', '${EXERCISE}', 1, 5, 0)`))
      .toBe(`exercise ${EXERCISE} is not in the library of the coach of this program`);
    expect(page).toContain('and answer how many were left out, so that the app can say so');
    await db.drop();
  });

  it('without migration 11 it says so (SLM02), and its rollback says there is nothing to undo (SLM03)', async () => {
    const db = await scratchDatabase();
    await db.runFile(manifest.baseline);
    const refusals = async () => {
      const before = await catalogSnapshot(db.query);
      const refused = await attempt(() => db.runFile(migration.paths.migration));
      const undone = await attempt(() => db.runFile(migration.paths.rollback));
      expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
      return [refused.error?.code, refused.error?.message, undone.error?.code];
    };
    // Without a ledger at all, then with the ledger and the migrations before 11 only.
    const needs = 'needs 2026_10_13_11_activate_reorder_rpcs, which is not applied';
    let [code, message, undone] = await refusals();
    expect([code, undone]).toEqual([REFUSAL.predecessorMissing, REFUSAL.notApplied]);
    expect(message).toContain(needs);
    for (const earlier of manifest.migrations.slice(0, 10)) await db.runFile(earlier.paths.migration);
    expect(await db.query.value(`select name from ${LEDGER} order by name desc limit 1`)).toBe('2026_10_13_10_goals_fk_coach_links');
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
  it('refuses to run when a function of one of the four names is there already, and changes nothing', async () => {
    const db = await production();
    const refusalOf = async () => {
      const before = await catalogSnapshot(db.query);
      const refused = await attempt(() => db.runFile(migration.paths.migration));
      await untouched(db, before);
      return refused.error?.message ?? 'it ran';
    };

    // With other arguments — the ones the plan first gave it: it would stay next to the new one.
    await db.query(`create function public.duplicate_week(p_week_id uuid) returns uuid language sql as 'select null::uuid'`);
    expect(await refusalOf()).toContain(`migration ${MIGRATION} would not create: duplicate_week(uuid) is already there`);
    expect(await printedAudit(db)).toMatchObject({ [LINE.strangers]: 'duplicate_week(uuid)', [LINE.week]: 'no' });
    expect(page).toContain('- **6** is not `none` — **stop and report the line.**');
    await db.query(`drop function public.duplicate_week(uuid)`);

    // With the same arguments: the audit reads `yes`, and the ledger does not know why.
    await db.query(`create function public.copy_sessions(p_session_ids uuid[], p_dest_week_id uuid) returns jsonb language sql as 'select null::jsonb'`);
    expect(await refusalOf()).toContain(`migration ${MIGRATION} would not create: copy_sessions(uuid[],uuid) is already there`);
    expect(await printedAudit(db)).toMatchObject({ [LINE.strangers]: 'none', [LINE.sessions]: 'yes', [LINE.program]: 'no' });
    expect(page).toContain('If it is not, a function of that name was made by hand: stop and report.');
    expect(page).toContain('| `would not create: … is already there` |');
    await db.query(`drop function public.copy_sessions(uuid[], uuid)`);

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
    await db.query(`alter table public.exercise_slots rename column record_video_set_numbers to film`);
    await db.query(`alter table public.weeks rename column label to name`);
    const before = await catalogSnapshot(db.query);
    const refused = await attempt(() => db.runFile(migration.paths.migration));
    expect(refused.error?.message).toContain(
      `migration ${MIGRATION} does not find the columns its functions are written with: `
      + 'public.exercise_slots.record_video_set_numbers, public.weeks.label',
    );
    await untouched(db, before);
    expect(page).toContain('| `does not find the columns its functions are written with: …` |');

    await db.query(`alter table public.exercise_slots rename column film to record_video_set_numbers`);
    await db.query(`alter table public.weeks rename column name to label`);
    await db.runFile(migration.paths.migration);
    await db.drop();
  });

  // Every column the functions name is one the guard asks for — a column that
  // a later migration makes them copy joins the list of ITS guard.
  it('its guard asks for every column the four functions are written with', async () => {
    const text = read(migration.paths.migration);
    const asked = new Set([...text.matchAll(/\('public\.(\w+)',\s+'(\w+)'\)/g)].map(([, table, column]) => `${table}.${column}`));
    const named = Object.entries(WHAT_A_COPY_IS).flatMap(([table, { copied }]) => copied.map((column) => `${table}.${column}`));
    expect(named.filter((column) => !asked.has(column))).toEqual([]);
    for (const column of ['students.coach_id', 'exercise_library.coach_id', 'programs.student_id', 'programs.deleted_at',
      'programs.is_active', 'programs.status', 'set_logs.is_student_added', 'set_logs.exercise_slot_id']) {
      expect(asked.has(column), column).toBe(true);
    }
  });

  // The privileges stand next to each function: what a new function is born
  // with is not this file's to rely on.
  it('applied where a new function is born open to everybody, the four are still closed to a request without a session', async () => {
    const db = await production();
    // Supabase's own defaults, as they were before migration 03.
    await db.query(`alter default privileges for role postgres grant execute on functions to public`);
    await db.query(`alter default privileges for role postgres in schema public grant execute on functions to anon, authenticated`);
    await db.runFile(migration.paths.migration);
    expect(await printedAudit(db)).toMatchObject({ [LINE.anon]: 'none', [LINE.users]: THE_FOUR });
    expect(await story(db, NOBODY, dupProgram)).toBe('permission denied for function duplicate_program');
    await db.runFile(migration.paths.rollback);

    // … and a file that forgot one of them reads its own result back, and undoes itself.
    const text = read(migration.paths.migration);
    const forgot = text.replace('REVOKE ALL ON FUNCTION public.duplicate_week(uuid, uuid, text) FROM PUBLIC, anon, authenticated;\n', '');
    expect(forgot).not.toBe(text);
    const before = await catalogSnapshot(db.query);
    const refused = await attempt(() => db.runSql(forgot, 'migration'));
    expect(refused.error?.message).toContain(
      `migration ${MIGRATION} did not get the functions it meant: public.duplicate_week(uuid, uuid, text): anon may execute it, PUBLIC may execute it`,
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
    expect(await story(db, THE_COACH, dupSession, titles(W1))).toBe('One, One (copy), Two');
    await db.drop();
  });

  // What the rollback page says of what happened while the migration was in place.
  it('rolled back: what was copied stays where it is, with its exercises and its sets', async () => {
    const db = await production();
    await db.runFile(migration.paths.migration);
    const asCoach = (sql) => db.runSql(
      `BEGIN;
       select set_config('role', 'authenticated', true), set_config('request.jwt.claims', '${JSON.stringify(THE_COACH.claims)}', true);
       ${sql};
       COMMIT;`, 'request',
    );
    await asCoach(dupSession);
    await asCoach(copyToTheirs);
    await asCoach(dupWeek);
    await asCoach(dupProgram);
    // 3 sets, then: +2 (One), +2 (One, to Billie), +4 (the phase), +8 (the block of two phases).
    const COPIED = { programs: 3, weeks: 5, sessions: 15, slots: 10, set_logs: 19 };
    expect(await rows(db)).toEqual(COPIED);

    await db.runFile(migration.paths.rollback);
    expect(await rows(db)).toEqual(COPIED);
    expect(await db.query.value(titles(W1))).toBe('One, One (copy), Two');
    expect(await printedAudit(db)).toMatchObject({
      [LINE.session]: 'no', [LINE.sessions]: 'no', [LINE.week]: 'no', [LINE.program]: 'no', [LINE.users]: 'none',
    });
    expect(page).toContain('the sessions, phases and blocks they copied stay where they are, with their exercises and their sets');

    // A function of one of the names made AFTERWARDS, with other arguments, is not the rollback's to drop.
    await db.runFile(migration.paths.migration);
    await db.query(`create function public.duplicate_program(p_program_id uuid) returns uuid language sql as 'select null::uuid'`);
    await db.runFile(migration.paths.rollback);
    expect(await db.query.value(`select to_regprocedure('public.duplicate_program(uuid)') is not null`)).toBe(true);
    await db.query(`drop function public.duplicate_program(uuid)`);
    // …and the migration applies again on what the rollback left.
    await db.runFile(migration.paths.migration);
    expect(await story(db, THE_COACH, dupWeek, phases)).toBe('Base, Base (copy), Base (copy)');
    await db.drop();
  });
});
