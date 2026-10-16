import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../lib/supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }));
vi.mock('./useAuth', () => ({ useAuth: vi.fn() }));

import {
  HISTORY_PAGE_SIZE,
  useSessionConfirmation,
  useReviewInbox,
  useReviewCounts,
  useConfirmationTotals,
  useConfirmationHistory,
  useMyConfirmedSessionIds,
  useWeekConfirmedSessionIds,
  useConfirmSession,
  useUnconfirmSession,
} from './useSessionConfirmation';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';
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

beforeEach(() => {
  vi.clearAllMocks();
  useAuth.mockReturnValue({ user: { id: 'user-1' } });
});

describe('useSessionConfirmation', () => {
  it('fetches the row for a single session via maybeSingle', async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { id: 'c-1', session_id: 's-1' },
        error: null,
      }),
    };
    supabase.from.mockReturnValue(chain);

    const qc = makeClient();
    const { result } = renderHook(() => useSessionConfirmation('s-1'), {
      wrapper: withClient(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(supabase.from).toHaveBeenCalledWith('session_confirmations');
    expect(result.current.data.session_id).toBe('s-1');
  });

  it('is disabled when sessionId is falsy', async () => {
    const qc = makeClient();
    const { result } = renderHook(() => useSessionConfirmation(null), {
      wrapper: withClient(qc),
    });
    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
    expect(supabase.from).not.toHaveBeenCalled();
  });

  // The app serves a cached answer for two minutes (queryClient.js), and this
  // key is persisted across reloads. That suits a screen that only shows the
  // confirmation. The coach's review offers its feedback form on it, and the
  // athlete can undo a confirmation in between.
  describe('with an answer already in the cache', () => {
    function cachedAsConfirmed() {
      const qc = new QueryClient({
        defaultOptions: {
          queries: { retry: false, gcTime: Infinity, staleTime: 1000 * 60 * 2 },
        },
      });
      qc.setQueryData(['session-confirmation', 's-1'], { id: 'c-1', session_id: 's-1' });
      // What the database says now: the athlete has undone it.
      const chain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      };
      supabase.from.mockReturnValue(chain);
      return qc;
    }

    it('serves it without a request by default', async () => {
      const qc = cachedAsConfirmed();
      const { result } = renderHook(() => useSessionConfirmation('s-1'), {
        wrapper: withClient(qc),
      });
      await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
      expect(supabase.from).not.toHaveBeenCalled();
      expect(result.current.data).toEqual({ id: 'c-1', session_id: 's-1' });
      expect(result.current.isFetchedAfterMount).toBe(false);
    });

    it("reads it again on mount with refetchOnMount: 'always'", async () => {
      const qc = cachedAsConfirmed();
      const { result } = renderHook(
        () => useSessionConfirmation('s-1', { refetchOnMount: 'always' }),
        { wrapper: withClient(qc) },
      );
      const cachedAt = result.current.dataUpdatedAt;
      await waitFor(() => expect(result.current.data).toBeNull());
      expect(supabase.from).toHaveBeenCalledTimes(1);
      // `dataUpdatedAt` is what the review compares with the moment it opened.
      expect(result.current.dataUpdatedAt).toBeGreaterThanOrEqual(cachedAt);
      expect(result.current.isSuccess).toBe(true);
    });
  });
});

// What RLS lets a coach read, as PostgREST would filter it: a filter is a path
// into the embedded rows, and a row whose embed does not match is dropped —
// which holds because every embed on the way is `!inner` (asserted apart).
const at = (row, path) => path.split('.').reduce((node, key) => node?.[key], row);
function where(rows) {
  return (request) =>
    rows.filter((row) =>
      request.filters.every(([op, path, a, b]) => {
        if (op === 'eq' || op === 'is') return at(row, path) === a;
        if (op === 'not' && a === 'is') return at(row, path) !== b;
        return true; // the keyset's gt/lt: applied by the fake itself
      }),
    );
}

// One confirmation as the coach's select returns it.
function confirmationRow({
  n,
  coach = 'user-1',
  student = 'st-1',
  name = 'Alex',
  reviewed = false,
  archived = false,
  trashed = false,
  confirmedAt,
}) {
  const id = `c-${String(n).padStart(5, '0')}`;
  return {
    id,
    session_id: `s-${id}`,
    student_id: `profile-${student}`,
    confirmed_at: confirmedAt ?? new Date(Date.UTC(2026, 0, 1) + n * 3_600_000).toISOString(),
    performed_on: null,
    notes: null,
    session: {
      title: `Session ${n}`,
      day_number: null,
      archived_at: archived ? '2026-09-01T00:00:00Z' : null,
      reviewed_at: reviewed ? '2026-09-01T00:00:00Z' : null,
      week: {
        week_number: 1,
        label: 'Phase',
        program: {
          deleted_at: trashed ? '2026-09-01T00:00:00Z' : null,
          student: { id: student, coach_id: coach, profile: { full_name: name } },
        },
      },
    },
  };
}

const rowsOf = (count, overrides = {}, from = 0) =>
  Array.from({ length: count }, (_, i) => confirmationRow({ n: from + i, ...overrides }));

const oneLine = (text) => text.replace(/\s+/g, '');

// The embeds every coach-wide read walks: drop one `!inner` and the filter on
// `coach_id` answers 200 and filters nothing.
function expectCoachChain(request) {
  const select = oneLine(request.select);
  expect(select).toContain('session:sessions!inner(');
  expect(select).toContain('week:weeks!inner(');
  expect(select).toContain('program:programs!inner(');
  expect(select).toContain('student:students!inner(id,coach_id');
  expect(request.filters).toContainEqual(['eq', 'session.week.program.student.coach_id', 'user-1']);
  expect(request.filters).toContainEqual(['is', 'session.week.program.deleted_at', null]);
}

describe('useReviewInbox', () => {
  it('reads the sessions neither reviewed nor archived, names the coach, and flattens them newest first', async () => {
    const db = fakePostgrest({
      session_confirmations: where([
        confirmationRow({ n: 1 }),
        confirmationRow({ n: 3, student: 'st-2', name: 'Bea' }),
        confirmationRow({ n: 2, reviewed: true }),
        confirmationRow({ n: 4, archived: true }),
        confirmationRow({ n: 5, trashed: true }),
      ]),
    });
    supabase.from.mockImplementation(db.from);

    const { result } = renderHook(() => useReviewInbox(), { wrapper: withClient(makeClient()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [request] = db.requestsTo('session_confirmations');
    expectCoachChain(request);
    expect(request.filters).toContainEqual(['is', 'session.reviewed_at', null]);
    expect(request.filters).toContainEqual(['is', 'session.archived_at', null]);
    expect(result.current.data.map((c) => c.id)).toEqual(['c-00003', 'c-00001']);
    expect(result.current.data[0]).toMatchObject({
      session_id: 's-c-00003',
      student_id: 'st-2',
      student_name: 'Bea',
      session_title: 'Session 3',
      week_label: 'Phase',
      reviewed_at: null,
      archived_at: null,
    });
  });

  // Review item L18: the feed read every confirmation of the coach in one
  // request, newest first, and PostgREST stops at 1000 rows without a word. A
  // session confirmed before the thousand newest that nobody had reviewed yet
  // left the inbox, its athlete's chip and the tab's number.
  it('keeps an old session still waiting for its review behind 1,300 newer confirmations', async () => {
    const old = rowsOf(15, {}, 0);
    const newer = rowsOf(1285, { reviewed: true }, 100);
    const db = fakePostgrest({ session_confirmations: where([...newer, ...old]) });
    supabase.from.mockImplementation(db.from);

    const { result } = renderHook(() => useReviewInbox(), { wrapper: withClient(makeClient()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(15);
    expect(result.current.data.at(-1).id).toBe('c-00000');
  });

  it('reads a backlog past a thousand sessions to its end', async () => {
    const db = fakePostgrest({ session_confirmations: where(rowsOf(1001)) });
    supabase.from.mockImplementation(db.from);

    const { result } = renderHook(() => useReviewInbox(), { wrapper: withClient(makeClient()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1001);
    expect(db.requestsTo('session_confirmations')).toHaveLength(2);
    expect(result.current.data[0].id).toBe('c-01000');
  });

  it('leaves out the sessions of another coach’s athletes, the coach’s own training included', async () => {
    const db = fakePostgrest({
      session_confirmations: where([
        confirmationRow({ n: 1, name: 'Alex' }),
        confirmationRow({ n: 2, coach: 'coach-other', student: 'st-self', name: 'Me, as an athlete' }),
      ]),
    });
    supabase.from.mockImplementation(db.from);

    const { result } = renderHook(() => useReviewInbox(), { wrapper: withClient(makeClient()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data.map((c) => c.student_name)).toEqual(['Alex']);
  });
});

describe('useReviewCounts', () => {
  const data = [
    ...rowsOf(3, { student: 'st-1' }, 0),
    ...rowsOf(2, { student: 'st-2', name: 'Bea' }, 10),
    ...rowsOf(4, { student: 'st-2', name: 'Bea', reviewed: true }, 20),
    ...rowsOf(5, { student: 'st-3', name: 'Cy', archived: true }, 30),
    ...rowsOf(2, { student: 'st-9', coach: 'coach-other' }, 40),
  ];
  // What coach_review_counts() answers on the same rows: the inbox's
  // predicate, grouped by `students.id`.
  const rpcRows = [
    { student_id: 'st-1', to_review: 3 },
    { student_id: 'st-2', to_review: 2 },
  ];

  it('asks the database to count, and reads no confirmation', async () => {
    supabase.rpc.mockResolvedValue({ data: rpcRows, error: null });
    const { result } = renderHook(() => useReviewCounts(), { wrapper: withClient(makeClient()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(supabase.rpc).toHaveBeenCalledWith('coach_review_counts');
    expect(supabase.from).not.toHaveBeenCalled();
    expect(result.current.data).toEqual({ 'st-1': 3, 'st-2': 2 });
  });

  it('counts the inbox itself when the database has no such function, to the same numbers', async () => {
    supabase.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } });
    const db = fakePostgrest({ session_confirmations: where(data) });
    supabase.from.mockImplementation(db.from);

    const qc = makeClient();
    const { result } = renderHook(() => useReviewCounts(), { wrapper: withClient(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const fromRpc = Object.fromEntries(rpcRows.map((r) => [r.student_id, r.to_review]));
    expect(result.current.data).toEqual(fromRpc);
    // …through the inbox's own entry, which the feed then finds read.
    expect(qc.getQueryData(['all-confirmations', 'inbox', 'user-1'])).toHaveLength(5);
    expect(db.requestsTo('session_confirmations')).toHaveLength(1);
  });

  it('fails on any other error, and counts nothing', async () => {
    supabase.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'permission denied' } });
    const { result } = renderHook(() => useReviewCounts(), { wrapper: withClient(makeClient()) });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('is dropped with the confirmations', async () => {
    supabase.rpc.mockResolvedValue({ data: rpcRows, error: null });
    const qc = makeClient();
    const { result } = renderHook(() => useReviewCounts(), { wrapper: withClient(qc) });
    await waitFor(() => expect(result.current.data).toEqual({ 'st-1': 3, 'st-2': 2 }));
    supabase.rpc.mockResolvedValue({ data: [{ student_id: 'st-1', to_review: 2 }], error: null });
    await qc.invalidateQueries({ queryKey: ['all-confirmations'] });
    await waitFor(() => expect(result.current.data).toEqual({ 'st-1': 2 }));
  });
});

describe('useConfirmationTotals', () => {
  it('counts the active and the archived confirmations with two head requests', async () => {
    const db = fakePostgrest({
      session_confirmations: where([
        ...rowsOf(4, {}, 0),
        ...rowsOf(3, { reviewed: true }, 10),
        ...rowsOf(2, { archived: true }, 20),
        ...rowsOf(6, { coach: 'coach-other' }, 30),
      ]),
    });
    supabase.from.mockImplementation(db.from);

    const { result } = renderHook(() => useConfirmationTotals(''), { wrapper: withClient(makeClient()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ active: 7, archived: 2 });

    const requests = db.requestsTo('session_confirmations');
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.options).toEqual({ count: 'exact', head: true });
      expectCoachChain(request);
    }
    expect(requests[0].filters).toContainEqual(['is', 'session.archived_at', null]);
    expect(requests[1].filters).toContainEqual(['not', 'session.archived_at', 'is', null]);
  });

  it('counts one athlete when the feed is filtered on one', async () => {
    const db = fakePostgrest({
      session_confirmations: where([...rowsOf(4, {}, 0), ...rowsOf(3, { student: 'st-2' }, 10)]),
    });
    supabase.from.mockImplementation(db.from);

    const { result } = renderHook(() => useConfirmationTotals('st-2'), { wrapper: withClient(makeClient()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ active: 3, archived: 0 });
    expect(db.requests[0].filters).toContainEqual(['eq', 'session.week.program.student.id', 'st-2']);
  });
});

describe('useConfirmationHistory', () => {
  const PAGE = HISTORY_PAGE_SIZE;

  it('reads one page, newest first, and the next one when asked', async () => {
    const db = fakePostgrest({ session_confirmations: where(rowsOf(PAGE + 5)) });
    supabase.from.mockImplementation(db.from);

    const { result } = renderHook(() => useConfirmationHistory(), { wrapper: withClient(makeClient()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    let [request] = db.requestsTo('session_confirmations');
    expectCoachChain(request);
    expect(request.filters).toContainEqual(['is', 'session.archived_at', null]);
    expect(request.orders).toEqual([
      { column: 'confirmed_at', ascending: false },
      { column: 'id', ascending: false },
    ]);
    expect(request.range).toEqual({ from: 0, to: PAGE - 1 });
    expect(result.current.data).toHaveLength(PAGE);
    expect(result.current.data[0].id).toBe(`c-${String(PAGE + 4).padStart(5, '0')}`);
    expect(result.current.hasNextPage).toBe(true);

    await act(() => result.current.fetchNextPage());
    await waitFor(() => expect(result.current.data).toHaveLength(PAGE + 5));
    request = db.requestsTo('session_confirmations')[1];
    expect(request.range).toEqual({ from: PAGE, to: 2 * PAGE - 1 });
    // A short page is the last one.
    expect(result.current.hasNextPage).toBe(false);
    expect(result.current.data.at(-1).id).toBe('c-00000');
  });

  it('reads the archived sessions of one athlete', async () => {
    const db = fakePostgrest({
      session_confirmations: where([
        ...rowsOf(3, { archived: true }, 0),
        ...rowsOf(2, { archived: true, student: 'st-2' }, 10),
        ...rowsOf(4, { student: 'st-2' }, 20),
      ]),
    });
    supabase.from.mockImplementation(db.from);

    const { result } = renderHook(() => useConfirmationHistory({ studentId: 'st-2', archived: true }), {
      wrapper: withClient(makeClient()),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data.map((c) => c.id)).toEqual(['c-00011', 'c-00010']);
    expect(db.requests[0].filters).toContainEqual(['eq', 'session.week.program.student.id', 'st-2']);
    expect(db.requests[0].filters).toContainEqual(['not', 'session.archived_at', 'is', null]);
    expect(result.current.hasNextPage).toBe(false);
  });

  // An offset moves when a confirmation arrives between two pages: the last
  // row of the first page comes back first on the second.
  it('keeps a row read twice across pages once', async () => {
    let rows = rowsOf(PAGE + 3);
    const db = fakePostgrest({ session_confirmations: (request) => where(rows)(request) });
    supabase.from.mockImplementation(db.from);

    const { result } = renderHook(() => useConfirmationHistory(), { wrapper: withClient(makeClient()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(PAGE);
    rows = [...rows, confirmationRow({ n: 9999 })];
    await act(() => result.current.fetchNextPage());
    await waitFor(() => expect(db.requests).toHaveLength(2));
    // The second page was c-00003 … c-00000: c-00003 is already there.
    await waitFor(() => expect(result.current.data).toHaveLength(PAGE + 3));
    const ids = result.current.data.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.at(-1)).toBe('c-00000');
  });

  it('sends nothing until the view that shows it is open', async () => {
    const db = fakePostgrest({ session_confirmations: where(rowsOf(3)) });
    supabase.from.mockImplementation(db.from);

    const { result, rerender } = renderHook(({ enabled }) => useConfirmationHistory({ enabled }), {
      wrapper: withClient(makeClient()),
      initialProps: { enabled: false },
    });
    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
    expect(db.requests).toHaveLength(0);

    rerender({ enabled: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(3);
  });
});

describe('useMyConfirmedSessionIds', () => {
  it('returns a Set of session ids scoped to the current user', async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({
        data: [{ session_id: 's-1' }, { session_id: 's-2' }],
        error: null,
      }),
    };
    supabase.from.mockReturnValue(chain);

    const qc = makeClient();
    const { result } = renderHook(() => useMyConfirmedSessionIds(), {
      wrapper: withClient(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeInstanceOf(Set);
    expect(result.current.data.has('s-1')).toBe(true);
    expect(chain.eq).toHaveBeenCalledWith('student_id', 'user-1');
    // The CACHE stores a plain array (JSON-persistable for offline cold
    // start); the Set consumers see is derived via `select`.
    expect(qc.getQueryData(['my-confirmed-session-ids', 'user-1'])).toEqual(['s-1', 's-2']);
  });
});

describe('useWeekConfirmedSessionIds', () => {
  it('returns an empty Set when the week has no confirmations', async () => {
    const confChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    supabase.from.mockReturnValue(confChain);

    const qc = makeClient();
    const { result } = renderHook(() => useWeekConfirmedSessionIds('w-1'), {
      wrapper: withClient(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data.size).toBe(0);
  });

  it('filters confirmations through the session join in one query', async () => {
    const confChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({
        data: [{ session_id: 's-1' }],
        error: null,
      }),
    };
    supabase.from.mockReturnValue(confChain);

    const qc = makeClient();
    const { result } = renderHook(() => useWeekConfirmedSessionIds('w-1'), {
      wrapper: withClient(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(supabase.from).toHaveBeenCalledTimes(1);
    expect(supabase.from).toHaveBeenCalledWith('session_confirmations');
    expect(confChain.eq).toHaveBeenCalledWith('sessions.week_id', 'w-1');
    expect(result.current.data.has('s-1')).toBe(true);
    expect(result.current.data.has('s-2')).toBe(false);
  });

  it('caches a plain array so the persister can round-trip it', async () => {
    const confChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ data: [{ session_id: 's-1' }], error: null }),
    };
    supabase.from.mockReturnValue(confChain);

    const qc = makeClient();
    const { result } = renderHook(() => useWeekConfirmedSessionIds('w-1'), {
      wrapper: withClient(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // A Set here would dehydrate to {} on the way through IndexedDB.
    expect(qc.getQueryData(['week-confirmed-session-ids', 'w-1'])).toEqual(['s-1']);
  });
});

describe('useConfirmSession / useUnconfirmSession', () => {
  it('useConfirmSession upserts with student_id from auth', async () => {
    const chain = {
      upsert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'c-1' }, error: null }),
    };
    supabase.from.mockReturnValue(chain);

    const qc = makeClient();
    const { result } = renderHook(() => useConfirmSession(), { wrapper: withClient(qc) });
    result.current.mutate({ sessionId: 's-1', notes: 'felt good' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [payload, options] = chain.upsert.mock.calls[0];
    expect(payload.session_id).toBe('s-1');
    expect(payload.student_id).toBe('user-1');
    expect(payload.notes).toBe('felt good');
    // Insert-or-nothing on session_id: a replay against a confirmed session
    // writes nothing, so the first note and training date stay.
    expect(options).toEqual({ onConflict: 'session_id', ignoreDuplicates: true });
  });

  // The date the student actually trained rides in the serialized variables,
  // so a confirm queued offline and replayed days later still records the
  // training day rather than the replay day.
  it('useConfirmSession forwards performedOn as performed_on', async () => {
    const chain = {
      upsert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'c-1' }, error: null }),
    };
    supabase.from.mockReturnValue(chain);

    const qc = makeClient();
    const { result } = renderHook(() => useConfirmSession(), { wrapper: withClient(qc) });
    result.current.mutate({ sessionId: 's-1', performedOn: '2026-08-18' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(chain.upsert.mock.calls[0][0].performed_on).toBe('2026-08-18');
    // The optimistic cache entry carries it too, so the UI doesn't flash the
    // wrong date between the tap and the server round-trip.
    expect(qc.getQueryData(['session-confirmation', 's-1'])).toMatchObject({
      performed_on: '2026-08-18',
    });
  });

  it('useConfirmSession sends performed_on=null when the caller has no date', async () => {
    const chain = {
      upsert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'c-1' }, error: null }),
    };
    supabase.from.mockReturnValue(chain);

    const qc = makeClient();
    const { result } = renderHook(() => useConfirmSession(), { wrapper: withClient(qc) });
    result.current.mutate({ sessionId: 's-1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // Server-side COALESCE then falls back to confirmed_at.
    expect(chain.upsert.mock.calls[0][0].performed_on).toBeNull();
  });

  it('useConfirmSession sends notes=null for empty/missing notes', async () => {
    const chain = {
      upsert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'c-1' }, error: null }),
    };
    supabase.from.mockReturnValue(chain);

    const qc = makeClient();
    const { result } = renderHook(() => useConfirmSession(), { wrapper: withClient(qc) });
    result.current.mutate({ sessionId: 's-1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(chain.upsert.mock.calls[0][0].notes).toBeNull();
  });

  it('useUnconfirmSession deletes by session_id', async () => {
    const chain = {
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: null }),
    };
    supabase.from.mockReturnValue(chain);

    const qc = makeClient();
    const { result } = renderHook(() => useUnconfirmSession(), { wrapper: withClient(qc) });
    result.current.mutate({ sessionId: 's-1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(chain.eq).toHaveBeenCalledWith('session_id', 's-1');
  });

  // What a confirmation and its undo put on screen before the database has
  // answered, what they take back when it refuses, and who reads the
  // confirmation again once they have settled (not these hooks): see
  // useSessionConfirmation.optimistic.test.jsx.
});
