import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

let mockConfirmations;
vi.mock('./useSessionConfirmation', () => ({
  useAllConfirmations: () => mockConfirmations,
}));

import { useToReviewCount } from './useToReviewCount';
import { buildRoster } from '../lib/coachRoster';

const confirmation = (overrides = {}) => ({
  id: 'c',
  session_id: 's',
  student_id: 'st-1',
  reviewed_at: null,
  archived_at: null,
  ...overrides,
});

describe('useToReviewCount', () => {
  beforeEach(() => {
    mockConfirmations = { data: undefined };
  });

  it('is not known while the confirmations are loading', () => {
    mockConfirmations = { data: undefined, isLoading: true };
    expect(renderHook(() => useToReviewCount()).result.current).toBeUndefined();
  });

  it('is not known when their read failed with nothing to show', () => {
    mockConfirmations = { data: undefined, isError: true };
    expect(renderHook(() => useToReviewCount()).result.current).toBeUndefined();
  });

  it('is 0 when there are none', () => {
    mockConfirmations = { data: [] };
    expect(renderHook(() => useToReviewCount()).result.current).toBe(0);
  });

  it('counts the sessions neither reviewed nor archived, across athletes', () => {
    mockConfirmations = {
      data: [
        confirmation({ id: 'a' }),
        confirmation({ id: 'b', student_id: 'st-2' }),
        confirmation({ id: 'c', reviewed_at: '2026-10-01T10:00:00Z' }),
        confirmation({ id: 'd', archived_at: '2026-10-01T10:00:00Z' }),
        confirmation({ id: 'e', reviewed_at: '2026-10-01T10:00:00Z', archived_at: '2026-10-02T10:00:00Z' }),
        confirmation({ id: 'f', student_id: 'st-2' }),
      ],
    };
    expect(renderHook(() => useToReviewCount()).result.current).toBe(3);
  });

  // The tab and the roster's chips are one count: the tab is their sum.
  it('says what the roster cards add up to', () => {
    const data = [
      confirmation({ id: 'a' }),
      confirmation({ id: 'b' }),
      confirmation({ id: 'c', student_id: 'st-2' }),
      confirmation({ id: 'd', student_id: 'st-2', reviewed_at: '2026-10-01T10:00:00Z' }),
    ];
    mockConfirmations = { data };
    const students = [
      { id: 'st-1', profile_id: 'p-1', created_at: null, profile: { full_name: 'Alice' } },
      { id: 'st-2', profile_id: 'p-2', created_at: null, profile: { full_name: 'Bob' } },
    ];
    const chips = buildRoster({ students, summary: {}, confirmations: data })
      .flatMap((entry) => entry.chips)
      .filter((chip) => chip.kind === 'toReview')
      .reduce((sum, chip) => sum + chip.n, 0);

    expect(renderHook(() => useToReviewCount()).result.current).toBe(chips);
    expect(chips).toBe(3);
  });
});
