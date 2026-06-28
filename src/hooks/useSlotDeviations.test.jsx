import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useSlotDeviations, useSaveSlotDeviation } from './useSlotDeviations';
import { supabase } from '../lib/supabase';

vi.mock('../lib/supabase', () => ({ supabase: { from: vi.fn() } }));
vi.mock('./useAuth', () => ({ useAuth: () => ({ user: { id: 'student-1' } }) }));

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
}
function withClient(qc) {
  return ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => vi.clearAllMocks());

describe('useSlotDeviations (query)', () => {
  it('returns [] with no slots and never hits supabase', async () => {
    const qc = makeClient();
    const { result } = renderHook(() => useSlotDeviations('sess-1', []), { wrapper: withClient(qc) });
    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('fetches slot_deviations for the supplied slots', async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      in: vi.fn().mockResolvedValue({
        data: [{ id: 'd-1', exercise_slot_id: 'sl-1', kind: 'swap' }],
        error: null,
      }),
    };
    supabase.from.mockReturnValue(chain);

    const qc = makeClient();
    const { result } = renderHook(
      () => useSlotDeviations('sess-1', [{ id: 'sl-1' }]),
      { wrapper: withClient(qc) },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(supabase.from).toHaveBeenCalledWith('slot_deviations');
    expect(chain.in).toHaveBeenCalledWith('exercise_slot_id', ['sl-1']);
    expect(result.current.data).toHaveLength(1);
  });
});

describe('useSaveSlotDeviation', () => {
  it('upserts a swap with the substitute and injects the studentId', async () => {
    const chain = {
      upsert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { id: 'd-1' }, error: null }),
    };
    supabase.from.mockReturnValue(chain);

    const qc = makeClient();
    const { result } = renderHook(() => useSaveSlotDeviation(), { wrapper: withClient(qc) });
    result.current.mutate({ sessionId: 'sess-1', slotId: 'sl-1', kind: 'swap', substituteExerciseId: 'ex-9' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [payload, opts] = chain.upsert.mock.calls[0];
    expect(payload).toMatchObject({
      exercise_slot_id: 'sl-1',
      student_id: 'student-1',
      kind: 'swap',
      substitute_exercise_id: 'ex-9',
    });
    expect(opts).toEqual({ onConflict: 'exercise_slot_id' });
  });

  it('forces substitute to null for a skip', async () => {
    const chain = {
      upsert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { id: 'd-1' }, error: null }),
    };
    supabase.from.mockReturnValue(chain);

    const qc = makeClient();
    const { result } = renderHook(() => useSaveSlotDeviation(), { wrapper: withClient(qc) });
    result.current.mutate({ sessionId: 'sess-1', slotId: 'sl-1', kind: 'skip', substituteExerciseId: 'ex-9' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(chain.upsert.mock.calls[0][0].substitute_exercise_id).toBeNull();
  });

  it('deletes the row when kind is null (clearing the deviation)', async () => {
    const chain = {
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: null }),
    };
    supabase.from.mockReturnValue(chain);

    const qc = makeClient();
    const { result } = renderHook(() => useSaveSlotDeviation(), { wrapper: withClient(qc) });
    result.current.mutate({ sessionId: 'sess-1', slotId: 'sl-1', kind: null });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(chain.delete).toHaveBeenCalled();
    expect(chain.eq).toHaveBeenCalledWith('exercise_slot_id', 'sl-1');
  });

  it('optimistically writes then clears the ["slot-deviations", sessionId] cache', async () => {
    let resolveUpsert;
    const chain = {
      upsert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn(() => new Promise((res) => { resolveUpsert = res; })),
    };
    supabase.from.mockReturnValue(chain);

    const qc = makeClient();
    qc.setQueryData(['slot-deviations', 'sess-1'], []);
    const { result } = renderHook(() => useSaveSlotDeviation(), { wrapper: withClient(qc) });
    act(() => result.current.mutate({ sessionId: 'sess-1', slotId: 'sl-1', kind: 'skip' }));

    await waitFor(() => {
      const rows = qc.getQueryData(['slot-deviations', 'sess-1']);
      expect(rows.find((d) => d.exercise_slot_id === 'sl-1')?.kind).toBe('skip');
    });

    act(() => resolveUpsert({ data: { id: 'd-1' }, error: null }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });
});
