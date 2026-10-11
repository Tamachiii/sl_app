// The backup, end to end: scripts/backup/ against a real PostgreSQL.
//
// The project is on the free plan, which has no backup of its own. What
// stands between a bad DELETE and the athletes' history is one file written
// by scripts/backup/dump.mjs — so this suite does to that file what an
// incident would: it dumps a database that looks like production, checks the
// file without a database, restores it into a database that only has
// supabase/schema.sql, and compares the two, table by table, in SQL.
//
// The commands are run as the owner runs them — `node scripts/backup/…` in a
// child process, with an environment of their own — and everything they print
// is kept, to check at the end that no line ever held the connection string,
// the database password or the passphrase.
//
// Not covered here, and said so in BACKUPS.md: the Supabase pooler and its TLS
// (nothing in this repository reaches production), and auth.users as GoTrue
// really has it (the suite's stand-in is a subset; see shim.sql).

import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import pg from 'pg';
import {
  afterAll, beforeAll, describe, expect, inject, it,
} from 'vitest';
import { parsePostgresUrl, knownProjectRefs, tlsFor } from '../../scripts/backup/lib/connection.mjs';
import { dumpDatabase } from '../../scripts/backup/lib/dump.mjs';
import { BackupError } from '../../scripts/backup/lib/errors.mjs';
import { readBackup } from '../../scripts/backup/lib/format.mjs';
import {
  CONFIRM_PRODUCTION_REF, CONFIRM_SUPABASE_HOST, refusals, restoreBackup,
} from '../../scripts/backup/lib/restore.mjs';
import { scrub } from '../../scripts/backup/lib/secrets.mjs';
import { BEGIN_SNAPSHOT, assertReadOnlySql, openSnapshot } from '../../scripts/backup/lib/snapshot.mjs';
import { verifyBackup } from '../../scripts/backup/lib/verify.mjs';
import {
  asAdmin, asUser, createDraftProgram, createProgram, repoRoot, scratchDatabase, seed,
} from './harness.js';

const server = inject('slDb');
// The bootstrap superuser of the suite's cluster (postgres.js). Needed for the
// one thing `postgres` cannot do there: create a login role that may read the
// tables of `auth`.
const SUPERUSER = { user: 'supabase_admin', password: 'postgres' };

const PASSPHRASE = `passphrase-${randomBytes(18).toString('hex')}`;
const OTHER_PASSPHRASE = `another-${randomBytes(18).toString('hex')}`;
const READER_PASSWORD = `Pw-${randomBytes(12).toString('hex')}/+@:#?&=%`;
const WRONG_PASSWORD = `Wrong-${randomBytes(12).toString('hex')}`;
const suffix = randomBytes(4).toString('hex');
const READER = `sl_backup_reader_${suffix}`;
const FILTERED = `sl_backup_filtered_${suffix}`;

const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

// ------------------------------------------------------------
// Running the commands
// ------------------------------------------------------------
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-backup-test-'));
const backups = path.join(home, 'sl_app-backups');
const transcript = [];

const urlOf = (database, { user = server.user, password = server.password } = {}) => (
  `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${server.host}:${server.port}/${database}`
);

/**
 * `node scripts/backup/<script> …args` with ONLY `env` (plus PATH and a HOME of
 * its own): nothing of the machine's environment — an owner's SUPABASE_DB_URL,
 * a CI flag — reaches the command. Resolves to `{ code, stdout, stderr, all }`.
 */
function run(script, args = [], env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join('scripts/backup', script), ...args], {
      cwd: repoRoot,
      env: { PATH: process.env.PATH, HOME: home, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      transcript.push(stdout, stderr);
      resolve({ code, stdout, stderr, all: `${stdout}\n${stderr}` });
    });
  });
}

const filesIn = (directory) => (fs.existsSync(directory) ? fs.readdirSync(directory).sort() : []);
const writtenBy = (result) => /^ {2}written {4}(\S+)$/m.exec(result.stdout)?.[1] ?? null;

/** `{ 'public.set_logs': 27, … }` out of the table a command prints. */
function printedCounts(stdout) {
  const counts = {};
  for (const [, name, rows] of stdout.matchAll(/^ {2}([a-z_]+\.[a-z_]+) +([\d,]+)(?: {2}.*)?$/gm)) {
    counts[name] = Number(rows.replace(/,/g, ''));
  }
  return counts;
}

/** Every row of a backup file, parsed, by table name. */
async function rowsOf(file, passphrase = PASSPHRASE) {
  const rows = new Map();
  for await (const entry of readBackup(file, { passphrase })) {
    if (entry.type === 'table') rows.set(entry.table.name, []);
    if (entry.type === 'row') rows.get(entry.table.name).push(JSON.parse(entry.text));
  }
  return rows;
}

// ------------------------------------------------------------
// The databases
// ------------------------------------------------------------

// What the suite's stand-in for Supabase lacks and production has: the
// identities of the accounts (GoTrue's table, with its generated column), and
// a table that is not in schema.sql at all — the next migration's, here with
// every kind of value a text dump can get wrong.
const PLATFORM_AND_PROBE = `
  CREATE TABLE auth.identities (
    provider_id     text NOT NULL,
    user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    identity_data   jsonb NOT NULL,
    provider        text NOT NULL,
    last_sign_in_at timestamptz,
    created_at      timestamptz,
    updated_at      timestamptz,
    email           text GENERATED ALWAYS AS (lower(identity_data ->> 'email')) STORED,
    id              uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    UNIQUE (provider_id, provider)
  );

  CREATE TABLE public.backup_probe (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    serial_no    serial,
    label        text NOT NULL,
    amount       int,
    doubled      int GENERATED ALWAYS AS (amount * 2) STORED,
    raw          bytea,
    big          bigint,
    exact        numeric,
    ratio        double precision,
    small_ratio  real,
    span         interval,
    at_micro     timestamptz,
    local_time   timestamp,
    day          date,
    clock        time,
    tags         text[],
    matrix       int[],
    ids          uuid[],
    doc          jsonb,
    doc_not_null jsonb NOT NULL DEFAULT '{}',
    raw_json     json,
    code         char(3),
    flag         boolean,
    kind         public.exercise_type,
    address      inet,
    "Odd ""Name""" text,
    r            text
  );
`;

const PROBE_ROWS = `
  INSERT INTO public.backup_probe
    (label, amount, raw, big, exact, ratio, small_ratio, span, at_micro, local_time, day, clock,
     tags, matrix, ids, doc, doc_not_null, raw_json, code, flag, kind, address, "Odd ""Name""", r)
  VALUES
    ('every awkward value', 21, '\\x00ff10', 9007199254740993,
     12345678901234567890.123456789012345678901234567890, 0.1::float8 + 0.2::float8, 1.1,
     '1 year 2 mons 3 days 04:05:06.789', '2026-10-03 18:04:05.123456+02', '2026-10-03 18:04:05.5',
     '2024-02-29', '23:59:59.999999',
     ARRAY['a,b', 'with "quotes"', NULL, '', 'back\\slash', E'new\\nline', 'NULL', '{braces}'],
     '{{1,2},{3,4}}', ARRAY['00000000-0000-4000-8000-000000000001'::uuid, NULL],
     '{"b": [1, 2.50, null], "a": {"é": "ü"}, "n": 1e400}', 'null',
     '{ "keeps":   "its spacing", "dup": 1, "dup": 2 }', 'ab', true, 'pull', '10.1.2.3/8',
     'a quoted column', 'a column named like an alias'),
    (E'tab\\there, "quotes", ''apostrophes'', back\\\\slash, emoji 🏋️, line\\nbreak, \\u2028 separator',
     NULL, '', -9223372036854775808, 'NaN', 'Infinity', '-Infinity', '-00:00:00.000001',
     '-infinity', 'infinity', 'infinity', '00:00:00', '{}', NULL, '{}', '"a string"', '[]',
     'null', '', false, 'push', '::1', NULL, NULL),
    ('nothing but nulls', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
     NULL, NULL, NULL, NULL, '{}', NULL, NULL, NULL, NULL, NULL, NULL, NULL),
    ('deleted again', 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
     NULL, NULL, NULL, NULL, '{}', NULL, NULL, NULL, NULL, NULL, NULL, NULL);
  -- The highest id is handed out and gone: the sequence is ahead of the rows.
  DELETE FROM public.backup_probe WHERE label = 'deleted again';
`;

/** A database with supabase/schema.sql and the two tables above, empty — a restore target. */
async function emptyTarget({ platform = true } = {}) {
  const db = await scratchDatabase({ from: 'schema' });
  if (platform) await db.runSql(PLATFORM_AND_PROBE, 'target');
  return { ...db, url: urlOf(db.name) };
}

// Count and an order-independent sum of the rows, as text: the same statement
// on the source and on a restored database must give the same answer.
const SUM = (table) => `
  select count(*)::int as rows,
         md5(coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '')) as sum
    from ${table} t`;

let ids;
let source;      // { name, url }
let tables;      // every table a backup must hold, 'schema.table'

beforeAll(async () => {
  ids = await seed();
  const name = await asAdmin((q) => q.value('select current_database()::text'));
  source = { name, url: urlOf(name) };

  await asAdmin((q) => q(PLATFORM_AND_PROBE), { commit: true });
  await asAdmin((q) => q(PROBE_ROWS), { commit: true });
  // A draft the athlete wrote and sent in: a program without a single set_log.
  await createDraftProgram(ids.studentB, { name: 'Billie’s own block', weeks: 1, sessions: 2, submitted: true });
  const trashed = await createProgram({ student: ids.studentA, name: 'Old block', weeks: 1, sessions: 1 });

  const { coach, studentA, studentB, exercises, programA } = ids;
  const [first, second] = programA.tree[0].sessions;
  const [pullUps, dips] = first.slots;

  // The athlete trains: done, failed, skipped, off-plan, an extra set, a
  // comment, a swap — as the athlete, so the triggers are the app's.
  await asUser(studentA, async (q) => {
    await q(`update set_logs set done = true, rpe = 8, weight_kg = 22.5,
                    logged_at = '2026-09-29 17:05:03.123456+00' where id = $1`, [pullUps.setLogs[0]]);
    await q(`update set_logs set done = true, rpe = 9, actual_reps = 4, actual_weight_kg = 17.25,
                    logged_at = '2026-09-29 17:09:41.000001+00' where id = $1`, [pullUps.setLogs[1]]);
    await q(`update set_logs set failed = true, failed_at = '2026-09-29 17:14:00+00' where id = $1`, [pullUps.setLogs[2]]);
    await q(`update set_logs set skipped = true where id = $1`, [dips.setLogs[0]]);
    await q(`insert into set_logs (exercise_slot_id, set_number, is_student_added, done, weight_kg, actual_reps, logged_at)
             values ($1, 4, true, true, 12.5, 6, '2026-09-29 17:20:00+00')`, [pullUps.id]);
    await q(`insert into slot_comments (exercise_slot_id, student_id, body)
             values ($1, $2, E'Left shoulder felt off.\\nStopped at 4 — "better safe"…')`, [pullUps.id, studentA.id]);
    await q(`insert into slot_deviations (exercise_slot_id, student_id, kind, substitute_exercise_id, note)
             values ($1, $2, 'swap', $3, 'Rings were taken')`, [dips.id, studentA.id, exercises.squat]);
    await q(`insert into slot_deviations (exercise_slot_id, student_id, kind, note)
             values ($1, $2, 'skip', null)`, [second.slots[0].id, studentA.id]);
    await q(`insert into session_confirmations (session_id, student_id, performed_on, notes)
             values ($1, $2, '2026-09-29', 'Tough one 💪')`, [first.id, studentA.id]);
    await q(`insert into bodyweight_logs (student_id, weight_kg, logged_on) values
               ($1, 72.35, '2026-09-22'), ($1, 71.9, '2026-09-29')`, [studentA.id]);
    await q(`insert into messages (sender_id, recipient_id, body)
             values ($1, $2, E'Séance faite — 3×5 @ 22,5 kg.\\n\\tÇa passe; "RPE 8" \\\\o/ 🏋️')`, [studentA.id, coach.id]);
    await q(`insert into push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
             values ($1, 'https://fcm.googleapis.com/fcm/send/abc:def', 'BPk-key', 'auth-secret', 'Mozilla/5.0 (iPhone)')`, [studentA.id]);
    await q(`insert into scheduled_pushes (user_id, fire_at, payload)
             values ($1, '2026-09-29 17:07:03+00', '{"title": "Rest over", "data": {"url": "/sl_app/#/student", "n": 1.50}}')`, [studentA.id]);
    await q(`insert into client_errors (user_id, role, message, stack, url, user_agent)
             values ($1, 'student', 'TypeError: x is undefined', E'at a (app.js:1:2)\\n  at b (app.js:3:4)', '/sl_app/#/student', 'Mozilla/5.0')`, [studentA.id]);
  }, { commit: true });

  // The coach answers, reviews, sets goals, prescribes a filmed set.
  await asUser(coach, async (q) => {
    await q(`update sessions set reviewed_at = '2026-09-30 08:00:00+00' where id = $1`, [first.id]);
    await q(`insert into messages (sender_id, recipient_id, body, session_id)
             values ($1, $2, 'Good session. Keep the shoulder warm.', $3)`, [coach.id, studentA.id, first.id]);
    await q(`update messages set read_at = now() where id = $1`, [ids.messages.aToCoach]);
    await q(
      `insert into goals (student_id, coach_id, exercise_id, kind, target_weight_kg, target_sets, target_reps, notes)
       values ($1, $2, $3, 'format', 40, 3, 5, 'By December')`,
      [studentA.id, coach.id, exercises.pullUp],
    );
    await q(`insert into goals (student_id, coach_id, exercise_id, kind, target_weight_kg, achieved, achieved_at)
             values ($1, $2, $3, 'one_rm', 60, true, '2026-08-01 10:00:00+00')`, [studentB.id, coach.id, exercises.dip]);
    await q(`update exercise_slots set record_video_set_numbers = '{1,3}', notes = 'Film sets 1 and 3',
                    superset_group = gen_random_uuid() where id = $1`, [pullUps.id]);
    await q(`update exercise_library set volume_weight = 0.75 where id = $1`, [exercises.muscleUp]);
    await q(`update students set notes = 'Returning from a shoulder injury' where id = $1`, [studentA.studentRowId]);
    await q(`update sessions set scheduled_date = '2026-10-06', day_number = 2 where id = $1`, [second.id]);
    await q(`update programs set deleted_at = '2026-09-01 00:00:00+00' where id = $1`, [trashed.id]);
  }, { commit: true });

  // What only the platform writes: the accounts as GoTrue keeps them, a video
  // and its object row, and two notifications no trigger would produce.
  await asAdmin(async (q) => {
    await q(`update auth.users
                set encrypted_password = '$2a$10$' || encode(sha256(email::bytea), 'hex'),
                    last_sign_in_at = '2026-09-29 16:59:00.5+00',
                    raw_app_meta_data = '{"provider": "email", "providers": ["email"]}'`);
    await q(`insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
             select id::text, id, jsonb_build_object('sub', id::text, 'email', upper(email), 'email_verified', true),
                    'email', created_at, updated_at
               from auth.users`);
    const video = `${studentA.id}/${pullUps.setLogs[0]}.mp4`;
    await q(`insert into storage.objects (bucket_id, name, owner, metadata, user_metadata)
             values ('set-videos', $1, $2, '{"size": 1048576, "mimetype": "video/mp4", "eTag": "\\"abc\\""}', null)`,
    [video, studentA.id]);
    await q(`insert into set_log_videos (set_log_id, storage_path, mime_type, size_bytes, duration_ms)
             values ($1, $2, 'video/mp4', 1048576, 8300)`, [pullUps.setLogs[0], video]);
    await q(`insert into goal_progress (goal_id, weight_kg, sets, reps, notes)
             select id, 32.5, 3, 5, null from goals where kind = 'format'`);
    // A jsonb column that holds the JSON value null — not SQL NULL.
    await q(`insert into notifications (recipient_id, kind, payload) values ($1, 'legacy', 'null')`, [coach.id]);
    await q(`insert into notifications (recipient_id, kind, payload, read_at)
             values ($1, 'legacy', '{"nested": {"list": [1, "two", null, {"k": 3.10}]}, "ünï": "cödé"}', now())`, [studentA.id]);
  }, { commit: true });

  // Production's ledger is not the checkout's: one migration applied long
  // ago, one this checkout has never heard of, and the newest missing.
  await asAdmin(async (q) => {
    await q(`delete from app_private.app_migrations where name <> '2026_10_03_01_migration_ledger'`);
    await q(`update app_private.app_migrations set applied_at = '2026-10-03 09:00:00+00'`);
    await q(`insert into app_private.app_migrations (name) values ('2027_01_01_99_not_in_this_checkout')`);
  }, { commit: true });

  tables = [
    ...(await asAdmin((q) => q.rows(
      `select 'public.' || tablename as name from pg_tables where schemaname = 'public' order by 1`,
    ))).map((row) => row.name),
    'auth.users', 'auth.identities', 'storage.buckets', 'storage.objects',
  ];

  // Two login roles of the cluster, made by its superuser.
  const admin = new pg.Client({ host: server.host, port: server.port, ...SUPERUSER, database: 'postgres' });
  await admin.connect();
  try {
    // Reads everything, as its own user, with a password that is nowhere else.
    await admin.query(`CREATE ROLE ${READER} LOGIN BYPASSRLS PASSWORD '${READER_PASSWORD}'`);
    // Reads everything too — except through the row-level security of a table
    // it does not own, which is every table of auth.
    await admin.query(`CREATE ROLE ${FILTERED} LOGIN NOBYPASSRLS PASSWORD '${READER_PASSWORD}'`);
    await admin.query(`GRANT postgres TO ${READER}, ${FILTERED}`);
  } finally {
    await admin.end();
  }
});

afterAll(async () => {
  fs.rmSync(home, { recursive: true, force: true });
  const admin = new pg.Client({ host: server.host, port: server.port, ...SUPERUSER, database: 'postgres' });
  await admin.connect();
  try {
    await admin.query(`DROP ROLE IF EXISTS ${READER}, ${FILTERED}`);
  } finally {
    await admin.end();
  }
});

const sums = (query) => Promise.all(tables.map(async (table) => [table, await query(SUM(table))]))
  .then(Object.fromEntries);
const sourceSums = () => asAdmin((q) => sums((sql) => q.one(sql)));

// ------------------------------------------------------------
// Dump → verify → restore
// ------------------------------------------------------------
describe('a backup, from the dump to the restore', () => {
  let file;
  let before;
  let target;

  it('the seed looks like production: every table of the app holds rows', async () => {
    before = await sourceSums();
    const empty = Object.entries(before).filter(([, { rows }]) => rows === 0).map(([name]) => name);
    expect(empty).toEqual([]);
    expect(tables).toContain('public.backup_probe');
    expect(tables.length).toBeGreaterThanOrEqual(25);
  });

  it('dump writes ONE encrypted file, outside the repository, and prints a count per table', async () => {
    const result = await run('dump.mjs', [], { SUPABASE_DB_URL: source.url, BACKUP_PASSPHRASE: PASSPHRASE });
    expect(result.all).not.toContain('FAILED');
    expect(result.code).toBe(0);

    expect(filesIn(backups)).toHaveLength(1);
    const [name] = filesIn(backups);
    expect(name).toMatch(/^sl_app-\d{8}T\d{6}Z\.jsonl\.gz\.enc$/);
    file = path.join(backups, name);
    expect(writtenBy(result)).toBe(file);
    expect(path.relative(repoRoot, file).startsWith('..')).toBe(true);
    // Readable by the owner alone, in a directory nobody else can list.
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(backups).mode & 0o777).toBe(0o700);
    // `openssl enc` format; nothing of the content in clear.
    const bytes = fs.readFileSync(file);
    expect(bytes.subarray(0, 8).toString('latin1')).toBe('Salted__');
    expect(bytes.includes(Buffer.from('alex@sl.test'))).toBe(false);

    // The printed counts are the counts of the database, table for table —
    // the migration ledger included, and a table schema.sql does not know.
    const printed = printedCounts(result.stdout);
    expect(printed).toEqual({
      ...Object.fromEntries(Object.entries(before).map(([table, { rows }]) => [table, rows])),
      'app_private.app_migrations': 2,
    });
    expect(result.stdout).toMatch(/read back {2}\d+ tables, [\d,]+ rows, every checksum matches/);
    expect(result.stdout).toContain('one read-only transaction, repeatable read');
  });

  it('verify checks the file with no database at hand', async () => {
    // No database variable at all: the command cannot connect to anything.
    const result = await run('verify.mjs', [], { BACKUP_PASSPHRASE: PASSPHRASE });
    expect(result.all).not.toContain('FAILED');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(file);
    expect(result.stdout).toMatch(/OK +\d+ tables, [\d,]+ rows/);
    expect(printedCounts(result.stdout)['public.set_logs']).toBe(before['public.set_logs'].rows);

    // The header says what is needed to find the structure again.
    const { header, trailer } = await verifyBackup({ file, passphrase: PASSPHRASE });
    expect(header.format).toBe('sl_app-backup');
    expect(header.source.server_version).toMatch(/^17\./);
    expect(header.repository.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(header.repository.schema_sql_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(header.tables.find((table) => table.name === 'public.set_logs').columns.map((column) => column.name))
      .toEqual(expect.arrayContaining(['id', 'exercise_slot_id', 'actual_weight_kg', 'logged_at']));
    expect(trailer.complete).toBe(true);
    // It says where the rows came from — the host — and not how to get in.
    expect(header.source).toMatchObject({ host: server.host, user: 'postgres', database: source.name, role: 'postgres' });
    expect(JSON.stringify(header)).not.toContain('://');
  });

  it('restore gives every row back, into a database that only had the schema', async () => {
    target = await emptyTarget();
    const ledgerBefore = await target.query.rows(`select * from app_private.app_migrations order by name`);

    const result = await run('restore.mjs', ['--db-url', target.url], { BACKUP_PASSPHRASE: PASSPHRASE });
    expect(result.all).not.toContain('FAILED');
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/RESTORED +\d+ tables/);
    expect(result.stdout).toContain('committed.');
    expect(result.stdout).not.toContain('row count only');
    expect(result.stderr).not.toContain('NOT LOADED');

    // Table by table, in SQL, with a statement that knows nothing of the tool.
    const after = await sums((sql) => target.query.one(sql));
    expect(after).toEqual(before);
    // Accounts included: the hashes are what make a restored login work.
    expect(after['auth.users'].rows).toBe(3);
    expect(await target.query.value(`select count(*)::int from auth.users where encrypted_password like '$2a$10$%'`)).toBe(3);
    // One profile per account: the insert into auth.users did not fire
    // handle_new_user() a second time.
    expect(after['public.profiles'].rows).toBe(3);

    // The ledger says what the STRUCTURE of the target is. It is left alone,
    // and the two are printed side by side.
    expect(ledgerBefore.length).toBeGreaterThanOrEqual(2);
    expect(await target.query.rows(`select * from app_private.app_migrations order by name`)).toEqual(ledgerBefore);
    expect(result.stdout).toContain('in the backup   2026_10_03_01_migration_ledger, 2027_01_01_99_not_in_this_checkout');
    expect(result.stdout).toContain(`in the target   ${ledgerBefore.map((row) => row.name).join(', ')}`);
    expect(result.stderr).toContain('WARNING: the backup comes from a database that had 2027_01_01_99_not_in_this_checkout; the target does not.');
  });

  it('keeps the values a text dump gets wrong', async () => {
    const probe = (label) => target.query.one(
      `select *, doc_not_null is null as sql_null, jsonb_typeof(doc_not_null) as json_type,
              raw_json::text as raw_json_text, exact::text as exact_text, ratio::text as ratio_text,
              encode(raw, 'hex') as raw_hex, at_micro::text as at_text, span::text as span_text,
              big::text as big_text, tags::text as tags_text, matrix::text as matrix_text
         from public.backup_probe where label like $1`, [label],
    );
    const awkward = await probe('every awkward value');
    // A jsonb column holding JSON null is not SQL NULL (and the column is NOT NULL).
    expect(awkward).toMatchObject({ sql_null: false, json_type: 'null' });
    expect(awkward.raw_json_text).toBe('{ "keeps":   "its spacing", "dup": 1, "dup": 2 }');
    expect(awkward.exact_text).toBe('12345678901234567890.123456789012345678901234567890');
    expect(awkward.big_text).toBe('9007199254740993');
    expect(awkward.ratio_text).toBe('0.30000000000000004');
    expect(awkward.raw_hex).toBe('00ff10');
    expect(awkward.at_text).toBe('2026-10-03 16:04:05.123456+00');
    expect(awkward.span_text).toBe('1 year 2 mons 3 days 04:05:06.789');
    expect(awkward.tags).toEqual(['a,b', 'with "quotes"', null, '', 'back\\slash', 'new\nline', 'NULL', '{braces}']);
    expect(awkward.matrix_text).toBe('{{1,2},{3,4}}');
    expect(awkward.doubled).toBe(42);
    expect(awkward['Odd "Name"']).toBe('a quoted column');

    const extremes = await probe('tab%');
    expect(extremes.label).toContain('emoji 🏋️, line\nbreak,   separator');
    expect(extremes).toMatchObject({ exact_text: 'NaN', ratio_text: 'Infinity', raw_hex: '', tags: [], json_type: 'array' });
    expect(extremes.big_text).toBe('-9223372036854775808');

    // From the app's own tables.
    expect(await target.query.value(`select jsonb_typeof(payload) from public.notifications where kind = 'legacy' and read_at is null`)).toBe('null');
    expect(await target.query.value(`select record_video_set_numbers::text from public.exercise_slots where notes = 'Film sets 1 and 3'`)).toBe('{1,3}');
    expect(await target.query.value(`select logged_at::text from public.set_logs where rpe = 8`)).toBe('2026-09-29 17:05:03.123456+00');
    expect(await target.query.value(`select weight_kg::text from public.bodyweight_logs where logged_on = '2026-09-29'`)).toBe('71.90');
    // Generated by the target from what was loaded, never loaded itself.
    expect(await target.query.value(`select email from auth.identities order by email limit 1`)).toBe('alex@sl.test');
    expect(await target.query.value(`select path_tokens[2] from storage.objects`)).toMatch(/\.mp4$/);
  });

  it('leaves the sequences past every id that was ever handed out', async () => {
    // Three rows are left, and a fourth id was used and deleted before the dump.
    expect(await target.query.value(`select max(id)::int from public.backup_probe`)).toBe(3);
    const next = await target.query.one(
      `insert into public.backup_probe (label) values ('after the restore') returning id::int, serial_no`,
    );
    expect(next).toEqual({ id: 5, serial_no: 5 });
  });

  it('the row triggers of the app are back at work afterwards', async () => {
    // session_replication_role was set for the transaction of the restore only.
    expect(await target.query.value(`show session_replication_role`)).toBe('origin');
    const profiles = await target.query.value(`select count(*)::int from public.profiles`);
    await target.query(`insert into auth.users (email, aud, role) values ('new@sl.test', 'authenticated', 'authenticated')`);
    expect(await target.query.value(`select count(*)::int from public.profiles`)).toBe(profiles + 1);
  });

  it('a second run refuses a target that holds rows, and replaces them when told to', async () => {
    const refused = await run('restore.mjs', [file, '--db-url', target.url], { BACKUP_PASSPHRASE: PASSPHRASE });
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('The target is not empty');
    expect(refused.stderr).toContain('--replace-existing-rows');
    // Refused means untouched: the account made by the test above is still there.
    expect(await target.query.value(`select count(*)::int from auth.users where email = 'new@sl.test'`)).toBe(1);

    const replaced = await run(
      'restore.mjs', [file, '--db-url', target.url, '--replace-existing-rows'], { BACKUP_PASSPHRASE: PASSPHRASE },
    );
    expect(replaced.all).not.toContain('FAILED');
    expect(replaced.code).toBe(0);
    expect(await sums((sql) => target.query.one(sql))).toEqual(before);
  });
});

// ------------------------------------------------------------
// The file
// ------------------------------------------------------------
describe('the file', () => {
  let encrypted;
  let clear;

  beforeAll(async () => {
    const directory = path.join(home, 'files');
    const one = await run('dump.mjs', ['--out', `${directory}/`], { SUPABASE_DB_URL: source.url, BACKUP_PASSPHRASE: PASSPHRASE });
    encrypted = writtenBy(one);
    const two = await run('dump.mjs', ['--out', path.join(directory, 'clear.jsonl.gz'), '--no-encrypt'], { SUPABASE_DB_URL: source.url });
    clear = writtenBy(two);
    expect([one.code, two.code]).toEqual([0, 0]);
    // The loud note comes with the clear file, on stderr, and only with it.
    expect(two.stderr).toContain('NOT ENCRYPTED');
    expect(two.stderr).toContain('password hashes');
    expect(one.stderr).not.toContain('NOT ENCRYPTED');
  });

  const copyWith = (file, change, name) => {
    const copy = path.join(home, 'files', name);
    fs.writeFileSync(copy, change(Buffer.from(fs.readFileSync(file))));
    return copy;
  };
  const failure = (file, passphrase = PASSPHRASE) => verifyBackup({ file, passphrase }).then(
    () => null,
    (err) => err.message,
  );
  // The text of a clear backup, changed, packed again as a valid gzip file.
  const rewritten = (change, name) => copyWith(clear, (bytes) => {
    const lines = zlib.gunzipSync(bytes).toString('utf8').split('\n').filter(Boolean);
    return zlib.gzipSync(`${change(lines).join('\n')}\n`);
  }, name);

  it('is one line of JSON per row, and the same rows whether encrypted or not', async () => {
    expect(fs.readFileSync(clear).subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
    const lines = zlib.gunzipSync(fs.readFileSync(clear)).toString('utf8').trimEnd().split('\n');
    expect(Object.keys(JSON.parse(lines[0]))).toEqual(['header']);
    expect(Object.keys(JSON.parse(lines.at(-1)))).toEqual(['trailer']);
    const kinds = new Set(lines.map((line) => Object.keys(JSON.parse(line))[0]));
    expect([...kinds].sort()).toEqual(['end', 'header', 'row', 'table', 'trailer']);
    // A value is the text PostgreSQL prints, or null — never a JSON number.
    const row = lines.map((line) => JSON.parse(line).row).find((value) => value?.rpe === '8');
    expect(row).toMatchObject({ weight_kg: '22.50', done: 'true', actual_reps: null, logged_at: '2026-09-29 17:05:03.123456+00' });
    for (const line of lines) {
      const { row: value } = JSON.parse(line);
      if (value) expect(Object.values(value).every((v) => v === null || typeof v === 'string')).toBe(true);
    }

    // Two dumps of the same data: the same checksums, table for table.
    const a = await verifyBackup({ file: encrypted, passphrase: PASSPHRASE });
    const b = await verifyBackup({ file: clear });
    expect(a.encrypted).toBe(true);
    expect(b.encrypted).toBe(false);
    expect(a.tables).toEqual(b.tables);
  });

  // Why the rows are text, column by column, and not row_to_json() of the row.
  it('row_to_json() alone would print a jsonb null and a SQL NULL the same way', async () => {
    const printed = await asAdmin((q) => q.one(
      `select row_to_json(t)::text as plain,
              row_to_json((select x from (select t.a::text as a, t.b::text as b) x))::text as as_text
         from (select 'null'::jsonb as a, null::jsonb as b) t`,
    ));
    expect(printed.plain).toBe('{"a":null,"b":null}');
    expect(printed.as_text).toBe('{"a":"null","b":null}');
  });

  it.skipIf(!hasOpenssl)('opens with the openssl command BACKUPS.md gives, and nothing else', () => {
    const page = fs.readFileSync(path.join(repoRoot, 'BACKUPS.md'), 'utf8');
    const [command] = /^openssl enc -d [^\n]+$/m.exec(page) ?? [];
    expect(command, 'BACKUPS.md has no `openssl enc -d …` line').toBeTruthy();
    expect(command).toContain('"$BACKUP_FILE"');
    expect(command).toContain('-pass env:BACKUP_PASSPHRASE');
    const out = execFileSync('bash', ['-c', command], {
      env: { PATH: process.env.PATH, BACKUP_FILE: encrypted, BACKUP_PASSPHRASE: PASSPHRASE },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const first = JSON.parse(out.split('\n')[0]);
    expect(first.header.format).toBe('sl_app-backup');
  });

  it.skipIf(!hasOpenssl)('a clear backup encrypted by openssl itself is a backup verify accepts', async () => {
    const byOpenssl = path.join(home, 'files', 'by-openssl.jsonl.gz.enc');
    execFileSync('openssl', [
      'enc', '-aes-256-cbc', '-pbkdf2', '-iter', '200000', '-md', 'sha256', '-salt',
      '-pass', 'env:BACKUP_PASSPHRASE', '-in', clear, '-out', byOpenssl,
    ], { env: { PATH: process.env.PATH, BACKUP_PASSPHRASE: PASSPHRASE } });
    const checked = await verifyBackup({ file: byOpenssl, passphrase: PASSPHRASE });
    expect(checked.tables).toEqual((await verifyBackup({ file: clear })).tables);
  });

  it('verify fails on a wrong passphrase, and on none', async () => {
    expect(await failure(encrypted, OTHER_PASSPHRASE)).toMatch(/cannot be decrypted/);
    expect(await failure(encrypted, null)).toMatch(/is encrypted: set BACKUP_PASSPHRASE/);
    const result = await run('verify.mjs', [encrypted], { BACKUP_PASSPHRASE: OTHER_PASSPHRASE });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('FAILED: The file cannot be decrypted');
    expect(result.stdout).not.toMatch(/\bOK\b/);
  });

  it('verify fails on one flipped byte, wherever it is', async () => {
    const { size } = fs.statSync(encrypted);
    // The salt, the first block, the middle, the last block, the last byte.
    for (const at of [9, 16, 40, Math.floor(size / 2), size - 17, size - 1]) {
      const copy = copyWith(encrypted, (bytes) => { bytes[at] ^= 0x01; return bytes; }, `flipped-${at}.jsonl.gz.enc`);
      expect(await failure(copy), `byte ${at} of ${size} flipped`).toMatch(/cannot be decrypted|damaged|cut short|altered/);
    }
    const clearSize = fs.statSync(clear).size;
    const copy = copyWith(clear, (bytes) => { bytes[Math.floor(clearSize / 2)] ^= 0x01; return bytes; }, 'flipped-clear.jsonl.gz');
    expect(await failure(copy, null)).toMatch(/damaged|cut short|altered/);

    const result = await run('verify.mjs', [copy], {});
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('FAILED');
  });

  it('verify fails on a file that was cut short', async () => {
    const { size } = fs.statSync(encrypted);
    for (const length of [0, 8, 16, 32, Math.floor(size / 2) & ~15, size - 16, size - 1]) {
      const copy = copyWith(encrypted, (bytes) => bytes.subarray(0, length), `cut-${length}.jsonl.gz.enc`);
      expect(await failure(copy), `cut to ${length} of ${size} bytes`).toBeTruthy();
    }
    const copy = copyWith(clear, (bytes) => bytes.subarray(0, bytes.length - 20), 'cut-clear.jsonl.gz');
    expect(await failure(copy, null)).toMatch(/damaged or cut short/);
  });

  it('verify fails on a valid file that says something else than its trailer', async () => {
    const isRowOf = (table) => {
      let inside = false;
      return (line) => {
        if (line.startsWith('{"table":')) inside = JSON.parse(line).table.name === table;
        return inside && line.startsWith('{"row":');
      };
    };
    // A dump that stopped before its end.
    expect(await failure(rewritten((lines) => lines.slice(0, -1), 'no-trailer.jsonl.gz'), null))
      .toMatch(/cut short: it has no trailer/);
    // A row taken out.
    const drop = isRowOf('public.set_logs');
    let dropped = false;
    expect(await failure(rewritten((lines) => lines.filter((line) => {
      if (dropped || !drop(line)) return true;
      dropped = true;
      return false;
    }), 'row-removed.jsonl.gz'), null)).toMatch(/public\.set_logs holds \d+ rows, and its end line says \d+/);
    // A value changed, the length kept.
    expect(await failure(rewritten((lines) => lines.map(
      (line) => (line.startsWith('{"row":') ? line.replace('"full_name":"Alex Athlete"', '"full_name":"Alex Athlexe"') : line),
    ), 'value-changed.jsonl.gz'), null)).toMatch(/rows of public\.profiles do not match their checksum/);
    // A row taken out and the end line of its table corrected to match: the
    // trailer still says what the dump wrote.
    const consistent = rewritten((lines) => {
      const out = [];
      const inMessages = isRowOf('public.messages');
      const kept = [];
      let removed = false;
      for (const line of lines) {
        if (inMessages(line)) {
          if (!removed) { removed = true; continue; }
          kept.push(line.slice('{"row":'.length, -1));
        }
        if (line.startsWith('{"end":{"name":"public.messages"')) {
          const sha256 = createHash('sha256').update(kept.map((row) => `${row}\n`).join('')).digest('hex');
          out.push(JSON.stringify({ end: { name: 'public.messages', rows: kept.length, sha256 } }));
        } else {
          out.push(line);
        }
      }
      return out;
    }, 'end-line-corrected.jsonl.gz');
    expect(await failure(consistent, null)).toMatch(/the trailer and the rows of public\.messages disagree/);
    // Something added after the end.
    expect(await failure(rewritten((lines) => [...lines, '{"table":{"name":"public.profiles"}}'], 'after-trailer.jsonl.gz'), null))
      .toMatch(/content after the trailer/);
    // Not a backup at all.
    const other = path.join(home, 'files', 'other.gz');
    fs.writeFileSync(other, zlib.gzipSync('{"hello":"world"}\n'));
    expect(await failure(other, null)).toBeTruthy();
    fs.writeFileSync(other, 'plain text');
    expect(await failure(other, null)).toMatch(/is not a backup/);
  });

  it('gets the name of a backup only after it was read back from the disk', async () => {
    const file = path.join(home, 'files', 'named-last.jsonl.gz.enc');
    const connection = parsePostgresUrl(source.url, 'test');
    // What the dump reads back, and under which names the file is then.
    let readBack = null;
    const verify = async (asked) => {
      readBack = { ...asked, named: fs.existsSync(file) };
      return verifyBackup(asked);
    };
    const result = await dumpDatabase({ connection, file, passphrase: PASSPHRASE, env: {}, verify });
    expect(readBack).toEqual({ file: `${file}.partial`, passphrase: PASSPHRASE, named: false });
    expect(result.readBack).toEqual({ tables: result.tables.length, totalRows: result.totalRows });
    expect(filesIn(path.join(home, 'files')).filter((name) => name.startsWith('named-last'))).toEqual(['named-last.jsonl.gz.enc']);

    // A disk that gives back something else: the file is kept to look at, and
    // never under a name that verify, the drill or a restore would pick up.
    const unread = path.join(home, 'files', 'unread.jsonl.gz.enc');
    await expect(dumpDatabase({
      connection,
      file: unread,
      passphrase: PASSPHRASE,
      env: {},
      verify: async () => { throw new BackupError('The backup is damaged or was altered: said the test.'); },
    })).rejects.toThrow(`does not read back (kept as ${unread}.failed): The backup is damaged or was altered: said the test.`);
    expect(filesIn(path.join(home, 'files')).filter((name) => name.startsWith('unread'))).toEqual(['unread.jsonl.gz.enc.failed']);
  });

  it('a damaged file never reaches the database of a restore', async () => {
    const target = await emptyTarget();
    const copy = copyWith(encrypted, (bytes) => { bytes[bytes.length - 40] ^= 0xff; return bytes; }, 'damaged.jsonl.gz.enc');
    const result = await run('restore.mjs', [copy, '--db-url', target.url], { BACKUP_PASSPHRASE: PASSPHRASE });
    expect(result.code).toBe(1);
    expect(await target.query.value(`select count(*)::int from public.profiles`)).toBe(0);
    expect(await target.query.value(`select count(*)::int from storage.buckets`)).toBe(1);
  });
});

// ------------------------------------------------------------
// What a dump refuses, and what it cannot do
// ------------------------------------------------------------
describe('what a dump refuses', () => {
  const never = path.join(home, 'never');
  const dump = (args, env) => run('dump.mjs', ['--out', `${never}/`, ...args], env);

  it('no passphrase and no --no-encrypt: nothing is written', async () => {
    const result = await dump([], { SUPABASE_DB_URL: source.url });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('BACKUP_PASSPHRASE is not set');
    expect(result.stderr).toContain('--no-encrypt');
    expect(filesIn(never)).toEqual([]);
  });

  it('a passphrase somebody could guess, or one that is not the string that was written down', async () => {
    const result = await dump([], { SUPABASE_DB_URL: source.url, BACKUP_PASSPHRASE: 'correct horse' });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('shorter than 20 characters');
    // A secret pasted into a web form with the line break behind it.
    const pasted = await dump([], { SUPABASE_DB_URL: source.url, BACKUP_PASSPHRASE: `${OTHER_PASSPHRASE}\n` });
    expect(pasted.code).toBe(2);
    expect(pasted.stderr).toContain('starts or ends with a space or a line break');
    expect(filesIn(never)).toEqual([]);
  });

  it('a clear file on a CI runner', async () => {
    for (const ci of [{ CI: 'true' }, { GITHUB_ACTIONS: 'true' }]) {
      const result = await dump(['--no-encrypt'], { SUPABASE_DB_URL: source.url, BACKUP_PASSPHRASE: PASSPHRASE, ...ci });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('--no-encrypt on a CI runner: refused');
    }
    expect(filesIn(never)).toEqual([]);
  });

  it('a file inside the repository', async () => {
    const inside = path.join(repoRoot, `backup-probe-${suffix}`);
    for (const out of [`${inside}/`, path.join(inside, 'x.jsonl.gz.enc'), path.join(repoRoot, 'supabase', 'x.jsonl.gz.enc')]) {
      const result = await run('dump.mjs', ['--out', out], { SUPABASE_DB_URL: source.url, BACKUP_PASSPHRASE: PASSPHRASE });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('is inside the repository');
    }
    // Not even the directory was made.
    expect(fs.existsSync(inside)).toBe(false);
  });

  it('no database named, and a URL that is not one', async () => {
    const none = await dump([], { BACKUP_PASSPHRASE: PASSPHRASE });
    expect(none.code).toBe(2);
    expect(none.stderr).toContain('set SUPABASE_DB_PASSWORD');
    expect(none.stderr).toContain('SUPABASE_DB_URL');

    const secret = `not-a-url-${WRONG_PASSWORD}`;
    const bad = await dump([], { BACKUP_PASSPHRASE: PASSPHRASE, SUPABASE_DB_URL: secret });
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('SUPABASE_DB_URL is not a PostgreSQL connection URL');
    expect(bad.all).not.toContain(secret);

    // A password without the pooler URL the CLI would have written.
    const unlinked = await dump([], {
      BACKUP_PASSPHRASE: PASSPHRASE, SUPABASE_DB_PASSWORD: WRONG_PASSWORD, SUPABASE_POOLER_URL_FILE: path.join(home, 'missing'),
    });
    expect(unlinked.code).toBe(2);
    expect(unlinked.stderr).toContain('supabase link');
    expect(filesIn(never)).toEqual([]);
  });

  it('a database that is not the app: a table of the accounts is missing', async () => {
    // schema.sql on the suite's stand-in, which has no auth.identities.
    const bare = await emptyTarget({ platform: false });
    const result = await dump([], { SUPABASE_DB_URL: bare.url, BACKUP_PASSPHRASE: PASSPHRASE });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('auth.identities does not exist in this database; nothing was written');
    expect(filesIn(never)).toEqual([]);
  });

  it('an empty database, when rows are required', async () => {
    const empty = await emptyTarget();
    const required = await dump(['--require-rows'], { SUPABASE_DB_URL: empty.url, BACKUP_PASSPHRASE: PASSPHRASE });
    expect(required.code).toBe(1);
    expect(required.stderr).toContain('auth.users and public.profiles are empty');
    expect(filesIn(never)).toEqual([]);

    // Without the flag it is a backup of an empty database, and says so.
    const allowed = await run('dump.mjs', ['--out', `${path.join(home, 'empty')}/`], { SUPABASE_DB_URL: empty.url, BACKUP_PASSPHRASE: PASSPHRASE });
    expect(allowed.code).toBe(0);
    expect(allowed.stderr).toContain('WARNING: auth.users and public.profiles are empty');
  });

  it('a wrong password or a server that is not there: an error, no file, and neither in the output', async () => {
    const wrong = await dump([], { SUPABASE_DB_URL: urlOf(source.name, { password: WRONG_PASSWORD }), BACKUP_PASSPHRASE: PASSPHRASE });
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toContain('FAILED');
    expect(wrong.stderr).toContain('28P01');
    expect(wrong.all).not.toContain(WRONG_PASSWORD);

    const closed = await new Promise((resolve) => {
      const probe = net.createServer().listen(0, '127.0.0.1', () => {
        const { port } = probe.address();
        probe.close(() => resolve(port));
      });
    });
    const nobody = await dump([], {
      SUPABASE_DB_URL: `postgres://postgres:${WRONG_PASSWORD}@127.0.0.1:${closed}/postgres`, BACKUP_PASSPHRASE: PASSPHRASE,
    });
    expect(nobody.code).toBe(1);
    expect(nobody.stderr).toContain('ECONNREFUSED');
    expect(nobody.all).not.toContain(WRONG_PASSWORD);
    expect(filesIn(never)).toEqual([]);
  });

  it('a server without TLS when TLS is asked for: it stops before the password is sent', async () => {
    // A server that answers the TLS request of the PostgreSQL protocol with "no".
    const received = [];
    const fake = net.createServer((socket) => {
      socket.on('data', (chunk) => {
        received.push(chunk);
        socket.write('N');
      });
      socket.on('error', () => {});
    });
    await new Promise((resolve) => { fake.listen(0, '127.0.0.1', resolve); });
    try {
      const result = await dump([], {
        SUPABASE_DB_URL: `postgres://postgres:${WRONG_PASSWORD}@127.0.0.1:${fake.address().port}/postgres?sslmode=require`,
        BACKUP_PASSPHRASE: PASSPHRASE,
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('does not support SSL');
      // The 8 bytes of the SSLRequest, and not one more: no user, no password.
      const bytes = Buffer.concat(received);
      expect(bytes).toHaveLength(8);
      expect(bytes.readInt32BE(4)).toBe(80877103);
    } finally {
      await new Promise((resolve) => { fake.close(resolve); });
    }
    expect(filesIn(never)).toEqual([]);
  });

  it('a server that quotes the password back in its error: still not printed', async () => {
    // Enough of the PostgreSQL protocol to ask for the password in clear and
    // then refuse it with a message that repeats it.
    const int32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
    let sent = null;
    const fake = net.createServer((socket) => {
      let asked = false;
      socket.on('error', () => {});
      socket.on('data', (chunk) => {
        if (!asked) {
          asked = true;
          socket.write(Buffer.concat([Buffer.from('R'), int32(8), int32(3)]));   // AuthenticationCleartextPassword
          return;
        }
        sent = chunk.subarray(5, chunk.length - 1).toString('utf8');               // PasswordMessage
        const fields = Buffer.from(`SFATAL\0VFATAL\0C28P01\0Mpassword "${sent}" is not accepted here\0\0`);
        socket.end(Buffer.concat([Buffer.from('E'), int32(4 + fields.length), fields]));
      });
    });
    await new Promise((resolve) => { fake.listen(0, '127.0.0.1', resolve); });
    try {
      const result = await dump([], {
        SUPABASE_DB_URL: `postgres://postgres:${WRONG_PASSWORD}@127.0.0.1:${fake.address().port}/postgres`,
        BACKUP_PASSPHRASE: PASSPHRASE,
      });
      // The password did reach that server, and the server's words did reach the output…
      expect(sent).toBe(WRONG_PASSWORD);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('FAILED: password "[hidden]" is not accepted here (28P01)');
      // …without it.
      expect(result.all).not.toContain(WRONG_PASSWORD);
    } finally {
      await new Promise((resolve) => { fake.close(resolve); });
    }
  });

  it('decides about TLS as documented: on for anything remote, never silently off', () => {
    const remote = { host: 'aws-0-eu-west-1.pooler.supabase.com' };
    expect(tlsFor({ ...remote, params: {} }).ssl).toEqual({ rejectUnauthorized: false });
    expect(tlsFor({ ...remote, params: {} }).says).toContain('certificate not checked');
    expect(tlsFor({ ...remote, params: { sslmode: 'verify-full' } }).ssl).toEqual({ rejectUnauthorized: true });
    expect(tlsFor({ ...remote, params: { sslmode: 'disable' } })).toEqual({ ssl: false, says: 'no TLS (sslmode=disable)' });
    expect(tlsFor({ host: '127.0.0.1', params: {} }).ssl).toBe(false);
    expect(tlsFor({ host: '127.0.0.1', params: { sslmode: 'require' } }).ssl).toEqual({ rejectUnauthorized: false });
    // With the CA file of the project, the certificate is checked.
    const ca = path.join(home, 'ca.crt');
    fs.writeFileSync(ca, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');
    const checked = tlsFor({ ...remote, params: {} }, { PGSSLROOTCERT: ca });
    expect(checked.ssl).toMatchObject({ rejectUnauthorized: true });
    expect(checked.ssl.ca).toContain('BEGIN CERTIFICATE');
    expect(() => tlsFor({ ...remote, params: {} }, { PGSSLROOTCERT: path.join(home, 'no-such.crt') })).toThrow(/cannot be read/);
    // That file in the environment asks every server for TLS, a local one too.
    // sslmode=disable is the one thing above it: what the drill says of the
    // server it started itself, and what a local scratch target needs.
    expect(tlsFor({ host: '127.0.0.1', params: {} }, { PGSSLROOTCERT: ca }).ssl).toMatchObject({ rejectUnauthorized: true });
    expect(tlsFor({ host: '127.0.0.1', params: { sslmode: 'disable' } }, { PGSSLROOTCERT: ca }).ssl).toBe(false);
  });
});

describe('a dump as another role', () => {
  let poolerUrl;
  beforeAll(() => {
    // What `supabase link` leaves in supabase/.temp/pooler-url: no password.
    poolerUrl = path.join(home, 'pooler-url');
    fs.writeFileSync(poolerUrl, `postgresql://${READER}@${server.host}:${server.port}/${source.name}\n`);
  });

  it('builds the connection from SUPABASE_DB_PASSWORD and the pooler URL of the CLI, and prints neither', async () => {
    const result = await run('dump.mjs', ['--out', `${path.join(home, 'reader')}/`], {
      SUPABASE_DB_PASSWORD: READER_PASSWORD, SUPABASE_POOLER_URL_FILE: poolerUrl, BACKUP_PASSPHRASE: PASSPHRASE,
    });
    expect(result.all).not.toContain('FAILED');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('SUPABASE_DB_PASSWORD + pooler-url');
    // Who it read as, and where: how the owner sees it is the right project.
    expect(result.stdout).toContain(`source     ${READER} at ${server.host} (`);
    expect(result.stdout).toContain(`role ${READER}`);
    expect(result.all).not.toContain(READER_PASSWORD);
    expect(result.all).not.toContain(encodeURIComponent(READER_PASSWORD));
    expect(result.all).not.toContain(PASSPHRASE);
    // The same rows as `postgres` reads.
    const mine = await verifyBackup({ file: writtenBy(result), passphrase: PASSPHRASE });
    const counts = await sourceSums();
    for (const table of tables) {
      expect(mine.tables.find(({ name }) => name === table).rows, table).toBe(counts[table].rows);
    }
  });

  it('a role that row-level security filters gets an error, not a smaller backup', async () => {
    // What that role sees of the accounts with row security left on: nothing.
    const filtered = new pg.Client({ host: server.host, port: server.port, user: FILTERED, password: READER_PASSWORD, database: source.name });
    await filtered.connect();
    try {
      expect((await filtered.query('select count(*)::int as n from auth.users')).rows[0].n).toBe(0);
      expect((await filtered.query('select count(*)::int as n from public.profiles')).rows[0].n).toBe(3);
    } finally {
      await filtered.end();
    }

    const out = path.join(home, 'filtered');
    const result = await run('dump.mjs', ['--out', `${out}/`], {
      SUPABASE_DB_URL: urlOf(source.name, { user: FILTERED, password: READER_PASSWORD }), BACKUP_PASSPHRASE: PASSPHRASE,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`Role ${FILTERED} cannot read auth.users past its row-level security`);
    expect(result.stderr).toContain('nothing was written');
    // No file, and no half of one.
    expect(filesIn(out)).toEqual([]);
    expect(result.all).not.toContain(READER_PASSWORD);
  });
});

describe('a dump cannot write, and reads one moment', () => {
  it('reads the state of one instant while another session writes', async () => {
    const before = await sourceSums();
    const file = path.join(home, 'snapshot.jsonl.gz');
    let wroteAfter = null;
    const result = await dumpDatabase({
      connection: parsePostgresUrl(source.url, 'test'),
      file,
      env: {},
      onTable: async ({ name, index }) => {
        if (index !== 0) return;
        // The first table is in the file; every table of the app is still to
        // come. Another session now changes them, and commits.
        expect(name).toBe('app_private.app_migrations');
        await asAdmin(async (q) => {
          await q(`insert into auth.users (email, aud, role) values ('mid-dump@sl.test', 'authenticated', 'authenticated')`);
          await q(`insert into public.messages (sender_id, recipient_id, body) values ($1, $2, 'written while the dump ran')`,
            [ids.coach.id, ids.studentB.id]);
          await q(`update public.exercise_library set name = 'Renamed mid-dump' where id = $1`, [ids.exercises.muscleUp]);
          await q(`delete from public.bodyweight_logs where logged_on = '2026-09-22'`);
          await q(`insert into storage.objects (bucket_id, name) values ('set-videos', 'mid-dump.mp4')`);
        }, { commit: true });
        wroteAfter = await sourceSums();
      },
    });

    // The other session did commit, and the database is different now.
    for (const table of ['auth.users', 'public.profiles', 'public.messages', 'public.exercise_library', 'public.bodyweight_logs', 'storage.objects']) {
      expect(wroteAfter[table], table).not.toEqual(before[table]);
    }
    // The file holds the instant the dump started: every count as before…
    expect(Object.fromEntries(result.tables.filter(({ name }) => tables.includes(name)).map(({ name, rows }) => [name, rows])))
      .toEqual(Object.fromEntries(Object.entries(before).map(([name, { rows }]) => [name, rows])));
    // …and none of what was written since, in any table.
    const rows = await rowsOf(file, null);
    const text = JSON.stringify([...rows.values()]);
    expect(text).not.toContain('mid-dump');
    expect(text).not.toContain('written while the dump ran');
    expect(rows.get('public.bodyweight_logs').some((row) => row.logged_on === '2026-09-22')).toBe(true);
    // Restored, it is the database as it was — not a mix of two moments.
    const target = await emptyTarget();
    const restored = await run('restore.mjs', [file, '--db-url', target.url]);
    expect(restored.code).toBe(0);
    expect(await sums((sql) => target.query.one(sql))).toEqual(before);
  });

  // The snapshot is about rows. TRUNCATE, and an ALTER TABLE that writes the
  // table again, put another file under the table: for a snapshot taken before
  // one of them commits, that table is EMPTY afterwards (PostgreSQL documents
  // both as not MVCC-safe). What keeps them out of a dump is a lock on every
  // table, taken before the first row is read — these two tests empty tables,
  // so each works on a database of its own with the rows of the seed in it.
  async function disposableCopy() {
    const copy = await emptyTarget();
    const seeded = path.join(home, `seed-${randomBytes(4).toString('hex')}.jsonl.gz`);
    await dumpDatabase({ connection: parsePostgresUrl(source.url, 'test'), file: seeded, env: {} });
    await restoreBackup({ file: seeded, target: parsePostgresUrl(copy.url, 'test'), env: {} });
    const session = async () => {
      const client = new pg.Client({ connectionString: copy.url });
      client.on('error', () => {});
      await client.connect();
      return client;
    };
    // How many sessions wait for the lock of a table of that database.
    const waiting = () => copy.query.value(
      `select count(*)::int from pg_locks l join pg_database d on d.oid = l.database
        where d.datname = current_database() and l.locktype = 'relation' and not l.granted`,
    );
    const rowsIn = (table) => copy.query.value(`select count(*)::int from ${table}`);
    return { ...copy, session, waiting, rowsIn };
  }
  const pause = () => new Promise((resolve) => { setTimeout(resolve, 20); });

  it('holds every table until it is done: a TRUNCATE or a rewriting migration sent meanwhile waits', async () => {
    const copy = await disposableCopy();
    const before = { errors: await copy.rowsIn('public.client_errors'), sets: await copy.rowsIn('public.set_logs') };
    expect(before.errors).toBeGreaterThan(0);
    expect(before.sets).toBeGreaterThan(20);

    // Two other sessions, one statement each.
    const statements = [
      `truncate public.client_errors`,
      // What migration 21 of the plan does to rpe: every row is written again.
      `alter table public.set_logs alter column rpe type numeric(3,1)`,
    ];
    const sessions = await Promise.all(statements.map(() => copy.session()));
    let sent = null;
    let state = null;
    try {
      const result = await dumpDatabase({
        connection: parsePostgresUrl(copy.url, 'test'),
        file: path.join(home, 'held.jsonl.gz'),
        env: {},
        onTable: async ({ name, index }) => {
          if (index !== 0) return;
          // One table is in the file; these two are still to come.
          expect(name).toBe('app_private.app_migrations');
          let settled = 0;
          sent = Promise.allSettled(statements.map((sql, i) => sessions[i].query(sql).finally(() => { settled += 1; })));
          // Either both wait for the dump, or one of them got through.
          for (let tries = 0; tries < 500 && settled === 0 && await copy.waiting() < 2; tries += 1) await pause();
          state = settled > 0 ? 'got through' : `${await copy.waiting()} waiting`;
        },
      });
      expect(state).toBe('2 waiting');

      // The dump is done and has let go: now they run, both of them.
      expect((await sent).map((outcome) => outcome.reason?.message ?? outcome.status)).toEqual(['fulfilled', 'fulfilled']);
      expect(await copy.rowsIn('public.client_errors')).toBe(0);
      expect(await copy.query.value(
        `select format_type(atttypid, atttypmod) from pg_attribute where attrelid = 'public.set_logs'::regclass and attname = 'rpe'`,
      )).toBe('numeric(3,1)');

      // And the file holds every row the two tables had when it began.
      const dumped = Object.fromEntries(result.tables.map(({ name, rows }) => [name, rows]));
      expect(dumped).toMatchObject({ 'public.client_errors': before.errors, 'public.set_logs': before.sets });
      const header = result.header.tables.find(({ name }) => name === 'public.set_logs');
      expect(header.columns.find(({ name }) => name === 'rpe').type).toBe('integer');
    } finally {
      await sent;
      await Promise.all(sessions.map((client) => client.end()));
    }
  });

  it('stops when a table was emptied between its snapshot and its lock — it does not write 0 rows', async () => {
    const copy = await disposableCopy();
    expect(await copy.rowsIn('public.bodyweight_logs')).toBeGreaterThan(0);
    const connection = parsePostgresUrl(copy.url, 'test');
    const file = path.join(home, 'in-flight.jsonl.gz');

    // A statement in flight when the dump starts: it has the table, not yet committed.
    const other = await copy.session();
    try {
      await other.query('begin');
      await other.query('truncate public.bodyweight_logs');
      const dump = dumpDatabase({ connection, file, env: {} }).then(() => null, (err) => err);
      // The dump has taken its snapshot, and now waits for that table.
      for (let tries = 0; tries < 500 && await copy.waiting() < 1; tries += 1) await pause();
      expect(await copy.waiting()).toBe(1);
      await other.query('commit');

      // For the snapshot of the dump the table is now empty. It says so, and writes nothing.
      const failure = await dump;
      expect(failure).toBeInstanceOf(BackupError);
      expect(failure.message).toContain('public.bodyweight_logs');
      expect(failure.message).toContain('nothing was written');
      expect(failure.message).toContain('Take the backup again');
      expect(failure.message).not.toContain('public.set_logs');
      expect(filesIn(home).filter((name) => name.startsWith('in-flight'))).toEqual([]);
    } finally {
      await other.end();
    }

    // Taken again, with nobody in the way: a backup of the database as it is now.
    const again = await dumpDatabase({ connection, file, env: {} });
    expect(again.tables.find(({ name }) => name === 'public.bodyweight_logs').rows).toBe(0);
    expect(again.tables.find(({ name }) => name === 'public.set_logs').rows).toBeGreaterThan(20);
  });

  it('opens a transaction in which the server itself refuses a write', async () => {
    const client = new pg.Client({ connectionString: source.url });
    await client.connect();
    try {
      const query = await openSnapshot(client);
      expect((await query('SELECT pg_catalog.count(*)::int AS n FROM public.profiles')).rows[0].n).toBeGreaterThan(0);
      // Past the guard, straight to the server: still refused.
      await expect(client.query(`delete from public.messages`)).rejects.toMatchObject({ code: '25006' });
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      await client.end();
    }
    expect(await asAdmin((q) => q.value(`select count(*)::int from public.messages`))).toBeGreaterThan(0);
  });

  it('lets through the reads of a dump and nothing that could write', () => {
    for (const sql of [
      BEGIN_SNAPSHOT,
      `SELECT pg_catalog.set_config('TimeZone', 'UTC', true)`,
      `SELECT "update"::text AS "update" FROM ONLY "public"."delete; drop table x"`,
      `SELECT 'insert into x; --' AS note`,
      // What holds a table for the length of the dump: an empty read of it.
      `SELECT 1 FROM ONLY "public"."set_logs" LIMIT 0`,
      'DECLARE sl_backup_cursor NO SCROLL CURSOR FOR SELECT 1',
      'FETCH 1000 FROM sl_backup_cursor',
      'CLOSE sl_backup_cursor',
      'ROLLBACK',
    ]) {
      expect(() => assertReadOnlySql(sql), sql).not.toThrow();
    }
    for (const sql of [
      'BEGIN',
      'BEGIN ISOLATION LEVEL REPEATABLE READ',
      'DELETE FROM public.messages',
      'UPDATE public.profiles SET full_name = $1',
      `INSERT INTO public.messages (body) VALUES ('x')`,
      'TRUNCATE public.messages',
      'DROP TABLE public.messages',
      'SELECT 1; DELETE FROM public.messages',
      'SELECT * INTO public.copy FROM public.messages',
      'WITH gone AS (DELETE FROM public.messages RETURNING *) SELECT * FROM gone',
      'SELECT * FROM public.messages FOR UPDATE',
      `SELECT pg_catalog.setval('public.x_seq', 1)`,
      `SELECT nextval('public.x_seq')`,
      'SET session_replication_role = replica',
      'COMMIT',
      'DECLARE c CURSOR FOR DELETE FROM public.messages RETURNING *',
      'DECLARE c CURSOR WITH HOLD FOR SELECT 1',
      'SELECT 1 -- ; a comment hides the rest\n; DELETE FROM public.messages',
      'COPY public.messages TO STDOUT',
      'CALL public.do_things()',
      'DO $$ BEGIN DELETE FROM public.messages; END $$',
      'LOCK TABLE public.messages',
      'VACUUM',
    ]) {
      expect(() => assertReadOnlySql(sql), sql).toThrow(/Refusing to send a statement/);
    }
  });
});

// ------------------------------------------------------------
// What a restore refuses
// ------------------------------------------------------------
describe('what a restore refuses', () => {
  let file;
  const REF = 'abcdefghijklmnopqrst';
  beforeAll(async () => {
    const result = await run('dump.mjs', ['--out', `${path.join(home, 'for-restore')}/`], { SUPABASE_DB_URL: source.url, BACKUP_PASSPHRASE: PASSPHRASE });
    expect(result.code).toBe(0);
    file = writtenBy(result);
  });
  const restore = (args, env = {}) => run('restore.mjs', [file, ...args], { BACKUP_PASSPHRASE: PASSPHRASE, ...env });

  it('a target that is not named on the command line — never the database of the dump', async () => {
    const result = await restore([], { SUPABASE_DB_URL: source.url, SUPABASE_DB_PASSWORD: server.password });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--db-url <url> is required');
    expect(result.stderr).toContain('never read from SUPABASE_DB_URL');
  });

  it('a Supabase host, before any connection is opened', async () => {
    for (const [host, written = host] of [
      [`db.${REF}.supabase.co`], ['aws-0-eu-west-1.pooler.supabase.com'], ['aws-1-us-east-2.pooler.supabase.com'],
      // The same hosts as DNS takes them too: with the dot of the root behind,
      // in capitals. The flag asks for the name without either.
      ['aws-0-eu-west-1.pooler.supabase.com', 'aws-0-eu-west-1.pooler.supabase.com.'],
      [`db.${REF}.supabase.co`, `DB.${REF}.Supabase.CO.`],
    ]) {
      const started = Date.now();
      const result = await restore(['--db-url', `postgres://postgres.${REF}:${WRONG_PASSWORD}@${written}:5432/postgres`]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(`${host} is a Supabase project`);
      expect(result.stderr).toContain(`--${CONFIRM_SUPABASE_HOST}=${host}`);
      expect(result.all).not.toContain(WRONG_PASSWORD);
      // Refused on the name alone: no lookup, no connection attempt.
      expect(Date.now() - started).toBeLessThan(5000);
    }
    // Not known to this checkout as production, and still a Supabase project.
    const dotted = parsePostgresUrl('postgres://postgres.zzzzzzzzzzzzzzzzzzzz:x@aws-0-eu-west-1.pooler.supabase.com.:5432/postgres', 'test');
    expect(dotted.host).toBe('aws-0-eu-west-1.pooler.supabase.com');
    expect(refusals(dotted, { refs: new Set() })).toHaveLength(1);
    expect(refusals({ ...dotted, host: 'aws-0-eu-west-1.pooler.supabase.com.' }, { refs: new Set() })).toHaveLength(1);
  });

  it('the production project, on a second flag of its own', async () => {
    const pooler = 'aws-0-eu-west-1.pooler.supabase.com';
    const url = `postgres://postgres.${REF}:${WRONG_PASSWORD}@${pooler}:5432/postgres`;
    // The host confirmed, the project known as production: still refused.
    const result = await restore(['--db-url', url, `--${CONFIRM_SUPABASE_HOST}=${pooler}`], { SUPABASE_PROJECT_REF: REF });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(`project ${REF}, which this checkout knows as PRODUCTION`);
    expect(result.stderr).toContain(`--${CONFIRM_PRODUCTION_REF}=${REF}`);
    expect(result.stderr).not.toContain('is a Supabase project');

    // The same judgement, on the sources a ref is learnt from.
    const target = parsePostgresUrl(url, 'test');
    expect(knownProjectRefs({ SUPABASE_PROJECT_REF: REF }, { root: home })).toEqual(new Set([REF]));
    expect(knownProjectRefs({ VITE_SUPABASE_URL: `https://${REF}.supabase.co` }, { root: home })).toEqual(new Set([REF]));
    expect(knownProjectRefs({ SUPABASE_DB_URL: `postgres://postgres:x@db.${REF}.supabase.co:5432/postgres` }, { root: home })).toEqual(new Set([REF]));
    expect(knownProjectRefs({ SUPABASE_DB_URL: url }, { root: home })).toEqual(new Set([REF]));
    expect(knownProjectRefs({}, { root: home })).toEqual(new Set());
    const refs = new Set([REF]);
    expect(refusals(target, { refs })).toHaveLength(2);
    expect(refusals(target, { refs, confirm: { supabaseHost: pooler } })).toHaveLength(1);
    expect(refusals(target, { refs, confirm: { supabaseHost: pooler, productionRef: 'zzzzzzzzzzzzzzzzzzzz' } })).toHaveLength(1);
    expect(refusals(target, { refs, confirm: { supabaseHost: 'pooler.supabase.com', productionRef: REF } })).toHaveLength(1);
    expect(refusals(target, { refs, confirm: { supabaseHost: pooler, productionRef: REF } })).toEqual([]);
    // Production behind another name is still production.
    expect(refusals(parsePostgresUrl(`postgres://postgres.${REF}:x@10.0.0.5:6543/postgres`, 'test'), { refs })).toHaveLength(1);
    expect(refusals(parsePostgresUrl('postgres://postgres:x@127.0.0.1:5432/scratch', 'test'), { refs })).toEqual([]);
  });

  it('a target whose structure cannot take the backup', async () => {
    // The suite's stand-in: no auth.identities, and no table of the next migration.
    const bare = await emptyTarget({ platform: false });
    const strict = await restore(['--db-url', bare.url]);
    expect(strict.code).toBe(1);
    expect(strict.stderr).toContain('auth.identities is in the backup and not in the target');
    expect(strict.stderr).toContain('public.backup_probe is in the backup and not in the target');
    expect(strict.stderr).toContain('nothing was changed');
    expect(await bare.query.value(`select count(*)::int from public.profiles`)).toBe(0);

    // The gap in `public` is never tolerated: those are the app's own tables.
    const tolerant = await restore(['--db-url', bare.url, '--tolerate-platform-gaps']);
    expect(tolerant.code).toBe(1);
    expect(tolerant.stderr).toContain('public.backup_probe is in the backup and not in the target');
    expect(tolerant.stderr).not.toContain('auth.identities is in the backup');
    expect(await bare.query.value(`select count(*)::int from public.profiles`)).toBe(0);

    // A column of the app that the target lacks: its values would be lost.
    const narrower = await emptyTarget();
    await narrower.query(`alter table public.students drop column notes`);
    const lost = await restore(['--db-url', narrower.url, '--tolerate-platform-gaps']);
    expect(lost.code).toBe(1);
    expect(lost.stderr).toContain('public.students: the target has no column notes');
    // A column the target demands and the backup cannot fill.
    const wider = await emptyTarget();
    await wider.query(`alter table public.goals add column deadline date not null`);
    const unfilled = await restore(['--db-url', wider.url]);
    expect(unfilled.code).toBe(1);
    expect(unfilled.stderr).toContain("public.goals: the target's column deadline is NOT NULL without a default");
  });

  it('with --tolerate-platform-gaps, a stand-in for Supabase takes what fits and says what did not', async () => {
    // The stand-in, plus the app's table: everything of `public` can be loaded.
    const standIn = await emptyTarget({ platform: false });
    await standIn.runSql(PLATFORM_AND_PROBE.slice(PLATFORM_AND_PROBE.indexOf('CREATE TABLE public.backup_probe')), 'probe');
    // Its accounts table has less than the real one.
    await standIn.query(`alter table storage.objects drop column user_metadata`);
    const result = await restore(['--db-url', standIn.url, '--tolerate-platform-gaps']);
    expect(result.all).not.toContain('FAILED');
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/auth\.identities +\d+ {2}NOT LOADED — not in the target/);
    expect(result.stdout).toMatch(/storage\.objects +\d+ {2}row count only — 1 of \d+ columns are not in the target/);
    expect(result.stderr).toContain('NOT LOADED: auth.identities.');
    expect(result.stdout).toMatch(/compared by row count only/);
    // Everything else is there, identical.
    const want = await sourceSums();
    const got = await sums((sql) => (sql.includes('auth.identities') ? { rows: 0, sum: null } : standIn.query.one(sql)));
    for (const table of tables.filter((name) => !['auth.identities', 'storage.objects'].includes(name))) {
      expect(got[table], table).toEqual(want[table]);
    }
    expect(got['storage.objects'].rows).toBe(want['storage.objects'].rows);
  });

  it('with --skip, the tables named are left out and everything else is loaded', async () => {
    const target = await emptyTarget();
    const typo = await restore(['--db-url', target.url, '--skip', 'auth.user']);
    expect(typo.code).toBe(2);
    expect(typo.stderr).toContain('--skip names a table the backup does not hold: auth.user');

    const result = await restore(['--db-url', target.url, '--skip', 'auth.users', '--skip', 'auth.identities']);
    expect(result.all).not.toContain('FAILED');
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/auth\.users +\d+ {2}NOT LOADED — left out on request/);
    expect(result.stderr).toContain('NOT LOADED: auth.identities, auth.users.');
    expect(await target.query.value(`select count(*)::int from auth.users`)).toBe(0);
    // The app's rows do not wait for the accounts: only their ids tie them.
    const want = await sourceSums();
    const got = await sums((sql) => target.query.one(sql));
    for (const table of tables.filter((name) => !name.startsWith('auth.'))) expect(got[table], table).toEqual(want[table]);
  });

  it('a column whose type changed is loaded, and compared by count because its text differs', async () => {
    const newer = await emptyTarget();
    // What migration 21 of the plan does to rpe.
    await newer.query(`alter table public.set_logs alter column rpe type numeric(3,1)`);
    const result = await restore(['--db-url', newer.url]);
    expect(result.all).not.toContain('FAILED');
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/public\.set_logs +\d+ {2}row count only — rpe is integer in the backup and numeric\(3,1\) in the target/);
    expect(await newer.query.value(`select rpe::text from public.set_logs where rpe = 8`)).toBe('8.0');
  });

  it('rows that load and read back differently: nothing is kept', async () => {
    // Same columns, same types — and a generated column the target computes
    // another way. Every insert succeeds; only the comparison can tell.
    const other = await emptyTarget({ platform: false });
    await other.runSql(PLATFORM_AND_PROBE.replace('(amount * 2)', '(amount * 3)'), 'target');
    const result = await restore(['--db-url', other.url]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('The target does not hold what the backup holds; nothing was kept');
    expect(result.stderr).toMatch(/public\.backup_probe: 3 rows, and they do not read back as they were written/);
    for (const table of ['auth.users', 'public.profiles', 'public.backup_probe']) {
      expect(await other.query.value(`select count(*)::int from ${table}`), table).toBe(0);
    }
  });

  it('a row the target refuses: nothing is kept, and the row is not quoted', async () => {
    const stricter = await emptyTarget();
    await stricter.query(`alter table public.messages add constraint short_messages check (char_length(body) < 30)`);
    const result = await restore(['--db-url', stricter.url]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('public.messages: the target refused a row of the backup (SQLSTATE 23514, constraint short_messages)');
    expect(result.stderr).toContain('Nothing was kept');
    expect(result.all).not.toContain('Welcome to the block');
    expect(result.all).not.toContain('Failing row');
    // One transaction: the tables loaded before that one are empty again.
    for (const table of ['auth.users', 'public.profiles', 'public.bodyweight_logs', 'public.messages']) {
      expect(await stricter.query.value(`select count(*)::int from ${table}`), table).toBe(0);
    }
    expect(await stricter.query.value(`select count(*)::int from storage.buckets`)).toBe(1);

    // Asked for, the server's own words are there.
    const detailed = await restore(['--db-url', stricter.url, '--details']);
    expect(detailed.code).toBe(1);
    expect(detailed.stderr).toContain('violates check constraint "short_messages"');

    // A refusal that is not about a row says what it is without being asked,
    // with the table it was about: here a role that the row-level security of
    // the accounts table stands in the way of.
    const guarded = await emptyTarget();
    const locked = await restore(['--db-url', urlOf(guarded.name, { user: FILTERED, password: READER_PASSWORD })]);
    expect(locked.code).toBe(1);
    expect(locked.stderr).toMatch(/auth\.users: the target refused the load: .*row-level security.*\(SQLSTATE 42501\)/);
    expect(await guarded.query.value(`select count(*)::int from public.profiles`)).toBe(0);
  });
});

// ------------------------------------------------------------
// The pages the owner follows
// ------------------------------------------------------------
describe('docs/runbook/00-before-you-start.md: the backup commands, as written', () => {
  const PAGE = 'docs/runbook/00-before-you-start.md';
  const page = fs.readFileSync(path.join(repoRoot, PAGE), 'utf8');
  const section = page.slice(page.indexOf('\n## 2. '), page.indexOf('\n## 3. '));
  const commands = [...section.matchAll(/```bash\n([\s\S]*?)\n```/g)].map(([, body]) => body);
  const backupCommands = commands.filter((command) => command.includes('scripts/backup/'));

  it('are three: take it, check it, restore it for practice — each through the env file', () => {
    expect(backupCommands).toEqual([
      'node --env-file=.env scripts/backup/dump.mjs',
      'node --env-file=.env scripts/backup/verify.mjs',
      'node --env-file=.env scripts/backup/drill.mjs',
    ]);
    // Nothing on the page takes a backup another way any more.
    expect(page).not.toMatch(/supabase db dump/);
  });

  it('run in that order on a machine that has only Node: a backup, checked, restored into a throw-away server', async () => {
    const owner = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-backup-owner-'));
    // `--env-file=.env` is how the owner's variables arrive; here they are
    // given directly — the suite never opens anybody's .env.
    const asOwner = (command, env) => new Promise((resolve, reject) => {
      const [script, ...args] = command.replace(/^node --env-file=\.env /, '').split(' ');
      const child = spawn(process.execPath, [script, ...args], { cwd: repoRoot, env: { PATH: process.env.PATH, HOME: owner, ...env } });
      let all = '';
      child.stdout.on('data', (chunk) => { all += chunk; });
      child.stderr.on('data', (chunk) => { all += chunk; });
      child.on('error', reject);
      child.on('close', (code) => { transcript.push(all); resolve({ code, all }); });
    });
    try {
      // "Production": the rows of the seed in the tables of supabase/schema.sql
      // and nothing else — the suite's own database has one table more.
      const production = await emptyTarget();
      const seeded = await run('dump.mjs', ['--out', `${path.join(home, 'for-production')}/`], { SUPABASE_DB_URL: source.url, BACKUP_PASSPHRASE: PASSPHRASE });
      const loaded = await run('restore.mjs', [writtenBy(seeded), '--db-url', production.url], { BACKUP_PASSPHRASE: PASSPHRASE });
      expect([seeded.code, loaded.code]).toEqual([0, 0]);
      await production.query(`drop table public.backup_probe`);
      const pooler = path.join(owner, 'pooler-url');
      fs.writeFileSync(pooler, `postgresql://${READER}@${server.host}:${server.port}/${production.name}\n`);

      const env = { SUPABASE_DB_PASSWORD: READER_PASSWORD, SUPABASE_POOLER_URL_FILE: pooler, BACKUP_PASSPHRASE: PASSPHRASE };
      const dumped = await asOwner(backupCommands[0], env);
      expect(dumped.all).not.toContain('FAILED');
      expect(dumped.code).toBe(0);
      expect(filesIn(path.join(owner, 'sl_app-backups'))).toHaveLength(1);

      const verified = await asOwner(backupCommands[1], { BACKUP_PASSPHRASE: PASSPHRASE });
      expect(verified.code).toBe(0);
      expect(verified.all).toMatch(/OK +\d+ tables/);

      // The drill: no database is named, none of the suite's is touched. It
      // gets everything the env file of the dump holds — with the line
      // BACKUPS.md says to add for the dump to check the certificate of the
      // project. That CA says nothing about the drill's own server, which is
      // on this machine and has no TLS.
      const ca = path.join(owner, 'prod-ca-2021.crt');
      fs.writeFileSync(ca, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');
      const drilled = await asOwner(backupCommands[2], { ...env, PGSSLROOTCERT: ca });
      expect(drilled.all).not.toContain('FAILED');
      expect(drilled.code).toBe(0);
      expect(drilled.all).toMatch(/DRILL OK +(\d+) of \1 tables of schema public fit supabase\/schema\.sql and read back identical\./);
      // The drill's server has schema.sql and the suite's stand-in for
      // Supabase: what it cannot take is said, not hidden.
      expect(drilled.all).toMatch(/auth\.identities +\d+ {2}NOT LOADED — not in the target/);
      expect(drilled.all).toMatch(/auth\.users +\d+ {2}identical/);
    } finally {
      fs.rmSync(owner, { recursive: true, force: true });
    }
  }, 120_000);

  it('the drill stops on a table of the app that supabase/schema.sql does not have', async () => {
    // The suite's database, with its extra table: production ahead of the
    // checkout, or a table made by hand.
    const dumped = await run('dump.mjs', ['--out', `${path.join(home, 'drift')}/`], { SUPABASE_DB_URL: source.url, BACKUP_PASSPHRASE: PASSPHRASE });
    const drilled = await run('drill.mjs', [writtenBy(dumped)], { BACKUP_PASSPHRASE: PASSPHRASE });
    // The exit code too: a job that runs the drill must turn red.
    expect(drilled.code).toBe(1);
    expect(drilled.stderr).toContain('public.backup_probe is in the backup and not in the target');
    expect(drilled.stdout).not.toContain('DRILL OK');

    // And on a file that is not a backup, before any server is started.
    const broken = path.join(home, 'drift', 'broken.jsonl.gz.enc');
    fs.writeFileSync(broken, fs.readFileSync(writtenBy(dumped)).subarray(0, 2000));
    const refused = await run('drill.mjs', [broken], { BACKUP_PASSPHRASE: PASSPHRASE });
    expect(refused.code).toBe(1);
    expect(refused.stdout).not.toContain('a throw-away PostgreSQL');
  }, 60_000);
});

// ------------------------------------------------------------
// Last: what all of the above printed
// ------------------------------------------------------------
describe('everything the commands printed, in this whole file', () => {
  it('never holds a connection string, a database password or the passphrase', () => {
    const all = transcript.join('\n');
    expect(transcript.length).toBeGreaterThan(40);
    expect(all.length).toBeGreaterThan(10_000);
    for (const secret of [PASSPHRASE, OTHER_PASSPHRASE, READER_PASSWORD, encodeURIComponent(READER_PASSWORD), WRONG_PASSWORD]) {
      expect(all.includes(secret), `a line holds ${secret.slice(0, 6)}…`).toBe(false);
    }
    // No URL with anything after the scheme, and no `user:password@host`.
    expect(all).not.toMatch(/postgres(?:ql)?:\/\/(?!\[hidden\])/);
    expect(all).not.toMatch(new RegExp(`:[^\\s@]*@${server.host.replace(/\./g, '\\.')}`));
    expect(all).not.toContain(`${server.host}:${server.port}`);
  });

  it('a URL typed where a file name belongs is not echoed with its password', async () => {
    const url = `postgres://postgres:${WRONG_PASSWORD}@db.example.test/postgres`;
    // The environment of the dump, given to a command that does not connect.
    const result = await run('verify.mjs', [url], { SUPABASE_DB_PASSWORD: READER_PASSWORD, BACKUP_PASSPHRASE: PASSPHRASE });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('FAILED: Cannot read');
    expect(result.all).not.toContain(WRONG_PASSWORD);
    // The assertion at the top of this block looks at what was captured so
    // far; this run is in it too.
    expect(transcript.join('\n')).not.toContain(WRONG_PASSWORD);
  });

  it('scrub() hides a secret in any text, also percent-encoded and inside a URL', () => {
    const parsed = parsePostgresUrl(`postgresql://user:${encodeURIComponent('p@ss/w:rd#1')}@db.example.test:5432/postgres`, 'test');
    expect(parsed).toMatchObject({ host: 'db.example.test', port: 5432, user: 'user', password: 'p@ss/w:rd#1', database: 'postgres' });
    const text = scrub(`could not connect: password "p@ss/w:rd#1" (${encodeURIComponent('p@ss/w:rd#1')}) for postgresql://user:x@db.example.test/postgres`);
    expect(text).not.toContain('p@ss');
    expect(text).not.toContain('db.example.test/postgres');
    expect(text).toContain('[hidden]');
  });
});
