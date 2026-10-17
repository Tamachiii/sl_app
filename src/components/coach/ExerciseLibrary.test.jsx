import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

let mockExercises = { data: [], isLoading: false };
let mockCreate = { mutate: vi.fn(), isPending: false };
const mockUpdate = { mutate: vi.fn() };
const mockDelete = { mutate: vi.fn() };
let mockArchive = { mutate: vi.fn(), isPending: false, variables: undefined };

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

// The real module underneath, for `isActiveExercise`: what the page counts
// as archived must be what the pickers count.
vi.mock('../../hooks/useExerciseLibrary', async () => ({
  ...(await vi.importActual('../../hooks/useExerciseLibrary')),
  useExerciseLibrary: () => mockExercises,
  useCreateExercise: () => mockCreate,
  useUpdateExercise: () => mockUpdate,
  useArchiveExercise: () => mockArchive,
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

// The page's controls: the round "+" of its LargeTitle, the SearchField and
// the type chips above the list, the grouped list itself.
const addButton = () => screen.getByRole('button', { name: 'Add an exercise' });
const searchBox = () => screen.getByRole('searchbox', { name: 'Search an exercise' });
const filters = () => within(screen.getByRole('group', { name: 'Filter by type' }));
const exerciseList = () => screen.getByRole('list', { name: 'Exercises' });
// The row of an exercise on offer, and the coloured mark of its caption.
const rowOf = (name) => within(exerciseList()).getByText(name).closest('li');
const markOf = (name) => rowOf(name).querySelector('.pk-caption [aria-hidden="true"]');

// An exercise's ⋯ opens a sheet named by the exercise, which holds what can be
// done to it: edit, archive, delete.
async function openOptions(user, name) {
  await user.click(screen.getByRole('button', { name: `Options for ${name}` }));
  return screen.getByRole('dialog', { name });
}

// ⋯ → "Delete {name}": the options give way to the delete dialog.
async function askToDelete(user, name) {
  const options = await openOptions(user, name);
  await user.click(within(options).getByRole('button', { name: `Delete ${name}` }));
  return screen.getByRole('dialog', { name: `Delete ${name}?` });
}

const newSheet = () => screen.getByRole('dialog', { name: 'New exercise' });
const editSheet = () => screen.getByRole('dialog', { name: 'Edit the exercise' });

// The "Close" written at the foot of the delete dialog — the sheet's round
// close button has the same name and no text.
const footClose = (sheet) => within(sheet).getByText('Keep the exercise', { selector: 'button' });

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
    mockCreate = { mutate: vi.fn(), isPending: false };
    mockUsage = usageQuery(UNUSED);
    mockArchive = { mutate: vi.fn(), isPending: false, variables: undefined };
  });

  it('renders loading spinner, and counts nothing it has not read', () => {
    mockExercises = { data: undefined, isLoading: true };
    renderLibrary();
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Library' })).toBeInTheDocument();
    expect(screen.queryByText(/^\d+ exercises?/)).toBeNull();
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('renders empty state', () => {
    mockExercises = { data: [], isLoading: false };
    renderLibrary();
    expect(screen.getByText('No exercise yet. Create the first one with the plus button.')).toBeInTheDocument();
    expect(screen.getByText('0 exercises')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Exercises' })).toBeNull();
  });

  it('renders exercise list, counted under the title', () => {
    renderLibrary();
    expect(screen.getByRole('heading', { level: 1, name: 'Library' })).toBeInTheDocument();
    expect(screen.getByText('2 exercises')).toBeInTheDocument();
    const names = within(exerciseList())
      .getAllByRole('listitem')
      .map((row) => row.querySelector('.pk-headline').textContent);
    expect(names).toEqual(['Pull Up', 'Dip']);
  });

  it('clicking "Add an exercise" opens the form in a sheet', async () => {
    const user = userEvent.setup();
    renderLibrary();

    await user.click(addButton());
    const sheet = within(newSheet());
    expect(sheet.getByRole('textbox', { name: 'Name of the exercise' })).toHaveValue('');
    expect(sheet.getByRole('button', { name: 'Create the exercise' })).toHaveAttribute('type', 'submit');
    expect(sheet.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    // What a new exercise starts as: pull, difficulty 1, its load not set.
    const pressed = (group) =>
      within(sheet.getByRole('group', { name: group }))
        .getAllByRole('button')
        .filter((b) => b.getAttribute('aria-pressed') === 'true')
        .map((b) => b.textContent);
    expect(pressed('Type')).toEqual(['Pull']);
    expect(pressed('Difficulty')).toEqual(['1']);
    expect(pressed('Load')).toEqual(['Not set']);
    expect(sheet.getByText('How a logged weight counts toward the strength relative to bodyweight.')).toBeInTheDocument();
  });

  it('submitting the add form calls createExercise, and closes once it is made', async () => {
    const user = userEvent.setup();
    mockCreate.mutate.mockImplementation((vals, opts) => opts?.onSuccess?.());
    renderLibrary();

    await user.click(addButton());
    const sheet = newSheet();
    await user.type(within(sheet).getByLabelText('Name of the exercise'), 'Muscle Up');
    await user.click(within(sheet).getByRole('button', { name: 'Create the exercise' }));

    expect(mockCreate.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Muscle Up' }),
      expect.any(Object)
    );
    expect(sheet.open).toBe(false);
  });

  it('says it is creating, and takes no second press, while the write is out', async () => {
    const user = userEvent.setup();
    mockCreate = { mutate: vi.fn(), isPending: true };
    renderLibrary();
    await user.click(addButton());
    const sheet = within(newSheet());
    expect(sheet.queryByRole('button', { name: 'Create the exercise' })).toBeNull();
    expect(sheet.getByRole('button', { name: 'Creating…' })).toBeDisabled();
  });

  it('clicking Cancel hides the add form', async () => {
    const user = userEvent.setup();
    renderLibrary();

    await user.click(addButton());
    const sheet = newSheet();
    await user.click(within(sheet).getByRole('button', { name: 'Cancel' }));
    expect(sheet.open).toBe(false);
    expect(screen.queryByLabelText('Name of the exercise')).not.toBeInTheDocument();
    expect(mockCreate.mutate).not.toHaveBeenCalled();
  });

  it('"Edit the exercise" in its options opens the form on that exercise', async () => {
    const user = userEvent.setup();
    renderLibrary();

    const options = await openOptions(user, 'Pull Up');
    await user.click(within(options).getByRole('button', { name: 'Edit the exercise' }));
    // The options give way to the form.
    expect(options.open).toBe(false);
    const sheet = within(editSheet());
    expect(sheet.getByLabelText('Name of the exercise')).toHaveValue('Pull Up');
    expect(within(sheet.getByRole('group', { name: 'Difficulty' })).getByRole('button', { name: '2' }))
      .toHaveAttribute('aria-pressed', 'true');
    expect(sheet.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  // The ⋯ sheet says what the exercise is, under its name.
  it('names the options after the exercise and describes it', async () => {
    const user = userEvent.setup();
    renderLibrary();
    const options = await openOptions(user, 'Dip');
    expect(options).toHaveAccessibleDescription('Push, difficulty 1');
    expect(within(options).getAllByRole('button').map((b) => b.getAttribute('aria-label') || b.textContent))
      .toEqual(['Close', 'Edit the exercise', 'Archive Dip', 'Delete Dip']);
  });

  describe('deleting an exercise', () => {
    it('opens the app’s dialog for that exercise instead of the browser’s confirm', async () => {
      const user = userEvent.setup();
      const nativeConfirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      renderLibrary();

      // Nothing is asked about any exercise until one is picked — opening its
      // options is not picking it.
      expect(mockUseExerciseUsage).not.toHaveBeenCalled();
      const options = await openOptions(user, 'Dip');
      expect(mockUseExerciseUsage).not.toHaveBeenCalled();

      await user.click(within(options).getByRole('button', { name: 'Delete Dip' }));
      expect(options.open).toBe(false);
      const dialog = screen.getByRole('dialog', { name: 'Delete Dip?' });
      expect(within(dialog).getByRole('heading', { name: 'Delete Dip?' })).toBeInTheDocument();
      expect(mockUseExerciseUsage).toHaveBeenCalledWith('ex-2');
      // Opening is not deleting.
      expect(mockDelete.mutate).not.toHaveBeenCalled();
      expect(nativeConfirm).not.toHaveBeenCalled();
      nativeConfirm.mockRestore();
    });

    it('deletes an unused exercise once the dialog is confirmed, and closes', async () => {
      const user = userEvent.setup();
      renderLibrary();

      const dialog = await askToDelete(user, 'Pull Up');
      await user.click(within(dialog).getByRole('button', { name: 'Delete the exercise' }));
      expect(mockDelete.mutate).toHaveBeenCalledTimes(1);
      expect(mockDelete.mutate).toHaveBeenCalledWith('ex-1');
      expect(dialog.open).toBe(false);
      expect(screen.queryByRole('heading', { name: 'Delete Pull Up?' })).not.toBeInTheDocument();
    });

    it('"Keep the exercise" deletes nothing', async () => {
      const user = userEvent.setup();
      renderLibrary();

      const dialog = await askToDelete(user, 'Pull Up');
      await user.click(within(dialog).getByRole('button', { name: 'Keep the exercise' }));
      expect(mockDelete.mutate).not.toHaveBeenCalled();
      expect(dialog.open).toBe(false);
      expect(screen.queryByRole('heading', { name: 'Delete Pull Up?' })).not.toBeInTheDocument();
    });

    // Finding L7: the old confirm() said nothing about the goals a delete
    // would take with it.
    it('shows the slots and goals that use the exercise, and cannot delete it', async () => {
      const user = userEvent.setup();
      mockUsage = usageQuery({ slots: 12, goals: 2, swaps: 0 });
      renderLibrary();

      const dialog = await askToDelete(user, 'Pull Up');
      const open = within(dialog);
      expect(open.getByRole('status')).toHaveTextContent('It is in use, so it cannot be deleted.');
      expect(open.getByText('Prescribed in sessions').nextSibling).toHaveTextContent('12');
      expect(open.getByText('Goals set on it').nextSibling).toHaveTextContent('2');
      expect(open.queryByRole('button', { name: 'Delete the exercise' })).not.toBeInTheDocument();

      await user.click(footClose(dialog));
      expect(mockDelete.mutate).not.toHaveBeenCalled();
      expect(dialog.open).toBe(false);
    });
  });

  it('shows search bar and type filter chips when exercises exist', () => {
    renderLibrary();
    expect(searchBox()).toBeInTheDocument();
    expect(filters().getAllByRole('button').map((b) => b.textContent)).toEqual(['All', 'Pull', 'Push']);
    // "All" until another is chosen.
    expect(filters().getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('search filters the list by name', async () => {
    const user = userEvent.setup();
    renderLibrary();

    await user.type(searchBox(), 'pull');
    expect(screen.getByText('Pull Up')).toBeInTheDocument();
    expect(screen.queryByText('Dip')).not.toBeInTheDocument();
  });

  it('shows empty state when search has no matches', async () => {
    const user = userEvent.setup();
    renderLibrary();

    await user.type(searchBox(), 'zzz');
    expect(screen.getByText('No exercise matches')).toBeInTheDocument();
    expect(
      screen.getByText('Change the search or the filter, or create the exercise with the plus button.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Exercises' })).toBeNull();
  });

  it('type filter chip filters the list', async () => {
    const user = userEvent.setup();
    renderLibrary();

    await user.click(filters().getByRole('button', { name: 'Push' }));
    expect(screen.queryByText('Pull Up')).not.toBeInTheDocument();
    expect(screen.getByText('Dip')).toBeInTheDocument();
  });

  it('active filter chip has aria-pressed=true', async () => {
    const user = userEvent.setup();
    renderLibrary();

    const pullBtn = filters().getByRole('button', { name: 'Pull' });
    await user.click(pullBtn);
    expect(pullBtn).toHaveAttribute('aria-pressed', 'true');
    expect(filters().getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('does not show search bar when library is empty', () => {
    mockExercises = { data: [], isLoading: false };
    renderLibrary();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Filter by type' })).not.toBeInTheDocument();
  });

  it('add form threads a chosen type, difficulty and load_mode into createExercise', async () => {
    const user = userEvent.setup();
    mockCreate.mutate.mockImplementation((vals, opts) => opts?.onSuccess?.());
    renderLibrary();

    await user.click(addButton());
    const sheet = within(newSheet());
    await user.type(sheet.getByLabelText('Name of the exercise'), 'Weighted Pull-up');
    const segment = (group, name) => within(sheet.getByRole('group', { name: group })).getByRole('button', { name });
    await user.click(segment('Type', 'Push'));
    await user.click(segment('Difficulty', '3'));
    await user.click(segment('Load', 'Added'));
    expect(segment('Load', 'Added')).toHaveAttribute('aria-pressed', 'true');
    expect(segment('Load', 'Not set')).toHaveAttribute('aria-pressed', 'false');
    await user.click(sheet.getByRole('button', { name: 'Create the exercise' }));

    expect(mockCreate.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Weighted Pull-up', type: 'push', difficulty: 3, load_mode: 'added' }),
      expect.any(Object),
    );
  });

  it('unclassified exercises submit load_mode: null', async () => {
    const user = userEvent.setup();
    mockCreate.mutate.mockImplementation((vals, opts) => opts?.onSuccess?.());
    renderLibrary();
    await user.click(addButton());
    const sheet = within(newSheet());
    await user.type(sheet.getByLabelText('Name of the exercise'), 'Row');
    await user.click(sheet.getByRole('button', { name: 'Create the exercise' }));
    expect(mockCreate.mutate).toHaveBeenCalledWith(
      { name: 'Row', type: 'pull', difficulty: 1, volume_weight: 1, load_mode: null },
      expect.any(Object),
    );
  });

  // What was "D2 · VW1 · +BW" in mono capitals is a sentence under the name.
  describe('the caption of an exercise', () => {
    it('tags a classified exercise with its load', () => {
      mockExercises = {
        data: [
          { id: 'ex-3', name: 'Weighted Dip', type: 'push', difficulty: 2, volume_weight: 1, load_mode: 'added' },
          { id: 'ex-4', name: 'Front Lever', type: 'pull', difficulty: 3, volume_weight: 1, load_mode: 'full' },
        ],
        isLoading: false,
      };
      renderLibrary();
      expect(rowOf('Weighted Dip').querySelector('.pk-caption')).toHaveTextContent('Push, difficulty 2, added load');
      expect(rowOf('Front Lever').querySelector('.pk-caption')).toHaveTextContent('Pull, difficulty 3, full load');
    });

    it('gives the volume weight only when it is not 1', () => {
      mockExercises = {
        data: [
          { id: 'ex-1', name: 'Pull Up', type: 'pull', difficulty: 2, volume_weight: '1.50' },
          { id: 'ex-2', name: 'Dip', type: 'push', difficulty: 1, volume_weight: '1.00' },
        ],
        isLoading: false,
      };
      renderLibrary();
      expect(rowOf('Pull Up').querySelector('.pk-caption')).toHaveTextContent('Pull, difficulty 2, volume ×1.5');
      expect(rowOf('Dip').querySelector('.pk-caption').textContent).not.toMatch(/volume/);
    });
  });

  // Review finding L9 (P31): the volume weight was a `type="number"` field read
  // with Number(). "0,5" was 5 in an English Chromium and "" in WebKit, and
  // Number("") sent 0. It is a text field read by parseDecimalInput now; the
  // form is submitted by clicking "Create the exercise" or Save, so its
  // validation runs.
  describe('the volume weight', () => {
    async function openAddForm(user) {
      await user.click(addButton());
      await user.type(within(newSheet()).getByLabelText('Name of the exercise'), 'Muscle Up');
      return within(newSheet()).getByLabelText('Volume weight');
    }
    const create = () => within(newSheet()).getByRole('button', { name: 'Create the exercise' });

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
      await user.click(create());
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
      await user.click(create());
      expect(mockCreate.mutate).not.toHaveBeenCalled();
      expect(within(newSheet()).getByLabelText('Name of the exercise')).toBeInTheDocument();
    });

    // A number, out of the range: refused by the form, which says why.
    it.each(['0', '0,05', '100'])('"%s" creates nothing and says the range', async (text) => {
      const user = userEvent.setup();
      renderLibrary();
      const field = await openAddForm(user);
      await user.clear(field);
      await user.type(field, text);
      await user.click(create());
      expect(mockCreate.mutate).not.toHaveBeenCalled();
      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent('Enter a number from 0.1 to 99.99');
      expect(field).toHaveAttribute('aria-invalid', 'true');
      expect(field).toHaveAttribute('aria-describedby', alert.id);

      // Typing again takes the alert away; a good value then goes.
      await user.clear(field);
      await user.type(field, '1,5');
      expect(screen.queryByRole('alert')).toBeNull();
      await user.click(create());
      expect(mockCreate.mutate).toHaveBeenCalledWith(
        expect.objectContaining({ volume_weight: 1.5 }),
        expect.any(Object),
      );
    });

    it('the edit form starts from the stored value as text, and saves what is typed', async () => {
      const user = userEvent.setup();
      mockUpdate.mutate.mockImplementation((vals, opts) => opts?.onSuccess?.());
      mockExercises = {
        data: [{ id: 'ex-1', name: 'Pull Up', type: 'pull', difficulty: 2, volume_weight: '1.50' }],
        isLoading: false,
      };
      renderLibrary();
      const options = await openOptions(user, 'Pull Up');
      await user.click(within(options).getByRole('button', { name: 'Edit the exercise' }));
      const sheet = editSheet();
      const field = within(sheet).getByLabelText('Volume weight');
      expect(field).toHaveValue('1.5');
      await user.clear(field);
      await user.type(field, '0,75');
      await user.click(within(sheet).getByRole('button', { name: 'Save' }));
      expect(mockUpdate.mutate).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'ex-1', name: 'Pull Up', volume_weight: 0.75 }),
        expect.any(Object),
      );
      expect(sheet.open).toBe(false);
    });
  });

  // The type was a hand-made pill showing the raw value ("pull"), coloured
  // push for anything that was not pull. It is now named at the head of the
  // caption, after a mark in the type's chart colour.
  describe('the type of an exercise', () => {
    it('is the type’s name and colour', () => {
      renderLibrary();
      expect(rowOf('Pull Up').querySelector('.pk-caption')).toHaveTextContent('Pull, difficulty 2');
      expect(markOf('Pull Up')).toHaveClass('bg-chart-pull');
      expect(rowOf('Dip').querySelector('.pk-caption')).toHaveTextContent('Push, difficulty 1');
      expect(markOf('Dip')).toHaveClass('bg-chart-push');
    });

    // lib/exerciseTypes.js: a type the list does not have "must not borrow
    // the colour of another type".
    it('draws a type the app does not know under its own name, in neither type’s colour', () => {
      mockExercises = {
        data: [{ id: 'ex-9', name: 'Pistol', type: 'legs', difficulty: 2, volume_weight: 1 }],
        isLoading: false,
      };
      renderLibrary();
      expect(rowOf('Pistol').querySelector('.pk-caption')).toHaveTextContent('legs, difficulty 2');
      expect(markOf('Pistol')).not.toBeNull();
      expect(markOf('Pistol')).not.toHaveClass('bg-chart-push');
      expect(markOf('Pistol')).not.toHaveClass('bg-chart-pull');
    });
  });

  // Review decision P18: an exercise in use cannot be deleted, and nothing
  // could archive one — it stayed in every picker for good.
  describe('archiving an exercise', () => {
    const ARCHIVED_AT = '2026-10-15T08:00:00.000Z';
    const withDipArchived = () => {
      mockExercises = {
        data: [
          { id: 'ex-1', name: 'Pull Up', type: 'pull', difficulty: 2, volume_weight: 1, archived_at: null },
          { id: 'ex-2', name: 'Dip', type: 'push', difficulty: 1, volume_weight: 1, archived_at: ARCHIVED_AT },
        ],
        isLoading: false,
      };
    };
    const archivedSection = () => screen.getByRole('region', { name: 'Archived exercises' });
    const drawerToggle = () => within(archivedSection()).getByRole('button', { name: /^\d+ archived$/ });

    it('archives an exercise from its options, and closes them', async () => {
      const user = userEvent.setup();
      renderLibrary();
      const options = await openOptions(user, 'Dip');
      await user.click(within(options).getByRole('button', { name: 'Archive Dip' }));
      expect(mockArchive.mutate).toHaveBeenCalledTimes(1);
      expect(mockArchive.mutate).toHaveBeenCalledWith({ id: 'ex-2', archived: true });
      expect(mockDelete.mutate).not.toHaveBeenCalled();
      expect(options.open).toBe(false);
    });

    it('does not take a second press while that exercise’s write is out', async () => {
      const user = userEvent.setup();
      mockArchive = { mutate: vi.fn(), isPending: true, variables: { id: 'ex-1', archived: true } };
      renderLibrary();
      let options = await openOptions(user, 'Pull Up');
      expect(within(options).getByRole('button', { name: 'Archive Pull Up' })).toBeDisabled();
      await user.click(within(options).getByRole('button', { name: 'Close' }));
      options = await openOptions(user, 'Dip');
      expect(within(options).getByRole('button', { name: 'Archive Dip' })).toBeEnabled();
    });

    it('nor a second restore while that exercise’s write is out', async () => {
      const user = userEvent.setup();
      mockExercises = {
        data: [
          { id: 'ex-1', name: 'Pull Up', type: 'pull', difficulty: 2, volume_weight: 1, archived_at: ARCHIVED_AT },
          { id: 'ex-2', name: 'Dip', type: 'push', difficulty: 1, volume_weight: 1, archived_at: ARCHIVED_AT },
        ],
        isLoading: false,
      };
      mockArchive = { mutate: vi.fn(), isPending: true, variables: { id: 'ex-2', archived: false } };
      renderLibrary();
      await user.click(drawerToggle());
      expect(screen.getByRole('button', { name: 'Restore Dip' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Restore Pull Up' })).toBeEnabled();
    });

    it('shows no drawer while nothing is archived', () => {
      renderLibrary();
      expect(screen.queryByRole('region', { name: 'Archived exercises' })).toBeNull();
      expect(screen.queryByRole('button', { name: /archived$/ })).toBeNull();
      expect(screen.getByText('2 exercises')).toBeInTheDocument();
    });

    it('moves an archived exercise out of the list, into a closed "N archived" drawer', () => {
      withDipArchived();
      renderLibrary();
      expect(within(exerciseList()).getByText('Pull Up')).toBeInTheDocument();
      expect(screen.queryByText('Dip')).toBeNull();
      expect(screen.getByText('1 exercise, 1 archived')).toBeInTheDocument();
      expect(drawerToggle()).toHaveTextContent('1 archived');
      expect(drawerToggle()).toHaveAttribute('aria-expanded', 'false');
    });

    it('opens the drawer on the archived exercises, which are restored and not archived again', async () => {
      const user = userEvent.setup();
      withDipArchived();
      renderLibrary();
      await user.click(drawerToggle());
      expect(drawerToggle()).toHaveAttribute('aria-expanded', 'true');
      expect(within(archivedSection()).getByText('Dip')).toBeInTheDocument();
      expect(screen.getByText(/Not offered for new sessions or goals/)).toBeInTheDocument();
      // No options on an archived exercise: it is neither edited nor archived
      // again from here.
      expect(screen.queryByRole('button', { name: 'Options for Dip' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Archive Dip' })).toBeNull();

      await user.click(screen.getByRole('button', { name: 'Restore Dip' }));
      expect(mockArchive.mutate).toHaveBeenCalledWith({ id: 'ex-2', archived: false });

      await user.click(drawerToggle());
      expect(screen.queryByText('Dip')).toBeNull();
      expect(screen.queryByText(/Not offered for new sessions or goals/)).toBeNull();
    });

    it('counts every archived exercise, whatever the search and the type chip say', async () => {
      const user = userEvent.setup();
      withDipArchived();
      renderLibrary();
      await user.type(searchBox(), 'zzz');
      expect(screen.getByText('No exercise matches')).toBeInTheDocument();
      expect(drawerToggle()).toHaveTextContent('1 archived');
      expect(screen.getByText('1 exercise, 1 archived')).toBeInTheDocument();
    });

    it('searches and filters the exercises on offer only', async () => {
      const user = userEvent.setup();
      withDipArchived();
      renderLibrary();
      // Dip is the only push, and it is archived.
      await user.click(filters().getByRole('button', { name: 'Push' }));
      expect(screen.getByText('No exercise matches')).toBeInTheDocument();
      expect(screen.queryByText('Dip')).toBeNull();
    });

    it('says so when every exercise is archived, and keeps the drawer', () => {
      mockExercises = {
        data: [{ id: 'ex-2', name: 'Dip', type: 'push', difficulty: 1, volume_weight: 1, archived_at: ARCHIVED_AT }],
        isLoading: false,
      };
      renderLibrary();
      expect(screen.getByText('Every exercise is archived.')).toBeInTheDocument();
      expect(screen.queryByText(/No exercise yet/)).toBeNull();
      expect(screen.queryByRole('searchbox')).toBeNull();
      expect(screen.getByText('0 exercises, 1 archived')).toBeInTheDocument();
      expect(drawerToggle()).toHaveTextContent('1 archived');
    });

    it('offers to archive an exercise in use from the delete dialog, and closes', async () => {
      const user = userEvent.setup();
      mockUsage = usageQuery({ slots: 3, goals: 1, swaps: 0 });
      renderLibrary();
      const dialog = await askToDelete(user, 'Pull Up');
      const open = within(dialog);
      expect(open.queryByRole('button', { name: 'Delete the exercise' })).toBeNull();
      await user.click(open.getByRole('button', { name: 'Archive instead' }));
      expect(mockArchive.mutate).toHaveBeenCalledWith({ id: 'ex-1', archived: true });
      expect(mockDelete.mutate).not.toHaveBeenCalled();
      expect(dialog.open).toBe(false);
      expect(screen.queryByRole('heading', { name: 'Delete Pull Up?' })).toBeNull();
    });

    it('still deletes an archived exercise nothing uses, through the same dialog', async () => {
      const user = userEvent.setup();
      withDipArchived();
      renderLibrary();
      await user.click(drawerToggle());
      await user.click(screen.getByRole('button', { name: 'Delete Dip' }));
      const open = within(screen.getByRole('dialog', { name: 'Delete Dip?' }));
      expect(mockUseExerciseUsage).toHaveBeenCalledWith('ex-2');
      await user.click(open.getByRole('button', { name: 'Delete the exercise' }));
      expect(mockDelete.mutate).toHaveBeenCalledWith('ex-2');
    });

    it('offers no archive in the dialog of an exercise that is archived already', async () => {
      const user = userEvent.setup();
      withDipArchived();
      mockUsage = usageQuery({ slots: 3, goals: 0, swaps: 0 });
      renderLibrary();
      await user.click(drawerToggle());
      await user.click(screen.getByRole('button', { name: 'Delete Dip' }));
      const dialog = screen.getByRole('dialog', { name: 'Delete Dip?' });
      const open = within(dialog);
      expect(open.getByRole('status')).toHaveTextContent('It is in use, so it cannot be deleted.');
      expect(open.queryByRole('button', { name: 'Archive instead' })).toBeNull();
      expect(open.queryByRole('button', { name: 'Delete the exercise' })).toBeNull();
      expect(footClose(dialog)).toBeInTheDocument();
    });
  });

  // Review item L15 and live finding N18: the filter pills were 23px tall,
  // "+ Add" 32px, and "edit" and "del" two words 4px apart, "del" 29×16. jsdom
  // lays nothing out (src/test/hitTargets.test.js holds the pk-* classes to
  // 44px — a row to 60px, a large button to 56px).
  describe('44px targets', () => {
    it('filter chips are Parc chips', () => {
      renderLibrary();
      for (const name of ['All', 'Pull', 'Push']) {
        expect(filters().getByRole('button', { name })).toHaveClass('pk-chip');
      }
    });

    it('every exercise has one round 44px button, and its options are rows', async () => {
      const user = userEvent.setup();
      renderLibrary();
      for (const name of ['Options for Pull Up', 'Options for Dip']) {
        expect(screen.getByRole('button', { name })).toHaveClass('pk-icon-btn');
      }
      const options = within(await openOptions(user, 'Pull Up'));
      for (const name of ['Edit the exercise', 'Archive Pull Up', 'Delete Pull Up']) {
        expect(options.getByRole('button', { name })).toHaveClass('pk-row');
      }
    });

    it('the drawer, and restore and delete in it, are 44px', async () => {
      const user = userEvent.setup();
      mockExercises = {
        data: [
          { id: 'ex-1', name: 'Pull Up', type: 'pull', difficulty: 2, volume_weight: 1 },
          { id: 'ex-2', name: 'Dip', type: 'push', difficulty: 1, volume_weight: 1, archived_at: '2026-10-15T08:00:00.000Z' },
        ],
        isLoading: false,
      };
      renderLibrary();
      const toggle = screen.getByRole('button', { name: '1 archived' });
      expect(toggle).toHaveClass('pk-row');
      await user.click(toggle);
      for (const name of ['Restore Dip', 'Delete Dip']) {
        expect(screen.getByRole('button', { name })).toHaveClass('pk-btn');
      }
    });

    it('"Add an exercise", and the controls of its form, are 44px', async () => {
      const user = userEvent.setup();
      renderLibrary();
      expect(addButton()).toHaveClass('pk-icon-btn');
      await user.click(addButton());
      const sheet = within(newSheet());
      expect(sheet.getByRole('button', { name: 'Create the exercise' })).toHaveClass('pk-btn', 'pk-btn-primary', 'pk-btn-lg');
      expect(sheet.getByRole('button', { name: 'Cancel' })).toHaveClass('pk-btn');
      for (const group of ['Type', 'Difficulty', 'Load']) {
        for (const segment of within(sheet.getByRole('group', { name: group })).getAllByRole('button')) {
          expect(segment).toHaveClass('pk-btn');
        }
      }
      expect(sheet.getByLabelText('Name of the exercise')).toHaveClass('pk-field');
      expect(sheet.getByLabelText('Volume weight')).toHaveClass('pk-field');
    });
  });
});
