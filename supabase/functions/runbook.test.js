// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { admitInternalRequest } from './_shared/auth.js';
import {
  REPO_ROOT, fakeAdmin, functionNames, functionTables, listen, loadFunction, readRepoFile as read,
} from './_test/harness.js';

// docs/runbook/30-edge-functions.md is the page the owner follows to deploy a
// function, to look at its secrets and to rotate the shared bearer. Nothing
// runs that page. What can be held here:
//
//   - what it lists: the functions with the flag supabase/config.toml gives
//     them, the commands, the secrets the functions read;
//   - the checks it gives for after a deploy, read off the page and run
//     against send-push/index.ts and dispatch-rest-push/index.ts themselves,
//     behind a real port — and against what the page says a wrong deploy
//     looks like;
//   - the lines of the functions' logs it quotes, which the two index.ts
//     must write to the character;
//   - the way back it gives, to the versions before.
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
  const DISPATCH_FILE = 'supabase/functions/dispatch-rest-push/index.ts';
  const shaFor = (file) => new RegExp(`^git restore --source=([0-9a-f]{7,40}) --worktree -- ${file}$`, 'm').exec(page)?.[1];
  // The file as the commit the page names has it, or null: no such commit in
  // this clone (a shallow one — CI), or no commit named.
  const fileAt = (commit, file) => {
    try {
      return execFileSync('git', ['show', `${commit}:${file}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return null;
    }
  };
  const sha = shaFor(FILE);
  const before = fileAt(sha, FILE);
  const dispatchBefore = fileAt(shaFor(DISPATCH_FILE), DISPATCH_FILE);

  it('takes one file from a commit, deploys it like any other version, and puts the file back — for each function', () => {
    for (const [name, file] of [['send-push', FILE], ['dispatch-rest-push', DISPATCH_FILE]]) {
      const from = shaFor(file);
      expect(from, `${PAGE} names no commit to restore ${file} from`).toBeTruthy();
      const steps = [
        `git restore --source=${from} --worktree -- ${file}`,
        `supabase functions deploy ${name} --use-api`,
        `git restore -- ${file}`,
      ].map((command) => commands.lastIndexOf(command));
      expect(steps.every((at) => at !== -1), `the undo of ${name} lacks one of its commands`).toBe(true);
      expect(steps, name).toEqual([...steps].sort((a, b) => a - b));
      // One after the other, with nothing in between.
      expect(steps[2] - steps[0], name).toBe(2);
    }
    // One commit for both, which the test below holds to the published main.
    expect(shaFor(DISPATCH_FILE)).toBe(sha);
    // Nothing else of the working tree is touched, and nothing is staged.
    expect(commands.filter((command) => /^git /.test(command))).toHaveLength(4);
  });

  // The version this goes back to sends a rest push the moment it is handed
  // one — ten seconds early, to every device. The job that hands them over
  // has to be off first, and so has to be there before the deploy.
  it('says not to go back while the job that hands over the rest pushes runs, and not to start that job before the deploy', () => {
    const undo = page.slice(page.indexOf('\n## Undo\n'));
    expect(undo).toContain('**Not while the job `sl-rest-push` is switched on.**');
    expect(undo.indexOf('Switch the job off first')).toBeGreaterThan(-1);
    const when = page.slice(page.indexOf('\n## When\n'), page.indexOf('\n## 1. Deploy\n'));
    expect(when).toContain('**migrations 15 and 16, then this deploy, then, if you choose pg_cron, migration 19.**');
    expect(when).toContain('**Never migration 19 before this deploy.**');
  });

  // The other function has the same two rules, for its own reasons: without
  // migration 16 it has no claim to ask and sends nothing; and the version
  // before sends a row it has merely read, next to whatever else sends it.
  it('says the same of dispatch-rest-push, and that it is never deployed before migration 16', () => {
    const when = page.slice(page.indexOf('\n## When\n'), page.indexOf('\n## 1. Deploy\n'));
    expect(when).toContain('**migration 16, then this deploy, then, if you choose pg_cron, migration 19.**');
    expect(when).toContain('**Never before migration 16.**');
    expect(when).toContain('**Never migration 19 before this deploy either.**');
    const undo = page.slice(page.indexOf('\n## Undo\n'));
    expect(undo).toContain('That holds for both functions.');
    expect(undo).toContain('does not ask the database before it sends');
    // What the function writes when the claim is not there, as the page has it.
    expect(when).toContain('`claim_rest_push could not be asked`');
    expect(read('supabase/functions/_shared/push.js')).toContain('claim_rest_push could not be asked, nothing is sent');
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

  // The old dispatch-rest-push goes back under the flag of today: the gateway
  // no longer checks in front of it. That is safe only because it asks the
  // auth server about the token itself — which is what is looked for here.
  it.skipIf(dispatchBefore === null)('names a commit that holds dispatch-rest-push as it was before the hops, and which checks its caller itself', () => {
    expect(dispatchBefore).toContain('await sleep(delay)');
    expect(dispatchBefore).not.toContain('claim_rest_push');
    expect(dispatchBefore).not.toContain('_shared');
    expect(dispatchBefore).toContain('await userClient.auth.getUser()');
    expect(dispatchBefore).toMatch(/if \(userErr \|\| !userData\?\.user\) \{\s+return new Response\('Unauthorized', \{ status: 401/);
    expect(dispatchBefore).toContain("if (scheduled.user_id !== userId)");
    // What its check prints in between, as the page says.
    expect(dispatchBefore).toMatch(/if \(!auth\) \{\s+return new Response\('Unauthorized', \{ status: 401/);
    expect(page).toContain('prints `no credentials: 401 Unauthorized`');
    expect(functionTables(read(CONFIG))['dispatch-rest-push']).toEqual({ verify_jwt: false });
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
  // A dash is a line that is not printed in that case.
  const column = (n) => `${expected.filter((row) => row[n] !== '—').map((row) => `${row[0]}: ${row[n]}`).join('\n')}\n`;

  let admin;
  let webpush;
  const servers = [];
  const folders = [];

  // A port that answers /functions/v1/send-push (or `path`) with `handler`,
  // and a folder standing in for the checkout: it holds the `.env` that
  // points there.
  async function deployed(handler, path = '/functions/v1/send-push') {
    const server = await listen((request) => (
      new URL(request.url).pathname === path
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
  // `command` is the check of send-push unless another one is given.
  function paste({ project }, { bearer, command = check } = {}) {
    if (!project || resolve(project).startsWith(root)) throw new Error(`paste: refusing to run in ${project}`);
    if (typeof command !== 'string' || /https?:\/\//.test(command)) throw new Error('paste: refusing this command');
    return new Promise((done) => {
      execFile('bash', ['-c', command], {
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
      push_subscriptions: [{ id: 's1', user_id: '11111111-1111-4111-8111-111111111111', endpoint: 'https://fcm.googleapis.com/fcm/send/s1', p256dh: 'k', auth: 'a' }],
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
    expect(expected?.map((row) => row[0])).toEqual(['no bearer', 'bearer', 'rest push']);
    expect(expected.map((row) => row[1])).toEqual([expect.any(String), expect.any(String), '—']);
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
    expect(ran.stdout).toContain('rest push: 400 send-push: schedule_id is not a uuid\n');
    expect(authorizations(site.requests)).toEqual([null, `Bearer ${SECRET}`, `Bearer ${SECRET}`]);
    // Its own output never shows the secret.
    expect(ran.stdout).not.toContain(SECRET);
  });

  // The version of wave 1: the same gate, and a fan-out that reads the user
  // and the payload and nothing else. Handed a rest push by the job of
  // migration 19, it sends it at once. The first two lines cannot tell it
  // from the version of this page; the third does.
  it('tells the version from before wave 2, which has the gate and does not know a rest push', async () => {
    const site = await deployed(async (request) => {
      const admitted = await admitInternalRequest(request, { name: 'send-push', bearer: SECRET });
      return admitted.response ?? Response.json({ delivered: 0 });
    });
    expect((await paste(site)).stdout).toBe(column(1));
    const ran = await paste(site, { bearer: SECRET });
    expect(ran.failed).toBe(true);
    expect(ran.stdout).toBe('no bearer: 401 send-push: unauthorized\nbearer: 200 {"delivered":0}\nrest push: 200 {"delivered":0}\n');
    expect(page).toContain('**`rest push: 200 {"delivered":0}`**');
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

  // The other function has a check of its own: one request that shows
  // nothing. The gateway does not guard dispatch-rest-push any more — the
  // requests it makes to itself carry no user JWT — and a deploy that puts
  // the gateway's check back loses every rest longer than a minute, with
  // nothing to show for it but a line in a log. This is the command that
  // tells, the minute after the deploy.
  describe('of dispatch-rest-push', () => {
    const PATH = '/functions/v1/dispatch-rest-push';
    const GATEWAY = { code: 401, message: 'Missing authorization header' };
    const command = commands.find((one) => one.includes(PATH));
    const createClient = vi.fn(() => { throw new Error('the check must not get as far as a client'); });

    const dispatchRestPush = () => loadFunction('dispatch-rest-push', {
      env: { ...ENV, SUPABASE_ANON_KEY: NEVER_SENT[2] },
      modules: {
        'jsr:@supabase/supabase-js@2': { createClient },
        'npm:web-push@3.6.7': { default: webpush },
      },
    });

    it('is on the page, apart from the check of send-push, and says what it prints', () => {
      expect(command, `${PAGE} has no bash block that calls ${PATH}`).toBeTruthy();
      expect(command).not.toBe(check);
      expect(command).not.toContain('/functions/v1/send-push');
      expect(page).toContain('It prints one line, `no credentials: 401 dispatch-rest-push: unauthorized`');
    });

    it('prints that line against dispatch-rest-push itself, which makes no client and reads nothing', async () => {
      const site = await deployed(await dispatchRestPush(), PATH);
      const ran = await paste(site, { command });
      expect(ran.stderr).toBe('');
      expect(ran.failed).toBe(false);
      expect(ran.stdout).toBe('no credentials: 401 dispatch-rest-push: unauthorized\n');
      expect(site.requests.map(({ method, path }) => `${method} ${path}`)).toEqual([`POST ${PATH}`]);
      expect(createClient).not.toHaveBeenCalled();
      expect(webpush.sendNotification).not.toHaveBeenCalled();
    });

    // During a rotation the shell holds the secret. This check has no use
    // for it, and does not send it.
    it('shows nothing — no token, no secret — even when the shell holds one, and takes nothing else from .env', async () => {
      const site = await deployed(await dispatchRestPush(), PATH);
      const ran = await paste(site, { command, bearer: SECRET });
      expect(ran.stdout).toBe('no credentials: 401 dispatch-rest-push: unauthorized\n');
      expect(site.requests).toHaveLength(1);
      expect(site.requests[0].headers.authorization).toBeUndefined();
      expect(site.requests[0].headers['x-internal-bearer']).toBeUndefined();
      expect(site.requests[0].headers.apikey).toBeUndefined();
      for (const secret of [...NEVER_SENT, SECRET]) expect(JSON.stringify(site.requests)).not.toContain(secret);
    });

    // The fault this check exists for, and also what it prints before the
    // first deploy from this branch: the page says both.
    it('tells the gateway\'s refusal from the function\'s: JWT verification is on', async () => {
      const reached = vi.fn();
      const site = await deployed((request) => {
        if (request.headers.has('authorization')) return reached();
        return Response.json(GATEWAY, { status: 401 });
      }, PATH);
      const ran = await paste(site, { command });
      expect(ran.failed).toBe(true);
      expect(ran.stdout).toBe('no credentials: 401 {"code":401,"message":"Missing authorization header"}\n');
      expect(reached).not.toHaveBeenCalled();
      expect(page).toContain('**`no credentials: 401`, then anything else**');
      expect(page).toContain('**Before the first deploy from this branch that is expected**');
      expect(page).toContain('every request the function makes to itself is refused');
    });

    it('recognises the version from before, deployed without the gateway\'s check', async () => {
      const site = await deployed(() => new Response('Unauthorized', {
        status: 401, headers: { 'Access-Control-Allow-Origin': '*' },
      }), PATH);
      const ran = await paste(site, { command });
      expect(ran.failed).toBe(true);
      expect(ran.stdout).toBe('no credentials: 401 Unauthorized\n');
      expect(page).toContain('**`no credentials: 401 Unauthorized`**');
    });

    it('fails on a function that is not there, that does not start, or that answers anyone', async () => {
      const cases = [
        [() => Response.json({ code: 'NOT_FOUND', message: 'Requested function was not found' }, { status: 404 }), /^no credentials: 404 /, '**`no credentials: 404`, then anything**'],
        [() => Response.json({ code: 'BOOT_ERROR', message: 'Function failed to start (please check logs)' }, { status: 503 }), /^no credentials: 503 /, '**`no credentials: 503`, then anything**'],
        [() => Response.json({ accepted: true }, { status: 202 }), /^no credentials: 202 /, '**`no credentials: 200`, then anything**'],
        [() => new Response('dispatch-rest-push: already resolved'), /^no credentials: 200 /, '**`no credentials: 200`, then anything**'],
      ];
      for (const [handler, line, bullet] of cases) {
        const site = await deployed(handler, PATH);
        const ran = await paste(site, { command });
        expect(ran.failed, bullet).toBe(true);
        expect(ran.stdout, bullet).toMatch(line);
        expect(ran.stdout.trimEnd().split('\n'), bullet).toHaveLength(1);
        expect(page).toContain(bullet);
      }
    });

    it('fails by name in a folder that has no .env', async () => {
      const empty = mkdtempSync(join(tmpdir(), 'sl-edge-check-'));
      folders.push(empty);
      const ran = await paste({ project: empty }, { command });
      expect(ran.failed).toBe(true);
      expect(ran.stdout).toBe('');
      expect(ran.stderr).toContain('.env: not found');
    });
  });
});

// ------------------------------------------------------------
// Section 5: the lines of the function's log, as the page quotes them. The
// owner looks for them in the dashboard on the day a push did not arrive —
// months from now, with nothing else to go by. Each line of the page is
// taken apart, the devices and the push services it describes are put behind
// send-push/index.ts, and the function must write those lines, and no other.
// ------------------------------------------------------------
describe(`${PAGE}: the lines of the log`, () => {
  const USER = '11111111-1111-4111-8111-111111111111';
  const SECRET = '5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b';
  const quoted = fences.find(({ lang, body }) => lang === 'text' && body.includes('push failed'))?.body.split('\n') ?? [];

  const FAILED = /^send-push: push failed status=(\d+|none) host=(\S+) subscription=(\S+) (body|error)=(".*")$/;
  const NOT_SENT = /^send-push: push not sent host=(\S+) subscription=(\S+) reason=".+"$/;
  const NOBODY = /^send-push: no device got the push \((\d+) failed, (\d+) gone\)$/;

  // What each line of the page says happened, as a device and the answer of
  // its push service.
  const devices = [];
  const answers = new Map();
  for (const line of quoted) {
    const [, status, host, id, , said] = FAILED.exec(line) ?? [];
    const [, elsewhere, other] = NOT_SENT.exec(line) ?? [];
    if (id) {
      const endpoint = `https://${host}/the-address-of-${id}`;
      devices.push({ id, user_id: USER, endpoint, p256dh: `p256dh-of-${id}`, auth: `auth-of-${id}` });
      answers.set(endpoint, status === 'none'
        ? new Error(JSON.parse(said))
        : Object.assign(new Error('Received unexpected response code'), { statusCode: Number(status), body: JSON.parse(said), endpoint }));
    } else if (other) {
      devices.push({ id: other, user_id: USER, endpoint: `https://${elsewhere}/the-address-of-${other}`, p256dh: 'k', auth: 'a' });
    }
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('quotes a push service that refused, one that did not answer, a device that is gone, an address that is not one, and the summary', () => {
    expect(quoted.length).toBeGreaterThan(3);
    for (const line of quoted) expect(FAILED.test(line) || NOT_SENT.test(line) || NOBODY.test(line), line).toBe(true);
    const statuses = quoted.map((line) => FAILED.exec(line)?.[1]).filter(Boolean);
    expect(statuses).toContain('none');
    expect(statuses.some((status) => status === '404' || status === '410')).toBe(true);
    expect(statuses.some((status) => /^\d+$/.test(status) && status !== '404' && status !== '410')).toBe(true);
    expect(quoted.filter((line) => NOT_SENT.test(line))).toHaveLength(1);
    expect(quoted.filter((line) => NOBODY.test(line))).toHaveLength(1);
    // A host, and nothing of an address after it.
    for (const line of quoted) expect(line).not.toMatch(/https?:|host=\S*\//);
  });

  it('is what send-push writes, to the character, and what it answers 502 to', async () => {
    const admin = fakeAdmin({ push_subscriptions: devices.map((device) => ({ ...device })) });
    const webpush = {
      setVapidDetails: vi.fn(),
      sendNotification: vi.fn(async ({ endpoint }) => {
        if (answers.has(endpoint)) throw answers.get(endpoint);
        return { statusCode: 201 };
      }),
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = await loadFunction('send-push', {
      env: {
        SUPABASE_URL: 'https://project.invalid',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-of-the-test',
        INTERNAL_BEARER: SECRET,
        VAPID_PUBLIC_KEY: 'vapid-public',
        VAPID_PRIVATE_KEY: 'vapid-private',
      },
      modules: {
        'jsr:@supabase/supabase-js@2': { createClient: () => admin },
        'npm:web-push@3.6.7': { default: webpush },
      },
    });

    const response = await handler(new Request('http://functions.invalid/functions/v1/send-push', {
      method: 'POST',
      headers: { authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ user_id: USER, payload: { title: 'Feedback from Coach' } }),
    }));
    expect(response.status).toBe(502);
    expect(page).toContain('the request that is answered `502`');

    const written = [...warn.mock.calls, ...error.mock.calls].map(([line]) => line);
    expect([...written].sort()).toEqual([...quoted].sort());
    // The summary comes last, and a device that is gone is a warning.
    expect(error.mock.calls.at(-1)[0]).toMatch(NOBODY);
    expect(warn.mock.calls.map(([line]) => FAILED.exec(line)?.[1])).toEqual(
      quoted.map((line) => FAILED.exec(line)?.[1]).filter((status) => status === '404' || status === '410'),
    );
    expect(page).toContain('Written as a warning, not as an error');
    // Sent to the push services only; the device that is gone is deleted.
    expect(webpush.sendNotification).toHaveBeenCalledTimes(answers.size);
    expect(admin.calls.filter(({ op }) => op === 'delete')).toHaveLength(warn.mock.calls.length);
  });

  it('names the place where they are read, and the 200 characters', () => {
    expect(page).toContain('Dashboard → Edge Functions → `send-push` → **Logs**');
    expect(page).toContain('cut at 200 characters');
  });
});

// ------------------------------------------------------------
// Section 5, the other function: what a rest writes in the log of
// dispatch-rest-push, request by request. The page quotes a rest of three
// minutes that rang, and the same rest where the function is deployed with
// JWT verification on — the one fault of a deploy that nothing but this log
// shows. The rest the page describes is run through dispatch-rest-push/index.ts
// on a clock of the test, with the address the function calls itself at
// answered by the function, or by a gateway that asks for a user JWT.
// ------------------------------------------------------------
describe(`${PAGE}: the lines of the log of dispatch-rest-push`, () => {
  const USER = '11111111-1111-4111-8111-111111111111';
  const SECRET = '3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b';
  const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJlLW9mLXRoZS11c2Vy';
  const NOW = Date.parse('2026-10-13T20:00:00.000Z');
  const quoted = fences
    .filter(({ lang, body }) => lang === 'text' && body.startsWith('dispatch-rest-push: rest push '))
    .map(({ body }) => body.split('\n'));
  const [rang = [], refused = []] = quoted;
  const [, id, ahead] = /^dispatch-rest-push: rest push ([0-9a-f-]{36}): hop 1, hands over in \d+ s \((\d+) s before its time\)$/.exec(rang[0] ?? '') ?? [];

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // The rest of the page, started by the app, to its end. `gateway` stands in
  // front of the function for the requests it makes to itself.
  async function rest({ gateway }) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(NOW);
    const tables = {
      push_subscriptions: [{ id: 's1', user_id: USER, endpoint: 'https://web.push.apple.com/the-address-of-s1', p256dh: 'k', auth: 'a' }],
      scheduled_pushes: [{
        id, user_id: USER, status: 'pending', canceled_at: null, fire_at: new Date(NOW + Number(ahead) * 1000).toISOString(),
        payload: { title: 'Rest done' }, endpoint: null, sent_at: null, error: null,
      }],
    };
    const admin = fakeAdmin(tables, {
      rpc: {
        claim_rest_push: ({ p_id }) => {
          const row = tables.scheduled_pushes.find((one) => one.id === p_id && one.status === 'pending');
          if (!row) return { data: null };
          row.status = 'sending';
          return { data: { id: row.id, user_id: row.user_id, payload: row.payload, endpoint: row.endpoint, fire_at: row.fire_at } };
        },
      },
    });
    const webpush = { setVapidDetails: vi.fn(), sendNotification: vi.fn(async () => ({ statusCode: 201 })) };
    const written = [];
    for (const level of ['info', 'warn', 'error']) {
      vi.spyOn(console, level).mockImplementation((line) => { written.push({ level, line }); });
    }
    const handed = [];
    vi.stubGlobal('EdgeRuntime', { waitUntil: (work) => { handed.push(work); } });
    const handler = await loadFunction('dispatch-rest-push', {
      env: {
        SUPABASE_URL: 'https://project.invalid',
        SUPABASE_ANON_KEY: 'anon-key-of-the-test',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-of-the-test',
        INTERNAL_BEARER: SECRET,
        VAPID_PUBLIC_KEY: 'vapid-public',
        VAPID_PRIVATE_KEY: 'vapid-private',
      },
      modules: {
        'jsr:@supabase/supabase-js@2': {
          createClient: (url, key) => (key === 'anon-key-of-the-test'
            ? { auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) } }
            : admin),
        },
        'npm:web-push@3.6.7': { default: webpush },
      },
    });
    vi.stubGlobal('fetch', vi.fn(async (url, init) => (gateway ? gateway(new Request(url, init)) : handler(new Request(url, init)))));

    const response = await handler(new Request('http://functions.invalid/functions/v1/dispatch-rest-push', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ scheduleId: id }),
    }));
    expect(response.status).toBe(202);
    await vi.advanceTimersByTimeAsync(Number(ahead) * 1000);
    await Promise.all(handed);
    return { written, webpush, row: tables.scheduled_pushes[0] };
  }

  it('quotes a rest that rang and one whose hand-over the gateway refused, of the same row', () => {
    expect(quoted).toHaveLength(2);
    expect(id, 'the first line names no row').toBeTruthy();
    expect(Number(ahead)).toBeGreaterThan(120);
    for (const line of [...rang, ...refused]) expect(line.startsWith(`dispatch-rest-push: rest push ${id}: `), line).toBe(true);
    expect(rang.at(-1)).toMatch(/: sent to \d+ devices?$/);
    expect(refused.at(-1)).toMatch(/did not take over, the rest does not ring: HTTP 401 \{/);
    // Neither block is taken for the lines of send-push.
    for (const line of [...rang, ...refused]) expect(line).not.toContain('push failed');
  });

  it('is what dispatch-rest-push writes for that rest, to the character', async () => {
    const { written, webpush, row } = await rest({});
    expect(written.map(({ line }) => line)).toEqual(rang);
    expect(written.every(({ level }) => level === 'info')).toBe(true);
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
    expect(row.status).toBe('sent');
  });

  it('is what it writes where the gateway asks its own request for a user JWT, and nothing rings', async () => {
    const gateway = (request) => (request.headers.has('authorization')
      ? new Response('the stand-in was shown a token', { status: 500 })
      : Response.json({ code: 401, message: 'Missing authorization header' }, { status: 401 }));
    const { written, webpush, row } = await rest({ gateway });
    expect(written.map(({ line }) => line)).toEqual(refused);
    expect(written.map(({ level }) => level)).toEqual(['info', 'error']);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
    expect(row.status).toBe('pending');
  });

  it('names the place where they are read, and explains the lines with the words the function writes', () => {
    expect(page).toContain('Dashboard → Edge Functions → `dispatch-rest-push` → **Logs**');
    const source = read('supabase/functions/_shared/restPush.js');
    const rows = tableUnder('| The line says | What it means | What to do |') ?? [];
    expect(rows.length).toBeGreaterThan(0);
    // The table of the lines of dispatch-rest-push is the second of that shape.
    const second = page.slice(page.indexOf('Dashboard → Edge Functions → `dispatch-rest-push` → **Logs**'));
    for (const words of [
      'hands over in',
      'sends in',
      'no longer waiting after hop',
      'taken back, or sent by the other sender. Not handed over',
      'did not take over, the rest does not ring',
      'INTERNAL_BEARER is not set',
      'not configured',
      'refused, ',
    ]) {
      expect(second, words).toContain(words);
      expect(source, words).toContain(words);
    }
    expect(second).toContain('`claim_rest_push could not be asked, nothing is sent`');
  });
});
