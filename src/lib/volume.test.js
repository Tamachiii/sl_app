import { describe, it, expect } from 'vitest';
import { computeSessionVolume } from './volume';

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

  it('sums multiple slots of mixed types', () => {
    const slots = [
      { sets: 3, reps: 10, exercise: { difficulty: 1, type: 'pull', volume_weight: 1 } },
      { sets: 3, reps: 10, exercise: { difficulty: 1, type: 'push', volume_weight: 1 } },
      { sets: 2, reps: 5, exercise: { difficulty: 2, type: 'pull', volume_weight: 2 } },
    ];
    expect(computeSessionVolume(slots)).toEqual({ pull: 70, push: 30 });
  });
});
