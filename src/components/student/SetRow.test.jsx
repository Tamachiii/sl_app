import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockToggleDone = { mutate: vi.fn() };
const mockSetRpe = { mutate: vi.fn() };
const mockSetWeight = { mutate: vi.fn() };

vi.mock('../../hooks/useSetLogs', () => ({
  useToggleSetDone: () => mockToggleDone,
  useSetRpe: () => mockSetRpe,
  useSetWeight: () => mockSetWeight,
}));

import SetRow from './SetRow';

const mockLog = {
  id: 'log-1',
  set_number: 1,
  done: false,
  rpe: null,
  weight_kg: null,
  exercise_slot_id: 'slot-1',
};

function renderSetRow(log = mockLog, props = {}) {
  return render(<SetRow log={log} {...props} />);
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

  it('renders weight input with BW placeholder when no prescribed weight', () => {
    renderSetRow();
    const input = screen.getByRole('spinbutton', { name: /weight for set 1/i });
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute('placeholder', 'BW');
  });

  it('renders weight input placeholder showing prescribed weight', () => {
    renderSetRow(mockLog, { prescribedWeightKg: 20 });
    const input = screen.getByRole('spinbutton', { name: /weight for set 1/i });
    expect(input).toHaveAttribute('placeholder', '20');
  });

  it('prefills input with logged weight_kg', () => {
    renderSetRow({ ...mockLog, weight_kg: 17.5 });
    const input = screen.getByRole('spinbutton', { name: /weight for set 1/i });
    expect(input).toHaveValue(17.5);
  });

  it('calls setWeight.mutate on blur when weight changes', async () => {
    const user = userEvent.setup();
    renderSetRow();
    const input = screen.getByRole('spinbutton', { name: /weight for set 1/i });
    await user.type(input, '15');
    await user.tab(); // triggers blur
    expect(mockSetWeight.mutate).toHaveBeenCalledWith({ logId: 'log-1', weightKg: 15 });
  });

  it('shows a read-only weight value when locked', () => {
    renderSetRow({ ...mockLog, weight_kg: 22.5 }, { locked: true });
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(screen.getByText('22.5 kg')).toBeInTheDocument();
  });
});
