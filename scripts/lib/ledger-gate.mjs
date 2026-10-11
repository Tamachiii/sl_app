// The deploy gate: does production have every migration this commit needs?
//
// The app of a commit calls the RPCs and reads the columns of the migrations
// written with it. Those are applied to production by hand, one file at a
// time (docs/RUNBOOK.md), and a push to `main` publishes the app. Until this
// check nothing connected the two: a client could go out ahead of its
// database (review finding P69).
//
// What is compared:
//
//   supabase/migrations/manifest.json   what this commit knows, each with a kind
//   app_private.app_migrations          what production has, by name — every
//                                       migration signs it in its own
//                                       transaction (migration 01)
//
// A `required` migration that is not in the ledger stops the deploy. An
// `optional` one may be skipped by design, and a `contract` one is applied
// long AFTER the deploy (it removes what an old client still uses): neither
// is asked for.
//
// It fails closed. When the ledger cannot be read, nothing says the database
// is ready, and the answer is no: a secret that is not set, a password that
// is refused, a role that may not read the table. One exception, and only
// one: no secret is set at all AND the repository variable
// ALLOW_DEPLOY_WITHOUT_LEDGER_CHECK is exactly `true`. A migration FOUND
// missing is never overridden, and neither is a secret that is set and does
// not work.
//
// Nothing here opens a connection or prints. The functions take the rows, or
// a `query(sql)` to get them with, and return what was found;
// scripts/check-migrations.mjs is the command around them.

import { KINDS, LEDGER, NAME } from '../../supabase/migrations/manifest.js';

/** The repository secret the deploy job reads production with (also the nightly backup's). */
export const SECRET = 'SUPABASE_DB_URL';
/** On the owner's machine: the database password, the address coming from the CLI link. */
export const LOCAL_SECRET = 'SUPABASE_DB_PASSWORD';
/** The repository VARIABLE that lets a deploy go out while no secret is set. */
export const OVERRIDE = 'ALLOW_DEPLOY_WITHOUT_LEDGER_CHECK';
/** Where the owner reads what to do when the gate says no. */
export const PAGE = 'docs/runbook/40-deploy.md';

/**
 * What the gate asks production — and what `--print` shows, for the owner to
 * run by hand. The same text as docs/runbook/00-before-you-start.md, section 5.
 */
export const LEDGER_QUERY = `select name, applied_at from ${LEDGER} order by applied_at, name`;

const [LEDGER_SCHEMA, LEDGER_TABLE] = LEDGER.split('.');

/** An error whose message is written for the person reading the run. */
export class GateError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'GateError';
  }
}

/** Does a deploy of this commit need `entry` in production? */
export const isRequired = (entry) => entry.kind === 'required';

// ------------------------------------------------------------
// The manifest
// ------------------------------------------------------------

/**
 * What stops the gate from judging the manifest, one line each — `[]` when it
 * can. The gate reads `kind` to know what a deploy needs: an entry it cannot
 * read ("requried") is one it would otherwise let through in silence. The
 * database suite holds the manifest to much more (manifest.js); this is only
 * what a wrong answer here would rest on.
 */
export function manifestFaults(migrations) {
  if (!Array.isArray(migrations) || migrations.length === 0) return ['it lists no migration'];
  const out = [];
  const seen = new Set();
  for (const entry of migrations) {
    const name = entry?.name;
    if (typeof name !== 'string' || !NAME.test(name)) {
      out.push(`${JSON.stringify(name)} is not a migration name (YYYY_MM_DD_NN_name)`);
      continue;
    }
    if (seen.has(name)) out.push(`${name} is listed twice`);
    seen.add(name);
    if (!KINDS.includes(entry.kind)) {
      out.push(`${name} has kind ${JSON.stringify(entry.kind)}, which is none of ${KINDS.join(', ')}`);
    }
  }
  // Migration 01, the ledger itself, is one: a list without any is not ours.
  if (out.length === 0 && !migrations.some(isRequired)) out.push('none of its migrations is `required`');
  return out;
}

// ------------------------------------------------------------
// The comparison
// ------------------------------------------------------------

/**
 * The manifest against the rows of the ledger (`[{ name, applied_at }]`, or
 * `null` when production has no ledger at all — then nothing is on record).
 *
 *   rows      one per migration of the manifest, in its order:
 *             { entry, needed, applied, appliedAt }
 *   missing   the entries a deploy needs and production does not have
 *   unknown   names in the ledger this commit does not know — production is
 *             ahead of it (an older commit is being deployed). Not a reason
 *             to stop: every migration is written to be safe under the client
 *             that was live before it.
 */
export function compare(migrations, ledger) {
  const applied = new Map((ledger ?? []).map((row) => [row.name, row.applied_at ?? null]));
  const known = new Set(migrations.map((entry) => entry.name));
  const rows = migrations.map((entry) => ({
    entry,
    needed: isRequired(entry),
    applied: applied.has(entry.name),
    appliedAt: applied.get(entry.name) ?? null,
  }));
  return {
    noLedger: ledger === null || ledger === undefined,
    rows,
    missing: rows.filter((row) => row.needed && !row.applied).map((row) => row.entry),
    unknown: [...applied.keys()].filter((name) => !known.has(name)),
  };
}

// ------------------------------------------------------------
// Reading the ledger
// ------------------------------------------------------------

export const BEGIN_READ_ONLY = 'BEGIN TRANSACTION READ ONLY';

// Who is asking, and whether the answer can be trusted — from the catalog,
// which every role may read, before the table itself is touched:
//
//   has_schema / has_table   no ledger is an ANSWER (migration 01 was never
//                            applied), not an error
//   may_use / may_select     a role without them gets "permission denied",
//                            which says nothing about the migrations
//   filtered                 row-level security applies to this role on that
//                            table: it would hide rows, and an applied
//                            migration would read as missing. The ledger has
//                            no policy on purpose; this is for the day someone
//                            switches RLS on "everywhere".
const STATE = `
  SELECT current_user::text AS role,
         pg_catalog.current_database()::text AS database,
         pg_catalog.current_setting('server_version') AS server_version,
         pg_catalog.current_setting('transaction_read_only') AS read_only,
         n.oid IS NOT NULL AS has_schema,
         c.oid IS NOT NULL AS has_table,
         COALESCE(pg_catalog.has_schema_privilege(n.oid, 'USAGE'), false) AS may_use,
         COALESCE(pg_catalog.has_table_privilege(c.oid, 'SELECT'), false) AS may_select,
         COALESCE(pg_catalog.row_security_active(c.oid), false) AS filtered
    FROM (SELECT 1) AS one
    LEFT JOIN pg_catalog.pg_namespace n ON n.nspname = '${LEDGER_SCHEMA}'
    LEFT JOIN pg_catalog.pg_class c
           ON c.relnamespace = n.oid AND c.relname = '${LEDGER_TABLE}' AND c.relkind IN ('r', 'p')`;

/**
 * Read the ledger through `query(sql)` — a connected client's — in one
 * read-only transaction that is rolled back. Resolves to
 * `{ role, database, serverVersion, ledger }`, `ledger` being the rows of
 * LEDGER_QUERY, or `null` when the database has no ledger table.
 *
 * Throws a GateError when the rows could not be trusted: the server did not
 * open a read-only transaction, the role may not read the table, or row-level
 * security would filter it.
 */
export async function readLedger(query) {
  await query(BEGIN_READ_ONLY);
  try {
    const { rows: [state] } = await query(STATE);
    if (state.read_only !== 'on') {
      throw new GateError('The server did not open a read-only transaction; nothing was read.');
    }
    const who = { role: state.role, database: state.database, serverVersion: state.server_version };
    if (!state.has_schema || !state.has_table) return { ...who, ledger: null };
    if (!state.may_use || !state.may_select) {
      throw new GateError(
        `Role ${state.role} may not read ${LEDGER} (it needs USAGE on schema ${LEDGER_SCHEMA} and SELECT on the table). `
        + `The connection string must be the one of the \`postgres\` role, which owns the schema — or of a role that was `
        + 'granted both. That says nothing about the migrations.',
      );
    }
    if (state.filtered) {
      throw new GateError(
        `Row-level security is on for ${LEDGER} and applies to role ${state.role}: it would hide rows, and a migration `
        + 'that is applied would read as missing. The ledger has no policy on purpose (migration 01); read it as the '
        + '`postgres` role.',
      );
    }
    const { rows } = await query(LEDGER_QUERY);
    return { ...who, ledger: rows.map(({ name, applied_at }) => ({ name, applied_at })) };
  } finally {
    // Nothing was written; this only ends the transaction. A connection that
    // is already gone has nothing left to roll back.
    await Promise.resolve().then(() => query('ROLLBACK')).catch(() => {});
  }
}

// ------------------------------------------------------------
// The decision
// ------------------------------------------------------------

const isSet = (value) => typeof value === 'string' && value.trim() !== '';

/** Is there anything in `env` to connect with? A secret that is blank is not set. */
export const canConnect = (env) => isSet(env[SECRET]) || isSet(env[LOCAL_SECRET]);

/** The override variable: `{ value, given, allows }`. Only the exact word counts. */
export function overrideOf(env) {
  const value = isSet(env[OVERRIDE]) ? env[OVERRIDE].trim() : '';
  return { value, given: value !== '', allows: value === 'true' };
}

/**
 * Decide whether a deploy of `migrations` (the manifest's) may go on.
 * `read()` resolves to what readLedger() returns, or throws; it is only
 * called when `env` holds something to connect with.
 *
 *   verdict       exit   meaning
 *   applied       0      production has every required migration
 *   unchecked     0      no secret, and the override variable is `true`
 *   missing       1      a required migration is not in the ledger (or there
 *                        is no ledger)
 *   no-secret     1      nothing to connect with, no override
 *   unreadable    1      a secret is set, and the ledger could not be read
 *   manifest      1      the manifest itself cannot be judged
 */
export async function decide({ env, migrations, read }) {
  const faults = manifestFaults(migrations);
  if (faults.length > 0) return { verdict: 'manifest', exitCode: 1, faults };

  const override = overrideOf(env);
  const required = migrations.filter(isRequired);
  if (!canConnect(env)) {
    return override.allows
      ? { verdict: 'unchecked', exitCode: 0, required, override }
      : { verdict: 'no-secret', exitCode: 1, required, override };
  }

  let state;
  try {
    state = await read();
  } catch (error) {
    return { verdict: 'unreadable', exitCode: 1, required, override, error };
  }
  const found = compare(migrations, state.ledger);
  const ok = found.missing.length === 0;
  return { verdict: ok ? 'applied' : 'missing', exitCode: ok ? 0 : 1, required, override, state, ...found };
}

// ------------------------------------------------------------
// Saying it
// ------------------------------------------------------------

const pad2 = (n) => String(n).padStart(2, '0');
const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** `2026-10-12 08:01 UTC`, from the Date `pg` gives for a timestamptz. */
function when(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** Rows of cells as aligned lines, two spaces in front. */
function columns(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => String(row[i]).length)));
  return rows.map((cells) => `  ${cells.map((cell, i) => String(cell).padEnd(widths[i])).join('  ')}`.trimEnd());
}
const table = (headers, rows) => columns([headers, ...rows]);

/** One line per migration: its number, its name, the checkpoint that applies it, its page. */
const listed = (entries) => columns(
  entries.map((entry) => [pad2(entry.order), entry.name, `Checkpoint ${entry.checkpoint}`, entry.paths.runbook]),
);

const NOT_NEEDED = {
  optional: 'not applied — not needed (optional)',
  contract: 'not applied — not needed (contract: it comes after the deploy)',
};

const RERUN = 'Actions → this run → Re-run failed jobs. No new commit is needed.';

/**
 * `--print`: the manifest as this commit has it, and the query that shows
 * what production has. The lines to print.
 */
export function describeManifest(migrations) {
  const required = migrations.filter(isRequired);
  return [
    'sl_app — the migrations of this commit (supabase/migrations/manifest.json)',
    '',
    ...table(
      ['NN', 'migration', 'kind', 'wave', 'checkpoint', 'a deploy needs it'],
      migrations.map((entry) => [
        pad2(entry.order), entry.name, entry.kind, entry.wave, entry.checkpoint,
        isRequired(entry) ? 'yes' : `no (${entry.kind})`,
      ]),
    ),
    '',
    `A deploy of this commit needs ${required.length} of ${migrations.length} in production: every \`required\` one.`,
    'What production has — a read-only query, for the SQL editor or the CLI:',
    '',
    `  ${LEDGER_QUERY}`,
    '',
    `  supabase db query --linked "${LEDGER_QUERY}"`,
    '',
    'To let this script compare the two: node --env-file=.env scripts/check-migrations.mjs --verify',
  ];
}

/**
 * What a decision reads like: `{ out, err, notes }` — lines for stdout, lines
 * for stderr, and `notes` (`{ level, title, text }`) for the annotations of a
 * GitHub run. `explain(error)` turns the error of an `unreadable` verdict
 * into a message; a GateError already is one.
 */
export function render(result, { explain = (error) => error?.message || String(error) } = {}) {
  const out = [];
  const err = [];
  const notes = [];
  const { verdict, override, required = [] } = result;
  const needs = () => [
    `  This commit needs ${count(required.length, 'migration')} in production:`,
    ...listed(required).map((line) => `  ${line}`),
  ];

  if (verdict === 'manifest') {
    err.push(
      '',
      'REFUSED: supabase/migrations/manifest.json cannot be judged:',
      ...result.faults.map((fault) => `  - ${fault}`),
      '  The gate reads `kind` to know what a deploy needs; an entry it cannot read is one it would let through.',
      '  This is a fault of the repository, not of production: fix the manifest (`npm run test:db` names the same fault).',
    );
    notes.push({ level: 'error', title: 'Deploy stopped', text: `supabase/migrations/manifest.json cannot be judged: ${result.faults[0]}.` });
    return { out, err, notes };
  }

  if (verdict === 'no-secret') {
    err.push(
      '',
      `REFUSED: the ledger of production was not read — ${SECRET} is not set.`,
      '',
      ...needs(),
      '  Nothing says that production has them, so the deploy stops.',
      '',
      `  On GitHub, set the repository secret ${SECRET} (Settings → Secrets and variables → Actions → Secrets):`,
      '  the session-pooler connection string of the project, with the database password in it. It is the secret',
      '  the nightly backup reads; BACKUPS.md, section "The nightly run on GitHub", says where it comes from, and',
      '  sets BACKUP_PASSPHRASE with it. Then run this job again:',
      `  ${RERUN}`,
      '',
      '  To publish without the secret: read the ledger yourself —',
      `    supabase db query --linked "${LEDGER_QUERY}"`,
      `  — and when it lists every migration above, set the repository VARIABLE ${OVERRIDE} to true`,
      '  (same page, tab Variables), then run this job again. From then on no deploy is checked until the',
      '  secret is set; delete the variable that day.',
      '',
      `  On your machine, the password comes from .env (${LOCAL_SECRET}) and the address from the linked CLI:`,
      '    node --env-file=.env scripts/check-migrations.mjs --verify',
      '',
      `  ${PAGE}`,
    );
    if (override.given) {
      err.push(`  (${OVERRIDE} is set to ${JSON.stringify(override.value)}. Only the exact value true counts.)`);
    }
    notes.push({
      level: 'error',
      title: 'Deploy stopped',
      text: `The ledger of production was not read: the repository secret ${SECRET} is not set. Set it (BACKUPS.md, "The nightly run on GitHub"), `
        + `or set the repository variable ${OVERRIDE} to true after reading the ledger yourself. ${PAGE}`,
    });
    return { out, err, notes };
  }

  if (verdict === 'unchecked') {
    err.push(
      '',
      `NOT CHECKED: ${SECRET} is not set, and ${OVERRIDE} is true.`,
      '',
      ...needs(),
      '  Nobody has compared that list with production. The deploy goes on.',
      `  Set the secret and delete the variable: until then this gate is open. ${PAGE}`,
    );
    notes.push({
      level: 'warning',
      title: 'Deploy not checked against the database',
      text: `${SECRET} is not set and ${OVERRIDE} is true: nobody compared production with the ${count(required.length, 'migration')} this commit needs. ${PAGE}`,
    });
    return { out, err, notes };
  }

  if (verdict === 'unreadable') {
    const why = result.error instanceof GateError ? result.error.message : explain(result.error);
    err.push(
      '',
      'REFUSED: the ledger of production could not be read.',
      ...String(why).split('\n').map((line) => `  ${line.trim()}`),
      '',
      ...needs(),
      '  Nothing says that production has them, so the deploy stops. Once the cause is gone, run this job again:',
      `  ${RERUN}`,
    );
    if (override.allows) {
      err.push(
        `  ${OVERRIDE} is true, and does not apply: it stands in for a secret that is NOT SET.`,
        '  One is set here, so the check has to succeed.',
      );
    }
    err.push(`  ${PAGE}`);
    notes.push({
      level: 'error',
      title: 'Deploy stopped',
      text: `The ledger of production could not be read: ${String(why).split('\n')[0]} ${PAGE}`,
    });
    return { out, err, notes };
  }

  // applied, or missing: the ledger was read.
  out.push(
    '',
    ...table(
      ['NN', 'migration', 'kind', 'checkpoint', 'production'],
      result.rows.map(({ entry, needed, applied, appliedAt }) => [
        pad2(entry.order), entry.name, entry.kind, entry.checkpoint,
        applied ? `applied ${when(appliedAt)}` : needed ? 'MISSING' : NOT_NEEDED[entry.kind],
      ]),
    ),
    '',
  );
  if (result.unknown.length > 0) {
    out.push(
      `  note: the ledger also lists ${result.unknown.join(', ')}, which this commit does not know.`,
      '  Production is ahead of it (an older commit is being deployed); that does not stop a deploy.',
      '',
    );
  }

  if (verdict === 'missing') {
    const { missing } = result;
    err.push(
      `REFUSED: ${count(missing.length, 'required migration is', 'required migrations are')} not applied in production:`,
      ...listed(missing).map((line) => `  ${line}`),
    );
    if (result.noLedger) {
      err.push(
        `  Production has no ledger at all (no table ${LEDGER}): migration 01 was never applied there,`,
        '  so nothing is on record.',
      );
    }
    err.push(
      '  The app of this commit uses what they add: published now, it would call a database that does not have it.',
      '  Apply them in order — docs/RUNBOOK.md has each checkpoint and its sequence — then run this job again:',
      `  ${RERUN}`,
      `  ${OVERRIDE} does not lift this: it stands in for a secret that is not set, never for a migration.`,
      `  ${PAGE}`,
    );
    notes.push({
      level: 'error',
      title: 'Deploy stopped',
      text: `${count(missing.length, 'required migration is', 'required migrations are')} not applied in production: `
        + `${missing.map((entry) => `${entry.name} (Checkpoint ${entry.checkpoint})`).join('; ')}. Apply, then re-run the failed job. ${PAGE}`,
    });
    return { out, err, notes };
  }

  out.push(`OK: production has ${required.length === 1 ? 'the one required migration' : `all ${required.length} required migrations`} of this commit. The deploy can go on.`);
  if (override.given) {
    out.push(`  note: ${OVERRIDE} is still set (${JSON.stringify(override.value)}). The check ran, so it is not needed: delete the variable.`);
    notes.push({
      level: 'warning',
      title: 'Deploy override still set',
      text: `The ledger was read and every required migration is applied. The repository variable ${OVERRIDE} is not needed any more: delete it. ${PAGE}`,
    });
  }
  return { out, err, notes };
}
