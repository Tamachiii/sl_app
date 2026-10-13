// Contrast of the design tokens, computed from the stylesheet as text.
//
// jsdom applies no cascade, so a component test cannot see what colour a class
// ends up with. What can be read is `src/index.css` itself: the tokens of
// `@theme`, what `.dark` sets on top of them, and the rule that paints each
// surface. These helpers turn that text into colours and WCAG ratios, for
// `contrast.test.js` and for any later test that needs "is this token readable
// on that surface".
//
// The reader is deliberately small: it knows rules that hold declarations and
// nothing else (an `@layer { … }` wrapper is seen through, a rule inside it is
// read like any other). `index.css` holds no other construct.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// The smallest ratio WCAG 2.x level AA accepts for text below 18.66px bold /
// 24px regular — every label, pill and button of the app.
export const AA_TEXT = 4.5;

export function readStylesheet(rel = 'src/index.css') {
  return readFileSync(resolve(root, rel), 'utf8');
}

function normalizeHex(colour) {
  const digits = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(colour)?.[1].toLowerCase();
  if (!digits) throw new Error(`not an opaque hex colour: ${colour}`);
  return `#${digits.length === 3 ? [...digits].map((d) => d + d).join('') : digits}`;
}

// WCAG 2.x relative luminance of an sRGB colour (#rgb or #rrggbb).
export function relativeLuminance(hex) {
  const n = parseInt(normalizeHex(hex).slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((channel) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// WCAG 2.x contrast ratio, 1 to 21. The order of the two colours is free.
export function contrastRatio(a, b) {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

// Every rule that holds declarations: [{ selectors, declarations }]. A rule
// that is written twice appears twice, in source order.
export function parseRules(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...text.matchAll(/([^{};]+)\{([^{}]*)\}/g)].map(([, prelude, body]) => ({
    selectors: prelude.split(',').map((selector) => selector.trim().replace(/\s+/g, ' ')),
    declarations: Object.fromEntries(
      body
        .split(';')
        .map((declaration) => declaration.trim())
        .filter(Boolean)
        .map((declaration) => {
          const colon = declaration.indexOf(':');
          return [declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim()];
        }),
    ),
  }));
}

const colourTokens = (declarations) =>
  Object.fromEntries(
    Object.entries(declarations)
      .filter(([property]) => property.startsWith('--color-'))
      .map(([property, value]) => [property.slice('--color-'.length), value]),
  );

// The colour tokens by name (`ink-400`, `accent`, …): `light` is `@theme`,
// `dark` is `@theme` with what the `.dark` rule itself sets on top — the
// values the app runs with, `class="dark"` being on <html>.
export function readTokens(css) {
  const rules = parseRules(css);
  const pick = (selector) =>
    rules
      .filter((rule) => rule.selectors.length === 1 && rule.selectors[0] === selector)
      .reduce((all, rule) => ({ ...all, ...colourTokens(rule.declarations) }), {});
  const light = pick('@theme');
  return { light, dark: { ...light, ...pick('.dark') } };
}

// A declared value as a hex colour: `var(--color-ink-850) !important` and
// `#fff` both resolve; anything else (a `color-mix`, a keyword, the
// `undefined` of a rule that is gone) throws, so a test never compares
// against a colour it did not understand.
export function resolveColour(value, tokens) {
  if (typeof value !== 'string') throw new Error('no declared value to resolve: the rule or the property is missing');
  const bare = value.replace(/\s*!important\s*$/, '').trim();
  const token = bare.match(/^var\(--color-([\w-]+)\)$/)?.[1];
  if (token && tokens[token] === undefined) throw new Error(`no token --color-${token}`);
  return normalizeHex(token ? tokens[token] : bare);
}

// The value a selector declares for one of the given properties — the last
// rule in the source wins, as it does between rules of the same weight.
// `undefined` when no rule with that selector declares any of them.
export function declared(css, selector, ...properties) {
  let found;
  for (const rule of parseRules(css)) {
    if (!rule.selectors.includes(selector)) continue;
    for (const property of properties) {
      if (rule.declarations[property] !== undefined) found = rule.declarations[property];
    }
  }
  return found;
}
