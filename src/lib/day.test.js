import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  todayDayNumber,
  DAY_LABELS,
  DAY_FULL,
  sessionDayNumber,
  parseISODate,
  isoDate,
  addDays,
  startOfWeekMonday,
} from './day';

describe('day.js', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('exports the M..S labels and Mon..Sun full labels', () => {
    expect(DAY_LABELS).toEqual(['M', 'T', 'W', 'T', 'F', 'S', 'S']);
    expect(DAY_FULL).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  });

  it.each([
    // [JS Date, expected day_number]
    ['2026-04-26T12:00:00Z', 7], // Sunday
    ['2026-04-27T12:00:00Z', 1], // Monday
    ['2026-04-28T12:00:00Z', 2], // Tuesday
    ['2026-04-29T12:00:00Z', 3], // Wednesday
    ['2026-04-30T12:00:00Z', 4], // Thursday
    ['2026-05-01T12:00:00Z', 5], // Friday
    ['2026-05-02T12:00:00Z', 6], // Saturday
  ])('todayDayNumber maps %s → %i', (iso, expected) => {
    vi.setSystemTime(new Date(iso));
    expect(todayDayNumber()).toBe(expected);
  });

  describe('sessionDayNumber', () => {
    it('returns day_number when scheduled_date is missing', () => {
      expect(sessionDayNumber({ day_number: 4 })).toBe(4);
    });

    it('derives the weekday from scheduled_date when present (overrides day_number)', () => {
      // 2026-04-27 is a Monday (1) in local time.
      expect(sessionDayNumber({ scheduled_date: '2026-04-27', day_number: 99 })).toBe(1);
    });

    it('maps Sunday calendar dates to day_number 7', () => {
      expect(sessionDayNumber({ scheduled_date: '2026-04-26' })).toBe(7);
    });

    it('returns undefined for null or empty input', () => {
      expect(sessionDayNumber(null)).toBeUndefined();
      expect(sessionDayNumber({})).toBeUndefined();
    });

    it('falls back to day_number when scheduled_date is malformed', () => {
      expect(sessionDayNumber({ scheduled_date: 'not-a-date', day_number: 3 })).toBe(3);
    });
  });

  describe('calendar helpers', () => {
    it('parseISODate parses YYYY-MM-DD as a local date', () => {
      const d = parseISODate('2026-04-27');
      expect(d.getFullYear()).toBe(2026);
      expect(d.getMonth()).toBe(3);
      expect(d.getDate()).toBe(27);
    });

    it('parseISODate rejects malformed input', () => {
      expect(parseISODate('nope')).toBeNull();
      expect(parseISODate('')).toBeNull();
      expect(parseISODate(null)).toBeNull();
    });

    it('isoDate round-trips with parseISODate', () => {
      expect(isoDate(parseISODate('2026-04-05'))).toBe('2026-04-05');
    });

    it('addDays crosses month boundaries', () => {
      expect(isoDate(addDays(parseISODate('2026-04-30'), 2))).toBe('2026-05-02');
      expect(isoDate(addDays(parseISODate('2026-05-02'), -2))).toBe('2026-04-30');
    });

    it.each([
      ['2026-04-27', '2026-04-27'], // Monday → itself
      ['2026-04-30', '2026-04-27'], // Thursday → that Monday
      ['2026-05-03', '2026-04-27'], // Sunday → the preceding Monday
    ])('startOfWeekMonday(%s) → %s', (input, expected) => {
      expect(isoDate(startOfWeekMonday(parseISODate(input)))).toBe(expected);
    });
  });
});
