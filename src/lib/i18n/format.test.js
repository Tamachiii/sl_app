// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { LANGUAGES, getMessage } from './index';
import {
  LOCALES,
  dayName,
  dayNames,
  formatDate,
  formatDateRange,
  formatDateTime,
  formatNumber,
  formatRelativeDays,
  formatTime,
  localeOf,
  pluralCategory,
  pluralKey,
  toDate,
} from './format';

// Intl separates with no-break spaces of several kinds ("1 234,5", "2:05 PM"):
// an expectation is written with plain ones.
const plain = (text) => text.replace(/\s/g, ' ');

// Run `fn` as a device in `timeZone` would. Node follows process.env.TZ while
// it runs; the first line fails if that ever stops being true here, so that a
// zone test cannot pass for having run in the machine's own zone.
function inTimeZone(timeZone, fn) {
  const before = process.env.TZ;
  process.env.TZ = timeZone;
  try {
    expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(timeZone);
    return fn();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}
// West of Greenwich, far east of it, and the zone most athletes are in.
const ZONES = ['America/Los_Angeles', 'Pacific/Kiritimati', 'Europe/Paris'];

describe('the locale table', () => {
  it('has one locale per language of the app, and no other', () => {
    expect(Object.keys(LOCALES)).toEqual(LANGUAGES);
    for (const lang of LANGUAGES) {
      expect(Intl.DateTimeFormat.supportedLocalesOf(LOCALES[lang])).toEqual([LOCALES[lang]]);
      expect(LOCALES[lang].startsWith(`${lang}-`)).toBe(true);
    }
  });

  it('cannot be changed by a caller', () => {
    expect(Object.isFrozen(LOCALES)).toBe(true);
  });

  it('falls back to English for a language the app does not have', () => {
    expect(localeOf('fr')).toBe('fr-FR');
    expect(localeOf('es')).toBe('en-US');
    expect(localeOf(undefined)).toBe('en-US');
    expect(localeOf(null)).toBe('en-US');
    // Not what an object carries by itself.
    expect(localeOf('constructor')).toBe('en-US');
    expect(localeOf('toString')).toBe('en-US');
  });
});

describe('toDate', () => {
  it('reads a bare calendar date as that day where the device is', () => {
    for (const zone of ZONES) {
      inTimeZone(zone, () => {
        const date = toDate('2026-10-13');
        expect([date.getFullYear(), date.getMonth(), date.getDate(), date.getHours()]).toEqual([2026, 9, 13, 0]);
      });
    }
  });

  it('does not read it as midnight UTC, which is the day before in the west', () => {
    inTimeZone('America/Los_Angeles', () => {
      expect(new Date('2026-10-13').getDate()).toBe(12);
      expect(toDate('2026-10-13').getDate()).toBe(13);
    });
  });

  it('reads a timestamp, milliseconds and a Date as the instant they say', () => {
    const instant = Date.UTC(2026, 9, 13, 12, 0, 0);
    expect(toDate('2026-10-13T12:00:00Z').getTime()).toBe(instant);
    expect(toDate('2026-10-13T14:00:00+02:00').getTime()).toBe(instant);
    expect(toDate(instant).getTime()).toBe(instant);
    const date = new Date(instant);
    expect(toDate(date)).toBe(date);
  });

  it('gives null for no date and for what is not one', () => {
    for (const value of [null, undefined, '', 'not a date', '2026-13-45T00:00:00Z', new Date(NaN), NaN]) {
      expect(toDate(value)).toBeNull();
    }
  });
});

describe('dates and times', () => {
  // Built from local parts: the same wall clock in every zone.
  const date = new Date(2026, 9, 13, 14, 5);

  it('writes a date in the language of the app', () => {
    expect(formatDate('en', date)).toBe('Oct 13, 2026');
    expect(formatDate('fr', date)).toBe('13 oct. 2026');
    expect(formatDate('de', date)).toBe('13. Okt. 2026');
  });

  it('takes the options of Intl.DateTimeFormat', () => {
    const weekday = { weekday: 'short', day: 'numeric', month: 'short' };
    expect(formatDate('en', date, weekday)).toBe('Tue, Oct 13');
    expect(formatDate('fr', date, weekday)).toBe('mar. 13 oct.');
    expect(formatDate('de', date, weekday)).toBe('Di., 13. Okt.');
    expect(formatDate('fr', date, { month: 'long', year: 'numeric' })).toBe('octobre 2026');
    expect(formatDate('de', date, { day: 'numeric', month: 'numeric' })).toBe('13.10.');
  });

  it('writes a time of day', () => {
    expect(plain(formatTime('en', date))).toBe('02:05 PM');
    expect(formatTime('fr', date)).toBe('14:05');
    expect(formatTime('de', date)).toBe('14:05');
  });

  it('writes a date with its time, the date as formatDate writes it', () => {
    expect(plain(formatDateTime('en', date))).toBe('Oct 13, 2026, 02:05 PM');
    expect(plain(formatDateTime('fr', date))).toBe('13 oct. 2026, 14:05');
    expect(plain(formatDateTime('de', date))).toBe('13. Okt. 2026, 14:05');
    for (const lang of LANGUAGES) {
      expect(formatDateTime(lang, date).startsWith(formatDate(lang, date))).toBe(true);
    }
  });

  it('prints a bare date as its own day in every zone', () => {
    for (const zone of ZONES) {
      inTimeZone(zone, () => {
        expect(formatDate('en', '2026-10-13')).toBe('Oct 13, 2026');
        expect(formatDate('fr', '2026-01-01')).toBe('1 janv. 2026');
      });
    }
  });

  it('prints a timestamp at the time it is where the device is', () => {
    const stamp = '2026-10-13T23:30:00Z';
    inTimeZone('America/Los_Angeles', () => expect(plain(formatDateTime('fr', stamp))).toBe('13 oct. 2026, 16:30'));
    inTimeZone('Europe/Paris', () => expect(plain(formatDateTime('fr', stamp))).toBe('14 oct. 2026, 01:30'));
    inTimeZone('Pacific/Kiritimati', () => expect(plain(formatDateTime('fr', stamp))).toBe('14 oct. 2026, 13:30'));
  });

  it('follows the zone of the device when it changes, without a reload', () => {
    const stamp = '2026-10-13T23:30:00Z';
    const first = inTimeZone('Europe/Paris', () => formatTime('fr', stamp));
    const second = inTimeZone('America/Los_Angeles', () => formatTime('fr', stamp));
    expect([first, second]).toEqual(['01:30', '16:30']);
  });

  it('writes a span of days the way the language does', () => {
    expect(plain(formatDateRange('en', '2026-07-06', '2026-07-12'))).toBe('Jul 6 – 12');
    expect(plain(formatDateRange('fr', '2026-07-06', '2026-07-12'))).toBe('6–12 juil.');
    expect(plain(formatDateRange('de', '2026-07-06', '2026-07-12'))).toBe('6.–12. Juli');
    // Across two months both are named.
    expect(plain(formatDateRange('fr', '2026-06-29', '2026-07-05'))).toBe('29 juin – 5 juil.');
  });

  it('is an empty label for no date, where Intl would throw', () => {
    expect(() => new Intl.DateTimeFormat('en-US').format(new Date(NaN))).toThrow(RangeError);
    for (const value of [null, undefined, '', 'not a date', new Date(NaN)]) {
      expect(formatDate('en', value)).toBe('');
      expect(formatTime('en', value)).toBe('');
      expect(formatDateTime('en', value)).toBe('');
      expect(formatDateRange('en', value, '2026-07-12')).toBe('');
      expect(formatDateRange('en', '2026-07-06', value)).toBe('');
    }
  });

  it('writes a distance in days in words', () => {
    expect(formatRelativeDays('en', -1)).toBe('yesterday');
    expect(formatRelativeDays('fr', -1)).toBe('hier');
    expect(formatRelativeDays('de', -1)).toBe('gestern');
    expect(formatRelativeDays('en', -3)).toBe('3 days ago');
    expect(formatRelativeDays('fr', -3)).toBe('il y a 3 jours');
    expect(formatRelativeDays('de', -3)).toBe('vor 3 Tagen');
    expect(formatRelativeDays('en', 0)).toBe('today');
    expect(formatRelativeDays('en', NaN)).toBe('');
    expect(formatRelativeDays('en', undefined)).toBe('');
  });
});

describe('numbers', () => {
  it('writes a number with the separators of the language', () => {
    expect(formatNumber('en', 1234.5)).toBe('1,234.5');
    expect(plain(formatNumber('fr', 1234.5))).toBe('1 234,5');
    expect(formatNumber('de', 1234.5)).toBe('1.234,5');
    expect(formatNumber('fr', 82.5)).toBe('82,5');
  });

  it('takes the options of Intl.NumberFormat, and a number that came as text', () => {
    expect(formatNumber('fr', 82.456, { maximumFractionDigits: 1 })).toBe('82,5');
    expect(formatNumber('en', '82.50')).toBe('82.5');
    expect(formatNumber('en', 0)).toBe('0');
  });

  it('is empty for no number', () => {
    for (const value of [null, undefined, '', 'abc', NaN, Infinity]) expect(formatNumber('en', value)).toBe('');
  });
});

describe('day names', () => {
  it('starts on Monday: index day_number - 1', () => {
    expect(dayNames('en', 'long')).toEqual(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
    expect(dayNames('fr', 'long')).toEqual(['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche']);
    expect(dayNames('de', 'long')).toEqual(['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag']);
  });

  it('gives the English day names for English', () => {
    expect(dayNames('en', 'narrow')).toEqual(['M', 'T', 'W', 'T', 'F', 'S', 'S']);
    expect(dayNames('en', 'short')).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  });

  it('gives one letter per day in the narrow form', () => {
    expect(dayNames('fr', 'narrow')).toEqual(['L', 'M', 'M', 'J', 'V', 'S', 'D']);
    expect(dayNames('de', 'narrow')).toEqual(['M', 'D', 'M', 'D', 'F', 'S', 'S']);
  });

  it('writes the short form without the full stop of a French abbreviation', () => {
    // Intl says "lun."; a pill says LUN.
    expect(new Intl.DateTimeFormat('fr-FR', { weekday: 'short', timeZone: 'UTC' }).format(Date.UTC(2024, 0, 1))).toBe('lun.');
    expect(dayNames('fr', 'short')).toEqual(['lun', 'mar', 'mer', 'jeu', 'ven', 'sam', 'dim']);
    expect(dayNames('de', 'short')).toEqual(['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']);
    for (const lang of LANGUAGES) {
      for (const name of dayNames(lang, 'short')) expect(name).toMatch(/^\p{L}+$/u);
    }
  });

  it('has seven names in every language and width, short unless told otherwise', () => {
    for (const lang of LANGUAGES) {
      for (const width of ['narrow', 'short', 'long']) expect(dayNames(lang, width)).toHaveLength(7);
      expect(dayNames(lang)).toEqual(dayNames(lang, 'short'));
      expect(dayNames(lang, 'no such width')).toEqual(dayNames(lang, 'short'));
    }
    expect(dayNames('es', 'long')).toEqual(dayNames('en', 'long'));
  });

  it('does not depend on where the device is', () => {
    const here = dayNames('fr', 'long');
    for (const zone of ZONES) {
      inTimeZone(zone, () => {
        // Built again in that zone, not read from the table of this one.
        const built = Array.from({ length: 7 }, (_, i) =>
          new Intl.DateTimeFormat('fr-FR', { weekday: 'long', timeZone: 'UTC' }).format(Date.UTC(2024, 0, 1 + i)),
        );
        expect(built).toEqual(here);
        expect(dayNames('de', 'long')[0]).toBe('Montag');
      });
    }
  });

  it('hands out one table that a caller cannot change', () => {
    const names = dayNames('fr', 'long');
    expect(dayNames('fr', 'long')).toBe(names);
    expect(Object.isFrozen(names)).toBe(true);
  });

  it('names one day_number, and nothing for a value that is not one', () => {
    expect(dayName('fr', 1, 'long')).toBe('lundi');
    expect(dayName('fr', 7, 'long')).toBe('dimanche');
    expect(dayName('de', 3)).toBe('Mi');
    expect(dayName('en', 5, 'narrow')).toBe('F');
    for (const value of [0, 8, -1, 1.5, null, undefined, '1', NaN]) expect(dayName('en', value)).toBe('');
  });
});

describe('plurals', () => {
  it('follows the rule of the language, not n === 1', () => {
    // French counts zero and one and a half as one: "0 séance", "1,5 heure".
    expect([0, 1, 1.5, 2, 5].map((n) => pluralCategory('fr', n))).toEqual(['one', 'one', 'one', 'other', 'other']);
    expect([0, 1, 1.5, 2, 5].map((n) => pluralCategory('en', n))).toEqual(['other', 'one', 'other', 'other', 'other']);
    expect([0, 1, 1.5, 2, 5].map((n) => pluralCategory('de', n))).toEqual(['other', 'one', 'other', 'other', 'other']);
  });

  it('is "other" for what is not a number', () => {
    for (const n of [NaN, undefined, null, Infinity, '2']) expect(pluralCategory('fr', n)).toBe('other');
  });

  it('picks the …One or …Many key of a pair', () => {
    expect(pluralKey('en', 1, 'student.training.sessions')).toBe('student.training.sessionsOne');
    expect(pluralKey('en', 0, 'student.training.sessions')).toBe('student.training.sessionsMany');
    expect(pluralKey('fr', 0, 'student.training.sessions')).toBe('student.training.sessionsOne');
    expect(pluralKey('de', 0, 'student.training.sessions')).toBe('student.training.sessionsMany');
    expect(pluralKey('fr', 2, 'student.training.sessions')).toBe('student.training.sessionsMany');
  });

  it('takes the plural form for the French millions, which are "many"', () => {
    expect(pluralCategory('fr', 1_000_000)).toBe('many');
    expect(pluralKey('fr', 1_000_000, 'coach.home.weeks')).toBe('coach.home.weeksMany');
    expect(pluralKey('fr', 1_000_000, { one: 'a.one', other: 'a.many' })).toBe('a.many');
  });

  it('takes a pair that is not named …One / …Many', () => {
    const pair = { one: 'offline.bannerOfflineWithPending', other: 'offline.bannerOfflineWithPendingMany' };
    expect(pluralKey('en', 1, pair)).toBe(pair.one);
    expect(pluralKey('en', 3, pair)).toBe(pair.other);
    expect(pluralKey('fr', 0, pair)).toBe(pair.one);
    // A pair with one form is that form.
    expect(pluralKey('en', 3, { one: 'a.only' })).toBe('a.only');
    expect(pluralKey('en', 1, { other: 'a.only' })).toBe('a.only');
  });

  it('gives sentences that are right in the three languages, on the real dictionaries', () => {
    const sessions = (lang, n) => getMessage(lang, pluralKey(lang, n, 'student.training.sessions'), { n });
    expect([0, 1, 2].map((n) => sessions('en', n))).toEqual(['0 sessions', '1 session', '2 sessions']);
    expect([0, 1, 2].map((n) => sessions('fr', n))).toEqual(['0 séance', '1 séance', '2 séances']);
    expect([0, 1, 2].map((n) => sessions('de', n))).toEqual(['0 Einheiten', '1 Einheit', '2 Einheiten']);
    const weeks = (lang, n) => getMessage(lang, pluralKey(lang, n, 'coach.home.weeks'), { n });
    expect([weeks('fr', 0), weeks('en', 0), weeks('de', 1)]).toEqual(['0 semaine', '0 weeks', '1 Woche']);
  });
});
