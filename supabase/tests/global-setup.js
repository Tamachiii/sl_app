// vitest globalSetup for the DB suite: one PostgreSQL cluster per run.
// Runs in the vitest main process, before any worker starts.

import { startPostgres } from './postgres.js';

export default async function setup(project) {
  const server = await startPostgres();
  // Read by harness.js through `inject('slDb')`.
  project.provide('slDb', server.connection);

  // Watch mode (`npx vitest --config vitest.db.config.js`): schema.sql is the
  // code under test, so a save rebuilds the template before the tests rerun
  // (vitest.db.config.js lists both .sql files in forceRerunTriggers). SQL that
  // does not load is reported by every test file instead of taking the
  // watcher down.
  project.onTestsRerun(async () => {
    try {
      await server.refresh();
      project.provide('slDb', server.connection);
    } catch (err) {
      project.provide('slDb', { ...server.connection, error: err.message });
    }
  });

  return async () => {
    await server.stop();
  };
}
