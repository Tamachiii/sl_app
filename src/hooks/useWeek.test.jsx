import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import {
  useWeek,
  useDeleteWeek,
  useReorderWeeks,
  useReorderSessions,
  useMoveSession,
  useUpdateWeek,
  useUpdateSession,
  useArchiveSession,
  useDeleteSession,
  useCreateSession,
  useCreateWeek,
} from './useWeek';
import { createTestQueryClient } from '../test/utils';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';

vi.mock('../lib/supabase', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
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

// A client that keeps what a test seeds: the shared test client drops data
// once nothing observes it, which would collect an entry before the test can
// read what an optimistic write or a rollback left in it.
function createKeepingWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
  return { qc, wrapper: withClient(qc) };
}

// A request the test answers when it chooses to.
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const OK = { data: null, error: null };
// Long enough for a request that is not held back to have gone out.
const settle = () => new Promise((r) => setTimeout(r, 25));

beforeEach(() => {
  vi.clearAllMocks();
  // Answers too, not only calls: a test here queues one answer per request
  // (`mockReturnValueOnce`), and one left over would answer the next test.
  supabase.rpc.mockReset();
});

describe('useWeek', () => {
  it('fetches the week tree in one query, sorting sessions and slots by sort_order', async () => {
    const mockWeekQuery = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: {
          id: 'w-1',
          week_number: 1,
          sessions: [
            { id: 's-2', week_id: 'w-1', sort_order: 2, exercise_slots: [] },
            {
              id: 's-1',
              week_id: 'w-1',
              sort_order: 1,
              exercise_slots: [
                { id: 'sl-2', sort_order: 2 },
                { id: 'sl-1', sort_order: 1 },
              ],
            },
          ],
        },
      }),
    };
    supabase.from.mockImplementation((table) => (table === 'weeks' ? mockWeekQuery : {}));

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useWeek('w-1'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data.id).toBe('w-1');
    // One round trip, not a week fetch plus a dependent sessions fetch.
    expect(supabase.from).toHaveBeenCalledTimes(1);
    expect(result.current.data.sessions.map((s) => s.id)).toEqual(['s-1', 's-2']);
    expect(result.current.data.sessions[0].exercise_slots.map((s) => s.id)).toEqual([
      'sl-1',
      'sl-2',
    ]);
  });
});

describe('useCreateWeek', () => {
  it('inserts a week and invalidates the program caches', async () => {
    const chain = {
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { id: 'w-new' }, error: null }),
    };
    supabase.from.mockReturnValue(chain);

    const { qc, wrapper } = createWrapper();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useCreateWeek(), { wrapper });
    result.current.mutate({ programId: 'p-1', weekNumber: 5, label: null });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(chain.insert).toHaveBeenCalledWith({
      program_id: 'p-1',
      week_number: 5,
      label: null,
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['program'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['active-program'] });
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
    // Archiving hides the session from the coach's Confirmed feed and moves it
    // out of the dashboard week strip, so both roll-ups have to drop.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['all-confirmations'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['coach-dashboard-programs'] });

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
    // A weekday is an optional RECOMMENDATION: with no caller-supplied day the
    // session must be born WITHOUT one. `|| 1` used to make every new session
    // Monday, which silently tied them all at the same sort rank.
    expect(payload.day_number).toBeNull();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['week', 'w-1'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['program'] });
  });
});

// Review finding P51. Position became the block's order in 2026_08_22, so this
// is the coach's only ordering control — and the athlete's queue reads it. It
// used to be one request per row, in two passes (park at 100000+, then place):
// a request that was lost left the phase parked. It is one call of
// `reorder_sessions` now, which renumbers the whole phase or nothing.
describe('useReorderSessions', () => {
  const block = () => ({
    id: 'p-1',
    weeks: [
      {
        id: 'w-1',
        sessions: [
          { id: 'a', sort_order: 0 },
          { id: 'b', sort_order: 1 },
          { id: 'old', sort_order: 2, archived_at: '2026-01-01' },
        ],
      },
      { id: 'w-2', sessions: [{ id: 'z', sort_order: 0 }] },
    ],
  });

  it('is ONE reorder_sessions call with the full list, and no request per row', async () => {
    supabase.rpc.mockResolvedValue(OK);
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useReorderSessions('p-1'), { wrapper });

    // The archived session travels with the list: the unique key counts it,
    // and the function refuses a list that is not every session of the phase.
    result.current.mutate({ weekId: 'w-1', orderedIds: ['c', 'a', 'b', 'old'] });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(supabase.rpc).toHaveBeenCalledWith('reorder_sessions', {
      p_week_id: 'w-1',
      p_ids: ['c', 'a', 'b', 'old'],
    });
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('refreshes the athlete queue too — it reads this exact order', async () => {
    supabase.rpc.mockResolvedValue(OK);
    const { qc, wrapper } = createWrapper();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useReorderSessions('p-1'), { wrapper });

    result.current.mutate({ weekId: 'w-1', orderedIds: ['a', 'b'] });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['program'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['student-program-details'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['coach-dashboard-programs'] });
  });

  it('draws the new order before the database has answered, numbered as it will be', async () => {
    const answer = deferred();
    supabase.rpc.mockReturnValue(answer.promise);
    const { qc, wrapper } = createKeepingWrapper();
    qc.setQueryData(['program', 'p-1'], block());

    const { result } = renderHook(() => useReorderSessions('p-1'), { wrapper });
    act(() => {
      result.current.mutate({ weekId: 'w-1', orderedIds: ['b', 'a', 'old'] });
    });

    await waitFor(() => expect(supabase.rpc).toHaveBeenCalledTimes(1));
    const [first, second] = qc.getQueryData(['program', 'p-1']).weeks;
    // 0 to n-1 in the order of the list: what reorder_sessions leaves behind.
    expect(first.sessions.map((s) => [s.id, s.sort_order])).toEqual([['b', 0], ['a', 1], ['old', 2]]);
    expect(second.sessions.map((s) => s.id)).toEqual(['z']);

    answer.resolve(OK);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  // `reorder_ids_mismatch` is what a page loaded before a session was added,
  // moved or deleted sends. Nothing was written: the order on screen goes back,
  // and the lists are read again so the coach sees the phase as it is.
  it('puts the order back when the database refuses the list, and reads the block again', async () => {
    const refusal = { code: 'P0001', message: 'reorder_ids_mismatch' };
    supabase.rpc.mockResolvedValue({ data: null, error: refusal });
    const { qc, wrapper } = createKeepingWrapper();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    qc.setQueryData(['program', 'p-1'], block());

    const { result } = renderHook(() => useReorderSessions('p-1'), { wrapper });
    act(() => {
      result.current.mutate({ weekId: 'w-1', orderedIds: ['b', 'a', 'old'] });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBe(refusal);
    expect(qc.getQueryData(['program', 'p-1'])).toEqual(block());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['program'] });
    // Once: a refusal is not sent again.
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
  });
});

describe('useReorderWeeks', () => {
  const block = () => ({
    id: 'p-1',
    weeks: [
      { id: 'w-a', week_number: 1 },
      { id: 'w-b', week_number: 2 },
      { id: 'w-c', week_number: 3 },
    ],
  });

  it('is ONE reorder_weeks call with every phase of the block, and no request per row', async () => {
    supabase.rpc.mockResolvedValue(OK);
    const { qc, wrapper } = createWrapper();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useReorderWeeks('p-1'), { wrapper });

    result.current.mutate({ programId: 'p-1', orderedIds: ['w-c', 'w-a', 'w-b'] });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(supabase.rpc).toHaveBeenCalledWith('reorder_weeks', {
      p_program_id: 'p-1',
      p_ids: ['w-c', 'w-a', 'w-b'],
    });
    expect(supabase.from).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['program'] });
    // The athlete's queue runs through the phases in this order.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['student-program-details'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['coach-dashboard-programs'] });
  });

  it('optimistically rewrites the matching ["program", x] cache', async () => {
    const answer = deferred();
    supabase.rpc.mockReturnValue(answer.promise);
    const { qc, wrapper } = createKeepingWrapper();
    qc.setQueryData(['program', 'p-1'], block());
    qc.setQueryData(['program', 'other'], {
      id: 'other',
      weeks: [{ id: 'x', week_number: 1 }],
    });

    const { result } = renderHook(() => useReorderWeeks('p-1'), { wrapper });
    act(() => {
      result.current.mutate({ programId: 'p-1', orderedIds: ['w-c', 'w-a', 'w-b'] });
    });

    await waitFor(() => expect(supabase.rpc).toHaveBeenCalledTimes(1));
    const data = qc.getQueryData(['program', 'p-1']);
    // 1 to n in the order of the list: what reorder_weeks leaves behind.
    expect(data.weeks.map((w) => [w.id, w.week_number])).toEqual([['w-c', 1], ['w-a', 2], ['w-b', 3]]);
    // Other program left untouched.
    expect(qc.getQueryData(['program', 'other']).weeks[0].id).toBe('x');

    answer.resolve(OK);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it('rolls back on failure', async () => {
    const refusal = { code: 'P0001', message: 'reorder_ids_mismatch' };
    supabase.rpc.mockResolvedValue({ data: null, error: refusal });
    const { qc, wrapper } = createKeepingWrapper();
    qc.setQueryData(['program', 'p-1'], block());

    const { result } = renderHook(() => useReorderWeeks('p-1'), { wrapper });
    act(() => {
      result.current.mutate({ programId: 'p-1', orderedIds: ['w-b', 'w-a', 'w-c'] });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBe(refusal);
    expect(qc.getQueryData(['program', 'p-1'])).toEqual(block());
  });
});

describe('useMoveSession', () => {
  it('is one move_session call, and reads again everything that shows the order of the block', async () => {
    supabase.rpc.mockResolvedValue(OK);
    const { qc, wrapper } = createWrapper();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useMoveSession('p-1'), { wrapper });

    result.current.mutate({
      sessionId: 's-2',
      destWeekId: 'w-2',
      sourceIds: ['s-1', 's-old'],
      destIds: ['s-2', 's-3'],
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(supabase.rpc).toHaveBeenCalledWith('move_session', {
      p_session_id: 's-2',
      p_dest_week_id: 'w-2',
      p_source_ids: ['s-1', 's-old'],
      p_dest_ids: ['s-2', 's-3'],
    });
    for (const queryKey of [['program'], ['week'], ['student-program-details'], ['coach-dashboard-programs']]) {
      expect(invalidate).toHaveBeenCalledWith({ queryKey });
    }
  });

  const block = () => ({
    id: 'p-1',
    weeks: [
      {
        id: 'w-1',
        sessions: [
          { id: 'a', title: 'Pull', sort_order: 0 },
          { id: 'b', title: 'Push', sort_order: 1 },
          { id: 'old', title: 'Old', sort_order: 2, archived_at: '2026-01-01' },
        ],
      },
      { id: 'w-2', sessions: [{ id: 'c', title: 'Legs', sort_order: 0 }] },
      { id: 'w-3', sessions: [{ id: 'z', title: 'Core', sort_order: 4 }] },
    ],
  });
  // 'b' dropped on 'c': out of the first phase, in front of 'c' in the second.
  const move = { sessionId: 'b', destWeekId: 'w-2', sourceIds: ['a', 'old'], destIds: ['b', 'c'] };

  // The next drag is made from the list on screen, and may be made before this
  // one is answered: the session has to be shown where it was dropped, with
  // both phases numbered the way `move_session` leaves them.
  it('draws the move before the database has answered, both phases numbered as they will be', async () => {
    supabase.rpc.mockReturnValue(deferred().promise);
    const { qc, wrapper } = createKeepingWrapper();
    qc.setQueryData(['program', 'p-1'], block());
    // Another block in the cache: it holds neither end of the move.
    qc.setQueryData(['program', 'p-9'], { id: 'p-9', weeks: [{ id: 'w-9', sessions: [{ id: 'q', sort_order: 0 }] }] });

    const { result } = renderHook(() => useMoveSession('p-1'), { wrapper });
    act(() => {
      result.current.mutate(move);
    });

    await waitFor(() => {
      expect(qc.getQueryData(['program', 'p-1']).weeks.map((w) => w.sessions)).toEqual([
        [
          { id: 'a', title: 'Pull', sort_order: 0 },
          { id: 'old', title: 'Old', sort_order: 1, archived_at: '2026-01-01' },
        ],
        [
          { id: 'b', title: 'Push', sort_order: 0 },
          { id: 'c', title: 'Legs', sort_order: 1 },
        ],
        // A phase the move does not touch keeps its numbers.
        [{ id: 'z', title: 'Core', sort_order: 4 }],
      ]);
    });
    expect(qc.getQueryData(['program', 'p-9']).weeks[0].sessions).toEqual([{ id: 'q', sort_order: 0 }]);
    expect(result.current.isPending).toBe(true);
  });

  it('puts the session back where it was when the database refuses the move, and reads the block again', async () => {
    const refusal = { code: 'P0001', message: 'cross_program_move' };
    supabase.rpc.mockResolvedValue({ data: null, error: refusal });
    const { qc, wrapper } = createKeepingWrapper();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    qc.setQueryData(['program', 'p-1'], block());

    const { result } = renderHook(() => useMoveSession('p-1'), { wrapper });
    act(() => {
      result.current.mutate(move);
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBe(refusal);
    expect(qc.getQueryData(['program', 'p-1'])).toEqual(block());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['program'] });
  });

  it('draws nothing for a session that is in its destination already', async () => {
    supabase.rpc.mockResolvedValue(OK);
    const { qc, wrapper } = createKeepingWrapper();
    qc.setQueryData(['program', 'p-1'], block());

    const { result } = renderHook(() => useMoveSession('p-1'), { wrapper });
    // The same move twice over: the page still held the list from before.
    result.current.mutate({ ...move, sessionId: 'c' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(qc.getQueryData(['program', 'p-1'])).toEqual(block());
  });
});

// A drag sends the FULL list of ids as the sheet shows it, so the order it was
// read from has to be the one the drag before it asked for. The three writes a
// drag can end in — sessions within a phase, a session across phases, the
// phases — therefore wait for each other, block by block.
describe('the order of a block: one drag at a time', () => {
  function renderOrderHooks(wrapper, blockId = 'p-1') {
    return renderHook(
      () => ({
        sessions: useReorderSessions(blockId),
        weeks: useReorderWeeks(blockId),
        move: useMoveSession(blockId),
      }),
      { wrapper },
    );
  }

  it('does not send the second reorder until the first has been answered', async () => {
    const first = deferred();
    supabase.rpc.mockReturnValueOnce(first.promise).mockResolvedValue(OK);
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useReorderSessions('p-1'), { wrapper });

    act(() => {
      result.current.mutate({ weekId: 'w-1', orderedIds: ['b', 'a', 'c'] });
    });
    await waitFor(() => expect(supabase.rpc).toHaveBeenCalledTimes(1));
    act(() => {
      result.current.mutate({ weekId: 'w-1', orderedIds: ['b', 'c', 'a'] });
    });
    await act(settle);
    expect(supabase.rpc).toHaveBeenCalledTimes(1);

    first.resolve(OK);
    await waitFor(() => expect(supabase.rpc).toHaveBeenCalledTimes(2));
    // In the order the drags were made: the last one is the one that stays.
    expect(supabase.rpc.mock.calls.map(([, args]) => args.p_ids)).toEqual([
      ['b', 'a', 'c'],
      ['b', 'c', 'a'],
    ]);
  });

  it('queues a reorder of sessions, a reorder of phases and a move of the same block together', async () => {
    const first = deferred();
    supabase.rpc.mockReturnValueOnce(first.promise).mockResolvedValue(OK);
    const { wrapper } = createWrapper();
    const { result } = renderOrderHooks(wrapper);

    act(() => {
      result.current.sessions.mutate({ weekId: 'w-1', orderedIds: ['b', 'a'] });
    });
    await waitFor(() => expect(supabase.rpc).toHaveBeenCalledTimes(1));
    act(() => {
      result.current.weeks.mutate({ programId: 'p-1', orderedIds: ['w-2', 'w-1'] });
      result.current.move.mutate({ sessionId: 'b', destWeekId: 'w-2', sourceIds: ['a'], destIds: ['b'] });
    });
    await act(settle);
    expect(supabase.rpc).toHaveBeenCalledTimes(1);

    first.resolve(OK);
    await waitFor(() => expect(supabase.rpc).toHaveBeenCalledTimes(3));
    expect(supabase.rpc.mock.calls.map(([fn]) => fn)).toEqual([
      'reorder_sessions',
      'reorder_weeks',
      'move_session',
    ]);
  });

  it('lets two blocks go out side by side', async () => {
    supabase.rpc.mockReturnValue(deferred().promise);
    const { wrapper } = createWrapper();
    const { result } = renderHook(
      () => ({ one: useReorderSessions('p-1'), other: useReorderSessions('p-2') }),
      { wrapper },
    );

    act(() => {
      result.current.one.mutate({ weekId: 'w-1', orderedIds: ['b', 'a'] });
      result.current.other.mutate({ weekId: 'w-9', orderedIds: ['y', 'x'] });
    });
    await waitFor(() => expect(supabase.rpc).toHaveBeenCalledTimes(2));
  });

  // The first of two drags must not read the block again: the answer would be
  // the order before the second one, on screen in place of the order the coach
  // has just made — and the list a third drag would send.
  it('leaves the refetch to the last drag of a run, so the order on screen stays the last one made', async () => {
    const first = deferred();
    const second = deferred();
    supabase.rpc.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { qc, wrapper } = createKeepingWrapper();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    qc.setQueryData(['program', 'p-1'], {
      id: 'p-1',
      weeks: [{ id: 'w-1', sessions: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }],
    });
    const shown = () => qc.getQueryData(['program', 'p-1']).weeks[0].sessions.map((s) => s.id);

    const { result } = renderHook(() => useReorderSessions('p-1'), { wrapper });
    act(() => {
      result.current.mutate({ weekId: 'w-1', orderedIds: ['b', 'a', 'c'] });
    });
    await waitFor(() => expect(supabase.rpc).toHaveBeenCalledTimes(1));
    act(() => {
      result.current.mutate({ weekId: 'w-1', orderedIds: ['b', 'c', 'a'] });
    });
    await waitFor(() => expect(shown()).toEqual(['b', 'c', 'a']));

    first.resolve(OK);
    // The second request is out: the first one has settled.
    await waitFor(() => expect(supabase.rpc).toHaveBeenCalledTimes(2));
    expect(invalidate).not.toHaveBeenCalled();
    expect(shown()).toEqual(['b', 'c', 'a']);

    second.resolve(OK);
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['program'] }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['student-program-details'] });
  });

  it('sends the drag behind one that failed, and reads the block again after it', async () => {
    const first = deferred();
    supabase.rpc.mockReturnValueOnce(first.promise).mockResolvedValue(OK);
    const { qc, wrapper } = createKeepingWrapper();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useReorderSessions('p-1'), { wrapper });
    act(() => {
      result.current.mutate({ weekId: 'w-1', orderedIds: ['b', 'a', 'c'] });
    });
    await waitFor(() => expect(supabase.rpc).toHaveBeenCalledTimes(1));
    act(() => {
      result.current.mutate({ weekId: 'w-1', orderedIds: ['b', 'c', 'a'] });
    });
    await act(settle);

    first.resolve({ data: null, error: { message: 'Failed to fetch' } });
    await waitFor(() => expect(supabase.rpc).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['program'] }));
  });

  // A snapshot is the whole block from before its drag. Put back while a later
  // drag waits, it takes that drag's order off the screen, and the next drag
  // would send a list without it. The last drag reads the server again, which
  // also settles what the failed one left on screen.
  it('does not put the order back for a drag that failed while a later one waits', async () => {
    const first = deferred();
    const second = deferred();
    supabase.rpc.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { qc, wrapper } = createKeepingWrapper();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    qc.setQueryData(['program', 'p-1'], {
      id: 'p-1',
      weeks: [
        { id: 'w-1', sessions: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
        { id: 'w-2', sessions: [{ id: 'x' }, { id: 'y' }] },
      ],
    });
    const shown = () =>
      qc.getQueryData(['program', 'p-1']).weeks.map((w) => w.sessions.map((s) => s.id));

    const { result } = renderOrderHooks(wrapper);
    act(() => {
      result.current.sessions.mutate({ weekId: 'w-1', orderedIds: ['b', 'a', 'c'] });
    });
    await waitFor(() => expect(supabase.rpc).toHaveBeenCalledTimes(1));
    act(() => {
      result.current.sessions.mutate({ weekId: 'w-2', orderedIds: ['y', 'x'] });
    });
    await waitFor(() => expect(shown()).toEqual([['b', 'a', 'c'], ['y', 'x']]));

    first.resolve({ data: null, error: { message: 'Failed to fetch' } });
    // The second request is out: the first one has failed and settled.
    await waitFor(() => expect(supabase.rpc).toHaveBeenCalledTimes(2));
    expect(shown()).toEqual([['b', 'a', 'c'], ['y', 'x']]);
    expect(invalidate).not.toHaveBeenCalled();

    second.resolve(OK);
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['program'] }));
  });

  // The hooks keep one block for as long as they live — the sheet is mounted
  // once per block — so a coach who picks another block unmounts hooks that
  // may have a write waiting. It is in the cache as it was made: it is sent in
  // its turn, and it reads the block again.
  it('sends the write that was waiting when its hooks were unmounted, and reads the block again', async () => {
    const first = deferred();
    supabase.rpc.mockReturnValueOnce(first.promise).mockResolvedValue(OK);
    const { qc, wrapper } = createKeepingWrapper();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result, unmount } = renderOrderHooks(wrapper);

    act(() => {
      result.current.sessions.mutate({ weekId: 'w-1', orderedIds: ['b', 'a'] });
    });
    await waitFor(() => expect(supabase.rpc).toHaveBeenCalledTimes(1));
    act(() => {
      result.current.move.mutate({ sessionId: 'b', destWeekId: 'w-2', sourceIds: ['a'], destIds: ['b'] });
    });
    await act(settle);
    unmount();
    // The sheet of another block, mounted in its place.
    renderOrderHooks(wrapper, 'p-2');
    expect(supabase.rpc).toHaveBeenCalledTimes(1);

    first.resolve(OK);
    await waitFor(() => expect(supabase.rpc).toHaveBeenCalledTimes(2));
    expect(supabase.rpc.mock.calls[1][0]).toBe('move_session');
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['program'] }));
  });

  // The sheet always names its block. A caller that does not gets no queue:
  // its writes go out at once, as a mutation without a scope always does.
  it('holds nothing back for a hook that was given no block', async () => {
    supabase.rpc.mockReturnValue(deferred().promise);
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useReorderSessions(), { wrapper });

    act(() => {
      result.current.mutate({ weekId: 'w-1', orderedIds: ['b', 'a'] });
      result.current.mutate({ weekId: 'w-1', orderedIds: ['a', 'b'] });
    });
    await waitFor(() => expect(supabase.rpc).toHaveBeenCalledTimes(2));
  });
});
