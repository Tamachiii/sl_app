import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within, act } from '@testing-library/react';
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

// What the sheet hands the three hooks a drag can end in: the block whose
// queue their writes wait in.
const orderHookArgs = {};

vi.mock('../../hooks/useWeek', () => ({
  useCreateWeek: () => mockCreateWeek,
  useReorderWeeks: (...args) => {
    orderHookArgs.reorderWeeks = args;
    return mockReorderWeeks;
  },
  useReorderSessions: (...args) => {
    orderHookArgs.reorderSessions = args;
    return mockReorderSessions;
  },
  useMoveSession: (...args) => {
    orderHookArgs.moveSession = args;
    return mockMoveSession;
  },
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

// Sessions the athlete has started (a logged set) without confirming.
let mockLogged = { data: new Set() };
vi.mock('../../hooks/useSession', () => ({
  useProgramLoggedSessionIds: () => mockLogged,
}));

// The copy sheet's reads: the coach has one athlete, the one of the page,
// whose one block is the block on screen — enough to pick a destination.
vi.mock('../../hooks/useStudents', () => ({
  useStudents: () => ({ data: [{ id: 's-1', profile: { full_name: 'Alice' } }] }),
}));
vi.mock('../../hooks/useProgram', () => ({
  useActiveProgram: () => ({ data: null }),
  useProgramsForStudent: (studentId) => ({
    data: studentId === 's-1' ? [{ id: 'prog-1', name: 'Base block', is_active: true }] : undefined,
  }),
  useProgram: (programId) => ({ data: programId === 'prog-1' ? program : undefined }),
}));

// dnd-kit measures the page to follow a pointer, and jsdom lays nothing out:
// a drag cannot be made here. The context is the real one; it also hands the
// test the sheet's `onDragEnd`, which `drop()` calls the way a drop does.
let onDragEnd = null;
vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = await importOriginal();
  const RealContext = actual.DndContext;
  return {
    ...actual,
    DndContext: (props) => {
      onDragEnd = props.onDragEnd;
      return <RealContext {...props} />;
    },
  };
});

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

function renderSheet(p = program, at = '/coach/students/s-1') {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <ProgramSheet studentId="s-1" program={p} />
    </MemoryRouter>,
  );
}

// A session's row: the button that opens it, named by the session, then what
// the athlete did with it, its recommended day and how many exercises it holds
// (« Pull, Monday, 2 exercises »). In select mode, the button that picks it.
function rowButton(name) {
  return screen.getByRole('button', { name: new RegExp(`^${name},`) });
}
function queryRowButton(name) {
  return screen.queryByRole('button', { name: new RegExp(`^${name},`) });
}

// The ⋯ of a session row, and the menu it opens — drawn on <body>.
const rowMenuButton = (name) => screen.getByRole('button', { name: `Options for ${name}` });
const rowMenu = (name) => screen.getByRole('group', { name: `Options for ${name}` });

// The ⋯ of each phase, and the open one. It is drawn on <body>, not in the sheet.
const phaseMenuButtons = () => screen.getAllByRole('button', { name: 'Phase options' });
const phaseMenu = () => screen.getByRole('group', { name: 'Phase options' });

// A phase: a section named by its heading.
const phase = (name) => screen.getByRole('region', { name });

// The sessions of the block in the trash, under their own heading.
const archivedToggle = (n) =>
  screen.getByRole('button', { name: n === 1 ? '1 archived session' : `${n} archived sessions` });

// jsdom lays nothing out: every box is 0 × 0 at the top of a 1024 × 768
// window. A test that needs a trigger somewhere gives it a box.
function placeAt(element, { top, height = 44, left = 300, width = 44 }) {
  element.getBoundingClientRect = () => ({
    top, bottom: top + height, left, right: left + width, width, height, x: left, y: top,
  });
}

describe('ProgramSheet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfirmed = { data: new Set() };
    mockLogged = { data: new Set() };
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
    // A row says its recommended weekday — the day's name, not a bare number —
    // and how many exercises the session holds.
    expect(rowButton('Pull')).toHaveAccessibleName('Pull, Monday, 2 exercises');
    expect(rowButton('Push')).toHaveAccessibleName('Push, Wednesday, 1 exercise');
    expect(rowButton('Legs')).toHaveAccessibleName('Legs, Tuesday, 0 exercises');
  });

  it('has no collapse control — nothing to expand', () => {
    renderSheet();
    expect(screen.queryByRole('button', { name: /week 1/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /week 2/i })).toBeNull();
    // A phase's name renames it; it never folds the phase.
    for (const heading of screen.getAllByRole('heading', { level: 2 })) {
      for (const button of within(heading).queryAllByRole('button')) {
        expect(button).not.toHaveAttribute('aria-expanded');
      }
    }
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

    // Parc: a phase is a section of the page, named by its h2, and its
    // sessions are in it.
    it('makes each phase a section named by its heading, holding its sessions', () => {
      renderSheet();
      expect(within(phase('Intro')).getByRole('heading', { level: 2 })).toHaveTextContent('Intro');
      expect(within(phase('Intro')).getByText('Pull')).toBeInTheDocument();
      expect(within(phase('Intro')).getByText('Push')).toBeInTheDocument();
      expect(within(phase('Unnamed phase')).getByText('Legs')).toBeInTheDocument();
      expect(within(phase('Unnamed phase')).queryByText('Pull')).toBeNull();
    });

    // Half the phases in production are unnamed; hiding their divider would
    // silently merge them into the phase above.
    it('still draws an unnamed phase, offering the name', () => {
      renderSheet();
      // The heading is the way to rename the phase: named by the phase, it
      // says what a tap does as its description.
      const namers = screen.getAllByRole('button', { description: 'Rename the phase' });
      expect(namers.map((b) => b.textContent)).toEqual(['Intro', 'Unnamed phase']);
    });

    it('renames in place', async () => {
      const user = userEvent.setup();
      renderSheet();
      await user.click(screen.getByRole('button', { name: 'Intro' }));
      const input = screen.getByRole('textbox', { name: 'Rename the phase' });
      await user.clear(input);
      await user.type(input, 'Accumulation{Enter}');
      expect(mockUpdateWeek.mutate).toHaveBeenCalledWith({ id: 'w-1', label: 'Accumulation' });
    });

    // The places a phase's sessions hold in the block (« Sessions 9 to 16 »)
    // replace the size line, « 2 sessions · 3 ex », the old divider wrote.
    it('says where the sessions of each phase stand in the block', () => {
      renderSheet({
        ...program,
        weeks: [...program.weeks, { id: 'w-3', program_id: 'prog-1', week_number: 3, label: 'Test', sessions: [] }],
      });
      expect(within(phase('Intro')).getByText('Sessions 1 to 2')).toBeInTheDocument();
      expect(within(phase('Unnamed phase')).getByText('Session 3')).toBeInTheDocument();
      expect(within(phase('Test')).getByText('No session yet')).toBeInTheDocument();
      expect(screen.queryByText(/\d ex\b/)).toBeNull();
    });

    it('adds a session to the phase whose menu was used', async () => {
      const user = userEvent.setup();
      renderSheet();
      await user.click(phaseMenuButtons()[0]);
      // The footer offers the same label: the menu's own is in the menu.
      await user.click(within(phaseMenu()).getByRole('button', { name: 'Add a session' }));
      expect(mockCreateSession.mutate).toHaveBeenCalledWith(
        expect.objectContaining({ weekId: 'w-1' }),
      );
      // The menu closes on its item.
      expect(screen.queryByRole('group', { name: 'Phase options' })).toBeNull();
    });

    it('duplicates a phase without pinning a number (the hook resolves max+1)', async () => {
      const user = userEvent.setup();
      renderSheet();
      await user.click(phaseMenuButtons()[0]);
      await user.click(within(phaseMenu()).getByRole('button', { name: 'Duplicate the phase' }));
      expect(mockDuplicateWeek.mutate).toHaveBeenCalledWith({ weekId: 'w-1' });
    });

    it('adds a phase at max(week_number) + 1', async () => {
      const user = userEvent.setup();
      renderSheet();
      await user.click(screen.getByRole('button', { name: 'Add a phase' }));
      expect(mockCreateWeek.mutate).toHaveBeenCalledWith({ programId: 'prog-1', weekNumber: 3 });
    });

    it('names the phase in the delete confirmation instead of numbering it', async () => {
      const user = userEvent.setup();
      renderSheet();
      await user.click(phaseMenuButtons()[0]);
      await user.click(within(phaseMenu()).getByRole('button', { name: 'Delete the phase' }));

      const sheet = screen.getByRole('dialog', { name: 'Delete “Intro”?' });
      expect(sheet).toHaveTextContent('Its sessions are removed with it.');
      expect(mockDeleteWeek.mutate).not.toHaveBeenCalled();
      await user.click(within(sheet).getByRole('button', { name: 'Delete the phase' }));
      expect(mockDeleteWeek.mutate).toHaveBeenCalledWith('w-1');
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('asks about an unnamed phase without a name, and deletes nothing on Cancel', async () => {
      const user = userEvent.setup();
      renderSheet();
      await user.click(phaseMenuButtons()[1]);
      await user.click(within(phaseMenu()).getByRole('button', { name: 'Delete the phase' }));

      const sheet = screen.getByRole('dialog', { name: 'Delete this phase?' });
      await user.click(within(sheet).getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(mockDeleteWeek.mutate).not.toHaveBeenCalled();
    });
  });

  // Review findings P32 and L10. The sheet was one `sl-card overflow-hidden`,
  // and its menus were absolutely positioned inside it: the card cut them. On
  // the last phase — the empty one "+ Phase" has just made — "Reorder phases"
  // and "Delete phase" were below the card, and that menu is the only way to
  // delete a phase. The menus are drawn on <body>.
  describe('menus are drawn outside the sheet', () => {
    const lastEmptyPhase = {
      ...program,
      weeks: [...program.weeks, { id: 'w-3', program_id: 'prog-1', week_number: 3, label: null, sessions: [] }],
    };
    let innerHeight;
    beforeEach(() => {
      innerHeight = window.innerHeight;
      window.innerHeight = 844;
    });
    afterEach(() => {
      window.innerHeight = innerHeight;
    });

    it('a phase menu hangs on <body>, not in the sheet', async () => {
      const user = userEvent.setup();
      const { container } = renderSheet();
      await user.click(phaseMenuButtons()[0]);
      expect(container).not.toContainElement(phaseMenu());
      expect(phaseMenu().parentElement).toBe(document.body);
    });

    it('opens upward on the last, empty phase, and every item of it can be pressed', async () => {
      const user = userEvent.setup();
      renderSheet(lastEmptyPhase);
      const triggers = phaseMenuButtons();
      expect(triggers).toHaveLength(3);
      // The last divider, 60px from the bottom of an 844px screen: 5 items of
      // 44px do not fit below it.
      placeAt(triggers[2], { top: 740 });
      await user.click(triggers[2]);

      const menu = phaseMenu();
      expect(menu).toHaveAttribute('data-placement', 'above');
      expect(menu.style.bottom).toBe(`${844 - 740 + 4}px`);
      expect(within(menu).getAllByRole('button').map((b) => b.textContent)).toEqual([
        'Add a session', 'Duplicate the phase', 'Copy to…', 'Reorder the phases', 'Delete the phase',
      ]);
      for (const item of within(menu).getAllByRole('button')) expect(item).toHaveClass('min-h-11');

      await user.click(within(menu).getByRole('button', { name: 'Delete the phase' }));
      expect(screen.getByRole('dialog', { name: 'Delete this phase?' })).toBeInTheDocument();
    });

    it('opens downward where there is room', async () => {
      const user = userEvent.setup();
      renderSheet();
      const trigger = phaseMenuButtons()[0];
      placeAt(trigger, { top: 120 });
      await user.click(trigger);
      expect(phaseMenu()).toHaveAttribute('data-placement', 'below');
      expect(phaseMenu().style.top).toBe(`${164 + 4}px`);
    });

    // The weekday picker of the last row was cut by the same card. It is in
    // the row's ⋯ now, under the session's duplicate.
    it('the menu of a session hangs on <body> too, its days in two rows of 44px cells', async () => {
      const user = userEvent.setup();
      const { container } = renderSheet();
      const trigger = rowMenuButton('Legs');
      placeAt(trigger, { top: 780, left: 12 });
      await user.click(trigger);
      expect(trigger).toHaveAttribute('aria-expanded', 'true');

      const menu = rowMenu('Legs');
      expect(container).not.toContainElement(menu);
      expect(menu.parentElement).toBe(document.body);
      expect(menu).toHaveAttribute('data-placement', 'above');
      expect(within(menu).getByRole('button', { name: 'Duplicate Legs' })).toHaveClass('min-h-11');
      const grid = within(menu).getByRole('button', { name: 'Monday' }).parentElement;
      expect(grid).toHaveClass('grid-cols-4');
      const cells = within(grid).getAllByRole('button');
      expect(cells.map((c) => c.getAttribute('aria-label'))).toEqual([
        'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'No recommended day',
      ]);
      for (const cell of cells) expect(cell).toHaveClass('w-11', 'h-11');

      await user.click(within(menu).getByRole('button', { name: 'Saturday' }));
      expect(mockUpdateSession.mutate).toHaveBeenCalledWith({ id: 'sess-3', day_number: 6 });
      expect(screen.queryByRole('group', { name: 'Options for Legs' })).toBeNull();
    });

    it('the two triggers are 44px', () => {
      renderSheet();
      expect(phaseMenuButtons()[0]).toHaveClass('pk-icon-btn');
      expect(rowMenuButton('Pull')).toHaveClass('pk-icon-btn');
    });
  });

  // Review item L15 and live finding N15: the button that opens a session was
  // the height of its text, 15px, between two writes on a tap (the day pill
  // and the duplicate button, 28px). jsdom lays nothing out, so these check
  // the classes (src/test/hitTargets.test.js holds `.pk-btn`, `.pk-icon-btn`
  // and `.pk-row` to 44px and more).
  describe('44px targets', () => {
    it('in a session row: the whole row height opens it, and its neighbour is a 44px box', () => {
      renderSheet();
      const open = rowButton('Pull');
      expect(open).toHaveClass('self-stretch', 'min-h-11', 'flex-1');
      expect(open.closest('li')).toHaveClass('pk-row');
      const menu = rowMenuButton('Pull');
      expect(menu).toHaveClass('pk-icon-btn');
      // Two boxes side by side, neither of them an enlarged area that would
      // lie over the other.
      for (const button of [open, menu]) expect(button).not.toHaveClass('sl-hit');
    });

    it('under the list', () => {
      renderSheet();
      for (const name of ['Add a session', 'Add a phase', 'Choose', 'Reorder']) {
        expect(screen.getByRole('button', { name })).toHaveClass('pk-btn');
      }
    });

    it('in the selection bar', async () => {
      const user = userEvent.setup();
      renderSheet();
      await user.click(screen.getByRole('button', { name: 'Choose' }));
      expect(rowButton('Pull')).toHaveClass('pk-row');
      expect(screen.getByRole('button', { name: 'Archive' })).toHaveClass('pk-btn', 'pk-btn-lg');
      expect(screen.getByRole('button', { name: 'Copy' })).toHaveClass('pk-btn', 'pk-btn-lg');
      expect(screen.getByRole('button', { name: 'Done' })).toHaveClass('pk-btn');
    });

    it('in the archived drawer', async () => {
      const user = userEvent.setup();
      renderSheet();
      const toggle = archivedToggle(1);
      expect(toggle).toHaveClass('pk-row');
      await user.click(toggle);
      expect(screen.getByRole('button', { name: 'Old' })).toHaveClass('min-h-11');
      expect(screen.getByRole('button', { name: 'Restore Old' })).toHaveClass('pk-btn');
    });

    it('in both reorder modes: the handles and Done', async () => {
      const user = userEvent.setup();
      renderSheet();
      await user.click(screen.getByRole('button', { name: 'Reorder' }));
      expect(screen.getByRole('button', { name: 'Move Pull' })).toHaveClass('pk-icon-btn');
      expect(screen.getByRole('button', { name: 'Done' })).toHaveClass('pk-btn');
      await user.click(screen.getByRole('button', { name: 'Done' }));

      await user.click(phaseMenuButtons()[0]);
      await user.click(within(phaseMenu()).getByRole('button', { name: 'Reorder the phases' }));
      expect(screen.getByRole('button', { name: 'Move Intro' })).toHaveClass('pk-icon-btn');
    });

    it('on a phase name', () => {
      renderSheet();
      for (const namer of screen.getAllByRole('button', { description: 'Rename the phase' })) {
        expect(namer).toHaveClass('min-h-11');
      }
    });

    it('for the first session of an empty block', () => {
      renderSheet({ id: 'prog-1', weeks: [] });
      expect(screen.getByRole('button', { name: 'Add a session' })).toHaveClass('pk-btn');
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
    expect(rowButton('Session 3')).toHaveAccessibleName('Session 3, 0 exercises');
    // Its place, in condensed digits, is drawn for the eye only: the name
    // already carries it.
    const place = rowButton('Session 3').closest('li').querySelector('.pk-condensed');
    expect(place).toHaveTextContent('3');
    expect(place).toHaveAttribute('aria-hidden', 'true');
  });

  describe('session reorder mode', () => {
    it('offers Reorder once the block holds more than one session', () => {
      renderSheet();
      expect(screen.getByRole('button', { name: 'Reorder' })).toBeInTheDocument();
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
      expect(screen.queryByRole('button', { name: 'Reorder' })).toBeNull();
    });

    it('swaps the rows for drag handles that KEEP their titles', async () => {
      const user = userEvent.setup();
      renderSheet();
      await user.click(screen.getByRole('button', { name: 'Reorder' }));

      expect(screen.getByText('Pull')).toBeInTheDocument();
      expect(screen.getByText('Legs')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Move Pull' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Move Legs' })).toBeInTheDocument();
      // Every other control steps out of the way so a drag can't mis-tap.
      expect(queryRowButton('Pull')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Options for Pull' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Add a session' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Choose' })).toBeNull();
    });

    // A mode adds no line above the list: its way out stands where the first
    // phase's ⋯ stood, and the other phases' menus, which have nothing to
    // offer while sessions are moved, step aside.
    it('puts Done where the first phase’s menu was, and no menu on the others', async () => {
      const user = userEvent.setup();
      renderSheet();
      await user.click(screen.getByRole('button', { name: 'Reorder' }));
      expect(within(phase('Intro')).getByRole('button', { name: 'Done' })).toHaveClass('pk-btn');
      expect(screen.getAllByRole('button', { name: 'Done' })).toHaveLength(1);
      expect(screen.queryAllByRole('button', { name: 'Phase options' })).toHaveLength(0);
    });

    it('writes no hint above the list', async () => {
      const user = userEvent.setup();
      renderSheet();
      await user.click(screen.getByRole('button', { name: 'Reorder' }));
      expect(screen.queryByText(/drag the handles|onto the name of a phase/i)).toBeNull();
    });

    it('leaves the mode on Done', async () => {
      const user = userEvent.setup();
      renderSheet();
      await user.click(screen.getByRole('button', { name: 'Reorder' }));
      await user.click(screen.getByRole('button', { name: 'Done' }));
      expect(rowMenuButton('Pull')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Move Pull' })).toBeNull();
      // Every phase has its menu again, and Done is gone.
      expect(phaseMenuButtons()).toHaveLength(2);
      expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
    });
  });

  describe('phase reorder mode', () => {
    it('is offered only from a divider menu, and only with several phases', async () => {
      const user = userEvent.setup();
      renderSheet();
      expect(screen.queryByRole('button', { name: 'Reorder the phases' })).toBeNull();
      await user.click(phaseMenuButtons()[0]);
      expect(within(phaseMenu()).getByRole('button', { name: 'Reorder the phases' })).toBeInTheDocument();
    });

    it('is absent for a lone phase', async () => {
      const user = userEvent.setup();
      renderSheet(oneWeek);
      await user.click(screen.getByRole('button', { name: 'Phase options' }));
      expect(screen.queryByRole('button', { name: 'Reorder the phases' })).toBeNull();
    });

    it('hides the sessions so a phase is dragged as a whole', async () => {
      const user = userEvent.setup();
      renderSheet();
      await user.click(phaseMenuButtons()[0]);
      await user.click(within(phaseMenu()).getByRole('button', { name: 'Reorder the phases' }));

      expect(screen.queryByText('Pull')).toBeNull();
      // The heads are rows to drag here: Done stands alone above them.
      const done = screen.getByRole('button', { name: 'Done' });
      const list = screen.getByRole('list', { name: 'Reorder the phases' });
      expect(done.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(done.parentElement).toHaveTextContent(/^Done$/);
      // A phase is a row: its name, how many sessions it holds, its handle.
      const intro = screen.getByRole('button', { name: 'Move Intro' }).closest('li');
      expect(intro).toHaveTextContent('Intro');
      expect(intro).toHaveTextContent('2 sessions');
      const unnamed = screen.getByRole('button', { name: 'Move Unnamed phase' }).closest('li');
      expect(unnamed).toHaveTextContent('1 session');
      // Nothing else to press than the handles and Done.
      expect(screen.queryByRole('button', { name: 'Add a phase' })).toBeNull();

      await user.click(screen.getByRole('button', { name: 'Done' }));
      expect(screen.getByText('Pull')).toBeInTheDocument();
    });
  });

  // Review finding P51. What a drop sends is what the database renumbers from,
  // in one statement: `reorder_sessions` and `reorder_weeks` take EVERY child
  // of the phase or the block and refuse a list that is not exactly that.
  describe('a drop', () => {
    function drop(activeId, overId) {
      act(() => onDragEnd({ active: { id: activeId }, over: overId ? { id: overId } : null }));
    }

    it('gives the three order hooks the block, so that its drags wait for each other', () => {
      renderSheet();
      expect(orderHookArgs).toEqual({
        reorderWeeks: ['prog-1'],
        reorderSessions: ['prog-1'],
        moveSession: ['prog-1'],
      });
    });

    it('within a phase sends every session of it, the archived one at the end', () => {
      renderSheet();
      drop('sess-2', 'sess-1');
      expect(mockReorderSessions.mutate).toHaveBeenCalledTimes(1);
      expect(mockReorderSessions.mutate).toHaveBeenCalledWith({
        weekId: 'w-1',
        orderedIds: ['sess-2', 'sess-1', 'sess-old'],
      });
      expect(mockMoveSession.mutate).not.toHaveBeenCalled();
      expect(mockReorderWeeks.mutate).not.toHaveBeenCalled();
    });

    it('across a divider moves the session, with the full list of both phases', () => {
      renderSheet();
      drop('sess-2', 'sess-3');
      expect(mockMoveSession.mutate).toHaveBeenCalledTimes(1);
      expect(mockMoveSession.mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'sess-2',
          destWeekId: 'w-2',
          sourceIds: ['sess-1', 'sess-old'],
          destIds: ['sess-2', 'sess-3'],
        }),
      );
      expect(mockReorderSessions.mutate).not.toHaveBeenCalled();
    });

    it('in phase mode sends every phase of the block in its new order', async () => {
      const user = userEvent.setup();
      renderSheet();
      await user.click(phaseMenuButtons()[0]);
      await user.click(within(phaseMenu()).getByRole('button', { name: 'Reorder the phases' }));

      drop('w-2', 'w-1');
      expect(mockReorderWeeks.mutate).toHaveBeenCalledTimes(1);
      expect(mockReorderWeeks.mutate).toHaveBeenCalledWith({
        programId: 'prog-1',
        orderedIds: ['w-2', 'w-1'],
      });
      expect(mockReorderSessions.mutate).not.toHaveBeenCalled();
      expect(mockMoveSession.mutate).not.toHaveBeenCalled();
    });

    it('that lands nowhere, or where it started, writes nothing', () => {
      renderSheet();
      drop('sess-1', null);
      drop('sess-1', 'sess-1');
      expect(mockReorderSessions.mutate).not.toHaveBeenCalled();
      expect(mockMoveSession.mutate).not.toHaveBeenCalled();
      expect(mockReorderWeeks.mutate).not.toHaveBeenCalled();
    });
  });

  // The coach's two named jobs. Archiving was previously unreachable from this
  // surface at all: useArchiveSession's only caller was SessionReview, which a
  // never-performed session can't reach — so the only tool for one was delete.
  describe('selection mode', () => {
    async function enterSelect(user) {
      await user.click(screen.getByRole('button', { name: 'Choose' }));
    }
    // The count of the selection bar (dnd-kit keeps a status of its own on
    // the page, for the drags it announces).
    const count = () => within(document.querySelector('.pk-actionbar')).getByRole('status');
    const inSelectMode = () => document.querySelector('.pk-actionbar') !== null;

    it('turns rows into pressable targets and reports the count', async () => {
      const user = userEvent.setup();
      renderSheet();
      await enterSelect(user);

      expect(within(phase('Intro')).getByRole('button', { name: 'Done' })).toBeInTheDocument();
      expect(screen.queryAllByRole('button', { name: 'Phase options' })).toHaveLength(0);
      expect(rowButton('Pull')).toHaveAttribute('aria-pressed', 'false');
      expect(count()).toHaveTextContent('None chosen');
      await user.click(rowButton('Pull'));
      expect(rowButton('Pull')).toHaveAttribute('aria-pressed', 'true');
      expect(count()).toHaveTextContent('1 chosen');
      await user.click(rowButton('Push'));
      expect(count()).toHaveTextContent('2 chosen');
      // Tapping again deselects.
      await user.click(rowButton('Push'));
      expect(rowButton('Push')).toHaveAttribute('aria-pressed', 'false');
      expect(count()).toHaveTextContent('1 chosen');
    });

    it('picks a session instead of opening it', async () => {
      const user = userEvent.setup();
      renderSheet();
      await enterSelect(user);
      expect(screen.queryByRole('button', { name: 'Options for Pull' })).toBeNull();
      await user.click(rowButton('Pull'));
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    // One selection for the whole block: archiving a finished mesocycle used to
    // be one pass per week card.
    it('spans phases', async () => {
      const user = userEvent.setup();
      renderSheet();
      await enterSelect(user);
      await user.click(rowButton('Pull'));
      await user.click(rowButton('Legs'));
      await user.click(screen.getByRole('button', { name: 'Archive' }));

      expect(mockArchiveSessions.mutate).toHaveBeenCalledWith(
        { sessionIds: ['sess-1', 'sess-3'], archived: true },
        expect.any(Object),
      );
    });

    it('leaves the mode once the archive is made', async () => {
      const user = userEvent.setup();
      renderSheet();
      await enterSelect(user);
      await user.click(rowButton('Pull'));
      await user.click(screen.getByRole('button', { name: 'Archive' }));

      const { onSuccess } = mockArchiveSessions.mutate.mock.calls[0][1];
      act(() => onSuccess());
      expect(inSelectMode()).toBe(false);
      expect(rowMenuButton('Pull')).toBeInTheDocument();
    });

    it('keeps both actions inert until something is picked', async () => {
      const user = userEvent.setup();
      renderSheet();
      await enterSelect(user);
      expect(screen.getByRole('button', { name: 'Archive' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Copy' })).toBeDisabled();
    });

    it('leaves the mode and clears the selection on Done', async () => {
      const user = userEvent.setup();
      renderSheet();
      await enterSelect(user);
      await user.click(rowButton('Pull'));
      await user.click(screen.getByRole('button', { name: 'Done' }));

      expect(inSelectMode()).toBe(false);
      expect(screen.queryByText(/chosen/)).toBeNull();
      // Back to the normal row, its menu and all.
      expect(rowMenuButton('Pull')).toBeInTheDocument();

      // And the next selection starts empty.
      await enterSelect(user);
      expect(count()).toHaveTextContent('None chosen');
      expect(rowButton('Pull')).toHaveAttribute('aria-pressed', 'false');
    });

    it('copies the selection into the phase chosen in the sheet', async () => {
      const user = userEvent.setup();
      renderSheet();
      await enterSelect(user);
      await user.click(rowButton('Pull'));
      await user.click(screen.getByRole('button', { name: 'Copy' }));

      // Scoped to the OPEN sheet: the sheet renders a second copy sheet, for
      // phases, and the confirmation of a phase's delete, both closed.
      const dialog = within(screen.getByRole('dialog', { name: 'Copy the sessions' }));
      expect(screen.getByRole('dialog', { name: 'Copy the sessions' })).toHaveAccessibleDescription(
        'Copies 1 session to the end of the phase you choose. The targets go with it, the athlete’s logged sets do not.',
      );
      // It asks for the destination BLOCK before the phase — the step that
      // lifts the old active-program-only restriction.
      await user.selectOptions(dialog.getByLabelText('Athlete'), 's-1');
      await user.selectOptions(dialog.getByLabelText('Block'), 'prog-1');
      await user.selectOptions(dialog.getByLabelText('Phase'), 'w-2');
      await user.click(dialog.getByRole('button', { name: 'Copy' }));

      expect(mockCopySessions.mutate).toHaveBeenCalledWith(
        { sessionIds: ['sess-1'], weekId: 'w-2' },
        expect.any(Object),
      );
      // Once the copy is made, the sheet closes and the mode is left.
      const { onSuccess } = mockCopySessions.mutate.mock.calls[0][1];
      act(() => onSuccess());
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(inSelectMode()).toBe(false);
    });
  });

  // design/parc/screens/Programme.dc.html: while sessions are being chosen,
  // what can be done with them sits in the ActionBar at the bottom of the
  // screen, after the count — within reach of the thumb, whatever the scroll.
  describe('the selection bar', () => {
    const bar = (container) => container.querySelector('.pk-actionbar');

    it('is the ActionBar, and only while sessions are being chosen', async () => {
      const user = userEvent.setup();
      const { container } = renderSheet();
      expect(bar(container)).toBeNull();

      await user.click(screen.getByRole('button', { name: 'Choose' }));
      const actions = within(bar(container));
      expect(actions.getByRole('status')).toHaveTextContent('None chosen');
      expect(actions.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
      // Archive is the bar's main action.
      expect(actions.getByRole('button', { name: 'Archive' })).toHaveClass('pk-btn-primary');
      // The footer under the list steps aside.
      expect(screen.queryByRole('button', { name: 'Add a session' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Reorder' })).toBeNull();

      await user.click(screen.getByRole('button', { name: 'Done' }));
      expect(bar(container)).toBeNull();
    });

    it('counts what is chosen as a status, read when it changes', async () => {
      const user = userEvent.setup();
      const { container } = renderSheet();
      await user.click(screen.getByRole('button', { name: 'Choose' }));
      await user.click(rowButton('Pull'));
      await user.click(rowButton('Push'));
      await user.click(rowButton('Legs'));
      expect(within(bar(container)).getByRole('status')).toHaveTextContent('3 chosen');
      expect(screen.getByRole('button', { name: 'Archive' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Copy' })).toBeEnabled();
    });

    it('takes no second archive while one is on its way', async () => {
      const user = userEvent.setup();
      mockArchiveSessions.isPending = true;
      try {
        renderSheet();
        await user.click(screen.getByRole('button', { name: 'Choose' }));
        await user.click(rowButton('Pull'));
        expect(screen.getByRole('button', { name: 'Archive' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Copy' })).toBeEnabled();
      } finally {
        mockArchiveSessions.isPending = false;
      }
    });
  });

  // design/parc/screens/Programme.dc.html, « Séances 1 à 6, toutes faites »:
  // the sessions a phase opens with that the athlete has done are one row,
  // so what is left to train comes first to the eye.
  describe('the done sessions a phase opens with', () => {
    const s = (id, title, sortOrder, extra = {}) => ({
      id, title, day_number: null, sort_order: sortOrder, archived_at: null, exercise_slots: [], ...extra,
    });
    const doneFirst = {
      id: 'prog-1',
      weeks: [
        {
          id: 'w-1', program_id: 'prog-1', week_number: 1, label: 'Base',
          sessions: [
            s('d-1', 'Pull A', 0),
            s('d-2', 'Push A', 1),
            // Done by its `performed_at`, before the confirmations are read.
            s('d-3', 'Legs A', 2, { performed_at: '2026-10-01T00:00:00Z' }),
            s('d-4', 'Pull B', 3),
          ],
        },
        {
          id: 'w-2', program_id: 'prog-1', week_number: 2, label: 'Peak',
          sessions: [s('d-5', 'Push B', 0), s('d-6', 'Legs B', 1)],
        },
      ],
    };
    const fold = () => screen.getByRole('button', { name: 'Sessions 1 to 3, All done' });

    beforeEach(() => {
      mockConfirmed = { data: new Set(['d-1', 'd-2', 'd-5']) };
    });

    it('are one row, closed, that says which they are', () => {
      renderSheet(doneFirst);
      expect(fold()).toHaveAttribute('aria-expanded', 'false');
      expect(within(phase('Base')).getByRole('list')).toContainElement(fold());
      for (const name of ['Pull A', 'Push A', 'Legs A']) expect(queryRowButton(name)).toBeNull();
      // What is left of the phase follows, at its place in the block.
      expect(rowButton('Pull B')).toHaveAccessibleName('Pull B, 0 exercises');
      expect(rowButton('Pull B').closest('li')).toHaveTextContent(/^4/);
      // The phase still says where all its sessions stand.
      expect(within(phase('Base')).getByText('Sessions 1 to 4')).toBeInTheDocument();
    });

    it('open on the tap', async () => {
      const user = userEvent.setup();
      renderSheet(doneFirst);
      await user.click(fold());

      expect(screen.queryByRole('button', { name: /All done/ })).toBeNull();
      // The pressed row is gone: the focus is on the first session it held.
      await waitFor(() => expect(rowButton('Pull A')).toHaveFocus());
      expect(rowButton('Pull A')).toHaveAccessibleName('Pull A, Done, 0 exercises');
      expect(rowButton('Push A')).toBeInTheDocument();
      expect(rowButton('Legs A')).toHaveAccessibleName('Legs A, Done, 0 exercises');
      // A done session opens its review.
      await user.click(rowButton('Pull A'));
      expect(mockNavigate).toHaveBeenCalledWith('/coach/student/s-1/session/d-1/review', {
        state: { from: '/coach/students/s-1' },
      });
    });

    it('open one phase, and leave the others as they are', async () => {
      const user = userEvent.setup();
      const twoRuns = structuredClone(doneFirst);
      twoRuns.weeks[1].sessions.push(s('d-7', 'Pull C', 2));
      mockConfirmed = { data: new Set(['d-1', 'd-2', 'd-5', 'd-6']) };
      renderSheet(twoRuns);
      const peak = screen.getByRole('button', { name: 'Sessions 5 to 6, All done' });

      await user.click(fold());
      expect(peak).toHaveAttribute('aria-expanded', 'false');
      expect(queryRowButton('Push B')).toBeNull();
    });

    it('leave a single done session as a row', () => {
      renderSheet(doneFirst);
      expect(within(phase('Peak')).queryByRole('button', { name: /All done/ })).toBeNull();
      expect(rowButton('Push B')).toHaveAccessibleName('Push B, Done, 0 exercises');
    });

    it('are a run that opens the phase: done sessions after one to do are rows', () => {
      mockConfirmed = { data: new Set(['d-2', 'd-5']) };
      renderSheet(doneFirst);
      expect(screen.queryByRole('button', { name: /All done/ })).toBeNull();
      expect(rowButton('Pull A')).toHaveAccessibleName('Pull A, 0 exercises');
      expect(rowButton('Push A')).toHaveAccessibleName('Push A, Done, 0 exercises');
      expect(rowButton('Legs A')).toHaveAccessibleName('Legs A, Done, 0 exercises');
    });

    // Started is not done: the athlete may still be in the middle of it.
    it('leave out a session that is only started', () => {
      mockConfirmed = { data: new Set() };
      mockLogged = { data: new Set(['d-1', 'd-2', 'd-3']) };
      const p = structuredClone(doneFirst);
      delete p.weeks[0].sessions[2].performed_at;
      renderSheet(p);
      expect(screen.queryByRole('button', { name: /All done/ })).toBeNull();
      expect(rowButton('Pull A')).toHaveAccessibleName('Pull A, In progress, 0 exercises');
    });

    // Choosing and moving act on sessions, and a folded one cannot be
    // reached: every row is shown while either is under way.
    it('are shown one by one while sessions are chosen', async () => {
      const user = userEvent.setup();
      renderSheet(doneFirst);
      await user.click(screen.getByRole('button', { name: 'Choose' }));
      expect(screen.queryByRole('button', { name: /All done/ })).toBeNull();
      await user.click(rowButton('Pull A'));
      expect(rowButton('Pull A')).toHaveAttribute('aria-pressed', 'true');

      // And folded again once it is over.
      await user.click(screen.getByRole('button', { name: 'Done' }));
      expect(fold()).toBeInTheDocument();
    });

    it('are shown one by one while sessions are reordered', async () => {
      const user = userEvent.setup();
      renderSheet(doneFirst);
      await user.click(screen.getByRole('button', { name: 'Reorder' }));
      expect(screen.queryByRole('button', { name: /All done/ })).toBeNull();
      expect(screen.getByRole('button', { name: 'Move Pull A' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Move Legs A' })).toBeInTheDocument();
    });
  });

  // One drawer for the block, not one per phase: which phase an archived
  // session used to sit in is not what the coach is looking for.
  describe('the archived sessions', () => {
    // Restoring meant opening the session's review page, a full-page route
    // whose back button lands on an unrelated feed — a one-way trip out of
    // Programming.
    it('restores an archived session in place, without leaving the sheet', async () => {
      const user = userEvent.setup();
      renderSheet();
      await user.click(archivedToggle(1));
      await user.click(screen.getByRole('button', { name: 'Restore Old' }));

      expect(mockArchiveSession.mutate).toHaveBeenCalledWith({
        sessionId: 'sess-old',
        archived: false,
      });
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    // Review item P11, the coach's half: an archived session is the coach's
    // cleanup, not a session done. Its row sits under « Archived » and says
    // nothing else, trained or not — no ✓, no "in progress".
    it('marks an archived session as archived, and as nothing else', async () => {
      const user = userEvent.setup();
      mockConfirmed = { data: new Set(['sess-old']) };
      mockLogged = { data: new Set(['sess-old']) };
      renderSheet();
      await user.click(archivedToggle(1));
      const drawer = phase('Archived');
      const open = within(drawer).getByRole('button', { name: 'Old' });
      const row = open.closest('li');
      expect(row).not.toHaveTextContent(/done|in progress/i);
      expect(row.querySelector('.pk-set-dot')).toBeNull();
    });

    it('are left out of the active list', () => {
      renderSheet();
      expect(screen.queryByText('Old')).not.toBeInTheDocument();
      expect(within(phase('Archived')).getByRole('button', { name: '1 archived session' })).toBeInTheDocument();
    });

    it('open and close under their count', async () => {
      const user = userEvent.setup();
      renderSheet();
      expect(archivedToggle(1)).toHaveAttribute('aria-expanded', 'false');
      await user.click(archivedToggle(1));
      expect(archivedToggle(1)).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByText('Old')).toBeInTheDocument();
      await user.click(archivedToggle(1));
      expect(screen.queryByText('Old')).toBeNull();
    });

    it('are gathered from every phase into one drawer', async () => {
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
      await user.click(archivedToggle(2));
      expect(screen.getByText('Old')).toBeInTheDocument();
      expect(screen.getByText('Older')).toBeInTheDocument();
    });

    // The drawer used to name an untitled archived session by its index in the
    // drawer, a number that is no place in the block.
    it('names an untitled archived session with no number', async () => {
      const user = userEvent.setup();
      const p = structuredClone(program);
      p.weeks[0].sessions[2].title = null;
      renderSheet(p);
      await user.click(archivedToggle(1));
      const archived = within(phase('Archived')).getByRole('button', { name: 'Session' });
      expect(archived).not.toHaveTextContent(/Session \d/);
      expect(screen.getByRole('button', { name: 'Restore Session' })).toBeInTheDocument();
    });

    it('stay linked to the review page', async () => {
      const user = userEvent.setup();
      renderSheet();
      await user.click(archivedToggle(1));
      const archived = screen.getByRole('button', { name: 'Old' });
      await user.click(archived);
      // …and the review is told where to come back to: it used to hardcode the
      // sessions feed, a one-way trip out of Programming.
      expect(mockNavigate).toHaveBeenCalledWith('/coach/student/s-1/session/sess-old/review', {
        state: { from: '/coach/students/s-1' },
      });
    });

    it('are put away while sessions are chosen or reordered', async () => {
      const user = userEvent.setup();
      renderSheet();
      await user.click(screen.getByRole('button', { name: 'Choose' }));
      expect(screen.queryByRole('region', { name: 'Archived' })).toBeNull();
      await user.click(screen.getByRole('button', { name: 'Done' }));
      await user.click(screen.getByRole('button', { name: 'Reorder' }));
      expect(screen.queryByRole('region', { name: 'Archived' })).toBeNull();
    });
  });

  it('opens a session inside the athlete shell (no /coach/student/ prefix)', async () => {
    const user = userEvent.setup();
    renderSheet();
    await user.click(rowButton('Pull'));
    expect(mockNavigate).toHaveBeenCalledWith('/coach/students/s-1/s/sess-1');
  });

  // Review finding P12. Every row used to open the editor, ✓ rows included:
  // reviewing — the coach's daily task — meant leaving for the Sessions tab and
  // finding the session again, while the tap that was on offer led to the one
  // screen able to delete what the athlete had logged.
  describe('a session the athlete has trained opens its review', () => {
    const reviewOf = (id) => `/coach/student/s-1/session/${id}/review`;
    const fromSheet = { state: { from: '/coach/students/s-1' } };

    it('when it is confirmed, and the row says it is done', async () => {
      const user = userEvent.setup();
      mockConfirmed = { data: new Set(['sess-1']) };
      renderSheet();
      expect(rowButton('Pull')).toHaveAccessibleName('Pull, Done, Monday, 2 exercises');
      await user.click(rowButton('Pull'));
      expect(mockNavigate).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledWith(reviewOf('sess-1'), fromSheet);
    });

    it('when it has logged sets but is not confirmed, and the row says so', async () => {
      const user = userEvent.setup();
      mockLogged = { data: new Set(['sess-2']) };
      renderSheet();
      expect(screen.getAllByRole('button', { name: /, In progress,/ })).toHaveLength(1);
      expect(rowButton('Push')).toHaveAccessibleName('Push, In progress, Wednesday, 1 exercise');
      expect(screen.queryByRole('button', { name: /, Done,/ })).toBeNull();
      await user.click(rowButton('Push'));
      expect(mockNavigate).toHaveBeenCalledWith(reviewOf('sess-2'), fromSheet);
    });

    // `performed_at` is the confirmation mirrored on the session row. It comes
    // with the sheet's own data, so a confirmed session does not open the
    // editor during the moment the confirmations query is still loading.
    it('on the session row alone, while the confirmations are still loading', async () => {
      const user = userEvent.setup();
      mockConfirmed = { data: undefined };
      mockLogged = { data: undefined };
      const p = structuredClone(program);
      p.weeks[1].sessions[0].performed_at = '2026-10-01T00:00:00Z';
      renderSheet(p);
      expect(screen.getAllByRole('button', { name: /, Done,/ })).toHaveLength(1);
      expect(rowButton('Legs')).toHaveAccessibleName('Legs, Done, Tuesday, 0 exercises');
      await user.click(rowButton('Legs'));
      expect(mockNavigate).toHaveBeenCalledWith(reviewOf('sess-3'), fromSheet);
    });

    it('leaves every other row on the editor', async () => {
      const user = userEvent.setup();
      mockConfirmed = { data: new Set(['sess-1']) };
      mockLogged = { data: new Set(['sess-2']) };
      renderSheet();
      expect(rowButton('Legs')).toHaveAccessibleName('Legs, Tuesday, 0 exercises');
      await user.click(rowButton('Legs'));
      expect(mockNavigate).toHaveBeenCalledWith('/coach/students/s-1/s/sess-3');
    });

    // Back from the review must land on the block the coach was looking at,
    // which is the `?program=` of the sheet's URL when it is not the active one.
    it('hands the review the page to come back to, block included', async () => {
      const user = userEvent.setup();
      mockConfirmed = { data: new Set(['sess-1']) };
      renderSheet(program, '/coach/students/s-1?program=prog-1');
      await user.click(rowButton('Pull'));
      expect(mockNavigate).toHaveBeenCalledWith(reviewOf('sess-1'), {
        state: { from: '/coach/students/s-1?program=prog-1' },
      });
    });
  });

  // The recommended day is in the row's ⋯, under the session's duplicate.
  describe('the recommended day', () => {
    it('writes day_number when a weekday is picked', async () => {
      const user = userEvent.setup();
      renderSheet();
      await user.click(rowMenuButton('Pull'));
      await user.click(within(rowMenu('Pull')).getByRole('button', { name: 'Thursday' }));
      expect(mockUpdateSession.mutate).toHaveBeenCalledWith({ id: 'sess-1', day_number: 4 });
    });

    it('marks the day the session has, and clears it', async () => {
      const user = userEvent.setup();
      renderSheet();
      await user.click(rowMenuButton('Pull'));
      const menu = within(rowMenu('Pull'));
      expect(menu.getByRole('button', { name: 'Monday' })).toHaveAttribute('aria-current', 'true');
      expect(menu.getByRole('button', { name: 'Thursday' })).toHaveAttribute('aria-current', 'false');
      expect(menu.getByRole('button', { name: 'No recommended day' })).toHaveAttribute('aria-current', 'false');

      // Clearing the day is a real choice: plenty of sessions should not
      // suggest one.
      await user.click(menu.getByRole('button', { name: 'No recommended day' }));
      expect(mockUpdateSession.mutate).toHaveBeenCalledWith({ id: 'sess-1', day_number: null });
    });

    it('marks « no day » on a session without one, and says no day in the row', async () => {
      const user = userEvent.setup();
      const p = structuredClone(program);
      p.weeks[1].sessions[0].day_number = null;
      renderSheet(p);
      expect(rowButton('Legs')).toHaveAccessibleName('Legs, 0 exercises');
      await user.click(rowMenuButton('Legs'));
      expect(within(rowMenu('Legs')).getByRole('button', { name: 'No recommended day' }))
        .toHaveAttribute('aria-current', 'true');
    });

    it('closes the menu on Escape and gives the focus back to its ⋯', async () => {
      const user = userEvent.setup();
      renderSheet();
      await user.click(rowMenuButton('Pull'));
      // The menu takes the focus: drawn on <body>, it is no longer next to its
      // trigger in the tab order.
      expect(within(rowMenu('Pull')).getByRole('button', { name: 'Duplicate Pull' })).toHaveFocus();
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('group', { name: 'Options for Pull' })).toBeNull();
      expect(rowMenuButton('Pull')).toHaveFocus();
      expect(mockUpdateSession.mutate).not.toHaveBeenCalled();
    });
  });

  // A weekday is a recommendation the coach makes deliberately, so a new
  // session starts without one. Auto-filling the next free day made every
  // session look due on a date nobody chose — and capped a week at 7, since
  // day 8 fell outside the strips and the session vanished from them.
  it('adds a session with no recommended weekday, at the end of the block', async () => {
    const user = userEvent.setup();
    renderSheet();
    await user.click(screen.getByRole('button', { name: 'Add a session' }));
    expect(mockCreateSession.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ weekId: 'w-2', dayNumber: null }),
    );
  });

  // Review item B26. A new session was titled "Session {n}" from its place on
  // the day it was added; after a reorder or an archive the name and the
  // place disagreed for good. It is born untitled, and the sheet names it by
  // its position wherever it goes.
  describe('a new session is born untitled', () => {
    it('from the footer', async () => {
      const user = userEvent.setup();
      renderSheet();
      await user.click(screen.getByRole('button', { name: 'Add a session' }));
      expect(mockCreateSession.mutate.mock.calls).toEqual([
        [{ weekId: 'w-2', dayNumber: null, sortOrder: 1 }],
      ]);
    });

    it('from a phase menu', async () => {
      const user = userEvent.setup();
      renderSheet();
      await user.click(phaseMenuButtons()[0]);
      await user.click(within(phaseMenu()).getByRole('button', { name: 'Add a session' }));
      // After the archived session's sort_order too: it still holds 2.
      expect(mockCreateSession.mutate.mock.calls).toEqual([
        [{ weekId: 'w-1', dayNumber: null, sortOrder: 3 }],
      ]);
    });

    it('as the first session of an empty block', async () => {
      const user = userEvent.setup();
      renderSheet({ id: 'prog-1', weeks: [] });
      await user.click(screen.getByRole('button', { name: 'Add a session' }));
      const [, { onSuccess }] = mockCreateWeek.mutate.mock.calls[0];
      onSuccess({ id: 'w-new' });
      expect(mockCreateSession.mutate.mock.calls).toEqual([
        [{ weekId: 'w-new', dayNumber: null, sortOrder: 0 }],
      ]);
    });

    it('and is named by where it stands, which moves with it', () => {
      const untitled = { id: 'new', title: null, day_number: null, sort_order: 5, archived_at: null, exercise_slots: [] };
      const { unmount } = renderSheet({
        ...program,
        weeks: [program.weeks[0], { ...program.weeks[1], sessions: [...program.weeks[1].sessions, untitled] }],
      });
      expect(rowButton('Session 4')).toBeInTheDocument();
      expect(rowMenuButton('Session 4')).toBeInTheDocument();
      unmount();
      // Moved to the top of the block.
      renderSheet({
        ...program,
        weeks: [
          { ...program.weeks[0], sessions: [{ ...untitled, week_id: 'w-1', sort_order: -1 }, ...program.weeks[0].sessions] },
          program.weeks[1],
        ],
      });
      expect(rowButton('Session 1')).toBeInTheDocument();
      expect(queryRowButton('Session 4')).toBeNull();
    });
  });

  it('marks confirmed sessions', () => {
    mockConfirmed = { data: new Set(['sess-1']) };
    renderSheet();
    expect(screen.getAllByRole('button', { name: /, Done,/ })).toHaveLength(1);
    expect(screen.getByRole('button', { name: /, Done,/ })).toBe(rowButton('Pull'));
  });

  // Building a block is a run of near-identical sessions; doing that from the
  // editor costs two navigations per copy. It is in the row's ⋯.
  it('duplicates a session straight from its row', async () => {
    const user = userEvent.setup();
    renderSheet();
    await user.click(rowMenuButton('Pull'));
    await user.click(within(rowMenu('Pull')).getByRole('button', { name: 'Duplicate Pull' }));
    expect(mockDuplicateSession.mutate).toHaveBeenCalledTimes(1);
    expect(mockDuplicateSession.mutate.mock.calls[0][0].sessionId).toBe('sess-1');
    expect(screen.queryByRole('group', { name: 'Options for Pull' })).toBeNull();
  });

  // Review item B26: the copy was titled by the function, " (copy)" in
  // English whatever the coach's language — and "Session (copy)", frozen, for
  // a source without a title.
  describe('the title of a copy', () => {
    it('takes the suffix in the coach’s language', async () => {
      const user = userEvent.setup();
      renderSheet();
      await user.click(rowMenuButton('Pull'));
      await user.click(within(rowMenu('Pull')).getByRole('button', { name: 'Duplicate Pull' }));
      expect(mockDuplicateSession.mutate).toHaveBeenCalledWith({ sessionId: 'sess-1', titleSuffix: ' (copy)' });
    });

    it('stays empty for a source without a title, which is named by its position', async () => {
      const user = userEvent.setup();
      renderSheet({
        ...program,
        weeks: [{ ...program.weeks[0], sessions: [
          { id: 'blank', title: null, day_number: null, sort_order: 0, archived_at: null, exercise_slots: [] },
          { id: 'spaces', title: '  ', day_number: null, sort_order: 1, archived_at: null, exercise_slots: [] },
        ] }],
      });
      for (const trigger of screen.getAllByRole('button', { name: /^Options for/ })) {
        await user.click(trigger);
        const menu = screen.getByRole('group', { name: /^Options for/ });
        await user.click(within(menu).getByRole('button', { name: /^Duplicate/ }));
      }
      expect(mockDuplicateSession.mutate.mock.calls).toEqual([
        [{ sessionId: 'blank', titleSuffix: '' }],
        [{ sessionId: 'spaces', titleSuffix: '' }],
      ]);
    });
  });

  // One copy on its way used to disable the duplicate button of every row.
  it('waits on the row being copied, and on no other', async () => {
    const user = userEvent.setup();
    mockDuplicateSession.isPending = true;
    mockDuplicateSession.variables = { sessionId: 'sess-2', titleSuffix: ' (copy)' };
    try {
      renderSheet();
      const duplicateOf = async (name) => {
        await user.click(rowMenuButton(name));
        const button = within(rowMenu(name)).getByRole('button', { name: `Duplicate ${name}` });
        const disabled = button.disabled;
        await user.keyboard('{Escape}');
        return disabled;
      };
      expect(await duplicateOf('Pull')).toBe(false);
      expect(await duplicateOf('Push')).toBe(true);
      expect(await duplicateOf('Legs')).toBe(false);
    } finally {
      mockDuplicateSession.isPending = false;
      delete mockDuplicateSession.variables;
    }
  });

  // Deleting a session lives in the session editor, where the coach has
  // already committed to that one session.
  it('keeps destructive session delete off the sheet rows', async () => {
    const user = userEvent.setup();
    renderSheet();
    expect(screen.getByText('Pull')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
    await user.click(rowMenuButton('Pull'));
    expect(within(rowMenu('Pull')).queryByRole('button', { name: /delete/i })).toBeNull();
  });

  // An empty block asks for a SESSION: the phase is a grouping the coach may
  // never want, so it is created implicitly behind that one CTA.
  it('offers to add a session, not a phase, when the block is empty', async () => {
    const user = userEvent.setup();
    renderSheet({ id: 'prog-1', weeks: [] });
    expect(screen.getByText('This block is empty. Add its first session.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add a phase' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Add a session' }));
    expect(mockCreateWeek.mutate).toHaveBeenCalledWith(
      { programId: 'prog-1', weekNumber: 1 },
      expect.any(Object),
    );
  });

  // A one-phase block and a six-phase one are now the SAME layout. The old
  // sheet had two: adding a second week changed the shape of the page under
  // the coach's hands.
  describe('a single-phase block is the same shape', () => {
    it('still draws its divider, so the phase can be named', () => {
      renderSheet(oneWeek);
      expect(screen.getByRole('heading', { level: 2, name: 'Intro' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Intro' })).toHaveAccessibleDescription('Rename the phase');
    });

    it('says where its sessions stand, as a phase among others does', () => {
      renderSheet(oneWeek);
      expect(within(phase('Intro')).getByText('Sessions 1 to 2')).toBeInTheDocument();
    });

    it('shows the sessions without needing to expand anything', () => {
      renderSheet(oneWeek);
      expect(screen.getByText('Pull')).toBeInTheDocument();
      expect(screen.getByText('Push')).toBeInTheDocument();
    });

    it('keeps copy-to-athlete reachable — block templating still matters', async () => {
      const user = userEvent.setup();
      renderSheet(oneWeek);
      await user.click(screen.getByRole('button', { name: 'Phase options' }));
      await user.click(within(phaseMenu()).getByRole('button', { name: 'Copy to…' }));

      const sheet = screen.getByRole('dialog', { name: 'Copy the phase' });
      expect(sheet).toHaveAccessibleDescription('The phase and its sessions are added at the end of the block you choose.');
      // A phase goes to a block, as its last phase: no phase is asked for.
      const dialog = within(sheet);
      expect(dialog.queryByLabelText('Phase')).toBeNull();
      await user.selectOptions(dialog.getByLabelText('Athlete'), 's-1');
      await user.selectOptions(dialog.getByLabelText('Block'), 'prog-1');
      await user.click(dialog.getByRole('button', { name: 'Copy' }));

      expect(mockDuplicateWeek.mutate).toHaveBeenCalledWith(
        { weekId: 'w-1', programId: 'prog-1' },
        expect.any(Object),
      );
      const { onSuccess } = mockDuplicateWeek.mutate.mock.calls[0][1];
      act(() => onSuccess());
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('still offers a way into phases', () => {
      renderSheet(oneWeek);
      expect(screen.getByRole('button', { name: 'Add a phase' })).toBeInTheDocument();
    });
  });

  // Review item P53, the sheet's half. A block the athlete is writing is
  // theirs until the coach approves it; the editor already opens its
  // sessions read-only. The sheet offered every write anyway, and the
  // athlete's next save replaced what the coach had done without a word.
  describe('an athlete’s draft', () => {
    const draft = {
      ...structuredClone(program),
      status: 'draft',
    };

    it('offers no write at all', () => {
      renderSheet(draft);
      // The sessions are all there.
      expect(screen.getByText('Pull')).toBeInTheDocument();
      expect(screen.getByText('Legs')).toBeInTheDocument();
      expect(screen.getByText('Intro')).toBeInTheDocument();

      for (const name of [
        /^Options for/,         // the row's menu: the weekday, the duplicate
        /^Duplicate/,
        'Add a session',        // footer
        'Choose',
        'Reorder',
        'Add a phase',
        'Phase options',        // the menu: add, duplicate, copy, reorder, delete
        'Intro',                // rename
        'Unnamed phase',
      ]) {
        expect(screen.queryByRole('button', { name })).toBeNull();
      }
      expect(screen.queryByRole('button', { description: 'Rename the phase' })).toBeNull();
      // The day is still shown, in the row.
      expect(rowButton('Pull')).toHaveAccessibleName('Pull, Monday, 2 exercises');
      expect(within(phase('Unnamed phase')).getByText('Unnamed phase')).toBeInTheDocument();
    });

    it('still opens a session, in the editor that is read-only too', async () => {
      const user = userEvent.setup();
      renderSheet(draft);
      await user.click(rowButton('Pull'));
      expect(mockNavigate).toHaveBeenCalledWith('/coach/students/s-1/s/sess-1');
    });

    it('shows its archived sessions without a restore', async () => {
      const user = userEvent.setup();
      renderSheet(draft);
      await user.click(archivedToggle(1));
      expect(screen.getByRole('button', { name: 'Old' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Restore Old' })).toBeNull();
    });

    it('when empty, says so without offering the first session', () => {
      renderSheet({ id: 'prog-1', status: 'draft', weeks: [] });
      expect(screen.getByText('No session in this draft yet.')).toBeInTheDocument();
      expect(screen.queryByRole('button')).toBeNull();
    });

    it('becomes writable again once it is approved', () => {
      renderSheet({ ...draft, status: 'approved' });
      expect(phaseMenuButtons()).toHaveLength(2);
      expect(screen.getAllByRole('button', { name: /^Options for/ })).toHaveLength(3);
      expect(screen.getByRole('button', { name: 'Add a phase' })).toBeInTheDocument();
      expect(screen.getAllByRole('button', { description: 'Rename the phase' })).toHaveLength(2);
    });
  });
});
