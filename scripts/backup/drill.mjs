#!/usr/bin/env node
// The restore drill, on this machine and with nothing to set up:
//
//   node --env-file=.env scripts/backup/drill.mjs [file]
//
// It starts the throw-away PostgreSQL of the database suite (the server
// binaries come from npm: `embedded-postgres`, production's version), builds a
// database from supabase/tests/shim.sql + supabase/schema.sql of THIS
// checkout, loads the backup into it with scripts/backup/restore.mjs's own
// code, compares every table with the backup, and deletes the whole server.
//
// What a green drill proves: the file opens with this passphrase, every row
// of every table of schema `public` fits the structure and the constraints of
// supabase/schema.sql, and reads back exactly as it was written.
//
// What it cannot prove: the scratch server is PostgreSQL with stand-ins for
// Supabase (supabase/tests/shim.sql). Its auth.users has a part of the real
// columns and it has no auth.identities, so those are loaded as far as they
// fit, or skipped, and the report says which. Restoring accounts into a real
// Supabase project has not been tried by anyone yet (BACKUPS.md).
//
// The rows are on this machine's disk, in clear, for the seconds the drill
// runs: the server's data directory is in the temp folder and is removed at
// the end, also on Ctrl-C.

import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import {
  exitNow, grouped, main, parse, passphraseFrom, pickBackup, printRestore, say, warn,
} from './lib/cli.mjs';
import { repoRoot } from './lib/connection.mjs';
import { BackupError } from './lib/errors.mjs';
import { restoreBackup } from './lib/restore.mjs';
import { verifyBackup } from './lib/verify.mjs';

const usage = `Usage: node --env-file=.env scripts/backup/drill.mjs [file]

Restores the backup (the most recent of ~/sl_app-backups when no file is
named) into a throw-away PostgreSQL built from supabase/schema.sql, compares
it with the backup, and removes the server again. Touches no other database.

Environment
  BACKUP_PASSPHRASE   needed when the file is encrypted`;

const DATABASE = 'sl_restore_drill';

await main(async () => {
  const parsed = parse({ usage, options: {}, positionals: 1 });
  if (!parsed) return;
  const passphrase = passphraseFrom(process.env);
  const file = pickBackup(parsed.positionals[0]);

  say('sl_app backup — restore drill');
  say(`  file       ${file}`);
  // Before a server is started for it.
  const checked = await verifyBackup({ file, passphrase });
  say(`             ${checked.tables.length} tables, ${grouped(checked.totalRows)} rows, checksums match`);

  const schemaSum = createHash('sha256')
    .update(await fsp.readFile(path.join(repoRoot, 'supabase/schema.sql')))
    .digest('hex');
  const taken = checked.header.repository.schema_sql_sha256;
  if (taken && taken !== schemaSum) {
    warn('  note: supabase/schema.sql of this checkout is not the one the backup was taken next to');
    warn(`        (commit ${checked.header.repository.commit ?? 'unknown'}). The drill uses this checkout's.`);
  }

  say('  target     a throw-away PostgreSQL: supabase/tests/shim.sql + supabase/schema.sql');
  // The server of the database suite. Its binaries are a dev dependency.
  let startPostgres;
  try {
    ({ startPostgres } = await import('../../supabase/tests/postgres.js'));
  } catch (err) {
    throw new BackupError(`The drill needs the dev dependencies of the repository (run \`npm ci\`): ${err.message}`);
  }
  const server = await startPostgres({ log: false });
  try {
    const { host, port, user, password, template } = server.connection;
    const admin = new pg.Client({ host, port, user, password, database: 'postgres' });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${DATABASE} TEMPLATE ${template} OWNER ${user}`);
    } finally {
      await admin.end();
    }
    const result = await restoreBackup({
      file,
      passphrase,
      // sslmode=disable: the server was started a moment ago, on the loopback
      // address, and has no TLS. Said here because the drill is run with the
      // env file of the dump: a PGSSLROOTCERT in it — the CA of the project —
      // would otherwise ask this server for TLS too.
      target: { host, port, user, password, database: DATABASE, params: { sslmode: 'disable' } },
      // The database is the drill's own. A row it holds before the load was
      // put there by supabase/schema.sql (a migration that seeds a table),
      // and the rows of the backup take its place.
      replaceExistingRows: true,
      toleratePlatformGaps: true,
    });
    printRestore(result);
    const app = result.tables.filter((table) => table.name.startsWith('public.'));
    const identical = app.filter((table) => table.compared === 'checksum').length;
    say();
    say(`  DRILL OK   ${identical} of ${app.length} tables of schema public fit supabase/schema.sql and read back identical`
      + (identical < app.length ? `; ${app.length - identical} could only be compared by row count (see above).` : '.'));
    say('             The scratch server has been removed.');
  } finally {
    await server.stop();
  }
});

// The server library (embedded-postgres, through async-exit-hook) ends a
// process that runs out of work with exit code 0, whatever was set: a drill
// that FAILED would look green to a script or a CI job. Say the code out loud.
exitNow();
