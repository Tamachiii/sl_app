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
// A done set as the volume read returns it: what was prescribed, what was
// logged instead (null when the set went as prescribed), and the slot.
const doneSet = (id, over = {}) => ({
  id,
  actual_reps: null,
  actual_weight_kg: null,
  target_reps: 5,
  target_weight_kg: 100,
  exercise_slot: { duration_seconds: null },
  ...over,
});
// n sets of 5 × 100 kg: 500 kg each.
const weighted = (n) => Array.from({ length: n }, (_, i) => doneSet(`l-${pad(i)}`));

// The path every set read filters the block through.
const PROGRAM = 'exercise_slot.session.week.program';

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

  it('sums volume across every page', async () => {
    // A full page forces a second request; the short second page ends it.
    const db = mockTables({
      counts: { sets: 1002 },
      setLogs: [
        ...weighted(1000),
        // A bodyweight movement: no load, 1 kg a rep.
        doneSet('l-01000', { target_reps: 10, target_weight_kg: null }),
        // Held for a time: no reps.
        doneSet('l-01001', { target_reps: null, target_weight_kg: 50, exercise_slot: { duration_seconds: 30 } }),
      ],
    });

    const { result } = renderHook(() => useStudentLifetimeStats(), {
      wrapper: withClient(makeClient()),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // 1000 × (5 × 100) + 10 × 1 + 0
    expect(result.current.data.totalVolumeKg).toBe(500_010);

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
      expect(page.filters).toContainEqual(['eq', `${PROGRAM}.student_id`, 'st-1']);
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

  // The total read `set_logs.weight_kg`, which nothing has written since the
  // athlete logs actuals, and fell back to the exercise's `volume_weight` — a
  // multiplier of 1: five sets of 5 at 100 kg made 25, not 2500.
  it('is the tonnage the Stats page counts: reps × load of every done set', async () => {
    mockTables({
      counts: { sets: 9 },
      setLogs: [
        // As prescribed: 5 × 100.
        doneSet('l-1'),
        // Logged otherwise: the actuals win, each on its own.
        doneSet('l-2', { actual_reps: 3, actual_weight_kg: 110 }), // 330
        doneSet('l-3', { actual_reps: 4 }), // 4 × 100
        doneSet('l-4', { actual_weight_kg: 90 }), // 5 × 90
        // No load, or a load of 0: the 1 kg bodyweight stand-in.
        doneSet('l-5', { target_reps: 10, target_weight_kg: null }), // 10
        doneSet('l-6', { target_reps: 8, target_weight_kg: 0 }), // 8
        // A slot held for a time adds no reps, whatever was typed in them.
        doneSet('l-7', { target_reps: null, actual_reps: 12, exercise_slot: { duration_seconds: 45 } }),
        // A real 0 reps is 0, not the target.
        doneSet('l-8', { actual_reps: 0 }),
        // A load written as text, as PostgREST prints a numeric.
        doneSet('l-9', { target_weight_kg: '62.5', target_reps: 2 }), // 125
      ],
    });
    const { result } = renderHook(() => useStudentLifetimeStats(), {
      wrapper: withClient(makeClient()),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data.totalVolumeKg).toBe(500 + 330 + 400 + 450 + 10 + 8 + 0 + 0 + 125);
  });

  // An undone set is not in the read (the fake applies no filter: the request
  // says it), and the read names no column nothing writes.
  it('reads done sets only, and never set_logs.weight_kg or the exercise', async () => {
    const db = mockTables({ counts: { sets: 1 }, setLogs: [doneSet('l-1')] });
    const { result } = renderHook(() => useStudentLifetimeStats(), {
      wrapper: withClient(makeClient()),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    for (const request of db.requestsTo('set_logs')) {
      expect(request.filters).toContainEqual(['eq', 'done', true]);
      expect(request.select).not.toMatch(/(?<![a-z_])weight_kg/);
      expect(request.select).not.toMatch(/exercise_library|volume_weight/);
      expect(request.select).toMatch(/duration_seconds/);
    }
  });

  // A block in the coach's trash is out of the Stats page, the training list
  // and the history; its sessions and sets were still in these three tiles.
  it('leaves a block in the trash out of the three figures', async () => {
    const db = mockTables({ counts: { sessions: 2, sets: 1 }, setLogs: [doneSet('l-1')] });
    const { result } = renderHook(() => useStudentLifetimeStats(), {
      wrapper: withClient(makeClient()),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [confirmations] = db.requestsTo('session_confirmations');
    expect(confirmations.select).toMatch(/programs!inner\(student_id, deleted_at\)/);
    expect(confirmations.filters).toEqual([
      ['eq', 'sessions.weeks.programs.student_id', 'st-1'],
      ['is', 'sessions.weeks.programs.deleted_at', null],
    ]);

    const sets = db.requestsTo('set_logs');
    expect(sets.map((r) => !!r.options?.head)).toEqual([true, false]);
    for (const request of sets) {
      expect(request.select).toMatch(/programs!inner\(student_id, deleted_at\)/);
      expect(request.filters).toContainEqual(['eq', `${PROGRAM}.student_id`, 'st-1']);
      expect(request.filters).toContainEqual(['is', `${PROGRAM}.deleted_at`, null]);
    }
  });
});
