// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

// docs/_pending holds what each package wants folded into the docs at the end
// of its wave (format: docs/_pending/README.md). The integrator finds a
// snippet by its package id and each block by its target document, so those
// two are the parts of the format a test holds; the wording is the author's.
describe('docs/_pending: one snippet file per package', () => {
  const PACKAGE_ID = '[a-z0-9]+(?:-[a-z0-9]+)*';
  const entries = readdirSync(resolve(root, 'docs/_pending')).sort();
  const snippets = entries.filter((name) => name !== 'README.md');
  const cases = snippets.map((name) => [name, read(`docs/_pending/${name}`).split('\n')]);

  // The lines that are not inside a fenced block: the text to fold may bring
  // a heading of its own, and it is quoted in a fence for that reason.
  function outsideFences(lines) {
    const out = [];
    let fence = null;
    for (const line of lines) {
      const mark = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
      if (mark && fence === null) fence = mark;
      else if (mark && mark[0] === fence[0] && mark.length >= fence.length) fence = null;
      else if (fence === null) out.push(line);
    }
    return out;
  }

  // The judgement of one file, so the same code is tried on text below.
  function problems(name, lines) {
    const id = name.replace(/\.md$/, '');
    if (!new RegExp(`^${PACKAGE_ID}\\.md$`).test(name)) return [`${name}: not named <package-id>.md`];
    const out = [];
    if (!/^# \S+ — docs to fold \(wave \d+, items:? .+\)$/.test(lines[0]) || lines[0].split(' ')[1] !== id) {
      out.push(`${name}: line 1 is not "# ${id} — docs to fold (wave N, items …)"`);
    }
    const blocks = outsideFences(lines).filter((line) => line.startsWith('## '));
    if (blocks.length === 0) out.push(`${name}: no "## <target doc> — <section>" block`);
    for (const heading of blocks) {
      const target = heading.slice(3).split(' — ')[0].split(' ')[0];
      if (!heading.includes(' — ') || !/^(?:[\w.-]+\/)*[\w.-]+\.md$/.test(target)) {
        out.push(`${name}: "${heading}" is not "## <target doc> — <section>"`);
      } else if (!target.startsWith('docs/runbook/') && target !== 'docs/RUNBOOK.md' && !existsSync(resolve(root, target))) {
        // The runbook is written during the waves; every other target exists.
        out.push(`${name}: "${heading}" names a document that does not exist`);
      }
    }
    return out;
  }

  it('keeps the README that gives the format', () => {
    expect(entries).toContain('README.md');
    expect(read('docs/_pending/README.md')).toContain('## <target doc> — <section>');
  });

  it('holds nothing but snippets in that format', () => {
    expect(cases.flatMap(([name, lines]) => problems(name, lines))).toEqual([]);
  });

  it('accepts a snippet as the README describes it', () => {
    const lines = [
      '# coach-review-flow — docs to fold (wave 1, items P57, L12)',
      '',
      'Each block: target doc, section, then the text to fold in.',
      '',
      '## docs/INVARIANTS.md — Coach session review',
      '',
      'Add after the bullet that starts "Review is one-shot":',
      '',
      '## docs/RUNBOOK.md — first-push checklist',
      '## docs/runbook/40-deploy.md — deploy order',
      '## CLAUDE.md — Commands',
    ];
    expect(problems('coach-review-flow.md', lines)).toEqual([]);
    expect(
      problems('w0-conventions.md', ['# w0-conventions — docs to fold (wave 0, items: none)', '## README.md — Tests']),
    ).toEqual([]);
  });

  it('lets the text to fold carry its own heading, inside a fence', () => {
    const title = '# coach-review-flow — docs to fold (wave 1, items P57)';
    const block = '## docs/ARCHITECTURE.md — new section "Review lifecycle", after "Routing"';
    const fenced = [title, block, '````markdown', '## Review lifecycle', '```sql', 'select 1;', '```', '````'];
    expect(problems('coach-review-flow.md', fenced)).toEqual([]);
    const bare = [title, block, '## Review lifecycle'];
    expect(problems('coach-review-flow.md', bare)).toEqual([
      'coach-review-flow.md: "## Review lifecycle" is not "## <target doc> — <section>"',
    ]);
  });

  it.each([
    ['notes.txt', ['# notes'], ['notes.txt: not named <package-id>.md']],
    ['Coach_Review.md', ['# x'], ['Coach_Review.md: not named <package-id>.md']],
    [
      'coach-review-flow.md',
      ['# Notes on the review flow', '## docs/INVARIANTS.md — Review'],
      ['coach-review-flow.md: line 1 is not "# coach-review-flow — docs to fold (wave N, items …)"'],
    ],
    [
      'coach-review-flow.md',
      ['# another-package — docs to fold (wave 1, items P57)', '## docs/INVARIANTS.md — Review'],
      ['coach-review-flow.md: line 1 is not "# coach-review-flow — docs to fold (wave N, items …)"'],
    ],
    [
      'coach-review-flow.md',
      ['# coach-review-flow — docs to fold (wave 1, items P57)', '', 'Document the lock.'],
      ['coach-review-flow.md: no "## <target doc> — <section>" block'],
    ],
    [
      'coach-review-flow.md',
      ['# coach-review-flow — docs to fold (wave 1, items P57)', '## Invariants', '## the lock — INVARIANTS.md'],
      [
        'coach-review-flow.md: "## Invariants" is not "## <target doc> — <section>"',
        'coach-review-flow.md: "## the lock — INVARIANTS.md" is not "## <target doc> — <section>"',
      ],
    ],
    [
      'coach-review-flow.md',
      ['# coach-review-flow — docs to fold (wave 1, items P57)', '## docs/INVARIANT.md — Review'],
      ['coach-review-flow.md: "## docs/INVARIANT.md — Review" names a document that does not exist'],
    ],
  ])('refuses %s (%#)', (name, lines, expected) => {
    expect(problems(name, lines)).toEqual(expected);
  });
});
