// Encryption of a backup file, in the format of the `openssl enc` command:
//
//   openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 -salt -pass env:BACKUP_PASSPHRASE
//
// so that a backup can be opened without these scripts, on any machine that
// has OpenSSL 1.1.1 or later (or LibreSSL 3):
//
//   openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 \
//     -pass env:BACKUP_PASSPHRASE -in <file>.jsonl.gz.enc | gunzip
//
// The file is the 8 bytes `Salted__`, 8 bytes of salt, then the ciphertext
// with PKCS#7 padding. Key and IV are the first 32 and the next 16 bytes of
// PBKDF2-HMAC-SHA256(passphrase, salt, 200000 rounds).
//
// CBC carries no authentication tag. What notices a damaged or altered file
// is what is inside: the gzip checksum, and the row counts and SHA-256 sums of
// the trailer (format.mjs). A wrong passphrase is noticed at the padding, or
// at the first bytes of the gzip stream.

import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { Transform } from 'node:stream';
import { BackupError } from './errors.mjs';

export const MAGIC = Buffer.from('Salted__', 'ascii');
export const KDF_ROUNDS = 200_000;
const HEADER_BYTES = MAGIC.length + 8;

/** The shell command that opens an encrypted backup without these scripts. */
export const OPENSSL_DECRYPT = `openssl enc -d -aes-256-cbc -pbkdf2 -iter ${KDF_ROUNDS} -md sha256 -pass env:BACKUP_PASSPHRASE`;

function keyAndIv(passphrase, salt) {
  const bytes = pbkdf2Sync(Buffer.from(passphrase, 'utf8'), salt, KDF_ROUNDS, 48, 'sha256');
  return { key: bytes.subarray(0, 32), iv: bytes.subarray(32, 48) };
}

/** A stream that encrypts what is written to it. */
export function encryptor(passphrase) {
  const salt = randomBytes(8);
  const { key, iv } = keyAndIv(passphrase, salt);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  let started = false;
  const start = (stream) => {
    if (!started) stream.push(Buffer.concat([MAGIC, salt]));
    started = true;
  };
  return new Transform({
    transform(chunk, _encoding, done) {
      start(this);
      done(null, cipher.update(chunk));
    },
    flush(done) {
      start(this);
      done(null, cipher.final());
    },
  });
}

/** The error for everything a wrong passphrase and a damaged file have in common. */
export const cannotDecrypt = () => new BackupError(
  'The file cannot be decrypted: BACKUP_PASSPHRASE is not the passphrase it was written with, '
  + 'or the file is damaged or cut short.',
);

/** A stream that decrypts an `openssl enc` file written to it. */
export function decryptor(passphrase) {
  let head = Buffer.alloc(0);
  let decipher = null;
  return new Transform({
    transform(chunk, _encoding, done) {
      try {
        let data = chunk;
        if (!decipher) {
          head = Buffer.concat([head, chunk]);
          if (head.length < HEADER_BYTES) return done();
          if (!head.subarray(0, MAGIC.length).equals(MAGIC)) {
            return done(new BackupError('Not an encrypted backup: the file does not start with "Salted__".'));
          }
          const { key, iv } = keyAndIv(passphrase, head.subarray(MAGIC.length, HEADER_BYTES));
          decipher = createDecipheriv('aes-256-cbc', key, iv);
          data = head.subarray(HEADER_BYTES);
          head = null;
        }
        return done(null, decipher.update(data));
      } catch {
        return done(cannotDecrypt());
      }
    },
    flush(done) {
      if (!decipher) return done(new BackupError('The file is cut short: it ends inside its first 16 bytes.'));
      try {
        return done(null, decipher.final());
      } catch {
        // Wrong key (the padding is garbage) or a length that is not a
        // multiple of the block size.
        return done(cannotDecrypt());
      }
    },
  });
}

/** Does this file start like an `openssl enc` file, a gzip file, or neither? */
export function kindOf(firstBytes) {
  if (firstBytes.length >= MAGIC.length && firstBytes.subarray(0, MAGIC.length).equals(MAGIC)) return 'encrypted';
  if (firstBytes.length >= 2 && firstBytes[0] === 0x1f && firstBytes[1] === 0x8b) return 'gzip';
  return 'unknown';
}
