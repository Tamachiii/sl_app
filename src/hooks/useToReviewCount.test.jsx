import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

let mockCounts;
const mockUseReviewCounts = vi.fn(() => mockCounts);
vi.mock('./useSessionConfirmation', () => ({
  useReviewCounts: () => mockUseReviewCounts(),
}));

import { useToReviewCount } from './useToReviewCount';
import { buildRoster, reviewCountsByStudent } from '../lib/coachRoster';

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
    mockCounts = { data: undefined };
    mockUseReviewCounts.mockClear();
  });

  it('is not known while the counts are loading', () => {
    mockCounts = { data: undefined, isLoading: true };
    expect(renderHook(() => useToReviewCount()).result.current).toBeUndefined();
  });

  it('is not known when their read failed with nothing to show', () => {
    mockCounts = { data: undefined, isError: true };
    expect(renderHook(() => useToReviewCount()).result.current).toBeUndefined();
  });

  it('is 0 when no athlete has a session to review', () => {
    mockCounts = { data: {} };
    expect(renderHook(() => useToReviewCount()).result.current).toBe(0);
  });

  it('adds up the counts of every athlete', () => {
    mockCounts = { data: { 'st-1': 2, 'st-2': 1 } };
    expect(renderHook(() => useToReviewCount()).result.current).toBe(3);
  });

  // Review item L18: the tab runs on every coach page, and it read every
  // confirmation the coach's athletes ever made to count the few waiting.
  it('asks the per-athlete counts, not the confirmations', () => {
    mockCounts = { data: { 'st-1': 2 } };
    renderHook(() => useToReviewCount());
    expect(mockUseReviewCounts).toHaveBeenCalled();
  });

  // The tab and the roster's chips are one count: the tab is their sum.
  it('says what the roster cards add up to', () => {
    const counts = reviewCountsByStudent([
      confirmation({ id: 'a' }),
      confirmation({ id: 'b' }),
      confirmation({ id: 'c', student_id: 'st-2' }),
      confirmation({ id: 'd', student_id: 'st-2', reviewed_at: '2026-10-01T10:00:00Z' }),
      confirmation({ id: 'e', student_id: 'st-2', archived_at: '2026-10-01T10:00:00Z' }),
    ]);
    mockCounts = { data: counts };
    const students = [
      { id: 'st-1', profile_id: 'p-1', created_at: null, profile: { full_name: 'Alice' } },
      { id: 'st-2', profile_id: 'p-2', created_at: null, profile: { full_name: 'Bob' } },
    ];
    const chips = buildRoster({ students, summary: {}, reviewCounts: counts })
      .flatMap((entry) => entry.chips)
      .filter((chip) => chip.kind === 'toReview')
      .reduce((sum, chip) => sum + chip.n, 0);

    expect(renderHook(() => useToReviewCount()).result.current).toBe(chips);
    expect(chips).toBe(3);
  });
});
