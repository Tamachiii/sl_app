import { describe, it, expect } from 'vitest';
import { epley1rm, effectiveWeight, effectiveReps, buildRecords, systemLoad } from './records';

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

  it('defaults to no ×BW (unclassified exercise / no bodyweight resolver)', () => {
    const logs = [{ done: true, exercise: ex, logged_at: '2026-07-01', actual_reps: 3, actual_weight_kg: 120 }];
    const recs = buildRecords(logs); // no bodyweightAt, no load_mode
    expect(recs[0].bestE1rm).toBe(132);
    expect(recs[0].relStrength).toBeNull();
    expect(recs[0].bwAtBest).toBeNull();
  });
});

describe('systemLoad', () => {
  it('adds bodyweight for added-load movements, needs a known bodyweight', () => {
    expect(systemLoad(40, 70, 'added')).toBe(110);
    expect(systemLoad(40, 0, 'added')).toBeNull();
    expect(systemLoad(40, null, 'added')).toBeNull();
  });
  it('returns the logged load as-is for full/unclassified', () => {
    expect(systemLoad(100, 70, 'full')).toBe(100);
    expect(systemLoad(100, 70, null)).toBe(100);
    expect(systemLoad(0, 70, 'full')).toBe(0);
  });
});

describe('buildRecords — relative strength (×BW)', () => {
  const added = { id: 'e-1', name: 'Weighted Pull-up', type: 'pull', load_mode: 'added' };
  const full = { id: 'e-2', name: 'Back Squat', type: 'push', load_mode: 'full' };
  const at70 = () => 70;

  it('added mode with known bodyweight → peak system-load ×BW, headline unchanged', () => {
    // +40 × 3 at 70kg BW: added-load e1RM 44 (headline); system e1RM epley(110,3)=121; 121/70=1.7.
    const logs = [{ done: true, exercise: added, logged_at: '2026-07-01', actual_reps: 3, actual_weight_kg: 40 }];
    const recs = buildRecords(logs, { bodyweightAt: at70 });
    expect(recs[0].bestE1rm).toBe(44);   // headline is the added-load e1RM
    expect(recs[0].relStrength).toBe(1.7);
    expect(recs[0].bwAtBest).toBe(70);
  });

  it('full mode with known bodyweight → e1RM ÷ BW', () => {
    // 100 × 3 at 70kg BW: e1RM epley(100,3)=110; 110/70=1.6.
    const logs = [{ done: true, exercise: full, logged_at: '2026-07-01', actual_reps: 3, actual_weight_kg: 100 }];
    const recs = buildRecords(logs, { bodyweightAt: at70 });
    expect(recs[0].bestE1rm).toBe(110);
    expect(recs[0].relStrength).toBe(1.6);
  });

  it('added mode with UNKNOWN bodyweight degrades gracefully (no pill)', () => {
    const logs = [{ done: true, exercise: added, logged_at: '2026-07-01', actual_reps: 3, actual_weight_kg: 40 }];
    const recs = buildRecords(logs, { bodyweightAt: () => null });
    expect(recs[0].bestE1rm).toBe(44); // added-load, exactly as today
    expect(recs[0].relStrength).toBeNull();
    expect(recs[0].bwAtBest).toBeNull();
  });

  it('×BW is the MAX ratio across sets, not the ratio of the added-load PR set', () => {
    // +40×3 wins the added-load PR (e1RM 44 > 38) but +30×8 has the higher
    // SYSTEM single: epley(100,8)=126.7 → 1.8× BW vs +40×3's epley(110,3)=121 → 1.7×.
    const logs = [
      { done: true, exercise: added, logged_at: '2026-07-01', actual_reps: 3, actual_weight_kg: 40 },
      { done: true, exercise: added, logged_at: '2026-07-08', actual_reps: 8, actual_weight_kg: 30 },
    ];
    const recs = buildRecords(logs, { bodyweightAt: at70 });
    expect(recs[0].bestE1rmWeight).toBe(40); // PR selection unchanged
    expect(recs[0].relStrength).toBe(1.8);   // ×BW tracks the strongest relative single
  });

  it('a bodyweight-only set on an added movement still yields a ×BW (system load = bodyweight)', () => {
    // Pure bodyweight × 12 at 70kg: epley(70,12)=98 → 1.4× BW. No added load → no e1RM.
    const logs = [{ done: true, exercise: added, logged_at: '2026-07-01', actual_reps: 12, actual_weight_kg: 0 }];
    const recs = buildRecords(logs, { bodyweightAt: at70 });
    expect(recs[0].bestE1rm).toBeNull();  // no weighted set
    expect(recs[0].relStrength).toBe(1.4);
  });

  it('bodyweight gain does not reshuffle PR selection (sort stays on added-load e1RM)', () => {
    const logs = [
      { done: true, exercise: added, logged_at: '2026-07-01', actual_reps: 3, actual_weight_kg: 40 }, // added e1RM 44
      { done: true, exercise: added, logged_at: '2026-08-01', actual_reps: 5, actual_weight_kg: 30 }, // added e1RM 35
    ];
    const recs = buildRecords(logs, { bodyweightAt: at70 });
    expect(recs[0].bestE1rmWeight).toBe(40); // the +40×3 set, not the later +30×5
    expect(recs[0].bestE1rmAt).toBe('2026-07-01');
  });
});
