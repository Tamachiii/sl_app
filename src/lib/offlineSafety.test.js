import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
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

// Mutations that are intentionally NOT offline-queued. Each must be UI-gated
// on connectivity (useOnlineStatus) so it can't silently hang/drop offline.
// Keep this list tight — adding a name here is a deliberate decision to
// forgo offline support for that write.
const ONLINE_ONLY = new Set([
  'useAddStudentSet', // brand-new-row INSERT can't queue offline (UNIQUE collision)
  'useRemoveStudentSet', // symmetry with add
  'useEnsureSetLogs', // student SessionView safety-net INSERT; self-heals on the next mount, so no gate needed
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
  const hooks = [];
  const re = /export function (use[A-Za-z0-9]+)\s*\(/g;
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
