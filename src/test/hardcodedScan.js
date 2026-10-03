// Lists the text a screen hard-codes instead of taking it from the i18n
// dictionaries. Test support, never imported by the app.
//
// It is meant for one `hardcoded.test.js` per component folder, which expects
// an empty list and names what is deliberately left untranslated:
//
//   // @vitest-environment node
//   import { describe, it, expect } from 'vitest';
//   import { dirname } from 'node:path';
//   import { fileURLToPath } from 'node:url';
//   import { scanHardcoded, formatFinding } from '../../test/hardcodedScan';
//
//   describe('student screens hard-code no text', () => {
//     const scan = scanHardcoded({
//       root: dirname(fileURLToPath(import.meta.url)),
//       allow: {
//         files: ['StudentProgramAuthor.jsx'], // English-only by decision
//         text: ['kg', 'RPE'],                 // the same in EN, FR and DE
//       },
//     });
//     it('read the folder', () => expect(scan.files).toBeGreaterThan(20));
//     it('finds none', () => expect(scan.findings.map(formatFinding)).toEqual([]));
//     it('has no stale allow-list entry', () => expect(scan.unused).toEqual({ files: [], text: [] }));
//   });
//
// WHAT IT REPORTS — a string with at least one letter that is
//   1. JSX text:                       <p>Skip set</p>
//   2. a string rendered as a child:   {done ? 'Done' : 'Skip'}   {`${n} sets`}
//                                      {n === 1 ? '' : 's'}       {name || 'Untitled'}
//   3. the value of a text attribute:  aria-label="Close"   placeholder={`Note for ${coach}`}
//      (see TEXT_ATTRIBUTES: what a person reads or a screen reader says)
// Strings in 2 and 3 are followed through `?:`, `&&`, `||`, `??`, `+`, arrays
// and template literals, and no further.
//
// WHAT IT CANNOT SEE — a string that reaches the screen through a variable, a
// prop, an object or a function call (`const label = 'Done'`, `pushToast('…')`,
// `TABS = [{ label: 'Stats' }]`). An empty list means "no literal in the
// markup", not "fully translated": the scan is a floor under the folder.
//
// The parser is ESLint's (a direct devDependency, and the one `npm run lint`
// already trusts with this code), driven through its public `Linter` class.
// No regular expression ever looks at JSX.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { Linter } from 'eslint';

// Attributes whose value is read or heard. A camelCase prop that ENDS in one
// of the plain names counts too — `confirmLabel`, `emptyTitle`, `helperText`,
// `ariaLabel` — because that is how the text travels into shared components
// (Dialog title, EmptyState message). `aria-labelledby` and friends hold ids
// and are not in the list.
export const TEXT_ATTRIBUTES = [
  'aria-label',
  'aria-description',
  'aria-roledescription',
  'aria-valuetext',
  'aria-placeholder',
  'title',
  'placeholder',
  'alt',
  'label',
  'description',
  'message',
  'hint',
  'text',
];

const HAS_LETTER = /\p{L}/u;
const SOURCE_FILE = /\.jsx?$/;
const TEST_FILE = /\.test\.jsx?$/;

const squash = (text) => text.replace(/\s+/g, ' ').trim();

function isTextAttribute(name, attributes) {
  return attributes.some(
    (attribute) =>
      name === attribute ||
      (!attribute.includes('-') && name.endsWith(attribute[0].toUpperCase() + attribute.slice(1))),
  );
}

// The strings an expression can put on screen, as { node, text, letters }.
// `letters` is what the has-a-letter test reads: for a template literal, its
// fixed parts only, so `${a} · ${b}` is not text but `${n} sets` is.
function renderedStrings(node, out = []) {
  if (!node) return out;
  switch (node.type) {
    case 'Literal':
      if (typeof node.value === 'string') out.push({ node, text: node.value, letters: node.value });
      break;
    case 'TemplateLiteral': {
      const fixed = node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw);
      out.push({
        node,
        text: fixed.map((part, i) => (i < node.expressions.length ? `${part}\${…}` : part)).join(''),
        letters: fixed.join(' '),
      });
      for (const expression of node.expressions) renderedStrings(expression, out);
      break;
    }
    case 'ConditionalExpression':
      renderedStrings(node.consequent, out);
      renderedStrings(node.alternate, out);
      break;
    case 'LogicalExpression':
      // `cond && 'text'` renders the right side only; `a || 'text'` either.
      if (node.operator !== '&&') renderedStrings(node.left, out);
      renderedStrings(node.right, out);
      break;
    case 'BinaryExpression':
      if (node.operator === '+') {
        renderedStrings(node.left, out);
        renderedStrings(node.right, out);
      }
      break;
    case 'ArrayExpression':
      for (const element of node.elements) renderedStrings(element, out);
      break;
    case 'JSXExpressionContainer':
      renderedStrings(node.expression, out);
      break;
    default:
      // Identifier, MemberExpression, CallExpression (t('…') included), JSX
      // elements (visited on their own), …: nothing this scan can know.
      break;
  }
  return out;
}

/**
 * The hard-coded text of one source text.
 *
 * @param {string} code      the file's content
 * @param {string} [name]    used in error messages only
 * @param {{ attributes?: string[] }} [options]  replaces TEXT_ATTRIBUTES
 * @returns {{ line: number, column: number, kind: 'text' | 'attribute', attribute?: string, text: string }[]}
 *   in source order; `line` is 1-based and `column` 0-based, as ESLint counts them
 */
export function scanSource(code, name = 'source.jsx', { attributes = TEXT_ATTRIBUTES } = {}) {
  const found = [];
  const add = (kind, extra, { node, text, letters }, at = node.loc.start) => {
    if (!HAS_LETTER.test(letters)) return;
    found.push({ line: at.line, column: at.column, kind, ...extra, text: squash(text) });
  };

  const rule = {
    meta: { type: 'problem', schema: [] },
    create() {
      return {
        JSXText(node) {
          // The node starts right after the `>` of the opening tag; report
          // where its first word is.
          const lead = node.value.match(/^\s*/)[0];
          const breaks = lead.split('\n');
          const at =
            breaks.length > 1
              ? { line: node.loc.start.line + breaks.length - 1, column: breaks.at(-1).length }
              : { line: node.loc.start.line, column: node.loc.start.column + lead.length };
          add('text', {}, { node, text: node.value, letters: node.value }, at);
        },
        JSXExpressionContainer(node) {
          if (node.parent.type !== 'JSXElement' && node.parent.type !== 'JSXFragment') return;
          for (const string of renderedStrings(node.expression)) add('text', {}, string);
        },
        JSXAttribute(node) {
          if (node.name.type !== 'JSXIdentifier' || !isTextAttribute(node.name.name, attributes)) return;
          for (const string of renderedStrings(node.value)) add('attribute', { attribute: node.name.name }, string);
        },
      };
    },
  };

  // A fixed, relative file name: the real path may lie outside the working
  // directory, and ESLint would then skip the file without running a rule.
  const messages = new Linter({ configType: 'flat' }).verify(
    code,
    [
      {
        files: ['**/*.jsx'],
        languageOptions: {
          ecmaVersion: 'latest',
          sourceType: 'module',
          parserOptions: { ecmaFeatures: { jsx: true } },
        },
        linterOptions: { reportUnusedDisableDirectives: 'off' },
        plugins: { hardcoded: { rules: { text: rule } } },
        rules: { 'hardcoded/text': 'error' },
      },
    ],
    // Inline `eslint-disable` comments are for `npm run lint`, not for this.
    { filename: 'source.jsx', allowInlineConfig: false },
  );

  // The rule reports nothing through ESLint, so any message means the file
  // was not (fully) read: a syntax error, or a file ESLint decided to skip.
  // Never return an empty list for a file that was not scanned.
  if (messages.length > 0) {
    const [first] = messages;
    throw new Error(`hardcodedScan: cannot read ${name}:${first.line ?? 0} — ${first.message}`);
  }

  return found.sort((a, b) => a.line - b.line || a.column - b.column);
}

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (SOURCE_FILE.test(entry) && !TEST_FILE.test(entry)) out.push(full);
  }
  return out;
}

function allows(entry, text) {
  if (entry instanceof RegExp) {
    entry.lastIndex = 0; // a /g flag would otherwise remember the last file
    return entry.test(text);
  }
  return entry === text;
}

/**
 * The hard-coded text of a folder, minus an allow-list.
 *
 * @param {object}   options
 * @param {string}   options.root            absolute folder, read recursively; `*.test.js(x)` skipped
 * @param {object}   [options.allow]
 * @param {string[]} [options.allow.files]   paths relative to `root` (with `/`), exempt as a whole
 * @param {(string | RegExp)[]} [options.allow.text]  exact texts (as reported: whitespace collapsed)
 *                                           or patterns, accepted in every file
 * @param {string[]} [options.attributes]    replaces TEXT_ATTRIBUTES
 * @returns {{
 *   files: number,
 *   findings: { file: string, line: number, column: number, kind: string, attribute?: string, text: string }[],
 *   unused: { files: string[], text: string[] },
 * }}
 *   `files` — source files read, exempt ones included (assert it, so a wrong
 *   `root` cannot pass as "nothing found").
 *   `unused` — allow-list entries that exempted nothing: a file that is gone
 *   or has no literal left, a text that no longer appears. Expect it empty and
 *   the allow-list can only shrink.
 */
export function scanHardcoded({ root, allow = {}, attributes = TEXT_ATTRIBUTES } = {}) {
  if (typeof root !== 'string' || root === '') throw new Error('hardcodedScan: `root` (an absolute folder) is required');
  const allowFiles = allow.files ?? [];
  const allowText = allow.text ?? [];

  const usedFiles = new Set();
  const usedText = new Set();
  const findings = [];
  const files = sourceFiles(root);

  for (const full of files) {
    const file = relative(root, full).split(sep).join('/');
    const found = scanSource(readFileSync(full, 'utf8'), file, { attributes });

    if (allowFiles.includes(file)) {
      if (found.length > 0) usedFiles.add(file);
      continue;
    }
    for (const finding of found) {
      const entry = allowText.find((candidate) => allows(candidate, finding.text));
      if (entry !== undefined) usedText.add(entry);
      else findings.push({ file, ...finding });
    }
  }

  return {
    files: files.length,
    findings,
    unused: {
      files: allowFiles.filter((file) => !usedFiles.has(file)),
      text: allowText.filter((entry) => !usedText.has(entry)).map(String),
    },
  };
}

/** One finding as a line: `SetRow.jsx:338 aria-label "Remove extra set"`. */
export function formatFinding({ file, line, kind, attribute, text }) {
  const where = file ? `${file}:${line}` : `${line}`;
  return `${where} ${kind === 'attribute' ? attribute : 'text'} ${JSON.stringify(text)}`;
}
