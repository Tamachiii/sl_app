import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { onlineManager } from '@tanstack/react-query';
import { getToasts, dismissToast } from '../../lib/toast';

const mockToggleDone = { mutate: vi.fn() };
const mockSetFailed = { mutate: vi.fn() };
const mockSetRpe = { mutate: vi.fn() };
const mockLogActual = { mutate: vi.fn() };
const mockSetSkipped = { mutate: vi.fn() };
// The removal answers the row as the database deleted it (see the Undo tests).
const mockRemoveStudentSet = {
  mutate: vi.fn(),
  mutateAsync: vi.fn(async ({ logId }) => ({ logId, removed: { id: logId } })),
  isPending: false,
};
const mockAddStudentSet = { mutate: vi.fn(), isPending: false };

vi.mock('../../hooks/useSetLogs', () => ({
  useToggleSetDone: () => mockToggleDone,
  useSetFailed: () => mockSetFailed,
  useSetRpe: () => mockSetRpe,
  useLogActual: () => mockLogActual,
  useSetSkipped: () => mockSetSkipped,
  useAddStudentSet: () => mockAddStudentSet,
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
  for (const toast of getToasts()) dismissToast(toast.id);
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

  // P68: a tap on a done set used to mark it failed — and drop its RPE.
  it('a tap on a done set marks nothing: it says that a hold marks it failed', async () => {
    const user = userEvent.setup();
    renderSetRow({ ...baseLog, done: true, rpe: 8 });

    const indicator = screen.getByRole('button', { name: /mark set failed/i });
    expect(indicator).toHaveAccessibleName('Done. Hold to mark set failed');
    await user.click(indicator);

    expect(mockSetFailed.mutate).not.toHaveBeenCalled();
    expect(mockToggleDone.mutate).not.toHaveBeenCalled();
    const hint = screen.getByRole('status');
    expect(hint).toHaveTextContent('Hold to mark this set failed.');
    expect(indicator).toHaveAttribute('aria-describedby', hint.id);
  });

  it('tap on indicator clears failed → pending', async () => {
    const user = userEvent.setup();
    renderSetRow({ ...baseLog, failed: true });

    const indicator = screen.getByRole('button', { name: /clear failed/i });
    await user.click(indicator);
    expect(mockSetFailed.mutate).toHaveBeenCalledWith({ logId: 'log-1', failed: false });
  });

  it('the indicator reaches every state: a tap to done, a hold to failed, a tap back to pending', async () => {
    const user = userEvent.setup();

    const { rerender } = render(<SetRow log={baseLog} />);
    await user.click(screen.getByRole('button', { name: /mark set done/i }));
    expect(mockToggleDone.mutate).toHaveBeenLastCalledWith({ logId: 'log-1', done: true });

    rerender(<SetRow log={{ ...baseLog, done: true }} />);
    // The menu of the indicator is its hold for a mouse or a keyboard.
    fireEvent.contextMenu(screen.getByRole('button', { name: /mark set failed/i }));
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

  // P68. Failed is a hold on the indicator (500 ms), no longer a tap: the tap
  // turned a set done a moment ago into a failure at the brush of a thumb.
  // jsdom has PointerEvent; the clock is a fake one.
  describe('a hold on the indicator marks the set failed', () => {
    const log = { ...baseLog, done: true, rpe: 8, target_rest_seconds: 90 };
    const indicator = () =>
      screen.getByRole('button', { name: /mark set failed|mark set done|clear failed/i });
    const press = (el, at = { clientX: 10, clientY: 10 }) =>
      fireEvent.pointerDown(el, { ...at, button: 0, isPrimary: true, pointerType: 'touch' });
    const wait = (ms) => act(() => vi.advanceTimersByTime(ms));

    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('held 500 ms, a done set is marked failed, once, and its rest goes on', () => {
      renderSetRow(log);
      const el = indicator();

      press(el);
      wait(499);
      expect(mockSetFailed.mutate).not.toHaveBeenCalled();
      wait(1);

      expect(mockSetFailed.mutate).toHaveBeenCalledTimes(1);
      expect(mockSetFailed.mutate).toHaveBeenCalledWith({ logId: 'log-1', failed: true });
      expect(mockToggleDone.mutate).not.toHaveBeenCalled();
      expect(startRestTimer).not.toHaveBeenCalled();
      expect(clearRestTimer).not.toHaveBeenCalled();
    });

    it('the click that ends the hold is not a tap', () => {
      // A pending set: a tap there would mark it done.
      renderSetRow({ ...baseLog, target_rest_seconds: 90 });
      const el = indicator();

      press(el);
      wait(500);
      fireEvent.pointerUp(el);
      fireEvent.click(el);

      expect(mockSetFailed.mutate).toHaveBeenCalledTimes(1);
      expect(mockToggleDone.mutate).not.toHaveBeenCalled();
      // Pending → failed: the rest of the set starts, as with the swipe.
      expect(startRestTimer).toHaveBeenCalledWith('log-1', 90);
      // The next tap is a tap again.
      press(el);
      fireEvent.pointerUp(el);
      fireEvent.click(el);
      expect(mockToggleDone.mutate).toHaveBeenCalledWith({ logId: 'log-1', done: true });
    });

    it('a finger lifted before 500 ms holds nothing', () => {
      renderSetRow(log);
      const el = indicator();

      press(el);
      wait(300);
      fireEvent.pointerUp(el);
      fireEvent.click(el);
      wait(1000);

      expect(mockSetFailed.mutate).not.toHaveBeenCalled();
      expect(screen.getByRole('status')).toHaveTextContent(/hold to mark this set failed/i);
    });

    it('a finger that travels — a swipe, a scroll — holds nothing', () => {
      renderSetRow(log);
      const el = indicator();

      press(el, { clientX: 10, clientY: 10 });
      fireEvent.pointerMove(el, { clientX: 30, clientY: 12, isPrimary: true });
      wait(600);
      expect(mockSetFailed.mutate).not.toHaveBeenCalled();

      // The browser takes a vertical pan for itself and cancels the pointer.
      press(el);
      fireEvent.pointerCancel(el);
      wait(600);
      expect(mockSetFailed.mutate).not.toHaveBeenCalled();
    });

    it('a finger that trembles a few pixels still holds', () => {
      renderSetRow(log);
      const el = indicator();

      press(el, { clientX: 10, clientY: 10 });
      fireEvent.pointerMove(el, { clientX: 15, clientY: 14, isPrimary: true });
      wait(500);

      expect(mockSetFailed.mutate).toHaveBeenCalledTimes(1);
    });

    it('Android opens the context menu on the same hold: one write, no menu', () => {
      renderSetRow(log);
      const el = indicator();

      press(el);
      wait(500);
      const shown = fireEvent.contextMenu(el);
      fireEvent.pointerUp(el);
      fireEvent.click(el);

      expect(shown).toBe(false);
      expect(mockSetFailed.mutate).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('the menu key or a right click marks it failed too, and the next tap is a tap (WCAG 2.1.1)', () => {
      renderSetRow(log);
      const el = indicator();

      const shown = fireEvent.contextMenu(el);
      expect(shown).toBe(false);
      expect(mockSetFailed.mutate).toHaveBeenCalledTimes(1);

      // No click follows a menu key: the next one is the athlete's.
      fireEvent.click(el);
      expect(screen.getByRole('status')).toBeInTheDocument();
    });

    it('a failed set, a locked row and a second finger hold nothing', () => {
      const { rerender } = render(<SetRow log={{ ...baseLog, failed: true }} />);
      press(indicator());
      wait(600);
      fireEvent.contextMenu(indicator());
      expect(mockSetFailed.mutate).not.toHaveBeenCalled();

      rerender(<SetRow log={log} locked />);
      press(indicator());
      wait(600);
      fireEvent.contextMenu(indicator());
      expect(mockSetFailed.mutate).not.toHaveBeenCalled();

      rerender(<SetRow log={log} />);
      fireEvent.pointerDown(indicator(), { clientX: 0, clientY: 0, button: 0, isPrimary: false });
      wait(600);
      expect(mockSetFailed.mutate).not.toHaveBeenCalled();
    });

    it('a row that goes away while held marks nothing', () => {
      const { unmount } = renderSetRow(log);
      press(indicator());
      unmount();
      wait(600);
      expect(mockSetFailed.mutate).not.toHaveBeenCalled();
    });

    it('the line that says how goes away by itself', () => {
      renderSetRow(log);
      fireEvent.click(indicator());
      expect(screen.getByRole('status')).toBeInTheDocument();

      wait(4000);

      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expect(indicator()).not.toHaveAttribute('aria-describedby');
    });

    it('a swipe from the indicator is still a swipe', () => {
      renderSetRow({ ...baseLog });
      const el = indicator();
      press(el, { clientX: 0, clientY: 0 });
      fireEvent.pointerMove(el, { clientX: 80, clientY: 0, isPrimary: true });
      swipe(rowFor(/mark set done/i), 80);
      wait(600);
      // One write: the swipe's.
      expect(mockSetFailed.mutate).toHaveBeenCalledTimes(1);
    });
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

    it('done → failed does not restart it (that rest is already running)', () => {
      renderSetRow({ ...log, done: true });

      fireEvent.contextMenu(screen.getByRole('button', { name: /mark set failed/i }));

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
      expect(screen.getByLabelText(/actual reps performed/i)).toHaveValue('10');
      expect(screen.getByLabelText(/actual weight in kilograms/i)).toHaveValue('80');
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

      expect(screen.getByLabelText(/actual reps performed/i)).toHaveValue('6');
      expect(screen.getByLabelText(/actual weight in kilograms/i)).toHaveValue('32.5');
    });

    it('without seeds, the reps start from the prescribed ones and the load from nothing', async () => {
      const user = userEvent.setup();
      renderSetRow(log, { swapped: true });

      await user.click(screen.getByRole('button', { name: /log what you actually did/i }));

      expect(screen.getByLabelText(/actual reps performed/i)).toHaveValue('8');
      expect(screen.getByLabelText(/actual weight in kilograms/i)).toHaveValue('');
    });

    it('what the set already holds comes before the seeds', async () => {
      const user = userEvent.setup();
      renderSetRow({ ...log, actual_reps: 7, actual_weight_kg: 40 }, { swapped: true, seedReps: 6, seedWeightKg: 32.5 });

      await user.click(screen.getByRole('button', { name: /logged actual/i }));

      expect(screen.getByLabelText(/actual reps performed/i)).toHaveValue('7');
      expect(screen.getByLabelText(/actual weight in kilograms/i)).toHaveValue('40');
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
      expect(screen.getByLabelText(/actual reps performed/i)).toHaveValue('8');
      expect(screen.getByLabelText(/actual weight in kilograms/i)).toHaveValue('100');
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
      expect(mockRemoveStudentSet.mutateAsync).toHaveBeenCalledWith({ logId: 'log-1' });
    });

    // P68. jsdom lays nothing out: the 44 px are read from the classes.
    it('draws the Undo of a skipped set and the Extra chip at 44 px', () => {
      const { rerender } = render(<SetRow log={{ ...repLog, skipped: true }} />);
      expect(screen.getByRole('button', { name: /^undo$/i })).toHaveClass('sl-pill', 'sl-pill-btn');

      rerender(<SetRow log={{ ...baseLog, is_student_added: true }} />);
      expect(screen.getByRole('button', { name: /remove extra set/i })).toHaveClass('sl-pill', 'sl-pill-btn');
    });

    it('and the two fields of the Actual editor', async () => {
      const user = userEvent.setup();
      renderSetRow(repLog);
      await user.click(screen.getByRole('button', { name: /log what you actually did/i }));
      expect(screen.getByLabelText(/actual reps performed/i)).toHaveClass('min-h-11');
      expect(screen.getByLabelText(/actual weight in kilograms/i)).toHaveClass('min-h-11');
    });

    it('does not offer "Skip" on an extra set (it is removed instead)', async () => {
      const user = userEvent.setup();
      renderSetRow({ ...baseLog, is_student_added: true });
      await user.click(screen.getByRole('button', { name: /log what you actually did/i }));
      expect(screen.queryByRole('button', { name: /^skip$/i })).not.toBeInTheDocument();
    });
  });

  // P68. One tap on "Extra ✕" deleted the set, its outcome, its RPE and what
  // it said was done. The removal is now followed by a toast whose Undo puts
  // the row back as the database answered it.
  describe('a removed extra set comes back with Undo', () => {
    const removed = {
      id: 'log-4',
      exercise_slot_id: 'slot-1',
      set_number: 4,
      is_student_added: true,
      done: true,
      failed: false,
      rpe: 8,
      logged_at: '2026-10-15T18:02:11+00:00',
      failed_at: null,
      actual_reps: 8,
      actual_weight_kg: 100,
    };
    const extraLog = { ...baseLog, ...removed };
    const clearToasts = () => {
      for (const toast of getToasts()) dismissToast(toast.id);
    };

    beforeEach(clearToasts);
    afterEach(() => {
      clearToasts();
      onlineManager.setOnline(true);
    });

    it('the removal says so, and its Undo inserts the set again — the row gone or not', async () => {
      const user = userEvent.setup();
      mockRemoveStudentSet.mutateAsync.mockResolvedValueOnce({ logId: 'log-4', removed });
      const { unmount } = renderSetRow(extraLog);

      await user.click(screen.getByRole('button', { name: /remove extra set/i }));

      await waitFor(() => expect(getToasts()).toHaveLength(1));
      const [toast] = getToasts();
      expect(toast).toMatchObject({
        kind: 'info',
        message: 'sessionTouchUndo.setRemoved',
        action: { label: 'uiSharedHelpers.undo' },
      });
      expect(mockAddStudentSet.mutate).not.toHaveBeenCalled();

      // The list read again without the set: the row is gone.
      unmount();
      toast.action.onClick();

      expect(mockAddStudentSet.mutate).toHaveBeenCalledTimes(1);
      expect(mockAddStudentSet.mutate).toHaveBeenCalledWith({
        slotId: 'slot-1',
        setNumber: 4,
        restore: removed,
      });
    });

    it('nothing removed — a session closed meanwhile — offers nothing to undo', async () => {
      const user = userEvent.setup();
      mockRemoveStudentSet.mutateAsync.mockResolvedValueOnce({ logId: 'log-4', removed: null });
      renderSetRow(extraLog);

      await user.click(screen.getByRole('button', { name: /remove extra set/i }));
      await act(async () => {});

      expect(getToasts()).toEqual([]);
    });

    it('a refused removal offers nothing to undo either (its error has its own toast)', async () => {
      const user = userEvent.setup();
      mockRemoveStudentSet.mutateAsync.mockRejectedValueOnce(new Error('refused'));
      renderSetRow(extraLog);

      await user.click(screen.getByRole('button', { name: /remove extra set/i }));
      await act(async () => {});

      expect(getToasts()).toEqual([]);
    });

    it('without a network, Undo inserts nothing and says why', async () => {
      const user = userEvent.setup();
      mockRemoveStudentSet.mutateAsync.mockResolvedValueOnce({ logId: 'log-4', removed });
      renderSetRow(extraLog);
      await user.click(screen.getByRole('button', { name: /remove extra set/i }));
      await waitFor(() => expect(getToasts()).toHaveLength(1));

      onlineManager.setOnline(false);
      getToasts()[0].action.onClick();

      expect(mockAddStudentSet.mutate).not.toHaveBeenCalled();
      expect(getToasts().at(-1)).toMatchObject({ kind: 'error', message: 'sessionTouchUndo.undoNeedsNetwork' });
    });
  });

  // P68. Skipping a set clears its outcome, its RPE and its actual values
  // (`patchForSkipped`): the strip's Undo only dropped the flag, and the set
  // came back pending. The skip is followed by a toast whose Undo writes all of
  // it back; the strip's Undo does the same after a skip made on the row.
  describe('a skipped set comes back as it was with Undo', () => {
    const doneLog = {
      ...baseLog,
      target_reps: 10,
      target_weight_kg: 80,
      target_rest_seconds: 90,
      done: true,
      rpe: 8,
      logged_at: '2026-10-15T18:02:11+00:00',
      actual_reps: 8,
      actual_weight_kg: null,
    };

    async function skip(user) {
      await user.click(screen.getByRole('button', { name: /logged actual|log what you actually did/i }));
      await user.click(screen.getByRole('button', { name: /^skip$/i }));
    }

    const order = (mock) => mock.mock.invocationCallOrder;

    it('the skip says so, and its Undo writes back the outcome dated as it was, the RPE and the actual values', async () => {
      const user = userEvent.setup();
      renderSetRow(doneLog);
      await skip(user);

      expect(mockSetSkipped.mutate).toHaveBeenCalledWith({ logId: 'log-1', skipped: true });
      const [toast] = getToasts();
      expect(toast).toMatchObject({
        kind: 'info',
        message: 'sessionTouchUndo.setSkipped',
        action: { label: 'uiSharedHelpers.undo' },
      });

      toast.action.onClick();

      expect(mockSetSkipped.mutate).toHaveBeenLastCalledWith({ logId: 'log-1', skipped: false });
      expect(mockToggleDone.mutate).toHaveBeenCalledWith({
        logId: 'log-1',
        done: true,
        at: '2026-10-15T18:02:11+00:00',
      });
      expect(mockSetRpe.mutate).toHaveBeenCalledWith({ logId: 'log-1', rpe: 8 });
      expect(mockLogActual.mutate).toHaveBeenCalledWith({ logId: 'log-1', actualReps: 8, actualWeightKg: null });
      // In this order, on the row's queue.
      expect(order(mockSetSkipped.mutate)[1]).toBeLessThan(order(mockToggleDone.mutate)[0]);
      expect(order(mockToggleDone.mutate)[0]).toBeLessThan(order(mockSetRpe.mutate)[0]);
      expect(order(mockSetRpe.mutate)[0]).toBeLessThan(order(mockLogActual.mutate)[0]);
      expect(mockSetFailed.mutate).not.toHaveBeenCalled();
      // The rest the skip cleared is not started again.
      expect(startRestTimer).not.toHaveBeenCalled();
    });

    it('a failed set comes back failed, dated as it was', async () => {
      const user = userEvent.setup();
      renderSetRow({ ...doneLog, done: false, rpe: null, logged_at: null, failed: true, failed_at: '2026-10-15T18:05:00+00:00', actual_reps: null });
      await skip(user);

      getToasts()[0].action.onClick();

      expect(mockSetFailed.mutate).toHaveBeenCalledWith({ logId: 'log-1', failed: true, at: '2026-10-15T18:05:00+00:00' });
      expect(mockToggleDone.mutate).not.toHaveBeenCalled();
      expect(mockSetRpe.mutate).not.toHaveBeenCalled();
      expect(mockLogActual.mutate).not.toHaveBeenCalled();
    });

    it('a pending set comes back pending: one write', async () => {
      const user = userEvent.setup();
      renderSetRow({ ...baseLog, target_reps: 10, target_weight_kg: 80 });
      await skip(user);

      getToasts()[0].action.onClick();

      expect(mockSetSkipped.mutate).toHaveBeenCalledTimes(2);
      expect(mockSetSkipped.mutate).toHaveBeenLastCalledWith({ logId: 'log-1', skipped: false });
      expect(mockToggleDone.mutate).not.toHaveBeenCalled();
      expect(mockSetFailed.mutate).not.toHaveBeenCalled();
      expect(mockSetRpe.mutate).not.toHaveBeenCalled();
      expect(mockLogActual.mutate).not.toHaveBeenCalled();
    });

    it("the strip's Undo is the same way back, closes the toast, and the toast's does nothing more", async () => {
      const user = userEvent.setup();
      const { rerender } = render(<SetRow log={doneLog} />);
      await skip(user);
      const [toast] = getToasts();
      // The optimistic skip on screen.
      rerender(<SetRow log={{ ...doneLog, skipped: true, done: false, rpe: null, logged_at: null, actual_reps: null }} />);

      await user.click(screen.getByRole('button', { name: /^undo$/i }));

      expect(getToasts()).toEqual([]);
      expect(mockToggleDone.mutate).toHaveBeenCalledWith({
        logId: 'log-1',
        done: true,
        at: '2026-10-15T18:02:11+00:00',
      });
      expect(mockSetRpe.mutate).toHaveBeenCalledWith({ logId: 'log-1', rpe: 8 });

      toast.action.onClick();
      expect(mockSetSkipped.mutate).toHaveBeenCalledTimes(2);
      expect(mockToggleDone.mutate).toHaveBeenCalledTimes(1);
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
      expect(screen.getByLabelText(/actual reps performed/i)).toHaveValue('8');
      expect(screen.getByLabelText(/actual weight in kilograms/i)).toHaveValue('100');
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
      expect(screen.getByLabelText(/actual reps performed/i)).toHaveValue('');
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

  // P31 (live N3, L9). The two fields were `type="number"`, which reads "82,5"
  // by the language of the browser: 825 in a Chromium whose UI is English, ""
  // in WebKit — and "" was read as null, which on a set written as prescribed
  // erased the actual it held and on a swapped or extra set stored 0 kg. They
  // are text fields now, read by lib/number: a comma or a point is a decimal
  // separator, and text that is not a number is refused, never saved.
  describe('a decimal comma is read, and text that is not a number is refused (P31)', () => {
    // Prescribed 10 × 80 kg, done.
    const log = { ...baseLog, done: true, target_reps: 10, target_weight_kg: 80 };
    const reps = () => screen.getByLabelText(/actual reps performed/i);
    const weight = () => screen.getByLabelText(/actual weight in kilograms/i);
    const save = () => screen.getByRole('button', { name: /^save$/i });

    async function openEditor(user, name = /log what you actually did/i) {
      await user.click(screen.getByRole('button', { name }));
    }

    async function typeWeight(user, text) {
      await user.clear(weight());
      if (text) await user.type(weight(), text);
    }

    it('the fields are text with a numeric keypad, not number fields', async () => {
      const user = userEvent.setup();
      renderSetRow(log);
      await openEditor(user);

      expect(reps()).toHaveAttribute('type', 'text');
      expect(reps()).toHaveAttribute('inputmode', 'numeric');
      expect(weight()).toHaveAttribute('type', 'text');
      expect(weight()).toHaveAttribute('inputmode', 'decimal');
    });

    it.each(['82,5', '82.5'])('"%s" is 82.5 kg, whatever the browser', async (text) => {
      const user = userEvent.setup();
      renderSetRow(log);
      await openEditor(user);

      await typeWeight(user, text);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      await user.click(save());

      expect(mockLogActual.mutate).toHaveBeenCalledWith({
        logId: 'log-1',
        actualReps: null,
        actualWeightKg: 82.5,
      });
    });

    it('a weight that is not a number is not saved, and the actual the set holds stays', async () => {
      const user = userEvent.setup();
      renderSetRow({ ...log, actual_reps: 8, actual_weight_kg: 100 });
      await openEditor(user, /logged actual/i);

      await typeWeight(user, 'abc');

      expect(screen.getByRole('alert')).toHaveTextContent('Enter a number, like 82.5');
      expect(weight()).toHaveAttribute('aria-invalid', 'true');
      expect(save()).toBeDisabled();
      expect(save()).toHaveAttribute('aria-describedby', screen.getByRole('alert').id);
      await user.click(save());
      expect(mockLogActual.mutate).not.toHaveBeenCalled();
      // The editor stays open on what was typed.
      expect(weight()).toHaveValue('abc');
    });

    it('reps that are not a whole number are refused with their own message', async () => {
      const user = userEvent.setup();
      renderSetRow(log);
      await openEditor(user);

      await user.clear(reps());
      await user.type(reps(), '8,5');

      expect(screen.getByRole('alert')).toHaveTextContent('Enter a whole number');
      expect(reps()).toHaveAttribute('aria-invalid', 'true');
      await user.click(save());
      expect(mockLogActual.mutate).not.toHaveBeenCalled();
    });

    it('a load past what the column holds is refused here, not by the server on replay', async () => {
      const user = userEvent.setup();
      renderSetRow(log);
      await openEditor(user);

      await typeWeight(user, '10000');

      expect(screen.getByRole('alert')).toBeInTheDocument();
      await user.click(save());
      expect(mockLogActual.mutate).not.toHaveBeenCalled();
    });

    it('a field left empty is still "as prescribed", and a corrected text clears the alert', async () => {
      const user = userEvent.setup();
      renderSetRow({ ...log, actual_reps: 8, actual_weight_kg: 100 });
      await openEditor(user, /logged actual/i);

      await typeWeight(user, '9o');
      expect(screen.getByRole('alert')).toBeInTheDocument();
      await typeWeight(user, '');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(weight()).not.toHaveAttribute('aria-invalid');
      await user.click(save());

      expect(mockLogActual.mutate).toHaveBeenCalledWith({
        logId: 'log-1',
        actualReps: 8,
        actualWeightKg: null,
      });
    });

    it('on a swapped exercise, text that is not a number is not stored as no load', async () => {
      const user = userEvent.setup();
      renderSetRow(log, { swapped: true, seedReps: 8, seedWeightKg: 30 });
      await openEditor(user);

      await typeWeight(user, 'abc');
      await user.click(save());

      expect(mockLogActual.mutate).not.toHaveBeenCalled();
      expect(screen.getByRole('alert')).toHaveTextContent('Enter a number, like 82.5');

      await typeWeight(user, '32,5');
      await user.click(save());
      expect(mockLogActual.mutate).toHaveBeenCalledWith({
        logId: 'log-1',
        actualReps: 8,
        actualWeightKg: 32.5,
      });
    });

    describe('on an extra set', () => {
      const extra = {
        ...baseLog,
        id: 'log-4',
        set_number: 4,
        is_student_added: true,
        actual_reps: null,
        actual_weight_kg: null,
      };

      it('"82,5" is saved as 82.5 and marks the set done', async () => {
        const user = userEvent.setup();
        renderSetRow(extra, { seedReps: 8, seedWeightKg: 80 });
        await openEditor(user);

        await typeWeight(user, '82,5');
        await user.click(save());

        expect(mockLogActual.mutate).toHaveBeenCalledWith({
          logId: 'log-4',
          actualReps: 8,
          actualWeightKg: 82.5,
          done: true,
        });
      });

      it('text that is not a number shows the alert, not the "needs reps and load" hint, and saves nothing', async () => {
        const user = userEvent.setup();
        renderSetRow(extra, { seedReps: 8, seedWeightKg: 80 });
        await openEditor(user);

        await typeWeight(user, 'abc');

        expect(screen.getByRole('alert')).toHaveTextContent('Enter a number, like 82.5');
        expect(screen.queryByText(/to mark this extra set done/i)).not.toBeInTheDocument();
        await user.click(save());
        expect(mockLogActual.mutate).not.toHaveBeenCalled();
      });
    });
  });
});
