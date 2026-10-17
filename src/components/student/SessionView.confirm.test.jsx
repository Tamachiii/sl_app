// A workout confirmed in the gym, end to end: the session page and the
// training list on their real hooks, on a client that carries the app's
// defaults for queued writes, next to the banner that counts what waits.
//
// SessionView.test.jsx stubs the hook layer and covers what the page does with
// each state of a write; hooks/useSessionConfirmation.optimistic.test.jsx
// covers what a write puts into the cache. This file is what the athlete sees
// across the two pages — the defect was there (P25): a confirmation made
// without a network left its dialog on "Confirming…" with Cancel switched
// off, and the session that had just been finished as the "Next" one of the
// list, with its Start button.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
  useAuth: () => ({
    user: { id: 'u-1' },
    profile: { full_name: 'Tony Me', role: 'student' },
    signOut: vi.fn(),
  }),
}));

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
  useMyFeedbackSessionIds: () => ({ data: new Set() }),
  formatMessageStamp: () => 'stamp',
}));
vi.mock('../ui/UserMenu', () => ({ default: () => <div data-testid="user-menu" /> }));

import SessionView from './SessionView';
import StudentTraining from './StudentTraining';
import OfflineBanner from '../ui/OfflineBanner';
import { shouldPersistQuery } from '../../lib/queryClient';
import { registerOfflineMutationDefaults } from '../../lib/offlineMutations';
import { supabase } from '../../lib/supabase';
import { fakePostgrest } from '../../test/fakePostgrest';

// --- the database ---------------------------------------------------------------

const exercise = (id, sort_order, name) => ({
  id,
  session_id: 's-2',
  sort_order,
  sets: 2,
  reps: 8,
  weight_kg: 40,
  duration_seconds: null,
  rest_seconds: 120,
  record_video_set_numbers: null,
  exercise: { id: `ex-${id}`, name, type: 'push', difficulty: 1, volume_weight: 1 },
});

const SLOTS = [exercise('sl-1', 0, 'Bench Press'), exercise('sl-2', 1, 'Weighted Dip')];

// Midday, so that the day is the same one in every timezone a test runs in.
const TRAINED_AT = new Date();
TRAINED_AT.setHours(12, 0, 0, 0);
const pad = (n) => String(n).padStart(2, '0');
const TRAINED_ON = `${TRAINED_AT.getFullYear()}-${pad(TRAINED_AT.getMonth() + 1)}-${pad(TRAINED_AT.getDate())}`;

const setRow = (exercise_slot_id, set_number, fields = {}) => ({
  id: `${exercise_slot_id}-${set_number}`,
  exercise_slot_id,
  set_number,
  done: false,
  failed: false,
  skipped: false,
  rpe: null,
  logged_at: null,
  target_reps: 8,
  target_weight_kg: 40,
  target_rest_seconds: 120,
  ...fields,
});

// What PostgREST answers when the INSERT policy turns a confirmation down:
// the coach archived the session while the athlete was training.
const REFUSED = {
  code: '42501',
  details: null,
  hint: null,
  message: 'new row violates row-level security policy for table "session_confirmations"',
};
// What postgrest-js hands back when `fetch` itself failed.
const NO_ANSWER = { message: 'TypeError: Failed to fetch', details: '', hint: '', code: '' };

// What the database holds, and how it answers the next write.
let server;
const network = { up: true };
let db;

const eq = (request, column) =>
  request.filters.find(([op, col]) => op === 'eq' && col === column)?.[2];

/**
 * The tables behind the two pages. Reads go through `fakePostgrest`; the
 * writes of a confirmation, of its undo and of a note are answered here, by
 * the database's own rules:
 *
 *   - a confirmation is INSERT … ON CONFLICT (session_id) DO NOTHING, and
 *     `sync_session_performed_at` dates the session from it;
 *   - `server.refuse` is the error the next write is answered with;
 *   - `server.hold()` keeps the answers back until `server.release()`.
 */
function wire() {
  const read = (rows) => (request) => (network.up ? rows(request) : { error: NO_ANSWER });
  const sessionRow = (id, title, sort_order, exercise_slots = []) => ({
    id,
    title,
    day_number: null,
    sort_order,
    scheduled_date: null,
    archived_at: null,
    performed_at: server.performedAt[id] ?? null,
    exercise_slots,
  });

  db = fakePostgrest({
    students: read(() => [{ id: 'st-1' }]),
    programs: read((request) => {
      if (!eq(request, 'is_active')) return [];
      return [
        {
          id: 'p-1',
          name: 'Bloc 3',
          sort_order: 0,
          is_active: true,
          weeks: [
            {
              id: 'w-1',
              week_number: 1,
              label: null,
              sessions: [
                sessionRow('s-1', 'Push A', 0),
                sessionRow('s-2', 'Pull A', 1, SLOTS.map((s) => ({ ...s, set_logs: [] }))),
                sessionRow('s-3', 'Legs A', 2),
              ],
            },
          ],
        },
      ];
    }),
    sessions: read(() => [
      {
        id: 's-2',
        title: 'Pull A',
        reviewed_at: null,
        archived_at: null,
        scheduled_date: null,
        weeks: { programs: { is_active: true } },
        exercise_slots: SLOTS.map((s) => ({ ...s })),
      },
    ]),
    set_logs: read(() => server.rows.map((r) => ({ ...r }))),
    slot_deviations: read(() => []),
    slot_comments: read(() => [...server.notes.values()].map((r) => ({ ...r }))),
    session_confirmations: read((request) => {
      const sessionId = eq(request, 'session_id');
      const rows = [...server.confirmations.values()].map((r) => ({ ...r }));
      return sessionId ? rows.filter((r) => r.session_id === sessionId) : rows;
    }),
  });

  // Every write is answered the same way: not at all without a network, when
  // the test lets it through, and with a refusal when one is set.
  const answer = async (name, apply) => {
    if (!network.up) return { data: null, error: NO_ANSWER };
    await server.held;
    server.writes.push(name);
    if (server.refuse) {
      const error = server.refuse;
      server.refuse = null;
      return { data: null, error };
    }
    return apply();
  };

  const writes = {
    session_confirmations: {
      upsert(payload) {
        const chain = {
          select: () => chain,
          maybeSingle: () =>
            answer('confirm', () => {
              const id = payload.session_id;
              if (server.confirmations.has(id)) return { data: null, error: null };
              const row = { id: `c-${id}`, confirmed_at: new Date().toISOString(), ...payload };
              server.confirmations.set(id, row);
              server.performedAt[id] = payload.performed_on
                ? `${payload.performed_on}T00:00:00+00:00`
                : row.confirmed_at;
              return { data: { ...row }, error: null };
            }),
        };
        return chain;
      },
      delete: () => ({
        eq: (_column, id) =>
          answer('undo', () => {
            server.confirmations.delete(id);
            delete server.performedAt[id];
            return { data: null, error: null };
          }),
      }),
    },
    slot_comments: {
      upsert(payload) {
        const chain = {
          select: () => chain,
          single: () =>
            answer('note', () => {
              const row = { id: `sc-${payload.exercise_slot_id}`, ...payload };
              server.notes.set(payload.exercise_slot_id, row);
              return { data: { ...row }, error: null };
            }),
        };
        return chain;
      },
      delete: () => ({
        eq: (_column, slotId) =>
          answer('note', () => {
            server.notes.delete(slotId);
            return { data: null, error: null };
          }),
      }),
    },
  };

  supabase.from.mockImplementation((table) => ({ ...db.from(table), ...writes[table] }));
  supabase.rpc.mockImplementation(async (name) => {
    throw new Error(`no function is called in this test: ${name}`);
  });
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

// Every client a test made, emptied when the test ends — see `afterEach`.
const clients = [];

// The app's client, as far as these pages go: a read waits for a network
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

const under = (client, page) => (
  <QueryClientProvider client={client}>
    <MemoryRouter>
      <OfflineBanner />
      {page}
    </MemoryRouter>
  </QueryClientProvider>
);
const renderSession = (client) => render(under(client, <SessionView />));
const renderList = (client) => render(under(client, <StudentTraining />));

// At home, on a network: the list, which reads the next session ahead.
async function atHome() {
  const client = makeClient();
  const view = renderList(client);
  expect(await screen.findByText('Bloc 3, session 2 of 3')).toBeInTheDocument();
  await waitFor(() => expect(db.requestsTo('set_logs')).toHaveLength(1));
  view.unmount();
  return client;
}

// What the app writes to IndexedDB and reads back at the next launch: the
// reads it keeps, and the writes that have not left.
function relaunch(from) {
  const next = makeClient();
  hydrate(next, JSON.parse(JSON.stringify(dehydrate(from, { shouldDehydrateQuery: shouldPersistQuery }))));
  return next;
}

// Long enough for a handler and the reads it could start.
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

const banner = () => screen.getByTestId('offline-banner');
// "Confirm session" is a text button in the page while sets are still to do,
// and the ActionBar's main button once every set is dealt with: one of the
// two, never both — so one button by that name.
const confirmCta = () => screen.queryByRole('button', { name: 'Confirm session' });
// The sheet that confirms, and its field. A closed sheet is not shown: both
// are null once it has closed.
const confirmSheet = () => screen.queryByRole('dialog', { name: 'Confirm the session' });
const notesField = () => {
  const sheet = confirmSheet();
  return sheet ? within(sheet).queryByRole('textbox', { name: 'Note for your coach' }) : null;
};
const confirmedCard = () => screen.queryByText('Session confirmed')?.closest('section') ?? null;
const waitingLine = () => screen.queryByText(/saved on this device/i);
// The facts under the title: « 2 exercises, 2 of 4 sets done ».
const facts = () => screen.queryByText(/sets done$/);

async function confirmWith(user, note) {
  await user.click(confirmCta());
  if (note) await user.type(notesField(), note);
  await user.click(within(confirmSheet()).getByRole('button', { name: 'Confirm' }));
}

// "Undo confirmation" on the page asks first, in a sheet; its answer undoes.
async function undoConfirmation(user) {
  await user.click(screen.getByRole('button', { name: 'Undo confirmation' }));
  const sheet = screen.getByRole('dialog', { name: 'Undo the confirmation?' });
  await user.click(within(sheet).getByRole('button', { name: 'Undo confirmation' }));
}

// The list after the confirmation of "Pull A": the block has moved on.
async function expectListMovedOn(user) {
  expect(screen.getByText('Bloc 3, session 3 of 3')).toBeInTheDocument();
  // The next session: the panel that holds « Start the session ».
  const next = screen.getByRole('link', { name: 'Start the session' }).closest('section');
  expect(within(next).getByRole('heading', { name: 'Legs A' })).toBeInTheDocument();
  expect(within(next).queryByText('Pull A')).toBeNull();

  // The row of finished sessions holds it, first — it is the one trained
  // last — and with its day.
  const history = screen.getByRole('region', { name: 'History' });
  const drawer = within(history).getByRole('button', { name: /sessions? done/ });
  expect(drawer).toHaveAccessibleName(/^2 sessions done,/);
  await user.click(drawer);
  const titles = within(history)
    .getAllByText(/^(Pull A|Push A)$/)
    .map((el) => el.textContent);
  expect(titles).toEqual(['Pull A', 'Push A']);
  // "Pull A, Tue, Oct 13": without its day the row says its title alone, and
  // sinks below the sessions that have one.
  expect(within(history).getByRole('link', { name: /^Pull A/ })).toHaveAccessibleName(
    /^Pull A, [A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}$/,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  network.up = true;
  onlineManager.setOnline(true);
  server = {
    // Two sets of four ticked, the first of them at midday.
    rows: [
      setRow('sl-1', 1, { done: true, logged_at: TRAINED_AT.toISOString() }),
      setRow('sl-1', 2, { done: true, logged_at: new Date(TRAINED_AT.getTime() + 180000).toISOString() }),
      setRow('sl-2', 1),
      setRow('sl-2', 2),
    ],
    confirmations: new Map([
      ['s-1', { id: 'c-1', session_id: 's-1', student_id: 'u-1', notes: null, performed_on: '2020-01-10' }],
    ]),
    performedAt: { 's-1': '2020-01-10T00:00:00+00:00' },
    notes: new Map(),
    writes: [],
    refuse: null,
    held: Promise.resolve(),
    hold() {
      this.held = new Promise((resolve) => {
        this.release = resolve;
      });
    },
  };
  wire();
});

afterEach(() => {
  vi.restoreAllMocks();
  // The queues first, the network second. A test can end with a write parked
  // on its client — the first one does, a confirmation made in the gym — and
  // the page is still mounted here: putting the manager back online would send
  // that write. It gets no answer, and where the defaults of its key send such
  // a write again (one, two and four seconds later) the copy arrives while
  // another test runs, in that test's `server`: it took the refusal that test
  // had set for its own confirmation.
  while (clients.length) clients.pop().clear();
  onlineManager.setOnline(true);
});

describe('a session confirmed without a network', () => {
  it('the sheet closes at the tap, the page says the confirmation is kept on the device, and the list has moved on', async () => {
    const user = userEvent.setup();
    const gym = await atHome();
    setNetwork(false);
    const page = renderSession(gym);
    expect(facts()).toHaveTextContent('2 exercises, 2 of 4 sets done');

    await user.click(confirmCta());
    expect(within(confirmSheet()).getByText('2 of 4 sets logged')).toBeInTheDocument();
    await user.type(notesField(), 'felt strong');
    await user.click(within(confirmSheet()).getByRole('button', { name: 'Confirm' }));

    // No "Confirming…", no sheet: the page behind it.
    expect(confirmSheet()).toBeNull();
    await waitFor(() => expect(confirmedCard()).not.toBeNull());
    expect(within(confirmedCard()).getByText('felt strong')).toBeInTheDocument();
    expect(waitingLine()).toHaveAttribute('role', 'status');
    expect(confirmCta()).toBeNull();
    expect(screen.queryByText(/confirming…/i)).toBeNull();
    expect(banner()).toHaveTextContent('Offline · 1 change waiting to sync');
    // Nothing has left the device.
    expect(server.writes).toEqual([]);
    expect(server.confirmations.has('s-2')).toBe(false);

    // Back to the list, still without a network.
    page.unmount();
    renderList(gym);
    await expectListMovedOn(user);
  });

  // The usual end of a workout: the app is closed, and opened again at home
  // before — or as — the network comes back.
  it('after the app was closed and opened again, the list and the page still say so, and the confirmation leaves when the network returns', async () => {
    const user = userEvent.setup();
    const gym = await atHome();
    setNetwork(false);
    const page = renderSession(gym);
    await confirmWith(user, 'felt strong');
    await waitFor(() => expect(confirmedCard()).not.toBeNull());
    page.unmount();

    const relaunched = relaunch(gym);
    const list = renderList(relaunched);
    await expectListMovedOn(user);
    expect(banner()).toHaveTextContent('Offline · 1 change waiting to sync');
    list.unmount();

    renderSession(relaunched);
    expect(confirmedCard()).not.toBeNull();
    expect(waitingLine()).toBeInTheDocument();
    expect(confirmCta()).toBeNull();

    // The network returns. No hook of this launch made the write: it is the
    // one the device kept, sent with the note and the day of the workout.
    setNetwork(true);
    await waitFor(() => expect(server.confirmations.has('s-2')).toBe(true));
    expect(server.confirmations.get('s-2')).toMatchObject({
      student_id: 'u-1',
      notes: 'felt strong',
      performed_on: TRAINED_ON,
    });
    await waitFor(() => expect(waitingLine()).toBeNull());
    await settle();
    expect(confirmedCard()).not.toBeNull();
    expect(within(confirmedCard()).getByText('felt strong')).toBeInTheDocument();
    expect(server.writes).toEqual(['confirm']);
  });

  // Keyed on `isPending`, which a parked write is for as long as the device
  // has no network, "Confirm session" stayed switched off and on
  // "Confirming…" after a confirmation that was taken back.
  it('confirmed, taken back and confirmed again: each step is offered and shown, and the three writes leave in order', async () => {
    const user = userEvent.setup();
    const gym = await atHome();
    setNetwork(false);
    renderSession(gym);
    await confirmWith(user, 'first');
    await waitFor(() => expect(confirmedCard()).not.toBeNull());

    await undoConfirmation(user);

    await waitFor(() => expect(confirmCta()).not.toBeNull());
    expect(confirmCta()).toBeEnabled();
    expect(confirmedCard()).toBeNull();
    expect(screen.queryByText(/confirming…/i)).toBeNull();
    expect(waitingLine()).toBeNull();
    expect(banner()).toHaveTextContent('Offline · 2 changes waiting to sync');

    // The note of the confirmation that has not been sent is still in the
    // field: it is written over.
    await user.click(confirmCta());
    expect(notesField()).toHaveValue('first');
    await user.clear(notesField());
    await user.type(notesField(), 'second');
    await user.click(within(confirmSheet()).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(confirmedCard()).not.toBeNull());
    expect(within(confirmedCard()).getByText('second')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo confirmation' })).toBeEnabled();
    expect(banner()).toHaveTextContent('Offline · 3 changes waiting to sync');

    setNetwork(true);
    await waitFor(() => expect(server.writes).toEqual(['confirm', 'undo', 'confirm']));
    await waitFor(() => expect(server.confirmations.get('s-2')).toMatchObject({ notes: 'second' }));
    await waitFor(() => expect(waitingLine()).toBeNull());
    await settle();
    expect(within(confirmedCard()).getByText('second')).toBeInTheDocument();
  });

  // The answer to a confirmation empties the field of its note. It can come
  // hours after the tap, and find the sheet open again.
  it('confirmed and taken back: the note being written when the network returns stays in its field', async () => {
    const user = userEvent.setup();
    const gym = await atHome();
    setNetwork(false);
    renderSession(gym);
    await confirmWith(user, 'first');
    await waitFor(() => expect(confirmedCard()).not.toBeNull());
    await undoConfirmation(user);
    await waitFor(() => expect(confirmCta()).not.toBeNull());

    await user.click(confirmCta());
    await user.type(notesField(), ', then a back-off set');

    setNetwork(true);
    await waitFor(() => expect(server.writes).toEqual(['confirm', 'undo']));
    await settle();
    expect(notesField()).toHaveValue('first, then a back-off set');
    expect(server.confirmations.has('s-2')).toBe(false);
  });
});

describe('a session confirmed on a network that is slow to answer', () => {
  it('the sheet closes at the tap and the page shows the session as confirmed, without "kept on this device"', async () => {
    const user = userEvent.setup();
    const client = makeClient();
    renderSession(client);
    await waitFor(() => expect(facts()).toHaveTextContent('2 of 4 sets done'));
    await settle();
    server.hold();

    await confirmWith(user, 'felt strong');

    expect(confirmSheet()).toBeNull();
    await waitFor(() => expect(confirmedCard()).not.toBeNull());
    // Being sent is not waiting for a network.
    expect(waitingLine()).toBeNull();
    expect(server.confirmations.has('s-2')).toBe(false);

    await act(async () => server.release());
    await waitFor(() => expect(server.confirmations.has('s-2')).toBe(true));
    await settle();
    expect(confirmedCard()).not.toBeNull();
    expect(within(confirmedCard()).getByText('felt strong')).toBeInTheDocument();

    // The note left the field with the answer.
    expect(server.confirmations.get('s-2')).toMatchObject({ notes: 'felt strong', performed_on: TRAINED_ON });
  });

  it('a refusal brings "Confirm session" back, and the sheet opens on the note that was written', async () => {
    const user = userEvent.setup();
    const client = makeClient();
    renderSession(client);
    await waitFor(() => expect(facts()).toHaveTextContent('2 of 4 sets done'));
    await settle();
    server.hold();
    server.refuse = REFUSED;

    await confirmWith(user, 'felt strong');
    await waitFor(() => expect(confirmedCard()).not.toBeNull());
    await act(async () => server.release());

    await waitFor(() => expect(confirmCta()).not.toBeNull());
    expect(confirmedCard()).toBeNull();
    expect(server.confirmations.has('s-2')).toBe(false);
    await waitFor(() => expect(confirmCta()).toBeEnabled());

    await user.click(confirmCta());
    expect(notesField()).toHaveValue('felt strong');
  });
});

describe('a note written without a network', () => {
  it('is on its exercise at once, its field closed, and is sent when the network returns', async () => {
    const user = userEvent.setup();
    const gym = await atHome();
    setNetwork(false);
    renderSession(gym);

    // The screen opens on the first exercise with a set to do; the note is
    // for the one before it, whose two sets are ticked and not rated yet —
    // picked by its chip.
    expect(screen.getByRole('heading', { level: 2, name: 'Weighted Dip' })).toBeInTheDocument();
    const chips = screen.getByRole('navigation', { name: 'Exercises of the session' });
    await user.click(within(chips).getByRole('button', { name: 'Bench Press' }));
    expect(screen.getByRole('heading', { level: 2, name: 'Bench Press' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add a note for the coach' }));
    await user.type(screen.getByRole('textbox', { name: 'Note for your coach' }), 'left elbow');
    await user.tab();

    const note = () => screen.queryByRole('region', { name: 'Your note for the coach' });
    expect(screen.queryByRole('textbox', { name: 'Note for your coach' })).toBeNull();
    expect(await screen.findByRole('region', { name: 'Your note for the coach' })).toHaveTextContent('left elbow');
    expect(within(note()).getByRole('button', { name: 'Edit the note' })).toBeInTheDocument();
    expect(banner()).toHaveTextContent('Offline · 1 change waiting to sync');
    expect(server.notes.size).toBe(0);

    setNetwork(true);
    await waitFor(() => expect(server.notes.get('sl-1')).toMatchObject({ body: 'left elbow', student_id: 'u-1' }));
    await settle();
    expect(note()).toHaveTextContent('left elbow');
  });
});
