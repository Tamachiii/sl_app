import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../lib/supabase', () => ({ supabase: { from: vi.fn() } }));
vi.mock('./useAuth', () => ({ useAuth: vi.fn() }));

import {
  useExerciseLibrary,
  useCreateExercise,
  useUpdateExercise,
  useDeleteExercise,
} from './useExerciseLibrary';
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
  useAuth.mockReturnValue({ user: { id: 'coach-1' } });
});

describe('useExerciseLibrary', () => {
  it('lists exercises ordered by name', async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({
        data: [{ id: 'e-1', name: 'Squat' }],
        error: null,
      }),
    };
    supabase.from.mockReturnValue(chain);
    const qc = makeClient();
    const { result } = renderHook(() => useExerciseLibrary(), { wrapper: withClient(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(chain.order).toHaveBeenCalledWith('name');
  });

  it('is disabled when no user', async () => {
    useAuth.mockReturnValue({ user: null });
    const qc = makeClient();
    const { result } = renderHook(() => useExerciseLibrary(), { wrapper: withClient(qc) });
    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
    expect(supabase.from).not.toHaveBeenCalled();
  });
});

describe('useCreateExercise', () => {
  it('injects coach_id from auth on insert', async () => {
    const chain = {
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { id: 'e-new' }, error: null }),
    };
    supabase.from.mockReturnValue(chain);

    const qc = makeClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useCreateExercise(), { wrapper: withClient(qc) });
    result.current.mutate({ name: 'OHP', type: 'push' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(chain.insert).toHaveBeenCalledWith({
      name: 'OHP',
      type: 'push',
      coach_id: 'coach-1',
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['exercise-library'] });
  });
});

describe('useUpdateExercise', () => {
  it('does NOT touch coach_id on update', async () => {
    const chain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { id: 'e-1' }, error: null }),
    };
    supabase.from.mockReturnValue(chain);
    const qc = makeClient();
    const { result } = renderHook(() => useUpdateExercise(), { wrapper: withClient(qc) });
    result.current.mutate({ id: 'e-1', difficulty: 5 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(chain.update).toHaveBeenCalledWith({ difficulty: 5 });
    expect(chain.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ coach_id: expect.anything() }),
    );
  });
});

describe('useDeleteExercise', () => {
  it('deletes by id and invalidates the library', async () => {
    const chain = {
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: null }),
    };
    supabase.from.mockReturnValue(chain);
    const qc = makeClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useDeleteExercise(), { wrapper: withClient(qc) });
    result.current.mutate('e-1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(chain.eq).toHaveBeenCalledWith('id', 'e-1');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['exercise-library'] });
  });
});
