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

  it('clicking "+ Add Exercise" shows the form', async () => {
    const user = userEvent.setup();
    renderLibrary();

    await user.click(screen.getByText('+ Add Exercise'));
    expect(screen.getByPlaceholderText('Exercise name')).toBeInTheDocument();
    expect(screen.getByText('Create')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  it('submitting the add form calls createExercise', async () => {
    const user = userEvent.setup();
    mockCreate.mutate.mockImplementation((vals, opts) => opts?.onSuccess?.());
    renderLibrary();

    await user.click(screen.getByText('+ Add Exercise'));
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

    await user.click(screen.getByText('+ Add Exercise'));
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
});
