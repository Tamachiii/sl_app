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

// The library as one account may read it under RLS: its own rows, plus the
// rows of the coach it is an athlete of. `libraryTable` applies the request's
// `.eq()` filters to that, as PostgREST would.
function libraryTable(visible) {
  const filters = [];
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn((column, value) => {
      filters.push([column, value]);
      return chain;
    }),
    order: vi.fn(async () => ({
      data: visible.filter((row) => filters.every(([column, value]) => row[column] === value)),
      error: null,
    })),
  };
  supabase.from.mockReturnValue(chain);
  return chain;
}

const cachedKeys = (qc) => qc.getQueryCache().getAll().map((q) => q.queryKey);

describe('useExerciseLibrary', () => {
  it('lists exercises ordered by name', async () => {
    const chain = libraryTable([{ id: 'e-1', name: 'Squat', coach_id: 'coach-1' }]);
    const qc = makeClient();
    const { result } = renderHook(() => useExerciseLibrary(), { wrapper: withClient(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(supabase.from).toHaveBeenCalledWith('exercise_library');
    expect(chain.order).toHaveBeenCalledWith('name');
  });

  it('is disabled when no user', async () => {
    useAuth.mockReturnValue({ user: null });
    const qc = makeClient();
    const { result } = renderHook(() => useExerciseLibrary(), { wrapper: withClient(qc) });
    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
    expect(supabase.from).not.toHaveBeenCalled();
  });

  describe('for a coach', () => {
    beforeEach(() => {
      useAuth.mockReturnValue({ user: { id: 'coach-1' }, role: 'coach' });
    });

    it('asks for the coach’s own rows', async () => {
      const chain = libraryTable([]);
      const qc = makeClient();
      const { result } = renderHook(() => useExerciseLibrary(), { wrapper: withClient(qc) });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(chain.eq).toHaveBeenCalledTimes(1);
      expect(chain.eq).toHaveBeenCalledWith('coach_id', 'coach-1');
    });

    // A coach who trains under another coach may READ that coach's library
    // (the athlete policy). It is not theirs to prescribe from.
    it('does not mix in the library of a coach they are an athlete of', async () => {
      libraryTable([
        { id: 'e-1', name: 'Dip', coach_id: 'coach-1' },
        { id: 'e-x', name: 'Front lever', coach_id: 'coach-other' },
        { id: 'e-2', name: 'Pull-up', coach_id: 'coach-1' },
      ]);
      const qc = makeClient();
      const { result } = renderHook(() => useExerciseLibrary(), { wrapper: withClient(qc) });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data.map((e) => e.id)).toEqual(['e-1', 'e-2']);
      expect(qc.getQueryData(['exercise-library']).map((e) => e.id)).toEqual(['e-1', 'e-2']);
    });

    // The key is shared and persisted, so the cache can hold a list that was
    // read without the filter: by the previous client on this device, or
    // before the profile had loaded.
    it('hides a foreign row the cache already holds, before any refetch', () => {
      const chain = libraryTable([]);
      const qc = makeClient();
      qc.setQueryDefaults(['exercise-library'], { staleTime: Infinity });
      qc.setQueryData(['exercise-library'], [
        { id: 'e-1', name: 'Dip', coach_id: 'coach-1' },
        { id: 'e-x', name: 'Front lever', coach_id: 'coach-other' },
      ]);
      const { result } = renderHook(() => useExerciseLibrary(), { wrapper: withClient(qc) });
      expect(result.current.data.map((e) => e.id)).toEqual(['e-1']);
      expect(chain.order).not.toHaveBeenCalled();
    });

    it('drops the foreign rows of a list read before the role was known, when the role arrives', async () => {
      useAuth.mockReturnValue({ user: { id: 'coach-1' }, role: null });
      const chain = libraryTable([
        { id: 'e-1', name: 'Dip', coach_id: 'coach-1' },
        { id: 'e-x', name: 'Front lever', coach_id: 'coach-other' },
      ]);
      const qc = makeClient();
      qc.setQueryDefaults(['exercise-library'], { staleTime: Infinity });
      const { result, rerender } = renderHook(() => useExerciseLibrary(), { wrapper: withClient(qc) });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      // No role yet: the request cannot name a coach, and nothing is hidden.
      expect(chain.eq).not.toHaveBeenCalled();
      expect(result.current.data).toHaveLength(2);

      useAuth.mockReturnValue({ user: { id: 'coach-1' }, role: 'coach' });
      rerender();
      expect(result.current.data.map((e) => e.id)).toEqual(['e-1']);
      // Same key, still fresh: this is the cached list, not a second read.
      expect(chain.order).toHaveBeenCalledTimes(1);
    });
  });

  describe('for an athlete', () => {
    beforeEach(() => {
      useAuth.mockReturnValue({ user: { id: 'athlete-1' }, role: 'student' });
    });

    // `coach_id = <athlete id>` matches nothing: the swap picker and the
    // program builder would be empty.
    it('sends no coach filter and gets the library RLS gives them', async () => {
      const chain = libraryTable([
        { id: 'e-1', name: 'Dip', coach_id: 'coach-1' },
        { id: 'e-2', name: 'Pull-up', coach_id: 'coach-1' },
      ]);
      const qc = makeClient();
      const { result } = renderHook(() => useExerciseLibrary(), { wrapper: withClient(qc) });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(chain.eq).not.toHaveBeenCalled();
      expect(result.current.data.map((e) => e.id)).toEqual(['e-1', 'e-2']);
    });

    it('is handed the cached list as it is', () => {
      libraryTable([]);
      const qc = makeClient();
      qc.setQueryDefaults(['exercise-library'], { staleTime: Infinity });
      const cached = [{ id: 'e-1', name: 'Dip', coach_id: 'coach-1' }];
      qc.setQueryData(['exercise-library'], cached);
      const { result } = renderHook(() => useExerciseLibrary(), { wrapper: withClient(qc) });
      expect(result.current.data).toBe(cached);
    });
  });

  // 'exercise-library' is a persisted root: the entry an athlete's device
  // holds names their exercises offline. A key per user or per role would
  // leave that entry unread.
  it('uses the one persisted key, [exercise-library], for both roles', async () => {
    for (const auth of [
      { user: { id: 'coach-1' }, role: 'coach' },
      { user: { id: 'athlete-1' }, role: 'student' },
    ]) {
      useAuth.mockReturnValue(auth);
      libraryTable([]);
      const qc = makeClient();
      const { result } = renderHook(() => useExerciseLibrary(), { wrapper: withClient(qc) });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(cachedKeys(qc)).toEqual([['exercise-library']]);
    }
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
