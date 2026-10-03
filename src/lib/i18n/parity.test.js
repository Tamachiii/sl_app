import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import en from './en';
import fr from './fr';
import de from './de';
import { LANGUAGES, fragmentModules, lookupMessage, messages } from './index';
import { mergeFragments } from './mergeFragments';

const base = { en, fr, de };

const isDict = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Flatten a nested dictionary to a sorted list of dotted key paths.
function keys(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (isDict(v)) {
      out.push(...keys(v, path));
    } else {
      out.push(path);
    }
  }
  return out.sort();
}

function leaves(obj, prefix = '') {
  return Object.entries(obj).flatMap(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    return isDict(v) ? leaves(v, path) : [[path, v]];
  });
}

// ---------------------------------------------------------------------------
// The fragment rules (fragments/README.md), as one function so the same code
// judges the real folder and the fixture. Returns one line per problem.
//
//   base     { en, fr, de } — the dictionaries without any fragment
//   modules  { en, fr, de } — per language, file path → default export (the
//            shape of `fragmentModules` in index.js)
//   files    the names actually present in the folder
// ---------------------------------------------------------------------------
const FRAGMENT_FILE = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.([a-z]+)\.js$/;
// Both are what usage.test.js can see in a literal t('namespace.key') call.
const NAMESPACE = /^[a-z][A-Za-z0-9]*$/;
const KEY_SEGMENT = /^[A-Za-z0-9_]+$/;

function checkFragments({ base, modules, files = [] }) {
  const problems = [];
  const loaded = new Set();
  const packages = new Map(); // package id → { lang → { file, dict } }

  for (const lang of LANGUAGES) {
    for (const [path, dict] of Object.entries(modules[lang] ?? {})) {
      const file = path.split('/').pop();
      loaded.add(file);
      const m = file.match(FRAGMENT_FILE);
      if (!m || m[2] !== lang) {
        problems.push(`${file}: a fragment is named <package-id>.<lang>.js, the package id in kebab-case`);
        continue;
      }
      if (!packages.has(m[1])) packages.set(m[1], {});
      packages.get(m[1])[lang] = { file, dict };
    }
  }

  // A file no glob picks up is a set of strings that silently never loads.
  for (const file of files) {
    if (file === 'README.md' || loaded.has(file)) continue;
    problems.push(
      `${file}: in the fragments folder but loaded by no language — name it <package-id>.<${LANGUAGES.join('|')}>.js`,
    );
  }

  const baseNamespaces = new Set(LANGUAGES.flatMap((lang) => Object.keys(base[lang])));
  const owner = new Map(); // namespace → package id

  for (const id of [...packages.keys()].sort()) {
    const byLang = packages.get(id);

    // Rule 1 — a fragment exists in all three languages…
    const absent = LANGUAGES.filter((lang) => !byLang[lang]);
    if (absent.length > 0) {
      problems.push(
        `${id}: no ${absent.map((lang) => `${id}.${lang}.js`).join(', ')} — a fragment exists in every language`,
      );
    }

    const namespaces = new Set();
    for (const lang of LANGUAGES) {
      if (!byLang[lang]) continue;
      const { file, dict } = byLang[lang];
      if (!isDict(dict)) {
        problems.push(`${file}: the default export is not an object`);
        continue;
      }
      const top = Object.keys(dict);
      if (top.length !== 1) {
        problems.push(`${file}: ${top.length} top-level namespaces (${top.join(', ')}) — a fragment has exactly one`);
      }
      for (const namespace of top) {
        namespaces.add(namespace);
        if (!NAMESPACE.test(namespace)) {
          problems.push(`${file}: namespace "${namespace}" is not camelCase — t('${namespace}.…') could not be checked`);
        }
        // Rule 2 — …and never redefines a base key. With one NEW top-level
        // namespace per fragment, that is: the namespace is not in the base.
        if (baseNamespaces.has(namespace)) {
          problems.push(
            `${file}: "${namespace}" is already a namespace of the base dictionary — a fragment never redefines a base key`,
          );
        }
        if (!isDict(dict[namespace])) {
          problems.push(`${file}: "${namespace}" is not an object of keys`);
        }
      }
      for (const [path, value] of leaves(dict)) {
        if (!path.split('.').every((segment) => KEY_SEGMENT.test(segment))) {
          problems.push(`${file}: key "${path}" — letters, digits and _ only`);
        }
        if (typeof value !== 'string' || value === '') {
          problems.push(`${file}: ${path} is not a non-empty string`);
        }
      }
    }

    // The merge keeps one fragment per namespace: a second package under the
    // same name would lose all its strings.
    for (const namespace of namespaces) {
      if (owner.has(namespace) && owner.get(namespace) !== id) {
        problems.push(`"${namespace}" is the namespace of two packages (${owner.get(namespace)}, ${id})`);
      } else {
        owner.set(namespace, id);
      }
    }

    // Rule 1, second half — …with identical keys. English is the reference.
    if (byLang.en && isDict(byLang.en.dict)) {
      const want = keys(byLang.en.dict);
      for (const lang of LANGUAGES) {
        if (lang === 'en' || !byLang[lang] || !isDict(byLang[lang].dict)) continue;
        const got = keys(byLang[lang].dict);
        for (const key of want.filter((k) => !got.includes(k))) {
          problems.push(`${byLang[lang].file}: missing ${key}`);
        }
        for (const key of got.filter((k) => !want.includes(k))) {
          problems.push(`${byLang[lang].file}: extra ${key} (not in ${byLang.en.file})`);
        }
      }
    }
  }

  return problems;
}

// Guards the EN/FR/DE dictionaries against silent drift: a new EN key with no
// FR/DE translation ships a mixed-language UI (the exact debt the audit
// flagged on the logging surface). Keep the three in lockstep.
//
// MERGED: the dictionaries as the app reads them, fragments included.
describe('i18n dictionary parity', () => {
  const enKeys = keys(messages.en);

  it('FR has exactly the same keys as EN', () => {
    const frKeys = keys(messages.fr);
    expect(frKeys.filter((k) => !enKeys.includes(k))).toEqual([]); // extra in FR
    expect(enKeys.filter((k) => !frKeys.includes(k))).toEqual([]); // missing in FR
  });

  it('DE has exactly the same keys as EN', () => {
    const deKeys = keys(messages.de);
    expect(deKeys.filter((k) => !enKeys.includes(k))).toEqual([]);
    expect(enKeys.filter((k) => !deKeys.includes(k))).toEqual([]);
  });

  it('reads the merged dictionaries, not the base files', () => {
    // Every base key is still there (a fragment can only add)…
    for (const lang of LANGUAGES) {
      expect(keys(messages[lang])).toEqual(expect.arrayContaining(keys(base[lang])));
    }
    // …and what the app reads is base + that language's fragments.
    for (const lang of LANGUAGES) {
      expect(messages[lang]).toEqual(mergeFragments(base[lang], fragmentModules[lang]));
    }
  });
});

describe('i18n fragments: the real folder', () => {
  const files = readdirSync(resolve(dirname(fileURLToPath(import.meta.url)), 'fragments'));

  it('has one glob per language', () => {
    expect(Object.keys(fragmentModules)).toEqual(LANGUAGES);
  });

  it('keeps its README, so the folder (and the convention) survive an empty state', () => {
    expect(files).toContain('README.md');
  });

  it('obeys the rules: three languages, identical keys, one new namespace, every file loaded', () => {
    expect(checkFragments({ base, modules: fragmentModules, files })).toEqual([]);
  });
});

// The same rules on a fixture package, loaded from disk with the glob shape
// index.js uses. Without it every check above is vacuous while the real
// folder is empty — which it is after each fold.
describe('i18n fragments: the rules, on a fixture package', () => {
  const fixture = {
    en: import.meta.glob('./__fixtures__/fragments/*.en.js', { eager: true, import: 'default' }),
    fr: import.meta.glob('./__fixtures__/fragments/*.fr.js', { eager: true, import: 'default' }),
    de: import.meta.glob('./__fixtures__/fragments/*.de.js', { eager: true, import: 'default' }),
  };
  const path = (lang, id = 'fixture-package') => `./__fixtures__/fragments/${id}.${lang}.js`;
  const files = LANGUAGES.map((lang) => `fixture-package.${lang}.js`);

  // A deep copy of the fixture with one thing wrong.
  const broken = (edit) => {
    const copy = JSON.parse(JSON.stringify(fixture));
    edit(copy);
    return copy;
  };
  const check = (modules, present = files) => checkFragments({ base, modules, files: present });

  it('the globs found the three files', () => {
    for (const lang of LANGUAGES) {
      expect(Object.keys(fixture[lang])).toEqual([path(lang)]);
      expect(Object.keys(fixture[lang][path(lang)])).toEqual(['fixturePackage']);
    }
  });

  it('a complete package passes', () => {
    expect(check(fixture)).toEqual([]);
  });

  it('its strings resolve in each language, next to the base ones', () => {
    const dictionaries = Object.fromEntries(
      LANGUAGES.map((lang) => [lang, mergeFragments(base[lang], fixture[lang])]),
    );
    expect(keys(dictionaries.fr)).toEqual(keys(dictionaries.en));
    expect(keys(dictionaries.de)).toEqual(keys(dictionaries.en));
    expect(keys(dictionaries.en)).toHaveLength(keys(en).length + 4);

    expect(lookupMessage(dictionaries, 'en', 'fixturePackage.title')).toBe('Check-in');
    expect(lookupMessage(dictionaries, 'fr', 'fixturePackage.greeting', { name: 'Tony' })).toBe('Bonjour Tony');
    expect(lookupMessage(dictionaries, 'de', 'fixturePackage.pain.no')).toBe('Keine Schmerzen');
    expect(lookupMessage(dictionaries, 'fr', 'common.cancel')).toBe(fr.common.cancel);
    // Not in the app's own dictionaries: the fixture is not a real fragment.
    expect(lookupMessage(messages, 'fr', 'fixturePackage.title')).toBe('fixturePackage.title');
  });

  it('a string missing in one language falls back to English at runtime', () => {
    const modules = broken((m) => delete m.fr[path('fr')].fixturePackage.title);
    const dictionaries = Object.fromEntries(
      LANGUAGES.map((lang) => [lang, mergeFragments(base[lang], modules[lang])]),
    );
    expect(lookupMessage(dictionaries, 'fr', 'fixturePackage.title')).toBe('Check-in');
  });

  it.each([
    [
      'a language is missing',
      (m) => delete m.de[path('de')],
      files.slice(0, 2),
      ['fixture-package: no fixture-package.de.js — a fragment exists in every language'],
    ],
    [
      'two languages are missing',
      (m) => {
        delete m.fr[path('fr')];
        delete m.de[path('de')];
      },
      files.slice(0, 1),
      ['fixture-package: no fixture-package.fr.js, fixture-package.de.js — a fragment exists in every language'],
    ],
    [
      'a key is missing in French',
      (m) => delete m.fr[path('fr')].fixturePackage.pain.no,
      files,
      ['fixture-package.fr.js: missing fixturePackage.pain.no'],
    ],
    [
      'German has a key English does not',
      (m) => {
        m.de[path('de')].fixturePackage.pain.maybe = 'Vielleicht';
      },
      files,
      ['fixture-package.de.js: extra fixturePackage.pain.maybe (not in fixture-package.en.js)'],
    ],
    [
      'the namespace differs between languages',
      (m) => {
        m.fr[path('fr')] = { paquetFixture: m.fr[path('fr')].fixturePackage };
      },
      files,
      [
        'fixture-package.fr.js: missing fixturePackage.greeting',
        'fixture-package.fr.js: missing fixturePackage.pain.no',
        'fixture-package.fr.js: missing fixturePackage.pain.yes',
        'fixture-package.fr.js: missing fixturePackage.title',
        'fixture-package.fr.js: extra paquetFixture.greeting (not in fixture-package.en.js)',
        'fixture-package.fr.js: extra paquetFixture.pain.no (not in fixture-package.en.js)',
        'fixture-package.fr.js: extra paquetFixture.pain.yes (not in fixture-package.en.js)',
        'fixture-package.fr.js: extra paquetFixture.title (not in fixture-package.en.js)',
      ],
    ],
    [
      'it redefines a base namespace',
      (m) => {
        for (const lang of LANGUAGES) m[lang][path(lang)] = { common: m[lang][path(lang)].fixturePackage };
      },
      files,
      LANGUAGES.map(
        (lang) =>
          `fixture-package.${lang}.js: "common" is already a namespace of the base dictionary — a fragment never redefines a base key`,
      ),
    ],
    [
      'it brings two namespaces',
      (m) => {
        m.en[path('en')].second = { a: 'A' };
      },
      files,
      [
        'fixture-package.en.js: 2 top-level namespaces (fixturePackage, second) — a fragment has exactly one',
        'fixture-package.fr.js: missing second.a',
        'fixture-package.de.js: missing second.a',
      ],
    ],
    [
      'the namespace is not camelCase',
      (m) => {
        for (const lang of LANGUAGES) m[lang][path(lang)] = { 'fixture-package': m[lang][path(lang)].fixturePackage };
      },
      files,
      LANGUAGES.flatMap((lang) => [
        `fixture-package.${lang}.js: namespace "fixture-package" is not camelCase — t('fixture-package.…') could not be checked`,
        ...['greeting', 'pain.yes', 'pain.no', 'title']
          .map((key) => `fixture-package.${lang}.js: key "fixture-package.${key}" — letters, digits and _ only`),
      ]),
    ],
    [
      'a value is not a string',
      (m) => {
        m.en[path('en')].fixturePackage.title = 42;
        m.de[path('de')].fixturePackage.greeting = '';
      },
      files,
      [
        'fixture-package.en.js: fixturePackage.title is not a non-empty string',
        'fixture-package.de.js: fixturePackage.greeting is not a non-empty string',
      ],
    ],
    [
      'the namespace is a string, not a group of keys',
      (m) => {
        for (const lang of LANGUAGES) m[lang][path(lang)] = { fixturePackage: 'Check-in' };
      },
      files,
      LANGUAGES.map((lang) => `fixture-package.${lang}.js: "fixturePackage" is not an object of keys`),
    ],
    [
      'the default export is not an object',
      (m) => {
        m.fr[path('fr')] = 'Bilan';
      },
      files,
      ['fixture-package.fr.js: the default export is not an object'],
    ],
    [
      'a second package takes the same namespace',
      (m) => {
        for (const lang of LANGUAGES) m[lang][path(lang, 'other-package')] = m[lang][path(lang)];
      },
      [...files, ...LANGUAGES.map((lang) => `other-package.${lang}.js`)],
      ['"fixturePackage" is the namespace of two packages (fixture-package, other-package)'],
    ],
    [
      'the package id is not kebab-case',
      (m) => {
        for (const lang of LANGUAGES) {
          m[lang] = { [path(lang, 'Fixture_Package')]: m[lang][path(lang)] };
        }
      },
      LANGUAGES.map((lang) => `Fixture_Package.${lang}.js`),
      LANGUAGES.map(
        (lang) => `Fixture_Package.${lang}.js: a fragment is named <package-id>.<lang>.js, the package id in kebab-case`,
      ),
    ],
    [
      'a file sits in the folder that no language loads',
      () => {},
      [...files, 'fixture-package.es.js', 'notes.js'],
      [
        'fixture-package.es.js: in the fragments folder but loaded by no language — name it <package-id>.<en|fr|de>.js',
        'notes.js: in the fragments folder but loaded by no language — name it <package-id>.<en|fr|de>.js',
      ],
    ],
  ])('refuses a package when %s', (_title, edit, present, expected) => {
    const problems = check(broken(edit), present);
    expect([...problems].sort()).toEqual([...expected].sort());
  });

  it('the base dictionary wins over a fragment that names one of its namespaces', () => {
    const merged = mergeFragments(en, { './fragments/rogue.en.js': { common: { cancel: 'Nope' }, rogue: { a: 'A' } } });
    expect(merged.common).toBe(en.common);
    expect(merged.rogue).toEqual({ a: 'A' });
  });

  it('between two fragments the first file in path order wins, whatever order they arrive in', () => {
    const first = { shared: { from: 'a' } };
    const second = { shared: { from: 'b' } };
    expect(mergeFragments({}, { './f/a.en.js': first, './f/b.en.js': second }).shared.from).toBe('a');
    expect(mergeFragments({}, { './f/b.en.js': second, './f/a.en.js': first }).shared.from).toBe('a');
  });

  it('a module that is not a dictionary adds nothing', () => {
    expect(mergeFragments({ a: { b: 'B' } }, { './f/x.en.js': undefined, './f/y.en.js': 'text', './f/z.en.js': ['x'] }))
      .toEqual({ a: { b: 'B' } });
    expect(mergeFragments(en, {})).toEqual(en);
  });
});
