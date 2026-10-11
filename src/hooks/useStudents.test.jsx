import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../lib/supabase', () => ({ supabase: { from: vi.fn() } }));
vi.mock('./useAuth', () => ({ useAuth: vi.fn() }));

import { useStudents, useMyStudentId } from './useStudents';
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
  useAuth.mockReturnValue({ user: { id: 'u-1' } });
});

describe('useStudents', () => {
  it('is disabled without a user', async () => {
    useAuth.mockReturnValue({ user: null });
    const qc = makeClient();
    const { result } = renderHook(() => useStudents(), { wrapper: withClient(qc) });
    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
    expect(supabase.from).not.toHaveBeenCalled();
  });

  function studentsChain(rows) {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({ data: rows, error: null }),
    };
    supabase.from.mockReturnValue(chain);
    return chain;
  }

  it('lists students ordered by created_at', async () => {
    const chain = studentsChain([{ id: 'st-1', profile: { full_name: 'A' } }]);
    const qc = makeClient();
    const { result } = renderHook(() => useStudents(), { wrapper: withClient(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(supabase.from).toHaveBeenCalledWith('students');
    expect(chain.order).toHaveBeenCalledWith('created_at');
  });

  // RLS lets an account read the rows it coaches AND the row in which it is
  // the athlete. Without the filter a coach who is somebody's athlete (a
  // promoted account, a forged link) is a card in their own roster.
  it('asks for the rows this user coaches, not every row RLS lets them read', async () => {
    const chain = studentsChain([]);
    const qc = makeClient();
    const { result } = renderHook(() => useStudents(), { wrapper: withClient(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(chain.eq).toHaveBeenCalledTimes(1);
    expect(chain.eq).toHaveBeenCalledWith('coach_id', 'u-1');
  });

  it('follows the signed-in user: another coach gets their own filter', async () => {
    useAuth.mockReturnValue({ user: { id: 'coach-2' } });
    const chain = studentsChain([]);
    const qc = makeClient();
    const { result } = renderHook(() => useStudents(), { wrapper: withClient(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(chain.eq).toHaveBeenCalledWith('coach_id', 'coach-2');
  });

  // The same rule, seen from its result. `visible` is what the two SELECT
  // policies on `students` let coach u-1 read; the table below applies the
  // request's `.eq()` filters to it, as PostgREST would.
  it('a coach who is also somebody’s athlete is not a card in their own roster', async () => {
    const visible = [
      { id: 'st-1', coach_id: 'u-1', profile_id: 'athlete-1' },
      { id: 'st-2', coach_id: 'u-1', profile_id: 'athlete-2' },
      // The row in which u-1 is the ATHLETE of another account.
      { id: 'st-self', coach_id: 'someone-else', profile_id: 'u-1' },
    ];
    const filters = [];
    const chain = {
      select: vi.fn(() => chain),
      eq: vi.fn((column, value) => {
        filters.push([column, value]);
        return chain;
      }),
      order: vi.fn(async () => ({
        data: visible.filter((row) => filters.every(([column, value]) => row[column] === value)),
        error: null,
      })),
    };
    supabase.from.mockReturnValue(chain);

    const qc = makeClient();
    const { result } = renderHook(() => useStudents(), { wrapper: withClient(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data.map((s) => s.id)).toEqual(['st-1', 'st-2']);
  });
});

describe('useMyStudentId', () => {
  it('resolves students.id by profile_id', async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { id: 'st-99' }, error: null }),
    };
    supabase.from.mockReturnValue(chain);
    const qc = makeClient();
    const { result } = renderHook(() => useMyStudentId(), { wrapper: withClient(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(chain.eq).toHaveBeenCalledWith('profile_id', 'u-1');
    expect(result.current.data).toBe('st-99');
  });
});
