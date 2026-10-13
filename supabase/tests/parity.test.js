// Parity: the production baseline plus every migration of the manifest, in
// order, is the database schema.sql describes.
//
// Why it matters. The other database tests load schema.sql. Production never
// does: it gets the migration files, one by one, by hand. If the two can
// differ, a hole can be closed in the tests and stay open in production. Here
// both are built — on an identical empty Supabase project (shim.sql) — and
// their catalogs are compared object by object.
//
//   left   fixtures/prod_baseline_2026_09_30.sql (production, frozen)
//          + every `required` and `optional` migration of manifest.json
//   right  schema.sql
//
// `contract` migrations are left out on both sides: they are merged into
// schema.sql only once they are applied.
//
// TWICE, because a project is one of two things. An optional migration that
// names an `extension` in the manifest (pg_cron) is applied only where the
// owner has switched that extension on, and stands in schema.sql inside a
// block that runs only there:
//
//   as production is     no such extension. Left: the migrations that name
//                        none. Right: schema.sql as every other test file
//                        gets it (the template). THIS is the comparison that
//                        says the suite runs on what production is.
//   with the extensions  each switched on right before the first migration
//                        that needs it, as the owner would; and before
//                        schema.sql on the right. Left: every migration.
//
// When this file is red, the message names the object and the side:
//   "… only in schema.sql"            the migration forgot it (or it was added
//                                     to schema.sql without a migration)
//   "… only in baseline + migrations" schema.sql forgot it
//   "… ≠ …"                           both have it, written differently —
//                                     copy the text from one file to the other

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { asAdmin, EXTENSION_STUBS, repoRoot, scratchDatabase } from './harness.js';
import { CATALOG_SECTIONS, catalogSnapshot, diffCatalogs } from './catalog.js';
import { EXTENSIONS, inSchemaSql, installedBySchemaSql, loadManifest } from '../migrations/manifest.js';

// Production on 2026-09-30 does not change after the fact. If this fails, the
// fixture was edited: undo that, and write the change as a migration.
const BASELINE_SHA256 = '20beb3904a9c362418680c40558244950e82e290d3e1049e6c0008dcc0f1f218';
const SCHEMA_SQL = 'supabase/schema.sql';

const manifest = loadManifest();
const merged = manifest.migrations.filter(inSchemaSql);
// The extensions a migration of the manifest waits for, in the order they are
// first needed.
const optionalExtensions = [...new Set(merged.map((m) => m.extension).filter((name) => name !== undefined))];
const sides = { left: 'baseline + migrations', right: 'schema.sql' };

const PROJECTS = [
  ['as production is: no optional extension', []],
  [`with ${optionalExtensions.join(', ') || 'no extension to switch on'} switched on`, optionalExtensions],
];

let baseline;         // the fixture alone
const built = new Map();  // label → { migrated, schema }

beforeAll(async () => {
  for (const [label, extensions] of PROJECTS) {
    // Left: the fixture, then the migrations a project with these extensions gets.
    const left = await scratchDatabase();
    await left.runFile(manifest.baseline);
    baseline ??= await catalogSnapshot(left.query);
    const on = new Set();
    for (const migration of merged.filter((m) => installedBySchemaSql(m, extensions))) {
      if (migration.extension !== undefined && !on.has(migration.extension)) {
        await left.enableExtension(migration.extension);
        on.add(migration.extension);
      }
      await left.runFile(migration.paths.migration);
    }
    const migrated = await catalogSnapshot(left.query);
    await left.drop();

    // Right: schema.sql — the template when nothing is switched on, which is
    // what asUser() and the other helpers of every test file run on.
    let schema;
    if (extensions.length === 0) {
      schema = await asAdmin((q) => catalogSnapshot(q));
    } else {
      const right = await scratchDatabase();
      for (const extension of extensions) await right.enableExtension(extension);
      await right.runFile(SCHEMA_SQL);
      schema = await catalogSnapshot(right.query);
      await right.drop();
    }
    built.set(label, { migrated, schema });
  }
});

describe('the production baseline', () => {
  it('is the file that was frozen on 2026-09-30', () => {
    const content = fs.readFileSync(path.join(repoRoot, manifest.baseline));
    expect(createHash('sha256').update(content).digest('hex')).toBe(BASELINE_SHA256);
  });

  it('holds what the live review counted in production', () => {
    const inPublic = (section) => Object.keys(baseline[section]).filter((key) => key.startsWith('public.')).length;
    expect({
      tables: inPublic('tables'),
      columns: inPublic('columns'),
      functions: inPublic('functions'),
      enums: inPublic('types'),
      // 70 on public tables + 4 on storage.objects; 16 + on_auth_user_created.
      policies: Object.keys(baseline.policies).length,
      triggers: Object.keys(baseline.triggers).length,
    }).toEqual({ tables: 20, columns: 164, functions: 36, enums: 2, policies: 74, triggers: 17 });
  });

  it('is not schema.sql on its own once a migration exists', () => {
    // The comparison below is only worth something if it can fail: without
    // the migrations, the two sides must differ.
    const { schema } = built.get(PROJECTS[0][0]);
    const diff = diffCatalogs(baseline, schema, sides);
    expect(diff.length > 0).toBe(merged.length > 0);
    if (merged.length) expect(diff).toContain('schemas app_private: only in schema.sql');
  });
});

describe('the extensions a migration may wait for', () => {
  it('each has a stub the suite can switch on, and every one a migration names is known', () => {
    expect(Object.keys(EXTENSION_STUBS).sort()).toEqual([...EXTENSIONS].sort());
    for (const file of Object.values(EXTENSION_STUBS)) expect(fs.existsSync(file), file).toBe(true);
    expect(optionalExtensions.filter((name) => !EXTENSIONS.includes(name))).toEqual([]);
  });

  it('a migration that names one is merged into schema.sql and applied by it only where the extension is', () => {
    const waiting = merged.filter((m) => m.extension !== undefined);
    expect(waiting.every((m) => m.kind === 'optional')).toBe(true);
    for (const migration of waiting) {
      expect(installedBySchemaSql(migration)).toBe(false);
      expect(installedBySchemaSql(migration, [migration.extension])).toBe(true);
    }
  });

  // The second comparison is only worth something if the two projects differ.
  it('the two projects are not the same database', () => {
    if (optionalExtensions.length === 0) return;
    const [plain, extended] = PROJECTS.map(([label]) => built.get(label).schema);
    const diff = diffCatalogs(plain, extended, { left: 'without', right: 'with' });
    for (const extension of optionalExtensions) expect(diff).toContain(`extensions ${extension}: only in with`);
    expect(diff.filter((line) => line.startsWith('data rows of app_private.app_migrations'))).toHaveLength(1);
  });
});

describe.each(PROJECTS)('baseline + migrations = schema.sql, in a project %s', (label, extensions) => {
  const applied = merged.filter((m) => installedBySchemaSql(m, extensions));

  // The rows of a table are compared one by one only when catalog.js lists the
  // table in REFERENCE_DATA. Of any other table the two sides compare how many
  // rows there are — and two different seeds can have the same number.
  it('neither side holds rows that would be compared by their number only', () => {
    const { migrated, schema } = built.get(label);
    const counted = (snapshot, side) => Object.entries(snapshot.data)
      .filter(([key, { count }]) => key.startsWith('row count of ') && count > 0)
      .map(([key, { count }]) => `${key.slice('row count of '.length)}: ${count} row(s) in ${side}`);
    expect(
      [...counted(migrated, sides.left), ...counted(schema, sides.right)],
      'a table that a SQL file fills goes into REFERENCE_DATA (supabase/tests/catalog.js), with the columns to compare',
    ).toEqual([]);
  });

  it.each(CATALOG_SECTIONS)('%s', (section) => {
    const { migrated, schema } = built.get(label);
    const diff = diffCatalogs(
      { [section]: migrated[section] },
      { [section]: schema[section] },
      sides,
    );
    expect(diff).toEqual([]);
  });

  it('schema.sql records the migrations it applied there, and no other', () => {
    const { migrated, schema } = built.get(label);
    const names = (snapshot) => (snapshot.data['rows of app_private.app_migrations'].rows ?? []).map((row) => JSON.parse(row).name);
    expect(names(schema)).toEqual(applied.map((m) => m.name).sort());
    expect(names(migrated)).toEqual(applied.map((m) => m.name).sort());
  });
});
