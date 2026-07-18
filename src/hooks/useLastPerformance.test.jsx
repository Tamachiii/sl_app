import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../lib/supabase', () => ({ supabase: { from: vi.fn() } }));
vi.mock('./useAuth', () => ({ useAuth: vi.fn() }));

import { useLastPerformance } from './useLastPerformance';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
}
function withClient(qc) {
  return ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

// A thenable chain that returns `this` from every builder method and resolves to
// `data` when awaited at any terminal — matches the supabase-js fluent API.
function chain(data) {
  const c = {
    select: vi.fn(() => c),
    eq: vi.fn(() => c),
    is: vi.fn(() => c),
    order: vi.fn(() => c),
    limit: vi.fn(() => c),
    then: (resolve, reject) => Promise.resolve({ data, error: null }).then(resolve, reject),
  };
  return c;
}

// The hook fetches set_logs first, then slot_deviations — wire them in order.
function wire({ setLogs = [], deviations = [] }) {
  const seq = [chain(setLogs), chain(deviations)];
  let i = 0;
  supabase.from.mockImplementation(() => seq[i++]);
}

function setLog({ slotId, exerciseId, sessionId, scheduledDate = null, loggedAt, setNumber = 1, tReps = null, tW = null, aReps = null, aW = null }) {
  return {
    set_number: setNumber,
    logged_at: loggedAt,
    target_reps: tReps,
    target_weight_kg: tW,
    actual_reps: aReps,
    actual_weight_kg: aW,
    exercise_slots: {
      id: slotId,
      exercise_id: exerciseId,
      session_id: sessionId,
      sessions: { scheduled_date: scheduledDate, weeks: { programs: { deleted_at: null } } },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuth.mockReturnValue({ user: { id: 'u-1' } });
});

const OPEN = 'sess-open';
const slotsE1 = [{ id: 'sl-open', exercise: { id: 'e-1' } }];

describe('useLastPerformance — swap awareness', () => {
  it('returns the last prior session for a non-swapped exercise', async () => {
    wire({
      setLogs: [
        setLog({ slotId: 'sl-a', exerciseId: 'e-1', sessionId: 's-prior', scheduledDate: '2026-04-01', loggedAt: '2026-04-01T10:00:00Z', setNumber: 1, tReps: 5, tW: 100 }),
        setLog({ slotId: 'sl-a', exerciseId: 'e-1', sessionId: 's-prior', scheduledDate: '2026-04-01', loggedAt: '2026-04-01T10:05:00Z', setNumber: 2, tReps: 5, tW: 100 }),
      ],
    });
    const qc = makeClient();
    const { result } = renderHook(() => useLastPerformance(OPEN, slotsE1, '2026-04-20', []), { wrapper: withClient(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data['e-1'].sets).toEqual([
      { weight: 100, reps: 5 },
      { weight: 100, reps: 5 },
    ]);
  });

  it('attributes a prior slot SWAPPED to the target exercise (uses actuals, ignores foreign target)', async () => {
    // The prior slot was prescribed e-9 but the student swapped to e-1 and logged
    // an actual 80kg × 6. The pinned target (e-9's 100kg) must be ignored.
    wire({
      setLogs: [
        setLog({ slotId: 'sl-swap', exerciseId: 'e-9', sessionId: 's-prior', scheduledDate: '2026-04-02', loggedAt: '2026-04-02T10:00:00Z', setNumber: 1, tReps: 5, tW: 100, aReps: 6, aW: 80 }),
      ],
      deviations: [{ exercise_slot_id: 'sl-swap', substitute_exercise_id: 'e-1' }],
    });
    const qc = makeClient();
    const { result } = renderHook(() => useLastPerformance(OPEN, slotsE1, '2026-04-20', []), { wrapper: withClient(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // e-1's "last time" is the swapped-in performance, with the LOGGED load.
    expect(result.current.data['e-1'].sets).toEqual([{ weight: 80, reps: 6 }]);
  });

  it('does NOT attribute a prior slot swapped AWAY from the target to it', async () => {
    // Prior slot prescribed e-1 but swapped to e-5 → that work was e-5, not e-1.
    wire({
      setLogs: [
        setLog({ slotId: 'sl-away', exerciseId: 'e-1', sessionId: 's-prior', scheduledDate: '2026-04-03', loggedAt: '2026-04-03T10:00:00Z', setNumber: 1, tReps: 5, tW: 100, aReps: 5, aW: 100 }),
      ],
      deviations: [{ exercise_slot_id: 'sl-away', substitute_exercise_id: 'e-5' }],
    });
    const qc = makeClient();
    const { result } = renderHook(() => useLastPerformance(OPEN, slotsE1, '2026-04-20', []), { wrapper: withClient(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // e-1 has no genuine prior → no entry.
    expect(result.current.data['e-1']).toBeUndefined();
  });

  it('keys on the substitute when the OPEN session swaps the slot', async () => {
    // Open slot prescribes e-1 but is swapped to e-2 this session → the hint
    // should reflect e-2's prior history.
    wire({
      setLogs: [
        setLog({ slotId: 'sl-b', exerciseId: 'e-2', sessionId: 's-prior', scheduledDate: '2026-04-04', loggedAt: '2026-04-04T10:00:00Z', setNumber: 1, tReps: 8, tW: 40 }),
      ],
    });
    const currentDeviations = [{ exercise_slot_id: 'sl-open', kind: 'swap', substitute_exercise_id: 'e-2' }];
    const qc = makeClient();
    const { result } = renderHook(() => useLastPerformance(OPEN, slotsE1, '2026-04-20', currentDeviations), { wrapper: withClient(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data['e-2'].sets).toEqual([{ weight: 40, reps: 8 }]);
    // The prescribed-but-swapped-out e-1 is not queried.
    expect(result.current.data['e-1']).toBeUndefined();
  });

  it('is disabled (no fetch) when the open session has no resolvable exercises', async () => {
    wire({});
    const qc = makeClient();
    const { result } = renderHook(() => useLastPerformance(OPEN, [{ id: 'sl-x', exercise: null }], '2026-04-20', []), { wrapper: withClient(qc) });
    // enabled:false → never fetches.
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.fetchStatus).toBe('idle');
    expect(supabase.from).not.toHaveBeenCalled();
  });
});
