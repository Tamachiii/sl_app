// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The Auth settings of production (sign-up off, site URL, redirect list,
// password length) live in the Supabase dashboard and nowhere else: the owner
// sets them by hand, following docs/runbook/20-auth-config.md. Nothing local
// can see them. What can be held here is the hand-over:
//
//   - the check that page gives the person who changes them, read off the page
//     and run against a stand-in for the Auth server — what is tested is the
//     command they will paste, and the output the page tells them to expect;
//   - the two ways the repository could undo their work without anyone
//     noticing: an Auth section in supabase/config.toml, and a script or a
//     workflow that runs `supabase config push`.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(resolve(root, rel), 'utf8');

const PAGE = 'docs/runbook/20-auth-config.md';
const page = existsSync(resolve(root, PAGE)) ? read(PAGE) : '';

// ```lang … ``` blocks of the page, in order.
const fences = [...page.matchAll(/^```(\w*)\n([\s\S]*?)^```$/gm)].map(([, lang, body]) => ({ lang, body }));

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

// ------------------------------------------------------------
// A stand-in for GET /auth/v1/settings: the shape GoTrue answers with (one
// boolean per provider under `external`, then the flags), behind a gateway
// that wants the project's anon key in `apikey`.
// ------------------------------------------------------------
const ANON_KEY = 'anon-key-of-the-stand-in';
const NEVER_SENT = ['db-password-of-the-stand-in', 'sbp_access_token_of_the_stand_in'];
const OTHER_PROVIDERS = [
  'apple', 'azure', 'bitbucket', 'discord', 'facebook', 'figma', 'fly', 'github', 'gitlab', 'google',
  'kakao', 'keycloak', 'linkedin', 'linkedin_oidc', 'notion', 'phone', 'slack', 'slack_oidc', 'spotify',
  'twitch', 'twitter', 'workos', 'zoom',
];
const settings = ({ disableSignup, autoconfirm = false, enabled = ['email'] }) => ({
  external: Object.fromEntries(
    ['anonymous_users', ...OTHER_PROVIDERS, 'email'].map((name) => [name, enabled.includes(name)]),
  ),
  disable_signup: disableSignup,
  mailer_autoconfirm: autoconfirm,
  phone_autoconfirm: false,
  sms_provider: 'twilio',
  saml_enabled: false,
});
// What the live review read on 2026-09-30, and what the page asks for.
const TODAY = settings({ disableSignup: false });
const AFTER = settings({ disableSignup: true });

let server;
let project;      // a folder standing in for the checkout: it holds the `.env`
let serving;      // what the stand-in answers
let requests;     // what it was asked

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    const [status, body] = req.headers.apikey === ANON_KEY
      ? [200, serving]
      : [401, { message: 'Invalid API key' }];
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise((done) => { server.listen(0, '127.0.0.1', done); });

  // A `.env` as the checkout has it: a quoted value, Windows line ends, and
  // the secrets of the CLI next to the two values the app ships.
  project = mkdtempSync(join(tmpdir(), 'sl-auth-check-'));
  writeFileSync(join(project, '.env'), [
    `VITE_SUPABASE_URL="http://127.0.0.1:${server.address().port}"`,
    `VITE_SUPABASE_ANON_KEY=${ANON_KEY}`,
    'VITE_VAPID_PUBLIC_KEY=',
    `SUPABASE_ACCESS_TOKEN=${NEVER_SENT[1]}`,
    `SUPABASE_DB_PASSWORD=${NEVER_SENT[0]}`,
    '',
  ].join('\r\n'));
});

afterAll(async () => {
  await new Promise((done) => { server.close(done); });
  rmSync(project, { recursive: true, force: true });
});

// Run a command of the page the way it is pasted: bash, in the checkout.
//
// The environment is NOT inherited. `node --env-file` never overrides a
// variable that is already set, and this process may carry the real project's
// URL (Vite loads `.env`) or CI's placeholder: inherited, either would send
// the request somewhere else than the stand-in.
function paste(command, { cwd = project, answer = TODAY } = {}) {
  // Never in the repository — its `.env` is the real project's — and never a
  // command that names a host of its own: the only address is the one in `.env`.
  if (!cwd || resolve(cwd).startsWith(root)) throw new Error(`paste: refusing to run in ${cwd}`);
  if (typeof command !== 'string' || /https?:\/\//.test(command)) throw new Error('paste: refusing this command');
  serving = answer;
  requests = [];
  return new Promise((done) => {
    execFile('bash', ['-c', command], {
      cwd,
      env: { PATH: `${dirname(process.execPath)}:${process.env.PATH}` },
      timeout: 20_000,
    }, (error, stdout, stderr) => done({ failed: Boolean(error), stdout, stderr, requests }));
  });
}

describe(`${PAGE}: the check of /auth/v1/settings`, () => {
  const check = fences.find(({ lang, body }) => lang === 'bash' && body.includes('/auth/v1/settings'))?.body;
  const expected = tableUnder('| line | today | after the four steps |');
  const column = (n) => `${expected.map((row) => `${row[0]}: ${row[n]}`).join('\n')}\n`;

  it('is on the page, with the table of what it prints', () => {
    expect(check, `${PAGE} has no bash block that reads /auth/v1/settings`).toBeTruthy();
    expect(expected?.map((row) => row[0])).toEqual(['disable_signup', 'mailer_autoconfirm', 'ways to sign in']);
  });

  it('sends one GET with the anon key, and nothing else of .env', async () => {
    const ran = await paste(check);
    expect(ran.requests.map(({ method, url }) => `${method} ${url}`)).toEqual(['GET /auth/v1/settings']);
    expect(ran.requests[0].headers.apikey).toBe(ANON_KEY);
    for (const secret of NEVER_SENT) {
      expect(JSON.stringify(ran.requests)).not.toContain(secret);
      expect(ran.stdout + ran.stderr).not.toContain(secret);
    }
  });

  it('prints the "today" column for the settings the review read', async () => {
    const ran = await paste(check, { answer: TODAY });
    expect(ran.failed).toBe(false);
    expect(ran.stdout).toBe(column(1));
    expect(ran.stdout).toContain('disable_signup: false');
  });

  it('prints the "after" column once sign-up is off', async () => {
    const ran = await paste(check, { answer: AFTER });
    expect(ran.failed).toBe(false);
    expect(ran.stdout).toBe(column(2));
    expect(ran.stdout).toContain('disable_signup: true');
  });

  // The cases the page lists under "If it does not print the today column".
  it('names every way in that is switched on, and says when there is none', async () => {
    const wide = await paste(check, {
      answer: settings({ disableSignup: true, autoconfirm: true, enabled: ['anonymous_users', 'google', 'email'] }),
    });
    expect(wide.stdout.split('\n')).toEqual([
      'disable_signup: true', 'mailer_autoconfirm: true', 'ways to sign in: anonymous_users, google, email', '',
    ]);

    const closed = await paste(check, { answer: settings({ disableSignup: true, enabled: [] }) });
    expect(closed.stdout).toContain('ways to sign in: none\n');
  });

  it('fails with the status when the key is refused, and prints no setting', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'sl-auth-check-'));
    writeFileSync(join(elsewhere, '.env'), [
      `VITE_SUPABASE_URL=http://127.0.0.1:${server.address().port}`,
      'VITE_SUPABASE_ANON_KEY=the-key-of-another-project',
      '',
    ].join('\n'));
    const ran = await paste(check, { cwd: elsewhere });
    rmSync(elsewhere, { recursive: true, force: true });

    expect(ran.failed).toBe(true);
    expect(ran.stdout).toBe('');
    expect(ran.stderr).toContain('HTTP 401');
    expect(page).toContain('**`HTTP 401`**');
  });

  it('fails by name in a folder that has no .env', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'sl-auth-check-'));
    const ran = await paste(check, { cwd: empty });
    rmSync(empty, { recursive: true, force: true });

    expect(ran.failed).toBe(true);
    expect(ran.requests).toEqual([]);
    expect(ran.stderr).toContain('.env: not found');
    expect(page).toContain('**`node: .env: not found`**');
  });
});

// ------------------------------------------------------------
// The repository holds no copy of the Auth settings, so that nothing can push
// one. `supabase config push` sends supabase/config.toml to the project, and
// for a setting the file does not give, the CLI uses its own default — sign-up
// on, site URL on localhost, passwords of 6 characters.
// ------------------------------------------------------------

// What a config.toml says besides `[functions.<name>]` and `project_id`: the
// first segment of every table and of every top-level key, comments aside.
function beyondFunctionFlags(toml) {
  const out = [];
  let inTable = false;
  for (const raw of toml.split('\n')) {
    const line = raw.replace(/^\s+/, '');
    if (line === '' || line.startsWith('#')) continue;
    const table = line.match(/^\[{1,2}\s*"?([A-Za-z0-9_-]+)/)?.[1];
    if (table) {
      inTable = true;
      if (table !== 'functions') out.push(line.replace(/\s*#.*$/, ''));
    } else if (!inTable) {
      const key = line.match(/^"?([A-Za-z0-9_-]+)/)?.[1];
      if (key !== 'project_id' && key !== 'functions') out.push(line.replace(/\s*#.*$/, ''));
    }
  }
  return out;
}

// Every file under `dir`, relative to the repository root.
function filesUnder(dir) {
  const full = resolve(root, dir);
  if (!existsSync(full)) return [];
  return readdirSync(full).flatMap((name) => {
    const rel = `${dir}/${name}`;
    return statSync(resolve(root, rel)).isDirectory() ? filesUnder(rel) : [rel];
  });
}

describe('the Auth settings are not mirrored in the repository', () => {
  it('reads a config.toml the way the next test needs', () => {
    expect(beyondFunctionFlags([
      '# [auth] is documented in docs/ENVIRONMENT.md, not here',
      'project_id = "sl_app"',
      '',
      '[functions.send-push]',
      'verify_jwt = false',
      '[functions.dispatch-rest-push]',
      'verify_jwt = true',
    ].join('\n'))).toEqual([]);

    expect(beyondFunctionFlags('[auth]\nenable_signup = false\nsite_url = "https://tamachiii.github.io/sl_app/"'))
      .toEqual(['[auth]']);
    expect(beyondFunctionFlags('[functions.send-push]\nverify_jwt = false\n\n  [auth.email]  # smtp\nenable_signup = false'))
      .toEqual(['[auth.email]']);
    expect(beyondFunctionFlags('[[auth.hook]]\n[api]\nmax_rows = 1000')).toEqual(['[[auth.hook]]', '[api]']);
    expect(beyondFunctionFlags('auth.enable_signup = false\n[functions.send-push]\nenabled = true'))
      .toEqual(['auth.enable_signup = false']);
  });

  it('supabase/config.toml, when there is one, pins the function flags and nothing else', () => {
    const file = 'supabase/config.toml';
    const found = existsSync(resolve(root, file)) ? beyondFunctionFlags(read(file)) : [];
    expect(found, `${file} must not carry project settings: see ${PAGE}`).toEqual([]);
  });

  it('no script and no workflow runs `supabase config push`', () => {
    const { scripts } = JSON.parse(read('package.json'));
    const commands = [
      ...Object.entries(scripts).map(([name, text]) => [`package.json "${name}"`, text]),
      ...[...filesUnder('.github/workflows'), ...filesUnder('scripts')].map((file) => [
        file,
        // A comment may name the command to forbid it.
        read(file).split('\n').filter((line) => !/^\s*(#|\/\/|\*)/.test(line)).join('\n'),
      ]),
    ];
    expect(commands.length).toBeGreaterThan(Object.keys(scripts).length);
    expect(commands.filter(([, text]) => /config\s+push/.test(text)).map(([where]) => where)).toEqual([]);
  });

  it('the page says so, and the page every migration starts from repeats it', () => {
    expect(page).toContain('## Never: `supabase config push`');
    expect(read('docs/runbook/00-before-you-start.md')).toContain('`supabase config push`');
  });
});
