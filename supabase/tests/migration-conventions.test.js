// Every migration of supabase/migrations/manifest.json follows the format of
// supabase/migrations/README.md — checked on the text of its files, and by
// running it: on the production baseline, in manifest order, each one is
//
//   refused without its predecessor → applied → refused a second time
//   → rolled back → refused a second rollback → applied again
//
// with its audit run read-only before and after. The catalog is compared at
// each step, so a rollback that leaves something behind does not pass. Then
// the list is applied once more with the optional migrations left out: the
// others must not need them.
//
// The rules live in migration-checks.js. The last block of this file runs them
// on migrations that are wrong on purpose: a judge that accepts everything
// would otherwise look exactly like a green suite.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot, scratchDatabase } from './harness.js';
import { checkMigration, staticProblems, withoutOptionalProblems } from './migration-checks.js';
import {
  LEDGER, loadManifest, MANIFEST_FILE, manifestProblems, orderOf, pathsOf, predecessorOf,
} from '../migrations/manifest.js';

const manifest = loadManifest();
const read = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8');
const filesOf = (migration) => ({
  name: migration.name,
  kind: migration.kind,
  predecessor: predecessorOf(manifest.migrations, migration)?.name ?? null,
  reversible: migration.reversible,
  up: read(migration.paths.migration),
  down: read(migration.paths.rollback),
  audit: read(migration.paths.audit),
});
const each = manifest.migrations.map((migration) => [migration.name, migration]);

// ------------------------------------------------------------
describe('supabase/migrations/manifest.json', () => {
  it('lists every migration file, each with its audit, its rollback and its runbook page', () => {
    expect(manifestProblems(manifest)).toEqual([]);
  });

  it('starts with the ledger: nothing can sign a table that does not exist yet', () => {
    expect(manifest.migrations[0]?.name).toMatch(/_01_migration_ledger$/);
    expect(predecessorOf(manifest.migrations, manifest.migrations[0])).toBeNull();
  });

  it.each(each)('%s: its runbook page names the three files', (_, migration) => {
    const page = read(migration.paths.runbook);
    for (const file of [migration.paths.migration, migration.paths.audit, migration.paths.rollback]) {
      expect(page, `${migration.paths.runbook} does not mention ${file}`).toContain(file);
    }
  });
});

// ------------------------------------------------------------
describe('each migration of the manifest', () => {
  it.each(each)('%s is written in the format', (_, migration) => {
    expect(staticProblems(filesOf(migration))).toEqual([]);
  });

  describe('run on the production baseline, in order', () => {
    let db;
    beforeAll(async () => {
      db = await scratchDatabase();
      await db.runFile(manifest.baseline);
    });

    it.each(each)(
      '%s: refused out of order, applied, refused twice, rolled back, applied again',
      async (_, migration) => {
        expect(await checkMigration(db, filesOf(migration))).toEqual([]);
      },
    );

    it('leaves a ledger with one row per migration, in the order they were applied', async () => {
      const rows = await db.query.rows(`select name from ${LEDGER} order by applied_at, name`);
      expect(rows.map((row) => row.name)).toEqual(manifest.migrations.map((m) => m.name));
    });
  });

  // The run above always has the optional migrations applied. Production may not.
  it('run on the production baseline without the optional ones, the others still apply', async () => {
    const db = await scratchDatabase();
    await db.runFile(manifest.baseline);
    expect(await withoutOptionalProblems(db, manifest.migrations.map(filesOf))).toEqual([]);

    const rows = await db.query.rows(`select name from ${LEDGER} order by applied_at, name`);
    expect(rows.map((row) => row.name)).toEqual(
      manifest.migrations.filter((m) => m.kind !== 'optional').map((m) => m.name),
    );
  });
});

// ------------------------------------------------------------
describe('the manifest reader', () => {
  it('derives the files of a migration from its name', () => {
    expect(pathsOf('2026_10_03_02_rpc_auth_null_guard')).toEqual({
      migration: 'supabase/migrations/2026_10_03_02_rpc_auth_null_guard.sql',
      audit: 'supabase/audits/2026_10_03_02_rpc_auth_null_guard.audit.sql',
      rollback: 'supabase/rollbacks/2026_10_03_02_rpc_auth_null_guard.down.sql',
      runbook: 'docs/runbook/migrations/02-rpc-auth-null-guard.md',
    });
    expect(orderOf('2026_10_03_02_rpc_auth_null_guard')).toBe(2);
  });

  it('makes a migration require the nearest one nobody may skip', () => {
    const list = [
      { name: 'a', kind: 'required' },
      { name: 'b', kind: 'optional' },
      { name: 'c', kind: 'required' },
      { name: 'd', kind: 'contract' },
      { name: 'e', kind: 'contract' },
      { name: 'f', kind: 'required' },
    ];
    const requires = Object.fromEntries(list.map((m) => [m.name, predecessorOf(list, m)?.name ?? null]));
    expect(requires).toEqual({
      a: null,
      b: 'a',   // an optional migration builds on a required one…
      c: 'a',   // …and the next required one must not need it
      d: 'c',
      e: 'd',   // contract files are applied together, in order
      f: 'c',   // a required migration never waits for a contract one
    });
  });

  // The judge of the manifest, in a folder of its own: two migrations in the
  // format and two files of the history. The real repository gains a migration
  // with every package, and what is tested here is the judge, not what is on
  // disk today.
  describe('judging a manifest against the files around it', () => {
    const FIRST = '2099_01_01_01_first';
    const SECOND = '2099_01_02_02_second';
    const BASELINE = 'supabase/tests/fixtures/baseline.sql';
    const entry = (name, more = {}) => ({
      name, kind: 'required', wave: 0, checkpoint: 'A0', covers: [], reversible: true, summary: 'A fixture.', ...more,
    });
    const both = [entry(FIRST), entry(SECOND)];

    let root;
    const write = (file, text = '') => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    };
    // Through manifest.json, the way the real one is read.
    const judge = (migrations, baseline = BASELINE) => {
      write(MANIFEST_FILE, JSON.stringify({ baseline, migrations }));
      return manifestProblems(loadManifest(root), root);
    };

    beforeAll(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-manifest-'));
      write(BASELINE);
      for (const name of [FIRST, SECOND]) Object.values(pathsOf(name)).forEach((file) => write(file));
      // The history: files from before the ledger, under the two names they have.
      write('supabase/migrations/2026_08_22_move_session.sql');
      write('supabase/migrations/20260416_set_logs_weight_kg.sql');
      write('supabase/migrations/README.md');
    });
    afterAll(() => root && fs.rmSync(root, { recursive: true, force: true }));

    it('accepts a folder where every migration is listed, and the history before the ledger', () => {
      expect(judge(both)).toEqual([]);
    });

    it('a migration on disk that is not listed', () => {
      expect(judge([entry(FIRST)])).toEqual([
        `supabase/migrations/${SECOND}.sql: not in supabase/migrations/manifest.json. `
        + 'A new migration is named YYYY_MM_DD_NN_name.sql and listed there.',
        `supabase/audits/${SECOND}.audit.sql: no migration of supabase/migrations/manifest.json has that name (expected <name>.audit.sql)`,
        `supabase/rollbacks/${SECOND}.down.sql: no migration of supabase/migrations/manifest.json has that name (expected <name>.down.sql)`,
      ]);
    });

    it('a migration that is listed and has none of its four files', () => {
      expect(judge([...both, entry('2099_01_03_03_ghost')])).toEqual([
        '2099_01_03_03_ghost: its migration file supabase/migrations/2099_01_03_03_ghost.sql does not exist',
        '2099_01_03_03_ghost: its audit file supabase/audits/2099_01_03_03_ghost.audit.sql does not exist',
        '2099_01_03_03_ghost: its rollback file supabase/rollbacks/2099_01_03_03_ghost.down.sql does not exist',
        '2099_01_03_03_ghost: its runbook file docs/runbook/migrations/03-ghost.md does not exist',
      ]);
    });

    it('an audit or a rollback that is not named after its migration', () => {
      const strays = [`supabase/audits/${FIRST}.sql`, `supabase/rollbacks/${FIRST}.rollback.sql`];
      strays.forEach((file) => write(file));
      try {
        expect(judge(both)).toEqual([
          `supabase/audits/${FIRST}.sql: no migration of supabase/migrations/manifest.json has that name (expected <name>.audit.sql)`,
          `supabase/rollbacks/${FIRST}.rollback.sql: no migration of supabase/migrations/manifest.json has that name (expected <name>.down.sql)`,
        ]);
      } finally {
        strays.forEach((file) => fs.rmSync(path.join(root, file)));
      }
    });

    it('the old naming, a name listed twice, a number or a wave that goes backwards', () => {
      expect(judge([...both, { name: '2026_10_04_no_number' }])).toEqual([
        '"2026_10_04_no_number": not named YYYY_MM_DD_NN_name (lower case, digits, underscores)',
      ]);
      expect(judge([...both, entry(SECOND)])).toEqual([
        `${SECOND}: listed twice`,
        `${SECOND}: its number 2 does not come after ${SECOND}`,
      ]);
      expect(judge([entry(SECOND), entry(FIRST)])).toEqual([
        `${FIRST}: its number 1 does not come after ${SECOND}`,
      ]);
      expect(judge([entry(FIRST, { wave: 1 }), entry(SECOND)])).toEqual([
        `${SECOND}: wave 0 comes after wave 1 (${FIRST})`,
      ]);
    });

    it('fields left out or of the wrong kind', () => {
      const wrong = { kind: 'mandatory', wave: '0', checkpoint: '', reversible: 'yes', covers: null, summary: ' ' };
      expect(judge([entry(FIRST, wrong), entry(SECOND)])).toEqual([
        `${FIRST}: kind is "mandatory", expected one of required, optional, contract`,
        `${FIRST}: wave must be a number (0, 1, 2 …)`,
        `${FIRST}: checkpoint is missing (A0, A1 … Z)`,
        `${FIRST}: reversible must be true or false`,
        `${FIRST}: covers must be a list of finding ids (it may be empty)`,
        `${FIRST}: summary is missing`,
      ]);
    });

    it('a baseline that is not there', () => {
      expect(judge(both, 'supabase/tests/fixtures/gone.sql')).toEqual([
        'manifest: baseline "supabase/tests/fixtures/gone.sql" does not exist',
      ]);
    });
  });
});

// ------------------------------------------------------------
// The judge, tried on migrations that are wrong on purpose.
// ------------------------------------------------------------
describe('the rules, tried on migrations that break them', () => {
  const NAME = '2099_01_01_90_fixture';
  // Really applied in schema.sql, so the fixture has something to build on.
  const PREDECESSOR = manifest.migrations[0].name;

  // A small, correct migration: one table, one function. Each test replaces
  // the part it wants to get wrong.
  const parts = {
    begin: 'BEGIN;',
    timeout: "SET LOCAL lock_timeout = '5s';",
    guard: `
      DO $guard$
      BEGIN
        IF EXISTS (SELECT 1 FROM ${LEDGER} WHERE name = '${NAME}') THEN
          RAISE EXCEPTION 'migration ${NAME} is already applied' USING ERRCODE = 'SLM01';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM ${LEDGER} WHERE name = '${PREDECESSOR}') THEN
          RAISE EXCEPTION 'migration ${NAME} needs ${PREDECESSOR}' USING ERRCODE = 'SLM02';
        END IF;
      END
      $guard$;`,
    body: `
      CREATE TABLE public.fixture_things (id uuid PRIMARY KEY, label text);
      ALTER TABLE public.fixture_things ENABLE ROW LEVEL SECURITY;
      CREATE INDEX fixture_things_label_idx ON public.fixture_things (label);
      CREATE FUNCTION public.fixture_count() RETURNS bigint LANGUAGE sql STABLE
        SET search_path = public, pg_temp AS $$ select count(*) from public.fixture_things $$;`,
    ledger: `INSERT INTO ${LEDGER} (name) VALUES ('${NAME}');`,
    notify: "NOTIFY pgrst, 'reload schema';",
    commit: 'COMMIT;',

    downGuard: `
      DO $guard$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM ${LEDGER} WHERE name = '${NAME}') THEN
          RAISE EXCEPTION 'migration ${NAME} is not applied' USING ERRCODE = 'SLM03';
        END IF;
      END
      $guard$;`,
    downBody: `
      DROP FUNCTION public.fixture_count();
      DROP TABLE public.fixture_things;`,
    downLedger: `DELETE FROM ${LEDGER} WHERE name = '${NAME}';`,
    downNotify: "NOTIFY pgrst, 'reload schema';",

    audit: `select count(*) as tables_named_like_it from pg_class where relname = 'fixture_things';`,
  };

  const fixture = (changes = {}) => {
    const p = { ...parts, ...changes };
    return {
      name: NAME,
      predecessor: PREDECESSOR,
      reversible: true,
      up: [p.begin, p.timeout, p.guard, p.body, p.ledger, p.notify, p.commit].join('\n'),
      down: [p.begin, p.timeout, p.downGuard, p.downBody, p.downLedger, p.downNotify, p.commit].join('\n'),
      audit: p.audit,
      ...p.fields,
    };
  };

  // A copy of schema.sql per case: a wrong migration leaves a mess behind.
  const run = async (migration) => {
    const db = await scratchDatabase({ from: 'schema' });
    try {
      return await checkMigration(db, migration);
    } finally {
      await db.drop();
    }
  };

  it('a migration in the format passes both', async () => {
    expect(staticProblems(fixture())).toEqual([]);
    expect(await run(fixture())).toEqual([]);
  });

  describe('on the text', () => {
    it.each([
      ['no BEGIN', { begin: '' }, 'migration: the first statement is not BEGIN'],
      ['no lock timeout', { timeout: '' }, "migration: the second statement is not SET LOCAL lock_timeout = '…s'"],
      [
        'a lock timeout for the whole session',
        { timeout: "SET lock_timeout = '5s';" },
        "migration: the second statement is not SET LOCAL lock_timeout = '…s'",
      ],
      ['no COMMIT', { commit: '' }, 'migration: the last statement is not COMMIT'],
      [
        'something after COMMIT',
        { commit: 'COMMIT;\nANALYZE public.fixture_things;' },
        'migration: the last statement is not COMMIT',
      ],
      ['no guard', { guard: '' }, 'migration: the third statement is not the guard (a DO block that raises before anything is changed)'],
      [
        'a guard that does not look for its own name',
        { guard: parts.guard.replace(/IF EXISTS[\s\S]*?END IF;/, '') },
        `migration:4: the guard does not refuse a second run (it must name ${NAME} and raise SLM01)`,
      ],
      [
        'a guard that does not look for its predecessor',
        { guard: parts.guard.replace(/IF NOT EXISTS[\s\S]*?END IF;/, '') },
        `migration:4: the guard does not require ${PREDECESSOR} (it must name it and raise SLM02)`,
      ],
      ['no ledger row', { ledger: '' }, `migration: no INSERT INTO ${LEDGER} of '${NAME}'`],
      [
        'a ledger row that is only a comment',
        { ledger: `-- INSERT INTO ${LEDGER} (name) VALUES ('${NAME}');` },
        `migration: no INSERT INTO ${LEDGER} of '${NAME}'`,
      ],
      [
        'a rollback guard that does not check the ledger',
        { downGuard: 'DO $guard$ BEGIN NULL; END $guard$;' },
        `rollback:3: the guard does not refuse when the migration is not applied (it must name ${NAME} and raise SLM03)`,
      ],
      [
        'an audit made of two queries',
        { audit: 'select 1 as a; select 2 as b;' },
        'audit: 2 statements — an audit is ONE query returning ONE table '
        + '(the SQL editor and `supabase db query` only show the result of the last statement)',
      ],
      [
        'an audit that is not a query',
        { audit: 'delete from public.client_errors' },
        'audit: it does not start with SELECT, WITH, VALUES or TABLE',
      ],
    ])('%s', (_, changes, expected) => {
      expect(staticProblems(fixture(changes))).toContain(expected);
    });

    it('a second transaction in the middle', () => {
      const problems = staticProblems(fixture({ body: `${parts.body}\nCOMMIT;\nBEGIN;` }));
      expect(problems.filter((p) => p.includes('inside the file'))).toHaveLength(2);
    });
  });

  describe('by running it', () => {
    it('runs without its predecessor', async () => {
      const problems = await run(fixture({ guard: parts.guard.replace(/IF NOT EXISTS[\s\S]*?END IF;/, '') }));
      expect(problems).toContain(`it runs although ${PREDECESSOR} is not in the ledger`);
    });

    it('fails halfway on a second run instead of refusing', async () => {
      const problems = await run(fixture({ guard: parts.guard.replace(/IF EXISTS[\s\S]*?END IF;/, '') }));
      expect(problems).toEqual([
        'a second run fails with 42P07: migration: relation "fixture_things" already exists — expected a refusal with SLM01',
      ]);
    });

    it('can be run twice', async () => {
      const problems = await run(fixture({
        guard: parts.guard.replace(/IF EXISTS[\s\S]*?END IF;/, ''),
        body: 'CREATE TABLE IF NOT EXISTS public.fixture_things (id uuid PRIMARY KEY);',
        ledger: `INSERT INTO ${LEDGER} (name) VALUES ('${NAME}') ON CONFLICT DO NOTHING;`,
        downBody: 'DROP TABLE public.fixture_things;',
      }));
      expect(problems).toEqual(['a second run goes through — it must refuse']);
    });

    it('does not sign the ledger', async () => {
      const problems = await run(fixture({ ledger: '' }));
      expect(problems).toContain(`applied, it is not in ${LEDGER}`);
    });

    it('changes the API without telling PostgREST', async () => {
      const problems = await run(fixture({ notify: '' }));
      expect(problems).toEqual([
        'it changes what the API exposes (table public.fixture_things, column public.fixture_things.id, '
        + "column public.fixture_things.label, …) without NOTIFY pgrst, 'reload schema'",
      ]);
    });

    it('has a rollback that changes the API back without telling PostgREST', async () => {
      const problems = await run(fixture({ downNotify: '' }));
      expect(problems).toEqual([
        'its rollback changes what the API exposes (table public.fixture_things, column public.fixture_things.id, '
        + "column public.fixture_things.label, …) without NOTIFY pgrst, 'reload schema'",
      ]);
    });

    it('adds a foreign key without telling PostgREST: what can be embedded in what is cached too', async () => {
      // A key of a table onto itself: no column of the app has to stay free of one for this test.
      const problems = await run(fixture({
        body: 'ALTER TABLE public.goals ADD CONSTRAINT fixture_fk FOREIGN KEY (id) REFERENCES public.goals (id);',
        downBody: 'ALTER TABLE public.goals DROP CONSTRAINT fixture_fk;',
        notify: '',
        downNotify: '',
      }));
      expect(problems).toEqual([
        "it changes what the API exposes (foreign key public.goals.fixture_fk) without NOTIFY pgrst, 'reload schema'",
        "its rollback changes what the API exposes (foreign key public.goals.fixture_fk) without NOTIFY pgrst, 'reload schema'",
      ]);
    });

    it('needs no NOTIFY when the API does not change', async () => {
      const problems = await run(fixture({
        body: `
          CREATE INDEX fixture_idx ON public.goals (created_at);
          ALTER TABLE public.goals ADD CONSTRAINT fixture_check CHECK (target_reps > 0);`,
        downBody: `
          ALTER TABLE public.goals DROP CONSTRAINT fixture_check;
          DROP INDEX public.fixture_idx;`,
        notify: '',
        downNotify: '',
      }));
      expect(problems).toEqual([]);
    });

    it('has a rollback that leaves something behind', async () => {
      const problems = await run(fixture({ downBody: 'DROP TABLE public.fixture_things;' }));
      expect(problems).toHaveLength(2);
      expect(problems[0]).toBe(
        'the rollback does not give back the database it started from:\n'
        + '  functions public.fixture_count(): only in after its rollback',
      );
      // …and so the migration cannot be applied again.
      expect(problems[1]).toMatch(/^after its rollback it does not apply again — migration: function "fixture_count" already exists/);
    });

    it('may leave something behind when the manifest says it is not reversible', async () => {
      const problems = await run(fixture({
        body: parts.body.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION'),
        downBody: 'DROP TABLE public.fixture_things;',
        fields: { reversible: false },
      }));
      expect(problems).toEqual([]);
    });

    it('has a rollback that keeps the ledger row', async () => {
      const problems = await run(fixture({ downLedger: '' }));
      expect(problems).toContain(`rolled back, it is still in ${LEDGER}`);
    });

    it('has a rollback that runs when there is nothing to roll back', async () => {
      const problems = await run(fixture({
        downGuard: 'DO $guard$ BEGIN NULL; END $guard$;',
        downBody: 'DROP FUNCTION IF EXISTS public.fixture_count(); DROP TABLE IF EXISTS public.fixture_things;',
      }));
      expect(problems).toEqual(['the rollback runs a second time — it must refuse when the migration is not applied']);
    });

    it('has an audit that writes', async () => {
      // It starts with WITH, so the text alone does not give it away.
      const audit = `with gone as (delete from public.client_errors returning 1) select count(*) as deleted from gone`;
      expect(staticProblems(fixture({ audit }))).toEqual([]);
      expect(await run(fixture({ audit }))).toEqual([
        expect.stringMatching(/^audit \(before the migration\): it writes — audit: cannot execute \w+ in a read-only transaction$/),
        expect.stringMatching(/^audit \(after the migration\): it writes — audit: cannot execute \w+ in a read-only transaction$/),
      ]);
    });

    it('has an audit that only works once the migration is applied', async () => {
      const problems = await run(fixture({ audit: 'select count(*) from public.fixture_things' }));
      expect(problems).toEqual([
        'audit (before the migration): it fails — 42P01: audit:1: relation "public.fixture_things" does not exist',
      ]);
    });

    it('does not apply at all', async () => {
      const problems = await run(fixture({ body: 'CREATE TABLE public.profiles (id uuid);' }));
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/^it does not apply — migration: relation "profiles" already exists/);
    });
  });

  // The fixture as an OPTIONAL migration, and a required one listed after it.
  // That one requires PREDECESSOR, as predecessorOf() says it must — so its
  // guard is satisfied either way, and only running it without the fixture
  // tells whether it needs it.
  describe('with the optional migrations left out', () => {
    const LATER = '2099_01_01_91_later';
    const optional = { ...fixture(), kind: 'optional' };
    const later = (body) => ({ name: LATER, kind: 'required', up: fixture({ body }).up.replaceAll(NAME, LATER) });
    const standsAlone = later('CREATE INDEX later_idx ON public.goals (created_at);');
    const leans = later('CREATE INDEX later_idx ON public.fixture_things (label);');

    // On a copy of schema.sql; resolves to what `fn` returns and to the
    // fixtures that signed the ledger.
    const onSchema = async (fn) => {
      const db = await scratchDatabase({ from: 'schema' });
      try {
        const result = await fn(db);
        const signed = await db.query.rows(`select name from ${LEDGER} where name like '2099%' order by name`);
        return [result, signed.map((row) => row.name)];
      } finally {
        await db.drop();
      }
    };

    it('a required migration that stands on its own applies', async () => {
      const [problems, signed] = await onSchema((db) => withoutOptionalProblems(db, [optional, standsAlone]));
      expect(problems).toEqual([]);
      expect(signed).toEqual([LATER]);
    });

    it('a required migration that uses what an optional one made does not', async () => {
      const [problems, signed] = await onSchema((db) => withoutOptionalProblems(db, [optional, leans]));
      expect(problems).toEqual([
        `${LATER}: without the optional ${NAME} it does not apply — `
        + 'migration: relation "public.fixture_things" does not exist',
      ]);
      expect(signed).toEqual([]);
    });

    it('…and the run in order cannot tell: there, the optional one is always applied first', async () => {
      const [, signed] = await onSchema(async (db) => {
        await db.runSql(optional.up, 'migration');
        await db.runSql(leans.up, 'migration');
      });
      expect(signed).toEqual([NAME, LATER]);
    });
  });
});
