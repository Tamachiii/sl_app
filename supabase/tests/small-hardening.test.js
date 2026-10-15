// Four small migrations of wave 3, one block each:
//
//   21  2026_10_16_21_rpe_half_steps_day_check      L34, B12
//       set_logs.rpe is numeric(3,1), from 1 to 10 in steps of 0.5;
//       sessions.day_number is NULL or 1..7 — the values that were not, and
//       every weekday of a block an athlete wrote, are cleared first;
//       save_draft_tree writes a number outside 1..7 as no weekday.
//
// Each block runs first against schema.sql, as the callers the app has —
// their requests written out as the app that is deployed sends them — then
// applies the migration file itself to the frozen production baseline, with
// the statements of its runbook page read off the page.

import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  asAdmin, asUser, attempt, repoRoot, scenario, scratchDatabase, seed,
} from './harness.js';
import { catalogSnapshot, diffCatalogs } from './catalog.js';
import { LEDGER, loadManifest, migrationsBefore, REFUSAL } from '../migrations/manifest.js';

const manifest = loadManifest();
const entry = (name) => manifest.migrations.find((m) => m.name === name);
const read = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8');

let ids;
beforeAll(async () => {
  ids = await seed();
});

/** `[message, SQLSTATE]` of what `fn` raised — or `'it went through'`. */
const refusal = async (fn) => {
  const tried = await attempt(fn);
  return tried.ok ? 'it went through' : [tried.error.message, tried.error.code];
};

/**
 * A PATCH of PostgREST, as the app sends one with `.update(body).eq('id', …)`:
 * the JSON body is read into a row of the table, whose column types decide
 * what a value may be — a JSON number 7.5 for an integer column is 22P02.
 */
const patch = (table, body) => `update public.${table} t set ${Object.keys(body).map((key) => `${key} = b.${key}`).join(', ')}
  from json_populate_record(null::public.${table}, '${JSON.stringify(body)}') b
  where t.id = $1`;

// ------------------------------------------------------------
// The files on the frozen baseline: shared by the four blocks.
// ------------------------------------------------------------
/** The frozen baseline, `world` written into it, and the migrations before `name` applied. */
const productionBefore = async (name, world) => {
  const db = await scratchDatabase();
  await db.runFile(manifest.baseline);
  await db.runSql(world, 'world');
  for (const earlier of migrationsBefore(manifest.migrations, name)) await db.runFile(earlier.paths.migration);
  return db;
};

// One transaction, always undone (replay-grace.test.js): each step is a
// statement or an actor; the answer is the first value of the last
// statement, or the message of the statement that raised.
const user = (sub) => ({ role: 'authenticated', claims: JSON.stringify({ role: 'authenticated', sub }) });
const actor = ({ role, claims }) => `select set_config('role', '${role}', true), set_config('request.jwt.claims', '${claims}', true)`;
const statements = (steps) => steps.map((step) => (typeof step === 'string' ? step : actor(step))).join(';\n');
const story = async (db, ...steps) => {
  const tried = await attempt(() => db.runSql(`BEGIN;\n${statements(steps)};\nROLLBACK;`, 'request'));
  if (!tried.ok) return (tried.error.cause ?? tried.error).message;
  const [found] = tried.value.at(-2).rows;
  return found ? Object.values(found)[0] : null;
};

/** The fenced blocks of a page in a language, without the indent of a list. */
const fencesOf = (page, lang) => [...page.matchAll(new RegExp(`^( *)\`\`\`${lang}\\n([\\s\\S]*?)\\n\\1\`\`\`$`, 'gm'))]
  .map(([, indent, body]) => body.split('\n').map((line) => line.slice(indent.length)).join('\n'));
/** The page's `do $check$` block, pasted between single quotes. */
const checkOf = (page) => fencesOf(page, 'bash')
  .map((command) => /^supabase db query --linked '(do \$check\$[\s\S]+\$check\$)'$/.exec(command)?.[1])
  .find(Boolean);
/** A statement the page quotes between double quotes, by its first words. */
const quotedOf = (page, start) => fencesOf(page, 'bash')
  .map((command) => /^supabase db query --linked "(.+)"$/.exec(command)?.[1])
  .find((sql) => sql?.startsWith(start));
/** The table of the audit on the page: `{ n, check, before, after }`, back-ticks kept. */
const auditTableOf = (page) => page.split('\n')
  .map((line) => /^\| (\d+) \| (.+?) \| (.+?) \| (.+?) \|$/.exec(line))
  .filter(Boolean)
  .map(([, n, check, before, after]) => ({ n: Number(n), check, before, after }));
const literal = (cell) => (/^`[^`]+`$/.test(cell) ? cell.slice(1, -1) : null);

const printedAudit = async (db, migration) => {
  const [result] = await db.readOnly(read(migration.paths.audit), 'audit');
  return result.rows.map((line) => [line.check, line.value]);
};

/** The page's check: it always fails, and its message is the answer. */
const runCheck = async (db, check) => {
  const tried = await attempt(() => db.runSql(check, 'page check'));
  expect(tried.ok, 'the check must always fail: that is what undoes it').toBe(false);
  return (tried.error.cause ?? tried.error).message;
};

const untouched = async (db, migration, before) => {
  expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
  expect(await db.query.value(`select count(*) from ${LEDGER} where name = $1`, [migration.name])).toBe(0);
};
/** What the file says when it refuses — the catalog and the ledger as they were. */
const refusalOf = async (db, migration, run = () => db.runFile(migration.paths.migration)) => {
  const before = await catalogSnapshot(db.query);
  const refused = await attempt(run);
  await untouched(db, migration, before);
  return refused.error?.message ?? 'it ran';
};

/** The lines of a catalog diff: `[only before, only after, changed as 'key → what']`. */
const changesOf = (before, after) => {
  const lines = diffCatalogs(before, after, { left: 'before', right: 'after' });
  const only = (side) => lines.filter((line) => line.endsWith(`: only in ${side}`))
    .map((line) => line.slice(0, -`: only in ${side}`.length)).sort();
  const changed = lines.filter((line) => !/: only in (before|after)$/.test(line))
    .map((line) => /^(.*?): (\w+): /.exec(line).slice(1, 3).join(' → ')).sort();
  return { before: only('before'), after: only('after'), changed };
};

const TO_COME = '2099_01_01_99_a_migration_to_come';

// ============================================================
// 21 — L34: an RPE in half steps
// ============================================================
describe('L34 — an RPE is rated in half steps, from 1 to 10', () => {
  const rate = (setLog, body) => asUser(ids.studentA, (athlete) => athlete.value(`${patch('set_logs', body)} returning t.rpe`, [setLog]));
  const ticked = { done: true, logged_at: '2026-10-16T09:00:00Z' };

  it('6, 7.5 and 10 are saved; 7.3, 0.5 and 10.5 are refused by a rule; a failed set still takes none', () => scenario(async () => {
    const [set] = ids.programA.setLogs;
    for (const rpe of [6, 7.5, 10, 1, 9.5]) expect(await rate(set, { ...ticked, rpe }), String(rpe)).toBe(rpe);
    expect(await refusal(() => rate(set, { rpe: 7.3 })))
      .toEqual(['new row for relation "set_logs" violates check constraint "set_logs_rpe_half_step"', '23514']);
    expect(await refusal(() => rate(set, { rpe: 0.5 })))
      .toEqual(['new row for relation "set_logs" violates check constraint "set_logs_rpe_check"', '23514']);
    expect(await refusal(() => rate(set, { rpe: 10.5 })))
      .toEqual(['new row for relation "set_logs" violates check constraint "set_logs_rpe_check"', '23514']);
    expect(await refusal(() => rate(set, { done: false, failed: true, rpe: 7.5 })))
      .toEqual(['new row for relation "set_logs" violates check constraint "set_logs_no_rpe_when_failed"', '23514']);
    expect(await asAdmin((q) => q.value(`select rpe from set_logs where id = $1`, [set]))).toBe(9.5);
  }));

  it('a value is rounded to one decimal before the rules are asked: 7.04 is 7.0, 7.26 is 7.3 and refused', () => scenario(async () => {
    const [set] = ids.programA.setLogs;
    expect(await rate(set, { ...ticked, rpe: 7.04 })).toBe(7);
    expect(await refusal(() => rate(set, { rpe: 7.26 })))
      .toEqual(['new row for relation "set_logs" violates check constraint "set_logs_rpe_half_step"', '23514']);
  }));

  it('a whole number, as the app that is deployed sends one, is saved and read back as it was', () => scenario(async (q) => {
    const [set] = ids.programA.setLogs;
    expect(await rate(set, { ...ticked, rpe: 8 })).toBe(8);
    // What PostgREST hands over: a JSON number, which JavaScript reads as 8 — and 7.5 as 7.5.
    const json = await q.value(`select json_build_object('rpe', rpe)::text from set_logs where id = $1`, [set]);
    expect(json).toBe('{"rpe" : 8.0}');
    expect(JSON.parse(json)).toEqual({ rpe: 8 });
    await rate(set, { rpe: 7.5 });
    expect(JSON.parse(await q.value(`select json_build_object('rpe', rpe)::text from set_logs where id = $1`, [set]))).toEqual({ rpe: 7.5 });
  }));

  it('a set rated 7.5 is logged: the coach cannot delete it, as for any rated set', () => scenario(async (q) => {
    const [set] = ids.programA.setLogs;
    await rate(set, { rpe: 7.5 });
    expect(await q.value(`select public.set_log_is_logged(sl) from set_logs sl where sl.id = $1`, [set])).toBe(true);
    const tried = await attempt(() => asUser(ids.coach, (coach) => coach(`delete from set_logs where id = $1`, [set])));
    expect(tried.error?.message).toMatch(/logged set/);
  }));
});

// ============================================================
// 21 — B12: the weekday of a session
// ============================================================
describe('B12 — the weekday of a session is 1 to 7, or none', () => {
  // useWeek.js, useUpdateSession: `.update({ day_number })` — 1 to 7 from the
  // weekday pills of the Program Sheet, or null.
  const setDay = (session, day) => asUser(ids.coach, (coach) => coach.value(`${patch('sessions', { day_number: day })} returning t.day_number`, [session]));

  it('the coach gives a session a weekday from 1 to 7, or takes it away; 0 and 8 are refused', () => scenario(async () => {
    const [session] = ids.programA.sessions;
    for (const day of [1, 7, null]) expect(await setDay(session, day), String(day)).toBe(day);
    for (const day of [0, 8, -1]) {
      expect(await refusal(() => setDay(session, day)), String(day))
        .toEqual(['new row for relation "sessions" violates check constraint "sessions_day_number_weekday"', '23514']);
    }
  }));

  // useAuthoring.js → lib/draftTree.js buildSnapshot → rpc('save_draft_tree'):
  // day_number is sent as the cached tree holds it.
  it('save_draft_tree writes a number outside 1 to 7 as no weekday — the rest of the tree is saved', () => scenario(async (q) => {
    const uuid = () => q.value(`select gen_random_uuid()`);
    const [program, week, s1, s2, s3, slot] = [await uuid(), await uuid(), await uuid(), await uuid(), await uuid(), await uuid()];
    const tree = {
      program: { id: program, name: 'Cached before the migration' },
      weeks: [{ id: week, program_id: program, week_number: 1, label: null }],
      sessions: [
        { id: s1, week_id: week, title: 'Day 1', day_number: 3, sort_order: 0 },
        { id: s2, week_id: week, title: 'Day 9', day_number: 9, sort_order: 1 },
        { id: s3, week_id: week, title: 'New', day_number: null, sort_order: 2 },
      ],
      slots: [{ id: slot, session_id: s2, exercise_id: ids.exercises.pullUp, sets: 3, reps: 5, sort_order: 0 }],
    };
    expect(await asUser(ids.studentB, (athlete) => athlete.value(`select public.save_draft_tree($1)`, [tree])))
      .toEqual({ program_id: program, weeks: 1, sessions: 3, slots: 1 });
    expect(await q.rows(`select title, day_number from sessions where week_id = $1 order by sort_order`, [week])).toEqual([
      { title: 'Day 1', day_number: 3 },
      { title: 'Day 9', day_number: null },
      { title: 'New', day_number: null },
    ]);
    // A value that is not a number at all is refused, as before.
    const broken = { ...tree, sessions: [{ ...tree.sessions[0], day_number: 'Monday' }] };
    expect((await refusal(() => asUser(ids.studentB, (athlete) => athlete(`select public.save_draft_tree($1)`, [broken]))))[1]).toBe('22P02');
  }));

  it('a copy keeps the weekday of its source, now always one', () => scenario(async (q) => {
    const [source] = ids.programA.sessions;
    await q(`update sessions set day_number = 6 where id = $1`, [source]);
    const copied = await asUser(ids.coach, (coach) => coach.value(`select public.duplicate_session($1)`, [source]));
    expect(await q.value(`select day_number from sessions where id = $1`, [copied.session_id])).toBe(6);
  }));
});

// ============================================================
// 21 — the migration file, on production as it was frozen
// ============================================================
describe('migration 2026_10_16_21_rpe_half_steps_day_check', () => {
  const migration = entry('2026_10_16_21_rpe_half_steps_day_check');
  const page = read(migration.paths.runbook);
  const COACH = '00000000-0000-4000-8000-00000000c0ac';
  const ATHLETE = '00000000-0000-4000-8000-0000000000a1';
  const LINK = '00000000-0000-4000-8000-000000000101';
  const PULL_UP = '00000000-0000-4000-8000-000000000201';
  const BLOCK = '00000000-0000-4000-8000-000000000301';
  const OWN = '00000000-0000-4000-8000-000000000302';
  const DRAFT = '00000000-0000-4000-8000-000000000303';
  const S_MONDAY = '00000000-0000-4000-8000-000000000451';
  const S_NINE = '00000000-0000-4000-8000-000000000452';
  const S_WEDNESDAY = '00000000-0000-4000-8000-000000000453';
  const SLOT = '00000000-0000-4000-8000-000000000501';
  const SET_8 = '00000000-0000-4000-8000-000000000601';
  const SET_7 = '00000000-0000-4000-8000-000000000602';
  const SET_NEXT = '00000000-0000-4000-8000-000000000603';

  // A coach and Alex. "Block" is the coach's, being trained: Monday, a
  // session the coach's own SQL gave the number 9, and Wednesday; two sets
  // rated 8 and 7, a third to come. "My block" is a block Alex wrote and the
  // coach approved: the builder said Monday on every session — the first one
  // trained and reviewed. "Next" is Alex's draft: positions 1 and 8.
  const WORLD = `
    insert into auth.users (id, email, aud, role, email_confirmed_at, raw_user_meta_data) values
      ('${COACH}',   'coach@sl.test', 'authenticated', 'authenticated', now(), '{"full_name": "Coach Carla"}'),
      ('${ATHLETE}', 'alex@sl.test',  'authenticated', 'authenticated', now(), '{"full_name": "Alex"}');
    BEGIN;
    SET LOCAL session_replication_role = replica;
    update public.profiles set role = 'coach' where id = '${COACH}';
    COMMIT;
    insert into public.students (id, profile_id, coach_id) values ('${LINK}', '${ATHLETE}', '${COACH}');
    insert into public.exercise_library (id, coach_id, name, type, difficulty) values ('${PULL_UP}', '${COACH}', 'Pull-up', 'pull', 2);
    insert into public.programs (id, student_id, name, status, is_active, created_by) values
      ('${BLOCK}', '${LINK}', 'Block',    'approved', true,  null),
      ('${OWN}',   '${LINK}', 'My block', 'approved', false, '${ATHLETE}'),
      ('${DRAFT}', '${LINK}', 'Next',     'draft',    false, '${ATHLETE}');
    insert into public.weeks (id, program_id, week_number) values
      ('00000000-0000-4000-8000-000000000401', '${BLOCK}', 1),
      ('00000000-0000-4000-8000-000000000402', '${OWN}', 1),
      ('00000000-0000-4000-8000-000000000403', '${DRAFT}', 1);
    insert into public.sessions (id, week_id, title, sort_order, day_number, reviewed_at) values
      ('${S_MONDAY}',    '00000000-0000-4000-8000-000000000401', 'Monday',    0, 1, null),
      ('${S_NINE}',      '00000000-0000-4000-8000-000000000401', 'Nine',      1, 9, null),
      ('${S_WEDNESDAY}', '00000000-0000-4000-8000-000000000401', 'Wednesday', 2, 3, null),
      ('00000000-0000-4000-8000-000000000454', '00000000-0000-4000-8000-000000000402', 'Own A', 0, 1, now()),
      ('00000000-0000-4000-8000-000000000455', '00000000-0000-4000-8000-000000000402', 'Own B', 1, 1, null),
      ('00000000-0000-4000-8000-000000000456', '00000000-0000-4000-8000-000000000403', 'Draft 1', 0, 1, null),
      ('00000000-0000-4000-8000-000000000457', '00000000-0000-4000-8000-000000000403', 'Draft 8', 1, 8, null);
    insert into public.exercise_slots (id, session_id, exercise_id, sets, reps, weight_kg, sort_order)
      values ('${SLOT}', '${S_MONDAY}', '${PULL_UP}', 3, 5, 20, 0);
    insert into public.set_logs (id, exercise_slot_id, set_number, target_reps, target_weight_kg, done, rpe, logged_at) values
      ('${SET_8}',    '${SLOT}', 1, 5, 20, true,  8,    now()),
      ('${SET_7}',    '${SLOT}', 2, 5, 20, true,  7,    now()),
      ('${SET_NEXT}', '${SLOT}', 3, 5, 20, false, null, null);
  `;
  const production = () => productionBefore(migration.name, WORLD);

  const THE_COACH = user(COACH);
  const THE_ATHLETE = user(ATHLETE);
  const rateNext = (rpe) => `${patch('set_logs', { done: true, rpe })} and t.id = '${SET_NEXT}' returning 'saved'`
    .replace('where t.id = $1 and ', 'where ');
  const dayOfMonday = (day) => `${patch('sessions', { day_number: day })} and t.id = '${S_MONDAY}' returning 'saved'`
    .replace('where t.id = $1 and ', 'where ');
  const finding = async (db) => ({
    half: await story(db, THE_ATHLETE, rateNext(7.5)),
    between: await story(db, THE_ATHLETE, rateNext(7.3)),
    eight: await story(db, THE_COACH, dayOfMonday(8)),
  });
  const OPEN = {
    half: 'invalid input syntax for type integer: "7.5"',
    between: 'invalid input syntax for type integer: "7.3"',
    eight: 'saved',
  };
  const CLOSED = {
    half: 'saved',
    between: 'new row for relation "set_logs" violates check constraint "set_logs_rpe_half_step"',
    eight: 'new row for relation "sessions" violates check constraint "sessions_day_number_weekday"',
  };
  const weekdays = (db) => db.query.value(
    `select string_agg(s.title || ' ' || coalesce(s.day_number::text, '-'), ', ' order by p.name, s.sort_order)
       from public.sessions s join public.weeks w on w.id = s.week_id join public.programs p on p.id = w.program_id`,
  );
  // Block, then My block, then Next.
  const AS_IT_WAS = 'Monday 1, Nine 9, Wednesday 3, Own A 1, Own B 1, Draft 1 1, Draft 8 8';
  const CLEARED = 'Monday 1, Nine -, Wednesday 3, Own A -, Own B -, Draft 1 -, Draft 8 -';
  const DRAFTS_ONLY = 'Monday 1, Nine -, Wednesday 3, Own A 1, Own B 1, Draft 1 -, Draft 8 -';
  const rpes = (db) => db.query.value(`select string_agg(rpe::text, ', ' order by set_number) from public.set_logs`);
  // The md5 the file and its audit know save_draft_tree by: its text without
  // its comments, spaces folded.
  const DRAFT_SAVE_MD5 = `select md5(btrim(regexp_replace(regexp_replace(prosrc, '-{2}.*', '', 'gn'), '[[:space:]]+', ' ', 'g')))
    from pg_proc where oid = 'public.save_draft_tree(jsonb)'::regprocedure`;

  it('a 7.5 is refused and a weekday of 8 taken before; the reverse after — the RPEs logged keep their value; the rollback rounds a half up', async () => {
    const db = await production();
    expect(await finding(db)).toEqual(OPEN);
    expect(await rpes(db)).toBe('8, 7');
    expect(await weekdays(db)).toBe(AS_IT_WAS);

    await db.runFile(migration.paths.migration);
    expect(await finding(db)).toEqual(CLOSED);
    expect(await rpes(db)).toBe('8.0, 7.0');
    expect(await weekdays(db)).toBe(CLEARED);
    // The coach still gives a weekday, and the athlete's draft still saves.
    expect(await story(db, THE_COACH, dayOfMonday(7))).toBe('saved');
    expect(await story(db, THE_COACH, dayOfMonday(null))).toBe('saved');

    await db.query(`update public.set_logs set rpe = 7.5 where id = '${SET_NEXT}'`);
    await db.query(`update public.set_logs set rpe = 9.5 where id = '${SET_7}'`);
    await db.runFile(migration.paths.rollback);
    expect(await finding(db)).toEqual(OPEN);
    // 7.5 went up to 8, 9.5 to 10; the weekdays the file cleared stay cleared.
    expect(await rpes(db)).toBe('8, 10, 8');
    expect(await weekdays(db)).toBe(CLEARED);
    await db.drop();
  });

  it('changes the type of rpe, adds two rules, replaces save_draft_tree and signs the ledger — no table, no policy, no privilege', async () => {
    const db = await production();
    const before = await catalogSnapshot(db.query);
    await db.runFile(migration.paths.migration);
    const after = await catalogSnapshot(db.query);
    expect(changesOf(before, after)).toEqual({
      before: [],
      after: ['constraints public.sessions.sessions_day_number_weekday', 'constraints public.set_logs.set_logs_rpe_half_step'],
      changed: [
        'columns public.set_logs.rpe → type',
        'constraints public.set_logs.set_logs_rpe_check → definition',
        'data rows of app_private.app_migrations → rows',
        'functions public.save_draft_tree(p_tree jsonb) → definition',
      ],
    });
    expect(after.constraints['public.sessions.sessions_day_number_weekday'])
      .toMatchObject({ definition: 'CHECK (day_number IS NULL OR day_number >= 1 AND day_number <= 7)', validated: true });
    const draftSave = 'public.save_draft_tree(p_tree jsonb)';
    expect(after.functions[draftSave].privileges).toEqual(before.functions[draftSave].privileges);
    expect(after.functions[draftSave].definition.split(/\nAS /)[0]).toBe(before.functions[draftSave].definition.split(/\nAS /)[0]);
    expect(await db.query.rows(`select name from ${LEDGER} order by name`)).toHaveLength(20);
    expect(page).toContain(`Expected: twenty rows, the last one \`${migration.name}\` — twenty-one where the optional migration 19 was applied at Checkpoint B.`);
    expect(page).toContain('| Kind | required · changes the type of 1 column, adds 2 rules, replaces 1 function; clears the weekdays listed below |');
    // The function of the file is the one of schema.sql, text for text.
    const schema = await scratchDatabase({ from: 'schema' });
    expect(after.functions[draftSave].definition).toBe((await catalogSnapshot(schema.query)).functions[draftSave].definition);
    await schema.drop();
    await db.drop();
  });

  it('its audit prints the "before" and "after" columns of the runbook page', async () => {
    const db = await production();
    const table = auditTableOf(page);
    expect(table.map((line) => line.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // Nine and Draft 8; Draft 1; Own A and Own B; Monday and Wednesday.
    const counted = { 3: '7: 1, 8: 1', 6: '2', 7: '1', 8: '2', 9: '2' };
    const column = (side, overrides = {}) => table.map((line) => [line.check, overrides[line.n] ?? literal(line[side]) ?? counted[line.n]]);
    expect(await printedAudit(db, migration)).toEqual(column('before'));
    await db.runFile(migration.paths.migration);
    expect(await printedAudit(db, migration)).toEqual(column('after', { 8: '0' }));
    // The header of the audit file says the same.
    const header = read(migration.paths.audit).split('\n').filter((line) => line.startsWith('--')).join('\n');
    for (const { check } of table) expect(header).toContain(check);
    // The md5 the audit knows the new function by is the one of the file.
    expect(read(migration.paths.audit)).toContain(await db.query.value(DRAFT_SAVE_MD5));
    // A half step joins the list as it is.
    await db.query(`update public.set_logs set rpe = 7.5 where id = '${SET_NEXT}'`);
    expect(Object.fromEntries(await printedAudit(db, migration))).toMatchObject({ 'the RPEs logged, by value': '7: 1, 7.5: 1, 8: 1' });
    await db.drop();
  });

  it('the page lists the sessions that lose their weekday, and the second command keeps those of the approved blocks', async () => {
    const list = quotedOf(page, 'select pr.full_name as athlete, p.name as block');
    expect(list, 'the page no longer lists the sessions').toBeTruthy();
    const listed = async (db) => (await db.query.rows(list)).map((row) => [row.block, row.state, row.phase, row.position, row.title, row.weekday, row.why]);
    const AS_LISTED = [
      ['Block', 'approved', 'phase 1', 2, 'Nine', 9, 'not a weekday'],
      ['My block', 'approved', 'phase 1', 1, 'Own A', 1, 'a block the athlete wrote'],
      ['My block', 'approved', 'phase 1', 2, 'Own B', 1, 'a block the athlete wrote'],
      ['Next', 'draft', 'phase 1', 1, 'Draft 1', 1, 'a draft the athlete is writing'],
      ['Next', 'draft', 'phase 1', 2, 'Draft 8', 8, 'not a weekday'],
    ];
    for (const why of ['not a weekday', 'a draft the athlete is writing', 'a block the athlete wrote']) expect(page).toContain(`- **\`${why}\`**`);

    // The file as it is: everything listed goes.
    const all = await production();
    expect(await listed(all)).toEqual(AS_LISTED);
    await all.runFile(migration.paths.migration);
    expect(await listed(all)).toEqual([]);
    expect(await weekdays(all)).toBe(CLEARED);
    await all.drop();

    // The second command of "Apply", as a shell runs it: the file behind one statement.
    const [, setting, file] = /^supabase db query --linked "(set app\.day_number_clearing = 'drafts';) \$\(cat (\S+)\)"$/
      .exec(fencesOf(page, 'bash').find((command) => command.includes('app.day_number_clearing'))) ?? [];
    expect(file).toBe(migration.paths.migration);
    const drafts = await production();
    await drafts.runSql(`${setting} ${read(file)}`, 'the second command');
    expect(await weekdays(drafts)).toBe(DRAFTS_ONLY);
    expect(await listed(drafts)).toEqual(AS_LISTED.filter((row) => row[6] === 'a block the athlete wrote'));
    expect(page).toContain('After the migration the same command lists nothing — or, with drafts only, the lines `a block the athlete wrote`.');
    expect(Object.fromEntries(await printedAudit(drafts, migration)))
      .toMatchObject({ 'sessions of an approved block an athlete wrote, with a weekday': '2', 'what the weekday of a session may be (B12)': 'none, or 1 to 7' });
    await drafts.drop();

    // Another word is a typing mistake, not a third choice.
    const typo = await production();
    expect(await refusalOf(typo, migration, () => typo.runSql(`set app.day_number_clearing = 'draft'; ${read(file)}`, 'typo')))
      .toContain('does not know app.day_number_clearing = draft');
    expect(page).toContain('| `does not know app.day_number_clearing` |');
    await typo.drop();
  });

  it('the page\'s check answers NOT THERE before and "in place" after, names what is wrong when something is — and writes nothing', async () => {
    const db = await production();
    const check = checkOf(page);
    expect(check, 'the page no longer gives the check').toBeTruthy();
    expect(check).not.toContain("'");
    const state = () => db.query.one(
      `select (select count(*) from auth.users) as accounts, (select count(*) from public.programs) as blocks,
              (select count(*) from public.sessions) as sessions, (select count(*) from public.set_logs) as sets,
              current_user::text as role, coalesce(current_setting('request.jwt.claims', true), '') as claims`,
    );
    const UNTOUCHED = { accounts: 2, blocks: 3, sessions: 7, sets: 3, role: 'postgres', claims: '' };
    const answer = (said) => `check only, nothing was written: ${said}`;
    const IN_PLACE = answer('in place: an RPE is saved in half steps and refused between them; a weekday is 1 to 7 or none; a draft whose session says 9 is saved without one');

    expect(await runCheck(db, check)).toBe(answer('NOT THERE: an RPE is a whole number, and a weekday any number'));
    expect(await state()).toEqual(UNTOUCHED);
    await db.runFile(migration.paths.migration);
    expect(await runCheck(db, check)).toBe(IN_PLACE);
    expect(await state()).toEqual(UNTOUCHED);
    expect(page).toContain(`\`${IN_PLACE}\``);
    expect(page).toContain('`… NOT THERE: an RPE is a whole number, and a weekday any number`');

    // Each rule taken away by hand, one at a time.
    await db.query(`alter table public.set_logs drop constraint set_logs_rpe_half_step`);
    expect(await runCheck(db, check)).toBe(answer('NOT PROTECTED: an RPE of 7.3 was saved'));
    await db.query(`alter table public.set_logs add constraint set_logs_rpe_half_step check (rpe is null or rpe * 2 = trunc(rpe * 2))`);
    await db.query(`alter table public.sessions drop constraint sessions_day_number_weekday`);
    await db.query(`alter table public.sessions add constraint sessions_day_number_weekday check (day_number is null or day_number between 1 and 9)`);
    expect(await runCheck(db, check)).toBe(answer('NOT PROTECTED: a session was given the weekday 8'));
    await db.query(`alter table public.sessions drop constraint sessions_day_number_weekday`);
    await db.query(`alter table public.sessions add constraint sessions_day_number_weekday check (day_number is null or day_number between 1 and 7)`);
    // The save_draft_tree of August: the draft is refused as a whole.
    const august = read('supabase/rollbacks/2026_10_16_21_rpe_half_steps_day_check.down.sql');
    const was = await db.query.value(`select pg_get_functiondef('public.save_draft_tree(jsonb)'::regprocedure)`);
    await db.query(august.slice(august.indexOf('CREATE OR REPLACE FUNCTION public.save_draft_tree'), august.indexOf('\n$$;\n') + 4));
    expect(await runCheck(db, check)).toMatch(/^check only, nothing was written: BROKEN: a draft whose session says 9 was not saved without a weekday: 23514 /);
    await db.query(was);
    expect(await runCheck(db, check)).toBe(IN_PLACE);
    expect(page).toContain('- `… NOT PROTECTED: …` or `… BROKEN: …` — the migration does not do what this page says: **roll back**, and report the full message.');
    expect(await state()).toEqual(UNTOUCHED);
    await db.drop();
  });

  it('takes the save_draft_tree production was given: the text of the file of 2026_08_22, whose comment is not the one of schema.sql', async () => {
    // The frozen baseline is schema.sql of August. Production differs from it
    // by the comments of about twelve functions (L29): it was given each of
    // them by its migration file, save_draft_tree by this one.
    const august = 'supabase/migrations/2026_08_22_draft_day_number_optional.sql';
    const db = await scratchDatabase();
    await db.runFile(manifest.baseline);
    const ofSchema = await db.query.value(DRAFT_SAVE_MD5);
    await db.runFile(august);
    await db.runSql(WORLD, 'world');
    for (const earlier of migrationsBefore(manifest.migrations, migration.name)) await db.runFile(earlier.paths.migration);
    const text = await db.query.value(`select prosrc from pg_proc where oid = 'public.save_draft_tree(jsonb)'::regprocedure`);
    expect(text).toContain('-- day_number passes through as-is: no weekday chosen stays NULL');
    expect(text).not.toContain('-- No weekday chosen stays NULL (2026_08_22)');
    expect(await db.query.value(DRAFT_SAVE_MD5)).toBe(ofSchema);

    expect(Object.fromEntries(await printedAudit(db, migration)))
      .toMatchObject({ 'what save_draft_tree writes for a number that is no weekday': 'the number' });
    await db.runFile(migration.paths.migration);
    expect(await finding(db)).toEqual(CLOSED);
    expect(await weekdays(db)).toBe(CLEARED);
    expect(Object.fromEntries(await printedAudit(db, migration)))
      .toMatchObject({ 'what save_draft_tree writes for a number that is no weekday': 'no weekday' });
    // Rolled back, it reads as before, and the file is taken again.
    await db.runFile(migration.paths.rollback);
    expect(Object.fromEntries(await printedAudit(db, migration)))
      .toMatchObject({ 'what save_draft_tree writes for a number that is no weekday': 'the number' });
    await db.runFile(migration.paths.migration);
    expect(await db.query.value(`select count(*) from ${LEDGER} where name = $1`, [migration.name])).toBe(1);
    await db.drop();
  });

  it('without migration 20 it says so (SLM02), and its rollback says there is nothing to undo (SLM03)', async () => {
    const db = await scratchDatabase();
    await db.runFile(manifest.baseline);
    for (const earlier of migrationsBefore(manifest.migrations, '2026_10_16_20_drafts_coach_readonly')) await db.runFile(earlier.paths.migration);
    const before = await catalogSnapshot(db.query);
    const refused = await attempt(() => db.runFile(migration.paths.migration));
    const undone = await attempt(() => db.runFile(migration.paths.rollback));
    expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
    expect([refused.error?.code, undone.error?.code]).toEqual([REFUSAL.predecessorMissing, REFUSAL.notApplied]);
    expect(refused.error.message).toContain('needs 2026_10_16_20_drafts_coach_readonly, which is not applied');
    expect(page).toContain('| `needs 2026_10_16_20_drafts_coach_readonly, which is not applied` (code `SLM02`) |');
    await db.drop();
  });

  it('refuses to run as another role, on a column or a function it does not know, next to a rule of its names — and changes nothing', async () => {
    const db = await production();
    const text = read(migration.paths.migration);
    const asServiceRole = text.replace(`SET LOCAL lock_timeout = '5s';`, `SET LOCAL lock_timeout = '5s';\nSET LOCAL ROLE service_role;`);
    expect(await refusalOf(db, migration, () => db.runSql(asServiceRole, 'migration')))
      .toContain(`migration ${migration.name} must be run as postgres, not as service_role`);

    await db.query(`alter table public.set_logs alter column rpe type smallint`);
    expect(await refusalOf(db, migration)).toContain('would not change set_logs.rpe: it is smallint, not integer');
    await db.query(`alter table public.set_logs alter column rpe type integer`);
    await db.query(`alter table public.set_logs drop constraint set_logs_rpe_check, add constraint set_logs_rpe_check check (rpe between 0 and 10)`);
    expect(await refusalOf(db, migration)).toContain('would not change set_logs.rpe: set_logs_rpe_check is CHECK (((rpe >= 0) AND (rpe <= 10)))');
    await db.query(`alter table public.set_logs drop constraint set_logs_rpe_check, add constraint set_logs_rpe_check check (rpe is null or (rpe between 1 and 10))`);

    await db.query(`alter table public.sessions add constraint sessions_day_number_weekday check (day_number > 0)`);
    expect(await refusalOf(db, migration)).toContain('would not create: sessions_day_number_weekday on sessions is already there');
    await db.query(`alter table public.sessions drop constraint sessions_day_number_weekday`);

    const was = await db.query.value(`select pg_get_functiondef('public.save_draft_tree(jsonb)'::regprocedure)`);
    await db.query(was.replace(`'My program'`, `'Mon programme'`));
    expect(await refusalOf(db, migration)).toMatch(/would not replace save_draft_tree: public\.save_draft_tree\(jsonb\) is not the text of 2026_08_22 \(md5 of its text, comments left out and spaces folded: [0-9a-f]{32}\)/);
    // A comment is not code: a `--` that comments a line out is.
    await db.query(was.replace('  DELETE FROM public.weeks WHERE', '  -- DELETE FROM public.weeks WHERE'));
    expect(await refusalOf(db, migration)).toContain('is not the text of 2026_08_22');
    // The same text laid out another way, and commented another way, is the same function.
    await db.query(was.replace('  v_weeks int := 0;', '\n\n      -- Three counters.\n      v_weeks int := 0;')
      .replace('  DELETE FROM public.weeks', '  -- The children go with the phases.\n  DELETE FROM public.weeks'));
    await db.runFile(migration.paths.migration);
    expect(await db.query.value(`select count(*) from ${LEDGER} where name = $1`, [migration.name])).toBe(1);
    for (const said of ['| `must be run as postgres` |', '| `would not change set_logs.rpe: …` |', '| `would not create: … is already there` |', '| `would not replace save_draft_tree: …` |']) {
      expect(page).toContain(said);
    }
    await db.drop();
  });

  it('its rollback is refused while the ledger records a later migration, and changes nothing', async () => {
    const db = await production();
    await db.runFile(migration.paths.migration);
    await db.query(`insert into ${LEDGER} (name) values ($1)`, [TO_COME]);
    const before = await catalogSnapshot(db.query);
    const refused = await attempt(() => db.runFile(migration.paths.rollback));
    expect(refused.error?.code).toBe(REFUSAL.stillNeeded);
    expect(refused.error.message).toContain(TO_COME);
    expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
    await db.drop();
  });
});
