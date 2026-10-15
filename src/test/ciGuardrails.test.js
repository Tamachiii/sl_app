// @vitest-environment node
import { afterAll, describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { OVERRIDE, PAGE, SECRET } from '../../scripts/lib/ledger-gate.mjs';
import { ASSETS_DIR, PAGE as SITE_PAGE } from '../../scripts/lib/published-builds.mjs';
import { MIN_BUILD_ENV, VERSION_FILE } from '../lib/buildInfo.js';

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

// The jobs a job waits for, from its one-line `needs: a` or `needs: [a, b]`.
function needsOf(jobLines) {
  const line = jobLines.map((l) => l.match(/^ {4}needs:\s+(.+?)\s*$/)).find(Boolean);
  if (!line) return [];
  return line[1].replace(/^\[|\]$/g, '').split(',').map((name) => name.trim()).filter(Boolean);
}

// The body of a `run: |` block of a workflow, by the name of its step.
function scriptOf(yaml, name) {
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
    expect(needsOf(job(deployYml, 'deploy'))).toContain('test');
  });
});

// The deploy gate on the database (review finding P69). The app of a commit
// needs the migrations written with it, and those reach production by hand: a
// push to main used to publish the client whether or not its SQL was there.
// The `migrations` job of deploy.yml asks production's ledger first. What the
// script decides is held in scripts/check-migrations.test.mjs and, against a
// real PostgreSQL, in supabase/tests/deploy-gate.test.js; what is held here
// is that the workflow cannot go around it.
describe('deploy: the database first, the app second', () => {
  const yaml = read('.github/workflows/deploy.yml');
  const gate = job(yaml, 'migrations');
  const deploy = job(yaml, 'deploy');
  const COMMAND = 'node scripts/check-migrations.mjs --verify';

  it('asks the ledger of production with the repository script, after the tests and before the publish', () => {
    expect(gate).not.toBeNull();
    expect(needsOf(gate)).toEqual(['test']);
    // Both by name: `needs` does not reach through a job that was removed.
    expect(needsOf(deploy).sort()).toEqual(['migrations', 'test']);
    // The whole step: nothing behind the command that could swallow its exit
    // code (`|| true`, `; echo done`).
    expect(runs(gate).filter((step) => step.includes('check-migrations'))).toEqual([COMMAND]);
    expect(existsSync(resolve(root, 'scripts/check-migrations.mjs'))).toBe(true);
    // One publish in the workflow, and it is in the job that waits.
    const publishes = (lines) => lines.filter((l) => /uses: peaceiris\/actions-gh-pages@/.test(l)).length;
    expect(publishes(yaml.split('\n').filter((l) => !isComment(l)))).toBe(1);
    expect(publishes(deploy)).toBe(1);
  });

  it('is the only way a workflow publishes', () => {
    // A second workflow that pushed to gh-pages — the action again, or the
    // emergency `npm run deploy` — would be a door beside the gate.
    const PUBLISHES = /actions-gh-pages|\bgh-pages\b|\bnpm run deploy\b/;
    const live = (file) => read(`.github/workflows/${file}`).split('\n').filter((l) => !isComment(l));
    expect(WORKFLOWS).toContain('deploy.yml');
    for (const file of WORKFLOWS.filter((name) => name !== 'deploy.yml')) {
      expect(live(file).filter((l) => PUBLISHES.test(l)), `${file} publishes`).toEqual([]);
    }
    // In deploy.yml itself the branch is named by the job that waits, and by
    // no other.
    expect(live('deploy.yml').filter((l) => PUBLISHES.test(l))).toEqual(deploy.filter((l) => PUBLISHES.test(l)));
    // That job WRITES to it in one place, the `uses:` line of the action…
    const WRITES = /actions-gh-pages|\bnpm run deploy\b|\bgit\b.*\bpush\b|\bgh-pages\s+-/;
    const writes = deploy.filter((l) => WRITES.test(l));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/^\s+- uses: peaceiris\/actions-gh-pages@/);
    // …and READS it, so that the builds before this one stay published: these
    // lines and no other. A new way of naming the branch is added here by
    // someone who looked at it.
    expect(deploy.filter((l) => PUBLISHES.test(l) && !WRITES.test(l)).map((l) => l.trim())).toEqual([
      'git ls-remote --exit-code --heads origin gh-pages >/dev/null || status=$?',
      'git fetch --no-tags --depth=1 origin gh-pages',
      'run: node scripts/prune-gh-pages.mjs --site published --dist dist',
    ]);
    // No workflow pushes with git itself, to any branch.
    for (const file of WORKFLOWS) {
      expect(live(file).filter((l) => /\bgit\b.*\bpush\b/.test(l)), `${file} pushes`).toEqual([]);
    }
  });

  it('cannot be skipped, and a red check cannot be stepped over', () => {
    // `continue-on-error` would turn the check into advice. An `if:` on a
    // step could skip it; an `if:` on the deploy job (`always()`,
    // `!cancelled()`) would start the publish whatever `needs` says.
    for (const lines of [gate, deploy]) {
      expect(lines.filter((l) => /^\s+(?:-\s+)?if:/.test(l))).toEqual([]);
      expect(lines.filter((l) => /continue-on-error/.test(l))).toEqual([]);
    }
  });

  it('hands the script the secret and the override under the names it reads', () => {
    const text = gate.join('\n');
    expect(text).toContain(`          ${SECRET}: \${{ secrets.${SECRET} }}`);
    expect(text).toContain(`          ${OVERRIDE}: \${{ vars.${OVERRIDE} }}`);
    // A variable, not a secret: its value can be read back in the settings.
    expect(yaml).not.toContain(`secrets.${OVERRIDE}`);
    // And nothing in the workflow decides about the override on its own: the
    // script is the one place that knows what it lifts.
    expect(yaml.split('\n').filter((l) => !isComment(l) && l.includes(OVERRIDE))).toHaveLength(1);
  });

  it('keeps the database URL out of the job that builds and publishes', () => {
    // The connection string of the `postgres` role: in the environment of one
    // step, in a job without a write token, where no install script runs.
    expect(yaml.match(/secrets\.SUPABASE_DB_URL/g)).toHaveLength(1);
    expect(deploy.join('\n')).not.toContain(SECRET);
    const header = gate.slice(0, gate.findIndex((l) => /^\s+steps:$/.test(l)));
    expect(header.join('\n')).not.toMatch(/secrets\./);
    expect(header.join('\n')).toMatch(/^ {4}permissions:\n {6}contents: read$/m);
    expect(runs(gate).filter((step) => step.startsWith('npm '))).toEqual(['npm ci --ignore-scripts']);
    expect(uses(gate.join('\n')).map((u) => u.ref.split('@')[0])).toEqual(['actions/checkout', 'actions/setup-node']);
    // It holds up a deploy: it ends, whatever the network does.
    expect(header.join('\n')).toMatch(/^ {4}timeout-minutes: \d$/m);
  });

  it('still waits for the database suite, which is what holds schema.sql to the migrations', () => {
    const db = job(read('.github/workflows/test.yml'), 'db');
    expect(db).not.toBeNull();
    expect(runs(db)).toContain('npm run test:db');
    expect(db.filter((l) => /continue-on-error|^\s+(?:-\s+)?if:/.test(l))).toEqual([]);
  });

  it('has a page that says what to do when it is red, by the same names', () => {
    const page = read(PAGE);
    for (const word of [`\`${SECRET}\``, `\`${OVERRIDE}\``, '`migrations`', `\`${COMMAND}\``, 'Re-run failed jobs', '.github/workflows/deploy.yml']) {
      expect(page, `${PAGE} does not mention ${word}`).toContain(word);
    }
    // The comment above the job sends there.
    expect(yaml).toContain(PAGE);
  });
});

// The second half of review finding P65. A page that was opened before a
// deploy asks for the files of ITS build when a screen is opened for the first
// time, and the deploy used to replace the published tree with the new build
// alone. The `deploy` job now publishes the new build on top of what is
// published and keeps the files of the two builds before it. What the script
// keeps and deletes is held in scripts/prune-gh-pages.test.mjs; what is held
// here is that the workflow hands it the published tree, publishes what it
// made, and cannot publish around it.
describe('deploy: the builds before this one stay published', () => {
  const yaml = read('.github/workflows/deploy.yml');
  const deploy = job(yaml, 'deploy');
  const PRUNE = 'node scripts/prune-gh-pages.mjs --site published --dist dist';
  const READ_STEP = 'What is published now';

  it('builds, reads what is published, adds the build to it, and publishes that folder', () => {
    const at = (re) => deploy.findIndex((l) => re.test(l));
    const order = [
      at(/^\s+- run: npm run build$/),
      at(new RegExp(`^\\s+- name: ${READ_STEP}$`)),
      at(/^\s+run: node scripts\/prune-gh-pages\.mjs /),
      at(/^\s+- uses: peaceiris\/actions-gh-pages@/),
    ];
    expect(order.every((i) => i !== -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The whole step: nothing behind the command that could swallow its exit
    // code. A tree the script refused is not published.
    expect(runs(deploy).filter((step) => step.includes('prune-gh-pages'))).toEqual([PRUNE]);
    expect(existsSync(resolve(root, 'scripts/prune-gh-pages.mjs'))).toBe(true);
    // The folder the script wrote is the one that goes out — not dist/, which
    // holds this build alone.
    expect(deploy.filter((l) => /^\s+publish_dir:/.test(l)).map((l) => l.trim())).toEqual(['publish_dir: ./published']);
  });

  it('lets the action replace the branch with that folder: with keep_files nothing would ever be deleted', () => {
    expect(deploy.filter((l) => /keep_files|force_orphan|destination_dir/.test(l))).toEqual([]);
  });

  it('runs one publish at a time, and never cuts short the one that is running', () => {
    // Read, add, write back: two at once would each publish without the
    // other's build.
    const header = deploy.slice(0, deploy.findIndex((l) => /^\s+steps:$/.test(l))).join('\n');
    expect(header).toMatch(/^ {4}concurrency:\n {6}group: \S+\n {6}cancel-in-progress: false$/m);
  });

  it('sends to the page of the deploy when the script says no', () => {
    // One page for both refusals of a deploy, and the comment above the steps
    // names it.
    expect(SITE_PAGE).toBe(PAGE);
    expect(yaml.slice(yaml.indexOf('\n  deploy:\n'))).toContain(SITE_PAGE);
  });

  // The step is run here as the runner runs it (`bash -e`), against a real
  // repository: a branch that could not be read must not look like a site
  // nothing was published to — the build would then go out alone, and take
  // the files of every other build away.
  describe(`the step "${READ_STEP}"`, () => {
    const step = scriptOf(yaml, READ_STEP);
    const tmp = mkdtempSync(join(tmpdir(), 'sl-published-'));
    afterAll(() => rmSync(tmp, { recursive: true, force: true }));

    const env = {
      PATH: process.env.PATH,
      HOME: tmp,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    };
    const git = (cwd, ...args) => {
      const done = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
      if (done.status !== 0) throw new Error(`git ${args.join(' ')}: ${done.stderr}`);
      return done.stdout;
    };

    /** A repository with one commit on `branch`, holding `files`. */
    function remote(branch, files) {
      const dir = mkdtempSync(join(tmp, 'origin-'));
      git(dir, 'init', '-q', '-b', branch);
      for (const [name, text] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, name)), { recursive: true });
        writeFileSync(join(dir, name), text);
      }
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', 'published');
      return `file://${dir}`;
    }

    /** The checkout of the job, with `origin` at `url`; then the step. */
    function runStep(url) {
      const work = mkdtempSync(join(tmp, 'work-'));
      git(work, 'init', '-q');
      git(work, 'remote', 'add', 'origin', url);
      const done = spawnSync('bash', ['--noprofile', '--norc', '-e', '-c', step], {
        cwd: work,
        env: { ...env, RUNNER_TEMP: mkdtempSync(join(tmp, 'runner-')) },
        encoding: 'utf8',
      });
      return { ...done, published: join(work, 'published') };
    }

    it('is a step of the job, with a script', () => {
      expect(step).toBeTruthy();
      expect(deploy.join('\n')).toContain(`- name: ${READ_STEP}`);
    });

    it('copies the published branch into the folder, and no repository with it', () => {
      const done = runStep(remote('gh-pages', {
        'index.html': '<!doctype html>',
        '.nojekyll': '',
        'assets/index-a1.js': 'a1',
        'builds/20261012090000.json': '{}',
      }));

      expect(done.status, done.stderr).toBe(0);
      expect(readdirSync(done.published).sort()).toEqual(['.nojekyll', 'assets', 'builds', 'index.html']);
      expect(readFileSync(join(done.published, 'assets/index-a1.js'), 'utf8')).toBe('a1');
      // A `.git` in the folder the action publishes would be its problem, or the branch's.
      expect(existsSync(join(done.published, '.git'))).toBe(false);
    });

    it('hands over an empty folder when nothing was ever published', () => {
      const done = runStep(remote('main', { 'README.md': 'x' }));

      expect(done.status, done.stderr).toBe(0);
      expect(readdirSync(done.published)).toEqual([]);
      expect(done.stdout).toContain('Nothing is published yet');
    });

    it('stops the job when the branch could not be read', () => {
      const done = runStep(`file://${join(tmp, 'no-such-repository')}`);

      expect(done.status).toBe(1);
      expect(done.stdout).toMatch(/^::error title=Deploy stopped::The published branch could not be read/m);
    });
  });
});

// version.json (src/lib/buildInfo.js): the build that is published, and the
// oldest one still allowed to run. The page reads it to learn that it must
// update, so it has to be the server's answer — and its minimum is the
// owner's to set, without a commit.
describe('deploy: version.json says which build is the oldest allowed', () => {
  const yaml = read('.github/workflows/deploy.yml');
  const deploy = job(yaml, 'deploy');
  const config = read('vite.config.js');

  it('gives the build the minimum under the name it reads, from a variable', () => {
    const build = deploy.findIndex((l) => /^\s+- run: npm run build$/.test(l));
    const next = deploy.findIndex((l, i) => i > build && /^\s+- /.test(l));
    const step = deploy.slice(build, next).join('\n');
    expect(step).toContain(`          ${MIN_BUILD_ENV}: \${{ vars.${MIN_BUILD_ENV} }}`);
    // A variable, not a secret: its value can be read back in the settings.
    expect(yaml).not.toContain(`secrets.${MIN_BUILD_ENV}`);
    expect(yaml.split('\n').filter((l) => !isComment(l) && l.includes(MIN_BUILD_ENV))).toHaveLength(1);
  });

  it('is written by the build, by the plugin that writes the id into index.html', () => {
    expect(config).toMatch(/^\s+buildInfoPlugin\(\{ env: process\.env \}\),$/m);
    expect(config.match(/buildInfoPlugin\(/g)).toHaveLength(1);
  });

  it('is never in the precache of the service worker', () => {
    // A copy in the precache would answer with what THIS worker was built
    // with — the one thing the page already knows.
    const patterns = config.match(/^\s+globPatterns: \[(.+)\],$/m);
    expect(patterns).not.toBeNull();
    expect(patterns[1]).toBe("'**/*.{js,css,html,svg,woff2}'");
    expect(VERSION_FILE).toMatch(/\.json$/);
    expect(config).not.toMatch(/additionalManifestEntries|globIgnores/);
  });

  it('prunes the folder Vite puts the files of a build in', () => {
    // scripts/lib/published-builds.mjs deletes under assets/ and nowhere else.
    expect(ASSETS_DIR).toBe('assets');
    expect(config).not.toMatch(/assetsDir/);
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

  const check = scriptOf(yaml, 'The two secrets are set');
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

  // Advisory until its first green run on GitHub (run 38354023259, the first
  // publication, 2026-10-13); a gate from then on. `continue-on-error` or an
  // `if:` would make a function that does not type-check a warning again.
  it('stops the gate when a function does not type-check', () => {
    expect(fn.filter((l) => /continue-on-error|^\s+(?:-\s+)?if:/.test(l))).toEqual([]);
    expect(fn.join('\n')).not.toMatch(/::warning/);
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

// Two things the first run on GitHub (2026-10-13) showed and the gate now
// holds. The unit job reported 2 tests skipped that pass in a full clone: the
// tests of supabase/functions/runbook.test.js that ask git about a commit of
// the published main, which a checkout of one commit does not have. And the
// database suite starts PostgreSQL binaries that have only been tried on the
// image ubuntu-latest pointed at then (24.04), while GitHub moves it to 26.
describe('CI: the runners the suites were tried on', () => {
  const testJob = job(read('.github/workflows/test.yml'), 'test');
  const dbJob = job(read('.github/workflows/test.yml'), 'db');
  const runsOn = (lines) => lines.map((l) => l.match(/^ {4}runs-on:\s+(\S+)\s*$/)).find(Boolean)?.[1];

  it('checks out the whole history for the unit suite, so no test of it skips on GitHub', () => {
    const checkout = testJob.findIndex((l) => /^\s+- uses: actions\/checkout@/.test(l));
    expect(checkout).toBeGreaterThan(-1);
    expect(testJob.slice(checkout + 1, checkout + 3).map((l) => l.trim())).toEqual(['with:', 'fetch-depth: 0']);
    // What needs it: the tests that look at a commit of the published main.
    expect(read('supabase/functions/runbook.test.js')).toMatch(/'origin\/main'/);
  });

  it('runs the database suite on the image its PostgreSQL binaries were started on', () => {
    expect(runsOn(dbJob)).toBe('ubuntu-24.04');
  });
});
