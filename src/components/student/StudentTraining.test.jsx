import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { IsRestoringProvider, QueryClient, QueryClientProvider } from '@tanstack/react-query';

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

// The sessions the coach wrote feedback on.
let mockFeedbackIds = new Set();
vi.mock('../../hooks/useMessages', () => ({
  useMyFeedbackSessionIds: () => ({ data: mockFeedbackIds }),
  useUnreadMessageCount: () => ({ data: 0 }),
}));

vi.mock('../ui/UserMenu', () => ({ default: () => <div data-testid="user-menu" /> }));

import StudentTraining from './StudentTraining';
import { useSession } from '../../hooks/useSession';
import { useSetLogs } from '../../hooks/useSetLogs';
import { supabase } from '../../lib/supabase';
import { fakePostgrest } from '../../test/fakePostgrest';

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

// An exercise of a session as the list's read carries it.
const slot = (id, name, over = {}) => ({
  id,
  sets: 3,
  reps: 8,
  weight_kg: 40,
  exercise: { id: `ex-${id}`, name, type: 'push' },
  ...over,
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

// `sessions.performed_at` as the database writes it: the day trained, as
// midnight UTC — a date, which the page reads as one in every zone.
const trainedOn = (iso) => `${iso}T00:00:00+00:00`;

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

// Where a link of the page took the athlete.
function LocationProbe() {
  const { pathname } = useLocation();
  return <div data-testid="location">{pathname}</div>;
}

const page = (client) => (
  <QueryClientProvider client={client}>
    <MemoryRouter>
      <StudentTraining />
      <LocationProbe />
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

// Wednesday 14 October 2026 at noon, for the tests that say a day: the week
// runs from Monday 12 to Sunday 18. Only `Date` is replaced — the reads, the
// clicks and `waitFor` keep their real timers.
function onWednesday() {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 14, 12));
  });
  afterEach(() => {
    vi.useRealTimers();
  });
}

// The parts of the page, by the names they are read by.
const startLink = () => screen.getByRole('link', { name: 'Start the session' });
// The next session: the panel that holds « Start the session ».
const nextPanel = () => startLink().closest('section');
const thenGroup = () => screen.getByRole('region', { name: 'Then' });
const historyGroup = () => screen.getByRole('region', { name: 'History' });
// The row that opens this block's finished sessions.
const doneRow = () => within(historyGroup()).getByRole('button', { name: /sessions? done/ });
// The row of a past block, by its name.
const blockRow = (name) => within(historyGroup()).getByRole('button', { name: new RegExp(`^${name},`) });
const archivedToggle = () => screen.getByRole('button', { name: /archived session/ });
const where = () => screen.getByTestId('location').textContent;

let db;
beforeEach(() => {
  vi.clearAllMocks();
  mockConfirmedIds = read(new Set());
  mockList = listOf([]);
  mockPastBlocks = {};
  mockFeedbackIds = new Set();
  pastBlockReads.length = 0;
  // Nothing to read ahead unless a test puts a session there.
  db = fakePostgrest({ sessions: [], set_logs: [] });
  supabase.from.mockImplementation(db.from);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('StudentTraining', () => {
  it('shows a spinner while loading, under the page’s title', () => {
    mockList = onItsWay();
    const { container } = renderTraining();
    expect(container.querySelector('.animate-spin')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Training' })).toBeInTheDocument();
  });

  it('tells an athlete without a program that the coach is preparing one', () => {
    renderTraining();
    expect(screen.getByText('No program yet. Your coach is preparing your first block.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Start the session' })).toBeNull();
  });

  // The whole reason the two pages merged: one screen, one question. The week
  // the athlete is in is seven dots in one picture — never a grid of days to
  // tap, never arrows to another week.
  it('does not render a Mon–Sun day strip or week navigation', () => {
    mockList = listOf([week('w-1', 1, [session('s-1', 'Upper 1', { day_number: 1 })])]);
    renderTraining();
    expect(screen.queryByLabelText('Week overview')).toBeNull();
    expect(screen.queryByRole('button', { name: /previous week/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /next week/i })).toBeNull();
    expect(screen.getAllByRole('img', { name: /^This week, / })).toHaveLength(1);
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
    expect(screen.getByText('Bloc Reprise, session 2 of 2')).toBeInTheDocument();
    expect(screen.getAllByText(/of 2$/)).toHaveLength(1);
    // The old page stacked four headings for this; these are retired. Nothing
    // follows the next session here, so there is no « Then » either.
    expect(screen.queryByText('Next session')).toBeNull();
    expect(screen.queryByText('Then')).toBeNull();
  });

  // B33: done out of order, the header named one session and the Next card
  // another — "Session 5 of 6" above the card of session 4.
  it('names the session of the Next panel when sessions were done out of order', () => {
    mockList = listOf([
      week('w-1', 1, ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'].map((title, i) =>
        session(title.toLowerCase(), title, { sort_order: i, day_number: null }))),
    ]);
    mockConfirmedIds = read(new Set(['s1', 's2', 's3', 's5']));
    renderTraining();
    expect(screen.getByText('Bloc Reprise, session 4 of 6')).toBeInTheDocument();
    // The finished ones are behind their closed row: the first session shown
    // is the next one, and it wears the number the header says.
    expect(screen.getAllByText(/^S\d$/).map((n) => n.textContent)).toEqual(['S4', 'S6']);
    expect(within(nextPanel()).getByRole('heading', { name: 'S4' })).toBeInTheDocument();
    expect(within(nextPanel()).getByText('Next')).toBeInTheDocument();
    expect(within(nextPanel()).getByText('Session 4, 0 exercises')).toBeInTheDocument();
    expect(within(thenGroup()).getByRole('link')).toHaveAccessibleName('S6, Session 6, 0 exercises');
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
    await user.click(doneRow());

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
    await user.click(doneRow());
    expect(within(historyGroup()).getByRole('link', { name: /^Wrist Routine,/ })).toHaveAccessibleName(
      'Wrist Routine, Fri, Aug 21',
    );
  });

  it('spells a recommended weekday out as advice rather than a date', () => {
    mockList = listOf([
      week('w-1', 1, [
        session('s-1', 'Upper 1', { day_number: 3 }),
        session('s-2', 'Upper 2', { day_number: 5, sort_order: 1 }),
      ]),
    ]);
    renderTraining();
    expect(within(nextPanel()).getByText('Next, advised on Wednesday')).toBeInTheDocument();
    expect(within(thenGroup()).getByRole('link')).toHaveAccessibleName('Upper 2, Session 2, advised on Friday');
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
    expect(within(nextPanel()).getByRole('heading', { name: 'Upper 1' })).toBeInTheDocument();
    // Numbered as the queue counts them, across phases — in words, and on the
    // dot at the start of the row.
    const [leg, upper2] = within(thenGroup()).getAllByRole('link');
    expect(leg).toHaveAccessibleName('Leg, Session 2, advised on Wednesday');
    expect(upper2).toHaveAccessibleName('Upper 2, Session 3, advised on Monday');
    const dot = (row) => row.querySelector('[aria-hidden="true"]').textContent;
    expect([dot(leg), dot(upper2)]).toEqual(['2', '3']);
  });

  // A month-long block reaches ~20 finished sessions, so the active block's
  // own history needs the same closed row as the past ones. The place in the
  // block, under the title, already states progress without listing it.
  it('collapses the active block finished sessions into a row that opens', async () => {
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

    // The row says how much is inside without rendering any of it…
    expect(doneRow()).toHaveAccessibleName(/^2 sessions done, In this block/);
    expect(doneRow()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Old Push')).toBeNull();
    expect(screen.queryByText('Old Pull')).toBeNull();
    // …while the work still to do stays in plain sight.
    expect(within(nextPanel()).getByText('Next Up')).toBeInTheDocument();

    await user.click(doneRow());
    expect(doneRow()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Old Push')).toBeInTheDocument();
    expect(screen.getByText('Old Pull')).toBeInTheDocument();

    // Closed again, it builds nothing.
    await user.click(doneRow());
    expect(screen.queryByText('Old Push')).toBeNull();
  });

  // Finished in this block, reviewing what was done is the point of keeping
  // it: each row leads to its session.
  it('leads from a finished session of this block to its page', async () => {
    const user = userEvent.setup();
    mockList = listOf([
      week('w-1', 1, [
        session('d1', 'Old Push', { performed_at: '2026-08-11T18:00:00Z' }),
        session('up', 'Next Up', { sort_order: 1 }),
      ]),
    ]);
    mockConfirmedIds = read(new Set(['d1']));
    renderTraining();
    await user.click(doneRow());
    await user.click(within(historyGroup()).getByRole('link', { name: /^Old Push,/ }));
    expect(where()).toBe('/student/session/d1');
  });

  // The next session is what the athlete came for: it is open, with what
  // each exercise asks for, and one button that starts it. There is no card
  // to fold any more, and no other session shows its exercises.
  describe('the next session', () => {
    const twoUpcoming = () =>
      listOf([
        week('w-1', 1, [
          session('a', 'Upper 1', { day_number: null, exercise_slots: [slot('s1', 'Bench Press')] }),
          session('b', 'Upper 2', {
            day_number: null,
            sort_order: 1,
            exercise_slots: [slot('s2', 'Overhead Press')],
          }),
        ]),
      ]);

    it('is open: its title, its place, its exercises and what each asks for', () => {
      mockList = twoUpcoming();
      renderTraining();
      const next = screen.getByRole('region', { name: 'Upper 1' });
      expect(within(next).getByText('Next')).toBeInTheDocument();
      expect(within(next).getByText('Session 1, 1 exercise')).toBeInTheDocument();
      expect(within(next).getByText('Bench Press')).toBeInTheDocument();
      expect(within(next).getByText('3 × 8 at 40 kg')).toBeInTheDocument();
      // Nothing in it opens or folds.
      expect(next.querySelector('[aria-expanded]')).toBeNull();
    });

    it('is the only session that lists its exercises: the next ones are counted', () => {
      mockList = twoUpcoming();
      renderTraining();
      expect(screen.queryByText('Overhead Press')).toBeNull();
      expect(within(thenGroup()).getByRole('link')).toHaveAccessibleName('Upper 2, Session 2, 1 exercise');
    });

    it('is started from its one button, which opens the session', async () => {
      const user = userEvent.setup();
      mockList = twoUpcoming();
      renderTraining();
      // One « Start the session » on the page: no other row repeats it.
      expect(screen.getAllByRole('link', { name: 'Start the session' })).toHaveLength(1);
      expect(startLink()).toHaveAttribute('href', '/student/session/a');
      await user.click(startLink());
      expect(where()).toBe('/student/session/a');
    });

    // B8: row-level security hides the library row of a former coach's
    // exercise, and the embed is null. The panel counts it; it lists it too.
    it('lists an exercise that cannot be read as unavailable, with its prescription', () => {
      const hidden = { id: 'slot-2', sets: 2, reps: 5, exercise: null };
      mockList = listOf([
        week('w-1', 1, [session('a', 'Lower 1', { exercise_slots: [slot('s1', 'Front Squat'), hidden] })]),
      ]);
      renderTraining();
      const next = nextPanel();
      expect(within(next).getByText('Session 1, 2 exercises')).toBeInTheDocument();
      expect(within(next).getByText('Front Squat')).toBeInTheDocument();
      expect(within(next).getByText('Exercise unavailable')).toBeInTheDocument();
      expect(within(next).getByText('2 × 5, bodyweight')).toBeInTheDocument();
    });

    it('groups sets that differ in their order, and gives up past three groups', () => {
      const varied = slot('s1', 'Deadlift', {
        sets: 3,
        reps: 6,
        weight_kg: 100,
        set_logs: [
          { set_number: 1, target_reps: 6, target_weight_kg: 100 },
          { set_number: 2, target_reps: 6, target_weight_kg: 100 },
          { set_number: 3, target_reps: 8, target_weight_kg: 80 },
        ],
      });
      const wild = slot('s2', 'Snatch', {
        sets: 4,
        reps: 5,
        weight_kg: 100,
        set_logs: [
          { set_number: 1, target_reps: 5, target_weight_kg: 60 },
          { set_number: 2, target_reps: 4, target_weight_kg: 70 },
          { set_number: 3, target_reps: 3, target_weight_kg: 80 },
          { set_number: 4, target_reps: 2, target_weight_kg: 90 },
        ],
      });
      mockList = listOf([week('w-1', 1, [session('a', 'Pull', { exercise_slots: [varied, wild] })])]);
      renderTraining();
      expect(within(nextPanel()).getByText('2 × 6 at 100 kg, 8 at 80 kg')).toBeInTheDocument();
      expect(within(nextPanel()).getByText('4 varied sets')).toBeInTheDocument();
    });

    it('says so when it has no exercise yet, and can still be started', () => {
      mockList = listOf([week('w-1', 1, [session('a', 'Upper 1')])]);
      renderTraining();
      expect(within(nextPanel()).getByText('No exercise in this session yet.')).toBeInTheDocument();
      expect(within(nextPanel()).getByText('Session 1, 0 exercises')).toBeInTheDocument();
      expect(startLink()).toHaveAttribute('href', '/student/session/a');
    });

    // A new session is born untitled and is named by its place in the block.
    it('names an untitled session by its place in the block', () => {
      mockList = listOf([
        week('w-1', 1, [
          session('a', 'Upper 1', { performed_at: '2026-08-11T18:00:00Z' }),
          session('b', null, { sort_order: 1, day_number: null }),
          session('c', '', { sort_order: 2, day_number: null }),
        ]),
      ]);
      mockConfirmedIds = read(new Set(['a']));
      renderTraining();
      expect(within(nextPanel()).getByRole('heading', { name: 'Session 2' })).toBeInTheDocument();
      expect(within(thenGroup()).getByRole('link')).toHaveAccessibleName('Session 3, Session 3, 0 exercises');
    });

    describe('when it is planned', () => {
      onWednesday();

      it('says today, or the date the coach set', () => {
        mockList = listOf([
          week('w-1', 1, [
            session('a', 'Upper 1', { scheduled_date: '2026-10-14' }),
            session('b', 'Upper 2', { sort_order: 1, scheduled_date: '2026-10-16' }),
            session('c', 'Upper 3', { sort_order: 2, scheduled_date: '2026-10-15' }),
          ]),
        ]);
        renderTraining();
        expect(within(nextPanel()).getByText('Next, today')).toBeInTheDocument();
        const [upper2, upper3] = within(thenGroup()).getAllByRole('link');
        expect(upper2).toHaveAccessibleName('Upper 2, Session 2, Fri, Oct 16');
        expect(upper3).toHaveAccessibleName('Upper 3, Session 3, tomorrow');
      });

      it('says the date of a next session planned on another day', () => {
        mockList = listOf([week('w-1', 1, [session('a', 'Upper 1', { scheduled_date: '2026-10-23' })])]);
        renderTraining();
        expect(within(nextPanel()).getByText('Next, Fri, Oct 23')).toBeInTheDocument();
      });
    });
  });

  // « Then »: the sessions after the next one, in program order, each a row
  // that leads to its page. Three of them, and the rest on a tap.
  describe('the sessions after the next one', () => {
    const block = (n) =>
      listOf([
        week(
          'w-1',
          1,
          Array.from({ length: n }, (_, i) =>
            session(`s${i + 1}`, `Day ${i + 1}`, { sort_order: i, day_number: null })),
        ),
      ]);

    it('shows the first three, then the others on a tap', async () => {
      const user = userEvent.setup();
      mockList = block(6);
      renderTraining();
      const titles = () => within(thenGroup()).getAllByText(/^Day \d$/).map((n) => n.textContent);
      expect(titles()).toEqual(['Day 2', 'Day 3', 'Day 4']);

      await user.click(within(thenGroup()).getByRole('button', { name: 'Show the 2 other sessions' }));
      expect(titles()).toEqual(['Day 2', 'Day 3', 'Day 4', 'Day 5', 'Day 6']);
      expect(within(thenGroup()).queryByRole('button')).toBeNull();
    });

    it('says one other session in the singular', () => {
      mockList = block(5);
      renderTraining();
      expect(within(thenGroup()).getByRole('button', { name: 'Show the other session' })).toBeInTheDocument();
    });

    it('asks for no tap when there are three or fewer', () => {
      mockList = block(4);
      renderTraining();
      expect(within(thenGroup()).getAllByRole('link')).toHaveLength(3);
      expect(within(thenGroup()).queryByRole('button')).toBeNull();
    });

    // A session of the block being trained is open to the athlete, whatever
    // its place: each row leads to its page.
    it('leads from each row to its session', async () => {
      const user = userEvent.setup();
      mockList = block(3);
      renderTraining();
      const rows = within(thenGroup()).getAllByRole('link');
      expect(rows.map((row) => row.getAttribute('href'))).toEqual(['/student/session/s2', '/student/session/s3']);
      await user.click(rows[1]);
      expect(where()).toBe('/student/session/s3');
    });

    it('is not there when nothing follows the next session', () => {
      mockList = block(1);
      renderTraining();
      expect(screen.queryByRole('region', { name: 'Then' })).toBeNull();
    });
  });

  it('says a finished block is over instead of showing an empty next slot', () => {
    mockList = listOf([week('w-1', 1, [session('a', 'Upper 1', { performed_at: '2026-08-18T18:00:00Z' })])]);
    mockConfirmedIds = read(new Set(['a']));
    renderTraining();
    expect(
      screen.getByText('Block over, every session is done. Your coach is preparing what comes next.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Start the session' })).toBeNull();
    expect(screen.getByText('Bloc Reprise, session 1 of 1')).toBeInTheDocument();
  });

  // A session the coach wrote feedback on says so wherever it is listed.
  describe('the coach’s feedback', () => {
    const block = () =>
      listOf([
        week('w-1', 1, [
          session('done', 'Old Push', { performed_at: '2026-08-11T18:00:00Z', day_number: null }),
          session('next', 'Upper 1', { sort_order: 1, day_number: null }),
          session('later', 'Upper 2', { sort_order: 2, day_number: null }),
        ]),
      ]);

    it('is said on the next session, a later one and a finished one', async () => {
      const user = userEvent.setup();
      mockList = block();
      mockConfirmedIds = read(new Set(['done']));
      mockFeedbackIds = new Set(['done', 'next', 'later']);
      renderTraining();

      expect(within(nextPanel()).getByText('Session 2, 0 exercises, Coach’s feedback')).toBeInTheDocument();
      expect(within(thenGroup()).getByRole('link')).toHaveAccessibleName(
        'Upper 2, Session 3, 0 exercises, Coach’s feedback',
      );
      await user.click(doneRow());
      expect(within(historyGroup()).getByRole('link', { name: /^Old Push,/ })).toHaveAccessibleName(
        'Old Push, Tue, Aug 11, Coach’s feedback',
      );
    });

    it('is said nowhere when there is none', async () => {
      const user = userEvent.setup();
      mockList = block();
      mockConfirmedIds = read(new Set(['done']));
      renderTraining();
      await user.click(doneRow());
      expect(screen.queryByText(/Coach’s feedback/)).toBeNull();
    });
  });

  // One line beside the week's dots, and only when it says something:
  // "Trained today" told the athlete what they already knew.
  describe('the line beside the week', () => {
    onWednesday();

    it('counts the sessions done this week, and the dots say which days', () => {
      mockList = listOf([
        week('w-1', 1, [
          session('mon', 'Upper 1', { performed_at: trainedOn('2026-10-12') }),
          session('tue', 'Lower 1', { sort_order: 1, performed_at: trainedOn('2026-10-13') }),
          session('fri', 'Upper 2', { sort_order: 2, day_number: 5 }),
        ]),
      ]);
      mockConfirmedIds = read(new Set(['mon', 'tue']));
      renderTraining();
      expect(screen.getByText('2 sessions done this week')).toBeInTheDocument();
      expect(
        screen.getByRole('img', { name: 'This week, Monday and Tuesday done, next session Friday' }),
      ).toBeInTheDocument();
    });

    it('never says "trained today" — it counts the week instead', () => {
      mockList = listOf([
        week('w-1', 1, [
          session('a', 'Upper 1', { performed_at: trainedOn('2026-10-14') }),
          session('b', 'Upper 2', { sort_order: 1, day_number: 5 }),
        ]),
      ]);
      mockConfirmedIds = read(new Set(['a']));
      renderTraining();
      expect(screen.queryByText(/trained today/i)).toBeNull();
      expect(screen.getByText('1 session done this week')).toBeInTheDocument();
    });

    it('says a session is planned today', () => {
      mockList = listOf([week('w-1', 1, [session('a', 'Upper 1', { scheduled_date: '2026-10-14' })])]);
      renderTraining();
      expect(screen.getByRole('img', { name: 'This week, a session planned today' })).toBeInTheDocument();
    });

    // In a week with nothing done yet, how long the athlete has been away.
    it('reports staleness when the athlete has been away', () => {
      mockList = listOf([
        week('w-1', 1, [
          session('a', 'Upper 1', { performed_at: trainedOn('2026-10-08') }),
          session('b', 'Upper 2', { sort_order: 1, day_number: 5 }),
        ]),
      ]);
      mockConfirmedIds = read(new Set(['a']));
      renderTraining();
      expect(screen.getByText('Last session 6 days ago')).toBeInTheDocument();
      expect(screen.queryByText(/done this week/)).toBeNull();
    });

    it('dates the last of the finished sessions on their row', () => {
      mockList = listOf([
        week('w-1', 1, [
          session('a', 'Upper 1', { performed_at: trainedOn('2026-10-08') }),
          session('b', 'Upper 2', { sort_order: 1 }),
        ]),
      ]);
      mockConfirmedIds = read(new Set(['a']));
      renderTraining();
      expect(doneRow()).toHaveAccessibleName('1 session done, In this block, the last one 6 days ago');
    });

    // Confirmed before the day was recorded: nothing to date them by, and
    // nothing made up.
    it('leaves the row of finished sessions undated when none has a date', () => {
      mockList = listOf([
        week('w-1', 1, [session('a', 'Upper 1'), session('b', 'Upper 2', { sort_order: 1 })]),
      ]);
      mockConfirmedIds = read(new Set(['a']));
      renderTraining();
      expect(doneRow()).toHaveAccessibleName('1 session done, In this block');
      expect(screen.queryByText(/Last session/)).toBeNull();
    });

    it('says nothing at all when there is no program to comment on', () => {
      renderTraining();
      expect(screen.queryByRole('img', { name: /This week/ })).toBeNull();
      expect(screen.queryByText(/Last session/)).toBeNull();
      expect(screen.queryByText(/done this week/)).toBeNull();
      expect(screen.queryByText('No session done yet')).toBeNull();
    });

    // Live N7: an athlete with 24 confirmed sessions in earlier blocks, on the
    // first session of a new one, read "No sessions logged yet". The queue
    // knows the block being trained only; the confirmations are every block's.
    describe('"No session done yet"', () => {
      const freshBlock = () =>
        listOf([week('w-1', 1, [session('a', 'Upper 1'), session('b', 'Upper 2', { day_number: 3 })])]);

      it('is said to an athlete who has never confirmed a session', () => {
        mockList = freshBlock();
        mockConfirmedIds = read(new Set());
        renderTraining();
        expect(screen.getByText('No session done yet')).toBeInTheDocument();
      });

      it('is not said to an athlete who confirmed sessions in an earlier block', () => {
        mockList = freshBlock();
        mockConfirmedIds = read(new Set(['old-session']));
        renderTraining();
        expect(screen.queryByText('No session done yet')).toBeNull();
        expect(screen.getByText('Bloc Reprise, session 1 of 2')).toBeInTheDocument();
        // The line beside the dots says the block has not begun — it was
        // empty (live run, 2026-10-17).
        expect(screen.getByText('No session in this block yet')).toBeInTheDocument();
      });

      it('says nothing of a block not begun once one of its sessions is done', () => {
        mockList = freshBlock();
        mockConfirmedIds = read(new Set(['a']));
        renderTraining();
        expect(screen.queryByText('No session in this block yet')).toBeNull();
      });

      it('is not said while the confirmations could not be read', () => {
        mockList = freshBlock();
        mockConfirmedIds = failed();
        renderTraining();
        expect(screen.getByText(/couldn’t be loaded/i)).toBeInTheDocument();
        expect(screen.queryByText('No session done yet')).toBeNull();
      });
    });
  });

  describe('past blocks', () => {
    const pastProgram = { id: 'p-0', name: 'Bloc 1', sort_order: 0, is_active: false };
    const current = () => week('w-1', 1, [session('now', 'Current Work', { day_number: 1 })]);
    // The sessions of the past block, as its own read returns them.
    const pastBlock = (sessions) => read([week('w-0', 1, sessions, pastProgram)]);

    it('renders finished blocks below the active one, as rows of the history', () => {
      mockList = listOf([current()], [pastHeader(pastProgram, 1)]);
      renderTraining();

      expect(screen.getByText('Bloc Reprise, session 1 of 1')).toBeInTheDocument();
      expect(blockRow('Bloc 1')).toHaveAccessibleName('Bloc 1, Block over, 1 session');
      expect(
        nextPanel().compareDocumentPosition(historyGroup()) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    // A year of coaching is hundreds of sessions; the landing page must not
    // spend its height on them — nor a request. The row of a closed block is
    // made of the name and the count the list's own read carries.
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
      expect(blockRow('Bloc 1')).toHaveAccessibleName('Bloc 1, Block over, 2 sessions');
      expect(blockRow('Bloc 1')).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByText('Old Squat')).toBeNull();
      expect(screen.queryByText('Old Pull')).toBeNull();
      expect(pastBlockReads).toEqual([]);
      // The ACTIVE block stays open — that is the page's actual subject.
      expect(within(nextPanel()).getByText('Current Work')).toBeInTheDocument();

      await user.click(blockRow('Bloc 1'));
      expect(blockRow('Bloc 1')).toHaveAttribute('aria-expanded', 'true');
      expect(new Set(pastBlockReads)).toEqual(new Set(['p-0']));
      expect(screen.getByText('Old Squat')).toBeInTheDocument();
      expect(screen.getByText('Old Pull')).toBeInTheDocument();
    });

    it('reads only the block whose row is opened', async () => {
      const user = userEvent.setup();
      const older = { id: 'p-00', name: 'Bloc 0', sort_order: -1, is_active: false };
      mockList = listOf([current()], [pastHeader(pastProgram, 2), pastHeader(older, 5)]);
      mockPastBlocks['p-0'] = pastBlock([session('old', 'Old Squat')]);
      renderTraining();

      await user.click(blockRow('Bloc 1'));
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

      await user.click(blockRow('Bloc 1'));
      const titles = screen
        .getAllByText(/^(Old Squat|Never Done|Old Pull)$/)
        .map((n) => n.textContent);
      expect(titles).toEqual(['Old Pull', 'Old Squat', 'Never Done']);
    });

    it('shows a spinner in an opened row until its block is read', async () => {
      const user = userEvent.setup();
      mockList = listOf([current()], [pastHeader(pastProgram, 2)]);
      renderTraining();

      await user.click(blockRow('Bloc 1'));
      expect(historyGroup().querySelector('.animate-spin')).toBeTruthy();
    });

    // The row comes from the read the device keeps; the sessions do not. An
    // opened row says so, and the rest of the page is untouched.
    it('says a past block is not on the device when it is opened without a network', async () => {
      const user = userEvent.setup();
      mockList = listOf([current()], [pastHeader(pastProgram, 2)]);
      mockPastBlocks['p-0'] = waitingForNetwork();
      renderTraining();

      await user.click(blockRow('Bloc 1'));
      const past = historyGroup();
      expect(within(past).getByText(/this block isn’t on this device/i)).toBeInTheDocument();
      expect(within(nextPanel()).getByText('Current Work')).toBeInTheDocument();

      await user.click(within(past).getByRole('button', { name: /try again/i }));
      expect(mockPastBlocks['p-0'].refetch).toHaveBeenCalledTimes(1);
      expect(mockPastBlocks['p-0'].refetch).toHaveBeenCalledWith({ cancelRefetch: false });
    });

    it('says a past block could not be loaded when its read failed', async () => {
      const user = userEvent.setup();
      mockList = listOf([current()], [pastHeader(pastProgram, 2)]);
      mockPastBlocks['p-0'] = failed();
      renderTraining();

      await user.click(blockRow('Bloc 1'));
      expect(within(historyGroup()).getByText(/this block couldn’t be loaded/i)).toBeInTheDocument();
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

      await user.click(blockRow('Bloc 1'));
      const review = within(historyGroup()).getByRole('link', { name: /^Old Squat,/ });
      expect(review).toHaveAccessibleName('Old Squat, Mon, Jun 1');
      await user.click(review);
      expect(where()).toBe('/student/session/old');
    });

    // Past-block sessions are locked in the UI and by RLS, so a Start on one
    // led nowhere; and one never trained has nothing to show either.
    it('offers no Start on a past block, and no way into a session never trained there', async () => {
      const user = userEvent.setup();
      mockList = listOf([current()], [pastHeader(pastProgram, 1)]);
      mockPastBlocks['p-0'] = pastBlock([session('stale', 'Never Finished')]);
      renderTraining();
      await user.click(blockRow('Bloc 1'));
      const past = historyGroup();
      expect(within(past).getByText('Never Finished')).toBeInTheDocument();
      expect(within(past).queryByRole('link')).toBeNull();
      // The one « Start the session » is the next session's, in the block
      // being trained.
      expect(screen.getAllByRole('link', { name: 'Start the session' })).toHaveLength(1);
      expect(startLink()).toHaveAttribute('href', '/student/session/now');
    });

    // A past block's unfinished sessions are history the athlete moved on
    // from — surfacing one as "next" would put stale work at the top.
    it('never offers a past block session as the next one', async () => {
      const user = userEvent.setup();
      mockList = listOf([current()], [pastHeader(pastProgram, 1)]);
      mockPastBlocks['p-0'] = pastBlock([session('abandoned', 'Never Finished')]);
      renderTraining();
      await user.click(blockRow('Bloc 1'));

      expect(within(nextPanel()).getByText('Current Work')).toBeInTheDocument();
      expect(within(nextPanel()).queryByText('Never Finished')).toBeNull();
      expect(screen.getAllByText(/^Next/)).toHaveLength(1);
      expect(screen.getByText('Bloc Reprise, session 1 of 1')).toBeInTheDocument();
    });

    // L32. "Full Body 2" of a past block: two sets of six ticked, never
    // confirmed, and the coach moved on. Its card held nothing but its
    // toggle. What was logged there is history like a confirmed session's.
    describe('a session trained in and never confirmed', () => {
      const trained = (logs, over = {}) =>
        session('half', 'Full Body 2', {
          exercise_slots: [
            {
              id: 'sl-1',
              sets: 2,
              reps: 5,
              sort_order: 0,
              exercise: { id: 'ex-1', name: 'Squat', type: 'push' },
              set_logs: logs,
            },
          ],
          ...over,
        });
      const fullBody = () => within(historyGroup()).getByText('Full Body 2');

      it('can be reviewed when one of its sets was logged', async () => {
        const user = userEvent.setup();
        mockList = listOf([current()], [pastHeader(pastProgram, 1)]);
        mockPastBlocks['p-0'] = pastBlock([
          trained([
            { set_number: 1, done: true, failed: false, skipped: false, rpe: 8 },
            { set_number: 2, done: false, failed: false, skipped: false, rpe: null },
          ]),
        ]);
        renderTraining();

        await user.click(blockRow('Bloc 1'));
        const past = historyGroup();
        // Never "start": the block is over, nothing can be logged there.
        expect(within(past).queryByRole('link', { name: 'Start the session' })).toBeNull();
        await user.click(within(past).getByRole('link', { name: /^Full Body 2/ }));
        expect(where()).toBe('/student/session/half');
      });

      it('an RPE or an actual left on a set that is not ticked counts as logged', async () => {
        const user = userEvent.setup();
        mockList = listOf([current()], [pastHeader(pastProgram, 1)]);
        mockPastBlocks['p-0'] = pastBlock([
          trained([{ set_number: 1, done: false, actual_reps: 3, actual_weight_kg: null, rpe: null }]),
        ]);
        renderTraining();

        await user.click(blockRow('Bloc 1'));
        expect(within(historyGroup()).getByRole('link', { name: /^Full Body 2/ })).toHaveAttribute(
          'href',
          '/student/session/half',
        );
      });

      it('leads nowhere when none of its sets was logged: the page would be empty', async () => {
        const user = userEvent.setup();
        mockList = listOf([current()], [pastHeader(pastProgram, 1)]);
        mockPastBlocks['p-0'] = pastBlock([
          trained([
            { set_number: 1, done: false, failed: false, skipped: false, rpe: null, actual_reps: null, actual_weight_kg: null },
            { set_number: 2, done: false, failed: false, skipped: false, rpe: null, actual_reps: null, actual_weight_kg: null },
          ]),
        ]);
        renderTraining();

        await user.click(blockRow('Bloc 1'));
        expect(fullBody()).toBeInTheDocument();
        expect(within(historyGroup()).queryByRole('link')).toBeNull();
      });

      it('archived by the coach: leads nowhere, logged sets or not', async () => {
        const user = userEvent.setup();
        mockList = listOf([current()], [pastHeader(pastProgram, 1, 1)]);
        mockPastBlocks['p-0'] = pastBlock([
          trained([{ set_number: 1, done: true, failed: false, skipped: false, rpe: 8 }], {
            archived_at: '2026-06-01T00:00:00Z',
          }),
        ]);
        renderTraining();

        await user.click(archivedToggle());
        await user.click(blockRow('Bloc 1'));
        expect(fullBody().closest('.pk-row')).toHaveTextContent('archived');
        expect(within(historyGroup()).queryByRole('link')).toBeNull();
      });
    });

    it('names a block without a name', () => {
      const untitled = { id: 'p-0', name: '', sort_order: 0, is_active: false };
      mockList = listOf([current()], [pastHeader(untitled, 1)]);
      renderTraining();
      expect(blockRow('Block without a name')).toHaveAccessibleName('Block without a name, Block over, 1 session');
    });

    // An untitled session is named by its place in ITS block — the place the
    // athlete saw it at while that block was being trained. No session is
    // number 0.
    it('names an untitled session of a past block by its place in that block', async () => {
      const user = userEvent.setup();
      mockList = listOf([current()], [pastHeader(pastProgram, 2)]);
      mockPastBlocks['p-0'] = pastBlock([
        session('old-a', 'Old Squat', { sort_order: 0, performed_at: '2026-06-01T18:00:00Z' }),
        session('old-b', null, { sort_order: 1, performed_at: '2026-06-03T18:00:00Z' }),
      ]);
      mockConfirmedIds = read(new Set(['old-a', 'old-b']));
      renderTraining();

      await user.click(blockRow('Bloc 1'));
      expect(within(historyGroup()).getByRole('link', { name: /^Session 2,/ })).toHaveAttribute(
        'href',
        '/student/session/old-b',
      );
      expect(screen.queryByText('Session 0')).toBeNull();
    });

    it('shows the past blocks of an athlete who has no block being trained', () => {
      mockList = listOf([], [pastHeader(pastProgram, 4)]);
      renderTraining();
      expect(blockRow('Bloc 1')).toHaveAccessibleName('Bloc 1, Block over, 4 sessions');
      expect(screen.queryByText(/no program yet/i)).toBeNull();
      expect(screen.queryByRole('link', { name: 'Start the session' })).toBeNull();
    });
  });

  describe('archived sessions', () => {
    const pastProgram = { id: 'p-0', name: 'Bloc 1', sort_order: 0, is_active: false };

    it('hides archived sessions behind a toggle', async () => {
      const user = userEvent.setup();
      mockList = listOf([
        week('w-1', 1, [
          session('a', 'Upper 1', { performed_at: '2026-08-18T18:00:00Z' }),
          session('gone', 'Pulled', { day_number: 3, archived_at: '2026-08-01T00:00:00Z' }),
        ]),
      ]);
      mockConfirmedIds = read(new Set(['a']));
      renderTraining();
      expect(screen.queryByText('Pulled')).toBeNull();
      expect(archivedToggle()).toHaveAccessibleName('Show the archived session');
      expect(archivedToggle()).toHaveAttribute('aria-pressed', 'false');
      expect(doneRow()).toHaveAccessibleName(/^1 session done/);

      await user.click(archivedToggle());
      expect(archivedToggle()).toHaveAccessibleName('Hide the archived session');
      expect(archivedToggle()).toHaveAttribute('aria-pressed', 'true');
      expect(doneRow()).toHaveAccessibleName(/^2 sessions done/);
      await user.click(doneRow());
      // Shown for what it is, and leading nowhere: the coach pulled it.
      const pulled = within(historyGroup()).getByText('Pulled').closest('.pk-row');
      expect(pulled).toHaveTextContent('archived');
      expect(within(historyGroup()).queryByRole('link', { name: /^Pulled/ })).toBeNull();
      // An archived session has no place in the block: it is one session long.
      expect(screen.getByText('Bloc Reprise, session 1 of 1')).toBeInTheDocument();
    });

    it('counts them in the plural', () => {
      mockList = listOf([
        week('w-1', 1, [
          session('a', 'Upper 1'),
          session('x', 'Pulled A', { archived_at: '2026-08-01T00:00:00Z' }),
          session('y', 'Pulled B', { archived_at: '2026-08-01T00:00:00Z' }),
        ]),
      ]);
      renderTraining();
      expect(archivedToggle()).toHaveAccessibleName('Show the 2 archived sessions');
    });

    it('is not offered when nothing is archived', () => {
      mockList = listOf([week('w-1', 1, [session('a', 'Upper 1')])]);
      renderTraining();
      expect(screen.queryByRole('button', { name: /archived session/ })).toBeNull();
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

      expect(blockRow('Bloc 1')).toHaveAccessibleName('Bloc 1, Block over, 3 sessions');
      await user.click(screen.getByRole('button', { name: 'Show the 3 archived sessions' }));
      expect(blockRow('Bloc 1')).toHaveAccessibleName('Bloc 1, Block over, 5 sessions');
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
      expect(screen.queryByRole('region', { name: 'History' })).toBeNull();

      await user.click(screen.getByRole('button', { name: 'Show the 2 archived sessions' }));
      await user.click(blockRow('Bloc 1'));
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

      await user.click(blockRow('Bloc 1'));
      expect(screen.getByText('Old Squat')).toBeInTheDocument();
      expect(screen.queryByText('Shelved')).toBeNull();

      await user.click(screen.getByRole('button', { name: 'Show the archived session' }));
      expect(screen.getByText('Shelved')).toBeInTheDocument();
    });

    // An archived session has no place in the queue, so no number to be named
    // by — and 0 is nobody's place.
    it('never names an untitled archived session "Session 0"', async () => {
      const user = userEvent.setup();
      mockList = listOf([
        week('w-1', 1, [
          session('a', 'Upper 1', { performed_at: '2026-08-18T18:00:00Z' }),
          session('gone', null, { sort_order: 1, archived_at: '2026-08-01T00:00:00Z' }),
        ]),
      ]);
      mockConfirmedIds = read(new Set(['a']));
      renderTraining();
      await user.click(archivedToggle());
      await user.click(doneRow());
      expect(within(historyGroup()).getByText('archived')).toBeInTheDocument();
      expect(screen.queryByText('Session 0')).toBeNull();
    });
  });

  // "No program assigned yet" is a statement about the athlete's program, and
  // only a read that answered can make it. The page used to make it for every
  // read without data — which, on a launch without a network, was all of them.
  describe('when the list has nothing to build on', () => {
    const noProgram = /no program yet/i;

    it('says the training is not on this device when the read waits for a network', async () => {
      const user = userEvent.setup();
      mockList = waitingForNetwork();
      renderTraining();

      expect(screen.getByText(/your training isn’t on this device yet/i)).toBeInTheDocument();
      expect(screen.getByText(/you’re offline/i)).toBeInTheDocument();
      expect(screen.queryByText(noProgram)).toBeNull();
      // The page is still a page: its title and the menu are there.
      expect(screen.getByRole('heading', { level: 1, name: 'Training' })).toBeInTheDocument();
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
      expect(within(nextPanel()).getByText('Upper 1')).toBeInTheDocument();
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
        expect(screen.queryByText(/^Next/)).toBeNull();
        expect(screen.queryByText('Upper 1')).toBeNull();
        expect(screen.queryByRole('link', { name: 'Start the session' })).toBeNull();
      });

      it('says the training is not on this device when they wait for a network', () => {
        mockList = block();
        mockConfirmedIds = waitingForNetwork();
        renderTraining();
        expect(screen.getByText(/your training isn’t on this device yet/i)).toBeInTheDocument();
        expect(screen.queryByText(/session 1 of 2/)).toBeNull();
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
