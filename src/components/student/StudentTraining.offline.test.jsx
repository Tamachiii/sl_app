// The training list from the device, end to end: the real hooks, a cache saved
// the way the app saves it (`shouldPersistQuery`, through JSON) and restored
// into a client of a launch without a network.
//
// StudentTraining.test.jsx stubs the hook layer and covers what the page does
// with each state of its reads. This file is the other half: that the reads
// the page REALLY makes are the ones the device keeps — the defect behind
// "No program assigned yet" in the gym was a key, and a stubbed hook has none.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import {
  QueryClient,
  QueryClientProvider,
  dehydrate,
  hydrate,
  onlineManager,
} from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'u-1' },
    profile: { full_name: 'Tony Me' },
    signOut: vi.fn(),
  }),
}));
vi.mock('../../lib/supabase', () => ({ supabase: { from: vi.fn() } }));
vi.mock('../ui/UserMenu', () => ({ default: () => <div data-testid="user-menu" /> }));

import StudentTraining from './StudentTraining';
import { useSession } from '../../hooks/useSession';
import { useSetLogs } from '../../hooks/useSetLogs';
import {
  studentProgramDetailsKey,
  studentPastProgramKey,
} from '../../hooks/useStudentProgramDetails';
import { queryClient as appClient, shouldPersistQuery, PERSIST_MAX_AGE_MS } from '../../lib/queryClient';
import { supabase } from '../../lib/supabase';
import { fakePostgrest } from '../../test/fakePostgrest';

// --- the athlete's data, as PostgREST nests it --------------------------------

const slot = (id, sort_order, name) => ({
  id,
  sort_order,
  sets: 2,
  reps: 8,
  weight_kg: 40,
  duration_seconds: null,
  record_video_set_numbers: null,
  exercise: { id: `ex-${id}`, name, type: 'push' },
  set_logs: [
    { set_number: 1, target_reps: 8, target_weight_kg: 40, target_duration_seconds: null, target_rest_seconds: 120 },
    { set_number: 2, target_reps: 8, target_weight_kg: 40, target_duration_seconds: null, target_rest_seconds: 120 },
  ],
});

const sessionOf = (id, title, sort_order, over = {}) => ({
  id,
  title,
  day_number: null,
  sort_order,
  scheduled_date: null,
  archived_at: null,
  performed_at: null,
  exercise_slots: [],
  ...over,
});

const NEXT_SLOTS = [slot('sl-1', 0, 'Bench Press'), slot('sl-2', 1, 'Weighted Dip')];

const ACTIVE = {
  id: 'p-2',
  name: 'Bloc 3',
  sort_order: 2,
  is_active: true,
  weeks: [
    {
      id: 'w-1',
      week_number: 1,
      label: null,
      sessions: [
        sessionOf('s-1', 'Push A', 0, { performed_at: '2026-10-09T17:00:00Z' }),
        sessionOf('s-2', 'Pull A', 1, { exercise_slots: NEXT_SLOTS }),
        sessionOf('s-3', 'Legs A', 2),
      ],
    },
  ],
};

const PAST = {
  id: 'p-1',
  name: 'Bloc Reprise',
  sort_order: 1,
  is_active: false,
  weeks: [
    {
      id: 'w-0',
      week_number: 1,
      label: null,
      sessions: [
        sessionOf('old-1', 'Old Squat', 0, { performed_at: '2026-06-01T17:00:00Z' }),
        sessionOf('old-2', 'Old Pull', 1, { performed_at: '2026-06-03T17:00:00Z' }),
      ],
    },
  ],
};

const SET_LOGS = [
  { id: 'l-1', exercise_slot_id: 'sl-1', set_number: 1, done: false },
  { id: 'l-2', exercise_slot_id: 'sl-1', set_number: 2, done: false },
  { id: 'l-3', exercise_slot_id: 'sl-2', set_number: 1, done: false },
  { id: 'l-4', exercise_slot_id: 'sl-2', set_number: 2, done: false },
];

// --- the network --------------------------------------------------------------

// What postgrest-js hands back when `fetch` itself failed: an error object
// with an empty code.
const NO_ANSWER = { message: 'TypeError: Failed to fetch', details: '', hint: '', code: '' };

const network = { up: true };
let db;

function wire() {
  const eq = (request, column) =>
    request.filters.find(([op, col]) => op === 'eq' && col === column)?.[2];
  const answer = (rows) => (request) => (network.up ? rows(request) : { error: NO_ANSWER });

  db = fakePostgrest({
    students: answer(() => [{ id: 'st-1' }]),
    programs: answer((request) => {
      const id = eq(request, 'id');
      if (id) return [PAST].filter((p) => p.id === id);
      if (eq(request, 'is_active')) return [ACTIVE];
      // The header read: nothing of a session but `archived_at`.
      return [
        {
          id: PAST.id,
          name: PAST.name,
          sort_order: PAST.sort_order,
          weeks: PAST.weeks.map((w) => ({
            sessions: w.sessions.map((s) => ({ archived_at: s.archived_at })),
          })),
        },
      ];
    }),
    session_confirmations: answer(() => [{ session_id: 's-1' }]),
    messages: answer(() => []),
    sessions: answer((request) => {
      const id = eq(request, 'id');
      return [
        {
          id,
          title: 'Pull A',
          reviewed_at: null,
          archived_at: null,
          weeks: { programs: { is_active: true } },
          exercise_slots: NEXT_SLOTS.map((s) => ({ ...s, session_id: id })),
        },
      ];
    }),
    set_logs: answer(() => SET_LOGS),
  });
  supabase.from.mockImplementation(db.from);
}

// The two ways a launch without a network has looked to React Query.
//
//   'paused'    the client knows the device is offline and holds its reads
//               back (`networkMode: 'online'`, the manager following
//               `navigator.onLine`);
//   'attempted' the client believes it is online — its manager only moves on
//               an event, and none fires at launch — so every read is sent,
//               and fails. Nothing tells it when the network returns.
//
// The page has to be right in both: which of the two it is given is decided in
// lib/queryClient.js, and it must not depend on the answer.
const MODES = {
  paused: { networkMode: 'online', managerFollows: true },
  attempted: { networkMode: 'offlineFirst', managerFollows: false },
};

function setNetwork(up, mode) {
  network.up = up;
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(up);
  act(() => {
    if (MODES[mode].managerFollows) onlineManager.setOnline(up);
    window.dispatchEvent(new Event(up ? 'online' : 'offline'));
  });
}

function makeClient(mode) {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: Infinity,
        // The app's two minutes.
        staleTime: 2 * 60 * 1000,
        networkMode: MODES[mode].networkMode,
      },
      mutations: { retry: false },
    },
  });
}

// The next session: the panel that holds « Start the session ».
const nextPanel = () => screen.getByRole('link', { name: 'Start the session' }).closest('section');
// The row of the past block, in the history.
const pastBlockRow = () => screen.getByRole('button', { name: /^Bloc Reprise,/ });

const withClient = (client) => ({ children }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);

function renderTraining(client) {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <StudentTraining />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// What the app writes to IndexedDB and reads back at the next launch.
function saveAndRestore(from, into) {
  const saved = JSON.parse(
    JSON.stringify(dehydrate(from, { shouldDehydrateQuery: shouldPersistQuery })),
  );
  hydrate(into, saved);
  return saved.queries.map((q) => q.queryKey);
}

// A first visit with a network: the list, and the next session read ahead.
async function visitOnline(mode) {
  const client = makeClient(mode);
  const view = renderTraining(client);
  await screen.findByText('Pull A');
  await waitFor(() => expect(db.requestsTo('set_logs')).toHaveLength(1));
  return { client, view };
}

beforeEach(() => {
  vi.clearAllMocks();
  network.up = true;
  onlineManager.setOnline(true);
  wire();
});

afterEach(() => {
  vi.restoreAllMocks();
  onlineManager.setOnline(true);
});

describe.each(Object.keys(MODES))('a launch without a network (reads %s)', (mode) => {
  it('shows the list the device kept: the block, the place in it, the next session, the past blocks', async () => {
    const { client: atHome, view } = await visitOnline(mode);
    const gym = makeClient(mode);
    const kept = saveAndRestore(atHome, gym);
    view.unmount();

    // The read the list is made of is among what was saved — under the very
    // key the page asks for, which is the whole point.
    expect(kept).toContainEqual(studentProgramDetailsKey('u-1'));
    expect(kept).toContainEqual(['my-confirmed-session-ids', 'u-1']);

    setNetwork(false, mode);
    const before = db.requests.length;
    renderTraining(gym);

    // One confirmed out of three: the athlete is on the second, not back on
    // the first.
    expect(screen.getByText('Bloc 3, session 2 of 3')).toBeInTheDocument();
    const next = nextPanel();
    expect(within(next).getByRole('heading', { name: 'Pull A' })).toBeInTheDocument();
    expect(within(next).getByText('Bench Press')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Then' })).getByText('Legs A')).toBeInTheDocument();
    expect(pastBlockRow()).toHaveAccessibleName('Bloc Reprise, Block over, 2 sessions');

    expect(screen.queryByText(/no program yet/i)).toBeNull();
    expect(screen.queryByText(/isn’t on this device/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();

    // And it stays the list once the reads of this launch have failed or been
    // held back: nothing that answered, nothing that replaced what was kept.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByText('Bloc 3, session 2 of 3')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
    if (MODES[mode].managerFollows) expect(db.requests).toHaveLength(before);
  });

  // The cache comes back from IndexedDB a moment after the page is on screen.
  // In that moment a device without a network holds nothing yet, exactly like
  // one that kept nothing — and must not be told so.
  it('goes from its spinner to the list, never through "not on this device", while the cache is read back', async () => {
    const { client: atHome, view } = await visitOnline(mode);
    const saved = JSON.parse(
      JSON.stringify(dehydrate(atHome, { shouldDehydrateQuery: shouldPersistQuery })),
    );
    view.unmount();
    setNetwork(false, mode);

    let handOver;
    const persister = {
      persistClient: async () => {},
      removeClient: async () => {},
      // Asynchronous, as IndexedDB is.
      restoreClient: () =>
        new Promise((resolve) => {
          handOver = () => resolve({ timestamp: Date.now(), buster: '', clientState: saved });
        }),
    };
    const { container } = render(
      <PersistQueryClientProvider client={makeClient(mode)} persistOptions={{ persister }}>
        <MemoryRouter>
          <StudentTraining />
        </MemoryRouter>
      </PersistQueryClientProvider>,
    );
    const said = [];
    const watch = new MutationObserver(() => {
      if (/isn’t on this device|couldn’t be loaded|no program yet/i.test(container.textContent)) {
        said.push(container.textContent);
      }
    });
    watch.observe(container, { childList: true, subtree: true, characterData: true });

    expect(container.querySelector('.animate-spin')).toBeTruthy();
    expect(screen.queryByText(/isn’t on this device/i)).toBeNull();

    await act(async () => handOver());
    expect(await screen.findByText('Bloc 3, session 2 of 3')).toBeInTheDocument();
    watch.disconnect();
    expect(said).toEqual([]);
  });

  it('opens the next session, which was never opened on this device', async () => {
    const { client: atHome, view } = await visitOnline(mode);
    const gym = makeClient(mode);
    const kept = saveAndRestore(atHome, gym);
    view.unmount();

    expect(kept).toContainEqual(['session', 's-2']);
    expect(kept).toContainEqual(['set-logs', 's-2', ['sl-1', 'sl-2']]);

    setNetwork(false, mode);
    // The session page's two reads — the ones it holds its spinner for.
    const { result } = renderHook(
      () => {
        const session = useSession('s-2');
        const logs = useSetLogs('s-2', session.data?.exercise_slots);
        return { session, logs };
      },
      { wrapper: withClient(gym) },
    );
    expect(result.current.session.data.title).toBe('Pull A');
    expect(result.current.session.data.program_is_active).toBe(true);
    expect(result.current.session.data.exercise_slots.map((s) => s.exercise.name)).toEqual([
      'Bench Press',
      'Weighted Dip',
    ]);
    // Ordered by set number, as the page asks for them.
    expect(result.current.logs.data.map((l) => l.id)).toEqual(['l-1', 'l-3', 'l-2', 'l-4']);
    expect(result.current.session.isLoading).toBe(false);
    expect(result.current.logs.isLoading).toBe(false);
  });

  it('keeps the sessions of a past block off the device, and says so when one is opened', async () => {
    const user = userEvent.setup();
    const { client: atHome, view } = await visitOnline(mode);

    // Opened at home: read, shown.
    await user.click(pastBlockRow());
    expect(await screen.findByText('Old Squat')).toBeInTheDocument();
    expect(atHome.getQueryData(studentPastProgramKey('u-1', 'p-1'))).toHaveLength(1);

    const gym = makeClient(mode);
    const kept = saveAndRestore(atHome, gym);
    view.unmount();
    expect(kept).not.toContainEqual(studentPastProgramKey('u-1', 'p-1'));
    expect(kept.filter((key) => key[0] === 'student-program-details')).toEqual([
      studentProgramDetailsKey('u-1'),
    ]);

    setNetwork(false, mode);
    renderTraining(gym);
    await user.click(pastBlockRow());
    const past = screen.getByRole('region', { name: 'History' });
    expect(
      await within(past).findByText(/this block isn’t on this device/i),
    ).toBeInTheDocument();
    // The workout is not held hostage by it.
    expect(screen.getByText('Pull A')).toBeInTheDocument();

    // Back on a network, the open drawer fills.
    setNetwork(true, mode);
    if (!MODES[mode].managerFollows) {
      // Nothing told this client: the drawer's button is the way.
      await user.click(within(past).getByRole('button', { name: /try again/i }));
    }
    expect(await within(past).findByText('Old Squat')).toBeInTheDocument();
    expect(within(past).getByText('Old Pull')).toBeInTheDocument();
  });

  it('with nothing kept, says the training is not on the device — and shows it when the network returns', async () => {
    setNetwork(false, mode);
    renderTraining(makeClient(mode));

    expect(
      await screen.findByText(/your training isn’t on this device yet/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/no program yet/i)).toBeNull();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();

    // No tap: the return of the network is enough.
    setNetwork(true, mode);
    expect(await screen.findByText('Bloc 3, session 2 of 3')).toBeInTheDocument();
    expect(screen.getByText('Pull A')).toBeInTheDocument();
    expect(screen.queryByText(/isn’t on this device/i)).toBeNull();
  });

  it('with nothing kept, tries again on a tap', async () => {
    const user = userEvent.setup();
    setNetwork(false, mode);
    renderTraining(makeClient(mode));
    await screen.findByText(/your training isn’t on this device yet/i);

    // The network is back but nothing said so: no event, the property alone.
    network.up = true;
    await user.click(screen.getByRole('button', { name: /try again/i }));
    if (MODES[mode].managerFollows) {
      // A client that holds its reads back sends them when ITS manager says so.
      act(() => onlineManager.setOnline(true));
    }
    expect(await screen.findByText('Bloc 3, session 2 of 3')).toBeInTheDocument();
  });
});

describe('on a network', () => {
  it('an athlete without a program is told so — by a read that answered', async () => {
    db = fakePostgrest({
      students: [{ id: 'st-1' }],
      programs: [],
      session_confirmations: [],
      messages: [],
    });
    supabase.from.mockImplementation(db.from);
    renderTraining(makeClient('paused'));
    expect(await screen.findByText(/no program yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
  });

  // The account exists and its owner has not linked it to a coach yet: no row
  // in `students`. The server answers that with zero rows, which is an answer
  // too — and the one case in which "Try again" could never have worked.
  it('an athlete who is not linked to a coach yet is told there is no program, not that it failed', async () => {
    db = fakePostgrest({ students: [], session_confirmations: [], messages: [] });
    supabase.from.mockImplementation(db.from);
    const client = makeClient('paused');
    renderTraining(client);

    expect(await screen.findByText(/no program yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/couldn’t be loaded/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
    // No link to read a program through: none was asked for.
    expect(db.requestsTo('programs')).toEqual([]);
    // What the server said is kept like any other answer.
    expect(
      dehydrate(client, { shouldDehydrateQuery: shouldPersistQuery }).queries.map((q) => q.queryKey),
    ).toContainEqual(studentProgramDetailsKey('u-1'));
  });

  it('a read that fails says it could not be loaded, and loads on a tap', async () => {
    const user = userEvent.setup();
    network.up = false; // the request fails; the device says it is online
    renderTraining(makeClient('paused'));
    expect(await screen.findByText(/your training couldn’t be loaded/i)).toBeInTheDocument();
    expect(screen.queryByText(/no program yet/i)).toBeNull();

    network.up = true;
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('Bloc 3, session 2 of 3')).toBeInTheDocument();
  });
});

// Every client above keeps what it has read for ever (`gcTime: Infinity`), so
// none of them can say how long the app's own client does. And it matters for
// one read more than for any other: a session read ahead has no observer until
// it is opened, an entry without an observer leaves memory after the `gcTime`
// of its root, and what has left memory is written out of the device at the
// next save. With the default of five minutes, the session is gone before the
// athlete has reached the gym.
//
// The `gcTime` is not this page's to give — `sessionQueryOptions` and
// `setLogsQueryOptions` carry none on purpose, it is set per root in
// lib/queryClient.js. So the test below asks the app's client, after the
// page's own read-ahead, whether it keeps its stored roots for as long as the
// device stores them — it holds the two together.
describe('on the client of the app', () => {
  // How long the device keeps what it stores is `PERSIST_MAX_AGE_MS`: the
  // `maxAge` the cache is persisted with.
  afterEach(() => {
    appClient.clear();
  });

  it('the session read ahead stays in memory for as long as the device stores it', async () => {
    const view = renderTraining(appClient);
    await screen.findByText('Pull A');
    const READ_AHEAD = [
      ['session', 's-2'],
      ['set-logs', 's-2', ['sl-1', 'sl-2']],
    ];
    await waitFor(() => {
      for (const queryKey of READ_AHEAD) expect(appClient.getQueryData(queryKey)).toBeDefined();
    });
    // The athlete leaves the list: nothing observes either read any more.
    view.unmount();

    const kept = Object.fromEntries(
      READ_AHEAD.map((queryKey) => [
        queryKey[0],
        appClient.getQueryCache().find({ queryKey }).gcTime,
      ]),
    );
    expect(kept.session).toBeGreaterThanOrEqual(PERSIST_MAX_AGE_MS);
    expect(kept['set-logs']).toBeGreaterThanOrEqual(PERSIST_MAX_AGE_MS);
  });
});
