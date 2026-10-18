// The « ⋯ » of the exercise shown: the real menu, its sheet and the sheets it
// opens — the library picker and the question before a skip. The write is a
// double.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockSave = { mutate: vi.fn(), isPending: false };
vi.mock('../../hooks/useSlotDeviations', () => ({
  useSaveSlotDeviation: () => mockSave,
  useRequestPromote: () => ({ mutate: vi.fn(), isPending: false }),
}));

// The sheets are modal <dialog>s, opened with `showModal()` (polyfilled in
// src/test/setup.js). A closed one is not shown, so a query by role finds the
// open one only.
import ExerciseMenu from './ExerciseMenu';

const slot = { id: 'sl-1', exercise: { id: 'ex-orig', name: 'Back Squat', type: 'push' } };
const library = [
  { id: 'ex-orig', name: 'Back Squat', type: 'push' },
  { id: 'ex-2', name: 'Goblet Squat', type: 'push' },
  { id: 'ex-3', name: 'Leg Press', type: 'push' },
];

function renderMenu(props = {}) {
  return render(
    <ExerciseMenu
      sessionId="sess-1"
      slot={slot}
      name="Back Squat"
      exerciseLibrary={library}
      canDeviate
      canNote
      hasNote={false}
      onNote={vi.fn()}
      {...props}
    />,
  );
}

const trigger = () => screen.getByRole('button', { name: 'Exercise options' });

async function openMenu(user) {
  await user.click(trigger());
  return screen.getByRole('dialog', { name: 'Back Squat' });
}

async function choose(user, name) {
  const menu = await openMenu(user);
  await user.click(within(menu).getByRole('button', { name }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ExerciseMenu', () => {
  it('opens on the exercise, with replace, skip and the note, and writes nothing', async () => {
    const user = userEvent.setup();
    renderMenu();
    expect(screen.queryByRole('dialog')).toBeNull();

    const menu = await openMenu(user);

    expect(within(menu).getAllByRole('button').map((b) => b.textContent)).toEqual([
      '',
      'Replace the exercise',
      'Skip the exercise',
      'Add a note for the coach',
    ]);
    expect(mockSave.mutate).not.toHaveBeenCalled();
  });

  it('once the exercise is off the plan or its sets are locked, it offers the note only', async () => {
    const user = userEvent.setup();
    renderMenu({ canDeviate: false, hasNote: true });
    const menu = await openMenu(user);
    expect(within(menu).queryByRole('button', { name: 'Replace the exercise' })).toBeNull();
    expect(within(menu).queryByRole('button', { name: 'Skip the exercise' })).toBeNull();
    expect(within(menu).getByRole('button', { name: 'Edit the note' })).toBeInTheDocument();
  });

  it('with nothing to offer, there is no « ⋯ »', () => {
    const { container } = renderMenu({ canDeviate: false, canNote: false });
    expect(screen.queryByRole('button', { name: 'Exercise options' })).toBeNull();
    expect(container.querySelector('dialog[open]')).toBeNull();
  });

  it('the note item closes the menu and then opens the note, the focus back on the « ⋯ »', async () => {
    const user = userEvent.setup();
    const onNote = vi.fn(() => expect(screen.queryByRole('dialog')).toBeNull());
    renderMenu({ onNote });

    await choose(user, 'Add a note for the coach');

    expect(onNote).toHaveBeenCalledTimes(1);
    expect(trigger()).toHaveFocus();
  });

  it('closed without a choice, it does nothing', async () => {
    const user = userEvent.setup();
    const onNote = vi.fn();
    renderMenu({ onNote });
    await openMenu(user);

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onNote).not.toHaveBeenCalled();
    expect(trigger()).toHaveFocus();
  });

  // L12. A skip notifies the coach (bell and push) the moment it is written.
  describe('skipping the exercise asks first, and says the coach will be told', () => {
    const askSkip = async (user) => {
      await choose(user, 'Skip the exercise');
      return screen.getByRole('dialog', { name: 'Skip Back Squat?' });
    };

    it('the item opens the question and writes nothing', async () => {
      const user = userEvent.setup();
      renderMenu();

      const sheet = await askSkip(user);

      expect(mockSave.mutate).not.toHaveBeenCalled();
      expect(sheet).toHaveTextContent('Your coach will be told.');
    });

    it('the answer skips it, and the question closes', async () => {
      const user = userEvent.setup();
      renderMenu();
      const sheet = await askSkip(user);

      await user.click(within(sheet).getByRole('button', { name: 'Skip the exercise' }));

      expect(mockSave.mutate).toHaveBeenCalledTimes(1);
      expect(mockSave.mutate).toHaveBeenCalledWith({ sessionId: 'sess-1', slotId: 'sl-1', kind: 'skip' });
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('"Keep the exercise" writes nothing and closes it, the focus back on the « ⋯ »', async () => {
      const user = userEvent.setup();
      renderMenu();
      const sheet = await askSkip(user);

      await user.click(within(sheet).getByRole('button', { name: 'Keep the exercise' }));

      expect(mockSave.mutate).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(trigger()).toHaveFocus();
    });

    it('an exercise that could not be read is asked about without a name', async () => {
      const user = userEvent.setup();
      renderMenu({ slot: { id: 'sl-1', exercise: null }, name: 'Back Squat' });

      await choose(user, 'Skip the exercise');

      expect(screen.getByRole('dialog', { name: 'Skip this exercise?' })).toBeInTheDocument();
      expect(mockSave.mutate).not.toHaveBeenCalled();
    });
  });

  it('replaces it by a library exercise (not the prescribed one) through the picker, which closes', async () => {
    const user = userEvent.setup();
    renderMenu();
    await choose(user, 'Replace the exercise');
    const picker = screen.getByRole('dialog', { name: 'Replace the exercise' });
    expect(picker).toContainElement(document.activeElement);
    // The prescribed exercise is not offered as a substitute.
    expect(within(picker).queryByRole('button', { name: /Back Squat/i })).not.toBeInTheDocument();

    await user.click(within(picker).getByRole('button', { name: /Goblet Squat/i }));

    expect(mockSave.mutate).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      slotId: 'sl-1',
      kind: 'swap',
      substituteExerciseId: 'ex-2',
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger()).toHaveFocus();
  });

  describe('the picker', () => {
    const ARCHIVED = '2026-10-01T00:00:00Z';
    const withArchived = [
      ...library,
      { id: 'ex-4', name: 'Hack Squat', type: 'push', archived_at: ARCHIVED },
      { id: 'ex-5', name: 'Seated Row', type: 'pull', archived_at: null },
    ];

    async function openPicker(user) {
      await choose(user, 'Replace the exercise');
      return screen.getByRole('dialog', { name: 'Replace the exercise' });
    }

    it('does not offer an exercise the coach archived — with a search typed either', async () => {
      const user = userEvent.setup();
      renderMenu({ exerciseLibrary: withArchived });
      const picker = await openPicker(user);

      expect(within(picker).queryByText('Hack Squat')).not.toBeInTheDocument();
      // Active: no archived_at, or a row read before the column existed.
      expect(within(picker).getByRole('button', { name: /seated row/i })).toBeInTheDocument();
      expect(within(picker).getByRole('button', { name: /goblet squat/i })).toBeInTheDocument();

      await user.type(within(picker).getByRole('searchbox', { name: 'Search an exercise' }), 'hack');
      expect(within(picker).getByText('No exercise matches.')).toBeInTheDocument();
    });

    it('narrows the exercises to the search, and opens again without it', async () => {
      const user = userEvent.setup();
      renderMenu({ exerciseLibrary: withArchived });
      let picker = await openPicker(user);

      await user.type(within(picker).getByRole('searchbox', { name: 'Search an exercise' }), 'ROW');

      expect(within(picker).getByRole('button', { name: /seated row/i })).toBeInTheDocument();
      expect(within(picker).queryByRole('button', { name: /goblet squat/i })).not.toBeInTheDocument();

      await user.keyboard('{Escape}');
      picker = await openPicker(user);
      expect(within(picker).getByRole('searchbox', { name: 'Search an exercise' })).toHaveValue('');
    });

    it("draws each exercise's type with the shared badge, under its name in the app", async () => {
      const user = userEvent.setup();
      renderMenu({ exerciseLibrary: withArchived });
      const picker = await openPicker(user);

      // The badge: a mark of the type's chart colour before its name.
      const push = within(within(picker).getByRole('button', { name: /goblet squat/i })).getByText('Push');
      expect(push).toHaveClass('text-ink-2', 'shrink-0');
      expect(push.querySelector('[aria-hidden="true"]')).toHaveClass('bg-chart-push');
      const pull = within(within(picker).getByRole('button', { name: /seated row/i })).getByText('Pull');
      expect(pull.querySelector('[aria-hidden="true"]')).toHaveClass('bg-chart-pull');
      // The raw value of the enum is gone.
      expect(within(picker).queryByText('push')).not.toBeInTheDocument();
    });
  });

  // P68. jsdom lays nothing out: the 44 px are the class of a Parc control,
  // whose min-height (or size) is the target size.
  describe('every control is 44 px at least', () => {
    it('the « ⋯ » and the items of the menu', async () => {
      const user = userEvent.setup();
      renderMenu();
      expect(trigger()).toHaveClass('pk-icon-btn');
      const menu = await openMenu(user);
      for (const name of ['Replace the exercise', 'Skip the exercise', 'Add a note for the coach']) {
        expect(within(menu).getByRole('button', { name })).toHaveClass('pk-row');
      }
    });

    it('the exercises of the picker', async () => {
      const user = userEvent.setup();
      renderMenu();
      await choose(user, 'Replace the exercise');
      expect(screen.getByRole('button', { name: /goblet squat/i })).toHaveClass('pk-row');
    });
  });
});
