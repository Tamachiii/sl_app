import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../lib/supabase', () => ({ supabase: { from: vi.fn() } }));
vi.mock('./useAuth', () => ({ useAuth: vi.fn() }));

import {
  useProgramsForStudent,
  useProgram,
  useActiveProgram,
  useEnsureProgram,
  useCreateProgram,
  useRenameProgram,
  useDeleteProgram,
  useSetActiveProgram,
  useReorderPrograms,
  useCoachDashboardPrograms,
  useCreateWeek,
} from './useProgram';
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

describe('useProgramsForStudent', () => {
  it('lists programs ordered by sort_order asc', async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({
        data: [
          { id: 'p-1', name: 'Block 1', sort_order: 0 },
          { id: 'p-2', name: 'Block 2', sort_order: 1 },
        ],
        error: null,
      }),
    };
    supabase.from.mockReturnValue(chain);
    const qc = makeClient();
    const { result } = renderHook(() => useProgramsForStudent('st-1'), {
      wrapper: withClient(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(chain.eq).toHaveBeenCalledWith('student_id', 'st-1');
    expect(chain.order).toHaveBeenCalledWith('sort_order', { ascending: true });
    expect(result.current.data).toHaveLength(2);
  });
});

describe('useProgram', () => {
  it('fetches a program and sorts weeks by week_number', async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          id: 'p-1',
          weeks: [
            { id: 'w-2', week_number: 2 },
            { id: 'w-1', week_number: 1 },
          ],
        },
        error: null,
      }),
    };
    supabase.from.mockReturnValue(chain);
    const qc = makeClient();
    const { result } = renderHook(() => useProgram('p-1'), { wrapper: withClient(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data.weeks.map((w) => w.id)).toEqual(['w-1', 'w-2']);
  });

  it('returns null when there is no row', async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
    supabase.from.mockReturnValue(chain);
    const qc = makeClient();
    const { result } = renderHook(() => useProgram('missing'), { wrapper: withClient(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });
});

describe('useActiveProgram', () => {
  it('filters by is_active=true', async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { id: 'p-1', weeks: [] },
        error: null,
      }),
    };
    supabase.from.mockReturnValue(chain);
    const qc = makeClient();
    const { result } = renderHook(() => useActiveProgram('st-1'), { wrapper: withClient(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const calls = chain.eq.mock.calls;
    expect(calls).toContainEqual(['student_id', 'st-1']);
    expect(calls).toContainEqual(['is_active', true]);
  });
});

describe('useEnsureProgram', () => {
  it('inserts a default program with is_active=true and sort_order=0', async () => {
    const chain = {
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: { id: 'p-new', weeks: [] },
        error: null,
      }),
    };
    supabase.from.mockReturnValue(chain);
    const qc = makeClient();
    const { result } = renderHook(() => useEnsureProgram(), { wrapper: withClient(qc) });
    result.current.mutate({ studentId: 'st-1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(chain.insert).toHaveBeenCalledWith({
      student_id: 'st-1',
      name: 'Program 1',
      is_active: true,
      sort_order: 0,
    });
  });
});

describe('useCreateProgram', () => {
  it('without setActive — inserts at next sort_order, no deactivate call', async () => {
    const listExisting = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({
        data: [{ sort_order: 2 }],
        error: null,
      }),
    };
    const insertProg = {
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: { id: 'p-new', name: 'Block 4', sort_order: 3, is_active: false },
        error: null,
      }),
    };
    const seq = [listExisting, insertProg];
    let i = 0;
    supabase.from.mockImplementation(() => seq[i++]);

    const qc = makeClient();
    const { result } = renderHook(() => useCreateProgram(), { wrapper: withClient(qc) });
    result.current.mutate({ studentId: 'st-1', name: 'Block 4' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(insertProg.insert).toHaveBeenCalledWith({
      student_id: 'st-1',
      name: 'Block 4',
      sort_order: 3,
      is_active: false,
    });
  });

  it('with setActive=true — first deactivates the current active program', async () => {
    const listExisting = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    const deactivate = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn(function () {
        this._calls = (this._calls || 0) + 1;
        // resolve on second .eq() (student_id then is_active)
        if (this._calls === 2) return Promise.resolve({ error: null });
        return this;
      }),
    };
    const insertProg = {
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: { id: 'p-new', name: 'Active Block', sort_order: 0, is_active: true },
        error: null,
      }),
    };
    const seq = [listExisting, deactivate, insertProg];
    let i = 0;
    supabase.from.mockImplementation(() => seq[i++]);

    const qc = makeClient();
    const { result } = renderHook(() => useCreateProgram(), { wrapper: withClient(qc) });
    result.current.mutate({ studentId: 'st-1', name: 'Active Block', setActive: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(deactivate.update).toHaveBeenCalledWith({ is_active: false });
    expect(insertProg.insert).toHaveBeenCalledWith(
      expect.objectContaining({ is_active: true, sort_order: 0 }),
    );
  });

  it('seeds the ["programs", studentId] cache synchronously on success', async () => {
    const listExisting = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    const insertProg = {
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: { id: 'p-new', name: 'X', sort_order: 0, is_active: false },
        error: null,
      }),
    };
    const seq = [listExisting, insertProg];
    let i = 0;
    supabase.from.mockImplementation(() => seq[i++]);

    const qc = makeClient();
    qc.setQueryData(['programs', 'st-1'], [{ id: 'p-old' }]);
    const { result } = renderHook(() => useCreateProgram(), { wrapper: withClient(qc) });
    result.current.mutate({ studentId: 'st-1', name: 'X' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const cached = qc.getQueryData(['programs', 'st-1']);
    expect(cached.map((p) => p.id)).toContain('p-new');
  });
});

describe('useRenameProgram', () => {
  it('updates the name and invalidates the program list', async () => {
    const chain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { id: 'p-1' }, error: null }),
    };
    supabase.from.mockReturnValue(chain);

    const qc = makeClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useRenameProgram(), { wrapper: withClient(qc) });
    result.current.mutate({ programId: 'p-1', name: 'Renamed', studentId: 'st-1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(chain.update).toHaveBeenCalledWith({ name: 'Renamed' });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['programs', 'st-1'] });
  });
});

describe('useDeleteProgram', () => {
  it('deletes by id and invalidates everything', async () => {
    const chain = {
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: null }),
    };
    supabase.from.mockReturnValue(chain);
    const qc = makeClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useDeleteProgram(), { wrapper: withClient(qc) });
    result.current.mutate({ programId: 'p-1', studentId: 'st-1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(chain.eq).toHaveBeenCalledWith('id', 'p-1');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['student-program-details'] });
  });
});

describe('useSetActiveProgram', () => {
  it('deactivates the sibling active program before activating the target', async () => {
    const callOrder = [];
    const deactivate = {
      update: vi.fn(function (payload) {
        this._payload = payload;
        return this;
      }),
      eq: vi.fn(function () {
        this._calls = (this._calls || 0) + 1;
        if (this._calls === 2) {
          callOrder.push({ phase: 'deactivate', payload: this._payload });
          return Promise.resolve({ error: null });
        }
        return this;
      }),
    };
    const activate = {
      update: vi.fn(function (payload) {
        this._payload = payload;
        return this;
      }),
      eq: vi.fn(function () {
        callOrder.push({ phase: 'activate', payload: this._payload });
        return this;
      }),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { id: 'p-1', is_active: true }, error: null }),
    };
    const seq = [deactivate, activate];
    let i = 0;
    supabase.from.mockImplementation(() => seq[i++]);

    const qc = makeClient();
    const { result } = renderHook(() => useSetActiveProgram(), { wrapper: withClient(qc) });
    result.current.mutate({ programId: 'p-1', studentId: 'st-1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(callOrder[0].phase).toBe('deactivate');
    expect(callOrder[0].payload).toEqual({ is_active: false });
    expect(callOrder[1].phase).toBe('activate');
    expect(callOrder[1].payload).toEqual({ is_active: true });
  });
});

describe('useReorderPrograms', () => {
  it('parks then re-numbers in two passes (sort_order)', async () => {
    const calls = [];
    const chain = {
      update: vi.fn(function (payload) {
        this._payload = payload;
        return this;
      }),
      eq: vi.fn(function (col, val) {
        calls.push({ payload: this._payload, where: { [col]: val } });
        return Promise.resolve({ error: null });
      }),
    };
    supabase.from.mockReturnValue(chain);

    const qc = makeClient();
    const { result } = renderHook(() => useReorderPrograms(), { wrapper: withClient(qc) });
    result.current.mutate({ studentId: 'st-1', orderedIds: ['p-a', 'p-b'] });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls.slice(0, 2).map((c) => c.payload.sort_order)).toEqual([100000, 100001]);
    expect(calls.slice(2).map((c) => c.payload.sort_order)).toEqual([0, 1]);
  });

  it('rolls back the cache when the update errors', async () => {
    const chain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: { message: 'nope' } }),
    };
    supabase.from.mockReturnValue(chain);

    const qc = makeClient();
    const original = [
      { id: 'p-a', sort_order: 0 },
      { id: 'p-b', sort_order: 1 },
    ];
    qc.setQueryData(['programs', 'st-1'], original);

    const { result } = renderHook(() => useReorderPrograms(), { wrapper: withClient(qc) });
    act(() => {
      result.current.mutate({ studentId: 'st-1', orderedIds: ['p-b', 'p-a'] });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    const restored = qc.getQueryData(['programs', 'st-1']);
    expect(restored.map((p) => p.id)).toEqual(['p-a', 'p-b']);
  });
});

describe('useCoachDashboardPrograms', () => {
  it('picks the first week with an unconfirmed non-archived session as activeWeek', async () => {
    const programsChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({
        data: [
          {
            student_id: 'st-1',
            name: 'Block A',
            weeks: [
              {
                id: 'w-1',
                week_number: 1,
                label: 'Acc',
                sessions: [
                  { id: 's-1', archived_at: null },
                  { id: 's-2', archived_at: null },
                ],
              },
              {
                id: 'w-2',
                week_number: 2,
                label: 'Hyp',
                sessions: [{ id: 's-3', archived_at: null }],
              },
            ],
          },
        ],
        error: null,
      }),
    };
    const confChain = {
      select: vi.fn().mockReturnThis(),
      in: vi.fn().mockResolvedValue({
        data: [{ session_id: 's-1' }, { session_id: 's-2' }],
        error: null,
      }),
    };
    let call = 0;
    supabase.from.mockImplementation(() => (call++ === 0 ? programsChain : confChain));

    const qc = makeClient();
    const { result } = renderHook(() => useCoachDashboardPrograms(), {
      wrapper: withClient(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // Week 1 fully confirmed → active week is W2.
    expect(result.current.data['st-1']).toEqual({
      programName: 'Block A',
      activeWeek: { week_number: 2, label: 'Hyp' },
    });
  });

  it('falls back to the last week when every session is confirmed', async () => {
    const programsChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({
        data: [
          {
            student_id: 'st-1',
            name: 'Done',
            weeks: [
              { id: 'w-1', week_number: 1, label: 'A', sessions: [{ id: 's-1', archived_at: null }] },
              { id: 'w-2', week_number: 2, label: 'B', sessions: [{ id: 's-2', archived_at: null }] },
            ],
          },
        ],
        error: null,
      }),
    };
    const confChain = {
      select: vi.fn().mockReturnThis(),
      in: vi.fn().mockResolvedValue({
        data: [{ session_id: 's-1' }, { session_id: 's-2' }],
        error: null,
      }),
    };
    let call = 0;
    supabase.from.mockImplementation(() => (call++ === 0 ? programsChain : confChain));

    const qc = makeClient();
    const { result } = renderHook(() => useCoachDashboardPrograms(), {
      wrapper: withClient(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data['st-1'].activeWeek).toEqual({
      week_number: 2,
      label: 'B',
    });
  });
});

describe('useCreateWeek', () => {
  it('inserts a week and invalidates ["program"]', async () => {
    const chain = {
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { id: 'w-new' }, error: null }),
    };
    supabase.from.mockReturnValue(chain);

    const qc = makeClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useCreateWeek(), { wrapper: withClient(qc) });
    result.current.mutate({ programId: 'p-1', weekNumber: 5, label: null });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(chain.insert).toHaveBeenCalledWith({
      program_id: 'p-1',
      week_number: 5,
      label: null,
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['program'] });
  });
});
