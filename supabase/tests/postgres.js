// Boots the throwaway PostgreSQL the DB suite runs against and builds the
// template database every test file is cloned from.
//
// Server side only: imported by global-setup.js (the vitest main process),
// never by a test. Tests import harness.js.
//
//   initdb → postgres (npm binaries, PG 17.6 like production)
//     → CREATE DATABASE sl_template
//     → shim.sql      as supabase_admin (bootstrap superuser)
//     → schema.sql    as postgres       (non-superuser owner, like Supabase)
//
// No Docker, no system Postgres, no psql: `embedded-postgres` ships the server
// binaries as an npm optional dependency for the host platform.

import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const TEMPLATE_DB = 'sl_template';
export const SHIM_SQL = path.join(here, 'shim.sql');
export const SCHEMA_SQL = path.join(here, '..', 'schema.sql');

const HOST = '127.0.0.1';
const SUPERUSER = 'supabase_admin';
const SUPERUSER_PASSWORD = 'postgres';
// Created by shim.sql. Everything a test does goes through this role.
const OWNER = 'postgres';
const OWNER_PASSWORD = 'postgres';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, HOST, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Run a whole .sql file as one multi-statement simple query (one implicit
 * transaction, exactly like pasting it in the Supabase SQL editor). On failure
 * the error is rewritten to point at the offending line of the file.
 */
async function runSqlFile(client, file) {
  const sql = await fs.readFile(file, 'utf8');
  try {
    await client.query(sql);
  } catch (err) {
    const rel = path.relative(process.cwd(), file);
    const offset = Number(err.position);
    const line = Number.isFinite(offset) && offset > 0
      ? sql.slice(0, offset - 1).split('\n').length
      : null;
    const detail = [err.detail, err.hint, err.where].filter(Boolean).join('\n  ');
    const wrapped = new Error(
      `${rel}${line ? `:${line}` : ''}: ${err.message}${detail ? `\n  ${detail}` : ''}`,
    );
    wrapped.code = err.code;
    wrapped.cause = err;
    wrapped.sqlFile = rel;
    throw wrapped;
  }
}

async function withClient(config, fn) {
  const client = new pg.Client({ host: HOST, ...config });
  // A connection cut while the cluster goes down must not crash the run.
  client.on('error', () => {});
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Identity of the SQL the template is built from — watch mode compares it. */
async function fingerprint() {
  const stats = await Promise.all([SHIM_SQL, SCHEMA_SQL].map((file) => fs.stat(file)));
  return stats.map((stat) => `${stat.size}:${stat.mtimeMs}`).join('|');
}

/** initdb → postgres → template database. Resolves to `{ stop, built }`. */
async function bootCluster(port, log) {
  // The data directory itself, so that the library's own exit hook (Ctrl-C,
  // SIGTERM) removes all of it.
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sl-app-pg-'));
  const built = await fingerprint();
  const tail = [];
  const onLog = (chunk) => {
    const text = String(chunk);
    if (log) process.stderr.write(text);
    tail.push(text);
    if (tail.length > 200) tail.shift();
  };

  const server = new EmbeddedPostgres({
    databaseDir: dataDir,
    port,
    user: SUPERUSER,
    password: SUPERUSER_PASSWORD,
    persistent: false,
    // The library hard-codes --lc-messages=en_US.UTF-8, a locale that minimal
    // machines (WSL, slim CI images) do not have; the later flag wins.
    initdbFlags: ['--encoding=UTF8', '--locale=C', '--lc-messages=C', '--no-sync'],
    postgresFlags: [
      // Durability is worthless for a cluster that is deleted on exit.
      '-c', 'fsync=off',
      '-c', 'synchronous_commit=off',
      '-c', 'full_page_writes=off',
      // Loopback TCP only: no socket file in /tmp, nothing reachable off-host.
      '-c', `listen_addresses=${HOST}`,
      '-c', 'unix_socket_directories=',
      // Supabase runs in UTC; pin it so date maths does not follow the laptop.
      '-c', 'timezone=UTC',
      '-c', 'log_timezone=UTC',
      '-c', 'max_connections=60',
      // As on Supabase: the realtime publication needs it to mean anything.
      '-c', 'wal_level=logical',
    ],
    onLog,
    onError: onLog,
  });

  // Last line of defence when the run is interrupted (Ctrl-C in watch mode,
  // SIGTERM): the async teardown may not get to finish, an `exit` listener
  // always runs. Immediate shutdown is fine for a cluster nobody keeps.
  const onExit = () => {
    try { server.process?.kill('SIGQUIT'); } catch { /* already gone */ }
    try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
  };
  process.once('exit', onExit);

  const stop = async () => {
    await server.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
    process.off('exit', onExit);
  };

  try {
    await server.initialise();
    await server.start();

    const superuser = { user: SUPERUSER, password: SUPERUSER_PASSWORD, port };
    await withClient({ ...superuser, database: 'postgres' }, (c) =>
      c.query(`CREATE DATABASE ${TEMPLATE_DB}`));
    await withClient({ ...superuser, database: TEMPLATE_DB }, (c) => runSqlFile(c, SHIM_SQL));
    await withClient(
      { user: OWNER, password: OWNER_PASSWORD, port, database: TEMPLATE_DB },
      (c) => runSqlFile(c, SCHEMA_SQL),
    );
  } catch (err) {
    await stop().catch(() => {});
    // A .sql file that does not load is the developer's error: say which line.
    if (err?.sqlFile) throw err;
    const reason = err instanceof Error ? err : new Error(
      `PostgreSQL failed to start: ${err ?? 'the server process exited'}`,
    );
    reason.message += `\n--- last server output ---\n${tail.join('').trim()}`;
    throw reason;
  }

  return { stop, built };
}

/**
 * Start a private cluster and build the template database.
 *
 * Resolves to `{ connection, refresh, stop }`:
 *   connection  what harness.js receives through vitest's provide/inject
 *   refresh()   watch mode — rebuild the cluster if shim.sql or schema.sql
 *               changed since the last build; resolves to true when it did
 *   stop()      shut the server down and delete its data directory
 */
export async function startPostgres({ log = process.env.DB_TEST_LOG === '1' } = {}) {
  const port = await freePort();
  let cluster = await bootCluster(port, log);

  return {
    connection: {
      host: HOST,
      port,
      user: OWNER,
      password: OWNER_PASSWORD,
      template: TEMPLATE_DB,
    },
    async refresh() {
      if (cluster && cluster.built === await fingerprint()) return false;
      // Same port, new data directory: the connection handed to the workers
      // stays valid, and a build that fails leaves no half-loaded template.
      const previous = cluster;
      cluster = null;
      await previous?.stop();
      cluster = await bootCluster(port, log);
      return true;
    },
    async stop() {
      const current = cluster;
      cluster = null;
      await current?.stop();
    },
  };
}
