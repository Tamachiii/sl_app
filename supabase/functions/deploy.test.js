// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { REPO_ROOT, functionNames, functionTables, readRepoFile as read } from './_test/harness.js';

// The Edge Functions are deployed by hand, by the owner. Nothing in the
// repository can see what is deployed; what can be held here is what a deploy
// starts from:
//
//   - supabase/config.toml: whether Supabase's gateway asks for a user JWT in
//     front of each function. Deployed the wrong way round, send-push answers
//     the database 401 from then on and no push of the app is sent — with no
//     error anywhere, because the triggers never read the answer — and
//     dispatch-rest-push answers its own hops 401, so that a rest longer than
//     a minute no longer rings;
//   - the files the CLI uploads for a function, which it finds by following
//     the imports of index.ts.
//
// The page the owner follows, and the check it gives for after a deploy, are
// held by runbook.test.js.

const root = REPO_ROOT;
const CONFIG = 'supabase/config.toml';
const functions = functionNames();

// `supabase functions deploy --use-api` uploads a function file by file: it
// reads the entry point, takes whatever this expression matches for an import
// (the expression of CLI 2.109, as it is), uploads the relative ones and reads
// those in turn. It does not parse the code: a quoted word after "import" or
// "export" in a comment is an import to it, and a file it cannot find, or a
// module it never sees, is a function that does not start.
const CLI_IMPORT = /(?:import|export)\s+(?:type\s+)?(?:{[^{}]+}|.*?)\s*(?:from)?\s*['"](.*?)['"]|import\(\s*['"](.*?)['"]\)/gi;
const REMOTE = /^(?:jsr|npm|node|https):/;

// The files the CLI would upload for an entry point, and what it would
// stumble on: { files, problems }.
function upload(entry) {
  const files = [];
  const problems = [];
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.shift();
    if (files.includes(file)) continue;
    if (!existsSync(resolve(root, file))) {
      problems.push(`${file}: imported, and not there`);
      continue;
    }
    files.push(file);
    for (const [, staticImport, dynamicImport] of read(file).matchAll(CLI_IMPORT)) {
      const specifier = staticImport ?? dynamicImport;
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        if (!/\.(?:js|ts|json)$/.test(specifier)) problems.push(`${file}: '${specifier}' has no extension`);
        pending.push(join(dirname(file), specifier));
      } else if (!REMOTE.test(specifier)) {
        problems.push(`${file}: the CLI would take '${specifier}' for an import`);
      }
    }
  }
  return { files, problems };
}

describe(`${CONFIG}: the flag of every function is committed`, () => {
  const flags = existsSync(resolve(root, CONFIG)) ? functionTables(read(CONFIG)) : {};

  it('reads a config.toml the way the next tests need', () => {
    expect(functionTables([
      '# verify_jwt = false   in a comment',
      'project_id = "sl_app"',
      '',
      '[functions.send-push]',
      'verify_jwt = false  # the database calls it',
      '[functions.dispatch-rest-push]',
      'verify_jwt=true',
      'import_map = "./deno.json"',
      '[auth]',
      'verify_jwt = false',
    ].join('\n'))).toEqual({
      'send-push': { verify_jwt: false },
      'dispatch-rest-push': { verify_jwt: true, import_map: '"./deno.json"' },
    });
    expect(functionTables('[functions.send-push]\nverify_jwt = "false"')).toEqual({ 'send-push': { verify_jwt: '"false"' } });
  });

  it('gives each function a table, and no table to a function that does not exist', () => {
    expect(functions.length).toBeGreaterThan(1);
    expect(Object.keys(flags).sort(), `${CONFIG} and the folders of supabase/functions disagree`).toEqual(functions);
  });

  // Left out, the CLI falls back to its default (`true`), which is the silent
  // failure this file exists to prevent. Written out, a reader sees a decision.
  it('writes verify_jwt out for each one, as a boolean', () => {
    for (const name of functions) {
      expect(flags[name]?.verify_jwt, `[functions.${name}] verify_jwt`).toBeTypeOf('boolean');
    }
  });

  // Each of the two is called by the project itself, which has no user JWT
  // to show: send-push by the database, dispatch-rest-push by its own hops —
  // a rest is waited for a minute at a time, and each minute after the first
  // is a request the function makes to its own address. `true` in front of
  // either is the gateway answering 401 where the function should have run.
  it('keeps the gateway\'s check off for both: each is also called by the project itself, without a user JWT', () => {
    expect(flags).toEqual({
      'send-push': { verify_jwt: false },
      'dispatch-rest-push': { verify_jwt: false },
    });
  });

  // With the gateway's check off, the function's own check is the only one:
  // it is made of the shared, tested comparisons — taken by the adapter, or by
  // the shared module the adapter hands the request to — and the adapter
  // compares nothing itself. That the check comes first, and that nothing
  // runs for a caller it refuses, is held by each function's index.test.js.
  it('has every function the gateway does not guard take its check from _shared/auth.js', () => {
    const unguarded = functions.filter((name) => flags[name]?.verify_jwt === false);
    expect(unguarded).toEqual(expect.arrayContaining(['send-push', 'dispatch-rest-push']));
    for (const name of unguarded) {
      const entry = `supabase/functions/${name}/index.ts`;
      expect(upload(entry).files, entry).toContain('supabase/functions/_shared/auth.js');
      const source = read(entry);
      expect(source, entry).not.toMatch(/[!=]==?\s*`?Bearer\b/);
      expect(source, entry).not.toMatch(/[!=]==?\s*INTERNAL_BEARER\b|\bINTERNAL_BEARER\s*[!=]==?/);
      expect(existsSync(resolve(root, `supabase/functions/${name}/index.test.js`)), `${name}/index.test.js`).toBe(true);
    }
  });

  it('would catch a check written in the adapter', () => {
    const own = /[!=]==?\s*`?Bearer\b/;
    // send-push as it was deployed before wave 1.
    expect('if (auth !== `Bearer ${INTERNAL_BEARER}`) {').toMatch(own);
    expect("if (req.headers.get('x-internal-bearer') === INTERNAL_BEARER) {").toMatch(/[!=]==?\s*INTERNAL_BEARER\b/);
  });
});

// What `upload` (at the top of the file) finds, function by function.
describe('what a deploy uploads', () => {
  it('reads imports the way this test needs', () => {
    const found = (source) => [...source.matchAll(CLI_IMPORT)].map(([, a, b]) => a ?? b);
    expect(found("import { a,\n  b } from '../_shared/auth.js';\nimport webpush from 'npm:web-push@3.6.7';")).toEqual([
      '../_shared/auth.js', 'npm:web-push@3.6.7',
    ]);
    expect(found('const m = await import("./lazy.js");\nexport { x } from "./x.js";')).toEqual(['./lazy.js', './x.js']);
    // What it gets wrong, and why a shared module is checked too.
    expect(found("// never import 'left-pad' here")).toEqual(['left-pad']);
    expect(found('// imports below are replaced\nexport const LIMIT = 8;')).toEqual([]);
  });

  it('finds every file of every function by following its imports, and nothing that is not one', () => {
    for (const name of functions) {
      expect(upload(`supabase/functions/${name}/index.ts`).problems, name).toEqual([]);
    }
  });

  // In the order the CLI finds them: the two modules index.ts names, then
  // the one push.js names. A module of _shared that is missing from the list
  // is a function that does not start.
  it('takes the gate, the fan-out and the list of push services along with send-push, and no test file', () => {
    expect(upload('supabase/functions/send-push/index.ts').files).toEqual([
      'supabase/functions/send-push/index.ts',
      'supabase/functions/_shared/auth.js',
      'supabase/functions/_shared/push.js',
      'supabase/functions/_shared/pushHosts.js',
    ]);
    const all = functions.flatMap((name) => upload(`supabase/functions/${name}/index.ts`).files);
    expect(all.filter((file) => /\.test\.|\/_test\//.test(file))).toEqual([]);
  });

  // index.ts names one module, which names the gate and the sender, which
  // names the list of push services.
  it('takes the hops, the gate, the sender and the list of push services along with dispatch-rest-push', () => {
    expect(upload('supabase/functions/dispatch-rest-push/index.ts').files).toEqual([
      'supabase/functions/dispatch-rest-push/index.ts',
      'supabase/functions/_shared/restPush.js',
      'supabase/functions/_shared/auth.js',
      'supabase/functions/_shared/push.js',
      'supabase/functions/_shared/pushHosts.js',
    ]);
  });
});
