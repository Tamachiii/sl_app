// P56 — the optimistic updates of the set-log writes used to fight each other.
// Each write snapshotted EVERY cached list of sets and, when it failed, put the
// lists back as they were before it — taking off the screen every set ticked
// since. Each write also read the sets again as soon as it settled: a read made
// between two queued writes comes back without the second one.
//
// The athlete ticks the next set while the last one is still on its way, so
// several writes are alive at once. The tests below keep the requests open and
// answer them one by one, in the order a slow network would.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';

// `auth.getSession` because one block below builds the app's client (the
// offline mutation defaults are registered on it): on that client a queued
// write is not sent until a session can be read.
vi.mock('../lib/supabase', () => ({
  supabase: {
    from: vi.fn(),
    auth: { getSession: async () => ({ data: { session: { user: { id: 'u-1' } } }, error: null }) },
  },
}));

import {
  useToggleSetDone,
  useSetFailed,
  useSetRpe,
  useLogActual,
  useSetSkipped,
} from './useSetLogs';
import { supabase } from '../lib/supabase';
import { MUTATION_KEYS, registerOfflineMutationDefaults } from '../lib/offlineMutations';

const KEY = ['set-logs', 'sess-1', ['slot-1']];
const OTHER_SESSION = ['set-logs', 'sess-2', ['slot-9']];

const pendingRow = (id, set_number) => ({
  id,
  exercise_slot_id: 'slot-1',
  set_number,
  target_reps: 5,
  done: false,
  failed: false,
  skipped: false,
  logged_at: null,
  failed_at: null,
  rpe: null,
  actual_reps: null,
  actual_weight_kg: null,
});

const ROWS = [pendingRow('a', 1), pendingRow('b', 2), pendingRow('c', 3)];

// What PostgREST answers when a CHECK turns a write down.
const REFUSED = {
  code: '23514',
  details: null,
  hint: null,
  message: 'new row for relation "set_logs" violates check constraint "set_logs_done_xor_failed"',
};

/**
 * A `set_logs` table whose updates stay open until the test answers them:
 * `requests[n].land()` — the database takes the write and answers with the row
 * — or `requests[n].refuse()`. `read` is the list of sets as the database has
 * it at that moment.
 */
function fakeSetLogs(rows = ROWS) {
  const server = new Map(rows.map((r) => [r.id, { ...r }]));
  const requests = [];
  supabase.from.mockImplementation(() => {
    const request = {};
    const chain = {
      update: (patch) => {
        request.patch = patch;
        return chain;
      },
      eq: (_column, id) => {
        request.logId = id;
        return chain;
      },
      select: () => chain,
      single: () =>
        new Promise((resolve) => {
          request.land = (alsoChanged = {}) => {
            const row = { ...server.get(request.logId), ...request.patch, ...alsoChanged };
            server.set(request.logId, row);
            resolve({ data: { ...row }, error: null });
          };
          request.refuse = (error = REFUSED) => resolve({ data: null, error });
          requests.push(request);
        }),
    };
    return chain;
  });
  const read = vi.fn(async () => [...server.values()].map((r) => ({ ...r })));
  return { server, requests, read };
}

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
}

/**
 * The session page, reduced to what matters here: the list of sets, mounted
 * and trusted (so it is read again only when something asks for it), and the
 * writes of rows `a` and `b`.
 */
function mount(api, qc = makeClient()) {
  qc.setQueryData(KEY, ROWS.map((r) => ({ ...r })));
  const wrapper = ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  const { result } = renderHook(
    () => ({
      sets: useQuery({ queryKey: KEY, queryFn: api.read, staleTime: Infinity }),
      tickA: useToggleSetDone('a'),
      failA: useSetFailed('a'),
      rpeA: useSetRpe('a'),
      tickB: useToggleSetDone('b'),
    }),
    { wrapper },
  );
  return { qc, result };
}

const shown = (qc, id) => qc.getQueryData(KEY).find((row) => row.id === id);
const sent = (api, n) => waitFor(() => expect(api.requests).toHaveLength(n));

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a write that fails takes back what it wrote, and nothing else', () => {
  it('its own row goes back, and a set ticked after it on another row stays ticked', async () => {
    const api = fakeSetLogs();
    const { qc, result } = mount(api);

    act(() => result.current.tickA.mutate({ logId: 'a', done: true }));
    await sent(api, 1);
    act(() => result.current.tickB.mutate({ logId: 'b', done: true }));
    await sent(api, 2);
    expect(shown(qc, 'a').done).toBe(true);
    expect(shown(qc, 'b').done).toBe(true);

    act(() => api.requests[0].refuse());
    await waitFor(() => expect(result.current.tickA.isError).toBe(true));

    expect(shown(qc, 'a')).toMatchObject({ done: false, logged_at: null });
    expect(shown(qc, 'b')).toMatchObject({ done: true, logged_at: expect.any(String) });
    expect(shown(qc, 'c')).toEqual(ROWS[2]);
  });

  it('a newer write to the same row keeps what it shows: the RPE given after a tick that is refused', async () => {
    const api = fakeSetLogs();
    const { qc, result } = mount(api);

    act(() => result.current.tickA.mutate({ logId: 'a', done: true }));
    await sent(api, 1);
    // Same row: it waits behind the tick (the per-row scope).
    act(() => result.current.rpeA.mutate({ logId: 'a', rpe: 8 }));
    await waitFor(() => expect(shown(qc, 'a').rpe).toBe(8));
    expect(api.requests).toHaveLength(1);

    act(() => api.requests[0].refuse());
    await waitFor(() => expect(result.current.tickA.isError).toBe(true));

    expect(shown(qc, 'a')).toMatchObject({ done: false, logged_at: null, rpe: 8 });

    // The RPE leaves in its turn, and the database has the last word.
    await sent(api, 2);
    act(() => api.requests[1].land());
    await waitFor(() => expect(result.current.rpeA.isSuccess).toBe(true));
    expect(shown(qc, 'a')).toEqual({ ...ROWS[0], rpe: 8 });
  });

  it('a field a newer write has written over is not put back: tick, then failed, and the tick is refused', async () => {
    const api = fakeSetLogs();
    const { qc, result } = mount(api);

    act(() => result.current.tickA.mutate({ logId: 'a', done: true }));
    await sent(api, 1);
    act(() => result.current.failA.mutate({ logId: 'a', failed: true }));
    await waitFor(() => expect(shown(qc, 'a').failed).toBe(true));

    act(() => api.requests[0].refuse());
    await waitFor(() => expect(result.current.tickA.isError).toBe(true));

    // Still what the athlete last said about this set.
    expect(shown(qc, 'a')).toMatchObject({
      done: false,
      failed: true,
      logged_at: null,
      failed_at: expect.any(String),
    });
  });

  it('a write that fails with nothing after it puts its row back exactly as it was', async () => {
    const api = fakeSetLogs();
    const { qc, result } = mount(api);

    act(() => result.current.failA.mutate({ logId: 'a', failed: true }));
    await sent(api, 1);
    expect(shown(qc, 'a').failed).toBe(true);

    act(() => api.requests[0].refuse());
    await waitFor(() => expect(result.current.failA.isError).toBe(true));

    expect(qc.getQueryData(KEY)).toEqual(ROWS);
  });

  it('what a write keeps for that is the fields it changed on one row, not the lists', async () => {
    const api = fakeSetLogs();
    const { qc, result } = mount(api);

    act(() => result.current.tickA.mutate({ logId: 'a', done: true }));
    await sent(api, 1);

    // Stored with the queued write, once per set of the workout.
    const [tick] = qc.getMutationCache().getAll();
    expect(tick.state.context).toEqual({
      written: { done: true, failed: false, logged_at: expect.any(String), failed_at: null },
      previous: { done: false, failed: false, logged_at: null, failed_at: null },
    });
  });

  it('a write to a row no list holds changes nothing and has nothing to take back', async () => {
    const api = fakeSetLogs([...ROWS, pendingRow('z', 9)]);
    const { qc } = mount(api);
    const wrapper = ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useToggleSetDone('z'), { wrapper });

    act(() => result.current.mutate({ logId: 'z', done: true }));
    await sent(api, 1);
    expect(qc.getMutationCache().getAll()[0].state.context.previous).toBeNull();

    act(() => api.requests[0].refuse());
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(qc.getQueryData(KEY)).toEqual(ROWS);
  });
});

describe('a tap writes one row of one list', () => {
  it('the lists of the other sessions are not written — not even marked as read just now', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-09T17:00:00.000Z') });
    const api = fakeSetLogs();
    const { qc, result } = mount(api);
    const otherRows = [{ ...pendingRow('x', 1), exercise_slot_id: 'slot-9' }];
    qc.setQueryData(OTHER_SESSION, otherRows);
    const readAt = qc.getQueryState(OTHER_SESSION).dataUpdatedAt;

    vi.setSystemTime(new Date('2026-10-09T18:02:11.000Z'));
    act(() => result.current.tickA.mutate({ logId: 'a', done: true }));
    await sent(api, 1);
    act(() => api.requests[0].land());
    await waitFor(() => expect(result.current.tickA.isSuccess).toBe(true));

    expect(shown(qc, 'a').done).toBe(true);
    expect(qc.getQueryData(OTHER_SESSION)).toBe(otherRows);
    expect(qc.getQueryState(OTHER_SESSION).dataUpdatedAt).toBe(readAt);
  });

  it('the other rows of the list are the same objects as before', async () => {
    const api = fakeSetLogs();
    const { qc, result } = mount(api);
    const [, b, c] = qc.getQueryData(KEY);

    act(() => result.current.tickA.mutate({ logId: 'a', done: true }));
    await sent(api, 1);

    const rows = qc.getQueryData(KEY);
    expect(rows[1]).toBe(b);
    expect(rows[2]).toBe(c);
  });
});

describe('the answer of the database is put on screen', () => {
  it('the row it answers replaces the guess, without the sets being read again', async () => {
    const api = fakeSetLogs();
    const { qc, result } = mount(api);

    act(() => result.current.tickA.mutate({ logId: 'a', done: true }));
    await sent(api, 1);
    // The coach lowered the target while this set was on its way.
    act(() => api.requests[0].land({ target_reps: 3 }));
    await waitFor(() => expect(result.current.tickA.isSuccess).toBe(true));

    expect(shown(qc, 'a')).toEqual(api.server.get('a'));
    expect(shown(qc, 'a')).toMatchObject({ done: true, target_reps: 3 });
    expect(api.read).not.toHaveBeenCalled();
  });

  it('a read that came back without a set still on its way is put right when that set lands', async () => {
    const api = fakeSetLogs();
    const { qc, result } = mount(api);

    act(() => result.current.tickA.mutate({ logId: 'a', done: true }));
    await sent(api, 1);
    // A read sent before the write reached the database — the return to the
    // app, the network coming back — answers now: the set is not in it.
    act(() => {
      qc.setQueryData(KEY, [...api.server.values()].map((r) => ({ ...r })));
    });
    expect(shown(qc, 'a').done).toBe(false);

    act(() => api.requests[0].land());
    await waitFor(() => expect(result.current.tickA.isSuccess).toBe(true));

    expect(shown(qc, 'a')).toMatchObject({ done: true, logged_at: expect.any(String) });
    expect(api.read).not.toHaveBeenCalled();
  });

  it('the answer to one write does not take a newer one to the same row off the screen', async () => {
    const api = fakeSetLogs();
    const { qc, result } = mount(api);

    act(() => result.current.tickA.mutate({ logId: 'a', done: true }));
    await sent(api, 1);
    act(() => result.current.rpeA.mutate({ logId: 'a', rpe: 8 }));
    await waitFor(() => expect(shown(qc, 'a').rpe).toBe(8));

    // The database answers the tick: done, and no RPE yet.
    act(() => api.requests[0].land());
    await waitFor(() => expect(result.current.tickA.isSuccess).toBe(true));
    expect(api.server.get('a').rpe).toBeNull();
    expect(shown(qc, 'a')).toMatchObject({ done: true, rpe: 8 });

    // The RPE leaves in its turn; its answer carries both.
    await sent(api, 2);
    act(() => api.requests[1].land());
    await waitFor(() => expect(result.current.rpeA.isSuccess).toBe(true));
    expect(shown(qc, 'a')).toEqual(api.server.get('a'));
    expect(shown(qc, 'a')).toMatchObject({ done: true, rpe: 8 });
    expect(api.read).not.toHaveBeenCalled();
  });

  it('a write on another row does not hold the answer back', async () => {
    const api = fakeSetLogs();
    const { qc, result } = mount(api);

    act(() => result.current.tickA.mutate({ logId: 'a', done: true }));
    await sent(api, 1);
    act(() => result.current.tickB.mutate({ logId: 'b', done: true }));
    await sent(api, 2);

    act(() => api.requests[0].land({ target_reps: 3 }));
    await waitFor(() => expect(result.current.tickA.isSuccess).toBe(true));

    expect(shown(qc, 'a')).toEqual(api.server.get('a'));
    expect(shown(qc, 'b').done).toBe(true);
  });
});

// Reading the sets again once the queue has drained is not the hooks' any
// more. It is the `onSettled` that `registerOfflineMutationDefaults` registers
// for each of these keys (lib/offlineMutations.js), which also serves a write
// replayed after a relaunch, with no hook around it. An option a hook sets
// REPLACES the default of the same name, so the hooks set none.
describe('the hooks read nothing by themselves', () => {
  it('two sets on their way: no read between them, and none after', async () => {
    const api = fakeSetLogs();
    const { qc, result } = mount(api);

    act(() => result.current.tickA.mutate({ logId: 'a', done: true }));
    act(() => result.current.tickB.mutate({ logId: 'b', done: true }));
    await sent(api, 2);

    act(() => api.requests[0].land());
    await waitFor(() => expect(result.current.tickA.isSuccess).toBe(true));
    expect(api.read).not.toHaveBeenCalled();
    expect(shown(qc, 'b').done).toBe(true);

    act(() => api.requests[1].land());
    await waitFor(() => expect(result.current.tickB.isSuccess).toBe(true));
    expect(api.read).not.toHaveBeenCalled();
    expect(result.current.sets.data).toEqual([...api.server.values()]);
  });

  it.each([
    ['useToggleSetDone', useToggleSetDone, MUTATION_KEYS.toggleDone, { logId: 'a', done: true }],
    ['useSetFailed', useSetFailed, MUTATION_KEYS.setFailed, { logId: 'a', failed: true }],
    ['useSetRpe', useSetRpe, MUTATION_KEYS.setRpe, { logId: 'a', rpe: 8 }],
    ['useLogActual', useLogActual, MUTATION_KEYS.logActual, { logId: 'a', actualReps: 4, actualWeightKg: null }],
    ['useSetSkipped', useSetSkipped, MUTATION_KEYS.setSkipped, { logId: 'a', skipped: true }],
  ])('%s leaves the refresh registered for its key in place', async (_name, useHook, key, variables) => {
    const api = fakeSetLogs();
    const { qc } = mount(api);
    const refresh = vi.fn();
    qc.setMutationDefaults(key, { onSettled: refresh });
    const wrapper = ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useHook('a'), { wrapper });

    act(() => result.current.mutate(variables));
    await sent(api, 1);
    expect(refresh).not.toHaveBeenCalled();
    act(() => api.requests[0].land());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(refresh).toHaveBeenCalledTimes(1);
    const [row, error, written] = refresh.mock.calls[0];
    expect(row).toEqual(api.server.get('a'));
    expect(error).toBeNull();
    // The very object of the mutation: the defaults find their write by it.
    expect(written).toBe(qc.getMutationCache().getAll()[0].state.variables);
    expect(written).toEqual({ ...variables, at: expect.any(String) });
  });

  it('…for a write the database turned down as well', async () => {
    const api = fakeSetLogs();
    const { qc, result } = mount(api);
    const refresh = vi.fn();
    qc.setMutationDefaults(MUTATION_KEYS.toggleDone, { onSettled: refresh });

    act(() => result.current.tickB.mutate({ logId: 'b', done: true }));
    await sent(api, 1);
    act(() => api.requests[0].refuse());
    await waitFor(() => expect(result.current.tickB.isError).toBe(true));

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh.mock.calls[0].slice(0, 2)).toEqual([undefined, REFUSED]);
  });
});

// The same two sets on the client the app builds. The second test needs the
// `onSettled` default of the set-log keys, which
// `registerOfflineMutationDefaults` gives them (lib/offlineMutations.js).
describe("on the app's client, the sets are read again once, after the last write", () => {
  function mountOnAppClient(api) {
    const qc = makeClient();
    registerOfflineMutationDefaults(qc);
    return mount(api, qc);
  }

  it('no read is made while a set is still on its way', async () => {
    const api = fakeSetLogs();
    const { qc, result } = mountOnAppClient(api);

    act(() => result.current.tickA.mutate({ logId: 'a', done: true }));
    act(() => result.current.tickB.mutate({ logId: 'b', done: true }));
    await sent(api, 2);
    act(() => api.requests[0].land());
    await waitFor(() => expect(result.current.tickA.isSuccess).toBe(true));

    expect(api.read).not.toHaveBeenCalled();
    expect(shown(qc, 'a').done).toBe(true);
    expect(shown(qc, 'b').done).toBe(true);
  });

  it('one read follows the last of them, and it has both', async () => {
    const api = fakeSetLogs();
    const { result } = mountOnAppClient(api);

    act(() => result.current.tickA.mutate({ logId: 'a', done: true }));
    act(() => result.current.tickB.mutate({ logId: 'b', done: true }));
    await sent(api, 2);
    act(() => api.requests[0].land());
    await waitFor(() => expect(result.current.tickA.isSuccess).toBe(true));
    act(() => api.requests[1].land({ target_reps: 3 }));
    await waitFor(() => expect(result.current.tickB.isSuccess).toBe(true));

    await waitFor(() => expect(api.read).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.sets.isFetching).toBe(false));
    expect(result.current.sets.data).toEqual([...api.server.values()]);
    expect(api.read).toHaveBeenCalledTimes(1);
  });
});
