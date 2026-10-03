import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, relative } from 'node:path';
import en from './en';
import { messages } from './index';
import { mergeFragments } from './mergeFragments';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(here, '../..');

function keys(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...keys(v, path));
    else out.push(path);
  }
  return out;
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (/\.jsx?$/.test(entry) && !/\.test\.jsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

// Literal t('a.b.c') call sites. Keys built from a template literal
// (t(`errors.${code}`)) don't match and are covered by their own call sites'
// tests — this guard is about typos and deletions, not dynamic families.
const T_CALL = /(?<![\w.])t\(\s*'([a-zA-Z0-9_.]+)'/g;

const literalKeys = (text) => [...text.matchAll(T_CALL)].map((m) => m[1]);

// `sources` is a list of { name, text }; the result one line per call site
// whose key the dictionary does not have.
function missingKeys(sources, dictionary) {
  const known = new Set(keys(dictionary));
  return sources.flatMap(({ name, text }) =>
    literalKeys(text).filter((key) => !known.has(key)).map((key) => `${name} → ${key}`),
  );
}

// A missing key renders as the raw dotted path in the UI — no crash, no test
// failure, just "student.home.weekAdherence" sitting on the screen. This is
// the guard for that, and the reason a key deletion can't quietly outrun its
// call sites.
describe('i18n key usage', () => {
  const files = [resolve(srcDir, 'components'), resolve(srcDir, 'hooks')].flatMap(walk);
  const sources = files.map((file) => ({ name: relative(srcDir, file), text: readFileSync(file, 'utf8') }));

  // MERGED English: the base dictionary plus every package's fragment, which
  // is what getMessage reads. A key may live in either.
  it('every literal t() key exists in the EN dictionary, fragments included', () => {
    expect(missingKeys(sources, messages.en)).toEqual([]);
  });

  it('actually scanned the component tree (guard against a broken walk)', () => {
    expect(files.length).toBeGreaterThan(40);
    const found = sources.flatMap(({ text }) => literalKeys(text));
    expect(found).toContain('common.back');
  });
});

// The same guard with a fixture fragment: a screen written by a package uses
// keys that exist only in that package's fragment.
describe('i18n key usage, with a fragment', () => {
  const fixture = import.meta.glob('./__fixtures__/fragments/*.en.js', { eager: true, import: 'default' });
  const screen = {
    name: 'components/student/CheckIn.jsx',
    text: `
      const { t } = useI18n();
      return (
        <section aria-label={t('fixturePackage.title')}>
          <p>{t('fixturePackage.greeting', { name })}</p>
          <button>{hurt ? t('fixturePackage.pain.yes') : t('fixturePackage.pain.no')}</button>
          <button>{t('common.cancel')}</button>
        </section>
      );
    `,
  };

  it('sees the call sites of a fragment namespace', () => {
    expect(literalKeys(screen.text)).toEqual([
      'fixturePackage.title',
      'fixturePackage.greeting',
      'fixturePackage.pain.yes',
      'fixturePackage.pain.no',
      'common.cancel',
    ]);
  });

  it('the base dictionary alone does not know them', () => {
    expect(missingKeys([screen], en)).toEqual([
      'components/student/CheckIn.jsx → fixturePackage.title',
      'components/student/CheckIn.jsx → fixturePackage.greeting',
      'components/student/CheckIn.jsx → fixturePackage.pain.yes',
      'components/student/CheckIn.jsx → fixturePackage.pain.no',
    ]);
  });

  it('the merged dictionary does', () => {
    expect(missingKeys([screen], mergeFragments(en, fixture))).toEqual([]);
  });

  it('a typo in a fragment key is still caught', () => {
    const typo = { name: screen.name, text: "t('fixturePackage.titel')" };
    expect(missingKeys([typo], mergeFragments(en, fixture))).toEqual([
      'components/student/CheckIn.jsx → fixturePackage.titel',
    ]);
  });
});
