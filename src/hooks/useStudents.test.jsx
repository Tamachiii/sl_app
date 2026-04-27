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

  it('lists students ordered by created_at', async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({
        data: [{ id: 'st-1', profile: { full_name: 'A' } }],
        error: null,
      }),
    };
    supabase.from.mockReturnValue(chain);
    const qc = makeClient();
    const { result } = renderHook(() => useStudents(), { wrapper: withClient(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(chain.order).toHaveBeenCalledWith('created_at');
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
