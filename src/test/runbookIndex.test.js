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
//   - the sequence of a checkpoint that is handed over — marked **ready**, or
//     **done** once it has been run: every migration of the manifest, in
//     order, audited before and after, its rollback and its page named, the
//     ledger read at the end, and a backup before the first statement;
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
// (`supabase/migrations/…`) is not a call. The backup scripts and the check of
// the ledger count as well: they connect to production with the database
// password.
const CALLS_CLI = /\bsupabase\s|\bscripts\/(?:backup\/|check-migrations\.mjs)/;

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
    state: /\b(done|ready)\b/.exec(row['Hand-over'] ?? '')?.[1] ?? null,
  }]));

  // The table against the manifest.
  for (const { name, checkpoint, order } of migrations) {
    const row = rows.get(checkpoint);
    if (!row) out.push(`${name}: the table has no row for checkpoint ${checkpoint}`);
    else if (!row.numbers.includes(order)) out.push(`${name}: the row of checkpoint ${checkpoint} does not list migration ${pad(order)}`);
  }

  // A checkpoint is handed over when it is marked ready — or done, once it has
  // been run — AND has its sequence.
  const sections = new Map();
  for (const { title, text: body } of sectionsOf(text)) {
    const id = /^Checkpoint (\w+) — /.exec(title)?.[1];
    if (id) sections.set(id, body);
  }
  for (const [id, row] of rows) {
    if (row.state && !sections.has(id)) out.push(`checkpoint ${id} is marked ${row.state} and has no "## Checkpoint ${id} — …" section`);
    if (!row.state && sections.has(id)) out.push(`checkpoint ${id} has a section and is marked neither ready nor done in the table`);
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

    // A backup, taken and checked, before the first statement that writes.
    const firstApply = commands.findIndex((c) => mine.some(({ paths }) => c === runsFile(paths.migration)));
    for (const script of ['dump', 'verify']) {
      const taken = commands.findIndex((c) => c.includes(`scripts/backup/${script}.mjs`));
      if (firstApply !== -1 && !(taken !== -1 && taken < firstApply)) out.push(`checkpoint ${id}: no backup (${script}.mjs) before its first migration`);
    }
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

  // Checkpoint A0 was run on 2026-10-11. Its row says so and its section
  // stays: it is the record of what production has, and the sequences after it
  // are written against it.
  it('records Checkpoint A0 as done, with the two migrations of wave 0 and its sequence kept', () => {
    const a0 = tableOf(index, 'Checkpoint').find((row) => row.Checkpoint.includes('A0'));
    expect(a0['Hand-over']).toMatch(/\*\*done\*\* on 2026-10-11/);
    expect(a0['Hand-over']).not.toMatch(/\bready\b/);
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

  // Wave 1: twelve migrations in three sittings. Which migration goes in
  // which is the manifest's; what is held here is that the index hands all
  // three over, in that order, and that each sitting is the sequence the owner
  // was promised: a backup of the day, then for each migration its audit, the
  // migration and the audit again — one command per fence, no fence between
  // the audit and the apply of the same migration — and the ledger at the end.
  describe('hands over the three checkpoints of wave 1', () => {
    const WAVE_1 = {
      A1: [3],
      A2: [4, 5, 6, 7, 8, 9, 10],
      A3: [11, 12, 13, 14],
    };
    const table = tableOf(index, 'Checkpoint');
    const state = (id) => table.find((row) => row.Checkpoint.replace(/\*/g, '') === id)['Hand-over'];
    const sectionOf = (id) => sectionsOf(index).find(({ title }) => title.startsWith(`Checkpoint ${id} — `));
    const dump = 'node --env-file=.env scripts/backup/dump.mjs';
    const verify = 'node --env-file=.env scripts/backup/verify.mjs';
    const ledgerRead = 'supabase db query --linked "select name, applied_at from app_private.app_migrations order by applied_at, name"';

    it('marks A1, A2 and A3 ready — or done with its date, once it was run — and nothing after them', () => {
      // Ready until the sitting, done from then on: the day a checkpoint is
      // run its row is rewritten as the row of A0 was, and that record must
      // not be what turns this file red. What holds either way: a done one
      // says when, and none is done after one that is still to run.
      const states = Object.keys(WAVE_1).map((id) => /\*\*(?:ready|done)\*\*/.exec(state(id))?.[0] ?? `${id}: ${state(id)}`);
      expect(states.join(' ')).toMatch(/^(?:\*\*done\*\* ?)*(?:\*\*ready\*\* ?)*$/);
      for (const id of Object.keys(WAVE_1)) {
        if (/\bdone\b/.test(state(id))) expect(state(id), `checkpoint ${id}`).toMatch(/^\*\*done\*\* on \d{4}-\d\d-\d\d\b/);
      }
      for (const id of ['B', 'C1', 'C2', 'D', 'E', 'F', 'G', 'Z']) expect(state(id), `checkpoint ${id}`).not.toMatch(/\b(?:ready|done)\b/);
      // The sections stand in the order they are run.
      const order = sectionsOf(index).map(({ title }) => /^Checkpoint (\w+) — /.exec(title)?.[1]).filter(Boolean);
      expect(order).toEqual(['A0', 'A1', 'A2', 'A3']);
    });

    it.each(Object.entries(WAVE_1))('Checkpoint %s holds the migrations the manifest gives it, each as audit, apply, audit', (id, numbers) => {
      const mine = manifest.migrations.filter((m) => m.checkpoint === id);
      expect(mine.map((m) => m.order)).toEqual(numbers);
      expect(mine.every((m) => m.wave === 1 && m.kind === 'required')).toBe(true);

      const section = sectionOf(id);
      expect(section, `${INDEX} has no "## Checkpoint ${id} — …" section`).toBeTruthy();
      const commands = fencesOf(section.text).map((f) => f.body);

      // The backup opens the sitting: taken, then checked, before anything else is run against a file.
      expect(commands.filter((c) => c.includes('scripts/backup/'))).toEqual([dump, verify]);
      const firstFile = commands.findIndex((c) => c.includes(' --file '));
      expect(commands.indexOf(dump)).toBeLessThan(commands.indexOf(verify));
      expect(commands.indexOf(verify)).toBeLessThan(firstFile);

      // Every file command of the section, in order: nothing else, nothing twice, nothing in between.
      const files = commands.filter((c) => c.includes(' --file '));
      expect(files).toEqual(mine.flatMap(({ paths }) => [runsFile(paths.audit), runsFile(paths.migration), runsFile(paths.audit)]));
      for (const { name, paths } of mine) {
        const at = commands.indexOf(runsFile(paths.migration));
        expect(commands[at - 1], `${name}: the fence before its apply`).toBe(runsFile(paths.audit));
        expect(commands[at + 1], `${name}: the fence after its apply`).toBe(runsFile(paths.audit));
      }

      // The ledger is read once the last migration is audited, and the step says how many rows it must hold.
      expect(commands.lastIndexOf(ledgerRead)).toBeGreaterThan(commands.lastIndexOf(runsFile(mine.at(-1).paths.audit)));
      const rows = ['zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen'][numbers.at(-1)];
      expect(section.text).toContain(`${rows} rows`);
      expect(section.text).toContain(`the last one \`${mine.at(-1).name}\``);

      // Every migration of the sitting says what stops it, and no rollback is a step.
      for (const { order } of mine) {
        const step = section.text.split(/^### /m).find((part) => new RegExp(`\\bmigration ${pad(order)}\\b`).test(part.split('\n')[0]));
        expect(step, `checkpoint ${id}: no "### Step … migration ${pad(order)}" heading`).toBeTruthy();
        expect(step, `migration ${pad(order)}: its step does not say what stops the sequence`).toMatch(/\*\*Stops/);
      }
      expect(commands.filter((c) => c.includes('supabase/rollbacks/'))).toEqual([]);
    });

    // The two migrations that change privileges for every request are looked
    // at from outside before anything follows them: as a request without a
    // session, which must be refused, and as a signed-in user, who must not.
    it.each([
      ['A1', 3, 'permission denied for function student_profile_for_slot'],
      ['A3', 14, 'permission denied for table profiles'],
    ])('Checkpoint %s tries migration %i as anon and as a signed-in user, with the checks of its page', (id, order, refusal) => {
      const { paths } = manifest.migrations.find((m) => m.order === order);
      const page = fencesOf(read(paths.runbook)).map((f) => f.body);
      const asAnon = page.find((c) => c.includes('set local role anon'));
      const asUser = page.find((c) => c.includes('set local role authenticated'));
      expect(asAnon).toBeTruthy();
      expect(asUser).toBeTruthy();
      const section = sectionOf(id);
      const commands = fencesOf(section.text).map((f) => f.body);
      const applied = commands.indexOf(runsFile(paths.migration));
      expect(commands.indexOf(asAnon)).toBeGreaterThan(applied);
      expect(commands.indexOf(asUser)).toBeGreaterThan(commands.indexOf(asAnon));
      expect(section.text).toContain(`\`${refusal}\``);
      // …and then in the app that is deployed, with both kinds of account.
      expect(section.text).toMatch(/^### Step \d+ — the app that is deployed, as an athlete and as the coach$/m);
    });

    it('lets Checkpoint A2 start only after the look at the app that ends A1', () => {
      expect(sectionOf('A1').text).toContain('Checkpoint A2 starts only then.');
    });

    // A section of a page that a step sends to by its name: the name is a
    // heading of a page, so a heading that is reworded is noticed here.
    it('names sections of the pages by headings they have', () => {
      const headings = new Set(PAGES.flatMap((file) => sectionsOf(read(file)).map(({ title }) => title)));
      const scope = [...Object.keys(WAVE_1).map((id) => sectionOf(id).text),
        sectionsOf(index).find(({ title }) => title === 'By hand in the SQL editor, from these checkpoints on')?.text];
      expect(scope.every(Boolean)).toBe(true);
      const quoted = [...new Set(scope.flatMap((text) => [...text.matchAll(/"([A-Z][^"`\n]{7,})"/g)].map(([, name]) => name)))];
      expect(quoted.length).toBeGreaterThan(15);
      expect(quoted.filter((name) => !headings.has(name))).toEqual([]);
    });

    // After A3 the app is published for the first time. Which commit, and the
    // question the deploy will ask, are part of the sitting.
    it('says in Checkpoint A3 which app may be published, and asks the deploy gate first', () => {
      const a3 = sectionOf('A3');
      const commands = fencesOf(a3.text).map((f) => f.body);
      const gate = 'node --env-file=.env scripts/check-migrations.mjs --verify';
      expect(fencesOf(read('docs/runbook/40-deploy.md')).map((f) => f.body)).toContain(gate);
      expect(commands.indexOf(gate)).toBeGreaterThan(commands.lastIndexOf(ledgerRead));
      const required = manifest.migrations.filter((m) => m.kind === 'required' && m.wave <= 1).length;
      expect(a3.text).toContain(`OK: production has all ${required} required migrations of this commit. The deploy can go on.`);
      expect(a3.text).toMatch(/the head of wave 1, and no later one/);
      expect(a3.text).toContain('](#first-push-checklist)');
    });
  });

  // Who pastes the commands. The owner asked Claude to apply the migrations
  // of the checkpoints for him; what he did not hand over is asked each time,
  // and the index is where an agent that runs a checkpoint reads the limit.
  it('says who runs a checkpoint, and what is asked again every time', () => {
    const who = sectionsOf(index).find(({ title }) => title === 'Who runs a checkpoint')?.text;
    expect(who, `${INDEX} has no "## Who runs a checkpoint" section`).toBeTruthy();
    expect(fencesOf(who)).toEqual([]);
    const [, notCovered] = who.split('What that answer does not cover');
    expect(notCovered).toBeTruthy();
    for (const asked of [/`optional` or a `contract` migration: 19, 31, and 43 to 45/, /pushing to `main`/, /Edge Function/, /pg_cron/, /GitHub secret/]) {
      expect(notCovered).toMatch(asked);
    }
    // A statement of a page that changes rows of the app is not a migration:
    // the list is read and passed on, and the write waits for the owner.
    expect(notCovered).toMatch(/writes or deletes rows of the app/);
    expect(notCovered).toMatch(/writes nothing until you have answered/);
    // The migrations of wave 1 whose page has such a statement, by number.
    for (const order of ['05', '07', '08', '10', '11']) expect(notCovered, `migration ${order}`).toContain(`(${order})`);
    // What it holds to: the conditions of the standing answer.
    for (const condition of [/fresh backup first/, /audit before and after each migration/, /one migration at a time/, /stops at the first line/, /rollback file/]) {
      expect(who.split('What that answer does not cover')[0]).toMatch(condition);
    }
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
    // The first migration of wave 2, as a later package will add it.
    const next = {
      name: '2026_10_20_15_push_plumbing',
      order: 15,
      checkpoint: 'A3',
      paths: {
        migration: 'supabase/migrations/2026_10_20_15_push_plumbing.sql',
        audit: 'supabase/audits/2026_10_20_15_push_plumbing.audit.sql',
        rollback: 'supabase/rollbacks/2026_10_20_15_push_plumbing.down.sql',
        runbook: 'docs/runbook/migrations/15-push-plumbing.md',
      },
    };
    expect(indexProblems(index, { ...real, migrations: [...manifest.migrations, next] })).toEqual([
      '2026_10_20_15_push_plumbing: the row of checkpoint A3 does not list migration 15',
      'checkpoint A3: 2026_10_20_15_push_plumbing is applied 0 times, expected once',
    ]);
    // At the checkpoint the plan gave it, and not handed over yet: nothing to say.
    expect(indexProblems(index, { ...real, migrations: [...manifest.migrations, { ...next, checkpoint: 'B' }] })).toEqual([]);
  });

  it('a migration the manifest moves to another checkpoint', () => {
    const movedTo = (checkpoint) => manifest.migrations.map((m) => (m === nullGuard ? { ...m, checkpoint } : m));
    // To one that is not handed over: its row does not list it, and the
    // sequence it was in runs files that are no longer its own.
    expect(indexProblems(index, { ...real, migrations: movedTo('B') })).toEqual([
      '2026_10_03_02_rpc_auth_null_guard: the row of checkpoint B does not list migration 02',
      `checkpoint A0: ${nullGuard.paths.audit} is not a file of a migration the manifest gives this checkpoint`,
      `checkpoint A0: ${nullGuard.paths.migration} is not a file of a migration the manifest gives this checkpoint`,
      `checkpoint A0: ${nullGuard.paths.audit} is not a file of a migration the manifest gives this checkpoint`,
    ]);
    // To one that is: that sequence does not apply it either.
    expect(indexProblems(index, { ...real, migrations: movedTo('A2') })).toEqual([
      '2026_10_03_02_rpc_auth_null_guard: the row of checkpoint A2 does not list migration 02',
      `checkpoint A0: ${nullGuard.paths.audit} is not a file of a migration the manifest gives this checkpoint`,
      `checkpoint A0: ${nullGuard.paths.migration} is not a file of a migration the manifest gives this checkpoint`,
      `checkpoint A0: ${nullGuard.paths.audit} is not a file of a migration the manifest gives this checkpoint`,
      'checkpoint A2: 2026_10_03_02_rpc_auth_null_guard is applied 0 times, expected once',
    ]);
    expect(indexProblems(index, { ...real, migrations: movedTo('Q') })).toContain(
      '2026_10_03_02_rpc_auth_null_guard: the table has no row for checkpoint Q',
    );
  });

  it('a sequence that starts without a backup, or takes it after the first migration', () => {
    const a2 = sectionsOf(index).find(({ title }) => title.startsWith('Checkpoint A2 — ')).text;
    const dump = fence('node --env-file=.env scripts/backup/dump.mjs');
    const verify = fence('node --env-file=.env scripts/backup/verify.mjs');
    expect(indexProblems(index.replace(a2, without(a2, verify)), real)).toEqual([
      'checkpoint A2: no backup (verify.mjs) before its first migration',
    ]);
    // Both moved to the end of the sitting.
    const late = `${without(without(a2, dump), verify)}\n${dump}\n${verify}`;
    expect(indexProblems(index.replace(a2, late), real)).toEqual([
      'checkpoint A2: no backup (dump.mjs) before its first migration',
      'checkpoint A2: no backup (verify.mjs) before its first migration',
    ]);
  });

  it('a checkpoint marked ready or done without its sequence, and the reverse', () => {
    const lines = index.split('\n');
    const row = (id) => lines.findIndex((line) => new RegExp(`^\\| \\**${id}\\** \\|`).test(line));
    const edited = (id, change) => lines.map((line, i) => (i === row(id) ? change(line) : line)).join('\n');
    const changed = (id, from, to) => {
      if (!lines[row(id)]?.includes(from)) throw new Error(`the row of checkpoint ${id} no longer contains: ${from}`);
      return edited(id, (line) => line.replace(from, to));
    };
    // The last cell of a row is its hand-over, whatever it reads today: A1 is
    // ready until it is run and done afterwards, and these cases hold for both.
    const handedOver = (id, to) => {
      if (!/\|[^|]*\|\s*$/.test(lines[row(id)] ?? '')) throw new Error(`the table no longer has a row for checkpoint ${id}`);
      return edited(id, (line) => line.replace(/\|[^|]*\|\s*$/, `| ${to} |`));
    };
    expect(indexProblems(changed('B', 'with wave 2', '**ready**'), real)).toEqual([
      'checkpoint B is marked ready and has no "## Checkpoint B — …" section',
    ]);
    expect(indexProblems(handedOver('A1', 'with wave 1'), real)).toEqual([
      'checkpoint A1 has a section and is marked neither ready nor done in the table',
    ]);
    // Done is not a way out of the sequence: the record stays on the page.
    expect(indexProblems(handedOver('A1', '**done** on 2026-10-14').replace('## Checkpoint A1 — ', '## Sitting A1 — '), real)).toEqual([
      'checkpoint A1 is marked done and has no "## Checkpoint A1 — …" section',
    ]);
    expect(indexProblems(index.replace('## Checkpoint A0 — ', '## Checkpoint A9 — '), real)).toEqual([
      'checkpoint A0 is marked done and has no "## Checkpoint A0 — …" section',
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
    // The check of the ledger connects to production as well: as its page
    // gives it, wherever the index asks for it, and in no other form.
    const gate = 'node --env-file=.env scripts/check-migrations.mjs --verify';
    expect(onPages.has(gate)).toBe(true);
    expect(indexProblems(`${index}\n${fence(gate)}`, real)).toEqual([]);
    const gateWithUrl = `SUPABASE_DB_URL="$PRODUCTION_URL" ${gate.replace(' --env-file=.env', '')}`;
    expect(indexProblems(`${index}\n${fence(gateWithUrl)}`, real)).toEqual([
      `"${gateWithUrl}": not a command of a page under docs/runbook/`,
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

  // Nothing of the review is pushed before Checkpoint A3, so no job of the
  // gate has run on GitHub when the first publication depends on all of them.
  // The checklist says what each must show on that first run. The database
  // suite is the one whose green meant nothing for a while (its process ended
  // with status 0 whatever the tests said — src/test/dbSuiteExitCode.test.js),
  // so its item says what the log reads, not only the colour.
  it('asks, on the first run after the push, for each job of the gate', () => {
    const checklist = sectionsOf(index).find(({ title }) => title === 'First-push checklist')?.text;
    const jobsOf = (file) => [...read(file).split(/^jobs:$/m)[1].matchAll(/^ {2}([a-z][\w-]*):$/gm)].map(([, name]) => name);
    expect(jobsOf('.github/workflows/test.yml')).toEqual(['test', 'db', 'functions']);
    expect(jobsOf('.github/workflows/deploy.yml')).toContain('migrations');
    for (const name of ['migrations', 'test', 'db', 'functions']) {
      expect(checklist, `the first-push checklist has no item for the job ${name}`).toMatch(new RegExp(`^\\d+\\. Job \`${name}\``, 'm'));
    }
    const db = checklist.split('\n').find((line) => /^\d+\. Job `db`/.test(line));
    expect(db).toContain('`npm run test:db`');
    expect(db).toMatch(/`Test Files {2}\d+ passed \(\d+\)`/);
  });

  // The publication of Checkpoint A3 names one commit by the subject it was
  // written under. `git log --grep` returns the newest match, so the subject
  // is given whole and closed with `$`: a later commit that begins with the
  // same words — the one that records the checkpoints as done — cannot take
  // its place. And the deploy's question is asked with that commit checked
  // out: the script reads the migrations of the checkout it runs in.
  it('finds the commit to publish by its whole subject, and asks the deploy gate on that commit', () => {
    const a3 = sectionsOf(index).find(({ title }) => title.startsWith('Checkpoint A3 — ')).text;
    const find = fencesOf(a3).map((f) => f.body).filter((body) => body.startsWith('git log '));
    expect(find).toHaveLength(1);
    expect(find[0]).toMatch(/^git log -1 --format='%H %s' --grep='\^docs\(runbook\): [^']+\$'$/);
    expect(a3).toMatch(/With that commit checked out, ask the question the deploy will ask/);
    expect(a3).toMatch(/reports them `MISSING`/);
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
