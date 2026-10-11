// What the four commands share: reading the command line and the
// environment, printing, and ending with the right exit code.
//
// Everything printed goes through scrub() (secrets.mjs). An error ends the
// command with a message and a non-zero exit code, never with a stack that
// nobody asked for (BACKUP_DEBUG=1 prints it).

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { parsePostgresUrl } from './connection.mjs';
import { BackupError, USAGE } from './errors.mjs';
import { defaultDirectory, newestBackup } from './format.mjs';
import { registerSecret, scrub } from './secrets.mjs';

export const say = (line = '') => process.stdout.write(`${scrub(line)}\n`);
export const warn = (line = '') => process.stderr.write(`${scrub(line)}\n`);

/** What went wrong, in one or two lines, for errors nobody raised on purpose. */
function describe(err) {
  // Node reports "could not connect on any address" as an AggregateError with
  // an empty message.
  const message = err?.message || err?.errors?.map((one) => one.message).join('; ') || String(err);
  const hints = {
    '28P01': 'The database refused the password. SUPABASE_DB_PASSWORD (or the password inside the URL) is not the database password of this project. In .env, a value needs single quotes around it: without them a # cuts it short.',
    '28000': 'The database refused the login for this user.',
    '3D000': 'There is no database of that name on the server.',
    ENOTFOUND: 'The host name does not resolve: check the address, and the network.',
    ECONNREFUSED: 'Nothing answers at that address and port.',
    ETIMEDOUT: 'The server did not answer in time.',
    ENETUNREACH: 'No route to that address. A direct `db.<ref>.supabase.co` host is IPv6-only on the free plan: use the session pooler.',
    SELF_SIGNED_CERT_IN_CHAIN: 'The certificate is signed by a CA this machine does not know: give the CA file (PGSSLROOTCERT) of the project.',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'The server presents a self-signed certificate: give its CA file (PGSSLROOTCERT).',
  };
  const hint = hints[err?.code] ?? (/timeout expired/i.test(message) ? hints.ETIMEDOUT : null);
  return [message + (err?.code ? ` (${err.code})` : ''), hint].filter(Boolean).join('\n  ');
}

function fail(err) {
  const message = err instanceof BackupError ? err.message : describe(err);
  warn(`\nFAILED: ${message}`);
  if (process.env.BACKUP_DEBUG === '1' && err?.stack) warn(err.stack);
  // On GitHub, the first line again as an annotation of the run.
  if (process.env.GITHUB_ACTIONS === 'true') say(`::error title=Backup::${scrub(message).split('\n')[0]}`);
  process.exitCode = Number.isInteger(err?.exitCode) && err.exitCode !== 0 ? err.exitCode : 1;
}

// Before a command does anything: whatever in its environment or on its
// command line is a secret is one from the first line it prints — also the
// variables this command does not use (verify and drill are run with the same
// env file as the dump), and a URL typed where a file name was expected.
function hideSecrets() {
  for (const name of ['SUPABASE_DB_PASSWORD', 'SUPABASE_DB_URL', 'BACKUP_PASSPHRASE']) registerSecret(process.env[name]);
  const urls = [process.env.SUPABASE_DB_URL, ...process.argv.slice(2)]
    .filter((text) => /postgres(?:ql)?:\/\//i.test(text ?? ''))
    .map((text) => text.slice(text.search(/postgres(?:ql)?:\/\//i)));
  for (const url of urls) {
    try {
      parsePostgresUrl(url, 'argument');
    } catch { /* not a URL after all; the text itself is registered */ }
  }
}

/** Run a command; whatever it throws ends the process with a scrubbed message. */
export async function main(run) {
  hideSecrets();
  // Nothing is in a known state after one of these: say it and stop.
  const crash = (err) => {
    fail(err);
    process.exit(process.exitCode);
  };
  process.on('uncaughtException', crash);
  process.on('unhandledRejection', crash);
  try {
    await run();
  } catch (err) {
    fail(err);
  }
}

/**
 * End the process now, with the exit code that was set, once everything
 * printed is out. Only for a command that loaded something which would
 * otherwise decide the exit code itself (drill.mjs).
 */
export function exitNow() {
  const code = process.exitCode ?? 0;
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
}

/** parseArgs with the usage text as the answer to a mistake, and to --help. */
export function parse({ usage, options, positionals = 0 }) {
  let parsed;
  try {
    parsed = parseArgs({
      options: { help: { type: 'boolean', short: 'h' }, ...options },
      allowPositionals: positionals > 0,
      strict: true,
    });
  } catch (err) {
    throw new BackupError(`${err.message}\n\n${usage}`, { exitCode: USAGE });
  }
  if (parsed.values.help) {
    say(usage);
    return null;
  }
  if (parsed.positionals.length > positionals) {
    throw new BackupError(`Too many arguments.\n\n${usage}`, { exitCode: USAGE });
  }
  return parsed;
}

/** BACKUP_PASSPHRASE, or null. Registered as a secret before anything else happens. */
export function passphraseFrom(env) {
  const value = env.BACKUP_PASSPHRASE;
  if (!value) return null;
  registerSecret(value);
  return value;
}

/** The backup a command works on: the one named, or the newest of ~/sl_app-backups. */
export function pickBackup(named) {
  if (named) {
    const file = path.resolve(named);
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
      const newest = newestBackup(file);
      if (!newest) throw new BackupError(`No backup file in ${file}.`, { exitCode: USAGE });
      return newest;
    }
    return file;
  }
  const newest = newestBackup(defaultDirectory());
  if (!newest) {
    throw new BackupError(
      `No backup file in ${defaultDirectory()}. Name the file, or take a backup first (scripts/backup/dump.mjs).`,
      { exitCode: USAGE },
    );
  }
  return newest;
}

const grouped = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** One aligned line per table, then the total. `lines`: [{ name, rows, note }]. */
export function printTables(lines, { total = null } = {}) {
  const width = Math.max(5, ...lines.map(({ name }) => name.length));
  const digits = Math.max(4, ...lines.map(({ rows }) => grouped(rows).length), grouped(total ?? 0).length);
  say(`  ${'table'.padEnd(width)}  ${'rows'.padStart(digits)}`);
  for (const { name, rows, note } of lines) {
    say(`  ${name.padEnd(width)}  ${grouped(rows).padStart(digits)}${note ? `  ${note}` : ''}`);
  }
  if (total !== null) say(`  ${'total'.padEnd(width)}  ${grouped(total).padStart(digits)}`);
}

/** What a header says about where and when a backup was taken. */
export function printOrigin(header) {
  const { source, repository } = header;
  say(`  taken      ${header.created_at} (snapshot ${source.snapshot_at})`);
  say(`  from       ${source.user} at ${source.host}, database ${source.database}, role ${source.role}, PostgreSQL ${source.server_version}`);
  say(`  checkout   commit ${repository.commit ?? 'unknown'}, supabase/schema.sql sha256 ${repository.schema_sql_sha256 ?? 'unknown'}`);
}

const RESTORE_NOTE = {
  load: (table) => (table.compared === 'checksum' ? 'identical' : `row count only — ${table.notes.join('; ')}`),
  skip: (table) => `NOT LOADED — ${table.notes.join('; ')}`,
  ledger: () => 'not loaded: it describes the structure, see below',
};

/** What a restore did, table by table, and what the two ledgers say. */
export function printRestore(result) {
  printOrigin(result.header);
  say();
  printTables(
    result.tables.map((table) => ({ ...table, note: RESTORE_NOTE[table.action](table) })),
    { total: result.totalRows },
  );
  say();
  for (const { sequence, value } of result.sequences) say(`  sequence   ${sequence} set to ${value}`);

  const list = (names) => (names === null ? 'no ledger' : names.length === 0 ? 'none' : names.join(', '));
  say('  migrations on record');
  say(`    in the backup   ${list(result.ledger.backup)}`);
  say(`    in the target   ${list(result.ledger.target)}`);
  const ahead = (result.ledger.backup ?? []).filter((name) => !(result.ledger.target ?? []).includes(name));
  if (ahead.length > 0) {
    warn(`  WARNING: the backup comes from a database that had ${ahead.join(', ')}; the target does not.`);
  }
  say();

  const loaded = result.tables.filter((table) => table.action === 'load');
  const identical = loaded.filter((table) => table.compared === 'checksum').length;
  say(
    `  RESTORED   ${loaded.length} tables, ${grouped(result.totalRows)} rows. ${identical} read back identical to the backup`
    + (identical < loaded.length ? `, ${loaded.length - identical} compared by row count only.` : '.'),
  );
  const skipped = result.tables.filter((table) => table.action === 'skip');
  if (skipped.length > 0) warn(`  NOT LOADED: ${skipped.map((table) => table.name).join(', ')}.`);
}

// `describeError`: what a connection that fails means is the same for every
// command that reads production — scripts/check-migrations.mjs is one more.
export { describe as describeError, grouped };
