import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

let mockSessionData = { data: null, isLoading: false };
let mockSetLogsData = { data: [], isLoading: false };

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ sessionId: 'sess-1' }) };
});

vi.mock('../../hooks/useSession', () => ({
  useSession: () => mockSessionData,
}));

vi.mock('../../hooks/useSetLogs', () => ({
  useSetLogs: () => mockSetLogsData,
  useEnsureSetLogs: () => ({ mutate: vi.fn() }),
  useToggleSetDone: () => ({ mutate: vi.fn() }),
  useSetRpe: () => ({ mutate: vi.fn() }),
}));

let mockConfirmation = { data: null, isLoading: false };
const mockConfirm = { mutate: vi.fn(), isPending: false };
const mockUnconfirm = { mutate: vi.fn(), isPending: false };

vi.mock('../../hooks/useSlotComments', () => ({
  useSlotComments: () => ({ data: [], isLoading: false }),
  useSaveSlotComment: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('../../hooks/useSetVideo', () => ({
  useSetVideos: () => ({ data: [], isLoading: false }),
  useUploadSetVideo: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteSetVideo: () => ({ mutate: vi.fn(), isPending: false }),
  useSetVideoSignedUrl: () => ({ data: null, isLoading: false }),
}));

vi.mock('../../hooks/useSessionConfirmation', () => ({
  useSessionConfirmation: () => mockConfirmation,
  useConfirmSession: () => mockConfirm,
  useUnconfirmSession: () => mockUnconfirm,
}));

import SessionView from './SessionView';

function renderSessionView() {
  return render(
    <MemoryRouter>
      <SessionView />
    </MemoryRouter>
  );
}

describe('SessionView', () => {
  beforeEach(() => {
    mockConfirmation = { data: null, isLoading: false };
    vi.clearAllMocks();
  });

  it('renders loading spinner', () => {
    mockSessionData = { data: null, isLoading: true };
    mockSetLogsData = { data: [], isLoading: false };
    renderSessionView();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('renders exercise names and set info', () => {
    mockSessionData = {
      data: {
        title: 'Push Day',
        exercise_slots: [
          {
            id: 'slot-1',
            sets: 3,
            reps: 10,
            weight_kg: 20,
            sort_order: 0,
            exercise: { name: 'Dip', type: 'push', difficulty: 2, volume_weight: 1 },
          },
        ],
      },
      isLoading: false,
    };
    mockSetLogsData = {
      data: [
        { id: 'log-1', exercise_slot_id: 'slot-1', set_number: 1, done: false, rpe: null },
        { id: 'log-2', exercise_slot_id: 'slot-1', set_number: 2, done: false, rpe: null },
      ],
      isLoading: false,
    };
    renderSessionView();

    expect(screen.getByText('Dip')).toBeInTheDocument();
    expect(screen.getByText('3 × 10 @ 20kg')).toBeInTheDocument();
    expect(screen.getByText('Set 1')).toBeInTheDocument();
    expect(screen.getByText('Set 2')).toBeInTheDocument();
  });

  it('renders header with session title', () => {
    mockSessionData = {
      data: { title: 'Pull Day', exercise_slots: [] },
      isLoading: false,
    };
    mockSetLogsData = { data: [], isLoading: false };
    renderSessionView();
    expect(screen.getByText('Pull Day')).toBeInTheDocument();
  });

  it('shows "Confirm session" button when not yet confirmed', () => {
    mockSessionData = { data: { title: 'Day 1', exercise_slots: [] }, isLoading: false };
    mockSetLogsData = { data: [], isLoading: false };
    renderSessionView();
    expect(screen.getByRole('button', { name: /confirm session/i })).toBeInTheDocument();
  });

  it('opens confirm dialog, types notes, and calls useConfirmSession', async () => {
    const user = userEvent.setup();
    mockSessionData = { data: { title: 'Day 1', exercise_slots: [] }, isLoading: false };
    mockSetLogsData = { data: [], isLoading: false };
    renderSessionView();

    // Notes textarea is hidden until the Student opens the confirm dialog.
    expect(screen.queryByLabelText(/notes for your coach/i)).toBeNull();

    await user.click(screen.getByRole('button', { name: /^confirm session$/i }));
    await user.type(screen.getByLabelText(/notes for your coach/i), 'felt strong');
    await user.click(screen.getByRole('button', { name: /^confirm$/i }));

    expect(mockConfirm.mutate).toHaveBeenCalledWith(
      { sessionId: 'sess-1', notes: 'felt strong' },
      expect.any(Object)
    );
  });

  it('cancel in confirm dialog closes it without calling useConfirmSession', async () => {
    const user = userEvent.setup();
    mockSessionData = { data: { title: 'Day 1', exercise_slots: [] }, isLoading: false };
    mockSetLogsData = { data: [], isLoading: false };
    renderSessionView();

    await user.click(screen.getByRole('button', { name: /^confirm session$/i }));
    expect(screen.getByLabelText(/notes for your coach/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(mockConfirm.mutate).not.toHaveBeenCalled();
  });

  it('displays coach note when slot has notes', () => {
    mockSessionData = {
      data: {
        title: 'Push Day',
        exercise_slots: [
          {
            id: 'slot-1',
            sets: 3,
            reps: 10,
            weight_kg: 20,
            sort_order: 0,
            notes: 'Keep elbows tucked throughout',
            exercise: { name: 'Dip', type: 'push', difficulty: 2, volume_weight: 1 },
          },
        ],
      },
      isLoading: false,
    };
    mockSetLogsData = { data: [], isLoading: false };
    renderSessionView();
    expect(screen.getByText('Keep elbows tucked throughout')).toBeInTheDocument();
  });

  it('auto-opens only the first incomplete slot when earlier slots are done', () => {
    mockSessionData = {
      data: {
        title: 'Mixed Day',
        exercise_slots: [
          {
            id: 'slot-done',
            sets: 2,
            reps: 10,
            weight_kg: 20,
            sort_order: 0,
            exercise: { name: 'Dip', type: 'push', difficulty: 2, volume_weight: 1 },
          },
          {
            id: 'slot-open',
            sets: 2,
            reps: 10,
            weight_kg: 20,
            sort_order: 1,
            exercise: { name: 'Pullup', type: 'pull', difficulty: 2, volume_weight: 1 },
          },
        ],
      },
      isLoading: false,
    };
    mockSetLogsData = {
      data: [
        { id: 'l-1', exercise_slot_id: 'slot-done', set_number: 1, done: true, rpe: null },
        { id: 'l-2', exercise_slot_id: 'slot-done', set_number: 2, done: true, rpe: null },
        { id: 'l-3', exercise_slot_id: 'slot-open', set_number: 1, done: false, rpe: null },
        { id: 'l-4', exercise_slot_id: 'slot-open', set_number: 2, done: false, rpe: null },
      ],
      isLoading: false,
    };
    renderSessionView();

    // Both exercise headers are visible.
    expect(screen.getByText('Dip')).toBeInTheDocument();
    expect(screen.getByText('Pullup')).toBeInTheDocument();
    // The completed slot's body (SetRow "Set 1/2") is hidden; the incomplete slot's body is visible.
    // Pullup has two SetRows ("Set 1" and "Set 2"); Dip has none because it's collapsed.
    const set1Nodes = screen.getAllByText('Set 1');
    expect(set1Nodes).toHaveLength(1);
  });

  it('auto-opens only the first slot when multiple slots are incomplete', () => {
    mockSessionData = {
      data: {
        title: 'Fresh Day',
        exercise_slots: [
          {
            id: 'slot-a',
            sets: 1,
            reps: 5,
            weight_kg: 50,
            sort_order: 0,
            exercise: { name: 'Squat', type: 'push', difficulty: 1, volume_weight: 1 },
          },
          {
            id: 'slot-b',
            sets: 1,
            reps: 5,
            weight_kg: 50,
            sort_order: 1,
            exercise: { name: 'Bench', type: 'push', difficulty: 1, volume_weight: 1 },
          },
          {
            id: 'slot-c',
            sets: 1,
            reps: 5,
            weight_kg: 50,
            sort_order: 2,
            exercise: { name: 'Row', type: 'pull', difficulty: 1, volume_weight: 1 },
          },
        ],
      },
      isLoading: false,
    };
    mockSetLogsData = {
      data: [
        { id: 'l-a', exercise_slot_id: 'slot-a', set_number: 1, done: false, rpe: null },
        { id: 'l-b', exercise_slot_id: 'slot-b', set_number: 1, done: false, rpe: null },
        { id: 'l-c', exercise_slot_id: 'slot-c', set_number: 1, done: false, rpe: null },
      ],
      isLoading: false,
    };
    renderSessionView();

    // All three exercise headers visible.
    expect(screen.getByText('Squat')).toBeInTheDocument();
    expect(screen.getByText('Bench')).toBeInTheDocument();
    expect(screen.getByText('Row')).toBeInTheDocument();

    // Only the first incomplete slot (Squat) is auto-open, so only one "Set 1" SetRow is rendered.
    const set1Nodes = screen.getAllByText('Set 1');
    expect(set1Nodes).toHaveLength(1);
  });

  it('drops manual override after state-reverting action so auto-open resumes', async () => {
    const user = userEvent.setup();
    const slots = [
      {
        id: 'slot-1',
        sets: 1,
        reps: 10,
        weight_kg: 20,
        sort_order: 0,
        exercise: { name: 'Dip', type: 'push', difficulty: 2, volume_weight: 1 },
      },
    ];
    // Start: the one set is already done → firstOpenIdx = -1, group auto-closed.
    mockSessionData = { data: { title: 'Back Nav', exercise_slots: slots }, isLoading: false };
    mockSetLogsData = {
      data: [{ id: 'l-1', exercise_slot_id: 'slot-1', set_number: 1, done: true, rpe: null }],
      isLoading: false,
    };
    const { rerender } = renderSessionView();

    // Auto-closed: no SetRow visible.
    expect(screen.queryByText('Set 1')).toBeNull();
    expect(screen.getByRole('button', { expanded: false, name: /Dip/i })).toBeInTheDocument();

    // Student goes "back" into the completed exercise by clicking the header.
    await user.click(screen.getByRole('button', { expanded: false, name: /Dip/i }));
    expect(screen.getByText('Set 1')).toBeInTheDocument();

    // Student cancels/undoes the set. firstOpenIdx flips from -1 → 0,
    // which should drop the manual override and auto-open the group.
    mockSetLogsData = {
      data: [{ id: 'l-1', exercise_slot_id: 'slot-1', set_number: 1, done: false, rpe: null }],
      isLoading: false,
    };
    rerender(
      <MemoryRouter>
        <SessionView />
      </MemoryRouter>
    );
    expect(screen.getByText('Set 1')).toBeInTheDocument();

    // Student re-completes the set. firstOpenIdx flips 0 → -1.
    // Before the fix, sticky manualOpen kept the group expanded; now it should auto-close.
    mockSetLogsData = {
      data: [{ id: 'l-1', exercise_slot_id: 'slot-1', set_number: 1, done: true, rpe: null }],
      isLoading: false,
    };
    rerender(
      <MemoryRouter>
        <SessionView />
      </MemoryRouter>
    );
    expect(screen.queryByText('Set 1')).toBeNull();
    expect(screen.getByRole('button', { expanded: false, name: /Dip/i })).toBeInTheDocument();
  });

  it('accordion: opening another slot closes the currently-open one', async () => {
    const user = userEvent.setup();
    mockSessionData = {
      data: {
        title: 'Multi',
        exercise_slots: [
          {
            id: 'slot-a',
            sets: 1,
            reps: 5,
            weight_kg: 50,
            sort_order: 0,
            exercise: { name: 'Squat', type: 'push', difficulty: 1, volume_weight: 1 },
          },
          {
            id: 'slot-b',
            sets: 1,
            reps: 5,
            weight_kg: 50,
            sort_order: 1,
            exercise: { name: 'Bench', type: 'push', difficulty: 1, volume_weight: 1 },
          },
          {
            id: 'slot-c',
            sets: 1,
            reps: 5,
            weight_kg: 50,
            sort_order: 2,
            exercise: { name: 'Row', type: 'pull', difficulty: 1, volume_weight: 1 },
          },
        ],
      },
      isLoading: false,
    };
    mockSetLogsData = {
      data: [
        { id: 'l-a', exercise_slot_id: 'slot-a', set_number: 1, done: false, rpe: null },
        { id: 'l-b', exercise_slot_id: 'slot-b', set_number: 1, done: false, rpe: null },
        { id: 'l-c', exercise_slot_id: 'slot-c', set_number: 1, done: false, rpe: null },
      ],
      isLoading: false,
    };
    renderSessionView();

    // Initially Squat (firstOpenIdx) is auto-open; Bench and Row collapsed.
    expect(screen.getByRole('button', { expanded: true, name: /Squat/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { expanded: false, name: /Bench/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { expanded: false, name: /Row/i })).toBeInTheDocument();

    // Tapping Row opens it and closes Squat.
    await user.click(screen.getByRole('button', { expanded: false, name: /Row/i }));
    expect(screen.getByRole('button', { expanded: false, name: /Squat/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { expanded: false, name: /Bench/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { expanded: true, name: /Row/i })).toBeInTheDocument();

    // Tapping Bench closes Row and opens Bench (still single-open accordion).
    await user.click(screen.getByRole('button', { expanded: false, name: /Bench/i }));
    expect(screen.getByRole('button', { expanded: false, name: /Squat/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { expanded: true, name: /Bench/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { expanded: false, name: /Row/i })).toBeInTheDocument();
  });

  it('manual toggle on an auto-open slot collapses it', async () => {
    const user = userEvent.setup();
    mockSessionData = {
      data: {
        title: 'Single',
        exercise_slots: [
          {
            id: 'slot-1',
            sets: 2,
            reps: 10,
            weight_kg: 20,
            sort_order: 0,
            exercise: { name: 'Dip', type: 'push', difficulty: 2, volume_weight: 1 },
          },
        ],
      },
      isLoading: false,
    };
    mockSetLogsData = {
      data: [
        { id: 'l-1', exercise_slot_id: 'slot-1', set_number: 1, done: false, rpe: null },
      ],
      isLoading: false,
    };
    renderSessionView();

    // Auto-open: Set 1 visible.
    expect(screen.getByText('Set 1')).toBeInTheDocument();

    // Click the slot header to collapse.
    await user.click(screen.getByRole('button', { expanded: true }));
    expect(screen.queryByText('Set 1')).toBeNull();
  });

  it('renders a superset group as a single collapsible unit', () => {
    mockSessionData = {
      data: {
        title: 'Super',
        exercise_slots: [
          {
            id: 'slot-a',
            sets: 3,
            reps: 8,
            weight_kg: 10,
            sort_order: 0,
            superset_group: 1,
            exercise: { name: 'Curl', type: 'pull', difficulty: 1, volume_weight: 1 },
          },
          {
            id: 'slot-b',
            sets: 3,
            reps: 8,
            weight_kg: 10,
            sort_order: 1,
            superset_group: 1,
            exercise: { name: 'Skullcrusher', type: 'push', difficulty: 1, volume_weight: 1 },
          },
        ],
      },
      isLoading: false,
    };
    mockSetLogsData = {
      data: [
        { id: 'l-a1', exercise_slot_id: 'slot-a', set_number: 1, done: false, rpe: null },
        { id: 'l-b1', exercise_slot_id: 'slot-b', set_number: 1, done: false, rpe: null },
      ],
      isLoading: false,
    };
    renderSessionView();

    expect(screen.getByText(/Superset/i)).toBeInTheDocument();
    expect(screen.getByText(/Alternate between exercises/i)).toBeInTheDocument();
    expect(screen.getByText('Curl')).toBeInTheDocument();
    expect(screen.getByText('Skullcrusher')).toBeInTheDocument();
  });

  it('shows a per-set list when sets have heterogeneous targets', () => {
    mockSessionData = {
      data: {
        title: 'Drop Set Day',
        exercise_slots: [
          {
            id: 'slot-1',
            sets: 3,
            reps: 6,
            weight_kg: 100,
            sort_order: 0,
            exercise: { name: 'Squat', type: 'push', difficulty: 2, volume_weight: 1 },
          },
        ],
      },
      isLoading: false,
    };
    mockSetLogsData = {
      data: [
        { id: 'log-1', exercise_slot_id: 'slot-1', set_number: 1, done: false, rpe: null, target_reps: 6, target_weight_kg: 100 },
        { id: 'log-2', exercise_slot_id: 'slot-1', set_number: 2, done: false, rpe: null, target_reps: 6, target_weight_kg: 100 },
        { id: 'log-3', exercise_slot_id: 'slot-1', set_number: 3, done: false, rpe: null, target_reps: 8, target_weight_kg: 80 },
      ],
      isLoading: false,
    };
    renderSessionView();

    expect(screen.getByText(/3 sets · varied/)).toBeInTheDocument();
    expect(screen.getAllByText('6 @ 100kg')).toHaveLength(2);
    expect(screen.getByText('8 @ 80kg')).toBeInTheDocument();
  });

  it('shows confirmed banner and undo button when already confirmed', async () => {
    const user = userEvent.setup();
    mockConfirmation = {
      data: {
        id: 'c-1',
        session_id: 'sess-1',
        student_id: 'u-1',
        confirmed_at: '2026-04-14T10:00:00Z',
        notes: 'great session',
      },
      isLoading: false,
    };
    mockSessionData = { data: { title: 'Day 1', exercise_slots: [] }, isLoading: false };
    mockSetLogsData = { data: [], isLoading: false };
    renderSessionView();

    expect(screen.getByText(/session confirmed/i)).toBeInTheDocument();
    expect(screen.getByText('great session')).toBeInTheDocument();

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: /undo confirmation/i }));
    expect(mockUnconfirm.mutate).toHaveBeenCalledWith({ sessionId: 'sess-1' });
    window.confirm.mockRestore();
  });
});
