import { describe, it, expect } from 'vitest';
import { findPreviousSession } from './PreviousSessionPanel';

const program = {
  id: 'p-1',
  weeks: [
    {
      id: 'w-1',
      week_number: 1,
      sessions: [
        { id: 'a1', day_number: 1, sort_order: 0, archived_at: null },
        { id: 'a3', day_number: 3, sort_order: 1, archived_at: null },
      ],
    },
    {
      id: 'w-2',
      week_number: 2,
      sessions: [
        { id: 'b1', day_number: 1, sort_order: 0, archived_at: null },
        { id: 'b3', day_number: 3, sort_order: 1, archived_at: null },
      ],
    },
  ],
};

describe('findPreviousSession', () => {
  it('matches the same weekday in the previous week', () => {
    const prev = findPreviousSession(program, 'b3');
    expect(prev.session.id).toBe('a3');
    expect(prev.week.week_number).toBe(1);
  });

  it('returns null in week 1 — there is no previous week', () => {
    expect(findPreviousSession(program, 'a1')).toBeNull();
  });

  it('returns null for a session that is not in the program', () => {
    expect(findPreviousSession(program, 'nope')).toBeNull();
  });

  it('falls back to the same position when the weekday does not exist', () => {
    const shifted = {
      weeks: [
        { id: 'w-1', week_number: 1, sessions: [{ id: 'a', day_number: 2, sort_order: 0, archived_at: null }] },
        { id: 'w-2', week_number: 2, sessions: [{ id: 'b', day_number: 5, sort_order: 0, archived_at: null }] },
      ],
    };
    expect(findPreviousSession(shifted, 'b').session.id).toBe('a');
  });

  it('ignores archived sessions — they are not what the athlete follows', () => {
    const withArchived = {
      weeks: [
        {
          id: 'w-1',
          week_number: 1,
          sessions: [{ id: 'old', day_number: 1, sort_order: 0, archived_at: '2026-01-01' }],
        },
        {
          id: 'w-2',
          week_number: 2,
          sessions: [{ id: 'new', day_number: 1, sort_order: 0, archived_at: null }],
        },
      ],
    };
    expect(findPreviousSession(withArchived, 'new')).toBeNull();
  });

  it('is null-safe when the program has not loaded', () => {
    expect(findPreviousSession(undefined, 'b3')).toBeNull();
    expect(findPreviousSession({}, 'b3')).toBeNull();
  });

  it('handles a gap in week numbers (no week N-1) by returning null', () => {
    const gapped = {
      weeks: [
        { id: 'w-1', week_number: 1, sessions: [{ id: 'a', day_number: 1, sort_order: 0, archived_at: null }] },
        { id: 'w-3', week_number: 3, sessions: [{ id: 'c', day_number: 1, sort_order: 0, archived_at: null }] },
      ],
    };
    expect(findPreviousSession(gapped, 'c')).toBeNull();
  });
});
