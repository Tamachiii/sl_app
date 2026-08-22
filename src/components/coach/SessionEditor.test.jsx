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

const stubProgram = (id) => ({
  data: id ? { id: 'prog-1', weeks: [{ id: 'w-10', week_number: 1, label: null }] } : null,
});

vi.mock('../../hooks/useProgram', () => ({
  useActiveProgram: (sid) => stubProgram(sid),
  useProgram: (pid) => stubProgram(pid),
  // CopyDialog now picks the destination BLOCK before the week, so it needs
  // the athlete's program list rather than just their active one.
  useProgramsForStudent: (sid) => ({
    data: sid ? [{ id: 'prog-1', name: 'Block A', is_active: true }] : [],
  }),
}));

// The "last time" panel runs a real query; this file is about the editor.
vi.mock('../../hooks/useLastPerformance', () => ({
  useLastPerformance: () => ({ data: {}, isLoading: false }),
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

const mockDeleteSession = { mutate: vi.fn(), isPending: false };

vi.mock('../../hooks/useWeek', () => ({
  useUpdateSession: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteSession: () => mockDeleteSession,
  useProgramIdForWeek: () => ({ data: 'prog-1' }),
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


  // Duplicate and "copy to…" left this header: the sheet carries both now — a
  // duplicate button on every row, copy behind its selection bar — so keeping
  // them was a second door onto the same actions, above the actual work.
  it('leaves duplicate and copy to the sheet', () => {
    mockSessionData = { data: { title: 'Day 1', exercise_slots: [] }, isLoading: false };
    renderEditor();
    expect(screen.queryByText('duplicate')).toBeNull();
    expect(screen.queryByText('copy to…')).toBeNull();
  });

  // Delete stays — it is the ONLY delete path in the app, and archiving from
  // the sheet does not replace it for a session created by mistake. It moved
  // to the bottom, away from the title.
  it('deletes the session from here — this is the only delete path there is', async () => {
    const user = userEvent.setup();
    mockSessionData = {
      data: { title: 'Day 1', exercise_slots: [] },
      isLoading: false,
    };
    renderEditor();

    await user.click(screen.getByText('Delete this session'));
    // Destructive, so it must go through the confirm step.
    expect(mockDeleteSession.mutate).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(mockDeleteSession.mutate).toHaveBeenCalledWith('sess-1', expect.any(Object));
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
    // Twice on purpose: once as the slot being edited, once in the "last time"
    // panel, which lists every exercise of the session with what the athlete
    // actually lifted for it.
    expect(screen.getAllByText('Pull Up')).toHaveLength(2);
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
