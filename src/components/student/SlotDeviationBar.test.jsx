import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockSave = { mutate: vi.fn(), isPending: false };
const mockRequestPromote = { mutate: vi.fn(), isPending: false };
vi.mock('../../hooks/useSlotDeviations', () => ({
  useSaveSlotDeviation: () => mockSave,
  useRequestPromote: () => mockRequestPromote,
}));
const network = { online: true };
vi.mock('../../hooks/useOnlineStatus', () => ({
  useOnlineStatus: () => network.online,
}));

// The picker is a Parc sheet: a modal <dialog>, opened with `showModal()`
// (polyfilled in src/test/setup.js). A closed one is not shown, so a query by
// role finds the open one only. The way off the plan — Replace, Skip — is in
// the exercise's menu: ExerciseMenu.test.jsx.
import SlotDeviationBar from './SlotDeviationBar';

const slot = { id: 'sl-1', exercise: { id: 'ex-orig', name: 'Back Squat', type: 'push' } };
const library = [
  { id: 'ex-orig', name: 'Back Squat', type: 'push' },
  { id: 'ex-2', name: 'Goblet Squat', type: 'push' },
  { id: 'ex-3', name: 'Leg Press', type: 'push' },
];
const SWAP = { exercise_slot_id: 'sl-1', kind: 'swap', substitute_exercise_id: 'ex-3' };
const SKIP = { exercise_slot_id: 'sl-1', kind: 'skip', substitute_exercise_id: null };

function renderBar(props = {}) {
  return render(
    <SlotDeviationBar sessionId="sess-1" slot={slot} exerciseLibrary={library} deviation={null} {...props} />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  network.online = true;
});

describe('SlotDeviationBar', () => {
  it('renders nothing while the exercise is as planned, locked or not', () => {
    const { container, rerender } = renderBar();
    expect(container).toBeEmptyDOMElement();
    rerender(<SlotDeviationBar sessionId="sess-1" slot={slot} exerciseLibrary={library} deviation={null} locked />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the active swap with the substitute name, and "Back to the plan" clears it', async () => {
    const user = userEvent.setup();
    renderBar({ deviation: SWAP });
    expect(screen.getByText('You do Leg Press instead.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back to the plan' }));
    expect(mockSave.mutate).toHaveBeenCalledWith({ sessionId: 'sess-1', slotId: 'sl-1', kind: null });
  });

  it('"Change" on an active swap opens the picker again, and a pick replaces the substitute', async () => {
    const user = userEvent.setup();
    renderBar({ deviation: SWAP });
    await user.click(screen.getByRole('button', { name: 'Change' }));
    const picker = screen.getByRole('dialog', { name: 'Replace the exercise' });
    // The prescribed exercise is not offered as a substitute.
    expect(within(picker).queryByRole('button', { name: /Back Squat/i })).not.toBeInTheDocument();

    await user.click(within(picker).getByRole('button', { name: /goblet squat/i }));

    expect(mockSave.mutate).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      slotId: 'sl-1',
      kind: 'swap',
      substituteExerciseId: 'ex-2',
    });
    expect(screen.queryByRole('dialog', { name: 'Replace the exercise' })).not.toBeInTheDocument();
  });

  it('a swap to an exercise archived since keeps its name', () => {
    renderBar({
      exerciseLibrary: [...library, { id: 'ex-4', name: 'Hack Squat', type: 'push', archived_at: '2026-10-01T00:00:00Z' }],
      deviation: { exercise_slot_id: 'sl-1', kind: 'swap', substitute_exercise_id: 'ex-4' },
    });
    expect(screen.getByText('You do Hack Squat instead.')).toBeInTheDocument();
  });

  it('a substitute that is not in the library is "another exercise"', () => {
    renderBar({ deviation: { ...SWAP, substitute_exercise_id: 'ex-gone' } });
    expect(screen.getByText('You do another exercise instead.')).toBeInTheDocument();
  });

  it('shows the active skip, with its way back and no "Change"', () => {
    renderBar({ deviation: SKIP });
    expect(screen.getByText('You skipped this exercise.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to the plan' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change' })).not.toBeInTheDocument();
  });

  // A swap or a skip made in a session that is now confirmed or read-only is
  // still said: the panel shows the substitute's figures. Nothing changes it.
  it('locked with a swap: says it, and offers no way to change it or to ask the coach', () => {
    renderBar({ deviation: SWAP, locked: true });
    expect(screen.getByText('You do Leg Press instead.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('lets the athlete ask the coach to make a deviation the standing plan', async () => {
    const user = userEvent.setup();
    renderBar({ deviation: SWAP });
    await user.click(screen.getByRole('button', { name: 'Ask your coach to keep this change' }));
    expect(mockRequestPromote.mutate).toHaveBeenCalledWith({ sessionId: 'sess-1', slotId: 'sl-1' });
  });

  // The request is online-only (useRequestPromote is not a queued write).
  it('offline: no request to the coach is offered', () => {
    network.online = false;
    renderBar({ deviation: SWAP });
    expect(screen.queryByRole('button', { name: 'Ask your coach to keep this change' })).not.toBeInTheDocument();
    // The way back is a queued write: it stays.
    expect(screen.getByRole('button', { name: 'Back to the plan' })).toBeInTheDocument();
  });

  it('shows the requested state (no ask button) once a request is pending', () => {
    renderBar({ deviation: { ...SWAP, promote_requested_at: '2026-04-26T09:00:00Z' } });
    expect(screen.getByText('You asked your coach to keep this change.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ask your coach to keep this change' })).not.toBeInTheDocument();
  });

  // P68. jsdom lays nothing out: the 44 px are the class of a Parc button,
  // whose min-height is the target size.
  it('Change, Back to the plan and the request to the coach on a swap are 44 px tall at least', () => {
    renderBar({ deviation: SWAP });
    for (const name of ['Change', 'Back to the plan', 'Ask your coach to keep this change']) {
      expect(screen.getByRole('button', { name })).toHaveClass('pk-btn');
    }
  });
});
