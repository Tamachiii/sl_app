import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useSetLogs,
  useEnsureSetLogs,
  useToggleSetDone,
  useSetRpe,
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

describe('useEnsureSetLogs', () => {
  it('inserts only the missing (slot_id, set_number) combinations', async () => {
    const selectChain = {
      select: vi.fn().mockReturnThis(),
      in: vi.fn().mockResolvedValue({
        data: [{ exercise_slot_id: 'sl-1', set_number: 1 }],
        error: null,
      }),
    };
    const insertChain = {
      insert: vi.fn().mockResolvedValue({ error: null }),
    };
    let call = 0;
    supabase.from.mockImplementation(() => (call++ === 0 ? selectChain : insertChain));

    const qc = makeClient();
    const { result } = renderHook(() => useEnsureSetLogs(), { wrapper: withClient(qc) });

    result.current.mutate({
      sessionId: 'sess-1',
      slots: [
        {
          id: 'sl-1',
          sets: 3,
          reps: 10,
          duration_seconds: null,
          weight_kg: 50,
          rest_seconds: 60,
        },
      ],
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const inserted = insertChain.insert.mock.calls[0][0];
    expect(inserted).toHaveLength(2);
    expect(inserted.map((r) => r.set_number)).toEqual([2, 3]);
    expect(inserted[0].target_reps).toBe(10);
    expect(inserted[0].target_weight_kg).toBe(50);
    expect(inserted[0].target_rest_seconds).toBe(60);
    expect(inserted[0].done).toBe(false);
  });

  it('does not insert when all logs already exist', async () => {
    const selectChain = {
      select: vi.fn().mockReturnThis(),
      in: vi.fn().mockResolvedValue({
        data: [
          { exercise_slot_id: 'sl-1', set_number: 1 },
          { exercise_slot_id: 'sl-1', set_number: 2 },
        ],
        error: null,
      }),
    };
    const insertChain = { insert: vi.fn() };
    let call = 0;
    supabase.from.mockImplementation(() => (call++ === 0 ? selectChain : insertChain));

    const qc = makeClient();
    const { result } = renderHook(() => useEnsureSetLogs(), { wrapper: withClient(qc) });
    result.current.mutate({
      sessionId: 'sess-1',
      slots: [{ id: 'sl-1', sets: 2 }],
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(insertChain.insert).not.toHaveBeenCalled();
  });
});

describe('useToggleSetDone', () => {
  function makeUpdateChain(result) {
    return {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue(result),
    };
  }

  it('writes done + a logged_at timestamp on done=true', async () => {
    const chain = makeUpdateChain({ data: { id: 'l-1', done: true }, error: null });
    supabase.from.mockReturnValue(chain);

    const qc = makeClient();
    const { result } = renderHook(() => useToggleSetDone(), { wrapper: withClient(qc) });
    result.current.mutate({ logId: 'l-1', done: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const payload = chain.update.mock.calls[0][0];
    expect(payload.done).toBe(true);
    expect(typeof payload.logged_at).toBe('string');
  });

  it('clears logged_at when done=false', async () => {
    const chain = makeUpdateChain({ data: { id: 'l-1', done: false }, error: null });
    supabase.from.mockReturnValue(chain);

    const qc = makeClient();
    const { result } = renderHook(() => useToggleSetDone(), { wrapper: withClient(qc) });
    result.current.mutate({ logId: 'l-1', done: false });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const payload = chain.update.mock.calls[0][0];
    expect(payload.done).toBe(false);
    expect(payload.logged_at).toBeNull();
  });

  it('optimistically flips done across all matching ["set-logs"] caches', async () => {
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

describe('useSetRpe', () => {
  it('writes rpe and invalidates ["set-logs"]', async () => {
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
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['set-logs'] });
  });
});
