// The RLS matrix: who can read, insert, update and delete what — every table
// the app has, as six callers, written down as one text file
// (snapshots/rls-matrix.txt) that the test compares against.
//
// It is a tripwire, not a specification. A migration that rewrites policies or
// grants and means to change nothing must leave the file untouched; one that
// means to change a cell shows exactly that cell in its commit. Update the
// file on purpose with
//
//   npx vitest run --config vitest.db.config.js supabase/tests/rls-matrix.test.js -u
//
// and read the diff before committing it: every changed cell is a change in
// what someone can do in production.
//
// The specifications — "anon cannot call adopt_skip", "athlete A cannot log in
// B's program" — are the other test files. This one catches what nobody
// thought of writing a test for.
//
// How a cell is measured (the same for every caller):
//   select   count(*) through the caller's eyes
//   insert   one plausible new row in athlete A's data (for the library, the
//            coach's), sometimes a second one in A's own draft
//   update   every existing row: `set id = id`. A no-op, so it measures who
//            may write the row, not what a trigger then pins.
//   delete   every existing row
// Every attempt is rolled back before the next.

import { beforeAll, describe, expect, it } from 'vitest';
import {
  asAdmin, asAnon, asService, asUser, attempt, createDraftProgram, createProgram, createUser,
  scenario, seed,
} from './harness.js';

// ------------------------------------------------------------
// The world. seed() gives one coach with athletes A and B; a second coach with
// athlete C is added so that "the coach sees everything" and "the coach sees
// their own athletes" are different numbers. Athlete A has one program in each
// state a policy looks at.
// ------------------------------------------------------------
let w;

async function buildWorld() {
  const ids = await seed();
  const { coach, studentA: A, studentB: B, exercises } = ids;

  const otherCoach = await createUser({ email: 'olga@sl.test', fullName: 'Coach Olga', role: 'coach' });
  const C = await createUser({ email: 'casey@sl.test', fullName: 'Casey Athlete', coach: otherCoach });
  // In no coach's roster, and an account whose profile is missing.
  const unlinked = await createUser({ email: 'una@sl.test', fullName: 'Una Unlinked' });
  const orphan = await createUser({ email: 'orphan@sl.test', fullName: 'No Profile' });

  const row = (q, sql, params) => q.value(`${sql} returning id`, params);

  const otherLibrary = await asAdmin((q) => row(q,
    `insert into exercise_library (coach_id, name, type, difficulty) values ($1, 'Row', 'pull', 1)`,
    [otherCoach.id]), { commit: true });

  const blockA = ids.programA;               // active: 2 weeks × 2 sessions × 2 slots × 3 sets
  const blockB = ids.programB;               // active: 1 × 1 × 2 × 3
  const pastA = await createProgram({ student: A, name: 'Past block' });
  const trashedA = await createProgram({ student: A, name: 'Trashed block' });
  const draftA = await createDraftProgram(A);
  const blockC = await createProgram({
    student: C, name: 'Block C', exercises: [otherLibrary], sets: 2, active: true,
  });

  const made = await asAdmin(async (q) => {
    await q(`delete from profiles where id = $1`, [orphan.id]);
    await q(`update programs set deleted_at = now() where id = $1`, [trashedA.id]);

    // Athlete A, session 1 of the active block: trained, confirmed, reviewed.
    await q(
      `update set_logs set done = true, rpe = 8, logged_at = now() where id = any($1)`,
      [blockA.tree[0].sessions[0].slots[0].setLogs],
    );
    await q(`update set_logs set done = true, logged_at = now() where id = $1`, [pastA.setLogs[0]]);
    const extraSet = await row(q,
      `insert into set_logs (exercise_slot_id, set_number, is_student_added) values ($1, 4, true)`,
      [blockA.slots[0]]);
    // Session 2 is archived by the coach; sessions 3 and 4 are still to come.
    await q(`update sessions set archived_at = now() where id = $1`, [blockA.sessions[1]]);

    const perAthlete = async (athlete, program, theirCoach, exerciseId) => {
      const [slot, otherSlot] = program.slots;
      await row(q, `insert into session_confirmations (session_id, student_id, performed_on) values ($1, $2, current_date)`,
        [program.sessions[0], athlete.id]);
      await row(q, `insert into slot_comments (exercise_slot_id, student_id, body) values ($1, $2, 'Felt heavy')`,
        [slot, athlete.id]);
      await row(q, `insert into slot_deviations (exercise_slot_id, student_id, kind) values ($1, $2, 'skip')`,
        [otherSlot ?? slot, athlete.id]);
      await row(q, `insert into set_log_videos (set_log_id, storage_path, mime_type, size_bytes) values ($1, $2, 'video/mp4', 1000)`,
        [program.setLogs[0], `${athlete.id}/${slot}/1-clip.mp4`]);
      await q(`insert into storage.objects (bucket_id, name) values ('set-videos', $1)`,
        [`${athlete.id}/${slot}/1-clip.mp4`]);
      const goal = await row(q,
        `insert into goals (student_id, coach_id, exercise_id, kind, target_weight_kg) values ($1, $2, $3, 'one_rm', 100)`,
        [athlete.id, theirCoach.id, exerciseId]);
      await row(q, `insert into goal_progress (goal_id, weight_kg) values ($1, 80)`, [goal]);
      await row(q, `insert into bodyweight_logs (student_id, weight_kg) values ($1, 75)`, [athlete.id]);
      await row(q, `insert into push_subscriptions (user_id, endpoint, p256dh, auth) values ($1, $2, 'key', 'auth')`,
        [athlete.id, `https://fcm.googleapis.com/fcm/send/${athlete.id}`]);
      await row(q, `insert into scheduled_pushes (user_id, fire_at) values ($1, now() + interval '2 minutes')`,
        [athlete.id]);
      await row(q, `insert into client_errors (user_id, role, message) values ($1, 'student', 'boom')`, [athlete.id]);
      // Feedback on the confirmed session: stamps reviewed_at, notifies the athlete.
      await row(q, `insert into messages (sender_id, recipient_id, body, session_id) values ($1, $2, 'Good session.', $3)`,
        [theirCoach.id, athlete.id, program.sessions[0]]);
      return goal;
    };

    const goalA = await perAthlete(A, blockA, coach, exercises.pullUp);
    await perAthlete(B, blockB, coach, exercises.dip);
    await perAthlete(C, blockC, otherCoach, otherLibrary);
    await row(q, `insert into client_errors (user_id, role, message) values ($1, 'coach', 'boom')`, [coach.id]);
    await row(q, `insert into push_subscriptions (user_id, endpoint, p256dh, auth) values ($1, $2, 'key', 'auth')`,
      [coach.id, `https://fcm.googleapis.com/fcm/send/${coach.id}`]);

    return { goalA, extraSet };
  }, { commit: true });

  return {
    coach, A, B, C, otherCoach, unlinked, orphan, exercises, blockA, pastA, trashedA, draftA, ...made,
    // Where the insert probes land: session 3 of the active block — not
    // archived, not confirmed, not reviewed.
    openSession: blockA.sessions[2],
    openSlot: blockA.tree[1].sessions[0].slots[0],
  };
}

// ------------------------------------------------------------
// Callers and tables
// ------------------------------------------------------------
const callers = () => [
  ['anon', asAnon],
  ['athlete A', (fn) => asUser(w.A, fn)],
  ['athlete B', (fn) => asUser(w.B, fn)],
  ['coach', (fn) => asUser(w.coach, fn)],
  ['other coach', (fn) => asUser(w.otherCoach, fn)],
  ['service', asService],
];

// storage.objects is not ours, but four of its policies are.
const EXTRA_TABLES = ['storage.objects'];

// One plausible new row per table, in athlete A's data. A table without an
// entry fails the test: a new table gets its probe with the migration that
// creates it. `setup` runs as postgres first, in the same rolled-back
// transaction.
const insertProbes = () => ({
  profiles: [{
    sql: `insert into profiles (id, role, full_name) values ($1, 'student', 'Probe')`,
    params: [w.orphan.id],
  }],
  students: [{
    sql: `insert into students (profile_id, coach_id) values ($1, $2)`,
    params: [w.unlinked.id, w.coach.id],
  }],
  programs: [{
    sql: `insert into programs (student_id, name) values ($1, 'Probe')`,
    params: [w.A.studentRowId],
  }, {
    label: 'own draft',
    // One draft in flight per athlete: make room for the probe.
    setup: (q) => q(`delete from programs where id = $1`, [w.draftA.id]),
    sql: `insert into programs (student_id, name, status, created_by) values ($1, 'Probe', 'draft', $2)`,
    params: [w.A.studentRowId, w.A.id],
  }],
  weeks: [{
    sql: `insert into weeks (program_id, week_number) values ($1, 99)`,
    params: [w.blockA.id],
  }, {
    label: 'own draft',
    sql: `insert into weeks (program_id, week_number) values ($1, 99)`,
    params: [w.draftA.id],
  }],
  sessions: [{
    sql: `insert into sessions (week_id, title, sort_order) values ($1, 'Probe', 99)`,
    params: [w.blockA.weeks[0]],
  }, {
    label: 'own draft',
    sql: `insert into sessions (week_id, title, sort_order) values ($1, 'Probe', 99)`,
    params: [w.draftA.weeks[0]],
  }],
  exercise_library: [{
    sql: `insert into exercise_library (coach_id, name, type, difficulty) values ($1, 'Probe', 'pull', 1)`,
    params: [w.coach.id],
  }],
  exercise_slots: [{
    sql: `insert into exercise_slots (session_id, exercise_id, sets, reps, sort_order) values ($1, $2, 3, 5, 99)`,
    params: [w.openSession, w.exercises.squat],
  }, {
    label: 'own draft',
    sql: `insert into exercise_slots (session_id, exercise_id, sets, reps, sort_order) values ($1, $2, 3, 5, 99)`,
    params: [w.draftA.sessions[0], w.exercises.squat],
  }],
  set_logs: [{
    sql: `insert into set_logs (exercise_slot_id, set_number, is_student_added) values ($1, 99, true)`,
    params: [w.openSlot.id],
  }],
  session_confirmations: [{
    sql: `insert into session_confirmations (session_id, student_id) values ($1, $2)`,
    params: [w.openSession, w.A.id],
  }],
  goals: [{
    sql: `insert into goals (student_id, coach_id, exercise_id, kind, target_weight_kg) values ($1, $2, $3, 'one_rm', 60)`,
    params: [w.A.id, w.coach.id, w.exercises.squat],
  }],
  goal_progress: [{
    sql: `insert into goal_progress (goal_id, weight_kg) values ($1, 85)`,
    params: [w.goalA],
  }],
  slot_comments: [{
    sql: `insert into slot_comments (exercise_slot_id, student_id, body) values ($1, $2, 'Probe')`,
    params: [w.openSlot.id, w.A.id],
  }],
  slot_deviations: [{
    sql: `insert into slot_deviations (exercise_slot_id, student_id, kind) values ($1, $2, 'skip')`,
    params: [w.openSlot.id, w.A.id],
  }],
  set_log_videos: [{
    sql: `insert into set_log_videos (set_log_id, storage_path, mime_type, size_bytes) values ($1, $2, 'video/mp4', 1000)`,
    params: [w.openSlot.setLogs[0], `${w.A.id}/${w.openSlot.id}/1-probe.mp4`],
  }],
  messages: [{
    label: 'from athlete A',
    sql: `insert into messages (sender_id, recipient_id, body) values ($1, $2, 'Probe')`,
    params: [w.A.id, w.coach.id],
  }, {
    label: 'to athlete A',
    sql: `insert into messages (sender_id, recipient_id, body) values ($1, $2, 'Probe')`,
    params: [w.coach.id, w.A.id],
  }],
  notifications: [{
    sql: `insert into notifications (recipient_id, kind) values ($1, 'probe')`,
    params: [w.A.id],
  }],
  push_subscriptions: [{
    sql: `insert into push_subscriptions (user_id, endpoint, p256dh, auth) values ($1, 'https://fcm.googleapis.com/fcm/send/probe', 'key', 'auth')`,
    params: [w.A.id],
  }],
  scheduled_pushes: [{
    sql: `insert into scheduled_pushes (user_id, fire_at) values ($1, now() + interval '1 minute')`,
    params: [w.A.id],
  }],
  client_errors: [{
    sql: `insert into client_errors (user_id, message) values ($1, 'Probe')`,
    params: [w.A.id],
  }],
  bodyweight_logs: [{
    sql: `insert into bodyweight_logs (student_id, weight_kg, logged_on) values ($1, 80, '2020-01-01')`,
    params: [w.A.id],
  }],
  'storage.objects': [{
    sql: `insert into storage.objects (bucket_id, name) values ('set-videos', $1)`,
    params: [`${w.A.id}/${w.openSlot.id}/1-probe.mp4`],
  }],
});

// ------------------------------------------------------------
// Measuring
// ------------------------------------------------------------
// Why a statement was refused, in a word: `denied` = no privilege on the table
// (a GRANT), `rls` = a policy's WITH CHECK, otherwise the SQLSTATE (P0001 is a
// RAISE in a trigger, 23xxx a constraint).
function refusal(error) {
  if (error.code === '42501') return /row-level security/.test(error.message) ? 'rls' : 'denied';
  return error.code ?? 'error';
}

async function countVisible(as, table) {
  const read = await attempt(() => as((q) => q.value(`select count(*) from ${table}`)));
  return read.ok ? String(read.value) : refusal(read.error);
}

async function tryInsert(as, { setup, sql, params }) {
  const tried = await attempt(() => scenario(async (q) => {
    if (setup) await setup(q);
    return as((caller) => caller(sql, params));
  }));
  return tried.ok ? 'yes' : refusal(tried.error);
}

// "12" = twelve rows written; "12 +3 P0001" = and three refused that way;
// "denied" when the caller holds no privilege on the table at all.
//
// The whole table in one statement first. When that goes through, its row
// count is the answer. When one row makes it fail (a WITH CHECK, a trigger, a
// foreign key), the rows are tried one at a time to find out how many.
async function tryRows(as, { all, one }, ids) {
  return as(async (q) => {
    const whole = await attempt(() => q.dryRun(all));
    if (whole.ok) return String(whole.value.rowCount);
    if (refusal(whole.error) === 'denied') return 'denied';

    const tally = new Map();
    let written = 0;
    for (const id of ids) {
      const tried = await attempt(() => q.dryRun(one, [id]));
      if (tried.ok) written += tried.value.rowCount;
      else tally.set(refusal(tried.error), (tally.get(refusal(tried.error)) ?? 0) + 1);
    }
    return [String(written), ...[...tally].sort().map(([why, n]) => `+${n} ${why}`)].join(' ');
  });
}

function render(rows) {
  const header = ['table', 'rows', 'action', ...callers().map(([name]) => name)];
  const all = [header, ...rows];
  const widths = header.map((_, column) => Math.max(...all.map((line) => line[column].length)));
  const line = (cells) => cells.map((cell, column) => cell.padEnd(widths[column])).join('  ').trimEnd();
  const out = [line(header), widths.map((width) => '-'.repeat(width)).join('  ')];
  let previous = null;
  for (const cells of rows) {
    if (previous !== null && cells[0] !== previous) out.push('');
    out.push(line(cells[0] === previous ? ['', '', ...cells.slice(2)] : cells));
    [previous] = cells;
  }
  return out.join('\n');
}

const LEGEND = `What each caller can do to each table — measured, not declared.
Regenerate on purpose: npx vitest run --config vitest.db.config.js supabase/tests/rls-matrix.test.js -u

Callers
  anon         the public anon key, no session
  athlete A    signed in; coached by "coach". Programs: an active block (session 1 trained,
               confirmed and reviewed; session 2 archived; 3 and 4 to come), a past block,
               a trashed block, and a draft A is writing
  athlete B    signed in; same coach, one active block
  coach        signed in; coach of A and B
  other coach  signed in; coach of athlete C only (C has one active block)
  service      the service-role key (Edge Functions): no RLS

Cells
  rows         how many rows the table holds in this world
  select       how many of them the caller sees
  insert       a new row in athlete A's data (in the coach's, for the library);
               "own draft" = in the draft A is writing
  update       how many rows the caller can write
  delete       how many rows the caller can delete
  yes          the insert went through
  rls          refused by a row-level-security policy
  denied       refused for want of a privilege on the table
  +2 P0001     and 2 rows were refused with that SQLSTATE (P0001: a trigger said no;
               23503: a foreign key)
`;

// ------------------------------------------------------------
describe('RLS matrix', () => {
  let tables;
  let before;

  const rowCounts = () => asAdmin(async (q) => {
    const out = {};
    for (const table of tables) out[table] = await q.value(`select count(*) from ${table}`);
    return out;
  });

  beforeAll(async () => {
    w = await buildWorld();
    tables = await asAdmin(async (q) => [
      ...(await q.rows(
        `select c.relname as name from pg_class c
          where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
          order by 1`,
      )).map((t) => t.name),
      ...EXTRA_TABLES,
    ]);
    before = await rowCounts();
  });

  it('has an insert probe for every table, and an id on every table', async () => {
    const probes = insertProbes();
    expect(tables.filter((table) => !probes[table]?.length), 'tables without an insert probe').toEqual([]);
    expect(Object.keys(probes).filter((table) => !tables.includes(table)), 'probes for tables that are gone').toEqual([]);

    const withoutId = await asAdmin(async (q) => {
      const out = [];
      for (const table of tables) {
        const has = await q.value(
          `select count(*) from pg_attribute where attrelid = $1::regclass and attname = 'id' and not attisdropped`,
          [table],
        );
        if (!has) out.push(table);
      }
      return out;
    });
    expect(withoutId, 'the update and delete cells address a row by its id').toEqual([]);
  });

  it('measures a world where every table holds rows', () => {
    const empty = Object.entries(before).filter(([, count]) => count === 0).map(([table]) => table);
    expect(empty, 'a table with no row says nothing about who can read it').toEqual([]);
  });

  it('is the matrix on file', async () => {
    const probes = insertProbes();
    const rows = [];

    for (const table of tables) {
      const ids = await asAdmin(async (q) => (await q.rows(`select id from ${table} order by id`)).map((r) => r.id));
      const total = String(ids.length);
      const cells = async (measure) => {
        const out = [];
        for (const [, as] of callers()) out.push(await measure(as));
        return out;
      };

      rows.push([table, total, 'select', ...await cells((as) => countVisible(as, table))]);
      for (const probe of probes[table] ?? []) {
        const action = probe.label ? `insert (${probe.label})` : 'insert';
        rows.push([table, total, action, ...await cells((as) => tryInsert(as, probe))]);
      }
      const update = { all: `update ${table} set id = id`, one: `update ${table} set id = id where id = $1` };
      const remove = { all: `delete from ${table}`, one: `delete from ${table} where id = $1` };
      rows.push([table, total, 'update', ...await cells((as) => tryRows(as, update, ids))]);
      rows.push([table, total, 'delete', ...await cells((as) => tryRows(as, remove, ids))]);
    }

    await expect(`${LEGEND}\n${render(rows)}\n`).toMatchFileSnapshot('./snapshots/rls-matrix.txt');
  });

  it('measuring left the world as it was', async () => {
    // Every attempt is rolled back; if one were not, the next run would differ.
    expect(await rowCounts()).toEqual(before);
  });
});
