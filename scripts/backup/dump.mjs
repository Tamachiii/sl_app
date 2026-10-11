#!/usr/bin/env node
// Take a backup of the database: one file, outside the repository.
//
//   node --env-file=.env scripts/backup/dump.mjs
//
// Node and the `pg` package only — no Docker, no Supabase CLI, no pg_dump.
// It reads; it cannot write (lib/snapshot.mjs). What the file holds and how to
// open it without these scripts: lib/format.mjs, lib/envelope.mjs, BACKUPS.md.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  grouped, main, parse, passphraseFrom, say, warn,
} from './lib/cli.mjs';
import { repoRoot, resolveSource, tlsFor } from './lib/connection.mjs';
import { dumpDatabase, fingerprint } from './lib/dump.mjs';
import { OPENSSL_DECRYPT } from './lib/envelope.mjs';
import { BackupError, USAGE } from './lib/errors.mjs';
import { defaultDirectory, fileName } from './lib/format.mjs';

const usage = `Usage: node --env-file=.env scripts/backup/dump.mjs [options]

Writes ~/sl_app-backups/sl_app-<UTC time>.jsonl.gz.enc: every table of the
schemas public and app_private, the accounts (auth.users, auth.identities) and
the storage metadata, read in one read-only transaction.

Environment
  SUPABASE_DB_PASSWORD   the database password; the address is read from
                         supabase/.temp/pooler-url (written by \`supabase link\`)
  SUPABASE_DB_URL        or: the whole session-pooler connection string
  BACKUP_PASSPHRASE      encrypts the file (at least 20 characters)
  PGSSLROOTCERT          optional: the CA file of the project, to check the
                         server's certificate

Options
  --out <path>      another directory, or another file name; never inside the
                    repository
  --no-encrypt      write the file in clear. It holds e-mail addresses and
                    password hashes. Refused on a CI runner.
  --require-rows    fail when there is no account or no profile in the dump
  -h, --help        this text`;

// A passphrase is the only thing between a public workflow artifact and the
// accounts. PBKDF2 slows a guess down; it does not make a short one long.
const SHORTEST_PASSPHRASE = 20;

const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

/** The file to write, with its directory created (0700) when it is new. */
async function target(out, encrypted) {
  const name = fileName(new Date(), encrypted);
  let file;
  if (!out) file = path.join(defaultDirectory(), name);
  else if (out.endsWith(path.sep) || (fs.existsSync(out) && fs.statSync(out).isDirectory())) file = path.join(path.resolve(out), name);
  else file = path.resolve(out);

  const directory = path.dirname(file);
  // Checked before the directory is created, and again on what it resolves to:
  // the repository is public, and a dump in the working tree is one
  // `git add -A` away from being published.
  const refuse = () => {
    throw new BackupError(
      `${file} is inside the repository (${repoRoot}). A backup holds every athlete's data: `
      + 'it is never written into the checkout.',
      { exitCode: USAGE },
    );
  };
  if (inside(repoRoot, file)) refuse();
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  if (inside(fs.realpathSync(repoRoot), path.join(fs.realpathSync(directory), path.basename(file)))) refuse();
  if ((fs.statSync(directory).mode & 0o077) !== 0) {
    warn(`note: other users of this machine can open ${directory} (chmod 700 would close it).`);
  }
  return file;
}

await main(async () => {
  const parsed = parse({
    usage,
    options: {
      out: { type: 'string' },
      'no-encrypt': { type: 'boolean' },
      'require-rows': { type: 'boolean' },
    },
  });
  if (!parsed) return;
  const { values } = parsed;
  const env = process.env;

  const clear = Boolean(values['no-encrypt']);
  // Read (and hidden from every line printed) even when it is not used.
  const given = passphraseFrom(env);
  const passphrase = clear ? null : given;
  if (clear && (env.CI || env.GITHUB_ACTIONS)) {
    throw new BackupError(
      '--no-encrypt on a CI runner: refused. An artifact of a public repository can be downloaded by anyone.',
      { exitCode: USAGE },
    );
  }
  if (!clear && !passphrase) {
    throw new BackupError(
      'BACKUP_PASSPHRASE is not set, so the file cannot be encrypted. Set it (for example to the output of '
      + '`openssl rand -base64 32`, kept in your password manager), or pass --no-encrypt to write the file '
      + 'in clear — it holds every athlete\'s data, the e-mail addresses and the password hashes.',
      { exitCode: USAGE },
    );
  }
  // A secret pasted with the line break behind it would still encrypt — and
  // the file would not open with the passphrase as it was written down.
  if (passphrase && passphrase !== passphrase.trim()) {
    throw new BackupError(
      'BACKUP_PASSPHRASE starts or ends with a space or a line break. Set it again without, '
      + 'so that it is the same string everywhere it is kept.',
      { exitCode: USAGE },
    );
  }
  if (passphrase && passphrase.length < SHORTEST_PASSPHRASE) {
    throw new BackupError(
      `BACKUP_PASSPHRASE is shorter than ${SHORTEST_PASSPHRASE} characters. Use a long random one: \`openssl rand -base64 32\`.`,
      { exitCode: USAGE },
    );
  }

  const connection = resolveSource(env);
  const file = await target(values.out, Boolean(passphrase));

  say('sl_app backup — dump');
  // The user, not only the host: through the pooler it is `postgres.<ref>`,
  // the one thing here that says WHICH project is being read.
  say(`  source     ${connection.user} at ${connection.host} (${connection.from}), ${tlsFor(connection, env).says}`);
  say('  reading    one read-only transaction, repeatable read');
  say();

  // Ctrl-C must not leave half a file behind under any name — nor a whole one
  // that has not been read back: until dumpDatabase() returns, the file is
  // `.partial`.
  const partial = `${file}.partial`;
  const interrupted = () => {
    fs.rmSync(partial, { force: true });
    warn('\nInterrupted: nothing was written.');
    process.exit(130);
  };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);

  // A line per table as it is done: over a slow link this is the progress.
  let width = 5;
  const line = (name, rows) => say(`  ${name.padEnd(width)}  ${grouped(rows).padStart(9)}`);
  const result = await dumpDatabase({
    connection,
    file,
    passphrase,
    env,
    onStart: ({ source, tables }) => {
      say(`  server     PostgreSQL ${source.server_version}, database ${source.database}, role ${source.role}`);
      say(`  snapshot   ${source.snapshot_at}`);
      say();
      width = Math.max(width, ...tables.map(({ name }) => name.length));
      say(`  ${'table'.padEnd(width)}  ${'rows'.padStart(9)}`);
    },
    onTable: ({ name, rows }) => line(name, rows),
  });
  process.off('SIGINT', interrupted);
  process.off('SIGTERM', interrupted);
  line('total', result.totalRows);
  say();

  const empty = ['auth.users', 'public.profiles'].filter((name) => result.tables.find((table) => table.name === name)?.rows === 0);
  if (empty.length > 0) {
    const message = `${empty.join(' and ')} ${empty.length > 1 ? 'are' : 'is'} empty: this is not the database with the athletes in it.`;
    if (values['require-rows']) {
      await fsp.rm(file, { force: true });
      throw new BackupError(`${message} Nothing was kept.`);
    }
    warn(`WARNING: ${message}`);
  }

  const { size, sha256 } = await fingerprint(file);
  say(`  written    ${file}`);
  say(`             ${grouped(size)} bytes, sha256 ${sha256}`);
  // From the disk, before the file got its name (lib/dump.mjs).
  say(`  read back  ${result.readBack.tables} tables, ${grouped(result.readBack.totalRows)} rows, every checksum matches`);
  if (result.encrypted) {
    say('  encrypted  with BACKUP_PASSPHRASE. Without that passphrase this file is noise: keep it');
    say('             where it survives this machine. To open the file without these scripts:');
    say(`             ${OPENSSL_DECRYPT} -in <file> | gunzip`);
  } else {
    warn('');
    warn('  NOT ENCRYPTED. This file holds every athlete\'s data in clear, with the e-mail');
    warn('  addresses and the password hashes of all accounts. Do not copy it to a shared');
    warn('  or synchronised folder, and never into the repository.');
  }
});
