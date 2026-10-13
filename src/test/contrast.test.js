// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  AA_TEXT,
  contrastRatio,
  declared,
  mixOver,
  parseRules,
  readStylesheet,
  readTokens,
  relativeLuminance,
  resolveColour,
} from './contrast.js';

// The app is dark-only, and most of its small text — labels, counters, pill
// captions, at 9 to 13px — is drawn in a handful of tokens on a handful of
// surfaces. Whether that text can be read is arithmetic on `src/index.css`,
// and no component test sees it: jsdom applies no cascade. So the ratios are
// recomputed here from the stylesheet, and a token or a surface that moves
// below AA fails here instead of on a phone in daylight.

const css = readStylesheet();
const { light, dark } = readTokens(css);

describe('contrast arithmetic (WCAG 2.x)', () => {
  it('gives the reference ratios', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 10);
    expect(contrastRatio('#abcdef', '#abcdef')).toBe(1);
    // The grey that just passes AA on white, and its neighbour that does not.
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
    expect(contrastRatio('#777777', '#ffffff')).toBeLessThan(AA_TEXT);
  });

  it('does not depend on which colour is the text', () => {
    expect(contrastRatio('#ff5a1f', '#111110')).toBe(contrastRatio('#111110', '#ff5a1f'));
    expect(contrastRatio('#fff', '#000')).toBe(contrastRatio('#ffffff', '#000000'));
  });

  it('orders colours by lightness', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 10);
    expect(relativeLuminance('#807a6e')).toBeLessThan(relativeLuminance('#a8a197'));
  });

  it('paints a colour at an alpha over a surface, per channel', () => {
    // What a tint like `bg-pull/15` is on the surface behind it.
    expect(mixOver('#ff5a1f', 0, '#171716')).toBe('#171716');
    expect(mixOver('#ff5a1f', 1, '#171716')).toBe('#ff5a1f');
    expect(mixOver('#ffffff', 0.5, '#000000')).toBe('#808080');
    expect(mixOver('#fff', 0.15, '#000')).toBe('#262626');
    // Accent at 15% on a card, as Chromium composites it.
    expect(mixOver('#ff5a1f', 0.15, '#171716')).toBe('#3a2117');
  });
});

describe('reading the stylesheet', () => {
  const sample = `
    @theme { --color-ink-900: #111110; --color-ink-400: #807a6e; --font-mono: "JetBrains Mono", monospace; }
    @layer components {
      .sl-card { background: #fff; }
      .dark .sl-card { background: var(--color-ink-900); }
    }
    /* .dark { --color-ink-900: #000000; } */
    .dark { color-scheme: dark; --color-ink-400: #999999; }
    .dark .other { --color-ink-900: #222222; }
    .dark .a,
    .dark .b { color: var(--color-ink-400) !important; }
    .dark .a { color: #FFF; }
  `;

  it('takes the tokens from @theme, and the dark values from the .dark rule alone', () => {
    const tokens = readTokens(sample);
    expect(tokens.light).toEqual({ 'ink-900': '#111110', 'ink-400': '#807a6e' });
    expect(tokens.dark).toEqual({ 'ink-900': '#111110', 'ink-400': '#999999' });
  });

  it('reads a rule inside a layer and a selector of a list, the last rule winning', () => {
    const tokens = readTokens(sample);
    expect(resolveColour(declared(sample, '.dark .sl-card', 'background-color', 'background'), tokens.dark)).toBe('#111110');
    expect(resolveColour(declared(sample, '.dark .b', 'color'), tokens.dark)).toBe('#999999');
    expect(resolveColour(declared(sample, '.dark .a', 'color'), tokens.dark)).toBe('#ffffff');
    expect(declared(sample, '.dark .c', 'color')).toBeUndefined();
  });

  it('refuses a colour it cannot resolve', () => {
    expect(() => resolveColour('var(--color-ink-123)', dark)).toThrow(/no token --color-ink-123/);
    expect(() => resolveColour('color-mix(in srgb, red 10%, transparent)', dark)).toThrow(/not an opaque hex colour/);
    expect(() => resolveColour(declared(css, '.no-such-class', 'color'), dark)).toThrow(/no declared value/);
  });

  it('finds the scale and the fills in src/index.css', () => {
    expect(Object.keys(light)).toEqual(
      expect.arrayContaining(['ink-900', 'ink-850', 'ink-800', 'ink-700', 'ink-400', 'ink-300', 'ink-0', 'accent', 'danger']),
    );
  });
});

// The neutral surfaces of the dark theme: every `.dark <selector>` rule that
// paints a background from the ink scale. Read from the stylesheet, so a remap
// added later is held to the same ratio without being listed here.
const NOT_BEHIND_TEXT = ['.dark .sl-hairline']; // a 1px rule
const inkSurfaces = parseRules(css).flatMap((rule) => {
  const value = rule.declarations['background-color'] ?? rule.declarations.background;
  if (!value || !/^var\(--color-ink-\d+\)/.test(value)) return [];
  return rule.selectors
    .filter((selector) => selector.startsWith('.dark ') && !NOT_BEHIND_TEXT.includes(selector))
    .map((selector) => [selector, resolveColour(value, dark)]);
});

describe('dark theme: muted text (ink-400)', () => {
  const muted = dark['ink-400'];

  it('is one token, read by the class, by .sl-label and by the gray-400 remap', () => {
    // `text-ink-400` is `color: var(--color-ink-400)` and has no remap of its
    // own: a `.dark .text-ink-400` rule would change the class and leave the
    // label, the inline styles and the chart fills on the old value.
    expect(declared(css, '.dark .text-ink-400', 'color')).toBeUndefined();
    expect(declared(css, '.sl-label', 'color')).toBe('var(--color-ink-400)');
    expect(resolveColour(declared(css, '.dark .text-gray-400', 'color'), dark)).toBe(muted);
  });

  it('is painted on the page, on cards and on pills, among other surfaces', () => {
    expect(Object.fromEntries(inkSurfaces)).toMatchObject({
      '.dark body': dark['ink-900'],
      '.dark .bg-gray-50': dark['ink-900'],
      '.dark .sl-card': dark['ink-850'],
      '.dark .bg-white': dark['ink-850'],
      '.dark .bg-ink-100': dark['ink-800'],
      '.dark .bg-gray-100': dark['ink-800'],
      '.dark .bg-ink-200': dark['ink-700'],
      '.dark .hover\\:bg-ink-200:hover': dark['ink-700'],
    });
  });

  it.each(inkSurfaces)('reaches AA on %s (%s)', (_selector, surface) => {
    expect(contrastRatio(muted, surface)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('stays quieter than secondary copy', () => {
    // `text-ink-500` is the step above in the dark theme. Muted text that
    // reached it would flatten the two levels into one.
    const secondary = resolveColour(declared(css, '.dark .text-ink-500', 'color'), dark);
    expect(relativeLuminance(muted)).toBeLessThan(relativeLuminance(secondary));
  });
});

// A button that is a coloured fill — the confirm button of ConfirmDialog, the
// primary CTA — writes its label in one colour, the same in both themes.
describe('text on an accent or danger fill', () => {
  const fills = [
    ['accent', dark.accent],
    ['danger', dark.danger],
  ];
  // Resolved inside each test: a class that is gone fails the tests about it,
  // not the whole file.
  const onFill = () => resolveColour(declared(css, '.sl-on-fill', 'color'), dark);

  it.each(fills)('.sl-on-fill reaches AA on %s (%s)', (_name, fill) => {
    expect(contrastRatio(onFill(), fill)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('.sl-btn-primary reaches AA on its own background, with the same colour', () => {
    const text = resolveColour(declared(css, '.sl-btn-primary', 'color'), dark);
    const fill = resolveColour(declared(css, '.sl-btn-primary', 'background-color', 'background'), dark);
    expect(fill).toBe(dark.accent);
    expect(text).toBe(onFill());
    expect(contrastRatio(text, fill)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('is the same fill and the same label in both themes', () => {
    expect([dark.accent, dark.danger, dark['ink-900']]).toEqual([light.accent, light.danger, light['ink-900']]);
  });

  it.each(fills)('is neither white nor what .dark makes of the dark text classes, which fail on %s', (_name, fill) => {
    // Why the class exists: the two obvious spellings both end up light.
    expect(contrastRatio('#ffffff', fill)).toBeLessThan(AA_TEXT);
    for (const selector of ['.dark .text-ink-900', '.dark .text-gray-900']) {
      const remapped = resolveColour(declared(css, selector, 'color'), dark);
      expect(contrastRatio(remapped, fill)).toBeLessThan(AA_TEXT);
    }
  });

  it('cannot be taken back by a colour class beside it', () => {
    // `!important` inside `@layer components` outranks the unlayered
    // `!important` of the `.dark` remaps and any utility, important or not.
    expect(declared(css, '.sl-on-fill', 'color')).toMatch(/ !important$/);
    const layer = css.match(/@layer components \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(layer).toContain('.sl-on-fill {');
    expect(layer).toContain('.sl-btn-primary {');
  });
});
