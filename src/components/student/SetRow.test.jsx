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

  it('auto-expands the RPE selector when the set transitions to done', () => {
    const { rerender } = render(<SetRow log={baseLog} />);
    // RpeInput is identifiable by its 1..10 grid; before transition, none are
    // visible because rpeOpen is false.
    expect(screen.queryByRole('button', { name: /^RPE 5$/i })).not.toBeInTheDocument();

    rerender(<SetRow log={{ ...baseLog, done: true }} />);
    // Auto-open: the 10-button RPE grid is now mounted.
    expect(screen.getByRole('button', { name: /^RPE 5$/i })).toBeInTheDocument();
  });

  it('does NOT auto-expand the RPE selector when the set is marked failed', () => {
    const { rerender } = render(<SetRow log={baseLog} />);
    rerender(<SetRow log={{ ...baseLog, failed: true }} />);
    expect(screen.queryByRole('button', { name: /^RPE 5$/i })).not.toBeInTheDocument();
  });

  it('starts the rest timer on pending → done transition', () => {
    const log = { ...baseLog, target_rest_seconds: 90 };
    const { rerender } = render(<SetRow log={log} />);
    expect(startRestTimer).not.toHaveBeenCalled();
    rerender(<SetRow log={{ ...log, done: true }} />);
    expect(startRestTimer).toHaveBeenCalledWith('log-1', 90);
  });

  it('starts the rest timer on pending → failed transition', () => {
    const log = { ...baseLog, target_rest_seconds: 90 };
    const { rerender } = render(<SetRow log={log} />);
    expect(startRestTimer).not.toHaveBeenCalled();
    rerender(<SetRow log={{ ...log, failed: true }} />);
    expect(startRestTimer).toHaveBeenCalledWith('log-1', 90);
  });

  it('clears the rest timer on failed → pending transition', () => {
    const log = { ...baseLog, target_rest_seconds: 90, failed: true };
    const { rerender } = render(<SetRow log={log} />);
    rerender(<SetRow log={{ ...log, failed: false }} />);
    expect(clearRestTimer).toHaveBeenCalledWith('log-1');
  });

  it('does NOT restart the rest timer on done → failed (timer already running)', () => {
    const log = { ...baseLog, target_rest_seconds: 90, done: true };
    const { rerender } = render(<SetRow log={log} />);
    expect(startRestTimer).not.toHaveBeenCalled();
    rerender(<SetRow log={{ ...log, done: false, failed: true }} />);
    expect(startRestTimer).not.toHaveBeenCalled();
    expect(clearRestTimer).not.toHaveBeenCalled();
  });

  it('auto-collapses the RPE selector after a value is selected', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<SetRow log={baseLog} />);
    rerender(<SetRow log={{ ...baseLog, done: true }} />);
    const rpe7 = screen.getByRole('button', { name: /^RPE 7$/i });
    await user.click(rpe7);
    expect(mockSetRpe.mutate).toHaveBeenCalledWith({ logId: 'log-1', rpe: 7 });
    // After selection the panel closes — the inner RpeInput grid is gone.
    expect(screen.queryByRole('button', { name: /^RPE 5$/i })).not.toBeInTheDocument();
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
      renderSetRow(repLog);
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
      renderSetRow({ ...baseLog, target_reps: 12, target_weight_kg: null });
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
      await user.click(screen.getByRole('button', { name: /^skip set$/i }));
      expect(mockSetSkipped.mutate).toHaveBeenCalledWith({ logId: 'log-1', skipped: true });
    });

    it('labels a student-added set "Extra set" and removes it on demand', async () => {
      const user = userEvent.setup();
      renderSetRow({ ...baseLog, is_student_added: true });
      expect(screen.getByText('Extra set')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /remove extra set/i }));
      expect(mockRemoveStudentSet.mutate).toHaveBeenCalledWith({ logId: 'log-1' });
    });

    it('does not offer "Skip set" on an extra set (it is removed instead)', async () => {
      const user = userEvent.setup();
      renderSetRow({ ...baseLog, is_student_added: true });
      await user.click(screen.getByRole('button', { name: /log what you actually did/i }));
      expect(screen.queryByRole('button', { name: /^skip set$/i })).not.toBeInTheDocument();
    });
  });
});
