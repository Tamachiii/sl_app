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

// The picker and the question are Parc sheets: modal <dialog>s, opened with
// `showModal()` (polyfilled in src/test/setup.js). A closed one is not shown,
// so a query by role finds the open one only.
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

const replaceButton = () => screen.getByRole('button', { name: 'Replace' });
const skipButton = () => screen.getByRole('button', { name: 'Skip' });

beforeEach(() => {
  vi.clearAllMocks();
  network.online = true;
});

describe('SlotDeviationBar', () => {
  it('offers Replace and Skip while the exercise is as planned', () => {
    renderBar();
    expect(replaceButton()).toBeInTheDocument();
    expect(skipButton()).toBeInTheDocument();
    // Nothing is asked or open yet.
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  // L12. A skip notifies the coach (bell and push) the moment it is written,
  // and the Skip pill wrote it at the first tap.
  describe('skipping the exercise asks first, and says the coach will be told', () => {
    const askSkip = async (user) => {
      await user.click(skipButton());
      return screen.getByRole('dialog', { name: 'Skip Back Squat?' });
    };

    it('the button opens the question and writes nothing', async () => {
      const user = userEvent.setup();
      renderBar();

      const sheet = await askSkip(user);

      expect(mockSave.mutate).not.toHaveBeenCalled();
      expect(sheet).toHaveTextContent('Your coach will be told.');
    });

    it('the answer skips it, and the question closes', async () => {
      const user = userEvent.setup();
      renderBar();
      const sheet = await askSkip(user);

      await user.click(within(sheet).getByRole('button', { name: 'Skip the exercise' }));

      expect(mockSave.mutate).toHaveBeenCalledTimes(1);
      expect(mockSave.mutate).toHaveBeenCalledWith({ sessionId: 'sess-1', slotId: 'sl-1', kind: 'skip' });
      expect(screen.queryByRole('dialog', { name: 'Skip Back Squat?' })).not.toBeInTheDocument();
    });

    it('"Keep the exercise" writes nothing and closes it', async () => {
      const user = userEvent.setup();
      renderBar();
      const sheet = await askSkip(user);

      await user.click(within(sheet).getByRole('button', { name: 'Keep the exercise' }));

      expect(mockSave.mutate).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog', { name: 'Skip Back Squat?' })).not.toBeInTheDocument();
    });

    it('an exercise that could not be read is asked about without a name', async () => {
      const user = userEvent.setup();
      renderBar({ slot: { id: 'sl-1', exercise: null } });

      await user.click(skipButton());

      expect(screen.getByRole('dialog', { name: 'Skip this exercise?' })).toBeInTheDocument();
      expect(mockSave.mutate).not.toHaveBeenCalled();
    });
  });

  it('replaces it by a library exercise (not the prescribed one) through the picker, which closes', async () => {
    const user = userEvent.setup();
    renderBar();
    await user.click(replaceButton());
    const picker = screen.getByRole('dialog', { name: 'Replace the exercise' });
    // The prescribed exercise is not offered as a substitute.
    expect(within(picker).queryByRole('button', { name: /Back Squat/i })).not.toBeInTheDocument();

    await user.click(within(picker).getByRole('button', { name: /Goblet Squat/i }));

    expect(mockSave.mutate).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      slotId: 'sl-1',
      kind: 'swap',
      substituteExerciseId: 'ex-2',
    });
    expect(screen.queryByRole('dialog', { name: 'Replace the exercise' })).not.toBeInTheDocument();
  });

  describe('the picker', () => {
    const ARCHIVED = '2026-10-01T00:00:00Z';
    const withArchived = [
      ...library,
      { id: 'ex-4', name: 'Hack Squat', type: 'push', archived_at: ARCHIVED },
      { id: 'ex-5', name: 'Seated Row', type: 'pull', archived_at: null },
    ];

    it('does not offer an exercise the coach archived — with a search typed either', async () => {
      const user = userEvent.setup();
      renderBar({ exerciseLibrary: withArchived });
      await user.click(replaceButton());
      const picker = screen.getByRole('dialog', { name: 'Replace the exercise' });

      expect(within(picker).queryByText('Hack Squat')).not.toBeInTheDocument();
      // Active: no archived_at, or a row read before the column existed.
      expect(within(picker).getByRole('button', { name: /seated row/i })).toBeInTheDocument();
      expect(within(picker).getByRole('button', { name: /goblet squat/i })).toBeInTheDocument();

      await user.type(within(picker).getByRole('searchbox', { name: 'Search an exercise' }), 'hack');
      expect(within(picker).getByText('No exercise matches.')).toBeInTheDocument();
    });

    it('narrows the exercises to the search', async () => {
      const user = userEvent.setup();
      renderBar({ exerciseLibrary: withArchived });
      await user.click(replaceButton());
      const picker = screen.getByRole('dialog', { name: 'Replace the exercise' });

      await user.type(within(picker).getByRole('searchbox', { name: 'Search an exercise' }), 'ROW');

      expect(within(picker).getByRole('button', { name: /seated row/i })).toBeInTheDocument();
      expect(within(picker).queryByRole('button', { name: /goblet squat/i })).not.toBeInTheDocument();
    });

    it('a swap to an exercise archived since keeps its name', () => {
      renderBar({
        exerciseLibrary: withArchived,
        deviation: { exercise_slot_id: 'sl-1', kind: 'swap', substitute_exercise_id: 'ex-4' },
      });
      expect(screen.getByText('You do Hack Squat instead.')).toBeInTheDocument();
    });

    it("draws each exercise's type with the shared badge, under its name in the app", async () => {
      const user = userEvent.setup();
      renderBar({ exerciseLibrary: withArchived });
      await user.click(replaceButton());
      const picker = screen.getByRole('dialog', { name: 'Replace the exercise' });

      const push = within(within(picker).getByRole('button', { name: /goblet squat/i })).getByText('Push');
      expect(push).toHaveClass('sl-pill', 'bg-push/15', 'text-push', 'shrink-0');
      const pull = within(within(picker).getByRole('button', { name: /seated row/i })).getByText('Pull');
      expect(pull).toHaveClass('sl-pill', 'bg-pull/15', 'text-pull');
      // The raw value of the enum is gone.
      expect(within(picker).queryByText('push')).not.toBeInTheDocument();
    });

    it('a pick still swaps', async () => {
      const user = userEvent.setup();
      renderBar({ exerciseLibrary: withArchived });
      await user.click(replaceButton());
      await user.click(screen.getByRole('button', { name: /seated row/i }));
      expect(mockSave.mutate).toHaveBeenCalledWith({
        sessionId: 'sess-1',
        slotId: 'sl-1',
        kind: 'swap',
        substituteExerciseId: 'ex-5',
      });
    });
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

    await user.click(within(picker).getByRole('button', { name: /goblet squat/i }));

    expect(mockSave.mutate).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      slotId: 'sl-1',
      kind: 'swap',
      substituteExerciseId: 'ex-2',
    });
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

  it('renders nothing when locked and as planned', () => {
    const { container } = renderBar({ locked: true });
    expect(container).toBeEmptyDOMElement();
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
  // whose min-height is the target size, and the 60 px of a list row.
  describe('every button is 44 px tall at least', () => {
    it('Replace and Skip', () => {
      renderBar();
      expect(replaceButton()).toHaveClass('pk-btn');
      expect(skipButton()).toHaveClass('pk-btn');
    });

    it('Change, Back to the plan and the request to the coach on a swap', () => {
      renderBar({ deviation: SWAP });
      for (const name of ['Change', 'Back to the plan', 'Ask your coach to keep this change']) {
        expect(screen.getByRole('button', { name })).toHaveClass('pk-btn');
      }
    });

    it('the exercises of the picker', async () => {
      const user = userEvent.setup();
      renderBar();
      await user.click(replaceButton());
      expect(screen.getByRole('button', { name: /goblet squat/i })).toHaveClass('pk-row');
    });
  });
});
