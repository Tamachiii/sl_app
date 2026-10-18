import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';

// The athlete page IS the athlete's block (design/parc/screens/Programme.dc.html):
// the block's name as the title, the athlete and what the block is on the line
// under it, the athlete's other pages as links, then the block. The sheet and
// the switcher are stand-ins — what they draw has tests of its own.

let programsRead;
let programRead;
let reviewCounts;

vi.mock('../../hooks/useProgram', () => ({
  useProgramsForStudent: () => programsRead,
  useProgram: () => programRead,
  useEnsureProgram: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('../../hooks/useSessionConfirmation', () => ({
  useReviewCounts: () => ({ data: reviewCounts }),
}));
vi.mock('./ProgramSheet', () => ({
  default: ({ program }) => <div data-testid="sheet">sheet:{program.id}</div>,
}));
// The title as ProgramSwitcher draws it: the block's name as the h1, and the
// line the page writes under it.
vi.mock('./ProgramSwitcher', () => ({
  default: ({ programs, selectedId, subtitle }) => (
    <header>
      <h1>{programs.find((p) => p.id === selectedId)?.name}</h1>
      <p data-testid="subtitle">{subtitle}</p>
    </header>
  ),
}));

import StudentOverview from './StudentOverview';

const ALICE = { id: 's-1', profile_id: 'p-1', profile: { full_name: 'Alice' } };

const BLOCKS = [
  { id: 'p-1', name: 'Block one', is_active: true, status: 'approved', submitted_at: null },
  { id: 'p-2', name: 'Block two', is_active: false, status: 'approved', submitted_at: null },
  { id: 'p-3', name: 'Her block', is_active: false, status: 'draft', submitted_at: '2026-10-01T00:00:00Z' },
  { id: 'p-4', name: 'Her next block', is_active: false, status: 'draft', submitted_at: null },
];

// A read as useQuery reports it.
function read(overrides) {
  return {
    data: undefined,
    isSuccess: false,
    isError: false,
    isPaused: false,
    isFetching: false,
    fetchStatus: 'idle',
    refetch: vi.fn(),
    ...overrides,
  };
}

let order = 0;
function session(id, { performed = false, archived = false } = {}) {
  order += 1;
  return {
    id,
    title: null,
    day_number: null,
    sort_order: order,
    scheduled_date: null,
    archived_at: archived ? '2026-10-01T00:00:00Z' : null,
    performed_at: performed ? '2026-10-01T00:00:00Z' : null,
    exercise_slots: [],
  };
}

// Two sessions trained, the third is next, an archived one that counts for
// nothing: session 3 of 4.
const BLOCK_ONE = {
  id: 'p-1',
  status: 'approved',
  weeks: [
    { id: 'w-1', week_number: 1, sessions: [session('a', { performed: true }), session('b', { performed: true }), session('c')] },
    { id: 'w-2', week_number: 2, sessions: [session('d'), session('e', { archived: true })] },
  ],
};

function block(id, n, status = 'approved') {
  return { id, status, weeks: [{ id: `w-${id}`, week_number: 1, sessions: Array.from({ length: n }, (_, i) => session(`${id}-${i}`)) }] };
}

function renderPage({ student = ALICE, entry = '/coach/students/s-1' } = {}) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route
          path="/coach/students/:studentId"
          element={<Outlet context={{ student, athleteName: student.profile?.full_name ?? '' }} />}
        >
          <Route index element={<StudentOverview />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

const subtitle = () => screen.getByTestId('subtitle');

beforeEach(() => {
  programsRead = read({ data: BLOCKS, isSuccess: true });
  programRead = read({ data: BLOCK_ONE, isSuccess: true });
  reviewCounts = {};
});

describe('StudentOverview: the title', () => {
  it('is the block in progress, with the athlete and the place in the block under it', () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Block one' })).toBeInTheDocument();
    // Counted as the roster counts it: two trained, the archived one left out.
    expect(subtitle()).toHaveTextContent('Alice, in progress, session 3 of 4');
  });

  it('counts the sessions of a block that is not in progress', () => {
    programRead = read({ data: block('p-2', 3), isSuccess: true });
    renderPage({ entry: '/coach/students/s-1?program=p-2' });
    expect(screen.getByRole('heading', { level: 1, name: 'Block two' })).toBeInTheDocument();
    expect(subtitle()).toHaveTextContent(/^Alice, 3 sessions$/);
  });

  it('says a draft is a draft, and a submitted one submitted', () => {
    programRead = read({ data: block('p-3', 2, 'draft'), isSuccess: true });
    renderPage({ entry: '/coach/students/s-1?program=p-3' });
    expect(subtitle()).toHaveTextContent(/^Alice, submitted, 2 sessions$/);
  });

  it('says an unsubmitted draft is a draft', () => {
    programRead = read({ data: block('p-4', 1, 'draft'), isSuccess: true });
    renderPage({ entry: '/coach/students/s-1?program=p-4' });
    expect(subtitle()).toHaveTextContent(/^Alice, draft, 1 session$/);
  });

  it('says only who and what until the block is read', () => {
    programRead = read({ fetchStatus: 'fetching', isFetching: true });
    renderPage();
    expect(subtitle()).toHaveTextContent(/^Alice, in progress$/);
  });

  it('says no place in a block that holds no session', () => {
    programRead = read({ data: { id: 'p-1', status: 'approved', weeks: [] }, isSuccess: true });
    renderPage();
    expect(subtitle()).toHaveTextContent(/^Alice, in progress$/);
  });

  it('is the athlete while there is no block', () => {
    programsRead = read({ data: [], isSuccess: true });
    programRead = read({});
    renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Alice' })).toBeInTheDocument();
    expect(screen.getByText('No block yet for this athlete.')).toBeInTheDocument();
  });

  it('is the athlete when the list of blocks could not be read', () => {
    programsRead = read({ isError: true });
    programRead = read({});
    renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Alice' })).toBeInTheDocument();
    expect(screen.getByText('This couldn’t be loaded')).toBeInTheDocument();
  });
});

// Review finding P12 brought back Message and Sessions; Goals and Stats left
// the page for pages of their own and are linked from the same place.
describe('StudentOverview: the athlete’s other pages', () => {
  const links = () => screen.getByRole('navigation', { name: /alice/i });

  it('links to the thread, keyed on the PROFILE id, the sessions in the feed, the goals and the stats', () => {
    renderPage();
    const nav = within(links());
    expect(nav.getByRole('link', { name: 'Message' })).toHaveAttribute('href', '/coach/messages/p-1');
    expect(nav.getByRole('link', { name: 'Sessions' })).toHaveAttribute('href', '/coach/sessions?student=s-1');
    expect(nav.getByRole('link', { name: 'Goals' })).toHaveAttribute('href', '/coach/students/s-1/goals');
    expect(nav.getByRole('link', { name: 'Stats' })).toHaveAttribute('href', '/coach/students/s-1/stats');
    expect(nav.getAllByRole('link')).toHaveLength(4);
  });

  it('says how many sessions wait for a review on the Sessions link', () => {
    reviewCounts = { 's-1': 3, 's-2': 8 };
    renderPage();
    const sessions = within(links()).getByRole('link', { name: 'Sessions 3 to review' });
    expect(sessions.querySelector('.pk-count')).toHaveTextContent('3');
  });

  it('sits between the title and the block', () => {
    renderPage();
    const title = screen.getByRole('heading', { level: 1 });
    const sheet = screen.getByTestId('sheet');
    expect(title.compareDocumentPosition(links()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(links().compareDocumentPosition(sheet) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('stays while the block cannot be shown, and while there is none', () => {
    programsRead = read({ data: [], isSuccess: true });
    programRead = read({});
    renderPage();
    expect(within(links()).getByRole('link', { name: 'Goals' })).toBeInTheDocument();
  });

  // Review item L15: the two links were 36px tall. They are Parc buttons,
  // 44px at least (`.pk-btn`, held by test/hitTargets).
  it('are buttons, 44px', () => {
    renderPage();
    for (const link of within(links()).getAllByRole('link')) {
      expect(link).toHaveClass('pk-btn');
    }
  });

  it('offers no thread link for an athlete row without a profile id', () => {
    renderPage({ student: { id: 's-1', profile: { full_name: 'Alice' } } });
    expect(within(links()).queryByRole('link', { name: 'Message' })).toBeNull();
    expect(within(links()).getByRole('link', { name: 'Sessions' })).toBeInTheDocument();
  });
});
