// The deploy gate, against a real PostgreSQL: scripts/check-migrations.mjs.
//
// A push to `main` publishes the app, and the SQL that app needs is applied to
// production by hand. Between the two stands one command, run by
// .github/workflows/deploy.yml: it reads app_private.app_migrations and
// refuses the deploy when a `required` migration of the manifest is not in it
// (review finding P69).
//
// What it decides from a list of names is held without a database, in
// scripts/check-migrations.test.mjs. Here the command is run as the deploy job
// runs it — `node scripts/check-migrations.mjs --verify` in a child process,
// with an environment of its own — against databases in the states production
// can be in: as the review found it, between two checkpoints, with everything
// applied, and asked by a role that cannot give a true answer.
//
// Not covered, and it cannot be from here: the Supabase pooler and its TLS.
// The connection code is the backup's (scripts/backup/lib/connection.mjs).

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import {
  afterAll, beforeAll, describe, expect, inject, it,
} from 'vitest';
import {
  LEDGER_QUERY, LOCAL_SECRET, OVERRIDE, PAGE, SECRET, decide, isRequired, readLedger,
} from '../../scripts/lib/ledger-gate.mjs';
import { LEDGER, loadManifest } from '../migrations/manifest.js';
import { repoRoot, scratchDatabase } from './harness.js';

const server = inject('slDb');
const manifest = loadManifest();
const required = manifest.migrations.filter(isRequired);
const last = required.at(-1);

const suffix = randomBytes(4).toString('hex');
// A password with everything a URL has to escape.
const PASSWORD = `Pw-${randomBytes(12).toString('hex')}/+@:#?&=%`;
const WRONG_PASSWORD = `Wrong-${randomBytes(12).toString('hex')}`;
// Two login roles of the cluster. One was given nothing; the other exactly
// what reading the ledger takes.
const STRANGER = `sl_gate_stranger_${suffix}`;
const READER = `sl_gate_reader_${suffix}`;

const urlOf = (database, { user = server.user, password = server.password } = {}) => (
  `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${server.host}:${server.port}/${database}`
);

// ------------------------------------------------------------
// Running the command
// ------------------------------------------------------------
const transcript = [];

/**
 * `node <script> …args` with ONLY `env` (plus PATH): nothing of the machine's
 * environment — an owner's SUPABASE_DB_URL, a CI flag — reaches the command.
 */
function node(script, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: repoRoot, env: { PATH: process.env.PATH, ...env } });
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

/** The step of the deploy job: the secret, and nothing else. */
const verify = (url, env = {}) => node('scripts/check-migrations.mjs', ['--verify'], { [SECRET]: url, ...env });

/** The names a refusal lists as missing, in the order it lists them. */
const refused = (result) => [...result.stderr.matchAll(/^ {4}\d{2} {2}(\S+) +Checkpoint \S+ +docs\/runbook\/migrations\/\S+\.md$/gm)]
  .map(([, name]) => name);

/** What the table says of each migration: `{ name: 'applied …' | 'MISSING' | 'not applied — …' }`. */
const statusOf = (result) => Object.fromEntries(
  [...result.stdout.matchAll(/^ {2}\d{2} {2}(\S+) +(?:required|optional|contract) {2}\S+ +(.+)$/gm)].map(([, name, status]) => [name, status]),
);

/** readLedger() on a connection of its own, as the command opens it. */
async function ledgerOf(database, credentials) {
  const client = new pg.Client({ host: server.host, port: server.port, user: server.user, password: server.password, database, ...credentials });
  await client.connect();
  try {
    return await readLedger((sql) => client.query(sql));
  } finally {
    await client.end();
  }
}

// ------------------------------------------------------------
// The databases
// ------------------------------------------------------------
let applied;     // supabase/schema.sql: every migration that is merged, on record
let granted;     // the same, with the ledger opened to READER
const drops = [];

beforeAll(async () => {
  applied = await scratchDatabase({ from: 'schema' });
  granted = await scratchDatabase({ from: 'schema' });
  drops.push(granted);
  // `postgres` may create roles there, as on Supabase.
  await granted.query(`CREATE ROLE ${STRANGER} LOGIN NOBYPASSRLS PASSWORD '${PASSWORD}'`);
  await granted.query(`CREATE ROLE ${READER} LOGIN NOBYPASSRLS PASSWORD '${PASSWORD}'`);
  await granted.query(`GRANT USAGE ON SCHEMA app_private TO ${READER}`);
  await granted.query(`GRANT SELECT ON ${LEDGER} TO ${READER}`);
});

afterAll(async () => {
  // A role cannot be dropped while a database still holds a grant to it.
  for (const db of drops) await db.drop();
  const admin = new pg.Client({ host: server.host, port: server.port, user: server.user, password: server.password, database: 'postgres' });
  await admin.connect();
  try {
    await admin.query(`DROP ROLE IF EXISTS ${STRANGER}, ${READER}`);
  } finally {
    await admin.end();
  }
});

describe('the manifest of the repository', () => {
  it('has required migrations, the ledger first', () => {
    expect(required.length).toBeGreaterThan(1);
    expect(required[0].name).toBe('2026_10_03_01_migration_ledger');
  });
});

describe('check-migrations --verify: production has everything', () => {
  it('lets the deploy go on, as the role that owns the schema', async () => {
    const result = await verify(urlOf(applied.name));
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`OK: production has all ${required.length} required migrations of this commit. The deploy can go on.`);
  });

  it('says who it asked, where, and what it found for each migration', async () => {
    // As READER: the suite's `postgres` has its own name for a password, and
    // the command hides a password wherever it would print it.
    const result = await verify(urlOf(granted.name, { user: READER, password: PASSWORD }));
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`  source     ${READER} at ${server.host} (SUPABASE_DB_URL), no TLS (local address)`);
    expect(result.stdout).toMatch(new RegExp(`^ {2}server {5}PostgreSQL 17\\.\\d+, database ${granted.name}, role ${READER}$`, 'm'));
    expect(result.stdout).toContain('  read       one read-only transaction, rolled back');
    const status = statusOf(result);
    expect(Object.keys(status)).toEqual(manifest.migrations.map((m) => m.name));
    for (const { name } of required) expect(status[name]).toMatch(/^applied \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
    expect(result.stdout).toContain(`OK: production has all ${required.length} required migrations of this commit. The deploy can go on.`);
    // Off GitHub, no annotation.
    expect(result.stdout).not.toContain('::');
  });

  it('reads what the stub of the unit tests stands for: names and dates, as postgres', async () => {
    const state = await ledgerOf(applied.name);
    expect(state).toMatchObject({ role: server.user, database: applied.name });
    expect(state.serverVersion).toMatch(/^17\./);
    expect(state.ledger.map((row) => Object.keys(row))).toEqual(state.ledger.map(() => ['name', 'applied_at']));
    for (const row of state.ledger) expect(row.applied_at).toBeInstanceOf(Date);
    expect(state.ledger.map((row) => row.name).sort()).toEqual(
      (await applied.query.rows(LEDGER_QUERY)).map((row) => row.name).sort(),
    );
  });

  it('changes nothing: the rows of the ledger are the ones that were there', async () => {
    const rows = `select name, applied_at, xmin::text as written_by from ${LEDGER} order by name`;
    const before = await applied.query.rows(rows);
    expect(before.length).toBeGreaterThan(1);
    expect((await verify(urlOf(applied.name))).code).toBe(0);
    expect(await applied.query.rows(rows)).toEqual(before);
  });

  it('is not held up by a ledger that knows more than the commit', async () => {
    const db = await scratchDatabase({ from: 'schema' });
    await db.query(`insert into ${LEDGER} (name) values ('2099_01_01_99_a_migration_to_come')`);
    const result = await verify(urlOf(db.name));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('note: the ledger also lists 2099_01_01_99_a_migration_to_come, which this commit does not know.');
    await db.drop();
  });
});

describe('check-migrations --verify: production is behind', () => {
  it('stops the deploy and names the one migration that is not on record', async () => {
    const db = await scratchDatabase({ from: 'schema' });
    await db.query(`delete from ${LEDGER} where name = $1`, [last.name]);
    const result = await verify(urlOf(db.name), { GITHUB_ACTIONS: 'true' });
    expect(result.code).toBe(1);
    expect(refused(result)).toEqual([last.name]);
    expect(result.stderr).toContain('REFUSED: 1 required migration is not applied in production:');
    expect(result.stderr).toContain(`Checkpoint ${last.checkpoint}  ${last.paths.runbook}`);
    expect(result.stderr).toContain(PAGE);
    expect(statusOf(result)[last.name]).toBe('MISSING');
    expect(result.stdout).not.toContain('OK:');
    // On GitHub, the verdict is on the summary page of the run as well.
    expect(result.stdout.split('\n').filter((line) => line.startsWith('::'))).toEqual([
      expect.stringContaining(`::error title=Deploy stopped::1 required migration is not applied in production: ${last.name} (Checkpoint ${last.checkpoint}).`),
    ]);

    // The variable stands in for a secret that is not set, never for a migration.
    const overridden = await verify(urlOf(db.name), { [OVERRIDE]: 'true' });
    expect(overridden.code).toBe(1);
    expect(refused(overridden)).toEqual([last.name]);
    await db.drop();
  });

  it('names all of them when the ledger is there and empty', async () => {
    const db = await scratchDatabase({ from: 'schema' });
    await db.query(`delete from ${LEDGER}`);
    const result = await verify(urlOf(db.name));
    expect(result.code).toBe(1);
    expect(refused(result)).toEqual(required.map((m) => m.name));
    expect(result.stderr).not.toContain('no ledger at all');
    await db.drop();
  });

  it('reads a project without any user SQL as one without any migration', async () => {
    const bare = await scratchDatabase();
    const result = await verify(urlOf(bare.name));
    expect(result.code).toBe(1);
    expect(refused(result)).toEqual(required.map((m) => m.name));
    expect(result.stderr).toContain(`Production has no ledger at all (no table ${LEDGER}): migration 01 was never applied there`);
    await bare.drop();
  });

  // Production as the review found it, then the owner's checkpoints: each
  // required file of the manifest, in order, as the SQL editor sends it. The
  // gate opens after the last one and not before — "the head of a wave needs
  // every required migration of the waves up to it".
  it('opens after the last required migration of the manifest is applied, and not one file earlier', async () => {
    const production = await scratchDatabase();
    await production.runFile(manifest.baseline);
    const url = urlOf(production.name);

    const found = await verify(url);
    expect(found.code).toBe(1);
    expect(refused(found)).toEqual(required.map((m) => m.name));
    expect(found.stderr).toContain('Production has no ledger at all');

    for (const [index, migration] of required.entries()) {
      await production.runFile(migration.paths.migration);
      const rest = required.slice(index + 1).map((m) => m.name);
      // Between two files the decision is taken in this process, on the rows
      // the real query returns; the command is run again at the end.
      const decision = await decide({
        env: { [SECRET]: url },
        migrations: manifest.migrations,
        read: () => ledgerOf(production.name),
      });
      expect(decision.missing.map((m) => m.name), `after ${migration.name}`).toEqual(rest);
      expect(decision.exitCode, `after ${migration.name}`).toBe(rest.length > 0 ? 1 : 0);
    }

    // What the gate did not ask for: the optional and the contract files.
    const skipped = manifest.migrations.filter((m) => !isRequired(m)).map((m) => m.name);
    const opened = await verify(url);
    expect(opened.stderr).toBe('');
    expect(opened.code).toBe(0);
    const status = statusOf(opened);
    for (const name of skipped) expect(status[name]).toMatch(/^not applied — not needed \((?:optional|contract)/);
    await production.drop();
  });

  it('does not ask for an optional or a contract migration, on the rows of a real ledger', async () => {
    const [first, second] = required;
    const entries = [
      first,
      second,
      { ...second, name: '2026_10_20_19_rest_push_cron', kind: 'optional', order: 19, checkpoint: 'B' },
      { ...second, name: '2026_11_30_43_set_logs_insert_pin', kind: 'contract', order: 43, checkpoint: 'Z' },
      { ...second, name: '2026_11_30_46_one_more', kind: 'required', order: 46, checkpoint: 'G' },
    ];
    const db = await scratchDatabase({ from: 'schema' });
    const judge = () => decide({ env: { [SECRET]: urlOf(db.name) }, migrations: entries, read: () => ledgerOf(db.name) });

    expect((await judge()).missing.map((m) => m.name)).toEqual(['2026_11_30_46_one_more']);
    await db.query(`insert into ${LEDGER} (name) values ('2026_11_30_46_one_more')`);
    expect(await judge()).toMatchObject({ verdict: 'applied', exitCode: 0, missing: [] });
    await db.drop();
  });
});

describe('check-migrations --verify: an answer that could not be trusted', () => {
  it('refuses a role that may not read the ledger, instead of calling its migrations missing', async () => {
    const result = await verify(urlOf(granted.name, { user: STRANGER, password: PASSWORD }));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('REFUSED: the ledger of production could not be read.');
    expect(result.stderr).toContain(`Role ${STRANGER} may not read ${LEDGER}`);
    expect(result.stderr).not.toContain('not applied in production');
    expect(result.stdout).not.toContain('MISSING');
    await expect(ledgerOf(granted.name, { user: STRANGER, password: PASSWORD })).rejects.toThrow(/may not read/);
  });

  it('answers a role that was granted the schema and the table, and nothing else', async () => {
    const result = await verify(urlOf(granted.name, { user: READER, password: PASSWORD }));
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`role ${READER}`);
    expect(result.stdout).toContain('The deploy can go on.');
    // That role reads the ledger and nothing of the app.
    const reader = new pg.Client({ host: server.host, port: server.port, user: READER, password: PASSWORD, database: granted.name });
    await reader.connect();
    try {
      await expect(reader.query('select count(*) from public.profiles')).rejects.toMatchObject({ code: '42501' });
    } finally {
      await reader.end();
    }
  });

  it('refuses a ledger that row-level security filters for the role — and still answers the owner', async () => {
    // The ledger has no RLS on purpose. The day someone switches it on
    // "everywhere", a role that does not bypass it reads an empty table.
    const db = await scratchDatabase({ from: 'schema' });
    drops.push(db);
    await db.query(`GRANT USAGE ON SCHEMA app_private TO ${READER}`);
    await db.query(`GRANT SELECT ON ${LEDGER} TO ${READER}`);
    await db.query(`ALTER TABLE ${LEDGER} ENABLE ROW LEVEL SECURITY`);

    const filtered = await verify(urlOf(db.name, { user: READER, password: PASSWORD }));
    expect(filtered.code).toBe(1);
    expect(filtered.stderr).toContain('REFUSED: the ledger of production could not be read.');
    expect(filtered.stderr).toContain(`Row-level security is on for ${LEDGER} and applies to role ${READER}`);
    expect(filtered.stderr).not.toContain('not applied in production');
    expect(filtered.stdout).not.toContain('MISSING');

    const owner = await verify(urlOf(db.name));
    expect(owner.code).toBe(0);
  });

  it('stops on a password the database refuses, and says what to fix', async () => {
    const url = urlOf(applied.name, { password: WRONG_PASSWORD });
    for (const env of [{}, { [OVERRIDE]: 'true' }]) {
      const result = await verify(url, env);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('REFUSED: the ledger of production could not be read.');
      expect(result.stderr).toContain('(28P01)');
      expect(result.stderr).toContain('The database refused the password.');
      expect(result.stdout).not.toContain('OK:');
    }
    const overridden = await verify(url, { [OVERRIDE]: 'true' });
    expect(overridden.stderr).toContain(`${OVERRIDE} is true, and does not apply`);
  });

  it('stops on a database that does not exist', async () => {
    const result = await verify(urlOf(`sl_no_such_database_${suffix}`));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('REFUSED: the ledger of production could not be read.');
    expect(result.stderr).toContain('(3D000)');
  });
});

// ------------------------------------------------------------
// The page the owner follows
// ------------------------------------------------------------
describe(`${PAGE}: the commands, as written`, () => {
  const page = fs.readFileSync(path.join(repoRoot, PAGE), 'utf8');
  const commands = [...page.matchAll(/```bash\n([\s\S]*?)\n```/g)].map(([, body]) => body);
  const VERIFY = 'node --env-file=.env scripts/check-migrations.mjs --verify';
  const PRINT = 'node scripts/check-migrations.mjs --print';

  it('are the check, the list, and the ledger read by hand', () => {
    expect([...new Set(commands)]).toEqual([
      VERIFY,
      PRINT,
      `supabase db query --linked "${LEDGER_QUERY}"`,
    ]);
  });

  it('the check runs on the owner\'s machine: the password of .env, the address of the linked CLI', async () => {
    const owner = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-gate-owner-'));
    try {
      // `--env-file=.env` is how the owner's variables arrive; here they are
      // given directly — the suite never opens anybody's .env.
      const [script, ...args] = VERIFY.replace(/^node --env-file=\.env /, '').split(' ');
      const pooler = path.join(owner, 'pooler-url');
      fs.writeFileSync(pooler, `postgresql://${READER}@${server.host}:${server.port}/${granted.name}\n`);
      const result = await node(script, args, { [LOCAL_SECRET]: PASSWORD, SUPABASE_POOLER_URL_FILE: pooler });
      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(`  source     ${READER} at ${server.host} (SUPABASE_DB_PASSWORD + pooler-url)`);
      expect(result.stdout).toContain('The deploy can go on.');
    } finally {
      fs.rmSync(owner, { recursive: true, force: true });
    }
  });

  it('the list prints what the check asks for, and the query the page gives', async () => {
    const [script, ...args] = PRINT.replace(/^node /, '').split(' ');
    const result = await node(script, args, {});
    expect(result.code).toBe(0);
    for (const { name } of manifest.migrations) expect(result.stdout).toContain(name);
    expect(result.stdout).toContain(`supabase db query --linked "${LEDGER_QUERY}"`);
    // And that query is one the database answers.
    expect((await applied.query.rows(LEDGER_QUERY)).map((row) => row.name).sort()).toEqual(
      manifest.migrations.filter((m) => m.kind !== 'contract').map((m) => m.name).sort(),
    );
  });
});

describe('what the command prints', () => {
  it('never holds a password or a connection string', () => {
    const all = transcript.join('\n');
    expect(all.length).toBeGreaterThan(2000);
    for (const secret of [PASSWORD, encodeURIComponent(PASSWORD), WRONG_PASSWORD, server.password === 'postgres' ? null : server.password]) {
      if (secret) expect(all).not.toContain(secret);
    }
    expect(all).not.toMatch(/postgres(?:ql)?:\/\/[^\s[]*@/);
  });
});
