import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../lib/supabase', () => ({ supabase: { from: vi.fn() } }));
vi.mock('./useAuth', () => ({ useAuth: vi.fn() }));

import { useStudentLifetimeStats } from './useStudentLifetimeStats';
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
  return ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

/**
 * Builds the table-keyed supabase mock. `setLogPages` is the sequence of
 * response pages the paging loop should walk; the head-count calls are served
 * from `counts`.
 */
function mockTables({ student = { id: 'st-1' }, counts = {}, setLogPages = [[]] } = {}) {
  const studentChain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: student, error: null }),
  };
  const confChain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockResolvedValue({ count: counts.sessions ?? 0, error: null }),
  };
  const pages = [...setLogPages];
  const setLogChain = {
    select: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    // Each .range() hands back the next page, so the hook's "short read ends
    // the loop" contract is what actually terminates this mock.
    range: vi.fn(() => Promise.resolve({ data: pages.shift() || [], error: null })),
  };
  // The head-count call has no .range(); it awaits the chain itself.
  setLogChain.then = (resolve) =>
    Promise.resolve({ count: counts.sets ?? 0, error: null }).then(resolve);

  supabase.from.mockImplementation((table) => {
    if (table === 'students') return studentChain;
    if (table === 'session_confirmations') return confChain;
    return setLogChain;
  });
  return { studentChain, confChain, setLogChain };
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuth.mockReturnValue({ user: { id: 'u-1' } });
});

describe('useStudentLifetimeStats', () => {
  it('returns zeroes for a profile with no students row instead of throwing', async () => {
    mockTables({ student: null });
    const { result } = renderHook(() => useStudentLifetimeStats(), {
      wrapper: withClient(makeClient()),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({
      sessionsCompleted: 0,
      setsDone: 0,
      totalVolumeKg: 0,
    });
  });

  it('takes both totals from server-side counts, not from row-array lengths', async () => {
    // 4210 is deliberately far past PostgREST's 1000-row default cap: reading
    // these off a returned array would silently report 1000.
    mockTables({ counts: { sessions: 1500, sets: 4210 } });
    const { result } = renderHook(() => useStudentLifetimeStats(), {
      wrapper: withClient(makeClient()),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data.sessionsCompleted).toBe(1500);
    expect(result.current.data.setsDone).toBe(4210);
  });

  it('sums volume across every page, falling back to volume_weight when unweighted', async () => {
    const weighted = (n) =>
      Array.from({ length: n }, () => ({
        weight_kg: 100,
        target_reps: 5,
        exercise_slot: { exercise: { volume_weight: 1 } },
      }));
    // A full page forces a second request; the short second page ends it.
    mockTables({
      counts: { sets: 1002 },
      setLogPages: [
        weighted(1000),
        [
          // Bodyweight movement: no logged weight, so volume_weight applies.
          { weight_kg: null, target_reps: 10, exercise_slot: { exercise: { volume_weight: 70 } } },
          // Time-based set: no target_reps, contributes nothing.
          { weight_kg: 50, target_reps: null, exercise_slot: { exercise: { volume_weight: 1 } } },
        ],
      ],
    });

    const { result } = renderHook(() => useStudentLifetimeStats(), {
      wrapper: withClient(makeClient()),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // 1000 × (100 × 5) + (70 × 10) + 0
    expect(result.current.data.totalVolumeKg).toBe(500_700);
  });
});
