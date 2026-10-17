// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { declared, readStylesheet } from './contrast.js';

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
