import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockToggleDone = { mutate: vi.fn() };
const mockSetRpe = { mutate: vi.fn() };

vi.mock('../../hooks/useSetLogs', () => ({
  useToggleSetDone: () => mockToggleDone,
  useSetRpe: () => mockSetRpe,
}));

import SetRow from './SetRow';

const mockLog = {
  id: 'log-1',
  set_number: 1,
  done: false,
  rpe: null,
  exercise_slot_id: 'slot-1',
};

function renderSetRow(log = mockLog) {
  return render(<SetRow log={log} />);
}

describe('SetRow', () => {
  it('renders set number', () => {
    renderSetRow();
    expect(screen.getByText('Set 1')).toBeInTheDocument();
  });

  it('clicking checkbox calls toggleDone', async () => {
    const user = userEvent.setup();
    renderSetRow();

    const checkbox = screen.getByRole('button', { name: /mark set/i });
    await user.click(checkbox);
    expect(mockToggleDone.mutate).toHaveBeenCalledWith({ logId: 'log-1', done: true });
  });

  it('clicking checkbox on done log toggles it off', async () => {
    const user = userEvent.setup();
    renderSetRow({ ...mockLog, done: true });

    const checkbox = screen.getByRole('button', { name: /mark set/i });
    await user.click(checkbox);
    expect(mockToggleDone.mutate).toHaveBeenCalledWith({ logId: 'log-1', done: false });
  });

  it('renders RPE buttons', () => {
    renderSetRow();
    expect(screen.getByText('RPE')).toBeInTheDocument();
  });
});
