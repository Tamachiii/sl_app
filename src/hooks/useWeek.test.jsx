import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import {
  useWeek,
  useDeleteWeek,
  useReorderWeeks,
  useUpdateWeek,
  useUpdateSession,
  useArchiveSession,
  useDeleteSession,
  useCreateSession,
} from './useWeek';
import { createTestQueryClient } from '../test/utils';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';

vi.mock('../lib/supabase', () => ({
  supabase: { from: vi.fn() },
}));

function withClient(qc) {
  return ({ children }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function createWrapper() {
  const qc = createTestQueryClient();
  return { qc, wrapper: withClient(qc) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useWeek', () => {
  it('fetches week and its sessions, sorting slots by sort_order', async () => {
    const mockWeekQuery = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { id: 'w-1', week_number: 1 } }),
    };
    const mockSessionsQuery = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({
        data: [
          {
            id: 's-1',
            week_id: 'w-1',
            exercise_slots: [
              { id: 'sl-2', sort_order: 2 },
              { id: 'sl-1', sort_order: 1 },
            ],
          },
        ],
      }),
    };
    supabase.from.mockImplementation((table) => {
      if (table === 'weeks') return mockWeekQuery;
      if (table === 'sessions') return mockSessionsQuery;
      return {};
    });

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useWeek('w-1'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data.id).toBe('w-1');
    expect(result.current.data.sessions[0].exercise_slots.map((s) => s.id)).toEqual([
      'sl-1',
      'sl-2',
    ]);
  });
});

describe('useDeleteWeek', () => {
  it('deletes week and invalidates the program + week caches', async () => {
    const mockDelete = {
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: null }),
    };
    supabase.from.mockReturnValue(mockDelete);

    const { qc, wrapper } = createWrapper();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useDeleteWeek(), { wrapper });
    result.current.mutate('w-1');

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockDelete.eq).toHaveBeenCalledWith('id', 'w-1');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['program'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['week', 'w-1'] });
  });
});

describe('useUpdateWeek', () => {
  it('writes the patch and invalidates ["week", id] + ["program"]', async () => {
    const mockUpdate = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { id: 'w-1', label: 'Hypertrophy' } }),
    };
    supabase.from.mockReturnValue(mockUpdate);

    const { qc, wrapper } = createWrapper();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useUpdateWeek(), { wrapper });
    result.current.mutate({ id: 'w-1', label: 'Hypertrophy' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockUpdate.update).toHaveBeenCalledWith({ label: 'Hypertrophy' });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['week', 'w-1'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['program'] });
  });
});

describe('useUpdateSession', () => {
  it('invalidates ["week", weekId] and ["session", id]', async () => {
    const mockUpdate = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { id: 's-1', week_id: 'w-9', title: 'Push' } }),
    };
    supabase.from.mockReturnValue(mockUpdate);

    const { qc, wrapper } = createWrapper();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useUpdateSession(), { wrapper });
    result.current.mutate({ id: 's-1', title: 'Push' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['week', 'w-9'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['session', 's-1'] });
  });
});

describe('useArchiveSession', () => {
  it('writes a timestamp when archiving and null when unarchiving', async () => {
    const mockUpdate = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: { id: 's-1', week_id: 'w-1', archived_at: '2026-04-26T10:00:00Z' },
      }),
    };
    supabase.from.mockReturnValue(mockUpdate);

    const { qc, wrapper } = createWrapper();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useArchiveSession(), { wrapper });
    result.current.mutate({ sessionId: 's-1', archived: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const archivePayload = mockUpdate.update.mock.calls[0][0];
    expect(typeof archivePayload.archived_at).toBe('string');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['student-confirmations'] });

    // Now unarchive — should pass null.
    mockUpdate.single.mockResolvedValueOnce({
      data: { id: 's-1', week_id: 'w-1', archived_at: null },
    });
    result.current.reset();
    result.current.mutate({ sessionId: 's-1', archived: false });
    await waitFor(() => {
      expect(mockUpdate.update.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    const unarchivePayload =
      mockUpdate.update.mock.calls[mockUpdate.update.mock.calls.length - 1][0];
    expect(unarchivePayload).toEqual({ archived_at: null });
  });
});

describe('useDeleteSession', () => {
  it('resolves week_id first, then deletes, then invalidates that week', async () => {
    const lookupChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { week_id: 'w-7' } }),
    };
    const deleteChain = {
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: null }),
    };
    let call = 0;
    supabase.from.mockImplementation(() => (call++ === 0 ? lookupChain : deleteChain));

    const { qc, wrapper } = createWrapper();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useDeleteSession(), { wrapper });
    result.current.mutate('s-1');

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(deleteChain.delete).toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['week', 'w-7'] });
  });

  it('falls back to invalidating ["week"] when week_id lookup returns no row', async () => {
    const lookupChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null }),
    };
    const deleteChain = {
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: null }),
    };
    let call = 0;
    supabase.from.mockImplementation(() => (call++ === 0 ? lookupChain : deleteChain));

    const { qc, wrapper } = createWrapper();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useDeleteSession(), { wrapper });
    result.current.mutate('s-1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['week'] });
  });
});

describe('useCreateSession', () => {
  it('inserts and invalidates the parent week + program', async () => {
    const mockInsert = {
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { id: 's-9' } }),
    };
    supabase.from.mockReturnValue(mockInsert);

    const { qc, wrapper } = createWrapper();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useCreateSession(), { wrapper });
    result.current.mutate({ weekId: 'w-1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const payload = mockInsert.insert.mock.calls[0][0];
    expect(payload.week_id).toBe('w-1');
    expect(payload.title).toBe('New Session');
    expect(payload.day_number).toBe(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['week', 'w-1'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['program'] });
  });
});

describe('useReorderWeeks', () => {
  function makeUpdateRecorder() {
    const calls = [];
    const chain = {
      update: vi.fn(function (payload) {
        this._currentPayload = payload;
        return this;
      }),
      eq: vi.fn(function (col, val) {
        calls.push({ payload: this._currentPayload, where: { [col]: val } });
        return Promise.resolve({ error: null });
      }),
    };
    supabase.from.mockReturnValue(chain);
    return calls;
  }

  it('parks then re-numbers in two passes', async () => {
    const calls = makeUpdateRecorder();

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useReorderWeeks(), { wrapper });

    result.current.mutate({ programId: 'p-1', orderedIds: ['w-a', 'w-b', 'w-c'] });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls.length).toBe(6);
    expect(calls.slice(0, 3).map((c) => c.payload.week_number)).toEqual([
      100000,
      100001,
      100002,
    ]);
    expect(calls.slice(3).map((c) => c.payload.week_number)).toEqual([1, 2, 3]);
    expect(calls.slice(0, 3).map((c) => c.where.id)).toEqual(['w-a', 'w-b', 'w-c']);
  });

  it('optimistically rewrites the matching ["program", x] cache', async () => {
    makeUpdateRecorder();
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
    });
    const wrapper = withClient(qc);
    qc.setQueryData(['program', 'p-1'], {
      id: 'p-1',
      weeks: [
        { id: 'w-a', week_number: 1 },
        { id: 'w-b', week_number: 2 },
        { id: 'w-c', week_number: 3 },
      ],
    });
    qc.setQueryData(['program', 'other'], {
      id: 'other',
      weeks: [{ id: 'x', week_number: 1 }],
    });

    const { result } = renderHook(() => useReorderWeeks(), { wrapper });
    act(() => {
      result.current.mutate({ programId: 'p-1', orderedIds: ['w-c', 'w-a', 'w-b'] });
    });

    await waitFor(() => {
      const data = qc.getQueryData(['program', 'p-1']);
      expect(data.weeks.map((w) => w.id)).toEqual(['w-c', 'w-a', 'w-b']);
    });
    const data = qc.getQueryData(['program', 'p-1']);
    expect(data.weeks.map((w) => w.week_number)).toEqual([1, 2, 3]);
    // Other program left untouched.
    expect(qc.getQueryData(['program', 'other']).weeks[0].id).toBe('x');
  });

  it('rolls back on failure', async () => {
    const chain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: { message: 'boom' } }),
    };
    supabase.from.mockReturnValue(chain);

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
    });
    const wrapper = withClient(qc);
    const original = {
      id: 'p-1',
      weeks: [
        { id: 'w-a', week_number: 1 },
        { id: 'w-b', week_number: 2 },
      ],
    };
    qc.setQueryData(['program', 'p-1'], original);

    const { result } = renderHook(() => useReorderWeeks(), { wrapper });
    act(() => {
      result.current.mutate({ programId: 'p-1', orderedIds: ['w-b', 'w-a'] });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    const restored = qc.getQueryData(['program', 'p-1']);
    expect(restored.weeks.map((w) => w.id)).toEqual(['w-a', 'w-b']);
  });
});
