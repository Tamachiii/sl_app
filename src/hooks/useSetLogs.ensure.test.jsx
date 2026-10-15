// L8 / P22 — the safety net that completes the sets of a session.
//
// It used to be a mutation the session page started at every opening: a read
// of the sets, an insert of the ones that were missing — counted on the
// exercises as the DEVICE had them — and a refresh. Without a network that
// mutation did not fail, it waited: "1 change waiting to sync" over a workout
// in which nothing was entered, then "Couldn't save that" at the next launch.
// And a set the coach had removed since the device read the session came back.
//
// The hook now decides by itself, on what the page shows, whether there is
// anything to ask, and asks the database — `ensure_set_logs(p_session_id)` —
// which reads the exercises where they are.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager, useQuery } from '@tanstack/react-query';

// `auth.getSession` because one block below runs on the app's client, whose
// queue of writes may ask who is signed in.
vi.mock('../lib/supabase', () => ({
  supabase: {
    from: vi.fn(),
    rpc: vi.fn(),
    auth: { getSession: async () => ({ data: { session: { user: { id: 'u-1' } } }, error: null }) },
  },
}));
vi.mock('../lib/toast', () => ({ pushToast: vi.fn() }));

import { useEnsureSetLogs, useToggleSetDone } from './useSetLogs';
import { supabase } from '../lib/supabase';
import { pushToast } from '../lib/toast';
import { queryClient as appClient } from '../lib/queryClient';

const SESSION = ['session', 'sess-1'];
const SETS = ['set-logs', 'sess-1', ['sl-1', 'sl-2']];
const OTHER_SESSION_SETS = ['set-logs', 'sess-2', ['sl-9']];

// The exercises as the device holds them: two, of three and two sets.
const slot = (id, sets, over = {}) => ({
  id,
  sets,
  reps: 8,
  duration_seconds: null,
  weight_kg: 40,
  rest_seconds: 120,
  ...over,
});
const SLOTS = [slot('sl-1', 3), slot('sl-2', 2)];

const row = (exercise_slot_id, set_number, over = {}) => ({
  id: `${exercise_slot_id}-${set_number}`,
  exercise_slot_id,
  set_number,
  done: false,
  is_student_added: false,
  ...over,
});
const ALL_ROWS = [row('sl-1', 1), row('sl-1', 2), row('sl-1', 3), row('sl-2', 1), row('sl-2', 2)];
const without = (...ids) => ALL_ROWS.filter((r) => !ids.includes(r.id));

// What PostgREST answers for a function it does not know, for a refusal of the
// function itself, and what postgrest-js hands back when `fetch` failed.
const NO_SUCH_FUNCTION = {
  code: 'PGRST202',
  details: 'Searched for the function public.ensure_set_logs with parameter p_session_id',
  hint: null,
  message: 'Could not find the function public.ensure_set_logs(p_session_id) in the schema cache',
};
const NOT_WRITABLE = {
  code: 'P0001',
  details: 'The coach has archived or reviewed this session.',
  hint: 'Nothing was changed.',
  message: 'session_not_writable',
};

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
}

const withClient = (qc) => ({ children }) => (
  <QueryClientProvider client={qc}>{children}</QueryClientProvider>
);

/**
 * The hook as the session page mounts it, next to the two reads its answer
 * refreshes — trusted for ever, so each is read again only when something asks
 * for it — and one list of another session, which nothing here may touch.
 */
function mount(options = {}) {
  const { slots = SLOTS, enabled = true, qc = makeClient() } = options;
  // `logs: undefined` is a value here — the sets are not read yet.
  const logs = 'logs' in options ? options.logs : ALL_ROWS;
  const reads = { session: vi.fn(async () => ({ id: 'sess-1' })), sets: vi.fn(async () => ALL_ROWS) };
  qc.setQueryData(SESSION, { id: 'sess-1' });
  qc.setQueryData(SETS, logs ?? []);
  qc.setQueryData(OTHER_SESSION_SETS, []);
  const view = renderHook(
    (props) => ({
      session: useQuery({ queryKey: SESSION, queryFn: reads.session, staleTime: Infinity }),
      sets: useQuery({ queryKey: SETS, queryFn: reads.sets, staleTime: Infinity }),
      ensure: useEnsureSetLogs('sess-1', props.slots, props.logs, { enabled: props.enabled }),
    }),
    { wrapper: withClient(qc), initialProps: { slots, logs, enabled } },
  );
  return { qc, reads, ...view };
}

// Long enough for an effect, a mutation and the reads it would start.
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

const mutations = (qc) => qc.getMutationCache().getAll();
const rpcCalls = () => supabase.rpc.mock.calls;

// The device with or without a network, as the app sees it: `navigator.onLine`
// with its event (useOnlineStatus), and React Query's own manager — the one
// that parks a mutation instead of sending it. The manager is set AFTER the
// event: a client that makes it follow the device does so on that event, and
// the cases below in which the two disagree have to stay in disagreement.
function setNetwork(up, { manager = up } = {}) {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(up);
  act(() => {
    window.dispatchEvent(new Event(up ? 'online' : 'offline'));
    onlineManager.setOnline(manager);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  onlineManager.setOnline(true);
  // An implementation given by one test is not the next one's.
  supabase.from.mockReset();
  supabase.rpc.mockReset();
  supabase.rpc.mockResolvedValue({ data: 0, error: null });
});

afterEach(() => {
  vi.restoreAllMocks();
  onlineManager.setOnline(true);
  appClient.clear();
});

describe('useEnsureSetLogs: whether there is anything to ask', () => {
  it('sends nothing and starts no mutation when every prescribed set has its row', async () => {
    const { qc, reads } = mount();
    await settle();

    expect(rpcCalls()).toHaveLength(0);
    expect(supabase.from).not.toHaveBeenCalled();
    expect(mutations(qc)).toHaveLength(0);
    // Neither read is made again: an opening costs what the page reads.
    expect(reads.session).not.toHaveBeenCalled();
    expect(reads.sets).not.toHaveBeenCalled();
  });

  it('asks the database, with the id of the session and nothing the device holds', async () => {
    mount({ logs: without('sl-1-3') });
    await waitFor(() => expect(rpcCalls()).toHaveLength(1));

    expect(rpcCalls()[0]).toEqual(['ensure_set_logs', { p_session_id: 'sess-1' }]);
    // No read of its own, and no insert: the function does both, there.
    expect(supabase.from).not.toHaveBeenCalled();
  });

  // The rule of the function: a number is taken by whatever row stands on it.
  it('counts an extra set of the athlete standing on a prescribed number as there', async () => {
    const extraOnThree = [...without('sl-1-3'), row('sl-1', 3, { id: 'extra', is_student_added: true })];
    const { qc } = mount({ logs: extraOnThree });
    await settle();

    expect(rpcCalls()).toHaveLength(0);
    expect(mutations(qc)).toHaveLength(0);
  });

  it('does not take an extra set above the prescription for a missing one, nor an exercise without a number of sets', async () => {
    const { qc } = mount({
      slots: [...SLOTS, slot('sl-3', null), slot('sl-4', 0)],
      logs: [...ALL_ROWS, row('sl-2', 3, { is_student_added: true })],
    });
    await settle();

    expect(rpcCalls()).toHaveLength(0);
    expect(mutations(qc)).toHaveLength(0);
  });

  it('waits for the sets to be read: a list that is not there yet is not an empty one', async () => {
    const { qc, rerender } = mount({ logs: undefined });
    await settle();
    expect(rpcCalls()).toHaveLength(0);
    expect(mutations(qc)).toHaveLength(0);

    // They arrive, and one is missing.
    rerender({ slots: SLOTS, logs: without('sl-2-2'), enabled: true });
    await waitFor(() => expect(rpcCalls()).toHaveLength(1));
  });

  it('asks nothing while it is switched off — a read-only session, reads still on their way — and asks when it is switched on', async () => {
    const missing = without('sl-1-1');
    const { qc, rerender } = mount({ logs: missing, enabled: false });
    await settle();
    expect(rpcCalls()).toHaveLength(0);
    expect(mutations(qc)).toHaveLength(0);

    rerender({ slots: SLOTS, logs: missing, enabled: true });
    await waitFor(() => expect(rpcCalls()).toHaveLength(1));
  });

  it('asks once for a list of missing sets, however often the page hands it over', async () => {
    const { rerender } = mount({ logs: without('sl-1-3') });
    await waitFor(() => expect(rpcCalls()).toHaveLength(1));

    // The same sets in new arrays — a read that came back unchanged — and the
    // switch flipped off and on, as it is each time the page reads again.
    for (let i = 0; i < 3; i++) {
      rerender({ slots: SLOTS.map((s) => ({ ...s })), logs: without('sl-1-3'), enabled: false });
      rerender({ slots: SLOTS.map((s) => ({ ...s })), logs: without('sl-1-3'), enabled: true });
    }
    await settle();
    expect(rpcCalls()).toHaveLength(1);

    // Another set goes missing: that is another question.
    rerender({ slots: SLOTS, logs: without('sl-1-3', 'sl-2-1'), enabled: true });
    await waitFor(() => expect(rpcCalls()).toHaveLength(2));
  });
});

// The defect of L8. `navigator.onLine` is what the app's pages look at;
// `onlineManager` is what makes React Query park a mutation. Either one saying
// "offline" is a reason not to start.
describe('useEnsureSetLogs: without a network', () => {
  it.each([
    ['the device is offline', { up: false, manager: false }],
    ['the device is offline and React Query does not know it', { up: false, manager: true }],
    ['React Query holds its requests back', { up: true, manager: false }],
  ])('starts nothing when %s: no mutation exists, parked or otherwise', async (_name, { up, manager }) => {
    setNetwork(up, { manager });
    const { qc } = mount({ logs: without('sl-1-3') });
    await settle();

    expect(rpcCalls()).toHaveLength(0);
    expect(supabase.from).not.toHaveBeenCalled();
    // This is the "1 change waiting to sync" of an untouched workout: a
    // mutation started offline is paused, counted by the banner and stored
    // with the queue.
    expect(mutations(qc)).toHaveLength(0);
    expect(qc.isMutating()).toBe(0);
  });

  it('asks when the network returns', async () => {
    setNetwork(false);
    const { qc } = mount({ logs: without('sl-1-3') });
    await settle();
    expect(rpcCalls()).toHaveLength(0);

    setNetwork(true);
    await waitFor(() => expect(rpcCalls()).toHaveLength(1));
    expect(rpcCalls()[0]).toEqual(['ensure_set_logs', { p_session_id: 'sess-1' }]);
    await waitFor(() => expect(qc.isMutating()).toBe(0));
    expect(mutations(qc).every((m) => !m.state.isPaused)).toBe(true);
  });

  it('asks again, once, for what it had asked before the network went', async () => {
    supabase.rpc.mockResolvedValue({ data: null, error: { code: '', message: 'TypeError: Failed to fetch' } });
    mount({ logs: without('sl-1-3') });
    await waitFor(() => expect(rpcCalls()).toHaveLength(1));
    await settle();
    expect(rpcCalls()).toHaveLength(1);

    setNetwork(false);
    await settle();
    setNetwork(true);
    await waitFor(() => expect(rpcCalls()).toHaveLength(2));
    await settle();
    expect(rpcCalls()).toHaveLength(2);
  });
});

describe('useEnsureSetLogs: what its answer reads again', () => {
  it('rows were added: the sets of that session, and nothing else', async () => {
    supabase.rpc.mockResolvedValue({ data: 2, error: null });
    const { qc, reads } = mount({ logs: without('sl-1-3', 'sl-2-2') });

    await waitFor(() => expect(reads.sets).toHaveBeenCalledTimes(1));
    await settle();
    expect(reads.sets).toHaveBeenCalledTimes(1);
    expect(reads.session).not.toHaveBeenCalled();
    expect(qc.getQueryState(OTHER_SESSION_SETS).isInvalidated).toBe(false);
  });

  // The database is short of nothing where the device counted a set missing:
  // its copy of the session — the numbers of sets — or of the sets is behind.
  it('0 rows were added: the session and its sets, since the device is behind — and it does not ask the database again', async () => {
    supabase.rpc.mockResolvedValue({ data: 0, error: null });
    const { qc, reads, rerender } = mount({ logs: without('sl-1-3') });

    await waitFor(() => expect(reads.session).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(reads.sets).toHaveBeenCalledTimes(1));
    expect(qc.getQueryState(OTHER_SESSION_SETS).isInvalidated).toBe(false);

    // Whatever the two reads bring back — here the same sets, in new arrays —
    // the question was answered.
    rerender({ slots: SLOTS.map((s) => ({ ...s })), logs: without('sl-1-3'), enabled: true });
    await settle();
    expect(rpcCalls()).toHaveLength(1);
    expect(reads.session).toHaveBeenCalledTimes(1);
    expect(reads.sets).toHaveBeenCalledTimes(1);
  });

  // A read of the sets made while one of their writes is on its way comes back
  // without it. The read that follows the last set-log write
  // (lib/offlineMutations.js) brings the added rows as well.
  it('leaves the read of the sets to the one that follows a set-log write on its way', async () => {
    supabase.rpc.mockResolvedValue({ data: 1, error: null });
    // A tick whose request stays open.
    supabase.from.mockImplementation(() => {
      const chain = {
        update: () => chain,
        eq: () => chain,
        select: () => chain,
        single: () => new Promise(() => {}),
      };
      return chain;
    });
    const qc = makeClient();
    const reads = { sets: vi.fn(async () => ALL_ROWS) };
    qc.setQueryData(SETS, without('sl-1-3'));
    const { result, rerender } = renderHook(
      (props) => ({
        sets: useQuery({ queryKey: SETS, queryFn: reads.sets, staleTime: Infinity }),
        tick: useToggleSetDone('sl-1-1'),
        ensure: useEnsureSetLogs('sess-1', SLOTS, props.logs, { enabled: props.enabled }),
      }),
      { wrapper: withClient(qc), initialProps: { logs: without('sl-1-3'), enabled: false } },
    );
    act(() => result.current.tick.mutate({ logId: 'sl-1-1', done: true }));
    await waitFor(() => expect(qc.isMutating({ mutationKey: ['set-log'] })).toBe(1));

    rerender({ logs: without('sl-1-3'), enabled: true });
    await waitFor(() => expect(result.current.ensure.isSuccess).toBe(true));
    await settle();

    expect(reads.sets).not.toHaveBeenCalled();
    // The tick is still what the list shows.
    expect(qc.getQueryData(SETS).find((r) => r.id === 'sl-1-1').done).toBe(true);
  });
});

// The other half of the case above, and it is not in this file's hands: the
// read that follows the last set-log write is the default
// `registerOfflineMutationDefaults` gives the set-log keys
// (lib/offlineMutations.js). Without that default nothing would read the sets
// after the tick, and the rows the database added would wait for the next
// opening of the page.
describe('useEnsureSetLogs: on the client of the app', () => {
  it('the rows added while a tick was on its way are read once the tick has landed', async () => {
    supabase.rpc.mockResolvedValue({ data: 1, error: null });
    // A tick whose request stays open until the test lets it land.
    let land;
    supabase.from.mockImplementation(() => {
      const chain = {
        update: () => chain,
        eq: () => chain,
        select: () => chain,
        single: () =>
          new Promise((resolve) => {
            land = () => resolve({ data: row('sl-1', 1, { done: true }), error: null });
          }),
      };
      return chain;
    });
    const reads = { sets: vi.fn(async () => ALL_ROWS) };
    appClient.setQueryData(SETS, without('sl-1-3'));
    const { result, rerender } = renderHook(
      (props) => ({
        sets: useQuery({ queryKey: SETS, queryFn: reads.sets, staleTime: Infinity }),
        tick: useToggleSetDone('sl-1-1'),
        ensure: useEnsureSetLogs('sess-1', SLOTS, props.logs, { enabled: props.enabled }),
      }),
      { wrapper: withClient(appClient), initialProps: { logs: without('sl-1-3'), enabled: false } },
    );
    act(() => result.current.tick.mutate({ logId: 'sl-1-1', done: true }));
    await waitFor(() => expect(land).toBeTypeOf('function'));

    rerender({ logs: without('sl-1-3'), enabled: true });
    await waitFor(() => expect(result.current.ensure.isSuccess).toBe(true));
    expect(reads.sets).not.toHaveBeenCalled();

    await act(async () => land());
    // One read, and it has the row the database added.
    await waitFor(() => expect(reads.sets).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.sets.data.map((r) => r.id)).toContain('sl-1-3'));
  });
});

describe('useEnsureSetLogs: a refusal', () => {
  it('writes nothing, reads nothing again and is not asked a second time', async () => {
    supabase.rpc.mockResolvedValue({ data: null, error: NOT_WRITABLE });
    const { reads, result, rerender } = mount({ logs: without('sl-1-3') });

    await waitFor(() => expect(result.current.ensure.isError).toBe(true));
    expect(result.current.ensure.error).toBe(NOT_WRITABLE);
    // A refusal is not "no such function": nothing is inserted in its place.
    expect(supabase.from).not.toHaveBeenCalled();
    expect(reads.session).not.toHaveBeenCalled();
    expect(reads.sets).not.toHaveBeenCalled();

    rerender({ slots: SLOTS.map((s) => ({ ...s })), logs: without('sl-1-3'), enabled: true });
    await settle();
    expect(rpcCalls()).toHaveLength(1);
  });

  // The athlete asked for nothing. On the app's client every failed mutation
  // is a toast unless it says otherwise.
  it('says nothing to the athlete on the client of the app', async () => {
    supabase.rpc.mockResolvedValue({ data: null, error: NOT_WRITABLE });
    const { result } = mount({ logs: without('sl-1-3'), qc: appClient });

    await waitFor(() => expect(result.current.ensure.isError).toBe(true));
    await settle();
    expect(pushToast).not.toHaveBeenCalled();
  });
});

// A database that does not have migration 2026_10_13_13: the hook does what
// the function does, in three requests of its own — and still takes nothing
// from the device.
describe('useEnsureSetLogs: a database without the function', () => {
  /**
   * `exercise_slots` and `set_logs` as the database has them. Records what is
   * asked (`requests`) and what is inserted (`inserted`).
   */
  function fakeTables({ slots, rows }) {
    const requests = [];
    const inserted = [];
    supabase.from.mockImplementation((table) => {
      const request = { table, filters: [] };
      const chain = {
        select: (columns) => {
          request.select = columns;
          return chain;
        },
        eq: (column, value) => {
          request.filters.push(['eq', column, value]);
          return chain;
        },
        in: (column, value) => {
          request.filters.push(['in', column, value]);
          return chain;
        },
        insert: (values) => {
          requests.push({ ...request, insert: values });
          inserted.push(...values);
          return Promise.resolve({ error: null });
        },
        then: (resolve, reject) => {
          requests.push(request);
          return Promise.resolve({ data: table === 'exercise_slots' ? slots : rows, error: null }).then(
            resolve,
            reject,
          );
        },
      };
      return chain;
    });
    return { requests, inserted };
  }

  beforeEach(() => {
    supabase.rpc.mockResolvedValue({ data: null, error: NO_SUCH_FUNCTION });
  });

  it('reads the exercises of the session and their sets there, and inserts the missing ones with the targets of their exercise', async () => {
    const onServer = [
      slot('sl-1', 3, { reps: 5, weight_kg: 100, rest_seconds: 180 }),
      slot('sl-2', 2, { reps: null, duration_seconds: 30, weight_kg: null, rest_seconds: null }),
    ];
    const db = fakeTables({ slots: onServer, rows: without('sl-1-3', 'sl-2-2') });
    const { reads, result } = mount({ logs: without('sl-1-3', 'sl-2-2') });

    await waitFor(() => expect(result.current.ensure.isSuccess).toBe(true));

    expect(db.requests.map((r) => r.table)).toEqual(['exercise_slots', 'set_logs', 'set_logs']);
    expect(db.requests[0].filters).toEqual([['eq', 'session_id', 'sess-1']]);
    expect(db.requests[1].filters).toEqual([['in', 'exercise_slot_id', ['sl-1', 'sl-2']]]);
    expect(db.inserted).toEqual([
      {
        exercise_slot_id: 'sl-1',
        set_number: 3,
        done: false,
        target_reps: 5,
        target_duration_seconds: null,
        target_weight_kg: 100,
        target_rest_seconds: 180,
      },
      {
        exercise_slot_id: 'sl-2',
        set_number: 2,
        done: false,
        target_reps: null,
        target_duration_seconds: 30,
        target_weight_kg: null,
        target_rest_seconds: null,
      },
    ]);
    // Two rows were added: the sets are read again, as after the function.
    await waitFor(() => expect(reads.sets).toHaveBeenCalledTimes(1));
    expect(reads.session).not.toHaveBeenCalled();
  });

  // P22. The device still has the exercise at four sets; the coach has taken
  // the fourth away. Counted on the device's copy, it would come back.
  it('does not bring back a set the coach has removed since the device read the session', async () => {
    const db = fakeTables({ slots: [slot('sl-1', 3), slot('sl-2', 2)], rows: ALL_ROWS });
    const { reads, result } = mount({ slots: [slot('sl-1', 4), slot('sl-2', 2)], logs: ALL_ROWS });

    await waitFor(() => expect(result.current.ensure.isSuccess).toBe(true));

    expect(db.inserted).toEqual([]);
    expect(db.requests.some((r) => r.insert)).toBe(false);
    // And the device learns that its copy is behind.
    await waitFor(() => expect(reads.session).toHaveBeenCalledTimes(1));
  });

  it('inserts nothing for a session that has no exercise there', async () => {
    const db = fakeTables({ slots: [], rows: [] });
    const { result } = mount({ logs: without('sl-1-3') });

    await waitFor(() => expect(result.current.ensure.isSuccess).toBe(true));
    expect(db.requests.map((r) => r.table)).toEqual(['exercise_slots']);
    expect(db.inserted).toEqual([]);
  });
});
