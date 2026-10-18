// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { declared, readStylesheet } from './contrast.js';

// A date or time field holds in a phone's column. iOS Safari draws one as a
// native control with a width of its own, which `width: 100%` does not hold
// back: on an iPhone the session editor's « Date conseillée » ran past the
// screen and the page scrolled sideways. Drawn as a plain field that may
// shrink, it takes the width of its column. jsdom lays nothing out: the rule
// is read from the stylesheet.
describe('Parc: a date field holds in a phone\'s column', () => {
  const parc = readStylesheet('src/styles/bundle.css') + readStylesheet('src/styles/parc-app.css');

  it.each(['.pk-field[type="date"]', '.pk-field[type="time"]'])('%s is a plain field that can shrink', (selector) => {
    expect(declared(parc, selector, '-webkit-appearance')).toBe('none');
    expect(declared(parc, selector, 'appearance')).toBe('none');
    expect(declared(parc, selector, 'min-width')).toBe('0');
    expect(declared(parc, selector, 'max-width')).toBe('100%');
  });

  it('still takes the width and the height of a field', () => {
    expect(declared(parc, '.pk-field', 'width')).toBe('100%');
    expect(declared(parc, '.pk-field', 'min-height')).toBe('var(--target-min)');
  });

  it('starts its value at the left, as a field of text does', () => {
    expect(declared(parc, '.pk-field[type="date"]::-webkit-date-and-time-value', 'text-align')).toBe('left');
  });
});
