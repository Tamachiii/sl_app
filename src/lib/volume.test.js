import { describe, it, expect } from 'vitest';
import {
  computeSessionVolume,
  groupSlotsBySuperset,
  formatRestSeconds,
  formatSlotPrescription,
  formatSetTarget,
  isSlotUniform,
  getSlotTargetWeight,
  getSlotTargetRest,
  summarizeSlotPrescription,
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

describe('formatSlotPrescription', () => {
  it('formats reps from slot scalars when no logs', () => {
    expect(formatSlotPrescription({ sets: 3, reps: 10 })).toBe('3 × 10');
  });

  it('formats seconds from slot scalars when no logs', () => {
    expect(formatSlotPrescription({ sets: 2, duration_seconds: 30 })).toBe('2 × 30s');
  });

  it('formats reps from per-set logs when uniform', () => {
    expect(
      formatSlotPrescription({
        sets: 3,
        set_logs: [
          { set_number: 1, target_reps: 8 },
          { set_number: 2, target_reps: 8 },
          { set_number: 3, target_reps: 8 },
        ],
      })
    ).toBe('3 × 8');
  });

  it('returns null when sets are heterogeneous', () => {
    expect(
      formatSlotPrescription({
        sets: 2,
        set_logs: [
          { set_number: 1, target_reps: 10 },
          { set_number: 2, target_reps: 6 },
        ],
      })
    ).toBe(null);
  });
});

describe('formatSetTarget', () => {
  it('formats reps and weight', () => {
    expect(formatSetTarget({ target_reps: 10, target_weight_kg: 80 })).toBe('10 @ 80kg');
  });

  it('formats reps with bodyweight', () => {
    expect(formatSetTarget({ target_reps: 5, target_weight_kg: null })).toBe('5 (BW)');
  });

  it('formats time-based set', () => {
    expect(formatSetTarget({ target_duration_seconds: 30, target_weight_kg: null })).toBe('30s (BW)');
  });
});

describe('getSlotTargetWeight / getSlotTargetRest', () => {
  it('falls back to slot scalars when logs are empty', () => {
    expect(getSlotTargetWeight({ weight_kg: 50 })).toBe(50);
    expect(getSlotTargetRest({ rest_seconds: 90 })).toBe(90);
  });

  it('falls back when logs exist but lack targets', () => {
    expect(getSlotTargetWeight({ weight_kg: 50, set_logs: [{ set_number: 1 }] })).toBe(50);
  });

  it('reads from the head log when targets are populated', () => {
    expect(
      getSlotTargetWeight({
        weight_kg: 50,
        set_logs: [{ set_number: 1, target_weight_kg: '80.00' }],
      })
    ).toBe(80);
  });

  it('returns null for bodyweight slots with no log targets', () => {
    expect(getSlotTargetWeight({ weight_kg: null })).toBe(null);
  });
});

describe('summarizeSlotPrescription', () => {
  it('formats uniform slot from scalars', () => {
    expect(summarizeSlotPrescription({ sets: 3, reps: 10, weight_kg: 80 })).toBe('3 × 10 @ 80kg');
  });

  it('formats uniform slot without weight as bodyweight (no suffix)', () => {
    // Bodyweight reads as no @ suffix in the headline (matches uniform shape).
    expect(summarizeSlotPrescription({ sets: 3, reps: 10 })).toBe('3 × 10');
  });

  it('formats a drop-set with two groups', () => {
    expect(
      summarizeSlotPrescription({
        sets: 6,
        set_logs: [
          { set_number: 1, target_reps: 3, target_weight_kg: 120 },
          { set_number: 2, target_reps: 3, target_weight_kg: 120 },
          { set_number: 3, target_reps: 3, target_weight_kg: 120 },
          { set_number: 4, target_reps: 6, target_weight_kg: 100 },
          { set_number: 5, target_reps: 6, target_weight_kg: 100 },
          { set_number: 6, target_reps: 6, target_weight_kg: 100 },
        ],
      })
    ).toBe('3 × 3 @ 120kg · 3 × 6 @ 100kg');
  });

  it('formats a 3-group ramp', () => {
    expect(
      summarizeSlotPrescription({
        sets: 3,
        set_logs: [
          { set_number: 1, target_reps: 5, target_weight_kg: 100 },
          { set_number: 2, target_reps: 3, target_weight_kg: 110 },
          { set_number: 3, target_reps: 1, target_weight_kg: 120 },
        ],
      })
    ).toBe('1 × 5 @ 100kg · 1 × 3 @ 110kg · 1 × 1 @ 120kg');
  });

  it('falls back to "N sets · varied" when more than three groups', () => {
    expect(
      summarizeSlotPrescription({
        sets: 4,
        set_logs: [
          { set_number: 1, target_reps: 5, target_weight_kg: 60 },
          { set_number: 2, target_reps: 4, target_weight_kg: 70 },
          { set_number: 3, target_reps: 3, target_weight_kg: 80 },
          { set_number: 4, target_reps: 2, target_weight_kg: 90 },
        ],
      })
    ).toBe('4 sets · varied');
  });

  it('handles bodyweight in heterogeneous groups', () => {
    expect(
      summarizeSlotPrescription({
        sets: 4,
        set_logs: [
          { set_number: 1, target_reps: 8, target_weight_kg: null },
          { set_number: 2, target_reps: 8, target_weight_kg: null },
          { set_number: 3, target_reps: 5, target_weight_kg: 20 },
          { set_number: 4, target_reps: 5, target_weight_kg: 20 },
        ],
      })
    ).toBe('2 × 8 (BW) · 2 × 5 @ 20kg');
  });
});

describe('formatRestSeconds', () => {
  it('formats seconds and minutes', () => {
    expect(formatRestSeconds(null)).toBe(null);
    expect(formatRestSeconds(45)).toBe('45s');
    expect(formatRestSeconds(60)).toBe('1:00');
    expect(formatRestSeconds(90)).toBe('1:30');
    expect(formatRestSeconds(125)).toBe('2:05');
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
