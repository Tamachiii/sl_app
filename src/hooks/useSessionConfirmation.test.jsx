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
});

describe('useAllConfirmations', () => {
  it('fetches confirmations through the session→week→program→student join and flattens them', async () => {
    // One embedded-join query, filtered through the join — no full-tree fetch,
    // no .in(id-list). The embed nests session → week → program → student.
    const confChain = {
      select: vi.fn().mockReturnThis(),
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
      single: vi.fn().mockResolvedValue({ data: { id: 'c-1' }, error: null }),
    };
    supabase.from.mockReturnValue(chain);

    const qc = makeClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useConfirmSession(), { wrapper: withClient(qc) });
    result.current.mutate({ sessionId: 's-1', notes: 'felt good' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [payload, options] = chain.upsert.mock.calls[0];
    expect(payload.session_id).toBe('s-1');
    expect(payload.student_id).toBe('user-1');
    expect(payload.notes).toBe('felt good');
    // onConflict on session_id keeps offline replay idempotent.
    expect(options).toEqual({ onConflict: 'session_id' });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['my-confirmed-session-ids'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['week-confirmed-session-ids'] });
  });

  // The date the student actually trained rides in the serialized variables,
  // so a confirm queued offline and replayed days later still records the
  // training day rather than the replay day.
  it('useConfirmSession forwards performedOn as performed_on', async () => {
    const chain = {
      upsert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { id: 'c-1' }, error: null }),
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
      single: vi.fn().mockResolvedValue({ data: { id: 'c-1' }, error: null }),
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
      single: vi.fn().mockResolvedValue({ data: { id: 'c-1' }, error: null }),
    };
    supabase.from.mockReturnValue(chain);

    const qc = makeClient();
    const { result } = renderHook(() => useConfirmSession(), { wrapper: withClient(qc) });
    result.current.mutate({ sessionId: 's-1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(chain.upsert.mock.calls[0][0].notes).toBeNull();
  });

  it('useUnconfirmSession deletes by session_id and invalidates the confirmation caches', async () => {
    const chain = {
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: null }),
    };
    supabase.from.mockReturnValue(chain);

    const qc = makeClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useUnconfirmSession(), { wrapper: withClient(qc) });
    result.current.mutate({ sessionId: 's-1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(chain.eq).toHaveBeenCalledWith('session_id', 's-1');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['session-confirmation'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['my-confirmed-session-ids'] });
    // 'student-confirmations' is not a key any query uses — invalidating it was
    // a no-op, and the coach's feed ('all-confirmations') is deliberately NOT
    // dropped here: this runs on the student's device.
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['student-confirmations'] });
  });
});
