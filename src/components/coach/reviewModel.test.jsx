import { describe, it, expect } from 'vitest';
import { getMessage } from '../../lib/i18n';
import { reviewTotals, rpeText, setRows } from './reviewModel';

// What the coach's review says of a session (design/parc/screens/
// Revue.dc.html), as data: the figures at the top and the rows of each
// exercise. It took over from SlotProgress, whose rules stay — live finding
// N12: a set the athlete added counted as one of the planned sets, "3/3 done"
// when one of the three prescribed sets was never done.

const ctxIn = (lang) => ({ lang, t: (key, params) => getMessage(lang, key, params) });
const en = ctxIn('en');
const fr = ctxIn('fr');

// A prescribed set of 5 reps at 100 kg, not done yet.
const set = (set_number, overrides = {}) => ({
  id: `log-${set_number}`,
  exercise_slot_id: 'sl-1',
  set_number,
  target_reps: 5,
  target_duration_seconds: null,
  target_weight_kg: 100,
  target_rest_seconds: 120,
  actual_reps: null,
  actual_weight_kg: null,
  done: false,
  failed: false,
  skipped: false,
  rpe: null,
  is_student_added: false,
  ...overrides,
});
// A set the athlete added: no target, what was done in its actuals.
const extra = (set_number, overrides = {}) =>
  set(set_number, {
    target_reps: null,
    target_weight_kg: null,
    target_rest_seconds: null,
    is_student_added: true,
    ...overrides,
  });

const slots = [{ id: 'sl-1', sets: 3 }];

// What a row says, as it is read: its title, its caption, its RPE.
const said = (rows) => rows.map(({ kind, title, caption, rpe }) => ({ kind, title, caption, rpe }));

describe('reviewTotals', () => {
  it('says nothing was done before a set is logged', () => {
    expect(reviewTotals({ slots, logs: [], deviations: [] })).toEqual({
      planned: 3,
      done: 0,
      extra: 0,
      avgRpe: null,
      changes: 0,
    });
    expect(reviewTotals({ slots, logs: undefined, deviations: undefined }).done).toBe(0);
  });

  it('counts the plan across the exercises', () => {
    expect(reviewTotals({ slots: [{ id: 'sl-1', sets: 3 }, { id: 'sl-2', sets: '2' }], logs: [] }).planned).toBe(5);
  });

  it('counts the prescribed sets against the plan, and the extra ones apart', () => {
    const totals = reviewTotals({
      slots,
      logs: [
        set(1, { done: true, rpe: 8 }),
        set(2, { done: true, rpe: 9 }),
        set(3),
        extra(4, { done: true, rpe: 9, actual_reps: 6, actual_weight_kg: 100 }),
      ],
      deviations: [],
    });
    // "2 of 3", never "3 of 3": the added set is not the one left undone.
    expect(totals.done).toBe(2);
    expect(totals.planned).toBe(3);
    expect(totals.extra).toBe(1);
  });

  it('has no extra when the added sets are not done', () => {
    const totals = reviewTotals({
      slots: [{ id: 'sl-1', sets: 2 }],
      logs: [set(1, { done: true }), set(2, { done: true }), extra(3)],
      deviations: [],
    });
    expect(totals.done).toBe(2);
    expect(totals.extra).toBe(0);
  });

  it('leaves failed and skipped sets out of the sets done, extras included', () => {
    const totals = reviewTotals({
      slots: [{ id: 'sl-1', sets: 2 }],
      logs: [set(1, { failed: true }), set(2, { skipped: true }), extra(3, { failed: true })],
      deviations: [],
    });
    expect(totals.done).toBe(0);
    expect(totals.extra).toBe(0);
  });

  it('averages the RPE of the sets done, added ones included', () => {
    const totals = reviewTotals({
      slots,
      logs: [
        set(1, { done: true, rpe: 8 }),
        set(2, { done: true, rpe: '9' }),
        set(3, { done: true }),
        extra(4, { done: true, rpe: 7, actual_reps: 5, actual_weight_kg: 100 }),
      ],
      deviations: [],
    });
    expect(totals.avgRpe).toBe(8);
  });

  it('has no average RPE when no set done carries one', () => {
    const totals = reviewTotals({ slots, logs: [set(1, { done: true }), set(2, { failed: true })], deviations: [] });
    expect(totals.avgRpe).toBeNull();
  });

  describe('the changes to the plan', () => {
    it('counts an exercise swapped or skipped once', () => {
      const totals = reviewTotals({
        slots: [{ id: 'sl-1', sets: 3 }, { id: 'sl-2', sets: 3 }],
        logs: [],
        deviations: [
          { exercise_slot_id: 'sl-1', kind: 'swap', substitute_exercise_id: 'ex-sub' },
          { exercise_slot_id: 'sl-2', kind: 'skip', substitute_exercise_id: null },
        ],
      });
      expect(totals.changes).toBe(2);
    });

    it('counts each set done with other values, and each set added', () => {
      const totals = reviewTotals({
        slots,
        logs: [
          set(1, { done: true }),
          set(2, { done: true, actual_weight_kg: 105 }),
          set(3, { done: true, actual_reps: 4 }),
          extra(4, { done: true, actual_reps: 5, actual_weight_kg: 100 }),
        ],
        deviations: [],
      });
      expect(totals.changes).toBe(3);
    });

    // The sets of a swapped exercise are the swap, not more changes.
    it('counts a swapped exercise once, whatever its sets say', () => {
      const totals = reviewTotals({
        slots,
        logs: [
          set(1, { done: true, actual_reps: 8, actual_weight_kg: 0 }),
          set(2, { done: true, actual_reps: 8, actual_weight_kg: 0 }),
          set(3, { done: true, actual_reps: 7, actual_weight_kg: 0 }),
        ],
        deviations: [{ exercise_slot_id: 'sl-1', kind: 'swap', substitute_exercise_id: 'ex-sub' }],
      });
      expect(totals.changes).toBe(1);
    });

    // The figure counts what the review draws in amber: a swap, a skip, a set
    // off plan, a set added. A failed set is drawn in red and says how far it
    // went (« 2 of 3 reps »); it did not leave the plan, it fell short of it.
    // design/parc/screens/Revue.dc.html counts « 2 écarts au plan » beside a
    // « Série 4, ratée, 2 répétitions sur 3 »: the heavier set and the swap.
    it('does not count a failed set that says how far it went', () => {
      const totals = reviewTotals({
        slots,
        logs: [set(1, { done: true }), set(2, { done: true }), set(3, { failed: true, actual_reps: 2 })],
        deviations: [],
      });
      expect(totals.changes).toBe(0);
    });
  });
});

describe('rpeText', () => {
  it('says nothing without an RPE', () => {
    expect(rpeText([], en)).toBeNull();
  });

  it('says one RPE, or the range of several', () => {
    expect(rpeText([8], en)).toBe('RPE 8');
    expect(rpeText([7.5, 7.5], en)).toBe('RPE 7.5');
    expect(rpeText([9, 7, 8], en)).toBe('RPE 7 to 9');
    expect(rpeText([8, 7.5], fr)).toBe('RPE 7,5 à 8');
  });
});

describe('setRows', () => {
  it('has no row before a set is logged', () => {
    expect(setRows([], en)).toEqual([]);
    expect(setRows(undefined, en)).toEqual([]);
  });

  describe('the sets done as planned', () => {
    it('are one row per target, with the range of their RPE', () => {
      const rows = setRows(
        [set(1, { done: true, rpe: 7 }), set(2, { done: true, rpe: 8 }), set(3, { done: true, rpe: 7.5 })],
        en,
      );
      expect(said(rows)).toEqual([
        { kind: 'done', title: 'Sets 1 to 3', caption: 'As planned, 5 reps, 100\u00a0kg', rpe: 'RPE 7 to 8' },
      ]);
      expect(rows[0].numbers).toEqual([1, 2, 3]);
      expect(rows[0].key).toBe('log-1');
    });

    it('name two sets, or sets apart, one by one', () => {
      expect(setRows([set(1, { done: true }), set(2, { done: true })], en)[0].title).toBe('Sets 1 and 2');
      const rows = setRows(
        [set(1, { done: true }), set(2, { done: true }), set(3, { done: true, actual_weight_kg: 105 }), set(4, { done: true })],
        en,
      );
      expect(rows.map((row) => row.title)).toEqual(['Sets 1, 2, and 4', 'Set 3, off plan']);
    });

    it('name one set alone', () => {
      const rows = setRows([set(4, { done: true })], en);
      expect(said(rows)).toEqual([{ kind: 'done', title: 'Set 4', caption: 'As planned, 5 reps, 100\u00a0kg', rpe: null }]);
    });

    it('split where the target changes', () => {
      const rows = setRows(
        [set(1, { done: true }), set(2, { done: true }), set(3, { done: true, target_reps: 3, target_weight_kg: 110 })],
        en,
      );
      expect(said(rows)).toEqual([
        { kind: 'done', title: 'Sets 1 and 2', caption: 'As planned, 5 reps, 100\u00a0kg', rpe: null },
        { kind: 'done', title: 'Set 3', caption: 'As planned, 3 reps, 110\u00a0kg', rpe: null },
      ]);
    });

    it('are said in the app’s language', () => {
      const logs = [1, 2, 3, 5].map((n) => set(n, { done: true, rpe: n === 5 ? 8 : 7.5, target_weight_kg: 32.5 }));
      const rows = setRows([...logs, set(4, { done: true, actual_weight_kg: 35 })], fr);
      expect(rows.map((row) => row.title)).toEqual(['Séries 1, 2, 3 et 5', 'Série 4, hors plan']);
      expect(rows[0].caption).toBe('Comme prévu, 5 répétitions, 32,5\u00a0kg');
      expect(rows[0].rpe).toBe('RPE 7,5 à 8');
      expect(setRows(logs.slice(0, 3), fr)[0].title).toBe('Séries 1 à 3');
    });
  });

  it('says a set done off plan with what was done, the plan being above', () => {
    const rows = setRows([set(1, { done: true, rpe: 8 }), set(2, { done: true, rpe: 9, actual_weight_kg: 105 })], en);
    expect(said(rows)[1]).toEqual({ kind: 'offPlan', title: 'Set 2, off plan', caption: 'Off plan, 5 reps, 105\u00a0kg', rpe: 'RPE 9' });
  });

  describe('a failed set', () => {
    it('says how far it went', () => {
      const rows = setRows([set(1, { done: true }), set(2, { failed: true, target_reps: 3, actual_reps: 2 })], en);
      expect(said(rows)[1]).toEqual({ kind: 'failed', title: 'Set 2, failed', caption: '2 of 3 reps', rpe: null });
      expect(setRows([set(2, { failed: true, target_reps: 3, actual_reps: 1 })], en)[0].caption).toBe('1 of 3 reps');
    });

    it('says what was planned when it says nothing more', () => {
      expect(setRows([set(2, { failed: true })], en)[0].caption).toBe('Planned 5 reps, 100\u00a0kg');
    });

    it('says the load it was tried at', () => {
      expect(setRows([set(2, { failed: true, actual_weight_kg: 110 })], en)[0].caption).toBe('5 reps, 110\u00a0kg');
    });
  });

  // SlotProgress counted failed and skipped sets over every set, extras
  // included: each is a row of its own here.
  it('gives every failed and skipped set a row of its own, extras included', () => {
    const rows = setRows([set(1, { failed: true }), set(2, { skipped: true }), extra(3, { failed: true })], en);
    expect(rows.map(({ kind, title }) => ({ kind, title }))).toEqual([
      { kind: 'failed', title: 'Set 1, failed' },
      { kind: 'skipped', title: 'Set 2, skipped' },
      { kind: 'failed', title: 'Set 3, failed' },
    ]);
    expect(rows[1].caption).toBe('Planned 5 reps, 100\u00a0kg');
  });

  it('says a set not done with what was planned', () => {
    const rows = setRows([set(1, { done: true }), set(2)], en);
    expect(said(rows)[1]).toEqual({ kind: 'notDone', title: 'Set 2, not done', caption: 'Planned 5 reps, 100\u00a0kg', rpe: null });
  });

  describe('a set the athlete added', () => {
    it('says what was done, and is never held against a target', () => {
      const rows = setRows(
        [set(1, { done: true }), set(2, { done: true }), extra(3, { done: true, rpe: 9, actual_reps: 5, actual_weight_kg: 100 })],
        en,
      );
      // The same values as the planned sets, and still not one of them.
      expect(said(rows)).toEqual([
        { kind: 'done', title: 'Sets 1 and 2', caption: 'As planned, 5 reps, 100\u00a0kg', rpe: null },
        { kind: 'added', title: 'Set 3, added', caption: '5 reps, 100\u00a0kg', rpe: 'RPE 9' },
      ]);
    });

    it('says nothing was planned when it is skipped', () => {
      const [row] = setRows([extra(3, { skipped: true })], en);
      expect(row).toMatchObject({ kind: 'skipped', title: 'Set 3, skipped', caption: null });
    });
  });

  it('says the sets of a swapped exercise with their values', () => {
    const swapped = (n, reps) => set(n, { done: true, rpe: 8, actual_reps: reps, actual_weight_kg: 0 });
    const rows = setRows([swapped(1, 8), swapped(2, 8), swapped(3, 7)], en, { swapped: true });
    // What was done on the substitute: never "as planned", never "off plan".
    expect(said(rows)).toEqual([
      { kind: 'done', title: 'Sets 1 and 2', caption: '8 reps, bodyweight', rpe: 'RPE 8' },
      { kind: 'done', title: 'Set 3', caption: '7 reps, bodyweight', rpe: 'RPE 8' },
    ]);
  });

  it('puts the rows in the order of their first set', () => {
    const rows = setRows(
      [set(4, { done: true }), extra(5, { done: true, actual_reps: 3, actual_weight_kg: 100 }), set(2, { failed: true }), set(1, { done: true }), set(3, { skipped: true })],
      en,
    );
    expect(rows.map((row) => row.title)).toEqual(['Sets 1 and 4', 'Set 2, failed', 'Set 3, skipped', 'Set 5, added']);
  });
});
