import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { todayDayNumber, DAY_LABELS, DAY_FULL } from './day';

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
});
