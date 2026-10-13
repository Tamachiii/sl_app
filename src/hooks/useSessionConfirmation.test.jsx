import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../lib/supabase', () => ({ supabase: { from: vi.fn() } }));
vi.mock('./useAuth', () => ({ useAuth: vi.fn() }));

import {
  useSessionConfirmation,
  useAllConfirmations,
  useMyConfirmedSessionIds,
  useWeekConfirmedSessionIds,
  useConfirmSession,
  useUnconfirmSession,
} from './useSessionConfirmation';
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

describe('useAllConfirmations', () => {
  it('fetches confirmations through the session→week→program→student join and flattens them', async () => {
    // One embedded-join query, filtered through the join — no full-tree fetch,
    // no .in(id-list). The embed nests session → week → program → student.
    const confChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({
        data: [
          {
            id: 'c-1',
            session_id: 's-1',
            student_id: 'st-1',
            confirmed_at: '2026-04-26',
            notes: 'felt good',
            session: {
              title: 'Push',
              day_number: 1,
              archived_at: null,
              reviewed_at: null,
              week: {
                week_number: 2,
                label: 'Hyp',
                program: {
                  deleted_at: null,
                  student: { id: 'st-1', profile: { full_name: 'Alex' } },
                },
              },
            },
          },
        ],
        error: null,
      }),
    };
    supabase.from.mockReturnValue(confChain);

    const qc = makeClient();
    const { result } = renderHook(() => useAllConfirmations(), {
      wrapper: withClient(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // Filtered through the join, ordered newest-first — never an .in() list.
    expect(confChain.eq).toHaveBeenCalledWith('session.week.program.student.coach_id', 'user-1');
    expect(confChain.is).toHaveBeenCalledWith('session.week.program.deleted_at', null);
    expect(confChain.order).toHaveBeenCalledWith('confirmed_at', { ascending: false });
    expect(supabase.from).toHaveBeenCalledWith('session_confirmations');
    const rows = result.current.data;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      session_id: 's-1',
      student_id: 'st-1',
      student_name: 'Alex',
      session_title: 'Push',
      week_number: 2,
      week_label: 'Hyp',
      notes: 'felt good',
    });
  });

  it('returns [] when there are no confirmations', async () => {
    const confChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    supabase.from.mockReturnValue(confChain);

    const qc = makeClient();
    const { result } = renderHook(() => useAllConfirmations(), {
      wrapper: withClient(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
  });

  // The feed and the roster's "to review" chips are the sessions of the
  // athletes this coach coaches, which is narrower than what RLS lets the
  // account read. The filter sits four embeds deep, and an embedded filter
  // only drops the confirmation when every embed on the way is `!inner`.
  it('names the coach, through inner joins all the way to students', async () => {
    const confChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    supabase.from.mockReturnValue(confChain);

    const { result } = renderHook(() => useAllConfirmations(), {
      wrapper: withClient(makeClient()),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(confChain.eq.mock.calls).toEqual([['session.week.program.student.coach_id', 'user-1']]);
    const select = confChain.select.mock.calls[0][0].replace(/\s+/g, '');
    expect(select).toContain('session:sessions!inner(');
    expect(select).toContain('week:weeks!inner(');
    expect(select).toContain('program:programs!inner(');
    expect(select).toContain('student:students!inner(id,coach_id,');
  });

  it('leaves out a confirmation that belongs to another coach’s athlete', async () => {
    const row = (id, coachId, name) => ({
      id,
      session_id: `s-${id}`,
      student_id: `profile-${id}`,
      confirmed_at: '2026-04-26',
      performed_on: null,
      notes: null,
      session: {
        title: 'Push',
        day_number: 1,
        archived_at: null,
        reviewed_at: null,
        week: {
          week_number: 1,
          label: null,
          program: {
            deleted_at: null,
            student: { id: `st-${id}`, coach_id: coachId, profile: { full_name: name } },
          },
        },
      },
    });
    // What RLS lets user-1 read; the chain applies the request's filters to
    // it, each path leading into the embedded rows.
    const visible = [row('1', 'user-1', 'Alex'), row('2', 'coach-other', 'Not mine')];
    const at = (r, path) => path.split('.').reduce((node, key) => node?.[key], r);
    const filters = [];
    const confChain = {
      select: vi.fn(() => confChain),
      eq: vi.fn((path, value) => {
        filters.push((r) => at(r, path) === value);
        return confChain;
      }),
      is: vi.fn((path, value) => {
        filters.push((r) => at(r, path) === value);
        return confChain;
      }),
      order: vi.fn(async () => ({ data: visible.filter((r) => filters.every((f) => f(r))), error: null })),
    };
    supabase.from.mockReturnValue(confChain);

    const { result } = renderHook(() => useAllConfirmations(), {
      wrapper: withClient(makeClient()),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data.map((c) => c.student_name)).toEqual(['Alex']);
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
