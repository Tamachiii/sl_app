// What the session screen works out from its reads, as pure functions: which
// set comes next, which exercise to show, what the editor of a set opens with,
// and how a set, a load and last time are written. The screen draws what these
// answer; the cases that went wrong on the screen (P59, P61, N5) are held here
// on the functions, and once more through the components in
// SessionExercise.test.jsx and SetSheet.test.jsx.
import { describe, it, expect } from 'vitest';
import { getMessage } from '../../lib/i18n';
import {
  actualText,
  capitalize,
  currentLogOf,
  deviationOf,
  editorSeeds,
  firstSlotToShow,
  isDurationBased,
  isLogResolved,
  lastTimeText,
  loadText,
  nextSlotToShow,
  restText,
  setOutcome,
  sharedRest,
  targetText,
  workText,
} from './sessionModel';

const ctx = { t: (key, params) => getMessage('en', key, params), lang: 'en' };

// Prescribed 8 × 100 kg, as the session read hands a set over.
const prescribed = (n, extra = {}) => ({
  id: `log-${n}`,
  exercise_slot_id: 'slot-1',
  set_number: n,
  target_reps: 8,
  target_weight_kg: 100,
  target_duration_seconds: null,
  target_rest_seconds: null,
  done: false,
  failed: false,
  skipped: false,
  rpe: null,
  actual_reps: null,
  actual_weight_kg: null,
  ...extra,
});

// An extra set: no target of its own.
const extra = (n, values = {}) =>
  prescribed(n, { is_student_added: true, target_reps: null, target_weight_kg: null, ...values });

describe('the outcome of a set', () => {
  it('a set is pending, done, failed or skipped — skipped first, then failed', () => {
    expect(setOutcome(prescribed(1))).toBe('pending');
    expect(setOutcome(prescribed(1, { done: true }))).toBe('done');
    expect(setOutcome(prescribed(1, { failed: true }))).toBe('failed');
    expect(setOutcome(prescribed(1, { skipped: true }))).toBe('skipped');
  });

  // The confirm sheet counts these: "10 of 12" for a session with every set
  // dealt with was the count of the done sets alone.
  it('a set needs no more attention once skipped, failed, rated, or under an exercise the athlete skipped', () => {
    const none = new Set();
    expect(isLogResolved(prescribed(1), none)).toBe(false);
    expect(isLogResolved(prescribed(1, { skipped: true }), none)).toBe(true);
    expect(isLogResolved(prescribed(1, { failed: true }), none)).toBe(true);
    expect(isLogResolved(prescribed(1, { done: true, rpe: 8 }), none)).toBe(true);
    // Done, not rated yet: the RPE is still to give.
    expect(isLogResolved(prescribed(1, { done: true }), none)).toBe(false);
    // Its sets are hidden, so they could never resolve otherwise.
    expect(isLogResolved(prescribed(1), new Set(['slot-1']))).toBe(true);
  });
});

describe('the set and the exercise to show', () => {
  it('the set in progress is the first one with no outcome, in set order', () => {
    const logs = [
      prescribed(1, { done: true }),
      prescribed(2, { failed: true }),
      prescribed(3, { skipped: true }),
      prescribed(4),
      prescribed(5),
    ];
    expect(currentLogOf(logs)?.id).toBe('log-4');
    expect(currentLogOf(logs.slice(0, 3))).toBeNull();
    expect(currentLogOf([])).toBeNull();
  });

  const slots = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const bySlot = (map) => (slotId) => map[slotId] ?? [];

  it('the screen opens on the first exercise with a set to do, an exercise skipped by the athlete passed over', () => {
    const logsOf = bySlot({
      a: [prescribed(1, { done: true })],
      b: [prescribed(1)],
      c: [prescribed(1)],
    });
    expect(firstSlotToShow(slots, logsOf, new Set())).toBe('b');
    expect(firstSlotToShow(slots, logsOf, new Set(['b']))).toBe('c');
  });

  it('with nothing left to do it opens on the first exercise, and on nothing without one', () => {
    const logsOf = bySlot({ a: [prescribed(1, { done: true })], b: [], c: [] });
    expect(firstSlotToShow(slots, logsOf, new Set())).toBe('a');
    expect(firstSlotToShow([], logsOf, new Set())).toBeNull();
  });

  it('after a set, an exercise with a set still to do stays on screen', () => {
    const logsOf = bySlot({ a: [prescribed(1, { done: true }), prescribed(2)], b: [prescribed(1)] });
    expect(nextSlotToShow('a', slots, logsOf, new Set())).toBe('a');
  });

  it('a finished exercise hands over to the next one with a set to do, wrapping round to the start', () => {
    const logsOf = bySlot({
      a: [prescribed(1)],
      b: [prescribed(1, { done: true })],
      c: [prescribed(1, { done: true })],
    });
    expect(nextSlotToShow('b', slots, logsOf, new Set())).toBe('a');
    expect(nextSlotToShow('c', slots, logsOf, new Set())).toBe('a');
    // An exercise the athlete skipped has no set to do.
    expect(nextSlotToShow('b', slots, logsOf, new Set(['a']))).toBeNull();
  });

  it('nothing left anywhere, or an exercise that is not in the session: nothing to show next', () => {
    const logsOf = bySlot({ a: [prescribed(1, { done: true })] });
    expect(nextSlotToShow('a', slots, logsOf, new Set())).toBeNull();
    expect(nextSlotToShow('z', slots, logsOf, new Set())).toBeNull();
  });

  describe('in a superset', () => {
    // A1 and A2 are done in turn; B comes after them.
    const superset = [
      { id: 'a1', superset_group: 'A' },
      { id: 'a2', superset_group: 'A' },
      { id: 'b', superset_group: null },
    ];

    it('the partner comes next, then back to the first: the two are done in turn', () => {
      const logsOf = bySlot({ a1: [prescribed(1)], a2: [prescribed(1)], b: [prescribed(1)] });
      expect(nextSlotToShow('a1', superset, logsOf, new Set())).toBe('a2');
      expect(nextSlotToShow('a2', superset, logsOf, new Set())).toBe('a1');
    });

    it('a partner that is finished, or skipped, leaves the exercise that still has sets on screen', () => {
      const finished = bySlot({ a1: [prescribed(1)], a2: [prescribed(1, { done: true })], b: [prescribed(1)] });
      expect(nextSlotToShow('a1', superset, finished, new Set())).toBe('a1');
      const open = bySlot({ a1: [prescribed(1)], a2: [prescribed(1)], b: [prescribed(1)] });
      expect(nextSlotToShow('a1', superset, open, new Set(['a2']))).toBe('a1');
    });

    it('once the pairing is finished, the next exercise of the session', () => {
      const logsOf = bySlot({
        a1: [prescribed(1, { done: true })],
        a2: [prescribed(1, { done: true })],
        b: [prescribed(1)],
      });
      expect(nextSlotToShow('a2', superset, logsOf, new Set())).toBe('b');
    });
  });
});

// N5. The header showed the rest only when every set of the exercise was the
// same, and no row showed one: Dips rested 3:00 after sets 1 to 3 and 2:00
// after 4 to 6 showed no rest anywhere.
describe('the prescribed rest of an exercise', () => {
  const rested = (n, seconds, more = {}) => prescribed(n, { target_rest_seconds: seconds, ...more });

  it('is one value when every set has the same, the loads differing or not', () => {
    expect(sharedRest([rested(1, 120), rested(2, 120), rested(3, 120)])).toBe(120);
    expect(sharedRest([rested(1, 120), rested(2, 120, { target_weight_kg: 90 })])).toBe(120);
    // A rest read as text is a number all the same.
    expect(sharedRest([rested(1, '90'), rested(2, 90)])).toBe(90);
  });

  it('is no value (each row says its own) when the sets are not rested alike', () => {
    expect(sharedRest([rested(1, 180), rested(2, 180), rested(4, 120), rested(5, 120)])).toBeUndefined();
    // A set without a rest among sets with one is a difference too.
    expect(sharedRest([rested(1, 180), rested(2, null), rested(3, 120)])).toBeUndefined();
  });

  it('is null when no set has one, and an extra set — which has no target — says nothing', () => {
    expect(sharedRest([rested(1, null), rested(2, null)])).toBeNull();
    expect(sharedRest([])).toBeNull();
    expect(sharedRest([rested(1, 120), extra(2)])).toBe(120);
  });
});

describe('the unit and the deviation of an exercise', () => {
  it('an exercise is held for a time when its first set with a target is, else by its own columns', () => {
    const hold = prescribed(1, { target_reps: null, target_duration_seconds: 45 });
    expect(isDurationBased({ duration_seconds: null }, [hold])).toBe(true);
    expect(isDurationBased({ duration_seconds: 45 }, [prescribed(1)])).toBe(false);
    // Extra sets alone say nothing: the slot does.
    expect(isDurationBased({ duration_seconds: 30 }, [extra(1)])).toBe(true);
    expect(isDurationBased({ duration_seconds: null }, [])).toBe(false);
  });

  it('a swap is another exercise in the slot; a skip, or a swap without its substitute, is not', () => {
    const slot = { id: 'slot-1' };
    const swap = { exercise_slot_id: 'slot-1', kind: 'swap', substitute_exercise_id: 'ex-dips' };
    expect(deviationOf(slot, [swap])).toEqual({ deviation: swap, skipped: false, swapped: true });

    const skip = { exercise_slot_id: 'slot-1', kind: 'skip', substitute_exercise_id: null };
    expect(deviationOf(slot, [skip])).toEqual({ deviation: skip, skipped: true, swapped: false });

    const half = { ...swap, substitute_exercise_id: null };
    expect(deviationOf(slot, [half]).swapped).toBe(false);

    expect(deviationOf(slot, [{ ...swap, exercise_slot_id: 'other' }])).toEqual({
      deviation: null,
      skipped: false,
      swapped: false,
    });
    expect(deviationOf(slot, undefined).deviation).toBeNull();
  });
});

describe('what the editor of a set opens with (editorSeeds)', () => {
  // P59. On a swapped exercise the rows' targets are the original's: never a
  // load to start from.
  describe('a swapped exercise', () => {
    it("each set opens on the substitute's last performance, set by set, the last of them beyond", () => {
      const seeds = editorSeeds([prescribed(1), prescribed(2), prescribed(3)], {
        swapped: true,
        lastPerf: { sets: [{ weight: 20, reps: 10 }, { weight: 22.5, reps: 8 }] },
      });
      expect(seeds.get('log-1')).toEqual({ reps: 10, weightKg: 20 });
      expect(seeds.get('log-2')).toEqual({ reps: 8, weightKg: 22.5 });
      expect(seeds.get('log-3')).toEqual({ reps: 8, weightKg: 22.5 });
    });

    it('done for the first time: the first set from the prescribed reps and no load, the next from what was logged before it', () => {
      const seeds = editorSeeds(
        [prescribed(1, { done: true, actual_reps: 12, actual_weight_kg: 0 }), prescribed(2)],
        { swapped: true, lastPerf: null },
      );
      expect(seeds.get('log-1')).toEqual({ reps: 8, weightKg: null });
      expect(seeds.get('log-2')).toEqual({ reps: 12, weightKg: 0 });
    });

    it('a last performance without sets is no last performance', () => {
      const seeds = editorSeeds([prescribed(1)], { swapped: true, lastPerf: { sets: [] } });
      expect(seeds.get('log-1')).toEqual({ reps: 8, weightKg: null });
    });
  });

  it('the exercise as the coach wrote it opens on its targets: its sets get no seed, its last time is not one', () => {
    const seeds = editorSeeds([prescribed(1), prescribed(2)], {
      swapped: false,
      lastPerf: { sets: [{ weight: 90, reps: 10 }] },
    });
    expect(seeds.size).toBe(0);
  });

  // P61. An extra set has no targets: it opens on the set before it, as that
  // set was done.
  describe('an extra set', () => {
    it('opens on the set before it: its targets when it was done as written', () => {
      const seeds = editorSeeds([prescribed(1, { done: true }), prescribed(2, { done: true }), extra(3)], {
        swapped: false,
      });
      expect(seeds.get('log-3')).toEqual({ reps: 8, weightKg: 100 });
    });

    it('its actual values when it was not, and an extra after an extra carries them on', () => {
      const seeds = editorSeeds(
        [
          prescribed(1, { done: true }),
          prescribed(2, { done: true, actual_reps: 6, actual_weight_kg: 95 }),
          extra(3),
          extra(4),
        ],
        { swapped: false },
      );
      expect(seeds.get('log-3')).toEqual({ reps: 6, weightKg: 95 });
      expect(seeds.get('log-4')).toEqual({ reps: 6, weightKg: 95 });
    });

    it('after a bodyweight set, the load it opens on is 0 — none added', () => {
      const seeds = editorSeeds([prescribed(1, { target_reps: 12, target_weight_kg: null }), extra(2)], {
        swapped: false,
      });
      expect(seeds.get('log-2')).toEqual({ reps: 12, weightKg: 0 });
    });

    it('on an exercise measured in seconds, it has no reps to start from', () => {
      const seeds = editorSeeds(
        [prescribed(1, { target_reps: null, target_duration_seconds: 45, target_weight_kg: 10 }), extra(2)],
        { swapped: false },
      );
      expect(seeds.get('log-2')).toEqual({ reps: null, weightKg: 10 });
    });

    it('a skipped set is not the set before it', () => {
      const seeds = editorSeeds(
        [prescribed(1, { done: true, actual_reps: 6, actual_weight_kg: 95 }), prescribed(2, { skipped: true }), extra(3)],
        { swapped: false },
      );
      expect(seeds.get('log-3')).toEqual({ reps: 6, weightKg: 95 });
    });

    it('first of all, it opens empty', () => {
      expect(editorSeeds([extra(1)], { swapped: false }).get('log-1')).toEqual({ reps: null, weightKg: null });
    });
  });
});

describe('how a set is written', () => {
  it('a load in kilograms, or bodyweight for none', () => {
    expect(loadText(20, ctx)).toBe('20 kg');
    expect(loadText('17.5', ctx)).toBe('17.5 kg');
    expect(loadText(0, ctx)).toBe('bodyweight');
    expect(loadText(null, ctx)).toBe('bodyweight');
  });

  it('reps and a load, a hold of seconds with its load when it has one, a load alone', () => {
    expect(workText({ reps: 5, seconds: null, weightKg: 20 }, ctx)).toBe('5 reps, 20 kg');
    expect(workText({ reps: 1, seconds: null, weightKg: null }, ctx)).toBe('1 rep, bodyweight');
    expect(workText({ reps: null, seconds: 30, weightKg: null }, ctx)).toBe('30 s hold');
    expect(workText({ reps: null, seconds: 30, weightKg: 10 }, ctx)).toBe('30 s hold, 10 kg');
    expect(workText({ reps: null, seconds: null, weightKg: 20 }, ctx)).toBe('20 kg');
    expect(workText({ reps: null, seconds: null, weightKg: null }, ctx)).toBe('Bodyweight');
  });

  it('the target of a set as the coach wrote it', () => {
    expect(targetText(prescribed(1, { target_reps: 5, target_weight_kg: 20 }), ctx)).toBe('5 reps, 20 kg');
    expect(targetText(prescribed(1, { target_reps: null, target_duration_seconds: 45, target_weight_kg: null }), ctx)).toBe(
      '45 s hold',
    );
  });

  it('what was done: the actual of each dimension, else its target', () => {
    const log = prescribed(1, { target_reps: 5, target_weight_kg: 20 });
    expect(actualText({ ...log, actual_reps: 3 }, ctx)).toBe('3 reps, 20 kg');
    expect(actualText({ ...log, actual_weight_kg: 22.5 }, ctx)).toBe('5 reps, 22.5 kg');
    expect(actualText({ ...log, actual_reps: 4, actual_weight_kg: 0 }, ctx)).toBe('4 reps, bodyweight');
    const hold = prescribed(1, { target_reps: null, target_duration_seconds: 30, target_weight_kg: null });
    expect(actualText({ ...hold, actual_weight_kg: 12.5 }, ctx)).toBe('30 s hold, 12.5 kg');
  });

  it('a rest as a clock', () => {
    expect(restText(90)).toBe('1:30');
    expect(restText('45')).toBe('0:45');
    expect(restText(180)).toBe('3:00');
  });

  it('a sentence starts with a capital', () => {
    expect(capitalize('yesterday')).toBe('Yesterday');
    expect(capitalize('')).toBe('');
    expect(capitalize(null)).toBeNull();
  });
});

describe('the line of last time', () => {
  // Midday local time, so that the days counted are the same in every zone.
  const now = new Date(2026, 9, 15, 12, 0, 0);
  const daysAgo = (n) => new Date(2026, 9, 15 - n, 18, 0, 0).toISOString();
  const five = (weight) => Array.from({ length: 5 }, () => ({ weight, reps: 5 }));

  it('says when, and the sets by groups of identical sets', () => {
    expect(lastTimeText({ performedAt: daysAgo(7), sets: five(17.5) }, ctx, now)).toBe('7 days ago, 5 × 5 at 17.5 kg.');
    expect(
      lastTimeText(
        { performedAt: daysAgo(1), sets: [{ weight: 20, reps: 10 }, { weight: 22.5, reps: 8 }, { weight: 22.5, reps: 8 }] },
        ctx,
        now,
      ),
    ).toBe('Yesterday, 10 at 20 kg, 2 × 8 at 22.5 kg.');
  });

  it('a set without a load is its reps alone', () => {
    expect(
      lastTimeText({ performedAt: daysAgo(0), sets: [{ weight: 0, reps: 12 }, { weight: 0, reps: 12 }] }, ctx, now),
    ).toBe('Today, 2 × 12.');
  });

  it('past four groups, the count of the others', () => {
    const sets = [10, 9, 8, 7, 6, 5].map((reps) => ({ weight: 20, reps }));
    expect(lastTimeText({ performedAt: daysAgo(2), sets }, ctx, now)).toBe(
      '2 days ago, 10 at 20 kg, 9 at 20 kg, 8 at 20 kg, 7 at 20 kg, +2.',
    );
  });

  it('without a date, the sets alone; without sets, nothing', () => {
    expect(lastTimeText({ performedAt: null, sets: five(17.5) }, ctx, now)).toBe('5 × 5 at 17.5 kg.');
    expect(lastTimeText({ performedAt: daysAgo(1), sets: [] }, ctx, now)).toBe('');
    expect(lastTimeText(null, ctx, now)).toBe('');
    expect(lastTimeText(undefined, ctx, now)).toBe('');
  });
});
