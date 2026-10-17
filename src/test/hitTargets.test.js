// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { declared, parseRules, readStylesheet } from './contrast.js';

// 44px is the smallest target a thumb hits reliably, and jsdom has no layout
// to measure one with. What can be held is the stylesheet: the two classes
// that carry the size — `.sl-pill-btn`, a pill that grows to it, and
// `.sl-hit`, a small control with a larger area to hit — say 44px, and say it
// in a way that moves nothing around them and that a caller can still adjust.

const css = readStylesheet();
const TARGET = '44px';

// The `@layer components { … }` block as text, and the selectors of its rules
// in source order.
const layer = css.match(/@layer components \{[\s\S]*?\n\}/)?.[0] ?? '';
const layerSelectors = parseRules(layer).flatMap((rule) => rule.selectors);

describe('.sl-pill-btn: a pill that is a button', () => {
  it('is 44px high and wide at least', () => {
    expect(declared(css, '.sl-pill-btn', 'min-height')).toBe(TARGET);
    expect(declared(css, '.sl-pill-btn', 'min-width')).toBe(TARGET);
  });

  it('centres its label in the height it gained', () => {
    expect(declared(css, '.sl-pill-btn', 'display')).toBe('inline-flex');
    expect(declared(css, '.sl-pill-btn', 'align-items')).toBe('center');
    expect(declared(css, '.sl-pill-btn', 'justify-content')).toBe('center');
  });

  it('sets no fixed size and no colour: those stay the caller\'s', () => {
    const own = parseRules(css)
      .filter((rule) => rule.selectors.includes('.sl-pill-btn'))
      .flatMap((rule) => Object.keys(rule.declarations));
    expect(own).not.toEqual(expect.arrayContaining(['height']));
    expect(own).not.toEqual(expect.arrayContaining(['width']));
    expect(own.filter((property) => /color|background/.test(property))).toEqual([]);
  });

  it('stands in the components layer, after .sl-pill', () => {
    // In the layer: a utility beside it (`px-2`, `w-full`) wins. After the
    // pill: its padding wins over the pill's `4px 10px`, both being one class.
    expect(layerSelectors).toContain('.sl-pill-btn');
    expect(layerSelectors.indexOf('.sl-pill-btn')).toBeGreaterThan(layerSelectors.indexOf('.sl-pill'));
    expect(declared(css, '.sl-pill-btn', 'padding-inline')).toBeDefined();
    expect(declared(css, '.sl-pill-btn', 'padding')).toBeUndefined();
  });

  it('is not made important, which a utility could not undo', () => {
    for (const rule of parseRules(css).filter((r) => r.selectors.some((s) => /^\.sl-(pill-btn|hit)/.test(s)))) {
      for (const value of Object.values(rule.declarations)) expect(value).not.toMatch(/!important/);
    }
  });
});

describe('.sl-hit: a small control with a 44px area to hit', () => {
  it('draws the area as a pseudo-element of the control, out of the flow', () => {
    expect(declared(css, '.sl-hit', 'position')).toBe('relative');
    expect(declared(css, '.sl-hit::after', 'position')).toBe('absolute');
    expect(declared(css, '.sl-hit::after', 'content')).toBe('""');
  });

  it('makes the area 44px at least, and never smaller than the control', () => {
    expect(declared(css, '.sl-hit::after', 'min-width')).toBe(TARGET);
    expect(declared(css, '.sl-hit::after', 'min-height')).toBe(TARGET);
    expect(declared(css, '.sl-hit::after', 'width')).toBe('100%');
    expect(declared(css, '.sl-hit::after', 'height')).toBe('100%');
  });

  it('centres the area on the control', () => {
    expect(declared(css, '.sl-hit::after', 'top')).toBe('50%');
    expect(declared(css, '.sl-hit::after', 'left')).toBe('50%');
    expect(declared(css, '.sl-hit::after', 'transform')).toBe('translate(-50%, -50%)');
  });

  it('gives the control itself no size, so nothing around it moves', () => {
    const own = parseRules(css)
      .filter((rule) => rule.selectors.includes('.sl-hit'))
      .flatMap((rule) => Object.keys(rule.declarations));
    expect(own).toEqual(['position']);
  });

  it('stands in the components layer', () => {
    expect(layerSelectors).toEqual(expect.arrayContaining(['.sl-hit', '.sl-hit::after']));
  });
});

// The Parc controls (src/styles/bundle.css and parc-app.css): every class a
// thumb hits is 44px at least — `target-min` —, the primary button 56px and a
// row 60px. A height written as a token is read through parc-tokens.css.
describe('Parc: what a thumb hits is 44px at least', () => {
  const tokens = readStylesheet('src/styles/parc-tokens.css');
  const parc = readStylesheet('src/styles/bundle.css') + readStylesheet('src/styles/parc-app.css');
  const px = (value) => {
    const token = /^var\(--([\w-]+)\)$/.exec(value ?? '')?.[1];
    const resolved = token ? declared(tokens, ':root', `--${token}`) : value;
    return Number.parseFloat(resolved);
  };
  const size = (selector, ...properties) => px(declared(parc, selector, ...properties));

  it.each([
    ['.pk-btn', 'min-height'],
    ['.pk-btn', 'min-width'],
    ['.pk-icon-btn', 'width'],
    ['.pk-icon-btn', 'height'],
    ['.pk-chip', 'height'],
    ['.pk-tab', 'min-height'],
    ['.pk-field', 'min-height'],
    ['.pk-row', 'min-height'],
    ['.pk-sidenav-item', 'min-height'],
  ])('%s has a %s of 44px or more', (selector, property) => {
    expect(size(selector, property)).toBeGreaterThanOrEqual(44);
  });

  it('makes the primary button 56px and a row 60px', () => {
    expect(size('.pk-btn-lg', 'min-height')).toBe(56);
    expect(size('.pk-row', 'min-height')).toBe(60);
  });

  it('builds a segment of the segmented control on .pk-btn', () => {
    // SegmentedControl writes `pk-btn pk-segment`: the segment sets no height.
    expect(declared(parc, '.pk-segment', 'height', 'min-height')).toBeUndefined();
  });
});
