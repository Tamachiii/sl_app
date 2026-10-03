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
import { asAdmin, repoRoot, scratchDatabase } from './harness.js';
import { CATALOG_SECTIONS, catalogSnapshot, diffCatalogs } from './catalog.js';
import { inSchemaSql, loadManifest } from '../migrations/manifest.js';

// Production on 2026-09-30 does not change after the fact. If this fails, the
// fixture was edited: undo that, and write the change as a migration.
const BASELINE_SHA256 = '20beb3904a9c362418680c40558244950e82e290d3e1049e6c0008dcc0f1f218';

const manifest = loadManifest();
const merged = manifest.migrations.filter(inSchemaSql);
const sides = { left: 'baseline + migrations', right: 'schema.sql' };

let baseline;   // the fixture alone
let migrated;   // the fixture + the migrations
let schema;     // schema.sql

beforeAll(async () => {
  const db = await scratchDatabase();
  await db.runFile(manifest.baseline);
  baseline = await catalogSnapshot(db.query);
  for (const migration of merged) await db.runFile(migration.paths.migration);
  migrated = await catalogSnapshot(db.query);
  schema = await asAdmin((q) => catalogSnapshot(q));
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
    const diff = diffCatalogs(baseline, schema, sides);
    expect(diff.length > 0).toBe(merged.length > 0);
    if (merged.length) expect(diff).toContain('schemas app_private: only in schema.sql');
  });
});

describe('baseline + migrations = schema.sql', () => {
  // The rows of a table are compared one by one only when catalog.js lists the
  // table in REFERENCE_DATA. Of any other table the two sides compare how many
  // rows there are — and two different seeds can have the same number.
  it('neither side holds rows that would be compared by their number only', () => {
    const counted = (snapshot, side) => Object.entries(snapshot.data)
      .filter(([key, { count }]) => key.startsWith('row count of ') && count > 0)
      .map(([key, { count }]) => `${key.slice('row count of '.length)}: ${count} row(s) in ${side}`);
    expect(
      [...counted(migrated, sides.left), ...counted(schema, sides.right)],
      'a table that a SQL file fills goes into REFERENCE_DATA (supabase/tests/catalog.js), with the columns to compare',
    ).toEqual([]);
  });

  it.each(CATALOG_SECTIONS)('%s', (section) => {
    const diff = diffCatalogs(
      { [section]: migrated[section] },
      { [section]: schema[section] },
      sides,
    );
    expect(diff).toEqual([]);
  });

  it('schema.sql records the migrations merged into it, and no other', () => {
    const rows = schema.data['rows of app_private.app_migrations'].rows ?? [];
    expect(rows.map((row) => JSON.parse(row).name)).toEqual(merged.map((m) => m.name).sort());
  });
});
