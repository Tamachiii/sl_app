// The migration ledger (2026_10_03_01): app_private.app_migrations.
//
// It lives outside `public` so that it needs no RLS — a table with RLS and no
// policy reads as empty to a read-only role, and a check of the ledger before
// a deploy would read "nothing is applied". What protects it instead is tested
// here: no API role can reach the schema, and nothing created in it later is
// reachable either.

import { beforeAll, describe, expect, it } from 'vitest';
import {
  asAdmin, asAnon, asService, asUser, attempt, scenario, scratchDatabase, seed,
} from './harness.js';
import { catalogSnapshot, diffCatalogs } from './catalog.js';
import {
  installedBySchemaSql, LEDGER, loadManifest, REFUSAL,
} from '../migrations/manifest.js';

const manifest = loadManifest();
// In the format, and never a real migration.
const TO_COME = '2099_01_01_99_a_migration_to_come';

let ids;
beforeAll(async () => {
  ids = await seed();
});

// Every way the API can arrive: the anon key, a signed-in athlete, the coach,
// and an Edge Function holding the service-role key.
const callers = () => [
  ['anon', asAnon],
  ['a signed-in athlete', (fn) => asUser(ids.studentA, fn)],
  ['the coach', (fn) => asUser(ids.coach, fn)],
  ['service_role', asService],
];

describe('app_private.app_migrations', () => {
  it('holds one row per migration merged into schema.sql', async () => {
    const names = await asAdmin((q) => q.rows(`select name from ${LEDGER} order by name`));
    expect(names.map((row) => row.name)).toEqual(
      // In a project as production is: a migration that waits for an
      // extension nobody switched on is not on record (parity.test.js has the
      // project that has it).
      manifest.migrations.filter((m) => installedBySchemaSql(m)).map((m) => m.name).sort(),
    );
    expect(names.length).toBeGreaterThan(0);
  });

  it('stamps a row with the moment it was applied', async () => {
    const row = await asAdmin((q) => q.one(
      `select applied_at, applied_at <= now() as in_the_past from ${LEDGER} order by name limit 1`,
    ));
    expect(row.applied_at).toBeInstanceOf(Date);
    expect(row.in_the_past).toBe(true);
  });

  it('takes a migration name once', () => scenario(async (q) => {
    const again = await attempt(() => q(
      `insert into ${LEDGER} (name) values ($1)`, [manifest.migrations[0].name],
    ));
    expect(again.error?.code).toBe('23505');
  }));

  it.each([
    ['the old naming, without a number', '2026_10_03_migration_ledger'],
    ['a file name', `${TO_COME}.sql`],
    ['capitals', '2099_01_01_99_A_Migration'],
    ['an empty name', ''],
  ])('refuses %s', (_, name) => scenario(async (q) => {
    const tried = await attempt(() => q(`insert into ${LEDGER} (name) values ($1)`, [name]));
    expect(tried.error?.code).toBe('23514');
  }));

  it('accepts the name of a migration to come', () => scenario(async (q) => {
    await q(`insert into ${LEDGER} (name) values ($1)`, [TO_COME]);
    expect(await q.value(`select count(*) from ${LEDGER} where name = $1`, [TO_COME])).toBe(1);
  }));
});

describe('the API roles and app_private', () => {
  it('none of them holds a privilege on the schema or on the ledger', async () => {
    const held = await asAdmin((q) => q.rows(
      `select r.rolname as role,
              has_schema_privilege(r.rolname, 'app_private', 'USAGE')  as use_schema,
              has_schema_privilege(r.rolname, 'app_private', 'CREATE') as create_in_schema,
              has_table_privilege(r.rolname, '${LEDGER}', 'SELECT')    as read_ledger,
              has_table_privilege(r.rolname, '${LEDGER}', 'INSERT, UPDATE, DELETE, TRUNCATE') as write_ledger
         from pg_roles r
        where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
        order by 1`,
    ));
    const none = { use_schema: false, create_in_schema: false, read_ledger: false, write_ledger: false };
    expect(held).toEqual([
      { role: 'anon', ...none },
      { role: 'authenticated', ...none },
      { role: 'authenticator', ...none },
      { role: 'service_role', ...none },
    ]);
  });

  it('none of them can read the ledger', async () => {
    for (const [who, as] of callers()) {
      const read = await attempt(() => as((q) => q.rows(`select name from ${LEDGER}`)));
      expect(read.ok, `${who} read ${JSON.stringify(read.value)}`).toBe(false);
      expect(read.error.code, who).toBe('42501');
      expect(read.error.message, who).toBe('permission denied for schema app_private');
    }
  });

  it('none of them can sign it, edit it or empty it', () => scenario(async (q) => {
    const before = await q.rows(`select name, applied_at from ${LEDGER} order by name`);
    const writes = [
      `insert into ${LEDGER} (name) values ('${TO_COME}')`,
      `update ${LEDGER} set applied_at = now() - interval '1 year'`,
      `delete from ${LEDGER}`,
      `truncate ${LEDGER}`,
      `drop table ${LEDGER}`,
      `create table app_private.mine (id int)`,
    ];
    for (const [who, as] of callers()) {
      for (const sql of writes) {
        const tried = await attempt(() => as((caller) => caller(sql)));
        expect(tried.error?.code, `${who}: ${sql}`).toBe('42501');
      }
    }
    expect(await q.rows(`select name, applied_at from ${LEDGER} order by name`)).toEqual(before);
  }));

  it('what a later migration creates in the schema is out of reach too', () => scenario(async (q) => {
    // Supabase grants the API roles everything on what `postgres` creates —
    // in `public`. Those default privileges must not follow into app_private.
    await q(`create table app_private.later_table (id int)`);
    await q(`create function app_private.later_function() returns int language sql as 'select 1'`);
    await q(`create sequence app_private.later_sequence`);

    const reach = await q.rows(
      `select r.rolname as role,
              has_table_privilege(r.rolname, 'app_private.later_table', 'SELECT')       as "table",
              has_sequence_privilege(r.rolname, 'app_private.later_sequence', 'USAGE')  as "sequence"
         from pg_roles r
        where r.rolname in ('anon', 'authenticated', 'service_role')
        order by 1`,
    );
    expect(reach).toEqual([
      { role: 'anon', table: false, sequence: false },
      { role: 'authenticated', table: false, sequence: false },
      { role: 'service_role', table: false, sequence: false },
    ]);

    // Without USAGE on the schema nobody gets as far as calling a function in
    // it. (Since migration 03 it would not be executable either: a function
    // `postgres` creates no longer starts with EXECUTE for PUBLIC, in any
    // schema — function-acl.test.js.)
    for (const [who, as] of callers()) {
      const called = await attempt(() => as((caller) => caller.value(`select app_private.later_function()`)));
      expect(called.error?.message, who).toBe('permission denied for schema app_private');
    }
  }));
});

// The rollback of migration 01 drops the ledger. Every other rollback is run
// by migration-conventions.test.js, but only this one can forget what is
// applied — and that test never rolls it back with something else in it.
describe('rolling migration 01 back', () => {
  it('is refused while the ledger records a later migration, and changes nothing', async () => {
    const first = manifest.migrations[0];
    // Production right after migration 01, not schema.sql: that one records
    // every migration merged since.
    const db = await scratchDatabase();
    await db.runFile(manifest.baseline);
    await db.runFile(first.paths.migration);
    await db.query(`insert into ${LEDGER} (name) values ($1)`, [TO_COME]);
    const before = await catalogSnapshot(db.query);

    const refused = await attempt(() => db.runFile(first.paths.rollback));
    expect(refused.error?.code).toBe(REFUSAL.stillNeeded);
    expect(refused.error.message).toContain(`the ledger still records later migrations: ${TO_COME}`);
    expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);

    // Once the later one is rolled back, it goes.
    await db.query(`delete from ${LEDGER} where name = $1`, [TO_COME]);
    await db.runFile(first.paths.rollback);
    expect(await db.query.value(`select to_regnamespace('app_private') is null`)).toBe(true);
  });
});
