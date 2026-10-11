// Test-side API of the DB suite. Import it from a `*.test.js` file under
// supabase/tests/ (run with `npm run test:db`).
//
//   import { asAnon, asUser, asService, asAdmin, scenario, seed } from './harness.js';
//
// One database per test FILE: the first helper call clones the template
// (shim.sql + schema.sql, built once per run by global-setup.js) into a fresh
// database, and it is dropped when the file is done. Files cannot see each
// other; tests inside a file share one database.
//
// One transaction per top-level helper call, ROLLED BACK when `fn` returns:
//
//   await asUser(ids.studentA, (q) => q('update set_logs set done = true'));
//   await asAdmin((q) => q('select …'));   // does NOT see the update above
//
// To have several actors in the SAME transaction, nest the calls — an inner
// helper joins the transaction of the outer one:
//
//   await scenario(async (q) => {                            // q: as postgres
//     await asUser(ids.studentA, (a) => a('update …'));      // a: as student A
//     const row = await q.one('select …');                   // sees the update
//   });                                                      // rolled back
//
// A `q` always runs as the actor of the helper that created it, wherever it is
// called from.
//
// The four actors above are the ones the API knows. GoTrue and the Storage
// server arrive as roles of their own, which `postgres` cannot become:
// asPlatformRole().
//
// A test about the SQL FILES themselves (does the production baseline plus the
// migrations give schema.sql? can this migration be rolled back?) needs a
// database it builds itself: scratchDatabase(), at the end of this file.
//
// How a role is impersonated is how PostgREST does it for every API request
// (and how the Supabase dashboard's "role impersonation" does it): inside the
// transaction, SET LOCAL ROLE to anon / authenticated / service_role and put
// the JWT claims in `request.jwt.claims`, which is what auth.uid() reads.

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, inject } from 'vitest';
import { runSql, runSqlFile } from './sql.js';

/** The repository root: SQL files are named relative to it. */
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const connection = inject('slDb');
if (!connection) {
  throw new Error(
    'supabase/tests/harness.js: no database was provided. Run the DB suite with '
    + '`npm run test:db` (vitest.db.config.js), not with the default vitest config.',
  );
}

// ------------------------------------------------------------
// Result parsing — line up with what PostgREST hands the app as JSON.
// ------------------------------------------------------------
const INT8 = 20;
const NUMERIC = 1700;
const DATE = 1082;
const types = {
  getTypeParser(oid, format) {
    if (format !== 'binary') {
      // count(*) and numeric(6,2) come back as JS numbers, not strings…
      if (oid === INT8 || oid === NUMERIC) return Number;
      // …and a `date` stays 'YYYY-MM-DD' instead of a local-midnight Date.
      if (oid === DATE) return (value) => value;
    }
    return pg.types.getTypeParser(oid, format);
  },
};

// ------------------------------------------------------------
// The file's database
// ------------------------------------------------------------
const server = {
  host: connection.host,
  port: connection.port,
  user: connection.user,
  password: connection.password,
};

let database = null;
// The databases this file built with scratchDatabase().
const scratch = [];

async function asServerAdmin(fn) {
  const client = new pg.Client({ ...server, database: 'postgres' });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function createDatabase(template = connection.template, poolOptions = {}) {
  // Watch mode only: the last save of schema.sql / shim.sql did not load.
  if (connection.error) throw new Error(`The template database could not be built.\n${connection.error}`);
  const name = `sl_test_${randomBytes(6).toString('hex')}`;
  await asServerAdmin((client) => client.query(
    `CREATE DATABASE ${name} TEMPLATE ${template} OWNER ${connection.user}`,
  ));
  const pool = new pg.Pool({ ...server, database: name, max: 4, types, ...poolOptions });
  // An idle client dropped by a server shutdown must not crash the worker.
  pool.on('error', () => {});
  return { name, pool };
}

async function dropDatabase({ name, pool }) {
  await pool.end();
  await asServerAdmin((client) => client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
}

function getDatabase() {
  database ??= createDatabase();
  return database;
}

afterAll(async () => {
  // Nothing to drop if no helper ran, or if the clone itself failed.
  const created = await database?.catch(() => null);
  database = null;
  const all = [created, ...scratch.splice(0)].filter(Boolean);
  for (const one of all) await dropDatabase(one);
});

// ------------------------------------------------------------
// Actors
// ------------------------------------------------------------
// PostgREST sets search_path to the exposed schema + db-extra-search-path for
// every request; `postgres` keeps its role default.
const API_SEARCH_PATH = 'public, extensions';
const OWNER_SEARCH_PATH = '"$user", public, extensions';

const ADMIN = { role: connection.user, claims: null, searchPath: OWNER_SEARCH_PATH };
const ANON = { role: 'anon', claims: { role: 'anon' }, searchPath: API_SEARCH_PATH };
const SERVICE = { role: 'service_role', claims: { role: 'service_role' }, searchPath: API_SEARCH_PATH };

const idOf = (user) => (typeof user === 'string' ? user : user?.id);

function userActor(user, extraClaims) {
  const sub = idOf(user);
  if (!sub) throw new Error('asUser: expected a user id (uuid) or an object with an `id`');
  return {
    role: 'authenticated',
    claims: { sub, role: 'authenticated', aud: 'authenticated', ...extraClaims },
    searchPath: API_SEARCH_PATH,
  };
}

function applyActor(client, actor) {
  return client.query(
    `select set_config('role', $1, true),
            set_config('request.jwt.claims', $2, true),
            set_config('search_path', $3, true)`,
    [actor.role, actor.claims ? JSON.stringify(actor.claims) : '', actor.searchPath],
  );
}

// ------------------------------------------------------------
// q — the query function handed to `fn`
// ------------------------------------------------------------
// `q` is bound to the actor of the helper that created it: wherever it is
// called from, it runs as that actor (the role is switched lazily, right
// before the statement, when someone else used the connection last).
//
// Every statement runs in its own SAVEPOINT. A statement that raises (an RLS
// violation, a RAISE EXCEPTION, a constraint) is rolled back alone and the
// error is thrown to the test, but the transaction stays usable — the next
// statement can go and look at what the failed one left behind. That matches
// the app, where each PostgREST call is its own request. `q.dryRun` uses the
// same savepoint to undo a statement that succeeded.
function createQuery(tx, actor) {
  const { client } = tx;

  const exec = async (text, params, keep) => {
    if (tx.actor !== actor) {
      await applyActor(client, actor);
      tx.actor = actor;
    }
    await client.query('SAVEPOINT harness_statement');
    try {
      const result = await client.query(text, params);
      await client.query(keep
        ? 'RELEASE SAVEPOINT harness_statement'
        : 'ROLLBACK TO SAVEPOINT harness_statement; RELEASE SAVEPOINT harness_statement');
      return result;
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT harness_statement; RELEASE SAVEPOINT harness_statement');
      throw err;
    }
  };

  // One statement at a time on the connection, even under Promise.all.
  const enqueue = (text, params, keep) => {
    const next = tx.queue.then(() => exec(text, params, keep));
    tx.queue = next.catch(() => {});
    return next;
  };
  const q = withShortcuts((text, params) => enqueue(text, params, true));
  /**
   * Run the statement and undo it at once: the result comes back (rowCount,
   * RETURNING rows), the database is as if it had never run — triggers and
   * cascades included. For "could this actor delete that row?" asked of many
   * rows in a row, where one answer must not change the next.
   */
  q.dryRun = (text, params) => enqueue(text, params, false);
  return q;
}

function withShortcuts(q) {
  /** All rows. */
  q.rows = async (text, params) => (await q(text, params)).rows;
  /** First row, or null. */
  q.one = async (text, params) => (await q(text, params)).rows[0] ?? null;
  /** First column of the first row, or null. */
  q.value = async (text, params) => {
    const row = (await q(text, params)).rows[0];
    return row ? Object.values(row)[0] ?? null : null;
  };
  return q;
}

// ------------------------------------------------------------
// Transactions
// ------------------------------------------------------------
// `tx` = one connection inside BEGIN, the queue that serializes statements on
// it, and the actor whose role/claims are currently applied.
const transactions = new AsyncLocalStorage();

async function run(actor, fn, { commit = false } = {}) {
  if (typeof fn !== 'function') throw new TypeError('harness: expected a function');

  // Nested call: join the transaction of the enclosing helper.
  const outer = transactions.getStore();
  if (outer) return fn(createQuery(outer, actor));

  const { pool } = await getDatabase();
  const client = await pool.connect();
  const tx = { client, queue: Promise.resolve(), actor: null };
  try {
    await client.query('BEGIN');
    const result = await transactions.run(tx, () => fn(createQuery(tx, actor)));
    await tx.queue;
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (err) {
    await tx.queue;
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Run `fn(q)` as an anonymous API caller: role `anon`, no user JWT, so
 * auth.uid() IS NULL. This is anyone holding the public anon key.
 */
export const asAnon = (fn, options) => run(ANON, fn, options);

/**
 * Run `fn(q)` as a signed-in user: role `authenticated`, auth.uid() = the id.
 * `user` is a uuid or any object with an `id` (e.g. `ids.studentA`).
 * `options.claims` adds JWT claims (email, app_metadata, …).
 */
export const asUser = (user, fn, options = {}) =>
  run(userActor(user, options.claims), fn, options);

/** Run `fn(q)` as `service_role` (Edge Functions): bypasses RLS, no auth.uid(). */
export const asService = (fn, options) => run(SERVICE, fn, options);

/**
 * Run `fn(q)` as `postgres`, the owner of the schema: bypasses RLS and holds
 * every privilege on `public`. Use it to arrange fixtures and to read the
 * ground truth after an actor has (or has not) changed something.
 */
export const asAdmin = (fn, options) => run(ADMIN, fn, options);

/**
 * Open one transaction for a multi-actor story and roll it back at the end.
 * Inside, every helper (asUser, asAnon, asAdmin, createUser, …) joins it.
 * `fn` receives an admin `q`.
 */
export const scenario = (fn, options) => run(ADMIN, fn, options);

/**
 * Run `fn(q, owner)` as a PLATFORM role — one `postgres` is not a member of,
 * and so cannot become with SET ROLE:
 *
 *   supabase_auth_admin     GoTrue. It owns auth.users: every sign-up, every
 *                           invitation and the dashboard's "Add user" is an
 *                           INSERT made as this role.
 *   supabase_storage_admin  the owner of storage.objects
 *
 *   await asPlatformRole('supabase_auth_admin', async (gotrue, owner) => {
 *     const id = await gotrue.value(`insert into auth.users (email) values ($1) returning id`, [email]);
 *     expect(await owner.value(`select role from public.profiles where id = $1`, [id])).toBe('student');
 *   });
 *
 * `q` runs as the role. `owner` runs as `postgres` in the same transaction, to
 * read what `q` did — a platform role holds no privilege on `public`.
 *
 * It is a connection of its own (the bootstrap superuser, then SET LOCAL
 * ROLE) and a transaction of its own, ROLLED BACK at the end. It does not join
 * a scenario(): it sees committed rows only — seed(), not what an enclosing
 * helper has written. There is no savepoint per statement: one that raises
 * ends the transaction.
 */
export async function asPlatformRole(role, fn) {
  if (typeof fn !== 'function') throw new TypeError('harness: expected a function');
  const { name } = await getDatabase();
  const client = new pg.Client({ ...server, ...connection.superuser, database: name, types });
  await client.connect();
  const as = (who) => withShortcuts(async (text, params) => {
    await client.query(`select set_config('role', $1, true)`, [who]);
    return client.query(text, params);
  });
  try {
    await client.query('BEGIN');
    return await fn(as(role), as(connection.user));
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
}

/**
 * Resolve to `{ ok: true, value }` or `{ ok: false, error }` instead of
 * throwing — for "try the attack, then look at the state" tests, where the
 * secure outcome may be an error OR a silent no-op.
 */
export async function attempt(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error };
  }
}

// ------------------------------------------------------------
// Fixtures. Called on their own they COMMIT (a rolled-back fixture is no
// fixture); called inside scenario()/as*() they join that transaction.
// ------------------------------------------------------------
const fixture = (fn) => run(ADMIN, fn, { commit: true });

/**
 * Create an account the way production does: a row in auth.users, which fires
 * handle_new_user() and creates the profile (always as 'student').
 *
 *   createUser({ email, fullName, role: 'coach' })
 *   createUser({ email, fullName, coach })      // student linked to that coach
 *
 * Returns `{ id, email, fullName, role, studentRowId }` — `id` is the
 * auth.users / profiles id (what auth.uid() returns); `studentRowId` is
 * `students.id` (what `programs.student_id` points at), null without a coach.
 */
export function createUser({ email, fullName = '', role = 'student', coach = null } = {}) {
  return fixture(async (q) => {
    const address = email ?? `user-${randomBytes(4).toString('hex')}@sl.test`;
    const id = await q.value(
      `insert into auth.users (email, aud, role, email_confirmed_at, raw_user_meta_data)
       values ($1, 'authenticated', 'authenticated', now(), $2)
       returning id`,
      [address, JSON.stringify({ full_name: fullName })],
    );

    if (role === 'coach') {
      // The documented promotion is a plain UPDATE, but the
      // profiles_pin_immutable_columns trigger reverts `role` for every
      // caller, `postgres` included. Go around the triggers the way a dump
      // restore does until that is settled.
      let stored = await q.value(
        `update public.profiles set role = 'coach' where id = $1 returning role`, [id],
      );
      if (stored !== 'coach') {
        await q(`select set_config('session_replication_role', 'replica', true)`);
        stored = await q.value(
          `update public.profiles set role = 'coach' where id = $1 returning role`, [id],
        );
        await q(`select set_config('session_replication_role', 'origin', true)`);
      }
      if (stored !== 'coach') throw new Error('createUser: could not promote the profile to coach');
    }

    const coachId = idOf(coach);
    const studentRowId = coachId
      ? await q.value(
        `insert into public.students (profile_id, coach_id) values ($1, $2) returning id`,
        [id, coachId],
      )
      : null;

    return { id, email: address, fullName, role, studentRowId };
  });
}

async function studentRowIdOf(q, student) {
  if (student?.studentRowId) return student.studentRowId;
  const rowId = await q.value(
    `select id from public.students where profile_id = $1`, [idOf(student)],
  );
  if (!rowId) throw new Error('harness: this user has no `students` row (not linked to a coach)');
  return rowId;
}

/**
 * Create a program tree for a student.
 *
 *   createProgram({ student, exercises, weeks: 2, sessions: 2, sets: 3, active: true })
 *
 *   student    user object or profile uuid (must be linked to a coach)
 *   exercises  exercise_library ids — one slot per id in EVERY session
 *              (default: the first two of the coach's library, by name)
 *   weeks      number of weeks                         (default 1)
 *   sessions   sessions per week                       (default 1)
 *   sets       sets per slot                           (default 3)
 *   status     'approved' | 'draft'                    (default 'approved')
 *   active     programs.is_active                      (default false)
 *   createdBy  profile uuid of a student author        (default null = coach)
 *   submitted  stamp submitted_at (drafts)             (default false)
 *   setLogs    materialize the per-set rows            (default: approved only —
 *              a draft has none until approve_program creates them)
 *
 * Every slot is `sets` × 5 reps @ 20 kg, 120 s rest, and every set_log carries
 * those as target_*. Returns
 *   { id, studentRowId, weeks: [id], sessions: [id], slots: [id], setLogs: [id],
 *     tree: [{ id, sessions: [{ id, slots: [{ id, exerciseId, setLogs: [id] }] }] }] }
 * with the flat arrays in program order.
 */
export function createProgram({
  student,
  name = 'Program',
  exercises,
  weeks = 1,
  sessions = 1,
  sets = 3,
  status = 'approved',
  active = false,
  createdBy = null,
  submitted = false,
  setLogs = status === 'approved',
} = {}) {
  return fixture(async (q) => {
    const studentRowId = await studentRowIdOf(q, student);
    const exerciseIds = exercises ?? (await q.rows(
      `select el.id
         from public.exercise_library el
         join public.students st on st.coach_id = el.coach_id
        where st.id = $1
        order by el.name
        limit 2`,
      [studentRowId],
    )).map((row) => row.id);
    if (exerciseIds.length === 0) {
      throw new Error('createProgram: the coach of this student has an empty exercise library');
    }

    const id = await q.value(
      `insert into public.programs (student_id, name, status, is_active, created_by, submitted_at)
       values ($1, $2, $3, $4, $5, case when $6 then now() end)
       returning id`,
      [studentRowId, name, status, active, idOf(createdBy), submitted],
    );

    const program = { id, studentRowId, weeks: [], sessions: [], slots: [], setLogs: [], tree: [] };

    for (let w = 0; w < weeks; w += 1) {
      const weekId = await q.value(
        `insert into public.weeks (program_id, week_number) values ($1, $2) returning id`,
        [id, w + 1],
      );
      const week = { id: weekId, sessions: [] };
      program.weeks.push(weekId);
      program.tree.push(week);

      for (let s = 0; s < sessions; s += 1) {
        const sessionId = await q.value(
          `insert into public.sessions (week_id, title, sort_order)
           values ($1, $2, $3) returning id`,
          [weekId, `W${w + 1} · S${s + 1}`, s],
        );
        const session = { id: sessionId, slots: [] };
        program.sessions.push(sessionId);
        week.sessions.push(session);

        for (let e = 0; e < exerciseIds.length; e += 1) {
          const slotId = await q.value(
            `insert into public.exercise_slots
               (session_id, exercise_id, sets, reps, weight_kg, rest_seconds, sort_order)
             values ($1, $2, $3, 5, 20, 120, $4) returning id`,
            [sessionId, exerciseIds[e], sets, e],
          );
          const slot = { id: slotId, exerciseId: exerciseIds[e], setLogs: [] };
          program.slots.push(slotId);
          session.slots.push(slot);

          if (setLogs) {
            const rows = await q.rows(
              `insert into public.set_logs
                 (exercise_slot_id, set_number, target_reps, target_weight_kg, target_rest_seconds)
               select $1, n, 5, 20, 120 from generate_series(1, $2::int) as n
               returning id, set_number`,
              [slotId, sets],
            );
            rows.sort((a, b) => a.set_number - b.set_number);
            for (const row of rows) {
              slot.setLogs.push(row.id);
              program.setLogs.push(row.id);
            }
          }
        }
      }
    }

    return program;
  });
}

/**
 * A draft the student authored (Phase 3.4): status 'draft', inactive,
 * created_by = the student, NO set_logs. `options` are createProgram's
 * (`weeks`, `sessions`, `exercises`, `sets`, `name`), plus
 * `submitted: true` to make it a draft awaiting the coach's approval.
 */
export function createDraftProgram(student, options = {}) {
  return createProgram({
    name: 'My draft',
    ...options,
    student,
    status: 'draft',
    active: false,
    createdBy: idOf(student),
    setLogs: false,
  });
}

/**
 * The baseline world. Call it once per file, in `beforeAll`:
 *
 *   coach      one coach
 *   studentA   linked to the coach — ACTIVE approved program "Block A":
 *              2 weeks × 2 sessions × 2 slots (pull-up, dip) × 3 set_logs
 *   studentB   linked to the coach — ACTIVE approved program "Block B":
 *              1 week × 1 session × 2 slots × 3 set_logs
 *   exercises  the coach's library: pullUp, dip (used by both programs),
 *              squat, muscleUp (used by nothing)
 *   messages   coach → A, A → coach (one thread), coach → B
 *
 * Returns
 *   { coach, studentA, studentB,            // createUser() objects
 *     exercises: { pullUp, dip, squat, muscleUp },
 *     programA, programB,                   // createProgram() objects
 *     messages: { coachToA, aToCoach, coachToB } }
 */
export function seed() {
  return fixture(async (q) => {
    const coach = await createUser({ email: 'coach@sl.test', fullName: 'Coach Carla', role: 'coach' });
    const studentA = await createUser({ email: 'alex@sl.test', fullName: 'Alex Athlete', coach });
    const studentB = await createUser({ email: 'billie@sl.test', fullName: 'Billie Athlete', coach });

    const exercises = {};
    for (const [key, name, type, difficulty, loadMode] of [
      ['pullUp', 'Pull-up', 'pull', 2, 'added'],
      ['dip', 'Dip', 'push', 2, 'added'],
      ['squat', 'Squat', 'push', 1, 'full'],
      ['muscleUp', 'Muscle-up', 'pull', 3, null],
    ]) {
      exercises[key] = await q.value(
        `insert into public.exercise_library (coach_id, name, type, difficulty, load_mode)
         values ($1, $2, $3, $4, $5) returning id`,
        [coach.id, name, type, difficulty, loadMode],
      );
    }
    const used = [exercises.pullUp, exercises.dip];

    const programA = await createProgram({
      student: studentA, name: 'Block A', exercises: used, weeks: 2, sessions: 2, active: true,
    });
    const programB = await createProgram({
      student: studentB, name: 'Block B', exercises: used, weeks: 1, sessions: 1, active: true,
    });

    const message = (from, to, body) => q.value(
      `insert into public.messages (sender_id, recipient_id, body) values ($1, $2, $3) returning id`,
      [from.id, to.id, body],
    );
    const messages = {
      coachToA: await message(coach, studentA, 'Welcome to the block, Alex.'),
      aToCoach: await message(studentA, coach, 'Thanks coach!'),
      coachToB: await message(coach, studentB, 'Welcome to the block, Billie.'),
    };

    return { coach, studentA, studentB, exercises, programA, programB, messages };
  });
}

// ------------------------------------------------------------
// Web Push fan-out (pg_net + vault stubs)
// ------------------------------------------------------------

/**
 * Configure the two Vault secrets the notify_* triggers look for. Without
 * them (the default) every trigger skips net.http_post — the "push not
 * configured" branch.
 */
export function enablePush({
  url = 'https://functions.sl.test/functions/v1',
  bearer = 'test-internal-bearer',
} = {}) {
  return fixture(async (q) => {
    await q(`delete from vault.secrets where name in ('app_functions_url', 'app_service_role_key')`);
    await q(`select vault.create_secret($1, 'app_functions_url')`, [url]);
    await q(`select vault.create_secret($1, 'app_service_role_key')`, [bearer]);
  });
}

/**
 * The HTTP requests queued through net.http_post so far, oldest first:
 * `[{ id, method, url, headers, body }]`. Nothing is ever sent.
 */
export function httpCalls() {
  return run(ADMIN, (q) => q.rows(
    `select id, method, url, headers, body from net.http_request_queue order by id`,
  ));
}

// ------------------------------------------------------------
// Databases built from SQL files
// ------------------------------------------------------------

/**
 * A database of its own for this test file, to load SQL files into. It is
 * dropped with the file's other databases when the file is done.
 *
 *   const db = await scratchDatabase();                    // an empty Supabase project
 *   const db = await scratchDatabase({ from: 'schema' });  // a copy of schema.sql
 *
 *   from: 'bare'    shim.sql only — the state of a project before any user
 *                   SQL. Load the production baseline and the migrations into
 *                   it. (default)
 *         'schema'  shim.sql + schema.sql, like the database asUser() & co. use,
 *                   but separate from it.
 *
 * Everything runs as `postgres`, the role the Supabase SQL editor uses, and is
 * COMMITTED — there is no rollback at the end of a call, unlike asAdmin():
 *
 *   db.query(sql, params)   one statement; also db.query.rows / .one / .value
 *   db.runFile(file)        a whole .sql file as one multi-statement query,
 *                           the way the SQL editor sends it. `file` is absolute
 *                           or relative to the repository root. A failure
 *                           names the file and the line, carries the SQLSTATE
 *                           as `code`, and leaves no transaction open.
 *   db.runSql(sql, label)   the same for SQL text
 *   db.readOnly(sql, label) the same inside a READ ONLY transaction that is
 *                           rolled back: any write raises 25006. Resolves to
 *                           the result of each statement of `sql`, in order.
 *   db.drop()               drop it now rather than at the end of the file —
 *                           for a test that builds many
 *
 * asUser() and the other role helpers do not see this database.
 */
export async function scratchDatabase({ from = 'bare' } = {}) {
  const template = { bare: connection.bare, schema: connection.template }[from];
  if (!template) throw new Error(`scratchDatabase: unknown \`from\` "${from}" (expected 'bare' or 'schema')`);
  // Connections are not kept: a file may build a dozen of these, and the
  // server has 60 slots for the whole run.
  const created = await createDatabase(template, { idleTimeoutMillis: 500 });
  scratch.push(created);
  const { name, pool } = created;

  // A file with its own BEGIN that fails halfway leaves the connection inside
  // an aborted transaction; close it before the connection goes back.
  const onOneConnection = async (fn) => {
    const client = await pool.connect();
    try {
      return await fn(client);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  };

  return {
    name,
    query: withShortcuts((text, params) => pool.query(text, params)),
    runSql: (sql, label) => onOneConnection((client) => runSql(client, sql, label)),
    runFile: (file) => onOneConnection(
      (client) => runSqlFile(client, path.resolve(repoRoot, file)),
    ),
    readOnly: (sql, label) => onOneConnection(async (client) => {
      await client.query('BEGIN TRANSACTION READ ONLY');
      const result = await runSql(client, sql, label);
      await client.query('ROLLBACK');
      return Array.isArray(result) ? result : [result];
    }),
    drop: async () => {
      const index = scratch.indexOf(created);
      if (index === -1) return;
      scratch.splice(index, 1);
      await dropDatabase(created);
    },
  };
}
