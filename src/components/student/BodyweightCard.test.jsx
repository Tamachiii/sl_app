import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockLog = { mutate: vi.fn(), isPending: false };
let mockLogs = [];

vi.mock('../../hooks/useBodyweight', () => ({
  useBodyweightLogs: () => ({ data: mockLogs }),
  useLogBodyweight: () => mockLog,
}));
vi.mock('../../hooks/useOnlineStatus', () => ({ useOnlineStatus: () => true }));

import BodyweightCard from './BodyweightCard';

const field = () => screen.getByLabelText('Weight (kg)');
const save = () => screen.getByRole('button', { name: /^save$/i });
const INVALID = 'Enter a weight between 1 and 500 kg.';

async function openDialog(user) {
  render(<BodyweightCard />);
  await user.click(screen.getByRole('button', { name: /^log$/i }));
}

async function typeWeight(user, text) {
  await user.clear(field());
  if (text) await user.type(field(), text);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLogs = [{ id: 'bw-1', weight_kg: 80, logged_on: '2026-10-10' }];
});

// P31 (live N3). The weight was a `type="number"` field read with Number():
// in a Chromium whose UI is English "82,5" became 825 and was refused by the
// range check, while "45,5" became 455 and was SAVED. It is a text field read
// by lib/number now: a comma or a point is the decimal separator.
describe('BodyweightCard — logging a weight', () => {
  it('the field is text with a decimal keypad, opening on the latest weight', async () => {
    const user = userEvent.setup();
    mockLogs = [{ id: 'bw-1', weight_kg: '81.50', logged_on: '2026-10-10' }];
    await openDialog(user);

    expect(field()).toHaveAttribute('type', 'text');
    expect(field()).toHaveAttribute('inputmode', 'decimal');
    expect(field()).toHaveValue('81.5');
  });

  it.each([
    ['82,5', 82.5],
    ['82.5', 82.5],
    ['45,5', 45.5],
    ['499,99', 499.99],
    ['1', 1],
  ])('"%s" is saved as %s kg', async (text, weightKg) => {
    const user = userEvent.setup();
    await openDialog(user);

    await typeWeight(user, text);
    await user.click(save());

    expect(mockLog.mutate).toHaveBeenCalledTimes(1);
    expect(mockLog.mutate).toHaveBeenCalledWith({ weightKg }, expect.any(Object));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  // Clicked like a person would: a submit button runs the form's validation
  // first, which the field's `pattern` would fail without the form's noValidate
  // — and then the alert never shows.
  it.each(['abc', '82kg', '0', '0,5', '500', '600', ''])(
    '"%s" saves nothing and shows the alert',
    async (text) => {
      const user = userEvent.setup();
      await openDialog(user);

      await typeWeight(user, text);
      await user.click(save());

      expect(mockLog.mutate).not.toHaveBeenCalled();
      expect(screen.getByRole('alert')).toHaveTextContent(INVALID);
      expect(field()).toHaveAttribute('aria-invalid', 'true');
      expect(field()).toHaveAttribute('aria-describedby', screen.getByRole('alert').id);
    },
  );

  it('typing again clears the alert', async () => {
    const user = userEvent.setup();
    await openDialog(user);

    await typeWeight(user, 'abc');
    await user.click(save());
    expect(screen.getByRole('alert')).toBeInTheDocument();

    await typeWeight(user, '82,5');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(field()).not.toHaveAttribute('aria-invalid');
  });

  it('a save that fails says so, without marking the weight as wrong', async () => {
    const user = userEvent.setup();
    mockLog.mutate.mockImplementationOnce((_vars, { onError }) => onError(new Error('offline')));
    await openDialog(user);

    await typeWeight(user, '82,5');
    await user.click(save());

    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t save that. Please try again.');
    expect(field()).not.toHaveAttribute('aria-invalid');
  });
});
