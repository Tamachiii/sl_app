import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

vi.mock('./supabase', () => ({ supabase: { from: vi.fn() } }));

import {
  HISTORY_STALE_MS,
  doneSetHistoryKey,
  readDoneSetHistory,
  fetchDoneSetHistory,
} from './doneSetHistory';
import { shouldPersistQuery } from './queryClient';
import { supabase } from './supabase';
import { fakePostgrest } from '../test/fakePostgrest';

const PROGRAM = 'exercise_slots.sessions.weeks.programs';

// What the reader may see of the library, by exercise id.
const LIBRARY = {
  'e-1': { name: 'Bench', type: 'push', load_mode: 'full' },
  'e-2': { name: 'Dip', type: 'push', load_mode: 'added' },
  'e-9': { name: 'Barbell Row', type: 'pull', load_mode: null },
};

const pad = (i) => String(i).padStart(5, '0');
let seq = 0;

// A set_logs row as PostgREST returns it. `exercise` defaults to the library
// row of `exerciseId`; pass null for an exercise the reader may not see.
function rawSet({
  id, slot = 'sl-1', exerciseId = 'e-1', exercise, session = 's-1', scheduled = null,
  at = '2026-04-01T10:00:00Z', n = 1, tReps = null, tW = null, aReps = null, aW = null,
} = {}) {
  return {
    id: id ?? `l-${pad(seq++)}`,
    set_number: n,
    logged_at: at,
    target_reps: tReps,
    target_weight_kg: tW,
    actual_reps: aReps,
    actual_weight_kg: aW,
    exercise_slots: {
      id: slot,
      exercise_id: exerciseId,
      session_id: session,
      exercise: exercise === undefined ? LIBRARY[exerciseId] ?? null : exercise,
      sessions: { scheduled_date: scheduled, weeks: { programs: { student_id: 'st-1', deleted_at: null } } },
    },
  };
}

function rawSwap({ id, slot, to, substitute }) {
  return {
    id: id ?? `d-${pad(seq++)}`,
    exercise_slot_id: slot,
    substitute_exercise_id: to,
    substitute: substitute === undefined ? LIBRARY[to] ?? null : substitute,
  };
}

function wire({ setLogs = [], swaps = [] } = {}) {
  const db = fakePostgrest({ set_logs: setLogs, slot_deviations: swaps });
  supabase.from.mockImplementation(db.from);
  return db;
}

const clients = [];
function makeClient(queries = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, ...queries } } });
  clients.push(qc);
  return qc;
}

beforeEach(() => {
  vi.clearAllMocks();
  seq = 0;
});

afterEach(() => {
  vi.useRealTimers();
  // Each history entry holds a ten-minute collection timer.
  while (clients.length) clients.pop().clear();
});

describe('readDoneSetHistory — the rows', () => {
  it('flattens a done set and names the exercise it was done on', async () => {
    wire({
      setLogs: [rawSet({ id: 'l-1', slot: 'sl-a', session: 's-a', scheduled: '2026-04-01', n: 2, tReps: 5, tW: 100, aReps: 6, aW: 102.5 })],
    });

    expect(await readDoneSetHistory()).toEqual([
      {
        id: 'l-1',
        slotId: 'sl-a',
        sessionId: 's-a',
        scheduledDate: '2026-04-01',
        setNumber: 2,
        loggedAt: '2026-04-01T10:00:00Z',
        exerciseId: 'e-1',
        exercise: { id: 'e-1', name: 'Bench', type: 'push', load_mode: 'full' },
        swapped: false,
        target_reps: 5,
        target_weight_kg: 100,
        actual_reps: 6,
        actual_weight_kg: 102.5,
      },
    ]);
  });

  it('gives a set done on a swapped slot to the SUBSTITUTE, with the logged numbers only', async () => {
    wire({
      // Prescribed e-9 at 5 × 100; done as e-2, 6 × 80.
      setLogs: [rawSet({ slot: 'sl-swap', exerciseId: 'e-9', tReps: 5, tW: 100, aReps: 6, aW: 80 })],
      swaps: [rawSwap({ slot: 'sl-swap', to: 'e-2' })],
    });

    const [set] = await readDoneSetHistory();
    expect(set).toMatchObject({
      exerciseId: 'e-2',
      exercise: { id: 'e-2', name: 'Dip', type: 'push', load_mode: 'added' },
      swapped: true,
      // The pinned targets are e-9's: foreign to what was done.
      target_reps: null,
      target_weight_kg: null,
      actual_reps: 6,
      actual_weight_kg: 80,
    });
  });

  it('leaves a set on a slot that was not swapped alone, whatever other slots did', async () => {
    wire({
      setLogs: [rawSet({ slot: 'sl-plain', exerciseId: 'e-9', tReps: 5, tW: 100 })],
      swaps: [rawSwap({ slot: 'sl-other', to: 'e-2' })],
    });

    const [set] = await readDoneSetHistory();
    expect(set).toMatchObject({ exerciseId: 'e-9', swapped: false, target_reps: 5, target_weight_kg: 100 });
  });

  it('keeps a set whose exercise the reader may not see, by id and without details', async () => {
    wire({
      setLogs: [
        // An exercise of a former coach's library…
        rawSet({ id: 'l-1', slot: 'sl-a', exerciseId: 'e-old', exercise: null, aReps: 5, aW: 60 }),
        // …and a swap to one.
        rawSet({ id: 'l-2', slot: 'sl-b', exerciseId: 'e-1', aReps: 5, aW: 60 }),
      ],
      swaps: [rawSwap({ slot: 'sl-b', to: 'e-gone', substitute: null })],
    });

    const sets = await readDoneSetHistory();
    expect(sets.map((s) => [s.id, s.exerciseId, s.exercise, s.swapped])).toEqual([
      ['l-1', 'e-old', null, false],
      // Still a swap: the set is not handed back to the exercise prescribed.
      ['l-2', 'e-gone', null, true],
    ]);
  });

  it('shares one details object between all the sets of an exercise', async () => {
    wire({ setLogs: [rawSet({ slot: 'sl-a' }), rawSet({ slot: 'sl-b' })] });
    const [a, b] = await readDoneSetHistory();
    expect(a.exercise).toBe(b.exercise);
  });

  it('returns the sets oldest first, whatever order the pages bring them in', async () => {
    wire({
      // Ids run against the dates, and paging walks ids.
      setLogs: [
        rawSet({ id: 'l-a', at: '2026-04-03T10:00:00Z' }),
        rawSet({ id: 'l-b', at: '2026-04-01T10:00:00Z' }),
        // Same instant as l-d: the id breaks the tie.
        rawSet({ id: 'l-e', at: '2026-04-02T10:00:00Z' }),
        rawSet({ id: 'l-d', at: '2026-04-02T10:00:00Z' }),
        // A done set from before the column: first.
        rawSet({ id: 'l-c', at: null }),
      ],
    });

    expect((await readDoneSetHistory()).map((s) => s.id)).toEqual(['l-c', 'l-b', 'l-d', 'l-e', 'l-a']);
  });
});

describe('readDoneSetHistory — the requests', () => {
  const longHistory = () => ({
    setLogs: Array.from({ length: 1001 }, (_, i) => rawSet({ id: `l-${pad(i)}`, slot: `sl-${i}` })),
    swaps: Array.from({ length: 1001 }, (_, i) => rawSwap({ id: `d-${pad(i)}`, slot: `sl-x${i}`, to: 'e-2' })),
  });

  it('reads done sets and swaps to their end, a page of 1000 at a time', async () => {
    const db = wire(longHistory());

    expect(await readDoneSetHistory()).toHaveLength(1001);

    for (const table of ['set_logs', 'slot_deviations']) {
      const requests = db.requestsTo(table);
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request.select).toMatch(/^\s*id, /);
        expect(request.order).toEqual({ column: 'id', ascending: true });
        expect(request.limit).toBe(1000);
        // Trashed programs are left out of both.
        expect(request.filters).toContainEqual(['is', `${PROGRAM}.deleted_at`, null]);
      }
    }
    for (const request of db.requestsTo('set_logs')) {
      expect(request.filters).toContainEqual(['eq', 'done', true]);
    }
    for (const request of db.requestsTo('slot_deviations')) {
      expect(request.filters).toContainEqual(['eq', 'kind', 'swap']);
    }
    expect(db.requestsTo('set_logs')[1].filters).toContainEqual(['gt', 'id', 'l-00999']);
    expect(db.requestsTo('slot_deviations')[1].filters).toContainEqual(['gt', 'id', 'd-00999']);
  });

  it('sends the two reads together, not one after the other', async () => {
    const db = wire(longHistory());
    await readDoneSetHistory();
    // In sequence this would read set_logs, set_logs, slot_deviations, slot_deviations.
    expect(db.requests.map((r) => r.table)).toEqual([
      'set_logs', 'slot_deviations', 'set_logs', 'slot_deviations',
    ]);
  });

  it('coach flow: every page of BOTH reads is filtered on the athlete', async () => {
    const db = wire(longHistory());

    await readDoneSetHistory('st-4');

    expect(db.requests).toHaveLength(4);
    // Without it a coach's RLS returns the whole roster's rows.
    for (const request of db.requests) {
      expect(request.filters).toContainEqual(['eq', `${PROGRAM}.student_id`, 'st-4']);
    }
  });

  it('athlete flow: no athlete filter on either read — RLS scopes the rows', async () => {
    const db = wire(longHistory());

    await readDoneSetHistory();

    expect(db.requests).toHaveLength(4);
    for (const request of db.requests) {
      expect(request.filters.filter(([, column]) => String(column).endsWith('student_id'))).toEqual([]);
    }
  });

  it('a follow-up swap past the first 1000 still re-points its set', async () => {
    wire({
      setLogs: [rawSet({ slot: 'sl-last', exerciseId: 'e-9', aReps: 6, aW: 80 })],
      swaps: [
        ...Array.from({ length: 1000 }, (_, i) => rawSwap({ id: `d-${pad(i)}`, slot: `sl-x${i}`, to: 'e-1' })),
        rawSwap({ id: 'd-01000', slot: 'sl-last', to: 'e-2' }),
      ],
    });

    const [set] = await readDoneSetHistory();
    expect(set.exerciseId).toBe('e-2');
  });

  it('fails as a whole when either read fails', async () => {
    const boom = { message: 'permission denied', code: '42501' };
    const db = fakePostgrest({ set_logs: [rawSet()], slot_deviations: { error: boom } });
    supabase.from.mockImplementation(db.from);

    await expect(readDoneSetHistory()).rejects.toBe(boom);
  });
});

describe('fetchDoneSetHistory — one cached read per athlete', () => {
  const athlete = { userId: 'u-1' };

  it('keys the entry on the athlete, under the root that confirm and bodyweight invalidate', async () => {
    wire({ setLogs: [rawSet()] });
    const qc = makeClient();

    expect(doneSetHistoryKey('st-4')).toEqual(['student-records', 'history', 'st-4']);

    await fetchDoneSetHistory(qc, { userId: 'u-1' });
    // A coach is signed in as themselves and reads an athlete: the athlete names the entry.
    await fetchDoneSetHistory(qc, { studentRowId: 'st-4', userId: 'coach-1' });

    expect(qc.getQueryCache().getAll().map((q) => q.queryKey)).toEqual([
      ['student-records', 'history', 'u-1'],
      ['student-records', 'history', 'st-4'],
    ]);
  });

  it('reads once: a second caller gets the same list without a request', async () => {
    const db = wire({ setLogs: [rawSet(), rawSet()] });
    const qc = makeClient();

    const first = await fetchDoneSetHistory(qc, athlete);
    const second = await fetchDoneSetHistory(qc, athlete);

    expect(first).toHaveLength(2);
    expect(second).toBe(first);
    expect(db.requests.map((r) => r.table)).toEqual(['set_logs', 'slot_deviations']);
  });

  it('two callers arriving together share one read', async () => {
    const db = wire({ setLogs: [rawSet()] });
    const qc = makeClient();

    const [a, b] = await Promise.all([fetchDoneSetHistory(qc, athlete), fetchDoneSetHistory(qc, athlete)]);

    expect(a).toBe(b);
    expect(db.requestsTo('set_logs')).toHaveLength(1);
    expect(db.requestsTo('slot_deviations')).toHaveLength(1);
  });

  it('coach flow: one entry and one filtered read per athlete, never one athlete from another', async () => {
    const ofAthlete = (request) =>
      request.filters.find(([op, column]) => op === 'eq' && column === `${PROGRAM}.student_id`)?.[2];
    const db = fakePostgrest({
      // The fake records filters without applying them; this table applies the
      // one that matters here.
      set_logs: (request) =>
        ({
          'st-4': [rawSet({ id: 'l-4', aReps: 5, aW: 100 })],
          'st-5': [rawSet({ id: 'l-5', aReps: 5, aW: 60 })],
        })[ofAthlete(request)] || [rawSet({ id: 'l-4' }), rawSet({ id: 'l-5' })],
      slot_deviations: [],
    });
    supabase.from.mockImplementation(db.from);
    const qc = makeClient();
    const coach = (studentRowId) => ({ studentRowId, userId: 'coach-1' });

    const four = await fetchDoneSetHistory(qc, coach('st-4'));
    const five = await fetchDoneSetHistory(qc, coach('st-5'));
    const fourAgain = await fetchDoneSetHistory(qc, coach('st-4'));

    expect(four.map((s) => s.id)).toEqual(['l-4']);
    expect(five.map((s) => s.id)).toEqual(['l-5']);
    expect(fourAgain).toBe(four);

    expect(db.requests.map((r) => [r.table, ofAthlete(r)])).toEqual([
      ['set_logs', 'st-4'], ['slot_deviations', 'st-4'],
      ['set_logs', 'st-5'], ['slot_deviations', 'st-5'],
    ]);
    expect(qc.getQueryCache().findAll({ queryKey: ['student-records', 'history'] })).toHaveLength(2);
  });

  it('reads again once ["student-records"] is invalidated — and the invalidation itself reads nothing', async () => {
    const setLogs = [rawSet({ id: 'l-1' })];
    const db = wire({ setLogs });
    const qc = makeClient();
    await fetchDoneSetHistory(qc, athlete);

    setLogs.push(rawSet({ id: 'l-2', at: '2026-04-08T10:00:00Z' }));
    // What confirming a session and logging a bodyweight do.
    await qc.invalidateQueries({ queryKey: ['student-records'] });
    expect(db.requestsTo('set_logs')).toHaveLength(1);

    expect((await fetchDoneSetHistory(qc, athlete)).map((s) => s.id)).toEqual(['l-1', 'l-2']);
    expect(db.requestsTo('set_logs')).toHaveLength(2);
    // Read once: the entry is fresh again.
    await fetchDoneSetHistory(qc, athlete);
    expect(db.requestsTo('set_logs')).toHaveLength(2);
  });

  it('trusts a read for HISTORY_STALE_MS, then reads again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = new Date('2026-10-11T09:00:00Z').getTime();
    vi.setSystemTime(start);
    const db = wire({ setLogs: [rawSet()] });
    const qc = makeClient();
    await fetchDoneSetHistory(qc, athlete);

    vi.setSystemTime(start + HISTORY_STALE_MS - 1);
    await fetchDoneSetHistory(qc, athlete);
    expect(db.requestsTo('set_logs')).toHaveLength(1);

    vi.setSystemTime(start + HISTORY_STALE_MS);
    await fetchDoneSetHistory(qc, athlete);
    expect(db.requestsTo('set_logs')).toHaveLength(2);
  });

  it('drops the list from memory once it is too old to be used, whatever the client default', async () => {
    vi.useFakeTimers();
    wire({ setLogs: [rawSet()] });
    const qc = makeClient({ gcTime: 60 * 1000 });
    await fetchDoneSetHistory(qc, athlete);
    const entry = () => qc.getQueryCache().find({ queryKey: doneSetHistoryKey('u-1') });

    await vi.advanceTimersByTimeAsync(HISTORY_STALE_MS - 1);
    expect(entry()).toBeDefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(entry()).toBeUndefined();
  });

  it('does not keep a failed read, and does not retry it on its own', async () => {
    const boom = { message: 'network down' };
    let failing = true;
    const db = fakePostgrest({
      set_logs: () => (failing ? { error: boom } : [rawSet({ id: 'l-1' })]),
      slot_deviations: [],
    });
    supabase.from.mockImplementation(db.from);
    // The app's client retries queries; the history leaves that to its callers.
    const qc = makeClient({ retry: 3, retryDelay: 0 });

    await expect(fetchDoneSetHistory(qc, athlete)).rejects.toBe(boom);
    expect(db.requestsTo('set_logs')).toHaveLength(1);

    failing = false;
    expect((await fetchDoneSetHistory(qc, athlete)).map((s) => s.id)).toEqual(['l-1']);
    expect(db.requestsTo('set_logs')).toHaveLength(2);
  });

  it('refuses to read for nobody', async () => {
    const db = wire({ setLogs: [rawSet()] });
    await expect(fetchDoneSetHistory(makeClient(), {})).rejects.toThrow(/studentRowId/);
    expect(db.requests).toEqual([]);
  });

  it('never reaches IndexedDB: only the small object "Last time" reduces it to is persisted', () => {
    const settled = (queryKey) => ({ queryKey, state: { status: 'success' } });
    expect(shouldPersistQuery(settled(doneSetHistoryKey('u-1')))).toBe(false);
    expect(shouldPersistQuery(settled(['last-performance', 'self', 's-1', ['e-1']]))).toBe(true);
  });
});
