import { describe, it, expect } from 'vitest';
import {
  computeSessionVolume,
  groupSlotsBySuperset,
  hasLoggedActual,
  isSlotUniform,
  getSlotTargetRest,
} from './volume';

describe('computeSessionVolume (legacy slot scalars)', () => {
  it('returns zero for empty slots', () => {
    expect(computeSessionVolume([])).toEqual({ pull: 0, push: 0 });
  });

  it('computes pull volume correctly', () => {
    const slots = [
      { sets: 3, reps: 10, exercise: { difficulty: 2, type: 'pull', volume_weight: 1 } },
    ];
    expect(computeSessionVolume(slots)).toEqual({ pull: 60, push: 0 });
  });

  it('computes push volume correctly', () => {
    const slots = [
      { sets: 4, reps: 8, exercise: { difficulty: 3, type: 'push', volume_weight: 1.5 } },
    ];
    expect(computeSessionVolume(slots)).toEqual({ pull: 0, push: 144 });
  });

  it('sums multiple slots of mixed types', () => {
    const slots = [
      { sets: 3, reps: 10, exercise: { difficulty: 1, type: 'pull', volume_weight: 1 } },
      { sets: 3, reps: 10, exercise: { difficulty: 1, type: 'push', volume_weight: 1 } },
      { sets: 2, reps: 5, exercise: { difficulty: 2, type: 'pull', volume_weight: 2 } },
    ];
    expect(computeSessionVolume(slots)).toEqual({ pull: 70, push: 30 });
  });
});

describe('computeSessionVolume (per-set targets)', () => {
  it('sums per-set target_reps when set_logs are present', () => {
    // 8 + 8 + 6 reps × difficulty 2 × volume_weight 1 = 44
    const slots = [
      {
        sets: 3,
        reps: 10, // legacy mirror — ignored when logs are present
        exercise: { difficulty: 2, type: 'pull', volume_weight: 1 },
        set_logs: [
          { set_number: 1, target_reps: 8, target_weight_kg: 80 },
          { set_number: 2, target_reps: 8, target_weight_kg: 80 },
          { set_number: 3, target_reps: 6, target_weight_kg: 100 },
        ],
      },
    ];
    expect(computeSessionVolume(slots)).toEqual({ pull: 44, push: 0 });
  });

  it('falls back to slot scalars when set_logs lack target_*', () => {
    // Logs present but with no target columns (legacy mock data) — fall back
    // to the slot's sets × reps so pre-migration data still aggregates.
    const slots = [
      {
        sets: 2,
        reps: 5,
        exercise: { difficulty: 1, type: 'push', volume_weight: 1 },
        set_logs: [
          { set_number: 1, done: false },
          { set_number: 2, done: false },
        ],
      },
    ];
    expect(computeSessionVolume(slots)).toEqual({ pull: 0, push: 10 });
  });

  it('skips time-under-tension sets with no target_reps', () => {
    const slots = [
      {
        sets: 1,
        duration_seconds: 30,
        exercise: { difficulty: 2, type: 'push', volume_weight: 1 },
        set_logs: [
          { set_number: 1, target_duration_seconds: 30 },
        ],
      },
    ];
    expect(computeSessionVolume(slots)).toEqual({ pull: 0, push: 0 });
  });
});

describe('isSlotUniform', () => {
  it('treats slots without per-set logs as uniform', () => {
    expect(isSlotUniform({ sets: 3, reps: 10 })).toBe(true);
  });

  it('returns true when every set has matching targets', () => {
    expect(
      isSlotUniform({
        sets: 3,
        set_logs: [
          { set_number: 1, target_reps: 10, target_weight_kg: 80 },
          { set_number: 2, target_reps: 10, target_weight_kg: 80 },
          { set_number: 3, target_reps: 10, target_weight_kg: 80 },
        ],
      })
    ).toBe(true);
  });

  it('returns false when reps differ across sets', () => {
    expect(
      isSlotUniform({
        sets: 2,
        set_logs: [
          { set_number: 1, target_reps: 10, target_weight_kg: 80 },
          { set_number: 2, target_reps: 6, target_weight_kg: 100 },
        ],
      })
    ).toBe(false);
  });

  it('returns false when weight differs across sets (numeric vs string)', () => {
    expect(
      isSlotUniform({
        sets: 2,
        set_logs: [
          { set_number: 1, target_reps: 10, target_weight_kg: 80 },
          { set_number: 2, target_reps: 10, target_weight_kg: '100.00' },
        ],
      })
    ).toBe(false);
  });

  it('returns true when only one set has targets (others empty)', () => {
    expect(
      isSlotUniform({
        sets: 2,
        set_logs: [
          { set_number: 1, target_reps: 10, target_weight_kg: 80 },
          { set_number: 2 }, // no targets — treated as not-yet-set, slot reads uniform
        ],
      })
    ).toBe(true);
  });
});

describe('hasLoggedActual', () => {
  it('is false when neither actual column is set', () => {
    expect(hasLoggedActual({ target_reps: 10, target_weight_kg: 80 })).toBe(false);
    expect(hasLoggedActual({ actual_reps: null, actual_weight_kg: null })).toBe(false);
  });

  it('is true when either actual column is set', () => {
    expect(hasLoggedActual({ actual_reps: 8 })).toBe(true);
    expect(hasLoggedActual({ actual_weight_kg: 100 })).toBe(true);
  });

  it('treats actual_reps 0 as a logged deviation (not absent)', () => {
    expect(hasLoggedActual({ actual_reps: 0 })).toBe(true);
  });

  it('is false for a null/undefined log', () => {
    expect(hasLoggedActual(null)).toBe(false);
    expect(hasLoggedActual(undefined)).toBe(false);
  });
});

describe('getSlotTargetRest', () => {
  it('falls back to the slot scalar when logs are empty', () => {
    expect(getSlotTargetRest({ rest_seconds: 90 })).toBe(90);
  });
});

describe('groupSlotsBySuperset', () => {
  it('groups consecutive shared groups', () => {
    const slots = [
      { id: 'a', superset_group: null },
      { id: 'b', superset_group: 'g1' },
      { id: 'c', superset_group: 'g1' },
      { id: 'd', superset_group: null },
      { id: 'e', superset_group: 'g2' },
    ];
    const groups = groupSlotsBySuperset(slots);
    expect(groups).toHaveLength(4);
    expect(groups[0].slots.map((s) => s.id)).toEqual(['a']);
    expect(groups[1].key).toBe('g1');
    expect(groups[1].slots.map((s) => s.id)).toEqual(['b', 'c']);
    expect(groups[2].slots.map((s) => s.id)).toEqual(['d']);
    expect(groups[3].slots.map((s) => s.id)).toEqual(['e']);
  });
});
