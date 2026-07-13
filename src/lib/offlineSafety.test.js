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
];

// Mutations that are intentionally NOT offline-queued. Each must be UI-gated
// on connectivity (useOnlineStatus) so it can't silently hang/drop offline.
// Keep this list tight — adding a name here is a deliberate decision to
// forgo offline support for that write.
const ONLINE_ONLY = new Set([
  'useAddStudentSet', // brand-new-row INSERT can't queue offline (UNIQUE collision)
  'useRemoveStudentSet', // symmetry with add
  'useEnsureSetLogs', // safety-net INSERT, coach/materialization path
  'useSendMessage', // composers gate on useOnlineStatus + render inline errors
  'useDeleteMessage', // chat delete is online-only
  'useMarkThreadRead', // read receipts are low-stakes; no offline durability needed
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

  for (const file of FILES) {
    const src = readFileSync(resolve(hooksDir, file), 'utf8');
    for (const { name, body } of extractHooks(src)) {
      if (!body.includes('useMutation')) continue; // read hook, skip
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
});
