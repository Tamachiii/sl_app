import { describe, it, expect } from 'vitest';
import { flattenSessions, buildQueue, buildDayStrip } from './sessionQueue';
import { parseISODate } from './day';

const prog = { id: 'p-1', name: 'Block', sort_order: 0, is_active: true };

const session = (id, over = {}) => ({
  id,
  title: id,
  day_number: 1,
  sort_order: 0,
  archived_at: null,
  scheduled_date: null,
  performed_at: null,
  ...over,
});

const week = (id, week_number, sessions) => ({
  id,
  week_number,
  label: null,
  program: prog,
  sessions,
});

describe('flattenSessions', () => {
  it('walks weeks in program order and sessions by POSITION', () => {
    // Weekdays are deliberately out of sequence: they are hints and must not
    // reorder anything.
    const weeks = [
      week('w-2', 2, [
        session('b1', { day_number: 5, sort_order: 0 }),
        session('b2', { day_number: 2, sort_order: 1 }),
      ]),
      week('w-1', 1, [
        session('a1', { day_number: 3, sort_order: 0 }),
        session('a2', { day_number: 1, sort_order: 1 }),
      ]),
    ];
    expect(flattenSessions(weeks).map((e) => e.session.id)).toEqual(['a1', 'a2', 'b1', 'b2']);
  });

  it('orders earlier programs first', () => {
    const past = { id: 'p-0', name: 'Old', sort_order: -1, is_active: false };
    const weeks = [
      week('w-1', 1, [session('now')]),
      { ...week('w-0', 1, [session('then')]), program: past },
    ];
    expect(flattenSessions(weeks).map((e) => e.session.id)).toEqual(['then', 'now']);
  });

  // Dates stopped ordering along with weekdays: both are advice. The coach's
  // position wins, which also removed the non-transitive comparator that mixing
  // dated and undated sessions used to produce.
  it('does not let a real date jump the position the coach set', () => {
    const weeks = [
      week('w-1', 1, [
        session('later-date-first', { scheduled_date: '2026-07-13', sort_order: 0 }),
        session('earlier-date-second', { scheduled_date: '2026-07-10', sort_order: 1 }),
      ]),
    ];
    expect(flattenSessions(weeks).map((e) => e.session.id))
      .toEqual(['later-date-first', 'earlier-date-second']);
  });

  it('tolerates missing weeks and sessions', () => {
    expect(flattenSessions(null)).toEqual([]);
    expect(flattenSessions([{ id: 'w', week_number: 1 }])).toEqual([]);
  });
});

describe('buildQueue', () => {
  it('offers unconfirmed sessions in program order and drops archived ones', () => {
    const weeks = [
      week('w-1', 1, [
        session('done', { day_number: 1 }),
        session('pulled', { day_number: 2, archived_at: '2026-08-01T00:00:00Z' }),
        session('next', { day_number: 3 }),
      ]),
      week('w-2', 2, [session('later', { day_number: 1 })]),
    ];
    const q = buildQueue(weeks, new Set(['done']));
    expect(q.upcoming.map((e) => e.session.id)).toEqual(['next', 'later']);
    // The pulled session counts for nothing — not total, not position.
    expect(q.total).toBe(3);
    expect(q.completed).toBe(1);
    expect(q.position).toBe(2);
  });

  // The point of the whole model: a session not done on its recommended day is
  // still simply next. Nothing is "missed" and nothing needs moving.
  it('keeps a skipped recommended day at the head of the queue', () => {
    const weeks = [
      week('w-1', 1, [
        session('sunday-one', { day_number: 7, scheduled_date: '2026-08-16', sort_order: 0 }),
        session('after', { day_number: 1, scheduled_date: '2026-08-17', sort_order: 1 }),
      ]),
    ];
    const q = buildQueue(weeks, new Set(), { now: new Date('2026-08-20T10:00:00Z') });
    expect(q.upcoming.map((e) => e.session.id)).toEqual(['sunday-one', 'after']);
  });

  it('reports position and total clamped when the block is finished', () => {
    const weeks = [week('w-1', 1, [session('a'), session('b', { day_number: 2 })])];
    const q = buildQueue(weeks, new Set(['a', 'b']));
    expect(q.upcoming).toEqual([]);
    expect(q.position).toBe(2);
    expect(q.total).toBe(2);
  });

  it('is empty and inert for a student with no program', () => {
    const q = buildQueue(null, new Set());
    expect(q).toMatchObject({ upcoming: [], total: 0, completed: 0, position: 0 });
    expect(q.daysSinceLast).toBeNull();
  });

  describe('activity figures', () => {
    const now = new Date('2026-08-20T12:00:00Z');
    const at = (daysAgo) => {
      const d = new Date(now);
      d.setDate(d.getDate() - daysAgo);
      return d.toISOString();
    };

    it('measures staleness from the most recent REAL training date', () => {
      const weeks = [
        week('w-1', 1, [
          session('old', { day_number: 1, performed_at: at(12) }),
          session('recent', { day_number: 2, performed_at: at(3) }),
        ]),
      ];
      const q = buildQueue(weeks, new Set(['old', 'recent']), { now });
      expect(q.lastPerformedAt).toBe(at(3));
      expect(q.daysSinceLast).toBe(3);
    });

    it('counts only the last 7 days', () => {
      const weeks = [
        week('w-1', 1, [
          session('a', { day_number: 1, performed_at: at(1) }),
          session('b', { day_number: 2, performed_at: at(6) }),
          session('c', { day_number: 3, performed_at: at(9) }),
        ]),
      ];
      const q = buildQueue(weeks, new Set(['a', 'b', 'c']), { now });
      expect(q.doneLast7).toBe(2);
    });

    // Rows confirmed before performed_at existed carry no date. They must not
    // fabricate one — the figures degrade quietly instead.
    it('ignores confirmed sessions that carry no training date', () => {
      const weeks = [week('w-1', 1, [session('legacy')])];
      const q = buildQueue(weeks, new Set(['legacy']), { now });
      expect(q.completed).toBe(1);
      expect(q.lastPerformedAt).toBeNull();
      expect(q.daysSinceLast).toBeNull();
      expect(q.doneLast7).toBe(0);
    });

    it('does not count an unconfirmed session, even one carrying a date', () => {
      const weeks = [week('w-1', 1, [session('stray', { performed_at: at(1) })])];
      const q = buildQueue(weeks, new Set(), { now });
      expect(q.doneLast7).toBe(0);
      expect(q.upcoming).toHaveLength(1);
    });
  });
});

// Shared by the athlete's Home strip and the coach roster's per-athlete strip,
// so the two can never tell different stories about the same week.
describe('buildDayStrip', () => {
  // Mon 6 Jul 2026 – Sun 12 Jul 2026.
  const monday = parseISODate('2026-07-06');
  const strip = (args) => buildDayStrip({ confirmedIds: new Set(), monday, ...args });
  const stateOn = (slots, dayNumber) => slots[dayNumber - 1];

  it('places a session on the day it was actually trained, not the day it was planned', () => {
    const moved = session('moved', {
      day_number: 1,
      scheduled_date: '2026-07-06', // recommended Monday
      performed_at: '2026-07-09T18:00:00Z', // trained Thursday
    });
    const slots = strip({ sessions: [moved], upcoming: [] });
    expect(stateOn(slots, 4)).toMatchObject({ state: 'performed' });
    expect(stateOn(slots, 4).session.id).toBe('moved');
    // Monday is free again — the plan does not linger where nothing happened.
    expect(stateOn(slots, 1)).toMatchObject({ session: null, state: 'rest' });
  });

  it('never produces a missed state for a recommended day that has passed', () => {
    const skipped = session('skipped', { day_number: 1, scheduled_date: '2026-07-06' });
    const slots = strip({ sessions: [skipped], upcoming: [skipped] });
    expect(stateOn(slots, 1).state).toBe('planned');
    expect(slots.map((s) => s.state)).not.toContain('missed');
  });

  it('projects an undated queue head onto its recommended weekday', () => {
    const soon = session('soon', { day_number: 3 });
    const slots = strip({ sessions: [soon], upcoming: [soon] });
    expect(stateOn(slots, 3)).toMatchObject({ state: 'suggested' });
  });

  it('does not project recommendations onto a week the athlete is not in', () => {
    const soon = session('soon', { day_number: 3 });
    const slots = strip({ sessions: [soon], upcoming: [soon], weekdayFallback: false });
    expect(stateOn(slots, 3)).toMatchObject({ session: null, state: 'rest' });
  });

  it('lets the record win a contested day', () => {
    const done = session('done', { day_number: 4, performed_at: '2026-07-09T18:00:00Z' });
    const due = session('due', { day_number: 4, scheduled_date: '2026-07-09' });
    const slots = strip({ sessions: [done, due], upcoming: [due] });
    expect(stateOn(slots, 4).session.id).toBe('done');
    expect(stateOn(slots, 4).state).toBe('performed');
  });

  it('keeps a pulled session visible rather than blanking the day', () => {
    const pulled = session('pulled', { day_number: 2, archived_at: '2026-07-01T00:00:00Z' });
    const slots = strip({ sessions: [pulled], upcoming: [] });
    expect(stateOn(slots, 2)).toMatchObject({ state: 'archived' });
  });

  // Rows confirmed before performed_at existed carry no real date; the day they
  // were planned for is the closest honest answer rather than dropping them.
  it('falls back to the planned day for a legacy confirmation', () => {
    const legacy = session('legacy', { day_number: 2, scheduled_date: '2026-07-07' });
    const slots = strip({
      sessions: [legacy],
      upcoming: [],
      confirmedIds: new Set(['legacy']),
    });
    expect(stateOn(slots, 2)).toMatchObject({ state: 'performed' });
  });

  it('always returns seven slots numbered 1..7', () => {
    const slots = strip({ sessions: [], upcoming: [] });
    expect(slots.map((s) => s.dayNumber)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(slots.every((s) => s.state === 'rest')).toBe(true);
  });
});
