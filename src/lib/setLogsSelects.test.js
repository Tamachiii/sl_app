// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

// `set_logs.weight_kg` was the athlete's logged load until the actuals
// (`actual_weight_kg`, `actual_reps`) replaced it; nothing has written it
// since, so a read of it is null on every set logged after that — the lifetime
// volume of the Profile page read it and counted 5 × 5 at 100 kg as 25. No
// read of `set_logs` names it: the column stays only to be dropped.
//
// What is read: every `.select(…)` chained on `.from('set_logs')`, and every
// `set_logs(…)` embed inside any select (`set_logs!inner(…)`, an alias
// `set_log:set_logs!inner(…)`), with a select held in a constant resolved —
// `volumeSelect`, `SLOT_LOG_COLUMNS`, `${LOGGED_SET_COLUMNS}`. Only the columns
// of `set_logs` itself are looked at: an embed of `exercise_slots` inside a
// set_logs read names that table's `weight_kg`, and goal and bodyweight rows
// have one of their own. `select('*')` and `select()` cannot be seen and pass.

const root = resolve(__dirname, '../..');
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return /\.(js|jsx)$/.test(entry.name) && !/\.test\.(js|jsx)$/.test(entry.name) ? [path] : [];
  });

// Code only: a comment may well quote the column it explains.
const codeOf = (text) =>
  text
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join('\n');

// The text inside the parenthesis that opens at `open`, quotes respected.
function inside(text, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === quote && text[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

// The first argument of a call's argument list.
function firstArgument(args) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < args.length; i += 1) {
    const c = args[i];
    if (quote) {
      if (c === quote && args[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) depth -= 1;
    else if (c === ',' && depth === 0) return args.slice(0, i).trim();
  }
  return args.trim();
}

// The text of an expression made of string literals joined by `+`, or null.
const LITERAL = /`[^`]*`|'[^']*'|"[^"]*"/g;
function literalText(expression) {
  const rest = expression.replace(LITERAL, '').replace(/[\s+()]/g, '');
  if (rest !== '') return null;
  return [...expression.matchAll(LITERAL)].map((m) => m[0].slice(1, -1)).join('');
}

// `const NAME = <string literals joined by +>;` of one file.
function constantsOf(code) {
  const out = {};
  const re = /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*((?:`[^`]*`|'[^']*'|"[^"]*"|[\s+()])+);/g;
  for (const m of code.matchAll(re)) {
    const text = literalText(m[2]);
    if (text != null) out[m[1]] = text;
  }
  return out;
}

const sources = walk(resolve(root, 'src'))
  .map((file) => relative(root, file).split('\\').join('/'))
  .filter((name) => !name.startsWith('src/test/'))
  .map((name) => ({ name, code: codeOf(readFileSync(resolve(root, name), 'utf8')) }));

const everyConstant = Object.assign({}, ...sources.map((s) => constantsOf(s.code)));

// The select a `.select(…)` argument list asks for, as text; null when it is
// none the scan can read.
function selectText(args, own) {
  const first = firstArgument(args);
  if (first === '') return '*';
  const known = { ...everyConstant, ...own };
  let text = /^[A-Za-z_$][\w$]*$/.test(first) ? known[first] ?? null : literalText(first);
  if (text == null) return null;
  // `${NAME}` in a template literal: the constant it names.
  for (let i = 0; i < 5 && /\$\{/.test(text); i += 1) {
    text = text.replace(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g, (whole, name) => known[name] ?? whole);
  }
  return /\$\{/.test(text) ? null : text;
}

// The columns a select names at its own level: every embed `x(…)` taken out.
function topLevel(select) {
  let out = '';
  let depth = 0;
  for (const c of select) {
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if (depth === 0) out += c;
  }
  return out;
}

// What each `set_logs(…)` embed of a select names at its own level.
function setLogsEmbeds(select) {
  const out = [];
  const re = /(?<![\w])set_logs(?:![\w]+)?\s*\(/g;
  for (const m of select.matchAll(re)) {
    const body = inside(select, m.index + m[0].length - 1);
    if (body != null) out.push(topLevel(body));
  }
  return out;
}

const BARE_WEIGHT = /(?<![a-z_])weight_kg/;

function scan() {
  const reads = []; // { file, columns } — the set_logs columns of one read
  const unread = []; // a set_logs select the scan could not resolve
  for (const { name, code } of sources) {
    const own = constantsOf(code);
    // Every select of the file, whatever its table: set_logs may be embedded.
    for (const m of code.matchAll(/\.select\s*\(/g)) {
      const args = inside(code, m.index + m[0].length - 1);
      if (args == null) continue;
      const text = selectText(args, own);
      if (text == null) continue;
      for (const columns of setLogsEmbeds(text)) reads.push({ file: name, columns });
    }
    // The selects chained on `.from('set_logs')`, up to the end of the chain.
    for (const m of code.matchAll(/\.from\(\s*['"`]set_logs['"`]\s*\)/g)) {
      const after = code.slice(m.index + m[0].length);
      const end = after.search(/;|\.from\(/);
      const chain = end === -1 ? after : after.slice(0, end);
      for (const s of chain.matchAll(/\.select\s*\(/g)) {
        const args = inside(chain, s.index + s[0].length - 1);
        const text = args == null ? null : selectText(args, own);
        if (text == null) unread.push({ file: name, args });
        else reads.push({ file: name, columns: topLevel(text) });
      }
    }
  }
  return { reads, unread };
}

describe('no read of set_logs names weight_kg', () => {
  it('can tell a set_logs read that names it from one that does not', () => {
    // The volume read of useStudentLifetimeStats before it was fixed.
    const before = `
      id,
      weight_kg,
      target_reps,
      exercise_slot:exercise_slots!inner(exercise:exercise_library!inner(volume_weight))
    `;
    expect(BARE_WEIGHT.test(topLevel(before))).toBe(true);
    // The load of an embedded slot is the slot's, not the set's.
    expect(BARE_WEIGHT.test(topLevel('id, target_weight_kg, exercise_slot:exercise_slots!inner(weight_kg)'))).toBe(false);
    // An embed of set_logs in a slot read, aliased or not.
    expect(setLogsEmbeds('id, weight_kg, set_logs(set_number, weight_kg)').map((c) => BARE_WEIGHT.test(c))).toEqual([true]);
    expect(setLogsEmbeds('*, set_log:set_logs!inner(id, actual_weight_kg)').map((c) => BARE_WEIGHT.test(c))).toEqual([false]);
    // A select held in constants.
    expect(selectText('COLUMNS', { COLUMNS: `id, ${'$'}{MORE}`, MORE: 'weight_kg' })).toBe('id, weight_kg');
  });

  it('holds for every source file', () => {
    const { reads, unread } = scan();
    // A select the scan cannot resolve is one it cannot vouch for: write it
    // as a literal or as a constant of string literals.
    expect(unread).toEqual([]);
    const offenders = reads.filter((r) => BARE_WEIGHT.test(r.columns)).map((r) => r.file);
    expect(offenders).toEqual([]);
  });

  // A scan that resolves nothing passes for nothing.
  it('sees the reads it is about', () => {
    const files = new Set(scan().reads.map((r) => r.file));
    for (const file of [
      'src/hooks/useStudentLifetimeStats.js', // a select in a variable
      'src/hooks/useSession.js', // SLOT_LOG_COLUMNS and ${LOGGED_SET_COLUMNS}
      'src/hooks/useStudentProgressStats.js', // an embed in a slot read
      'src/hooks/useSetVideo.js', // an aliased embed
      'src/lib/doneSetHistory.js',
    ]) {
      expect(files).toContain(file);
    }
  });
});
