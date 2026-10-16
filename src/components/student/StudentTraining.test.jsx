import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { IsRestoringProvider, QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'u-1' },
    profile: { full_name: 'Tony Me' },
    signOut: vi.fn(),
  }),
}));

// The session page's two reads are NOT mocked: the list hands their options to
// the client to read the next session ahead, and the tests of that mount the
// real hooks on what it cached. Only the database behind them is a double.
vi.mock('../../lib/supabase', () => ({ supabase: { from: vi.fn() } }));

// A read as a component sees it. `data` alone makes it one that answered.
const read = (data, over = {}) => ({
  data,
  fetchStatus: 'idle',
  isPaused: false,
  isError: false,
  dataUpdatedAt: data == null ? 0 : 1,
  refetch: vi.fn(),
  ...over,
});
const waitingForNetwork = () => read(undefined, { fetchStatus: 'paused', isPaused: true });
const failed = () => read(undefined, { isError: true });
const onItsWay = () => read(undefined, { fetchStatus: 'fetching' });

let mockList = read({ weeks: [], pastPrograms: [] });
// One read per past block, by program id; a block nobody set up is loading.
let mockPastBlocks = {};
const pastBlockReads = [];
vi.mock('../../hooks/useStudentProgramDetails', () => ({
  useStudentProgramDetails: () => mockList,
  useStudentPastProgram: (_userId, programId) => {
    pastBlockReads.push(programId);
    return mockPastBlocks[programId] ?? onItsWay();
  },
}));

let mockConfirmedIds = read(new Set());
vi.mock('../../hooks/useSessionConfirmation', () => ({
  useMyConfirmedSessionIds: () => mockConfirmedIds,
}));

vi.mock('../../hooks/useMessages', () => ({
  useMyFeedbackSessionIds: () => ({ data: new Set() }),
  useUnreadMessageCount: () => ({ data: 0 }),
}));

vi.mock('../ui/UserMenu', () => ({ default: () => <div data-testid="user-menu" /> }));

import StudentTraining from './StudentTraining';
import { useSession } from '../../hooks/useSession';
import { useSetLogs } from '../../hooks/useSetLogs';
import { supabase } from '../../lib/supabase';
import { fakePostgrest } from '../../test/fakePostgrest';
import { isoDate } from '../../lib/day';

const activeProgram = { id: 'p-1', name: 'Bloc Reprise', sort_order: 1, is_active: true };

const session = (id, title, over = {}) => ({
  id,
  title,
  day_number: 1,
  sort_order: 0,
  archived_at: null,
  scheduled_date: null,
  performed_at: null,
  exercise_slots: [],
  ...over,
});

const week = (id, week_number, sessions, program = activeProgram) => ({
  id,
  week_number,
  label: null,
  program,
  sessions,
});

// The list's read: the weeks of the block being trained, and the past blocks
// as the rows of their closed drawers.
const listOf = (weeks, pastPrograms = []) => read({ weeks, pastPrograms });

// A past block as the list's read carries it: a name and two counts.
const pastHeader = (program, session_count, archived_count = 0) => ({
  id: program.id,
  name: program.name,
  sort_order: program.sort_order,
  session_count,
  archived_count,
});

// A client like the app's where it matters here: a read is trusted for a
// while, so reading ahead twice in a row is one request.
function makeClient(queries = {}) {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: 60_000, ...queries },
      mutations: { retry: false },
    },
  });
}

const page = (client) => (
  <QueryClientProvider client={client}>
    <MemoryRouter>
      <StudentTraining />
    </MemoryRouter>
  </QueryClientProvider>
);

let queryClient;
function renderTraining(client = makeClient()) {
  queryClient = client;
  return render(page(client));
}

function setOnline(online) {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(online);
  act(() => {
    window.dispatchEvent(new Event(online ? 'online' : 'offline'));
  });
}

let db;
beforeEach(() => {
  vi.clearAllMocks();
  mockConfirmedIds = read(new Set());
  mockList = listOf([]);
  mockPastBlocks = {};
  pastBlockReads.length = 0;
  // Nothing to read ahead unless a test puts a session there.
  db = fakePostgrest({ sessions: [], set_logs: [] });
  supabase.from.mockImplementation(db.from);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('StudentTraining', () => {
  it('shows a spinner while loading', () => {
    mockList = onItsWay();
    const { container } = renderTraining();
    expect(container.querySelector('.animate-spin')).toBeTruthy();
  });

  it('shows the empty state when no program is assigned', () => {
    renderTraining();
    expect(screen.getByText(/no program assigned yet/i)).toBeInTheDocument();
  });

  // The whole reason the two pages merged: one screen, one question.
  it('does not render a Mon–Sun day strip or week navigation', () => {
    mockList = listOf([week('w-1', 1, [session('s-1', 'Upper 1', { day_number: 1 })])]);
    renderTraining();
    expect(screen.queryByLabelText('Week overview')).toBeNull();
    expect(screen.queryByRole('button', { name: /previous week/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /next week/i })).toBeNull();
  });

  it('states where the athlete is in the block exactly once', () => {
    mockList = listOf([
        week('w-1', 1, [
          session('done-1', 'Upper 1', { day_number: 1, performed_at: '2026-08-18T18:00:00Z' }),
          session('next-1', 'Upper 2', { day_number: 3 }),
        ]),
      ]);
    mockConfirmedIds = read(new Set(['done-1']));
    renderTraining();
    expect(screen.getByText('Session 2 of 2')).toBeInTheDocument();
    // The old page stacked four headings for this; these are retired.
    expect(screen.queryByText('Next session')).toBeNull();
    expect(screen.queryByText('Then')).toBeNull();
  });

  // B33: done out of order, the header named one session and the Next card
  // another — "Session 5 of 6" above the card of session 4.
  it('names the session of the Next card when sessions were done out of order', () => {
    mockList = listOf([
      week('w-1', 1, ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'].map((title, i) =>
        session(title.toLowerCase(), title, { sort_order: i, day_number: null }))),
    ]);
    mockConfirmedIds = read(new Set(['s1', 's2', 's3', 's5']));
    renderTraining();
    expect(screen.getByText('Session 4 of 6')).toBeInTheDocument();
    // The finished ones are in the closed drawer: the first card is the Next one.
    expect(screen.getAllByText(/^S\d$/).map((n) => n.textContent)).toEqual(['S4', 'S6']);
    expect(screen.getByText('Next')).toBeInTheDocument();
  });

  // The defect that prompted the merge: finished sessions were ordered by
  // RECOMMENDED weekday, so one trained on the 18th sat above one trained on
  // the 21st. A log has exactly one honest order — when it happened.
  it('orders finished sessions by the day they were really trained, newest first', async () => {
    const user = userEvent.setup();
    mockList = listOf([
        week('w-1', 1, [
          // Monday's session, trained first.
          session('upper1', 'Upper 1', { day_number: 1, performed_at: '2026-08-18T18:00:00Z' }),
          // Friday's session, trained three days LATER — must sort above.
          session('wrist', 'Wrist Routine', { day_number: 5, performed_at: '2026-08-21T18:00:00Z' }),
        ]),
      ]);
    mockConfirmedIds = read(new Set(['upper1', 'wrist']));
    renderTraining();
    await user.click(screen.getByText('Done'));

    const titles = screen.getAllByText(/^(Upper 1|Wrist Routine)$/).map((n) => n.textContent);
    expect(titles).toEqual(['Wrist Routine', 'Upper 1']);
  });

  it('shows each finished session on the date it was actually trained', async () => {
    const user = userEvent.setup();
    mockList = listOf([
        week('w-1', 1, [
          session('wrist', 'Wrist Routine', {
            day_number: 1, // recommended Monday…
            performed_at: '2026-08-21T18:00:00Z', // …trained on the Friday
          }),
        ]),
      ]);
    mockConfirmedIds = read(new Set(['wrist']));
    renderTraining();
    await user.click(screen.getByText('Done'));
    expect(screen.getByText(/Fri, Aug 21/)).toBeInTheDocument();
  });

  it('spells a recommended weekday out as advice rather than a date', () => {
    mockList = listOf([week('w-1', 1, [session('s-1', 'Upper 1', { day_number: 3 })])]);
    renderTraining();
    expect(screen.getByText(/Recommended Wednesday/)).toBeInTheDocument();
  });

  it('puts the next session first and leaves the rest in program order', () => {
    mockList = listOf([
        week('w-1', 1, [
          session('a', 'Upper 1', { day_number: 1 }),
          session('b', 'Leg', { day_number: 3 }),
        ]),
        week('w-2', 2, [session('c', 'Upper 2', { day_number: 1 })]),
      ]);
    renderTraining();
    const titles = screen.getAllByText(/^(Upper 1|Leg|Upper 2)$/).map((n) => n.textContent);
    expect(titles).toEqual(['Upper 1', 'Leg', 'Upper 2']);
  });

  // A month-long block reaches ~20 completed cards, so the active block's own
  // history needs the same drawer as the past ones. The queue position in the
  // header already states progress without listing it.
  it('collapses the active block finished sessions into a drawer', async () => {
    const user = userEvent.setup();
    mockList = listOf([
        week('w-1', 1, [
          session('d1', 'Old Push', { day_number: 1, performed_at: '2026-08-11T18:00:00Z' }),
          session('d2', 'Old Pull', { day_number: 2, performed_at: '2026-08-13T18:00:00Z' }),
          session('up', 'Next Up', { day_number: 3 }),
        ]),
      ]);
    mockConfirmedIds = read(new Set(['d1', 'd2']));
    renderTraining();

    // The drawer says how much is inside without rendering any of it…
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(screen.getByText('2 sessions')).toBeInTheDocument();
    expect(screen.queryByText('Old Push')).toBeNull();
    expect(screen.queryByText('Old Pull')).toBeNull();
    // …while the work still to do stays in plain sight.
    expect(screen.getByText('Next Up')).toBeInTheDocument();

    await user.click(screen.getByText('Done'));
    expect(screen.getByText('Old Push')).toBeInTheDocument();
    expect(screen.getByText('Old Pull')).toBeInTheDocument();
  });

  // The next session opens by default because it is what the athlete came for,
  // but it is a card like any other: opening another one collapses it instead
  // of leaving a screenful for a session that is no longer the subject.
  // The next session opens by default because it is what the athlete came for,
  // but it is a card like any other: opening another one collapses it instead
  // of leaving a screenful for a session that is no longer the subject.
  //
  // "Open" is asserted through the exercise list rather than the Start button:
  // a collapsed card's Start pill carries the same accessible name as the
  // expanded card's bottom CTA, so counting buttons proves nothing.
  describe('the next session is a card, not a fixture', () => {
    const slot = (id, name) => ({
      id,
      sets: 3,
      reps: 8,
      weight_kg: 40,
      exercise: { id: `ex-${id}`, name, type: 'push' },
    });
    const twoUpcoming = () =>
      listOf([
        week('w-1', 1, [
          session('a', 'Upper 1', { day_number: 1, exercise_slots: [slot('s1', 'Bench Press')] }),
          session('b', 'Upper 2', { day_number: 3, exercise_slots: [slot('s2', 'Overhead Press')] }),
        ]),
      ]);

    it('opens by default and marks itself with a Next badge', () => {
      mockList = twoUpcoming();
      renderTraining();
      expect(screen.getByText('Next')).toBeInTheDocument();
      expect(screen.getByText('Bench Press')).toBeInTheDocument();
      expect(screen.queryByText('Overhead Press')).toBeNull();
    });

    it('collapses when another session is opened', async () => {
      const user = userEvent.setup();
      mockList = twoUpcoming();
      renderTraining();

      await user.click(screen.getByText('Upper 2'));
      expect(screen.getByText('Overhead Press')).toBeInTheDocument();
      expect(screen.queryByText('Bench Press')).toBeNull();
      // The badge survives the collapse, so which one is next stays legible
      // among otherwise identical rows.
      expect(screen.getByText('Next')).toBeInTheDocument();
    });

    it('can be collapsed on its own and stays collapsed', async () => {
      const user = userEvent.setup();
      mockList = twoUpcoming();
      renderTraining();

      await user.click(screen.getByText('Upper 1'));
      expect(screen.queryByText('Bench Press')).toBeNull();
      expect(screen.queryByText('Overhead Press')).toBeNull();
    });
  });

  it('celebrates a finished block instead of showing an empty next slot', () => {
    mockList = listOf([week('w-1', 1, [session('a', 'Upper 1', { performed_at: '2026-08-18T18:00:00Z' })])]);
    mockConfirmedIds = read(new Set(['a']));
    renderTraining();
    expect(screen.getByText(/block complete/i)).toBeInTheDocument();
  });

  describe('the activity line says something or nothing', () => {
    const withPerformed = (iso) =>
      listOf([week('w-1', 1, [
        session('a', 'Upper 1', { performed_at: iso }),
        session('b', 'Upper 2', { day_number: 3 }),
      ])]);

    // `performed_at` as the database writes it: the day trained, as midnight
    // UTC — a date, which the page reads as one in every zone.
    const trainedDaysAgo = (n) => {
      const d = new Date();
      d.setDate(d.getDate() - n);
      return `${isoDate(d)}T00:00:00+00:00`;
    };

    it('reports staleness when the athlete has been away', () => {
      mockList = withPerformed(trainedDaysAgo(4));
      mockConfirmedIds = read(new Set(['a']));
      renderTraining();
      expect(screen.getByText(/4 days ago/)).toBeInTheDocument();
    });

    // "Trained today" told the athlete what they already knew.
    it('never says "trained today" — it shows the week\'s rhythm instead', () => {
      mockList = withPerformed(trainedDaysAgo(0));
      mockConfirmedIds = read(new Set(['a']));
      renderTraining();
      expect(screen.queryByText(/trained today/i)).toBeNull();
      expect(screen.getByText(/1 session in the last 7 days/)).toBeInTheDocument();
    });

    it('says nothing at all when there is no program to comment on', () => {
      renderTraining();
      expect(screen.queryByText(/last trained/i)).toBeNull();
      expect(screen.queryByText(/in the last 7 days/i)).toBeNull();
    });
  });

  describe('past blocks', () => {
    const pastProgram = { id: 'p-0', name: 'Bloc 1', sort_order: 0, is_active: false };
    const current = () => week('w-1', 1, [session('now', 'Current Work', { day_number: 1 })]);
    // The sessions of the past block, as its own read returns them.
    const pastBlock = (sessions) => read([week('w-0', 1, sessions, pastProgram)]);

    it('renders finished blocks below the active one, labelled as past', () => {
      mockList = listOf([current()], [pastHeader(pastProgram, 1)]);
      renderTraining();

      expect(screen.getByText('Bloc Reprise')).toBeInTheDocument();
      expect(screen.getByText('Bloc 1')).toBeInTheDocument();
      expect(screen.getByText(/past program/i)).toBeInTheDocument();
    });

    // A year of coaching is hundreds of cards; the landing page must not spend
    // its height on them — nor a request. The row of a closed block is made of
    // the name and the count the list's own read carries.
    it('collapses a finished block to a single summary row, and does not read it', async () => {
      const user = userEvent.setup();
      mockList = listOf([current()], [pastHeader(pastProgram, 2)]);
      mockPastBlocks['p-0'] = pastBlock([
        session('old-a', 'Old Squat', { performed_at: '2026-06-01T18:00:00Z' }),
        session('old-b', 'Old Pull', { performed_at: '2026-05-20T18:00:00Z' }),
      ]);
      mockConfirmedIds = read(new Set(['old-a', 'old-b']));
      renderTraining();

      // The row states what is inside without rendering any of it.
      expect(screen.getByText(/past program · 2 sessions/i)).toBeInTheDocument();
      expect(screen.queryByText('Old Squat')).toBeNull();
      expect(screen.queryByText('Old Pull')).toBeNull();
      expect(pastBlockReads).toEqual([]);
      // The ACTIVE block stays open — that is the page's actual subject.
      expect(screen.getByText('Current Work')).toBeInTheDocument();

      await user.click(screen.getByText('Bloc 1'));
      expect(new Set(pastBlockReads)).toEqual(new Set(['p-0']));
      expect(screen.getByText('Old Squat')).toBeInTheDocument();
      expect(screen.getByText('Old Pull')).toBeInTheDocument();
    });

    it('reads only the block whose drawer is opened', async () => {
      const user = userEvent.setup();
      const older = { id: 'p-00', name: 'Bloc 0', sort_order: -1, is_active: false };
      mockList = listOf([current()], [pastHeader(pastProgram, 2), pastHeader(older, 5)]);
      mockPastBlocks['p-0'] = pastBlock([session('old', 'Old Squat')]);
      renderTraining();

      await user.click(screen.getByText('Bloc 1'));
      expect(screen.getByText('Old Squat')).toBeInTheDocument();
      expect(pastBlockReads).not.toContain('p-00');
    });

    it('orders the sessions of a past block by the day they were trained, newest first', async () => {
      const user = userEvent.setup();
      mockList = listOf([current()], [pastHeader(pastProgram, 3)]);
      mockPastBlocks['p-0'] = pastBlock([
        session('a', 'Old Squat', { sort_order: 0, performed_at: '2026-05-20T18:00:00Z' }),
        session('b', 'Never Done', { sort_order: 1 }),
        session('c', 'Old Pull', { sort_order: 2, performed_at: '2026-06-01T18:00:00Z' }),
      ]);
      renderTraining();

      await user.click(screen.getByText('Bloc 1'));
      const titles = screen
        .getAllByText(/^(Old Squat|Never Done|Old Pull)$/)
        .map((n) => n.textContent);
      expect(titles).toEqual(['Old Pull', 'Old Squat', 'Never Done']);
    });

    it('shows a spinner in an opened drawer until its block is read', async () => {
      const user = userEvent.setup();
      mockList = listOf([current()], [pastHeader(pastProgram, 2)]);
      renderTraining();

      await user.click(screen.getByText('Bloc 1'));
      const past = screen.getByText('Bloc 1').closest('section');
      expect(past.querySelector('.animate-spin')).toBeTruthy();
    });

    // The row comes from the read the device keeps; the sessions do not. An
    // opened drawer says so, and the rest of the page is untouched.
    it('says a past block is not on the device when it is opened without a network', async () => {
      const user = userEvent.setup();
      mockList = listOf([current()], [pastHeader(pastProgram, 2)]);
      mockPastBlocks['p-0'] = waitingForNetwork();
      renderTraining();

      await user.click(screen.getByText('Bloc 1'));
      const past = screen.getByText('Bloc 1').closest('section');
      expect(within(past).getByText(/this block isn’t on this device/i)).toBeInTheDocument();
      expect(screen.getByText('Current Work')).toBeInTheDocument();

      await user.click(within(past).getByRole('button', { name: /try again/i }));
      expect(mockPastBlocks['p-0'].refetch).toHaveBeenCalledTimes(1);
    });

    it('says a past block could not be loaded when its read failed', async () => {
      const user = userEvent.setup();
      mockList = listOf([current()], [pastHeader(pastProgram, 2)]);
      mockPastBlocks['p-0'] = failed();
      renderTraining();

      await user.click(screen.getByText('Bloc 1'));
      const past = screen.getByText('Bloc 1').closest('section');
      expect(within(past).getByText(/this block couldn’t be loaded/i)).toBeInTheDocument();
    });

    // A lock stops LOGGING, never LOOKING. Reviewing what you did in an old
    // block is the reason the history is on the page at all — and the first
    // cut of `locked` broke exactly this by dropping onStart wholesale, so
    // "Review session" rendered as an inert button.
    it('lets a finished past-block session be reviewed', async () => {
      const user = userEvent.setup();
      mockList = listOf([current()], [pastHeader(pastProgram, 1)]);
      mockPastBlocks['p-0'] = pastBlock([
        session('old', 'Old Squat', { performed_at: '2026-06-01T18:00:00Z' }),
      ]);
      mockConfirmedIds = read(new Set(['old']));
      renderTraining();

      await user.click(screen.getByText('Bloc 1'));
      await user.click(screen.getByText('Old Squat'));
      const review = screen.getByRole('button', { name: /review session/i });
      await user.click(review);
      expect(mockNavigate).toHaveBeenCalledWith('/student/session/old');
    });

    // Past-block sessions are locked in the UI and by RLS, so a Start button
    // on one led nowhere.
    it('offers no Start affordance on a past block', async () => {
      const user = userEvent.setup();
      mockList = listOf([current()], [pastHeader(pastProgram, 1)]);
      mockPastBlocks['p-0'] = pastBlock([session('stale', 'Never Finished')]);
      renderTraining();
      await user.click(screen.getByText('Bloc 1'));
      const past = screen.getByText('Bloc 1').closest('section');
      expect(within(past).getByText('Never Finished')).toBeInTheDocument();
      expect(within(past).queryByRole('button', { name: /^start$/i })).toBeNull();
    });

    it('offers no Start CTA inside an unfinished past-block session either', async () => {
      const user = userEvent.setup();
      mockList = listOf([current()], [pastHeader(pastProgram, 1)]);
      mockPastBlocks['p-0'] = pastBlock([session('stale', 'Never Finished')]);
      renderTraining();
      await user.click(screen.getByText('Bloc 1'));
      await user.click(screen.getByText('Never Finished'));
      // Scoped: the ACTIVE block's next-up card legitimately shows a Start CTA.
      const past = screen.getByText('Bloc 1').closest('section');
      expect(within(past).queryByRole('button', { name: /start session/i })).toBeNull();
    });

    // A past block's unfinished sessions are history the athlete moved on
    // from — surfacing one as "next" would put stale work at the top.
    it('never offers a past block session as the next one', async () => {
      const user = userEvent.setup();
      mockList = listOf([current()], [pastHeader(pastProgram, 1)]);
      mockPastBlocks['p-0'] = pastBlock([session('abandoned', 'Never Finished')]);
      renderTraining();
      await user.click(screen.getByText('Bloc 1'));

      const heading = screen.getByText('Bloc Reprise').closest('section');
      expect(within(heading).getByText('Current Work')).toBeInTheDocument();
      expect(within(heading).queryByText('Never Finished')).toBeNull();
      expect(screen.getAllByText('Next')).toHaveLength(1);
      expect(screen.getByText('Session 1 of 1')).toBeInTheDocument();
    });

    it('shows the past blocks of an athlete who has no block being trained', () => {
      mockList = listOf([], [pastHeader(pastProgram, 4)]);
      renderTraining();
      expect(screen.getByText(/past program · 4 sessions/i)).toBeInTheDocument();
      expect(screen.queryByText(/no program assigned yet/i)).toBeNull();
    });
  });

  describe('archived sessions', () => {
    const pastProgram = { id: 'p-0', name: 'Bloc 1', sort_order: 0, is_active: false };

    it('hides archived sessions behind a toggle', () => {
      mockList = listOf([
        week('w-1', 1, [
          session('a', 'Upper 1', { performed_at: '2026-08-18T18:00:00Z' }),
          session('gone', 'Pulled', { day_number: 3, archived_at: '2026-08-01T00:00:00Z' }),
        ]),
      ]);
      mockConfirmedIds = read(new Set(['a']));
      renderTraining();
      expect(screen.queryByText('Pulled')).toBeNull();
      expect(screen.getByRole('button', { name: /show 1 archived/i })).toBeInTheDocument();
    });

    // The toggle counts what it would reveal, and a past block's archived
    // sessions are known from the list's read without opening the block.
    it('counts the archived sessions of the past blocks, and leaves them out of the rows', async () => {
      const user = userEvent.setup();
      mockList = listOf(
        [
          week('w-1', 1, [
            session('a', 'Upper 1'),
            session('gone', 'Pulled', { archived_at: '2026-08-01T00:00:00Z' }),
          ]),
        ],
        [pastHeader(pastProgram, 5, 2)],
      );
      renderTraining();

      expect(screen.getByText(/past program · 3 sessions/i)).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /show 3 archived/i }));
      expect(screen.getByText(/past program · 5 sessions/i)).toBeInTheDocument();
    });

    it('gives a past block whose sessions are all archived a row only once they are asked for', async () => {
      const user = userEvent.setup();
      mockList = listOf([week('w-1', 1, [session('a', 'Upper 1')])], [pastHeader(pastProgram, 2, 2)]);
      mockPastBlocks['p-0'] = read([
        week('w-0', 1, [
          session('x', 'Shelved A', { archived_at: '2026-06-01T00:00:00Z' }),
          session('y', 'Shelved B', { archived_at: '2026-06-01T00:00:00Z' }),
        ], pastProgram),
      ]);
      renderTraining();
      expect(screen.queryByText('Bloc 1')).toBeNull();

      await user.click(screen.getByRole('button', { name: /show 2 archived/i }));
      await user.click(screen.getByText('Bloc 1'));
      expect(screen.getByText('Shelved A')).toBeInTheDocument();
      expect(screen.getByText('Shelved B')).toBeInTheDocument();
    });

    it('leaves the archived sessions of an opened past block out until they are asked for', async () => {
      const user = userEvent.setup();
      mockList = listOf([week('w-1', 1, [session('a', 'Upper 1')])], [pastHeader(pastProgram, 2, 1)]);
      mockPastBlocks['p-0'] = read([
        week('w-0', 1, [
          session('x', 'Old Squat'),
          session('y', 'Shelved', { archived_at: '2026-06-01T00:00:00Z' }),
        ], pastProgram),
      ]);
      renderTraining();

      await user.click(screen.getByText('Bloc 1'));
      expect(screen.getByText('Old Squat')).toBeInTheDocument();
      expect(screen.queryByText('Shelved')).toBeNull();

      await user.click(screen.getByRole('button', { name: /show 1 archived/i }));
      expect(screen.getByText('Shelved')).toBeInTheDocument();
    });
  });

  // "No program assigned yet" is a statement about the athlete's program, and
  // only a read that answered can make it. The page used to make it for every
  // read without data — which, on a launch without a network, was all of them.
  describe('when the list has nothing to build on', () => {
    const noProgram = /no program assigned yet/i;

    it('says the training is not on this device when the read waits for a network', async () => {
      const user = userEvent.setup();
      mockList = waitingForNetwork();
      renderTraining();

      expect(screen.getByText(/your training isn’t on this device yet/i)).toBeInTheDocument();
      expect(screen.getByText(/you’re offline/i)).toBeInTheDocument();
      expect(screen.queryByText(noProgram)).toBeNull();
      // The page is still a page: the greeting and the menu are there.
      expect(screen.getByText(/hey, tony/i)).toBeInTheDocument();
      expect(screen.getByTestId('user-menu')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /try again/i }));
      expect(mockList.refetch).toHaveBeenCalledWith({ cancelRefetch: false });
      expect(mockConfirmedIds.refetch).toHaveBeenCalledWith({ cancelRefetch: false });
    });

    it('says the training could not be loaded when the read failed on a network', async () => {
      const user = userEvent.setup();
      mockList = failed();
      renderTraining();

      expect(screen.getByText(/your training couldn’t be loaded/i)).toBeInTheDocument();
      expect(screen.getByText(/check your connection/i)).toBeInTheDocument();
      expect(screen.queryByText(noProgram)).toBeNull();

      await user.click(screen.getByRole('button', { name: /try again/i }));
      expect(mockList.refetch).toHaveBeenCalledTimes(1);
    });

    // navigator.onLine is the reliable half of the story: a read that failed
    // on a device with no network failed because of that.
    it('blames the network, not the read, for a failure on a device that is offline', () => {
      vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
      mockList = failed();
      renderTraining();
      expect(screen.getByText(/your training isn’t on this device yet/i)).toBeInTheDocument();
      expect(screen.queryByText(/couldn’t be loaded/i)).toBeNull();
    });

    it('keeps its spinner while the read is on its way, a second attempt included', () => {
      mockList = read(undefined, { fetchStatus: 'fetching', isError: false });
      const { container } = renderTraining();
      expect(container.querySelector('.animate-spin')).toBeTruthy();
      expect(screen.queryByText(noProgram)).toBeNull();
      expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
    });

    // At launch the cache is read back from IndexedDB before any read is sent
    // or answered from it. For those few milliseconds a device without a
    // network looks exactly like one that kept nothing.
    it('does not say "not on this device" while what the device kept is still being read', () => {
      vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
      mockList = read(undefined);
      mockConfirmedIds = read(undefined);
      const { container } = render(
        <IsRestoringProvider value={true}>{page(makeClient())}</IsRestoringProvider>,
      );
      expect(container.querySelector('.animate-spin')).toBeTruthy();
      expect(screen.queryByText(/isn’t on this device/i)).toBeNull();
      expect(screen.queryByText(noProgram)).toBeNull();
    });

    it('does not take an account that is not known yet for one without a program', () => {
      // Disabled read: no data, nothing on its way, no error.
      mockList = read(undefined);
      const { container } = renderTraining();
      expect(container.querySelector('.animate-spin')).toBeTruthy();
      expect(screen.queryByText(noProgram)).toBeNull();
    });

    // A refresh that fails leaves the last answer in place, and that answer is
    // the page: an error next to data is not a reason to hide the workout.
    it('shows the list it holds when a refresh of it failed or waits', () => {
      const weeks = [week('w-1', 1, [session('a', 'Upper 1')])];
      mockList = read({ weeks, pastPrograms: [] }, { isError: true });
      mockConfirmedIds = read(new Set(), { fetchStatus: 'paused', isPaused: true });
      renderTraining();
      expect(screen.getByText('Upper 1')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
    });

    // The block alone is not a list. Without the confirmations every session
    // counts as not done, and the athlete is sent back to the first one.
    describe('and the block is read but the confirmations are not', () => {
      const block = () =>
        listOf([
          week('w-1', 1, [
            session('a', 'Upper 1', { performed_at: '2026-08-18T18:00:00Z' }),
            session('b', 'Upper 2', { day_number: 3 }),
          ]),
        ]);

      it('waits for them rather than naming a next session', () => {
        mockList = block();
        mockConfirmedIds = onItsWay();
        const { container } = renderTraining();
        expect(container.querySelector('.animate-spin')).toBeTruthy();
        expect(screen.queryByText('Next')).toBeNull();
        expect(screen.queryByText('Upper 1')).toBeNull();
      });

      it('says the training is not on this device when they wait for a network', () => {
        mockList = block();
        mockConfirmedIds = waitingForNetwork();
        renderTraining();
        expect(screen.getByText(/your training isn’t on this device yet/i)).toBeInTheDocument();
        expect(screen.queryByText('Session 1 of 2')).toBeNull();
      });
    });

    describe('and the network returns', () => {
      it('asks again by itself', () => {
        vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
        mockList = waitingForNetwork();
        mockConfirmedIds = waitingForNetwork();
        renderTraining();
        expect(mockList.refetch).not.toHaveBeenCalled();

        setOnline(true);
        expect(mockList.refetch).toHaveBeenCalledTimes(1);
        expect(mockList.refetch).toHaveBeenCalledWith({ cancelRefetch: false });
        expect(mockConfirmedIds.refetch).toHaveBeenCalledTimes(1);
      });

      // One step, one attempt: a read that keeps failing while the device is
      // online stops at its message.
      it('asks once per return, not for as long as the read fails', () => {
        vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
        mockList = failed();
        const view = renderTraining();
        setOnline(true);
        expect(mockList.refetch).toHaveBeenCalledTimes(1);

        // The attempt failed too: same state, rendered again.
        view.rerender(page(queryClient));
        expect(mockList.refetch).toHaveBeenCalledTimes(1);

        setOnline(false);
        setOnline(true);
        expect(mockList.refetch).toHaveBeenCalledTimes(2);
      });

      it('asks nothing when the list is there: its own refresh is the client’s business', () => {
        vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
        mockList = listOf([week('w-1', 1, [session('a', 'Upper 1')])]);
        renderTraining();
        setOnline(true);
        expect(mockList.refetch).not.toHaveBeenCalled();
        expect(mockConfirmedIds.refetch).not.toHaveBeenCalled();
      });
    });
  });

  // The list is where an athlete is before a workout, usually on a network;
  // the session is opened in the gym, often without one. A session that was
  // never opened on the device had nothing to show there.
  describe('reading the next session ahead', () => {
    const slot = (id, over = {}) => ({ id, sort_order: 0, sets: 2, set_logs: [], ...over });
    // The session row as the session page's read returns it.
    const sessionRow = (id, slots) => ({
      id,
      title: 'Upper 1',
      weeks: { programs: { is_active: true } },
      exercise_slots: slots,
    });
    const setRow = (id, slotId, n) => ({ id, exercise_slot_id: slotId, set_number: n, done: false });

    const twoSessions = () =>
      listOf([
        week('w-1', 1, [
          session('a', 'Upper 1', { sort_order: 0, exercise_slots: [slot('sl-2'), slot('sl-1')] }),
          session('b', 'Upper 2', { sort_order: 1, exercise_slots: [slot('sl-9')] }),
        ]),
      ]);

    function wire({ slots = [slot('sl-2', { sort_order: 1 }), slot('sl-1')] } = {}) {
      db = fakePostgrest({
        sessions: (request) => {
          const id = request.filters.find(([op, column]) => op === 'eq' && column === 'id')?.[2];
          return [sessionRow(id, slots)];
        },
        set_logs: [setRow('l-1', 'sl-1', 1), setRow('l-2', 'sl-2', 1)],
      });
      supabase.from.mockImplementation(db.from);
      return db;
    }

    const withClient = (client) => ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    it('reads the next session and its sets into the cache the session page reads', async () => {
      wire();
      mockList = twoSessions();
      renderTraining();

      await waitFor(() => expect(db.requestsTo('set_logs')).toHaveLength(1));
      expect(db.requestsTo('sessions')).toHaveLength(1);
      expect(db.requestsTo('sessions')[0].filters).toContainEqual(['eq', 'id', 'a']);
      expect(db.requestsTo('set_logs')[0].filters).toContainEqual([
        'in',
        'exercise_slot_id',
        ['sl-1', 'sl-2'],
      ]);

      // The proof that it was read under the page's keys, in the page's shape:
      // the page's own hooks, mounted on this cache, have their data at once
      // and send nothing.
      const { result } = renderHook(
        () => {
          const session = useSession('a');
          const logs = useSetLogs('a', session.data?.exercise_slots);
          return { session, logs };
        },
        { wrapper: withClient(queryClient) },
      );
      expect(result.current.session.data.program_is_active).toBe(true);
      expect(result.current.session.data.exercise_slots.map((s) => s.id)).toEqual(['sl-1', 'sl-2']);
      expect(result.current.logs.data.map((l) => l.id)).toEqual(['l-1', 'l-2']);
      expect(db.requests).toHaveLength(2);
    });

    it('reads the next session only: the one after it is read when it becomes the next', async () => {
      wire();
      mockList = twoSessions();
      const view = renderTraining();
      await waitFor(() => expect(db.requestsTo('set_logs')).toHaveLength(1));
      expect(db.requestsTo('sessions').map((r) => r.filters[0][2])).toEqual(['a']);

      // Confirmed: 'b' is next now.
      mockConfirmedIds = read(new Set(['a']));
      view.rerender(page(queryClient));
      await waitFor(() => expect(db.requestsTo('sessions')).toHaveLength(2));
      expect(db.requestsTo('sessions')[1].filters).toContainEqual(['eq', 'id', 'b']);
    });

    // The list can be one coach edit behind the session row. The page builds
    // the key of its set read from the ROW, so the read-ahead must too — a
    // key built from the list's slots would be one the page never asks for.
    it('asks for the sets of the exercises the session row has, not the ones the list has', async () => {
      wire({ slots: [slot('sl-1'), slot('sl-2', { sort_order: 1 }), slot('sl-new', { sort_order: 2 })] });
      mockList = twoSessions();
      renderTraining();

      await waitFor(() => expect(db.requestsTo('set_logs')).toHaveLength(1));
      const keys = queryClient
        .getQueryCache()
        .getAll()
        .map((q) => q.queryKey);
      expect(keys).toContainEqual(['set-logs', 'a', ['sl-1', 'sl-2', 'sl-new']]);
    });

    it('asks for no sets of a session that has no exercise yet', async () => {
      wire({ slots: [] });
      mockList = twoSessions();
      renderTraining();
      await waitFor(() => expect(queryClient.getQueryData(['session', 'a'])).toBeTruthy());
      await act(async () => {});
      expect(db.requestsTo('set_logs')).toEqual([]);
    });

    it('reads nothing ahead when the block is finished', async () => {
      wire();
      mockList = listOf([week('w-1', 1, [session('a', 'Upper 1')])]);
      mockConfirmedIds = read(new Set(['a']));
      renderTraining();
      await act(async () => {});
      expect(db.requests).toEqual([]);
    });

    // A wrong "next" would be read: without the confirmations every session
    // counts as not done.
    it('reads nothing ahead before the confirmations are known', async () => {
      wire();
      mockList = twoSessions();
      mockConfirmedIds = onItsWay();
      renderTraining();
      await act(async () => {});
      expect(db.requests).toEqual([]);
    });

    it('reads nothing ahead without a network, and does when it returns', async () => {
      wire();
      vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
      mockList = twoSessions();
      renderTraining();
      await act(async () => {});
      expect(db.requests).toEqual([]);

      setOnline(true);
      await waitFor(() => expect(db.requestsTo('set_logs')).toHaveLength(1));
    });

    it('answers from the cache while its copy is fresh, however often the list is read', async () => {
      wire();
      mockList = twoSessions();
      const view = renderTraining();
      await waitFor(() => expect(db.requestsTo('set_logs')).toHaveLength(1));

      // The list was read again: same next session, a newer read.
      mockList = { ...twoSessions(), dataUpdatedAt: 2 };
      view.rerender(page(queryClient));
      await act(async () => {});
      expect(db.requests).toHaveLength(2);
    });

    // What a coach rewrote this afternoon must not be kept as it was this
    // morning: each read of the list is a chance to bring the session up to
    // date, taken when the copy is no longer fresh.
    it('reads the session again when the list is read again and the copy is out of date', async () => {
      wire();
      mockList = twoSessions();
      const view = renderTraining(makeClient({ staleTime: 0 }));
      await waitFor(() => expect(db.requestsTo('set_logs')).toHaveLength(1));

      // Rendered again without a new read of the list: nothing.
      view.rerender(page(queryClient));
      await act(async () => {});
      expect(db.requestsTo('sessions')).toHaveLength(1);

      mockList = { ...twoSessions(), dataUpdatedAt: 2 };
      view.rerender(page(queryClient));
      await waitFor(() => expect(db.requestsTo('set_logs')).toHaveLength(2));
      expect(db.requestsTo('sessions')).toHaveLength(2);
    });

    // The answer of a read made while a write is on its way can be older than
    // what the device holds: it would put the ticked sets back as they were.
    it('waits for the writes of the device to be through', async () => {
      wire();
      mockList = twoSessions();
      const client = makeClient();
      let finishWrite;
      const write = client.getMutationCache().build(client, {
        mutationFn: () => new Promise((resolve) => { finishWrite = resolve; }),
      });
      write.execute();

      renderTraining(client);
      await act(async () => {});
      expect(db.requests).toEqual([]);

      await act(async () => { finishWrite(); });
      await waitFor(() => expect(db.requestsTo('set_logs')).toHaveLength(1));
    });

    it('leaves a failed read-ahead to the page: no error, and the list as it was', async () => {
      db = fakePostgrest({
        sessions: { error: { code: '57014', message: 'canceling statement due to statement timeout' } },
        set_logs: [],
      });
      supabase.from.mockImplementation(db.from);
      const onUnhandled = vi.fn();
      process.on('unhandledRejection', onUnhandled);
      try {
        mockList = twoSessions();
        renderTraining();
        await waitFor(() => expect(db.requestsTo('sessions')).toHaveLength(1));
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
      expect(onUnhandled).not.toHaveBeenCalled();
      expect(db.requestsTo('set_logs')).toEqual([]);
      expect(screen.getByText('Upper 1')).toBeInTheDocument();
    });
  });
});
