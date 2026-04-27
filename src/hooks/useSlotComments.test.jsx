import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../lib/supabase', () => ({ supabase: { from: vi.fn() } }));
vi.mock('./useAuth', () => ({ useAuth: vi.fn() }));

import { useSlotComments, useSaveSlotComment } from './useSlotComments';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';

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
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
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
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['slot-comments', 's-1'] });
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
