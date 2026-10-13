import { configDefaults, defineConfig } from 'vitest/config';

// The DATABASE suite (`npm run test:db`): supabase/schema.sql loaded into a
// real PostgreSQL 17 and exercised as anon / a signed-in user / the coach.
// Deliberately separate from vite.config.js — no jsdom, no React, no PWA
// plugin — and the default `npm test` excludes supabase/tests/**.
export default defineConfig({
  test: {
    name: 'db',
    environment: 'node',
    include: ['supabase/tests/**/*.test.js'],
    // Boots Postgres from the npm binaries once per run and builds the
    // template database (shim.sql + schema.sql) every test file is cloned from.
    globalSetup: ['./supabase/tests/global-setup.js'],
    // Watch mode: the SQL is not in the module graph, so name it. A save
    // reruns every file, after global-setup.js has rebuilt the template
    // (schema.sql, shim.sql). The migrations, their audits and rollbacks, the
    // manifest, the frozen baseline and the stub of pg_cron are read by the
    // tests themselves.
    forceRerunTriggers: [
      ...configDefaults.forceRerunTriggers,
      '**/supabase/schema.sql',
      '**/supabase/tests/shim.sql',
      '**/supabase/tests/shim-pg-cron.sql',
      '**/supabase/tests/fixtures/**',
      '**/supabase/migrations/**',
      '**/supabase/audits/**',
      '**/supabase/rollbacks/**',
    ],
    // One worker process, test files one after the other. Each file gets its
    // own database, so this is about a quiet 2-core CI runner, not isolation.
    pool: 'forks',
    fileParallelism: false,
    // harness.js keeps "the database of this file" in module state.
    isolate: true,
    // First boot on a cold CI runner (initdb + schema load) is the slow part.
    hookTimeout: 120_000,
    testTimeout: 30_000,
    teardownTimeout: 30_000,
  },
});
