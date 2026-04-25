import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '../../hooks/useTheme';

const mockNavigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'user-1' },
    profile: { full_name: 'Ada Lovelace' },
    signOut: vi.fn(),
  }),
}));

let mockWeeks = { data: null, isLoading: true };
let mockConfirmedIds = { data: new Set() };

vi.mock('../../hooks/useStudentProgramDetails', () => ({
  useStudentProgramDetails: () => mockWeeks,
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
      {
        id: 'sess-1',
        title: 'Push Day',
        day_number: 1,
        sort_order: 0,
        archived_at: null,
        exercise_slots: [
          { id: 'slot-1', sets: 3, reps: 8, weight_kg: 40, exercise: { id: 'ex-1', name: 'Bench Press' } },
        ],
      },
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

  it('shows the next unconfirmed session card', () => {
    mockWeeks = { data: sampleWeeks, isLoading: false };
    renderHome();
    expect(screen.getByText('Next session')).toBeInTheDocument();
    // Earliest unconfirmed session (by weekday) becomes the Next session card.
    expect(screen.getByText('Push Day')).toBeInTheDocument();
  });

  it('renders the Next session exercise list expanded by default (no toggle)', () => {
    mockWeeks = { data: sampleWeeks, isLoading: false };
    renderHome();
    // Exercise from the Push Day slot is visible without any interaction.
    expect(screen.getByText('Bench Press')).toBeInTheDocument();
    // The Next session card is non-collapsible — no expand/collapse toggle inside the section.
    const section = screen.getByRole('region', { name: /next session/i });
    const inSection = within(section);
    expect(inSection.queryByRole('button', { expanded: true })).toBeNull();
    expect(inSection.queryByRole('button', { expanded: false })).toBeNull();
  });

  it('surfaces the next unconfirmed session when the first is confirmed', () => {
    mockWeeks = { data: sampleWeeks, isLoading: false };
    mockConfirmedIds = { data: new Set(['sess-1']) };
    renderHome();
    // Remaining unconfirmed session becomes the Next session card.
    expect(screen.getByText('Next session')).toBeInTheDocument();
    expect(screen.getByText('Pull Day')).toBeInTheDocument();
  });

  it('keeps an archived session visible in the day strip (does not flip to Rest)', () => {
    mockWeeks = {
      data: [
        {
          id: 'w-1',
          week_number: 1,
          label: 'Intro',
          sessions: [
            { id: 'sess-1', title: 'Push Day', day_number: 1, sort_order: 0, archived_at: null },
            {
              id: 'sess-arch',
              title: 'Leg 1',
              day_number: 3,
              sort_order: 1,
              archived_at: '2026-04-22T08:00:00Z',
            },
          ],
        },
      ],
      isLoading: false,
    };
    renderHome();
    // The archived session keeps its title in the day strip and is exposed as archived to AT.
    expect(screen.getByLabelText(/Leg 1 \(archived\)/i)).toBeInTheDocument();
    // The cell is disabled — no click navigates from an archived day.
    const cell = screen.getByLabelText(/Leg 1 \(archived\)/i);
    expect(cell).toBeDisabled();
  });

  it('clicking a day-strip cell navigates to that session', async () => {
    const user = userEvent.setup();
    mockWeeks = { data: sampleWeeks, isLoading: false };
    renderHome();
    // The Wednesday cell links to sess-2 (day_number 3). Its aria-label exposes the title.
    await user.click(screen.getByLabelText(/Pull Day/));
    expect(mockNavigate).toHaveBeenCalledWith('/student/session/sess-2');
  });
});
