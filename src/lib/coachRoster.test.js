import { describe, it, expect } from 'vitest';
import { buildRoster } from './coachRoster';

const student = (id, name) => ({ id, profile: { full_name: name } });

// A strip is now placement state, not adherence: nothing here is "missed",
// and triage reads `daysSinceLast` instead.
const week = [
  { dayNumber: 1, session: { id: 'a' }, state: 'performed' },
  { dayNumber: 2, session: { id: 'b' }, state: 'performed' },
  { dayNumber: 3, session: { id: 'c' }, state: 'suggested' },
  { dayNumber: 4, session: null, state: 'rest' },
  { dayNumber: 5, session: null, state: 'rest' },
  { dayNumber: 6, session: null, state: 'rest' },
  { dayNumber: 7, session: null, state: 'rest' },
];

describe('buildRoster', () => {
  const students = [
    student('s1', 'Alice'), // calm
    student('s2', 'Bob'), // no program (absent from summary)
    student('s3', 'Cara'), // 2 to review
    student('s4', 'Dan'), // gone quiet
    student('s5', 'Eve'), // calm
  ];

  const summary = {
    s1: { programName: 'Hyp', position: 7, totalSessions: 24, daysSinceLast: 1, weekDays: week },
    s3: { programName: 'Str', position: 2, totalSessions: 12, daysSinceLast: 2, weekDays: week },
    s4: { programName: 'GPP', position: 4, totalSessions: 16, daysSinceLast: 14, weekDays: week },
    s5: { programName: 'Base', position: 1, totalSessions: 9, daysSinceLast: null, weekDays: week },
    // s2 deliberately absent → "no active program".
  };

  const confirmations = [
    { student_id: 's3', reviewed_at: null, archived_at: null },
    { student_id: 's3', reviewed_at: null, archived_at: null },
    { student_id: 's3', reviewed_at: '2026-01-01', archived_at: null }, // already reviewed → ignored
    { student_id: 's1', reviewed_at: null, archived_at: '2026-01-01' }, // archived → ignored
  ];

  const roster = buildRoster({ students, summary, confirmations });
  const byId = Object.fromEntries(roster.map((e) => [e.student.id, e]));

  it('orders attention-first (noProgram > toReview > stale), then calm A–Z', () => {
    expect(roster.map((e) => e.student.id)).toEqual(['s2', 's3', 's4', 's1', 's5']);
  });

  it('flags "no active program" from summary-map absence, not activeWeek', () => {
    expect(byId.s2.chips).toEqual([{ kind: 'noProgram' }]);
    expect(byId.s2.hasAttention).toBe(true);
    expect(byId.s2.programName).toBeNull();
  });

  it('counts sessions awaiting review, ignoring reviewed/archived confirmations', () => {
    expect(byId.s3.chips).toEqual([{ kind: 'toReview', n: 2 }]);
    // s1 had only an archived confirmation → no review chip, stays calm.
    expect(byId.s1.chips).toEqual([]);
    expect(byId.s1.hasAttention).toBe(false);
  });

  // A passing recommended day is no longer a finding — athletes train when
  // they can. Going quiet for a stretch is.
  it('flags an athlete who has gone quiet, not one who moved a day', () => {
    expect(byId.s4.chips).toEqual([{ kind: 'stale', days: 14 }]);
    // Trained a day or two ago → nothing to flag.
    expect(byId.s1.chips).toEqual([]);
    expect(byId.s3.chips.some((c) => c.kind === 'stale')).toBe(false);
  });

  // An athlete who has never logged anything may have just been assigned a
  // block; "quiet forever" is not a finding either.
  it('does not flag an athlete who has never trained', () => {
    expect(byId.s5.daysSinceLast).toBeNull();
    expect(byId.s5.chips).toEqual([]);
  });

  it('carries program name + queue position onto each entry', () => {
    expect(byId.s1.programName).toBe('Hyp');
    expect(byId.s1.position).toBe(7);
    expect(byId.s1.totalSessions).toBe(24);
  });

  it('combines chips and ranks by the most-urgent one', () => {
    // A student with no program AND a pending review → both chips, priority of noProgram.
    const combined = buildRoster({
      students: [student('x', 'Zoe')],
      summary: {},
      confirmations: [{ student_id: 'x', reviewed_at: null, archived_at: null }],
    });
    expect(combined[0].chips.map((c) => c.kind)).toEqual(['noProgram', 'toReview']);
    expect(combined[0].priority).toBe(3);
  });

  it('is resilient to undefined summary / confirmations', () => {
    const bare = buildRoster({ students: [student('s1', 'Alice')], summary: undefined, confirmations: undefined });
    expect(bare).toHaveLength(1);
    expect(bare[0].chips).toEqual([{ kind: 'noProgram' }]);
    expect(bare[0].weekDays).toBeNull();
  });
});
