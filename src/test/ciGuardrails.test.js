// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
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
    // vacuously. These two are in the workflows today. (The backup job used
    // a third, supabase/setup-cli, until it stopped needing the CLI.)
    expect(thirdParty.map((u) => u.ref.split('@')[0]).sort()).toEqual(
      expect.arrayContaining([
        'denoland/setup-deno',
        'peaceiris/actions-gh-pages',
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

// The nightly backup (.github/workflows/backup.yml). The project is on the
// free plan: this job and the file the owner writes by hand are the only
// backups there are. Review finding P67: without its two secrets the job
// skipped every step and ended green, every night, for months.
describe('nightly backup: a night without a backup is a red run', () => {
  const yaml = read('.github/workflows/backup.yml');
  const dump = job(yaml, 'dump');
  const steps = runs(dump);

  // The body of a `run: |` block, by the name of its step.
  function script(name) {
    const lines = yaml.split('\n');
    const at = lines.findIndex((l) => l.trim() === `- name: ${name}`);
    if (at === -1) return null;
    const start = lines.findIndex((l, i) => i > at && /^\s+run: \|$/.test(l));
    const indent = lines[start + 1].match(/^\s*/)[0].length;
    const body = [];
    for (const line of lines.slice(start + 1)) {
      if (line.trim() !== '' && line.match(/^\s*/)[0].length < indent) break;
      body.push(line.slice(indent));
    }
    return body.join('\n');
  }
  const check = script('The two secrets are set');
  // The shell of a `run:` step on a GitHub runner. A secret that is not set
  // arrives as an empty variable.
  const runCheck = (env) => spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', check], {
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8',
  });

  it('fails, and names the secret that is missing', () => {
    expect(check).toBeTruthy();
    const none = runCheck({ SUPABASE_DB_URL: '', BACKUP_PASSPHRASE: '' });
    expect(none.status).toBe(1);
    expect(runCheck({}).status).toBe(1);
    expect(none.stdout).toMatch(/^::error title=No backup was taken::/);
    expect(none.stdout).toContain('SUPABASE_DB_URL');
    expect(none.stdout).toContain('BACKUP_PASSPHRASE');
    expect(none.stdout).toContain('BACKUPS.md');

    const one = runCheck({ SUPABASE_DB_URL: 'x' });
    expect(one.status).toBe(1);
    expect(one.stdout).toContain('not set: BACKUP_PASSPHRASE.');
    const other = runCheck({ SUPABASE_DB_URL: '', BACKUP_PASSPHRASE: 'x' });
    expect(other.status).toBe(1);
    expect(other.stdout).toContain('not set: SUPABASE_DB_URL.');

    const both = runCheck({ SUPABASE_DB_URL: 'x', BACKUP_PASSPHRASE: 'y' });
    expect(both.status).toBe(0);
    expect(both.stdout).toBe('');
  });

  it('has no step that can be skipped: every one runs, or the job is red', () => {
    expect(dump.filter((l) => /^\s+(?:-\s+)?if:/.test(l))).toEqual([]);
    expect(dump.filter((l) => /continue-on-error/.test(l))).toEqual([]);
    expect(yaml).not.toMatch(/GITHUB_OUTPUT/);
  });

  it('dumps with the repository script, checks the file, and only then uploads', () => {
    const at = (re) => dump.findIndex((l) => re.test(l));
    const order = [
      at(/- name: The two secrets are set/),
      at(/uses: actions\/checkout@/),
      at(/run: npm ci/),
      at(/run: node scripts\/backup\/dump\.mjs /),
      at(/run: node scripts\/backup\/verify\.mjs /),
      at(/uses: actions\/upload-artifact@/),
    ];
    expect(order.every((i) => i !== -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Not the Supabase CLI: `supabase db dump` needs Docker and always
    // switches to the role postgres.
    expect(yaml).not.toMatch(/supabase db dump|setup-cli/);
    expect(steps.find((s) => s.includes('dump.mjs'))).toContain('--require-rows');
  });

  // The repository is public: an artifact can be downloaded by anyone.
  it('never uploads a file in clear', () => {
    expect(yaml).not.toContain('--no-encrypt');
    const paths = dump.filter((l) => /^\s+path:/.test(l)).map((l) => l.trim());
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatch(/\*\.jsonl\.gz\.enc$/);
    expect(dump.join('\n')).toMatch(/^\s+if-no-files-found: error$/m);
    // Outside the checkout, where the script would refuse to write.
    expect(steps.find((s) => s.includes('dump.mjs'))).toContain('--out "$RUNNER_TEMP/');
  });

  it('keeps the database URL away from every step that does not connect', () => {
    // No job-wide environment: `npm ci` and the upload never see a secret.
    const header = dump.slice(0, dump.findIndex((l) => /^\s+steps:$/.test(l)));
    expect(header.join('\n')).not.toMatch(/secrets\./);
    expect(yaml.match(/secrets\.SUPABASE_DB_URL/g)).toHaveLength(2);
    expect(yaml.match(/secrets\.BACKUP_PASSPHRASE/g)).toHaveLength(3);
    expect(steps).toContain('npm ci --ignore-scripts');
    expect(yaml).toMatch(/^permissions:\n {2}contents: read$/m);
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
