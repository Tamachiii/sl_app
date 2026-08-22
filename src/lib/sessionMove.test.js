import { describe, it, expect } from 'vitest';
import { planSessionDrag, phaseDropId } from './sessionMove';

// Two phases, each with an archived row so every case checks the thing that
// actually bites: `UNIQUE (week_id, sort_order)` covers archived sessions too,
// so any payload that forgets them renumbers straight into a collision.
function tree() {
  return [
    {
      id: 'w-1',
      sessions: [
        { id: 'a', sort_order: 0, archived_at: null },
        { id: 'b', sort_order: 1, archived_at: null },
        { id: 'c', sort_order: 2, archived_at: null },
        { id: 'a-old', sort_order: 3, archived_at: '2026-01-01' },
      ],
    },
    {
      id: 'w-2',
      sessions: [
        { id: 'x', sort_order: 0, archived_at: null },
        { id: 'y', sort_order: 1, archived_at: null },
        { id: 'x-old', sort_order: 2, archived_at: '2026-01-01' },
      ],
    },
  ];
}

describe('planSessionDrag', () => {
  describe('within one phase', () => {
    it('reorders and keeps archived rows trailing the payload', () => {
      const plan = planSessionDrag(tree(), 'c', 'a');
      expect(plan).toEqual({
        type: 'reorder',
        weekId: 'w-1',
        orderedIds: ['c', 'a', 'b', 'a-old'],
      });
    });

    it('moves downward as well as upward', () => {
      expect(planSessionDrag(tree(), 'a', 'c')).toEqual({
        type: 'reorder',
        weekId: 'w-1',
        orderedIds: ['b', 'c', 'a', 'a-old'],
      });
    });
  });

  describe('across a phase divider', () => {
    it('rehomes the session and renumbers BOTH phases', () => {
      const plan = planSessionDrag(tree(), 'b', 'y');
      expect(plan).toEqual({
        type: 'move',
        sessionId: 'b',
        destWeekId: 'w-2',
        // The source closes its gap...
        sourceIds: ['a', 'c', 'a-old'],
        // ...and the destination opens one at the row that was dropped on.
        destIds: ['x', 'b', 'y', 'x-old'],
      });
    });

    it('lands at the top when dropped on the divider itself', () => {
      const plan = planSessionDrag(tree(), 'a', phaseDropId('w-2'));
      expect(plan).toEqual({
        type: 'move',
        sessionId: 'a',
        destWeekId: 'w-2',
        sourceIds: ['b', 'c', 'a-old'],
        destIds: ['a', 'x', 'y', 'x-old'],
      });
    });

    // The only way to reach a phase with nothing in it to aim at.
    it('fills an empty phase', () => {
      const weeks = [tree()[0], { id: 'w-empty', sessions: [] }];
      expect(planSessionDrag(weeks, 'a', phaseDropId('w-empty'))).toEqual({
        type: 'move',
        sessionId: 'a',
        destWeekId: 'w-empty',
        sourceIds: ['b', 'c', 'a-old'],
        destIds: ['a'],
      });
    });
  });

  describe('refuses to produce a write', () => {
    it('for a drop on itself', () => {
      expect(planSessionDrag(tree(), 'a', 'a')).toBeNull();
    });

    it('for a drop back on the divider of its own phase', () => {
      // Index 0 of w-1 is already 'a' — a move that changes nothing.
      expect(planSessionDrag(tree(), 'a', phaseDropId('w-1'))).toBeNull();
    });

    it('for an unknown target', () => {
      expect(planSessionDrag(tree(), 'a', 'nope')).toBeNull();
      expect(planSessionDrag(tree(), 'a', phaseDropId('w-nope'))).toBeNull();
    });

    // An archived row is not in the list, so it can neither be dragged nor
    // dropped onto — its position is bookkeeping, not a place in the plan.
    it('for an archived source or target', () => {
      expect(planSessionDrag(tree(), 'a-old', 'b')).toBeNull();
      expect(planSessionDrag(tree(), 'a', 'a-old')).toBeNull();
    });

    it('for missing input', () => {
      expect(planSessionDrag(null, 'a', 'b')).toBeNull();
      expect(planSessionDrag(tree(), null, 'b')).toBeNull();
      expect(planSessionDrag(tree(), 'a', null)).toBeNull();
    });
  });

  // Positions are read through `compareSessions`, not array order, so a tree
  // that arrives out of order still plans correctly.
  it('reads position from sort_order, not the array', () => {
    const weeks = [{
      id: 'w-1',
      sessions: [
        { id: 'third', sort_order: 2, archived_at: null },
        { id: 'first', sort_order: 0, archived_at: null },
        { id: 'second', sort_order: 1, archived_at: null },
      ],
    }];
    expect(planSessionDrag(weeks, 'third', 'first')).toEqual({
      type: 'reorder',
      weekId: 'w-1',
      orderedIds: ['third', 'first', 'second'],
    });
  });
});
