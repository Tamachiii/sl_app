// Dump a database into one backup file (format.mjs describes the file).
//
// What is read: every table of schema `public` — the list comes from the
// catalog at the moment of the dump, so a table added by a later migration is
// in the next backup without anyone touching this code — and the tables of
// catalog.mjs (accounts, storage metadata, the migration ledger).
//
// How: one read-only REPEATABLE READ transaction (snapshot.mjs), each table
// held against a TRUNCATE or a rewrite before the first row is read, then
// read through a server-side cursor, each row as the text the server prints.
// The rows go straight into gzip and, with a passphrase, into the cipher:
// nothing unencrypted is written to disk on the way, and the file only gets
// its name when the trailer is in it and it has been read back from the disk.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import pg from 'pg';
import {
  APP_SCHEMA, PLATFORM_TABLES, SETTINGS, describeTable, selectRowsSql, settingsSql, streamRows, tablesOf,
} from './catalog.mjs';
import { clientConfig, repoRoot, tlsFor } from './connection.mjs';
import { encryptor } from './envelope.mjs';
import { BackupError } from './errors.mjs';
import {
  FORMAT, RowDigest, VERSION, endLine, headerLine, rowLine, tableLine, trailerLine,
} from './format.mjs';
import { holdTables, openSnapshot } from './snapshot.mjs';
import { verifyBackup } from './verify.mjs';

const run = promisify(execFile);

// ------------------------------------------------------------
// The file being written
// ------------------------------------------------------------

/**
 * text → gzip → (cipher) → `<file>.partial`, read back and renamed to `<file>`
 * by finish(). A dump that stops halfway leaves nothing behind: abort()
 * removes the partial file, and a partial file is never a backup anyway (no
 * trailer).
 */
class BackupFile {
  constructor(file, passphrase, verify) {
    this.file = file;
    this.partial = `${file}.partial`;
    this.passphrase = passphrase;
    this.verify = verify;
    this.content = createHash('sha256');
  }

  async open() {
    // 'wx': never write over a file that is there. 0600: the owner only.
    const handle = await fsp.open(this.partial, 'wx', 0o600);
    await handle.chmod(0o600);
    this.gzip = zlib.createGzip({ level: zlib.constants.Z_BEST_COMPRESSION });
    const stages = this.passphrase
      ? [this.gzip, encryptor(this.passphrase), handle.createWriteStream()]
      : [this.gzip, handle.createWriteStream()];
    this.written = pipeline(stages);
    // Reported by finish(); must not become an unhandled rejection first.
    this.written.catch(() => {});
  }

  /** Lines without their line feed. Everything written counts in the content sum. */
  async write(lines) {
    const bytes = Buffer.from(`${lines.join('\n')}\n`, 'utf8');
    this.content.update(bytes);
    if (!this.gzip.write(bytes)) await once(this.gzip, 'drain');
  }

  contentSum() {
    return this.content.copy().digest('hex');
  }

  /**
   * On the disk, and read back from it, before it gets the name that says
   * "this is a backup". Resolves to what the reading back found.
   */
  async finish() {
    this.gzip.end();
    await this.written;
    const handle = await fsp.open(this.partial, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    // A file that cannot be read back is not a backup: the way verify.mjs
    // will read it — decrypt, unpack, recount, recompute, compare with the
    // trailer. It is kept to look at, under a name no tool takes for a backup.
    let readBack;
    try {
      readBack = await this.verify({ file: this.partial, passphrase: this.passphrase });
    } catch (err) {
      const kept = `${this.file}.failed`;
      await fsp.rename(this.partial, kept).catch(() => {});
      throw new BackupError(`The file was written and does not read back (kept as ${kept}): ${err.message}`, { cause: err });
    }
    await fsp.rename(this.partial, this.file);
    return readBack;
  }

  async abort() {
    this.gzip?.destroy();
    await this.written?.catch(() => {});
    await fsp.rm(this.partial, { force: true });
  }
}

// ------------------------------------------------------------
// The header
// ------------------------------------------------------------

async function repositoryState(root) {
  const state = { commit: null, schema_sql_sha256: null };
  try {
    state.commit = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim() || null;
  } catch { /* not a checkout, or no git: the header says null */ }
  try {
    state.schema_sql_sha256 = createHash('sha256')
      .update(await fsp.readFile(path.join(root, 'supabase/schema.sql')))
      .digest('hex');
  } catch { /* no schema.sql next to the scripts */ }
  return state;
}

/** The tables to dump, each with its columns, in the order they are written. */
async function tablesToDump(query, role) {
  const wanted = [
    ...(await tablesOf(query, APP_SCHEMA)).map((table) => ({ schema: APP_SCHEMA, table, required: true })),
    ...PLATFORM_TABLES,
  ];
  if (!wanted.some(({ schema }) => schema === APP_SCHEMA)) {
    throw new BackupError(`Schema ${APP_SCHEMA} has no table: this is not the database of the app.`);
  }
  const tables = [];
  for (const { schema, table, required } of wanted) {
    const described = await describeTable(query, schema, table);
    if (!described) {
      if (required) throw new BackupError(`${schema}.${table} does not exist in this database; nothing was written.`);
      continue;
    }
    if (!described.readable) {
      throw new BackupError(`Role ${role} may not read ${described.name}; nothing was written.`);
    }
    tables.push(described);
  }
  return tables.sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** `last_value` of the sequences that feed a column, so a restore never hands an id out twice. */
async function sequenceValues(query, tables) {
  const values = new Map();
  for (const table of tables) {
    for (const column of table.columns) {
      if (!column.owned_sequence) continue;
      const { rows: [row] } = await query(
        `SELECT s.last_value::text AS last_value
           FROM pg_catalog.pg_sequences s
          WHERE pg_catalog.format('%I.%I', s.schemaname, s.sequencename) = $1`,
        [column.owned_sequence],
      );
      // NULL: never used, or not readable by this role.
      values.set(column.owned_sequence, row?.last_value ?? null);
    }
  }
  return values;
}

// ------------------------------------------------------------
// The dump
// ------------------------------------------------------------

/**
 * Dump the database of `connection` into `file`.
 *
 *   connection  from connection.mjs (resolveSource / parsePostgresUrl)
 *   file        the final path; must not exist
 *   passphrase  encrypts the file when given
 *   env         where PGSSLROOTCERT is looked up
 *   onStart     (header) once the snapshot is open and the tables are held
 *   onTable     async ({ name, rows, index, count }) after each table — the
 *               progress line of the command, and the hook of the test that
 *               writes to the database while it is being dumped
 *   verify      how the written file is read back before it gets its name:
 *               verifyBackup(), unless a test has another answer
 *
 * Resolves to `{ file, encrypted, tables: [{ name, rows, sha256 }], totalRows,
 * header, readBack: { tables, totalRows } }` once the trailer is written, the
 * file has been read back from the disk, and it has its name.
 */
export async function dumpDatabase({
  connection, file, passphrase = null, env = process.env, root = repoRoot, onStart = null, onTable = null,
  verify = verifyBackup,
}) {
  if (fs.existsSync(file)) throw new BackupError(`${file} exists already; a backup is never written over.`);
  const client = new pg.Client(clientConfig(connection, env));
  // An error on an idle connection (the server went away) is reported by the
  // query that meets it, not thrown from nowhere.
  client.on('error', () => {});
  await client.connect();

  const backup = new BackupFile(file, passphrase, verify);
  let opened = false;
  try {
    const query = await openSnapshot(client);
    await query(settingsSql());
    const { rows: [server] } = await query(
      `SELECT pg_catalog.current_setting('server_version') AS version,
              pg_catalog.current_setting('server_version_num') AS version_num,
              pg_catalog.current_database()::text AS database,
              current_user::text AS role,
              pg_catalog.now()::text AS snapshot_at,
              (SELECT r.rolsuper OR r.rolbypassrls FROM pg_catalog.pg_roles r
                WHERE r.rolname = current_user) AS reads_through_rls`,
    );
    // 42501 with row_security off: the role is subject to a policy on that
    // table. Fewer rows would have been a backup that lies.
    const pastRowSecurity = (table, err) => (err.code === '42501' && !server.reads_through_rls
      ? new BackupError(
        `Role ${server.role} cannot read ${table.name} past its row-level security `
        + `(${err.message}). A backup needs a role that bypasses it — the \`postgres\` `
        + 'connection string does; nothing was written.',
        { cause: err },
      )
      : err);

    const tables = await tablesToDump(query, server.role);
    // Before a row is read, and before the file exists: no table can be
    // emptied or rewritten under the dump from here on (snapshot.mjs).
    await holdTables(query, tables, pastRowSecurity);
    const sequences = await sequenceValues(query, tables);

    const header = {
      format: FORMAT,
      version: VERSION,
      created_at: new Date().toISOString(),
      source: {
        host: connection.host,
        user: connection.user,
        database: server.database,
        role: server.role,
        server_version: server.version,
        server_version_num: Number(server.version_num),
        snapshot_at: server.snapshot_at,
        transport: tlsFor(connection, env).says,
      },
      repository: await repositoryState(root),
      settings: SETTINGS,
      tables: tables.map(({ name, schema, table, kind, columns }) => ({
        name,
        schema,
        table,
        kind,
        columns: columns.map(({ owned_sequence: sequence, ...column }) => (
          sequence ? { ...column, sequence: { name: sequence, last_value: sequences.get(sequence) } } : column
        )),
      })),
    };

    await backup.open();
    opened = true;
    await backup.write([headerLine(header)]);
    await onStart?.(header);

    const summary = [];
    for (const [index, table] of tables.entries()) {
      const digest = new RowDigest();
      await backup.write([tableLine(table.name)]);
      try {
        await streamRows(query, selectRowsSql(table, table.columns.map(({ name }) => name)), (texts) => {
          for (const text of texts) digest.add(text);
          return backup.write(texts.map(rowLine));
        });
      } catch (err) {
        throw pastRowSecurity(table, err);
      }
      const counted = digest.done();
      await backup.write([endLine(table.name, counted)]);
      summary.push({ name: table.name, ...counted });
      await onTable?.({ name: table.name, rows: counted.rows, index, count: tables.length });
    }

    const totalRows = summary.reduce((sum, { rows }) => sum + rows, 0);
    const trailer = {
      complete: true,
      finished_at: new Date().toISOString(),
      total_rows: totalRows,
      tables: Object.fromEntries(summary.map(({ name, rows, sha256 }) => [name, { rows, sha256 }])),
      content_sha256: backup.contentSum(),
    };
    await backup.write([trailerLine(trailer)]);
    const readBack = await backup.finish();
    return {
      file,
      encrypted: Boolean(passphrase),
      tables: summary,
      totalRows,
      header,
      readBack: { tables: readBack.tables.length, totalRows: readBack.totalRows },
    };
  } catch (err) {
    if (opened) await backup.abort();
    throw err;
  } finally {
    // Nothing to commit. The guard is not needed for this one statement, and
    // it must go out even when the guard itself was what failed.
    await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
  }
}

/** Size and SHA-256 of a file, to compare a copy with its original. */
export async function fingerprint(file) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of fs.createReadStream(file)) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { size, sha256: hash.digest('hex') };
}
