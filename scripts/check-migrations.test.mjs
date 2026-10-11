// @vitest-environment node
import {
  afterAll, beforeAll, describe, expect, it, vi,
} from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest } from '../supabase/migrations/manifest.js';
import {
  BEGIN_READ_ONLY, GateError, LEDGER_QUERY, LOCAL_SECRET, OVERRIDE, PAGE, SECRET,
  compare, decide, describeManifest, manifestFaults, overrideOf, readLedger, render,
} from './lib/ledger-gate.mjs';

// The deploy gate (review finding P69): a push to `main` publishes the app,
// and the SQL that app needs is applied to production by hand. The gate is
// what stands between the two, so what is held here is every way it could say
// yes when the answer is no — a migration that is missing, a ledger nobody
// read, a manifest it cannot judge — and the two things it must not ask for:
// an optional migration and a contract one.
//
// No database here: the ledger is a stub, and the command is run as a child
// process only where it connects to nothing. The same command against a real
// PostgreSQL is supabase/tests/deploy-gate.test.js (`npm run test:db`).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

// ------------------------------------------------------------
// A manifest as it will read a few waves from now, loaded by the real reader
// ------------------------------------------------------------
const LEDGER_01 = '2026_10_03_01_migration_ledger';
const NULL_GUARD_02 = '2026_10_03_02_rpc_auth_null_guard';
const GRANTS_03 = '2026_10_11_03_function_grants_lockdown';
const CRON_19 = '2026_10_20_19_rest_push_cron';
const PIN_43 = '2026_11_30_43_set_logs_insert_pin';

const entry = (name, kind, wave, checkpoint) => ({
  name, kind, wave, checkpoint, covers: [], reversible: true, summary: 'A fixture.',
});
const FIXTURE = [
  entry(LEDGER_01, 'required', 0, 'A0'),
  entry(NULL_GUARD_02, 'required', 0, 'A0'),
  entry(GRANTS_03, 'required', 1, 'A1'),
  entry(CRON_19, 'optional', 2, 'B'),
  entry(PIN_43, 'contract', 8, 'Z'),
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-ledger-gate-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** `entries` written as a manifest.json and read back by loadManifest(). */
function manifestOf(entries) {
  const dir = fs.mkdtempSync(path.join(tmp, 'repo-'));
  fs.mkdirSync(path.join(dir, 'supabase/migrations'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'supabase/migrations/manifest.json'),
    JSON.stringify({ baseline: 'supabase/tests/fixtures/none.sql', migrations: entries }),
  );
  return loadManifest(dir).migrations;
}
const migrations = manifestOf(FIXTURE);
const REQUIRED = [LEDGER_01, NULL_GUARD_02, GRANTS_03];

// ------------------------------------------------------------
// A ledger that is a stub
// ------------------------------------------------------------
const APPLIED_AT = new Date('2026-10-12T08:01:30Z');
const rowsOf = (...names) => names.map((name) => ({ name, applied_at: APPLIED_AT }));
/** A `read()` that answers with these ledger rows (`null`: no ledger table). */
const answering = (ledger) => vi.fn(async () => ({
  role: 'postgres', database: 'postgres', serverVersion: '17.6', ledger,
}));
const neverRead = () => vi.fn(async () => { throw new Error('the gate connected, and had nothing to connect with'); });

const WITH_SECRET = { [SECRET]: 'postgresql://postgres.abcdefghijklmnopqrst:pw@aws-0-eu-west-1.pooler.supabase.com:5432/postgres' };
const text = (result, options) => {
  const { out, err, notes } = render(result, options);
  return { out: out.join('\n'), err: err.join('\n'), notes, all: [...out, ...err].join('\n') };
};

describe('deploy gate: the manifest against the ledger', () => {
  it('reads the fixture as the real reader gives it: order, paths, kind', () => {
    expect(migrations.map((m) => [m.order, m.kind])).toEqual([
      [1, 'required'], [2, 'required'], [3, 'required'], [19, 'optional'], [43, 'contract'],
    ]);
    expect(migrations[2].paths.runbook).toBe('docs/runbook/migrations/03-function-grants-lockdown.md');
    expect(manifestFaults(migrations)).toEqual([]);
  });

  it('lets the deploy go on when every required migration is applied', async () => {
    const readLedgerStub = answering(rowsOf(...REQUIRED, CRON_19, PIN_43));
    const result = await decide({ env: WITH_SECRET, migrations, read: readLedgerStub });
    expect(result).toMatchObject({ verdict: 'applied', exitCode: 0, missing: [], unknown: [] });
    expect(readLedgerStub).toHaveBeenCalledTimes(1);

    const said = text(result);
    expect(said.err).toBe('');
    expect(said.out).toContain('OK: production has all 3 required migrations of this commit. The deploy can go on.');
    expect(said.out).toMatch(/^ {2}03 {2}2026_10_11_03_function_grants_lockdown {2}required {2}A1 +applied 2026-10-12 08:01 UTC$/m);
    expect(said.notes).toEqual([]);
  });

  it('stops the deploy when one required migration is missing, and names it', async () => {
    const result = await decide({ env: WITH_SECRET, migrations, read: answering(rowsOf(LEDGER_01, NULL_GUARD_02)) });
    expect(result.verdict).toBe('missing');
    expect(result.exitCode).toBe(1);
    expect(result.missing.map((m) => m.name)).toEqual([GRANTS_03]);

    const said = text(result);
    expect(said.err).toContain('REFUSED: 1 required migration is not applied in production:');
    // Its number, its name, the checkpoint that applies it, the page that says how.
    expect(said.err).toMatch(/^ {4}03 {2}2026_10_11_03_function_grants_lockdown {2}Checkpoint A1 {2}docs\/runbook\/migrations\/03-function-grants-lockdown\.md$/m);
    expect(said.err).toContain('Re-run failed jobs');
    expect(said.err).toContain(PAGE);
    expect(said.out).toMatch(/^ {2}03 {2}2026_10_11_03_function_grants_lockdown {2}required {2}A1 +MISSING$/m);
    expect(said.out).not.toContain('OK:');
    // The migrations that ARE applied are not in the refusal.
    expect(said.err).not.toContain(LEDGER_01);
    expect(said.notes).toEqual([{
      level: 'error',
      title: 'Deploy stopped',
      text: expect.stringContaining(`${GRANTS_03} (Checkpoint A1)`),
    }]);
  });

  it('names every missing one, in the order they are applied', async () => {
    const result = await decide({ env: WITH_SECRET, migrations, read: answering(rowsOf(LEDGER_01)) });
    expect(result.exitCode).toBe(1);
    expect(result.missing.map((m) => m.name)).toEqual([NULL_GUARD_02, GRANTS_03]);
    const { err } = text(result);
    expect(err).toContain('REFUSED: 2 required migrations are not applied in production:');
    expect(err.indexOf(NULL_GUARD_02)).toBeLessThan(err.indexOf(GRANTS_03));
  });

  it('does not ask for an optional migration', async () => {
    const result = await decide({ env: WITH_SECRET, migrations, read: answering(rowsOf(...REQUIRED, PIN_43)) });
    expect(result).toMatchObject({ verdict: 'applied', exitCode: 0, missing: [] });
    expect(text(result).out).toMatch(/^ {2}19 {2}2026_10_20_19_rest_push_cron +optional {2}B +not applied — not needed \(optional\)$/m);
  });

  it('does not ask for a contract migration: it is applied long after the deploy', async () => {
    const result = await decide({ env: WITH_SECRET, migrations, read: answering(rowsOf(...REQUIRED, CRON_19)) });
    expect(result).toMatchObject({ verdict: 'applied', exitCode: 0, missing: [] });
    expect(text(result).out).toMatch(/^ {2}43 {2}2026_11_30_43_set_logs_insert_pin +contract {2}Z +not applied — not needed \(contract: it comes after the deploy\)$/m);
  });

  it('asks for the required ones only, whatever else is or is not there', async () => {
    const result = await decide({ env: WITH_SECRET, migrations, read: answering(rowsOf(CRON_19, PIN_43)) });
    expect(result.exitCode).toBe(1);
    expect(result.missing.map((m) => m.name)).toEqual(REQUIRED);
  });

  it('reads a database without a ledger as a database without any migration', async () => {
    const result = await decide({ env: WITH_SECRET, migrations, read: answering(null) });
    expect(result).toMatchObject({ verdict: 'missing', exitCode: 1, noLedger: true });
    expect(result.missing.map((m) => m.name)).toEqual(REQUIRED);
    const { err } = text(result);
    expect(err).toContain('Production has no ledger at all (no table app_private.app_migrations): migration 01 was never applied there');
    // An empty ledger is not the same thing: the table is there, with no row.
    const empty = await decide({ env: WITH_SECRET, migrations, read: answering([]) });
    expect(empty).toMatchObject({ verdict: 'missing', exitCode: 1, noLedger: false });
    expect(text(empty).err).not.toContain('no ledger at all');
  });

  it('notes a ledger that is ahead of the commit, and lets the deploy go on', async () => {
    const later = '2026_12_01_46_something_later';
    const result = await decide({ env: WITH_SECRET, migrations, read: answering(rowsOf(...REQUIRED, later)) });
    expect(result).toMatchObject({ verdict: 'applied', exitCode: 0, unknown: [later] });
    expect(text(result).out).toContain(`note: the ledger also lists ${later}, which this commit does not know.`);
  });

  it('compares by name, and a name is one migration: a near miss is missing', () => {
    const found = compare(migrations, rowsOf(LEDGER_01, NULL_GUARD_02, `${GRANTS_03}_v2`, '2026_10_11_03_function_grants'));
    expect(found.missing.map((m) => m.name)).toEqual([GRANTS_03]);
    expect(found.unknown).toEqual([`${GRANTS_03}_v2`, '2026_10_11_03_function_grants']);
  });
});

describe('deploy gate: a ledger nobody read', () => {
  it('stops the deploy when no secret is set, and says which secret, where, and what the override is', async () => {
    for (const env of [{}, { [SECRET]: '' }, { [SECRET]: '  \n' }, { [SECRET]: '', [LOCAL_SECRET]: '' }]) {
      const connect = neverRead();
      const result = await decide({ env, migrations, read: connect });
      expect(result).toMatchObject({ verdict: 'no-secret', exitCode: 1 });
      expect(connect).not.toHaveBeenCalled();
    }

    const said = text(await decide({ env: {}, migrations, read: neverRead() }));
    expect(said.err).toContain(`REFUSED: the ledger of production was not read — ${SECRET} is not set.`);
    // What the owner asked the message to say: the secret, where it is set,
    // which page says what it is, and the documented way around.
    expect(said.err).toContain(`set the repository secret ${SECRET} (Settings → Secrets and variables → Actions → Secrets)`);
    expect(said.err).toContain('session-pooler connection string');
    expect(said.err).toContain('BACKUPS.md, section "The nightly run on GitHub"');
    expect(said.err).toContain('BACKUP_PASSPHRASE');
    expect(said.err).toContain(`set the repository VARIABLE ${OVERRIDE} to true`);
    expect(said.err).toContain(`supabase db query --linked "${LEDGER_QUERY}"`);
    expect(said.err).toContain(PAGE);
    // What this commit needs, so that the ledger can be read by hand against it.
    for (const name of REQUIRED) expect(said.err).toContain(name);
    expect(said.err).not.toContain(CRON_19);
    expect(said.err).not.toContain(PIN_43);
    expect(said.out).not.toContain('OK:');
    expect(said.notes).toEqual([{ level: 'error', title: 'Deploy stopped', text: expect.stringContaining(SECRET) }]);
    expect(said.notes[0].text).toContain(OVERRIDE);
  });

  it('goes on without checking when no secret is set and the variable is exactly `true` — and says so loudly', async () => {
    const connect = neverRead();
    const result = await decide({ env: { [OVERRIDE]: 'true' }, migrations, read: connect });
    expect(result).toMatchObject({ verdict: 'unchecked', exitCode: 0 });
    expect(connect).not.toHaveBeenCalled();

    const said = text(result);
    expect(said.err).toContain(`NOT CHECKED: ${SECRET} is not set, and ${OVERRIDE} is true.`);
    expect(said.err).toContain('Nobody has compared that list with production. The deploy goes on.');
    for (const name of REQUIRED) expect(said.err).toContain(name);
    // Never the word of a check that passed.
    expect(said.all).not.toMatch(/\bOK\b/);
    expect(said.notes).toEqual([{
      level: 'warning',
      title: 'Deploy not checked against the database',
      text: expect.stringContaining('nobody compared production with the 3 migrations this commit needs'),
    }]);
  });

  it.each(['TRUE', 'True', '1', 'yes', 'on', 'false', 'true-ish', '"true"'])(
    'does not take %j for the override',
    async (value) => {
      expect(overrideOf({ [OVERRIDE]: value })).toEqual({ value, given: true, allows: false });
      const result = await decide({ env: { [OVERRIDE]: value }, migrations, read: neverRead() });
      expect(result).toMatchObject({ verdict: 'no-secret', exitCode: 1 });
      expect(text(result).err).toContain(`(${OVERRIDE} is set to ${JSON.stringify(value)}. Only the exact value true counts.)`);
    },
  );

  it('takes the word with the line break a pasted value ends with', () => {
    expect(overrideOf({ [OVERRIDE]: ' true\n' })).toEqual({ value: 'true', given: true, allows: true });
    expect(overrideOf({})).toEqual({ value: '', given: false, allows: false });
  });

  it('never lifts a migration that was found missing', async () => {
    const env = { ...WITH_SECRET, [OVERRIDE]: 'true' };
    const result = await decide({ env, migrations, read: answering(rowsOf(LEDGER_01, NULL_GUARD_02)) });
    expect(result).toMatchObject({ verdict: 'missing', exitCode: 1 });
    expect(text(result).err).toContain(`${OVERRIDE} does not lift this`);
  });

  it('checks as soon as a secret is set, and then asks for the variable to be deleted', async () => {
    const env = { ...WITH_SECRET, [OVERRIDE]: 'true' };
    const connect = answering(rowsOf(...REQUIRED));
    const result = await decide({ env, migrations, read: connect });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ verdict: 'applied', exitCode: 0 });
    const said = text(result);
    expect(said.out).toContain(`note: ${OVERRIDE} is still set ("true"). The check ran, so it is not needed: delete the variable.`);
    expect(said.notes).toEqual([{ level: 'warning', title: 'Deploy override still set', text: expect.stringContaining('delete it') }]);
  });

  it('stops the deploy when a secret is set and the ledger cannot be read — with or without the variable', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
    const failing = () => vi.fn(async () => { throw refused; });
    const explain = (error) => `${error.message} (${error.code})\nNothing answers at that address and port.`;

    const plain = await decide({ env: WITH_SECRET, migrations, read: failing() });
    expect(plain).toMatchObject({ verdict: 'unreadable', exitCode: 1, error: refused });
    const said = text(plain, { explain });
    expect(said.err).toContain('REFUSED: the ledger of production could not be read.');
    expect(said.err).toContain('  connect ECONNREFUSED 127.0.0.1:5432 (ECONNREFUSED)\n  Nothing answers at that address and port.');
    expect(said.err).toContain('Nothing says that production has them, so the deploy stops.');
    for (const name of REQUIRED) expect(said.err).toContain(name);
    expect(said.err).not.toContain(OVERRIDE);
    expect(said.notes).toEqual([{
      level: 'error',
      title: 'Deploy stopped',
      // One line: the first of the explanation.
      text: `The ledger of production could not be read: connect ECONNREFUSED 127.0.0.1:5432 (ECONNREFUSED) ${PAGE}`,
    }]);

    // The variable stands in for a secret that is not set. One is set.
    const overridden = await decide({ env: { ...WITH_SECRET, [OVERRIDE]: 'true' }, migrations, read: failing() });
    expect(overridden).toMatchObject({ verdict: 'unreadable', exitCode: 1 });
    expect(text(overridden, { explain }).err).toContain(`${OVERRIDE} is true, and does not apply: it stands in for a secret that is NOT SET.`);

    // The owner's machine: the database password instead of the whole URL.
    const local = await decide({ env: { [LOCAL_SECRET]: 'pw' }, migrations, read: failing() });
    expect(local).toMatchObject({ verdict: 'unreadable', exitCode: 1 });
  });

  it('prints a refusal of the ledger itself as it was written', async () => {
    const why = new GateError('Role reader may not read app_private.app_migrations (…). That says nothing about the migrations.');
    const result = await decide({ env: WITH_SECRET, migrations, read: vi.fn(async () => { throw why; }) });
    expect(result).toMatchObject({ verdict: 'unreadable', exitCode: 1 });
    const explain = vi.fn(() => 'not this');
    expect(text(result, { explain }).err).toContain(`  ${why.message}`);
    expect(explain).not.toHaveBeenCalled();
  });
});

describe('deploy gate: a manifest it cannot judge', () => {
  const judge = (entries) => decide({ env: WITH_SECRET, migrations: entries, read: neverRead() });
  const withKind = (kind) => migrations.map((m) => (m.name === GRANTS_03 ? { ...m, kind } : m));

  it('stops on a kind it does not know, instead of reading it as "not required"', async () => {
    // One letter off: without this the migration is asked of nobody.
    for (const kind of ['requried', 'Required', '', undefined, null]) {
      const result = await judge(withKind(kind));
      expect(result).toMatchObject({ verdict: 'manifest', exitCode: 1 });
      expect(result.faults).toEqual([
        `${GRANTS_03} has kind ${JSON.stringify(kind)}, which is none of required, optional, contract`,
      ]);
    }
    const said = text(await judge(withKind('requried')));
    expect(said.err).toContain('REFUSED: supabase/migrations/manifest.json cannot be judged:');
    expect(said.err).toContain(`  - ${GRANTS_03} has kind "requried"`);
    expect(said.notes).toEqual([{ level: 'error', title: 'Deploy stopped', text: expect.stringContaining('cannot be judged') }]);
  });

  it('stops on a list that is empty, has no required migration, a name twice, or a name that is not one', async () => {
    expect(manifestFaults([])).toEqual(['it lists no migration']);
    expect(manifestFaults(undefined)).toEqual(['it lists no migration']);
    expect(manifestFaults(migrations.filter((m) => m.kind !== 'required'))).toEqual(['none of its migrations is `required`']);
    expect(manifestFaults([...migrations, migrations[0]])).toEqual([`${LEDGER_01} is listed twice`]);
    expect(manifestFaults([...migrations, { name: '2026_10_03_migration_ledger', kind: 'required' }])).toEqual([
      '"2026_10_03_migration_ledger" is not a migration name (YYYY_MM_DD_NN_name)',
    ]);
    expect(manifestFaults([...migrations, {}])).toEqual(['undefined is not a migration name (YYYY_MM_DD_NN_name)']);
    for (const entries of [[], migrations.filter((m) => m.kind !== 'required'), [...migrations, migrations[0]]]) {
      expect(await judge(entries)).toMatchObject({ verdict: 'manifest', exitCode: 1 });
    }
  });

  it('is not lifted by the variable either', async () => {
    const result = await decide({ env: { [OVERRIDE]: 'true' }, migrations: withKind('requried'), read: neverRead() });
    expect(result).toMatchObject({ verdict: 'manifest', exitCode: 1 });
  });

  it('finds nothing to say about the manifest of the repository', () => {
    const real = loadManifest(root).migrations;
    expect(real.length).toBeGreaterThan(1);
    expect(manifestFaults(real)).toEqual([]);
    expect(real[0]).toMatchObject({ name: LEDGER_01, kind: 'required' });
  });
});

// ------------------------------------------------------------
// readLedger(), against a server that is a function
// ------------------------------------------------------------
describe('deploy gate: reading the ledger', () => {
  const STATE = {
    role: 'postgres',
    database: 'postgres',
    server_version: '17.6',
    read_only: 'on',
    has_schema: true,
    has_table: true,
    may_use: true,
    may_select: true,
    filtered: false,
  };

  /** A `query(sql)` that answers like the server would, and keeps what it was sent. */
  function server({ state = {}, rows = [], failOn = null } = {}) {
    const sent = [];
    const query = async (sql) => {
      sent.push(sql);
      if (failOn?.test(sql)) throw Object.assign(new Error('the server said no'), { code: '57014' });
      if (sql === BEGIN_READ_ONLY || sql === 'ROLLBACK') return { rows: [] };
      if (sql === LEDGER_QUERY) return { rows };
      if (/\bcurrent_user\b/.test(sql)) return { rows: [{ ...STATE, ...state }] };
      throw new Error(`a statement the gate has no business sending: ${sql}`);
    };
    return { query, sent };
  }

  it('reads in one read-only transaction, sends nothing but reads, and rolls back', async () => {
    const { query, sent } = server({ rows: [{ name: LEDGER_01, applied_at: APPLIED_AT, extra: 'dropped' }] });
    const state = await readLedger(query);
    expect(state).toEqual({
      role: 'postgres', database: 'postgres', serverVersion: '17.6', ledger: [{ name: LEDGER_01, applied_at: APPLIED_AT }],
    });
    expect(sent).toHaveLength(4);
    expect(sent[0]).toBe('BEGIN TRANSACTION READ ONLY');
    expect(sent[2]).toBe(LEDGER_QUERY);
    expect(sent[3]).toBe('ROLLBACK');
    for (const sql of sent.slice(1, 3)) {
      expect(sql.trim()).toMatch(/^select\b/i);
      expect(sql).not.toMatch(/\b(?:insert|update|delete|truncate|create|alter|drop|grant|revoke|set_config|nextval|commit)\b/i);
      expect(sql).not.toContain(';');
    }
    // The catalog is asked about the ledger by the name the migrations use.
    expect(sent[1]).toContain("n.nspname = 'app_private'");
    expect(sent[1]).toContain("c.relname = 'app_migrations'");
  });

  it('asks production what the runbook asks it', () => {
    expect(LEDGER_QUERY).toBe('select name, applied_at from app_private.app_migrations order by applied_at, name');
    expect(read('docs/runbook/00-before-you-start.md')).toContain(`supabase db query --linked "${LEDGER_QUERY}"`);
  });

  it('answers "no ledger" for a database without the schema or without the table, and does not touch the table', async () => {
    for (const state of [{ has_schema: false, has_table: false }, { has_schema: true, has_table: false }]) {
      const { query, sent } = server({ state: { ...state, may_use: false, may_select: false } });
      expect((await readLedger(query)).ledger).toBeNull();
      expect(sent).not.toContain(LEDGER_QUERY);
      expect(sent.at(-1)).toBe('ROLLBACK');
    }
  });

  it('refuses a role that may not read the table, rather than report its migrations missing', async () => {
    for (const state of [{ may_use: false }, { may_select: false }, { may_use: false, may_select: false }]) {
      const { query, sent } = server({ state: { ...state, role: 'reader' } });
      await expect(readLedger(query)).rejects.toThrow(GateError);
      await expect(readLedger(server({ state: { ...state, role: 'reader' } }).query)).rejects.toThrow(
        /^Role reader may not read app_private\.app_migrations .*That says nothing about the migrations\.$/,
      );
      expect(sent).not.toContain(LEDGER_QUERY);
      expect(sent.at(-1)).toBe('ROLLBACK');
    }
  });

  it('refuses a ledger that row-level security would filter for this role', async () => {
    const { query, sent } = server({ state: { filtered: true, role: 'reader' } });
    await expect(readLedger(query)).rejects.toThrow(/^Row-level security is on for app_private\.app_migrations and applies to role reader/);
    expect(sent).not.toContain(LEDGER_QUERY);
    expect(sent.at(-1)).toBe('ROLLBACK');
  });

  it('refuses to read when the server did not open a read-only transaction', async () => {
    const { query, sent } = server({ state: { read_only: 'off' } });
    await expect(readLedger(query)).rejects.toThrow('The server did not open a read-only transaction; nothing was read.');
    expect(sent).not.toContain(LEDGER_QUERY);
  });

  it('passes on what the server raised, after ending the transaction — even on a connection that is gone', async () => {
    const { query, sent } = server({ failOn: /from app_private\.app_migrations/ });
    await expect(readLedger(query)).rejects.toMatchObject({ code: '57014' });
    expect(sent.at(-1)).toBe('ROLLBACK');

    const dead = server({ failOn: /current_user|ROLLBACK/ });
    await expect(readLedger(dead.query)).rejects.toMatchObject({ code: '57014', message: 'the server said no' });
  });
});

// ------------------------------------------------------------
// The page the owner reads when the job is red
// ------------------------------------------------------------
describe(`${PAGE}: what it quotes is what the command says`, () => {
  const page = read(PAGE);
  const tooFar = Object.assign(new Error('connect ENETUNREACH'), { code: 'ENETUNREACH' });
  const verdictOf = (env, readStub, entries = migrations) => decide({ env, migrations: entries, read: readStub });
  const refusing = (state) => async () => {
    const answers = {
      role: 'reader', database: 'postgres', server_version: '17.6', read_only: 'on',
      has_schema: true, has_table: true, may_use: true, may_select: true, filtered: false, ...state,
    };
    return readLedger(async (sql) => ({ rows: /\bcurrent_user\b/.test(sql) ? [answers] : [] }));
  };

  // Every ending the command has, as text.
  let said;
  beforeAll(async () => {
    const results = await Promise.all([
      verdictOf(WITH_SECRET, answering(rowsOf(...REQUIRED, '2026_12_01_46_something_later'))),
      verdictOf({ ...WITH_SECRET, [OVERRIDE]: 'true' }, answering(rowsOf(...REQUIRED))),
      verdictOf(WITH_SECRET, answering(rowsOf(LEDGER_01))),
      verdictOf(WITH_SECRET, answering(null)),
      verdictOf({}, neverRead()),
      verdictOf({ [OVERRIDE]: 'true' }, neverRead()),
      verdictOf(WITH_SECRET, async () => { throw tooFar; }),
      verdictOf(WITH_SECRET, refusing({ may_use: false })),
      verdictOf(WITH_SECRET, refusing({ filtered: true })),
      verdictOf(WITH_SECRET, neverRead(), migrations.map((m) => ({ ...m, kind: 'requried' }))),
    ]);
    expect(results.map((r) => r.verdict)).toEqual([
      'applied', 'applied', 'missing', 'missing', 'no-secret', 'unchecked', 'unreadable', 'unreadable', 'unreadable', 'manifest',
    ]);
    said = results.map((result) => text(result).all).join('\n');
  });

  // `REFUSED: … not applied in production` → a pattern, the … standing for anything on the line.
  const pattern = (quoted) => new RegExp(quoted.split('…').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*'));
  const spans = [...page.matchAll(/`([^`\n]+)`/g)].map(([, span]) => span);
  const MESSAGE = /^(?:REFUSED\b|NOT CHECKED\b|OK: |Production has |the ledger also lists |Role … may not read |Row-level security is on )/;

  it('quotes messages, and all of them are ones the command prints', () => {
    const quoted = [...new Set(spans.filter((span) => MESSAGE.test(span)))];
    // The cases of section 4, the two endings of section 2, the override, the note.
    expect(quoted.length).toBeGreaterThanOrEqual(10);
    expect(quoted.filter((span) => !pattern(span).test(said))).toEqual([]);
    expect(pattern('REFUSED: … not applied in production').test('REFUSED: the ledger was read')).toBe(false);
  });

  it('names the crash of the check as the command prints it', () => {
    expect(page).toContain('`FAILED:`');
    expect(read('scripts/check-migrations.mjs')).toContain('warn(`\\nFAILED: ');
  });

  it('shows the table the command prints', async () => {
    const sample = /```text\n([\s\S]*?)\n```/.exec(page)?.[1];
    expect(sample).toBeTruthy();
    const three = migrations.slice(0, 3);
    const result = await decide({
      env: WITH_SECRET,
      migrations: three,
      read: answering([
        { name: LEDGER_01, applied_at: new Date('2026-10-12T08:01:10Z') },
        { name: NULL_GUARD_02, applied_at: new Date('2026-10-12T08:03:59Z') },
      ]),
    });
    expect(render(result).out.filter((line) => line.startsWith('  ')).join('\n')).toBe(sample);
  });

  it('gives the two commands, and links pages that exist', () => {
    const fences = [...page.matchAll(/```bash\n([\s\S]*?)\n```/g)].map(([, body]) => body);
    expect(fences).toContain('node --env-file=.env scripts/check-migrations.mjs --verify');
    expect(fences).toContain('node scripts/check-migrations.mjs --print');
    expect(fences).toContain(`supabase db query --linked "${LEDGER_QUERY}"`);
    const links = [...new Set([...page.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)].map(([, target]) => target))];
    expect(links.length).toBeGreaterThan(2);
    expect(links.filter((target) => !fs.existsSync(path.resolve(root, path.dirname(PAGE), target)))).toEqual([]);
    // The section of BACKUPS.md it sends to for the secret is there under that name.
    expect(page).toContain('*The nightly run on GitHub*');
    expect(read('BACKUPS.md')).toContain('\n## The nightly run on GitHub\n');
    expect(read('BACKUPS.md')).toContain(`\`${SECRET}\``);
  });
});

// ------------------------------------------------------------
// The command, where it connects to nothing
// ------------------------------------------------------------
// Each test starts Node a few times. On a busy two-core runner that is not
// five seconds' work for certain, and this file is part of the deploy's own
// gate: a test that times out there holds up a deploy for nothing.
describe('scripts/check-migrations.mjs', { timeout: 30_000 }, () => {
  /** The command with ONLY `env`: nothing of this machine's environment reaches it. */
  const cli = (args, env = {}) => spawnSync(process.execPath, ['scripts/check-migrations.mjs', ...args], {
    cwd: root,
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  const real = loadManifest(root).migrations;

  // A port of this machine nothing listens on.
  let closedPort;
  beforeAll(async () => {
    closedPort = await new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.on('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const { port } = probe.address();
        probe.close(() => resolve(port));
      });
    });
  });

  it('--print lists the manifest and the read-only query, and connects to nothing', () => {
    // A URL that would fail at once if it were used.
    const result = cli(['--print'], { [SECRET]: 'not a url' });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    for (const { name, kind, order } of real) {
      expect(result.stdout).toMatch(new RegExp(`^ {2}${String(order).padStart(2, '0')} {2}${name} +${kind} `, 'm'));
    }
    const required = real.filter((m) => m.kind === 'required').length;
    expect(result.stdout).toContain(`A deploy of this commit needs ${required} of ${real.length} in production`);
    expect(result.stdout).toContain(`\n  ${LEDGER_QUERY}\n`);
    expect(result.stdout).toContain(`supabase db query --linked "${LEDGER_QUERY}"`);
    expect(describeManifest(real).join('\n')).toBe(result.stdout.trimEnd());
  });

  it('--verify without a secret exits 1 with the refusal, and annotates the run on GitHub only', () => {
    const local = cli(['--verify']);
    expect(local.status).toBe(1);
    expect(local.stderr).toContain(`REFUSED: the ledger of production was not read — ${SECRET} is not set.`);
    expect(local.stderr).toContain(OVERRIDE);
    expect(local.stdout).not.toContain('::error');
    expect(local.stdout).not.toContain('OK:');

    const onGitHub = cli(['--verify'], { GITHUB_ACTIONS: 'true', [SECRET]: '', [OVERRIDE]: '' });
    expect(onGitHub.status).toBe(1);
    const annotations = onGitHub.stdout.split('\n').filter((line) => line.startsWith('::'));
    expect(annotations).toHaveLength(1);
    expect(annotations[0]).toMatch(new RegExp(`^::error title=Deploy stopped::The ledger of production was not read: the repository secret ${SECRET} is not set\\.`));
  });

  it('--verify without a secret exits 0 when the variable is `true`, with a warning on the run', () => {
    const result = cli(['--verify'], { GITHUB_ACTIONS: 'true', [SECRET]: '', [OVERRIDE]: 'true' });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain(`NOT CHECKED: ${SECRET} is not set, and ${OVERRIDE} is true.`);
    expect(result.stdout.split('\n').filter((line) => line.startsWith('::'))).toEqual([
      expect.stringMatching(/^::warning title=Deploy not checked against the database::/),
    ]);
    expect(cli(['--verify'], { [OVERRIDE]: 'yes' }).status).toBe(1);
  });

  it('--verify exits 1 when the secret is set and the database does not answer — and prints no part of the secret', () => {
    const password = 'S3cret/+@:#?&=% word';
    const url = `postgresql://postgres.abcdefghijklmnopqrst:${encodeURIComponent(password)}@127.0.0.1:${closedPort}/postgres`;
    for (const extra of [{}, { [OVERRIDE]: 'true' }]) {
      const result = cli(['--verify'], { GITHUB_ACTIONS: 'true', [SECRET]: url, ...extra });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('  source     postgres.abcdefghijklmnopqrst at 127.0.0.1 (SUPABASE_DB_URL), no TLS (local address)');
      expect(result.stderr).toContain('REFUSED: the ledger of production could not be read.');
      expect(result.stderr).toContain('(ECONNREFUSED)');
      expect(result.stderr).toContain('Nothing answers at that address and port.');
      expect(result.stdout).toMatch(/^::error title=Deploy stopped::The ledger of production could not be read: /m);
      const all = result.stdout + result.stderr;
      for (const secret of [url, password, encodeURIComponent(password)]) expect(all).not.toContain(secret);
      expect(all).not.toMatch(/postgres(?:ql)?:\/\/\S*@/);
      expect(all).not.toContain('OK:');
    }
  });

  it('--verify exits 1 on a secret that is not a connection string, without printing it', () => {
    const result = cli(['--verify'], { [SECRET]: 'hunter2-is-not-a-url' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('REFUSED: the ledger of production could not be read.');
    expect(result.stderr).toContain('SUPABASE_DB_URL is not a PostgreSQL connection URL.');
    expect(result.stdout + result.stderr).not.toContain('hunter2');
  });

  it('exits 2 on a command line it does not understand, and 0 on --help', () => {
    for (const args of [[], ['--print', '--verify'], ['--check'], ['--verify', 'extra']]) {
      const result = cli(args);
      expect(result.status, `args: ${args.join(' ') || '(none)'}`).toBe(2);
      expect(result.stderr).toContain('Usage: node scripts/check-migrations.mjs --print');
    }
    const help = cli(['--help']);
    expect(help.status).toBe(0);
    for (const word of ['--print', '--verify', SECRET, LOCAL_SECRET, OVERRIDE, PAGE]) expect(help.stdout).toContain(word);
  });

  it('is `npm run check:migrations`', () => {
    expect(JSON.parse(read('package.json')).scripts['check:migrations']).toBe('node scripts/check-migrations.mjs');
  });
});
