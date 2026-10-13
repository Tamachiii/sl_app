// P25 — a confirmation made without a network did not show where it matters.
// The hook wrote the session's own confirmation into the cache and nothing
// else: the training list, which reads "which sessions are done" from another
// entry, kept the session that had just been finished as the "Next" one, with
// its Start button, until the confirmation reached the database.
//
// A confirmation is usually still waiting when the athlete looks at the list,
// so the requests below stay open until the test answers them — or are not
// sent at all, without a network.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import {
  QueryClient,
  QueryClientProvider,
  dehydrate,
  hydrate,
  onlineManager,
} from '@tanstack/react-query';

// `auth.getSession` because some blocks below build the app's client (the
// offline mutation defaults are registered on it): on that client a queued
// write is not sent until a session can be read.
vi.mock('../lib/supabase', () => ({
  supabase: {
    from: vi.fn(),
    auth: { getSession: async () => ({ data: { session: { user: { id: 'u-1' } } }, error: null }) },
  },
}));
vi.mock('./useAuth', () => ({ useAuth: () => ({ user: { id: 'u-1' } }) }));

import {
  useSessionConfirmation,
  useMyConfirmedSessionIds,
  useConfirmSession,
  useUnconfirmSession,
  useConfirmationWaiting,
} from './useSessionConfirmation';
import { studentProgramDetailsKey, studentPastProgramKey } from './useStudentProgramDetails';
import { supabase } from '../lib/supabase';
import { MUTATION_KEYS, registerOfflineMutationDefaults } from '../lib/offlineMutations';

const IDS_KEY = ['my-confirmed-session-ids', 'u-1'];
const LIST_KEY = studentProgramDetailsKey('u-1');
const rowKey = (sessionId) => ['session-confirmation', sessionId];

// What PostgREST answers when the INSERT policy turns a confirmation down:
// the session was archived, or its block is no longer the one being trained.
const REFUSED = {
  code: '42501',
  details: null,
  hint: null,
  message: 'new row violates row-level security policy for table "session_confirmations"',
};

const FIRST = {
  id: 'c-1',
  session_id: 's-1',
  student_id: 'u-1',
  notes: null,
  performed_on: '2026-10-10',
  confirmed_at: '2026-10-10T18:00:00+00:00',
};

const session = (id, title, sort_order, performed_at = null) => ({
  id,
  title,
  sort_order,
  day_number: null,
  scheduled_date: null,
  archived_at: null,
  performed_at,
  exercise_slots: [],
});

// The training list as the device holds it: one session done, two to go.
const BLOCK = {
  weeks: [
    {
      id: 'w-1',
      week_number: 1,
      label: null,
      program: { id: 'p-1', name: 'Bloc 3', sort_order: 0, is_active: true },
      sessions: [
        session('s-1', 'Push A', 0, '2026-10-10T00:00:00+00:00'),
        session('s-2', 'Pull A', 1),
        session('s-3', 'Legs A', 2),
      ],
    },
  ],
  pastPrograms: [],
};

/**
 * A `session_confirmations` table whose writes stay open until the test
 * answers them: `requests[n].land()` — the database takes the write — or
 * `requests[n].refuse()`. The two reads of the athlete's device (one
 * confirmation; the list of confirmed sessions) are answered at once, from
 * what the table holds at that moment, and counted.
 */
function fakeConfirmations(rows = [FIRST]) {
  const server = new Map(rows.map((r) => [r.session_id, { ...r }]));
  const requests = [];
  const reads = { row: 0, ids: 0 };
  const hold = (request, apply) =>
    new Promise((resolve) => {
      request.land = () => resolve(apply());
      request.refuse = (error = REFUSED) => resolve({ data: null, error });
      requests.push(request);
    });

  supabase.from.mockImplementation((table) => {
    if (table !== 'session_confirmations') throw new Error(`no such table in this test: ${table}`);
    const request = { kind: 'read' };
    const chain = {
      upsert(payload, options) {
        Object.assign(request, { kind: 'confirm', payload, options });
        return chain;
      },
      delete() {
        request.kind = 'undo';
        return chain;
      },
      select: () => chain,
      eq(column, value) {
        request[column] = value;
        return chain;
      },
      maybeSingle() {
        if (request.kind === 'confirm') {
          // INSERT … ON CONFLICT (session_id) DO NOTHING
          return hold(request, () => {
            const id = request.payload.session_id;
            if (server.has(id)) return { data: null, error: null };
            const row = { id: `c-${id}`, confirmed_at: '2026-10-13T18:00:00+00:00', ...request.payload };
            server.set(id, row);
            return { data: { ...row }, error: null };
          });
        }
        reads.row += 1;
        return Promise.resolve({ data: server.get(request.session_id) ?? null, error: null });
      },
      then(resolve, reject) {
        if (request.kind === 'undo') {
          return hold(request, () => {
            server.delete(request.session_id);
            return { data: null, error: null };
          }).then(resolve, reject);
        }
        reads.ids += 1;
        const data = [...server.keys()].map((session_id) => ({ session_id }));
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return chain;
  });
  return { server, requests, reads };
}

// Every client a test made, emptied when the test ends — see `afterEach`.
const clients = [];

function makeClient() {
  const client = new QueryClient({
    defaultOptions: {
      // Mounted and trusted: a read is made again only when something asks.
      queries: { retry: false, gcTime: Infinity, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  clients.push(client);
  return client;
}

const withClient = (qc) => ({ children }) => (
  <QueryClientProvider client={qc}>{children}</QueryClientProvider>
);

/**
 * The athlete's device after a visit to the training list and with the page
 * of `sessionId` open: the list of confirmed sessions, the confirmation of
 * that session and the block are in the cache, as the database has them.
 */
function mount(api, { qc = makeClient(), sessionId = 's-2' } = {}) {
  qc.setQueryData(IDS_KEY, [...api.server.keys()]);
  qc.setQueryData(rowKey(sessionId), api.server.get(sessionId) ?? null);
  qc.setQueryData(LIST_KEY, structuredClone(BLOCK));
  const { result } = renderHook(
    () => ({
      ids: useMyConfirmedSessionIds(),
      confirmation: useSessionConfirmation(sessionId),
      confirm: useConfirmSession(),
      undo: useUnconfirmSession(),
      waiting: useConfirmationWaiting(sessionId),
    }),
    { wrapper: withClient(qc) },
  );
  return { qc, result };
}

const trainedAt = (qc, id, key = LIST_KEY) => {
  const data = qc.getQueryData(key);
  const weeks = Array.isArray(data) ? data : data.weeks;
  return weeks.flatMap((w) => w.sessions).find((s) => s.id === id).performed_at;
};

const sent = (api, n) => waitFor(() => expect(api.requests).toHaveLength(n));

function setNetwork(up) {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(up);
  act(() => {
    onlineManager.setOnline(up);
    window.dispatchEvent(new Event(up ? 'online' : 'offline'));
  });
}

// Long enough for a handler and the reads it could start.
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

beforeEach(() => {
  vi.clearAllMocks();
  onlineManager.setOnline(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  // The queues first, the network second: several tests end with a write
  // parked on their client, the hooks are still mounted here, and putting the
  // manager back online would send that write once its test is over.
  while (clients.length) clients.pop().clear();
  onlineManager.setOnline(true);
});

describe('a confirmation shows at the tap, wherever "this session is done" is read', () => {
  it('the card, the list of confirmed sessions and the day trained — while the request is still open', async () => {
    const api = fakeConfirmations();
    const { qc, result } = mount(api);

    act(() =>
      result.current.confirm.mutate({ sessionId: 's-2', notes: 'felt strong', performedOn: '2026-10-13' }),
    );
    await sent(api, 1);

    expect(result.current.confirmation.data).toMatchObject({
      session_id: 's-2',
      student_id: 'u-1',
      notes: 'felt strong',
      performed_on: '2026-10-13',
    });
    // What the training list builds "Next", the place in the block and the
    // "Done" drawer from. An array in the cache: the device stores it.
    expect(qc.getQueryData(IDS_KEY)).toEqual(['s-1', 's-2']);
    expect(result.current.ids.data).toEqual(new Set(['s-1', 's-2']));
    // The day, written the way `sync_session_performed_at` will: the day
    // trained as a moment, midnight UTC.
    expect(trainedAt(qc, 's-2')).toBe('2026-10-13T00:00:00+00:00');
    expect(trainedAt(qc, 's-1')).toBe('2026-10-10T00:00:00+00:00');
    expect(trainedAt(qc, 's-3')).toBeNull();
    // Nothing was read to say so.
    expect(api.reads).toEqual({ row: 0, ids: 0 });

    act(() => api.requests[0].land());
    await waitFor(() => expect(result.current.confirm.isSuccess).toBe(true));
    expect(qc.getQueryData(IDS_KEY)).toEqual(['s-1', 's-2']);
    expect(api.requests[0].payload).toMatchObject({ session_id: 's-2', performed_on: '2026-10-13' });
  });

  it('without a network the write waits, and the three reads say the same', async () => {
    const api = fakeConfirmations();
    const { qc, result } = mount(api);
    setNetwork(false);

    act(() => result.current.confirm.mutate({ sessionId: 's-2', performedOn: '2026-10-13' }));
    await waitFor(() => expect(result.current.confirm.isPaused).toBe(true));

    expect(api.requests).toHaveLength(0);
    expect(result.current.confirmation.data).toMatchObject({ session_id: 's-2' });
    expect(result.current.ids.data.has('s-2')).toBe(true);
    expect(trainedAt(qc, 's-2')).toBe('2026-10-13T00:00:00+00:00');

    // The network returns: the write leaves, as it was made.
    setNetwork(true);
    await sent(api, 1);
    act(() => api.requests[0].land());
    await waitFor(() => expect(result.current.confirm.isSuccess).toBe(true));
    expect(api.server.get('s-2')).toMatchObject({ performed_on: '2026-10-13', student_id: 'u-1' });
    expect(result.current.ids.data.has('s-2')).toBe(true);
  });

  it('a confirmation sent without a day is dated by its own moment, as the database does', async () => {
    const api = fakeConfirmations();
    const { qc, result } = mount(api);

    act(() => result.current.confirm.mutate({ sessionId: 's-2' }));
    await sent(api, 1);

    expect(trainedAt(qc, 's-2')).toBe(result.current.confirmation.data.confirmed_at);
  });

  // What the block was read as stays what decides when it is read again: a
  // guess is not a read. Stamped as read at the tap, the list would not be
  // asked for when the athlete comes back to it from the workout.
  it('the lists keep the age of their last read', async () => {
    const api = fakeConfirmations();
    const { qc, result } = mount(api);
    const readAt = { ids: qc.getQueryState(IDS_KEY).dataUpdatedAt, list: qc.getQueryState(LIST_KEY).dataUpdatedAt };
    await new Promise((resolve) => setTimeout(resolve, 5));

    act(() => result.current.confirm.mutate({ sessionId: 's-2', performedOn: '2026-10-13' }));
    await sent(api, 1);

    expect(qc.getQueryData(IDS_KEY)).toEqual(['s-1', 's-2']);
    expect(qc.getQueryState(IDS_KEY).dataUpdatedAt).toBe(readAt.ids);
    expect(qc.getQueryState(LIST_KEY).dataUpdatedAt).toBe(readAt.list);
  });

  // A list made of the one session the device has just confirmed would be an
  // answer nobody gave: every other session of the block "not done".
  it('a list the device does not hold is not made', async () => {
    const api = fakeConfirmations();
    const qc = makeClient();
    const { result } = renderHook(() => useConfirmSession(), { wrapper: withClient(qc) });

    act(() => result.current.mutate({ sessionId: 's-2', performedOn: '2026-10-13' }));
    await sent(api, 1);

    expect(qc.getQueryData(rowKey('s-2'))).toMatchObject({ session_id: 's-2' });
    expect(qc.getQueryData(IDS_KEY)).toBeUndefined();
    expect(qc.getQueryData(LIST_KEY)).toBeUndefined();
    // And nothing is kept to take back.
    expect(qc.getMutationCache().getAll()[0].state.context).toMatchObject({ list: null, trained: null });
  });

  it('a past block that was opened, and a list cached as bare weeks by an older build, are written too', async () => {
    const api = fakeConfirmations();
    const qc = makeClient();
    const pastKey = studentPastProgramKey('u-1', 'p-1');
    qc.setQueryData(LIST_KEY, structuredClone(BLOCK.weeks));
    qc.setQueryData(pastKey, structuredClone(BLOCK.weeks));
    const { result } = renderHook(() => useConfirmSession(), { wrapper: withClient(qc) });

    act(() => result.current.mutate({ sessionId: 's-2', performedOn: '2026-10-13' }));
    await sent(api, 1);

    expect(Array.isArray(qc.getQueryData(LIST_KEY))).toBe(true);
    expect(trainedAt(qc, 's-2')).toBe('2026-10-13T00:00:00+00:00');
    expect(trainedAt(qc, 's-2', pastKey)).toBe('2026-10-13T00:00:00+00:00');
  });
});

describe('a confirmation the database refuses is taken back', () => {
  it('the card, the list and the day go back to what they were', async () => {
    const api = fakeConfirmations();
    const { qc, result } = mount(api);

    act(() => result.current.confirm.mutate({ sessionId: 's-2', performedOn: '2026-10-13' }));
    await sent(api, 1);
    expect(result.current.ids.data.has('s-2')).toBe(true);
    act(() => api.requests[0].refuse());
    await waitFor(() => expect(result.current.confirm.isError).toBe(true));

    expect(result.current.confirmation.data).toBeNull();
    expect(qc.getQueryData(IDS_KEY)).toEqual(['s-1']);
    expect(trainedAt(qc, 's-2')).toBeNull();
  });

  // The session was read ahead and opened in the gym: its confirmation was
  // never read. `setQueryData(key, undefined)` writes nothing — the card
  // stayed on "Session confirmed" after a confirmation that was refused.
  it('…when the confirmation had never been read: the card does not stay on "confirmed"', async () => {
    const api = fakeConfirmations();
    const qc = makeClient();
    qc.setQueryData(IDS_KEY, ['s-1']);
    const { result } = renderHook(() => useConfirmSession(), { wrapper: withClient(qc) });
    expect(qc.getQueryData(rowKey('s-2'))).toBeUndefined();

    act(() => result.current.mutate({ sessionId: 's-2', performedOn: '2026-10-13' }));
    await sent(api, 1);
    expect(qc.getQueryData(rowKey('s-2'))).toMatchObject({ session_id: 's-2' });
    act(() => api.requests[0].refuse());
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(qc.getQueryData(rowKey('s-2'))).toBeNull();
    expect(qc.getQueryData(IDS_KEY)).toEqual(['s-1']);
  });

  it('a session that was already in the list stays in it: the write takes back what it added', async () => {
    const api = fakeConfirmations();
    // A second device confirmed s-2; this one read the list, not the row.
    api.server.set('s-2', { ...FIRST, id: 'c-2', session_id: 's-2' });
    const { qc, result } = mount(api);
    qc.setQueryData(rowKey('s-2'), null);

    act(() => result.current.confirm.mutate({ sessionId: 's-2', performedOn: '2026-10-13' }));
    await sent(api, 1);
    expect(qc.getMutationCache().getAll()[0].state.context.list).toBeNull();
    act(() => api.requests[0].refuse());
    await waitFor(() => expect(result.current.confirm.isError).toBe(true));

    expect(qc.getQueryData(IDS_KEY)).toEqual(['s-1', 's-2']);
  });
});

describe('undoing a confirmation', () => {
  it('takes the session out of the three reads at the tap', async () => {
    const api = fakeConfirmations();
    const { qc, result } = mount(api, { sessionId: 's-1' });
    expect(result.current.confirmation.data).toMatchObject({ id: 'c-1' });

    act(() => result.current.undo.mutate({ sessionId: 's-1' }));
    await sent(api, 1);

    expect(result.current.confirmation.data).toBeNull();
    expect(qc.getQueryData(IDS_KEY)).toEqual([]);
    // The trigger empties the day when the confirmation goes.
    expect(trainedAt(qc, 's-1')).toBeNull();
    expect(api.reads).toEqual({ row: 0, ids: 0 });

    act(() => api.requests[0].land());
    await waitFor(() => expect(result.current.undo.isSuccess).toBe(true));
    expect(api.server.has('s-1')).toBe(false);
  });

  // The coach reviewed the session in between: the database keeps the
  // confirmation of a reviewed session.
  it('refused: the confirmation, its place in the list and its day come back', async () => {
    const api = fakeConfirmations();
    const { qc, result } = mount(api, { sessionId: 's-1' });

    act(() => result.current.undo.mutate({ sessionId: 's-1' }));
    await sent(api, 1);
    act(() => api.requests[0].refuse());
    await waitFor(() => expect(result.current.undo.isError).toBe(true));

    expect(result.current.confirmation.data).toEqual(FIRST);
    expect(qc.getQueryData(IDS_KEY)).toEqual(['s-1']);
    expect(trainedAt(qc, 's-1')).toBe('2026-10-10T00:00:00+00:00');
  });
});

// Confirm, undo, confirm again without a network is three writes. What the
// athlete sees is the state after the last of them — and stays that when an
// earlier one fails. On the app's client, whose defaults put these writes in
// one scope: they leave one at a time, in the order they were made.
describe('several writes on one session, made without a network', () => {
  function mountOnAppClient(api) {
    const qc = makeClient();
    registerOfflineMutationDefaults(qc);
    return mount(api, { qc });
  }

  async function confirmUndoConfirm(result) {
    setNetwork(false);
    act(() => result.current.confirm.mutate({ sessionId: 's-2', notes: 'first', performedOn: '2026-10-13' }));
    await waitFor(() => expect(result.current.ids.data.has('s-2')).toBe(true));
    act(() => result.current.undo.mutate({ sessionId: 's-2' }));
    await waitFor(() => expect(result.current.ids.data.has('s-2')).toBe(false));
    act(() => result.current.confirm.mutate({ sessionId: 's-2', notes: 'second', performedOn: '2026-10-13' }));
    await waitFor(() => expect(result.current.ids.data.has('s-2')).toBe(true));
  }

  it('each one is shown as it is made', async () => {
    const api = fakeConfirmations();
    const { qc, result } = mountOnAppClient(api);

    await confirmUndoConfirm(result);

    expect(api.requests).toHaveLength(0);
    expect(result.current.confirmation.data).toMatchObject({ notes: 'second' });
    expect(qc.getQueryData(IDS_KEY)).toEqual(['s-1', 's-2']);
    expect(trainedAt(qc, 's-2')).toBe('2026-10-13T00:00:00+00:00');
  });

  it('the first one fails when they leave: the screen keeps the state after the last', async () => {
    const api = fakeConfirmations();
    const { qc, result } = mountOnAppClient(api);
    await confirmUndoConfirm(result);

    setNetwork(true);
    await sent(api, 1);
    expect(api.requests[0].payload.notes).toBe('first');
    act(() => api.requests[0].refuse());

    // The undo leaves next: the first write has failed, and been through its
    // handlers. Its "before" — not confirmed — is not put back over a
    // confirmation that is still in the queue.
    await sent(api, 2);
    expect(api.requests[1].kind).toBe('undo');
    expect(result.current.confirmation.data).toMatchObject({ notes: 'second' });
    expect(qc.getQueryData(IDS_KEY)).toEqual(['s-1', 's-2']);
    expect(trainedAt(qc, 's-2')).toBe('2026-10-13T00:00:00+00:00');

    // The other two land, in the order they were made.
    act(() => api.requests[1].land());
    await sent(api, 3);
    expect(api.requests[2].payload.notes).toBe('second');
    act(() => api.requests[2].land());
    await waitFor(() => expect(result.current.confirm.isSuccess).toBe(true));
    expect(api.server.get('s-2')).toMatchObject({ notes: 'second' });
    expect(qc.getQueryData(IDS_KEY)).toContain('s-2');
    expect(result.current.confirmation.data).toMatchObject({ notes: 'second' });
  });

  it('the last one fails with nothing after it: it is taken back', async () => {
    const api = fakeConfirmations();
    const { qc, result } = mountOnAppClient(api);
    setNetwork(false);
    act(() => result.current.confirm.mutate({ sessionId: 's-2', performedOn: '2026-10-13' }));
    await waitFor(() => expect(result.current.confirm.isPaused).toBe(true));

    setNetwork(true);
    await sent(api, 1);
    act(() => api.requests[0].refuse());
    await waitFor(() => expect(result.current.confirm.isError).toBe(true));

    expect(result.current.confirmation.data).toBeNull();
    expect(qc.getQueryData(IDS_KEY)).toEqual(['s-1']);
    expect(trainedAt(qc, 's-2')).toBeNull();
  });
});

// Asking the database again for what a confirmation changes is not the hooks'
// any more. It is the `onSettled` that `registerOfflineMutationDefaults`
// registers for these two keys (lib/offlineMutations.js), which also serves a
// confirmation replayed after a relaunch, with no hook around it. An option a
// hook sets REPLACES the default of the same name, so the hooks set none.
describe('the hooks read nothing by themselves', () => {
  it('a confirmation that lands is followed by no read', async () => {
    const api = fakeConfirmations();
    const { result } = mount(api);

    act(() => result.current.confirm.mutate({ sessionId: 's-2', performedOn: '2026-10-13' }));
    await sent(api, 1);
    act(() => api.requests[0].land());
    await waitFor(() => expect(result.current.confirm.isSuccess).toBe(true));
    await settle();

    expect(api.reads).toEqual({ row: 0, ids: 0 });
  });

  it.each([
    ['useConfirmSession', 'confirm', MUTATION_KEYS.confirmSession, { sessionId: 's-2', performedOn: '2026-10-13' }, 's-2'],
    ['useUnconfirmSession', 'undo', MUTATION_KEYS.unconfirmSession, { sessionId: 's-1' }, 's-1'],
  ])('%s leaves the refresh registered for its key in place', async (_name, write, key, variables, sessionId) => {
    const api = fakeConfirmations();
    const qc = makeClient();
    const refresh = vi.fn();
    qc.setMutationDefaults(key, { onSettled: refresh });
    const { result } = mount(api, { qc, sessionId });

    act(() => result.current[write].mutate(variables));
    await sent(api, 1);
    expect(refresh).not.toHaveBeenCalled();
    act(() => api.requests[0].land());
    await waitFor(() => expect(result.current[write].isSuccess).toBe(true));

    expect(refresh).toHaveBeenCalledTimes(1);
    const [, error, written] = refresh.mock.calls[0];
    expect(error).toBeNull();
    // The very object of the mutation: the defaults find their write by it.
    expect(written).toBe(qc.getMutationCache().getAll()[0].state.variables);
    expect(written).toMatchObject(variables);
  });

  it('…for a write the database turned down as well', async () => {
    const api = fakeConfirmations();
    const qc = makeClient();
    const refresh = vi.fn();
    qc.setMutationDefaults(MUTATION_KEYS.confirmSession, { onSettled: refresh });
    const { result } = mount(api, { qc });

    act(() => result.current.confirm.mutate({ sessionId: 's-2' }));
    await sent(api, 1);
    act(() => api.requests[0].refuse());
    await waitFor(() => expect(result.current.confirm.isError).toBe(true));

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh.mock.calls[0].slice(0, 2)).toEqual([undefined, REFUSED]);
  });
});

// The same confirmation on the client the app builds. It needs the `onSettled`
// default of the confirmation keys, which `core-mutation-contracts` (lane
// offline-core, same wave) adds to lib/offlineMutations.js: until both lanes
// are in one tree it is an `it.fails`, and the run turns red on it ("expected
// to fail") the day they are — delete `.fails` then.
describe("on the app's client, what a confirmation changes is read again once it has settled", () => {
  it.fails('the list of confirmed sessions and the confirmation are asked of the database', async () => {
    const api = fakeConfirmations();
    const qc = makeClient();
    registerOfflineMutationDefaults(qc);
    const { result } = mount(api, { qc });

    act(() => result.current.confirm.mutate({ sessionId: 's-2', performedOn: '2026-10-13' }));
    await sent(api, 1);
    expect(api.reads).toEqual({ row: 0, ids: 0 });
    act(() => api.requests[0].land());
    await waitFor(() => expect(result.current.confirm.isSuccess).toBe(true));

    await waitFor(() => expect(api.reads).toEqual({ row: 1, ids: 1 }));
    await waitFor(() => expect(result.current.ids.isFetching).toBe(false));
    expect(result.current.ids.data).toEqual(new Set(['s-1', 's-2']));
    expect(result.current.confirmation.data).toMatchObject({ id: 'c-s-2', session_id: 's-2' });
  });
});

describe('useConfirmationWaiting — the confirmation is on the device, and waits for a network', () => {
  it('is true from the tap without a network until the write has left', async () => {
    const api = fakeConfirmations();
    const { result } = mount(api);
    expect(result.current.waiting).toBe(false);
    setNetwork(false);
    expect(result.current.waiting).toBe(false);

    act(() => result.current.confirm.mutate({ sessionId: 's-2', performedOn: '2026-10-13' }));
    await waitFor(() => expect(result.current.waiting).toBe(true));

    setNetwork(true);
    await sent(api, 1);
    expect(result.current.waiting).toBe(false);
    act(() => api.requests[0].land());
    await waitFor(() => expect(result.current.confirm.isSuccess).toBe(true));
    expect(result.current.waiting).toBe(false);
  });

  it('is false for a confirmation that is being sent', async () => {
    const api = fakeConfirmations();
    const { result } = mount(api);

    act(() => result.current.confirm.mutate({ sessionId: 's-2', performedOn: '2026-10-13' }));
    await sent(api, 1);

    expect(result.current.confirm.isPending).toBe(true);
    expect(result.current.waiting).toBe(false);
  });

  it('is about one session: the confirmation of another one does not count', async () => {
    const api = fakeConfirmations();
    const { result } = mount(api, { sessionId: 's-3' });
    setNetwork(false);

    act(() => result.current.confirm.mutate({ sessionId: 's-2', performedOn: '2026-10-13' }));
    await waitFor(() => expect(result.current.confirm.isPaused).toBe(true));

    expect(result.current.waiting).toBe(false);
  });

  // React Query calls a write paused while it stands behind another one of its
  // scope as well — here a write of the same queue that has not been answered
  // yet. That is a few hundred milliseconds on a working network, not a
  // confirmation kept on the device.
  it('is false for a confirmation that only stands behind another write, on a network', async () => {
    const api = fakeConfirmations();
    const qc = makeClient();
    registerOfflineMutationDefaults(qc);
    const { result } = mount(api, { qc });
    // A note being saved: same scope, not answered.
    const ahead = qc
      .getMutationCache()
      .build(qc, { scope: { id: 'offline-writes' }, mutationFn: () => new Promise(() => {}) });
    ahead.execute({}).catch(() => {});

    act(() => result.current.confirm.mutate({ sessionId: 's-2', performedOn: '2026-10-13' }));
    await waitFor(() => expect(result.current.confirm.isPaused).toBe(true));

    expect(api.requests).toHaveLength(0);
    expect(result.current.waiting).toBe(false);
  });

  // The usual case: the app was closed after the workout and is opened again,
  // still without a network. The write is a mutation restored from the store,
  // which no `useConfirmSession` of this launch has ever seen.
  it('is true after a relaunch, for a confirmation restored from the device', async () => {
    const api = fakeConfirmations();
    const gym = mount(api);
    setNetwork(false);
    act(() => gym.result.current.confirm.mutate({ sessionId: 's-2', performedOn: '2026-10-13' }));
    await waitFor(() => expect(gym.result.current.confirm.isPaused).toBe(true));

    const relaunched = makeClient();
    hydrate(relaunched, JSON.parse(JSON.stringify(dehydrate(gym.qc))));
    const { result } = renderHook(
      () => ({ waiting: useConfirmationWaiting('s-2'), ids: useMyConfirmedSessionIds() }),
      { wrapper: withClient(relaunched) },
    );

    expect(result.current.waiting).toBe(true);
    // And the list it restored has the session as done.
    expect(result.current.ids.data.has('s-2')).toBe(true);
  });
});
