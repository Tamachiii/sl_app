// The Parc tokens as the app reads them (src/styles/parc-tokens.css) against
// their source, design/parc/tokens.json: every colour, space, radius and
// shadow of the JSON is a variable of the stylesheet with the same value, and
// the pairs the design system writes text with reach 4.5:1.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { AA_TEXT, contrastRatio } from './contrast';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const tokens = JSON.parse(readFileSync(resolve(root, 'design/parc/tokens.json'), 'utf8'));
const stylesheet = readFileSync(resolve(root, 'src/styles/parc-tokens.css'), 'utf8');

// `--name: value;` of the :root rule. `\.` in a name (`--space-1\.5`) is the
// escaped dot of the JSON's `space-1.5`.
const variables = new Map(
  [...stylesheet.matchAll(/--([\w\\.-]+):\s*([^;]+);/g)].map(([, name, value]) => [
    name.replace(/\\\./g, '.'),
    value.trim(),
  ]),
);

// A JSON value `{ground}` is the stylesheet's `var(--ground)`.
const asCss = (value) => value.replace(/^\{([\w.-]+)\}$/, 'var(--$1)');

const families = [
  ['color', tokens.color.tokens],
  ['spacing', tokens.spacing.tokens],
  ['radius', tokens.radius.tokens],
  ['shadow', tokens.shadow.tokens],
];

describe('src/styles/parc-tokens.css', () => {
  for (const [family, list] of families) {
    it(`carries every ${family} token of tokens.json with its value`, () => {
      for (const { name, value } of list) {
        expect(variables.get(name), `--${name}`).toBe(asCss(value));
      }
    });
  }

  it('names Archivo as the one family', () => {
    expect(variables.get('font-sans')).toMatch(/^"Archivo Variable", "Archivo"/);
  });
});

// The colour a token ends up with, following `var(--x)` to its hex.
function colour(name) {
  const value = variables.get(name);
  const ref = /^var\(--([\w-]+)\)$/.exec(value);
  return ref ? colour(ref[1]) : value;
}

describe('Parc contrast', () => {
  // The text colours of design/parc/README.md ("Couleur") on the surfaces the
  // same page puts them on. ink-3 is text on surface only.
  const TEXT = [
    ['ink', ['surface', 'ground', 'fill', 'blue-soft', 'amber-soft', 'red-soft']],
    ['ink-2', ['surface', 'ground', 'fill', 'blue-soft']],
    ['ink-3', ['surface']],
    ['blue', ['surface', 'ground', 'blue-soft']],
    ['on-blue', ['blue', 'blue-pressed', 'red']],
    ['amber', ['surface', 'ground', 'amber-soft']],
    ['red', ['surface', 'ground', 'red-soft']],
  ];
  for (const [text, surfaces] of TEXT) {
    for (const surface of surfaces) {
      it(`${text} on ${surface} is at least 4.5:1`, () => {
        expect(contrastRatio(colour(text), colour(surface))).toBeGreaterThanOrEqual(AA_TEXT);
      });
    }
  }

  // A field's outline and a chart series are not text: 3:1 (WCAG 1.4.11).
  const NON_TEXT = [
    ['line-control', 'surface'],
    ['line-control', 'ground'],
    ['chart-pull', 'surface'],
    ['chart-push', 'surface'],
  ];
  for (const [graphic, surface] of NON_TEXT) {
    it(`${graphic} on ${surface} is at least 3:1`, () => {
      expect(contrastRatio(colour(graphic), colour(surface))).toBeGreaterThanOrEqual(3);
    });
  }

  it('ink-3 is not a text colour on ground, which is why it stays on surface', () => {
    expect(contrastRatio(colour('ink-3'), colour('ground'))).toBeLessThan(AA_TEXT);
  });
});
