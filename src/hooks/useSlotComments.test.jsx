import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';

// `auth.getSession` because one block below builds the app's client (the
// offline mutation defaults are registered on it): on that client a queued
// write is not sent until a session can be read.
vi.mock('../lib/supabase', () => ({
  supabase: {
    from: vi.fn(),
    auth: { getSession: async () => ({ data: { session: { user: { id: 'u-1' } } }, error: null }) },
  },
}));
vi.mock('./useAuth', () => ({ useAuth: vi.fn() }));

import { useSlotComments, useSaveSlotComment } from './useSlotComments';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';
import { MUTATION_KEYS, registerOfflineMutationDefaults } from '../lib/offlineMutations';

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
}
function withClient(qc) {
  return ({ children }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuth.mockReturnValue({ user: { id: 'u-1' } });
});

describe('useSlotComments', () => {
  it('is disabled when slots is empty', async () => {
    const qc = makeClient();
    const { result } = renderHook(() => useSlotComments('s-1', []), {
      wrapper: withClient(qc),
    });
    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('queries by exercise_slot_id IN (...)', async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      in: vi.fn().mockResolvedValue({
        data: [{ id: 'sc-1', exercise_slot_id: 'sl-1', body: 'good' }],
        error: null,
      }),
    };
    supabase.from.mockReturnValue(chain);
    const qc = makeClient();
    const { result } = renderHook(
      () => useSlotComments('s-1', [{ id: 'sl-1' }]),
      { wrapper: withClient(qc) },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(chain.in).toHaveBeenCalledWith('exercise_slot_id', ['sl-1']);
  });
});

describe('useSaveSlotComment', () => {
  it('upserts the trimmed body with student_id from auth', async () => {
    const chain = {
      upsert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { id: 'sc-1' }, error: null }),
    };
    supabase.from.mockReturnValue(chain);
    const qc = makeClient();
    const { result } = renderHook(() => useSaveSlotComment(), {
      wrapper: withClient(qc),
    });
    result.current.mutate({ sessionId: 's-1', slotId: 'sl-1', body: '  felt heavy  ' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const upsertPayload = chain.upsert.mock.calls[0][0];
    expect(upsertPayload).toMatchObject({
      exercise_slot_id: 'sl-1',
      student_id: 'u-1',
      body: 'felt heavy',
    });
    expect(typeof upsertPayload.updated_at).toBe('string');
  });

  it('deletes the row when the body is empty', async () => {
    const chain = {
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: null }),
    };
    supabase.from.mockReturnValue(chain);
    const qc = makeClient();
    const { result } = renderHook(() => useSaveSlotComment(), {
      wrapper: withClient(qc),
    });
    result.current.mutate({ sessionId: 's-1', slotId: 'sl-1', body: '   ' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(chain.delete).toHaveBeenCalled();
    expect(chain.eq).toHaveBeenCalledWith('exercise_slot_id', 'sl-1');
  });
});

// P25 — a note had no place on screen until the database had answered: saved
// without a network, the exercise went back to "Add note" as if nothing had
// been written. The requests below stay open until the test answers them.
describe('useSaveSlotComment — the note on screen', () => {
  const KEY = ['slot-comments', 's-1'];
  const OTHER = { id: 'sc-9', exercise_slot_id: 'sl-9', student_id: 'u-1', body: 'tight shoulder' };
  const MINE = { id: 'sc-1', exercise_slot_id: 'sl-1', student_id: 'u-1', body: 'felt heavy' };

  // What PostgREST answers when the policy turns the write down: the coach
  // reviewed the session in between.
  const REFUSED = {
    code: '42501',
    details: null,
    hint: null,
    message: 'new row violates row-level security policy for table "slot_comments"',
  };

  /**
   * A `slot_comments` table whose writes stay open until the test answers
   * them — `requests[n].land()` or `requests[n].refuse()` — and whose read
   * (`reads`) answers at once with what the table holds.
   */
  function fakeNotes(rows = []) {
    const server = new Map(rows.map((r) => [r.exercise_slot_id, { ...r }]));
    const requests = [];
    const api = { server, requests, reads: 0 };
    const hold = (request, apply) =>
      new Promise((resolve) => {
        request.land = () => resolve(apply());
        request.refuse = (error = REFUSED) => resolve({ data: null, error });
        requests.push(request);
      });
    supabase.from.mockImplementation(() => {
      const request = { kind: 'read' };
      const chain = {
        upsert(payload) {
          Object.assign(request, { kind: 'save', payload });
          return chain;
        },
        delete() {
          request.kind = 'delete';
          return chain;
        },
        select: () => chain,
        in: () => chain,
        eq(_column, slotId) {
          request.slotId = slotId;
          return chain;
        },
        single: () =>
          hold(request, () => {
            const slotId = request.payload.exercise_slot_id;
            const row = { id: `sc-${slotId}`, ...server.get(slotId), ...request.payload };
            server.set(slotId, row);
            return { data: { ...row }, error: null };
          }),
        then(resolve, reject) {
          if (request.kind === 'delete') {
            return hold(request, () => {
              server.delete(request.slotId);
              return { data: null, error: null };
            }).then(resolve, reject);
          }
          api.reads += 1;
          return Promise.resolve({ data: [...server.values()].map((r) => ({ ...r })), error: null }).then(
            resolve,
            reject,
          );
        },
      };
      return chain;
    });
    return api;
  }

  // Every client a test made, emptied when the test ends — see `afterEach`.
  const clients = [];

  function trustedClient() {
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

  // The session page, reduced to its notes and the save of one.
  function mount(api, { qc = trustedClient(), held = [...api.server.values()] } = {}) {
    if (held) qc.setQueryData(KEY, held.map((r) => ({ ...r })));
    const { result } = renderHook(
      () => ({
        notes: useSlotComments('s-1', [{ id: 'sl-1' }, { id: 'sl-9' }]),
        save: useSaveSlotComment(),
      }),
      { wrapper: withClient(qc) },
    );
    return { qc, result };
  }

  const noteOf = (qc, slotId) =>
    (qc.getQueryData(KEY) || []).find((c) => c.exercise_slot_id === slotId);
  const sent = (api, n) => waitFor(() => expect(api.requests).toHaveLength(n));

  function setNetwork(up) {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(up);
    act(() => {
      onlineManager.setOnline(up);
      window.dispatchEvent(new Event(up ? 'online' : 'offline'));
    });
  }

  beforeEach(() => {
    onlineManager.setOnline(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // The queues first, the network second: a test can end with a save parked
    // on its client, the hooks are still mounted here, and putting the manager
    // back online would send that save once its test is over.
    while (clients.length) clients.pop().clear();
    onlineManager.setOnline(true);
  });

  it('a new note appears at the tap, as the database will hold it, while its request is still open', async () => {
    const api = fakeNotes([OTHER]);
    const { qc, result } = mount(api);

    act(() => result.current.save.mutate({ sessionId: 's-1', slotId: 'sl-1', body: '  felt heavy  ' }));
    await sent(api, 1);

    expect(noteOf(qc, 'sl-1')).toMatchObject({ exercise_slot_id: 'sl-1', student_id: 'u-1', body: 'felt heavy' });
    // The note of the other exercise is the object it was.
    expect(result.current.notes.data).toHaveLength(2);
    expect(noteOf(qc, 'sl-9')).toEqual(OTHER);
    expect(api.reads).toBe(0);
  });

  it('a note that is rewritten keeps its row, with the new text', async () => {
    const api = fakeNotes([MINE, OTHER]);
    const { qc, result } = mount(api);

    act(() => result.current.save.mutate({ sessionId: 's-1', slotId: 'sl-1', body: 'felt light' }));
    await sent(api, 1);

    expect(noteOf(qc, 'sl-1')).toMatchObject({ id: 'sc-1', body: 'felt light' });
    expect(qc.getQueryData(KEY)).toHaveLength(2);
  });

  it('a note that is emptied goes at the tap', async () => {
    const api = fakeNotes([MINE, OTHER]);
    const { qc, result } = mount(api);

    act(() => result.current.save.mutate({ sessionId: 's-1', slotId: 'sl-1', body: '   ' }));
    await sent(api, 1);

    expect(api.requests[0].kind).toBe('delete');
    expect(noteOf(qc, 'sl-1')).toBeUndefined();
    expect(qc.getQueryData(KEY)).toEqual([OTHER]);
  });

  it('without a network the save waits, and the note is on screen', async () => {
    const api = fakeNotes([OTHER]);
    const { qc, result } = mount(api);
    setNetwork(false);

    act(() => result.current.save.mutate({ sessionId: 's-1', slotId: 'sl-1', body: 'felt heavy' }));
    await waitFor(() => expect(result.current.save.isPaused).toBe(true));

    expect(api.requests).toHaveLength(0);
    expect(noteOf(qc, 'sl-1')).toMatchObject({ body: 'felt heavy' });

    setNetwork(true);
    await sent(api, 1);
    act(() => api.requests[0].land());
    await waitFor(() => expect(result.current.save.isSuccess).toBe(true));
    expect(api.server.get('sl-1')).toMatchObject({ body: 'felt heavy', student_id: 'u-1' });
  });

  describe('a save the database refuses is taken back', () => {
    it.each([
      ['a new note goes', [OTHER], 'felt heavy', undefined],
      ['a rewritten note shows what it said before', [MINE, OTHER], 'felt light', MINE],
      ['an emptied note comes back', [MINE, OTHER], '', MINE],
    ])('%s', async (_name, rows, body, after) => {
      const api = fakeNotes(rows);
      const { qc, result } = mount(api);

      act(() => result.current.save.mutate({ sessionId: 's-1', slotId: 'sl-1', body }));
      await sent(api, 1);
      act(() => api.requests[0].refuse());
      await waitFor(() => expect(result.current.save.isError).toBe(true));

      expect(noteOf(qc, 'sl-1')).toEqual(after);
      expect(noteOf(qc, 'sl-9')).toEqual(OTHER);
    });

    // Two saves of the same note made without a network: what the athlete
    // sees is the second. On the app's client, whose defaults send them one
    // at a time, in order.
    it('…unless a newer save of the same note is waiting: its text stays', async () => {
      const api = fakeNotes([OTHER]);
      const qc = trustedClient();
      registerOfflineMutationDefaults(qc);
      const { result } = mount(api, { qc });
      setNetwork(false);
      act(() => result.current.save.mutate({ sessionId: 's-1', slotId: 'sl-1', body: 'felt heavy' }));
      await waitFor(() => expect(noteOf(qc, 'sl-1')?.body).toBe('felt heavy'));
      act(() => result.current.save.mutate({ sessionId: 's-1', slotId: 'sl-1', body: 'felt heavy, left elbow' }));
      await waitFor(() => expect(noteOf(qc, 'sl-1')?.body).toBe('felt heavy, left elbow'));

      setNetwork(true);
      await sent(api, 1);
      expect(api.requests[0].payload.body).toBe('felt heavy');
      act(() => api.requests[0].refuse());
      await sent(api, 2);

      expect(noteOf(qc, 'sl-1')).toMatchObject({ body: 'felt heavy, left elbow' });
      act(() => api.requests[1].land());
      await waitFor(() => expect(result.current.save.isSuccess).toBe(true));
      expect(noteOf(qc, 'sl-1')).toMatchObject({ body: 'felt heavy, left elbow' });
    });
  });

  // The session was read ahead by the training list and opened in the gym:
  // its notes were never read. That is the session a note is written in.
  describe('when the notes of the session were never read', () => {
    it('the note is shown all the same, and the entry is flagged to be read', async () => {
      const api = fakeNotes([]);
      const { qc, result } = mount(api, { held: null });
      setNetwork(false);
      expect(result.current.notes.data).toBeUndefined();

      act(() => result.current.save.mutate({ sessionId: 's-1', slotId: 'sl-1', body: 'felt heavy' }));
      await waitFor(() => expect(result.current.notes.data).toHaveLength(1));

      expect(noteOf(qc, 'sl-1')).toMatchObject({ exercise_slot_id: 'sl-1', student_id: 'u-1', body: 'felt heavy' });
      expect(qc.getQueryState(KEY).isInvalidated).toBe(true);
    });

    it('a refusal takes it off again, and the entry stays flagged', async () => {
      const api = fakeNotes([]);
      const qc = trustedClient();
      const { result } = renderHook(() => useSaveSlotComment(), { wrapper: withClient(qc) });

      act(() => result.current.mutate({ sessionId: 's-1', slotId: 'sl-1', body: 'felt heavy' }));
      await sent(api, 1);
      expect(qc.getQueryData(KEY)).toHaveLength(1);
      act(() => api.requests[0].refuse());
      await waitFor(() => expect(result.current.isError).toBe(true));

      expect(qc.getQueryData(KEY)).toEqual([]);
      expect(qc.getQueryState(KEY).isInvalidated).toBe(true);
    });

    it('an empty note makes no entry: there is nothing to show', async () => {
      const api = fakeNotes([]);
      const qc = trustedClient();
      const { result } = renderHook(() => useSaveSlotComment(), { wrapper: withClient(qc) });

      act(() => result.current.mutate({ sessionId: 's-1', slotId: 'sl-1', body: '  ' }));
      await sent(api, 1);

      expect(qc.getQueryData(KEY)).toBeUndefined();
    });
  });

  // A guess is not a read: stamped as read at the tap, notes that were due to
  // be asked for again would count as fresh.
  it('the notes keep the age of their last read', async () => {
    const api = fakeNotes([OTHER]);
    const { qc, result } = mount(api);
    const readAt = qc.getQueryState(KEY).dataUpdatedAt;
    await new Promise((resolve) => setTimeout(resolve, 5));

    act(() => result.current.save.mutate({ sessionId: 's-1', slotId: 'sl-1', body: 'felt heavy' }));
    await sent(api, 1);

    expect(noteOf(qc, 'sl-1')).toBeDefined();
    expect(qc.getQueryState(KEY).dataUpdatedAt).toBe(readAt);
  });

  // Reading the notes again once the save has settled is the `onSettled` that
  // `registerOfflineMutationDefaults` registers for the key, which also
  // serves a note replayed after a relaunch. An option a hook sets REPLACES
  // the default of the same name, so the hook sets none.
  describe('the hook reads nothing by itself', () => {
    it('a save that lands is followed by no read', async () => {
      const api = fakeNotes([OTHER]);
      const { result } = mount(api);

      act(() => result.current.save.mutate({ sessionId: 's-1', slotId: 'sl-1', body: 'felt heavy' }));
      await sent(api, 1);
      act(() => api.requests[0].land());
      await waitFor(() => expect(result.current.save.isSuccess).toBe(true));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });

      expect(api.reads).toBe(0);
    });

    it('it leaves the refresh registered for its key in place', async () => {
      const api = fakeNotes([OTHER]);
      const qc = trustedClient();
      const refresh = vi.fn();
      qc.setMutationDefaults(MUTATION_KEYS.saveSlotComment, { onSettled: refresh });
      const { result } = mount(api, { qc });

      act(() => result.current.save.mutate({ sessionId: 's-1', slotId: 'sl-1', body: 'felt heavy' }));
      await sent(api, 1);
      expect(refresh).not.toHaveBeenCalled();
      act(() => api.requests[0].land());
      await waitFor(() => expect(result.current.save.isSuccess).toBe(true));

      expect(refresh).toHaveBeenCalledTimes(1);
      const [, error, written] = refresh.mock.calls[0];
      expect(error).toBeNull();
      // The session is in the variables: the default reads `sessionId` there.
      expect(written).toBe(qc.getMutationCache().getAll()[0].state.variables);
      expect(written).toMatchObject({ sessionId: 's-1', slotId: 'sl-1', studentId: 'u-1' });
    });
  });

  // The same save on the client the app builds. It needs the `onSettled`
  // default of the note's key, which `registerOfflineMutationDefaults` gives
  // it (lib/offlineMutations.js).
  describe("on the app's client, the notes are read again once the save has settled", () => {
    it('one read follows it, and brings the row of the database', async () => {
      const api = fakeNotes([OTHER]);
      const qc = trustedClient();
      registerOfflineMutationDefaults(qc);
      const { result } = mount(api, { qc });

      act(() => result.current.save.mutate({ sessionId: 's-1', slotId: 'sl-1', body: 'felt heavy' }));
      await sent(api, 1);
      expect(api.reads).toBe(0);
      act(() => api.requests[0].land());
      await waitFor(() => expect(result.current.save.isSuccess).toBe(true));

      await waitFor(() => expect(api.reads).toBe(1));
      await waitFor(() => expect(result.current.notes.isFetching).toBe(false));
      expect(noteOf(qc, 'sl-1')).toMatchObject({ id: 'sc-sl-1', body: 'felt heavy' });
    });
  });
});
