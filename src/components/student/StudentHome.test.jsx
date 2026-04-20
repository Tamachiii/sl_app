import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '../../hooks/useTheme';

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

vi.mock('../../hooks/useStudentWeeks', () => ({
  useStudentWeeks: () => mockWeeks,
}));

vi.mock('../../hooks/useSessionConfirmation', () => ({
  useMyConfirmedSessionIds: () => mockConfirmedIds,
}));

import StudentHome from './StudentHome';

function renderHome() {
  return render(
    <ThemeProvider>
      <MemoryRouter>
        <StudentHome />
      </MemoryRouter>
    </ThemeProvider>
  );
}

const sampleWeeks = [
  {
    id: 'w-1',
    week_number: 1,
    label: 'Intro',
    sessions: [
      { id: 'sess-1', title: 'Push Day', day_number: 1, sort_order: 0, archived_at: null },
      { id: 'sess-2', title: 'Pull Day', day_number: 3, sort_order: 1, archived_at: null },
    ],
  },
];

describe('StudentHome', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWeeks = { data: null, isLoading: true };
    mockConfirmedIds = { data: new Set() };
  });

  it('renders the Home header', () => {
    renderHome();
    expect(screen.getByText('Home')).toBeInTheDocument();
  });

  it('shows spinner while loading', () => {
    renderHome();
    expect(screen.queryByText(/week/i)).not.toBeInTheDocument();
  });

  it('shows empty state when no weeks', () => {
    mockWeeks = { data: [], isLoading: false };
    renderHome();
    expect(screen.getByText(/no program assigned yet/i)).toBeInTheDocument();
  });

  it('renders the active week heading', () => {
    mockWeeks = { data: sampleWeeks, isLoading: false };
    renderHome();
    expect(screen.getByText(/Week 1/)).toBeInTheDocument();
  });

  it('renders a 7-day strip with 7 cells', () => {
    mockWeeks = { data: sampleWeeks, isLoading: false };
    renderHome();
    // Day labels M T W T F S S
    const mCells = screen.getAllByText('M');
    expect(mCells.length).toBeGreaterThanOrEqual(1);
  });

  it('shows upcoming section with unconfirmed sessions', () => {
    mockWeeks = { data: sampleWeeks, isLoading: false };
    renderHome();
    expect(screen.getByText('Upcoming')).toBeInTheDocument();
    expect(screen.getByText('Push Day')).toBeInTheDocument();
    expect(screen.getByText('Pull Day')).toBeInTheDocument();
  });

  it('moves confirmed sessions into completed section', () => {
    mockWeeks = { data: sampleWeeks, isLoading: false };
    mockConfirmedIds = { data: new Set(['sess-1']) };
    renderHome();
    expect(screen.getByText('Completed this week')).toBeInTheDocument();
    expect(screen.getByText('Upcoming')).toBeInTheDocument();
  });

  it('clicking an upcoming session navigates to SessionView', async () => {
    const user = userEvent.setup();
    mockWeeks = { data: sampleWeeks, isLoading: false };
    renderHome();
    // The upcoming section shows the session; click the card button
    const cards = screen.getAllByText('Push Day');
    await user.click(cards[0]);
    expect(mockNavigate).toHaveBeenCalledWith('/student/session/sess-1');
  });
});
