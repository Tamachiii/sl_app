import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '../../hooks/useTheme';

const mockNavigate = vi.fn();
const mockCreateSession = { mutate: vi.fn(), isPending: false };
const mockDeleteSession = { mutate: vi.fn() };
const mockDuplicateWeek = { mutate: vi.fn(), isPending: false };

let mockWeekData = { data: null, isLoading: false };

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useParams: () => ({ studentId: 's-1', weekId: 'w-1' }),
  };
});

vi.mock('../../hooks/useWeek', () => ({
  useWeek: () => mockWeekData,
  useCreateSession: () => mockCreateSession,
  useDeleteSession: () => mockDeleteSession,
  useUpdateWeek: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateSession: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('../../hooks/useDuplicate', () => ({
  useDuplicateWeek: () => mockDuplicateWeek,
}));

vi.mock('../../hooks/useSessionConfirmation', () => ({
  useWeekConfirmedSessionIds: () => ({ data: new Set() }),
}));

import WeekView from './WeekView';

function renderWeekView() {
  return render(
    <ThemeProvider>
      <MemoryRouter>
        <WeekView />
      </MemoryRouter>
    </ThemeProvider>
  );
}

describe('WeekView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading spinner', () => {
    mockWeekData = { data: null, isLoading: true };
    renderWeekView();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('renders empty state when no sessions', () => {
    mockWeekData = {
      data: { week_number: 1, sessions: [] },
      isLoading: false,
    };
    renderWeekView();
    expect(screen.getByText('No sessions yet')).toBeInTheDocument();
  });

  it('renders session titles', () => {
    mockWeekData = {
      data: {
        week_number: 1,
        sessions: [
          { id: 'sess-1', title: 'Push Day', day_number: 1, exercise_slots: [] },
          { id: 'sess-2', title: 'Pull Day', day_number: 2, exercise_slots: [] },
        ],
      },
      isLoading: false,
    };
    renderWeekView();
    expect(screen.getByText('Push Day')).toBeInTheDocument();
    expect(screen.getByText('Pull Day')).toBeInTheDocument();
  });

  it('clicking open session chevron navigates to session editor', async () => {
    const user = userEvent.setup();
    mockWeekData = {
      data: {
        week_number: 1,
        sessions: [{ id: 'sess-1', title: 'Push Day', day_number: 1, exercise_slots: [] }],
      },
      isLoading: false,
    };
    renderWeekView();

    await user.click(screen.getByRole('button', { name: /open session/i }));
    expect(mockNavigate).toHaveBeenCalledWith('/coach/student/s-1/week/w-1/session/sess-1');
  });

  it('clicking "+ Add Session" calls createSession', async () => {
    const user = userEvent.setup();
    mockWeekData = {
      data: { week_number: 1, sessions: [] },
      isLoading: false,
    };
    renderWeekView();

    await user.click(screen.getByText('+ Add Session'));
    expect(mockCreateSession.mutate).toHaveBeenCalled();
  });

  it('clicking Duplicate calls duplicateWeek', async () => {
    const user = userEvent.setup();
    mockWeekData = {
      data: { week_number: 2, sessions: [] },
      isLoading: false,
    };
    renderWeekView();

    await user.click(screen.getByText('Duplicate'));
    expect(mockDuplicateWeek.mutate).toHaveBeenCalledWith({
      weekId: 'w-1',
      newWeekNumber: 3,
    });
  });

  it('clicking delete session with confirm calls deleteSession', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockWeekData = {
      data: {
        week_number: 1,
        sessions: [{ id: 'sess-1', title: 'Day 1', day_number: 1, exercise_slots: [] }],
      },
      isLoading: false,
    };
    renderWeekView();

    await user.click(screen.getByRole('button', { name: /delete session/i }));
    expect(mockDeleteSession.mutate).toHaveBeenCalledWith('sess-1');
    window.confirm.mockRestore();
  });
});
