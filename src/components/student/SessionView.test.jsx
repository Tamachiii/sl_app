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
  useSetFailed: () => ({ mutate: vi.fn() }),
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
import { resetRestTimer } from '../../hooks/useRestTimer';

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
    resetRestTimer();
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
    // Two SetRows render → two indicator buttons in the pending state.
    expect(screen.getAllByRole('button', { name: /mark set done/i })).toHaveLength(2);
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
        // Done sets need an RPE to count as resolved (so the auto-expanded
        // RPE panel on the last set has a chance to be filled in).
        { id: 'l-1', exercise_slot_id: 'slot-done', set_number: 1, done: true, rpe: 7 },
        { id: 'l-2', exercise_slot_id: 'slot-done', set_number: 2, done: true, rpe: 8 },
        { id: 'l-3', exercise_slot_id: 'slot-open', set_number: 1, done: false, rpe: null },
        { id: 'l-4', exercise_slot_id: 'slot-open', set_number: 2, done: false, rpe: null },
      ],
      isLoading: false,
    };
    renderSessionView();

    // Both exercise headers are visible.
    expect(screen.getByText('Dip')).toBeInTheDocument();
    expect(screen.getByText('Pullup')).toBeInTheDocument();
    // The completed slot's body (SetRows) is hidden; the incomplete slot's body is visible.
    // Pullup has two pending SetRows; Dip has none because it's collapsed.
    expect(screen.getAllByRole('button', { name: /mark set done/i })).toHaveLength(2);
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

    // Only the first incomplete slot (Squat) is auto-open, so only one SetRow is rendered.
    expect(screen.getAllByRole('button', { name: /mark set done/i })).toHaveLength(1);
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
    // Start: the one set is already done AND has an RPE → firstOpenIdx = -1,
    // group auto-closed. (A done-without-RPE set keeps the group open so the
    // auto-expanded RPE panel doesn't collapse before the student records it.)
    mockSessionData = { data: { title: 'Back Nav', exercise_slots: slots }, isLoading: false };
    mockSetLogsData = {
      data: [{ id: 'l-1', exercise_slot_id: 'slot-1', set_number: 1, done: true, rpe: 8 }],
      isLoading: false,
    };
    const { rerender } = renderSessionView();

    // Auto-closed: no SetRow visible.
    expect(screen.queryByRole('button', { name: /mark set failed/i })).toBeNull();
    expect(screen.getByRole('button', { expanded: false, name: /Dip/i })).toBeInTheDocument();

    // Student goes "back" into the completed exercise by clicking the header.
    await user.click(screen.getByRole('button', { expanded: false, name: /Dip/i }));
    // The done set's indicator now reads "mark set failed" (cycle: done → failed).
    expect(screen.getByRole('button', { name: /mark set failed/i })).toBeInTheDocument();

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
    expect(screen.getByRole('button', { name: /mark set done/i })).toBeInTheDocument();

    // Student re-completes the set AND records RPE. firstOpenIdx flips 0 → -1.
    // Before the fix, sticky manualOpen kept the group expanded; now it should auto-close.
    mockSetLogsData = {
      data: [{ id: 'l-1', exercise_slot_id: 'slot-1', set_number: 1, done: true, rpe: 8 }],
      isLoading: false,
    };
    rerender(
      <MemoryRouter>
        <SessionView />
      </MemoryRouter>
    );
    expect(screen.queryByRole('button', { name: /mark set failed/i })).toBeNull();
    expect(screen.getByRole('button', { expanded: false, name: /Dip/i })).toBeInTheDocument();
  });

  it('done set without RPE keeps the group open (so auto-expanded RPE panel survives)', () => {
    mockSessionData = {
      data: {
        title: 'Last Set',
        exercise_slots: [
          {
            id: 'slot-1',
            sets: 1,
            reps: 5,
            weight_kg: 50,
            sort_order: 0,
            exercise: { name: 'Squat', type: 'push', difficulty: 1, volume_weight: 1 },
          },
          {
            id: 'slot-2',
            sets: 1,
            reps: 5,
            weight_kg: 50,
            sort_order: 1,
            exercise: { name: 'Bench', type: 'push', difficulty: 1, volume_weight: 1 },
          },
        ],
      },
      isLoading: false,
    };
    // Squat is done but rpe is null — under the new rule, the group is
    // unresolved, so Squat (not Bench) stays auto-open.
    mockSetLogsData = {
      data: [
        { id: 'l-1', exercise_slot_id: 'slot-1', set_number: 1, done: true, rpe: null },
        { id: 'l-2', exercise_slot_id: 'slot-2', set_number: 1, done: false, rpe: null },
      ],
      isLoading: false,
    };
    renderSessionView();

    expect(screen.getByRole('button', { expanded: true, name: /Squat/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { expanded: false, name: /Bench/i })).toBeInTheDocument();
  });

  it('failed set bypasses the RPE requirement and lets the group resolve', () => {
    mockSessionData = {
      data: {
        title: 'Failed Bypass',
        exercise_slots: [
          {
            id: 'slot-1',
            sets: 1,
            reps: 5,
            weight_kg: 50,
            sort_order: 0,
            exercise: { name: 'Squat', type: 'push', difficulty: 1, volume_weight: 1 },
          },
          {
            id: 'slot-2',
            sets: 1,
            reps: 5,
            weight_kg: 50,
            sort_order: 1,
            exercise: { name: 'Bench', type: 'push', difficulty: 1, volume_weight: 1 },
          },
        ],
      },
      isLoading: false,
    };
    // Squat is failed (no rpe needed) → group resolves → auto-open advances to Bench.
    mockSetLogsData = {
      data: [
        { id: 'l-1', exercise_slot_id: 'slot-1', set_number: 1, done: false, failed: true, rpe: null },
        { id: 'l-2', exercise_slot_id: 'slot-2', set_number: 1, done: false, rpe: null },
      ],
      isLoading: false,
    };
    renderSessionView();

    expect(screen.getByRole('button', { expanded: false, name: /Squat/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { expanded: true, name: /Bench/i })).toBeInTheDocument();
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

    // Auto-open: SetRow visible (its indicator button reads "Mark set done").
    expect(screen.getByRole('button', { name: /mark set done/i })).toBeInTheDocument();

    // Click the slot header to collapse.
    await user.click(screen.getByRole('button', { expanded: true }));
    expect(screen.queryByRole('button', { name: /mark set done/i })).toBeNull();
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
    // Header always shows the exercise count, regardless of open/closed state.
    expect(screen.getByText(/2 exercises/i)).toBeInTheDocument();
    expect(screen.getByText('Curl')).toBeInTheDocument();
    expect(screen.getByText('Skullcrusher')).toBeInTheDocument();
    // Supersets share a single comment box (anchored to the lead slot), not
    // one per exercise. Without this guarantee, students would see the
    // "Add note for coach" prompt N times for an N-exercise superset.
    expect(screen.getAllByRole('button', { name: /add note for coach/i })).toHaveLength(1);
  });

  it('shows a grouped summary in the header and per-set targets inline on SetRows when heterogeneous', () => {
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

    // Header: grouped summary (no separate per-set list).
    expect(screen.getByText('2 × 6 @ 100kg · 1 × 8 @ 80kg')).toBeInTheDocument();
    // SetRows render their own target inline when sets are heterogeneous.
    expect(screen.getAllByText('6 @ 100kg')).toHaveLength(2);
    expect(screen.getByText('8 @ 80kg')).toBeInTheDocument();
  });

  // Failed sets count toward session progress (the student worked through
  // them) but NOT toward the "X of Y sets" tally (which tracks successful
  // completion).
  it('progress bar counts failed sets; "X of Y" tally counts only done', () => {
    mockSessionData = {
      data: {
        title: 'Mixed',
        exercise_slots: [
          {
            id: 'slot-1',
            sets: 4,
            reps: 5,
            weight_kg: 50,
            sort_order: 0,
            exercise: { name: 'Squat', type: 'push', difficulty: 1, volume_weight: 1 },
          },
        ],
      },
      isLoading: false,
    };
    mockSetLogsData = {
      data: [
        { id: 'l-1', exercise_slot_id: 'slot-1', set_number: 1, done: true, failed: false, rpe: 7 },
        { id: 'l-2', exercise_slot_id: 'slot-1', set_number: 2, done: true, failed: false, rpe: 8 },
        { id: 'l-3', exercise_slot_id: 'slot-1', set_number: 3, done: false, failed: true, rpe: null },
        { id: 'l-4', exercise_slot_id: 'slot-1', set_number: 4, done: false, failed: false, rpe: null },
      ],
      isLoading: false,
    };
    renderSessionView();

    // Tally still reads "2 of 4" (only successful) — the percentage reads
    // "75%" (3 of 4 sets resolved: two done + one failed).
    expect(screen.getByText('2 of 4 sets')).toBeInTheDocument();
    expect(screen.getByText('75%')).toBeInTheDocument();
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

  // Past-program sessions reach SessionView via the stats calendar history
  // overlay. They must be read-only — no Confirm, no Undo, locked sets — so
  // historical training data can't be retroactively rewritten.
  it('past-program session: hides Confirm and shows read-only banner when unconfirmed', () => {
    mockSessionData = {
      data: { title: 'Old Day', exercise_slots: [], program_is_active: false },
      isLoading: false,
    };
    mockSetLogsData = { data: [], isLoading: false };
    renderSessionView();

    expect(screen.queryByRole('button', { name: /confirm session/i })).toBeNull();
    expect(screen.getByText(/from a past program/i)).toBeInTheDocument();
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
  });

  it('past-program session: hides Undo and shows confirmation-locked banner when confirmed', () => {
    mockConfirmation = {
      data: {
        id: 'c-1',
        session_id: 'sess-1',
        student_id: 'u-1',
        confirmed_at: '2026-04-14T10:00:00Z',
        notes: null,
      },
      isLoading: false,
    };
    mockSessionData = {
      data: { title: 'Old Day', exercise_slots: [], program_is_active: false },
      isLoading: false,
    };
    mockSetLogsData = { data: [], isLoading: false };
    renderSessionView();

    expect(screen.queryByRole('button', { name: /undo confirmation/i })).toBeNull();
    expect(screen.getByText(/from a past program/i)).toBeInTheDocument();
    expect(screen.getByText(/confirmation is locked/i)).toBeInTheDocument();
  });

  it('past-program session: SetRow toggle button is disabled', () => {
    mockSessionData = {
      data: {
        title: 'Old Day',
        program_is_active: false,
        exercise_slots: [
          {
            id: 'slot-1',
            sets: 1,
            reps: 5,
            weight_kg: 50,
            sort_order: 0,
            exercise: { name: 'Squat', type: 'push', difficulty: 1, volume_weight: 1 },
          },
        ],
      },
      isLoading: false,
    };
    mockSetLogsData = {
      data: [{ id: 'l-1', exercise_slot_id: 'slot-1', set_number: 1, done: false, rpe: null }],
      isLoading: false,
    };
    renderSessionView();

    expect(screen.getByRole('button', { name: /mark set done/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /set rpe/i })).toBeDisabled();
  });

  it('coach-archived unconfirmed session: hides Confirm and shows archive read-only banner', () => {
    mockSessionData = {
      data: {
        title: 'Day 1',
        exercise_slots: [],
        program_is_active: true,
        archived_at: '2026-04-20T10:00:00Z',
      },
      isLoading: false,
    };
    mockSetLogsData = { data: [], isLoading: false };
    renderSessionView();

    expect(screen.queryByRole('button', { name: /confirm session/i })).toBeNull();
    expect(screen.getByText(/archived by your coach/i)).toBeInTheDocument();
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
  });
});
