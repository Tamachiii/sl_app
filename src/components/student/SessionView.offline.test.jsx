// The session page with and without a network, end to end: the real reads, the
// real hook that completes a session's sets, a cache saved the way the app
// saves it and restored into the client of a launch in the gym — and the
// banner that counts what waits to be synced, rendered next to the page.
//
// SessionView.test.jsx stubs the hook layer and covers what the page does with
// each state of its reads. This file is the other half: what opening a session
// STARTS. The defects were there — a mutation fired at every opening, which
// without a network became "1 change waiting to sync" over a workout nobody
// had touched (L8), and which re-created sets from the device's copy of the
// session (P22) — and a stubbed hook starts nothing.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  QueryClient,
  QueryClientProvider,
  dehydrate,
  hydrate,
  onlineManager,
} from '@tanstack/react-query';

vi.mock('../../lib/supabase', () => ({
  supabase: {
    from: vi.fn(),
    rpc: vi.fn(),
    auth: { getSession: async () => ({ data: { session: { user: { id: 'u-1' } } }, error: null }) },
  },
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ sessionId: 's-2' }) };
});

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'u-1' }, profile: { full_name: 'Tony Me', role: 'student' } }),
}));

// Around the two reads the page is made of: left out, each with the answer of
// a session that has none of it.
vi.mock('../../hooks/useLastPerformance', () => ({ useLastPerformance: () => ({ data: {} }) }));
// The real isActiveExercise: the swap picker filters with it.
vi.mock('../../hooks/useExerciseLibrary', async () => {
  const actual = await vi.importActual('../../hooks/useExerciseLibrary');
  return { ...actual, useExerciseLibrary: () => ({ data: [], isLoading: false }) };
});
vi.mock('../../hooks/useSetVideo', () => ({
  useSetVideos: () => ({ data: [], isLoading: false }),
  useUploadSetVideo: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteSetVideo: () => ({ mutate: vi.fn(), isPending: false }),
  useSetVideoSignedUrl: () => ({ data: null, isLoading: false }),
}));
vi.mock('../../hooks/useMessages', () => ({
  useSessionFeedback: () => ({ data: null }),
  formatMessageStamp: () => 'stamp',
}));
vi.mock('../../hooks/useRestTimerEffects', () => ({ useRestTimerEffects: () => {} }));
vi.mock('../../hooks/useRestTimerPush', () => ({ useRestTimerPush: () => {} }));

import SessionView from './SessionView';
import OfflineBanner from '../ui/OfflineBanner';
import { sessionQueryOptions } from '../../hooks/useSession';
import { setLogsQueryOptions } from '../../hooks/useSetLogs';
import { shouldPersistQuery } from '../../lib/queryClient';
import { supabase } from '../../lib/supabase';
import { fakePostgrest } from '../../test/fakePostgrest';

// --- the database ---------------------------------------------------------------

const exercise = (id, sort_order, name, sets) => ({
  id,
  session_id: 's-2',
  sort_order,
  sets,
  reps: 8,
  weight_kg: 40,
  duration_seconds: null,
  rest_seconds: 120,
  exercise: { id: `ex-${id}`, name, type: 'push', difficulty: 1, volume_weight: 1 },
});

const setRow = (exercise_slot_id, set_number) => ({
  id: `${exercise_slot_id}-${set_number}`,
  exercise_slot_id,
  set_number,
  done: false,
  failed: false,
  skipped: false,
  rpe: null,
  target_reps: 8,
  target_weight_kg: 40,
  target_rest_seconds: 120,
});

// What the database holds: the exercises of the session, and their sets.
let server;

// What postgrest-js hands back when `fetch` itself failed.
const NO_ANSWER = { message: 'TypeError: Failed to fetch', details: '', hint: '', code: '' };

const network = { up: true };
let db;

// `ensure_set_logs`, as the database does it: on ITS exercises, every number
// from 1 to the number of sets that has no row.
function ensureSetLogs() {
  const added = [];
  for (const slot of server.slots) {
    for (let n = 1; n <= slot.sets; n++) {
      const there = server.rows.some((r) => r.exercise_slot_id === slot.id && r.set_number === n);
      if (!there) added.push(setRow(slot.id, n));
    }
  }
  server.rows.push(...added);
  return added.length;
}

function wire() {
  const answer = (rows) => () => (network.up ? rows() : { error: NO_ANSWER });
  db = fakePostgrest({
    sessions: answer(() => [
      {
        id: 's-2',
        title: 'Pull A',
        reviewed_at: null,
        archived_at: null,
        scheduled_date: null,
        weeks: { programs: { is_active: true } },
        exercise_slots: server.slots.map((s) => ({ ...s })),
      },
    ]),
    set_logs: answer(() => server.rows.map((r) => ({ ...r }))),
    slot_comments: answer(() => []),
    slot_deviations: answer(() => []),
    session_confirmations: answer(() => []),
  });
  supabase.from.mockImplementation(db.from);
  supabase.rpc.mockImplementation(async (name) => {
    if (!network.up) return { data: null, error: NO_ANSWER };
    if (name !== 'ensure_set_logs') throw new Error(`no such function in this test: ${name}`);
    return { data: ensureSetLogs(), error: null };
  });
}

// The two ways a launch without a network has looked to React Query — see
// StudentTraining.offline.test.jsx. The page has to be right in both.
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

function renderPage(client) {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <OfflineBanner />
        <SessionView />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// At home, on a network: the session and its sets are read ahead by the
// training list (`readAheadSession`), through the options of the page's hooks.
async function readAhead(client) {
  const session = await client.fetchQuery(sessionQueryOptions('s-2'));
  await client.prefetchQuery(setLogsQueryOptions('s-2', session.exercise_slots));
}

// What the app writes to IndexedDB and reads back at the next launch.
function saveAndRestore(from, into) {
  hydrate(into, JSON.parse(JSON.stringify(dehydrate(from, { shouldDehydrateQuery: shouldPersistQuery }))));
}

async function gymClientWith(mode) {
  const atHome = makeClient(mode);
  await readAhead(atHome);
  const gym = makeClient(mode);
  saveAndRestore(atHome, gym);
  return gym;
}

// Long enough for the effects of a mount, a mutation and the reads it starts.
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

const banner = () => screen.getByTestId('offline-banner');
const confirmButton = () => screen.queryByRole('button', { name: /^confirm session$/i });

beforeEach(() => {
  vi.clearAllMocks();
  network.up = true;
  onlineManager.setOnline(true);
  server = {
    slots: [exercise('sl-1', 0, 'Bench Press', 2), exercise('sl-2', 1, 'Weighted Dip', 2)],
    rows: [setRow('sl-1', 1), setRow('sl-1', 2), setRow('sl-2', 1), setRow('sl-2', 2)],
  };
  wire();
});

afterEach(() => {
  vi.restoreAllMocks();
  onlineManager.setOnline(true);
});

describe.each(Object.keys(MODES))('a session opened without a network (reads %s)', (mode) => {
  // L8. Nothing was entered: nothing waits.
  it('shows the session the device kept, and starts no write: nothing waits to be synced', async () => {
    const gym = await gymClientWith(mode);
    setNetwork(false, mode);
    renderPage(gym);

    expect(screen.getByText('Pull A')).toBeInTheDocument();
    expect(screen.getByText('Bench Press')).toBeInTheDocument();
    expect(screen.getByText('0 of 4 sets')).toBeInTheDocument();
    await settle();
    // The workout can be done and confirmed from here: the confirmation is a
    // write of the queue, and this session is the next one of the list.
    expect(confirmButton()).toBeInTheDocument();

    expect(gym.getMutationCache().getAll()).toEqual([]);
    expect(banner()).toHaveTextContent('Offline — your changes will sync when you reconnect.');
    expect(banner()).not.toHaveTextContent(/waiting to sync/i);
    // Nor would anything be stored with the queue for the next launch.
    expect(dehydrate(gym).mutations).toEqual([]);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  // The one case in which there IS something to ask: it is not asked without
  // a network either, and it is asked — of the database — when it returns.
  it('with a set missing on the device: still nothing is started offline, and the database is asked when the network returns', async () => {
    server.rows = server.rows.filter((r) => r.id !== 'sl-2-2');
    const gym = await gymClientWith(mode);
    setNetwork(false, mode);
    renderPage(gym);

    expect(screen.getByText('0 of 3 sets')).toBeInTheDocument();
    await settle();
    expect(gym.getMutationCache().getAll()).toEqual([]);
    expect(banner()).not.toHaveTextContent(/waiting to sync/i);
    expect(supabase.rpc).not.toHaveBeenCalled();

    setNetwork(true, mode);
    // The set is added there, and shown.
    expect(await screen.findByText('0 of 4 sets')).toBeInTheDocument();
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(supabase.rpc).toHaveBeenCalledWith('ensure_set_logs', { p_session_id: 's-2' });
    expect(server.rows.map((r) => r.id)).toContain('sl-2-2');
    await settle();
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(gym.isMutating()).toBe(0);
  });

  // N1. A session that was never opened on this device, and was not read
  // ahead: the page has nothing — and used to show a session without an
  // exercise, under the title "Session", with "Confirm session" live.
  it('a session that is not on the device: says so, offers no confirmation, and opens when the network returns', async () => {
    setNetwork(false, mode);
    const gym = makeClient(mode);
    renderPage(gym);

    expect(await screen.findByText(/this session isn’t on this device yet/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    expect(confirmButton()).toBeNull();
    expect(screen.queryByText(/of \d+ sets/i)).toBeNull();
    await settle();
    expect(screen.getByText(/this session isn’t on this device yet/i)).toBeInTheDocument();
    expect(confirmButton()).toBeNull();
    expect(gym.getMutationCache().getAll()).toEqual([]);

    // No tap: the return of the network is enough.
    setNetwork(true, mode);
    expect(await screen.findByText('Bench Press')).toBeInTheDocument();
    expect(screen.getByText('Pull A')).toBeInTheDocument();
    expect(screen.getByText('0 of 4 sets')).toBeInTheDocument();
    expect(confirmButton()).toBeInTheDocument();
    expect(screen.queryByText(/isn’t on this device/i)).toBeNull();
  });
});

describe('a session opened on a network', () => {
  // L8, the other half: every opening used to cost a second read of the sets
  // by the safety net, and a third to refresh them after it.
  it('with every set in place: one read of the session, one of its sets, and no write', async () => {
    const client = makeClient('paused');
    renderPage(client);

    expect(await screen.findByText('Bench Press')).toBeInTheDocument();
    expect(screen.getByText('0 of 4 sets')).toBeInTheDocument();
    await settle();

    expect(db.requestsTo('sessions')).toHaveLength(1);
    expect(db.requestsTo('set_logs')).toHaveLength(1);
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(client.getMutationCache().getAll()).toEqual([]);
  });

  it('with a set missing: the database adds it, once, and the page shows it', async () => {
    server.rows = server.rows.filter((r) => r.id !== 'sl-1-2');
    const client = makeClient('paused');
    renderPage(client);

    expect(await screen.findByText('0 of 4 sets')).toBeInTheDocument();
    await settle();

    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(supabase.rpc).toHaveBeenCalledWith('ensure_set_logs', { p_session_id: 's-2' });
    // The sets were read, found short, and read again after the answer.
    expect(db.requestsTo('set_logs')).toHaveLength(2);
    expect(db.requestsTo('sessions')).toHaveLength(1);
    expect(client.isMutating()).toBe(0);
  });

  // P22. The device read the session when "Bench Press" had three sets; the
  // coach has taken the third away since, and the sets were read again after
  // that. Counted on the device's copy of the session, a set is missing — and
  // the page used to insert it.
  it('a set the coach removed since the device read the session does not come back', async () => {
    const client = makeClient('paused');
    const before = { ...server, slots: [exercise('sl-1', 0, 'Bench Press', 3), server.slots[1]] };
    client.setQueryData(sessionQueryOptions('s-2').queryKey, {
      id: 's-2',
      title: 'Pull A',
      reviewed_at: null,
      archived_at: null,
      program_is_active: true,
      exercise_slots: before.slots,
    });
    client.setQueryData(
      setLogsQueryOptions('s-2', before.slots).queryKey,
      server.rows.map((r) => ({ ...r })),
    );
    renderPage(client);
    expect(screen.getByText('0 of 4 sets')).toBeInTheDocument();

    // The database is asked, by the id of the session; it is short of nothing.
    await waitFor(() => expect(supabase.rpc).toHaveBeenCalledTimes(1));
    expect(supabase.rpc).toHaveBeenCalledWith('ensure_set_logs', { p_session_id: 's-2' });
    await settle();

    expect(server.rows.map((r) => r.id)).toEqual(['sl-1-1', 'sl-1-2', 'sl-2-1', 'sl-2-2']);
    expect(screen.getByText('0 of 4 sets')).toBeInTheDocument();
    // The answer told the device that its copy was behind: it was read again,
    // and with the session as it is now there is nothing left to ask.
    expect(db.requestsTo('sessions')).toHaveLength(1);
    expect(client.getQueryData(['session', 's-2']).exercise_slots[0].sets).toBe(2);
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
  });
});
