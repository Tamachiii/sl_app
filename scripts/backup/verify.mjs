#!/usr/bin/env node
// Check a backup file. No database, no network: it opens the file (decrypts,
// unpacks), counts the rows, recomputes every checksum and compares with the
// trailer the dump wrote.
//
//   node --env-file=.env scripts/backup/verify.mjs [file]
//
// Exit code 0: the file is whole and readable with this passphrase. Anything
// else — a wrong passphrase, a file cut short, one changed byte — is a
// non-zero exit code and a message that says which.

import {
  grouped, main, parse, passphraseFrom, pickBackup, printOrigin, printTables, say,
} from './lib/cli.mjs';
import { fingerprint } from './lib/dump.mjs';
import { verifyBackup } from './lib/verify.mjs';

const usage = `Usage: node --env-file=.env scripts/backup/verify.mjs [file]

Without a file: the most recent backup of ~/sl_app-backups. A directory: the
most recent backup in it.

Environment
  BACKUP_PASSPHRASE   needed when the file is encrypted (….jsonl.gz.enc)`;

await main(async () => {
  const parsed = parse({ usage, options: {}, positionals: 1 });
  if (!parsed) return;
  const passphrase = passphraseFrom(process.env);
  const file = pickBackup(parsed.positionals[0]);

  say('sl_app backup — verify');
  say(`  file       ${file}`);
  const checked = await verifyBackup({ file, passphrase });
  const { size, sha256 } = await fingerprint(file);
  say(`             ${grouped(size)} bytes, sha256 ${sha256}, ${checked.encrypted ? 'encrypted' : 'NOT encrypted'}`);
  printOrigin(checked.header);
  say();
  printTables(checked.tables, { total: checked.totalRows });
  say();
  say(`  OK         ${checked.tables.length} tables, ${grouped(checked.totalRows)} rows: the counts and checksums are those of the trailer.`);
});
