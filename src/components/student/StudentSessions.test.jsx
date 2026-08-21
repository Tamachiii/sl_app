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

let mockFeedbackIds = { data: new Set() };

vi.mock('../../hooks/useMessages', () => ({
  useMyFeedbackSessionIds: () => mockFeedbackIds,
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

const activeProgram = { id: 'p-1', name: 'Block 1', sort_order: 0, is_active: true };

const sampleWeeks = [
  {
    id: 'w-1',
    week_number: 1,
    label: 'Base',
    program: activeProgram,
    sessions: [makeSession('sess-1', 'Lower 1'), makeSession('sess-2', 'Upper 1')],
  },
];

describe('StudentSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWeeks = { data: null, isLoading: true };
    mockConfirmedIds = { data: new Set() };
    mockFeedbackIds = { data: new Set() };
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
          program: activeProgram,
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

    const showToggle = screen.getByRole('button', { name: /Show 1 archived session/i });
    await user.click(showToggle);
    expect(screen.getByText('Old Session')).toBeInTheDocument();

    const hideToggle = screen.getByRole('button', { name: /Hide 1 archived session/i });
    expect(hideToggle).toHaveAttribute('aria-pressed', 'true');
    await user.click(hideToggle);
    expect(screen.queryByText('Old Session')).toBeNull();
  });

  it("renders the 'feedback' pill on cards whose session is in the feedback set", () => {
    mockWeeks = { data: sampleWeeks, isLoading: false };
    mockFeedbackIds = { data: new Set(['sess-1']) };
    renderSessions();
    // Only the matching session card carries the feedback pill — the second
    // session (sess-2) renders the standard Start affordance instead.
    expect(screen.getByText('feedback')).toBeInTheDocument();
    expect(screen.getAllByText('feedback')).toHaveLength(1);
  });

  it('renders weeks in reverse order — newest week_number first', () => {
    mockWeeks = {
      data: [
        {
          id: 'w-1',
          week_number: 1,
          label: 'Bloc 1/2',
          program: activeProgram,
          sessions: [makeSession('s-1a', 'A1'), makeSession('s-1b', 'A2')],
        },
        {
          id: 'w-2',
          week_number: 2,
          label: 'Bloc 2/2',
          program: activeProgram,
          sessions: [makeSession('s-2a', 'B1'), makeSession('s-2b', 'B2')],
        },
      ],
      isLoading: false,
    };
    renderSessions();

    // A week heading is now the coach's PHASE LABEL, not "Week N" — the
    // ordinal is grouping, not a calendar slot the student is measured against.
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings[0]).toBe('Bloc 2/2');
    expect(headings[1]).toBe('Bloc 1/2');

    // Sessions inside each week stay in their original order, and week 2's
    // sessions precede week 1's in the DOM (because week 2 is newer).
    const [a1, a2, b1, b2] = ['A1', 'A2', 'B1', 'B2'].map((tt) => screen.getByText(tt));
    const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;
    expect(b1.compareDocumentPosition(b2) & FOLLOWING).toBeTruthy();
    expect(a1.compareDocumentPosition(a2) & FOLLOWING).toBeTruthy();
    expect(b2.compareDocumentPosition(a1) & FOLLOWING).toBeTruthy();
  });

  it('groups weeks by program — active program first, then past programs', () => {
    const pastProgram = { id: 'p-0', name: 'Block 0', sort_order: -1, is_active: false };
    mockWeeks = {
      data: [
        {
          id: 'w-current',
          week_number: 1,
          label: null,
          program: activeProgram,
          sessions: [makeSession('cur-1', 'Current Session')],
        },
        {
          id: 'w-past',
          week_number: 1,
          label: null,
          program: pastProgram,
          sessions: [makeSession('past-1', 'Past Session')],
        },
      ],
      isLoading: false,
    };
    renderSessions();

    expect(screen.getByText('Block 1')).toBeInTheDocument();
    expect(screen.getByText('Block 0')).toBeInTheDocument();
    expect(screen.getByText(/past program/i)).toBeInTheDocument();

    const current = screen.getByText('Current Session');
    const past = screen.getByText('Past Session');
    const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;
    expect(current.compareDocumentPosition(past) & FOLLOWING).toBeTruthy();
  });

  it('reveals archived sessions from past programs when the toggle is on', async () => {
    const user = userEvent.setup();
    const pastProgram = { id: 'p-0', name: 'Block 0', sort_order: -1, is_active: false };
    mockWeeks = {
      data: [
        {
          id: 'w-current',
          week_number: 1,
          label: null,
          program: activeProgram,
          sessions: [makeSession('cur-1', 'Current Session')],
        },
        {
          id: 'w-past',
          week_number: 1,
          label: null,
          program: pastProgram,
          sessions: [makeSession('past-arch', 'Old Archived', { archived: true })],
        },
      ],
      isLoading: false,
    };
    renderSessions();

    expect(screen.queryByText('Old Archived')).toBeNull();
    expect(screen.queryByText('Block 0')).toBeNull();

    await user.click(screen.getByRole('button', { name: /Show 1 archived session/i }));
    expect(screen.getByText('Old Archived')).toBeInTheDocument();
    expect(screen.getByText('Block 0')).toBeInTheDocument();
  });
});
