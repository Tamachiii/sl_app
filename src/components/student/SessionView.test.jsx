import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { IsRestoringProvider } from '@tanstack/react-query';

let mockSessionData = { data: null, isLoading: false };
let mockSetLogsData = { data: [], isLoading: false };

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ sessionId: 'sess-1' }) };
});

// The page asks for the session row again at a few moments (see "a session the
// coach has reviewed" below), so the query's `refetch` is part of what it reads.
const mockRefetchSession = vi.fn();

vi.mock('../../hooks/useSession', () => ({
  useSession: () => ({ refetch: mockRefetchSession, ...mockSessionData }),
}));

// The page hands the completion of the session's sets over to this hook, with
// what it shows and whether it may ask (see "missing set rows" below); what
// the hook does with it is in hooks/useSetLogs.ensure.test.jsx.
const mockEnsureSetLogs = vi.fn();
const mockRefetchLogs = vi.fn();

vi.mock('../../hooks/useSetLogs', () => ({
  useSetLogs: () => ({ refetch: mockRefetchLogs, ...mockSetLogsData }),
  useEnsureSetLogs: (...args) => mockEnsureSetLogs(...args),
  useToggleSetDone: () => ({ mutate: vi.fn() }),
  useSetFailed: () => ({ mutate: vi.fn() }),
  useSetRpe: () => ({ mutate: vi.fn() }),
  useLogActual: () => ({ mutate: vi.fn() }),
  useSetSkipped: () => ({ mutate: vi.fn() }),
  useAddStudentSet: () => ({ mutate: vi.fn(), isPending: false }),
  useRemoveStudentSet: () => ({ mutate: vi.fn(), isPending: false }),
}));

let mockDeviations = { data: [], isLoading: false };

vi.mock('../../hooks/useSlotDeviations', () => ({
  useSlotDeviations: () => mockDeviations,
  useSaveSlotDeviation: () => ({ mutate: vi.fn(), isPending: false }),
  useRequestPromote: () => ({ mutate: vi.fn(), isPending: false }),
}));

let mockLastPerformance = { data: {} };

vi.mock('../../hooks/useLastPerformance', () => ({
  useLastPerformance: () => mockLastPerformance,
}));

vi.mock('../../hooks/useExerciseLibrary', () => ({
  useExerciseLibrary: () => ({ data: [], isLoading: false }),
}));

let mockOnline = true;

vi.mock('../../hooks/useOnlineStatus', () => ({
  useOnlineStatus: () => mockOnline,
}));

let mockConfirmation = { data: null, isLoading: false };
const mockConfirm = { mutate: vi.fn(), isPending: false };
const mockUnconfirm = { mutate: vi.fn(), isPending: false };

vi.mock('../../hooks/useSlotComments', () => ({
  useSlotComments: () => ({ data: [], isLoading: false }),
  useSaveSlotComment: () => ({ mutate: vi.fn(), isPending: false }),
}));

let mockVideos = { data: [], isLoading: false };

vi.mock('../../hooks/useSetVideo', () => ({
  useSetVideos: () => mockVideos,
  useUploadSetVideo: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteSetVideo: () => ({ mutate: vi.fn(), isPending: false }),
  useSetVideoSignedUrl: () => ({ data: null, isLoading: false }),
}));

// Whether the confirmation of the session is kept on the device until a
// network returns — read from the queue of writes by the real hook.
let mockConfirmWaiting = false;

vi.mock('../../hooks/useSessionConfirmation', () => ({
  useSessionConfirmation: () => mockConfirmation,
  useConfirmSession: () => mockConfirm,
  useUnconfirmSession: () => mockUnconfirm,
  useConfirmationWaiting: () => mockConfirmWaiting,
}));

let mockFeedback = { data: null };

vi.mock('../../hooks/useMessages', () => ({
  useSessionFeedback: () => mockFeedback,
  formatMessageStamp: () => 'stamp',
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
    mockConfirmWaiting = false;
    Object.assign(mockConfirm, { isPending: false, isPaused: false });
    Object.assign(mockUnconfirm, { isPending: false, isPaused: false });
    mockFeedback = { data: null };
    mockDeviations = { data: [], isLoading: false };
    vi.clearAllMocks();
    resetRestTimer();
  });

  it('renders loading spinner', () => {
    mockSessionData = { data: undefined, isLoading: true, fetchStatus: 'fetching' };
    mockSetLogsData = { data: undefined, isLoading: false, fetchStatus: 'idle' };
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
      {
        sessionId: 'sess-1',
        notes: 'felt strong',
        // No set was ticked in this fixture, so the date falls back to today.
        performedOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      },
      expect.any(Object)
    );
  });

  // The training date is pinned from the set logs at confirm time, not left to
  // the server's confirmed_at default — an offline confirm can replay days later.
  it('confirm sends the date of the earliest logged set, not today', async () => {
    const user = userEvent.setup();
    mockSessionData = { data: { title: 'Day 1', exercise_slots: [] }, isLoading: false };
    mockSetLogsData = {
      data: [
        { id: 'l-2', done: true, logged_at: new Date(2026, 7, 18, 19, 30).toISOString() },
        { id: 'l-1', done: true, logged_at: new Date(2026, 7, 18, 18, 0).toISOString() },
      ],
      isLoading: false,
    };
    renderSessionView();

    await user.click(screen.getByRole('button', { name: /^confirm session$/i }));
    await user.click(screen.getByRole('button', { name: /^confirm$/i }));

    expect(mockConfirm.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ performedOn: '2026-08-18' }),
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
    expect(screen.queryByLabelText(/notes for your coach/i)).toBeNull();
  });

  // P25. The answer to a confirmation can be hours away — the write is parked
  // without a network, which is neither a success nor a failure — and the
  // page behind the dialog shows the session as confirmed from the tap. The
  // dialog used to wait for the answer, on "Confirming…" with Cancel off.
  describe('the confirm dialog closes at the tap', () => {
    const notesField = () => screen.queryByLabelText(/notes for your coach/i);

    function openDialog(user) {
      mockSessionData = { data: { title: 'Day 1', exercise_slots: [] }, isLoading: false };
      mockSetLogsData = { data: [], isLoading: false };
      renderSessionView();
      return user.click(screen.getByRole('button', { name: /^confirm session$/i }));
    }

    it('without waiting for the answer of the write', async () => {
      const user = userEvent.setup();
      await openDialog(user);
      await user.type(notesField(), 'felt strong');

      await user.click(screen.getByRole('button', { name: /^confirm$/i }));

      // `mutate` is a stub: nothing has answered, and nothing will.
      expect(mockConfirm.mutate).toHaveBeenCalledTimes(1);
      expect(notesField()).toBeNull();
    });

    it('the note leaves the field when the database has it, not before', async () => {
      const user = userEvent.setup();
      await openDialog(user);
      await user.type(notesField(), 'felt strong');
      await user.click(screen.getByRole('button', { name: /^confirm$/i }));

      // The confirmation was refused (the hook put the page back): the dialog
      // opens on what was written.
      await user.click(screen.getByRole('button', { name: /^confirm session$/i }));
      expect(notesField()).toHaveValue('felt strong');
      await user.click(screen.getByRole('button', { name: /^cancel$/i }));

      // It landed.
      const { onSuccess } = mockConfirm.mutate.mock.calls[0][1];
      act(() => onSuccess());
      await user.click(screen.getByRole('button', { name: /^confirm session$/i }));
      expect(notesField()).toHaveValue('');
    });

    it('its buttons are never switched off by a write that is waiting', async () => {
      const user = userEvent.setup();
      Object.assign(mockConfirm, { isPending: true, isPaused: true });
      await openDialog(user);

      expect(screen.getByRole('button', { name: /^confirm$/i })).toBeEnabled();
      expect(screen.getByRole('button', { name: /^cancel$/i })).toBeEnabled();
      expect(screen.queryByText(/confirming…/i)).toBeNull();
    });
  });

  // A parked write is `isPending` for as long as the device has no network.
  // Keyed on that alone the buttons stayed off, and "Confirm session" on
  // "Confirming…", for a session confirmed and un-confirmed in the gym.
  describe('a write that waits for a network does not hold its button', () => {
    const CONFIRMED = {
      id: 'c-1',
      session_id: 'sess-1',
      student_id: 'u-1',
      notes: null,
      confirmed_at: '2026-04-14T10:00:00Z',
    };

    beforeEach(() => {
      mockSessionData = { data: { title: 'Day 1', exercise_slots: [] }, isLoading: false };
      mockSetLogsData = { data: [], isLoading: false };
    });

    it('"Confirm session" stays available while a confirmation is parked (confirm, then undo, offline)', () => {
      Object.assign(mockConfirm, { isPending: true, isPaused: true });
      renderSessionView();
      expect(screen.getByRole('button', { name: /^confirm session$/i })).toBeEnabled();
      expect(screen.queryByText(/confirming…/i)).toBeNull();
    });

    it('…and is held, as "Confirming…", by one that is being sent', () => {
      Object.assign(mockConfirm, { isPending: true, isPaused: false });
      renderSessionView();
      expect(screen.getByRole('button', { name: /^confirming…$/i })).toBeDisabled();
    });

    it('"Undo confirmation" stays available while an undo is parked (undo, then confirm again, offline)', () => {
      mockConfirmation = { data: CONFIRMED, isLoading: false };
      Object.assign(mockUnconfirm, { isPending: true, isPaused: true });
      renderSessionView();
      expect(screen.getByRole('button', { name: /undo confirmation/i })).toBeEnabled();
    });

    it('…and is held by one that is being sent', () => {
      mockConfirmation = { data: CONFIRMED, isLoading: false };
      Object.assign(mockUnconfirm, { isPending: true, isPaused: false });
      renderSessionView();
      expect(screen.getByRole('button', { name: /undo confirmation/i })).toBeDisabled();
    });

    it('the confirmed card says that the confirmation is kept on the device, while it is', () => {
      mockConfirmation = { data: CONFIRMED, isLoading: false };
      mockConfirmWaiting = true;
      const { rerender } = renderSessionView();

      const line = screen.getByText(/saved on this device\. it will be sent as soon as you’re back online/i);
      expect(line).toHaveAttribute('role', 'status');
      expect(line.closest('.sl-card')).toHaveTextContent(/session confirmed/i);

      mockConfirmWaiting = false;
      rerender(
        <MemoryRouter>
          <SessionView />
        </MemoryRouter>,
      );
      expect(screen.queryByText(/saved on this device/i)).toBeNull();
      expect(screen.getByText(/session confirmed/i)).toBeInTheDocument();
    });

    it('…and nothing of the kind on a session that is not confirmed', () => {
      // Confirmed and un-confirmed offline: the confirmation is still in the
      // queue, in front of its undo.
      mockConfirmWaiting = true;
      renderSessionView();
      expect(screen.queryByText(/saved on this device/i)).toBeNull();
    });
  });

  // Live item N8: "Confirm session" was offered at 0 of 12 sets, and the
  // dialog said nothing about what was being confirmed.
  describe('the confirm dialog says what is confirmed', () => {
    const SLOT = {
      id: 'slot-1',
      sets: 3,
      reps: 10,
      weight_kg: 20,
      sort_order: 0,
      exercise: { name: 'Dip', type: 'push', difficulty: 2, volume_weight: 1 },
    };
    const setRow = (n, fields = {}) => ({
      id: `log-${n}`,
      exercise_slot_id: 'slot-1',
      set_number: n,
      done: false,
      failed: false,
      skipped: false,
      rpe: null,
      ...fields,
    });
    const dialog = () => screen.getByLabelText(/notes for your coach/i).closest('dialog');
    const inDialog = () => within(dialog());

    function openOn(user, logs) {
      mockSessionData = { data: { title: 'Push Day', exercise_slots: [SLOT] }, isLoading: false };
      mockSetLogsData = { data: logs, isLoading: false };
      renderSessionView();
      return user.click(screen.getByRole('button', { name: /^confirm session$/i }));
    }

    it('how many sets are logged, counted like the progress bar: done, failed and skipped', async () => {
      const user = userEvent.setup();
      await openOn(user, [setRow(1, { done: true }), setRow(2, { failed: true }), setRow(3)]);

      expect(inDialog().getByText('Sets logged: 2 of 3')).toBeInTheDocument();
      // Something is logged: one tap confirms.
      await user.click(inDialog().getByRole('button', { name: /^confirm$/i }));
      expect(mockConfirm.mutate).toHaveBeenCalledTimes(1);
    });

    it('the sets of an exercise the athlete skipped count as dealt with', async () => {
      const user = userEvent.setup();
      mockDeviations = { data: [{ exercise_slot_id: 'slot-1', kind: 'skip' }], isLoading: false };
      await openOn(user, [setRow(1), setRow(2), setRow(3)]);

      expect(inDialog().getByText('Sets logged: 3 of 3')).toBeInTheDocument();
      await user.click(inDialog().getByRole('button', { name: /^confirm$/i }));
      expect(mockConfirm.mutate).toHaveBeenCalledTimes(1);
    });

    it('with nothing logged it asks a second time before it confirms', async () => {
      const user = userEvent.setup();
      await openOn(user, [setRow(1), setRow(2), setRow(3)]);
      expect(inDialog().getByText('Sets logged: 0 of 3')).toBeInTheDocument();
      expect(inDialog().queryByRole('alert')).toBeNull();
      await user.type(screen.getByLabelText(/notes for your coach/i), 'did it at home');

      await user.click(inDialog().getByRole('button', { name: /^confirm$/i }));

      // Asked, not sent — and the dialog is still there, with the note.
      expect(mockConfirm.mutate).not.toHaveBeenCalled();
      expect(inDialog().getByRole('alert')).toHaveTextContent(
        /you haven’t logged a single set of this session\. confirm it anyway\?/i,
      );
      expect(screen.getByLabelText(/notes for your coach/i)).toHaveValue('did it at home');
      expect(inDialog().queryByRole('button', { name: /^confirm$/i })).toBeNull();

      await user.click(inDialog().getByRole('button', { name: /^confirm anyway$/i }));
      expect(mockConfirm.mutate).toHaveBeenCalledTimes(1);
      expect(mockConfirm.mutate).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'sess-1', notes: 'did it at home' }),
        expect.any(Object),
      );
      expect(screen.queryByLabelText(/notes for your coach/i)).toBeNull();
    });

    it('a dialog that was closed asks again from the start', async () => {
      const user = userEvent.setup();
      await openOn(user, [setRow(1), setRow(2), setRow(3)]);
      await user.click(inDialog().getByRole('button', { name: /^confirm$/i }));
      expect(inDialog().getByRole('alert')).toBeInTheDocument();
      await user.click(inDialog().getByRole('button', { name: /^cancel$/i }));

      await user.click(screen.getByRole('button', { name: /^confirm session$/i }));

      expect(inDialog().queryByRole('alert')).toBeNull();
      await user.click(inDialog().getByRole('button', { name: /^confirm$/i }));
      expect(mockConfirm.mutate).not.toHaveBeenCalled();
    });

    it('a session without a set has nothing to count, and is confirmed in one tap', async () => {
      const user = userEvent.setup();
      mockSessionData = { data: { title: 'Mobility', exercise_slots: [] }, isLoading: false };
      mockSetLogsData = { data: [], isLoading: false };
      renderSessionView();
      await user.click(screen.getByRole('button', { name: /^confirm session$/i }));

      expect(inDialog().queryByText(/sets logged/i)).toBeNull();
      await user.click(inDialog().getByRole('button', { name: /^confirm$/i }));
      expect(mockConfirm.mutate).toHaveBeenCalledTimes(1);
    });
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

  it('skipped set resolves its group: auto-open advances and progress counts it', () => {
    mockSessionData = {
      data: {
        title: 'Skip Set',
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
    // Squat's only set is skipped (neither done nor failed, per the DB CHECK).
    // Before the fix it stayed "unresolved" forever: the accordion pinned to
    // Squat and progress capped at 0%.
    mockSetLogsData = {
      data: [
        { id: 'l-1', exercise_slot_id: 'slot-1', set_number: 1, done: false, failed: false, skipped: true, rpe: null },
        { id: 'l-2', exercise_slot_id: 'slot-2', set_number: 1, done: false, failed: false, rpe: null },
      ],
      isLoading: false,
    };
    renderSessionView();

    expect(screen.getByRole('button', { expanded: false, name: /Squat/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { expanded: true, name: /Bench/i })).toBeInTheDocument();
    expect(screen.getByText('50%')).toBeInTheDocument();
  });

  it('skip-deviated exercise resolves its group even though its logs stay pending', () => {
    mockSessionData = {
      data: {
        title: 'Skip Exercise',
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
    // The whole Squat exercise is skip-deviated; its logs are merely hidden
    // by SlotGroupCard, so without the skippedSlotIds pass-through they would
    // pin the accordion and hold progress below 100% for the whole session.
    mockDeviations = {
      data: [{ exercise_slot_id: 'slot-1', student_id: 'u-1', kind: 'skip' }],
      isLoading: false,
    };
    mockSetLogsData = {
      data: [
        { id: 'l-1', exercise_slot_id: 'slot-1', set_number: 1, done: false, failed: false, rpe: null },
        { id: 'l-2', exercise_slot_id: 'slot-2', set_number: 1, done: false, failed: false, rpe: null },
      ],
      isLoading: false,
    };
    renderSessionView();

    expect(screen.getByRole('button', { expanded: false, name: /Squat/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { expanded: true, name: /Bench/i })).toBeInTheDocument();
    expect(screen.getByText('50%')).toBeInTheDocument();
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

  // Per-slot numbering must reflect cumulative slot position, not group
  // index. With a single → 2-slot superset → single layout, the trailing
  // single slot used to render as 03 (group index + 1) instead of 04.
  it('numbers slots by cumulative position so a slot after a superset advances by the superset length', () => {
    mockSessionData = {
      data: {
        title: 'Numbering',
        exercise_slots: [
          {
            id: 'slot-1',
            sets: 1,
            reps: 5,
            weight_kg: 100,
            sort_order: 0,
            exercise: { name: 'Dips', type: 'push', difficulty: 1, volume_weight: 1 },
          },
          {
            id: 'slot-2a',
            sets: 1,
            reps: 5,
            weight_kg: 100,
            sort_order: 1,
            superset_group: 1,
            exercise: { name: 'Dips', type: 'push', difficulty: 1, volume_weight: 1 },
          },
          {
            id: 'slot-2b',
            sets: 1,
            reps: 5,
            weight_kg: 100,
            sort_order: 2,
            superset_group: 1,
            exercise: { name: 'Dips', type: 'push', difficulty: 1, volume_weight: 1 },
          },
          {
            id: 'slot-3',
            sets: 1,
            reps: 5,
            weight_kg: 90,
            sort_order: 3,
            exercise: { name: 'Bench Press', type: 'push', difficulty: 1, volume_weight: 1 },
          },
        ],
      },
      isLoading: false,
    };
    mockSetLogsData = {
      data: [
        { id: 'l-1', exercise_slot_id: 'slot-1', set_number: 1, done: false, rpe: null },
        { id: 'l-2a', exercise_slot_id: 'slot-2a', set_number: 1, done: false, rpe: null },
        { id: 'l-2b', exercise_slot_id: 'slot-2b', set_number: 1, done: false, rpe: null },
        { id: 'l-3', exercise_slot_id: 'slot-3', set_number: 1, done: false, rpe: null },
      ],
      isLoading: false,
    };
    renderSessionView();

    // The single slots show their globalIdx in the SlotHeader. Open the
    // superset so its inner slots' indices render too.
    fireEvent.click(screen.getByRole('button', { name: /Superset/i }));
    expect(screen.getByText('01')).toBeInTheDocument();
    expect(screen.getByText('02')).toBeInTheDocument();
    expect(screen.getByText('03')).toBeInTheDocument();
    expect(screen.getByText('04')).toBeInTheDocument();
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

    // Undo goes through the app's ConfirmDialog now, not a native confirm() —
    // so the click opens the dialog and the mutation waits for its button.
    await user.click(screen.getByRole('button', { name: /undo confirmation/i }));
    expect(mockUnconfirm.mutate).not.toHaveBeenCalled();

    // Both the confirm-session Dialog and this one live in the DOM, so pick
    // the one carrying the undo title rather than by role alone.
    const dialog = screen.getByText(/undo confirmation\?/i).closest('dialog');
    await user.click(within(dialog).getByRole('button', { name: /undo confirmation/i }));
    expect(mockUnconfirm.mutate).toHaveBeenCalledWith({ sessionId: 'sess-1' });
  });

  it('dismissing the undo dialog leaves the confirmation in place', async () => {
    const user = userEvent.setup();
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
    mockSessionData = { data: { title: 'Day 1', exercise_slots: [] }, isLoading: false };
    mockSetLogsData = { data: [], isLoading: false };
    renderSessionView();

    await user.click(screen.getByRole('button', { name: /undo confirmation/i }));
    const dialog = screen.getByText(/undo confirmation\?/i).closest('dialog');
    await user.click(within(dialog).getByRole('button', { name: /cancel/i }));
    expect(mockUnconfirm.mutate).not.toHaveBeenCalled();
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

  it("shows the coach's feedback section when feedback exists for the session", async () => {
    const user = userEvent.setup();
    mockFeedback = {
      data: {
        id: 'msg-1',
        body: 'Great work — push the bar harder next week.',
        created_at: '2026-04-15T10:00:00Z',
      },
    };
    mockSessionData = { data: { title: 'Day 1', exercise_slots: [] }, isLoading: false };
    mockSetLogsData = { data: [], isLoading: false };
    renderSessionView();

    expect(screen.getByText("Coach's feedback")).toBeInTheDocument();
    expect(
      screen.getByText('Great work — push the bar harder next week.')
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /reply in messages/i }));
  });

  // P68. jsdom lays nothing out: the 44 px are read from the classes.
  it('draws its buttons at 44 px: the way back, the slot across from it, and "Reply in messages"', () => {
    mockFeedback = {
      data: { id: 'msg-1', body: 'Good.', created_at: '2026-04-15T10:00:00Z' },
    };
    mockSessionData = { data: { title: 'Day 1', exercise_slots: [] }, isLoading: false };
    mockSetLogsData = { data: [], isLoading: false };
    renderSessionView();

    const back = screen.getByRole('button', { name: /go back/i });
    expect(back).toHaveClass('w-11', 'h-11');
    expect(back).not.toHaveClass('w-9');
    // The slot of the rest-timer pill: as wide as the way back, so the title
    // stays centred between them.
    const bar = back.parentElement;
    expect(bar.lastElementChild).toHaveClass('min-w-11', 'h-11');
    expect(screen.getByRole('button', { name: /reply in messages/i })).toHaveClass('sl-pill', 'sl-pill-btn');
  });

  it('hides the feedback section when no feedback exists', () => {
    mockFeedback = { data: null };
    mockSessionData = { data: { title: 'Day 1', exercise_slots: [] }, isLoading: false };
    mockSetLogsData = { data: [], isLoading: false };
    renderSessionView();
    expect(screen.queryByText("Coach's feedback")).toBeNull();
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

// Lock after review (review finding P57, the athlete's half). Once
// `sessions.reviewed_at` is set, what the athlete logged has to stay what the
// coach read: the session is read-only and its confirmation can no longer be
// undone. There is no reopening in the app, so the page says why and links to
// the thread with the coach.
describe('SessionView: a session the coach has reviewed', () => {
  const REVIEWED_AT = '2026-04-15T09:00:00Z';
  const CONFIRMATION = {
    id: 'c-1',
    session_id: 'sess-1',
    student_id: 'u-1',
    confirmed_at: '2026-04-14T10:00:00Z',
    notes: null,
  };
  const SLOT = {
    id: 'slot-1',
    sets: 1,
    reps: 5,
    weight_kg: 50,
    sort_order: 0,
    exercise: { id: 'ex-1', name: 'Squat', type: 'push', difficulty: 1, volume_weight: 1 },
  };
  // Pending, so its exercise is the one the page opens by itself.
  const PENDING_LOG = {
    id: 'l-1',
    exercise_slot_id: 'slot-1',
    set_number: 1,
    done: false,
    rpe: null,
  };

  function session(fields = {}) {
    return {
      data: { title: 'Day 1', exercise_slots: [], program_is_active: true, ...fields },
      isLoading: false,
    };
  }

  function rerenderSessionView(view) {
    view.rerender(
      <MemoryRouter>
        <SessionView />
      </MemoryRouter>
    );
  }

  const lockLine = () => screen.queryByText(/reviewed by your coach/i);
  const coachLink = () => screen.queryByRole('link', { name: /message your coach/i });
  const undoButton = () => screen.queryByRole('button', { name: /undo confirmation/i });
  const confirmButton = () => screen.queryByRole('button', { name: /^confirm session$/i });

  beforeEach(() => {
    mockConfirmation = { data: null, isLoading: false };
    mockFeedback = { data: null };
    mockDeviations = { data: [], isLoading: false };
    mockSetLogsData = { data: [], isLoading: false };
    mockVideos = { data: [], isLoading: false };
    vi.clearAllMocks();
    resetRestTimer();
  });

  describe('confirmed', () => {
    beforeEach(() => {
      mockConfirmation = { data: CONFIRMATION, isLoading: false };
    });

    it('says the coach has reviewed it and links to the thread, where Undo was', () => {
      mockSessionData = session({ reviewed_at: REVIEWED_AT });
      renderSessionView();

      expect(screen.getByText(/session confirmed/i)).toBeInTheDocument();
      expect(undoButton()).toBeNull();
      expect(lockLine()).toHaveTextContent(/this session can no longer be changed/i);
      expect(coachLink()).toHaveAttribute('href', '/student/messages');
      // Nothing to confirm a second time.
      expect(confirmButton()).toBeNull();
    });

    it('still offers Undo while the session is not reviewed', () => {
      mockSessionData = session({ reviewed_at: null });
      renderSessionView();

      expect(undoButton()).toBeInTheDocument();
      expect(lockLine()).toBeNull();
      expect(coachLink()).toBeNull();
    });

    // A confirmed session already has its sets locked; the note for the coach
    // is what a review closes on top of that.
    it('closes the note for the coach, which a confirmation alone leaves open', () => {
      mockSetLogsData = { data: [PENDING_LOG], isLoading: false };

      mockSessionData = session({ exercise_slots: [SLOT], reviewed_at: null });
      const open = renderSessionView();
      expect(screen.getByRole('button', { name: /add note for coach/i })).toBeInTheDocument();
      open.unmount();

      mockSessionData = session({ exercise_slots: [SLOT], reviewed_at: REVIEWED_AT });
      renderSessionView();
      expect(screen.queryByRole('button', { name: /add note for coach/i })).toBeNull();
    });

    it('keeps the line of a past program or an archived session, which no coach can lift', () => {
      mockSessionData = session({ reviewed_at: REVIEWED_AT, program_is_active: false });
      const past = renderSessionView();
      expect(screen.getByText(/from a past program — confirmation is locked/i)).toBeInTheDocument();
      expect(lockLine()).toBeNull();
      expect(coachLink()).toBeNull();
      expect(undoButton()).toBeNull();
      past.unmount();

      mockSessionData = session({ reviewed_at: REVIEWED_AT, archived_at: '2026-04-20T10:00:00Z' });
      renderSessionView();
      expect(screen.getByText(/archived by your coach — confirmation is locked/i)).toBeInTheDocument();
      expect(lockLine()).toBeNull();
      expect(coachLink()).toBeNull();
      expect(undoButton()).toBeNull();
    });
  });

  // Sessions reviewed without a confirmation, or whose confirmation was undone
  // after the review, exist from before the two were tied together.
  describe('not confirmed', () => {
    it('is read-only: no set, RPE, extra set, swap, skip or note can be written', () => {
      mockSetLogsData = { data: [PENDING_LOG], isLoading: false };
      mockSessionData = session({ exercise_slots: [SLOT], reviewed_at: REVIEWED_AT });
      renderSessionView();

      expect(screen.getByRole('button', { name: /mark set done/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /set rpe/i })).toBeDisabled();
      expect(screen.queryByRole('button', { name: /log what you actually did/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /add set/i })).toBeNull();
      expect(screen.queryByText(/can't do this exercise/i)).toBeNull();
      expect(screen.queryByRole('button', { name: /add note for coach/i })).toBeNull();
    });

    it('the same session, not reviewed, offers all of them', () => {
      mockSetLogsData = { data: [PENDING_LOG], isLoading: false };
      mockSessionData = session({ exercise_slots: [SLOT], reviewed_at: null });
      renderSessionView();

      expect(screen.getByRole('button', { name: /mark set done/i })).toBeEnabled();
      expect(screen.getByRole('button', { name: /set rpe/i })).toBeEnabled();
      expect(screen.getByRole('button', { name: /log what you actually did/i })).toBeEnabled();
      expect(screen.getByRole('button', { name: /add set/i })).toBeInTheDocument();
      expect(screen.getByText(/can't do this exercise/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /add note for coach/i })).toBeInTheDocument();
      expect(lockLine()).toBeNull();
    });

    // The video of a set is part of what the coach read. The lock reaches the
    // button through SetRow's `locked`, like every other control of the row.
    it('keeps the video the coach saw: it plays, and cannot be replaced or deleted', () => {
      const slot = { ...SLOT, record_video_set_numbers: [1] };
      mockSetLogsData = { data: [PENDING_LOG], isLoading: false };
      mockVideos = {
        data: [{ id: 'v-1', set_log_id: 'l-1', storage_path: 'u-1/slot-1/1.mp4' }],
        isLoading: false,
      };

      mockSessionData = session({ exercise_slots: [slot], reviewed_at: null });
      const open = renderSessionView();
      expect(screen.getByRole('button', { name: /replace video/i })).toBeEnabled();
      expect(screen.getByRole('button', { name: /delete video/i })).toBeEnabled();
      open.unmount();

      mockSessionData = session({ exercise_slots: [slot], reviewed_at: REVIEWED_AT });
      renderSessionView();
      expect(screen.getByRole('button', { name: /play video/i })).toBeEnabled();
      expect(screen.getByRole('button', { name: /replace video/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /delete video/i })).toBeDisabled();
    });

    // Confirming is the one thing left: without it the session would stay
    // "Next" in the training list for good.
    it('says why, links to the thread, and can still be confirmed', async () => {
      const user = userEvent.setup();
      mockSessionData = session({ reviewed_at: REVIEWED_AT });
      renderSessionView();

      expect(lockLine()).toHaveTextContent(/what you logged can no longer be changed/i);
      expect(lockLine()).toHaveTextContent(/you can still confirm the session/i);
      expect(coachLink()).toHaveAttribute('href', '/student/messages');

      await user.click(confirmButton());
      await user.click(screen.getByRole('button', { name: /^confirm$/i }));
      expect(mockConfirm.mutate).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'sess-1' }),
        expect.any(Object)
      );
    });

    it('keeps the read-only line of an archived session, and offers no confirmation there', () => {
      mockSessionData = session({ reviewed_at: REVIEWED_AT, archived_at: '2026-04-20T10:00:00Z' });
      renderSessionView();

      expect(screen.getByText(/archived by your coach — read-only/i)).toBeInTheDocument();
      expect(lockLine()).toBeNull();
      expect(coachLink()).toBeNull();
      expect(confirmButton()).toBeNull();
    });
  });

  // A prescribed set without its row is added by the database, through
  // useEnsureSetLogs. The page hands the hook what it shows and says whether
  // it may ask: on a reviewed session those would be sets the coach never
  // read, and the function refuses a session that is closed.
  describe('missing set rows', () => {
    const handedOver = () => mockEnsureSetLogs.mock.calls.at(-1);

    it('are left to the hook, with the session, its exercises and the sets the page has read', () => {
      mockSetLogsData = { data: [PENDING_LOG], isLoading: false };
      mockSessionData = session({ exercise_slots: [SLOT], reviewed_at: null });
      renderSessionView();
      expect(handedOver()).toEqual(['sess-1', [SLOT], [PENDING_LOG], { enabled: true }]);
    });

    it('are not asked for on a reviewed session', () => {
      mockSetLogsData = { data: [PENDING_LOG], isLoading: false };
      mockSessionData = session({ exercise_slots: [SLOT], reviewed_at: REVIEWED_AT });
      renderSessionView();
      expect(handedOver()[3]).toEqual({ enabled: false });
    });

    it('nor on a session of a past program, nor on an archived one', () => {
      mockSetLogsData = { data: [PENDING_LOG], isLoading: false };
      mockSessionData = session({ exercise_slots: [SLOT], program_is_active: false });
      renderSessionView().unmount();
      expect(handedOver()[3]).toEqual({ enabled: false });

      mockSessionData = session({ exercise_slots: [SLOT], archived_at: '2026-04-20T10:00:00Z' });
      renderSessionView();
      expect(handedOver()[3]).toEqual({ enabled: false });
    });

    // "Missing" is counted on the session and its sets: while one of the two
    // is being read again, the other may be the older copy.
    it('nor while the session or its sets are being read again', () => {
      mockSetLogsData = { data: [PENDING_LOG], isLoading: false };
      mockSessionData = { ...session({ exercise_slots: [SLOT] }), isFetching: true };
      renderSessionView().unmount();
      expect(handedOver()[3]).toEqual({ enabled: false });

      mockSessionData = session({ exercise_slots: [SLOT] });
      mockSetLogsData = { data: [PENDING_LOG], isLoading: false, isFetching: true };
      const view = renderSessionView();
      expect(handedOver()[3]).toEqual({ enabled: false });

      // Both have answered.
      mockSetLogsData = { data: [PENDING_LOG], isLoading: false, isFetching: false };
      rerenderSessionView(view);
      expect(handedOver()[3]).toEqual({ enabled: true });
    });
  });

  // `reviewed_at` comes from a cached row and nothing pushes a review to the
  // athlete's device, so "not reviewed" is only as true as the row is recent.
  // The page asks for the row again when a review may have happened behind it.
  describe('how the page learns of a review', () => {
    it('asks for the row again when it opens on a confirmed session', () => {
      mockConfirmation = { data: CONFIRMATION, isLoading: false };
      mockSessionData = session({ reviewed_at: null });
      const view = renderSessionView();

      expect(mockRefetchSession).toHaveBeenCalledTimes(1);
      // Joins a request already on its way instead of cancelling it.
      expect(mockRefetchSession).toHaveBeenCalledWith({ cancelRefetch: false });

      // An answer that still says "not reviewed" stands: no second request.
      rerenderSessionView(view);
      expect(mockRefetchSession).toHaveBeenCalledTimes(1);
    });

    it("asks again when the coach's feedback arrives", () => {
      mockSessionData = session({ reviewed_at: null });
      const view = renderSessionView();
      expect(mockRefetchSession).not.toHaveBeenCalled();

      mockFeedback = {
        data: { id: 'msg-1', body: 'Good work.', created_at: REVIEWED_AT },
      };
      rerenderSessionView(view);
      expect(mockRefetchSession).toHaveBeenCalledTimes(1);

      // The answer: the feedback reviewed the session.
      mockSessionData = session({ reviewed_at: REVIEWED_AT });
      rerenderSessionView(view);
      expect(lockLine()).toBeInTheDocument();
      expect(mockRefetchSession).toHaveBeenCalledTimes(1);
    });

    it('does not ask for a session in progress', () => {
      mockSetLogsData = { data: [PENDING_LOG], isLoading: false };
      mockSessionData = session({ exercise_slots: [SLOT], reviewed_at: null });
      renderSessionView();
      expect(mockRefetchSession).not.toHaveBeenCalled();
    });

    it('does not ask once the session is reviewed, or closed for another reason', () => {
      mockConfirmation = { data: CONFIRMATION, isLoading: false };
      mockFeedback = {
        data: { id: 'msg-1', body: 'Good work.', created_at: REVIEWED_AT },
      };

      mockSessionData = session({ reviewed_at: REVIEWED_AT });
      renderSessionView().unmount();
      mockSessionData = session({ reviewed_at: null, program_is_active: false });
      renderSessionView().unmount();
      mockSessionData = session({ reviewed_at: null, archived_at: '2026-04-20T10:00:00Z' });
      renderSessionView().unmount();

      expect(mockRefetchSession).not.toHaveBeenCalled();
    });

    // A review without feedback sends nothing that would refresh the row, so
    // the tap on Undo asks too — and the dialog does not outlive the answer.
    it('asks once more on a tap on Undo, and a "reviewed" answer takes the dialog away', async () => {
      const user = userEvent.setup();
      mockConfirmation = { data: CONFIRMATION, isLoading: false };
      mockSessionData = session({ reviewed_at: null });
      const view = renderSessionView();
      expect(mockRefetchSession).toHaveBeenCalledTimes(1);

      await user.click(undoButton());
      expect(mockRefetchSession).toHaveBeenCalledTimes(2);
      expect(mockRefetchSession).toHaveBeenLastCalledWith({ cancelRefetch: false });
      const dialog = screen.getByText(/undo confirmation\?/i).closest('dialog');
      expect(within(dialog).getByRole('button', { name: /undo confirmation/i })).toBeInTheDocument();

      mockSessionData = session({ reviewed_at: REVIEWED_AT });
      rerenderSessionView(view);

      expect(within(dialog).queryByRole('button', { name: /undo confirmation/i })).toBeNull();
      expect(undoButton()).toBeNull();
      expect(lockLine()).toBeInTheDocument();
      expect(mockUnconfirm.mutate).not.toHaveBeenCalled();
    });
  });
});

// The page is made of two reads — the session, and its sets — and both reach
// it through a cache the device keeps. Opened in a gym on a session that is not
// on the device, neither answers. That used to be rendered as an empty
// session: a page titled "Session", no exercise, and a live "Confirm session"
// (live item N1). What each state of the two reads looks like is here; that
// the real reads get into those states is in SessionView.offline.test.jsx.
describe('SessionView: a session whose reads did not answer', () => {
  const SLOT = {
    id: 'slot-1',
    sets: 1,
    reps: 5,
    weight_kg: 50,
    sort_order: 0,
    exercise: { id: 'ex-1', name: 'Squat', type: 'push', difficulty: 1, volume_weight: 1 },
  };
  const LOG = { id: 'l-1', exercise_slot_id: 'slot-1', set_number: 1, done: false, rpe: null };

  // A read as useQuery reports it, without data.
  const waiting = { data: undefined, isLoading: false, fetchStatus: 'paused', isPaused: true };
  const failed = { data: undefined, isLoading: false, fetchStatus: 'idle', isError: true };
  const onItsWay = { data: undefined, isLoading: true, fetchStatus: 'fetching' };
  // The sets are not asked for while the session has no exercise to show.
  const notAsked = { data: undefined, isLoading: false, fetchStatus: 'idle' };
  const loaded = (fields = {}) => ({
    data: { title: 'Pull A', exercise_slots: [SLOT], program_is_active: true, ...fields },
    isLoading: false,
    fetchStatus: 'idle',
  });

  const confirmButton = () => screen.queryByRole('button', { name: /^confirm session$/i });
  const retryButton = () => screen.queryByRole('button', { name: /try again/i });
  const notOnDevice = () => screen.queryByText(/this session isn’t on this device yet/i);
  const notLoaded = () => screen.queryByText(/this session couldn’t be loaded/i);

  function rerenderSessionView(view) {
    view.rerender(
      <MemoryRouter>
        <SessionView />
      </MemoryRouter>
    );
  }

  beforeEach(() => {
    mockOnline = true;
    mockConfirmation = { data: null, isLoading: false };
    mockFeedback = { data: null };
    mockDeviations = { data: [], isLoading: false };
    mockVideos = { data: [], isLoading: false };
    mockSessionData = loaded();
    mockSetLogsData = { data: [LOG], isLoading: false, fetchStatus: 'idle' };
    vi.clearAllMocks();
    resetRestTimer();
  });

  afterEach(() => {
    mockOnline = true;
  });

  it('without a network and with nothing on the device: says so, and offers nothing to confirm', () => {
    mockOnline = false;
    mockSessionData = waiting;
    mockSetLogsData = notAsked;
    // The confirmation was never read either, and waits like the rest.
    mockConfirmation = { data: undefined, isLoading: false };
    renderSessionView();

    expect(notOnDevice()).toBeInTheDocument();
    expect(screen.getByText(/you’re offline\. it will open as soon as the connection is back/i)).toBeInTheDocument();
    expect(retryButton()).toBeInTheDocument();
    // The page keeps its bar and its way back…
    expect(screen.getByText('Session')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /go back/i })).toBeInTheDocument();
    // …and nothing that speaks for a session it does not have.
    expect(confirmButton()).toBeNull();
    expect(screen.queryByText(/of \d+ sets/i)).toBeNull();
    expect(screen.queryByRole('status', { name: /loading/i })).toBeNull();
  });

  // A client that pauses its reads without a network says "paused" before the
  // device says "offline", and one that attempted the read ends on an error
  // while the device is offline: both are the same thing to the athlete.
  it('is the same message whether the read waits or was attempted and failed', () => {
    mockSessionData = waiting;
    mockSetLogsData = notAsked;
    const paused = renderSessionView();
    expect(notOnDevice()).toBeInTheDocument();
    expect(confirmButton()).toBeNull();
    paused.unmount();

    mockOnline = false;
    mockSessionData = failed;
    renderSessionView();
    expect(notOnDevice()).toBeInTheDocument();
    expect(notLoaded()).toBeNull();
    expect(confirmButton()).toBeNull();
  });

  it('on a network, a read that failed: says it could not be loaded, and "Try again" asks for it', async () => {
    const user = userEvent.setup();
    mockSessionData = failed;
    mockSetLogsData = notAsked;
    renderSessionView();

    expect(notLoaded()).toBeInTheDocument();
    expect(screen.getByText(/check your connection, then try again/i)).toBeInTheDocument();
    expect(notOnDevice()).toBeNull();
    expect(confirmButton()).toBeNull();

    await user.click(retryButton());
    // Joins a request already on its way instead of starting a second one.
    expect(mockRefetchSession).toHaveBeenCalledTimes(1);
    expect(mockRefetchSession).toHaveBeenCalledWith({ cancelRefetch: false });
    // No exercise is known: there are no sets to ask for.
    expect(mockRefetchLogs).not.toHaveBeenCalled();
  });

  // The session row is there and its sets are not: the exercises with no set
  // under them, and a confirmation of nothing, are not the session either.
  it('the session without its sets is not shown as exercises without sets', async () => {
    const user = userEvent.setup();
    mockOnline = false;
    mockSetLogsData = waiting;
    renderSessionView();

    expect(notOnDevice()).toBeInTheDocument();
    // What is known is said: the title of the session.
    expect(screen.getByText('Pull A')).toBeInTheDocument();
    expect(screen.queryByText('Squat')).toBeNull();
    expect(confirmButton()).toBeNull();

    await user.click(retryButton());
    expect(mockRefetchSession).toHaveBeenCalledWith({ cancelRefetch: false });
    expect(mockRefetchLogs).toHaveBeenCalledWith({ cancelRefetch: false });
  });

  it('holds its spinner while a read is on its way, and while the cache is read back from the device', () => {
    mockSessionData = onItsWay;
    mockSetLogsData = notAsked;
    const session = renderSessionView();
    expect(screen.getByRole('status')).toHaveAccessibleName(/loading/i);
    session.unmount();

    mockSessionData = loaded();
    mockSetLogsData = onItsWay;
    const sets = renderSessionView();
    expect(screen.getByRole('status')).toHaveAccessibleName(/loading/i);
    expect(retryButton()).toBeNull();
    sets.unmount();

    // At launch, before IndexedDB has answered: no read holds data and none
    // was sent, on a device that may hold the whole session.
    mockOnline = false;
    mockSessionData = notAsked;
    mockSetLogsData = notAsked;
    render(
      <IsRestoringProvider value={true}>
        <MemoryRouter>
          <SessionView />
        </MemoryRouter>
      </IsRestoringProvider>
    );
    expect(screen.getByRole('status')).toHaveAccessibleName(/loading/i);
    expect(notOnDevice()).toBeNull();
    expect(retryButton()).toBeNull();
  });

  // A refresh that failed leaves an error next to the last good answer, and
  // the device being offline changes nothing to what it holds.
  it('data wins: the workout the device holds is shown, offline and after a refresh that failed', () => {
    mockOnline = false;
    mockSessionData = { ...loaded(), isError: true, isPaused: true, fetchStatus: 'paused' };
    mockSetLogsData = { data: [LOG], isLoading: false, isError: true, fetchStatus: 'idle' };
    renderSessionView();

    expect(screen.getByText('Squat')).toBeInTheDocument();
    expect(screen.getByText(/0 of 1 sets/i)).toBeInTheDocument();
    expect(confirmButton()).toBeInTheDocument();
    expect(notOnDevice()).toBeNull();
    expect(notLoaded()).toBeNull();
  });

  it('a session without an exercise waits for no sets', () => {
    mockSessionData = loaded({ exercise_slots: [] });
    mockSetLogsData = notAsked;
    renderSessionView();

    expect(screen.getByText('Pull A')).toBeInTheDocument();
    expect(confirmButton()).toBeInTheDocument();
    expect(retryButton()).toBeNull();
  });

  it('asks again by itself when the network returns — once, not for as long as it fails', () => {
    mockOnline = false;
    mockSessionData = failed;
    mockSetLogsData = notAsked;
    const view = renderSessionView();
    expect(mockRefetchSession).not.toHaveBeenCalled();

    mockOnline = true;
    rerenderSessionView(view);
    expect(mockRefetchSession).toHaveBeenCalledTimes(1);
    expect(mockRefetchSession).toHaveBeenCalledWith({ cancelRefetch: false });

    // Still failing, still online: the message and its button, no loop.
    rerenderSessionView(view);
    rerenderSessionView(view);
    expect(mockRefetchSession).toHaveBeenCalledTimes(1);
    expect(notLoaded()).toBeInTheDocument();
  });

  it('asks for nothing when the network returns on a page that has its session', () => {
    mockOnline = false;
    const view = renderSessionView();
    mockOnline = true;
    rerenderSessionView(view);

    expect(mockRefetchSession).not.toHaveBeenCalled();
    expect(mockRefetchLogs).not.toHaveBeenCalled();
  });
});
