// Check a backup file without a database: open it (decrypt, unpack), count
// the rows, recompute every checksum, and compare with what the dump wrote in
// the trailer. readBackup() does the checking; this walks it to the end.

import { readBackup } from './format.mjs';

/**
 * Resolves to `{ header, trailer, tables: [{ name, rows, sha256 }], totalRows,
 * encrypted }` when the file is whole. Throws a BackupError that says what is
 * wrong otherwise: a wrong passphrase, a file cut short, a changed byte, a
 * missing table.
 */
export async function verifyBackup({ file, passphrase = null }) {
  let header = null;
  let last = null;
  for await (const entry of readBackup(file, { passphrase })) {
    if (entry.type === 'header') header = entry.header;
    last = entry;
  }
  // readBackup() only ends without throwing after it handed out the trailer.
  const { trailer, tables, totalRows, encrypted } = last;
  return { header, trailer, tables, totalRows, encrypted };
}
