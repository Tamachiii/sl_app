// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  REPO_ROOT, fakeAdmin, functionNames, functionTables, listen, loadFunction, readRepoFile as read,
} from './_test/harness.js';

// docs/runbook/30-edge-functions.md is the page the owner follows to deploy a
// function, to look at its secrets and to rotate the shared bearer. Nothing
// runs that page. What can be held here:
//
//   - what it lists: the functions with the flag supabase/config.toml gives
//     them, the commands, the secrets the functions read;
//   - the check it gives for after a deploy, read off the page and run
//     against send-push/index.ts itself, behind a real port — and against
//     what the page says a wrong deploy looks like;
//   - the way back it gives, to the version before.
//
// The SQL statements of the page (the vault) are run by
// supabase/tests/push-secrets.test.js, in the database suite.

const root = REPO_ROOT;
const CONFIG = 'supabase/config.toml';
const PAGE = 'docs/runbook/30-edge-functions.md';
const page = existsSync(resolve(root, PAGE)) ? read(PAGE) : '';
const functions = functionNames();

// ```lang … ``` blocks of the page, in order.
const fences = [...page.matchAll(/^```(\w*)\n([\s\S]*?)^```$/gm)].map(([, lang, body]) => ({ lang, body: body.trim() }));
const commands = fences.filter(({ lang }) => lang === 'bash').map(({ body }) => body);

// The rows of the table under `header`, cells without their back-ticks.
function tableUnder(header) {
  const lines = page.split('\n');
  const start = lines.indexOf(header);
  if (start === -1) return null;
  const rows = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) break;
    rows.push(line.split('|').slice(1, -1).map((cell) => cell.trim().replace(/^`(.*)`$/, '$1')));
  }
  return rows;
}

describe(`${PAGE}: deploying`, () => {
  it('lists every function with the flag config.toml gives it', () => {
    const rows = tableUnder('| Function | `verify_jwt` | Called by | How it knows its caller |');
    expect(rows, `${PAGE} has no table of the functions`).toBeTruthy();
    const onPage = Object.fromEntries(rows.map(([name, flag]) => [name, { verify_jwt: flag === 'true' }]));
    expect(rows.every(([, flag]) => flag === 'true' || flag === 'false')).toBe(true);
    expect(onPage).toEqual(functionTables(read(CONFIG)));
  });

  it('deploys one function per command, by name, and leaves the flag to config.toml', () => {
    const deploys = commands.filter((command) => /\bfunctions\s+deploy\b/.test(command));
    expect(deploys.length).toBeGreaterThanOrEqual(functions.length);
    for (const command of deploys) {
      expect(command).toMatch(/^supabase functions deploy [a-z][a-z0-9-]* --use-api$/);
    }
    expect([...new Set(deploys.map((command) => command.split(' ')[3]))].sort()).toEqual(functions);
    // Named on the page, to forbid it; never in a command.
    expect(page).toContain('**Never `--no-verify-jwt`.**');
    expect(commands.filter((command) => command.includes('--no-verify-jwt'))).toEqual([]);
  });

  it('gives no command the runbook forbids', () => {
    const forbidden = /\bsupabase\s+(?:db\s+push|config\s+push|migration\s+(?:up|repair))\b/;
    expect(fences.filter(({ body }) => forbidden.test(body))).toEqual([]);
    expect(page).toContain('**Never `supabase config push`.**');
  });

  it('names every secret a function reads, and none it must not be given', () => {
    const readByFunctions = new Set(functions.flatMap((name) => (
      [...read(`supabase/functions/${name}/index.ts`).matchAll(/Deno\.env\.get\('([A-Z0-9_]+)'\)/g)].map(([, key]) => key)
    )));
    const provided = [...readByFunctions].filter((key) => key.startsWith('SUPABASE_')).sort();
    const toSet = [...readByFunctions].filter((key) => !key.startsWith('SUPABASE_')).sort();
    expect(toSet).toEqual(['INTERNAL_BEARER', 'VAPID_PRIVATE_KEY', 'VAPID_PUBLIC_KEY', 'VAPID_SUBJECT']);

    const rows = tableUnder('| Name | Read by | What it is |');
    expect(rows, `${PAGE} has no table of the functions' secrets`).toBeTruthy();
    const named = rows.flatMap(([names]) => names.split(',').map((name) => name.trim().replace(/`/g, ''))).sort();
    expect(named).toEqual(toSet);
    // Supabase provides these; the page says so and sets none of them.
    for (const key of provided) expect(page, key).toContain(`\`${key}\``);
    expect(commands.filter((command) => /secrets set\b.*SUPABASE_/.test(command))).toEqual([]);
  });

  it('only ever sets the bearer from the shell variable, never from a value typed on the page', () => {
    const sets = commands.filter((command) => /\bsecrets\s+set\b/.test(command));
    expect(sets).toEqual(['supabase secrets set INTERNAL_BEARER="$INTERNAL_BEARER"']);
    // Made in the shell, used, and dropped: in that order.
    const order = [
      'export INTERNAL_BEARER="$(openssl rand -hex 32)"',
      sets[0],
      'unset INTERNAL_BEARER',
    ].map((command) => commands.indexOf(command));
    expect(order.every((at) => at !== -1), 'the rotation lacks one of its commands').toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // A 64-character value typed out on the page would be everybody's secret.
    expect(page).not.toMatch(/\b[0-9a-f]{32,}\b/i);
  });
});

// A function has no rollback file: going back is deploying the old code, which
// the page takes from a commit.
describe(`${PAGE}: going back`, () => {
  const FILE = 'supabase/functions/send-push/index.ts';
  const [, sha] = new RegExp(`^git restore --source=([0-9a-f]{7,40}) --worktree -- ${FILE}$`, 'm').exec(page) ?? [];
  const before = (() => {
    try {
      return execFileSync('git', ['show', `${sha}:${FILE}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return null;
    }
  })();

  it('takes one file from a commit, deploys it like any other version, and puts the file back', () => {
    expect(sha, `${PAGE} names no commit to restore ${FILE} from`).toBeTruthy();
    const steps = [
      `git restore --source=${sha} --worktree -- ${FILE}`,
      'supabase functions deploy send-push --use-api',
      `git restore -- ${FILE}`,
    ].map((command) => commands.lastIndexOf(command));
    expect(steps.every((at) => at !== -1), 'the undo lacks one of its commands').toBe(true);
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
    // Nothing else of the working tree is touched, and nothing is staged.
    expect(commands.filter((command) => /^git /.test(command))).toHaveLength(2);
  });

  // The way back is needed on the day a deploy went wrong, possibly months
  // from now. A commit of a branch that is not published yet can be gone by
  // then — rebased, or squashed into one — and the first command would fail
  // with "could not resolve". So the page names a commit GitHub's main has.
  // true / false, or null where that cannot be told: no such commit, or no
  // `origin/main`, in this clone.
  const published = (() => {
    if (!sha) return null;
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', sha, 'origin/main'], { cwd: root, stdio: 'ignore' });
      return true;
    } catch (error) {
      return error.status === 1 ? false : null;
    }
  })();

  it.skipIf(published === null)('names a commit that the published main has, not one of a branch that can still move', () => {
    expect(published, `${sha} is not an ancestor of origin/main`).toBe(true);
  });

  // A shallow clone — CI — does not have the commit. The checkout the owner
  // deploys from does, and that is where this must hold.
  it.skipIf(before === null)('names a commit that holds send-push as it was before the gate', () => {
    expect(before).toContain('auth !== `Bearer ${INTERNAL_BEARER}`');
    expect(before).toContain("'Access-Control-Allow-Origin': '*'");
    expect(before).not.toContain('_shared');
    // What the check prints in between, as the page says.
    expect(before).toContain("new Response('Unauthorized', { status: 401");
    expect(page).toContain('prints `no bearer: 401 Unauthorized`');
  });
});

// ------------------------------------------------------------
// The check of section 3, pasted. It reads the project URL from `.env` and
// calls <url>/functions/v1/send-push; here `.env` points at a port of this
// machine, and behind the port is send-push/index.ts — the file that gets
// deployed, with its database and its push library replaced — or a stand-in
// for one of the wrong deploys the page describes.
// ------------------------------------------------------------
describe(`${PAGE}: the check after a deploy`, () => {
  const SECRET = '9d3e1f0a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e';
  const NEVER_SENT = ['sbp_access_token_of_the_stand_in', 'db-password-of-the-stand-in', 'anon-key-of-the-stand-in'];
  const ENV = {
    SUPABASE_URL: 'https://project.invalid',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-of-the-test',
    INTERNAL_BEARER: SECRET,
    VAPID_PUBLIC_KEY: 'vapid-public',
    VAPID_PRIVATE_KEY: 'vapid-private',
  };

  const check = commands.find((command) => command.includes('/functions/v1/send-push'));
  const expected = tableUnder('| line | after a deploy | during a rotation (section 4) |');
  const column = (n) => `${expected.map((row) => `${row[0]}: ${row[n]}`).join('\n')}\n`;

  let admin;
  let webpush;
  const servers = [];
  const folders = [];

  // A port that answers /functions/v1/send-push with `handler`, and a folder
  // standing in for the checkout: it holds the `.env` that points there.
  async function deployed(handler) {
    const server = await listen((request) => (
      new URL(request.url).pathname === '/functions/v1/send-push'
        ? handler(request)
        : Response.json({ code: 'NOT_FOUND', message: 'Requested function was not found' }, { status: 404 })
    ));
    servers.push(server);
    const project = mkdtempSync(join(tmpdir(), 'sl-edge-check-'));
    folders.push(project);
    // As the checkout has it: a quoted value, Windows line ends, and the
    // CLI's own secrets next to the values the app ships.
    writeFileSync(join(project, '.env'), [
      `VITE_SUPABASE_URL="${server.origin}"`,
      `VITE_SUPABASE_ANON_KEY=${NEVER_SENT[2]}`,
      `SUPABASE_ACCESS_TOKEN=${NEVER_SENT[0]}`,
      `SUPABASE_DB_PASSWORD=${NEVER_SENT[1]}`,
      '',
    ].join('\r\n'));
    return { project, requests: server.requests };
  }

  const sendPush = (env = ENV) => loadFunction('send-push', {
    env,
    modules: {
      'jsr:@supabase/supabase-js@2': { createClient: () => admin },
      'npm:web-push@3.6.7': { default: webpush },
    },
  });

  // Run the command the way it is pasted: bash, in the checkout. The
  // environment is NOT inherited — `node --env-file` never overrides a
  // variable that is already set, and this process may carry the real
  // project's URL — and the shell holds the secret only when `bearer` says so.
  function paste({ project }, { bearer } = {}) {
    if (!project || resolve(project).startsWith(root)) throw new Error(`paste: refusing to run in ${project}`);
    if (typeof check !== 'string' || /https?:\/\//.test(check)) throw new Error('paste: refusing this command');
    return new Promise((done) => {
      execFile('bash', ['-c', check], {
        cwd: project,
        env: {
          PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
          ...(bearer === undefined ? {} : { INTERNAL_BEARER: bearer }),
        },
        timeout: 20_000,
      }, (error, stdout, stderr) => done({ failed: Boolean(error), stdout, stderr }));
    });
  }

  const authorizations = (requests) => requests.map(({ headers }) => headers.authorization ?? null);

  beforeAll(() => {
    admin = fakeAdmin({
      push_subscriptions: [{ id: 's1', user_id: '11111111-1111-4111-8111-111111111111', endpoint: 'https://push.invalid/s1', p256dh: 'k', auth: 'a' }],
    });
    webpush = { setVapidDetails: vi.fn(), sendNotification: vi.fn(async () => ({ statusCode: 201 })) };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => { admin.calls.length = 0; });

  afterAll(async () => {
    await Promise.all(servers.map((server) => server.close()));
    for (const folder of folders) rmSync(folder, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('is on the page, with the table of what it prints', () => {
    expect(check, `${PAGE} has no bash block that calls /functions/v1/send-push`).toBeTruthy();
    expect(expected?.map((row) => row[0])).toEqual(['no bearer', 'bearer']);
  });

  it('prints the "after a deploy" column against send-push itself, without the secret', async () => {
    const site = await deployed(await sendPush());
    const ran = await paste(site);
    expect(ran.stderr).toBe('');
    expect(ran.failed).toBe(false);
    expect(ran.stdout).toBe(column(1));
    expect(ran.stdout).toContain('no bearer: 401 send-push: unauthorized\n');
    expect(site.requests.map(({ method, path }) => `${method} ${path}`)).toEqual(['POST /functions/v1/send-push']);
    expect(authorizations(site.requests)).toEqual([null]);
  });

  it('prints the "during a rotation" column when the shell holds the secret', async () => {
    const site = await deployed(await sendPush());
    const ran = await paste(site, { bearer: SECRET });
    expect(ran.stderr).toBe('');
    expect(ran.failed).toBe(false);
    expect(ran.stdout).toBe(column(2));
    expect(ran.stdout).toContain('bearer: 200 {"delivered":0}\n');
    expect(authorizations(site.requests)).toEqual([null, `Bearer ${SECRET}`]);
    // Its own output never shows the secret.
    expect(ran.stdout).not.toContain(SECRET);
  });

  it('sends no notification, writes nothing, and takes nothing else from .env', async () => {
    const site = await deployed(await sendPush());
    await paste(site, { bearer: SECRET });
    expect(webpush.sendNotification).not.toHaveBeenCalled();
    expect(admin.calls).toEqual([
      { table: 'push_subscriptions', op: 'select', column: 'user_id', value: '00000000-0000-0000-0000-000000000000' },
    ]);
    for (const secret of NEVER_SENT) expect(JSON.stringify(site.requests)).not.toContain(secret);
  });

  it('says when the value of the shell is not the function\'s secret', async () => {
    const site = await deployed(await sendPush());
    const ran = await paste(site, { bearer: `${SECRET.slice(0, -1)}f` });
    expect(ran.failed).toBe(true);
    expect(ran.stdout).toBe('no bearer: 401 send-push: unauthorized\nbearer: 401 send-push: unauthorized\n');
    expect(page).toContain('**`bearer: 401 send-push: unauthorized`**');
  });

  it('says when the function has no secret', async () => {
    const { INTERNAL_BEARER: _unset, ...env } = ENV;
    const site = await deployed(await sendPush(env));
    const ran = await paste(site, { bearer: SECRET });
    expect(ran.failed).toBe(true);
    expect(ran.stdout).toBe('no bearer: 500 send-push: not configured\n');
    expect(page).toContain('**`no bearer: 500 send-push: not configured`**');
    expect(authorizations(site.requests)).toEqual([null]);
  });

  // B18 itself: deployed with JWT verification on, the gateway answers and
  // the function never runs. The secret is not handed to that answer.
  it('tells the gateway\'s refusal from the function\'s, and does not send the secret to it', async () => {
    const reached = vi.fn();
    const site = await deployed((request) => {
      const jwt = /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/.test(request.headers.get('authorization') ?? '');
      if (jwt) return reached();
      return Response.json({
        code: 401,
        message: request.headers.has('authorization') ? 'Invalid JWT' : 'Missing authorization header',
      }, { status: 401 });
    });
    const ran = await paste(site, { bearer: SECRET });
    expect(ran.failed).toBe(true);
    expect(ran.stdout).toBe('no bearer: 401 {"code":401,"message":"Missing authorization header"}\n');
    expect(authorizations(site.requests)).toEqual([null]);
    expect(reached).not.toHaveBeenCalled();
    expect(page).toContain('**`no bearer: 401`, then anything else**');
  });

  // The version in production until the first deploy from this branch.
  it('recognises the version from before, which it does not trust with the secret either', async () => {
    const site = await deployed(() => new Response('Unauthorized', {
      status: 401, headers: { 'Access-Control-Allow-Origin': '*' },
    }));
    const ran = await paste(site, { bearer: SECRET });
    expect(ran.failed).toBe(true);
    expect(ran.stdout).toBe('no bearer: 401 Unauthorized\n');
    expect(authorizations(site.requests)).toEqual([null]);
    expect(page).toContain('**`no bearer: 401 Unauthorized`**');
  });

  it('fails on a function that is not there, that does not start, or that answers anyone', async () => {
    const cases = [
      [() => Response.json({ code: 'NOT_FOUND', message: 'Requested function was not found' }, { status: 404 }), /^no bearer: 404 /, '**`no bearer: 404`, then anything**'],
      [() => Response.json({ code: 'BOOT_ERROR', message: 'Function failed to start (please check logs)' }, { status: 503 }), /^no bearer: 503 /, '**`no bearer: 503`, then anything**'],
      [() => Response.json({ delivered: 0 }), /^no bearer: 200 /, '**`no bearer: 200`, then anything**'],
    ];
    for (const [handler, line, bullet] of cases) {
      const site = await deployed(handler);
      const ran = await paste(site, { bearer: SECRET });
      expect(ran.failed, bullet).toBe(true);
      expect(ran.stdout, bullet).toMatch(line);
      expect(ran.stdout.trimEnd().split('\n'), bullet).toHaveLength(1);
      expect(authorizations(site.requests), bullet).toEqual([null]);
      expect(page).toContain(bullet);
    }
  });

  it('fails by name in a folder that has no .env', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'sl-edge-check-'));
    folders.push(empty);
    const ran = await paste({ project: empty }, { bearer: SECRET });
    expect(ran.failed).toBe(true);
    expect(ran.stdout).toBe('');
    expect(ran.stderr).toContain('.env: not found');
    expect(page).toContain('**`node: .env: not found`**');
  });
});
