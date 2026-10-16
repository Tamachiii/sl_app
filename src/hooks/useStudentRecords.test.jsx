import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../lib/supabase', () => ({ supabase: { from: vi.fn() } }));
vi.mock('./useAuth', () => ({ useAuth: vi.fn() }));

import { useStudentRecords } from './useStudentRecords';
import { fetchDoneSetHistory } from '../lib/doneSetHistory';
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

// The tables behind the hook, served by name: set_logs and slot_deviations
// (the athlete's shared history, lib/doneSetHistory), bodyweight_logs, and
// students (the coach flow reads the athlete's profile id from it). The fake
// cuts every response at 1000 rows, as PostgREST does.
function wire({ profile = { profile_id: 'prof-1' }, setLogs = [], deviations = [], bodyweight = [] }) {
  const db = fakePostgrest({
    students: profile ? [profile] : [],
    set_logs: setLogs,
    slot_deviations: deviations,
    bodyweight_logs: bodyweight,
  });
  supabase.from.mockImplementation(db.from);
  return db;
}

// A set_logs row as the history read receives it. `exercise` is the library
// row of the slot's exercise ({ id, name, type, load_mode }); pass
// `visible: false` for one the reader may not see (the embed comes back null).
let nextLogId = 0;
function log({ id, slotId, exercise, visible = true, loggedAt, tReps = null, tW = null, aReps = null, aW = null }) {
  const { id: exerciseId, ...details } = exercise;
  return {
    id: id ?? `l-${String(nextLogId++).padStart(5, '0')}`,
    set_number: 1,
    logged_at: loggedAt,
    target_reps: tReps,
    target_weight_kg: tW,
    actual_reps: aReps,
    actual_weight_kg: aW,
    exercise_slots: {
      id: slotId,
      exercise_id: exerciseId,
      session_id: `s-${slotId}`,
      exercise: visible ? details : null,
      sessions: { scheduled_date: null, weeks: { programs: { student_id: 'st-1', deleted_at: null } } },
    },
  };
}

// A swap: the slot was done as `to` instead of what it prescribed.
function swap({ id = 'd-1', slotId, to, visible = true }) {
  const { id: substituteId, ...details } = to;
  return { id, exercise_slot_id: slotId, substitute_exercise_id: substituteId, substitute: visible ? details : null };
}

// Coach flow by default (a students-table id); `records(null)` is the athlete flow.
async function records(studentRowId = 'st-1', qc = makeClient()) {
  const { result } = renderHook(() => useStudentRecords(studentRowId ?? undefined), { wrapper: withClient(qc) });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  return result.current.data;
}

const BENCH = { id: 'e-1', name: 'Bench', type: 'push' };
const ROW = { id: 'e-9', name: 'Barbell Row', type: 'pull' };
const MACHINE_ROW = { id: 'e-1', name: 'Machine Row', type: 'pull' };
const PROGRAM = 'exercise_slots.sessions.weeks.programs';

beforeEach(() => {
  vi.clearAllMocks();
  nextLogId = 0;
  useAuth.mockReturnValue({ user: { id: 'u-1' } });
});

afterEach(() => {
  // Each history entry holds a ten-minute collection timer.
  while (clients.length) clients.pop().clear();
});

describe('useStudentRecords — swap awareness', () => {
  it('builds a record for a non-swapped exercise from effective load', async () => {
    wire({
      setLogs: [log({ slotId: 'sl-1', exercise: BENCH, loggedAt: '2026-04-01T10:00:00Z', tReps: 5, tW: 100, aReps: 5, aW: 100 })],
    });
    const bench = (await records()).find((r) => r.exercise_id === 'e-1');
    expect(bench).toMatchObject({ name: 'Bench', type: 'push' });
    // Epley: 100 × (1 + 5/30) ≈ 116.67 → rounded 117.
    expect(bench.bestE1rm).toBe(117);
  });

  it('credits a swapped set to the SUBSTITUTE using the logged actual, not the original or its pinned target', async () => {
    wire({
      // Slot prescribed e-9 @ 100kg target; student swapped to e-1 and logged 6 @ 80.
      setLogs: [log({ slotId: 'sl-swap', exercise: ROW, loggedAt: '2026-04-02T10:00:00Z', tReps: 5, tW: 100, aReps: 6, aW: 80 })],
      deviations: [swap({ slotId: 'sl-swap', to: MACHINE_ROW })],
    });
    const data = await records();
    // The original e-9 gets NO record (the set wasn't that exercise)…
    expect(data.find((r) => r.exercise_id === 'e-9')).toBeUndefined();
    // …the substitute e-1 gets it, from the LOGGED 80kg × 6 (not the 100kg target).
    const sub = data.find((r) => r.exercise_id === 'e-1');
    expect(sub).toMatchObject({ name: 'Machine Row', type: 'pull' });
    // 80 × (1 + 6/30) = 96.
    expect(sub.bestE1rm).toBe(96);
  });

  it('drops a swapped set with no logged actual (never inherits the original prescription)', async () => {
    wire({
      // Swapped but only the coach's target exists — no actuals. Nothing to credit
      // to the substitute (and the original must not get it either).
      setLogs: [log({ slotId: 'sl-swap', exercise: ROW, loggedAt: '2026-04-03T10:00:00Z', tReps: 5, tW: 100, aReps: null, aW: null })],
      deviations: [swap({ slotId: 'sl-swap', to: MACHINE_ROW })],
    });
    expect(await records()).toEqual([]);
  });

  it('sets no record for an exercise the reader may not see — and does not hand a hidden swap back to the original', async () => {
    wire({
      setLogs: [
        // An exercise of a former coach's library: an id, no name.
        log({ slotId: 'sl-old', exercise: { id: 'e-old' }, visible: false, loggedAt: '2026-04-01T10:00:00Z', aReps: 5, aW: 200 }),
        // Prescribed e-9, done as something the reader cannot see.
        log({ slotId: 'sl-swap', exercise: ROW, loggedAt: '2026-04-02T10:00:00Z', tReps: 5, tW: 100, aReps: 5, aW: 150 }),
        log({ slotId: 'sl-1', exercise: BENCH, loggedAt: '2026-04-03T10:00:00Z', aReps: 1, aW: 100 }),
      ],
      deviations: [swap({ slotId: 'sl-swap', to: { id: 'e-gone' }, visible: false })],
    });
    expect((await records()).map((r) => r.exercise_id)).toEqual(['e-1']);
  });
});

describe('useStudentRecords — relative strength (×BW)', () => {
  const PULL_UP = { id: 'e-1', name: 'Weighted Pull-up', type: 'pull', load_mode: 'added' };

  it('computes ×BW for a classified exercise using the bodyweight series', async () => {
    wire({
      setLogs: [log({ slotId: 'sl-1', exercise: PULL_UP, loggedAt: '2026-04-10T10:00:00Z', aReps: 3, aW: 40 })],
      bodyweight: [{ weight_kg: '70', logged_on: '2026-04-01' }],
    });
    const r = (await records()).find((x) => x.exercise_id === 'e-1');
    // +40 × 3 at BW 70 → system e1RM 121, 1.7× BW. Headline stays the added-load e1RM.
    expect(r.bestE1rm).toBe(44);
    expect(r.relStrength).toBe(1.7);
    expect(r.bwAtBest).toBe(70);
  });

  it('omits ×BW when bodyweight is unknown (graceful degrade)', async () => {
    wire({
      setLogs: [log({ slotId: 'sl-1', exercise: PULL_UP, loggedAt: '2026-04-10T10:00:00Z', aReps: 3, aW: 40 })],
      bodyweight: [],
    });
    const r = (await records()).find((x) => x.exercise_id === 'e-1');
    expect(r.bestE1rm).toBe(44); // added-load e1RM, as today
    expect(r.relStrength).toBeNull();
  });

  it('takes the load mode of the SUBSTITUTE on a swapped set', async () => {
    wire({
      // Prescribed a barbell lift (full load), done as a weighted pull-up.
      setLogs: [log({ slotId: 'sl-swap', exercise: { ...ROW, load_mode: 'full' }, loggedAt: '2026-04-10T10:00:00Z', tReps: 5, tW: 100, aReps: 1, aW: 30 })],
      deviations: [swap({ slotId: 'sl-swap', to: PULL_UP })],
      bodyweight: [{ weight_kg: '60', logged_on: '2026-04-01' }],
    });
    const [r] = await records();
    // (60 + 30) / 60, not 30 / 60.
    expect(r).toMatchObject({ exercise_id: 'e-1', loadMode: 'added', relStrength: 1.5 });
  });
});

// A record can sit anywhere in the history, and one response holds 1000 rows.
describe('useStudentRecords — history longer than one page', () => {
  const pad = (i) => String(i).padStart(5, '0');
  const day = (i) => new Date(Date.UTC(2023, 0, 1 + i, 12)).toISOString();

  it('finds the record of an athlete with 1009 done sets when it sits past the first 1000', async () => {
    const setLogs = Array.from({ length: 1009 }, (_, i) =>
      log({ id: `l-${pad(i)}`, slotId: `sl-${i}`, exercise: BENCH, loggedAt: day(i), aReps: 5, aW: 100 }),
    );
    // The best lift, and the only set of a second exercise, both on page two.
    setLogs[1004] = log({ id: 'l-01004', slotId: 'sl-1004', exercise: BENCH, loggedAt: day(1004), aReps: 1, aW: 180 });
    setLogs[1007] = log({ id: 'l-01007', slotId: 'sl-1007', exercise: { id: 'e-2', name: 'Dip', type: 'push' }, loggedAt: day(1007), aReps: 12 });
    const db = wire({ setLogs });

    const data = await records();
    expect(data.find((r) => r.exercise_id === 'e-1').bestE1rm).toBe(180);
    expect(data.find((r) => r.exercise_id === 'e-2').bestReps).toBe(12);

    const requests = db.requestsTo('set_logs');
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.select).toMatch(/^\s*id, /);
      expect(request.order).toEqual({ column: 'id', ascending: true });
      expect(request.limit).toBe(1000);
      expect(request.filters).toContainEqual(['eq', 'done', true]);
      expect(request.filters).toContainEqual(['eq', `${PROGRAM}.student_id`, 'st-1']);
      expect(request.filters).toContainEqual(['is', `${PROGRAM}.deleted_at`, null]);
    }
    expect(requests[1].filters).toContainEqual(['gt', 'id', 'l-00999']);
  });

  it('follows every swap of an athlete with more than 1000 of them', async () => {
    const SLOTS = 1001;
    const db = wire({
      // Every slot prescribed e-9 and swapped to e-1. Two of them were trained,
      // the first and the one whose swap is the last row of the list.
      setLogs: [0, SLOTS - 1].map((i) =>
        log({ id: `l-${pad(i)}`, slotId: `sl-${pad(i)}`, exercise: ROW, loggedAt: day(i), tReps: 5, tW: 100, aReps: 6, aW: 80 }),
      ),
      deviations: Array.from({ length: SLOTS }, (_, i) => swap({ id: `d-${pad(i)}`, slotId: `sl-${pad(i)}`, to: MACHINE_ROW })),
    });

    const data = await records();
    // A swap lost to the cut would hand its set — and a record — to e-9.
    expect(data.map((r) => r.exercise_id)).toEqual(['e-1']);

    const requests = db.requestsTo('slot_deviations');
    expect(requests).toHaveLength(2);
    expect(requests[0].select).toMatch(/^\s*id, /);
    expect(requests[1].filters).toContainEqual(['eq', 'kind', 'swap']);
    expect(requests[1].filters).toContainEqual(['eq', `${PROGRAM}.student_id`, 'st-1']);
    expect(requests[1].filters).toContainEqual(['gt', 'id', 'd-00999']);
  });

  it('weighs each set against the bodyweight of its own period, over a series of 1100 days', async () => {
    const dateOf = (i) => day(i).slice(0, 10);
    // 50 kg for the first 100 days, 60 kg for the next 900, 80 kg for the last 100.
    const bodyweight = Array.from({ length: 1100 }, (_, i) => ({
      logged_on: dateOf(i),
      weight_kg: String(i < 100 ? 50 : i < 1000 ? 60 : 80),
    }));
    const added = (id, name) => ({ id, name, type: 'pull', load_mode: 'added' });
    const db = wire({
      setLogs: [
        // Day 10, in the OLDEST part of the series: (50 + 50) / 50 = 2.0.
        log({ slotId: 'sl-1', exercise: added('e-1', 'Weighted Pull-up'), loggedAt: day(10), aReps: 1, aW: 50 }),
        // Day 1099, in the NEWEST part: (80 + 40) / 80 = 1.5.
        log({ slotId: 'sl-2', exercise: added('e-2', 'Weighted Dip'), loggedAt: day(1099), aReps: 1, aW: 40 }),
      ],
      bodyweight,
    });

    const data = await records();
    // Either end of the series cut off gives another bodyweight, so another ratio.
    expect(data.find((r) => r.exercise_id === 'e-1')).toMatchObject({ relStrength: 2, bwAtBest: 50 });
    expect(data.find((r) => r.exercise_id === 'e-2')).toMatchObject({ relStrength: 1.5, bwAtBest: 80 });

    const requests = db.requestsTo('bodyweight_logs');
    expect(requests).toHaveLength(2);
    // Walked on the day, newest first: unique within one athlete's series.
    expect(requests[0].order).toEqual({ column: 'logged_on', ascending: false });
    expect(requests[0].limit).toBe(1000);
    expect(requests[0].filters).toEqual([['eq', 'student_id', 'prof-1']]);
    expect(requests[1].filters).toContainEqual(['lt', 'logged_on', dateOf(100)]);
  });
});

describe('useStudentRecords — the order of the rows does not decide a record', () => {
  it('leaves a tied best with the EARLIER set, so matching it is not a new PR', async () => {
    const now = Date.now();
    const yesterday = new Date(now - 24 * 3600 * 1000).toISOString();
    const lastYear = new Date(now - 365 * 24 * 3600 * 1000).toISOString();
    wire({
      // Ids run against the dates: read in id order, the recent set comes first.
      setLogs: [
        log({ id: 'l-a', slotId: 'sl-2', exercise: BENCH, loggedAt: yesterday, aReps: 5, aW: 100 }),
        log({ id: 'l-b', slotId: 'sl-1', exercise: BENCH, loggedAt: lastYear, aReps: 5, aW: 100 }),
      ],
    });

    const [bench] = await records();
    expect(bench.bestE1rmAt).toBe(lastYear);
    expect(bench.recent).toBe(false);
  });
});

describe('useStudentRecords — a new PR is a new best of what the card shows', () => {
  it('a light back-off yesterday leaves last year’s e1RM where it was: no new PR', async () => {
    const now = Date.now();
    const yesterday = new Date(now - 24 * 3600 * 1000).toISOString();
    const lastYear = new Date(now - 365 * 24 * 3600 * 1000).toISOString();
    wire({
      setLogs: [
        log({ slotId: 'sl-1', exercise: BENCH, loggedAt: lastYear, aReps: 3, aW: 120 }),
        // More reps than any set before, at half the load.
        log({ slotId: 'sl-2', exercise: BENCH, loggedAt: yesterday, aReps: 12, aW: 60 }),
      ],
    });

    const [bench] = await records();
    expect(bench).toMatchObject({ bestE1rm: 132, bestE1rmAt: lastYear, bestReps: 12, bestRepsAt: yesterday });
    expect(bench.recent).toBe(false);
  });
});

describe('useStudentRecords — whose rows', () => {
  it('coach flow: the history is filtered on the athlete, and the bodyweight is that of the athlete’s profile', async () => {
    const db = wire({
      profile: { profile_id: 'prof-9' },
      setLogs: [log({ slotId: 'sl-1', exercise: BENCH, loggedAt: '2026-04-01T10:00:00Z', aReps: 5, aW: 100 })],
    });
    await records('st-9');

    expect(db.requestsTo('students').map((r) => r.filters)).toEqual([[['eq', 'id', 'st-9']]]);
    for (const table of ['set_logs', 'slot_deviations']) {
      expect(db.requestsTo(table)).toHaveLength(1);
      expect(db.requestsTo(table)[0].filters).toContainEqual(['eq', `${PROGRAM}.student_id`, 'st-9']);
    }
    expect(db.requestsTo('bodyweight_logs')[0].filters).toEqual([['eq', 'student_id', 'prof-9']]);
  });

  it('coach flow: an athlete whose row is gone still gets records, without a bodyweight read', async () => {
    const db = wire({
      profile: null,
      setLogs: [log({ slotId: 'sl-1', exercise: BENCH, loggedAt: '2026-04-01T10:00:00Z', aReps: 5, aW: 100 })],
    });
    expect((await records('st-9')).map((r) => r.exercise_id)).toEqual(['e-1']);
    expect(db.requestsTo('bodyweight_logs')).toEqual([]);
  });

  it('coach flow: the athlete is named by studentRowId alone — the reader’s own id is not needed', async () => {
    useAuth.mockReturnValue({ user: null });
    const db = wire({
      setLogs: [log({ slotId: 'sl-1', exercise: BENCH, loggedAt: '2026-04-01T10:00:00Z', aReps: 5, aW: 100 })],
    });
    expect((await records('st-9')).map((r) => r.exercise_id)).toEqual(['e-1']);
    expect(db.requestsTo('set_logs')[0].filters).toContainEqual(['eq', `${PROGRAM}.student_id`, 'st-9']);
  });

  it('athlete flow: no filter and no students lookup — RLS scopes the history, the bodyweight is the user’s own', async () => {
    const db = wire({
      setLogs: [log({ slotId: 'sl-1', exercise: BENCH, loggedAt: '2026-04-01T10:00:00Z', aReps: 5, aW: 100 })],
    });
    expect((await records(null)).map((r) => r.exercise_id)).toEqual(['e-1']);

    expect(db.requestsTo('students')).toEqual([]);
    for (const table of ['set_logs', 'slot_deviations']) {
      expect(db.requestsTo(table)).toHaveLength(1);
      expect(db.requestsTo(table)[0].filters.filter(([, column]) => String(column).endsWith('student_id'))).toEqual([]);
    }
    expect(db.requestsTo('bodyweight_logs')[0].filters).toEqual([['eq', 'student_id', 'u-1']]);
  });

  it('athlete flow: an athlete with no done set has no records', async () => {
    wire({});
    expect(await records(null)).toEqual([]);
  });

  it('keys the records on the athlete: a coach moving between two never shows one the other’s', async () => {
    const ofAthlete = (request) =>
      request.filters.find(([op, column]) => op === 'eq' && column === `${PROGRAM}.student_id`)?.[2];
    const db = fakePostgrest({
      students: [{ profile_id: 'prof-1' }],
      // The fake records filters without applying them; this table applies the
      // one that separates athletes.
      set_logs: (request) =>
        ({
          'st-4': [log({ id: 'l-4', slotId: 'sl-4', exercise: BENCH, loggedAt: '2026-04-01T10:00:00Z', aReps: 1, aW: 140 })],
          'st-5': [log({ id: 'l-5', slotId: 'sl-5', exercise: BENCH, loggedAt: '2026-04-01T10:00:00Z', aReps: 1, aW: 60 })],
        })[ofAthlete(request)] || [],
      slot_deviations: [],
      bodyweight_logs: [],
    });
    supabase.from.mockImplementation(db.from);
    const qc = makeClient();

    expect((await records('st-4', qc))[0].bestE1rm).toBe(140);
    expect((await records('st-5', qc))[0].bestE1rm).toBe(60);

    const keys = qc.getQueryCache().getAll().map((q) => q.queryKey);
    expect(keys).toEqual(expect.arrayContaining([
      ['student-records', 'st-4'],
      ['student-records', 'st-5'],
      ['student-records', 'history', 'st-4'],
      ['student-records', 'history', 'st-5'],
    ]));
    expect(keys).toHaveLength(4);
  });
});

// The sets come from the athlete's shared history (lib/doneSetHistory), which
// "Last time" derives from too: the hook must use what is there, and renew it
// when — and only when — something says the history changed.
describe('useStudentRecords — the history is read once and shared', () => {
  const oneSet = () => [log({ id: 'l-1', slotId: 'sl-1', exercise: BENCH, loggedAt: '2026-04-01T10:00:00Z', aReps: 5, aW: 100 })];

  it('uses a history that is already in the cache instead of reading it again', async () => {
    const db = wire({ setLogs: oneSet() });
    const qc = makeClient();
    // What opening a session does first.
    await fetchDoneSetHistory(qc, { userId: 'u-1' });
    expect(db.requestsTo('set_logs')).toHaveLength(1);

    expect((await records(null, qc))[0].bestE1rm).toBe(117);

    expect(db.requestsTo('set_logs')).toHaveLength(1);
    expect(db.requestsTo('slot_deviations')).toHaveLength(1);
  });

  it('a refetch — coming back to the tab — re-reads the bodyweight, not the history', async () => {
    const db = wire({ setLogs: oneSet() });
    const { result } = renderHook(() => useStudentRecords(), { wrapper: withClient(makeClient()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    await act(() => result.current.refetch());

    expect(db.requestsTo('bodyweight_logs')).toHaveLength(2);
    expect(db.requestsTo('set_logs')).toHaveLength(1);
    expect(db.requestsTo('slot_deviations')).toHaveLength(1);
  });

  it('invalidating ["student-records"] — a confirmed session, a logged bodyweight — renews the history and the records', async () => {
    const setLogs = oneSet();
    const db = wire({ setLogs });
    const qc = makeClient();
    const { result } = renderHook(() => useStudentRecords(), { wrapper: withClient(qc) });
    await waitFor(() => expect(result.current.data?.[0].bestE1rm).toBe(117));

    // The session just confirmed held a heavier single.
    setLogs.push(log({ id: 'l-2', slotId: 'sl-2', exercise: BENCH, loggedAt: '2026-04-08T10:00:00Z', aReps: 1, aW: 130 }));
    await act(() => qc.invalidateQueries({ queryKey: ['student-records'] }));

    await waitFor(() => expect(result.current.data[0].bestE1rm).toBe(130));
    expect(db.requestsTo('set_logs')).toHaveLength(2);
    expect(db.requestsTo('slot_deviations')).toHaveLength(2);
  });

  it('fails when the history cannot be read, and reads it again on the next try', async () => {
    let failing = true;
    const db = fakePostgrest({
      set_logs: () => (failing ? { error: { message: 'network down' } } : oneSet()),
      slot_deviations: [],
      bodyweight_logs: [],
    });
    supabase.from.mockImplementation(db.from);
    const { result } = renderHook(() => useStudentRecords(), { wrapper: withClient(makeClient()) });
    await waitFor(() => expect(result.current.isError).toBe(true));

    failing = false;
    await act(() => result.current.refetch());

    await waitFor(() => expect(result.current.data?.[0].bestE1rm).toBe(117));
    expect(db.requestsTo('set_logs')).toHaveLength(2);
  });
});
