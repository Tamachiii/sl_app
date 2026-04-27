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
  it('joins programs → weeks → sessions → confirmations and decorates with student name', async () => {
    const studentChain = {
      select: vi.fn().mockResolvedValue({
        data: [
          { id: 'st-1', profile: { full_name: 'Alex' } },
          { id: 'st-2', profile: null },
        ],
        error: null,
      }),
    };
    const programsChain = {
      select: vi.fn().mockResolvedValue({
        data: [
          {
            id: 'p-1',
            student_id: 'st-1',
            weeks: [
              {
                id: 'w-1',
                week_number: 2,
                label: 'Hyp',
                sessions: [
                  { id: 's-1', title: 'Push', day_number: 1, archived_at: null },
                  { id: 's-2', title: 'Pull', day_number: 2, archived_at: null },
                ],
              },
            ],
          },
        ],
        error: null,
      }),
    };
    const confChain = {
      select: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({
        data: [
          { id: 'c-1', session_id: 's-1', confirmed_at: '2026-04-26' },
        ],
        error: null,
      }),
    };
    let call = 0;
    supabase.from.mockImplementation(() => {
      const idx = call++;
      if (idx === 0) return studentChain;
      if (idx === 1) return programsChain;
      return confChain;
    });

    const qc = makeClient();
    const { result } = renderHook(() => useAllConfirmations(), {
      wrapper: withClient(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const rows = result.current.data;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      session_id: 's-1',
      student_name: 'Alex',
      session_title: 'Push',
      week_number: 2,
      week_label: 'Hyp',
    });
  });

  it('returns [] when there are no sessions', async () => {
    const studentChain = {
      select: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    const programsChain = {
      select: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    let call = 0;
    supabase.from.mockImplementation(() => (call++ === 0 ? studentChain : programsChain));

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
  });
});

describe('useWeekConfirmedSessionIds', () => {
  it('returns an empty Set when the week has no sessions', async () => {
    const sessionsChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    supabase.from.mockReturnValue(sessionsChain);

    const qc = makeClient();
    const { result } = renderHook(() => useWeekConfirmedSessionIds('w-1'), {
      wrapper: withClient(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data.size).toBe(0);
  });

  it('returns confirmed ids for the supplied week', async () => {
    const sessionsChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({
        data: [{ id: 's-1' }, { id: 's-2' }],
        error: null,
      }),
    };
    const confChain = {
      select: vi.fn().mockReturnThis(),
      in: vi.fn().mockResolvedValue({
        data: [{ session_id: 's-1' }],
        error: null,
      }),
    };
    let call = 0;
    supabase.from.mockImplementation(() => (call++ === 0 ? sessionsChain : confChain));

    const qc = makeClient();
    const { result } = renderHook(() => useWeekConfirmedSessionIds('w-1'), {
      wrapper: withClient(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data.has('s-1')).toBe(true);
    expect(result.current.data.has('s-2')).toBe(false);
  });
});

describe('useConfirmSession / useUnconfirmSession', () => {
  it('useConfirmSession inserts with student_id from auth', async () => {
    const chain = {
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { id: 'c-1' }, error: null }),
    };
    supabase.from.mockReturnValue(chain);

    const qc = makeClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useConfirmSession(), { wrapper: withClient(qc) });
    result.current.mutate({ sessionId: 's-1', notes: 'felt good' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const inserted = chain.insert.mock.calls[0][0];
    expect(inserted.session_id).toBe('s-1');
    expect(inserted.student_id).toBe('user-1');
    expect(inserted.notes).toBe('felt good');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['my-confirmed-session-ids'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['week-confirmed-session-ids'] });
  });

  it('useConfirmSession sends notes=null for empty/missing notes', async () => {
    const chain = {
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { id: 'c-1' }, error: null }),
    };
    supabase.from.mockReturnValue(chain);

    const qc = makeClient();
    const { result } = renderHook(() => useConfirmSession(), { wrapper: withClient(qc) });
    result.current.mutate({ sessionId: 's-1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(chain.insert.mock.calls[0][0].notes).toBeNull();
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
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['student-confirmations'] });
  });
});
