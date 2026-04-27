import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../lib/supabase', () => ({ supabase: { from: vi.fn() } }));

import { useStudentProgramDetails } from './useStudentProgramDetails';
import { supabase } from '../lib/supabase';

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

  it('returns weeks sorted by week_number with sessions/slots/logs sorted', async () => {
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
          // Second .eq() is is_active=true → terminal.
          return Promise.resolve({
            data: [
              {
                id: 'p-1',
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
                        exercise_slots: [
                          {
                            id: 'sl-2',
                            sort_order: 0,
                            sets: 1,
                            set_logs: [
                              { set_number: 2 },
                              { set_number: 1 },
                            ],
                          },
                        ],
                      },
                      {
                        id: 's-2a',
                        sort_order: 0,
                        title: 'A',
                        exercise_slots: [],
                      },
                    ],
                  },
                  {
                    id: 'w-1',
                    week_number: 1,
                    label: null,
                    sessions: [],
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
    let call = 0;
    supabase.from.mockImplementation(() => (call++ === 0 ? studentChain : programsChain));

    const qc = makeClient();
    const { result } = renderHook(() => useStudentProgramDetails('u-1'), {
      wrapper: withClient(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data.map((w) => w.id)).toEqual(['w-1', 'w-2']);
    const w2 = result.current.data[1];
    expect(w2.sessions.map((s) => s.id)).toEqual(['s-2a', 's-2b']);
    expect(w2.sessions[1].exercise_slots[0].set_logs.map((l) => l.set_number)).toEqual([
      1, 2,
    ]);
  });
});
