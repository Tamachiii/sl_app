// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// A gate that cannot go red is not a gate. `npm run test:db` is one job of the
// workflow every deploy waits for, and CI reads one thing from it: the exit
// status. For a while that status was 0 whatever the tests said — the server
// library the suite loads into the vitest main process (embedded-postgres)
// ends a process that runs out of work with process.exit(0), which is exactly
// how vitest ends, after setting process.exitCode. supabase/tests/postgres.js
// now keeps the code vitest chose.
//
// This test is in the UNIT suite on purpose: a test of the database suite
// that failed for this reason would not have turned anything red either.
//
// It runs the real vitest as a child process on supabase/tests/fixtures/
// exit-code/: the configuration of the database suite, with a global setup
// that loads what the real one loads and starts no PostgreSQL, and one test
// that fails. Without the lines in postgres.js that run ends with status 0.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURE = 'supabase/tests/fixtures/exit-code';
const read = (rel) => readFileSync(resolve(root, rel), 'utf8');

function runVitest(filter) {
  return new Promise((done, reject) => {
    const child = spawn(
      process.execPath,
      ['node_modules/vitest/vitest.mjs', 'run', '--config', `${FIXTURE}/vitest.config.js`, filter],
      // Not this run's environment: VITEST, NODE_ENV and the worker ids of the
      // suite that is running belong to it, not to the one that is started.
      { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, NO_COLOR: '1' } },
    );
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { out += chunk; });
    child.on('error', reject);
    child.on('close', (status, signal) => done({ status, signal, out }));
  });
}

describe('database suite: the exit status of `npm run test:db`', () => {
  let red;
  let green;

  beforeAll(async () => {
    // One after the other: two more vitest processes next to the unit suite
    // are enough.
    red = await runVitest('red.case');
    green = await runVitest('green.case');
  }, 120_000);

  it('is not 0 when a test failed', () => {
    // The run did happen, and did fail: a status of 1 for another reason (no
    // file found, a config that does not load) would prove nothing.
    expect(red.out).toMatch(/Tests\s+1 failed \(1\)/);
    expect(red.signal).toBeNull();
    expect(red.status).toBe(1);
  });

  it('is 0 when every test passed', () => {
    expect(green.out).toMatch(/Tests\s+1 passed \(1\)/);
    expect(green.signal).toBeNull();
    expect(green.status).toBe(0);
  });

  it('is asked of the process the gate really starts', () => {
    // The fixture stands for the database suite only as long as these hold:
    // the command (ciGuardrails.test.js holds that the `db` job runs it), the
    // global setup that command loads, and the file that loads the server
    // library — and keeps the exit code.
    expect(JSON.parse(read('package.json')).scripts['test:db'])
      .toBe('vitest run --config vitest.db.config.js');
    expect(read('vitest.db.config.js')).toContain("globalSetup: ['./supabase/tests/global-setup.js']");
    expect(read(`${FIXTURE}/vitest.config.js`)).toContain('...dbConfig.test,');
    expect(read(`${FIXTURE}/global-setup.js`)).toContain("import '../../global-setup.js';");
    expect(read('supabase/tests/global-setup.js')).toContain("from './postgres.js';");
    expect(read('supabase/tests/postgres.js')).toContain("from 'embedded-postgres';");
  });
});
