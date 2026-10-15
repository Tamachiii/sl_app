import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

let mockExercises = { data: [], isLoading: false };
const mockCreate = { mutate: vi.fn() };
const mockUpdate = { mutate: vi.fn() };
const mockDelete = { mutate: vi.fn() };

// The usage read behind the delete dialog, as a query that has answered since
// the dialog opened — the only kind the dialog acts on (it compares the
// query's timestamps with its own opening time; ExerciseDeleteDialog.test.jsx
// runs it on the real hook).
const usageQuery = (counts) => ({
  data: counts,
  isFetchedAfterMount: true,
  dataUpdatedAt: Number.MAX_SAFE_INTEGER,
  errorUpdatedAt: 0,
  isPaused: false,
  isFetching: false,
  refetch: vi.fn(),
});
const UNUSED = { slots: 0, goals: 0, swaps: 0 };
let mockUsage = usageQuery(UNUSED);
const mockUseExerciseUsage = vi.fn(() => mockUsage);

vi.mock('../../hooks/useExerciseLibrary', () => ({
  useExerciseLibrary: () => mockExercises,
  useCreateExercise: () => mockCreate,
  useUpdateExercise: () => mockUpdate,
  useDeleteExercise: () => mockDelete,
  useExerciseUsage: (id) => mockUseExerciseUsage(id),
}));

import ExerciseLibrary from './ExerciseLibrary';

function renderLibrary() {
  return render(
    <MemoryRouter>
      <ExerciseLibrary />
    </MemoryRouter>
  );
}

describe('ExerciseLibrary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExercises = {
      data: [
        { id: 'ex-1', name: 'Pull Up', type: 'pull', difficulty: 2, volume_weight: 1 },
        { id: 'ex-2', name: 'Dip', type: 'push', difficulty: 1, volume_weight: 1 },
      ],
      isLoading: false,
    };
    mockUsage = usageQuery(UNUSED);
  });

  it('renders loading spinner', () => {
    mockExercises = { data: undefined, isLoading: true };
    renderLibrary();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('renders empty state', () => {
    mockExercises = { data: [], isLoading: false };
    renderLibrary();
    expect(screen.getByText('No exercises yet')).toBeInTheDocument();
  });

  it('renders exercise list', () => {
    renderLibrary();
    expect(screen.getByText('Pull Up')).toBeInTheDocument();
    expect(screen.getByText('Dip')).toBeInTheDocument();
  });

  it('clicking "+ Add" shows the form', async () => {
    const user = userEvent.setup();
    renderLibrary();

    await user.click(screen.getByText('+ ADD'));
    expect(screen.getByPlaceholderText('Exercise name')).toBeInTheDocument();
    expect(screen.getByText('Create')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  it('submitting the add form calls createExercise', async () => {
    const user = userEvent.setup();
    mockCreate.mutate.mockImplementation((vals, opts) => opts?.onSuccess?.());
    renderLibrary();

    await user.click(screen.getByText('+ ADD'));
    await user.type(screen.getByPlaceholderText('Exercise name'), 'Muscle Up');
    await user.click(screen.getByText('Create'));

    expect(mockCreate.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Muscle Up' }),
      expect.any(Object)
    );
  });

  it('clicking Cancel hides the add form', async () => {
    const user = userEvent.setup();
    renderLibrary();

    await user.click(screen.getByText('+ ADD'));
    await user.click(screen.getByText('Cancel'));
    expect(screen.queryByPlaceholderText('Exercise name')).not.toBeInTheDocument();
  });

  it('clicking Edit on an exercise shows edit form', async () => {
    const user = userEvent.setup();
    renderLibrary();

    const editButtons = screen.getAllByRole('button', { name: /edit/i });
    await user.click(editButtons[0]);
    expect(screen.getByText('Save')).toBeInTheDocument();
  });

  describe('deleting an exercise', () => {
    const dialog = () => screen.getByRole('dialog');

    it('opens the app’s dialog for that exercise instead of the browser’s confirm', async () => {
      const user = userEvent.setup();
      const nativeConfirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      renderLibrary();

      // Nothing is asked about any exercise until one is picked.
      expect(mockUseExerciseUsage).not.toHaveBeenCalled();

      await user.click(screen.getByRole('button', { name: 'Delete Dip' }));
      expect(within(dialog()).getByRole('heading', { name: 'Delete "Dip"?' })).toBeInTheDocument();
      expect(mockUseExerciseUsage).toHaveBeenCalledWith('ex-2');
      // Opening is not deleting.
      expect(mockDelete.mutate).not.toHaveBeenCalled();
      expect(nativeConfirm).not.toHaveBeenCalled();
      nativeConfirm.mockRestore();
    });

    it('deletes an unused exercise once the dialog is confirmed, and closes', async () => {
      const user = userEvent.setup();
      renderLibrary();

      await user.click(screen.getByRole('button', { name: 'Delete Pull Up' }));
      await user.click(within(dialog()).getByRole('button', { name: 'Delete' }));
      expect(mockDelete.mutate).toHaveBeenCalledTimes(1);
      expect(mockDelete.mutate).toHaveBeenCalledWith('ex-1');
      expect(screen.queryByRole('heading', { name: 'Delete "Pull Up"?' })).not.toBeInTheDocument();
    });

    it('Cancel deletes nothing', async () => {
      const user = userEvent.setup();
      renderLibrary();

      await user.click(screen.getByRole('button', { name: 'Delete Pull Up' }));
      await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
      expect(mockDelete.mutate).not.toHaveBeenCalled();
      expect(screen.queryByRole('heading', { name: 'Delete "Pull Up"?' })).not.toBeInTheDocument();
    });

    // Finding L7: the old confirm() said nothing about the goals a delete
    // would take with it.
    it('shows the slots and goals that use the exercise, and cannot delete it', async () => {
      const user = userEvent.setup();
      mockUsage = usageQuery({ slots: 12, goals: 2, swaps: 0 });
      renderLibrary();

      await user.click(screen.getByRole('button', { name: 'Delete Pull Up' }));
      const open = within(dialog());
      expect(open.getByRole('status')).toHaveTextContent('It is in use, so it cannot be deleted.');
      expect(open.getByText('Prescribed in sessions').nextSibling).toHaveTextContent('12');
      expect(open.getByText('Goals set on it').nextSibling).toHaveTextContent('2');
      expect(open.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();

      await user.click(open.getByRole('button', { name: 'OK' }));
      expect(mockDelete.mutate).not.toHaveBeenCalled();
    });
  });

  it('shows search bar and type filter pills when exercises exist', () => {
    renderLibrary();
    expect(screen.getByRole('searchbox', { name: /search exercises/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^all$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^pull$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^push$/i })).toBeInTheDocument();
  });

  it('search filters the list by name', async () => {
    const user = userEvent.setup();
    renderLibrary();

    await user.type(screen.getByRole('searchbox', { name: /search exercises/i }), 'pull');
    expect(screen.getByText('Pull Up')).toBeInTheDocument();
    expect(screen.queryByText('Dip')).not.toBeInTheDocument();
  });

  it('shows empty state when search has no matches', async () => {
    const user = userEvent.setup();
    renderLibrary();

    await user.type(screen.getByRole('searchbox', { name: /search exercises/i }), 'zzz');
    expect(screen.getByText(/no exercises match/i)).toBeInTheDocument();
  });

  it('type filter pill filters the list', async () => {
    const user = userEvent.setup();
    renderLibrary();

    await user.click(screen.getByRole('button', { name: /^push$/i }));
    expect(screen.queryByText('Pull Up')).not.toBeInTheDocument();
    expect(screen.getByText('Dip')).toBeInTheDocument();
  });

  it('active filter pill has aria-pressed=true', async () => {
    const user = userEvent.setup();
    renderLibrary();

    const pullBtn = screen.getByRole('button', { name: /^pull$/i });
    await user.click(pullBtn);
    expect(pullBtn).toHaveAttribute('aria-pressed', 'true');
  });

  it('does not show search bar when library is empty', () => {
    mockExercises = { data: [], isLoading: false };
    renderLibrary();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  });

  it('add form threads a chosen load_mode into createExercise', async () => {
    const user = userEvent.setup();
    mockCreate.mutate.mockImplementation((vals, opts) => opts?.onSuccess?.());
    renderLibrary();

    await user.click(screen.getByText('+ ADD'));
    await user.type(screen.getByPlaceholderText('Exercise name'), 'Weighted Pull-up');
    // Selects in order: type, difficulty, loading mode.
    const selects = screen.getAllByRole('combobox');
    await user.selectOptions(selects[2], 'added');
    await user.click(screen.getByText('Create'));

    expect(mockCreate.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Weighted Pull-up', load_mode: 'added' }),
      expect.any(Object),
    );
  });

  it('unclassified exercises submit load_mode: null', async () => {
    const user = userEvent.setup();
    mockCreate.mutate.mockImplementation((vals, opts) => opts?.onSuccess?.());
    renderLibrary();
    await user.click(screen.getByText('+ ADD'));
    await user.type(screen.getByPlaceholderText('Exercise name'), 'Row');
    await user.click(screen.getByText('Create'));
    expect(mockCreate.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ load_mode: null }),
      expect.any(Object),
    );
  });

  it('tags a classified exercise on its meta row', () => {
    mockExercises = {
      data: [{ id: 'ex-3', name: 'Weighted Dip', type: 'push', difficulty: 2, volume_weight: 1, load_mode: 'added' }],
      isLoading: false,
    };
    renderLibrary();
    expect(screen.getByText(/\+BW/)).toBeInTheDocument();
  });

  // Review item L15 and live finding N18: the filter pills were 23px tall,
  // "+ Add" 32px, and "edit" and "del" two words 4px apart, "del" 29×16. jsdom
  // lays nothing out (src/test/hitTargets.test.js holds the classes to 44px).
  // Review finding L9 (P31): the volume weight was a `type="number"` field read
  // with Number(). "0,5" was 5 in an English Chromium and "" in WebKit, and
  // Number("") sent 0. It is a text field read by parseDecimalInput now; the
  // form is submitted by clicking Create or Save, so its validation runs.
  describe('the volume weight', () => {
    async function openAddForm(user) {
      await user.click(screen.getByText('+ ADD'));
      await user.type(screen.getByPlaceholderText('Exercise name'), 'Muscle Up');
      return screen.getByLabelText('Volume weight');
    }

    it('is a text field with the decimal keypad, starting at 1', async () => {
      const user = userEvent.setup();
      renderLibrary();
      const field = await openAddForm(user);
      expect(field).toHaveAttribute('type', 'text');
      expect(field).toHaveAttribute('inputmode', 'decimal');
      expect(field).toHaveValue('1');
    });

    it.each(['0,5', '0.5'])('"%s" creates the exercise with 0.5', async (text) => {
      const user = userEvent.setup();
      renderLibrary();
      const field = await openAddForm(user);
      await user.clear(field);
      await user.type(field, text);
      await user.click(screen.getByRole('button', { name: 'Create' }));
      expect(mockCreate.mutate).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Muscle Up', volume_weight: 0.5 }),
        expect.any(Object),
      );
    });

    // Not a number: the field's pattern stops the submit, as the browser does.
    it.each(['abc', '0,5x', ''])('"%s" creates nothing', async (text) => {
      const user = userEvent.setup();
      renderLibrary();
      const field = await openAddForm(user);
      await user.clear(field);
      if (text) await user.type(field, text);
      await user.click(screen.getByRole('button', { name: 'Create' }));
      expect(mockCreate.mutate).not.toHaveBeenCalled();
      expect(screen.getByPlaceholderText('Exercise name')).toBeInTheDocument();
    });

    // A number, out of the range: refused by the form, which says why.
    it.each(['0', '0,05', '100'])('"%s" creates nothing and says the range', async (text) => {
      const user = userEvent.setup();
      renderLibrary();
      const field = await openAddForm(user);
      await user.clear(field);
      await user.type(field, text);
      await user.click(screen.getByRole('button', { name: 'Create' }));
      expect(mockCreate.mutate).not.toHaveBeenCalled();
      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent('Enter a number from 0.1 to 99.99');
      expect(field).toHaveAttribute('aria-invalid', 'true');
      expect(field).toHaveAttribute('aria-describedby', alert.id);

      // Typing again takes the alert away; a good value then goes.
      await user.clear(field);
      await user.type(field, '1,5');
      expect(screen.queryByRole('alert')).toBeNull();
      await user.click(screen.getByRole('button', { name: 'Create' }));
      expect(mockCreate.mutate).toHaveBeenCalledWith(
        expect.objectContaining({ volume_weight: 1.5 }),
        expect.any(Object),
      );
    });

    it('the edit form starts from the stored value as text, and saves what is typed', async () => {
      const user = userEvent.setup();
      mockExercises = {
        data: [{ id: 'ex-1', name: 'Pull Up', type: 'pull', difficulty: 2, volume_weight: '1.50' }],
        isLoading: false,
      };
      renderLibrary();
      await user.click(screen.getByRole('button', { name: /edit/i }));
      const field = screen.getByLabelText('Volume weight');
      expect(field).toHaveValue('1.5');
      await user.clear(field);
      await user.type(field, '0,75');
      await user.click(screen.getByRole('button', { name: 'Save' }));
      expect(mockUpdate.mutate).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'ex-1', volume_weight: 0.75 }),
        expect.any(Object),
      );
    });
  });

  describe('44px targets', () => {
    it('filter pills are pill buttons', () => {
      renderLibrary();
      for (const name of [/^all$/i, /^pull$/i, /^push$/i]) {
        expect(screen.getByRole('button', { name })).toHaveClass('sl-pill', 'sl-pill-btn');
      }
    });

    it('edit and delete are two 44px boxes on every exercise', () => {
      renderLibrary();
      for (const name of ['Edit Pull Up', 'Delete Pull Up', 'Edit Dip', 'Delete Dip']) {
        const button = screen.getByRole('button', { name });
        expect(button).toHaveClass('min-h-11', 'min-w-11');
        expect(button).not.toHaveClass('px-1');
      }
    });

    it('+ Add, and the two buttons of its form, are 44px tall', async () => {
      const user = userEvent.setup();
      renderLibrary();
      const add = screen.getByRole('button', { name: '+ ADD' });
      expect(add).toHaveClass('min-h-11');
      await user.click(add);
      expect(screen.getByRole('button', { name: 'Create' })).toHaveClass('min-h-11');
      expect(screen.getByRole('button', { name: 'Cancel' })).toHaveClass('min-h-11');
    });
  });
});
