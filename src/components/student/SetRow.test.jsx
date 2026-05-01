import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockToggleDone = { mutate: vi.fn() };
const mockSetFailed = { mutate: vi.fn() };
const mockSetRpe = { mutate: vi.fn() };

vi.mock('../../hooks/useSetLogs', () => ({
  useToggleSetDone: () => mockToggleDone,
  useSetFailed: () => mockSetFailed,
  useSetRpe: () => mockSetRpe,
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
  it('renders set number', () => {
    renderSetRow();
    expect(screen.getByText('Set 1')).toBeInTheDocument();
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

  it('renders FAILED label when set is failed', () => {
    renderSetRow({ ...baseLog, failed: true });
    expect(screen.getByText('FAILED')).toBeInTheDocument();
  });

  // Touch swipes — jsdom doesn't simulate gestures, so we drive the
  // touch lifecycle directly via fireEvent.
  function swipe(row, dx) {
    fireEvent.touchStart(row, { touches: [{ clientX: 0, clientY: 0 }] });
    fireEvent.touchMove(row, { touches: [{ clientX: dx, clientY: 0 }] });
    fireEvent.touchEnd(row);
  }

  it('right-to-left swipe past threshold marks set done', () => {
    renderSetRow();
    const row = screen.getByText('Set 1').closest('div.relative.rounded-xl, div.rounded-xl');
    swipe(row, -80);
    expect(mockToggleDone.mutate).toHaveBeenCalledWith({ logId: 'log-1', done: true });
    expect(mockSetFailed.mutate).not.toHaveBeenCalled();
  });

  it('left-to-right swipe past threshold marks set failed', () => {
    renderSetRow();
    const row = screen.getByText('Set 1').closest('div.relative.rounded-xl, div.rounded-xl');
    swipe(row, 80);
    expect(mockSetFailed.mutate).toHaveBeenCalledWith({ logId: 'log-1', failed: true });
    expect(mockToggleDone.mutate).not.toHaveBeenCalled();
  });

  it('swipe under threshold does not commit', () => {
    renderSetRow();
    const row = screen.getByText('Set 1').closest('div.relative.rounded-xl, div.rounded-xl');
    swipe(row, -30);
    expect(mockToggleDone.mutate).not.toHaveBeenCalled();
    expect(mockSetFailed.mutate).not.toHaveBeenCalled();
  });

  it('swipe is suppressed when locked', () => {
    renderSetRow(baseLog, { locked: true });
    const row = screen.getByText('Set 1').closest('div.relative.rounded-xl, div.rounded-xl');
    swipe(row, -80);
    expect(mockToggleDone.mutate).not.toHaveBeenCalled();
  });

  it('swipe-right on already-failed set is a no-op (no redundant write)', () => {
    renderSetRow({ ...baseLog, failed: true });
    const row = screen.getByText('Set 1').closest('div.relative.rounded-xl, div.rounded-xl');
    swipe(row, 80);
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
});
