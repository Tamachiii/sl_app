// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { decimalPattern, decimalText, parseDecimalInput } from './number';

const ok = (value) => ({ ok: true, value });
const no = (reason) => ({ ok: false, reason });

describe('parseDecimalInput: what a person types', () => {
  it.each([
    ['82,5', 82.5],
    ['82.5', 82.5],
    ['82', 82],
    [',5', 0.5],
    ['.5', 0.5],
    ['82,', 82],
    ['82.', 82],
    ['0', 0],
    ['0,0', 0],
    ['007', 7],
    ['82,50', 82.5],
    ['2,25', 2.25],
  ])('reads %j as %d', (text, value) => {
    expect(parseDecimalInput(text)).toEqual(ok(value));
  });

  it('reads the comma as the decimal separator, never as nothing', () => {
    // The finding: a browser whose UI is not French dropped the comma of a
    // number field and saved 825 kg.
    expect(parseDecimalInput('82,5').value).not.toBe(825);
    expect(parseDecimalInput('82,5')).toEqual(parseDecimalInput('82.5'));
  });

  it('trims the spaces around the number, no-break ones included', () => {
    expect(parseDecimalInput(' 82,5 ')).toEqual(ok(82.5));
    expect(parseDecimalInput(' 82,5 ')).toEqual(ok(82.5));
    expect(parseDecimalInput('\t82\n')).toEqual(ok(82));
  });

  it.each([
    'abc',
    '82kg',
    '82 kg',
    '8 2',
    '1,000.5',
    '1.000,5',
    '1 000',
    '1e3',
    '-5',
    '+5',
    '−5',
    ',',
    '.',
    '8,,5',
    '8.5.1',
    '0x10',
    'Infinity',
    'NaN',
    '٨٢',
    '½',
  ])('refuses %j instead of guessing', (text) => {
    expect(parseDecimalInput(text)).toEqual(no('format'));
  });

  it('gives null for an empty field and for nothing else', () => {
    expect(parseDecimalInput('')).toEqual(ok(null));
    expect(parseDecimalInput('   ')).toEqual(ok(null));
    expect(parseDecimalInput(null)).toEqual(ok(null));
    expect(parseDecimalInput(undefined)).toEqual(ok(null));
    // What used to be saved as null: text a number field could not read.
    for (const garbage of ['abc', '82kg', '1e3', '-5', ',', '8,,5']) {
      const result = parseDecimalInput(garbage);
      expect(result.ok).toBe(false);
      expect(result).not.toHaveProperty('value');
    }
  });

  it('keeps a zero a zero', () => {
    expect(parseDecimalInput('0')).toEqual(ok(0));
    expect(parseDecimalInput('0').value).not.toBeNull();
    expect(Object.is(parseDecimalInput(-0).value, 0)).toBe(true);
  });

  it('refuses an empty field when the caller needs an answer', () => {
    expect(parseDecimalInput('', { allowEmpty: false })).toEqual(no('empty'));
    expect(parseDecimalInput('  ', { allowEmpty: false })).toEqual(no('empty'));
    expect(parseDecimalInput(null, { allowEmpty: false })).toEqual(no('empty'));
    expect(parseDecimalInput('0', { allowEmpty: false })).toEqual(ok(0));
  });

  it('holds the number to an inclusive range', () => {
    const weight = { min: 1, max: 500 };
    expect(parseDecimalInput('1', weight)).toEqual(ok(1));
    expect(parseDecimalInput('500', weight)).toEqual(ok(500));
    expect(parseDecimalInput('0,5', weight)).toEqual(no('range'));
    expect(parseDecimalInput('500,5', weight)).toEqual(no('range'));
    expect(parseDecimalInput('0', { min: 0 })).toEqual(ok(0));
    // The range says nothing about an empty field: `allowEmpty` does.
    expect(parseDecimalInput('', weight)).toEqual(ok(null));
    // Garbage is garbage before it is out of range.
    expect(parseDecimalInput('abc', weight)).toEqual(no('format'));
  });

  it('refuses digits that overflow', () => {
    expect(parseDecimalInput('9'.repeat(400))).toEqual(no('range'));
  });

  it('reads whole numbers only when asked to', () => {
    const whole = { integer: true };
    expect(parseDecimalInput('8', whole)).toEqual(ok(8));
    expect(parseDecimalInput(' 12 ', whole)).toEqual(ok(12));
    expect(parseDecimalInput('', whole)).toEqual(ok(null));
    // "8,5" reps was 85 in the browsers that dropped the comma.
    expect(parseDecimalInput('8,5', whole)).toEqual(no('format'));
    expect(parseDecimalInput('8.0', whole)).toEqual(no('format'));
    expect(parseDecimalInput('8,', whole)).toEqual(no('format'));
    expect(parseDecimalInput(8.5, whole)).toEqual(no('format'));
    expect(parseDecimalInput('0', { integer: true, min: 1 })).toEqual(no('range'));
  });

  it('takes a number as it is, under the same rules', () => {
    expect(parseDecimalInput(82.5)).toEqual(ok(82.5));
    expect(parseDecimalInput(0)).toEqual(ok(0));
    expect(parseDecimalInput(-5)).toEqual(no('range'));
    expect(parseDecimalInput(600, { max: 500 })).toEqual(no('range'));
    expect(parseDecimalInput(NaN)).toEqual(no('format'));
    expect(parseDecimalInput(Infinity)).toEqual(no('format'));
  });

  it('refuses anything that is neither text nor a number', () => {
    expect(parseDecimalInput(true)).toEqual(no('format'));
    expect(parseDecimalInput({})).toEqual(no('format'));
    expect(parseDecimalInput(['82'])).toEqual(no('format'));
  });
});

describe('decimalPattern: the pattern attribute of the field', () => {
  // A browser compiles `pattern` with the `v` flag and anchors it itself.
  const matches = (pattern, text) => new RegExp(`^(?:${pattern})$`, 'v').test(text);

  const samples = [
    '82,5', '82.5', '82', ',5', '.5', '82,', ' 82,5 ', '0', '007',
    'abc', '82kg', '8 2', '1,000.5', '1e3', '-5', '+5', ',', '.', '8,,5', '٨٢',
  ];

  it.each(samples)('agrees with the parser on %j', (text) => {
    expect(matches(decimalPattern(), text)).toBe(parseDecimalInput(text).ok);
  });

  it.each(samples)('agrees with the parser on %j as a whole number', (text) => {
    expect(matches(decimalPattern({ integer: true }), text)).toBe(parseDecimalInput(text, { integer: true }).ok);
  });
});

describe('decimalText: the text a field starts with', () => {
  it('writes a stored number the way the parser reads it back', () => {
    expect(decimalText(82.5)).toBe('82.5');
    expect(decimalText(0)).toBe('0');
    expect(decimalText('82.50')).toBe('82.5');
    expect(decimalText('100')).toBe('100');
    for (const stored of [82.5, 0, 100, 2.25, '82.50']) {
      expect(parseDecimalInput(decimalText(stored))).toEqual(ok(Number(stored)));
    }
  });

  it('is empty for nothing and for what is not a number', () => {
    expect(decimalText(null)).toBe('');
    expect(decimalText(undefined)).toBe('');
    expect(decimalText('')).toBe('');
    expect(decimalText('  ')).toBe('');
    expect(decimalText('abc')).toBe('');
    expect(decimalText(NaN)).toBe('');
    expect(decimalText({})).toBe('');
  });
});
