import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../lib/supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }));
vi.mock('./useAuth', () => ({ useAuth: vi.fn() }));

import {
  useProgramsForStudent,
  useProgram,
  useActiveProgram,
  useEnsureProgram,
  useCreateProgram,
  useRenameProgram,
  useDeleteProgram,
  useRestoreProgram,
  useHardDeleteProgram,
  useSetActiveProgram,
  useReorderPrograms,
  useCoachDashboardPrograms,
  useApproveProgram,
  useSendBackProgram,
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
  it('lists programs ordered by sort_order asc, excluding the trash', async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
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
    expect(chain.is).toHaveBeenCalledWith('deleted_at', null);
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
  it('filters by is_active=true and excludes the trash', async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
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
    expect(chain.is).toHaveBeenCalledWith('deleted_at', null);
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
  // The two requests every create makes: the read of the highest sort_order,
  // then the insert. `update` is a spy on both so a test can say that no
  // request of the hook switched a block off.
  function createChains({ existing = [], inserted, insertError = null, order = [] }) {
    const listExisting = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: existing, error: null }),
      update: vi.fn(),
    };
    const insertProg = {
      insert: vi.fn(function (row) {
        order.push(['insert', row]);
        return this;
      }),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: insertError ? null : inserted, error: insertError }),
      update: vi.fn(),
    };
    const seq = [listExisting, insertProg];
    let i = 0;
    supabase.from.mockImplementation(() => seq[i++]);
    return { listExisting, insertProg, order };
  }

  function activation(order, result) {
    supabase.rpc.mockImplementation((fn, args) => {
      order.push(['rpc', fn, args]);
      return Promise.resolve(result);
    });
  }

  it('without setActive — inserts at next sort_order, inactive, and activates nothing', async () => {
    const { insertProg } = createChains({
      existing: [{ sort_order: 2 }],
      inserted: { id: 'p-new', name: 'Block 4', sort_order: 3, is_active: false },
    });

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
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  // Review finding P16. The hook used to switch the athlete's active block
  // off, then insert the new one as active: with the insert lost, the athlete
  // had no active block and every set they logged was refused.
  it('with setActive=true — inserts the program INACTIVE, then activates it in one call', async () => {
    const { listExisting, insertProg, order } = createChains({
      inserted: { id: 'p-new', name: 'Active Block', sort_order: 0, is_active: false },
    });
    activation(order, {
      data: { program_id: 'p-new', student_id: 'st-1', already_active: false, deactivated: 1 },
      error: null,
    });

    const qc = makeClient();
    const { result } = renderHook(() => useCreateProgram(), { wrapper: withClient(qc) });
    result.current.mutate({ studentId: 'st-1', name: 'Active Block', setActive: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // The insert first, so that the activation has a program to name.
    expect(order).toEqual([
      ['insert', { student_id: 'st-1', name: 'Active Block', sort_order: 0, is_active: false }],
      ['rpc', 'activate_program', { p_program_id: 'p-new' }],
    ]);
    // The read and the insert: no third request, and none that updates.
    expect(supabase.from).toHaveBeenCalledTimes(2);
    expect(listExisting.update).not.toHaveBeenCalled();
    expect(insertProg.update).not.toHaveBeenCalled();
    // The row came back inactive from the insert; it is active now.
    expect(result.current.data).toMatchObject({ id: 'p-new', is_active: true });
  });

  it('with setActive=true — a refused activation fails the mutation and has switched nothing off', async () => {
    const { listExisting, insertProg, order } = createChains({
      inserted: { id: 'p-new', name: 'Active Block', sort_order: 0, is_active: false },
    });
    const refusal = { code: 'P0001', message: 'program_in_trash' };
    activation(order, { data: null, error: refusal });

    const qc = makeClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useCreateProgram(), { wrapper: withClient(qc) });
    result.current.mutate({ studentId: 'st-1', name: 'Active Block', setActive: true });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error).toBe(refusal);
    expect(supabase.from).toHaveBeenCalledTimes(2);
    expect(listExisting.update).not.toHaveBeenCalled();
    expect(insertProg.update).not.toHaveBeenCalled();
    // The program exists, inactive: the lists are read again so it shows.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['programs', 'st-1'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['active-program', 'st-1'] });
  });

  it('with setActive=true — an insert that fails activates nothing', async () => {
    const { order } = createChains({ insertError: { code: '42501', message: 'not allowed' } });
    activation(order, { data: null, error: null });

    const { result } = renderHook(() => useCreateProgram(), { wrapper: withClient(makeClient()) });
    result.current.mutate({ studentId: 'st-1', name: 'Active Block', setActive: true });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('seeds the ["programs", studentId] cache synchronously on success', async () => {
    createChains({ inserted: { id: 'p-new', name: 'X', sort_order: 0, is_active: false } });

    const qc = makeClient();
    qc.setQueryData(['programs', 'st-1'], [{ id: 'p-old', is_active: true }]);
    const { result } = renderHook(() => useCreateProgram(), { wrapper: withClient(qc) });
    result.current.mutate({ studentId: 'st-1', name: 'X' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // An inactive newcomer leaves the active block as it is.
    expect(qc.getQueryData(['programs', 'st-1'])).toEqual([
      { id: 'p-old', is_active: true },
      { id: 'p-new', name: 'X', sort_order: 0, is_active: false, weeks: [] },
    ]);
  });

  it('seeds an ACTIVE newcomer as the only active program of the list', async () => {
    const { order } = createChains({
      inserted: { id: 'p-new', name: 'X', sort_order: 1, is_active: false },
    });
    activation(order, { data: {}, error: null });

    const qc = makeClient();
    qc.setQueryData(['programs', 'st-1'], [{ id: 'p-old', is_active: true }]);
    const { result } = renderHook(() => useCreateProgram(), { wrapper: withClient(qc) });
    result.current.mutate({ studentId: 'st-1', name: 'X', setActive: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(qc.getQueryData(['programs', 'st-1']).map((p) => [p.id, p.is_active])).toEqual([
      ['p-old', false],
      ['p-new', true],
    ]);
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
  it('is archive-first: stamps deleted_at and clears is_active instead of DELETE', async () => {
    const chain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: null }),
    };
    supabase.from.mockReturnValue(chain);
    const qc = makeClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useDeleteProgram(), { wrapper: withClient(qc) });
    result.current.mutate({ programId: 'p-1', studentId: 'st-1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const payload = chain.update.mock.calls[0][0];
    expect(typeof payload.deleted_at).toBe('string');
    // A trashed row must never hold the one-active-per-student slot.
    expect(payload.is_active).toBe(false);
    expect(chain.eq).toHaveBeenCalledWith('id', 'p-1');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['student-program-details'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['programs-trash', 'st-1'] });
  });
});

describe('useRestoreProgram', () => {
  it('nulls deleted_at (program comes back inactive)', async () => {
    const chain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: null }),
    };
    supabase.from.mockReturnValue(chain);
    const qc = makeClient();
    const { result } = renderHook(() => useRestoreProgram(), { wrapper: withClient(qc) });
    result.current.mutate({ programId: 'p-1', studentId: 'st-1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(chain.update).toHaveBeenCalledWith({ deleted_at: null });
  });
});

describe('useHardDeleteProgram', () => {
  it('refuses with PROGRAM_HAS_LOGGED_SETS when any logged set exists', async () => {
    const countChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      or: vi.fn().mockResolvedValue({ count: 3, error: null }),
    };
    supabase.from.mockReturnValue(countChain);
    const qc = makeClient();
    const { result } = renderHook(() => useHardDeleteProgram(), { wrapper: withClient(qc) });
    result.current.mutate({ programId: 'p-1', studentId: 'st-1' });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error.code).toBe('PROGRAM_HAS_LOGGED_SETS');
    // The DELETE was never attempted.
    expect(supabase.from).toHaveBeenCalledTimes(1);
  });

  it('deletes (trash-only) when the program has zero logged sets', async () => {
    const countChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      or: vi.fn().mockResolvedValue({ count: 0, error: null }),
    };
    const deleteChain = {
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      not: vi.fn().mockResolvedValue({ error: null }),
    };
    let call = 0;
    supabase.from.mockImplementation(() => (call++ === 0 ? countChain : deleteChain));
    const qc = makeClient();
    const { result } = renderHook(() => useHardDeleteProgram(), { wrapper: withClient(qc) });
    result.current.mutate({ programId: 'p-1', studentId: 'st-1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(deleteChain.eq).toHaveBeenCalledWith('id', 'p-1');
    // Guard: hard delete only reaches rows already in the trash.
    expect(deleteChain.not).toHaveBeenCalledWith('deleted_at', 'is', null);
  });
});

// Review finding P16. "Set active" was two requests — the athlete's other
// blocks off, then this one on — and each request is a transaction of its own:
// with the second one lost the athlete had no active block. It is one call of
// `activate_program` now, which does both or neither.
describe('useSetActiveProgram', () => {
  const PROGRAM_KEYS = [
    ['programs', 'st-1'],
    ['programs-trash', 'st-1'],
    ['active-program', 'st-1'],
    ['program'],
    ['student-program-details'],
    ['student-progress-stats'],
    ['coach-dashboard-programs'],
  ];

  it('is ONE activate_program call, and no request of its own on the table', async () => {
    const answer = { program_id: 'p-1', student_id: 'st-1', already_active: false, deactivated: 1 };
    supabase.rpc.mockResolvedValue({ data: answer, error: null });

    const qc = makeClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useSetActiveProgram(), { wrapper: withClient(qc) });
    result.current.mutate({ programId: 'p-1', studentId: 'st-1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(supabase.rpc).toHaveBeenCalledWith('activate_program', { p_program_id: 'p-1' });
    expect(supabase.from).not.toHaveBeenCalled();
    expect(result.current.data).toEqual(answer);
    // The athlete's own views read through is_active, so they drop too.
    for (const queryKey of PROGRAM_KEYS) expect(invalidate).toHaveBeenCalledWith({ queryKey });
  });

  // What the function refuses is a program the list on screen still offers —
  // one that went to the trash from another tab, say. The mutation fails (the
  // toast), and the list is read again so that it stops offering it.
  it('a refusal fails the mutation, writes nothing itself and reads the lists again', async () => {
    const refusal = { code: 'P0001', message: 'program_in_trash' };
    supabase.rpc.mockResolvedValue({ data: null, error: refusal });

    const qc = makeClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useSetActiveProgram(), { wrapper: withClient(qc) });
    result.current.mutate({ programId: 'p-1', studentId: 'st-1' });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error).toBe(refusal);
    expect(supabase.from).not.toHaveBeenCalled();
    for (const queryKey of PROGRAM_KEYS) expect(invalidate).toHaveBeenCalledWith({ queryKey });
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

// A PostgREST read is awaited after its last filter, whichever that is: every
// method returns the builder, and the builder resolves to the result.
function readChain(result) {
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return chain;
}

// The same builder over `rows`, applying the request's `.eq()` filters the way
// PostgREST does with `!inner` embeds: 'student.coach_id' is a path into the
// embedded row, and a row whose embed does not match is dropped.
function filteringChain(rows) {
  const filters = [];
  const at = (row, path) => path.split('.').reduce((node, key) => node?.[key], row);
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn((path, value) => {
      filters.push([path, value]);
      return chain;
    }),
    then: (resolve, reject) =>
      Promise.resolve({
        data: rows.filter((row) => filters.every(([path, value]) => at(row, path) === value)),
        error: null,
      }).then(resolve, reject),
  };
  return chain;
}

const oneLine = (text) => text.replace(/\s+/g, ' ').trim();

describe('useCoachDashboardPrograms', () => {
  // RLS answers "every program this account may read", which includes the
  // programs in which the account is the ATHLETE. The roster is narrower: the
  // athletes this coach coaches. An embedded filter only drops the parent row
  // when the embed is `!inner`, so the select is part of the rule.
  it('names the coach in both reads, through an inner join on students', async () => {
    const programsChain = readChain({ data: [], error: null });
    const confChain = readChain({ data: [], error: null });
    supabase.from.mockImplementation((table) => (table === 'programs' ? programsChain : confChain));

    const { result } = renderHook(() => useCoachDashboardPrograms(), { wrapper: withClient(makeClient()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(oneLine(programsChain.select.mock.calls[0][0])).toContain('student:students!inner(coach_id)');
    expect(programsChain.eq.mock.calls).toEqual([
      ['is_active', true],
      ['student.coach_id', 'coach-1'],
    ]);

    expect(confChain.select.mock.calls[0][0]).toBe(
      'session_id, session:sessions!inner(week:weeks!inner(program:programs!inner(is_active, student:students!inner(coach_id))))',
    );
    expect(confChain.eq.mock.calls).toEqual([
      ['session.week.program.is_active', true],
      ['session.week.program.student.coach_id', 'coach-1'],
    ]);
  });

  it('leaves out the program in which the coach is somebody else’s athlete', async () => {
    const week = (id, sessionId) => ({
      id,
      week_number: 1,
      label: null,
      sessions: [{ id: sessionId, title: 'Push', day_number: 1, archived_at: null }],
    });
    // What RLS lets coach-1 read: the active block of an athlete they coach,
    // and their own active block under another coach.
    const programsChain = filteringChain([
      { student_id: 'st-1', name: 'Block A', is_active: true, student: { coach_id: 'coach-1' }, weeks: [week('w-1', 's-1')] },
      { student_id: 'st-self', name: 'My block', is_active: true, student: { coach_id: 'coach-other' }, weeks: [week('w-9', 's-9')] },
    ]);
    const confChain = readChain({ data: [], error: null });
    supabase.from.mockImplementation((table) => (table === 'programs' ? programsChain : confChain));

    const { result } = renderHook(() => useCoachDashboardPrograms(), { wrapper: withClient(makeClient()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(Object.keys(result.current.data)).toEqual(['st-1']);
  });

  it('reports the athlete position in the QUEUE, not an ordinal week', async () => {
    const programsChain = readChain({
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
                { id: 's-1', archived_at: null, day_number: 1 },
                { id: 's-2', archived_at: null, day_number: 3 },
              ],
            },
            {
              id: 'w-2',
              week_number: 2,
              label: 'Hyp',
              sessions: [{ id: 's-3', archived_at: null, day_number: 2 }],
            },
          ],
        },
      ],
      error: null,
    });
    const confChain = readChain({
      data: [{ session_id: 's-1' }, { session_id: 's-2' }],
      error: null,
    });
    supabase.from.mockImplementation((table) => (table === 'programs' ? programsChain : confChain));

    const qc = makeClient();
    const { result } = renderHook(() => useCoachDashboardPrograms(), {
      wrapper: withClient(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // Two of three sessions done → the athlete is on session 3 of 3. "W2"
    // said nothing about how far through the block they actually were.
    expect(result.current.data['st-1']).toMatchObject({
      programName: 'Block A',
      position: 3,
      totalSessions: 3,
    });
  });

  it('clamps position to the block size once every session is done', async () => {
    const programsChain = readChain({
      data: [
        {
          student_id: 'st-1',
          name: 'Done',
          weeks: [
            { id: 'w-1', week_number: 1, label: 'A', sessions: [{ id: 's-1', archived_at: null, day_number: 1 }] },
            { id: 'w-2', week_number: 2, label: 'B', sessions: [{ id: 's-2', archived_at: null, day_number: 1 }] },
          ],
        },
      ],
      error: null,
    });
    const confChain = readChain({
      data: [{ session_id: 's-1' }, { session_id: 's-2' }],
      error: null,
    });
    supabase.from.mockImplementation((table) => (table === 'programs' ? programsChain : confChain));

    const qc = makeClient();
    const { result } = renderHook(() => useCoachDashboardPrograms(), {
      wrapper: withClient(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // Finished blocks read "2 of 2", never "3 of 2".
    expect(result.current.data['st-1']).toMatchObject({ position: 2, totalSessions: 2 });
    expect(result.current.data['st-1'].nextSessionTitle).toBeNull();
  });

  it('builds a 7-slot weekDays array, placing undated sessions on their recommended weekday', async () => {
    const programsChain = readChain({
      data: [
        {
          student_id: 'st-1',
          name: 'Block A',
          weeks: [
            {
              id: 'w-1',
              week_number: 1,
              label: null,
              sessions: [
                { id: 's-mon', title: 'Push', day_number: 1, archived_at: null },
                { id: 's-wed', title: 'Pull', day_number: 3, archived_at: null },
                { id: 's-fri', title: 'Legs', day_number: 5, archived_at: null },
              ],
            },
          ],
        },
      ],
      error: null,
    });
    const confChain = readChain({
      data: [{ session_id: 's-mon' }],
      error: null,
    });
    supabase.from.mockImplementation((table) => (table === 'programs' ? programsChain : confChain));

    const qc = makeClient();
    const { result } = renderHook(() => useCoachDashboardPrograms(), {
      wrapper: withClient(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const days = result.current.data['st-1'].weekDays;
    expect(days).toHaveLength(7);
    // s-mon is confirmed but carries no performed_at (nothing logged), so it
    // falls back to counting as trained without inventing a date.
    expect(days[2]).toMatchObject({ dayNumber: 3, state: 'suggested' });
    expect(days[2].session).toMatchObject({ id: 's-wed' });
    expect(days[1].session).toBeNull();
    expect(days[1].state).toBe('rest');
    expect(days[6].session).toBeNull();
  });

  it('weekDays prefers the active session when an archived sibling shares the same day', async () => {
    const programsChain = readChain({
      data: [
        {
          student_id: 'st-1',
          name: 'P',
          weeks: [
            {
              id: 'w-1',
              week_number: 1,
              label: null,
              sessions: [
                { id: 's-old', title: 'Old', day_number: 1, archived_at: '2026-01-01' },
                { id: 's-new', title: 'New', day_number: 1, archived_at: null },
              ],
            },
          ],
        },
      ],
      error: null,
    });
    const confChain = readChain({ data: [], error: null });
    supabase.from.mockImplementation((table) => (table === 'programs' ? programsChain : confChain));

    const qc = makeClient();
    const { result } = renderHook(() => useCoachDashboardPrograms(), {
      wrapper: withClient(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data['st-1'].weekDays[0].session).toMatchObject({ id: 's-new' });
  });

  describe('calendar-week placement of dated sessions', () => {
    beforeEach(() => {
      // Freeze "today" at Thursday 2026-07-09 (current week: Mon 06 – Sun 12).
      // Only Date is faked so waitFor's real timers keep working.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(2026, 6, 9, 12, 0, 0));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    function mockDashboard(weeks, confirmations = []) {
      const programsChain = readChain({
        data: [{ student_id: 'st-1', name: 'Block A', weeks }],
        error: null,
      });
      const confChain = readChain({
        data: confirmations.map((id) => ({ session_id: id })),
        error: null,
      });
      supabase.from.mockImplementation((table) => (table === 'programs' ? programsChain : confChain));
    }

    async function renderDashboard() {
      const qc = makeClient();
      const { result } = renderHook(() => useCoachDashboardPrograms(), {
        wrapper: withClient(qc),
      });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      return result.current.data['st-1'].weekDays;
    }

    it('places dated sessions on their true date and hides ones outside the current week', async () => {
      mockDashboard([
        {
          id: 'w-1',
          week_number: 1,
          label: null,
          sessions: [
            // Dated Wednesday of the current week — day_number would say Monday.
            { id: 's-wed', title: 'Push', day_number: 1, scheduled_date: '2026-07-08', archived_at: null },
            // Dated NEXT Monday — must not render in this week's strip at all.
            { id: 's-next', title: 'Pull', day_number: 2, scheduled_date: '2026-07-13', archived_at: null },
          ],
        },
      ]);
      const days = await renderDashboard();
      expect(days[2].session).toMatchObject({ id: 's-wed' });
      expect(days[0].session).toBeNull();
      expect(days[1].session).toBeNull();
    });

    it('shows a dated session from a non-active training week when its date falls in the current week', async () => {
      mockDashboard([
        {
          id: 'w-1',
          week_number: 1,
          label: null,
          sessions: [{ id: 's-open', title: 'Open', day_number: 1, archived_at: null }],
        },
        {
          id: 'w-2',
          week_number: 2,
          label: null,
          sessions: [
            { id: 's-fri', title: 'Deadlift', day_number: 5, scheduled_date: '2026-07-10', archived_at: null },
          ],
        },
      ]);
      const days = await renderDashboard();
      // w-1 is the active week (s-open unconfirmed), yet w-2's dated session places.
      expect(days[0].session).toMatchObject({ id: 's-open' });
      expect(days[4].session).toMatchObject({ id: 's-fri' });
    });

    // The strip records days rather than tracking adherence, so the session
    // actually trained on Thursday owns Thursday. The pending one is not
    // hidden — it is the head of the queue, which is where the coach and the
    // athlete both read "what's next" now.
    it('gives the day to the session that was trained on it', async () => {
      mockDashboard(
        [
          {
            id: 'w-1',
            week_number: 1,
            label: null,
            sessions: [{ id: 's-due', title: 'Due', day_number: 4, archived_at: null }],
          },
          {
            id: 'w-2',
            week_number: 2,
            label: null,
            sessions: [
              { id: 's-done', title: 'Done', day_number: 4, scheduled_date: '2026-07-09', archived_at: null },
            ],
          },
        ],
        ['s-done']
      );
      const days = await renderDashboard();
      expect(days[3].session).toMatchObject({ id: 's-done' });
      expect(days[3].state).toBe('performed');
    });
  });
});


// Phase 3.4c: approve materializes set_logs from the draft's slot scalars and
// flips status to 'approved'; send-back clears submitted_at. Both are
// coach-only SECURITY DEFINER RPCs — the client half is just the call and the
// cache drop, and neither was covered before.
describe('useApproveProgram / useSendBackProgram', () => {
  beforeEach(() => {
    supabase.rpc.mockResolvedValue({ data: null, error: null });
  });

  it('useApproveProgram calls approve_program and refreshes the program caches', async () => {
    const qc = makeClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useApproveProgram(), { wrapper: withClient(qc) });
    result.current.mutate({ programId: 'p-1', studentId: 'st-1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(supabase.rpc).toHaveBeenCalledWith('approve_program', { p_program_id: 'p-1' });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['programs', 'st-1'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['active-program', 'st-1'] });
    // Approval materializes the student's set_logs, so their views must drop too.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['student-program-details'] });
  });

  it('useSendBackProgram calls send_back_program', async () => {
    const qc = makeClient();
    const { result } = renderHook(() => useSendBackProgram(), { wrapper: withClient(qc) });
    result.current.mutate({ programId: 'p-1', studentId: 'st-1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(supabase.rpc).toHaveBeenCalledWith('send_back_program', { p_program_id: 'p-1' });
  });

  it('surfaces an RPC rejection (a non-coach caller) as a failed mutation', async () => {
    supabase.rpc.mockResolvedValue({ data: null, error: new Error('permission denied') });
    const { result } = renderHook(() => useApproveProgram(), { wrapper: withClient(makeClient()) });
    result.current.mutate({ programId: 'p-1', studentId: 'st-1' });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
