import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../lib/supabase', () => ({ supabase: { from: vi.fn() } }));
vi.mock('./useAuth', () => ({ useAuth: vi.fn() }));

import { useStudentLifetimeStats } from './useStudentLifetimeStats';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';
import { fakePostgrest } from '../test/fakePostgrest';

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
 * The three tables the hook reads, served by name. `setLogs` are the DONE rows
 * the volume read walks; the two head-count calls are answered from `counts`
 * (a server-side count is independent of the rows a response can carry, which
 * the fake cuts at 1000 as PostgREST does).
 */
function mockTables({ student = { id: 'st-1' }, counts = {}, setLogs = [] } = {}) {
  const db = fakePostgrest({
    students: student ? [student] : [],
    session_confirmations: { count: counts.sessions ?? 0 },
    set_logs: { rows: setLogs, count: counts.sets ?? 0 },
  });
  supabase.from.mockImplementation(db.from);
  return db;
}

const pad = (i) => String(i).padStart(5, '0');
const weighted = (n) =>
  Array.from({ length: n }, (_, i) => ({
    id: `l-${pad(i)}`,
    weight_kg: 100,
    target_reps: 5,
    exercise_slot: { exercise: { volume_weight: 1 } },
  }));

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
    // A full page forces a second request; the short second page ends it.
    const db = mockTables({
      counts: { sets: 1002 },
      setLogs: [
        ...weighted(1000),
        // Bodyweight movement: no logged weight, so volume_weight applies.
        { id: 'l-01000', weight_kg: null, target_reps: 10, exercise_slot: { exercise: { volume_weight: 70 } } },
        // Time-based set: no target_reps, contributes nothing.
        { id: 'l-01001', weight_kg: 50, target_reps: null, exercise_slot: { exercise: { volume_weight: 1 } } },
      ],
    });

    const { result } = renderHook(() => useStudentLifetimeStats(), {
      wrapper: withClient(makeClient()),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // 1000 × (100 × 5) + (70 × 10) + 0
    expect(result.current.data.totalVolumeKg).toBe(500_700);

    // The volume read: done sets of this athlete, walked on id — each page
    // starts after the last id received, so a set logged meanwhile cannot shift
    // the next page. (The head count is the request that carries no limit.)
    const pages = db.requestsTo('set_logs').filter((r) => !r.options?.head);
    expect(pages).toHaveLength(2);
    for (const page of pages) {
      expect(page.select).toMatch(/^\s*id,/);
      expect(page.order).toEqual({ column: 'id', ascending: true });
      expect(page.limit).toBe(1000);
      expect(page.filters).toContainEqual(['eq', 'done', true]);
      expect(page.filters).toContainEqual(['eq', 'exercise_slot.session.week.program.student_id', 'st-1']);
    }
    expect(pages[0].filters.find((f) => f[0] === 'gt')).toBeUndefined();
    expect(pages[1].filters).toContainEqual(['gt', 'id', 'l-00999']);
  });

  it('asks for a second page when exactly 1000 done sets come back', async () => {
    const db = mockTables({ counts: { sets: 1000 }, setLogs: weighted(1000) });
    const { result } = renderHook(() => useStudentLifetimeStats(), {
      wrapper: withClient(makeClient()),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data.totalVolumeKg).toBe(500_000);
    expect(db.requestsTo('set_logs').filter((r) => !r.options?.head)).toHaveLength(2);
  });
});
