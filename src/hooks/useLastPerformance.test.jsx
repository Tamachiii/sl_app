import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../lib/supabase', () => ({ supabase: { from: vi.fn() } }));
vi.mock('./useAuth', () => ({ useAuth: vi.fn() }));

import { useLastPerformance } from './useLastPerformance';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';
import { fakePostgrest } from '../test/fakePostgrest';

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
}
function withClient(qc) {
  return ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

// The two tables the hook reads, served by name. The fake cuts every response
// at 1000 rows, as PostgREST does, and records each request.
function wire({ setLogs = [], deviations = [] }) {
  const db = fakePostgrest({ set_logs: setLogs, slot_deviations: deviations });
  supabase.from.mockImplementation(db.from);
  return db;
}

let nextLogId = 0;
function setLog({ id, slotId, exerciseId, sessionId, scheduledDate = null, loggedAt, setNumber = 1, tReps = null, tW = null, aReps = null, aW = null }) {
  return {
    id: id ?? `l-${String(nextLogId++).padStart(5, '0')}`,
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
  nextLogId = 0;
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
      deviations: [{ id: 'd-1', exercise_slot_id: 'sl-swap', substitute_exercise_id: 'e-1' }],
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
      deviations: [{ id: 'd-1', exercise_slot_id: 'sl-away', substitute_exercise_id: 'e-5' }],
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

// The last time a lift was done can be anywhere in the history, and one
// response holds 1000 rows: a hint cut there reads "never".
describe('useLastPerformance — history longer than one page', () => {
  const pad = (i) => String(i).padStart(5, '0');
  const at = (i) => new Date(Date.UTC(2023, 0, 1 + i, 12)).toISOString();
  const dateOf = (i) => at(i).slice(0, 10);

  async function lastTime(db, ...args) {
    const { result } = renderHook(
      () => useLastPerformance(OPEN, slotsE1, '2026-04-20', [], true, ...args),
      { wrapper: withClient(makeClient()) },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    return result.current.data;
  }

  // 1119 done sets of another lift, one a day; `over` replaces some of them.
  const history = (over = {}) =>
    Array.from({ length: 1119 }, (_, i) =>
      over[i]
        ? setLog({ id: `l-${pad(i)}`, ...over[i] })
        : setLog({ id: `l-${pad(i)}`, slotId: `sl-${i}`, exerciseId: 'e-2', sessionId: `s-${i}`, scheduledDate: dateOf(i), loggedAt: at(i), tReps: 8, tW: 40 }),
    );

  it('finds a lift done once, long ago, behind more than 1000 other sets', async () => {
    // The OLDEST set of the history, and the last row in id order: neither the
    // newest 1000 nor the first 1000 by id contain it.
    const db = wire({
      setLogs: history({
        1118: { slotId: 'sl-old', exerciseId: 'e-1', sessionId: 's-old', scheduledDate: '2022-06-01', loggedAt: '2022-06-01T10:00:00Z', tReps: 3, tW: 140 },
      }),
    });

    const data = await lastTime(db);
    expect(data['e-1'].sets).toEqual([{ weight: 140, reps: 3 }]);

    const requests = db.requestsTo('set_logs');
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.select).toMatch(/^\s*id, /);
      expect(request.order).toEqual({ column: 'id', ascending: true });
      expect(request.limit).toBe(1000);
      expect(request.filters).toContainEqual(['eq', 'done', true]);
      expect(request.filters).toContainEqual(['is', 'exercise_slots.sessions.weeks.programs.deleted_at', null]);
      // Student flow: RLS scopes the rows, no athlete filter is sent.
      expect(request.filters.find((f) => f[1].endsWith('.student_id'))).toBeUndefined();
    }
    expect(requests[1].filters).toContainEqual(['gt', 'id', 'l-00999']);
  });

  it('shows the LATEST session of a lift wherever its rows fall in id order', async () => {
    const db = wire({
      setLogs: history({
        // An older session, early in id order…
        3: { slotId: 'sl-a', exerciseId: 'e-1', sessionId: 's-a', scheduledDate: '2025-01-10', loggedAt: '2025-01-10T10:00:00Z', tReps: 5, tW: 100 },
        // …and the most recent one on the second page.
        1100: { slotId: 'sl-b', exerciseId: 'e-1', sessionId: 's-b', scheduledDate: '2026-03-01', loggedAt: '2026-03-01T10:00:00Z', tReps: 5, tW: 110 },
      }),
    });

    const data = await lastTime(db);
    expect(data['e-1'].scheduledDate).toBe('2026-03-01');
    expect(data['e-1'].sets).toEqual([{ weight: 110, reps: 5 }]);
  });

  it('follows a prior swap whose row is past the first 1000 swaps', async () => {
    const db = wire({
      // Prescribed e-9, done as e-1: only the swap says so.
      setLogs: [
        setLog({ slotId: 'sl-01000', exerciseId: 'e-9', sessionId: 's-prior', scheduledDate: '2026-04-02', loggedAt: '2026-04-02T10:00:00Z', tReps: 5, tW: 100, aReps: 6, aW: 80 }),
      ],
      deviations: Array.from({ length: 1001 }, (_, i) => ({
        id: `d-${pad(i)}`, exercise_slot_id: `sl-${pad(i)}`, substitute_exercise_id: 'e-1',
      })),
    });

    const data = await lastTime(db);
    expect(data['e-1'].sets).toEqual([{ weight: 80, reps: 6 }]);

    const requests = db.requestsTo('slot_deviations');
    expect(requests).toHaveLength(2);
    expect(requests[0].select).toMatch(/^\s*id, /);
    expect(requests[1].filters).toContainEqual(['eq', 'kind', 'swap']);
    expect(requests[1].filters).toContainEqual(['gt', 'id', 'd-00999']);
  });

  it('coach flow: every page of both reads is filtered on the athlete', async () => {
    const db = wire({
      setLogs: history(),
      deviations: Array.from({ length: 1001 }, (_, i) => ({
        id: `d-${pad(i)}`, exercise_slot_id: `sl-x${i}`, substitute_exercise_id: 'e-7',
      })),
    });

    await lastTime(db, 'st-4');

    const scope = 'exercise_slots.sessions.weeks.programs.student_id';
    expect(db.requestsTo('set_logs')).toHaveLength(2);
    expect(db.requestsTo('slot_deviations')).toHaveLength(2);
    // Without it a coach's RLS returns every athlete's rows.
    for (const request of db.requests) {
      expect(request.filters).toContainEqual(['eq', scope, 'st-4']);
    }
  });
});
