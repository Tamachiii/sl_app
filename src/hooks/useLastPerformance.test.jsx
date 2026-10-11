import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../lib/supabase', () => ({ supabase: { from: vi.fn() } }));
vi.mock('./useAuth', () => ({ useAuth: vi.fn() }));

import { useLastPerformance } from './useLastPerformance';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';
import { fakePostgrest } from '../test/fakePostgrest';

const clients = [];
function makeClient() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
  clients.push(qc);
  return qc;
}
function withClient(qc) {
  return ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

// The two tables behind the hint — the athlete's shared history, read by
// lib/doneSetHistory — served by name. The fake cuts every response at 1000
// rows, as PostgREST does, and records each request.
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

afterEach(() => {
  // Each history entry holds a ten-minute collection timer.
  while (clients.length) clients.pop().clear();
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

  async function lastTime() {
    const { result } = renderHook(
      () => useLastPerformance(OPEN, slotsE1, '2026-04-20', []),
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

    const data = await lastTime();
    expect(data['e-1'].sets).toEqual([{ weight: 140, reps: 3 }]);

    const requests = db.requestsTo('set_logs');
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.select).toMatch(/^\s*id, /);
      expect(request.order).toEqual({ column: 'id', ascending: true });
      expect(request.limit).toBe(1000);
      expect(request.filters).toContainEqual(['eq', 'done', true]);
      expect(request.filters).toContainEqual(['is', 'exercise_slots.sessions.weeks.programs.deleted_at', null]);
    }
    expect(requests[1].filters).toContainEqual(['gt', 'id', 'l-00999']);
  });

  it('shows the LATEST session of a lift wherever its rows fall in id order', async () => {
    wire({
      setLogs: history({
        // An older session, early in id order…
        3: { slotId: 'sl-a', exerciseId: 'e-1', sessionId: 's-a', scheduledDate: '2025-01-10', loggedAt: '2025-01-10T10:00:00Z', tReps: 5, tW: 100 },
        // …and the most recent one on the second page.
        1100: { slotId: 'sl-b', exerciseId: 'e-1', sessionId: 's-b', scheduledDate: '2026-03-01', loggedAt: '2026-03-01T10:00:00Z', tReps: 5, tW: 110 },
      }),
    });

    const data = await lastTime();
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

    const data = await lastTime();
    expect(data['e-1'].sets).toEqual([{ weight: 80, reps: 6 }]);

    const requests = db.requestsTo('slot_deviations');
    expect(requests).toHaveLength(2);
    expect(requests[0].select).toMatch(/^\s*id, /);
    expect(requests[1].filters).toContainEqual(['eq', 'kind', 'swap']);
    expect(requests[1].filters).toContainEqual(['gt', 'id', 'd-00999']);
  });
});

// INVARIANTS makes the scope a MUST: a coach's RLS returns every athlete of the
// roster, so a hint read without the athlete filter shows the most recent
// number across all of them. And the cache must keep athletes apart too.
describe('useLastPerformance — whose history', () => {
  const pad = (i) => String(i).padStart(5, '0');
  const SCOPE = 'exercise_slots.sessions.weeks.programs.student_id';
  const athleteOf = (request) => request.filters.find(([op, column]) => op === 'eq' && column === SCOPE)?.[2];

  // 1001 rows in each table, so each read takes two requests.
  const twoPages = () => ({
    setLogs: Array.from({ length: 1001 }, (_, i) =>
      setLog({ id: `l-${pad(i)}`, slotId: `sl-${i}`, exerciseId: 'e-1', sessionId: `s-${i}`, loggedAt: '2026-04-01T10:00:00Z', tReps: 5, tW: 100 }),
    ),
    deviations: Array.from({ length: 1001 }, (_, i) => ({
      id: `d-${pad(i)}`, exercise_slot_id: `sl-x${i}`, substitute_exercise_id: 'e-7',
    })),
  });

  async function lastTime(qc, { session = OPEN, slots = slotsE1, athlete } = {}) {
    const { result } = renderHook(
      () => useLastPerformance(session, slots, '2026-04-20', [], true, athlete),
      { wrapper: withClient(qc) },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    return result.current.data;
  }

  it('coach flow: every page of BOTH reads is filtered on the athlete named by studentRowId', async () => {
    const db = wire(twoPages());

    await lastTime(makeClient(), { athlete: 'st-4' });

    expect(db.requestsTo('set_logs')).toHaveLength(2);
    expect(db.requestsTo('slot_deviations')).toHaveLength(2);
    for (const request of db.requests) {
      expect(request.filters).toContainEqual(['eq', SCOPE, 'st-4']);
    }
  });

  it('athlete flow: with no studentRowId, NEITHER read carries an athlete filter', async () => {
    const db = wire(twoPages());

    await lastTime(makeClient());

    expect(db.requestsTo('set_logs')).toHaveLength(2);
    expect(db.requestsTo('slot_deviations')).toHaveLength(2);
    // RLS scopes the rows to the signed-in athlete.
    for (const request of db.requests) {
      expect(request.filters.filter(([, column]) => String(column).endsWith('student_id'))).toEqual([]);
    }
  });

  it('keeps two athletes apart: each has their own hint, their own entry and their own history', async () => {
    const bench = (id, weight) =>
      setLog({ id, slotId: `sl-${id}`, exerciseId: 'e-1', sessionId: `s-${id}`, scheduledDate: '2026-04-01', loggedAt: '2026-04-01T10:00:00Z', tReps: 5, tW: weight });
    const db = fakePostgrest({
      // The fake records filters without applying them; this table applies the
      // one that separates athletes. Unfiltered, it answers like a coach's RLS:
      // with everybody's rows.
      set_logs: (request) =>
        ({ 'st-4': [bench('l-4', 140)], 'st-5': [bench('l-5', 60)] })[athleteOf(request)] ||
        [bench('l-4', 140), bench('l-5', 60)],
      slot_deviations: [],
    });
    supabase.from.mockImplementation(db.from);
    const qc = makeClient();

    // The same session id and the same exercise for both: only the athlete differs.
    const four = await lastTime(qc, { athlete: 'st-4' });
    const five = await lastTime(qc, { athlete: 'st-5' });

    expect(four['e-1'].sets).toEqual([{ weight: 140, reps: 5 }]);
    expect(five['e-1'].sets).toEqual([{ weight: 60, reps: 5 }]);

    expect(qc.getQueryCache().getAll().map((q) => q.queryKey)).toEqual(expect.arrayContaining([
      ['last-performance', 'st-4', OPEN, ['e-1']],
      ['last-performance', 'st-5', OPEN, ['e-1']],
      ['student-records', 'history', 'st-4'],
      ['student-records', 'history', 'st-5'],
    ]));
    expect(qc.getQueryCache().getAll()).toHaveLength(4);
    expect(db.requestsTo('set_logs').map(athleteOf)).toEqual(['st-4', 'st-5']);
  });

  it('athlete flow: the hint is keyed "self" and the history on the signed-in user', async () => {
    wire({
      setLogs: [setLog({ slotId: 'sl-a', exerciseId: 'e-1', sessionId: 's-prior', loggedAt: '2026-04-01T10:00:00Z', tReps: 5, tW: 100 })],
    });
    const qc = makeClient();

    await lastTime(qc);

    expect(qc.getQueryCache().getAll().map((q) => q.queryKey)).toEqual(expect.arrayContaining([
      ['last-performance', 'self', OPEN, ['e-1']],
      ['student-records', 'history', 'u-1'],
    ]));
  });
});

// The hint is picked out of the athlete's shared history (lib/doneSetHistory).
// A new session, or one more exercise, is a new query — not a new download.
describe('useLastPerformance — the history is read once', () => {
  const prior = (id, exerciseId, weight, day = '2026-04-01') =>
    setLog({ id, slotId: `sl-${id}`, exerciseId, sessionId: `s-${id}`, scheduledDate: day, loggedAt: `${day}T10:00:00Z`, tReps: 5, tW: weight });
  const slot = (id, exerciseId) => ({ id, exercise: { id: exerciseId } });

  it('opening a second session sends nothing', async () => {
    const db = wire({ setLogs: [prior('l-1', 'e-1', 100), prior('l-2', 'e-2', 40)] });
    const qc = makeClient();

    const first = renderHook(() => useLastPerformance('s-open-a', [slot('sl-a', 'e-1')], '2026-04-20', []), { wrapper: withClient(qc) });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    const second = renderHook(() => useLastPerformance('s-open-b', [slot('sl-b', 'e-2')], '2026-04-22', []), { wrapper: withClient(qc) });
    await waitFor(() => expect(second.result.current.isSuccess).toBe(true));

    expect(first.result.current.data['e-1'].sets).toEqual([{ weight: 100, reps: 5 }]);
    expect(second.result.current.data['e-2'].sets).toEqual([{ weight: 40, reps: 5 }]);
    expect(db.requests.map((r) => r.table)).toEqual(['set_logs', 'slot_deviations']);
  });

  it('coach editor: adding an exercise to the session shows its numbers without a request', async () => {
    const db = wire({ setLogs: [prior('l-1', 'e-1', 100), prior('l-2', 'e-2', 40)] });
    const { result, rerender } = renderHook(
      ({ slots }) => useLastPerformance(OPEN, slots, null, null, true, 'st-4'),
      { wrapper: withClient(makeClient()), initialProps: { slots: [slot('sl-a', 'e-1')] } },
    );
    await waitFor(() => expect(result.current.data?.['e-1']).toBeDefined());
    expect(result.current.data['e-2']).toBeUndefined();

    rerender({ slots: [slot('sl-a', 'e-1'), slot('sl-b', 'e-2')] });

    await waitFor(() => expect(result.current.data?.['e-2']?.sets).toEqual([{ weight: 40, reps: 5 }]));
    expect(result.current.data['e-1'].sets).toEqual([{ weight: 100, reps: 5 }]);
    expect(db.requests.map((r) => r.table)).toEqual(['set_logs', 'slot_deviations']);
  });

  it('a refetch — the phone unlocked between two sets — sends nothing', async () => {
    const db = wire({ setLogs: [prior('l-1', 'e-1', 100)] });
    const { result } = renderHook(() => useLastPerformance(OPEN, slotsE1, '2026-04-20', []), { wrapper: withClient(makeClient()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    await act(() => result.current.refetch());

    expect(db.requests.map((r) => r.table)).toEqual(['set_logs', 'slot_deviations']);
  });

  it('after ["student-records"] is invalidated — a confirmed session — the next session opened reads the history again', async () => {
    const setLogs = [prior('l-1', 'e-1', 100, '2026-04-01')];
    const db = wire({ setLogs });
    const qc = makeClient();
    const first = renderHook(() => useLastPerformance('s-open-a', slotsE1, '2026-04-10', []), { wrapper: withClient(qc) });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));

    // Session A is trained and confirmed.
    setLogs.push(setLog({ id: 'l-9', slotId: 'sl-a', exerciseId: 'e-1', sessionId: 's-open-a', scheduledDate: '2026-04-10', loggedAt: '2026-04-10T10:00:00Z', tReps: 5, tW: 105 }));
    await act(() => qc.invalidateQueries({ queryKey: ['student-records'] }));
    // Nothing derives from the history at that moment: nothing is read.
    expect(db.requestsTo('set_logs')).toHaveLength(1);

    const second = renderHook(() => useLastPerformance('s-open-b', slotsE1, '2026-04-17', []), { wrapper: withClient(qc) });
    await waitFor(() => expect(second.result.current.isSuccess).toBe(true));

    expect(second.result.current.data['e-1'].sets).toEqual([{ weight: 105, reps: 5 }]);
    expect(db.requestsTo('set_logs')).toHaveLength(2);
  });

  it('caches the small reduced object under its key — the entry that is persisted — not the history', async () => {
    wire({
      setLogs: [
        prior('l-1', 'e-1', 100),
        // 300 sets of other lifts: in the history, not in the entry.
        ...Array.from({ length: 300 }, (_, i) => prior(`l-x${i}`, 'e-2', 40)),
      ],
    });
    const qc = makeClient();
    const { result } = renderHook(() => useLastPerformance(OPEN, slotsE1, '2026-04-20', []), { wrapper: withClient(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(qc.getQueryData(['last-performance', 'self', OPEN, ['e-1']])).toEqual({
      'e-1': { performedAt: '2026-04-01T10:00:00Z', scheduledDate: '2026-04-01', sets: [{ weight: 100, reps: 5 }] },
    });
    expect(qc.getQueryData(['student-records', 'history', 'u-1'])).toHaveLength(301);
  });

  it('fails when the history cannot be read, and reads it again on the next try', async () => {
    let failing = true;
    const db = fakePostgrest({
      set_logs: () => (failing ? { error: { message: 'network down' } } : [prior('l-1', 'e-1', 100)]),
      slot_deviations: [],
    });
    supabase.from.mockImplementation(db.from);
    const { result } = renderHook(() => useLastPerformance(OPEN, slotsE1, '2026-04-20', []), { wrapper: withClient(makeClient()) });
    await waitFor(() => expect(result.current.isError).toBe(true));

    failing = false;
    await act(() => result.current.refetch());

    await waitFor(() => expect(result.current.data?.['e-1']?.sets).toEqual([{ weight: 100, reps: 5 }]));
    expect(db.requestsTo('set_logs')).toHaveLength(2);
  });
});
