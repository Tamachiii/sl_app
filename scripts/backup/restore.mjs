#!/usr/bin/env node
// Load a backup into a scratch database that already has the structure
// (supabase/schema.sql), and compare what is in it afterwards with the file.
//
//   node --env-file=.env scripts/backup/restore.mjs [file] --db-url <target>
//
// The tool of the restore drill — not a button for production. What it
// refuses, and why: lib/restore.mjs. The drill that needs no database of your
// own is scripts/backup/drill.mjs.

import {
  main, parse, passphraseFrom, pickBackup, printRestore, say,
} from './lib/cli.mjs';
import { knownProjectRefs, parsePostgresUrl, tlsFor } from './lib/connection.mjs';
import { BackupError, USAGE } from './lib/errors.mjs';
import { CONFIRM_PRODUCTION_REF, CONFIRM_SUPABASE_HOST, restoreBackup } from './lib/restore.mjs';

const usage = `Usage: node --env-file=.env scripts/backup/restore.mjs [file] --db-url <target>

Loads the backup (the most recent of ~/sl_app-backups when no file is named)
into <target>, in one transaction, then reads every table back and compares it
with the backup. The target must already have the tables: load
supabase/schema.sql into it first.

  --db-url <url>            the database to write to. Required, and never
                            taken from SUPABASE_DB_URL or SUPABASE_DB_PASSWORD.
  --replace-existing-rows   the target already holds rows: empty the tables of
                            the backup first
  --tolerate-platform-gaps  for auth.* and storage.* only: skip a table or a
                            column the target does not have, and say so
  --skip <schema.table>     leave a table of the backup out (may be repeated)
  --details                 when the target refuses a row, print the server's
                            message (it may quote the row)
  --${CONFIRM_SUPABASE_HOST}=<host>
                            the target is a Supabase project: repeat its host
  --${CONFIRM_PRODUCTION_REF}=<ref>
                            the target is the production project: repeat its ref

Environment
  BACKUP_PASSPHRASE   needed when the file is encrypted`;

await main(async () => {
  const parsed = parse({
    usage,
    positionals: 1,
    options: {
      'db-url': { type: 'string' },
      'replace-existing-rows': { type: 'boolean' },
      'tolerate-platform-gaps': { type: 'boolean' },
      skip: { type: 'string', multiple: true },
      details: { type: 'boolean' },
      [CONFIRM_SUPABASE_HOST]: { type: 'string' },
      [CONFIRM_PRODUCTION_REF]: { type: 'string' },
    },
  });
  if (!parsed) return;
  const { values, positionals } = parsed;
  const env = process.env;
  const passphrase = passphraseFrom(env);

  if (!values['db-url']) {
    throw new BackupError(
      'No target: --db-url <url> is required. It is never read from SUPABASE_DB_URL or '
      + 'SUPABASE_DB_PASSWORD — those name the database the backups come from.',
      { exitCode: USAGE },
    );
  }
  const target = parsePostgresUrl(values['db-url'], '--db-url');
  // The refs are read before anything else can fail, the refusal comes before
  // the file is even looked for: lib/restore.mjs checks again.
  const refs = knownProjectRefs(env);
  const file = pickBackup(positionals[0]);

  say('sl_app backup — restore');
  say(`  file       ${file}`);
  say(`  target     ${target.host}, database ${target.database}, ${tlsFor(target, env).says}`);

  const result = await restoreBackup({
    file,
    passphrase,
    target,
    env,
    refs,
    confirm: { supabaseHost: values[CONFIRM_SUPABASE_HOST], productionRef: values[CONFIRM_PRODUCTION_REF] },
    replaceExistingRows: Boolean(values['replace-existing-rows']),
    toleratePlatformGaps: Boolean(values['tolerate-platform-gaps']),
    skip: values.skip ?? [],
    details: Boolean(values.details),
  });

  printRestore(result);
  say('             committed.');
});
