import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, relative, resolve } from 'node:path';

// The registry of the queue is read from the module itself; the module opens
// the supabase client at import.
vi.mock('./supabase', () => ({ supabase: {} }));

import { MUTATION_KEYS, MUTATION_FNS } from './offlineMutations';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(here, '..');
const hooksDir = resolve(here, '../hooks');

// Student-surface write hooks: every mutation here must survive
// offline → reload → resume, OR be an explicit, documented online-only
// exception. This static guard would have caught useSendMessage silently
// pausing-then-losing offline (the reload-drop bug from the July audit) and
// catches every future hook added to these files. It's the machine-checked
// version of docs/INVARIANTS.md's offline-mutations contract.
const FILES = [
  'useSetLogs.js',
  'useSessionConfirmation.js',
  'useSlotComments.js',
  'useSlotDeviations.js',
  'useMessages.js',
  'useAuthoring.js',
  'useGoals.js',
  'useBodyweight.js',
  'useSetVideo.js',
];

// Coach-device mutations that happen to live in a scanned file. The offline
// lane is a STUDENT-surface contract — a coach edits at their desk — so these
// are outside the scan rather than online-only exceptions to it.
const COACH_ONLY = new Set([
  'useCreateGoal',
  'useDeleteGoal',
]);

// Mutations that are intentionally NOT offline-queued. Each is kept from
// STARTING without a network — see "an online-only write has an online guard"
// below, which checks it. Without a network such a write would not fail: it
// would pause, and run whenever the network returns, on whatever the page
// held at the time. It is not part of the queue either, so nothing stores it
// (lib/persistence.js): the same write is gone if the app is closed first.
// Keep this list tight — adding a name here is a deliberate decision to
// forgo offline support for that write.
const ONLINE_ONLY = new Set([
  'useAddStudentSet', // brand-new-row INSERT can't queue offline (UNIQUE collision)
  'useRemoveStudentSet', // symmetry with add
  'useEnsureSetLogs', // started by the hook itself, only when the device and `onlineManager` are online
  'useAddGoalProgress', // brand-new-row INSERT, no offline id story; MyGoals gates on useOnlineStatus
  'useDeleteGoalProgress', // symmetry with add
  'useToggleGoalAchieved', // low-stakes flag; MyGoals gates on useOnlineStatus
  'useLogBodyweight', // BodyweightCard gates on useOnlineStatus
  'useUploadSetVideo', // a file upload can't be queued in the mutation cache; VideoUploadButton gates
  'useDeleteSetVideo', // storage delete, same reason
  'useSendMessage', // composers gate on useOnlineStatus + render inline errors
  'useDeleteMessage', // chat delete is online-only
  'useMarkThreadRead', // read receipts are low-stakes; no offline durability needed
  'useRequestPromote', // "make permanent" ask isn't urgent; SlotDeviationBar gates on useOnlineStatus
  // Phase 3.4d: authoring is now OFFLINE-CAPABLE. The whole draft syncs as one
  // keyed snapshot mutation (useSaveDraftTree) + useDiscardDraft — both carry a
  // mutationKey, so they pass the scan directly. The per-edit hooks became plain
  // optimistic-cache editors (no useMutation), so they no longer appear here.
]);

// Split a file's text into top-level `export function useXxx(...) { ... }`
// blocks by brace-matching, so we can inspect each hook in isolation.
function extractHooks(src) {
  return extractFunctions(src, /export function (use[A-Za-z0-9]+)\s*\(/g);
}

function extractFunctions(src, re) {
  const hooks = [];
  let m;
  while ((m = re.exec(src))) {
    const name = m[1];
    // Skip the parameter list first (it may itself contain `{ destructured }`
    // braces) by paren-matching from the `(` we just matched, THEN find the
    // body's opening brace. Matching the first `{` after the name would
    // otherwise capture a destructured-param brace and miss the real body.
    let pdepth = 0;
    let p = re.lastIndex - 1; // at the '('
    for (; p < src.length; p++) {
      if (src[p] === '(') pdepth++;
      else if (src[p] === ')') {
        pdepth--;
        if (pdepth === 0) break;
      }
    }
    const braceStart = src.indexOf('{', p);
    if (braceStart === -1) continue;
    let depth = 0;
    let i = braceStart;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    hooks.push({ name, body: src.slice(braceStart, i + 1) });
  }
  return hooks;
}

describe('offline-safety guardrail', () => {
  const offending = [];
  const inspected = [];

  for (const file of FILES) {
    const src = readFileSync(resolve(hooksDir, file), 'utf8');
    for (const { name, body } of extractHooks(src)) {
      // A write hook either calls useMutation directly or delegates to a
      // local factory that does — in both cases it names a `mutationFn`.
      // Testing only for `useMutation` would silently stop covering any hook
      // that gets refactored onto a factory.
      const isWriteHook = body.includes('useMutation') || /mutationFn\s*:/.test(body);
      if (!isWriteHook) continue; // read hook, skip
      if (COACH_ONLY.has(name)) continue;
      inspected.push(name);
      const hasMutationKey = /mutationKey\s*:/.test(body);
      const isOnlineOnly = ONLINE_ONLY.has(name);
      if (!hasMutationKey && !isOnlineOnly) {
        offending.push(`${file} → ${name}`);
      }
    }
  }

  it('every student-surface mutation is offline-keyed or explicitly online-only', () => {
    expect(offending).toEqual([]);
  });

  it('actually inspected the expected hooks (guard against a broken scan)', () => {
    // Sanity: if the regex ever stops matching, the test above would pass
    // vacuously. Assert we saw a known offline-keyed hook and a known
    // online-only one.
    const setLogs = readFileSync(resolve(hooksDir, 'useSetLogs.js'), 'utf8');
    const hooks = extractHooks(setLogs).map((h) => h.name);
    expect(hooks).toContain('useToggleSetDone');
    expect(hooks).toContain('useAddStudentSet');
  });

  it('covers the set-log writes that delegate to the optimistic factory', () => {
    // These five don't call useMutation in their own body — they hand off to
    // useOptimisticSetLogMutation. A detector keyed on the literal
    // "useMutation" would skip them as read hooks and pass vacuously, which
    // is exactly how a workout write could lose its offline key unnoticed.
    expect(inspected).toEqual(
      expect.arrayContaining([
        'useToggleSetDone',
        'useSetFailed',
        'useLogActual',
        'useSetSkipped',
        'useSetRpe',
      ]),
    );
  });
});

// --- an online-only write has an online guard ----------------------------------------
//
// "Online-only" is a promise that the write does not start without a network.
// It is kept in one of two places, and this is where it is checked:
//   - in the hook itself, which reads the state of the network before it
//     mutates; or
//   - in every component that calls the hook, which reads it to disable or
//     hide the control.
// "Reads the state of the network" is one of the three ways the app has:
// `useOnlineStatus()`, `onlineManager.isOnline()` or `navigator.onLine`. A
// static check cannot tell that the value is USED on the right line; what it
// does tell is that a write was added to ONLINE_ONLY without anything near it
// looking at the network — which is how every entry without a guard got there.
const READS_THE_NETWORK = /\buseOnlineStatus\s*\(|\bonlineManager\s*\.\s*isOnline\s*\(|\bnavigator\s*\.\s*onLine\b/;

// A hook nobody calls starts nothing, with or without a network.
function isGuarded({ body, callers }) {
  return READS_THE_NETWORK.test(body) || callers.every((caller) => READS_THE_NETWORK.test(caller.text));
}

// Every source file of the app, tests left out.
function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.jsx?$/.test(entry.name) || /\.test\.jsx?$/.test(entry.name)) return [];
    return [{ file: relative(srcDir, path), text: readFileSync(path, 'utf8') }];
  });
}

describe('an online-only write has an online guard', () => {
  const sources = sourceFiles(srcDir);
  const hooks = FILES.flatMap((file) =>
    extractHooks(readFileSync(resolve(hooksDir, file), 'utf8')).map((hook) => ({ ...hook, file: `hooks/${file}` })),
  );
  // An entry whose hook is gone guards nothing and is left alone here: the
  // hook that replaced it is caught by the first test of this file, which
  // sends it to ONLINE_ONLY — and so to this one.
  const guards = hooks
    .filter((hook) => ONLINE_ONLY.has(hook.name))
    .map((hook) => {
      const calls = new RegExp(`\\b${hook.name}\\s*\\(`);
      const callers = sources.filter((source) => source.file !== hook.file && calls.test(source.text));
      return { name: hook.name, hook, callers };
    });

  it('the hook reads the state of the network, or every component that calls it does', () => {
    const unguarded = guards
      .filter(({ hook, callers }) => !isGuarded({ body: hook.body, callers }))
      .map(({ name, callers }) => `${name} — called from ${callers.map((caller) => caller.file).join(', ')}`);

    // A name here is a write that pauses without a network and runs later, on
    // stale data, or is lost with the app. Read the network in the hook
    // (`onlineManager.isOnline()`) or in each caller (`useOnlineStatus()`).
    expect(unguarded).toEqual([]);
  });

  it('looked at the hooks and found who calls them: the scan is not passing for want of anything to read', () => {
    expect(guards.length).toBeGreaterThan(ONLINE_ONLY.size / 2);
    expect(guards.filter((guard) => guard.callers.length > 0).length).toBeGreaterThan(guards.length / 2);
    expect(sources.some((source) => source.file === 'hooks/useOnlineStatus.js')).toBe(true);
    expect(sources.some((source) => /\.test\./.test(source.file))).toBe(false);
  });

  it('tells a guard from its absence', () => {
    const gated = { file: 'Gated.jsx', text: 'const online = useOnlineStatus();\nuseAddThing();' };
    const blind = { file: 'Blind.jsx', text: 'const add = useAddThing();\nadd.mutate();' };

    expect(isGuarded({ body: '{ return useMutation({ mutationFn }); }', callers: [gated] })).toBe(true);
    // One caller that does not look is enough for the write to start offline.
    expect(isGuarded({ body: '{ return useMutation({ mutationFn }); }', callers: [gated, blind] })).toBe(false);
    // The hook that looks for itself covers every caller.
    expect(isGuarded({ body: '{ if (!onlineManager.isOnline()) return; }', callers: [blind] })).toBe(true);
    expect(isGuarded({ body: '{ if (navigator.onLine === false) return; }', callers: [blind] })).toBe(true);
    // Importing the helper is not reading the network.
    expect(isGuarded({ body: '{ return useMutation({ mutationFn }); }', callers: [{ ...blind, text: "import { useOnlineStatus } from './x';\nuseAddThing();" }] })).toBe(false);
  });
});

// --- a write of the queue can be sent twice ------------------------------------------
//
// The queue re-sends. A write that got no answer is sent again (the first copy
// may have reached the database), and so is every write that had not settled
// when the app was killed: the persister stores all of them — paused, out
// with a request that hangs, asleep between two attempts — and the next launch
// replays them (lib/persistence.js). All of it rests on one property of the
// registered functions: run twice, a function leaves the database as it does
// run once.
//
// That is read off the code, statement by statement. Each registered write is
// listed with what it sends; a function that changes, or a write that is
// added, has to be put here and looked at:
//   update — columns of the row named by the variables, set to values carried
//            in the variables: the second run writes the same values;
//   upsert — only with `onConflict`: the second run meets the row of the first
//            (and overwrites it with the same values, or does nothing);
//   delete — the second run finds nothing to delete;
//   rpc    — only a function known to be a full replace.
// A bare INSERT is the one thing that is never replay-safe: sent twice, it is
// two rows, or a UNIQUE violation that fails a write which had succeeded.
const WHAT_A_QUEUED_WRITE_SENDS = {
  toggleDone: ['update'],
  setFailed: ['update'],
  setRpe: ['update'],
  logActual: ['update'],
  setSkipped: ['update'],
  confirmSession: ['upsert'],
  unconfirmSession: ['delete'],
  saveSlotComment: ['delete', 'upsert'],
  saveSlotDeviation: ['delete', 'upsert'],
  saveDraftTree: ['rpc save_draft_tree'],
  discardDraft: ['delete'],
};

// `save_draft_tree` replaces the whole draft by client-minted ids.
const REPLAY_SAFE_RPCS = ['save_draft_tree'];

function statementsOf(body) {
  const sent = new Set();
  for (const [, verb] of body.matchAll(/\.\s*(insert|update|upsert|delete)\s*\(/g)) sent.add(verb);
  for (const [, fn] of body.matchAll(/\.\s*rpc\s*\(\s*['"`]([^'"`]+)['"`]/g)) sent.add(`rpc ${fn}`);
  // An rpc whose name is not a literal cannot be vouched for.
  if (/\.\s*rpc\s*\(\s*[^'"`\s]/.test(body)) sent.add('rpc ?');
  return [...sent].sort();
}

describe('a write of the queue can be sent twice', () => {
  const source = readFileSync(resolve(here, 'offlineMutations.js'), 'utf8');
  const senders = Object.fromEntries(
    extractFunctions(source, /async function ([A-Za-z0-9]+)Fn\s*\(/g).map(({ name, body }) => [name, body]),
  );

  it('every registered write is listed, and has a function to send it', () => {
    expect(Object.keys(WHAT_A_QUEUED_WRITE_SENDS).sort()).toEqual(Object.keys(MUTATION_KEYS).sort());
    expect(Object.keys(MUTATION_FNS).sort()).toEqual(Object.keys(MUTATION_KEYS).sort());
    expect(Object.keys(MUTATION_KEYS).filter((name) => !senders[name])).toEqual([]);
  });

  it('each sends what it is listed with, and nothing else', () => {
    const actual = Object.fromEntries(Object.keys(MUTATION_KEYS).map((name) => [name, statementsOf(senders[name] ?? '')]));

    expect(actual).toEqual(WHAT_A_QUEUED_WRITE_SENDS);
  });

  it('none is a bare INSERT, an upsert without its conflict target, or an rpc nobody vouched for', () => {
    const unsafe = [];
    for (const name of Object.keys(MUTATION_KEYS)) {
      const body = senders[name] ?? '';
      const sent = statementsOf(body);
      if (sent.includes('insert')) unsafe.push(`${name}: insert`);
      const upserts = body.match(/\.\s*upsert\s*\(/g)?.length ?? 0;
      const targets = body.match(/\bonConflict\s*:/g)?.length ?? 0;
      if (upserts > targets) unsafe.push(`${name}: upsert without onConflict`);
      for (const statement of sent.filter((s) => s.startsWith('rpc '))) {
        if (!REPLAY_SAFE_RPCS.includes(statement.slice(4))) unsafe.push(`${name}: ${statement}`);
      }
    }

    expect(unsafe).toEqual([]);
  });

  it('reads a function the way it is written: the scan is not passing on an empty body', () => {
    expect(statementsOf(senders.confirmSession)).toEqual(['upsert']);
    expect(senders.confirmSession).toContain('ignoreDuplicates: true');
    expect(statementsOf("{ await supabase.from('set_logs').insert(rows); }")).toEqual(['insert']);
    expect(statementsOf("{ await supabase.rpc('ensure_set_logs', { p_session_id }); }")).toEqual(['rpc ensure_set_logs']);
    expect(statementsOf('{ await supabase.rpc(name, args); }')).toEqual(['rpc ?']);
  });
});
