import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  setLogsQueryOptions,
  useSetLogs,
  useToggleSetDone,
  useSetFailed,
  useSetRpe,
  useLogActual,
  useSetSkipped,
  useAddStudentSet,
  useRemoveStudentSet,
} from './useSetLogs';
import { supabase } from '../lib/supabase';

vi.mock('../lib/supabase', () => ({ supabase: { from: vi.fn() } }));

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
});

describe('useSetLogs (query)', () => {
  it('returns [] when there are no slots', async () => {
    const qc = makeClient();
    const { result } = renderHook(() => useSetLogs('sess-1', []), {
      wrapper: withClient(qc),
    });
    // Disabled query — returns undefined data; fetchStatus 'idle'.
    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('fetches set_logs for the supplied slots', async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({
        data: [{ id: 'l-1', exercise_slot_id: 'sl-1', set_number: 1, done: false }],
        error: null,
      }),
    };
    supabase.from.mockReturnValue(chain);

    const qc = makeClient();
    const { result } = renderHook(
      () => useSetLogs('sess-1', [{ id: 'sl-1' }]),
      { wrapper: withClient(qc) },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(supabase.from).toHaveBeenCalledWith('set_logs');
    expect(chain.in).toHaveBeenCalledWith('exercise_slot_id', ['sl-1']);
    expect(result.current.data).toHaveLength(1);
  });
});

// The athlete's training list reads the sets of the next session ahead through
// these very options, so that the session page finds them in the cache.
describe('setLogsQueryOptions', () => {
  it('is the read useSetLogs mounts: what was fetched through it, the hook shows without asking', async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({
        data: [{ id: 'l-1', exercise_slot_id: 'sl-1', set_number: 1, done: false }],
        error: null,
      }),
    };
    supabase.from.mockReturnValue(chain);
    // Trusted for a while, as on the app's client.
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: 60_000 } },
    });

    const ahead = await qc.fetchQuery(setLogsQueryOptions('sess-1', [{ id: 'sl-2' }, { id: 'sl-1' }]));
    expect(chain.in).toHaveBeenCalledWith('exercise_slot_id', ['sl-1', 'sl-2']);

    // The page hands its slots over in the order of the session; the key does
    // not depend on it.
    const { result } = renderHook(
      () => useSetLogs('sess-1', [{ id: 'sl-1' }, { id: 'sl-2' }]),
      { wrapper: withClient(qc) },
    );
    expect(result.current.data).toBe(ahead);
    expect(result.current.isLoading).toBe(false);
    expect(supabase.from).toHaveBeenCalledTimes(1);
  });

  it('keys the read by the session and its exercises, sorted', () => {
    expect(setLogsQueryOptions('sess-1', [{ id: 'sl-2' }, { id: 'sl-1' }]).queryKey).toEqual([
      'set-logs',
      'sess-1',
      ['sl-1', 'sl-2'],
    ]);
  });

  // See sessionQueryOptions: how long a read is trusted and kept is the
  // client's decision, per root.
  it('says what to read and nothing about how long to trust or keep it', () => {
    const options = setLogsQueryOptions('sess-1', [{ id: 'sl-1' }]);
    expect(Object.keys(options).sort()).toEqual(['enabled', 'queryFn', 'queryKey']);
    expect(options.enabled).toBe(true);
    expect(setLogsQueryOptions('sess-1', []).enabled).toBe(false);
    expect(setLogsQueryOptions(undefined, [{ id: 'sl-1' }]).enabled).toBe(false);
  });
});

// `useEnsureSetLogs` — the sets a session is short of, asked of the database
// when the page can tell that one is missing — has a file of its own:
// useSetLogs.ensure.test.jsx.

describe('useToggleSetDone', () => {
  function makeUpdateChain(result) {
    return {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue(result),
    };
  }

  it('writes done + a logged_at timestamp + clears any prior failed flag', async () => {
    const chain = makeUpdateChain({ data: { id: 'l-1', done: true }, error: null });
    supabase.from.mockReturnValue(chain);

    const qc = makeClient();
    const { result } = renderHook(() => useToggleSetDone(), { wrapper: withClient(qc) });
    result.current.mutate({ logId: 'l-1', done: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const payload = chain.update.mock.calls[0][0];
    expect(payload.done).toBe(true);
    expect(typeof payload.logged_at).toBe('string');
    expect(payload.failed).toBe(false);
    expect(payload.failed_at).toBeNull();
  });

  it('clears logged_at when done=false (without touching failed)', async () => {
    const chain = makeUpdateChain({ data: { id: 'l-1', done: false }, error: null });
    supabase.from.mockReturnValue(chain);

    const qc = makeClient();
    const { result } = renderHook(() => useToggleSetDone(), { wrapper: withClient(qc) });
    result.current.mutate({ logId: 'l-1', done: false });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const payload = chain.update.mock.calls[0][0];
    expect(payload.done).toBe(false);
    expect(payload.logged_at).toBeNull();
    expect('failed' in payload).toBe(false);
  });

  it('optimistically flips done on the row, in the ["set-logs"] cache that holds it', async () => {
    // Resolve the mutation manually so we can inspect the cache during onMutate.
    let resolveUpdate;
    const chain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn(() =>
        new Promise((res) => {
          resolveUpdate = res;
        }),
      ),
    };
    supabase.from.mockReturnValue(chain);

    const qc = makeClient();
    qc.setQueryData(['set-logs', 'sess-1', ['sl-1']], [
      { id: 'l-1', done: false, logged_at: null },
      { id: 'l-2', done: false, logged_at: null },
    ]);
    qc.setQueryData(['set-logs', 'sess-2', ['sl-2']], [
      { id: 'l-9', done: false, logged_at: null },
    ]);

    const { result } = renderHook(() => useToggleSetDone(), { wrapper: withClient(qc) });
    act(() => {
      result.current.mutate({ logId: 'l-1', done: true });
    });

    // Optimistic update has flipped l-1 in the first cache.
    await waitFor(() => {
      const cache1 = qc.getQueryData(['set-logs', 'sess-1', ['sl-1']]);
      expect(cache1.find((l) => l.id === 'l-1').done).toBe(true);
    });
    const cache2 = qc.getQueryData(['set-logs', 'sess-2', ['sl-2']]);
    expect(cache2[0].done).toBe(false);

    // Let the mutation resolve.
    act(() => {
      resolveUpdate({ data: { id: 'l-1', done: true }, error: null });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it('rolls back the cache when the mutation errors', async () => {
    const chain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null, error: { message: 'nope' } }),
    };
    supabase.from.mockReturnValue(chain);

    const qc = makeClient();
    const initial = [
      { id: 'l-1', done: false, logged_at: null },
      { id: 'l-2', done: false, logged_at: null },
    ];
    qc.setQueryData(['set-logs', 'sess-1', ['sl-1']], initial);

    const { result } = renderHook(() => useToggleSetDone(), { wrapper: withClient(qc) });
    act(() => {
      result.current.mutate({ logId: 'l-1', done: true });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));

    const restored = qc.getQueryData(['set-logs', 'sess-1', ['sl-1']]);
    expect(restored.find((l) => l.id === 'l-1').done).toBe(false);
  });
});

describe('useSetFailed', () => {
  function makeUpdateChain(result) {
    return {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue(result),
    };
  }

  it('writes failed=true + failed_at + clears any prior done + nulls rpe', async () => {
    const chain = makeUpdateChain({ data: { id: 'l-1', failed: true }, error: null });
    supabase.from.mockReturnValue(chain);

    const qc = makeClient();
    const { result } = renderHook(() => useSetFailed(), { wrapper: withClient(qc) });
    result.current.mutate({ logId: 'l-1', failed: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const payload = chain.update.mock.calls[0][0];
    expect(payload.failed).toBe(true);
    expect(typeof payload.failed_at).toBe('string');
    expect(payload.done).toBe(false);
    expect(payload.logged_at).toBeNull();
    expect(payload.rpe).toBeNull();
  });

  it('clears failed_at when failed=false (rpe is left alone)', async () => {
    const chain = makeUpdateChain({ data: { id: 'l-1', failed: false }, error: null });
    supabase.from.mockReturnValue(chain);

    const qc = makeClient();
    const { result } = renderHook(() => useSetFailed(), { wrapper: withClient(qc) });
    result.current.mutate({ logId: 'l-1', failed: false });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const payload = chain.update.mock.calls[0][0];
    expect(payload.failed).toBe(false);
    expect(payload.failed_at).toBeNull();
    expect('done' in payload).toBe(false);
    expect('rpe' in payload).toBe(false);
  });

  it('optimistically flips failed in matching ["set-logs"] caches', async () => {
    let resolveUpdate;
    const chain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn(() =>
        new Promise((res) => {
          resolveUpdate = res;
        }),
      ),
    };
    supabase.from.mockReturnValue(chain);

    const qc = makeClient();
    qc.setQueryData(['set-logs', 'sess-1', ['sl-1']], [
      { id: 'l-1', done: false, failed: false, logged_at: null, failed_at: null, rpe: 8 },
    ]);

    const { result } = renderHook(() => useSetFailed(), { wrapper: withClient(qc) });
    act(() => {
      result.current.mutate({ logId: 'l-1', failed: true });
    });

    await waitFor(() => {
      const cache = qc.getQueryData(['set-logs', 'sess-1', ['sl-1']]);
      const log = cache.find((l) => l.id === 'l-1');
      expect(log.failed).toBe(true);
      // The orphan RPE is wiped optimistically on the same patch.
      expect(log.rpe).toBeNull();
    });

    act(() => {
      resolveUpdate({ data: { id: 'l-1', failed: true }, error: null });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });
});

describe('useSetRpe', () => {
  // The hook asks for no read of the sets itself: that is the `onSettled` the
  // mutation defaults register for the key — useSetLogs.optimistic.test.jsx.
  it('writes rpe, and reads nothing again by itself', async () => {
    const chain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { id: 'l-1', rpe: 8 }, error: null }),
    };
    supabase.from.mockReturnValue(chain);

    const qc = makeClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useSetRpe(), { wrapper: withClient(qc) });
    result.current.mutate({ logId: 'l-1', rpe: 8 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(chain.update).toHaveBeenCalledWith({ rpe: 8 });
    expect(invalidate).not.toHaveBeenCalled();
  });

  // P27 — a rating given on a pending set marks it done: SetRow says so with
  // `done: true`, and the rating and the done fields leave in ONE update.
  it('with `done: true`, writes the rating and the set done in one update', async () => {
    const chain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { id: 'l-1', rpe: 8, done: true }, error: null }),
    };
    supabase.from.mockReturnValue(chain);

    const qc = makeClient();
    const { result } = renderHook(() => useSetRpe(), { wrapper: withClient(qc) });
    result.current.mutate({ logId: 'l-1', rpe: 8, done: true });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(chain.update).toHaveBeenCalledTimes(1);
    expect(chain.update).toHaveBeenCalledWith({
      rpe: 8,
      done: true,
      failed: false,
      logged_at: expect.any(String),
      failed_at: null,
    });
    expect(chain.eq).toHaveBeenCalledWith('id', 'l-1');
  });
});

describe('useLogActual', () => {
  function makeUpdateChain(result) {
    return {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue(result),
    };
  }

  it('writes only the actual_* columns (never touches target_* or outcomes)', async () => {
    const chain = makeUpdateChain({ data: { id: 'l-1' }, error: null });
    supabase.from.mockReturnValue(chain);

    const qc = makeClient();
    const { result } = renderHook(() => useLogActual(), { wrapper: withClient(qc) });
    result.current.mutate({ logId: 'l-1', actualReps: 8, actualWeightKg: 100 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const payload = chain.update.mock.calls[0][0];
    expect(payload).toEqual({ actual_reps: 8, actual_weight_kg: 100 });
    expect(chain.eq).toHaveBeenCalledWith('id', 'l-1');
  });

  it('with `done: true`, writes the values and the set done in one update (P27)', async () => {
    const chain = makeUpdateChain({ data: { id: 'l-1' }, error: null });
    supabase.from.mockReturnValue(chain);

    const qc = makeClient();
    const { result } = renderHook(() => useLogActual(), { wrapper: withClient(qc) });
    result.current.mutate({ logId: 'l-1', actualReps: 8, actualWeightKg: null, done: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(chain.update).toHaveBeenCalledTimes(1);
    expect(chain.update.mock.calls[0][0]).toEqual({
      actual_reps: 8,
      actual_weight_kg: null,
      done: true,
      failed: false,
      logged_at: expect.any(String),
      failed_at: null,
    });
  });

  it('coerces undefined/missing values to null so a clear persists', async () => {
    const chain = makeUpdateChain({ data: { id: 'l-1' }, error: null });
    supabase.from.mockReturnValue(chain);

    const qc = makeClient();
    const { result } = renderHook(() => useLogActual(), { wrapper: withClient(qc) });
    result.current.mutate({ logId: 'l-1', actualReps: null, actualWeightKg: undefined });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(chain.update.mock.calls[0][0]).toEqual({ actual_reps: null, actual_weight_kg: null });
  });

  it('optimistically patches actual_* into matching ["set-logs"] caches', async () => {
    let resolveUpdate;
    const chain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn(() => new Promise((res) => { resolveUpdate = res; })),
    };
    supabase.from.mockReturnValue(chain);

    const qc = makeClient();
    qc.setQueryData(['set-logs', 'sess-1', ['sl-1']], [
      { id: 'l-1', actual_reps: null, actual_weight_kg: null },
    ]);

    const { result } = renderHook(() => useLogActual(), { wrapper: withClient(qc) });
    act(() => {
      result.current.mutate({ logId: 'l-1', actualReps: 6, actualWeightKg: 90 });
    });

    await waitFor(() => {
      const log = qc.getQueryData(['set-logs', 'sess-1', ['sl-1']]).find((l) => l.id === 'l-1');
      expect(log.actual_reps).toBe(6);
      expect(log.actual_weight_kg).toBe(90);
    });

    act(() => resolveUpdate({ data: { id: 'l-1' }, error: null }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it('rolls back the cache when the mutation errors', async () => {
    const chain = makeUpdateChain({ data: null, error: { message: 'nope' } });
    supabase.from.mockReturnValue(chain);

    const qc = makeClient();
    qc.setQueryData(['set-logs', 'sess-1', ['sl-1']], [
      { id: 'l-1', actual_reps: null, actual_weight_kg: null },
    ]);

    const { result } = renderHook(() => useLogActual(), { wrapper: withClient(qc) });
    act(() => {
      result.current.mutate({ logId: 'l-1', actualReps: 6, actualWeightKg: 90 });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));

    const restored = qc.getQueryData(['set-logs', 'sess-1', ['sl-1']]).find((l) => l.id === 'l-1');
    expect(restored.actual_reps).toBeNull();
    expect(restored.actual_weight_kg).toBeNull();
  });
});

describe('useSetSkipped', () => {
  it('writes skipped=true and clears done/failed/rpe/actuals in one patch', async () => {
    const chain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { id: 'l-1', skipped: true }, error: null }),
    };
    supabase.from.mockReturnValue(chain);

    const qc = makeClient();
    const { result } = renderHook(() => useSetSkipped(), { wrapper: withClient(qc) });
    result.current.mutate({ logId: 'l-1', skipped: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const payload = chain.update.mock.calls[0][0];
    expect(payload.skipped).toBe(true);
    expect(payload.done).toBe(false);
    expect(payload.failed).toBe(false);
    expect(payload.rpe).toBeNull();
    expect(payload.actual_reps).toBeNull();
  });

  it('optimistically marks the set skipped across matching caches', async () => {
    let resolveUpdate;
    const chain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn(() => new Promise((res) => { resolveUpdate = res; })),
    };
    supabase.from.mockReturnValue(chain);

    const qc = makeClient();
    qc.setQueryData(['set-logs', 'sess-1', ['sl-1']], [
      { id: 'l-1', done: true, skipped: false, rpe: 7 },
    ]);

    const { result } = renderHook(() => useSetSkipped(), { wrapper: withClient(qc) });
    act(() => result.current.mutate({ logId: 'l-1', skipped: true }));

    await waitFor(() => {
      const log = qc.getQueryData(['set-logs', 'sess-1', ['sl-1']]).find((l) => l.id === 'l-1');
      expect(log.skipped).toBe(true);
      expect(log.done).toBe(false);
      expect(log.rpe).toBeNull();
    });

    act(() => resolveUpdate({ data: { id: 'l-1' }, error: null }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });
});

describe('useAddStudentSet', () => {
  it('inserts an is_student_added row at the supplied set_number', async () => {
    const chain = {
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { id: 'l-new' }, error: null }),
    };
    supabase.from.mockReturnValue(chain);

    const qc = makeClient();
    const { result } = renderHook(() => useAddStudentSet(), { wrapper: withClient(qc) });
    result.current.mutate({ slotId: 'sl-1', setNumber: 4 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const payload = chain.insert.mock.calls[0][0];
    expect(payload).toMatchObject({
      exercise_slot_id: 'sl-1',
      set_number: 4,
      is_student_added: true,
      done: false,
      failed: false,
    });
  });

  // P68: the Undo of a removed extra set.
  describe('with `restore`, the set the athlete removed', () => {
    const removed = {
      id: 'l-extra',
      exercise_slot_id: 'sl-1',
      set_number: 4,
      is_student_added: true,
      done: true,
      failed: false,
      rpe: 8,
      logged_at: '2026-10-15T18:02:11+00:00',
      failed_at: null,
      actual_reps: 8,
      actual_weight_kg: 100,
      target_reps: null,
      created_at: '2026-10-15T18:00:00+00:00',
    };
    const conflict = { code: '23505', message: 'duplicate key value violates unique constraint' };

    // Each `from('set_logs')` is one request, answered in turn.
    function setLogsAnswering(...answers) {
      const requests = [];
      supabase.from.mockImplementation(() => {
        const request = { answer: answers[requests.length] };
        requests.push(request);
        const chain = {
          insert: vi.fn((row) => {
            request.insert = row;
            return chain;
          }),
          select: vi.fn((columns) => {
            request.select = columns;
            return chain;
          }),
          eq: vi.fn((column, value) => {
            request.eq = [column, value];
            return chain;
          }),
          single: vi.fn(async () => request.answer),
          then: (resolve) => resolve(request.answer),
        };
        return chain;
      });
      return requests;
    }

    async function restore() {
      const qc = makeClient();
      const { result } = renderHook(() => useAddStudentSet(), { wrapper: withClient(qc) });
      let answer;
      await act(async () => {
        answer = await result.current.mutateAsync({ slotId: 'sl-1', setNumber: 4, restore: removed });
      });
      return answer;
    }

    it('inserts it again with its id and what it said was done — no target, no date of creation', async () => {
      const requests = setLogsAnswering({ data: { ...removed }, error: null });

      await restore();

      expect(requests).toHaveLength(1);
      expect(requests[0].insert).toEqual({
        id: 'l-extra',
        exercise_slot_id: 'sl-1',
        set_number: 4,
        is_student_added: true,
        done: true,
        failed: false,
        rpe: 8,
        logged_at: '2026-10-15T18:02:11+00:00',
        failed_at: null,
        actual_reps: 8,
        actual_weight_kg: 100,
      });
    });

    it('its number taken by a set added meanwhile, it comes back after the last set', async () => {
      const requests = setLogsAnswering(
        { data: null, error: conflict },
        {
          data: [
            { id: 'l-1', set_number: 1 },
            { id: 'l-2', set_number: 2 },
            { id: 'l-3', set_number: 3 },
            { id: 'l-new', set_number: 4 },
          ],
          error: null,
        },
        { data: { ...removed, set_number: 5 }, error: null },
      );

      const answer = await restore();

      expect(requests).toHaveLength(3);
      expect(requests[1].eq).toEqual(['exercise_slot_id', 'sl-1']);
      expect(requests[2].insert).toMatchObject({ id: 'l-extra', set_number: 5, done: true, rpe: 8 });
      expect(answer.set_number).toBe(5);
    });

    it('already back — its id is there — it is not inserted twice', async () => {
      const requests = setLogsAnswering(
        { data: null, error: conflict },
        { data: [{ id: 'l-extra', set_number: 4 }], error: null },
      );

      const answer = await restore();

      expect(requests).toHaveLength(2);
      expect(answer).toEqual({ id: 'l-extra', set_number: 4 });
    });

    it('a new extra set whose number is taken is refused, as it was', async () => {
      const requests = setLogsAnswering({ data: null, error: conflict });
      const qc = makeClient();
      const { result } = renderHook(() => useAddStudentSet(), { wrapper: withClient(qc) });

      await act(async () => {
        await expect(result.current.mutateAsync({ slotId: 'sl-1', setNumber: 4 })).rejects.toBe(conflict);
      });
      expect(requests).toHaveLength(1);
    });
  });
});

describe('useRemoveStudentSet', () => {
  // The query builder is thenable; delete().eq().eq().select() resolves to
  // the deleted rows.
  function deleteChain(answer) {
    const chain = {
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      then: (resolve) => resolve(answer),
    };
    supabase.from.mockReturnValue(chain);
    return chain;
  }

  it('deletes only the student-added row by id', async () => {
    const chain = deleteChain({ data: [{ id: 'l-extra' }], error: null });

    const qc = makeClient();
    const { result } = renderHook(() => useRemoveStudentSet(), { wrapper: withClient(qc) });
    result.current.mutate({ logId: 'l-extra' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(chain.delete).toHaveBeenCalled();
    expect(chain.eq).toHaveBeenCalledWith('id', 'l-extra');
    expect(chain.eq).toHaveBeenCalledWith('is_student_added', true);
  });

  // What an Undo puts back is what the database deleted, not the row of the
  // device's cache.
  it('answers the row as the database deleted it', async () => {
    const row = { id: 'l-extra', exercise_slot_id: 'sl-1', set_number: 4, done: true, rpe: 8, actual_reps: 8 };
    const chain = deleteChain({ data: [row], error: null });

    const qc = makeClient();
    const { result } = renderHook(() => useRemoveStudentSet(), { wrapper: withClient(qc) });
    let answer;
    await act(async () => {
      answer = await result.current.mutateAsync({ logId: 'l-extra' });
    });

    expect(chain.select).toHaveBeenCalled();
    expect(answer).toEqual({ logId: 'l-extra', removed: row });
  });

  // A DELETE the policy refuses is filtered: no error, no row.
  it('answers no row when nothing was deleted', async () => {
    deleteChain({ data: [], error: null });

    const qc = makeClient();
    const { result } = renderHook(() => useRemoveStudentSet(), { wrapper: withClient(qc) });
    let answer;
    await act(async () => {
      answer = await result.current.mutateAsync({ logId: 'l-extra' });
    });

    expect(answer).toEqual({ logId: 'l-extra', removed: null });
  });
});
