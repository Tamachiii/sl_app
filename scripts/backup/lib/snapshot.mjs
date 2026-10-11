// The one transaction a dump reads in, and the guard in front of it.
//
// A dump connects to production. It must not be able to change it, and it
// must see ONE state of the database even while athletes are logging sets:
//
//   BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY
//
// REPEATABLE READ: every statement of the transaction sees the snapshot taken
// by the first one — a row inserted while the dump is at another table is in
// none of them, so a session never arrives without its sets. READ ONLY: the
// server itself refuses any write (SQLSTATE 25006), whatever this code sends.
//
// The snapshot is about ROWS. Two commands do not change rows, they put
// another file under the table: TRUNCATE, and an ALTER TABLE that writes the
// table again (a column that changes its type — a migration). PostgreSQL
// documents both as not MVCC-safe: once one of them has committed, the table
// is EMPTY for every snapshot taken before. A dump that trusted its snapshot
// alone would write that table with 0 rows, verify, and exit 0. So, as pg_dump
// does, the dump takes the lock of a read on every table before it reads the
// first row, and keeps it to the end (holdTables(), below): such a command
// then waits for the dump. One that committed in the moment between the
// snapshot and the lock is noticed there, and the dump stops.
//
// The guard below is about writes again: a second bar on the door READ ONLY
// already shuts. Nothing reaches the connection of a dump except through
// `query()`, and `query()` only passes a statement that has the shape of one
// of the reads a dump makes.

import { qualified } from './catalog.mjs';
import { BackupError } from './errors.mjs';

export const BEGIN_SNAPSHOT = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';

const FIRST_WORD = /^(SELECT|DECLARE|FETCH|CLOSE|ROLLBACK)\b/;
// Words no read of a dump contains once strings and quoted names are taken
// out: every statement that writes, locks or runs code starts with one of
// them, or needs one (SELECT … INTO, WITH … AS (DELETE …), FOR UPDATE).
const WRITES = /\b(?:insert|update|delete|truncate|merge|create|alter|drop|grant|revoke|comment|copy|call|do|into|lock|vacuum|analyze|refresh|reindex|cluster|prepare|execute|listen|notify|unlisten|discard|reset|set|begin|start|commit|savepoint|release|share|nextval|setval)\b/i;

/** `sql` without its string literals and quoted identifiers. */
function bare(sql) {
  return sql.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');
}

/** Throw unless `sql` is one statement with the shape of a read. */
export function assertReadOnlySql(sql) {
  const text = String(sql).trim();
  if (text === BEGIN_SNAPSHOT) return;
  const stripped = bare(text);
  const refuse = (why) => {
    throw new BackupError(`Refusing to send a statement that ${why} on the connection of a dump: ${stripped.slice(0, 80)}`);
  };
  if (stripped.includes(';')) refuse('holds more than one statement');
  if (/--|\/\*/.test(stripped)) refuse('holds a comment');
  if (!FIRST_WORD.test(stripped)) refuse('is not a read');
  if (/^DECLARE\b/.test(stripped) && !/^DECLARE \w+ NO SCROLL CURSOR FOR SELECT\b/.test(stripped)) {
    refuse('declares something other than a read-only cursor');
  }
  if (WRITES.test(stripped)) refuse('could write');
}

/**
 * Open the snapshot on a connected `pg` client and return the guarded
 * `query(sql, params)`. Refuses to go on when the server did not give the
 * transaction that was asked for.
 */
export async function openSnapshot(client) {
  const query = (sql, params) => {
    assertReadOnlySql(typeof sql === 'string' ? sql : sql.text);
    return client.query(sql, params);
  };
  await query(BEGIN_SNAPSHOT);
  const { rows: [state] } = await query(
    `SELECT pg_catalog.current_setting('transaction_read_only') AS read_only,
            pg_catalog.current_setting('transaction_isolation') AS isolation`,
  );
  if (state.read_only !== 'on' || state.isolation !== 'repeatable read') {
    throw new BackupError(
      `The server did not open a read-only snapshot (read only: ${state.read_only}, `
      + `isolation: ${state.isolation}); nothing was read.`,
    );
  }
  return query;
}

// ------------------------------------------------------------
// The tables, held still
// ------------------------------------------------------------

// ACCESS SHARE, the lock every SELECT takes on its table, kept until the
// transaction ends like any lock. An empty read takes it: no LOCK statement,
// nothing the guard would have to learn. It stands in the way of nothing but
// what needs the table for itself (ACCESS EXCLUSIVE: TRUNCATE, most forms of
// ALTER TABLE, DROP) — athletes go on reading and writing rows.
// ONLY, as the rows are read (catalog.mjs): a partitioned table is read
// through its parent, and locked with its partitions.
const holdSql = ({ schema, table, kind }) => `SELECT 1 FROM ${kind === 'p' ? '' : 'ONLY '}${qualified(schema, table)} LIMIT 0`;

// Of the tables named: those that are not, now, what the snapshot saw. The
// row of pg_class is read like any row, in the snapshot; to_regclass() and
// pg_relation_filenode() answer from the catalog as it is at this moment.
// Another oid behind the name: dropped and made again, or renamed away.
// Another file behind the oid: TRUNCATE, or a rewrite. (A table without a
// file of its own — a partitioned parent — has 0 on one side, NULL on the
// other; its partitions are not looked at one by one.)
const REPLACED = `
  SELECT pg_catalog.format('%s.%s', wanted.nspname, wanted.relname) AS name
    FROM ROWS FROM (pg_catalog.unnest($1::text[]), pg_catalog.unnest($2::text[])) AS wanted (nspname, relname)
    JOIN pg_catalog.pg_namespace n ON n.nspname = wanted.nspname
    JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relname = wanted.relname
   WHERE pg_catalog.to_regclass(pg_catalog.format('%I.%I', wanted.nspname, wanted.relname))::oid IS DISTINCT FROM c.oid
      OR pg_catalog.pg_relation_filenode(c.oid) IS DISTINCT FROM NULLIF(c.relfilenode, 0::oid)
   ORDER BY 1`;

/**
 * Hold every table of `tables` (`{ name, schema, table, kind }`, as
 * describeTable() gives them) until the transaction of `query` ends, and
 * refuse to go on when one of them was emptied, rewritten or replaced since
 * the snapshot was taken — which the snapshot itself cannot tell from an
 * empty table.
 *
 * Waits for whoever has a table for itself at that moment (a migration in
 * flight), for as long as a statement of this connection may take
 * (connection.mjs). `explain(table, err)` may give a better error for a table
 * the server does not let this role read.
 */
export async function holdTables(query, tables, explain = (_table, err) => err) {
  for (const table of tables) {
    try {
      await query(holdSql(table));
    } catch (err) {
      throw explain(table, err);
    }
  }
  const { rows } = await query(REPLACED, [tables.map(({ schema }) => schema), tables.map(({ table }) => table)]);
  if (rows.length > 0) {
    throw new BackupError(
      `Another session emptied, rewrote or replaced ${rows.map(({ name }) => name).join(', ')} just as this dump began `
      + '(a TRUNCATE, or a migration that rewrites or re-creates a table). The rows the dump set out to read are '
      + 'no longer there for it; nothing was written. Take the backup again.',
    );
  }
}
