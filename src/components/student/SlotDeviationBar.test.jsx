import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockSave = { mutate: vi.fn(), isPending: false };
vi.mock('../../hooks/useSlotDeviations', () => ({
  useSaveSlotDeviation: () => mockSave,
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

  it('skips the exercise', async () => {
    const user = userEvent.setup();
    renderBar();
    await user.click(screen.getByRole('button', { name: /^skip$/i }));
    expect(mockSave.mutate).toHaveBeenCalledWith({ sessionId: 'sess-1', slotId: 'sl-1', kind: 'skip' });
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
});
