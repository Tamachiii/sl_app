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

  it('clicking Confirm session calls useConfirmSession with notes', async () => {
    const user = userEvent.setup();
    mockSessionData = { data: { title: 'Day 1', exercise_slots: [] }, isLoading: false };
    mockSetLogsData = { data: [], isLoading: false };
    renderSessionView();

    await user.type(screen.getByLabelText(/notes for your coach/i), 'felt strong');
    await user.click(screen.getByRole('button', { name: /^confirm session$/i }));

    expect(mockConfirm.mutate).toHaveBeenCalledWith(
      { sessionId: 'sess-1', notes: 'felt strong' },
      expect.any(Object)
    );
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
