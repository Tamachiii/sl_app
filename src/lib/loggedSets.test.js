import { describe, it, expect, vi } from 'vitest';
import {
  isLoggedSet,
  hasSetVideo,
  isProtectedSet,
  onlyPendingSets,
  loggedSetsError,
  LOGGED_SETS_ERROR_CODE,
  LOGGED_SET_COLUMNS,
  LOGGED_SET_OR_FILTER,
} from './loggedSets';
import { mutationErrorKey } from './mutationErrors';

const pending = {
  done: false,
  failed: false,
  skipped: false,
  rpe: null,
  actual_reps: null,
  actual_weight_kg: null,
};

describe('isLoggedSet', () => {
  it('is false for a row the athlete has not touched', () => {
    expect(isLoggedSet(pending)).toBe(false);
    expect(isLoggedSet({})).toBe(false);
    expect(isLoggedSet(null)).toBe(false);
  });

  // The database's predicate, one flag at a time: any ONE of them is training
  // the athlete recorded, done or not.
  it.each([
    ['done', { done: true }],
    ['failed', { failed: true }],
    ['skipped', { skipped: true }],
    ['an RPE on an un-ticked set', { rpe: 8 }],
    ['actual reps', { actual_reps: 6 }],
    ['an actual weight', { actual_weight_kg: 82.5 }],
    // A real zero is a value, not an absence.
    ['zero actual reps', { actual_reps: 0 }],
  ])('is true for %s', (_label, patch) => {
    expect(isLoggedSet({ ...pending, ...patch })).toBe(true);
  });

  it('names every column the predicate reads, in both of its query forms', () => {
    for (const col of ['done', 'failed', 'skipped', 'rpe', 'actual_reps', 'actual_weight_kg']) {
      expect(LOGGED_SET_COLUMNS).toContain(col);
      expect(LOGGED_SET_OR_FILTER).toContain(`${col}.`);
    }
  });
});

describe('hasSetVideo / isProtectedSet', () => {
  it('reads the embed as an object (to-one) or as an array', () => {
    expect(hasSetVideo({ set_log_videos: { id: 'v-1' } })).toBe(true);
    expect(hasSetVideo({ set_log_videos: [{ id: 'v-1' }] })).toBe(true);
    expect(hasSetVideo({ set_log_videos: null })).toBe(false);
    expect(hasSetVideo({ set_log_videos: [] })).toBe(false);
    expect(hasSetVideo({})).toBe(false);
  });

  it('protects a set that carries a video even when it was never ticked', () => {
    expect(isProtectedSet({ ...pending, set_log_videos: { id: 'v-1' } })).toBe(true);
    expect(isProtectedSet({ ...pending, done: true })).toBe(true);
    expect(isProtectedSet(pending)).toBe(false);
  });
});

describe('onlyPendingSets', () => {
  it('adds the inverse of the predicate to a query, column by column', () => {
    const q = { eq: vi.fn().mockReturnThis(), is: vi.fn().mockReturnThis() };
    expect(onlyPendingSets(q)).toBe(q);
    expect(q.eq.mock.calls).toEqual([
      ['done', false],
      ['failed', false],
      ['skipped', false],
    ]);
    expect(q.is.mock.calls).toEqual([
      ['rpe', null],
      ['actual_reps', null],
      ['actual_weight_kg', null],
    ]);
  });
});

describe('loggedSetsError', () => {
  // The toast is chosen by lib/mutationErrors from the MESSAGE. If the wording
  // drifts, the coach gets "Couldn't save that. Please try again." — and tries
  // again.
  it('is the error the global toast reads as "has logged training"', () => {
    const err = loggedSetsError();
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(LOGGED_SETS_ERROR_CODE);
    expect(mutationErrorKey(err)).toBe('errors.hasLoggedTraining');
  });
});
