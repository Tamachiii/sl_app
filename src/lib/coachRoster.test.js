import { describe, it, expect } from 'vitest';
import { buildRoster, reviewCountsByStudent } from './coachRoster';

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

  // What useReviewCounts holds: `{ [students.id]: n }`.
  const reviewCounts = reviewCountsByStudent(confirmations);
  const roster = buildRoster({ students, summary, reviewCounts });
  const byId = Object.fromEntries(roster.map((e) => [e.student.id, e]));

  it('orders attention-first (noProgram > toReview > stale), then calm A–Z', () => {
    expect(roster.map((e) => e.student.id)).toEqual(['s2', 's3', 's4', 's1', 's5']);
  });

  it('flags "no active program" from summary-map absence, not activeWeek', () => {
    expect(byId.s2.chips).toEqual([{ kind: 'noProgram' }]);
    expect(byId.s2.hasAttention).toBe(true);
    expect(byId.s2.programName).toBeNull();
  });

  it('counts per athlete the confirmations neither reviewed nor archived', () => {
    expect(reviewCounts).toEqual({ s3: 2 });
    expect(reviewCountsByStudent([])).toEqual({});
    expect(reviewCountsByStudent([{ student_id: null, reviewed_at: null, archived_at: null }])).toEqual({});
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
      reviewCounts: { x: 1 },
    });
    expect(combined[0].chips.map((c) => c.kind)).toEqual(['noProgram', 'toReview']);
    expect(combined[0].priority).toBe(3);
  });

  // Review items P48, N16: a summary that had not arrived, or that was
  // answered by a 500, was read as "nobody has a program" — a red chip on
  // every athlete, all of them sorted to the top. Null is unknown, not empty.
  describe('a read that has not answered', () => {
    it('invents no chip when neither read is known', () => {
      for (const unknown of [null, undefined]) {
        const bare = buildRoster({ students, summary: unknown, reviewCounts: unknown });
        expect(bare.map((e) => e.chips)).toEqual([[], [], [], [], []]);
        expect(bare.every((e) => !e.hasAttention && e.priority === 0)).toBe(true);
        expect(bare.map((e) => e.fullName)).toEqual(['Alice', 'Bob', 'Cara', 'Dan', 'Eve']);
        expect(bare[0].weekDays).toBeNull();
        expect(bare[0].programName).toBeNull();
        expect(bare[0].position).toBeNull();
        expect(bare[0].totalSessions).toBeNull();
      }
    });

    it('still flags what the summary says when the counts are unknown', () => {
      const partial = buildRoster({ students, summary, reviewCounts: null });
      const of = Object.fromEntries(partial.map((e) => [e.student.id, e]));
      expect(of.s2.chips).toEqual([{ kind: 'noProgram' }]);
      expect(of.s4.chips).toEqual([{ kind: 'stale', days: 14 }]);
      // Cara has two sessions to review, which nobody knows yet.
      expect(of.s3.chips).toEqual([]);
      expect(of.s1.programName).toBe('Hyp');
      expect(partial.map((e) => e.student.id)).toEqual(['s2', 's4', 's1', 's3', 's5']);
    });

    it('still counts the reviews when the summary is unknown, and says nothing about programs', () => {
      const partial = buildRoster({ students, summary: null, reviewCounts });
      const of = Object.fromEntries(partial.map((e) => [e.student.id, e]));
      expect(of.s3.chips).toEqual([{ kind: 'toReview', n: 2 }]);
      // Bob is not known to be without a program, nor Dan to be quiet.
      expect(of.s2.chips).toEqual([]);
      expect(of.s4.chips).toEqual([]);
      expect(partial.map((e) => e.student.id)).toEqual(['s3', 's1', 's2', 's4', 's5']);
    });

    it('reads an empty summary as an answer: nobody has an active program', () => {
      const answered = buildRoster({ students: [student('s1', 'Alice')], summary: {}, reviewCounts: {} });
      expect(answered[0].chips).toEqual([{ kind: 'noProgram' }]);
    });
  });
});
