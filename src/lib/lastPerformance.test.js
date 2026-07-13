import { describe, it, expect } from 'vitest';
import { buildLastPerformance, formatLastPerformance, daysSince } from './lastPerformance';

// Build a flattened set_log row the way useLastPerformance feeds buildLastPerformance.
function row(over = {}) {
  return {
    exerciseId: 'ex-1',
    sessionId: 's-1',
    scheduledDate: '2026-07-01',
    loggedAt: '2026-07-01T10:00:00.000Z',
    setNumber: 1,
    target_reps: 8,
    target_weight_kg: 100,
    actual_reps: null,
    actual_weight_kg: null,
    ...over,
  };
}

describe('buildLastPerformance', () => {
  it('returns the sets of the most recent prior session per exercise', () => {
    const out = buildLastPerformance(
      [
        // older session
        row({ sessionId: 's-old', scheduledDate: '2026-06-01', setNumber: 1, target_weight_kg: 90 }),
        // most recent prior session (two sets)
        row({ sessionId: 's-1', scheduledDate: '2026-07-01', setNumber: 1, target_weight_kg: 100 }),
        row({ sessionId: 's-1', scheduledDate: '2026-07-01', setNumber: 2, target_weight_kg: 100 }),
      ],
      { currentSessionId: 's-current', currentScheduledDate: '2026-07-08' }
    );
    expect(out['ex-1'].sets).toEqual([
      { weight: 100, reps: 8 },
      { weight: 100, reps: 8 },
    ]);
    expect(out['ex-1'].scheduledDate).toBe('2026-07-01');
  });

  it('excludes the current session', () => {
    const out = buildLastPerformance(
      [row({ sessionId: 's-current', scheduledDate: '2026-07-08' })],
      { currentSessionId: 's-current', currentScheduledDate: '2026-07-08' }
    );
    expect(out['ex-1']).toBeUndefined();
  });

  it('excludes sessions dated on/after the current session', () => {
    const out = buildLastPerformance(
      [
        row({ sessionId: 's-future', scheduledDate: '2026-07-20', target_weight_kg: 120 }),
        row({ sessionId: 's-prior', scheduledDate: '2026-07-01', target_weight_kg: 100 }),
      ],
      { currentSessionId: 's-current', currentScheduledDate: '2026-07-08' }
    );
    expect(out['ex-1'].sets).toEqual([{ weight: 100, reps: 8 }]);
  });

  it('prefers actual reps/weight over the prescribed target', () => {
    const out = buildLastPerformance(
      [row({ actual_reps: 6, actual_weight_kg: 110 })],
      { currentSessionId: 's-current' }
    );
    expect(out['ex-1'].sets).toEqual([{ weight: 110, reps: 6 }]);
  });

  it('keeps sets in set order regardless of input order', () => {
    const out = buildLastPerformance(
      [
        row({ setNumber: 3, target_weight_kg: 95 }),
        row({ setNumber: 1, target_weight_kg: 100 }),
        row({ setNumber: 2, target_weight_kg: 100 }),
      ],
      { currentSessionId: 's-current' }
    );
    expect(out['ex-1'].sets).toEqual([
      { weight: 100, reps: 8 },
      { weight: 100, reps: 8 },
      { weight: 95, reps: 8 },
    ]);
  });

  it('handles bodyweight sets (no external load)', () => {
    const out = buildLastPerformance(
      [row({ target_weight_kg: null, target_reps: 10 })],
      { currentSessionId: 's-current' }
    );
    expect(out['ex-1'].sets).toEqual([{ weight: 0, reps: 10 }]);
  });

  it('skips sets with no rep count (duration-only work)', () => {
    const out = buildLastPerformance(
      [row({ target_reps: null, actual_reps: null })],
      { currentSessionId: 's-current' }
    );
    expect(out['ex-1']).toBeUndefined();
  });

  it('groups per exercise independently', () => {
    const out = buildLastPerformance(
      [
        row({ exerciseId: 'ex-1', sessionId: 's-1', target_weight_kg: 100 }),
        row({ exerciseId: 'ex-2', sessionId: 's-1', target_weight_kg: 60 }),
      ],
      { currentSessionId: 's-current' }
    );
    expect(out['ex-1'].sets[0].weight).toBe(100);
    expect(out['ex-2'].sets[0].weight).toBe(60);
  });

  it('falls back to loggedAt ordering when scheduledDate is missing', () => {
    const out = buildLastPerformance(
      [
        row({ sessionId: 's-a', scheduledDate: null, loggedAt: '2026-07-01T10:00:00Z', target_weight_kg: 90 }),
        row({ sessionId: 's-b', scheduledDate: null, loggedAt: '2026-07-05T10:00:00Z', target_weight_kg: 105 }),
      ],
      { currentSessionId: 's-current' }
    );
    expect(out['ex-1'].sets).toEqual([{ weight: 105, reps: 8 }]);
  });

  it('excludes a future-dated session when a today boundary is supplied (undated open session)', () => {
    // Mirrors what useLastPerformance passes when the open session has no
    // scheduled_date: currentScheduledDate defaults to today.
    const out = buildLastPerformance(
      [
        row({ sessionId: 's-ahead', scheduledDate: '2026-08-01', target_weight_kg: 130 }),
        row({ sessionId: 's-prior', scheduledDate: '2026-07-01', target_weight_kg: 100 }),
      ],
      { currentSessionId: 's-current', currentScheduledDate: '2026-07-10' }
    );
    expect(out['ex-1'].sets).toEqual([{ weight: 100, reps: 8 }]);
  });

  it('returns an empty object for no rows', () => {
    expect(buildLastPerformance([], {})).toEqual({});
    expect(buildLastPerformance(null, {})).toEqual({});
  });
});

describe('formatLastPerformance', () => {
  it('collapses a uniform set of sets', () => {
    expect(
      formatLastPerformance({ sets: [
        { weight: 100, reps: 8 },
        { weight: 100, reps: 8 },
        { weight: 100, reps: 8 },
      ] })
    ).toBe('3 × 8 @ 100kg');
  });

  it('lists distinct groups separated by a middot', () => {
    expect(
      formatLastPerformance({ sets: [
        { weight: 100, reps: 8 },
        { weight: 100, reps: 8 },
        { weight: 100, reps: 6 },
      ] })
    ).toBe('2 × 8 @ 100kg · 6 @ 100kg');
  });

  it('renders reps only for bodyweight sets', () => {
    expect(
      formatLastPerformance({ sets: [
        { weight: 0, reps: 10 },
        { weight: 0, reps: 8 },
      ] })
    ).toBe('10 · 8');
  });

  it('caps the number of groups with a +N overflow', () => {
    expect(
      formatLastPerformance(
        { sets: [
          { weight: 100, reps: 5 },
          { weight: 95, reps: 5 },
          { weight: 90, reps: 5 },
          { weight: 85, reps: 5 },
          { weight: 80, reps: 5 },
        ] },
        { maxGroups: 3 }
      )
    ).toBe('5 @ 100kg · 5 @ 95kg · 5 @ 90kg · +2');
  });

  it('returns empty string for no sets', () => {
    expect(formatLastPerformance(null)).toBe('');
    expect(formatLastPerformance({ sets: [] })).toBe('');
  });
});

describe('daysSince', () => {
  // Build LOCAL dates (midday, so no offset/DST edge can shift the calendar
  // day) — daysSince anchors to local midnight, so the assertions are
  // timezone-independent.
  const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h);
  const now = at(2026, 7, 10);

  it('counts whole calendar days elapsed', () => {
    expect(daysSince(at(2026, 7, 5).toISOString(), now)).toBe(5);
    expect(daysSince(at(2026, 7, 10, 0).toISOString(), now)).toBe(0);
  });

  it('counts the previous calendar day as 1 even when under 24h elapsed', () => {
    // Evening session (19:00) viewed next morning (10:00): 15h apart but a
    // calendar day back — must read "yesterday" (1), not "today" (0).
    expect(daysSince(at(2026, 7, 9, 19).toISOString(), at(2026, 7, 10, 10))).toBe(1);
  });

  it('never returns negative for future dates', () => {
    expect(daysSince(at(2026, 7, 20).toISOString(), now)).toBe(0);
  });

  it('returns null for a missing or invalid timestamp', () => {
    expect(daysSince(null, now)).toBeNull();
    expect(daysSince('not-a-date', now)).toBeNull();
  });
});
