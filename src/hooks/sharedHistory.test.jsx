// Personal records and the "Last time" hint derive from ONE read of the
// athlete's done sets (lib/doneSetHistory). Each hook has its own tests; this
// file holds what only shows with the hooks side by side, as a page mounts
// them — and with the real confirmation mutation, whose invalidation of
// ['student-records'] is what renews the history.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// `auth.getSession` because this file builds the app's client (the offline
// mutation defaults are registered on it): on that client a queued write —
// the confirmation, here — is not sent until a session can be read.
vi.mock('../lib/supabase', () => ({
  supabase: {
    from: vi.fn(),
    auth: { getSession: async () => ({ data: { session: { user: { id: 'u-1' } } }, error: null }) },
  },
}));
vi.mock('./useAuth', () => ({ useAuth: vi.fn() }));

import { useStudentRecords } from './useStudentRecords';
import { useLastPerformance } from './useLastPerformance';
import { useConfirmSession } from './useSessionConfirmation';
import { registerOfflineMutationDefaults } from '../lib/offlineMutations';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';
import { fakePostgrest } from '../test/fakePostgrest';

const PROGRAM = 'exercise_slots.sessions.weeks.programs';
const BENCH = { name: 'Bench', type: 'push', load_mode: 'full' };
const DIP = { name: 'Dip', type: 'push', load_mode: 'added' };
const LIBRARY = { 'e-1': BENCH, 'e-2': DIP };

const clients = [];
// The app's client, as far as these hooks can tell: the offline mutation
// defaults are registered on it, as queryClient.js does.
function makeClient() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
  registerOfflineMutationDefaults(qc);
  clients.push(qc);
  return qc;
}
function withClient(qc) {
  return ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

// One done set of `exerciseId` in `session`, 5 reps at `weight`.
function done(id, exerciseId, session, day, weight) {
  return {
    id,
    set_number: 1,
    logged_at: `${day}T10:00:00Z`,
    target_reps: 5,
    target_weight_kg: weight,
    actual_reps: null,
    actual_weight_kg: null,
    exercise_slots: {
      id: `sl-${id}`,
      exercise_id: exerciseId,
      session_id: session,
      exercise: LIBRARY[exerciseId],
      sessions: { scheduled_date: day, weeks: { programs: { student_id: 'st-1', deleted_at: null } } },
    },
  };
}

// The read tables come from the fake that cuts at 1000 rows; the one write of
// this file — the confirmation upsert — is answered by a stub (it resolves
// through `.single()` today; `.maybeSingle()` is answered the same).
function wire(setLogs) {
  const db = fakePostgrest({
    students: [{ profile_id: 'prof-1' }],
    set_logs: setLogs,
    slot_deviations: [],
    bodyweight_logs: [],
  });
  const confirmation = { id: 'c-1', session_id: 's-a', student_id: 'u-1' };
  const write = {
    upsert: vi.fn(() => write),
    select: () => write,
    single: async () => ({ data: confirmation, error: null }),
    maybeSingle: async () => ({ data: confirmation, error: null }),
  };
  supabase.from.mockImplementation((table) => (table === 'session_confirmations' ? write : db.from(table)));
  return { db, write };
}

const slot = (id, exerciseId) => ({ id, exercise: { id: exerciseId } });
const SLOTS_A = [slot('sl-open-a', 'e-1')];
const SLOTS_B = [slot('sl-open-b', 'e-1'), slot('sl-open-b2', 'e-2')];

const tables = (db) => db.requests.map((r) => r.table).sort();

beforeEach(() => {
  vi.clearAllMocks();
  useAuth.mockReturnValue({ user: { id: 'u-1' } });
});

afterEach(() => {
  // Each history entry holds a ten-minute collection timer.
  while (clients.length) clients.pop().clear();
});

describe('records and "Last time" share one read of the history', () => {
  const history = () => [
    done('l-1', 'e-1', 's-1', '2026-04-01', 100),
    done('l-2', 'e-2', 's-1', '2026-04-01', 20),
    done('l-3', 'e-1', 's-2', '2026-04-08', 105),
  ];

  // The records list and two sessions' hints, mounted in the same render.
  function usePage(athlete) {
    return {
      records: useStudentRecords(athlete),
      sessionA: useLastPerformance('s-open-a', SLOTS_A, '2026-04-20', [], true, athlete),
      sessionB: useLastPerformance('s-open-b', SLOTS_B, '2026-04-22', [], true, athlete),
    };
  }
  const settled = (result) =>
    waitFor(() => {
      expect(result.current.records.isSuccess).toBe(true);
      expect(result.current.sessionA.isSuccess).toBe(true);
      expect(result.current.sessionB.isSuccess).toBe(true);
    });

  it('athlete: the records and two sessions’ hints cost ONE history read between them', async () => {
    const { db } = wire(history());
    const { result } = renderHook(() => usePage(), { wrapper: withClient(makeClient()) });
    await settled(result);

    expect(result.current.records.data.map((r) => [r.exercise_id, r.bestE1rm])).toEqual([
      ['e-1', 123], // 105 × (1 + 5/30)
      ['e-2', 23],
    ]);
    expect(result.current.sessionA.data['e-1'].sets).toEqual([{ weight: 105, reps: 5 }]);
    expect(result.current.sessionB.data).toMatchObject({
      'e-1': { sets: [{ weight: 105, reps: 5 }] },
      'e-2': { sets: [{ weight: 20, reps: 5 }] },
    });

    // Three scans of the five-level join before; one now, plus the bodyweight.
    expect(tables(db)).toEqual(['bodyweight_logs', 'set_logs', 'slot_deviations']);
  });

  it('coach: the same, with the one read filtered on the athlete', async () => {
    const { db } = wire(history());
    const { result } = renderHook(() => usePage('st-4'), { wrapper: withClient(makeClient()) });
    await settled(result);

    expect(tables(db)).toEqual(['bodyweight_logs', 'set_logs', 'slot_deviations', 'students']);
    for (const table of ['set_logs', 'slot_deviations']) {
      expect(db.requestsTo(table)[0].filters).toContainEqual(['eq', `${PROGRAM}.student_id`, 'st-4']);
    }
  });

  it('one after the other — the records first, a session later — is still one read', async () => {
    const { db } = wire(history());
    const qc = makeClient();
    const records = renderHook(() => useStudentRecords(), { wrapper: withClient(qc) });
    await waitFor(() => expect(records.result.current.isSuccess).toBe(true));

    const session = renderHook(() => useLastPerformance('s-open-a', SLOTS_A, '2026-04-20', []), { wrapper: withClient(qc) });
    await waitFor(() => expect(session.result.current.isSuccess).toBe(true));

    expect(db.requestsTo('set_logs')).toHaveLength(1);
    expect(db.requestsTo('slot_deviations')).toHaveLength(1);
  });
});

// What renews the history after a confirmation is no longer the hook: it is
// the `onSettled` default of the confirmation keys, which `core-mutation-
// contracts` (lane offline-core, same wave) adds to lib/offlineMutations.js
// (`refreshAfter`, `CONFIRMATION_READS`). `useConfirmSession` sets no
// `onSettled` of its own from `student-confirm-offline` on — an option of the
// hook would replace that default.
describe('confirming a session renews the shared history', () => {
  // Session s-open-a is open; it is trained (one heavier set) and confirmed.
  const before = () => [done('l-1', 'e-1', 's-1', '2026-04-01', 100)];
  const trained = () => done('l-9', 'e-1', 's-open-a', '2026-04-20', 110);

  async function confirm(qc) {
    const { result } = renderHook(() => useConfirmSession(), { wrapper: withClient(qc) });
    await act(() => result.current.mutateAsync({ sessionId: 's-open-a', notes: '' }));
  }

  it('the records on screen pick up the session just confirmed, with one more read', async () => {
    const setLogs = before();
    const { db, write } = wire(setLogs);
    const qc = makeClient();
    const records = renderHook(() => useStudentRecords(), { wrapper: withClient(qc) });
    await waitFor(() => expect(records.result.current.data?.[0].bestE1rm).toBe(117));

    setLogs.push(trained());
    await confirm(qc);

    expect(write.upsert).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(records.result.current.data[0].bestE1rm).toBe(128)); // 110 × (1 + 5/30)
    expect(db.requestsTo('set_logs')).toHaveLength(2);
  });

  it('with nothing deriving from it, the confirmation reads nothing; the next session opened does, once, and sees the confirmed sets', async () => {
    const setLogs = before();
    const { db } = wire(setLogs);
    const qc = makeClient();
    const open = renderHook(() => useLastPerformance('s-open-a', SLOTS_A, '2026-04-20', []), { wrapper: withClient(qc) });
    await waitFor(() => expect(open.result.current.isSuccess).toBe(true));
    expect(open.result.current.data['e-1'].sets).toEqual([{ weight: 100, reps: 5 }]);

    setLogs.push(trained());
    await confirm(qc);
    // The open session's hint is not about its own sets: it is left alone.
    expect(db.requestsTo('set_logs')).toHaveLength(1);

    const next = renderHook(() => useLastPerformance('s-open-b', SLOTS_B, '2026-04-27', []), { wrapper: withClient(qc) });
    await waitFor(() => expect(next.result.current.isSuccess).toBe(true));
    expect(next.result.current.data['e-1'].sets).toEqual([{ weight: 110, reps: 5 }]);
    expect(db.requestsTo('set_logs')).toHaveLength(2);

    // And that read serves the records too.
    const records = renderHook(() => useStudentRecords(), { wrapper: withClient(qc) });
    await waitFor(() => expect(records.result.current.data?.[0].bestE1rm).toBe(128));
    expect(db.requestsTo('set_logs')).toHaveLength(2);
  });
});
