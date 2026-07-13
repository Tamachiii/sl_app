import { describe, it, expect } from 'vitest';
import { epley1rm, effectiveWeight, effectiveReps, buildRecords } from './records';

describe('epley1rm', () => {
  it('equals the weight at 1 rep and scales by Epley above', () => {
    expect(epley1rm(100, 1)).toBe(100);
    expect(epley1rm(100, 10)).toBeCloseTo(133.33, 2); // 100 × (1 + 10/30)
  });
  it('is 0 for non-positive weight or reps', () => {
    expect(epley1rm(0, 5)).toBe(0);
    expect(epley1rm(100, 0)).toBe(0);
    expect(epley1rm(null, 5)).toBe(0);
  });
});

describe('effective weight/reps', () => {
  it('actual overrides target; missing/zero weight → 0', () => {
    expect(effectiveWeight({ actual_weight_kg: 90, target_weight_kg: 100 })).toBe(90);
    expect(effectiveWeight({ actual_weight_kg: null, target_weight_kg: 100 })).toBe(100);
    expect(effectiveWeight({ actual_weight_kg: 0, target_weight_kg: null })).toBe(0);
    expect(effectiveReps({ actual_reps: 3, target_reps: 5 })).toBe(3);
    expect(effectiveReps({ actual_reps: null, target_reps: 5 })).toBe(5);
  });
});

describe('buildRecords', () => {
  const ex = { id: 'e-1', name: 'Weighted Pull-up', type: 'pull' };
  const bw = { id: 'e-2', name: 'Push-up', type: 'push' };

  it('takes the best e1RM per exercise from done weighted sets, ignoring undone', () => {
    const logs = [
      { done: true, exercise: ex, logged_at: '2026-07-01', target_reps: 5, target_weight_kg: 100 }, // 116.7
      { done: true, exercise: ex, logged_at: '2026-07-08', actual_reps: 3, actual_weight_kg: 120 }, // 132
      { done: false, exercise: ex, logged_at: '2026-07-09', actual_reps: 1, actual_weight_kg: 200 }, // ignored
    ];
    const recs = buildRecords(logs);
    expect(recs).toHaveLength(1);
    expect(recs[0].bestE1rm).toBe(132); // 120 × (1 + 3/30) = 132
    expect(recs[0].bestE1rmWeight).toBe(120);
    expect(recs[0].bestE1rmReps).toBe(3);
    expect(recs[0].bestE1rmAt).toBe('2026-07-08');
  });

  it('tracks best reps for bodyweight sets (no e1RM)', () => {
    const logs = [
      { done: true, exercise: bw, logged_at: '2026-07-01', actual_reps: 20, actual_weight_kg: null },
      { done: true, exercise: bw, logged_at: '2026-07-05', actual_reps: 25, actual_weight_kg: 0 },
    ];
    const recs = buildRecords(logs);
    expect(recs[0].bestE1rm).toBeNull();
    expect(recs[0].bestReps).toBe(25);
    expect(recs[0].bestRepsAt).toBe('2026-07-05');
  });

  it('flags a record set on/after recentSince as recent, and sorts weighted first', () => {
    const logs = [
      { done: true, exercise: bw, logged_at: '2026-07-05', actual_reps: 25 },
      { done: true, exercise: ex, logged_at: '2026-07-10', actual_reps: 3, actual_weight_kg: 120 },
    ];
    const recs = buildRecords(logs, { recentSince: new Date('2026-07-08') });
    // Weighted (e1RM) sorts before bodyweight-only.
    expect(recs[0].exercise_id).toBe('e-1');
    expect(recs[0].recent).toBe(true); // 07-10 ≥ 07-08
    expect(recs[1].recent).toBe(false); // 07-05 < 07-08
  });
});
