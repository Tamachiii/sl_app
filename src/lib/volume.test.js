import { describe, it, expect } from 'vitest';
import { computeSessionVolume, groupSlotsBySuperset, formatRestSeconds } from './volume';

describe('computeSessionVolume', () => {
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

  it('formatRestSeconds formats seconds and minutes', () => {
    expect(formatRestSeconds(null)).toBe(null);
    expect(formatRestSeconds(45)).toBe('45s');
    expect(formatRestSeconds(60)).toBe('1:00');
    expect(formatRestSeconds(90)).toBe('1:30');
    expect(formatRestSeconds(125)).toBe('2:05');
  });

  it('groupSlotsBySuperset groups consecutive shared groups', () => {
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

  it('sums multiple slots of mixed types', () => {
    const slots = [
      { sets: 3, reps: 10, exercise: { difficulty: 1, type: 'pull', volume_weight: 1 } },
      { sets: 3, reps: 10, exercise: { difficulty: 1, type: 'push', volume_weight: 1 } },
      { sets: 2, reps: 5, exercise: { difficulty: 2, type: 'pull', volume_weight: 2 } },
    ];
    expect(computeSessionVolume(slots)).toEqual({ pull: 70, push: 30 });
  });
});
