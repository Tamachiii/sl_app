// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Static guards over the CI definition itself. A workflow only runs after a
// push, so nothing local notices when a gate is loosened or dropped — the
// first sign would be a deploy that should have been refused. These read the
// YAML as text (no YAML dependency) and pin the properties the gate rests on.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(resolve(root, rel), 'utf8');

// The text of one job: from its `  <name>:` line to the next line indented
// like it. Comment lines are dropped so a commented-out step never counts.
function job(yaml, name) {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^ {0,2}\S/.test(l) && !/^\s*#/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).filter((l) => !/^\s*#/.test(l));
}

// The single-line `run:` commands of a job, in order.
function runs(jobLines) {
  return jobLines
    .map((l) => l.match(/^\s*(?:-\s+)?run:\s+(?![|>])(.+?)\s*$/))
    .filter(Boolean)
    .map((m) => m[1]);
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
