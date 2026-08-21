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
  nextFreeDayNumber,
  compareSessions,
  performedOnFromLogs,
  performedDate,
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

  describe('nextFreeDayNumber', () => {
    it('returns 1 for an empty week', () => {
      expect(nextFreeDayNumber([])).toBe(1);
      expect(nextFreeDayNumber(null)).toBe(1);
    });

    it('returns the first gap, not a running count', () => {
      expect(nextFreeDayNumber([{ day_number: 1 }, { day_number: 3 }])).toBe(2);
      expect(nextFreeDayNumber([{ day_number: 1 }, { day_number: 2 }])).toBe(3);
    });

    it('never exceeds 7 — the roster week strip drops anything outside 1..7', () => {
      const fullWeek = [1, 2, 3, 4, 5, 6, 7].map((d) => ({ day_number: d }));
      expect(nextFreeDayNumber(fullWeek)).toBe(7);
      // The old `sessions.length + 1` would have returned 8 here and the
      // session would have silently vanished from the coach roster.
      expect(nextFreeDayNumber(fullWeek)).toBeLessThanOrEqual(7);
    });
  });

  describe('compareSessions', () => {
    const sorted = (arr) => arr.slice().sort(compareSessions).map((s) => s.title);

    it('orders by training day, not by creation order', () => {
      // The reported bug: Upper 2 (Fri) was written before Leg (Wed), so it
      // listed second and the week read Mon / Fri / Wed.
      const week = [
        { title: 'Upper 1', day_number: 1, sort_order: 0 },
        { title: 'Upper 2', day_number: 5, sort_order: 1 },
        { title: 'Leg', day_number: 3, sort_order: 2 },
      ];
      expect(sorted(week)).toEqual(['Upper 1', 'Leg', 'Upper 2']);
    });

    it('breaks a same-day tie on sort_order', () => {
      const week = [
        { title: 'PM', day_number: 3, sort_order: 1 },
        { title: 'AM', day_number: 3, sort_order: 0 },
      ];
      expect(sorted(week)).toEqual(['AM', 'PM']);
    });

    it('sorts a session with no usable weekday last, not onto Monday', () => {
      const week = [
        { title: 'unset', day_number: null, sort_order: 0 },
        { title: 'out of range', day_number: 9, sort_order: 1 },
        { title: 'Tue', day_number: 2, sort_order: 2 },
      ];
      expect(sorted(week)).toEqual(['Tue', 'unset', 'out of range']);
    });

    it('prefers scheduled_date over day_number where the surface fetches it', () => {
      // 2026-08-05 is a Wednesday, so it must beat a day_number of 5 (Fri)
      // even though the stale day_number says otherwise.
      const week = [
        { title: 'Fri', day_number: 5, sort_order: 0 },
        { title: 'rescheduled to Wed', day_number: 5, scheduled_date: '2026-08-05', sort_order: 1 },
      ];
      expect(sorted(week)).toEqual(['rescheduled to Wed', 'Fri']);
    });
  });

  // The training date must come from the set logs (minted when the student
  // ticked the set), never from when the confirmation happened to reach the
  // server — that is the whole reason performed_on exists.
  describe('performedOnFromLogs', () => {
    it('takes the EARLIEST logged set: a session that runs past midnight belongs to the day it began', () => {
      const logs = [
        { logged_at: '2026-08-19T23:40:00Z' },
        { logged_at: '2026-08-19T22:10:00Z' },
        { logged_at: '2026-08-20T00:20:00Z' },
      ];
      // Local-time date of the earliest stamp.
      expect(performedOnFromLogs(logs)).toBe(isoDate(new Date('2026-08-19T22:10:00Z')));
    });

    it('ignores unticked and malformed logs', () => {
      const logs = [
        { logged_at: null },
        { logged_at: 'not-a-date' },
        { logged_at: '2026-08-18T09:00:00Z' },
      ];
      expect(performedOnFromLogs(logs)).toBe(isoDate(new Date('2026-08-18T09:00:00Z')));
    });

    it('falls back to now when nothing was ticked — a student can confirm without logging a set', () => {
      vi.setSystemTime(new Date('2026-08-21T10:00:00Z'));
      expect(performedOnFromLogs([])).toBe(isoDate(new Date()));
      expect(performedOnFromLogs(null)).toBe(isoDate(new Date()));
    });

    it('resolves in LOCAL time, so it never lands a day off like toISOString would', () => {
      // 23:30 local on the 19th — the UTC date may already be the 20th.
      const localLate = new Date(2026, 7, 19, 23, 30);
      expect(performedOnFromLogs([{ logged_at: localLate.toISOString() }])).toBe('2026-08-19');
    });
  });

  describe('performedDate', () => {
    it('prefers a confirmation performed_on over its confirmed_at', () => {
      const d = performedDate({
        performed_on: '2026-08-18',
        confirmed_at: '2026-08-21T09:00:00Z',
      });
      expect(isoDate(d)).toBe('2026-08-18');
    });

    it('falls back to confirmed_at for rows written before performed_on existed', () => {
      const d = performedDate({ confirmed_at: '2026-08-21T09:00:00Z' });
      expect(d.getTime()).toBe(new Date('2026-08-21T09:00:00Z').getTime());
    });

    it('reads performed_at off a session row', () => {
      const d = performedDate({ performed_at: '2026-08-20T18:00:00Z' });
      expect(d.getTime()).toBe(new Date('2026-08-20T18:00:00Z').getTime());
    });

    it('returns null when the session was never performed', () => {
      expect(performedDate(null)).toBeNull();
      expect(performedDate({})).toBeNull();
      expect(performedDate({ performed_at: null, confirmed_at: null })).toBeNull();
    });
  });
});
