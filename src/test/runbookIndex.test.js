// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest } from '../../supabase/migrations/manifest.js';

// docs/RUNBOOK.md is the page the owner follows when he applies SQL to
// production by hand: which migrations at which checkpoint, in what order,
// with which audit before and after. Nothing runs that page, so nothing
// notices when it sends him to a file that does not exist, skips an audit,
// lists a migration under the wrong checkpoint or gives a command no test has
// ever run. What can be held here:
//
//   - the checkpoint table against supabase/migrations/manifest.json, which is
//     what the migrations themselves and the deploy rule go by;
//   - the sequence of a checkpoint that is handed over: every migration of
//     the manifest, in order, audited before and after, its rollback and its
//     page named, the ledger read at the end;
//   - the commands: the index repeats commands that a page under docs/runbook/
//     gives — those are read off their page and run by a test — and never
//     introduces one of its own, in a fence of any language;
//   - the backup: the index takes and checks it with the commands of the 00
//     page (run by supabase/tests/backup-roundtrip.test.js), never writes it
//     into the checkout, and gives the nightly run the place BACKUPS.md and
//     the workflow give it — two secrets, after the first push.
//
// The index is the integrator's file. A failure here after a change to the
// manifest or to a runbook page means the index has to follow.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(resolve(root, rel), 'utf8');

const INDEX = 'docs/RUNBOOK.md';
const index = read(INDEX);
const manifest = loadManifest(root);

// The review's own folder: reports and the artefacts of the runs against
// production. Ignored by git, so it exists in the checkout the review ran in
// and nowhere else — not in CI, not in a worktree.
const LOCAL_ONLY = 'review-2026-09-30/';

const FORBIDDEN = /\bsupabase\s+(?:db\s+push|config\s+push|migration\s+(?:up|repair))\b/;

// A fence that calls the CLI: the word, then a space. Whatever the fence is
// tagged (`sh`, `console`, nothing: it is pasted just the same) and whatever
// stands before the word on its line (`npx supabase …`). A path
// (`supabase/migrations/…`) is not a call. The backup scripts count as well:
// they connect to production with the database password.
const CALLS_CLI = /\bsupabase\s|\bscripts\/backup\//;

// ------------------------------------------------------------
// Reading a page
// ------------------------------------------------------------

// The lines of a page, each with what it is: a heading outside any fence, or
// part of fenced block number `fence`. A fence inside a list item is indented;
// its body is read without that indent, as it is pasted.
function scan(text) {
  const out = [];
  let open = null;
  let count = -1;
  for (const raw of text.split('\n')) {
    const mark = /^(\s*)(`{3,})(\w*)\s*$/.exec(raw);
    if (open === null && mark) {
      count += 1;
      open = { indent: mark[1].length, ticks: mark[2].length, lang: mark[3] };
      out.push({ raw, fence: count, edge: true, lang: open.lang });
    } else if (open !== null && mark && mark[2].length >= open.ticks && mark[3] === '') {
      out.push({ raw, fence: count, edge: true, lang: open.lang });
      open = null;
    } else if (open !== null) {
      const indent = raw.length - raw.trimStart().length;
      out.push({ raw, fence: count, lang: open.lang, body: raw.slice(Math.min(open.indent, indent)) });
    } else {
      out.push({ raw, heading: /^(#{1,6}) (.+)$/.exec(raw) });
    }
  }
  return out;
}

// The fenced blocks of a page, in order: language, text, and the headings
// they stand under (`h2`, and `h3` when there is one below it).
function fencesOf(text) {
  const out = [];
  let h2 = null;
  let h3 = null;
  for (const line of scan(text)) {
    if (line.heading) {
      const [, hashes, title] = line.heading;
      if (hashes.length === 2) { h2 = title; h3 = null; }
      if (hashes.length === 3) h3 = title;
    } else if (line.fence !== undefined) {
      out[line.fence] ??= { lang: line.lang, lines: [], h2, h3 };
      if (!line.edge) out[line.fence].lines.push(line.body);
    }
  }
  return out.map(({ lines, ...rest }) => ({ ...rest, body: lines.join('\n').trim() }));
}

// The text under each `## ` heading, heading included.
function sectionsOf(text) {
  const out = [];
  for (const line of scan(text)) {
    if (line.heading?.[1].length === 2) out.push({ title: line.heading[2], lines: [] });
    out.at(-1)?.lines.push(line.raw);
  }
  return out.map(({ title, lines }) => ({ title, text: lines.join('\n') }));
}

// The rows of the table whose header row starts with `| <first> |`, as
// objects keyed by the header cells.
function tableOf(text, first) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`| ${first} |`));
  if (start === -1) return null;
  const cells = (line) => line.split('|').slice(1, -1).map((cell) => cell.trim());
  const header = cells(lines[start]);
  const rows = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) break;
    rows.push(Object.fromEntries(cells(line).map((cell, i) => [header[i], cell])));
  }
  return rows;
}

// "04–10", "15–18, and 19 if pg_cron is enabled", "36, 37" → the numbers.
function numbersIn(cell) {
  const out = [];
  for (const [, from, to] of cell.matchAll(/\b(\d{2})(?:\s*[–-]\s*(\d{2}))?\b/g)) {
    for (let n = Number(from); n <= Number(to ?? from); n += 1) out.push(n);
  }
  return out;
}

const pad = (n) => String(n).padStart(2, '0');
const firstLine = (command) => command.split('\n')[0];
const runsFile = (file) => `supabase db query --linked --file ${file}`;

// ------------------------------------------------------------
// The judgement of an index, so the same code is tried on wrong ones below.
//   migrations  the manifest's, with `order`, `checkpoint` and `paths`
//   onPages     the fenced commands the pages under docs/runbook/ give
// ------------------------------------------------------------
function indexProblems(text, { migrations, onPages }) {
  const out = [];

  const table = tableOf(text, 'Checkpoint');
  if (!table) return ['no checkpoint table (a header row that starts "| Checkpoint |")'];
  const rows = new Map(table.map((row) => [row.Checkpoint.replace(/\*/g, ''), {
    numbers: numbersIn(row.Migrations ?? ''),
    ready: /\bready\b/.test(row['Hand-over'] ?? ''),
  }]));

  // The table against the manifest.
  for (const { name, checkpoint, order } of migrations) {
    const row = rows.get(checkpoint);
    if (!row) out.push(`${name}: the table has no row for checkpoint ${checkpoint}`);
    else if (!row.numbers.includes(order)) out.push(`${name}: the row of checkpoint ${checkpoint} does not list migration ${pad(order)}`);
  }

  // A checkpoint is handed over when it is marked ready AND has its sequence.
  const sections = new Map();
  for (const { title, text: body } of sectionsOf(text)) {
    const id = /^Checkpoint (\w+) — /.exec(title)?.[1];
    if (id) sections.set(id, body);
  }
  for (const [id, row] of rows) {
    if (row.ready && !sections.has(id)) out.push(`checkpoint ${id} is marked ready and has no "## Checkpoint ${id} — …" section`);
    if (!row.ready && sections.has(id)) out.push(`checkpoint ${id} has a section and is not marked ready in the table`);
  }
  for (const id of sections.keys()) {
    if (!rows.has(id)) out.push(`"## Checkpoint ${id} — …" is not a row of the table`);
  }

  // The sequence of each one: audit, apply, audit — in the manifest's order.
  // One command per fence: it is pasted, looked at, and only then the next.
  for (const [id, body] of sections) {
    if (!rows.has(id)) continue;
    const mine = migrations.filter((m) => m.checkpoint === id);
    const commands = fencesOf(body).map((f) => f.body);
    const at = (command) => commands.flatMap((c, i) => (c === command ? [i] : []));
    let lastApply = -1;

    for (const { name, order, paths } of mine) {
      const applies = at(runsFile(paths.migration));
      const audits = at(runsFile(paths.audit));
      if (applies.length !== 1) {
        out.push(`checkpoint ${id}: ${name} is applied ${applies.length} times, expected once`);
        continue;
      }
      const [apply] = applies;
      if (!(audits[0] < apply)) out.push(`checkpoint ${id}: ${name} is not audited before it is applied`);
      if (!(audits.at(-1) > apply)) out.push(`checkpoint ${id}: ${name} is not audited again after it is applied`);
      if (apply < lastApply) out.push(`checkpoint ${id}: ${name} is applied before a migration it comes after`);
      lastApply = Math.max(lastApply, apply);
      if (!body.includes(`\`${paths.rollback}\``)) out.push(`checkpoint ${id}: the rollback file of ${name} is not named`);
      const page = paths.runbook.replace(/^docs\//, '');
      if (!body.includes(`](${page})`)) out.push(`checkpoint ${id}: the page of migration ${pad(order)} (${page}) is not linked`);
    }

    for (const command of commands) {
      const file = /--file (supabase\/(?:migrations|audits|rollbacks)\/\S+)/.exec(command)?.[1];
      if (file && !mine.some(({ paths }) => Object.values(paths).includes(file))) {
        out.push(`checkpoint ${id}: ${file} is not a file of a migration the manifest gives this checkpoint`);
      }
    }

    const ledgerRead = commands.findLastIndex((c) => c.includes('from app_private.app_migrations'));
    if (mine.length > 0 && ledgerRead < lastApply) out.push(`checkpoint ${id}: the ledger is not read after the last migration`);
  }

  // The commands, wherever they stand on the page and in whatever fence.
  for (const { body, h2, h3 } of fencesOf(text)) {
    if (FORBIDDEN.test(body)) out.push(`"${firstLine(body)}": a command the runbook forbids`);
    if (!CALLS_CLI.test(body)) continue;
    if (body.includes(LOCAL_ONLY)) {
      // A file of the review folder cannot be tested and is not in every
      // checkout: it may be offered, never be a step.
      if (!/^Optional\b/.test(h3 ?? '')) out.push(`"${firstLine(body)}": a file of ${LOCAL_ONLY} outside an "### Optional — …" step (under "${h3 ?? h2}")`);
    } else if (!onPages.has(body)) {
      out.push(`"${firstLine(body)}": not a command of a page under docs/runbook/`);
    }
  }

  return out;
}

// ------------------------------------------------------------
// The pages the index sends the owner to
// ------------------------------------------------------------
const filesUnder = (dir) => readdirSync(resolve(root, dir), { withFileTypes: true }).flatMap((entry) => (
  entry.isDirectory() ? filesUnder(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`]
));
const PAGES = filesUnder('docs/runbook').filter((file) => file.endsWith('.md')).sort();
const onPages = new Set(PAGES.flatMap((file) => fencesOf(read(file))).filter((f) => f.lang === 'bash').map((f) => f.body));
const real = { migrations: manifest.migrations, onPages };

describe(`${INDEX}: the checkpoints against the manifest`, () => {
  it('reads the table, the sections and the commands this test relies on', () => {
    const table = tableOf(index, 'Checkpoint');
    expect(table.map((row) => row.Checkpoint.replace(/\*/g, ''))).toEqual(
      ['A0', 'A1', 'A2', 'A3', 'B', 'C1', 'C2', 'D', 'E', 'F', 'G', 'Z'],
    );
    expect(Object.keys(table[0])).toEqual(expect.arrayContaining(['Checkpoint', 'Migrations', 'Hand-over']));
    expect(numbersIn('15–18, and 19 if pg_cron is enabled')).toEqual([15, 16, 17, 18, 19]);
    expect(numbersIn('27–30 and 32; 31 is optional')).toEqual([27, 28, 29, 30, 32, 31]);
    expect(numbersIn('—')).toEqual([]);
    // A parser that found no command at all would let every rule below pass.
    expect(onPages.size).toBeGreaterThan(8);
    expect(fencesOf(index).filter((f) => f.lang === 'bash').length).toBeGreaterThan(10);
    // A fence inside a list item, read without its indent.
    expect(fencesOf('1. Step\n\n   ```bash\n   one\n     two\n   ```\n')).toEqual([
      { lang: 'bash', h2: null, h3: null, body: 'one\n  two' },
    ]);
  });

  it('follows the manifest, gives each handed-over checkpoint its whole sequence, and only commands of a page', () => {
    expect(manifest.migrations.length).toBeGreaterThan(0);
    expect(indexProblems(index, real)).toEqual([]);
  });

  it('lists every migration number once, from 01 on, without a gap', () => {
    const numbers = tableOf(index, 'Checkpoint').flatMap((row) => numbersIn(row.Migrations));
    expect(numbers.filter((n, i) => numbers.indexOf(n) !== i)).toEqual([]);
    expect(numbers.length).toBeGreaterThanOrEqual(manifest.migrations.length);
    expect([...numbers].sort((a, b) => a - b)).toEqual(numbers.map((_, i) => i + 1));
  });

  it('hands over Checkpoint A0: marked ready, with the two migrations of wave 0', () => {
    const a0 = tableOf(index, 'Checkpoint').find((row) => row.Checkpoint.includes('A0'));
    expect(a0['Hand-over']).toContain('ready');
    expect(manifest.migrations.filter((m) => m.checkpoint === 'A0').map((m) => m.name)).toEqual([
      '2026_10_03_01_migration_ledger',
      '2026_10_03_02_rpc_auth_null_guard',
    ]);
    const section = sectionsOf(index).find(({ title }) => title.startsWith('Checkpoint A0 — '));
    expect(section, `${INDEX} has no "## Checkpoint A0 — …" section`).toBeTruthy();
    // The steps the plan gives the checkpoint besides the migrations.
    for (const page of ['runbook/20-auth-config.md', '../BACKUPS.md', 'runbook/00-before-you-start.md']) {
      expect(index, `${INDEX} does not link ${page}`).toContain(`](${page})`);
    }
    // Its backup is taken, checked and restored for practice with the three
    // commands of the 00 page, in that order.
    const backup = fencesOf(read('docs/runbook/00-before-you-start.md'))
      .map((f) => f.body)
      .filter((body) => body.includes('scripts/backup/'));
    expect(backup).toEqual(['dump', 'verify', 'drill'].map((name) => `node --env-file=.env scripts/backup/${name}.mjs`));
    expect(fencesOf(section.text).map((f) => f.body).filter((body) => body.includes('scripts/backup/'))).toEqual(backup);
  });
});

// The same judgement on indexes that are wrong, each in one way.
describe(`${INDEX}: what the test would catch`, () => {
  const [ledger, nullGuard] = manifest.migrations;
  const fence = (command) => `\`\`\`bash\n${command}\n\`\`\`\n`;
  const without = (text, piece) => {
    if (!text.includes(piece)) throw new Error(`the index no longer contains: ${piece}`);
    return text.replace(piece, '');
  };
  const swapped = (text, a, b) => {
    if (!text.includes(a) || !text.includes(b)) throw new Error('the index no longer contains what this case swaps');
    return text.replace(a, '\u0000').replace(b, a).replace('\u0000', b);
  };

  it('a migration applied without its audit first', () => {
    const wrong = without(index, fence(runsFile(ledger.paths.audit)));
    expect(indexProblems(wrong, real)).toEqual([
      'checkpoint A0: 2026_10_03_01_migration_ledger is not audited before it is applied',
    ]);
  });

  it('a migration that is not audited again afterwards', () => {
    const audit = fence(runsFile(nullGuard.paths.audit));
    const wrong = index.slice(0, index.lastIndexOf(audit)) + index.slice(index.lastIndexOf(audit) + audit.length);
    expect(indexProblems(wrong, real)).toEqual([
      'checkpoint A0: 2026_10_03_02_rpc_auth_null_guard is not audited again after it is applied',
    ]);
  });

  it('a migration that is never applied, or applied out of order', () => {
    expect(indexProblems(without(index, fence(runsFile(nullGuard.paths.migration))), real)).toEqual([
      'checkpoint A0: 2026_10_03_02_rpc_auth_null_guard is applied 0 times, expected once',
    ]);
    const wrong = swapped(index, runsFile(ledger.paths.migration), runsFile(nullGuard.paths.migration));
    expect(indexProblems(wrong, real)).toContain(
      'checkpoint A0: 2026_10_03_02_rpc_auth_null_guard is applied before a migration it comes after',
    );
  });

  it('a rollback or a page that is not named, a ledger that is not read', () => {
    expect(indexProblems(index.replaceAll(`\`${nullGuard.paths.rollback}\``, 'the rollback file'), real)).toEqual([
      'checkpoint A0: the rollback file of 2026_10_03_02_rpc_auth_null_guard is not named',
    ]);
    expect(indexProblems(index.replaceAll('](runbook/migrations/01-migration-ledger.md)', '](#)'), real)).toEqual([
      'checkpoint A0: the page of migration 01 (runbook/migrations/01-migration-ledger.md) is not linked',
    ]);
    const a0 = sectionsOf(index).find(({ title }) => title.startsWith('Checkpoint A0 — ')).text;
    const noLedger = index.replace(a0, a0.replaceAll('from app_private.app_migrations', 'from somewhere_else'));
    expect(indexProblems(noLedger, real)).toContain('checkpoint A0: the ledger is not read after the last migration');
  });

  it('a migration the manifest adds to a checkpoint that is handed over', () => {
    const third = {
      name: '2026_10_04_03_function_grants_lockdown',
      order: 3,
      checkpoint: 'A0',
      paths: {
        migration: 'supabase/migrations/2026_10_04_03_function_grants_lockdown.sql',
        audit: 'supabase/audits/2026_10_04_03_function_grants_lockdown.audit.sql',
        rollback: 'supabase/rollbacks/2026_10_04_03_function_grants_lockdown.down.sql',
        runbook: 'docs/runbook/migrations/03-function-grants-lockdown.md',
      },
    };
    expect(indexProblems(index, { ...real, migrations: [...manifest.migrations, third] })).toEqual([
      '2026_10_04_03_function_grants_lockdown: the row of checkpoint A0 does not list migration 03',
      'checkpoint A0: 2026_10_04_03_function_grants_lockdown is applied 0 times, expected once',
    ]);
    // At the checkpoint the plan gave it, and not handed over yet: nothing to say.
    expect(indexProblems(index, { ...real, migrations: [...manifest.migrations, { ...third, checkpoint: 'A1' }] })).toEqual([]);
  });

  it('a migration the manifest moves to another checkpoint', () => {
    const moved = [ledger, { ...nullGuard, checkpoint: 'A1' }];
    expect(indexProblems(index, { ...real, migrations: moved })).toEqual([
      '2026_10_03_02_rpc_auth_null_guard: the row of checkpoint A1 does not list migration 02',
      `checkpoint A0: ${nullGuard.paths.audit} is not a file of a migration the manifest gives this checkpoint`,
      `checkpoint A0: ${nullGuard.paths.migration} is not a file of a migration the manifest gives this checkpoint`,
      `checkpoint A0: ${nullGuard.paths.audit} is not a file of a migration the manifest gives this checkpoint`,
    ]);
    expect(indexProblems(index, { ...real, migrations: [ledger, { ...nullGuard, checkpoint: 'Q' }] })).toContain(
      '2026_10_03_02_rpc_auth_null_guard: the table has no row for checkpoint Q',
    );
  });

  it('a checkpoint marked ready without its sequence, and the reverse', () => {
    const lines = index.split('\n');
    const row = (id) => lines.findIndex((line) => new RegExp(`^\\| \\**${id}\\** \\|`).test(line));
    const edited = (id, change) => lines.map((line, i) => (i === row(id) ? change(line) : line)).join('\n');
    expect(indexProblems(edited('A1', (line) => line.replace('with wave 1', '**ready**')), real)).toEqual([
      'checkpoint A1 is marked ready and has no "## Checkpoint A1 — …" section',
    ]);
    expect(indexProblems(edited('A0', (line) => line.replace('**ready**', 'with wave 0')), real)).toEqual([
      'checkpoint A0 has a section and is not marked ready in the table',
    ]);
    expect(indexProblems(index.replace('## Checkpoint A0 — ', '## Checkpoint A9 — '), real)).toEqual([
      'checkpoint A0 is marked ready and has no "## Checkpoint A0 — …" section',
      '"## Checkpoint A9 — …" is not a row of the table',
    ]);
    expect(indexProblems(index.replace('| Checkpoint |', '| Sitting |'), real)).toEqual([
      'no checkpoint table (a header row that starts "| Checkpoint |")',
    ]);
  });

  it('a command of its own, and a command the runbook forbids', () => {
    const own = 'supabase db query --linked "delete from public.notifications"';
    expect(indexProblems(`${index}\n${fence(own)}`, real)).toEqual([
      `"${own}": not a command of a page under docs/runbook/`,
    ]);
    // One character away from a command a page gives.
    const near = runsFile(ledger.paths.audit).replace('--linked', '--local');
    expect(indexProblems(`${index}\n${fence(near)}`, real)).toEqual([
      `"${near}": not a command of a page under docs/runbook/`,
    ]);
    // A backup command no page gives: the restore, which writes.
    const restore = 'node --env-file=.env scripts/backup/restore.mjs --db-url "$SUPABASE_DB_URL"';
    expect(indexProblems(`${index}\n${fence(restore)}`, real)).toEqual([
      `"${restore}": not a command of a page under docs/runbook/`,
    ]);
    for (const command of ['supabase db push', 'supabase config push', 'supabase migration repair --status applied 01']) {
      expect(indexProblems(`${index}\n${fence(command)}`, real)).toContain(`"${command}": a command the runbook forbids`);
    }
    // Named in a sentence, to forbid it: not a command.
    expect(indexProblems(`${index}\nNever \`supabase db push\`.\n`, real)).toEqual([]);
  });

  it('a command in a fence that is not tagged bash', () => {
    const tagged = (lang, command) => `\`\`\`${lang}\n${command}\n\`\`\`\n`;
    const step = '### Step 6 — say that it is done';
    const before = (text, piece) => {
      if (!text.includes(step)) throw new Error(`the index no longer contains: ${step}`);
      return text.replace(step, `${piece}\n${step}`);
    };
    // Untagged, inside the checkpoint that is handed over.
    const own = 'supabase db query --linked "delete from public.notifications"';
    expect(indexProblems(before(index, tagged('', own)), real)).toEqual([
      `"${own}": not a command of a page under docs/runbook/`,
    ]);
    for (const lang of ['', 'sh', 'console', 'text']) {
      expect(indexProblems(`${index}\n${tagged(lang, 'supabase db push')}`, real)).toEqual([
        '"supabase db push": a command the runbook forbids',
        '"supabase db push": not a command of a page under docs/runbook/',
      ]);
    }
    // Behind another word on its line.
    expect(indexProblems(`${index}\n${tagged('bash', 'npx supabase db push')}`, real)).toEqual([
      '"npx supabase db push": a command the runbook forbids',
      '"npx supabase db push": not a command of a page under docs/runbook/',
    ]);
    // The sequence of a checkpoint is read the same way: a second apply does
    // not hide in an untagged fence…
    expect(indexProblems(before(index, tagged('', runsFile(nullGuard.paths.migration))), real)).toEqual([
      'checkpoint A0: 2026_10_03_02_rpc_auth_null_guard is applied 2 times, expected once',
    ]);
    // …and a page whose fences are all tagged otherwise is the same page.
    expect(indexProblems(index.replaceAll('```bash', '```sh'), real)).toEqual([]);
    // A path is not a call.
    expect(indexProblems(`${index}\n${tagged('', 'ls supabase/migrations')}`, real)).toEqual([]);
  });

  it('a file of the review folder as a step', () => {
    const cleanup = fencesOf(index).find((f) => f.body.includes(LOCAL_ONLY) && /^supabase\s/.test(f.body));
    expect(cleanup?.h3).toMatch(/^Optional — /);
    const wrong = index.replace(`### ${cleanup.h3}`, '### Step 7 — remove what the first run left');
    expect(indexProblems(wrong, real)).toEqual([
      `"${cleanup.body}": a file of ${LOCAL_ONLY} outside an "### Optional — …" step (under "Step 7 — remove what the first run left")`,
    ]);
  });
});

describe(`${INDEX}: what it points at`, () => {
  // `path` spans that name a file the owner is sent to run or to read.
  const named = [...new Set([...index.matchAll(/`([^`\n]+)`/g)].map(([, span]) => span))]
    .filter((span) => /^(?:supabase\/(?:migrations|audits|rollbacks)|docs|src|\.github)\/[\w./-]+$/.test(span));
  const links = [...new Set([...index.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)].map(([, target]) => target))];

  it('names files that exist', () => {
    expect(named.length).toBeGreaterThan(5);
    expect(named.filter((file) => !existsSync(resolve(root, file)))).toEqual([]);
  });

  it('links pages that exist', () => {
    expect(links.length).toBeGreaterThan(4);
    expect(links.filter((target) => !existsSync(resolve(root, 'docs', target)))).toEqual([]);
  });

  it('says of the review folder what is true: git ignores it', () => {
    expect(index).toContain(LOCAL_ONLY);
    expect(read('.gitignore').split('\n')).toContain(LOCAL_ONLY);
  });

  // A backup holds every athlete's data and the accounts, and the repository
  // is public: a file in the working tree is one `git add -A` away from being
  // published. The script writes to ~/sl_app-backups and refuses a path
  // inside the checkout (supabase/tests/backup-roundtrip.test.js holds that);
  // what is held here is that no page asks for one, and that no page still
  // takes a backup the old way — a pg_dump that needs Docker and writes
  // wherever `-f` points.
  it('never has a backup written into the checkout', () => {
    const everything = [...PAGES.map(read), index, read('BACKUPS.md')];
    const commands = everything
      .flatMap((text) => fencesOf(text))
      .flatMap((f) => f.body.split('\n'))
      .filter((line) => /scripts\/backup\/dump\.mjs|\bbackup:dump\b/.test(line));
    expect(commands.length).toBeGreaterThan(2);
    const targets = commands.flatMap((line) => / --out[= ](\S+)/.exec(line)?.[1] ?? []);
    expect(targets.filter((target) => !/^(?:~\/|"?\$HOME\/)/.test(target))).toEqual([]);
    for (const text of everything) expect(text).not.toMatch(/supabase db dump/);
    // And the net under it, for a file that lands there anyway.
    const ignored = read('.gitignore').split('\n');
    for (const pattern of ['*.jsonl.gz*', 'backup-*.sql', '*-backup-*.sql', '/schema.sql', '/data.sql', 'dump.tar.gz*']) {
      expect(ignored, `.gitignore does not ignore ${pattern}`).toContain(pattern);
    }
  });

  // The nightly backup. Until October 2026 BACKUPS.md described a set-up that
  // could not produce a dump, and the index said not to follow it. The
  // workflow now runs the script the owner runs by hand, so the three places
  // must agree on what is left to do: two secrets, by name, set once the
  // workflow of this branch is on GitHub — the owner asked for that as an
  // explicit step, and a run without them is red.
  it('gives the nightly backup the same place in the index, in BACKUPS.md and in the workflow', () => {
    const backups = read('BACKUPS.md');
    const workflow = read('.github/workflows/backup.yml');
    // The notice went with the command it was about.
    expect(backups).not.toContain('Not working yet');
    expect(workflow).toContain('node scripts/backup/dump.mjs');
    expect(workflow).toContain('node scripts/backup/verify.mjs');

    const checklist = sectionsOf(index).find(({ title }) => title === 'First-push checklist')?.text;
    expect(checklist, `${INDEX} has no "## First-push checklist" section`).toBeTruthy();
    const nightly = sectionsOf(backups).find(({ title }) => title === 'The nightly run on GitHub')?.text;
    expect(nightly, 'BACKUPS.md has no "## The nightly run on GitHub" section').toBeTruthy();
    for (const secret of ['SUPABASE_DB_URL', 'BACKUP_PASSPHRASE']) {
      expect(workflow, `backup.yml does not read the secret ${secret}`).toContain(`secrets.${secret}`);
      expect(checklist, `the first-push checklist does not name ${secret}`).toContain(`\`${secret}\``);
      expect(nightly, `BACKUPS.md does not say what ${secret} is`).toContain(`\`${secret}\``);
    }
    expect(checklist).toContain('](../BACKUPS.md)');
    // Which role the connection string belongs to is said where it is asked for.
    expect(nightly).toMatch(/`postgres` role/);
    expect(nightly).toContain('session-pooler');

    // Not at Checkpoint A0: the workflow that reads the secrets is not on
    // GitHub before the first push, and the one that is there would use them
    // for another command.
    const a0 = sectionsOf(index).find(({ title }) => title.startsWith('Checkpoint A0 — ')).text;
    expect(a0).toContain('The nightly backup on GitHub is not set up at this checkpoint');
    expect(a0).not.toMatch(/Secrets and variables/);
    expect(nightly).toContain('once the workflow of this page is on the default branch');
    // The page of the backup sends to both.
    const page = read('docs/runbook/00-before-you-start.md');
    expect(page).toContain('*The nightly run on GitHub*');
    expect(page).toContain('first-push checklist');
  });

  // The four Auth values are written on the page of the step, in
  // docs/ENVIRONMENT.md and in the index. The page is the one a test runs.
  it('gives the Auth values of docs/runbook/20-auth-config.md, as docs/ENVIRONMENT.md does', () => {
    const page = tableOf(read('docs/runbook/20-auth-config.md'), 'Setting (API name)');
    const wanted = Object.fromEntries(page.map((row) => [row['Setting (API name)'].replace(/`/g, ''), row.Wanted]));
    expect(Object.keys(wanted)).toEqual(['disable_signup', 'site_url', 'uri_allow_list', 'password_min_length']);
    const a0 = sectionsOf(index).find(({ title }) => title.startsWith('Checkpoint A0 — ')).text;
    const environment = read('docs/ENVIRONMENT.md');
    for (const setting of ['site_url', 'uri_allow_list', 'password_min_length']) {
      expect(wanted[setting]).toMatch(/^`[^`]+`$/);
      const inTable = (text) => text.split('\n').some((line) => line.trimStart().startsWith('|') && line.includes(`| ${wanted[setting]}`));
      expect(inTable(a0), `${INDEX}, Checkpoint A0: no table row gives ${setting} = ${wanted[setting]}`).toBe(true);
      expect(inTable(environment), `docs/ENVIRONMENT.md: no table row gives ${setting} = ${wanted[setting]}`).toBe(true);
    }
  });
});
