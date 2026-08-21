import { describe, it, expect } from 'vitest';
import { flattenSessions, buildQueue } from './sessionQueue';

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
  it('walks weeks in program order and sessions by recommended weekday', () => {
    const weeks = [
      week('w-2', 2, [session('b1', { day_number: 5 }), session('b2', { day_number: 2 })]),
      week('w-1', 1, [session('a1', { day_number: 3 }), session('a2', { day_number: 1 })]),
    ];
    expect(flattenSessions(weeks).map((e) => e.session.id)).toEqual(['a2', 'a1', 'b2', 'b1']);
  });

  it('orders earlier programs first', () => {
    const past = { id: 'p-0', name: 'Old', sort_order: -1, is_active: false };
    const weeks = [
      week('w-1', 1, [session('now')]),
      { ...week('w-0', 1, [session('then')]), program: past },
    ];
    expect(flattenSessions(weeks).map((e) => e.session.id)).toEqual(['then', 'now']);
  });

  // compareSessions ranks by WEEKDAY, so two real dates in different calendar
  // weeks would otherwise invert — Monday the 13th ahead of Friday the 10th.
  it('orders two dated sessions chronologically, not by weekday', () => {
    const weeks = [
      week('w-1', 1, [
        session('mon-13', { day_number: 1, scheduled_date: '2026-07-13' }),
        session('fri-10', { day_number: 1, scheduled_date: '2026-07-10' }),
      ]),
    ];
    expect(flattenSessions(weeks).map((e) => e.session.id)).toEqual(['fri-10', 'mon-13']);
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
        session('sunday-one', { day_number: 7, scheduled_date: '2026-08-16' }),
        session('after', { day_number: 1, scheduled_date: '2026-08-17' }),
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
