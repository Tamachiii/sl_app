// Reader of manifest.json — the list of the migrations that follow the ledger
// convention (README.md, in this folder), in the order they are applied.
//
// Plain Node, no dependency: the database tests import it, and so can a
// script that compares the manifest with the ledger of a real database.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const MANIFEST_FILE = 'supabase/migrations/manifest.json';

/** The table every applied migration leaves its name in. */
export const LEDGER = 'app_private.app_migrations';

/** YYYY_MM_DD_NN_name — DD is the day the file was committed, NN the global order. */
export const NAME = /^(\d{4})_(\d{2})_(\d{2})_(\d{2})_([a-z][a-z0-9_]*)$/;

// The files that predate the ledger. They are history: production already has
// them, they cannot be replayed in order, and nothing reads them any more.
const LEGACY_FILE = /^(2026_0[4-8]_\d{2}_[a-z][a-z0-9_]*|20260416_set_logs_weight_kg)\.sql$/;

/**
 *   required  the client of its wave needs it; merged into schema.sql
 *   optional  may be skipped (it needs an extension, or only pays off under
 *             load); merged into schema.sql all the same
 *   contract  removes something an old client still uses: applied long after
 *             the deploy, and merged into schema.sql only once it is applied
 */
export const KINDS = ['required', 'optional', 'contract'];

/** SQLSTATEs a migration or a rollback raises when it refuses to run. */
export const REFUSAL = {
  /** A migration: its name is already in the ledger. */
  alreadyApplied: 'SLM01',
  /** A migration: the one it builds on is not in the ledger. */
  predecessorMissing: 'SLM02',
  /** A rollback: the migration it undoes is not in the ledger. */
  notApplied: 'SLM03',
  /** A rollback: something applied later still needs what it would remove. */
  stillNeeded: 'SLM04',
  /**
   * A migration: rows that are already in the database break the rule it is
   * about to enforce. Its audit counts them and its runbook page says how to
   * remove them; then the file is run again.
   */
  rowsInTheWay: 'SLM05',
};

/** The files that belong to one migration, relative to the repository root. */
export function pathsOf(name) {
  const [, , , , order, slug] = NAME.exec(name) ?? [];
  return {
    migration: `supabase/migrations/${name}.sql`,
    audit: `supabase/audits/${name}.audit.sql`,
    rollback: `supabase/rollbacks/${name}.down.sql`,
    runbook: `docs/runbook/migrations/${order}-${String(slug).replace(/_/g, '-')}.md`,
  };
}

/** Its NN, as a number (NaN when the name is not in the format). */
export const orderOf = (name) => Number(NAME.exec(name)?.[4]);

/** `{ baseline, migrations }`, each migration with its `order` and `paths`. */
export function loadManifest(root = REPO_ROOT) {
  const raw = JSON.parse(fs.readFileSync(path.join(root, MANIFEST_FILE), 'utf8'));
  return {
    baseline: raw.baseline,
    migrations: (raw.migrations ?? []).map((entry) => ({
      ...entry,
      order: orderOf(entry.name),
      paths: pathsOf(entry.name),
    })),
  };
}

/** Merged into schema.sql — which is what the parity test replays on the baseline. */
export const inSchemaSql = (entry) => entry.kind !== 'contract';

/**
 * The migration `entry` refuses to run without: the nearest one before it
 * that nobody may skip. That is the nearest `required` one — for a `contract`
 * migration, the nearest `required` or `contract` one, because the contract
 * files are applied together and in order. `null` for the first of the list.
 */
export function predecessorOf(migrations, entry) {
  const index = migrations.findIndex((m) => m.name === entry.name);
  const counts = (m) => m.kind === 'required' || (entry.kind === 'contract' && m.kind === 'contract');
  for (let i = index - 1; i >= 0; i -= 1) {
    if (counts(migrations[i])) return migrations[i];
  }
  return null;
}

const listSql = (root, dir) => {
  const full = path.join(root, dir);
  return fs.existsSync(full) ? fs.readdirSync(full).filter((file) => file.endsWith('.sql')).sort() : [];
};

/**
 * What is wrong with the manifest and the files around it, one line each —
 * `[]` when every migration is listed, well named and complete.
 */
export function manifestProblems({ baseline, migrations }, root = REPO_ROOT) {
  const out = [];
  const exists = (file) => typeof file === 'string' && fs.existsSync(path.join(root, file));

  if (!exists(baseline)) out.push(`manifest: baseline ${JSON.stringify(baseline)} does not exist`);

  const seen = new Set();
  let previous = null;
  for (const entry of migrations) {
    const { name } = entry;
    if (typeof name !== 'string' || !NAME.test(name)) {
      out.push(`${JSON.stringify(name)}: not named YYYY_MM_DD_NN_name (lower case, digits, underscores)`);
      continue;
    }
    if (seen.has(name)) out.push(`${name}: listed twice`);
    seen.add(name);

    if (!KINDS.includes(entry.kind)) out.push(`${name}: kind is ${JSON.stringify(entry.kind)}, expected one of ${KINDS.join(', ')}`);
    if (!Number.isInteger(entry.wave) || entry.wave < 0) out.push(`${name}: wave must be a number (0, 1, 2 …)`);
    if (typeof entry.checkpoint !== 'string' || !entry.checkpoint) out.push(`${name}: checkpoint is missing (A0, A1 … Z)`);
    if (typeof entry.reversible !== 'boolean') out.push(`${name}: reversible must be true or false`);
    if (!Array.isArray(entry.covers)) out.push(`${name}: covers must be a list of finding ids (it may be empty)`);
    if (typeof entry.summary !== 'string' || !entry.summary.trim()) out.push(`${name}: summary is missing`);

    if (previous) {
      if (entry.order <= previous.order) {
        out.push(`${name}: its number ${entry.order} does not come after ${previous.name}`);
      }
      if (Number.isInteger(entry.wave) && Number.isInteger(previous.wave) && entry.wave < previous.wave) {
        out.push(`${name}: wave ${entry.wave} comes after wave ${previous.wave} (${previous.name})`);
      }
    }
    previous = entry;

    for (const [what, file] of Object.entries(entry.paths)) {
      if (!exists(file)) out.push(`${name}: its ${what} file ${file} does not exist`);
    }
  }

  // Nothing next to the manifest that the manifest does not know.
  for (const file of listSql(root, 'supabase/migrations')) {
    if (!seen.has(file.replace(/\.sql$/, '')) && !LEGACY_FILE.test(file)) {
      out.push(
        `supabase/migrations/${file}: not in ${MANIFEST_FILE}. A new migration is named `
        + 'YYYY_MM_DD_NN_name.sql and listed there.',
      );
    }
  }
  for (const [dir, suffix] of [['supabase/audits', '.audit.sql'], ['supabase/rollbacks', '.down.sql']]) {
    for (const file of listSql(root, dir)) {
      if (!file.endsWith(suffix) || !seen.has(file.slice(0, -suffix.length))) {
        out.push(`${dir}/${file}: no migration of ${MANIFEST_FILE} has that name (expected <name>${suffix})`);
      }
    }
  }
  return out;
}
