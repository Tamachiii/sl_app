// Runs an Edge Function's index.ts under vitest, and puts it behind a real
// HTTP port.
//
// The functions are Deno programs: they read `Deno.env`, hand their handler to
// `Deno.serve`, and import from `jsr:` and `npm:`. None of that exists under
// Node. What a function decides is in ../_shared/, which needs none of it; this
// file is for the rest — the adapter itself, so that "the gate is the first
// thing index.ts runs" is a test and not a reading of the source:
//
//   const handler = await loadFunction('send-push', { env, modules });
//   const response = await handler(new Request(…));
//
// It also reads the repository the way a deploy does — which folders are
// functions, what supabase/config.toml says of each — for the tests that hold
// the two together (../deploy.test.js, ../runbook.test.js).
//
// Test-only. Nothing here is imported by a function, so nothing here is
// deployed; the folder starts with `_`, so neither the CLI nor the CI glob
// takes it for a function.

import { readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';

/** supabase/functions, absolute. */
export const FUNCTIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** The repository root, absolute. */
export const REPO_ROOT = resolve(FUNCTIONS_DIR, '../..');

/** A file of the repository as text; `file` is relative to the root. */
export const readRepoFile = (file) => readFileSync(resolve(REPO_ROOT, file), 'utf8');

/**
 * The functions of the repository, by name: a folder of supabase/functions
 * with an index.ts. `_shared` and `_test` hold modules, not functions.
 */
export function functionNames() {
  return readdirSync(FUNCTIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_') && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
}

/**
 * The `[functions.<name>]` tables of a config.toml, as
 * `{ name: { key: value } }`. `true` and `false` are read as booleans;
 * any other value stays the text the file has.
 */
export function functionTables(toml) {
  const out = {};
  let table = null;
  for (const raw of toml.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      const name = /^\[functions\.([A-Za-z0-9_-]+)\]$/.exec(line)?.[1];
      table = name ? (out[name] = {}) : null;
    } else if (table) {
      const [, key, value] = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line) ?? [];
      if (key) table[key] = value === 'true' ? true : value === 'false' ? false : value;
    }
  }
  return out;
}

/**
 * Imports `<name>/index.ts` afresh and returns the handler it passed to
 * `Deno.serve`.
 *
 *   env      what `Deno.env.get(name)` answers; a name that is not there is
 *            an unset secret
 *   modules  what each `jsr:` / `npm:` specifier of the file resolves to:
 *            `{ 'npm:web-push@3.6.7': { default: fake } }`. A specifier the
 *            file imports and this map does not give fails the import, which
 *            is the point: a test never loads the real client.
 *
 * The module is evaluated again on every call, so its top-level reads of the
 * environment see the `env` of that call.
 */
export async function loadFunction(name, { env = {}, modules = {} } = {}) {
  vi.resetModules();
  for (const [specifier, exports] of Object.entries(modules)) {
    vi.doMock(specifier, () => exports);
  }
  let handler = null;
  vi.stubGlobal('Deno', {
    env: { get: (key) => env[key] },
    // Deno.serve(handler) or Deno.serve(options, handler).
    serve: (...args) => { handler = args.find((arg) => typeof arg === 'function') ?? null; },
  });
  await import(/* @vite-ignore */ resolve(FUNCTIONS_DIR, name, 'index.ts'));
  if (!handler) throw new Error(`supabase/functions/${name}/index.ts did not call Deno.serve`);
  return handler;
}

/**
 * The part of a supabase-js client the functions use, over arrays:
 * `from(table).select().eq()`, `.update().eq()`, `.delete().eq()` — and
 * `rpc(name, args)`, answered by the function of that name in `rpc`.
 *
 *   const admin = fakeAdmin({ push_subscriptions: [row, …] }, {
 *     rpc: { claim_rest_push: ({ p_id }) => ({ data: { id: p_id, … } }) },
 *   });
 *   admin.calls   → in order: [{ table, op, column, value, values? }] for a
 *                   table, [{ rpc, args }] for a function
 *   admin.error   → set it to make every read fail with that message
 *
 * An update changes the rows it names, a delete removes them: a test reads
 * the arrays it gave. A function `rpc` does not have is answered the way
 * PostgREST answers one the database does not have.
 */
export function fakeAdmin(tables = {}, { rpc = {} } = {}) {
  const calls = [];
  const admin = {
    calls,
    error: null,
    from(table) {
      const rows = () => tables[table] ?? [];
      const record = (op, extra = {}) => (column, value) => {
        calls.push({ table, op, column, value, ...extra });
        if (op === 'select') {
          return Promise.resolve(admin.error
            ? { data: null, error: { message: admin.error } }
            : { data: rows().filter((row) => row[column] === value), error: null });
        }
        if (op === 'update') {
          for (const row of rows()) if (row[column] === value) Object.assign(row, extra.values);
        }
        if (op === 'delete') tables[table] = rows().filter((row) => row[column] !== value);
        return Promise.resolve({ data: null, error: null });
      };
      return {
        select: () => ({ eq: record('select') }),
        update: (values) => ({ eq: record('update', { values }) }),
        delete: () => ({ eq: record('delete') }),
      };
    },
    async rpc(name, args) {
      calls.push({ rpc: name, args });
      if (typeof rpc[name] !== 'function') {
        return { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${name} in the schema cache` } };
      }
      return { data: null, error: null, ...(await rpc[name](args)) };
    },
  };
  return admin;
}

/**
 * Serves a fetch-style handler — `(Request) => Response` — on a port of
 * 127.0.0.1, the way the Edge runtime serves a function. Resolves to
 * `{ origin, requests, close }`; `requests` lists what came in, as
 * `{ method, path, headers }`, for a test to read.
 */
export function listen(handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    requests.push({ method: req.method, path: req.url, headers: req.headers });
    try {
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      const request = new Request(`http://${req.headers.host}${req.url}`, {
        method: req.method,
        headers: Object.entries(req.headers).flatMap(([name, value]) => (
          [].concat(value).map((one) => [name, one])
        )),
        ...(hasBody ? { body: Readable.toWeb(req), duplex: 'half' } : {}),
      });
      const response = await handler(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`the stand-in failed: ${error?.stack ?? error}`);
    }
  });
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => done({
      origin: `http://127.0.0.1:${server.address().port}`,
      requests,
      close: () => new Promise((closed) => { server.close(closed); server.closeAllConnections(); }),
    }));
  });
}
