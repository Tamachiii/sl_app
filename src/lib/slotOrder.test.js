import { describe, it, expect } from 'vitest';
import { planSlotDrag } from './slotOrder';
import { groupSlotsBySuperset } from './volume';

// A session's slots, written as a string: a letter per slot, a lower-case
// group after it ("Ag Bg C" = A and B in superset g, then C on its own).
function slotsOf(spec) {
  return spec.split(' ').map((token, i) => ({
    id: token[0],
    sort_order: i,
    superset_group: token[1] ?? null,
  }));
}

// The plan applied, written back the same way.
function after(spec, activeId, overId) {
  const slots = slotsOf(spec);
  const plan = planSlotDrag(slots, activeId, overId);
  if (!plan) return null;
  const byId = new Map(slots.map((s) => [s.id, { ...s }]));
  for (const c of plan.changes) Object.assign(byId.get(c.id), c);
  return plan.orderedIds.map((id) => `${id}${byId.get(id).superset_group ?? ''}`).join(' ');
}

// What the editor draws: every group one box, of two slots or more.
function expectOneRunPerGroup(order) {
  const groups = groupSlotsBySuperset(order.map((s) => ({ ...s })));
  const keys = groups.filter((g) => g.slots[0].superset_group).map((g) => g.key);
  expect(new Set(keys).size).toBe(keys.length);
  for (const g of groups) {
    if (g.slots[0].superset_group) expect(g.slots.length).toBeGreaterThan(1);
  }
}

describe('planSlotDrag', () => {
  it('moves a slot and renumbers 0 to n-1', () => {
    expect(after('A B C', 'C', 'A')).toBe('C A B');
    expect(after('A B C', 'A', 'C')).toBe('B C A');
  });

  it('writes only the slots that change', () => {
    const plan = planSlotDrag(slotsOf('A B C D'), 'B', 'C');
    expect(plan.orderedIds).toEqual(['A', 'C', 'B', 'D']);
    expect(plan.changes).toEqual([
      { id: 'C', sort_order: 1, superset_group: null },
      { id: 'B', sort_order: 2, superset_group: null },
    ]);
  });

  it('renumbers tied or gapped sort orders it meets', () => {
    const slots = [
      { id: 'A', sort_order: 0, superset_group: null },
      { id: 'B', sort_order: 0, superset_group: null },
      { id: 'C', sort_order: 5, superset_group: null },
    ];
    const plan = planSlotDrag(slots, 'C', 'B');
    expect(plan.orderedIds).toEqual(['A', 'C', 'B']);
    expect(plan.changes.map((c) => [c.id, c.sort_order])).toEqual([['C', 1], ['B', 2]]);
  });

  it('is null for a drop on itself, on nothing, or of a slot it does not know', () => {
    expect(planSlotDrag(slotsOf('A B'), 'A', 'A')).toBeNull();
    expect(planSlotDrag(slotsOf('A B'), 'A', null)).toBeNull();
    expect(planSlotDrag(slotsOf('A B'), 'Z', 'A')).toBeNull();
    expect(planSlotDrag(slotsOf('A B'), 'A', 'Z')).toBeNull();
    expect(planSlotDrag(undefined, 'A', 'B')).toBeNull();
  });

  describe('supersets', () => {
    it('a slot dropped between two members joins their superset', () => {
      expect(after('X Ag Bg', 'X', 'A')).toBe('Ag Xg Bg');
      expect(after('Ag Bg Cg X', 'X', 'B')).toBe('Ag Xg Bg Cg');
    });

    it('a slot dropped beside a superset, not inside it, stays on its own', () => {
      expect(after('Ag Bg X', 'X', 'A')).toBe('X Ag Bg');
      expect(after('X Ag Bg Y', 'Y', 'A')).toBe('X Y Ag Bg');
    });

    it('a member moved inside its superset stays in it', () => {
      expect(after('Ag Bg Cg', 'A', 'B')).toBe('Bg Ag Cg');
      expect(after('Ag Bg Cg', 'C', 'A')).toBe('Cg Ag Bg');
    });

    it('a member dragged out leaves its superset', () => {
      expect(after('Ag Bg Cg X', 'A', 'X')).toBe('Bg Cg X A');
    });

    it('a superset left with one slot is no superset', () => {
      expect(after('X Ag Bg', 'A', 'X')).toBe('A X B');
      expect(after('Ag Bg X Y', 'B', 'Y')).toBe('A X Y B');
    });

    it('a member moved into another superset joins that one', () => {
      expect(after('Ag Bg Cg Dh Eh', 'A', 'D')).toBe('Bg Cg Dh Ah Eh');
      // Dropped past the last member, it is outside: on its own, and the
      // superset it left, with one slot, is none.
      expect(after('Ag Bg Ch Dh', 'A', 'D')).toBe('B Ch Dh A');
    });

    it('never splits a superset: every group is one run of two or more', () => {
      const specs = ['Ag Bg C D', 'A Bg Cg D', 'Ag Bg Ch Dh E', 'A Bg Cg Dg E', 'Ag Bg Cg Dh Eh F'];
      for (const spec of specs) {
        const slots = slotsOf(spec);
        for (const a of slots) {
          for (const o of slots) {
            const plan = planSlotDrag(slots, a.id, o.id);
            if (!plan) continue;
            const byId = new Map(slots.map((s) => [s.id, { ...s }]));
            for (const c of plan.changes) Object.assign(byId.get(c.id), c);
            expectOneRunPerGroup(plan.orderedIds.map((id) => byId.get(id)));
          }
        }
      }
    });

    // Written before these rules: one group in two places, a group of one.
    it('mends a group found in two runs, and a group of one, on the next drag', () => {
      const plan = planSlotDrag(slotsOf('Ag Bg X Cg Dg Eh Y'), 'Y', 'X');
      const order = Object.fromEntries(plan.changes.map((c) => [c.id, c.superset_group]));
      // The first run keeps the id; the second takes its first slot's id.
      expect(order.A).toBeUndefined();
      expect(order.C).toBe('C');
      expect(order.D).toBe('C');
      // E was a superset of one.
      expect(order.E).toBeNull();
    });
  });
});
