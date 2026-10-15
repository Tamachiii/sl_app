import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider, MutationCache } from '@tanstack/react-query';

vi.mock('../lib/supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }));
vi.mock('../lib/toast', () => ({ pushToast: vi.fn() }));

import {
  useDuplicateWeek,
  useDuplicateSession,
  useDuplicateProgram,
  useCopySessions,
} from './useDuplicate';
import { supabase } from '../lib/supabase';
import { pushToast } from '../lib/toast';
import { queryClient as appClient } from '../lib/queryClient';

// A client that keeps what a test seeds (the shared test client drops data
// nothing observes), with the mutation cache of the APP: its `onError` is what
// turns a failed mutation into a toast, so "the coach is told once" is counted
// on the handler that runs in production, not on a copy of it.
function makeClient() {
  return new QueryClient({
    mutationCache: new MutationCache({ onError: appClient.getMutationCache().config.onError }),
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
function setup(useHook) {
  const qc = makeClient();
  const invalidate = vi.spyOn(qc, 'invalidateQueries');
  const { result, unmount } = renderHook(() => useHook(), { wrapper: withClient(qc) });
  return { qc, invalidate, result, unmount };
}

// What each function answers (migration 2026_10_13_12_copy_rpcs).
const SESSION_ANSWER = {
  session_id: 's-copy',
  week_id: 'w-1',
  sort_order: 2,
  title: 'Pull (copy)',
  slots: 4,
  set_logs: 12,
  slots_left_out: 0,
};
const COPY_ANSWER = {
  session_ids: ['c-1', 'c-2', 'c-3'],
  week_id: 'w-dest',
  slots: 9,
  set_logs: 27,
  slots_left_out: 0,
};
const WEEK_ANSWER = {
  week_id: 'w-copy',
  program_id: 'p-1',
  week_number: 4,
  label: 'Base (copy)',
  sessions: 3,
  slots: 9,
  set_logs: 27,
  slots_left_out: 0,
};
const PROGRAM_ANSWER = {
  program_id: 'p-copy',
  student_id: 'st-1',
  name: 'Block 1 (copy)',
  sort_order: 3,
  weeks: 2,
  sessions: 6,
  slots: 18,
  set_logs: 54,
  slots_left_out: 0,
};

// Everything that shows what a block holds…
const BLOCKS = [
  ['program'],
  ['week'],
  ['session'],
  ['set-logs'],
  ['student-program-details'],
  ['coach-dashboard-programs'],
];
// …and, for a new phase or a new block, the lists of programs: a row of one
// is a block, and counts its phases.
const LISTS = [['programs']];

// A session duplicated is announced with a way back (review item L15).
const UNDO_TOAST = [
  'Session duplicated',
  { kind: 'info', action: { label: 'uiSharedHelpers.undo', onClick: expect.any(Function) } },
];

// The four hooks side by side: the call each one makes, what it answers, and
// what it says when the copy is complete.
const HOOKS = [
  {
    name: 'useDuplicateSession',
    useHook: useDuplicateSession,
    vars: { sessionId: 's-1' },
    rpc: ['duplicate_session', { p_session_id: 's-1' }],
    answer: SESSION_ANSWER,
    readAgain: BLOCKS,
    madeToasts: [UNDO_TOAST],
  },
  {
    name: 'useCopySessions',
    useHook: useCopySessions,
    vars: { sessionIds: ['s-2', 's-1', 's-2'], weekId: 'w-dest' },
    rpc: ['copy_sessions', { p_session_ids: ['s-2', 's-1', 's-2'], p_dest_week_id: 'w-dest' }],
    answer: COPY_ANSWER,
    readAgain: BLOCKS,
    madeToasts: [],
  },
  {
    name: 'useDuplicateWeek',
    useHook: useDuplicateWeek,
    vars: { weekId: 'w-1' },
    rpc: ['duplicate_week', { p_week_id: 'w-1', p_dest_program_id: null }],
    answer: WEEK_ANSWER,
    readAgain: [...BLOCKS, ...LISTS],
    madeToasts: [],
  },
  {
    name: 'useDuplicateProgram',
    useHook: useDuplicateProgram,
    vars: { programId: 'p-1', studentId: 'st-1' },
    rpc: ['duplicate_program', { p_program_id: 'p-1' }],
    answer: PROGRAM_ANSWER,
    readAgain: [...BLOCKS, ...LISTS],
    madeToasts: [],
  },
];

// The keys a hook invalidated — these and no other, in any order.
const sorted = (keys) => keys.map((key) => JSON.stringify(key)).sort();
const keysReadAgain = (invalidate) => sorted(invalidate.mock.calls.map(([filters]) => filters.queryKey));

const answers = (data) => supabase.rpc.mockResolvedValue({ data, error: null });
const refuses = (error) => supabase.rpc.mockResolvedValue({ data: null, error });

beforeEach(() => {
  vi.clearAllMocks();
  supabase.rpc.mockReset();
});

describe.each(HOOKS)('$name', ({ useHook, vars, rpc, answer, readAgain, madeToasts }) => {
  // One request, so one transaction: the copy is whole or is not there. The
  // requests this replaced — one per row or per table — left a session without
  // its exercises when one of them was lost.
  it('is ONE call of its function, with these arguments and no other', async () => {
    answers(answer);
    const { result } = setup(useHook);

    result.current.mutate(vars);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // toStrictEqual: an argument sent as `undefined` would not be equal.
    expect(supabase.rpc.mock.calls).toStrictEqual([rpc]);
    // No row is read or written by the app itself any more.
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('reads again everything that shows what a block holds', async () => {
    answers(answer);
    const { result, invalidate } = setup(useHook);

    result.current.mutate(vars);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(keysReadAgain(invalidate)).toEqual(sorted(readAgain));
  });

  // What the functions refuse is something the page still shows — a session
  // deleted in another tab, a phase moved while the call waited — so the
  // lists are read again after a refusal too. And nothing was written: there
  // is no second try and nothing to clean up.
  it('sends a refused copy once, tells the coach once, and reads the block again', async () => {
    const refusal = { code: 'P0001', message: 'copy_source_changed' };
    refuses(refusal);
    const { result, invalidate } = setup(useHook);

    result.current.mutate(vars);
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(supabase.from).not.toHaveBeenCalled();
    expect(result.current.error).toBe(refusal);
    // The error is the database's, as it came.
    expect(refusal).toStrictEqual({ code: 'P0001', message: 'copy_source_changed' });
    // One toast, from the mutation cache of the app; none from the hook.
    expect(pushToast.mock.calls).toEqual([['errors.generic', { kind: 'error' }]]);
    expect(keysReadAgain(invalidate)).toEqual(sorted(readAgain));
  });

  it('says "not allowed" for a place the caller reads and may not write', async () => {
    refuses({ code: '42501', message: 'not authorized' });
    const { result } = setup(useHook);

    result.current.mutate(vars);
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(pushToast.mock.calls).toEqual([['errors.notAllowed', { kind: 'error' }]]);
  });

  // After a change of coach an athlete's older blocks still name exercises of
  // the former coach's library. The function copies the rest and counts them:
  // the copy looks complete and is not, so the coach has to be told.
  it('says how many exercises the copy left out', async () => {
    answers({ ...answer, slots_left_out: 2 });
    const { result } = setup(useHook);

    result.current.mutate(vars);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(pushToast.mock.calls).toEqual([
      ...madeToasts,
      ['Exercises left out of the copy: 2 — not in your library.', { kind: 'info' }],
    ]);
  });

  it('says nothing more about a copy that is complete', async () => {
    answers(answer);
    const { result } = setup(useHook);

    result.current.mutate(vars);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(pushToast.mock.calls).toEqual(madeToasts);
  });
});

describe('what a copy hook returns', () => {
  // The answer as it is: a later caller reads the id of what was made in it
  // (`session_id` for an undo, `week_id` to scroll to the new phase).
  it.each(HOOKS.filter(({ name }) => name !== 'useDuplicateProgram'))(
    '$name returns the answer of its function, untouched',
    async ({ useHook, vars, answer }) => {
      answers(answer);
      const { result } = setup(useHook);

      result.current.mutate(vars);
      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data).toBe(answer);
    },
  );

  // "Duplicate program" selects the copy by `id`, as it selects any program.
  it('useDuplicateProgram returns the answer with the id of the copy as `id`', async () => {
    answers(PROGRAM_ANSWER);
    const { result } = setup(useDuplicateProgram);

    result.current.mutate({ programId: 'p-1', studentId: 'st-1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual({ ...PROGRAM_ANSWER, id: 'p-copy' });
  });
});

describe('useDuplicateWeek', () => {
  // "Copy this phase to…": the block picked in the dialog, the coach's own or
  // another athlete's.
  it('sends the block the phase is copied to', async () => {
    answers({ ...WEEK_ANSWER, program_id: 'p-other' });
    const { result } = setup(useDuplicateWeek);

    result.current.mutate({ weekId: 'w-1', programId: 'p-other' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(supabase.rpc.mock.calls).toStrictEqual([
      ['duplicate_week', { p_week_id: 'w-1', p_dest_program_id: 'p-other' }],
    ]);
  });
});

describe('useDuplicateProgram and the list of programs', () => {
  const LIST = [
    { id: 'p-1', student_id: 'st-1', name: 'Block 1', sort_order: 0, is_active: true, weeks: [{ id: 'w-1' }] },
    { id: 'p-2', student_id: 'st-1', name: 'Block 2', sort_order: 1, is_active: false, weeks: [] },
  ];
  // A row of useProgramsForStudent, as duplicate_program leaves a copy:
  // approved, inactive, not submitted.
  const SEEDED = {
    id: 'p-copy',
    student_id: 'st-1',
    name: 'Block 1 (copy)',
    sort_order: 3,
    is_active: false,
    status: 'approved',
    submitted_at: null,
    weeks: [],
  };

  // The caller selects the copy in its own onSuccess, and CoachHome drops a
  // ?program that is not in the list: the copy has to be in it by then, before
  // any refetch has answered.
  it('puts the copy in the list before the caller is told it is made', async () => {
    answers(PROGRAM_ANSWER);
    const { qc, result } = setup(useDuplicateProgram);
    qc.setQueryData(['programs', 'st-1'], LIST);

    let listSeenByCaller;
    result.current.mutate(
      { programId: 'p-1', studentId: 'st-1' },
      {
        onSuccess: () => {
          listSeenByCaller = qc.getQueryData(['programs', 'st-1']);
        },
      },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(listSeenByCaller).toEqual([...LIST, SEEDED]);
    // The block that is trained stays the active one.
    expect(listSeenByCaller.filter((p) => p.is_active).map((p) => p.id)).toEqual(['p-1']);
  });

  it('makes no list where none was read', async () => {
    answers(PROGRAM_ANSWER);
    const { qc, result } = setup(useDuplicateProgram);

    result.current.mutate({ programId: 'p-1', studentId: 'st-1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(qc.getQueryData(['programs', 'st-1'])).toBeUndefined();
  });

  // The function names the athlete the copy was made for. That is the list it
  // belongs in, whatever page the call was made from.
  it('puts the copy in the list of the athlete the function names', async () => {
    answers({ ...PROGRAM_ANSWER, student_id: 'st-2' });
    const { qc, result } = setup(useDuplicateProgram);
    qc.setQueryData(['programs', 'st-1'], LIST);
    qc.setQueryData(['programs', 'st-2'], []);

    result.current.mutate({ programId: 'p-1', studentId: 'st-1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(qc.getQueryData(['programs', 'st-1'])).toEqual(LIST);
    expect(qc.getQueryData(['programs', 'st-2'])).toEqual([{ ...SEEDED, student_id: 'st-2' }]);
  });

  it('does not list a copy twice', async () => {
    answers(PROGRAM_ANSWER);
    const { qc, result } = setup(useDuplicateProgram);
    qc.setQueryData(['programs', 'st-1'], [...LIST, SEEDED]);

    result.current.mutate({ programId: 'p-1', studentId: 'st-1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(qc.getQueryData(['programs', 'st-1'])).toEqual([...LIST, SEEDED]);
  });

  it('leaves the list as it was when the copy is refused', async () => {
    refuses({ code: 'P0001', message: 'program_not_found' });
    const { qc, result } = setup(useDuplicateProgram);
    qc.setQueryData(['programs', 'st-1'], LIST);

    result.current.mutate({ programId: 'p-gone', studentId: 'st-1' });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(qc.getQueryData(['programs', 'st-1'])).toEqual(LIST);
  });
});

describe('useDuplicateSession', () => {
  // Review item B26: the function's suffix is English, " (copy)". The sheet
  // sends the coach's.
  it('sends the suffix it is given', async () => {
    answers({ ...SESSION_ANSWER, title: 'Pull (copie)' });
    const { result } = setup(useDuplicateSession);

    result.current.mutate({ sessionId: 's-1', titleSuffix: ' (copie)' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(supabase.rpc.mock.calls).toStrictEqual([
      ['duplicate_session', { p_session_id: 's-1', p_title_suffix: ' (copie)' }],
    ]);
  });

  // An empty suffix copies the title as it is, null included: the copy of an
  // untitled session stays untitled instead of "Session (copy)".
  it('sends an empty suffix as it is', async () => {
    answers({ ...SESSION_ANSWER, title: null });
    const { result } = setup(useDuplicateSession);

    result.current.mutate({ sessionId: 's-1', titleSuffix: '' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(supabase.rpc.mock.calls).toStrictEqual([
      ['duplicate_session', { p_session_id: 's-1', p_title_suffix: '' }],
    ]);
  });

  describe('Undo', () => {
    // The `sessions` table as useDeleteSession reads and deletes it.
    function sessionsTable() {
      const deleted = [];
      supabase.from.mockImplementation(() => ({
        select: () => ({
          eq: () => ({ single: () => Promise.resolve({ data: { week_id: 'w-1' }, error: null }) }),
        }),
        delete: () => ({
          eq: (column, id) => {
            deleted.push([column, id]);
            return Promise.resolve({ error: null });
          },
        }),
      }));
      return deleted;
    }

    async function duplicate() {
      answers(SESSION_ANSWER);
      const made = setup(useDuplicateSession);
      made.result.current.mutate({ sessionId: 's-1', titleSuffix: ' (copy)' });
      await waitFor(() => expect(made.result.current.isSuccess).toBe(true));
      const [, { action }] = pushToast.mock.calls.find(([message]) => message === 'Session duplicated');
      return { ...made, undo: action.onClick };
    }

    it('deletes the copy, and nothing else, and reads the sheet again', async () => {
      const deleted = sessionsTable();
      const { undo, invalidate } = await duplicate();
      invalidate.mockClear();

      act(() => undo());
      await waitFor(() => expect(deleted).toEqual([['id', 's-copy']]));
      await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['program'] }));
      expect(supabase.rpc).toHaveBeenCalledTimes(1);
    });

    // A callback given to `mutate()` dies with the sheet; the toast stays 8 s
    // and the coach may have left by then.
    it('still deletes the copy once the sheet that made it is gone', async () => {
      const deleted = sessionsTable();
      const { undo, unmount } = await duplicate();
      unmount();

      act(() => undo());
      await waitFor(() => expect(deleted).toEqual([['id', 's-copy']]));
    });

    it('is not offered for a copy that was refused', async () => {
      refuses({ code: 'P0001', message: 'session_not_found' });
      const { result } = setup(useDuplicateSession);

      result.current.mutate({ sessionId: 's-gone', titleSuffix: ' (copy)' });
      await waitFor(() => expect(result.current.isError).toBe(true));

      expect(pushToast.mock.calls.some(([, options]) => options?.action)).toBe(false);
    });
  });
});
