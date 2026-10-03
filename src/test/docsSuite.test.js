// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import docsConfig from '../../vitest.docs.config.js';

// Three suites, three commands: `npm test` (this one, jsdom), `npm run
// test:db` (a real Postgres) and `npm run test:docs` (tests about the docs,
// kept under docs/). The docs suite is run by the integrator and by CI, never
// by a feature package — which only holds if `npm test` does not pick up a
// test under docs/ on its own, and if the docs command exists and is green
// while it is still empty. Nothing else would notice either going wrong.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(resolve(root, rel), 'utf8');

// The `exclude: [...]` of the `test:` block in vite.config.js, read as text:
// importing that file here would load the React, Tailwind and PWA plugins.
function unitSuiteExcludes() {
  const testBlock = read('vite.config.js').split(/^ {2}test: \{$/m)[1];
  const list = testBlock?.match(/^\s+exclude: \[([^\]]*)\],$/m)?.[1];
  return list ? [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]) : null;
}

describe('docs suite: `npm run test:docs`', () => {
  it('is a script, on its own config', () => {
    const { scripts } = JSON.parse(read('package.json'));
    expect(scripts['test:docs']).toBe('vitest run --config vitest.docs.config.js');
  });

  it('runs the tests under docs/ and nothing else', () => {
    const { include } = docsConfig.test;
    expect(include.length).toBeGreaterThan(0);
    expect(include.filter((pattern) => !pattern.startsWith('docs/'))).toEqual([]);
    expect(docsConfig.test.environment).toBe('node');
  });

  it('is green while it has no test', () => {
    // Without this vitest exits 1 on "no test files found", and the wave gate
    // would be red until the first docs test is written.
    expect(docsConfig.test.passWithNoTests).toBe(true);
  });
});

describe('unit suite: `npm test`', () => {
  const excludes = unitSuiteExcludes();

  it('has an exclude list this test can read', () => {
    expect(excludes).not.toBeNull();
    // The two that were there before, so a parser that matched the wrong
    // block does not pass by accident.
    expect(excludes).toEqual(expect.arrayContaining(['**/node_modules/**', '.claude/**']));
  });

  it('leaves docs/ to the docs suite', () => {
    expect(excludes).toContain('docs/**');
  });

  it('leaves supabase/tests/ to the database suite', () => {
    expect(excludes).toContain('supabase/tests/**');
  });
});
