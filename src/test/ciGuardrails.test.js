// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Static guards over the CI definition itself. A workflow only runs after a
// push, so nothing local notices when a gate is loosened or dropped — the
// first sign would be a deploy that should have been refused. These read the
// YAML as text (no YAML dependency) and pin the properties the gate rests on.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(resolve(root, rel), 'utf8');

const WORKFLOWS = readdirSync(resolve(root, '.github/workflows'))
  .filter((f) => /\.ya?ml$/.test(f))
  .sort();

const isComment = (line) => /^\s*#/.test(line);

// The text of one job: from its `  <name>:` line to the next line indented
// like it. Comment lines are dropped so a commented-out step never counts.
function job(yaml, name) {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^ {0,2}\S/.test(l) && !isComment(l));
  return (end === -1 ? rest : rest.slice(0, end)).filter((l) => !isComment(l));
}

// The single-line `run:` commands of a job, in order.
function runs(jobLines) {
  return jobLines
    .map((l) => l.match(/^\s*(?:-\s+)?run:\s+(?![|>])(.+?)\s*$/))
    .filter(Boolean)
    .map((m) => m[1]);
}

// Every `uses:` of a workflow: the reference and the trailing comment, if any.
function uses(yaml) {
  return yaml
    .split('\n')
    .filter((l) => !isComment(l))
    .map((l) => l.match(/^\s*(?:-\s+)?uses:\s+(\S+)(?:\s+#\s*(.+?))?\s*$/))
    .filter(Boolean)
    .map((m) => ({ ref: m[1], comment: m[2] ?? null }));
}

describe('CI gate: what ships has no high advisory', () => {
  const steps = runs(job(read('.github/workflows/test.yml'), 'test'));

  it('audits the runtime dependencies, after the install', () => {
    const audit = steps.indexOf('npm audit --omit=dev --audit-level=high');
    expect(audit).toBeGreaterThan(-1);
    expect(steps.indexOf('npm ci')).toBeGreaterThan(-1);
    expect(audit).toBeGreaterThan(steps.indexOf('npm ci'));
  });

  it('is the gate the deploy waits on', () => {
    const deployYml = read('.github/workflows/deploy.yml');
    expect(job(deployYml, 'test').join('\n')).toMatch(/^\s+uses: \.\/\.github\/workflows\/test\.yml$/m);
    expect(job(deployYml, 'deploy').join('\n')).toMatch(/^\s+needs: test$/m);
  });
});

describe('CI gate: lint warnings have a ceiling', () => {
  // The count on the day the ceiling went in (2026-10-03). It is a ratchet:
  // lowering the number in package.json is progress, raising it is not —
  // fix the new warning, or disable it inline with the reason, instead.
  const CEILING = 26;

  it('fails on one warning more than the count on record', () => {
    const { scripts } = JSON.parse(read('package.json'));
    const m = scripts.lint.match(/^eslint src --max-warnings[= ](\d+)$/);
    expect(m, `lint script is "${scripts.lint}"`).not.toBeNull();
    expect(Number(m[1])).toBeLessThanOrEqual(CEILING);
  });

  it('is what CI runs, not a bare eslint that would skip the ceiling', () => {
    const steps = runs(job(read('.github/workflows/test.yml'), 'test'));
    expect(steps).toContain('npm run lint');
    expect(steps.filter((s) => /\beslint\b/.test(s))).toEqual([]);
  });
});

describe('workflows: third-party actions are pinned to a commit', () => {
  // GitHub's own organisations: the same party that runs the job and builds
  // the runner image, so a major tag adds no one to the trust list. Anything
  // else is third-party code running with this repository's token or
  // secrets, and a tag or branch can be re-pointed at other code overnight.
  const FIRST_PARTY = new Set(['actions', 'github']);
  const PINNED = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/;

  const all = WORKFLOWS.flatMap((file) =>
    uses(read(`.github/workflows/${file}`)).map((u) => ({ file, ...u })),
  );
  const thirdParty = all.filter(
    ({ ref }) => !ref.startsWith('./') && !FIRST_PARTY.has(ref.split('/')[0]),
  );

  it('sees the actions it is meant to judge', () => {
    // If the parser ever matched nothing, every check below would pass
    // vacuously. These three are in the workflows today.
    expect(thirdParty.map((u) => u.ref.split('@')[0]).sort()).toEqual(
      expect.arrayContaining([
        'denoland/setup-deno',
        'peaceiris/actions-gh-pages',
        'supabase/setup-cli',
      ]),
    );
  });

  const cases = thirdParty.map((u) => [`${u.file}: ${u.ref}`, u]);

  it.each(cases)('%s is a full commit SHA', (_title, { ref }) => {
    expect(ref).toMatch(PINNED);
  });

  it.each(cases)('%s says which release that commit is', (_title, { comment }) => {
    // A bare SHA cannot be reviewed or updated by a human.
    expect(comment).toMatch(/^v\d+\.\d+\.\d+$/);
  });

  it('pins every other action to at least a version', () => {
    const floating = all.filter(({ ref }) => !ref.startsWith('./') && !/@\S+$/.test(ref));
    expect(floating).toEqual([]);
  });
});

describe('CI: Edge Functions are type-checked', () => {
  const fn = job(read('.github/workflows/test.yml'), 'functions');

  it('runs deno check over the function entry points', () => {
    expect(fn).not.toBeNull();
    expect(runs(fn)).toContain('deno check supabase/functions/*/index.ts');
  });

  it('keeps the app package.json out of it', () => {
    // With the Vite app's package.json adopted as Deno's manifest, the check
    // stops at `npm:web-push` ("not in node_modules") and type-checks nothing.
    expect(fn.join('\n')).toMatch(/^\s+DENO_NO_PACKAGE_JSON: '1'$/m);
  });

  it('covers every function: each one has the index.ts the glob looks for', () => {
    // `_shared` and friends hold modules, not functions.
    const dirs = readdirSync(resolve(root, 'supabase/functions'), { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.'))
      .map((d) => d.name);
    expect(dirs.length).toBeGreaterThan(0);
    const missing = dirs.filter((d) => !existsSync(resolve(root, 'supabase/functions', d, 'index.ts')));
    expect(missing).toEqual([]);
  });
});
