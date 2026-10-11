import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../lib/supabase', () => ({ supabase: { from: vi.fn() } }));
vi.mock('./useAuth', () => ({ useAuth: vi.fn() }));

import { useStudentRecords } from './useStudentRecords';
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

// The tables the hook reads, served by name: students (the row id, or the
// profile id in the coach flow), set_logs, slot_deviations, bodyweight_logs.
// The fake cuts every response at 1000 rows, as PostgREST does.
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

let nextLogId = 0;
function log({ id, slotId, exercise, loggedAt, tReps = null, tW = null, aReps = null, aW = null }) {
  return {
    id: id ?? `l-${String(nextLogId++).padStart(5, '0')}`,
    done: true,
    logged_at: loggedAt,
    target_reps: tReps,
    target_weight_kg: tW,
    actual_reps: aReps,
    actual_weight_kg: aW,
    exercise_slots: { id: slotId, exercise, sessions: { weeks: { programs: { student_id: 'st-1', deleted_at: null } } } },
  };
}

// Coach flow by default (a students-table id); `records(null)` is the student flow.
async function records(studentRowId = 'st-1') {
  const { result } = renderHook(() => useStudentRecords(studentRowId ?? undefined), { wrapper: withClient(makeClient()) });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  return result.current.data;
}

beforeEach(() => {
  vi.clearAllMocks();
  nextLogId = 0;
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
      deviations: [{ id: 'd-1', exercise_slot_id: 'sl-swap', substitute: { id: 'e-1', name: 'Machine Row', type: 'pull' } }],
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
      deviations: [{ id: 'd-1', exercise_slot_id: 'sl-swap', substitute: { id: 'e-1', name: 'Machine Row', type: 'pull' } }],
    });
    const qc = makeClient();
    const { result } = renderHook(() => useStudentRecords('st-1'), { wrapper: withClient(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
  });
});

describe('useStudentRecords — relative strength (×BW)', () => {
  it('computes ×BW for a classified exercise using the bodyweight series', async () => {
    wire({
      setLogs: [log({ slotId: 'sl-1', exercise: { id: 'e-1', name: 'Weighted Pull-up', type: 'pull', load_mode: 'added' }, loggedAt: '2026-04-10T10:00:00Z', aReps: 3, aW: 40 })],
      bodyweight: [{ weight_kg: '70', logged_on: '2026-04-01' }],
    });
    const qc = makeClient();
    const { result } = renderHook(() => useStudentRecords('st-1'), { wrapper: withClient(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const r = result.current.data.find((x) => x.exercise_id === 'e-1');
    // +40 × 3 at BW 70 → system e1RM 121, 1.7× BW. Headline stays the added-load e1RM.
    expect(r.bestE1rm).toBe(44);
    expect(r.relStrength).toBe(1.7);
    expect(r.bwAtBest).toBe(70);
  });

  it('omits ×BW when bodyweight is unknown (graceful degrade)', async () => {
    wire({
      setLogs: [log({ slotId: 'sl-1', exercise: { id: 'e-1', name: 'Weighted Pull-up', type: 'pull', load_mode: 'added' }, loggedAt: '2026-04-10T10:00:00Z', aReps: 3, aW: 40 })],
      bodyweight: [],
    });
    const qc = makeClient();
    const { result } = renderHook(() => useStudentRecords('st-1'), { wrapper: withClient(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const r = result.current.data.find((x) => x.exercise_id === 'e-1');
    expect(r.bestE1rm).toBe(44); // added-load e1RM, as today
    expect(r.relStrength).toBeNull();
  });
});

// A record can sit anywhere in the history, and one response holds 1000 rows.
describe('useStudentRecords — history longer than one page', () => {
  const BENCH = { id: 'e-1', name: 'Bench', type: 'push' };
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
    const scope = 'exercise_slots.sessions.weeks.programs';
    for (const request of requests) {
      expect(request.select).toMatch(/^\s*id, /);
      expect(request.order).toEqual({ column: 'id', ascending: true });
      expect(request.limit).toBe(1000);
      expect(request.filters).toContainEqual(['eq', 'done', true]);
      expect(request.filters).toContainEqual(['eq', `${scope}.student_id`, 'st-1']);
      expect(request.filters).toContainEqual(['is', `${scope}.deleted_at`, null]);
    }
    expect(requests[1].filters).toContainEqual(['gt', 'id', 'l-00999']);
  });

  it('follows every swap of an athlete with more than 1000 of them', async () => {
    const SLOTS = 1001;
    const db = wire({
      // Every slot prescribed e-9 and swapped to e-1. Two of them were trained,
      // the first and the one whose swap is the last row of the list.
      setLogs: [0, SLOTS - 1].map((i) =>
        log({ id: `l-${pad(i)}`, slotId: `sl-${pad(i)}`, exercise: { id: 'e-9', name: 'Barbell Row', type: 'pull' }, loggedAt: day(i), tReps: 5, tW: 100, aReps: 6, aW: 80 }),
      ),
      deviations: Array.from({ length: SLOTS }, (_, i) => ({
        id: `d-${pad(i)}`, exercise_slot_id: `sl-${pad(i)}`, substitute: { id: 'e-1', name: 'Machine Row', type: 'pull' },
      })),
    });

    const data = await records();
    // A swap lost to the cut would hand its set — and a record — to e-9.
    expect(data.map((r) => r.exercise_id)).toEqual(['e-1']);

    const requests = db.requestsTo('slot_deviations');
    expect(requests).toHaveLength(2);
    expect(requests[0].select).toMatch(/^\s*id, /);
    expect(requests[1].filters).toContainEqual(['eq', 'kind', 'swap']);
    expect(requests[1].filters).toContainEqual(['eq', 'exercise_slots.sessions.weeks.programs.student_id', 'st-1']);
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
        log({ id: 'l-a', slotId: 'sl-2', exercise: { id: 'e-1', name: 'Bench', type: 'push' }, loggedAt: yesterday, aReps: 5, aW: 100 }),
        log({ id: 'l-b', slotId: 'sl-1', exercise: { id: 'e-1', name: 'Bench', type: 'push' }, loggedAt: lastYear, aReps: 5, aW: 100 }),
      ],
    });

    const [bench] = await records();
    expect(bench.bestE1rmAt).toBe(lastYear);
    expect(bench.recent).toBe(false);
  });
});

describe('useStudentRecords — whose rows', () => {
  it('student flow: resolves the students row from the profile and reads the own bodyweight', async () => {
    const db = wire({ profile: { id: 'st-7' } });
    await records(null);

    expect(db.requestsTo('students')[0].filters).toEqual([['eq', 'profile_id', 'u-1']]);
    expect(db.requestsTo('set_logs')[0].filters).toContainEqual([
      'eq', 'exercise_slots.sessions.weeks.programs.student_id', 'st-7',
    ]);
    expect(db.requestsTo('bodyweight_logs')[0].filters).toEqual([['eq', 'student_id', 'u-1']]);
  });

  it('a profile with no students row has no records, and nothing else is read', async () => {
    const db = wire({ profile: null });
    expect(await records(null)).toEqual([]);
    expect(db.requests.map((r) => r.table)).toEqual(['students']);
  });
});
