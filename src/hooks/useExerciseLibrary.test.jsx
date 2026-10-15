import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../lib/supabase', () => ({ supabase: { from: vi.fn() } }));
vi.mock('./useAuth', () => ({ useAuth: vi.fn() }));

import {
  useExerciseLibrary,
  isActiveExercise,
  useExerciseUsage,
  useCreateExercise,
  useUpdateExercise,
  useArchiveExercise,
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

describe('isActiveExercise', () => {
  it('is true while archived_at is empty', () => {
    expect(isActiveExercise({ id: 'e-1', archived_at: null })).toBe(true);
    // A row read before the column existed has no such field.
    expect(isActiveExercise({ id: 'e-1' })).toBe(true);
  });

  it('is false once the exercise is archived', () => {
    expect(isActiveExercise({ id: 'e-1', archived_at: '2026-10-11T08:00:00Z' })).toBe(false);
  });

  it('is false for a missing exercise, so it can filter a list as it is', () => {
    expect(isActiveExercise(null)).toBe(false);
    expect(isActiveExercise(undefined)).toBe(false);
    expect([{ id: 'a' }, { id: 'b', archived_at: '2026-10-11' }, undefined].filter(isActiveExercise)).toEqual([
      { id: 'a' },
    ]);
  });
});

describe('useExerciseUsage', () => {
  // One chain per table. `answers[table]` is what the server returns for it:
  // a HEAD read has no rows, only the count.
  function usageTables(answers) {
    const chains = {};
    supabase.from.mockImplementation((table) => {
      const chain = {
        select: vi.fn(() => chain),
        eq: vi.fn(async () => ({ data: null, error: null, ...answers[table] })),
      };
      chains[table] = chain;
      return chain;
    });
    return chains;
  }

  it('counts the slots, the goals and the swaps that point at the exercise', async () => {
    const chains = usageTables({
      exercise_slots: { count: 12 },
      goals: { count: 2 },
      slot_deviations: { count: 1 },
    });
    const { result } = renderHook(() => useExerciseUsage('e-1'), { wrapper: withClient(makeClient()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ slots: 12, goals: 2, swaps: 1 });

    // Counted by the server, nothing downloaded: a page of rows would cap the
    // number at 1000.
    for (const table of ['exercise_slots', 'goals', 'slot_deviations']) {
      expect(chains[table].select).toHaveBeenCalledWith('id', { count: 'exact', head: true });
    }
    expect(chains.exercise_slots.eq).toHaveBeenCalledWith('exercise_id', 'e-1');
    expect(chains.goals.eq).toHaveBeenCalledWith('exercise_id', 'e-1');
    // A swap points at the exercise through its own column.
    expect(chains.slot_deviations.eq).toHaveBeenCalledWith('substitute_exercise_id', 'e-1');
  });

  it('reads nothing without an exercise', async () => {
    usageTables({});
    const { result } = renderHook(() => useExerciseUsage(undefined), { wrapper: withClient(makeClient()) });
    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('fails as a whole when one of the three counts fails', async () => {
    usageTables({
      exercise_slots: { count: 0 },
      goals: { count: null, error: { message: 'permission denied', code: '42501' } },
      slot_deviations: { count: 0 },
    });
    const { result } = renderHook(() => useExerciseUsage('e-1'), { wrapper: withClient(makeClient()) });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });

  // The dialog deletes on "nothing uses it". A response without a count is
  // not that answer.
  it('treats a count that did not come back as an error, never as zero', async () => {
    usageTables({
      exercise_slots: { count: 0 },
      goals: { count: null },
      slot_deviations: { count: 0 },
    });
    const { result } = renderHook(() => useExerciseUsage('e-1'), { wrapper: withClient(makeClient()) });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });

  // The app's client serves a query from its cache for two minutes. These
  // numbers decide a delete, so a second look reads again.
  it('keeps nothing once it is no longer watched, whatever the client’s defaults', async () => {
    usageTables({ exercise_slots: { count: 0 }, goals: { count: 0 }, slot_deviations: { count: 0 } });
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 1000 * 60 * 2, gcTime: 1000 * 60 * 5 } },
    });
    const first = renderHook(() => useExerciseUsage('e-1'), { wrapper: withClient(qc) });
    await waitFor(() => expect(first.result.current.data).toEqual({ slots: 0, goals: 0, swaps: 0 }));
    first.unmount();
    await waitFor(() => expect(qc.getQueryData(['exercise-usage', 'e-1'])).toBeUndefined());

    // Meanwhile a slot was added.
    usageTables({ exercise_slots: { count: 1 }, goals: { count: 0 }, slot_deviations: { count: 0 } });
    const second = renderHook(() => useExerciseUsage('e-1'), { wrapper: withClient(qc) });
    expect(second.result.current.data).toBeUndefined();
    await waitFor(() => expect(second.result.current.data).toEqual({ slots: 1, goals: 0, swaps: 0 }));
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

describe('useArchiveExercise', () => {
  // One update, read back as the row the server holds after it.
  function updateChain(answer) {
    const chain = {
      update: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      select: vi.fn(() => chain),
      single: vi.fn(async () => answer),
    };
    supabase.from.mockReturnValue(chain);
    return chain;
  }

  it('archives: archived_at is the moment of the write, on that exercise alone', async () => {
    const chain = updateChain({ data: { id: 'e-1', archived_at: '2026-10-15T08:00:00.000Z' }, error: null });
    const qc = makeClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useArchiveExercise(), { wrapper: withClient(qc) });
    const before = Date.now();
    result.current.mutate({ id: 'e-1', archived: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(supabase.from).toHaveBeenCalledWith('exercise_library');
    expect(chain.update).toHaveBeenCalledTimes(1);
    const [patch] = chain.update.mock.calls[0];
    // The one column, and nothing else of the row.
    expect(Object.keys(patch)).toEqual(['archived_at']);
    expect(typeof patch.archived_at).toBe('string');
    expect(new Date(patch.archived_at).toISOString()).toBe(patch.archived_at);
    expect(Date.parse(patch.archived_at)).toBeGreaterThanOrEqual(before);
    expect(chain.eq).toHaveBeenCalledWith('id', 'e-1');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['exercise-library'] });
  });

  it('restores: archived_at is empty again', async () => {
    const chain = updateChain({ data: { id: 'e-1', archived_at: null }, error: null });
    const qc = makeClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useArchiveExercise(), { wrapper: withClient(qc) });
    result.current.mutate({ id: 'e-1', archived: false });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(chain.update).toHaveBeenCalledWith({ archived_at: null });
    expect(chain.eq).toHaveBeenCalledWith('id', 'e-1');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['exercise-library'] });
  });

  // The exercise changes lists when the write is through, not one library
  // read later. (Nothing watches the library here, so the invalidation reads
  // nothing again: what the cache holds is the row of the write.)
  it('puts the row the server sent back into the cached library', async () => {
    const archived = { id: 'e-1', name: 'Dip', coach_id: 'coach-1', archived_at: '2026-10-15T08:00:00.000Z' };
    updateChain({ data: archived, error: null });
    const qc = makeClient();
    const other = { id: 'e-2', name: 'Pull-up', coach_id: 'coach-1', archived_at: null };
    qc.setQueryData(['exercise-library'], [{ ...archived, archived_at: null }, other]);
    const { result } = renderHook(() => useArchiveExercise(), { wrapper: withClient(qc) });
    result.current.mutate({ id: 'e-1', archived: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(qc.getQueryData(['exercise-library'])).toEqual([archived, other]);
  });

  it('writes nothing into the cache, and invalidates nothing, when the database refuses the write', async () => {
    updateChain({ data: null, error: { code: 'PGRST116', message: 'no rows' } });
    const qc = makeClient();
    const cached = [{ id: 'e-1', name: 'Dip', coach_id: 'coach-1', archived_at: null }];
    qc.setQueryData(['exercise-library'], cached);
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useArchiveExercise(), { wrapper: withClient(qc) });
    result.current.mutate({ id: 'e-1', archived: true });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(invalidate).not.toHaveBeenCalled();
    expect(qc.getQueryData(['exercise-library'])).toBe(cached);
  });

  it('leaves a library that was never read unread', async () => {
    updateChain({ data: { id: 'e-1', archived_at: '2026-10-15T08:00:00.000Z' }, error: null });
    const qc = makeClient();
    const { result } = renderHook(() => useArchiveExercise(), { wrapper: withClient(qc) });
    result.current.mutate({ id: 'e-1', archived: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(qc.getQueryData(['exercise-library'])).toBeUndefined();
  });
});

// An archived exercise is still the name of what was trained: the session
// view, the review and the goals look it up in this list. Only a picker leaves
// it out (isActiveExercise).
describe('useExerciseLibrary and archived exercises', () => {
  const rows = [
    { id: 'e-1', name: 'Dip', coach_id: 'coach-1', archived_at: '2026-10-15T08:00:00.000Z' },
    { id: 'e-2', name: 'Pull-up', coach_id: 'coach-1', archived_at: null },
  ];

  it.each([
    ['a coach', { user: { id: 'coach-1' }, role: 'coach' }],
    ['an athlete', { user: { id: 'athlete-1' }, role: 'student' }],
  ])('returns them to %s, with the active ones', async (_who, auth) => {
    useAuth.mockReturnValue(auth);
    const chain = libraryTable(rows);
    const qc = makeClient();
    const { result } = renderHook(() => useExerciseLibrary(), { wrapper: withClient(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data.map((e) => e.id)).toEqual(['e-1', 'e-2']);
    // No filter on the column in the request either.
    expect(chain.eq).not.toHaveBeenCalledWith('archived_at', expect.anything());
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

  // A goal row embeds its exercise, and a goals foreign key that still
  // cascades takes the goals with the exercise: both goal lists (the coach's
  // per athlete, the athlete's own) sit under ['goals'].
  it('drops the goal lists too', async () => {
    const chain = {
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: null }),
    };
    supabase.from.mockReturnValue(chain);
    const qc = makeClient();
    qc.setQueryData(['goals', 'student', 'athlete-1'], [{ id: 'g-1', exercise_id: 'e-1' }]);
    qc.setQueryData(['goals', 'mine', 'athlete-1'], [{ id: 'g-1', exercise_id: 'e-1' }]);
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useDeleteExercise(), { wrapper: withClient(qc) });
    result.current.mutate('e-1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['goals'] });
    expect(qc.getQueryState(['goals', 'student', 'athlete-1']).isInvalidated).toBe(true);
    expect(qc.getQueryState(['goals', 'mine', 'athlete-1']).isInvalidated).toBe(true);
  });

  it('leaves every cache alone when the database refuses the delete', async () => {
    const chain = {
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: { code: '23503', message: 'still referenced' } }),
    };
    supabase.from.mockReturnValue(chain);
    const qc = makeClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useDeleteExercise(), { wrapper: withClient(qc) });
    result.current.mutate('e-1');
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(invalidate).not.toHaveBeenCalled();
  });
});
