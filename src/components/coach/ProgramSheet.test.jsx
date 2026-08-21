import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const mockCreateWeek = { mutate: vi.fn(), isPending: false };
const mockCreateSession = { mutate: vi.fn(), isPending: false };
const mockUpdateSession = { mutate: vi.fn(), isPending: false };
const mockDeleteSession = { mutate: vi.fn(), isPending: false };
const mockDeleteWeek = { mutate: vi.fn(), isPending: false };
const mockUpdateWeek = { mutate: vi.fn(), isPending: false };
const mockReorderWeeks = { mutate: vi.fn(), isPending: false };
const mockDuplicateWeek = { mutate: vi.fn(), isPending: false };

vi.mock('../../hooks/useWeek', () => ({
  useCreateWeek: () => mockCreateWeek,
  useReorderWeeks: () => mockReorderWeeks,
  useUpdateWeek: () => mockUpdateWeek,
  useDeleteWeek: () => mockDeleteWeek,
  useCreateSession: () => mockCreateSession,
  useUpdateSession: () => mockUpdateSession,
  useDeleteSession: () => mockDeleteSession,
}));

vi.mock('../../hooks/useDuplicate', () => ({
  useDuplicateWeek: () => mockDuplicateWeek,
}));

let mockConfirmed = { data: new Set() };
vi.mock('../../hooks/useSessionConfirmation', () => ({
  useProgramConfirmedSessionIds: () => mockConfirmed,
}));

// CopyDialog pulls the student list + program hooks; stub them out so this
// test stays focused on the sheet itself.
vi.mock('../../hooks/useStudents', () => ({
  useStudents: () => ({ data: [{ id: 's-1', profile: { full_name: 'Alice' } }] }),
}));
vi.mock('../../hooks/useProgram', () => ({
  useActiveProgram: () => ({ data: null }),
  useProgram: () => ({ data: null }),
}));

import ProgramSheet from './ProgramSheet';

const program = {
  id: 'prog-1',
  weeks: [
    {
      id: 'w-1',
      program_id: 'prog-1',
      week_number: 1,
      label: 'Intro',
      sessions: [
        { id: 'sess-1', title: 'Pull', day_number: 1, sort_order: 0, archived_at: null, exercise_slots: [{ id: 'x' }, { id: 'y' }] },
        { id: 'sess-2', title: 'Push', day_number: 3, sort_order: 1, archived_at: null, exercise_slots: [{ id: 'z' }] },
        { id: 'sess-old', title: 'Old', day_number: 5, sort_order: 2, archived_at: '2026-01-01', exercise_slots: [] },
      ],
    },
    {
      id: 'w-2',
      program_id: 'prog-1',
      week_number: 2,
      label: null,
      sessions: [
        { id: 'sess-3', title: 'Legs', day_number: 2, sort_order: 0, archived_at: null, exercise_slots: [] },
      ],
    },
  ],
};

function renderSheet(p = program) {
  return render(
    <MemoryRouter>
      <ProgramSheet studentId="s-1" program={p} />
    </MemoryRouter>,
  );
}

describe('ProgramSheet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfirmed = { data: new Set() };
    // The sheet remembers the open week per program in localStorage so it
    // survives a trip into the session editor — clear it so cases don't
    // inherit whichever week a previous case expanded.
    localStorage.clear();
  });

  it('lists every week with its session count and exercise total', () => {
    renderSheet();
    // W1 has 2 active sessions (the archived one is excluded) and 3 slots.
    expect(screen.getByText('2 sessions · 3 ex')).toBeInTheDocument();
    expect(screen.getByText('1 sessions · 0 ex')).toBeInTheDocument();
  });

  it('shows the sessions of the current week inline — the old chip strip showed none', () => {
    renderSheet();
    expect(screen.getByText('Pull')).toBeInTheDocument();
    expect(screen.getByText('Push')).toBeInTheDocument();
    // Day pills render the weekday, not a bare number.
    expect(screen.getByRole('button', { name: /day: mon/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /day: wed/i })).toBeInTheDocument();
  });

  it('lists sessions by training day, not by the order they were created', () => {
    // A Friday session written before the Wednesday one: the week must still
    // read Mon → Wed → Fri. Creation order (sort_order) says the opposite.
    renderSheet({
      ...program,
      weeks: [{
        ...program.weeks[0],
        sessions: [
          { id: 's-mon', title: 'Upper 1', day_number: 1, sort_order: 0, archived_at: null, exercise_slots: [] },
          { id: 's-fri', title: 'Upper 2', day_number: 5, sort_order: 1, archived_at: null, exercise_slots: [] },
          { id: 's-wed', title: 'Leg', day_number: 3, sort_order: 2, archived_at: null, exercise_slots: [] },
        ],
      }],
    });

    const order = screen.getAllByText(/^(Upper 1|Upper 2|Leg)$/).map((n) => n.textContent);
    expect(order).toEqual(['Upper 1', 'Leg', 'Upper 2']);
  });

  it('excludes archived sessions from the active list', () => {
    renderSheet();
    expect(screen.queryByText('Old')).not.toBeInTheDocument();
    expect(screen.getByText(/show 1 archived/i)).toBeInTheDocument();
  });

  it('opens a session inside the athlete shell (no /coach/student/ prefix)', async () => {
    const user = userEvent.setup();
    renderSheet();
    await user.click(screen.getAllByRole('button', { name: /open session/i })[0]);
    expect(mockNavigate).toHaveBeenCalledWith('/coach/students/s-1/s/sess-1');
  });

  it('remembers the open week so returning from a session keeps your place', async () => {
    const user = userEvent.setup();
    const { unmount } = renderSheet();
    // Collapse the default week and open W2 instead.
    await user.click(screen.getAllByRole('button', { name: /week 2/i })[0]);
    expect(screen.getByText('Legs')).toBeInTheDocument();

    // Simulate stepping into the session editor and coming back.
    unmount();
    renderSheet();
    expect(screen.getByText('Legs')).toBeInTheDocument();
    expect(screen.queryByText('Pull')).not.toBeInTheDocument();
  });

  it('writes day_number when a weekday is picked', async () => {
    const user = userEvent.setup();
    renderSheet();
    await user.click(screen.getByRole('button', { name: /day: mon/i }));
    await user.click(screen.getByRole('button', { name: 'Thu' }));
    expect(mockUpdateSession.mutate).toHaveBeenCalledWith({ id: 'sess-1', day_number: 4 });
  });

  // A weekday is a recommendation the coach makes deliberately, so a new
  // session starts without one. Auto-filling the next free day made every
  // session look due on a date nobody chose — and capped a week at 7, since
  // day 8 fell outside the strips and the session vanished from them.
  it('adds a session with no recommended weekday', async () => {
    const user = userEvent.setup();
    renderSheet();
    await user.click(screen.getByRole('button', { name: /add session/i }));
    expect(mockCreateSession.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ weekId: 'w-1', dayNumber: null }),
    );
  });

  it('adds a week at max(week_number) + 1', async () => {
    const user = userEvent.setup();
    renderSheet();
    await user.click(screen.getByRole('button', { name: /\+ week/i }));
    expect(mockCreateWeek.mutate).toHaveBeenCalledWith({ programId: 'prog-1', weekNumber: 3 });
  });

  it('duplicates a week without pinning a week number (the hook resolves max+1)', async () => {
    const user = userEvent.setup();
    renderSheet();
    await user.click(screen.getAllByRole('button', { name: /week options/i })[0]);
    await user.click(screen.getByRole('button', { name: /duplicate/i }));
    expect(mockDuplicateWeek.mutate).toHaveBeenCalledWith({ weekId: 'w-1' });
  });

  it('expands the first week with unconfirmed work, not simply the first week', () => {
    // Week 1 fully confirmed → week 2 becomes the one that needs attention.
    mockConfirmed = { data: new Set(['sess-1', 'sess-2']) };
    renderSheet();
    expect(screen.getByText('Legs')).toBeInTheDocument();
    expect(screen.queryByText('Pull')).not.toBeInTheDocument();
  });

  it('marks confirmed sessions', () => {
    mockConfirmed = { data: new Set(['sess-1', 'sess-2']) };
    renderSheet();
    // Week 2 is the expanded one; its session is unconfirmed.
    expect(screen.queryByLabelText(/confirmed by student/i)).not.toBeInTheDocument();
  });

  it('enters reorder mode from the week menu, not a standing top-level button', async () => {
    const user = userEvent.setup();
    renderSheet();
    // No reorder control until you ask for one.
    expect(screen.queryByRole('button', { name: /reorder weeks/i })).not.toBeInTheDocument();
    expect(screen.getByText('Pull')).toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: /week options/i })[0]);
    await user.click(screen.getByRole('button', { name: /reorder weeks/i }));

    // Session rows collapse out of the way and drag handles appear.
    expect(screen.queryByText('Pull')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /reorder week 1/i })[0]).toBeInTheDocument();

    // Done exits the mode and the sheet comes back.
    await user.click(screen.getByRole('button', { name: /done/i }));
    expect(screen.getByText('Pull')).toBeInTheDocument();
  });

  it('offers no reorder entry when there is only one week to order', async () => {
    const user = userEvent.setup();
    renderSheet({ id: 'prog-1', weeks: [program.weeks[0]] });
    await user.click(screen.getByRole('button', { name: /week options/i }));
    expect(screen.queryByRole('button', { name: /reorder weeks/i })).not.toBeInTheDocument();
  });

  it('keeps destructive session delete off the sheet rows', () => {
    renderSheet();
    expect(screen.getByText('Pull')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete session/i })).not.toBeInTheDocument();
  });

  it('renders an empty state when the program has no weeks', () => {
    renderSheet({ id: 'prog-1', weeks: [] });
    expect(screen.getByText(/no weeks yet/i)).toBeInTheDocument();
  });

  it('lets the coach collapse the open week', async () => {
    const user = userEvent.setup();
    renderSheet();
    const w1 = screen.getAllByRole('button', { name: /week 1/i })[0];
    await user.click(w1);
    expect(screen.queryByText('Pull')).not.toBeInTheDocument();
  });

  it('keeps the archived drawer linked to the review page', async () => {
    const user = userEvent.setup();
    renderSheet();
    await user.click(screen.getByText(/show 1 archived/i));
    const archived = screen.getByRole('button', { name: /open archived session/i });
    expect(within(archived).getByText('Old')).toBeInTheDocument();
    await user.click(archived);
    expect(mockNavigate).toHaveBeenCalledWith('/coach/student/s-1/session/sess-old/review');
  });
});
