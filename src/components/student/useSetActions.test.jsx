// The writes of one set and what follows them, as the session screen calls
// them: the ActionBar's « Validate set n » (`markDone`), the long press of a
// row (`markFailed`), the sheets. The hooks of useSetLogs are doubles, and so
// are the rest timer's two entry points.
//
// The rest timer and the RPE follow what the athlete DOES — a gesture is a
// call here — and never what the set turns into: a change of `log` is a
// `rerender`, which is what a replayed write, a read or a rollback is to the
// screen. An effect on `log.done` restarted the rest and scheduled a rest push
// once per set when a workout logged offline was replayed (P56).
//
// The sheets that call the rest are tested on their own: SetSheet.test.jsx
// (values, ratings, skip, removal), RpeSheet.test.jsx, and
// SessionExercise.test.jsx for the long press.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { getToasts, dismissToast } from '../../lib/toast';

const mockToggleDone = { mutate: vi.fn() };
const mockSetFailed = { mutate: vi.fn() };
const mockSetRpe = { mutate: vi.fn() };
const mockLogActual = { mutate: vi.fn() };
const mockSetSkipped = { mutate: vi.fn() };
const idle = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });

vi.mock('../../hooks/useSetLogs', () => ({
  useToggleSetDone: () => mockToggleDone,
  useSetFailed: () => mockSetFailed,
  useSetRpe: () => mockSetRpe,
  useLogActual: () => mockLogActual,
  useSetSkipped: () => mockSetSkipped,
  useAddStudentSet: () => idle(),
  useRemoveStudentSet: () => idle(),
}));

vi.mock('../../hooks/useRestTimer', async () => {
  const actual = await vi.importActual('../../hooks/useRestTimer');
  return { ...actual, startRestTimer: vi.fn(), clearRestTimer: vi.fn() };
});

import { useSetActions, extraValuesComplete } from './useSetActions';
import { startRestTimer, clearRestTimer } from '../../hooks/useRestTimer';

const log = {
  id: 'log-1',
  exercise_slot_id: 'slot-1',
  set_number: 1,
  target_reps: 10,
  target_weight_kg: 80,
  target_rest_seconds: 90,
  done: false,
  failed: false,
  skipped: false,
  rpe: null,
  actual_reps: null,
  actual_weight_kg: null,
};

const extra = {
  ...log,
  id: 'log-4',
  set_number: 4,
  is_student_added: true,
  target_reps: null,
  target_weight_kg: null,
};

function renderActions(initial, exercise) {
  return renderHook(({ current }) => useSetActions(current, exercise), { initialProps: { current: initial } });
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const toast of getToasts()) dismissToast(toast.id);
});

describe('« Validate set n » (markDone)', () => {
  it('marks the set done, starts its rest, and asks for the RPE sheet', () => {
    const { result } = renderActions(log);

    let next;
    act(() => {
      next = result.current.markDone();
    });

    expect(next).toBe('rpe');
    expect(mockToggleDone.mutate).toHaveBeenCalledWith({ logId: 'log-1', done: true });
    expect(startRestTimer).toHaveBeenCalledTimes(1);
    expect(startRestTimer).toHaveBeenCalledWith('log-1', 90);
  });

  it('once per gesture: whatever the set turns into afterwards starts nothing', () => {
    const { result, rerender } = renderActions(log);
    act(() => {
      result.current.markDone();
    });

    // The optimistic validation, a read that comes back without it, the write
    // landing, a refresh.
    rerender({ current: { ...log, done: true } });
    rerender({ current: log });
    rerender({ current: { ...log, done: true } });
    rerender({ current: { ...log, done: true, logged_at: '2026-10-09T18:02:11+00:00' } });

    expect(startRestTimer).toHaveBeenCalledTimes(1);
    expect(clearRestTimer).not.toHaveBeenCalled();
  });

  it('a set that turns done, failed or back to do without a gesture starts and clears nothing', () => {
    const { rerender } = renderActions(log);
    rerender({ current: { ...log, done: true } });
    rerender({ current: log });
    rerender({ current: { ...log, failed: true } });
    rerender({ current: log });
    expect(startRestTimer).not.toHaveBeenCalled();
    expect(clearRestTimer).not.toHaveBeenCalled();
    expect(mockToggleDone.mutate).not.toHaveBeenCalled();
  });

  it('a set without a prescribed rest starts none', () => {
    const { result } = renderActions({ ...log, target_rest_seconds: null });
    act(() => {
      result.current.markDone();
    });
    expect(mockToggleDone.mutate).toHaveBeenCalledTimes(1);
    expect(startRestTimer).not.toHaveBeenCalled();
  });

  it('failed → done does not restart the rest: it is already running', () => {
    const { result } = renderActions({ ...log, failed: true });
    act(() => {
      result.current.markDone();
    });
    expect(mockToggleDone.mutate).toHaveBeenCalledWith({ logId: 'log-1', done: true });
    expect(startRestTimer).not.toHaveBeenCalled();
    expect(clearRestTimer).not.toHaveBeenCalled();
  });

  // P61. An extra set has no targets: validated as it was, it counted as a
  // set with no volume. Every gesture that would mark it done opens its sheet.
  it('an extra set that does not say what was done is not marked done: its sheet opens instead', () => {
    const { result } = renderActions(extra, { seedReps: 8, seedWeightKg: 100 });
    let next;
    act(() => {
      next = result.current.markDone();
    });

    expect(next).toBe('values');
    expect(result.current.extraIncomplete).toBe(true);
    expect(mockToggleDone.mutate).not.toHaveBeenCalled();
    expect(startRestTimer).not.toHaveBeenCalled();

    // Nor by a rating.
    act(() => {
      next = result.current.rate(8);
    });
    expect(next).toBe('values');
    expect(mockSetRpe.mutate).not.toHaveBeenCalled();
  });

  it('an extra set that says what was done is validated like any other', () => {
    const { result } = renderActions({ ...extra, actual_reps: 8, actual_weight_kg: 100 });
    let next;
    act(() => {
      next = result.current.markDone();
    });
    expect(next).toBe('rpe');
    expect(mockToggleDone.mutate).toHaveBeenCalledWith({ logId: 'log-4', done: true });
    expect(startRestTimer).toHaveBeenCalledWith('log-4', 90);
  });

  it('an extra set of an exercise held for a time says what was done with a load alone', () => {
    const { result } = renderActions({ ...extra, actual_weight_kg: 20 }, { durationBased: true });
    expect(result.current.repsApplies).toBe(false);
    expect(result.current.extraIncomplete).toBe(false);
    act(() => {
      result.current.markDone();
    });
    expect(mockToggleDone.mutate).toHaveBeenCalledTimes(1);
  });
});

describe('a set reaches every state', () => {
  it('validated, then failed by a long press, then not failed after all', () => {
    const { result, rerender } = renderActions(log);

    act(() => {
      result.current.markDone();
    });
    expect(mockToggleDone.mutate).toHaveBeenLastCalledWith({ logId: 'log-1', done: true });

    rerender({ current: { ...log, done: true } });
    act(() => {
      result.current.markFailed();
    });
    expect(mockSetFailed.mutate).toHaveBeenLastCalledWith({ logId: 'log-1', failed: true });

    rerender({ current: { ...log, failed: true } });
    act(() => {
      result.current.clearFailed();
    });
    expect(mockSetFailed.mutate).toHaveBeenLastCalledWith({ logId: 'log-1', failed: false });
    expect(clearRestTimer).toHaveBeenCalledWith('log-1');
    // One rest, the one of the validation.
    expect(startRestTimer).toHaveBeenCalledTimes(1);
  });

  it('a set that already failed, or was skipped, is not failed again', () => {
    const { result, rerender } = renderActions({ ...log, failed: true });
    act(() => {
      result.current.markFailed({ toast: 'Set 1 marked failed.' });
    });
    rerender({ current: { ...log, skipped: true } });
    act(() => {
      result.current.markFailed({ toast: 'Set 1 marked failed.' });
    });
    expect(mockSetFailed.mutate).not.toHaveBeenCalled();
    expect(getToasts()).toEqual([]);
  });
});

describe('what an extra set must say before it is done (extraValuesComplete)', () => {
  it('reps above 0 and a load, 0 being no load', () => {
    expect(extraValuesComplete({ reps: 8, weightKg: 100, durationBased: false })).toBe(true);
    expect(extraValuesComplete({ reps: 8, weightKg: 0, durationBased: false })).toBe(true);
    expect(extraValuesComplete({ reps: 0, weightKg: 20, durationBased: false })).toBe(false);
    expect(extraValuesComplete({ reps: null, weightKg: 20, durationBased: false })).toBe(false);
    expect(extraValuesComplete({ reps: 8, weightKg: null, durationBased: false })).toBe(false);
  });

  it('on an exercise held for a time, the load alone', () => {
    expect(extraValuesComplete({ reps: null, weightKg: 0, durationBased: true })).toBe(true);
    expect(extraValuesComplete({ reps: null, weightKg: null, durationBased: true })).toBe(false);
  });
});

it('no set, no actions', () => {
  const { result } = renderActions(null);
  expect(result.current).toBeNull();
});
