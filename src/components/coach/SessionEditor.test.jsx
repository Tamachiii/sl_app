import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '../../hooks/useTheme';

const mockAddSlot = { mutate: vi.fn(), isPending: false };
const mockUpdateSlot = { mutate: vi.fn(), mutateAsync: vi.fn().mockResolvedValue({}) };
const mockDeleteSlot = { mutate: vi.fn() };
const mockDuplicateSession = { mutate: vi.fn(), isPending: false };
let mockSessionData = { data: null, isLoading: false };
let mockLibraryData = { data: [] };

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ sessionId: 'sess-1', studentId: 'stu-1' }),
  };
});

vi.mock('../../hooks/useStudents', () => ({
  useStudents: () => ({
    data: [
      { id: 'stu-1', profile: { full_name: 'Alice' } },
      { id: 'stu-2', profile: { full_name: 'Bob' } },
    ],
  }),
}));

vi.mock('../../hooks/useProgram', () => ({
  useActiveProgram: (sid) => ({
    data: sid
      ? { id: 'prog-1', weeks: [{ id: 'w-10', week_number: 1, label: null }] }
      : null,
  }),
}));

vi.mock('../../hooks/useSession', () => ({
  useSession: () => mockSessionData,
  useAddSlot: () => mockAddSlot,
  useUpdateSlot: () => mockUpdateSlot,
  useDeleteSlot: () => mockDeleteSlot,
  useUpdateSetTarget: () => ({ mutate: vi.fn(), isPending: false }),
  useResetSlotToUniform: () => ({ mutate: vi.fn(), isPending: false }),
  useRemoveSet: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('../../hooks/useExerciseLibrary', () => ({
  useExerciseLibrary: () => mockLibraryData,
}));

vi.mock('../../hooks/useDuplicate', () => ({
  useDuplicateSession: () => mockDuplicateSession,
}));

vi.mock('../../hooks/useWeek', () => ({
  useUpdateSession: () => ({ mutate: vi.fn(), isPending: false }),
}));

import SessionEditor from './SessionEditor';

function renderEditor() {
  return render(
    <ThemeProvider>
      <MemoryRouter>
        <SessionEditor />
      </MemoryRouter>
    </ThemeProvider>
  );
}

describe('SessionEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLibraryData = {
      data: [
        { id: 'ex-1', name: 'Pull Up', type: 'pull', difficulty: 2, volume_weight: 1 },
        { id: 'ex-2', name: 'Dip', type: 'push', difficulty: 2, volume_weight: 1 },
      ],
    };
  });

  it('renders loading spinner', () => {
    mockSessionData = { data: null, isLoading: true };
    renderEditor();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('renders session title', () => {
    mockSessionData = {
      data: { title: 'Push Day', exercise_slots: [] },
      isLoading: false,
    };
    renderEditor();
    expect(screen.getByText('Push Day')).toBeInTheDocument();
  });

  it('clicking "+ Add Exercise" shows the add form', async () => {
    const user = userEvent.setup();
    mockSessionData = {
      data: { title: 'Day 1', exercise_slots: [] },
      isLoading: false,
    };
    renderEditor();

    await user.click(screen.getByText('+ ADD EXERCISE'));
    expect(screen.getByText('Select exercise…')).toBeInTheDocument();
    expect(screen.getByText('Add')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  it('clicking Cancel hides the add form', async () => {
    const user = userEvent.setup();
    mockSessionData = {
      data: { title: 'Day 1', exercise_slots: [] },
      isLoading: false,
    };
    renderEditor();

    await user.click(screen.getByText('+ ADD EXERCISE'));
    await user.click(screen.getByText('Cancel'));
    expect(screen.queryByText('Select exercise…')).not.toBeInTheDocument();
  });

  it('selecting an exercise and clicking Add calls addSlot', async () => {
    const user = userEvent.setup();
    mockSessionData = {
      data: { title: 'Day 1', exercise_slots: [] },
      isLoading: false,
    };
    renderEditor();

    await user.click(screen.getByText('+ ADD EXERCISE'));
    await user.selectOptions(screen.getByRole('combobox'), 'ex-1');
    await user.click(screen.getByText('Add'));

    expect(mockAddSlot.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-1',
        exerciseId: 'ex-1',
        sets: 3,
        reps: 10,
      })
    );
  });

  it('clicking Duplicate calls duplicateSession', async () => {
    const user = userEvent.setup();
    mockSessionData = {
      data: { title: 'Day 1', exercise_slots: [] },
      isLoading: false,
    };
    renderEditor();

    await user.click(screen.getByText('duplicate'));
    expect(mockDuplicateSession.mutate).toHaveBeenCalledWith({ sessionId: 'sess-1' });
  });

  it('copies the session to another student via the dialog', async () => {
    const user = userEvent.setup();
    mockSessionData = {
      data: { title: 'Day 1', exercise_slots: [] },
      isLoading: false,
    };
    renderEditor();

    await user.click(screen.getByText('copy to…'));
    const selects = screen.getAllByRole('combobox');
    await user.selectOptions(selects[0], 'stu-2');
    await user.selectOptions(selects[1], 'w-10');
    await user.click(screen.getByText('Copy'));

    expect(mockDuplicateSession.mutate).toHaveBeenCalledWith(
      { sessionId: 'sess-1', weekId: 'w-10' },
      expect.any(Object)
    );
  });

  it('renders exercise slots', () => {
    mockSessionData = {
      data: {
        title: 'Day 1',
        exercise_slots: [
          {
            id: 'slot-1',
            sets: 3,
            reps: 10,
            weight_kg: 20,
            sort_order: 0,
            exercise: { name: 'Pull Up', type: 'pull', difficulty: 2, volume_weight: 1 },
          },
        ],
      },
      isLoading: false,
    };
    renderEditor();
    expect(screen.getByText('Pull Up')).toBeInTheDocument();
  });

  // Regression: adding an exercise used to assign sortOrder = slots.length, which
  // collides with existing sort_orders when a prior deletion has left a gap. The
  // collision made superset children render before their parent.
  it('adds a new slot with sortOrder = max(existing)+1 when sort_orders have gaps', async () => {
    const user = userEvent.setup();
    mockSessionData = {
      data: {
        title: 'Day 1',
        exercise_slots: [
          { id: 's-a', sets: 3, reps: 10, sort_order: 0, exercise: { name: 'Pull Up', type: 'pull', difficulty: 2, volume_weight: 1 } },
          // gap at 1 (deleted)
          { id: 's-b', sets: 3, reps: 10, sort_order: 2, exercise: { name: 'Dip', type: 'push', difficulty: 2, volume_weight: 1 } },
          { id: 's-c', sets: 3, reps: 10, sort_order: 5, exercise: { name: 'Pull Up', type: 'pull', difficulty: 2, volume_weight: 1 } },
        ],
      },
      isLoading: false,
    };
    renderEditor();

    await user.click(screen.getByText('+ ADD EXERCISE'));
    await user.selectOptions(screen.getByRole('combobox'), 'ex-2');
    await user.click(screen.getByText('Add'));

    expect(mockAddSlot.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ sortOrder: 6 })
    );
  });
});
