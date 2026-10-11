// What a dump reads and how a table is read — shared by the dump (which
// writes the rows to the file) and the restore (which reads the target back
// the same way, to compare it with the file).
//
// Everything here is SQL text or a function of a `query(sql, params)` given by
// the caller; nothing opens a connection.

/** A PostgreSQL identifier, quoted. */
export const quoteIdent = (name) => `"${String(name).replace(/"/g, '""')}"`;
export const qualified = (schema, table) => `${quoteIdent(schema)}.${quoteIdent(table)}`;

/**
 * The schemas of the app. Every table in them is dumped, whatever it is
 * called: the list is read from the catalog. `public` is what the API
 * exposes; `app_private` is what it must never reach — the migration ledger
 * today (the schema does not exist before migration 01), and whatever a later
 * migration puts there.
 */
export const APP_SCHEMAS = ['public', 'app_private'];

/**
 * The tables dumped from the schemas the platform owns. A Supabase project
 * always has them: a database without one of them is not the app's.
 *
 *   auth.users, auth.identities the accounts. Every row of the app hangs on
 *                               profiles.id = auth.users.id; without these two
 *                               nobody can sign in to a restored database.
 *   storage.buckets, .objects   the bucket and one row per uploaded video —
 *                               the METADATA. The video files are in object
 *                               storage and in no database dump.
 *
 * Not dumped, on purpose: the rest of `auth` (sessions, refresh tokens, MFA,
 * audit log — everyone signs in again after a restore), `vault` (secrets are
 * re-created by hand), `net` and the other platform schemas.
 */
export const PLATFORM_TABLES = [
  { schema: 'auth', table: 'users' },
  { schema: 'auth', table: 'identities' },
  { schema: 'storage', table: 'buckets' },
  { schema: 'storage', table: 'objects' },
];

/**
 * `app_private.app_migrations`: what the structure is, not what the athletes
 * did. It is dumped like any table, and a restore does not load it.
 */
export const LEDGER = 'app_private.app_migrations';

/**
 * Settings of the transaction, so that the text form of a value does not
 * depend on the server, the role or the pooler it came through — and so that
 * the restore reads a table back to the very same text:
 *
 *   row_security off   a role that row-level security would filter gets an
 *                      ERROR instead of fewer rows (as pg_dump does it)
 *   search_path        only pg_catalog: every other type name is printed with
 *                      its schema
 */
export const SETTINGS = {
  row_security: 'off',
  search_path: 'pg_catalog',
  TimeZone: 'UTC',
  DateStyle: 'ISO, YMD',
  IntervalStyle: 'postgres',
  bytea_output: 'hex',
  extra_float_digits: '3',
};

/** One SELECT that applies SETTINGS to the current transaction only. */
export const settingsSql = () => `SELECT ${
  Object.entries(SETTINGS)
    .map(([name, value]) => `pg_catalog.set_config('${name}', '${value}', true)`)
    .join(', ')
}`;

const TABLES_OF_SCHEMA = `
  SELECT c.relname::text AS "table"
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = $1
     AND c.relkind IN ('r', 'p')
     AND NOT c.relispartition
   ORDER BY 1`;

const TABLE = `
  SELECT c.relkind::text AS kind,
         pg_catalog.has_table_privilege(c.oid, 'SELECT') AS readable
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p')`;

const COLUMNS = `
  SELECT a.attname::text AS name,
         pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
         a.attnotnull AS not_null,
         a.atthasdef AS has_default,
         a.attgenerated::text AS generated,
         a.attidentity::text AS identity,
         pg_catalog.pg_get_serial_sequence(
           pg_catalog.format('%I.%I', n.nspname, c.relname), a.attname
         ) AS owned_sequence
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = $1 AND c.relname = $2
     AND a.attnum > 0 AND NOT a.attisdropped
   ORDER BY a.attnum`;

/** The names of the ordinary and partitioned tables of a schema. */
export async function tablesOf(query, schema) {
  return (await query(TABLES_OF_SCHEMA, [schema])).rows.map((row) => row.table);
}

/**
 * One table as the catalog describes it, or null when it does not exist:
 * `{ name, schema, table, kind, readable, columns: [{ name, type, not_null,
 * has_default, generated, identity, owned_sequence }] }`.
 */
export async function describeTable(query, schema, table) {
  const found = (await query(TABLE, [schema, table])).rows[0];
  if (!found) return null;
  const { rows: columns } = await query(COLUMNS, [schema, table]);
  return { name: `${schema}.${table}`, schema, table, ...found, columns };
}

/**
 * The SELECT that prints a table as one JSON text per row: the columns named,
 * each cast to text, sorted by the text of the row (format.mjs says why).
 */
export function selectRowsSql({ schema, table, kind }, columnNames) {
  const columns = columnNames
    .map((name) => `${quoteIdent(name)}::text AS ${quoteIdent(name)}`)
    .join(', ');
  // ONLY: a table that others inherit from is listed with its children, each
  // under its own name. A partitioned table is read through its parent.
  const from = `${kind === 'p' ? '' : 'ONLY '}${qualified(schema, table)}`;
  return 'SELECT sl_backup_json FROM ('
    + 'SELECT pg_catalog.row_to_json(sl_backup_row.*)::text AS sl_backup_json '
    + `FROM (SELECT ${columns} FROM ${from}) AS sl_backup_row`
    + ') AS sl_backup_sorted ORDER BY sl_backup_json COLLATE "C"';
}

const CURSOR = 'sl_backup_cursor';

/**
 * Run `sql` (one text column) through a server-side cursor and hand the rows
 * to `onRows(texts)` in batches, so that a table never has to fit in memory.
 * Needs an open transaction.
 */
export async function streamRows(query, sql, onRows, { batch = 1000 } = {}) {
  await query(`DECLARE ${CURSOR} NO SCROLL CURSOR FOR ${sql}`);
  for (;;) {
    const { rows } = await query({ text: `FETCH ${batch} FROM ${CURSOR}`, rowMode: 'array' });
    if (rows.length > 0) await onRows(rows.map(([text]) => text));
    if (rows.length < batch) break;
  }
  await query(`CLOSE ${CURSOR}`);
}
