// Numbers typed by a person.
//
// Half of the app's users type a weight as "82,5" and the other half as
// "82.5". `<input type="number">` settles that by the language of the BROWSER
// — not of the app, not of the person. In a Chromium whose UI is English the
// comma is dropped and "82,5" becomes 825, a valid number that is saved as
// typed. In WebKit the field reports "" for the same keystrokes, which every
// caller read as "empty" and saved as null: a logged weight wiped, a
// prescribed load shown as bodyweight.
//
// So a typed number is a TEXT field (`ui/DecimalInput`) read by one parser.
// The parser is strict on purpose: what it does not understand is refused,
// never repaired. Repairing is how "82,5" turned into 825.

// What a person may type, as source for two regular expressions: the parser's
// and the `pattern` attribute of the field. One optional separator, comma or
// point, with digits on at least one side: "82", "82,5", "82.5", ",5", "82,".
// No sign, no exponent, no grouping ("1,000.5", "1 000"), no unit.
const DECIMAL = '(?:[0-9]+(?:[.,][0-9]*)?|[.,][0-9]+)';
const WHOLE = '[0-9]+';

const decimalRe = new RegExp(`^${DECIMAL}$`);
const wholeRe = new RegExp(`^${WHOLE}$`);

/**
 * The value of the `pattern` attribute for a field read by
 * `parseDecimalInput`: the same grammar, with the surrounding spaces the
 * parser trims. A browser anchors a pattern at both ends by itself.
 */
export function decimalPattern({ integer = false } = {}) {
  return `\\s*${integer ? WHOLE : DECIMAL}\\s*`;
}

const fail = (reason) => ({ ok: false, reason });

/**
 * Read a number a person typed.
 *
 *   parseDecimalInput('82,5')                    → { ok: true, value: 82.5 }
 *   parseDecimalInput('')                        → { ok: true, value: null }
 *   parseDecimalInput('', { allowEmpty: false }) → { ok: false, reason: 'empty' }
 *   parseDecimalInput('abc')                     → { ok: false, reason: 'format' }
 *   parseDecimalInput('600', { max: 500 })       → { ok: false, reason: 'range' }
 *
 * `value` is `null` for an empty field and for nothing else: text that is not
 * a number is `ok: false`, so a caller that writes `value` only when `ok` can
 * never store null in place of something the person typed. A zero is a zero.
 *
 * Options: `min` and `max` are inclusive; `allowEmpty` (default true) says
 * whether an empty field is an answer; `integer` refuses a separator.
 * A number is accepted as it is (a stored value passed back in), held to the
 * same rules: finite, not negative, inside the range.
 */
export function parseDecimalInput(raw, { min, max, allowEmpty = true, integer = false } = {}) {
  let value;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return fail('format');
    if (integer && !Number.isInteger(raw)) return fail('format');
    if (raw < 0) return fail('range');
    value = raw;
  } else {
    if (raw != null && typeof raw !== 'string') return fail('format');
    // trim() takes the no-break spaces with it, which a paste brings along.
    const text = (raw ?? '').trim();
    if (text === '') return allowEmpty ? { ok: true, value: null } : fail('empty');
    if (!(integer ? wholeRe : decimalRe).test(text)) return fail('format');
    value = Number(text.replace(',', '.'));
    // Enough digits overflow to Infinity: a number, and not one to store.
    if (!Number.isFinite(value)) return fail('range');
  }
  if (min != null && value < min) return fail('range');
  if (max != null && value > max) return fail('range');
  // `-0` passes `>= 0` and prints as "0"; it is stored as what it prints.
  return { ok: true, value: value === 0 ? 0 : value };
}

/**
 * The text a field STARTS with for a stored value: '' for nothing, "82.5" for
 * 82.5 and for the "82.50" a numeric column can come back as.
 *
 * For seeding state, once. Never for the text while it is typed: rewriting
 * "82.0" to "82" under the cursor turns the "82.05" being typed into 825.
 */
export function decimalText(stored) {
  if (stored == null) return '';
  const number = typeof stored === 'string' && stored.trim() !== '' ? Number(stored) : stored;
  return typeof number === 'number' && Number.isFinite(number) ? String(number) : '';
}
