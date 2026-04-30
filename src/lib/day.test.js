import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { todayDayNumber, DAY_LABELS, DAY_FULL, sessionDayNumber } from './day';

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
  });
});
