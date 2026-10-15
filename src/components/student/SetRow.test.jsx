import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockToggleDone = { mutate: vi.fn() };
const mockSetFailed = { mutate: vi.fn() };
const mockSetRpe = { mutate: vi.fn() };
const mockLogActual = { mutate: vi.fn() };
const mockSetSkipped = { mutate: vi.fn() };
const mockRemoveStudentSet = { mutate: vi.fn(), isPending: false };

vi.mock('../../hooks/useSetLogs', () => ({
  useToggleSetDone: () => mockToggleDone,
  useSetFailed: () => mockSetFailed,
  useSetRpe: () => mockSetRpe,
  useLogActual: () => mockLogActual,
  useSetSkipped: () => mockSetSkipped,
  useRemoveStudentSet: () => mockRemoveStudentSet,
}));

vi.mock('../../hooks/useOnlineStatus', () => ({
  useOnlineStatus: () => true,
}));

vi.mock('../../hooks/useRestTimer', async () => {
  const actual = await vi.importActual('../../hooks/useRestTimer');
  return {
    ...actual,
    startRestTimer: vi.fn(),
    clearRestTimer: vi.fn(),
  };
});

import SetRow from './SetRow';
import { resetRestTimer, startRestTimer, clearRestTimer } from '../../hooks/useRestTimer';

const baseLog = {
  id: 'log-1',
  set_number: 1,
  done: false,
  failed: false,
  rpe: null,
  exercise_slot_id: 'slot-1',
};

function renderSetRow(log = baseLog, props = {}) {
  return render(<SetRow log={log} {...props} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetRestTimer();
});

describe('SetRow', () => {
  it('renders the set number on the indicator button', () => {
    renderSetRow();
    // Indicator shows the set number while pending; after done/failed it
    // swaps to a check/✕ icon. Row position covers the rest.
    const indicator = screen.getByRole('button', { name: /mark set done/i });
    expect(indicator).toHaveTextContent('1');
  });

  it('tap on indicator marks pending → done', async () => {
    const user = userEvent.setup();
    renderSetRow();

    const indicator = screen.getByRole('button', { name: /mark set done/i });
    await user.click(indicator);
    expect(mockToggleDone.mutate).toHaveBeenCalledWith({ logId: 'log-1', done: true });
  });

  it('tap on indicator advances done → failed', async () => {
    const user = userEvent.setup();
    renderSetRow({ ...baseLog, done: true });

    const indicator = screen.getByRole('button', { name: /mark set failed/i });
    await user.click(indicator);
    expect(mockSetFailed.mutate).toHaveBeenCalledWith({ logId: 'log-1', failed: true });
    expect(mockToggleDone.mutate).not.toHaveBeenCalled();
  });

  it('tap on indicator clears failed → pending', async () => {
    const user = userEvent.setup();
    renderSetRow({ ...baseLog, failed: true });

    const indicator = screen.getByRole('button', { name: /clear failed/i });
    await user.click(indicator);
    expect(mockSetFailed.mutate).toHaveBeenCalledWith({ logId: 'log-1', failed: false });
  });

  it('tap cycles neutral → done → failed → neutral over successive renders', async () => {
    const user = userEvent.setup();

    const { rerender } = render(<SetRow log={baseLog} />);
    await user.click(screen.getByRole('button', { name: /mark set done/i }));
    expect(mockToggleDone.mutate).toHaveBeenLastCalledWith({ logId: 'log-1', done: true });

    rerender(<SetRow log={{ ...baseLog, done: true }} />);
    await user.click(screen.getByRole('button', { name: /mark set failed/i }));
    expect(mockSetFailed.mutate).toHaveBeenLastCalledWith({ logId: 'log-1', failed: true });

    rerender(<SetRow log={{ ...baseLog, failed: true }} />);
    await user.click(screen.getByRole('button', { name: /clear failed/i }));
    expect(mockSetFailed.mutate).toHaveBeenLastCalledWith({ logId: 'log-1', failed: false });
  });

  it('renders RPE buttons', () => {
    renderSetRow();
    expect(screen.getByText('RPE')).toBeInTheDocument();
  });

  it('disables RPE button when set is failed', () => {
    renderSetRow({ ...baseLog, failed: true });
    const rpeBtn = screen.getByRole('button', { name: /rpe disabled/i });
    expect(rpeBtn).toBeDisabled();
  });

  // Touch swipes — jsdom doesn't simulate gestures, so we drive the
  // touch lifecycle directly via fireEvent.
  function swipe(row, dx) {
    fireEvent.touchStart(row, { touches: [{ clientX: 0, clientY: 0 }] });
    fireEvent.touchMove(row, { touches: [{ clientX: dx, clientY: 0 }] });
    fireEvent.touchEnd(row);
  }

  function rowFor(indicatorPattern) {
    return screen
      .getByRole('button', { name: indicatorPattern })
      .closest('div.relative.rounded-xl, div.rounded-xl');
  }

  it('right-to-left swipe past threshold marks set done', () => {
    renderSetRow();
    swipe(rowFor(/mark set done/i), -80);
    expect(mockToggleDone.mutate).toHaveBeenCalledWith({ logId: 'log-1', done: true });
    expect(mockSetFailed.mutate).not.toHaveBeenCalled();
  });

  it('left-to-right swipe past threshold marks set failed', () => {
    renderSetRow();
    swipe(rowFor(/mark set done/i), 80);
    expect(mockSetFailed.mutate).toHaveBeenCalledWith({ logId: 'log-1', failed: true });
    expect(mockToggleDone.mutate).not.toHaveBeenCalled();
  });

  it('swipe under threshold does not commit', () => {
    renderSetRow();
    swipe(rowFor(/mark set done/i), -30);
    expect(mockToggleDone.mutate).not.toHaveBeenCalled();
    expect(mockSetFailed.mutate).not.toHaveBeenCalled();
  });

  it('swipe is suppressed when locked', () => {
    renderSetRow(baseLog, { locked: true });
    swipe(rowFor(/mark set done/i), -80);
    expect(mockToggleDone.mutate).not.toHaveBeenCalled();
  });

  it('swipe-right on already-failed set is a no-op (no redundant write)', () => {
    renderSetRow({ ...baseLog, failed: true });
    swipe(rowFor(/clear failed/i), 80);
    expect(mockSetFailed.mutate).not.toHaveBeenCalled();
  });

  // The RPE selector and the rest timer follow what the athlete DOES on the
  // row — a tap, a swipe — and never what the row turns into. The hooks are
  // mocked here, so a gesture changes nothing of `log`; a change of `log` is a
  // `rerender`, which is what a replayed write, a read or a rollback is to the
  // row. RpeInput is identifiable by its 1..10 grid.
  const rpeGrid = () => screen.queryByRole('button', { name: /^RPE 5$/i });

  describe('the RPE selector opens on the gesture that marks the set done', () => {
    it('a tap on a pending set opens it', async () => {
      const user = userEvent.setup();
      renderSetRow();
      expect(rpeGrid()).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /mark set done/i }));

      expect(rpeGrid()).toBeInTheDocument();
    });

    it('so does a swipe to done', () => {
      renderSetRow();
      swipe(rowFor(/mark set done/i), -80);
      expect(rpeGrid()).toBeInTheDocument();
    });

    it('and a swipe from failed to done, once the row shows it', () => {
      const { rerender } = render(<SetRow log={{ ...baseLog, failed: true }} />);
      swipe(rowFor(/clear failed/i), -80);
      // Still shown as failed until the write is: RPE is locked there.
      expect(rpeGrid()).not.toBeInTheDocument();

      rerender(<SetRow log={{ ...baseLog, done: true }} />);

      expect(rpeGrid()).toBeInTheDocument();
    });

    it('marking the set failed opens nothing: RPE is locked there', () => {
      renderSetRow();
      swipe(rowFor(/mark set done/i), 80);
      expect(mockSetFailed.mutate).toHaveBeenCalledTimes(1);
      expect(rpeGrid()).not.toBeInTheDocument();
    });

    it('a set that turns done without a gesture opens nothing', () => {
      const { rerender } = render(<SetRow log={baseLog} />);
      rerender(<SetRow log={{ ...baseLog, done: true }} />);
      expect(rpeGrid()).not.toBeInTheDocument();
    });

    it('closes once a value is selected', async () => {
      const user = userEvent.setup();
      const { rerender } = render(<SetRow log={baseLog} />);
      await user.click(screen.getByRole('button', { name: /mark set done/i }));
      // The tick on screen, as the optimistic cache shows it before the rating.
      rerender(<SetRow log={{ ...baseLog, done: true }} />);

      await user.click(screen.getByRole('button', { name: /^RPE 7$/i }));

      expect(mockSetRpe.mutate).toHaveBeenCalledWith({ logId: 'log-1', rpe: 7 });
      // After selection the panel closes — the inner RpeInput grid is gone.
      expect(rpeGrid()).not.toBeInTheDocument();
    });

    it('and stays closed when the row is read again: a tick that leaves the screen and comes back', async () => {
      const user = userEvent.setup();
      const { rerender } = render(<SetRow log={baseLog} />);
      await user.click(screen.getByRole('button', { name: /mark set done/i }));
      rerender(<SetRow log={{ ...baseLog, done: true }} />);
      await user.click(screen.getByRole('button', { name: /^RPE 7$/i }));
      rerender(<SetRow log={{ ...baseLog, done: true, rpe: 7 }} />);
      expect(rpeGrid()).not.toBeInTheDocument();

      // A read that was sent before the tick reached the database, then the
      // tick landing: pending again, then done again.
      rerender(<SetRow log={baseLog} />);
      rerender(<SetRow log={{ ...baseLog, done: true, rpe: 7 }} />);

      expect(rpeGrid()).not.toBeInTheDocument();
    });
  });

  describe('the rest timer starts and stops on the gesture', () => {
    const log = { ...baseLog, target_rest_seconds: 90 };

    it('a tap that marks a pending set done starts the rest of that set', async () => {
      const user = userEvent.setup();
      renderSetRow(log);
      expect(startRestTimer).not.toHaveBeenCalled();

      await user.click(screen.getByRole('button', { name: /mark set done/i }));

      expect(startRestTimer).toHaveBeenCalledTimes(1);
      expect(startRestTimer).toHaveBeenCalledWith('log-1', 90);
    });

    it('once per gesture: whatever the row turns into afterwards starts nothing', async () => {
      const user = userEvent.setup();
      const { rerender } = render(<SetRow log={log} />);
      await user.click(screen.getByRole('button', { name: /mark set done/i }));
      expect(startRestTimer).toHaveBeenCalledTimes(1);

      // The optimistic tick, a read that comes back without it, the write
      // landing, a refresh.
      rerender(<SetRow log={{ ...log, done: true }} />);
      rerender(<SetRow log={log} />);
      rerender(<SetRow log={{ ...log, done: true }} />);
      rerender(<SetRow log={{ ...log, done: true, logged_at: '2026-10-09T18:02:11+00:00' }} />);

      expect(startRestTimer).toHaveBeenCalledTimes(1);
      expect(clearRestTimer).not.toHaveBeenCalled();
    });

    it('a set that turns done or failed without a gesture starts no rest', () => {
      const { rerender } = render(<SetRow log={log} />);
      rerender(<SetRow log={{ ...log, done: true }} />);
      rerender(<SetRow log={log} />);
      rerender(<SetRow log={{ ...log, failed: true }} />);
      expect(startRestTimer).not.toHaveBeenCalled();
    });

    it('a swipe to done starts it', () => {
      renderSetRow(log);
      swipe(rowFor(/mark set done/i), -80);
      expect(startRestTimer).toHaveBeenCalledTimes(1);
      expect(startRestTimer).toHaveBeenCalledWith('log-1', 90);
    });

    it('marking a pending set failed starts it too: the athlete recovers whatever the outcome', () => {
      renderSetRow(log);
      swipe(rowFor(/mark set done/i), 80);
      expect(startRestTimer).toHaveBeenCalledTimes(1);
      expect(startRestTimer).toHaveBeenCalledWith('log-1', 90);
    });

    it('done → failed does not restart it (that rest is already running)', async () => {
      const user = userEvent.setup();
      renderSetRow({ ...log, done: true });

      await user.click(screen.getByRole('button', { name: /mark set failed/i }));

      expect(mockSetFailed.mutate).toHaveBeenCalledWith({ logId: 'log-1', failed: true });
      expect(startRestTimer).not.toHaveBeenCalled();
      expect(clearRestTimer).not.toHaveBeenCalled();
    });

    it('failed → done by a swipe does not restart it either', () => {
      renderSetRow({ ...log, failed: true });
      swipe(rowFor(/clear failed/i), -80);
      expect(mockToggleDone.mutate).toHaveBeenCalledWith({ logId: 'log-1', done: true });
      expect(startRestTimer).not.toHaveBeenCalled();
      expect(clearRestTimer).not.toHaveBeenCalled();
    });

    it('clearing a failed mark clears the rest of that set', async () => {
      const user = userEvent.setup();
      renderSetRow({ ...log, failed: true });

      await user.click(screen.getByRole('button', { name: /clear failed/i }));

      expect(clearRestTimer).toHaveBeenCalledTimes(1);
      expect(clearRestTimer).toHaveBeenCalledWith('log-1');
    });

    it('a set that goes back to pending without a gesture clears nothing', () => {
      // A write that was taken back, or a read that does not have it yet.
      const { rerender } = render(<SetRow log={{ ...log, failed: true }} />);
      rerender(<SetRow log={log} />);
      expect(clearRestTimer).not.toHaveBeenCalled();
    });

    it('skipping the set clears its rest', async () => {
      const user = userEvent.setup();
      renderSetRow({ ...log, done: true, target_reps: 10 });
      await user.click(screen.getByRole('button', { name: /log what you actually did/i }));

      await user.click(screen.getByRole('button', { name: /^skip$/i }));

      expect(mockSetSkipped.mutate).toHaveBeenCalledWith({ logId: 'log-1', skipped: true });
      expect(clearRestTimer).toHaveBeenCalledWith('log-1');
    });

    it('a set without a prescribed rest starts none', async () => {
      const user = userEvent.setup();
      renderSetRow({ ...baseLog, target_rest_seconds: null });
      await user.click(screen.getByRole('button', { name: /mark set done/i }));
      expect(mockToggleDone.mutate).toHaveBeenCalledTimes(1);
      expect(startRestTimer).not.toHaveBeenCalled();
    });

    it('a locked row writes nothing and starts nothing', () => {
      renderSetRow(log, { locked: true });
      swipe(rowFor(/mark set done/i), -80);
      fireEvent.click(screen.getByRole('button', { name: /mark set done/i }));
      expect(mockToggleDone.mutate).not.toHaveBeenCalled();
      expect(startRestTimer).not.toHaveBeenCalled();
    });
  });

  describe('off-plan actual logging', () => {
    const repLog = { ...baseLog, target_reps: 10, target_weight_kg: 80 };

    it('opens the editor prefilled from the prescribed target', async () => {
      const user = userEvent.setup();
      renderSetRow(repLog);
      await user.click(screen.getByRole('button', { name: /log what you actually did/i }));
      expect(screen.getByLabelText(/actual reps performed/i)).toHaveValue(10);
      expect(screen.getByLabelText(/actual weight in kilograms/i)).toHaveValue(80);
    });

    it('stores only the dimension that differs; a value equal to target is nulled', async () => {
      const user = userEvent.setup();
      renderSetRow({ ...repLog, done: true });
      await user.click(screen.getByRole('button', { name: /log what you actually did/i }));
      // Drop reps to 8, leave weight at the prescribed 80.
      const reps = screen.getByLabelText(/actual reps performed/i);
      await user.clear(reps);
      await user.type(reps, '8');
      await user.click(screen.getByRole('button', { name: /^save$/i }));
      expect(mockLogActual.mutate).toHaveBeenCalledWith({
        logId: 'log-1',
        actualReps: 8,
        actualWeightKg: null,
      });
    });

    it('stores an added load against a bodyweight prescription', async () => {
      const user = userEvent.setup();
      renderSetRow({ ...baseLog, done: true, target_reps: 12, target_weight_kg: null });
      await user.click(screen.getByRole('button', { name: /log what you actually did/i }));
      const weight = screen.getByLabelText(/actual weight in kilograms/i);
      await user.type(weight, '20');
      await user.click(screen.getByRole('button', { name: /^save$/i }));
      expect(mockLogActual.mutate).toHaveBeenCalledWith({
        logId: 'log-1',
        actualReps: null,
        actualWeightKg: 20,
      });
    });

    it('shows the logged actual on the pill and clears it on demand', async () => {
      const user = userEvent.setup();
      renderSetRow({ ...repLog, actual_reps: 8, actual_weight_kg: 100 });
      // Pill summarizes the deviation.
      const pill = screen.getByRole('button', { name: /logged actual 8 @ 100kg/i });
      expect(pill).toHaveTextContent('8 @ 100kg');
      await user.click(pill);
      await user.click(screen.getByRole('button', { name: /^clear$/i }));
      expect(mockLogActual.mutate).toHaveBeenCalledWith({
        logId: 'log-1',
        actualReps: null,
        actualWeightKg: null,
      });
    });

    it('hides the reps input for duration-based sets', async () => {
      const user = userEvent.setup();
      renderSetRow({ ...baseLog, target_reps: null, target_duration_seconds: 30 });
      await user.click(screen.getByRole('button', { name: /log what you actually did/i }));
      expect(screen.queryByLabelText(/actual reps performed/i)).not.toBeInTheDocument();
      expect(screen.getByLabelText(/actual weight in kilograms/i)).toBeInTheDocument();
    });

    it('shows a read-only actual pill but no editor when locked', () => {
      renderSetRow({ ...repLog, actual_reps: 8, actual_weight_kg: 100 }, { locked: true });
      const pill = screen.getByRole('button', { name: /logged actual/i });
      expect(pill).toBeDisabled();
      // No editor entry point when there's nothing logged + locked.
      expect(screen.queryByLabelText(/actual reps performed/i)).not.toBeInTheDocument();
    });

    it('offers no actual affordance on a locked set with nothing logged', () => {
      renderSetRow(repLog, { locked: true });
      expect(screen.queryByRole('button', { name: /log what you actually did/i })).not.toBeInTheDocument();
    });
  });

  // P27. A set rated or given its actual values without being ticked stayed
  // pending: the session was confirmed with no set done, and Stats, the
  // records, "Last time" and the coach all saw it as not done. On a pending set
  // the rating and the Save of the Actual editor ARE the set done: one write
  // with the value and `done: true`, which the hook dates at the tap.
  describe('an RPE or an Actual given on a pending set marks it done, in the same write', () => {
    const log = { ...baseLog, target_reps: 10, target_weight_kg: 80, target_rest_seconds: 90 };

    it('an RPE on a pending set is one write: the rating and the set done', async () => {
      const user = userEvent.setup();
      renderSetRow(log);

      await user.click(screen.getByRole('button', { name: /^set rpe$/i }));
      await user.click(screen.getByRole('button', { name: /^RPE 8$/i }));

      expect(mockSetRpe.mutate).toHaveBeenCalledTimes(1);
      expect(mockSetRpe.mutate).toHaveBeenCalledWith({ logId: 'log-1', rpe: 8, done: true });
      expect(mockToggleDone.mutate).not.toHaveBeenCalled();
      expect(rpeGrid()).not.toBeInTheDocument();
    });

    it('it is the gesture that marks the set done: the rest of the set starts, once', async () => {
      const user = userEvent.setup();
      const { rerender } = render(<SetRow log={log} />);

      await user.click(screen.getByRole('button', { name: /^set rpe$/i }));
      await user.click(screen.getByRole('button', { name: /^RPE 8$/i }));
      rerender(<SetRow log={{ ...log, done: true, rpe: 8 }} />);
      rerender(<SetRow log={log} />);
      rerender(<SetRow log={{ ...log, done: true, rpe: 8 }} />);

      expect(startRestTimer).toHaveBeenCalledTimes(1);
      expect(startRestTimer).toHaveBeenCalledWith('log-1', 90);
    });

    it('an RPE changed on a done set is the rating alone: the set is not dated again', async () => {
      const user = userEvent.setup();
      renderSetRow({ ...log, done: true, rpe: 7 });

      await user.click(screen.getByRole('button', { name: /RPE 7, tap to change/i }));
      await user.click(screen.getByRole('button', { name: /^RPE 9$/i }));

      expect(mockSetRpe.mutate).toHaveBeenCalledWith({ logId: 'log-1', rpe: 9 });
      expect(startRestTimer).not.toHaveBeenCalled();
    });

    it('a rating taken back marks nothing done', async () => {
      const user = userEvent.setup();
      // A rating left on a set that was never ticked, by a build before this rule.
      renderSetRow({ ...log, rpe: 6 });

      await user.click(screen.getByRole('button', { name: /RPE 6, tap to change/i }));
      await user.click(screen.getByRole('button', { name: /^RPE 6$/i }));

      expect(mockSetRpe.mutate).toHaveBeenCalledWith({ logId: 'log-1', rpe: null });
      expect(startRestTimer).not.toHaveBeenCalled();
    });

    it('an Actual saved on a pending set is one write: the values and the set done', async () => {
      const user = userEvent.setup();
      renderSetRow(log);

      await user.click(screen.getByRole('button', { name: /log what you actually did/i }));
      const reps = screen.getByLabelText(/actual reps performed/i);
      await user.clear(reps);
      await user.type(reps, '8');
      await user.click(screen.getByRole('button', { name: /^save$/i }));

      expect(mockLogActual.mutate).toHaveBeenCalledTimes(1);
      expect(mockLogActual.mutate).toHaveBeenCalledWith({
        logId: 'log-1',
        actualReps: 8,
        actualWeightKg: null,
        done: true,
      });
      expect(mockToggleDone.mutate).not.toHaveBeenCalled();
      // The gesture that marked it done: its rest, and the selector for its rating.
      expect(startRestTimer).toHaveBeenCalledTimes(1);
      expect(startRestTimer).toHaveBeenCalledWith('log-1', 90);
      expect(rpeGrid()).toBeInTheDocument();
    });

    it('"did it as written" on a pending set (open, Save) is the set done', async () => {
      const user = userEvent.setup();
      renderSetRow(log);

      await user.click(screen.getByRole('button', { name: /log what you actually did/i }));
      await user.click(screen.getByRole('button', { name: /^save$/i }));

      expect(mockLogActual.mutate).toHaveBeenCalledWith({
        logId: 'log-1',
        actualReps: null,
        actualWeightKg: null,
        done: true,
      });
    });

    it('an Actual saved on a done set is the values alone', async () => {
      const user = userEvent.setup();
      renderSetRow({ ...log, done: true });

      await user.click(screen.getByRole('button', { name: /log what you actually did/i }));
      await user.click(screen.getByRole('button', { name: /^save$/i }));

      expect(mockLogActual.mutate).toHaveBeenCalledWith({
        logId: 'log-1',
        actualReps: null,
        actualWeightKg: null,
      });
      expect(startRestTimer).not.toHaveBeenCalled();
      expect(rpeGrid()).not.toBeInTheDocument();
    });

    it('an Actual saved on a failed set leaves it failed', async () => {
      const user = userEvent.setup();
      renderSetRow({ ...log, failed: true });

      await user.click(screen.getByRole('button', { name: /log what you actually did/i }));
      const weight = screen.getByLabelText(/actual weight in kilograms/i);
      await user.clear(weight);
      await user.type(weight, '75');
      await user.click(screen.getByRole('button', { name: /^save$/i }));

      expect(mockLogActual.mutate).toHaveBeenCalledWith({
        logId: 'log-1',
        actualReps: null,
        actualWeightKg: 75,
      });
      expect(mockToggleDone.mutate).not.toHaveBeenCalled();
      expect(startRestTimer).not.toHaveBeenCalled();
    });

    it('clearing the Actual of a pending set marks nothing done', async () => {
      const user = userEvent.setup();
      renderSetRow({ ...log, actual_reps: 8 });

      await user.click(screen.getByRole('button', { name: /logged actual/i }));
      await user.click(screen.getByRole('button', { name: /^clear$/i }));

      expect(mockLogActual.mutate).toHaveBeenCalledWith({
        logId: 'log-1',
        actualReps: null,
        actualWeightKg: null,
      });
      expect(startRestTimer).not.toHaveBeenCalled();
    });
  });

  // P59. On a swapped exercise the pinned targets are the ORIGINAL exercise's.
  // The editor collapsed a value equal to one of them to null, so a swap done
  // with the same scheme stored nothing — and the substitute's records and
  // "Last time", which only read logged actuals, never had a set.
  describe('a swapped exercise stores what was done, as entered', () => {
    // Prescribed 8 × 100 kg on the original exercise.
    const log = { ...baseLog, done: true, target_reps: 8, target_weight_kg: 100 };

    it('values equal to the original targets are stored, both of them', async () => {
      const user = userEvent.setup();
      renderSetRow(log, { swapped: true, seedReps: 8, seedWeightKg: 100 });

      await user.click(screen.getByRole('button', { name: /log what you actually did/i }));
      await user.click(screen.getByRole('button', { name: /^save$/i }));

      expect(mockLogActual.mutate).toHaveBeenCalledWith({
        logId: 'log-1',
        actualReps: 8,
        actualWeightKg: 100,
      });
    });

    it('the editor opens on the seeds it is given: the substitute\'s last performance', async () => {
      const user = userEvent.setup();
      renderSetRow(log, { swapped: true, seedReps: 6, seedWeightKg: 32.5 });

      await user.click(screen.getByRole('button', { name: /log what you actually did/i }));

      expect(screen.getByLabelText(/actual reps performed/i)).toHaveValue(6);
      expect(screen.getByLabelText(/actual weight in kilograms/i)).toHaveValue(32.5);
    });

    it('without seeds, the reps start from the prescribed ones and the load from nothing', async () => {
      const user = userEvent.setup();
      renderSetRow(log, { swapped: true });

      await user.click(screen.getByRole('button', { name: /log what you actually did/i }));

      expect(screen.getByLabelText(/actual reps performed/i)).toHaveValue(8);
      expect(screen.getByLabelText(/actual weight in kilograms/i)).toHaveValue(null);
    });

    it('what the set already holds comes before the seeds', async () => {
      const user = userEvent.setup();
      renderSetRow({ ...log, actual_reps: 7, actual_weight_kg: 40 }, { swapped: true, seedReps: 6, seedWeightKg: 32.5 });

      await user.click(screen.getByRole('button', { name: /logged actual/i }));

      expect(screen.getByLabelText(/actual reps performed/i)).toHaveValue(7);
      expect(screen.getByLabelText(/actual weight in kilograms/i)).toHaveValue(40);
    });

    it('a load left empty is no load, not the original exercise\'s', async () => {
      const user = userEvent.setup();
      renderSetRow(log, { swapped: true });

      await user.click(screen.getByRole('button', { name: /log what you actually did/i }));
      await user.click(screen.getByRole('button', { name: /^save$/i }));

      expect(mockLogActual.mutate).toHaveBeenCalledWith({
        logId: 'log-1',
        actualReps: 8,
        actualWeightKg: 0,
      });
    });

    it('on a pending set, the same Save marks it done (P27)', async () => {
      const user = userEvent.setup();
      renderSetRow({ ...log, done: false }, { swapped: true, seedReps: 8, seedWeightKg: 100 });

      await user.click(screen.getByRole('button', { name: /log what you actually did/i }));
      await user.click(screen.getByRole('button', { name: /^save$/i }));

      expect(mockLogActual.mutate).toHaveBeenCalledWith({
        logId: 'log-1',
        actualReps: 8,
        actualWeightKg: 100,
        done: true,
      });
    });

    it('the exercise as the coach wrote it keeps the rule: a value equal to its target is nulled', async () => {
      const user = userEvent.setup();
      renderSetRow(log, { seedReps: 6, seedWeightKg: 32.5 });

      await user.click(screen.getByRole('button', { name: /log what you actually did/i }));
      // Seeds are for a swap: this editor opens on the targets.
      expect(screen.getByLabelText(/actual reps performed/i)).toHaveValue(8);
      expect(screen.getByLabelText(/actual weight in kilograms/i)).toHaveValue(100);
      await user.click(screen.getByRole('button', { name: /^save$/i }));

      expect(mockLogActual.mutate).toHaveBeenCalledWith({
        logId: 'log-1',
        actualReps: null,
        actualWeightKg: null,
      });
    });
  });

  describe('skip + extra sets', () => {
    const repLog = { ...baseLog, target_reps: 10, target_weight_kg: 80 };

    it('renders a skipped set as a muted strip with the target struck through', () => {
      renderSetRow({ ...repLog, skipped: true });
      expect(screen.getByText('Skipped')).toBeInTheDocument();
      // No outcome indicator on a skipped row.
      expect(screen.queryByRole('button', { name: /mark set done/i })).not.toBeInTheDocument();
    });

    it('unskips a skipped set via Undo', async () => {
      const user = userEvent.setup();
      renderSetRow({ ...repLog, skipped: true });
      await user.click(screen.getByRole('button', { name: /^undo$/i }));
      expect(mockSetSkipped.mutate).toHaveBeenCalledWith({ logId: 'log-1', skipped: false });
    });

    it('skips a set from the off-plan panel', async () => {
      const user = userEvent.setup();
      renderSetRow(repLog);
      await user.click(screen.getByRole('button', { name: /log what you actually did/i }));
      await user.click(screen.getByRole('button', { name: /^skip$/i }));
      expect(mockSetSkipped.mutate).toHaveBeenCalledWith({ logId: 'log-1', skipped: true });
    });

    it('marks a student-added set as extra and removes it on demand', async () => {
      const user = userEvent.setup();
      renderSetRow({ ...baseLog, is_student_added: true });
      // The "Extra" marker and its remove control are one chip (keeps the row
      // to a single line on mobile); its accessible name is "Remove extra set".
      const removeBtn = screen.getByRole('button', { name: /remove extra set/i });
      expect(removeBtn).toHaveTextContent(/extra/i);
      await user.click(removeBtn);
      expect(mockRemoveStudentSet.mutate).toHaveBeenCalledWith({ logId: 'log-1' });
    });

    it('does not offer "Skip" on an extra set (it is removed instead)', async () => {
      const user = userEvent.setup();
      renderSetRow({ ...baseLog, is_student_added: true });
      await user.click(screen.getByRole('button', { name: /log what you actually did/i }));
      expect(screen.queryByRole('button', { name: /^skip$/i })).not.toBeInTheDocument();
    });
  });

  // P61. An extra set has no targets. Ticked as it was, it counted as a set
  // with no volume, or as 1 kg a rep, or added reps to an exercise measured in
  // seconds. It now says what was done before it can be done: every gesture
  // that would mark it done opens its editor, pre-filled from the set before
  // it (`seedReps` / `seedWeightKg`, worked out by SlotGroupCard).
  describe('an extra set is done once it says what was done', () => {
    const extra = {
      ...baseLog,
      id: 'log-4',
      set_number: 4,
      is_student_added: true,
      target_rest_seconds: 90,
      actual_reps: null,
      actual_weight_kg: null,
    };
    const seeds = { seedReps: 8, seedWeightKg: 100 };
    const hint = () => screen.queryByText(/to mark this extra set done/i);
    const editorOpen = () => screen.queryByLabelText(/actual weight in kilograms/i);

    it('a tap opens its editor, pre-filled from the set before it, and marks nothing', async () => {
      const user = userEvent.setup();
      renderSetRow(extra, seeds);

      await user.click(screen.getByRole('button', { name: /mark set done/i }));

      expect(mockToggleDone.mutate).not.toHaveBeenCalled();
      expect(startRestTimer).not.toHaveBeenCalled();
      expect(rpeGrid()).not.toBeInTheDocument();
      expect(screen.getByLabelText(/actual reps performed/i)).toHaveValue(8);
      expect(screen.getByLabelText(/actual weight in kilograms/i)).toHaveValue(100);
      expect(hint()).not.toBeInTheDocument();
    });

    it('so does a swipe to done', () => {
      renderSetRow(extra, seeds);
      swipe(rowFor(/mark set done/i), -80);
      expect(mockToggleDone.mutate).not.toHaveBeenCalled();
      expect(editorOpen()).toBeInTheDocument();
    });

    it('and the RPE: a rating does not mark an empty extra set done', async () => {
      const user = userEvent.setup();
      renderSetRow(extra, seeds);

      await user.click(screen.getByRole('button', { name: /^set rpe$/i }));

      expect(rpeGrid()).not.toBeInTheDocument();
      expect(editorOpen()).toBeInTheDocument();
      expect(mockSetRpe.mutate).not.toHaveBeenCalled();
    });

    it('a selector left open when the set went back to empty rates nothing either', async () => {
      const user = userEvent.setup();
      const done = { ...extra, done: true, actual_reps: 8, actual_weight_kg: 100 };
      const { rerender } = render(<SetRow log={done} {...seeds} />);
      await user.click(screen.getByRole('button', { name: /^set rpe$/i }));
      // A write taken back, a read without it.
      rerender(<SetRow log={extra} {...seeds} />);

      await user.click(screen.getByRole('button', { name: /^RPE 8$/i }));

      expect(mockSetRpe.mutate).not.toHaveBeenCalled();
      expect(editorOpen()).toBeInTheDocument();
    });

    it('Save writes the values and marks it done, in one write, and is the gesture of the set', async () => {
      const user = userEvent.setup();
      renderSetRow(extra, seeds);
      await user.click(screen.getByRole('button', { name: /mark set done/i }));

      await user.click(screen.getByRole('button', { name: /^save$/i }));

      expect(mockLogActual.mutate).toHaveBeenCalledTimes(1);
      expect(mockLogActual.mutate).toHaveBeenCalledWith({
        logId: 'log-4',
        actualReps: 8,
        actualWeightKg: 100,
        done: true,
      });
      expect(mockToggleDone.mutate).not.toHaveBeenCalled();
      expect(startRestTimer).toHaveBeenCalledTimes(1);
      expect(startRestTimer).toHaveBeenCalledWith('log-4', 90);
      expect(rpeGrid()).toBeInTheDocument();
    });

    it('without a set before it the editor is empty, and Save waits for reps and a load', async () => {
      const user = userEvent.setup();
      renderSetRow(extra);
      await user.click(screen.getByRole('button', { name: /log what you actually did/i }));

      const save = screen.getByRole('button', { name: /^save$/i });
      expect(screen.getByLabelText(/actual reps performed/i)).toHaveValue(null);
      expect(save).toBeDisabled();
      expect(hint()).toHaveTextContent('Enter the reps and the load (0 for bodyweight) to mark this extra set done.');
      expect(save).toHaveAttribute('aria-describedby', hint().id);

      await user.type(screen.getByLabelText(/actual reps performed/i), '10');
      expect(save).toBeDisabled();
      await user.click(save);
      expect(mockLogActual.mutate).not.toHaveBeenCalled();

      // 0 is a load: no load added, at bodyweight.
      await user.type(screen.getByLabelText(/actual weight in kilograms/i), '0');
      expect(save).toBeEnabled();
      expect(hint()).not.toBeInTheDocument();
      await user.click(save);

      expect(mockLogActual.mutate).toHaveBeenCalledWith({
        logId: 'log-4',
        actualReps: 10,
        actualWeightKg: 0,
        done: true,
      });
    });

    it('0 reps is not a set done', async () => {
      const user = userEvent.setup();
      renderSetRow(extra, { seedReps: 0, seedWeightKg: 20 });
      await user.click(screen.getByRole('button', { name: /log what you actually did/i }));
      expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
    });

    it('on an exercise measured in seconds it asks for the load only, and stores no reps', async () => {
      const user = userEvent.setup();
      renderSetRow(extra, { durationBased: true, seedReps: 12 });
      await user.click(screen.getByRole('button', { name: /mark set done/i }));

      expect(screen.queryByLabelText(/actual reps performed/i)).not.toBeInTheDocument();
      expect(hint()).toHaveTextContent('Enter the load (0 for bodyweight) to mark this extra set done.');
      await user.type(screen.getByLabelText(/actual weight in kilograms/i), '20');
      await user.click(screen.getByRole('button', { name: /^save$/i }));

      expect(mockLogActual.mutate).toHaveBeenCalledWith({
        logId: 'log-4',
        actualReps: null,
        actualWeightKg: 20,
        done: true,
      });
    });

    it('an extra set that says what was done is ticked like any other', async () => {
      const user = userEvent.setup();
      renderSetRow({ ...extra, actual_reps: 8, actual_weight_kg: 100 });

      await user.click(screen.getByRole('button', { name: /mark set done/i }));

      expect(mockToggleDone.mutate).toHaveBeenCalledWith({ logId: 'log-4', done: true });
      expect(rpeGrid()).toBeInTheDocument();
    });

    it('a done extra set keeps its values: no Clear, and no Save without them', async () => {
      const user = userEvent.setup();
      renderSetRow({ ...extra, done: true, actual_reps: 8, actual_weight_kg: 100 });

      await user.click(screen.getByRole('button', { name: /logged actual/i }));
      expect(screen.queryByRole('button', { name: /^clear$/i })).not.toBeInTheDocument();
      await user.clear(screen.getByLabelText(/actual weight in kilograms/i));
      expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
    });
  });
});
