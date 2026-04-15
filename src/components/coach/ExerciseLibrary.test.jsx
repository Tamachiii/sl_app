import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

let mockExercises = { data: [], isLoading: false };
const mockCreate = { mutate: vi.fn() };
const mockUpdate = { mutate: vi.fn() };
const mockDelete = { mutate: vi.fn() };

vi.mock('../../hooks/useExerciseLibrary', () => ({
  useExerciseLibrary: () => mockExercises,
  useCreateExercise: () => mockCreate,
  useUpdateExercise: () => mockUpdate,
  useDeleteExercise: () => mockDelete,
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

    await user.click(screen.getByText('+ Add'));
    expect(screen.getByPlaceholderText('Exercise name')).toBeInTheDocument();
    expect(screen.getByText('Create')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  it('submitting the add form calls createExercise', async () => {
    const user = userEvent.setup();
    mockCreate.mutate.mockImplementation((vals, opts) => opts?.onSuccess?.());
    renderLibrary();

    await user.click(screen.getByText('+ Add'));
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

    await user.click(screen.getByText('+ Add'));
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

  it('clicking Delete with confirm calls deleteExercise', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderLibrary();

    const deleteButtons = screen.getAllByRole('button', { name: /delete/i });
    await user.click(deleteButtons[0]);
    expect(mockDelete.mutate).toHaveBeenCalledWith('ex-1');
    window.confirm.mockRestore();
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
});
