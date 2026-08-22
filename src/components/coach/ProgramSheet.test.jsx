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
const mockReorderSessions = { mutate: vi.fn(), isPending: false };
const mockMoveSession = { mutate: vi.fn(), isPending: false };
const mockArchiveSession = { mutate: vi.fn(), isPending: false };
const mockArchiveSessions = { mutate: vi.fn(), isPending: false };
const mockCopySessions = { mutate: vi.fn(), isPending: false };
const mockDuplicateWeek = { mutate: vi.fn(), isPending: false };
const mockDuplicateSession = { mutate: vi.fn(), isPending: false };

vi.mock('../../hooks/useWeek', () => ({
  useCreateWeek: () => mockCreateWeek,
  useReorderWeeks: () => mockReorderWeeks,
  useReorderSessions: () => mockReorderSessions,
  useMoveSession: () => mockMoveSession,
  useArchiveSession: () => mockArchiveSession,
  useArchiveSessions: () => mockArchiveSessions,
  useUpdateWeek: () => mockUpdateWeek,
  useDeleteWeek: () => mockDeleteWeek,
  useCreateSession: () => mockCreateSession,
  useUpdateSession: () => mockUpdateSession,
  useDeleteSession: () => mockDeleteSession,
}));

vi.mock('../../hooks/useDuplicate', () => ({
  useDuplicateWeek: () => mockDuplicateWeek,
  useDuplicateSession: () => mockDuplicateSession,
  useCopySessions: () => mockCopySessions,
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
  useProgramsForStudent: () => ({ data: [] }),
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

const oneWeek = { id: 'prog-1', weeks: [program.weeks[0]] };

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
    localStorage.clear();
  });

  // The block is ONE list. It used to be an accordion of week cards with a
  // single one expanded, so the order the athlete would actually train in was
  // only ever visible a week at a time.
  it('shows every session of the block at once, across phases', () => {
    renderSheet();
    expect(screen.getByText('Pull')).toBeInTheDocument();
    expect(screen.getByText('Push')).toBeInTheDocument();
    expect(screen.getByText('Legs')).toBeInTheDocument();
    // Day pills render the weekday, not a bare number.
    expect(screen.getByRole('button', { name: /day: mon/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /day: wed/i })).toBeInTheDocument();
  });

  it('has no collapse control — nothing to expand', () => {
    renderSheet();
    expect(screen.queryByRole('button', { name: /week 1/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /week 2/i })).toBeNull();
  });

  // A phase carries a free name and no number: the number was what made a week
  // feel like a fixed-length container, which is the idea the queue refactor
  // removed.
  describe('phase dividers', () => {
    it('shows the name, never a week number', () => {
      renderSheet();
      expect(screen.getByText('Intro')).toBeInTheDocument();
      expect(screen.queryByText(/^W\d/)).toBeNull();
      expect(screen.queryByText(/week \d/i)).toBeNull();
    });

    // Half the phases in production are unnamed; hiding their divider would
    // silently merge them into the phase above.
    it('still draws an unnamed phase, offering the name', () => {
      renderSheet();
      const namers = screen.getAllByRole('button', { name: /edit week label/i });
      expect(namers).toHaveLength(2);
      expect(screen.getByText('Name this phase')).toBeInTheDocument();
    });

    it('renames in place', async () => {
      const user = userEvent.setup();
      renderSheet();
      await user.click(screen.getByText('Intro'));
      const input = screen.getByRole('textbox');
      await user.clear(input);
      await user.type(input, 'Accumulation{Enter}');
      expect(mockUpdateWeek.mutate).toHaveBeenCalledWith({ id: 'w-1', label: 'Accumulation' });
    });

    it('reports each phase size once there is more than one', () => {
      renderSheet();
      expect(screen.getByText('2 sessions · 3 ex')).toBeInTheDocument();
      expect(screen.getByText('1 sessions · 0 ex')).toBeInTheDocument();
    });

    it('adds a session to the phase whose menu was used', async () => {
      const user = userEvent.setup();
      renderSheet();
      await user.click(screen.getAllByRole('button', { name: /phase options/i })[0]);
      // The footer offers the same label; the menu's copy comes first in the
      // DOM because the divider it hangs off sits above the list.
      await user.click(screen.getAllByRole('button', { name: /add session/i })[0]);
      expect(mockCreateSession.mutate).toHaveBeenCalledWith(
        expect.objectContaining({ weekId: 'w-1' }),
      );
    });

    it('duplicates a phase without pinning a number (the hook resolves max+1)', async () => {
      const user = userEvent.setup();
      renderSheet();
      await user.click(screen.getAllByRole('button', { name: /phase options/i })[0]);
      // Exact name: every session row also offers "Duplicate session".
      await user.click(screen.getByRole('button', { name: 'duplicate' }));
      expect(mockDuplicateWeek.mutate).toHaveBeenCalledWith({ weekId: 'w-1' });
    });

    it('adds a phase at max(week_number) + 1', async () => {
      const user = userEvent.setup();
      renderSheet();
      await user.click(screen.getByRole('button', { name: /\+ phase/i }));
      expect(mockCreateWeek.mutate).toHaveBeenCalledWith({ programId: 'prog-1', weekNumber: 3 });
    });

    it('names the phase in the delete confirmation instead of numbering it', async () => {
      const user = userEvent.setup();
      renderSheet();
      await user.click(screen.getAllByRole('button', { name: /phase options/i })[0]);
      await user.click(screen.getByRole('button', { name: /delete phase/i }));
      expect(screen.getByText(/Delete “Intro”/)).toBeInTheDocument();
    });
  });

  // The sheet lists sessions in the POSITION the coach put them in, and that is
  // the same order the athlete's queue reads. Weekdays used to rank first,
  // which made the day pill the only real reorder control.
  it('lists sessions by position, not by recommended weekday', () => {
    renderSheet({
      ...program,
      weeks: [{
        ...program.weeks[0],
        sessions: [
          { id: 's-fri', title: 'Upper 2', day_number: 5, sort_order: 0, archived_at: null, exercise_slots: [] },
          { id: 's-mon', title: 'Upper 1', day_number: 1, sort_order: 1, archived_at: null, exercise_slots: [] },
          { id: 's-wed', title: 'Leg', day_number: 3, sort_order: 2, archived_at: null, exercise_slots: [] },
        ],
      }],
    });

    const order = screen.getAllByText(/^(Upper 1|Upper 2|Leg)$/).map((n) => n.textContent);
    expect(order).toEqual(['Upper 2', 'Upper 1', 'Leg']);
  });

  // Positions run across the whole block, because that is the number the coach
  // is looking at in a single list.
  it('numbers untitled sessions across phases, not within one', () => {
    renderSheet({
      ...program,
      weeks: [
        program.weeks[0],
        { ...program.weeks[1], sessions: [
          { id: 'blank', title: '', day_number: null, sort_order: 0, archived_at: null, exercise_slots: [] },
        ] },
      ],
    });
    expect(screen.getByText('Session 3')).toBeInTheDocument();
  });

  describe('session reorder mode', () => {
    it('offers Reorder once the block holds more than one session', () => {
      renderSheet();
      expect(screen.getByRole('button', { name: /^reorder$/i })).toBeInTheDocument();
    });

    it('offers no Reorder for a single session — nothing to order', () => {
      renderSheet({
        ...program,
        weeks: [{
          ...program.weeks[0],
          sessions: [
            { id: 'only', title: 'Solo', day_number: 1, sort_order: 0, archived_at: null, exercise_slots: [] },
          ],
        }],
      });
      expect(screen.queryByRole('button', { name: /^reorder$/i })).toBeNull();
    });

    it('swaps the rows for drag handles that KEEP their titles', async () => {
      const user = userEvent.setup();
      renderSheet();
      await user.click(screen.getByRole('button', { name: /^reorder$/i }));

      expect(screen.getByText('Pull')).toBeInTheDocument();
      expect(screen.getByText('Legs')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /reorder pull/i })).toBeInTheDocument();
      // Every other control steps out of the way so a drag can't mis-tap.
      expect(screen.queryByRole('button', { name: /day: mon/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /duplicate session/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /add session/i })).toBeNull();
    });

    // Dragging across a divider is the gesture that used to be impossible —
    // the editor's "copy to" duplicated the session and left the original.
    it('says so when there is a divider to drag across', async () => {
      const user = userEvent.setup();
      renderSheet();
      await user.click(screen.getByRole('button', { name: /^reorder$/i }));
      expect(screen.getByText(/drag a session onto a phase name/i)).toBeInTheDocument();
    });

    it('keeps that hint out of a single-phase block', async () => {
      const user = userEvent.setup();
      renderSheet(oneWeek);
      await user.click(screen.getByRole('button', { name: /^reorder$/i }));
      expect(screen.queryByText(/drag a session onto a phase name/i)).toBeNull();
    });

    it('leaves the mode on Done', async () => {
      const user = userEvent.setup();
      renderSheet();
      await user.click(screen.getByRole('button', { name: /^reorder$/i }));
      await user.click(screen.getByRole('button', { name: /^done$/i }));
      expect(screen.getByRole('button', { name: /day: mon/i })).toBeInTheDocument();
    });
  });

  describe('phase reorder mode', () => {
    it('is offered only from a divider menu, and only with several phases', async () => {
      const user = userEvent.setup();
      renderSheet();
      expect(screen.queryByRole('button', { name: /reorder phases/i })).toBeNull();
      await user.click(screen.getAllByRole('button', { name: /phase options/i })[0]);
      expect(screen.getByRole('button', { name: /reorder phases/i })).toBeInTheDocument();
    });

    it('is absent for a lone phase', async () => {
      const user = userEvent.setup();
      renderSheet(oneWeek);
      await user.click(screen.getByRole('button', { name: /phase options/i }));
      expect(screen.queryByRole('button', { name: /reorder phases/i })).toBeNull();
    });

    it('hides the sessions so a phase is dragged as a whole', async () => {
      const user = userEvent.setup();
      renderSheet();
      await user.click(screen.getAllByRole('button', { name: /phase options/i })[0]);
      await user.click(screen.getByRole('button', { name: /reorder phases/i }));

      expect(screen.queryByText('Pull')).toBeNull();
      expect(screen.getByRole('button', { name: /reorder intro/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /reorder unnamed phase/i })).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /^done$/i }));
      expect(screen.getByText('Pull')).toBeInTheDocument();
    });
  });

  // The coach's two named jobs. Archiving was previously unreachable from this
  // surface at all: useArchiveSession's only caller was SessionReview, which a
  // never-performed session can't reach — so the only tool for one was delete.
  describe('selection mode', () => {
    async function enterSelect(user) {
      await user.click(screen.getByRole('button', { name: /^select$/i }));
    }

    it('turns rows into pressable targets and reports the count', async () => {
      const user = userEvent.setup();
      renderSheet();
      await enterSelect(user);

      expect(screen.getByText('0 selected')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /Pull/ }));
      expect(screen.getByText('1 selected')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /Push/ }));
      expect(screen.getByText('2 selected')).toBeInTheDocument();
      // Tapping again deselects.
      await user.click(screen.getByRole('button', { name: /Push/ }));
      expect(screen.getByText('1 selected')).toBeInTheDocument();
    });

    // One selection for the whole block: archiving a finished mesocycle used to
    // be one pass per week card.
    it('spans phases', async () => {
      const user = userEvent.setup();
      renderSheet();
      await enterSelect(user);
      await user.click(screen.getByRole('button', { name: /Pull/ }));
      await user.click(screen.getByRole('button', { name: /Legs/ }));
      await user.click(screen.getByRole('button', { name: /^archive$/i }));

      expect(mockArchiveSessions.mutate).toHaveBeenCalledWith(
        { sessionIds: ['sess-1', 'sess-3'], archived: true },
        expect.any(Object),
      );
    });

    it('keeps both actions inert until something is picked', async () => {
      const user = userEvent.setup();
      renderSheet();
      await enterSelect(user);
      expect(screen.getByRole('button', { name: /^archive$/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /copy to/i })).toBeDisabled();
    });

    it('leaves the mode and clears the selection on dismiss', async () => {
      const user = userEvent.setup();
      renderSheet();
      await enterSelect(user);
      await user.click(screen.getByRole('button', { name: /Pull/ }));
      await user.click(screen.getByRole('button', { name: /cancel/i }));

      expect(screen.queryByText(/selected/)).toBeNull();
      // Back to the normal row, day pill and all.
      expect(screen.getByRole('button', { name: /day: mon/i })).toBeInTheDocument();
    });

    it('copies the selection into the week chosen in the dialog', async () => {
      const user = userEvent.setup();
      renderSheet();
      await enterSelect(user);
      await user.click(screen.getByRole('button', { name: /Pull/ }));
      await user.click(screen.getByRole('button', { name: /copy to/i }));
      // Scoped to the OPEN dialog: `Dialog` mounts its children whatever its
      // state, and the sheet renders a second CopyDialog for phase copying.
      const dialog = screen.getByRole('dialog');
      // It asks for the destination BLOCK before the week — the step that
      // lifts the old active-program-only restriction.
      // Exact strings, not regexes: a substring regex also matches the <label>
      // wrapping each <span>, which reads as two hits for one field.
      expect(within(dialog).getByText('Destination block')).toBeInTheDocument();
      expect(within(dialog).getByText('Destination week')).toBeInTheDocument();
    });
  });

  // Restoring meant opening the session's review page, a full-page route whose
  // back button lands on an unrelated feed — a one-way trip out of Programming.
  it('restores an archived session in place, without leaving the sheet', async () => {
    const user = userEvent.setup();
    renderSheet();
    await user.click(screen.getByText(/show 1 archived/i));
    await user.click(screen.getByRole('button', { name: /restore this session/i }));

    expect(mockArchiveSession.mutate).toHaveBeenCalledWith({
      sessionId: 'sess-old',
      archived: false,
    });
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('excludes archived sessions from the active list', () => {
    renderSheet();
    expect(screen.queryByText('Old')).not.toBeInTheDocument();
    expect(screen.getByText(/show 1 archived/i)).toBeInTheDocument();
  });

  // One drawer for the block, not one per phase: which phase an archived
  // session used to sit in is not what the coach is looking for.
  it('gathers archived sessions from every phase into one drawer', async () => {
    const user = userEvent.setup();
    renderSheet({
      ...program,
      weeks: [
        program.weeks[0],
        { ...program.weeks[1], sessions: [
          ...program.weeks[1].sessions,
          { id: 'sess-old-2', title: 'Older', day_number: null, sort_order: 9, archived_at: '2026-01-02', exercise_slots: [] },
        ] },
      ],
    });
    await user.click(screen.getByText(/show 2 archived/i));
    expect(screen.getByText('Old')).toBeInTheDocument();
    expect(screen.getByText('Older')).toBeInTheDocument();
  });

  it('opens a session inside the athlete shell (no /coach/student/ prefix)', async () => {
    const user = userEvent.setup();
    renderSheet();
    await user.click(screen.getAllByRole('button', { name: /open session/i })[0]);
    expect(mockNavigate).toHaveBeenCalledWith('/coach/students/s-1/s/sess-1');
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
  it('adds a session with no recommended weekday, at the end of the block', async () => {
    const user = userEvent.setup();
    renderSheet();
    await user.click(screen.getByRole('button', { name: /add session/i }));
    expect(mockCreateSession.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ weekId: 'w-2', dayNumber: null }),
    );
  });

  it('marks confirmed sessions', () => {
    mockConfirmed = { data: new Set(['sess-1']) };
    renderSheet();
    expect(screen.getAllByLabelText(/confirmed by student/i)).toHaveLength(1);
  });

  // Building a block is a run of near-identical sessions; doing that from the
  // editor costs two navigations per copy.
  it('duplicates a session straight from its row', async () => {
    const user = userEvent.setup();
    renderSheet();
    await user.click(screen.getAllByRole('button', { name: /duplicate session/i })[0]);
    expect(mockDuplicateSession.mutate).toHaveBeenCalledWith({ sessionId: 'sess-1' });
  });

  it('keeps destructive session delete off the sheet rows', () => {
    renderSheet();
    expect(screen.getByText('Pull')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete session/i })).not.toBeInTheDocument();
  });

  // An empty block asks for a SESSION: the phase is a grouping the coach may
  // never want, so it is created implicitly behind that one CTA.
  it('offers to add a session, not a phase, when the block is empty', async () => {
    const user = userEvent.setup();
    renderSheet({ id: 'prog-1', weeks: [] });
    expect(screen.getByText(/empty block/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /\+ phase/i })).toBeNull();

    await user.click(screen.getByRole('button', { name: /add session/i }));
    expect(mockCreateWeek.mutate).toHaveBeenCalledWith(
      { programId: 'prog-1', weekNumber: 1 },
      expect.any(Object),
    );
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

  // A one-phase block and a six-phase one are now the SAME layout. The old
  // sheet had two: adding a second week changed the shape of the page under
  // the coach's hands.
  describe('a single-phase block is the same shape', () => {
    it('still draws its divider, so the phase can be named', () => {
      renderSheet(oneWeek);
      expect(screen.getByText('Intro')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /edit week label/i })).toBeInTheDocument();
    });

    it('drops the size meta — the list below is the size', () => {
      renderSheet(oneWeek);
      expect(screen.queryByText(/sessions ·/)).toBeNull();
    });

    it('shows the sessions without needing to expand anything', () => {
      renderSheet(oneWeek);
      expect(screen.getByText('Pull')).toBeInTheDocument();
      expect(screen.getByText('Push')).toBeInTheDocument();
    });

    it('keeps copy-to-athlete reachable — block templating still matters', async () => {
      const user = userEvent.setup();
      renderSheet(oneWeek);
      await user.click(screen.getByRole('button', { name: /phase options/i }));
      await user.click(screen.getByRole('button', { name: /copy to/i }));
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('still offers a way into phases', () => {
      renderSheet(oneWeek);
      expect(screen.getByRole('button', { name: /\+ phase/i })).toBeInTheDocument();
    });
  });
});
