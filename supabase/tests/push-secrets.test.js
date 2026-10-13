// The vault statements of docs/runbook/30-edge-functions.md.
//
// send-push lets in whoever presents the project's INTERNAL_BEARER. The
// database holds its copy in the vault, under `app_service_role_key`, and
// send_push_event() sends it for every notify_* trigger (since migration 15,
// which also reads it under `app_internal_bearer` — the rename is that
// migration's page, and push-plumbing.test.js). The page has the owner look at the vault,
// and change that copy when the secret is rotated — by hand, in production,
// with statements nothing else runs. If one of them is wrong, the two copies
// differ, send-push answers the database 401, and no push is sent: silently,
// since the triggers do not read the answer.
//
// The statements are read off the page. What is tested is what the owner
// will paste, after the shell has put the secret where `$INTERNAL_BEARER`
// stands, against the triggers that read the vault.
//
// SHIM LIMIT: the vault of the harness does not encrypt (shim.sql, section 5).
// What it has in common with supabase_vault 0.3.1 is what these statements
// rely on: the two functions and their arguments, the view, and who may use
// them.

import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  asUser, attempt, enablePush, httpCalls, repoRoot, scenario, scratchDatabase, seed,
} from './harness.js';

const PAGE = 'docs/runbook/30-edge-functions.md';
const page = fs.readFileSync(path.join(repoRoot, PAGE), 'utf8');

// On the page a statement is the argument of the CLI, between double quotes,
// on one line. Each is found by a word no other one has.
const pasted = [...page.matchAll(/^supabase db query --linked "([^"\n]+)"$/gm)].map(([, sql]) => sql);
const statement = (word) => pasted.filter((sql) => sql.includes(word));
const [LOOK] = statement('case when name');
const [UPDATE] = statement('vault.update_secret(');
const [SAME] = statement('vault_holds_the_value_of_this_shell');
const [CREATE] = statement('vault.create_secret(');

// What bash does to the argument: inside double quotes, the variable is
// replaced by its value, and nothing else on these lines is special.
const inShell = (sql, bearer) => sql.replaceAll('$INTERNAL_BEARER', bearer);

const URL = 'https://functions.sl.test/functions/v1';
const OLD = 'the-bearer-in-use-before-the-rotation';
// What `openssl rand -hex 32` prints.
const NEW = '4e1f0a9b8c7d6e5f4a3b2c1d0e9d3e1f0a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d';

let ids;
beforeAll(async () => { ids = await seed(); });

// An event that makes the database call send-push: an athlete confirms a
// session, the coach is notified.
const confirm = (n) => asUser(ids.studentA, (a) => a(
  `insert into session_confirmations (session_id, student_id) values ($1, $2)`,
  [ids.programA.sessions[n], ids.studentA.id],
));
const lastCall = async () => (await httpCalls()).at(-1);

describe(`${PAGE}: the vault statements`, () => {
  it('are on the page: four statements, each one of a kind', () => {
    expect(pasted).toHaveLength(4);
    for (const word of ['case when name', 'vault.update_secret(', 'vault_holds_the_value_of_this_shell', 'vault.create_secret(']) {
      expect(statement(word), word).toHaveLength(1);
    }
  });

  it('are single statements, and the shell reads nothing in them but the variable', () => {
    for (const sql of pasted) {
      expect(sql).toMatch(/^select /);
      expect(sql).not.toContain(';');
      // Inside double quotes bash still reads $, `, \ and !.
      expect(inShell(sql, '')).not.toMatch(/[$`\\!]/);
    }
    expect(LOOK).not.toContain('$INTERNAL_BEARER');
    // The value goes into a SQL string as it is. That is safe for what the
    // page generates, and only for that: hexadecimal, no quote to close.
    expect(page).toContain('export INTERNAL_BEARER="$(openssl rand -hex 32)"');
    for (const sql of [UPDATE, SAME, CREATE]) expect(sql).toContain(`'$INTERNAL_BEARER'`);
  });
});

describe(`${PAGE}: looking at the vault`, () => {
  it('shows where the database calls, and never the bearer', () => scenario(async (q) => {
    await enablePush({ url: URL, bearer: OLD });
    const rows = await q.rows(LOOK);
    expect(rows.map(({ name, value }) => ({ name, value }))).toEqual([
      { name: 'app_functions_url', value: URL },
      { name: 'app_service_role_key', value: null },
    ]);
    expect(Object.keys(rows[0])).toEqual(['name', 'value', 'updated_at']);
    expect(JSON.stringify(rows)).not.toContain(OLD);
  }));

  it('shows a row less when a secret is missing, which is when the triggers send nothing', () => scenario(async (q) => {
    expect(await q.rows(LOOK)).toEqual([]);
    await confirm(0);
    expect(await httpCalls()).toEqual([]);

    await q(`select vault.create_secret($1, 'app_functions_url')`, [URL]);
    expect((await q.rows(LOOK)).map(({ name }) => name)).toEqual(['app_functions_url']);
    await confirm(1);
    expect(await httpCalls()).toEqual([]);
  }));

  // The two statements that only look, the way an audit file is run: in a
  // READ ONLY transaction, where any write raises.
  it('reads, and writes nothing', async () => {
    const db = await scratchDatabase({ from: 'schema' });
    await db.query(`select vault.create_secret($1, 'app_functions_url')`, [URL]);
    await db.query(`select vault.create_secret($1, 'app_service_role_key')`, [OLD]);

    const [look] = await db.readOnly(LOOK, 'the look at the vault');
    expect(look.rows.map(({ name }) => name)).toEqual(['app_functions_url', 'app_service_role_key']);
    const [same] = await db.readOnly(inShell(SAME, OLD), 'the comparison with the shell');
    expect(same.rows).toEqual([{ vault_holds_the_value_of_this_shell: true }]);

    // The two that write are refused there: they are not looks.
    for (const sql of [inShell(UPDATE, NEW), inShell(CREATE, NEW)]) {
      const tried = await attempt(() => db.readOnly(sql, 'a statement that writes'));
      expect(tried.ok, sql).toBe(false);
      expect(tried.error.code, sql).toBe('25006');
    }
    await db.drop();
  });
});

describe(`${PAGE}: rotating the bearer`, () => {
  it('makes the triggers send the new value, to the same place', () => scenario(async (q) => {
    await enablePush({ url: URL, bearer: OLD });
    await confirm(0);
    expect(await lastCall()).toMatchObject({ url: `${URL}/send-push`, headers: { Authorization: `Bearer ${OLD}` } });

    const result = await q(inShell(UPDATE, NEW));
    expect(result.rowCount).toBe(1);

    await confirm(1);
    expect(await lastCall()).toMatchObject({ url: `${URL}/send-push`, headers: { Authorization: `Bearer ${NEW}` } });
    expect(await q.value(`select count(*) from vault.secrets`)).toBe(2);
    expect(await q.value(`select decrypted_secret from vault.decrypted_secrets where name = 'app_functions_url'`)).toBe(URL);
  }));

  it('says whether the vault holds the value of the shell, without printing it', () => scenario(async (q) => {
    await enablePush({ url: URL, bearer: OLD });
    const answer = async (bearer) => q.rows(inShell(SAME, bearer));

    // Before the third command of the rotation, and after it.
    expect(await answer(NEW)).toEqual([{ vault_holds_the_value_of_this_shell: false }]);
    await q(inShell(UPDATE, NEW));
    expect(await answer(NEW)).toEqual([{ vault_holds_the_value_of_this_shell: true }]);

    // A shell that is not the one of the rotation: another value, or none
    // (the variable was unset, and bash leaves an empty string).
    expect(await answer(OLD)).toEqual([{ vault_holds_the_value_of_this_shell: false }]);
    expect(await answer('')).toEqual([{ vault_holds_the_value_of_this_shell: false }]);
  }));

  it('touches no row when the vault has no such secret, and the page\'s other statement creates it', () => scenario(async (q) => {
    await q(`select vault.create_secret($1, 'app_functions_url')`, [URL]);

    const result = await q(inShell(UPDATE, NEW));
    expect(result.rowCount).toBe(0);
    expect(await q.rows(inShell(SAME, NEW))).toEqual([]);
    expect(await q.value(`select count(*) from vault.secrets`)).toBe(1);

    await q(inShell(CREATE, NEW));
    expect(await q.rows(inShell(SAME, NEW))).toEqual([{ vault_holds_the_value_of_this_shell: true }]);
    await confirm(0);
    expect(await lastCall()).toMatchObject({ url: `${URL}/send-push`, headers: { Authorization: `Bearer ${NEW}` } });
  }));

  // The recipe the README and schema.sql carried: `UPDATE vault.secrets SET
  // secret = '<new>'`. The owner's role may not write that table — and where
  // it may, the value would be stored as typed, not encrypted.
  it('goes through vault.update_secret, because the table itself cannot be written', async () => {
    await scenario(async (q) => {
      await enablePush({ url: URL, bearer: OLD });
      const direct = await attempt(() => q(
        `update vault.secrets set secret = $1 where name = 'app_service_role_key'`, [NEW],
      ));
      expect(direct.ok).toBe(false);
      expect(direct.error.message).toMatch(/permission denied/);
      expect(await q.rows(inShell(SAME, OLD))).toEqual([{ vault_holds_the_value_of_this_shell: true }]);
    });
    expect(page).toContain('`vault.update_secret`, not with `UPDATE vault.secrets`');
  });

  it('is the owner\'s to run: a signed-in coach reaches neither the vault nor its functions', async () => {
    for (const sql of [LOOK, inShell(SAME, OLD), inShell(UPDATE, NEW), inShell(CREATE, NEW)]) {
      const tried = await attempt(() => asUser(ids.coach, (c) => c(sql)));
      expect(tried.ok, sql).toBe(false);
      expect(tried.error.message, sql).toMatch(/permission denied/);
    }
  });
});
