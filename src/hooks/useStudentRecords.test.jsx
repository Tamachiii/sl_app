import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../lib/supabase', () => ({ supabase: { from: vi.fn() } }));
vi.mock('./useAuth', () => ({ useAuth: vi.fn() }));

import { useStudentRecords } from './useStudentRecords';
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

function chain(data) {
  const c = {
    select: vi.fn(() => c),
    eq: vi.fn(() => c),
    is: vi.fn(() => c),
    limit: vi.fn(() => c),
    then: (resolve, reject) => Promise.resolve({ data, error: null }).then(resolve, reject),
  };
  return c;
}

// With a studentRowId passed the hook skips the students lookup: it fetches
// set_logs, then slot_deviations.
function wire({ setLogs = [], deviations = [] }) {
  const seq = [chain(setLogs), chain(deviations)];
  let i = 0;
  supabase.from.mockImplementation(() => seq[i++]);
}

function log({ slotId, exercise, loggedAt, tReps = null, tW = null, aReps = null, aW = null }) {
  return {
    done: true,
    logged_at: loggedAt,
    target_reps: tReps,
    target_weight_kg: tW,
    actual_reps: aReps,
    actual_weight_kg: aW,
    exercise_slots: { id: slotId, exercise, sessions: { weeks: { programs: { student_id: 'st-1', deleted_at: null } } } },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuth.mockReturnValue({ user: { id: 'u-1' } });
});

describe('useStudentRecords — swap awareness', () => {
  it('builds a record for a non-swapped exercise from effective load', async () => {
    wire({
      setLogs: [log({ slotId: 'sl-1', exercise: { id: 'e-1', name: 'Bench', type: 'push' }, loggedAt: '2026-04-01T10:00:00Z', tReps: 5, tW: 100, aReps: 5, aW: 100 })],
    });
    const qc = makeClient();
    const { result } = renderHook(() => useStudentRecords('st-1'), { wrapper: withClient(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const bench = result.current.data.find((r) => r.exercise_id === 'e-1');
    expect(bench).toBeTruthy();
    // Epley: 100 × (1 + 5/30) ≈ 116.67 → rounded 117.
    expect(bench.bestE1rm).toBe(117);
  });

  it('credits a swapped set to the SUBSTITUTE using the logged actual, not the original or its pinned target', async () => {
    wire({
      // Slot prescribed e-9 @ 100kg target; student swapped to e-1 and logged 6 @ 80.
      setLogs: [log({ slotId: 'sl-swap', exercise: { id: 'e-9', name: 'Barbell Row', type: 'pull' }, loggedAt: '2026-04-02T10:00:00Z', tReps: 5, tW: 100, aReps: 6, aW: 80 })],
      deviations: [{ exercise_slot_id: 'sl-swap', substitute: { id: 'e-1', name: 'Machine Row', type: 'pull' } }],
    });
    const qc = makeClient();
    const { result } = renderHook(() => useStudentRecords('st-1'), { wrapper: withClient(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // The original e-9 gets NO record (the set wasn't that exercise)…
    expect(result.current.data.find((r) => r.exercise_id === 'e-9')).toBeUndefined();
    // …the substitute e-1 gets it, from the LOGGED 80kg × 6 (not the 100kg target).
    const sub = result.current.data.find((r) => r.exercise_id === 'e-1');
    expect(sub).toBeTruthy();
    // 80 × (1 + 6/30) = 96.
    expect(sub.bestE1rm).toBe(96);
  });

  it('drops a swapped set with no logged actual (never inherits the original prescription)', async () => {
    wire({
      // Swapped but only the coach's target exists — no actuals. Nothing to credit
      // to the substitute (and the original must not get it either).
      setLogs: [log({ slotId: 'sl-swap', exercise: { id: 'e-9', name: 'Barbell Row', type: 'pull' }, loggedAt: '2026-04-03T10:00:00Z', tReps: 5, tW: 100, aReps: null, aW: null })],
      deviations: [{ exercise_slot_id: 'sl-swap', substitute: { id: 'e-1', name: 'Machine Row', type: 'pull' } }],
    });
    const qc = makeClient();
    const { result } = renderHook(() => useStudentRecords('st-1'), { wrapper: withClient(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
  });
});
