// What the session page tells the sheet of each set about its exercise:
// whether it was swapped, what the fields open with, and its unit — and what
// « Validate set n » does on a set that cannot be validated as it is. The old
// exercise card worked these out for its rows; the page does now
// (sessionModel `editorSeeds`, `isDurationBased`, `deviationOf`), and hands
// them to the set's `useSetActions` when its sheet opens.
//
// The page is the real one, on its real reads and writes; only the database is
// a double, and the reads around what is tested — "last time" and the exercise
// library, which each test sets — are stand-ins.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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

// Set by each test: the athlete's last time on each exercise, and the library.
let mockLastPerformance = {};
let mockLibrary = [];
vi.mock('../../hooks/useLastPerformance', () => ({
  useLastPerformance: () => ({ data: mockLastPerformance, isPending: false, fetchStatus: 'idle' }),
}));
vi.mock('../../hooks/useExerciseLibrary', async () => {
  const actual = await vi.importActual('../../hooks/useExerciseLibrary');
  return { ...actual, useExerciseLibrary: () => ({ data: mockLibrary, isLoading: false }) };
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
import { registerOfflineMutationDefaults } from '../../lib/offlineMutations';
import { getToasts, dismissToast } from '../../lib/toast';
import { fakePostgrest } from '../../test/fakePostgrest';

// --- the database ---------------------------------------------------------------

const BENCH = { id: 'ex-bench', name: 'Bench Press', type: 'push', load_mode: 'added', archived_at: null };
const DIPS = { id: 'ex-dips', name: 'Weighted Dip', type: 'push', load_mode: 'full', archived_at: null };

// Prescribed 8 × 100 kg on the bench press.
const prescribed = (n, extra = {}) => ({
  id: `log-${n}`,
  exercise_slot_id: 'sl-1',
  set_number: n,
  is_student_added: false,
  target_reps: 8,
  target_weight_kg: 100,
  target_duration_seconds: null,
  target_rest_seconds: null,
  done: false,
  failed: false,
  skipped: false,
  logged_at: null,
  failed_at: null,
  rpe: null,
  actual_reps: null,
  actual_weight_kg: null,
  ...extra,
});

// An extra set: no target of its own.
const extraSet = (n, values = {}) =>
  prescribed(n, { is_student_added: true, target_reps: null, target_weight_kg: null, ...values });

const SWAP = { id: 'dev-1', exercise_slot_id: 'sl-1', kind: 'swap', substitute_exercise_id: DIPS.id, promote_requested_at: null };

let server;

// The tables behind the page. Reads go through `fakePostgrest`; an update of
// `set_logs` is taken at once and answered with the row.
function wire({ rows, deviations = [], durationSeconds = null }) {
  server = { rows: new Map(rows.map((r) => [r.id, { ...r }])), writes: [] };
  const slot = {
    id: 'sl-1',
    session_id: 's-1',
    sort_order: 0,
    // The prescribed sets: an extra set is not one, and `ensure_set_logs`
    // counts these.
    sets: rows.filter((r) => !r.is_student_added).length,
    reps: durationSeconds ? null : 8,
    weight_kg: 100,
    duration_seconds: durationSeconds,
    rest_seconds: null,
    record_video_set_numbers: null,
    superset_group: null,
    notes: null,
    exercise: BENCH,
  };
  const db = fakePostgrest({
    sessions: [
      {
        id: 's-1',
        title: 'Push A',
        reviewed_at: null,
        archived_at: null,
        scheduled_date: null,
        weeks: { program_id: 'p-1', programs: { is_active: true, status: 'approved' } },
        exercise_slots: [slot],
      },
    ],
    set_logs: () => [...server.rows.values()].map((r) => ({ ...r })),
    slot_comments: [],
    slot_deviations: deviations,
    session_confirmations: [],
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

const clients = [];

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

async function openPage() {
  const client = makeClient();
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SessionView />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(await screen.findByRole('heading', { level: 1, name: 'Push A' })).toBeInTheDocument();
  return client;
}

const setList = () => screen.getByRole('list', { name: 'Sets' });
const row = (n) => within(within(setList()).getAllByRole('listitem')[n - 1]).getByRole('button');
// The sheet that is open, if any.
const openSheet = () => {
  const open = [...document.querySelectorAll('dialog')].filter((d) => d.open);
  expect(open).toHaveLength(1);
  return within(open[0]);
};
const noSheetOpen = () => [...document.querySelectorAll('dialog')].every((d) => !d.open);
const fieldsOf = (sheet) => ({
  reps: sheet.queryByRole('textbox', { name: 'Reps' })?.value ?? null,
  load: sheet.queryByRole('textbox', { name: 'Load in kg' })?.value ?? null,
});

async function openSetSheet(user, n) {
  await user.click(row(n));
  return openSheet();
}

async function closeSheet(user) {
  await user.click(openSheet().getByRole('button', { name: 'Close' }));
  expect(noSheetOpen()).toBe(true);
}

beforeEach(() => {
  vi.clearAllMocks();
  onlineManager.setOnline(true);
  mockLastPerformance = {};
  mockLibrary = [BENCH, DIPS];
  for (const toast of getToasts()) dismissToast(toast.id);
});

afterEach(() => {
  while (clients.length) clients.pop().clear();
  onlineManager.setOnline(true);
});

// P59. On a swapped exercise the rows' targets are the ORIGINAL exercise's.
describe('a swapped exercise', () => {
  it("each set's sheet opens on the substitute's last performance, set by set", async () => {
    const user = userEvent.setup();
    wire({ rows: [prescribed(1), prescribed(2), prescribed(3)], deviations: [SWAP] });
    mockLastPerformance = {
      [DIPS.id]: { performedAt: '2026-10-08T18:00:00Z', sets: [{ weight: 20, reps: 10 }, { weight: 22.5, reps: 8 }] },
      // The original exercise's own history is not the substitute's.
      [BENCH.id]: { performedAt: null, sets: [{ weight: 100, reps: 8 }] },
    };
    await openPage();
    expect(screen.getByRole('heading', { level: 2, name: 'Weighted Dip' })).toBeInTheDocument();

    expect(fieldsOf(await openSetSheet(user, 1))).toEqual({ reps: '10', load: '20' });
    await closeSheet(user);
    expect(fieldsOf(await openSetSheet(user, 2))).toEqual({ reps: '8', load: '22.5' });
    await closeSheet(user);
    // Beyond the sets of last time: the last of them.
    expect(fieldsOf(await openSetSheet(user, 3))).toEqual({ reps: '8', load: '22.5' });
  });

  it('validating stores both values even when they equal the original targets, then asks the RPE', async () => {
    const user = userEvent.setup();
    wire({ rows: [prescribed(1)], deviations: [SWAP] });
    mockLastPerformance = { [DIPS.id]: { performedAt: null, sets: [{ weight: 100, reps: 8 }] } };
    await openPage();

    const sheet = await openSetSheet(user, 1);
    await user.click(sheet.getByRole('button', { name: 'Validate set 1' }));

    await waitFor(() => expect(server.writes).toHaveLength(1));
    expect(server.rows.get('log-1')).toMatchObject({ done: true, actual_reps: 8, actual_weight_kg: 100 });
    expect(openSheet().getByRole('heading', { level: 2, name: 'RPE of set 1' })).toBeInTheDocument();
  });

  it('done for the first time: the first set from the prescribed reps, the next from what was logged before it', async () => {
    const user = userEvent.setup();
    wire({
      rows: [prescribed(1, { done: true, rpe: 8, actual_reps: 12, actual_weight_kg: 0 }), prescribed(2)],
      deviations: [SWAP],
    });
    await openPage();

    // What the set holds comes before any seed.
    expect(fieldsOf(await openSetSheet(user, 1))).toEqual({ reps: '12', load: '0' });
    await closeSheet(user);
    expect(fieldsOf(await openSetSheet(user, 2))).toEqual({ reps: '12', load: '0' });
  });
});

describe('the exercise as the coach wrote it', () => {
  it("opens on the set's targets, not on last time, and keeps storing a value equal to them as null", async () => {
    const user = userEvent.setup();
    wire({ rows: [prescribed(1, { done: true, rpe: 8 })] });
    mockLastPerformance = { [BENCH.id]: { performedAt: null, sets: [{ weight: 90, reps: 10 }] } };
    await openPage();

    const sheet = await openSetSheet(user, 1);
    expect(fieldsOf(sheet)).toEqual({ reps: '8', load: '100' });
    await user.click(sheet.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(server.writes).toHaveLength(1));
    expect(server.writes[0].patch).toEqual({ actual_reps: null, actual_weight_kg: null });
  });
});

// P61. An extra set has no targets: its sheet opens on the set before it, as
// that set was done, and the exercise's unit says whether it has reps. It
// says what was done before it can be done: « Validate set n » opens its sheet.
describe('an extra set', () => {
  it('« Validate set n » opens its sheet instead of validating it, on the set before it', async () => {
    const user = userEvent.setup();
    wire({
      rows: [
        prescribed(1, { done: true, rpe: 8 }),
        prescribed(2, { done: true, rpe: 8, actual_reps: 6, actual_weight_kg: 95 }),
        extraSet(3),
        extraSet(4),
      ],
    });
    await openPage();

    await user.click(screen.getByRole('button', { name: 'Validate set 3' }));

    expect(server.writes).toEqual([]);
    const sheet = openSheet();
    expect(sheet.getByRole('heading', { level: 2, name: 'Set 3, added' })).toBeInTheDocument();
    // Its actual values, since set 2 was not done as written.
    expect(fieldsOf(sheet)).toEqual({ reps: '6', load: '95' });
    await closeSheet(user);

    // An extra after an extra carries them on.
    expect(fieldsOf(await openSetSheet(user, 4))).toEqual({ reps: '6', load: '95' });
  });

  it("after a set done as written it opens on that set's targets, and its Validate writes the values and the set done, then asks the RPE", async () => {
    const user = userEvent.setup();
    wire({ rows: [prescribed(1, { done: true, rpe: 8 }), extraSet(2)] });
    await openPage();

    await user.click(screen.getByRole('button', { name: 'Validate set 2' }));
    const sheet = openSheet();
    expect(fieldsOf(sheet)).toEqual({ reps: '8', load: '100' });
    await user.click(sheet.getByRole('button', { name: 'Validate set 2' }));

    await waitFor(() => expect(server.writes).toHaveLength(1));
    expect(server.rows.get('log-2')).toMatchObject({ done: true, actual_reps: 8, actual_weight_kg: 100 });
    expect(openSheet().getByRole('heading', { level: 2, name: 'RPE of set 2' })).toBeInTheDocument();
  });

  it('after a bodyweight set, the load it opens on is 0 — none added — and it is validated as it is', async () => {
    const user = userEvent.setup();
    wire({ rows: [prescribed(1, { done: true, rpe: 8, target_reps: 12, target_weight_kg: null }), extraSet(2)] });
    await openPage();

    await user.click(screen.getByRole('button', { name: 'Validate set 2' }));
    const sheet = openSheet();
    expect(fieldsOf(sheet)).toEqual({ reps: '12', load: '0' });
    await user.click(sheet.getByRole('button', { name: 'Validate set 2' }));

    await waitFor(() => expect(server.writes).toHaveLength(1));
    expect(server.rows.get('log-2')).toMatchObject({ done: true, actual_reps: 12, actual_weight_kg: 0 });
  });

  it('on an exercise measured in seconds, it has no reps to give', async () => {
    const user = userEvent.setup();
    wire({
      rows: [
        prescribed(1, { done: true, rpe: 8, target_reps: null, target_duration_seconds: 45, target_weight_kg: 10 }),
        extraSet(2),
      ],
      durationSeconds: 45,
    });
    await openPage();

    await user.click(screen.getByRole('button', { name: 'Validate set 2' }));
    const sheet = openSheet();
    expect(fieldsOf(sheet)).toEqual({ reps: null, load: '10' });
    await user.click(sheet.getByRole('button', { name: 'Validate set 2' }));

    await waitFor(() => expect(server.writes).toHaveLength(1));
    expect(server.rows.get('log-2')).toMatchObject({ done: true, actual_reps: null, actual_weight_kg: 10 });
  });
});
