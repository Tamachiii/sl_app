import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { inTimeZone, ZONES } from '../../test/inTimeZone';

const mockLog = { mutate: vi.fn(), isPending: false };
let mockLogs = [];
let mockOnline = true;

vi.mock('../../hooks/useBodyweight', () => ({
  useBodyweightLogs: () => ({ data: mockLogs }),
  useLogBodyweight: () => mockLog,
}));
vi.mock('../../hooks/useOnlineStatus', () => ({ useOnlineStatus: () => mockOnline }));

import BodyweightCard from './BodyweightCard';
import { BODYWEIGHT_HEADING_ID } from './PersonalRecords';

const field = () => screen.getByLabelText('Weight in kg');
const save = () => screen.getByRole('button', { name: 'Save the weight' });
const logButton = () => screen.getByRole('button', { name: 'Log my weight' });
const INVALID = 'Enter a weight between 1 and 500 kg.';

async function openDialog(user) {
  render(<BodyweightCard />);
  await user.click(logButton());
}

async function typeWeight(user, text) {
  await user.clear(field());
  if (text) await user.type(field(), text);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLog.isPending = false;
  mockOnline = true;
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

  it('opens in a sheet named by its title, and Cancel closes it without saving', async () => {
    const user = userEvent.setup();
    await openDialog(user);

    expect(screen.getByRole('dialog', { name: 'Log my weight' })).toBeInTheDocument();
    expect(field()).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Weight in kg')).not.toBeInTheDocument();
    expect(mockLog.mutate).not.toHaveBeenCalled();
  });

  it('closes the sheet once the weight is saved', async () => {
    const user = userEvent.setup();
    mockLog.mutate.mockImplementationOnce((_vars, { onSuccess }) => onSuccess());
    await openDialog(user);

    await typeWeight(user, '79');
    await user.click(save());

    expect(mockLog.mutate).toHaveBeenCalledWith({ weightKg: 79 }, expect.any(Object));
    expect(screen.queryByLabelText('Weight in kg')).not.toBeInTheDocument();
  });

  it('holds the save button while the weight is being sent', async () => {
    const user = userEvent.setup();
    mockLog.isPending = true;
    await openDialog(user);

    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
  });

  // Logging is online-only: the card says why the button does nothing.
  it('cannot be opened offline, and says why', () => {
    mockOnline = false;
    render(<BodyweightCard />);

    expect(logButton()).toBeDisabled();
    expect(screen.getByText('Connect to log your weight.')).toBeInTheDocument();
  });

  it('says nothing about the network online', () => {
    render(<BodyweightCard />);

    expect(logButton()).toBeEnabled();
    expect(screen.queryByText('Connect to log your weight.')).not.toBeInTheDocument();
  });
});

describe('BodyweightCard — the weight', () => {
  // Saturday 17 October 2026, in the morning.
  const NOW = () => new Date(2026, 9, 17, 9, 0, 0);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW());
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const facts = (container) => container.querySelector('p.pk-caption')?.textContent ?? null;
  const sparkline = (container) => container.querySelector('svg');

  // The records' nudge scrolls to this title.
  it('is a section named by its title, which carries the id the nudge scrolls to', () => {
    render(<BodyweightCard />);
    const heading = screen.getByRole('heading', { level: 2, name: 'Bodyweight' });
    expect(heading).toHaveAttribute('id', BODYWEIGHT_HEADING_ID);
    expect(screen.getByRole('region', { name: 'Bodyweight' })).toContainElement(heading);
  });

  it('shows the last weigh-in, the change over the last six weeks and when it was weighed', () => {
    mockLogs = [
      { id: 'bw-4', weight_kg: '71.40', logged_on: '2026-10-17' },
      { id: 'bw-3', weight_kg: '71.80', logged_on: '2026-10-03' },
      // Six weeks before the last one: the start of the change.
      { id: 'bw-2', weight_kg: '72.20', logged_on: '2026-09-05' },
      // Older than six weeks: in no figure.
      { id: 'bw-1', weight_kg: '78.00', logged_on: '2026-08-20' },
    ];
    const { container } = render(<BodyweightCard />);

    expect(screen.getByText('71.4')).toBeInTheDocument();
    expect(screen.getByText('kg')).toBeInTheDocument();
    expect(facts(container)).toBe('-0.8\u00a0kg in 6 weeks, weighed today');
    // Drawn for the eye; one point per weigh-in of the window.
    expect(sparkline(container)).toHaveAttribute('aria-hidden', 'true');
    expect(sparkline(container).querySelector('polyline').getAttribute('points').split(' ')).toHaveLength(3);
  });

  it('signs a gain, and counts a single week in the singular', () => {
    mockLogs = [
      { id: 'bw-2', weight_kg: 80.5, logged_on: '2026-10-16' },
      { id: 'bw-1', weight_kg: 80, logged_on: '2026-10-09' },
    ];
    const { container } = render(<BodyweightCard />);
    expect(facts(container)).toBe('+0.5\u00a0kg in 1 week, weighed yesterday');
  });

  it('says the day of a weigh-in more than six days old', () => {
    mockLogs = [{ id: 'bw-1', weight_kg: 80, logged_on: '2026-10-01' }];
    const { container } = render(<BodyweightCard />);
    expect(facts(container)).toBe('weighed October 1');
  });

  it('draws no change and no line for a single weigh-in', () => {
    mockLogs = [{ id: 'bw-1', weight_kg: 80, logged_on: '2026-10-14' }];
    const { container } = render(<BodyweightCard />);
    expect(facts(container)).toBe('weighed 3 days ago');
    expect(sparkline(container)).toBeNull();
  });

  it('says no change that rounds to nothing', () => {
    mockLogs = [
      { id: 'bw-2', weight_kg: 80.02, logged_on: '2026-10-17' },
      { id: 'bw-1', weight_kg: 80, logged_on: '2026-10-10' },
    ];
    const { container } = render(<BodyweightCard />);
    expect(facts(container)).toBe('weighed today');
  });

  it('says when nothing was logged, and still offers to log', () => {
    mockLogs = [];
    const { container } = render(<BodyweightCard />);
    expect(screen.getByText('No weight logged yet.')).toBeInTheDocument();
    expect(sparkline(container)).toBeNull();
    expect(logButton()).toBeEnabled();
    fireEvent.click(logButton());
    expect(field()).toHaveValue('');
  });

  // `logged_on` is a bare calendar day: the day the athlete stepped on the
  // scale, wherever the device is. Read as midnight UTC, it is the evening
  // before west of Greenwich, and today's weigh-in said "yesterday".
  it.each(ZONES)('says a weigh-in of today is today (%s)', (zone) => {
    inTimeZone(zone, () => {
      vi.setSystemTime(NOW());
      mockLogs = [
        { id: 'bw-2', weight_kg: 80, logged_on: '2026-10-17' },
        { id: 'bw-1', weight_kg: 81, logged_on: '2026-10-03' },
      ];
      const { container, unmount } = render(<BodyweightCard />);
      expect(facts(container)).toBe('-1\u00a0kg in 2 weeks, weighed today');
      unmount();
    });
  });
});
