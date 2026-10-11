// Where the tools connect, read from the environment at run time.
//
// Nothing here opens a connection: it turns environment variables and a URL
// into the options `pg` takes, decides about TLS, and says whether a host is
// a Supabase project. Every secret it meets is registered for scrubbing
// (secrets.mjs) before anything can fail.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackupError, USAGE } from './errors.mjs';
import { registerSecret } from './secrets.mjs';

/** The checkout these scripts live in. */
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * A postgres:// URL as `{ host, port, database, user, password, params }`.
 * `label` names where the text came from; the text itself is never quoted in
 * an error.
 */
export function parsePostgresUrl(text, label) {
  const value = String(text ?? '').trim();
  registerSecret(value);
  let url = null;
  try {
    url = new URL(value);
  } catch { /* reported below, without the text */ }
  if (!url || !/^postgres(?:ql)?:$/.test(url.protocol) || !url.hostname) {
    throw new BackupError(
      `${label} is not a PostgreSQL connection URL. `
      + 'In a URL, a password that contains @ : / # ? % or a space must be percent-encoded.',
      { exitCode: USAGE },
    );
  }
  const decode = (part, what) => {
    try {
      return decodeURIComponent(part);
    } catch {
      throw new BackupError(`${label}: the ${what} is not valid percent-encoding.`, { exitCode: USAGE });
    }
  };
  const password = decode(url.password, 'password');
  registerSecret(password);
  registerSecret(url.password);
  return {
    // Without the brackets of an IPv6 address, and without the dot of the DNS
    // root (`db.<ref>.supabase.co.` is the same host): what decides whether a
    // host is a Supabase project looks at the end of this name.
    host: url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase(),
    port: url.port ? Number(url.port) : 5432,
    database: decode(url.pathname.replace(/^\//, ''), 'database name') || 'postgres',
    user: decode(url.username, 'user name'),
    password,
    params: Object.fromEntries(url.searchParams),
  };
}

/**
 * The database a dump reads, from the environment:
 *
 *   SUPABASE_DB_URL        the whole connection string, or
 *   SUPABASE_DB_PASSWORD   the database password, added to the password-less
 *                          session-pooler URL the Supabase CLI keeps in
 *                          supabase/.temp/pooler-url after `supabase link`.
 *
 * The pooler, not `db.<ref>.supabase.co`: on the free plan the direct host
 * answers over IPv6 only, which neither WSL nor a GitHub runner has.
 * SUPABASE_POOLER_URL_FILE names another file (the test suite does).
 */
export function resolveSource(env, { root = repoRoot } = {}) {
  registerSecret(env.SUPABASE_DB_PASSWORD);
  if (env.SUPABASE_DB_URL) {
    return { ...parsePostgresUrl(env.SUPABASE_DB_URL, 'SUPABASE_DB_URL'), from: 'SUPABASE_DB_URL' };
  }
  if (env.SUPABASE_DB_PASSWORD) {
    const file = env.SUPABASE_POOLER_URL_FILE || path.join(root, 'supabase/.temp/pooler-url');
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      throw new BackupError(
        `SUPABASE_DB_PASSWORD is set, but there is no ${path.relative(root, file) || file}: `
        + 'run `supabase link` once (it writes that file), or set SUPABASE_DB_URL to the '
        + 'session-pooler connection string of the project.',
        { exitCode: USAGE },
      );
    }
    const parsed = parsePostgresUrl(text, path.relative(root, file) || file);
    return { ...parsed, password: env.SUPABASE_DB_PASSWORD, from: 'SUPABASE_DB_PASSWORD + pooler-url' };
  }
  throw new BackupError(
    'No database to read: set SUPABASE_DB_PASSWORD (the database password; the address comes '
    + 'from supabase/.temp/pooler-url), or SUPABASE_DB_URL (the session-pooler connection string).',
    { exitCode: USAGE },
  );
}

/**
 * TLS for a connection, the way libpq names it:
 *
 *   sslmode=disable                  no TLS
 *   sslmode=verify-full / verify-ca  TLS, certificate checked
 *   sslrootcert=<file> in the URL,
 *   or PGSSLROOTCERT in the env      TLS, certificate checked against that CA
 *   anything else                    TLS without checking the certificate —
 *                                    except on a loopback address, where a
 *                                    local Postgres has no TLS at all
 *
 * The default does not check the certificate because Supabase signs its
 * database certificates with its own CA, which Node does not know: checking
 * needs the CA file of the project (Dashboard → Project Settings → Database →
 * SSL configuration). Without it the traffic is encrypted, and the server is
 * not authenticated. There is never a silent fall-back to clear text: when TLS
 * is asked for and the server has none, `pg` refuses to go on.
 */
export function tlsFor({ host, params = {} }, env = {}) {
  const mode = params.sslmode ?? null;
  const caFile = params.sslrootcert || env.PGSSLROOTCERT || null;
  if (mode === 'disable') return { ssl: false, says: 'no TLS (sslmode=disable)' };
  if (caFile) {
    let ca;
    try {
      ca = fs.readFileSync(caFile, 'utf8');
    } catch {
      throw new BackupError(`The CA file (sslrootcert / PGSSLROOTCERT) cannot be read: ${caFile}`, { exitCode: USAGE });
    }
    const ssl = { ca, rejectUnauthorized: true };
    if (mode === 'verify-ca') ssl.checkServerIdentity = () => undefined;
    return { ssl, says: 'TLS, certificate checked against the CA file' };
  }
  if (mode === 'verify-full') return { ssl: { rejectUnauthorized: true }, says: 'TLS, certificate checked' };
  if (mode === 'verify-ca') {
    return { ssl: { rejectUnauthorized: true, checkServerIdentity: () => undefined }, says: 'TLS, certificate checked' };
  }
  if (LOOPBACK.has(host) && mode !== 'require') return { ssl: false, says: 'no TLS (local address)' };
  return { ssl: { rejectUnauthorized: false }, says: 'TLS, certificate not checked (no CA file given)' };
}

/** The options `new pg.Client()` takes for a parsed connection. */
export function clientConfig(connection, env = {}) {
  const { ssl } = tlsFor(connection, env);
  return {
    host: connection.host,
    port: connection.port,
    database: connection.database,
    user: connection.user,
    password: connection.password,
    ssl,
    // Supavisor reads the tenant from the user name (`postgres.<ref>`) or from
    // this option; pass it on when a URL carries it.
    ...(connection.params?.options ? { options: connection.params.options } : {}),
    application_name: 'sl_app-backup',
    connectionTimeoutMillis: 20_000,
    // A network that drops the connection without a word must not leave the
    // tool waiting for ever: no single statement of a dump or a restore of
    // this database comes near ten minutes.
    keepAlive: true,
    query_timeout: 600_000,
  };
}

// ------------------------------------------------------------
// Is this a Supabase project? Is it THE project?
// ------------------------------------------------------------

/** `db.<ref>.supabase.co`, `aws-0-<region>.pooler.supabase.com`, … */
export const isSupabaseHost = (host) => /(?:^|\.)supabase\.(?:co|com|net|in|red)\.?$/i.test(String(host));

/**
 * The project refs this machine knows as production: the linked project
 * (supabase/.temp/project-ref, written by `supabase link`), SUPABASE_PROJECT_REF,
 * and the ones that can be read out of VITE_SUPABASE_URL, SUPABASE_DB_URL and
 * the pooler URL when those are in the environment.
 */
export function knownProjectRefs(env, { root = repoRoot } = {}) {
  const refs = new Set();
  const exact = (value) => {
    const text = String(value ?? '').trim();
    if (/^[a-z0-9]{20}$/.test(text)) refs.add(text);
  };
  const firstLabel = (host) => exact(String(host ?? '').split('.')[0]);
  const fromUrl = (text, label) => {
    if (!text) return;
    try {
      const parsed = parsePostgresUrl(text, label);
      exact(parsed.user.split('.').pop());
      if (isSupabaseHost(parsed.host)) firstLabel(parsed.host.replace(/^db\./, ''));
    } catch { /* not a URL: nothing to learn from it */ }
  };

  exact(env.SUPABASE_PROJECT_REF);
  try {
    exact(fs.readFileSync(path.join(root, 'supabase/.temp/project-ref'), 'utf8'));
  } catch { /* not linked */ }
  try {
    firstLabel(new URL(env.VITE_SUPABASE_URL).hostname);
  } catch { /* not set */ }
  fromUrl(env.SUPABASE_DB_URL, 'SUPABASE_DB_URL');
  try {
    fromUrl(fs.readFileSync(env.SUPABASE_POOLER_URL_FILE || path.join(root, 'supabase/.temp/pooler-url'), 'utf8'), 'pooler-url');
  } catch { /* not linked */ }
  return refs;
}

/** The known project ref a connection names — in its host, user or options — or null. */
export function projectRefOf(connection, refs) {
  const words = [connection.host, connection.user, connection.params?.options ?? '']
    .join(' ')
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  return words.find((word) => refs.has(word)) ?? null;
}
