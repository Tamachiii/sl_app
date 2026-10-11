// Load a backup into a database that already has the structure
// (supabase/schema.sql), and prove that what is in it afterwards is what the
// file holds.
//
// This is the tool of the restore drill. It writes, so everything about it is
// built to make the wrong target hard to hit:
//
//   - the target is named on the command line and nowhere else. It is never
//     taken from SUPABASE_DB_URL or SUPABASE_DB_PASSWORD: those name the
//     database the backups come FROM;
//   - a host that is a Supabase project is refused unless a flag repeats that
//     host, and the linked production project is refused unless a second flag
//     repeats its ref (refusals(), below) — checked before a connection is
//     opened;
//   - a target that already holds rows is refused unless told to replace them.
//
// One transaction: either every table is loaded and compares equal, or the
// target is left exactly as it was.
//
// `SET LOCAL session_replication_role = replica`, as a data dump of pg_dump
// does: the rows are facts that already passed the triggers once. Without it
// the insert into auth.users would create a second profile, every pin and
// notify trigger would fire again, and tables would have to be loaded in
// foreign-key order. CHECK, NOT NULL and UNIQUE constraints still hold.
//
// A row is loaded by casting each text value to the type of its column — the
// reverse of how the dump printed it (format.mjs).

import pg from 'pg';
import {
  APP_SCHEMAS, LEDGER, describeTable, qualified, quoteIdent, selectRowsSql, settingsSql, streamRows,
} from './catalog.mjs';
import { clientConfig, isSupabaseHost, projectRefOf } from './connection.mjs';
import { BackupError, USAGE } from './errors.mjs';
import { RowDigest, readBackup } from './format.mjs';
import { verifyBackup } from './verify.mjs';

/** The flag that allows a Supabase host: its value must repeat the host. */
export const CONFIRM_SUPABASE_HOST = 'i-am-restoring-into-supabase-host';
/** The flag that allows the production project: its value must repeat the ref. */
export const CONFIRM_PRODUCTION_REF = 'i-am-overwriting-the-production-project';

// supabase/schema.sql creates this row itself (the `set-videos` bucket), so a
// database that "only has the schema" is never empty here. The backup's rows
// replace it. A migration that seeds rows into another table makes that table
// one more of these: without its name here, restore.mjs asks for
// --replace-existing-rows on a target that only has the schema. (The drill
// does not depend on this list: its database is its own.)
const SEEDED_BY_SCHEMA = new Set(['storage.buckets']);

const literal = (text) => `'${String(text).replace(/'/g, "''")}'`;

/**
 * Why this target is refused — an empty list when it is not.
 *   refs      the project refs known as production (connection.mjs)
 *   confirm   { supabaseHost, productionRef }: the values of the two flags
 */
export function refusals(target, { refs = new Set(), confirm = {} } = {}) {
  const out = [];
  if (isSupabaseHost(target.host) && confirm.supabaseHost !== target.host) {
    out.push(
      `${target.host} is a Supabase project. This tool is for the restore drill, into a scratch `
      + `database. To write there all the same, add --${CONFIRM_SUPABASE_HOST}=${target.host}`,
    );
  }
  const ref = projectRefOf(target, refs);
  if (ref && confirm.productionRef !== ref) {
    out.push(
      `The target names project ${ref}, which this checkout knows as PRODUCTION. Restoring over `
      + `production is not a drill. To do it all the same, add --${CONFIRM_PRODUCTION_REF}=${ref}`,
    );
  }
  return out;
}

/**
 * What to do with one table of the backup, given the table of the same name
 * in the target (`null` when it has none).
 */
function planTable(inBackup, inTarget, { toleratePlatformGaps, skip }) {
  const plan = {
    name: inBackup.name, inBackup, inTarget, action: 'load', insert: [], comparable: true, notes: [], problems: [],
  };
  if (skip.has(inBackup.name)) {
    plan.action = 'skip';
    plan.notes.push('left out on request');
    return plan;
  }
  // Only the tables the platform owns may differ, and only when asked: the
  // suite's stand-in for Supabase has a reduced auth.users, no auth.identities.
  const tolerated = toleratePlatformGaps && !APP_SCHEMAS.includes(inBackup.schema);

  if (inBackup.name === LEDGER) {
    plan.action = 'ledger';
    return plan;
  }
  if (!inTarget) {
    if (tolerated) {
      plan.action = 'skip';
      plan.notes.push('not in the target');
    } else {
      plan.problems.push(`${inBackup.name} is in the backup and not in the target`);
    }
    return plan;
  }

  const target = new Map(inTarget.columns.map((column) => [column.name, column]));
  const backup = new Set(inBackup.columns.map((column) => column.name));
  const missing = inBackup.columns.filter((column) => !target.has(column.name)).map((column) => column.name);
  if (missing.length > 0) {
    if (tolerated) {
      plan.comparable = false;
      plan.notes.push(`${missing.length} of ${inBackup.columns.length} columns are not in the target`);
    } else {
      plan.problems.push(`${inBackup.name}: the target has no column ${missing.join(', ')} — their values would be lost`);
    }
  }
  for (const column of inBackup.columns) {
    const there = target.get(column.name);
    if (!there) continue;
    // A generated column is computed by the target; it is compared, not loaded.
    if (there.generated === '') plan.insert.push(there);
    if (there.type !== column.type) {
      plan.comparable = false;
      plan.notes.push(`${column.name} is ${column.type} in the backup and ${there.type} in the target`);
    }
  }
  for (const column of inTarget.columns) {
    if (backup.has(column.name)) continue;
    if (column.not_null && !column.has_default && column.generated === '' && column.identity === '') {
      plan.problems.push(`${inBackup.name}: the target's column ${column.name} is NOT NULL without a default, and the backup has no value for it`);
    }
  }
  if (plan.insert.length === 0) plan.problems.push(`${inBackup.name}: no column of the backup can be loaded into the target`);
  return plan;
}

function insertSql({ inTarget, insert }) {
  const names = insert.map((column) => quoteIdent(column.name)).join(', ');
  const values = insert
    .map((column) => `(sl_backup_row ->> ${literal(column.name)})::${column.type}`)
    .join(', ');
  // An identity column declared GENERATED ALWAYS takes a given value only
  // with this clause; it is harmless on the others.
  const overriding = insert.some((column) => column.identity !== '') ? ' OVERRIDING SYSTEM VALUE' : '';
  return `INSERT INTO ${qualified(inTarget.schema, inTarget.table)} (${names})${overriding} `
    + `SELECT ${values} FROM pg_catalog.jsonb_array_elements($1::jsonb) AS sl_backup_row`;
}

// A refusal of the database, without the row. For a value or a constraint
// (SQLSTATE classes 22 and 23) the server's message and detail can quote the
// row ("Failing row contains (…)", "invalid input syntax for type integer:
// …"), and the drill may run where its log is public. Any other refusal — no
// privilege on the table, a type the target does not have — names objects,
// not values, and is passed on as it is.
function refusedRow(table, err, details) {
  if (!/^2[23]/.test(err.code ?? '')) {
    return new BackupError(
      `${table}: the target refused the load: ${err.message}${err.code ? ` (SQLSTATE ${err.code})` : ''}. Nothing was kept.`,
      { cause: err },
    );
  }
  const where = [
    `SQLSTATE ${err.code}`,
    err.constraint && `constraint ${err.constraint}`,
    err.column && `column ${err.column}`,
  ].filter(Boolean).join(', ');
  return new BackupError(
    `${table}: the target refused a row of the backup (${where}). Nothing was kept.`
    + (details ? `\n  ${err.message}${err.detail ? `\n  ${err.detail}` : ''}` : '\n  --details prints the message of the server, which may quote the row.'),
    { cause: err },
  );
}

/** After the load, a sequence that feeds a column stands at or past every id in use. */
async function resetSequences(query, plan) {
  const reset = [];
  for (const { inBackup, inTarget, insert } of plan) {
    const saved = new Map(inBackup.columns.map((column) => [column.name, column.sequence?.last_value ?? null]));
    for (const column of insert) {
      if (!column.owned_sequence) continue;
      const { rows: [{ highest }] } = await query(
        `SELECT pg_catalog.max(${quoteIdent(column.name)})::text AS highest FROM ${qualified(inTarget.schema, inTarget.table)}`,
      );
      const candidates = [highest, saved.get(column.name)].filter((value) => value !== null && /^\d+$/.test(value)).map(BigInt);
      if (candidates.length === 0) continue;
      const value = candidates.reduce((a, b) => (a > b ? a : b));
      if (value < 1n) continue;
      await query('SELECT pg_catalog.setval($1::regclass, $2::bigint, true)', [column.owned_sequence, value.toString()]);
      reset.push({ sequence: column.owned_sequence, value: value.toString() });
    }
  }
  return reset;
}

/**
 * Load `file` into the database of `target`.
 *
 *   target                from parsePostgresUrl()
 *   refs, confirm         see refusals()
 *   replaceExistingRows   empty the tables of the backup first, when the
 *                         target already holds rows
 *   toleratePlatformGaps  for the platform's tables only (auth.*, storage.*):
 *                         skip a table or a column the target does not have,
 *                         and say so — a stand-in for Supabase has fewer
 *   skip                  names of tables of the backup to leave out
 *                         ('auth.users'): for a target where they cannot be
 *                         written and come back another way
 *   details               put the server's message in the error of a refused row
 *   onTable               ({ name, action, rows }) as each table is done
 *
 * Resolves, after COMMIT, to `{ tables: [{ name, action, rows, compared,
 * notes }], totalRows, sequences, ledger, header }`. `compared` is 'checksum'
 * (read back and equal to the trailer, row for row), 'count' (the columns
 * differ, so only the number of rows could be compared) or null (not loaded).
 */
export async function restoreBackup({
  file, passphrase = null, target, env = process.env, refs = new Set(), confirm = {},
  replaceExistingRows = false, toleratePlatformGaps = false, skip = [], details = false, onTable = null,
}) {
  const refused = refusals(target, { refs, confirm });
  if (refused.length > 0) throw new BackupError(`Refused.\n- ${refused.join('\n- ')}`, { exitCode: USAGE });

  // The whole file first: a damaged backup never gets as far as a DELETE.
  const checked = await verifyBackup({ file, passphrase });
  const { header } = checked;
  const expected = new Map(checked.tables.map((table) => [table.name, table]));
  const unknown = skip.filter((name) => !expected.has(name));
  if (unknown.length > 0) {
    throw new BackupError(`--skip names a table the backup does not hold: ${unknown.join(', ')}`, { exitCode: USAGE });
  }

  const client = new pg.Client(clientConfig(target, env));
  client.on('error', () => {});
  await client.connect();
  const query = (sql, params) => client.query(sql, params);

  try {
    await query('BEGIN');
    try {
      await query('SET LOCAL session_replication_role = replica');
    } catch (err) {
      throw new BackupError(
        'The target does not let this role set session_replication_role, which a data restore needs '
        + '(a superuser, or GRANT SET ON PARAMETER session_replication_role, as the `postgres` role of '
        + `Supabase has): ${err.message}`,
        { cause: err },
      );
    }
    await query(settingsSql());
    await query("SELECT pg_catalog.set_config('standard_conforming_strings', 'on', true), pg_catalog.set_config('statement_timeout', '0', true)");

    // What goes where — settled before the first row moves.
    const plan = [];
    for (const inBackup of header.tables) {
      const inTarget = await describeTable(query, inBackup.schema, inBackup.table);
      plan.push(planTable(inBackup, inTarget, { toleratePlatformGaps, skip: new Set(skip) }));
    }
    const problems = plan.flatMap((entry) => entry.problems);
    if (problems.length > 0) {
      throw new BackupError(
        `The target does not have the structure of the backup; nothing was changed.\n- ${problems.join('\n- ')}\n`
        + 'Load supabase/schema.sql of the commit the backup names first'
        + (problems.some((problem) => /^(auth|storage)\./.test(problem))
          ? '; for a stand-in that has less of auth.* and storage.* than Supabase, add --tolerate-platform-gaps.'
          : '.'),
      );
    }
    const loading = plan.filter((entry) => entry.action === 'load');
    // A statement about one table: what the target answers is reported with
    // the name of that table in front.
    const on = (name, sql, params) => query(sql, params).catch((err) => {
      throw refusedRow(name, err, details);
    });

    const occupied = [];
    for (const { name, inTarget } of loading) {
      if (SEEDED_BY_SCHEMA.has(name)) continue;
      const { rows: [{ has_rows: hasRows }] } = await on(
        name, `SELECT EXISTS (SELECT 1 FROM ${qualified(inTarget.schema, inTarget.table)}) AS has_rows`,
      );
      if (hasRows) occupied.push(name);
    }
    if (occupied.length > 0 && !replaceExistingRows) {
      throw new BackupError(
        `The target is not empty: ${occupied.join(', ')} already hold rows. Nothing was changed.\n`
        + 'A restore replaces what is there. If these rows may go, add --replace-existing-rows.',
        { exitCode: USAGE },
      );
    }

    // Second pass over the file: load.
    const byName = new Map(plan.map((entry) => [entry.name, entry]));
    const ledgerInBackup = [];
    let current = null;
    let batch = [];
    let batchBytes = 0;
    const flush = async () => {
      if (batch.length === 0) return;
      const rows = `[${batch.join(',')}]`;
      batch = [];
      batchBytes = 0;
      await on(current.name, current.sql, [rows]);
    };
    for await (const entry of readBackup(file, { passphrase })) {
      if (entry.type === 'table') {
        const planned = byName.get(entry.table.name);
        current = planned.action === 'load' ? { ...planned, sql: insertSql(planned) } : planned;
        if (current.action === 'load') {
          const { inTarget } = current;
          await on(current.name, `DELETE FROM ${inTarget.kind === 'p' ? '' : 'ONLY '}${qualified(inTarget.schema, inTarget.table)}`);
        }
      } else if (entry.type === 'row') {
        if (current.action === 'ledger') ledgerInBackup.push(JSON.parse(entry.text).name);
        if (current.action !== 'load') continue;
        batch.push(entry.text);
        batchBytes += entry.text.length;
        if (batch.length >= 500 || batchBytes >= 1_000_000) await flush();
      } else if (entry.type === 'end') {
        await flush();
      }
    }

    const sequences = await resetSequences(query, loading);

    // Read every loaded table back the way the dump read it, and compare.
    const tables = [];
    const differing = [];
    for (const entry of plan) {
      const want = expected.get(entry.name);
      const line = { name: entry.name, action: entry.action, rows: want.rows, compared: null, notes: entry.notes };
      if (entry.action === 'load') {
        const { inTarget, inBackup } = entry;
        if (entry.comparable) {
          const digest = new RowDigest();
          await streamRows(query, selectRowsSql(inTarget, inBackup.columns.map(({ name }) => name)), (texts) => {
            for (const text of texts) digest.add(text);
          });
          const got = digest.done();
          line.compared = 'checksum';
          if (got.rows !== want.rows) differing.push(`${entry.name}: ${got.rows} rows in the target, ${want.rows} in the backup`);
          else if (got.sha256 !== want.sha256) differing.push(`${entry.name}: ${got.rows} rows, and they do not read back as they were written`);
        } else {
          const { rows: [{ rows }] } = await query(
            `SELECT pg_catalog.count(*)::text AS rows FROM ${qualified(inTarget.schema, inTarget.table)}`,
          );
          line.compared = 'count';
          if (Number(rows) !== want.rows) differing.push(`${entry.name}: ${rows} rows in the target, ${want.rows} in the backup`);
        }
      }
      tables.push(line);
      await onTable?.(line);
    }
    if (differing.length > 0) {
      throw new BackupError(`The target does not hold what the backup holds; nothing was kept.\n- ${differing.join('\n- ')}`);
    }

    // The ledger says which migrations made the STRUCTURE. The target's own
    // is the truth about the target; the backup's is what production had.
    // `null` on a side: that database has no ledger (before migration 01).
    const [ledgerSchema, ledgerName] = LEDGER.split('.');
    const targetLedger = byName.get(LEDGER)?.inTarget ?? await describeTable(query, ledgerSchema, ledgerName);
    const ledger = {
      backup: byName.has(LEDGER) ? ledgerInBackup.sort() : null,
      target: targetLedger
        ? (await query(`SELECT "name"::text AS name FROM ${qualified(ledgerSchema, ledgerName)} ORDER BY 1`)).rows.map((row) => row.name)
        : null,
    };

    await query('COMMIT');
    return {
      header,
      tables,
      totalRows: tables.filter((table) => table.action === 'load').reduce((sum, { rows }) => sum + rows, 0),
      sequences,
      ledger,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end().catch(() => {});
  }
}
