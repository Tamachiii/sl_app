// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { EXERCISE_TYPES, exerciseType, exerciseTypeLabel } from './exerciseTypes';
import { LANGUAGES, getMessage } from './i18n';
import { contrastRatio } from '../test/contrast.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// The colour of a Parc token, following `var(--x)` to its hex
// (src/styles/parc-tokens.css, a copy of design/parc/tokens.json).
const parc = readFileSync(resolve(root, 'src/styles/parc-tokens.css'), 'utf8');
function token(name) {
  const value = new RegExp(`--${name}:\\s*([^;]+);`).exec(parc)?.[1]?.trim();
  const ref = /^var\(--([\w-]+)\)$/.exec(value ?? '');
  return ref ? token(ref[1]) : value;
}
// A mark is a graphic, not text: 3:1 against what it sits on (WCAG 1.4.11).
const AA_GRAPHIC = 3;

describe('EXERCISE_TYPES', () => {
  it('lists pull and push, each under one id', () => {
    expect(EXERCISE_TYPES.map((type) => type.id)).toEqual(['pull', 'push']);
    expect(new Set(EXERCISE_TYPES.map((type) => type.id)).size).toBe(EXERCISE_TYPES.length);
  });

  it('offers no type the database would refuse', () => {
    // The list feeds the <option>s of the library form. The enum may be
    // ahead of it (a type the app does not draw yet is shown neutral), never
    // behind.
    const schema = readFileSync(resolve(root, 'supabase/schema.sql'), 'utf8');
    const values = /CREATE TYPE exercise_type AS ENUM \(([^)]*)\)/.exec(schema)?.[1];
    const inDatabase = [...(values ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1]);
    expect(inDatabase).toEqual(expect.arrayContaining(['pull', 'push']));
    for (const type of EXERCISE_TYPES) expect(inDatabase).toContain(type.id);
  });

  it('cannot be changed by a caller', () => {
    expect(Object.isFrozen(EXERCISE_TYPES)).toBe(true);
    for (const type of EXERCISE_TYPES) expect(Object.isFrozen(type)).toBe(true);
  });

  it.each(EXERCISE_TYPES.map((type) => [type.id, type]))('%s has a name in every language', (_id, type) => {
    // The key is not a literal t('…') call, so the usage test does not see it.
    for (const lang of LANGUAGES) {
      const label = getMessage(lang, type.labelKey);
      expect(label).not.toBe(type.labelKey);
      expect(label.trim()).not.toBe('');
    }
    expect(exerciseTypeLabel(type.id, (key) => getMessage('en', key))).toBe(getMessage('en', type.labelKey));
  });

  it('names pull and push as the library form does', () => {
    const name = (lang, id) => exerciseTypeLabel(id, (key) => getMessage(lang, key));
    expect([name('en', 'pull'), name('en', 'push')]).toEqual(['Pull', 'Push']);
    expect([name('fr', 'pull'), name('fr', 'push')]).toEqual(['Tirer', 'Pousser']);
    expect([name('de', 'pull'), name('de', 'push')]).toEqual(['Zug', 'Druck']);
  });

  it.each(EXERCISE_TYPES.map((type) => [type.id, type]))('%s is marked in the colour of its charts', (id, type) => {
    // A Parc token of its own, the one its columns are drawn in…
    expect(type.mark).toBe(`bg-chart-${id}`);
    expect(type.color).toBe(`var(--chart-${id})`);
    expect(token(`chart-${id}`)).toMatch(/^#[0-9a-f]{6}$/i);
    // …that stands out of the `surface` a mark sits on — a row, a sheet. The
    // mark is never alone: the type's name is written beside it.
    expect(contrastRatio(token(`chart-${id}`), token('surface'))).toBeGreaterThanOrEqual(AA_GRAPHIC);
  });

  it('gives two types two colours', () => {
    expect(new Set(EXERCISE_TYPES.map((type) => token(`chart-${type.id}`))).size).toBe(EXERCISE_TYPES.length);
  });
});

describe('exerciseType', () => {
  it('finds a listed type', () => {
    expect(exerciseType('pull')).toBe(EXERCISE_TYPES[0]);
    expect(exerciseType('push')).toBe(EXERCISE_TYPES[1]);
  });

  it('gives a neutral entry for a type the list does not have — not push', () => {
    const legs = exerciseType('legs');
    expect(legs).toEqual({ id: 'legs', labelKey: null, mark: 'bg-ink-3', color: 'var(--ink-3)' });
    for (const type of EXERCISE_TYPES) {
      expect(legs.mark).not.toBe(type.mark);
      expect(legs.color).not.toBe(type.color);
    }
  });

  it('gives the neutral entry for no type', () => {
    expect(exerciseType(null)).toMatchObject({ id: null, labelKey: null });
    expect(exerciseType(undefined)).toMatchObject({ id: null, labelKey: null });
    expect(exerciseType('')).toMatchObject({ id: '', labelKey: null });
  });

  it('does not let a caller change the neutral entry for the next one', () => {
    exerciseType('legs').mark = 'bg-chart-push';
    expect(exerciseType('core').mark).toBe('bg-ink-3');
  });
});

describe('exerciseTypeLabel', () => {
  const t = (key) => getMessage('fr', key);

  it('names an unlisted type by its own id and no type by nothing', () => {
    expect(exerciseTypeLabel('legs', t)).toBe('legs');
    expect(exerciseTypeLabel(null, t)).toBe('');
    expect(exerciseTypeLabel(undefined, t)).toBe('');
  });

  it('serves as the source of a select', () => {
    const options = EXERCISE_TYPES.map((type) => ({ value: type.id, label: exerciseTypeLabel(type.id, t) }));
    expect(options).toEqual([
      { value: 'pull', label: 'Tirer' },
      { value: 'push', label: 'Pousser' },
    ]);
  });
});
