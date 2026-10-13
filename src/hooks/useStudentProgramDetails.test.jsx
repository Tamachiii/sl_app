import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../lib/supabase', () => ({ supabase: { from: vi.fn() } }));

import {
  studentProgramDetailsKey,
  studentPastProgramKey,
  useStudentProgramDetails,
  useStudentPastProgram,
} from './useStudentProgramDetails';
import { supabase } from '../lib/supabase';
import { shouldPersistQuery } from '../lib/queryClient';
import { fakePostgrest } from '../test/fakePostgrest';

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

const filtersOf = (request) =>
  request.filters.map(([op, column, value]) => `${op} ${column} ${value}`);
const isActiveFilter = (request) =>
  request.filters.find(([op, column]) => op === 'eq' && column === 'is_active')?.[2];

// The block being trained, as PostgREST nests it — deliberately out of order.
const ACTIVE_TREE = {
  id: 'p-2',
  name: 'Bloc 3',
  sort_order: 2,
  is_active: true,
  weeks: [
    {
      id: 'w-2',
      week_number: 2,
      label: null,
      sessions: [
        {
          id: 's-2b',
          sort_order: 1,
          title: 'B',
          archived_at: null,
          exercise_slots: [
            { id: 'sl-b', sort_order: 1, sets: 1, set_logs: [] },
            {
              id: 'sl-a',
              sort_order: 0,
              sets: 2,
              set_logs: [{ set_number: 2 }, { set_number: 1 }],
            },
          ],
        },
        { id: 's-2a', sort_order: 0, title: 'A', archived_at: null, exercise_slots: [] },
      ],
    },
    { id: 'w-1', week_number: 1, label: 'Base', sessions: [] },
  ],
};

// The other blocks, as the header request returns them: no column of a
// session but `archived_at`.
const PAST_HEADERS = [
  {
    id: 'p-0',
    name: 'Bloc 1',
    sort_order: 0,
    weeks: [{ sessions: [{ archived_at: null }, { archived_at: null }] }],
  },
  {
    id: 'p-1',
    name: 'Bloc 2',
    sort_order: 1,
    weeks: [
      { sessions: [{ archived_at: null }, { archived_at: '2026-08-01T00:00:00Z' }] },
      { sessions: [{ archived_at: null }] },
    ],
  },
];

// `programs` answers by what was asked: the tree of the active block, the
// headers of the others, or one block by its id.
function wire({ active = [ACTIVE_TREE], past = PAST_HEADERS, byId = {}, programs } = {}) {
  const db = fakePostgrest({
    students: [{ id: 'st-1' }],
    programs:
      programs ??
      ((request) => {
        const id = request.filters.find(([op, column]) => op === 'eq' && column === 'id')?.[2];
        if (id) return byId[id] ? [byId[id]] : [];
        return isActiveFilter(request) ? active : past;
      }),
  });
  supabase.from.mockImplementation(db.from);
  return db;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the keys', () => {
  const settled = (queryKey) => ({ queryKey, state: { status: 'success' } });

  // The defect this pins: the list read a key the device does not keep, and
  // came back empty at the next launch without a network.
  it('the list is read under a key the device keeps', async () => {
    wire();
    const qc = makeClient();
    const { result } = renderHook(() => useStudentProgramDetails('u-1'), {
      wrapper: withClient(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // What the hook really cached, not what the helper says it would.
    const cached = qc.getQueryCache().getAll();
    expect(cached.map((q) => q.queryKey)).toEqual([studentProgramDetailsKey('u-1')]);
    expect(shouldPersistQuery(cached[0])).toBe(true);
  });

  it('the sessions of a past block are not written to the device', async () => {
    wire({ byId: { 'p-0': { ...ACTIVE_TREE, id: 'p-0', is_active: false } } });
    const qc = makeClient();
    const { result } = renderHook(() => useStudentPastProgram('u-1', 'p-0'), {
      wrapper: withClient(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const cached = qc.getQueryCache().getAll();
    expect(cached.map((q) => q.queryKey)).toEqual([studentPastProgramKey('u-1', 'p-0')]);
    expect(shouldPersistQuery(cached[0])).toBe(false);
  });

  it('are per account, and per block for a past one', () => {
    expect(studentProgramDetailsKey('u-1')).not.toEqual(studentProgramDetailsKey('u-2'));
    expect(studentPastProgramKey('u-1', 'p-0')).not.toEqual(studentPastProgramKey('u-1', 'p-1'));
    // Both sit under the root every writer of a program invalidates.
    expect(studentProgramDetailsKey('u-1')[0]).toBe('student-program-details');
    expect(studentPastProgramKey('u-1', 'p-0')[0]).toBe('student-program-details');
    expect(shouldPersistQuery(settled(studentProgramDetailsKey('u-1')))).toBe(true);
    expect(shouldPersistQuery(settled(studentPastProgramKey('u-1', 'p-0')))).toBe(false);
  });
});

describe('useStudentProgramDetails', () => {
  it('is disabled without a userId', async () => {
    const qc = makeClient();
    const { result } = renderHook(() => useStudentProgramDetails(null), {
      wrapper: withClient(qc),
    });
    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('returns the weeks of the block being trained, with sessions, slots and logs in order', async () => {
    wire();
    const { result } = renderHook(() => useStudentProgramDetails('u-1'), {
      wrapper: withClient(makeClient()),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const { weeks } = result.current.data;
    expect(weeks.map((w) => w.id)).toEqual(['w-1', 'w-2']);
    expect(weeks[0].program).toEqual({ id: 'p-2', name: 'Bloc 3', sort_order: 2, is_active: true });
    expect(weeks[1].sessions.map((s) => s.id)).toEqual(['s-2a', 's-2b']);
    const slots = weeks[1].sessions[1].exercise_slots;
    expect(slots.map((sl) => sl.id)).toEqual(['sl-a', 'sl-b']);
    expect(slots[0].set_logs.map((l) => l.set_number)).toEqual([1, 2]);
  });

  it('returns the other blocks as a name and two counts, newest first', async () => {
    wire();
    const { result } = renderHook(() => useStudentProgramDetails('u-1'), {
      wrapper: withClient(makeClient()),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data.pastPrograms).toEqual([
      { id: 'p-1', name: 'Bloc 2', sort_order: 1, session_count: 3, archived_count: 1 },
      { id: 'p-0', name: 'Bloc 1', sort_order: 0, session_count: 2, archived_count: 0 },
    ]);
  });

  // What keeps this read small enough to be stored: the whole tree for one
  // block, and for the others nothing of a session but whether it is archived.
  it('asks for the tree of the active block only, and for no exercise of a past one', async () => {
    const db = wire();
    const { result } = renderHook(() => useStudentProgramDetails('u-1'), {
      wrapper: withClient(makeClient()),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(filtersOf(db.requestsTo('students')[0])).toEqual(['eq profile_id u-1']);

    const requests = db.requestsTo('programs');
    expect(requests).toHaveLength(2);
    const tree = requests.find((r) => isActiveFilter(r) === true);
    const headers = requests.find((r) => isActiveFilter(r) === false);
    for (const request of [tree, headers]) {
      expect(filtersOf(request)).toContain('eq student_id st-1');
      // A block in the trash is not the athlete's to see.
      expect(filtersOf(request)).toContain('is deleted_at null');
    }
    expect(tree.select).toMatch(/exercise_slots\(/);
    expect(headers.select.replace(/\s+/g, '')).toBe('id,name,sort_order,weeks(sessions(archived_at))');
  });

  it('has no block and no past block for an athlete who was given none', async () => {
    wire({ active: [], past: [] });
    const { result } = renderHook(() => useStudentProgramDetails('u-1'), {
      wrapper: withClient(makeClient()),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ weeks: [], pastPrograms: [] });
  });

  // Half a list would be shown as the whole one: a block without its history,
  // or the history under "no program".
  it.each([
    ['the tree', true],
    ['the past blocks', false],
  ])('fails as a whole when %s cannot be read', async (_what, failing) => {
    wire({
      programs: (request) =>
        isActiveFilter(request) === failing
          ? { error: { code: '57014', message: 'canceling statement due to statement timeout' } }
          : [],
    });
    const { result } = renderHook(() => useStudentProgramDetails('u-1'), {
      wrapper: withClient(makeClient()),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
    expect(result.current.error.code).toBe('57014');
  });

  // An account the owner has not linked to a coach yet — the two steps of
  // docs/runbook/migrations/05-students-role-gate.md, between the first and
  // the second — has no row in `students`. Zero rows is an answer: no link, so
  // no block. Read as a failure, it gave that athlete "couldn't be loaded" and
  // a "Try again" that could never succeed.
  it('has no block and no past block for an account that is not linked to a coach yet', async () => {
    const db = fakePostgrest({ students: [] });
    supabase.from.mockImplementation(db.from);
    const qc = makeClient();
    const { result } = renderHook(() => useStudentProgramDetails('u-1'), {
      wrapper: withClient(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ weeks: [], pastPrograms: [] });
    // Nothing to read programs through, so none is asked for.
    expect(db.requestsTo('programs')).toEqual([]);
    // An answer like any other: the device keeps it.
    expect(shouldPersistQuery(qc.getQueryCache().getAll()[0])).toBe(true);
  });

  // …and only zero rows is. A link that could not be read says nothing about
  // the athlete's program.
  it('fails when the link itself cannot be read', async () => {
    const db = fakePostgrest({
      students: { error: { code: '57014', message: 'canceling statement due to statement timeout' } },
    });
    supabase.from.mockImplementation(db.from);
    const { result } = renderHook(() => useStudentProgramDetails('u-1'), {
      wrapper: withClient(makeClient()),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
    expect(result.current.error.code).toBe('57014');
    expect(db.requestsTo('programs')).toEqual([]);
  });

  // A device can still hold the entry an earlier build wrote under this key:
  // the bare list of weeks.
  it('reads an entry cached as a bare list of weeks as a block with no past blocks known', () => {
    const legacy = [
      { id: 'w-1', week_number: 1, program: { id: 'p-2', is_active: true }, sessions: [] },
    ];
    // Fresh for ever, so the hook shows what the cache holds and asks nothing.
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    qc.setQueryData(studentProgramDetailsKey('u-1'), legacy);

    const { result } = renderHook(() => useStudentProgramDetails('u-1'), {
      wrapper: withClient(qc),
    });
    expect(result.current.data).toEqual({ weeks: legacy, pastPrograms: [] });
    expect(supabase.from).not.toHaveBeenCalled();
  });
});

describe('useStudentPastProgram', () => {
  it('is disabled until it has an account and a block', async () => {
    const { result } = renderHook(() => useStudentPastProgram('u-1', null), {
      wrapper: withClient(makeClient()),
    });
    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('reads one block by its id, as weeks in order', async () => {
    const db = wire({
      byId: { 'p-0': { ...ACTIVE_TREE, id: 'p-0', name: 'Bloc 1', sort_order: 0, is_active: false } },
    });
    const { result } = renderHook(() => useStudentPastProgram('u-1', 'p-0'), {
      wrapper: withClient(makeClient()),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data.map((w) => w.id)).toEqual(['w-1', 'w-2']);
    expect(result.current.data[0].program).toEqual({
      id: 'p-0',
      name: 'Bloc 1',
      sort_order: 0,
      is_active: false,
    });
    expect(result.current.data[1].sessions.map((s) => s.id)).toEqual(['s-2a', 's-2b']);

    // One request: the block is named by its id, there is no athlete to look up.
    expect(db.requests).toHaveLength(1);
    expect(filtersOf(db.requests[0])).toEqual(['eq id p-0', 'is deleted_at null']);
    expect(db.requests[0].select).toMatch(/exercise_slots\(/);
  });

  it('is an empty block when the coach has put it in the trash meanwhile', async () => {
    wire();
    const { result } = renderHook(() => useStudentPastProgram('u-1', 'p-gone'), {
      wrapper: withClient(makeClient()),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
  });
});
