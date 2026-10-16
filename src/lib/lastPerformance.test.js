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
        row({ sessionId: 's-old', scheduledDate: '2026-06-01', loggedAt: '2026-06-01T10:00:00.000Z', setNumber: 1, target_weight_kg: 90 }),
        // most recent prior session (two sets)
        row({ sessionId: 's-1', scheduledDate: '2026-07-01', setNumber: 1, target_weight_kg: 100 }),
        row({ sessionId: 's-1', scheduledDate: '2026-07-01', setNumber: 2, target_weight_kg: 100 }),
      ],
      { currentSessionId: 's-current' }
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
      { currentSessionId: 's-current' }
    );
    expect(out['ex-1']).toBeUndefined();
  });

  it('excludes a session that started after the open session’s first set', () => {
    // The open session is an old one, opened again: what came after it is
    // not its "last time".
    const out = buildLastPerformance(
      [
        row({ sessionId: 's-prior', scheduledDate: '2026-07-01', loggedAt: '2026-07-01T10:00:00Z', target_weight_kg: 100 }),
        row({ sessionId: 's-current', scheduledDate: '2026-07-08', loggedAt: '2026-07-08T10:00:00Z', target_weight_kg: 110 }),
        row({ sessionId: 's-later', scheduledDate: '2026-07-15', loggedAt: '2026-07-15T10:00:00Z', target_weight_kg: 120 }),
      ],
      { currentSessionId: 's-current' }
    );
    expect(out['ex-1'].sets).toEqual([{ weight: 100, reps: 8 }]);
    expect(out['ex-1'].performedAt).toBe('2026-07-01T10:00:00Z');
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


  it('returns an empty object for no rows', () => {
    expect(buildLastPerformance([], {})).toEqual({});
    expect(buildLastPerformance(null, {})).toEqual({});
  });
});

// The order is the order of training. The recommended date is advice: a copy
// of a block carries none, a session can be trained before its date, and the
// coach moves dates around.
describe('buildLastPerformance — the order of training', () => {
  it('a newer undated session is last time, before an older dated one', () => {
    const out = buildLastPerformance(
      [
        row({ sessionId: 's-dated', scheduledDate: '2026-05-01', loggedAt: '2026-05-01T10:00:00Z', target_weight_kg: 90 }),
        row({ sessionId: 's-copy', scheduledDate: null, loggedAt: '2026-07-01T10:00:00Z', target_weight_kg: 105 }),
      ],
      { currentSessionId: 's-current' }
    );
    expect(out['ex-1'].sets).toEqual([{ weight: 105, reps: 8 }]);
    expect(out['ex-1'].scheduledDate).toBeNull();
  });

  it('a newer dated session is last time, before an older undated one', () => {
    const out = buildLastPerformance(
      [
        row({ sessionId: 's-dated', scheduledDate: '2026-07-01', loggedAt: '2026-07-01T10:00:00Z', target_weight_kg: 105 }),
        row({ sessionId: 's-undated', scheduledDate: null, loggedAt: '2026-05-01T10:00:00Z', target_weight_kg: 90 }),
      ],
      { currentSessionId: 's-current' }
    );
    expect(out['ex-1'].sets).toEqual([{ weight: 105, reps: 8 }]);
  });

  it('a session trained ahead of its recommended date is last time', () => {
    // Recommended for August, trained on 5 July; the open session is
    // recommended for 10 July and not started.
    const out = buildLastPerformance(
      [
        row({ sessionId: 's-prior', scheduledDate: '2026-07-01', loggedAt: '2026-07-01T10:00:00Z', target_weight_kg: 100 }),
        row({ sessionId: 's-ahead', scheduledDate: '2026-08-01', loggedAt: '2026-07-05T10:00:00Z', target_weight_kg: 130 }),
      ],
      { currentSessionId: 's-current' }
    );
    expect(out['ex-1'].sets).toEqual([{ weight: 130, reps: 8 }]);
    expect(out['ex-1'].performedAt).toBe('2026-07-05T10:00:00Z');
  });

  it('a session dated after the open one but trained before it started is kept', () => {
    const out = buildLastPerformance(
      [
        row({ sessionId: 's-ahead', scheduledDate: '2026-08-01', loggedAt: '2026-07-05T10:00:00Z', target_weight_kg: 130 }),
        // The open session, recommended for 10 July, started on 9 July.
        row({ sessionId: 's-current', scheduledDate: '2026-07-10', loggedAt: '2026-07-09T18:00:00Z', target_weight_kg: 135 }),
      ],
      { currentSessionId: 's-current' }
    );
    expect(out['ex-1'].sets).toEqual([{ weight: 130, reps: 8 }]);
  });

  it('the open session’s start is its first set of any exercise', () => {
    const out = buildLastPerformance(
      [
        // Started at 10:00 with another lift…
        row({ exerciseId: 'ex-2', sessionId: 's-current', loggedAt: '2026-07-08T10:00:00Z' }),
        // …a session started at 10:30, an hour before the open session reached ex-1.
        row({ sessionId: 's-after', loggedAt: '2026-07-08T10:30:00Z', target_weight_kg: 120 }),
        row({ sessionId: 's-current', loggedAt: '2026-07-08T11:30:00Z', target_weight_kg: 110 }),
        row({ sessionId: 's-before', loggedAt: '2026-07-01T10:00:00Z', target_weight_kg: 100 }),
      ],
      { currentSessionId: 's-current', exerciseIds: ['ex-1'] }
    );
    expect(out['ex-1'].sets).toEqual([{ weight: 100, reps: 8 }]);
    // The open session's own sets never become an entry.
    expect(out['ex-2']).toBeUndefined();
  });

  it('a prior session’s start is its first set of any exercise, outside `exerciseIds` too', () => {
    const out = buildLastPerformance(
      [
        row({ sessionId: 's-current', loggedAt: '2026-07-08T10:00:00Z', target_weight_kg: 110 }),
        // Started at 09:00 with ex-2, reached ex-1 at 10:30: started before the
        // open session, so it is kept.
        row({ exerciseId: 'ex-2', sessionId: 's-early', loggedAt: '2026-07-08T09:00:00Z' }),
        row({ sessionId: 's-early', loggedAt: '2026-07-08T10:30:00Z', target_weight_kg: 105 }),
        row({ sessionId: 's-before', loggedAt: '2026-07-01T10:00:00Z', target_weight_kg: 100 }),
      ],
      { currentSessionId: 's-current', exerciseIds: ['ex-1'] }
    );
    expect(out['ex-1'].sets).toEqual([{ weight: 105, reps: 8 }]);
    expect(Object.keys(out)).toEqual(['ex-1']);
  });

  it('an open session with no logged set cuts nothing', () => {
    const out = buildLastPerformance(
      [
        row({ sessionId: 's-a', loggedAt: '2026-07-01T10:00:00Z', target_weight_kg: 100 }),
        row({ sessionId: 's-b', loggedAt: '2026-07-20T10:00:00Z', target_weight_kg: 120 }),
      ],
      { currentSessionId: 's-current' }
    );
    expect(out['ex-1'].sets).toEqual([{ weight: 120, reps: 8 }]);
  });

  it('compares instants, not strings: stamps of mixed forms', () => {
    // As text, '2026-07-01T11:00:00+02:00' sorts after the two others; as an
    // instant it is 09:00Z, the earliest of the three. The latest is 10:30Z.
    const out = buildLastPerformance(
      [
        row({ sessionId: 's-a', loggedAt: '2026-07-01T11:00:00+02:00', target_weight_kg: 90 }),
        row({ sessionId: 's-b', loggedAt: '2026-07-01T10:00:00+00:00', target_weight_kg: 100 }),
        row({ sessionId: 's-c', loggedAt: '2026-07-01T10:30:00.000Z', target_weight_kg: 110 }),
      ],
      { currentSessionId: 's-current' }
    );
    expect(out['ex-1'].sets).toEqual([{ weight: 110, reps: 8 }]);
    expect(out['ex-1'].performedAt).toBe('2026-07-01T10:30:00.000Z');
  });

  it('ranks by the latest set of the exercise in each session', () => {
    const out = buildLastPerformance(
      [
        row({ sessionId: 's-a', setNumber: 1, loggedAt: '2026-07-01T10:00:00Z', target_weight_kg: 100 }),
        row({ sessionId: 's-a', setNumber: 2, loggedAt: '2026-07-03T10:00:00Z', target_weight_kg: 100 }),
        row({ sessionId: 's-b', setNumber: 1, loggedAt: '2026-07-02T10:00:00Z', target_weight_kg: 120 }),
      ],
      { currentSessionId: 's-current' }
    );
    expect(out['ex-1'].sets).toEqual([{ weight: 100, reps: 8 }, { weight: 100, reps: 8 }]);
    expect(out['ex-1'].performedAt).toBe('2026-07-03T10:00:00Z');
  });

  it('a session with no stamp ranks after every session that has one', () => {
    const out = buildLastPerformance(
      [
        row({ sessionId: 's-legacy', scheduledDate: '2026-09-01', loggedAt: null, target_weight_kg: 140 }),
        row({ sessionId: 's-stamped', scheduledDate: '2026-01-01', loggedAt: '2026-01-01T10:00:00Z', target_weight_kg: 100 }),
      ],
      { currentSessionId: 's-current' }
    );
    expect(out['ex-1'].sets).toEqual([{ weight: 100, reps: 8 }]);
  });

  it('sessions with no stamp, or the same one, give the same answer in any order', () => {
    const rows = [
      row({ sessionId: 's-a', scheduledDate: '2026-06-01', loggedAt: null, target_weight_kg: 90 }),
      row({ sessionId: 's-b', scheduledDate: '2026-07-01', loggedAt: null, target_weight_kg: 100 }),
      row({ sessionId: 's-c', scheduledDate: null, loggedAt: null, target_weight_kg: 110 }),
    ];
    const forward = buildLastPerformance(rows, { currentSessionId: 's-current' });
    const backward = buildLastPerformance([...rows].reverse(), { currentSessionId: 's-current' });
    expect(forward).toEqual(backward);
    // With nothing else to go by, the later recommended date.
    expect(forward['ex-1'].sets).toEqual([{ weight: 100, reps: 8 }]);
    expect(forward['ex-1'].performedAt).toBeNull();

    const tied = [
      row({ sessionId: 's-y', scheduledDate: null, target_weight_kg: 100 }),
      row({ sessionId: 's-x', scheduledDate: null, target_weight_kg: 110 }),
    ];
    expect(buildLastPerformance(tied, { currentSessionId: 's-current' })).toEqual(
      buildLastPerformance([...tied].reverse(), { currentSessionId: 's-current' })
    );
  });

  it('the entry keeps its shape: performedAt, scheduledDate, sets', () => {
    const out = buildLastPerformance(
      [row({ sessionId: 's-1', scheduledDate: '2026-07-01', loggedAt: '2026-07-01T10:00:00Z' })],
      { currentSessionId: 's-current', exerciseIds: ['ex-1'] }
    );
    expect(out).toEqual({
      'ex-1': { performedAt: '2026-07-01T10:00:00Z', scheduledDate: '2026-07-01', sets: [{ weight: 100, reps: 8 }] },
    });
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
