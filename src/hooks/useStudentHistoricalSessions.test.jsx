import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../lib/supabase', () => ({ supabase: { from: vi.fn() } }));
vi.mock('./useAuth', () => ({ useAuth: vi.fn() }));

import { useStudentHistoricalSessions } from './useStudentHistoricalSessions';
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

describe('useStudentHistoricalSessions', () => {
  it('queries non-active programs and tags sessions historical:true', async () => {
    const studentChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { id: 'st-1' }, error: null }),
    };
    const programsChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn(function () {
        this._calls = (this._calls || 0) + 1;
        if (this._calls === 2) {
          // Second .eq → is_active=false → terminal
          return Promise.resolve({
            data: [
              {
                id: 'p-old',
                weeks: [
                  {
                    sessions: [
                      {
                        id: 's-1',
                        title: 'Squat day',
                        scheduled_date: '2026-03-12',
                        archived_at: null,
                      },
                      {
                        id: 's-2',
                        title: 'Skipped',
                        scheduled_date: null,
                        archived_at: null,
                      },
                    ],
                  },
                ],
              },
            ],
            error: null,
          });
        }
        return this;
      }),
    };
    const confChain = {
      select: vi.fn().mockReturnThis(),
      in: vi.fn().mockResolvedValue({
        data: [{ session_id: 's-1' }],
        error: null,
      }),
    };
    const seq = [studentChain, programsChain, confChain];
    let i = 0;
    supabase.from.mockImplementation(() => seq[i++]);

    const qc = makeClient();
    const { result } = renderHook(() => useStudentHistoricalSessions(), {
      wrapper: withClient(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // Only s-1 has scheduled_date.
    expect(result.current.data).toEqual([
      {
        session_id: 's-1',
        title: 'Squat day',
        date: '2026-03-12',
        completed: true,
        historical: true,
      },
    ]);
    // Verifies is_active=false was the filter.
    const eqCalls = programsChain.eq.mock.calls;
    expect(eqCalls).toContainEqual(['is_active', false]);
  });
});
