import { defineConfig } from 'vitest/config';
import dbConfig from '../../../../vitest.db.config.js';

// NOT a suite, and not part of `npm run test:db`: src/test/dbSuiteExitCode.test.js
// runs vitest on this folder as a child process and reads its exit status.
//
// The configuration of the database suite, with two things replaced: the
// tests (one that fails, one that passes — `*.case.js`, a name neither suite
// collects) and the global setup, which loads what the real one loads and
// starts no server. What is left is the question the `db` job of CI depends
// on: does a failed test end this process with a status other than 0?
export default defineConfig({
  test: {
    ...dbConfig.test,
    name: 'db-exit-code',
    include: ['supabase/tests/fixtures/exit-code/*.case.js'],
    globalSetup: ['./supabase/tests/fixtures/exit-code/global-setup.js'],
  },
});
