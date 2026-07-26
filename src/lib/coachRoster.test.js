import { describe, it, expect } from 'vitest';
import { buildRoster } from './coachRoster';

const student = (id, name) => ({ id, profile: { full_name: name } });

// todayDN = 3 (Wed) throughout, so a day-1 unconfirmed session reads "missed".
const TODAY = 3;

const calmWeek = [
  { dayNumber: 1, session: { id: 'a' }, confirmed: true }, // completed
  { dayNumber: 2, session: { id: 'b' }, confirmed: true }, // completed
  { dayNumber: 3, session: { id: 'c' }, confirmed: false }, // today
  { dayNumber: 4, session: null, confirmed: false },
  { dayNumber: 5, session: null, confirmed: false },
  { dayNumber: 6, session: null, confirmed: false },
  { dayNumber: 7, session: null, confirmed: false },
];

const missedWeek = [
  { dayNumber: 1, session: { id: 'm' }, confirmed: false }, // missed (day 1 < today 3)
  { dayNumber: 2, session: null, confirmed: false },
  { dayNumber: 3, session: { id: 'c' }, confirmed: false }, // today
  { dayNumber: 4, session: null, confirmed: false },
  { dayNumber: 5, session: null, confirmed: false },
  { dayNumber: 6, session: null, confirmed: false },
  { dayNumber: 7, session: null, confirmed: false },
];

describe('buildRoster', () => {
  const students = [
    student('s1', 'Alice'), // calm
    student('s2', 'Bob'), // no program (absent from summary)
    student('s3', 'Cara'), // 2 to review
    student('s4', 'Dan'), // missed a day
    student('s5', 'Eve'), // calm
  ];

  const summary = {
    s1: { programName: 'Hyp', activeWeek: { week_number: 3, label: 'B1' }, weekDays: calmWeek },
    s3: { programName: 'Str', activeWeek: { week_number: 1, label: null }, weekDays: calmWeek },
    s4: { programName: 'GPP', activeWeek: { week_number: 2, label: null }, weekDays: missedWeek },
    s5: { programName: 'Base', activeWeek: { week_number: 5, label: null }, weekDays: calmWeek },
    // s2 deliberately absent → "no active program".
  };

  const confirmations = [
    { student_id: 's3', reviewed_at: null, archived_at: null },
    { student_id: 's3', reviewed_at: null, archived_at: null },
    { student_id: 's3', reviewed_at: '2026-01-01', archived_at: null }, // already reviewed → ignored
    { student_id: 's1', reviewed_at: null, archived_at: '2026-01-01' }, // archived → ignored
  ];

  const roster = buildRoster({ students, summary, confirmations, todayDN: TODAY });
  const byId = Object.fromEntries(roster.map((e) => [e.student.id, e]));

  it('orders attention-first (noProgram > toReview > missed), then calm A–Z', () => {
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

  it('derives a missed chip with the first missed day-number', () => {
    expect(byId.s4.chips).toEqual([{ kind: 'missed', day: 1 }]);
  });

  it('carries program name + active week onto each entry', () => {
    expect(byId.s1.programName).toBe('Hyp');
    expect(byId.s1.activeWeek).toEqual({ week_number: 3, label: 'B1' });
  });

  it('combines chips and ranks by the most-urgent one', () => {
    // A student with no program AND a pending review → both chips, priority of noProgram.
    const combined = buildRoster({
      students: [student('x', 'Zoe')],
      summary: {},
      confirmations: [{ student_id: 'x', reviewed_at: null, archived_at: null }],
      todayDN: TODAY,
    });
    expect(combined[0].chips.map((c) => c.kind)).toEqual(['noProgram', 'toReview']);
    expect(combined[0].priority).toBe(3);
  });

  it('is resilient to undefined summary / confirmations', () => {
    const bare = buildRoster({ students: [student('s1', 'Alice')], summary: undefined, confirmations: undefined, todayDN: TODAY });
    expect(bare).toHaveLength(1);
    expect(bare[0].chips).toEqual([{ kind: 'noProgram' }]);
    expect(bare[0].weekDays).toBeNull();
  });
});
