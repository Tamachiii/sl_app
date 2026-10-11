// The backup file: what is in it, and the one reader every tool uses.
//
// A backup is ONE file, `sl_app-<UTC time>.jsonl.gz` (+ `.enc` when it is
// encrypted, see envelope.mjs). Unpacked, it is text: UTF-8, one JSON object
// per line, each with exactly one key that says what the line is.
//
//   {"header":{…}}                 once, first: format version, when, from
//                                  which server, the repository commit and the
//                                  SHA-256 of supabase/schema.sql, and every
//                                  table with its columns
//   {"table":{"name":"public.x"}}  opens a table
//   {"row":{"id":"…","n":"20.00"}} one row of that table
//   {"end":{"name":…,"rows":N,"sha256":…}}  closes it
//   {"trailer":{…}}                once, last: rows and SHA-256 per table,
//                                  the total, and the SHA-256 of every byte
//                                  before this line
//
// A row is `row_to_json()` of the row with every column cast to text first,
// exactly as the server printed it. So a value is a JSON string holding the
// text form PostgreSQL itself gives the value ("20.00", "2026-10-03
// 18:04:05.123456+00", "{1,3}", "\\x00ff"), or JSON null for SQL NULL. Nothing
// is ever turned into a JavaScript number or date on the way, and loading a
// row back is the cast `text → column type` that pg_dump relies on too.
//
// Why not row_to_json() on the row as it is: it prints a jsonb column that
// holds the JSON value `null` and a column that is SQL NULL the same way
// (`"payload":null`), so the first would come back as the second — into a
// NOT NULL column, as an error. The text form keeps them apart ("null" / null).
//
// The SHA-256 of a table is taken over the text of each row followed by a line
// feed, in file order. Rows are sorted by that text (bytewise), so two dumps
// of the same data give the same sums, and a restore can be compared with the
// trailer by reading the table back the same way.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream';
import zlib from 'node:zlib';
import { BackupError } from './errors.mjs';
import { cannotDecrypt, decryptor, kindOf } from './envelope.mjs';

export const FORMAT = 'sl_app-backup';
export const VERSION = 1;

const LF = Buffer.from('\n');
const ROW_PREFIX = Buffer.from('{"row":');
// A line longer than this is not a row of this database: stop before the
// memory does.
const MAX_LINE_BYTES = 256 * 1024 * 1024;

// ------------------------------------------------------------
// Names
// ------------------------------------------------------------

/** Where a backup goes when nothing else is said: outside any checkout. */
export const defaultDirectory = () => path.join(os.homedir(), 'sl_app-backups');

const stamp = (date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');

/** `sl_app-20261011T181500Z.jsonl.gz` or `….jsonl.gz.enc`. */
export const fileName = (date, encrypted) => `sl_app-${stamp(date)}.jsonl.gz${encrypted ? '.enc' : ''}`;

const BACKUP_NAME = /^sl_app-\d{8}T\d{6}Z\.jsonl\.gz(?:\.enc)?$/;

/** The most recent backup file of a directory (by the time in its name), or null. */
export function newestBackup(directory) {
  let names;
  try {
    names = fs.readdirSync(directory);
  } catch {
    return null;
  }
  const last = names.filter((name) => BACKUP_NAME.test(name)).sort().at(-1);
  return last ? path.join(directory, last) : null;
}

// ------------------------------------------------------------
// Writing
// ------------------------------------------------------------

export const headerLine = (header) => JSON.stringify({ header });
export const tableLine = (name) => JSON.stringify({ table: { name } });
export const endLine = (name, { rows, sha256 }) => JSON.stringify({ end: { name, rows, sha256 } });
export const trailerLine = (trailer) => JSON.stringify({ trailer });

/** `text` is the JSON object the server printed for the row; it goes in as it is. */
export function rowLine(text) {
  if (typeof text !== 'string' || text[0] !== '{' || text.includes('\n')) {
    throw new BackupError('The server returned a row that is not one line of JSON; nothing was kept.');
  }
  return `{"row":${text}}`;
}

/** Rows and SHA-256 of one table, fed row by row. */
export class RowDigest {
  constructor() {
    this.hash = createHash('sha256');
    this.rows = 0;
  }

  /** `row` is the row's JSON text, as a string or as the bytes of the file. */
  add(row) {
    this.hash.update(row);
    this.hash.update(LF);
    this.rows += 1;
  }

  done() {
    return { rows: this.rows, sha256: this.hash.digest('hex') };
  }
}

// ------------------------------------------------------------
// Reading
// ------------------------------------------------------------

const damaged = (what) => new BackupError(`The backup is damaged or was altered: ${what}.`);

function checkHeader(header) {
  if (header?.format !== FORMAT) throw new BackupError('Not a backup of this app: the first line is not its header.');
  if (header.version !== VERSION) {
    throw new BackupError(
      `This backup has format version ${header.version}; these scripts read version ${VERSION}. `
      + 'Use the scripts of the commit the header names.',
    );
  }
  if (!Array.isArray(header.tables) || header.tables.length === 0) throw damaged('the header lists no table');
  for (const table of header.tables) {
    if (typeof table?.name !== 'string' || !Array.isArray(table.columns) || table.columns.length === 0) {
      throw damaged('the header describes a table without a name or without columns');
    }
  }
}

function sameKeys(row, columns) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return false;
  const keys = Object.keys(row);
  return keys.length === columns.length && keys.every((key, i) => key === columns[i].name);
}

/**
 * Read a backup file from the first byte to the last and check everything
 * that can be checked without a database, while handing out what it reads:
 *
 *   { type: 'header',  header }
 *   { type: 'table',   table }             table: the header's entry
 *   { type: 'row',     table, text }       text: the row's JSON, as written
 *   { type: 'end',     table, rows, sha256 }
 *   { type: 'trailer', trailer, tables, totalRows }   last; only when all of
 *                                                     the above held
 *
 * Throws a BackupError — and hands out no trailer — when the file is cut
 * short, altered, encrypted with another passphrase, or not a backup.
 */
export async function* readBackup(file, { passphrase = null } = {}) {
  let first;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      first = Buffer.alloc(16);
      first = first.subarray(0, fs.readSync(fd, first, 0, 16, 0));
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    throw new BackupError(`Cannot read ${file}: ${err.code ?? err.message}`);
  }
  const kind = kindOf(first);
  if (kind === 'unknown') {
    throw new BackupError(
      first.length === 0
        ? `${file} is empty.`
        : `${file} is not a backup: it is neither a gzip file nor an encrypted one.`,
    );
  }
  const encrypted = kind === 'encrypted';
  if (encrypted && !passphrase) {
    throw new BackupError('This backup is encrypted: set BACKUP_PASSPHRASE to the passphrase it was written with.');
  }

  const gunzip = zlib.createGunzip();
  const stages = encrypted
    ? [fs.createReadStream(file), decryptor(passphrase), gunzip]
    : [fs.createReadStream(file), gunzip];
  // An error in any stage destroys the last one with it, which is how the
  // loop below gets to see it.
  pipeline(stages, () => {});

  const content = createHash('sha256');
  const done = new Map();
  let header = null;
  let byName = null;
  let open = null;
  let trailer = null;
  let unpacked = 0;

  // One line of the file → at most one thing to hand out.
  const read = (line) => {
    if (trailer) throw damaged('there is content after the trailer');
    content.update(line);
    content.update(LF);

    if (line.length > ROW_PREFIX.length && line.subarray(0, ROW_PREFIX.length).equals(ROW_PREFIX)
        && line[line.length - 1] === 0x7d) {
      if (!open) throw damaged('a row stands outside any table');
      const bytes = line.subarray(ROW_PREFIX.length, line.length - 1);
      const text = bytes.toString('utf8');
      let row;
      try {
        row = JSON.parse(text);
      } catch {
        throw damaged(`a row of ${open.table.name} is not JSON`);
      }
      if (!sameKeys(row, open.table.columns)) {
        throw damaged(`a row of ${open.table.name} does not have the columns the header gives that table`);
      }
      open.digest.add(bytes);
      return { type: 'row', table: open.table, text };
    }

    let entry;
    try {
      entry = JSON.parse(line.toString('utf8'));
    } catch {
      throw damaged('a line is not JSON');
    }
    const [key, ...others] = Object.keys(entry ?? {});
    if (others.length > 0 || !['header', 'table', 'end'].includes(key)) {
      throw damaged('a line is neither a header, a table, a row, an end nor a trailer');
    }
    const value = entry[key];

    if (key === 'header') {
      if (header) throw damaged('there is a second header');
      checkHeader(value);
      header = value;
      byName = new Map(header.tables.map((table) => [table.name, table]));
      if (byName.size !== header.tables.length) throw damaged('the header lists a table twice');
      return { type: 'header', header };
    }
    if (!header) throw new BackupError('Not a backup of this app: the first line is not its header.');

    if (key === 'table') {
      if (open) throw damaged(`${value?.name} starts before ${open.table.name} has ended`);
      const table = byName.get(value?.name);
      if (!table) throw damaged(`it holds a table the header does not list (${value?.name})`);
      if (done.has(table.name)) throw damaged(`${table.name} is in it twice`);
      open = { table, digest: new RowDigest() };
      return { type: 'table', table };
    }

    // key === 'end'
    if (!open || open.table.name !== value?.name) throw damaged(`an end line closes a table that is not open (${value?.name})`);
    const counted = open.digest.done();
    if (counted.rows !== value.rows) {
      throw damaged(`${open.table.name} holds ${counted.rows} rows, and its end line says ${value.rows}`);
    }
    if (counted.sha256 !== value.sha256) throw damaged(`the rows of ${open.table.name} do not match their checksum`);
    done.set(open.table.name, counted);
    const { table } = open;
    open = null;
    return { type: 'end', table, ...counted };
  };

  // The trailer is the proof that the dump got to its end, and the second,
  // independent statement of what the file holds.
  const closeWith = (line) => {
    let value;
    try {
      value = JSON.parse(line.toString('utf8')).trailer;
    } catch {
      throw damaged('the trailer is not JSON');
    }
    if (value?.complete !== true || typeof value.tables !== 'object' || value.tables === null) {
      throw damaged('the trailer does not say the dump was complete');
    }
    for (const table of header.tables) {
      const counted = done.get(table.name);
      const said = value.tables[table.name];
      if (!counted) throw damaged(`${table.name} is in the header and not in the file`);
      if (!said || said.rows !== counted.rows || said.sha256 !== counted.sha256) {
        throw damaged(`the trailer and the rows of ${table.name} disagree`);
      }
    }
    if (Object.keys(value.tables).length !== header.tables.length) throw damaged('the trailer lists a table the header does not');
    const totalRows = [...done.values()].reduce((sum, { rows }) => sum + rows, 0);
    if (value.total_rows !== totalRows) throw damaged(`the trailer counts ${value.total_rows} rows and the file holds ${totalRows}`);
    return { value, totalRows };
  };

  const TRAILER_PREFIX = Buffer.from('{"trailer":');
  let rest = null;
  try {
    for await (const chunk of gunzip) {
      unpacked += chunk.length;
      const data = rest ? Buffer.concat([rest, chunk]) : chunk;
      let from = 0;
      for (let at = data.indexOf(0x0a, from); at !== -1; at = data.indexOf(0x0a, from)) {
        const line = data.subarray(from, at);
        from = at + 1;
        if (line.length > TRAILER_PREFIX.length && line.subarray(0, TRAILER_PREFIX.length).equals(TRAILER_PREFIX)) {
          if (trailer) throw damaged('there is content after the trailer');
          if (!header) throw new BackupError('Not a backup of this app: the first line is not its header.');
          if (open) throw damaged(`the trailer comes before ${open.table.name} has ended`);
          // Every byte before this line, which is why it is not hashed itself.
          const sum = content.copy().digest('hex');
          const { value, totalRows } = closeWith(line);
          if (value.content_sha256 !== sum) throw damaged('the content does not match the checksum of the trailer');
          trailer = { value, totalRows };
        } else {
          yield read(line);
        }
      }
      rest = from < data.length ? data.subarray(from) : null;
      if (rest && rest.length > MAX_LINE_BYTES) throw damaged('a line is longer than any row can be');
    }
  } catch (err) {
    if (err instanceof BackupError) throw err;
    // zlib: bad header, bad block, checksum mismatch, unexpected end of file.
    if (encrypted && unpacked === 0) throw cannotDecrypt();
    throw new BackupError(
      `The backup is damaged or cut short: ${err.code ?? 'read error'} (${err.message}).`,
    );
  } finally {
    // Also when the caller stops reading halfway: no open file is left behind.
    for (const stage of stages) stage.destroy();
  }
  if (rest) throw damaged('its last line is cut short');
  if (!header) throw new BackupError(`${file} holds no backup: it unpacks to nothing.`);
  if (!trailer) {
    throw new BackupError(
      'The backup is cut short: it has no trailer, so the dump that wrote it did not finish.',
    );
  }
  yield {
    type: 'trailer',
    trailer: trailer.value,
    tables: header.tables.map((table) => ({ name: table.name, ...done.get(table.name) })),
    totalRows: trailer.totalRows,
    encrypted,
  };
}
