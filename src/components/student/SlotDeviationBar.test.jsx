import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockSave = { mutate: vi.fn(), isPending: false };
const mockRequestPromote = { mutate: vi.fn(), isPending: false };
vi.mock('../../hooks/useSlotDeviations', () => ({
  useSaveSlotDeviation: () => mockSave,
  useRequestPromote: () => mockRequestPromote,
}));
vi.mock('../../hooks/useOnlineStatus', () => ({
  useOnlineStatus: () => true,
}));

// Render the dialog inline when open so the picker is queryable.
vi.mock('../ui/Dialog', () => ({
  default: ({ open, title, children }) => (open ? <div role="dialog" aria-label={title}>{children}</div> : null),
}));

import SlotDeviationBar from './SlotDeviationBar';

const slot = { id: 'sl-1', exercise: { id: 'ex-orig', name: 'Back Squat', type: 'push' } };
const library = [
  { id: 'ex-orig', name: 'Back Squat', type: 'push' },
  { id: 'ex-2', name: 'Goblet Squat', type: 'push' },
  { id: 'ex-3', name: 'Leg Press', type: 'push' },
];

function renderBar(props = {}) {
  return render(
    <SlotDeviationBar sessionId="sess-1" slot={slot} exerciseLibrary={library} deviation={null} {...props} />,
  );
}

beforeEach(() => vi.clearAllMocks());

describe('SlotDeviationBar', () => {
  it('offers Swap and Skip actions when on-plan', () => {
    renderBar();
    expect(screen.getByRole('button', { name: /^swap$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^skip$/i })).toBeInTheDocument();
  });

  // L12. A skip notifies the coach (bell and push) the moment it is written,
  // and the Skip pill wrote it at the first tap.
  describe('skipping the exercise asks first, and says the coach will be told', () => {
    const askSkip = async (user) => {
      await user.click(screen.getByRole('button', { name: /^skip$/i }));
      return screen.getByRole('dialog', { name: 'Skip Back Squat?' });
    };

    it('the pill opens the question and writes nothing', async () => {
      const user = userEvent.setup();
      renderBar();

      const dialog = await askSkip(user);

      expect(mockSave.mutate).not.toHaveBeenCalled();
      expect(dialog).toHaveTextContent('Your coach will be notified.');
    });

    it('the answer skips it', async () => {
      const user = userEvent.setup();
      renderBar();
      const dialog = await askSkip(user);

      await user.click(within(dialog).getByRole('button', { name: /^skip exercise$/i }));

      expect(mockSave.mutate).toHaveBeenCalledTimes(1);
      expect(mockSave.mutate).toHaveBeenCalledWith({ sessionId: 'sess-1', slotId: 'sl-1', kind: 'skip' });
      expect(screen.queryByRole('dialog', { name: 'Skip Back Squat?' })).not.toBeInTheDocument();
    });

    it('Cancel writes nothing and closes it', async () => {
      const user = userEvent.setup();
      renderBar();
      const dialog = await askSkip(user);

      await user.click(within(dialog).getByRole('button', { name: /^cancel$/i }));

      expect(mockSave.mutate).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog', { name: 'Skip Back Squat?' })).not.toBeInTheDocument();
    });

    it('an exercise that could not be read is asked about without a name', async () => {
      const user = userEvent.setup();
      renderBar({ slot: { id: 'sl-1', exercise: null } });

      await user.click(screen.getByRole('button', { name: /^skip$/i }));

      expect(screen.getByRole('dialog', { name: 'Skip this exercise?' })).toBeInTheDocument();
      expect(mockSave.mutate).not.toHaveBeenCalled();
    });
  });

  it('swaps to a library exercise (excluding the prescribed one) via the picker', async () => {
    const user = userEvent.setup();
    renderBar();
    await user.click(screen.getByRole('button', { name: /^swap$/i }));
    // The prescribed exercise is not offered as a substitute.
    expect(screen.queryByRole('button', { name: /Back Squat/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Goblet Squat/i }));
    expect(mockSave.mutate).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      slotId: 'sl-1',
      kind: 'swap',
      substituteExerciseId: 'ex-2',
    });
  });

  it('shows the active swap with the substitute name and clears it on Undo', async () => {
    const user = userEvent.setup();
    renderBar({ deviation: { exercise_slot_id: 'sl-1', kind: 'swap', substitute_exercise_id: 'ex-3' } });
    expect(screen.getByText('Leg Press')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^undo$/i }));
    expect(mockSave.mutate).toHaveBeenCalledWith({ sessionId: 'sess-1', slotId: 'sl-1', kind: null });
  });

  it('shows the active skip state', () => {
    renderBar({ deviation: { exercise_slot_id: 'sl-1', kind: 'skip', substitute_exercise_id: null } });
    expect(screen.getByText(/skipped this exercise/i)).toBeInTheDocument();
  });

  it('renders nothing actionable when locked and on-plan', () => {
    const { container } = renderBar({ locked: true });
    expect(container).toBeEmptyDOMElement();
  });

  it('lets the student ask the coach to make a deviation permanent', async () => {
    const user = userEvent.setup();
    renderBar({ deviation: { exercise_slot_id: 'sl-1', kind: 'swap', substitute_exercise_id: 'ex-3' } });
    await user.click(screen.getByRole('button', { name: /make this permanent/i }));
    expect(mockRequestPromote.mutate).toHaveBeenCalledWith({ sessionId: 'sess-1', slotId: 'sl-1' });
  });

  // P68. jsdom lays nothing out: the 44 px are the `sl-pill-btn` class.
  describe('every button is 44 px tall', () => {
    it('Swap and Skip', () => {
      renderBar();
      for (const name of [/^swap$/i, /^skip$/i]) {
        expect(screen.getByRole('button', { name })).toHaveClass('sl-pill', 'sl-pill-btn');
      }
    });

    it('Change, Undo and "make this permanent" on a swap', () => {
      renderBar({ deviation: { exercise_slot_id: 'sl-1', kind: 'swap', substitute_exercise_id: 'ex-3' } });
      for (const name of [/^change$/i, /^undo$/i, /make this permanent/i]) {
        expect(screen.getByRole('button', { name })).toHaveClass('sl-pill', 'sl-pill-btn');
      }
    });

    it('the exercises of the picker', async () => {
      const user = userEvent.setup();
      renderBar();
      await user.click(screen.getByRole('button', { name: /^swap$/i }));
      expect(screen.getByRole('button', { name: /goblet squat/i })).toHaveClass('min-h-11');
    });
  });

  it('shows the requested state (no ask button) once a promote is pending', () => {
    renderBar({
      deviation: {
        exercise_slot_id: 'sl-1', kind: 'swap', substitute_exercise_id: 'ex-3',
        promote_requested_at: '2026-04-26T09:00:00Z',
      },
    });
    expect(screen.getByText(/Asked your coach/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /make this permanent/i })).not.toBeInTheDocument();
  });
});
