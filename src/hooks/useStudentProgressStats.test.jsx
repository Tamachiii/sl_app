import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../lib/supabase', () => ({ supabase: { from: vi.fn() } }));
vi.mock('./useAuth', () => ({ useAuth: vi.fn() }));

import { useStudentProgressStats } from './useStudentProgressStats';
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

/**
 * Build the four sequential supabase chains the hook walks through:
 *   1) students lookup   (only when no studentId is passed)
 *   2) programs (with the join tree)
 *   3) session_confirmations
 *   4) set_logs
 *
 * The hook builds the query for #2 with `.eq('student_id', ...).order(...)` —
 * `.order()` is the terminal call, so we resolve there. For scope==='all' there
 * is one .eq before .order; for scope==='active' there are two .eq calls.
 */
function setupChains({
  programsData,
  confirmationsData = [],
  setLogsData = [],
  studentIdLookup = { id: 'st-1' },
}) {
  const studentChain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: studentIdLookup, error: null }),
  };
  // The hook uses the supabase chain pattern: from(...).select(...).eq(...).order(...).
  // Make every method return `this` and only resolve via the *terminal* awaited
  // call. Since the hook does `await q;` (with q assigned via chained returns),
  // all chains are thenable on resolve. We wire `.order` and `.eq` as both
  // chainable AND awaitable: when awaited, they return the resolved promise.
  const programsChain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    then(resolve, reject) {
      Promise.resolve({ data: programsData, error: null }).then(resolve, reject);
    },
  };
  const confChain = {
    select: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    then(resolve, reject) {
      Promise.resolve({ data: confirmationsData, error: null }).then(resolve, reject);
    },
  };
  const logsChain = {
    select: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    then(resolve, reject) {
      Promise.resolve({ data: setLogsData, error: null }).then(resolve, reject);
    },
  };
  // The hook order varies based on scope/studentId — but it always pulls
  // students FIRST when no studentId is provided. Track call index.
  const sequenceWithStudent = [studentChain, programsChain, confChain, logsChain];
  const sequenceNoStudent = [programsChain, confChain, logsChain];
  let callIdx = 0;
  let useStudentLookup = true;
  return {
    chains: { studentChain, programsChain, confChain, logsChain },
    register({ withStudentLookup = true } = {}) {
      callIdx = 0;
      useStudentLookup = withStudentLookup;
      const seq = useStudentLookup ? sequenceWithStudent : sequenceNoStudent;
      supabase.from.mockImplementation(() => seq[callIdx++]);
    },
  };
}

describe('useStudentProgressStats — scope', () => {
  it('scope="all" by default: queries by student_id without is_active filter', async () => {
    const setup = setupChains({
      programsData: [
        {
          id: 'p-1',
          name: 'Block A',
          sort_order: 0,
          is_active: true,
          weeks: [
            {
              id: 'w-1',
              week_number: 1,
              label: null,
              sessions: [
                {
                  id: 's-1',
                  title: 'Push',
                  day_number: 1,
                  sort_order: 0,
                  scheduled_date: '2026-04-20',
                  archived_at: null,
                  exercise_slots: [],
                },
              ],
            },
          ],
        },
      ],
    });
    setup.register();
    const qc = makeClient();
    const { result } = renderHook(() => useStudentProgressStats(), {
      wrapper: withClient(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // .eq called with student_id=st-1 (resolved from profile) only.
    const eqCalls = setup.chains.programsChain.eq.mock.calls;
    expect(eqCalls).toContainEqual(['student_id', 'st-1']);
    expect(eqCalls.find((c) => c[0] === 'is_active')).toBeUndefined();
    expect(eqCalls.find((c) => c[0] === 'id')).toBeUndefined();
  });

  it('scope="active" adds is_active=true filter', async () => {
    const setup = setupChains({ programsData: [] });
    setup.register();
    const qc = makeClient();
    const { result } = renderHook(
      () => useStudentProgressStats(undefined, 'active'),
      { wrapper: withClient(qc) },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const eqCalls = setup.chains.programsChain.eq.mock.calls;
    expect(eqCalls).toContainEqual(['is_active', true]);
  });

  it('scope=<programId> filters by id and skips the students lookup when studentId is passed', async () => {
    const setup = setupChains({ programsData: [] });
    setup.register({ withStudentLookup: false });
    const qc = makeClient();
    const { result } = renderHook(
      () => useStudentProgressStats('st-1', 'p-7'),
      { wrapper: withClient(qc) },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const eqCalls = setup.chains.programsChain.eq.mock.calls;
    expect(eqCalls).toContainEqual(['id', 'p-7']);
    // No students lookup invoked.
    expect(setup.chains.studentChain.select).not.toHaveBeenCalled();
  });
});

describe('useStudentProgressStats — completion + tonnage', () => {
  it('treats archived sessions as completed even without a confirmation row', async () => {
    const setup = setupChains({
      programsData: [
        {
          id: 'p-1',
          name: 'Block A',
          sort_order: 0,
          is_active: true,
          weeks: [
            {
              id: 'w-1',
              week_number: 1,
              label: null,
              sessions: [
                {
                  id: 's-1',
                  title: 'Push',
                  day_number: 1,
                  sort_order: 0,
                  scheduled_date: null,
                  archived_at: '2026-04-22T10:00:00Z',
                  exercise_slots: [],
                },
                {
                  id: 's-2',
                  title: 'Pull',
                  day_number: 2,
                  sort_order: 1,
                  scheduled_date: null,
                  archived_at: null,
                  exercise_slots: [],
                },
              ],
            },
          ],
        },
      ],
      confirmationsData: [],
    });
    setup.register();
    const qc = makeClient();
    const { result } = renderHook(() => useStudentProgressStats(), {
      wrapper: withClient(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data.totalSessions).toBe(2);
    expect(result.current.data.totalSessionsConfirmed).toBe(1);
  });

  it('counts a session as completed when there is a confirmation row', async () => {
    const setup = setupChains({
      programsData: [
        {
          id: 'p-1',
          name: 'A',
          sort_order: 0,
          is_active: true,
          weeks: [
            {
              id: 'w-1',
              week_number: 1,
              label: null,
              sessions: [
                {
                  id: 's-1',
                  title: 'Push',
                  day_number: 1,
                  sort_order: 0,
                  scheduled_date: null,
                  archived_at: null,
                  exercise_slots: [],
                },
              ],
            },
          ],
        },
      ],
      confirmationsData: [{ id: 'c-1', session_id: 's-1', confirmed_at: '2026-04-21' }],
    });
    setup.register();
    const qc = makeClient();
    const { result } = renderHook(() => useStudentProgressStats(), {
      wrapper: withClient(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data.totalSessionsConfirmed).toBe(1);
    expect(result.current.data.weeksActive).toBe(1);
  });

  it('treats zero/null target_weight_kg as 1kg (bodyweight surrogate) for tonnage', async () => {
    const setup = setupChains({
      programsData: [
        {
          id: 'p-1',
          name: 'A',
          sort_order: 0,
          is_active: true,
          weeks: [
            {
              id: 'w-1',
              week_number: 1,
              label: null,
              sessions: [
                {
                  id: 's-1',
                  title: 'Push',
                  day_number: 1,
                  sort_order: 0,
                  scheduled_date: null,
                  archived_at: null,
                  exercise_slots: [
                    {
                      id: 'sl-1',
                      sets: 3,
                      reps: 5,
                      duration_seconds: null,
                      weight_kg: 0,
                      exercise: { id: 'e-1', name: 'Pull-up', type: 'pull', volume_weight: 1 },
                      set_logs: [
                        {
                          set_number: 1,
                          target_reps: 5,
                          target_duration_seconds: null,
                          target_weight_kg: 0,
                          target_rest_seconds: null,
                        },
                        {
                          set_number: 2,
                          target_reps: 5,
                          target_duration_seconds: null,
                          target_weight_kg: null,
                          target_rest_seconds: null,
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    setup.register();
    const qc = makeClient();
    const { result } = renderHook(() => useStudentProgressStats(), {
      wrapper: withClient(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const ex = result.current.data.exerciseProgress;
    expect(ex.exercises).toHaveLength(1);
    expect(ex.exercises[0].name).toBe('Pull-up');
    // 5 reps × 1kg × 2 logs = 10
    const points = ex.byExercise[ex.exercises[0].id];
    expect(points[0].tonnage).toBe(10);
  });

  it('falls back to slot scalars when set_logs are empty', async () => {
    const setup = setupChains({
      programsData: [
        {
          id: 'p-1',
          name: 'A',
          sort_order: 0,
          is_active: true,
          weeks: [
            {
              id: 'w-1',
              week_number: 1,
              label: null,
              sessions: [
                {
                  id: 's-1',
                  title: 'Push',
                  day_number: 1,
                  sort_order: 0,
                  scheduled_date: null,
                  archived_at: null,
                  exercise_slots: [
                    {
                      id: 'sl-1',
                      sets: 4,
                      reps: 5,
                      duration_seconds: null,
                      weight_kg: 100,
                      exercise: { id: 'e-1', name: 'Bench', type: 'push' },
                      set_logs: [],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    setup.register();
    const qc = makeClient();
    const { result } = renderHook(() => useStudentProgressStats(), {
      wrapper: withClient(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const ex = result.current.data.exerciseProgress;
    const points = ex.byExercise[ex.exercises[0].id];
    expect(points[0].tonnage).toBe(4 * 5 * 100);
  });

  it('caps recentConfirmations at 5 newest', async () => {
    const sessions = Array.from({ length: 7 }, (_, i) => ({
      id: `s-${i + 1}`,
      title: `S${i + 1}`,
      day_number: 1,
      sort_order: i,
      scheduled_date: null,
      archived_at: null,
      exercise_slots: [],
    }));
    const setup = setupChains({
      programsData: [
        {
          id: 'p-1',
          name: 'A',
          sort_order: 0,
          is_active: true,
          weeks: [{ id: 'w-1', week_number: 1, label: null, sessions }],
        },
      ],
      confirmationsData: sessions.map((s, i) => ({
        id: `c-${i + 1}`,
        session_id: s.id,
        confirmed_at: `2026-04-${20 + i}`,
      })),
    });
    setup.register();
    const qc = makeClient();
    const { result } = renderHook(() => useStudentProgressStats(), {
      wrapper: withClient(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data.recentConfirmations).toHaveLength(5);
    expect(result.current.data.recentConfirmations[0].session_title).toBeDefined();
  });

  it('builds sessionCalendar only for sessions with scheduled_date', async () => {
    const setup = setupChains({
      programsData: [
        {
          id: 'p-1',
          name: 'A',
          sort_order: 0,
          is_active: true,
          weeks: [
            {
              id: 'w-1',
              week_number: 1,
              label: null,
              sessions: [
                {
                  id: 's-1',
                  title: 'A',
                  day_number: 1,
                  sort_order: 0,
                  scheduled_date: '2026-04-20',
                  archived_at: null,
                  exercise_slots: [],
                },
                {
                  id: 's-2',
                  title: 'B',
                  day_number: 2,
                  sort_order: 1,
                  scheduled_date: null,
                  archived_at: null,
                  exercise_slots: [],
                },
              ],
            },
          ],
        },
      ],
    });
    setup.register();
    const qc = makeClient();
    const { result } = renderHook(() => useStudentProgressStats(), {
      wrapper: withClient(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data.sessionCalendar).toEqual([
      { session_id: 's-1', title: 'A', date: '2026-04-20', completed: false },
    ]);
  });
});
