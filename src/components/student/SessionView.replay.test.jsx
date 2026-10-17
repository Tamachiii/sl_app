// P56, end to end on the session page: sets logged without a network, then
// replayed.
//
// The page is the real one, on its real reads and writes and a client that
// carries the app's defaults for queued writes; only the database and the rest
// timer's two entry points are doubles (and the reads around what is tested,
// left out with the answer of a session that has none of them). What the
// athlete does offline is a few gestures — « Validate set n », a rating, a
// sheet closed. What the page then goes through when the network returns — a
// read that does not have the sets yet, then each write landing — is not a
// gesture, and must start no rest and open no RPE sheet.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';

vi.mock('../../lib/supabase', () => ({
  supabase: {
    from: vi.fn(),
    rpc: vi.fn(),
    auth: { getSession: async () => ({ data: { session: { user: { id: 'u-1' } } }, error: null }) },
  },
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ sessionId: 's-1' }) };
});

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'u-1' }, profile: { full_name: 'Tony Me', role: 'student' } }),
}));

vi.mock('../../hooks/useRestTimer', async () => {
  const actual = await vi.importActual('../../hooks/useRestTimer');
  return { ...actual, startRestTimer: vi.fn(), clearRestTimer: vi.fn() };
});

// Around what is tested: left out, each with the answer of a session that has
// none of it.
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

import SessionView from './SessionView';
import { supabase } from '../../lib/supabase';
import { startRestTimer, clearRestTimer } from '../../hooks/useRestTimer';
import { registerOfflineMutationDefaults } from '../../lib/offlineMutations';
import { getToasts, dismissToast } from '../../lib/toast';
import { fakePostgrest } from '../../test/fakePostgrest';

// --- the database ---------------------------------------------------------------

// The session's sets as the page keys them: ['set-logs', session, its exercises].
const KEY = ['set-logs', 's-1', ['sl-1']];

const slotWith = (sets) => ({
  id: 'sl-1',
  session_id: 's-1',
  sort_order: 0,
  sets,
  reps: 5,
  weight_kg: 100,
  duration_seconds: null,
  rest_seconds: 120,
  record_video_set_numbers: null,
  superset_group: null,
  notes: null,
  exercise: { id: 'ex-bench', name: 'Bench Press', type: 'push', difficulty: 1, volume_weight: 1 },
});

const pendingRow = (id, set_number) => ({
  id,
  exercise_slot_id: 'sl-1',
  set_number,
  is_student_added: false,
  target_reps: 5,
  target_weight_kg: 100,
  target_duration_seconds: null,
  target_rest_seconds: 120,
  done: false,
  failed: false,
  skipped: false,
  logged_at: null,
  failed_at: null,
  rpe: null,
  actual_reps: null,
  actual_weight_kg: null,
});

// What postgrest-js hands back when `fetch` itself failed.
const NO_ANSWER = { message: 'TypeError: Failed to fetch', details: '', hint: '', code: '' };

const network = { up: true };
let server;

// The tables behind the page. Reads go through `fakePostgrest`; an update of
// `set_logs` is taken at once and answered with the row, as the database does.
function wire(rows) {
  server = { rows: new Map(rows.map((r) => [r.id, { ...r }])), writes: [] };
  const read = (answer) => () => (network.up ? answer() : { error: NO_ANSWER });
  const db = fakePostgrest({
    sessions: read(() => [
      {
        id: 's-1',
        title: 'Push A',
        reviewed_at: null,
        archived_at: null,
        scheduled_date: null,
        weeks: { program_id: 'p-1', programs: { is_active: true, status: 'approved' } },
        exercise_slots: [slotWith(rows.length)],
      },
    ]),
    set_logs: read(() => [...server.rows.values()].map((r) => ({ ...r }))),
    slot_comments: read(() => []),
    slot_deviations: read(() => []),
    session_confirmations: read(() => []),
  });

  const setLogs = {
    update(patch) {
      const request = { patch };
      const chain = {
        eq: (_column, id) => {
          request.logId = id;
          return chain;
        },
        select: () => chain,
        single: async () => {
          if (!network.up) return { data: null, error: NO_ANSWER };
          const row = { ...server.rows.get(request.logId), ...request.patch };
          server.rows.set(request.logId, row);
          server.writes.push(request);
          return { data: { ...row }, error: null };
        },
      };
      return chain;
    },
  };

  supabase.from.mockImplementation((table) => (table === 'set_logs' ? { ...db.from(table), ...setLogs } : db.from(table)));
  supabase.rpc.mockImplementation(async (name) => ({ data: null, error: { message: `not in this test: ${name}` } }));
}

// --- the device -----------------------------------------------------------------

function setNetwork(up) {
  network.up = up;
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(up);
  act(() => {
    onlineManager.setOnline(up);
    window.dispatchEvent(new Event(up ? 'online' : 'offline'));
  });
}

// Every client a test made, emptied when the test ends.
const clients = [];

// The app's client, as far as this page goes: a read waits for a network
// instead of failing, and the queued writes carry the defaults of their keys.
function makeClient() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: 2 * 60 * 1000, networkMode: 'online' },
      mutations: { retry: false },
    },
  });
  registerOfflineMutationDefaults(client);
  clients.push(client);
  return client;
}

async function openPage(client) {
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SessionView />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(await screen.findByRole('heading', { level: 1, name: 'Push A' })).toBeInTheDocument();
}

const setList = () => screen.getByRole('list', { name: 'Sets' });
// The row of the n-th set, in set order: a button whose name starts with its
// title (« Set 1, done », « Set 2 »).
const row = (n) => within(within(setList()).getAllByRole('listitem')[n - 1]).getByRole('button');
const isDone = (n) => /^Set \d+, done/.test(row(n).textContent);
const openSheets = () => [...document.querySelectorAll('dialog')].filter((d) => d.open);
const rpeSheet = () => screen.queryByRole('heading', { level: 2, name: /^RPE of set/ });

// Long enough for a handler and the reads it could start.
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

beforeEach(() => {
  vi.clearAllMocks();
  network.up = true;
  onlineManager.setOnline(true);
  for (const toast of getToasts()) dismissToast(toast.id);
});

afterEach(() => {
  vi.restoreAllMocks();
  // The queues first, the network second: a write left parked would be sent
  // into the next test's database.
  while (clients.length) clients.pop().clear();
  onlineManager.setOnline(true);
});

describe('a workout logged offline and replayed', () => {
  it('starts one rest per set the athlete validated, and opens no RPE sheet again', async () => {
    const user = userEvent.setup();
    wire([pendingRow('a', 1), pendingRow('b', 2)]);
    const qc = makeClient();
    await openPage(qc);

    // In the gym, no network: set 1 validated and rated, set 2 validated and
    // its RPE sheet closed without a rating.
    setNetwork(false);
    await user.click(screen.getByRole('button', { name: 'Validate set 1' }));
    expect(rpeSheet()).toHaveTextContent('RPE of set 1');
    await waitFor(() => expect(isDone(1)).toBe(true));
    await user.click(screen.getByRole('button', { name: 'RPE 8' }));
    await waitFor(() => expect(row(1)).toHaveTextContent('RPE 8'));
    expect(openSheets()).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Validate set 2' }));
    expect(rpeSheet()).toHaveTextContent('RPE of set 2');
    await user.click(screen.getByRole('button', { name: 'Close without RPE' }));
    await waitFor(() => expect(isDone(2)).toBe(true));
    expect(openSheets()).toEqual([]);

    expect(startRestTimer.mock.calls).toEqual([
      ['a', 120],
      ['b', 120],
    ]);
    expect(server.writes).toHaveLength(0);
    // Validate 1, its rating, validate 2.
    expect(qc.isMutating()).toBe(3);
    // Every set dealt with: the page offers the confirmation.
    expect(screen.getByRole('button', { name: 'Confirm session' })).toBeInTheDocument();

    // The network returns. A read of the sets answers before the queue has
    // left: nothing of the workout is in it.
    const withoutTheWorkout = [...server.rows.values()].map((r) => ({ ...r }));
    act(() => {
      qc.setQueryData(KEY, withoutTheWorkout);
    });
    await waitFor(() => expect(isDone(1)).toBe(false));
    expect(isDone(2)).toBe(false);
    expect(screen.getByRole('button', { name: 'Validate set 1' })).toBeInTheDocument();

    // Then the three writes land, each putting its row back on screen.
    setNetwork(true);
    await act(() => qc.resumePausedMutations());
    await waitFor(() => expect(qc.isMutating()).toBe(0));
    await settle();

    expect(server.writes).toHaveLength(3);
    expect(server.rows.get('a')).toMatchObject({ done: true, rpe: 8 });
    expect(server.rows.get('b')).toMatchObject({ done: true, rpe: null });
    await waitFor(() => expect(isDone(1) && isDone(2)).toBe(true));
    expect(row(1)).toHaveTextContent('RPE 8');
    // Nothing of that was a gesture.
    expect(startRestTimer).toHaveBeenCalledTimes(2);
    expect(clearRestTimer).not.toHaveBeenCalled();
    expect(openSheets()).toEqual([]);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  // P27 — rating a set that was not validated is the set done: one write, not
  // a validation and a rating, and the database gets the set done, rated and
  // dated at the tap.
  it('a set rated in its sheet without being validated is one queued write, which lands done, rated and dated', async () => {
    const user = userEvent.setup();
    wire([pendingRow('a', 1)]);
    const qc = makeClient();
    await openPage(qc);

    setNetwork(false);
    await user.click(row(1));
    expect(screen.getByRole('heading', { level: 2, name: 'Set 1' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'RPE 8' }));

    // Done on screen at once, the sheet closed, and one write waiting.
    await waitFor(() => expect(isDone(1)).toBe(true));
    expect(row(1)).toHaveTextContent('RPE 8');
    expect(openSheets()).toEqual([]);
    expect(qc.isMutating()).toBe(1);
    expect(startRestTimer.mock.calls).toEqual([['a', 120]]);
    const tappedAt = qc.getMutationCache().getAll()[0].state.variables.at;
    expect(tappedAt).toEqual(expect.any(String));

    setNetwork(true);
    await act(() => qc.resumePausedMutations());
    await waitFor(() => expect(qc.isMutating()).toBe(0));
    await settle();

    expect(server.writes).toHaveLength(1);
    expect(server.rows.get('a')).toMatchObject({ done: true, failed: false, rpe: 8, logged_at: tappedAt });
    expect(startRestTimer).toHaveBeenCalledTimes(1);
    expect(openSheets()).toEqual([]);
  });
});

// P68 on the real hooks and cache: the Undo of a skip is four writes on one
// row's queue, and what the database holds at the end is the set as it was.
describe('a set skipped and taken back', () => {
  it('ends as it was in the database: done at its time, rated, with its actual reps', async () => {
    const user = userEvent.setup();
    wire([
      {
        ...pendingRow('a', 1),
        done: true,
        rpe: 8,
        logged_at: '2026-10-15T18:02:11.000Z',
        actual_reps: 4,
      },
    ]);
    const qc = makeClient();
    await openPage(qc);
    expect(row(1)).toHaveTextContent('Off plan, 4 reps, 100 kg');

    await user.click(row(1));
    await user.click(screen.getByRole('button', { name: 'Skip the set' }));
    await waitFor(() => expect(qc.isMutating()).toBe(0));
    expect(server.rows.get('a')).toMatchObject({ skipped: true, done: false, rpe: null, logged_at: null, actual_reps: null });
    await waitFor(() => expect(row(1)).toHaveAccessibleName(/^Set 1, skipped/));

    const [toast] = getToasts();
    expect(toast).toMatchObject({ message: 'parcSession.toastSkipped', action: { label: 'uiSharedHelpers.undo' } });
    act(() => toast.action.onClick());
    await waitFor(() => expect(qc.isMutating()).toBe(0));
    await settle();

    expect(server.rows.get('a')).toMatchObject({
      skipped: false,
      done: true,
      failed: false,
      rpe: 8,
      logged_at: '2026-10-15T18:02:11.000Z',
      actual_reps: 4,
      actual_weight_kg: null,
    });
    await waitFor(() => expect(row(1)).toHaveTextContent('RPE 8'));
    expect(row(1)).toHaveTextContent('Off plan, 4 reps, 100 kg');
    expect(startRestTimer).not.toHaveBeenCalled();
  });
});
