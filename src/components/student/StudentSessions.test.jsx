import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

const mockNavigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'user-1' } }),
}));

let mockWeeks = { data: null, isLoading: true };
let mockConfirmedIds = { data: new Set() };

vi.mock('../../hooks/useStudentProgramDetails', () => ({
  useStudentProgramDetails: () => mockWeeks,
}));

vi.mock('../../hooks/useSessionConfirmation', () => ({
  useMyConfirmedSessionIds: () => mockConfirmedIds,
}));

import StudentSessions from './StudentSessions';

function renderSessions() {
  return render(
    <MemoryRouter>
      <StudentSessions />
    </MemoryRouter>
  );
}

const makeSession = (id, title, { archived = false } = {}) => ({
  id,
  title,
  sort_order: 0,
  archived_at: archived ? '2026-04-01T12:00:00Z' : null,
  exercise_slots: [
    { id: `${id}-s1`, sets: 3, reps: 5, weight_kg: 50, exercise: { name: 'Squat', type: 'push' } },
  ],
});

const sampleWeeks = [
  {
    id: 'w-1',
    week_number: 1,
    label: 'Base',
    sessions: [makeSession('sess-1', 'Lower 1'), makeSession('sess-2', 'Upper 1')],
  },
];

describe('StudentSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWeeks = { data: null, isLoading: true };
    mockConfirmedIds = { data: new Set() };
  });

  it('shows empty state when no program', () => {
    mockWeeks = { data: [], isLoading: false };
    renderSessions();
    expect(screen.getByText(/no program assigned yet/i)).toBeInTheDocument();
  });

  it('renders one card per non-archived session', () => {
    mockWeeks = { data: sampleWeeks, isLoading: false };
    renderSessions();
    expect(screen.getByText('Lower 1')).toBeInTheDocument();
    expect(screen.getByText('Upper 1')).toBeInTheDocument();
  });

  it('enforces accordion: only one card open at a time', async () => {
    const user = userEvent.setup();
    mockWeeks = { data: sampleWeeks, isLoading: false };
    renderSessions();

    // The two card header buttons are aria-expanded={false} initially.
    const [firstHeader, secondHeader] = screen.getAllByRole('button', { expanded: false });

    await user.click(firstHeader);
    // First card's body now shows "Squat" (the slot's exercise name).
    expect(screen.getAllByText('Squat').length).toBe(1);

    await user.click(secondHeader);
    // Still only one body open — the second one.
    expect(screen.getAllByText('Squat').length).toBe(1);
    // First header should now be collapsed again (aria-expanded={false}).
    const openHeaders = screen.getAllByRole('button', { expanded: true });
    expect(openHeaders).toHaveLength(1);
  });

  it('hides archived sessions by default and reveals them via the toggle', async () => {
    const user = userEvent.setup();
    mockWeeks = {
      data: [
        {
          id: 'w-1',
          week_number: 1,
          label: 'Base',
          sessions: [
            makeSession('sess-1', 'Lower 1'),
            makeSession('sess-arch', 'Old Session', { archived: true }),
          ],
        },
      ],
      isLoading: false,
    };
    renderSessions();

    expect(screen.queryByText('Old Session')).toBeNull();

    // Collapsed: only the bottom toggle is rendered.
    const initialToggles = screen.getAllByRole('button', { name: /Show 1 archived session/i });
    expect(initialToggles).toHaveLength(1);
    await user.click(initialToggles[0]);
    expect(screen.getByText('Old Session')).toBeInTheDocument();

    // Expanded: a second toggle is rendered above the archived weeks so a
    // student scrolled up to read them can collapse without scrolling back.
    const expandedToggles = screen.getAllByRole('button', { name: /Hide 1 archived session/i });
    expect(expandedToggles).toHaveLength(2);

    // Either toggle collapses.
    await user.click(expandedToggles[0]);
    expect(screen.queryByText('Old Session')).toBeNull();
  });
});
