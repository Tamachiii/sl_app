// Dates, times, numbers, day names and plurals in the language of the APP.
//
// The app has its own language switch, so the language of a formatted value
// is `lang` (from useI18n), never the device's: `date.toLocaleDateString()`
// with no locale prints "10/13/2026" inside a French sentence on a phone set
// to English. And a plural is not `n === 1`: French says "0 séance", and the
// rule belongs to the language, not to the call site.
//
// Every function takes `lang` first and is pure: no React, no dictionary (this
// file does not import ./index.js, which only runs under Vite), no state but
// the day-name tables it has already built.

/**
 * The one table from the app's languages to the locale Intl is asked for.
 * Its keys are LANGUAGES of ./index.js; format.test.js holds the two together.
 */
export const LOCALES = Object.freeze({ en: 'en-US', fr: 'fr-FR', de: 'de-DE' });

/** The Intl locale of an app language; English for one the app does not have. */
export function localeOf(lang) {
  return Object.prototype.hasOwnProperty.call(LOCALES, lang) ? LOCALES[lang] : LOCALES.en;
}

// ---- dates ----------------------------------------------------------------

const BARE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A Date from what the app holds, or null.
 *
 * A bare calendar date — "2026-10-13", what `scheduled_date` and
 * `performed_on` are — is that day in the DEVICE's zone. `new Date()` reads
 * it as midnight UTC, which is the day before for everyone west of Greenwich.
 * A timestamp, a number of milliseconds or a Date is the instant it says.
 */
export function toDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const bare = typeof value === 'string' ? BARE_DATE.exec(value) : null;
  const date = bare ? new Date(Number(bare[1]), Number(bare[2]) - 1, Number(bare[3])) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// A formatter is built per call. Building one costs microseconds, and one
// kept would keep the time zone the device had when it was built.
function dateTimeText(lang, value, options) {
  const date = toDate(value);
  // Intl throws on an invalid date; a missing date is an empty label.
  return date ? new Intl.DateTimeFormat(localeOf(lang), options).format(date) : '';
}

/**
 * A date: "Oct 13, 2026" · "13 oct. 2026" · "13. Okt. 2026" by default.
 * `options` are Intl.DateTimeFormat's, e.g. `{ weekday: 'short', day:
 * 'numeric', month: 'short' }`. '' for no date.
 */
export function formatDate(lang, value, options = { day: 'numeric', month: 'short', year: 'numeric' }) {
  return dateTimeText(lang, value, options);
}

/** A time of day: "02:05 PM" · "14:05" · "14:05" by default. '' for no date. */
export function formatTime(lang, value, options = { hour: '2-digit', minute: '2-digit' }) {
  return dateTimeText(lang, value, options);
}

// formatDate's date with formatTime's time. Spelled out rather than
// `dateStyle: 'medium'`, which German writes all in digits ("13.10.2026").
const DATE_TIME = { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' };

/**
 * A date with its time: "Oct 13, 2026, 02:05 PM" · "13 oct. 2026, 14:05" ·
 * "13. Okt. 2026, 14:05" by default. '' for no date.
 */
export function formatDateTime(lang, value, options = DATE_TIME) {
  return dateTimeText(lang, value, options);
}

/**
 * A span of days, written the way the language writes one: "Jul 6 – 12" ·
 * "6–12 juil." · "6.–12. Juli". '' unless both ends are dates.
 */
export function formatDateRange(lang, start, end, options = { day: 'numeric', month: 'short' }) {
  const from = toDate(start);
  const to = toDate(end);
  return from && to ? new Intl.DateTimeFormat(localeOf(lang), options).formatRange(from, to) : '';
}

/**
 * A distance in days from today, in words: -1 → "yesterday" · "hier" ·
 * "gestern", -3 → "3 days ago" · "il y a 3 jours" · "vor 3 Tagen", 0 →
 * "today". '' for no number.
 */
export function formatRelativeDays(lang, days) {
  if (!Number.isFinite(days)) return '';
  return new Intl.RelativeTimeFormat(localeOf(lang), { numeric: 'auto' }).format(Math.trunc(days), 'day');
}

// ---- numbers --------------------------------------------------------------

/**
 * A number for reading: 1234.5 → "1,234.5" · "1 234,5" · "1.234,5". `options`
 * are Intl.NumberFormat's (`{ maximumFractionDigits: 1 }`). '' for no number.
 * For the text of a field, see decimalText in lib/number.js: a field is not
 * grouped.
 */
export function formatNumber(lang, value, options) {
  if (value == null || value === '') return '';
  const number = Number(value);
  return Number.isFinite(number) ? new Intl.NumberFormat(localeOf(lang), options).format(number) : '';
}

// ---- day names ------------------------------------------------------------

// Monday 1 January 2024, in UTC and printed in UTC: the names do not depend
// on where the device is.
const MONDAY = Date.UTC(2024, 0, 1);
const DAY_MS = 24 * 60 * 60 * 1000;
const WIDTHS = ['narrow', 'short', 'long'];
const dayTables = new Map();

/**
 * The seven day names, MONDAY FIRST: index `day_number - 1`, the convention of
 * lib/day.js (1 = Monday … 7 = Sunday).
 *
 *   dayNames('fr', 'narrow') → L M M J V S D
 *   dayNames('fr', 'short')  → lun mar mer jeu ven sam dim
 *   dayNames('fr', 'long')   → lundi mardi …
 *
 * 'short' drops the full stop French puts on an abbreviation ("lun."): these
 * are labels of pills and columns, which no other language of the app
 * punctuates. A date written by formatDate keeps it. Case is the language's
 * own (French and German differ); a pill upper-cases in CSS.
 */
export function dayNames(lang, width = 'short') {
  const style = WIDTHS.includes(width) ? width : 'short';
  const locale = localeOf(lang);
  const key = `${locale}|${style}`;
  if (!dayTables.has(key)) {
    const format = new Intl.DateTimeFormat(locale, { weekday: style, timeZone: 'UTC' });
    const names = Array.from({ length: 7 }, (_, i) => {
      const name = format.format(new Date(MONDAY + i * DAY_MS));
      return style === 'short' ? name.replace(/\.$/, '') : name;
    });
    dayTables.set(key, Object.freeze(names));
  }
  return dayTables.get(key);
}

/** The name of one `day_number` (1 = Monday … 7 = Sunday); '' for any other value. */
export function dayName(lang, dayNumber, width = 'short') {
  return Number.isInteger(dayNumber) && dayNumber >= 1 && dayNumber <= 7
    ? dayNames(lang, width)[dayNumber - 1]
    : '';
}

// ---- plurals --------------------------------------------------------------

/**
 * The plural category of `n` in the language: 'one' or 'other' in English and
 * German, and in French 'one' for 0, 1 and 1.5 too ("0 séance", "1,5 heure"),
 * with 'many' for the millions.
 */
export function pluralCategory(lang, n) {
  return Number.isFinite(n) ? new Intl.PluralRules(localeOf(lang)).select(n) : 'other';
}

/**
 * The dictionary key for `n` things. The dictionaries carry two forms per
 * counted string, `…One` and `…Many`:
 *
 *   t(pluralKey(lang, n, 'student.training.sessions'), { n })
 *   // → student.training.sessionsOne | student.training.sessionsMany
 *
 * A pair that is not named that way is given in full:
 *
 *   t(pluralKey(lang, n, { one: 'offline.bannerOfflineWithPending',
 *                          other: 'offline.bannerOfflineWithPendingMany' }), { n })
 *
 * Every category but 'one' takes the plural form.
 */
export function pluralKey(lang, n, keys) {
  const one = pluralCategory(lang, n) === 'one';
  if (typeof keys === 'string') return `${keys}${one ? 'One' : 'Many'}`;
  return (one ? keys.one : keys.other) ?? keys.other ?? keys.one;
}
