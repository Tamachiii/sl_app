// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { EXERCISE_TYPES, exerciseType, exerciseTypeLabel } from './exerciseTypes';
import { LANGUAGES, getMessage } from './i18n';
import {
  AA_TEXT,
  contrastRatio,
  declared,
  mixOver,
  readStylesheet,
  readTokens,
  resolveColour,
} from '../test/contrast.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const css = readStylesheet();
const { light, dark } = readTokens(css);

// `bg-pull/15 text-pull` → { token: 'pull', alpha: 0.15 }
function tintOf(className) {
  const match = /^bg-([a-z]+)\/(\d+) text-([a-z]+)$/.exec(className);
  if (!match) throw new Error(`not a "bg-<token>/<n> text-<token>" pair: ${className}`);
  if (match[1] !== match[3]) throw new Error(`tint and text of two tokens: ${className}`);
  return { token: match[1], alpha: Number(match[2]) / 100 };
}

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

  it.each(EXERCISE_TYPES.map((type) => [type.id, type]))('%s is drawn in a colour token of its own', (_id, type) => {
    const { token } = tintOf(type.className);
    // In @theme, so that Tailwind writes `bg-<token>/15` and `text-<token>`…
    expect(light[token]).toMatch(/^#[0-9a-f]{6}$/i);
    // …the same in the dark theme, with no remap that would move the text
    // and leave the tint…
    expect(dark[token]).toBe(light[token]);
    expect(declared(css, `.dark .text-${token}`, 'color')).toBeUndefined();
    // …and the one the entry hands to a chart.
    expect(type.color).toBe(`var(--color-${token})`);
  });

  // A badge sits on a card (the library, the review) or on a row of a dialog,
  // hovered or not (the pickers): ink-850; and the page behind is ink-900.
  const surfaces = [
    ['a card', resolveColour(declared(css, '.dark .sl-card', 'background-color', 'background'), dark)],
    ['a dialog', resolveColour(declared(css, '.dark .bg-white', 'background-color'), dark)],
    ['a hovered row', resolveColour(declared(css, '.dark .hover\\:bg-ink-50:hover', 'background-color'), dark)],
    ['the page', resolveColour(declared(css, '.dark body', 'background-color'), dark)],
  ];

  it.each(EXERCISE_TYPES.flatMap((type) => surfaces.map(([name, surface]) => [type.id, name, type, surface])))(
    '%s reaches AA on its own tint over %s',
    (_id, _name, type, surface) => {
      const { token, alpha } = tintOf(type.className);
      const tint = mixOver(dark[token], alpha, surface);
      expect(contrastRatio(dark[token], tint)).toBeGreaterThanOrEqual(AA_TEXT);
    },
  );
});

describe('exerciseType', () => {
  it('finds a listed type', () => {
    expect(exerciseType('pull')).toBe(EXERCISE_TYPES[0]);
    expect(exerciseType('push')).toBe(EXERCISE_TYPES[1]);
  });

  it('gives a neutral entry for a type the list does not have — not push', () => {
    const legs = exerciseType('legs');
    expect(legs).toEqual({ id: 'legs', labelKey: null, className: 'bg-ink-100 text-ink-500', color: 'var(--color-ink-400)' });
    for (const type of EXERCISE_TYPES) {
      expect(legs.className).not.toBe(type.className);
      expect(legs.color).not.toBe(type.color);
    }
  });

  it('draws the neutral entry readably', () => {
    const text = resolveColour(declared(css, '.dark .text-ink-500', 'color'), dark);
    const fill = resolveColour(declared(css, '.dark .bg-ink-100', 'background-color'), dark);
    expect(contrastRatio(text, fill)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('gives the neutral entry for no type', () => {
    expect(exerciseType(null)).toMatchObject({ id: null, labelKey: null });
    expect(exerciseType(undefined)).toMatchObject({ id: null, labelKey: null });
    expect(exerciseType('')).toMatchObject({ id: '', labelKey: null });
  });

  it('does not let a caller change the neutral entry for the next one', () => {
    exerciseType('legs').className = 'bg-push/15 text-push';
    expect(exerciseType('core').className).toBe('bg-ink-100 text-ink-500');
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
