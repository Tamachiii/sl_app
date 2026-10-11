import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../lib/supabase', () => ({ supabase: { from: vi.fn() } }));
vi.mock('./useAuth', () => ({ useAuth: vi.fn() }));

import { useStudentProgressStats } from './useStudentProgressStats';
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
  return ({ children }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuth.mockReturnValue({ user: { id: 'u-1' } });
});

// Every time-based aggregate keys off the day the session was TRAINED, so a
// fixture that exercises volume/tonnage maths has to say when it happened —
// an undated session is backlog, not a data point (see the dedicated test).
const TRAINED_AT = '2026-07-08T18:00:00Z';

/**
 * The five tables the hook reads, served by table name (never by call order,
 * so a test does not care which read goes out first):
 *   students (only when no studentId is passed), programs (the join tree),
 *   session_confirmations, set_logs (the flat DONE list), slot_deviations.
 *
 * The fake cuts every response at 1000 rows like PostgREST does, and records
 * each request on `db.requests`.
 */
function setupChains({
  programsData,
  confirmationsData = [],
  setLogsData = [],
  deviationsData = [],
  studentIdLookup = { id: 'st-1' },
}) {
  const db = fakePostgrest({
    students: [studentIdLookup],
    programs: programsData,
    session_confirmations: confirmationsData,
    set_logs: setLogsData,
    slot_deviations: deviationsData,
  });
  return {
    db,
    register() {
      supabase.from.mockImplementation(db.from);
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
    // Filtered on student_id=st-1 (resolved from profile) only.
    const { filters } = setup.db.requestsTo('programs')[0];
    expect(filters).toContainEqual(['eq', 'student_id', 'st-1']);
    expect(filters.find((f) => f[1] === 'is_active')).toBeUndefined();
    expect(filters.find((f) => f[1] === 'id')).toBeUndefined();
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
    expect(setup.db.requestsTo('programs')[0].filters).toContainEqual(['eq', 'is_active', true]);
  });

  it('scope=<programId> filters by id and skips the students lookup when studentId is passed', async () => {
    const setup = setupChains({ programsData: [] });
    setup.register();
    const qc = makeClient();
    const { result } = renderHook(
      () => useStudentProgressStats('st-1', 'p-7'),
      { wrapper: withClient(qc) },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(setup.db.requestsTo('programs')[0].filters).toContainEqual(['eq', 'id', 'p-7']);
    // No students lookup invoked.
    expect(setup.db.requestsTo('students')).toHaveLength(0);
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
                  performed_at: TRAINED_AT,
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
                  performed_at: TRAINED_AT,
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
    // PLANNED tonnage uses target_* with the 1kg bodyweight surrogate:
    // 5 reps × 1kg × 2 logs = 10. No done set_logs → performed tonnage 0.
    const points = ex.byExercise[ex.exercises[0].id];
    expect(points[0].plannedTonnage).toBe(10);
    expect(points[0].tonnage).toBe(0);
  });

  it('performed tonnage reflects actual reps/weight on DONE sets (actual overrides target)', async () => {
    const setup = setupChains({
      programsData: [
        {
          id: 'p-1', name: 'A', sort_order: 0, is_active: true,
          weeks: [{
            id: 'w-1', week_number: 1, label: null,
            sessions: [{
              id: 's-1', title: 'Push', day_number: 1, sort_order: 0,
              scheduled_date: null, archived_at: null, performed_at: TRAINED_AT,
              exercise_slots: [{
                id: 'sl-1', sets: 2, reps: 5, duration_seconds: null, weight_kg: 100,
                exercise: { id: 'e-1', name: 'Bench', type: 'push', volume_weight: 1 },
                set_logs: [
                  { set_number: 1, target_reps: 5, target_weight_kg: 100 },
                  { set_number: 2, target_reps: 5, target_weight_kg: 100 },
                ],
              }],
            }],
          }],
        },
      ],
      // Set 1 done as prescribed (5×100); set 2 done with an actual override
      // (3 reps @ 90); the flat set_logs carry the performance columns.
      setLogsData: [
        { id: 'l-1', exercise_slot_id: 'sl-1', set_number: 1, done: true, target_reps: 5, target_weight_kg: 100, actual_reps: null, actual_weight_kg: null },
        { id: 'l-2', exercise_slot_id: 'sl-1', set_number: 2, done: true, target_reps: 5, target_weight_kg: 100, actual_reps: 3, actual_weight_kg: 90 },
      ],
    });
    setup.register();
    const qc = makeClient();
    const { result } = renderHook(() => useStudentProgressStats(), { wrapper: withClient(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const ex = result.current.data.exerciseProgress;
    const p = ex.byExercise[ex.exercises[0].id][0];
    // Planned: (5×100)+(5×100)=1000. Performed: (5×100)+(3×90)=770.
    expect(p.plannedTonnage).toBe(1000);
    expect(p.tonnage).toBe(770);
    // Weekly adherence: 2 of 2 prescribed sets done.
    const wk = result.current.data.weeklyVolume[0];
    expect(wk.sets_done).toBe(2);
    expect(wk.sets_prescribed).toBe(2);
  });

  it('adherence excludes student-added extra sets so it can never exceed 100%', async () => {
    const setup = setupChains({
      programsData: [
        {
          id: 'p-1', name: 'A', sort_order: 0, is_active: true,
          weeks: [{
            id: 'w-1', week_number: 1, label: null,
            sessions: [{
              id: 's-1', title: 'Push', day_number: 1, sort_order: 0,
              scheduled_date: null, archived_at: null, performed_at: TRAINED_AT,
              exercise_slots: [{
                id: 'sl-1', sets: 2, reps: 5, duration_seconds: null, weight_kg: 100,
                exercise: { id: 'e-1', name: 'Bench', type: 'push', volume_weight: 1 },
                set_logs: [
                  { set_number: 1, target_reps: 5, target_weight_kg: 100 },
                  { set_number: 2, target_reps: 5, target_weight_kg: 100 },
                ],
              }],
            }],
          }],
        },
      ],
      // 2 prescribed sets done + 1 STUDENT-ADDED extra set done.
      setLogsData: [
        { id: 'l-1', exercise_slot_id: 'sl-1', done: true, is_student_added: false, target_reps: 5, target_weight_kg: 100 },
        { id: 'l-2', exercise_slot_id: 'sl-1', done: true, is_student_added: false, target_reps: 5, target_weight_kg: 100 },
        { id: 'l-3', exercise_slot_id: 'sl-1', done: true, is_student_added: true, target_reps: null, target_weight_kg: null, actual_reps: 8, actual_weight_kg: 100 },
      ],
    });
    setup.register();
    const qc = makeClient();
    const { result } = renderHook(() => useStudentProgressStats(), { wrapper: withClient(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const wk = result.current.data.weeklyVolume[0];
    // Adherence counts the 2 prescribed sets, NOT the extra → 2/2 = 100%.
    expect(wk.sets_done).toBe(2);
    expect(wk.sets_prescribed).toBe(2);
    // The extra set still counts toward performed tonnage (real work):
    // (5×100)+(5×100)+(8×100) = 1800.
    const p = result.current.data.exerciseProgress.byExercise['e-1'][0];
    expect(p.tonnage).toBe(1800);
  });

  it('attributes performed work to the SWAP substitute, planned stays on the original', async () => {
    const setup = setupChains({
      programsData: [
        {
          id: 'p-1', name: 'A', sort_order: 0, is_active: true,
          weeks: [{
            id: 'w-1', week_number: 1, label: null,
            sessions: [{
              id: 's-1', title: 'Push', day_number: 1, sort_order: 0,
              scheduled_date: null, archived_at: null, performed_at: TRAINED_AT,
              exercise_slots: [{
                id: 'sl-1', sets: 1, reps: 5, duration_seconds: null, weight_kg: 100,
                // Coach prescribed a PUSH exercise…
                exercise: { id: 'e-1', name: 'Bench', type: 'push', difficulty: 1, volume_weight: 1 },
                set_logs: [{ set_number: 1, target_reps: 5, target_weight_kg: 100 }],
              }],
            }],
          }],
        },
      ],
      // …the student did the set (done), but SWAPPED to a PULL exercise.
      setLogsData: [
        { id: 'l-1', exercise_slot_id: 'sl-1', set_number: 1, done: true, target_reps: 5, target_weight_kg: 100, actual_reps: null, actual_weight_kg: null },
      ],
      deviationsData: [
        {
          id: 'd-1',
          exercise_slot_id: 'sl-1',
          kind: 'swap',
          substitute: { id: 'e-2', name: 'Machine Row', type: 'pull', difficulty: 1, volume_weight: 1 },
        },
      ],
    });
    setup.register();
    const qc = makeClient();
    const { result } = renderHook(() => useStudentProgressStats(), { wrapper: withClient(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const ex = result.current.data.exerciseProgress;
    // Two exercises now surface: the prescribed Bench (planned only) and the
    // performed Machine Row (performed only).
    const bench = ex.byExercise['e-1'][0];
    const row = ex.byExercise['e-2'][0];
    expect(bench.plannedTonnage).toBe(500);       // 5 × 100 prescribed (target)
    expect(bench.tonnage).toBe(0);                // no bench performed
    expect(bench.swappedTo).toBe('Machine Row');  // labeled as a swap, not a miss
    // No actual load was logged on the swap → 1kg bodyweight surrogate, NOT the
    // coach's original 100kg (the substitute must never inherit a foreign load).
    expect(row.tonnage).toBe(5);
    expect(row.plannedTonnage).toBeUndefined();   // substitute was never prescribed
    expect(row.swappedFrom).toBe('Bench');

    // Weekly volume: performed follows the swap (push → pull); planned stays push.
    const wk = result.current.data.weeklyVolume[0];
    expect(wk.pull).toBe(5);        // performed pull from the substitute
    expect(wk.push).toBe(0);        // no performed push
    expect(wk.push_planned).toBe(5); // planned stayed on the original push
    expect(wk.pull_planned).toBe(0);
  });

  it('honors a logged actual load on a swapped slot (not the original prescription)', async () => {
    const setup = setupChains({
      programsData: [
        {
          id: 'p-1', name: 'A', sort_order: 0, is_active: true,
          weeks: [{
            id: 'w-1', week_number: 1, label: null,
            sessions: [{
              id: 's-1', title: 'Push', day_number: 1, sort_order: 0,
              scheduled_date: null, archived_at: null, performed_at: TRAINED_AT,
              exercise_slots: [{
                id: 'sl-1', sets: 1, reps: 5, duration_seconds: null, weight_kg: 100,
                exercise: { id: 'e-1', name: 'Bench', type: 'push', difficulty: 1, volume_weight: 1 },
                set_logs: [{ set_number: 1, target_reps: 5, target_weight_kg: 100 }],
              }],
            }],
          }],
        },
      ],
      // Swapped to a machine and logged an ACTUAL 60kg × 5.
      setLogsData: [
        { id: 'l-1', exercise_slot_id: 'sl-1', set_number: 1, done: true, target_reps: 5, target_weight_kg: 100, actual_reps: 5, actual_weight_kg: 60 },
      ],
      deviationsData: [
        { id: 'd-1', exercise_slot_id: 'sl-1', kind: 'swap', substitute: { id: 'e-2', name: 'Machine Row', type: 'pull', difficulty: 1, volume_weight: 1 } },
      ],
    });
    setup.register();
    const qc = makeClient();
    const { result } = renderHook(() => useStudentProgressStats(), { wrapper: withClient(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // Performed tonnage uses the logged 60kg, not the original's pinned 100kg.
    const row = result.current.data.exerciseProgress.byExercise['e-2'][0];
    expect(row.tonnage).toBe(300); // 5 × 60
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
                  performed_at: TRAINED_AT,
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
    // Slot-scalar fallback feeds the PLANNED tonnage (sets × reps × weight).
    expect(points[0].plannedTonnage).toBe(4 * 5 * 100);
    expect(points[0].tonnage).toBe(0); // nothing logged done
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
    // Newest first, whatever order the rows were read in (they come by id).
    expect(result.current.data.recentConfirmations.map((c) => c.confirmed_at)).toEqual([
      '2026-04-26', '2026-04-25', '2026-04-24', '2026-04-23', '2026-04-22',
    ]);
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

// The whole point of Phase 3: time-based aggregates key off the day the
// student TRAINED, not the ordinal week the coach authored the session under.
describe('useStudentProgressStats — real-calendar bucketing', () => {
  const sessionFixture = (id, over = {}) => ({
    id,
    title: id,
    day_number: 1,
    sort_order: 0,
    scheduled_date: null,
    archived_at: null,
    performed_at: null,
    exercise_slots: [],
    ...over,
  });

  const programFixture = (sessions) => [
    {
      id: 'p-1',
      name: 'A',
      sort_order: 0,
      is_active: true,
      weeks: [{ id: 'w-1', week_number: 1, label: null, sessions }],
    },
  ];

  async function run(programsData, confirmationsData = []) {
    const setup = setupChains({ programsData, confirmationsData });
    setup.register();
    const qc = makeClient();
    const { result } = renderHook(() => useStudentProgressStats(), { wrapper: withClient(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    return result.current.data;
  }

  it('buckets by the real Mon–Sun week the session was trained in', async () => {
    const data = await run(
      programFixture([
        // Both authored in training week 1, but trained 9 days apart — they
        // belong to two different real weeks and must not share a bucket.
        sessionFixture('s-1', { performed_at: '2026-07-08T18:00:00Z' }), // Wed, week of Jul 6
        sessionFixture('s-2', { performed_at: '2026-07-17T18:00:00Z' }), // Fri, week of Jul 13
      ])
    );
    expect(data.weeklyVolume.map((b) => b.bucket_start)).toEqual(['2026-07-06', '2026-07-13']);
    expect(data.weeklyVolume[0].bucket_end).toBe('2026-07-12');
    expect(data.weeklyVolume.every((b) => b.sessions_confirmed === 1)).toBe(true);
    // Two calendar weeks of training — the honest elapsed-time figure.
    expect(data.weeksActive).toBe(2);
  });

  it('counts sessions with no training date as backlog, never as a time bucket', async () => {
    const data = await run(
      programFixture([
        sessionFixture('done', { performed_at: '2026-07-08T18:00:00Z' }),
        sessionFixture('todo'),
        sessionFixture('also-todo'),
      ])
    );
    expect(data.weeklyVolume).toHaveLength(1);
    expect(data.backlogSessions).toBe(2);
  });

  it('falls back to the confirmation date for rows written before performed_at existed', async () => {
    const data = await run(programFixture([sessionFixture('legacy')]), [
      {
        id: 'c-1',
        session_id: 'legacy',
        performed_on: '2026-07-09',
        confirmed_at: '2026-07-20T09:00:00Z',
      },
    ]);
    // performed_on beats confirmed_at — the latter is the moment an offline
    // confirm reached the server, which can be days after the training.
    expect(data.weeklyVolume[0].bucket_start).toBe('2026-07-06');
    expect(data.backlogSessions).toBe(0);
  });

  it('puts a trained session on the calendar on its REAL date, not its planned one', async () => {
    const data = await run(
      programFixture([
        sessionFixture('moved', {
          scheduled_date: '2026-07-06',
          performed_at: '2026-07-09T18:00:00Z',
        }),
        // Trained without any coach-set date: invisible on the old calendar,
        // which only ever plotted scheduled_date.
        sessionFixture('undated', { performed_at: '2026-07-10T18:00:00Z' }),
      ])
    );
    expect(data.sessionCalendar).toEqual([
      { session_id: 'moved', title: 'moved', date: '2026-07-09', completed: false },
      { session_id: 'undated', title: 'undated', date: '2026-07-10', completed: false },
    ]);
  });
});

// PostgREST answers one request with 1000 rows at most and does not say when it
// cut. The three flat lists the hook reads all grow with history, so each must
// be read to its end — these fixtures are sized like the two athletes who were
// past the cap in production.
describe('useStudentProgressStats — history longer than one page', () => {
  const pad = (i) => String(i).padStart(4, '0');

  const oneSessionProgram = (slots, over = {}) => [
    {
      id: 'p-1', name: 'A', sort_order: 0, is_active: true,
      weeks: [{
        id: 'w-1', week_number: 1, label: null,
        sessions: [{
          id: 's-1', title: 'Push', day_number: 1, sort_order: 0,
          scheduled_date: null, archived_at: null, performed_at: TRAINED_AT,
          exercise_slots: slots,
          ...over,
        }],
      }],
    },
  ];

  async function run(tables, args = []) {
    const setup = setupChains(tables);
    setup.register();
    const { result } = renderHook(() => useStudentProgressStats(...args), {
      wrapper: withClient(makeClient()),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    return { data: result.current.data, db: setup.db };
  }

  it('counts every done set of an athlete with 1119 of them, not the first 1000', async () => {
    const DONE = 1119;
    const { data, db } = await run({
      programsData: oneSessionProgram([
        {
          id: 'sl-1', sets: DONE, reps: 5, duration_seconds: null, weight_kg: 100,
          exercise: { id: 'e-1', name: 'Bench', type: 'push', difficulty: 1, volume_weight: 1 },
          set_logs: [],
        },
      ]),
      setLogsData: Array.from({ length: DONE }, (_, i) => ({
        id: `l-${pad(i)}`, exercise_slot_id: 'sl-1', set_number: i + 1, done: true,
        is_student_added: false, rpe: 8, target_reps: 5, target_weight_kg: 100,
        actual_reps: null, actual_weight_kg: null,
      })),
    });

    expect(data.totalSetsDone).toBe(DONE);
    expect(data.weeklyVolume[0].sets_done).toBe(DONE);
    expect(data.weeklyVolume[0].push).toBe(DONE * 5);
    expect(data.exerciseProgress.byExercise['e-1'][0].tonnage).toBe(DONE * 5 * 100);

    const requests = db.requestsTo('set_logs');
    expect(requests).toHaveLength(2);
    expect(requests[0].order).toEqual({ column: 'id', ascending: true });
    expect(requests[0].limit).toBe(1000);
    expect(requests[0].select).toMatch(/^id, /);
    expect(requests[1].filters).toContainEqual(['gt', 'id', 'l-0999']);
  });

  it('asks for done sets only, and scopes every page to the athlete and the block', async () => {
    const { db } = await run(
      {
        programsData: oneSessionProgram([
          {
            id: 'sl-1', sets: 1001, reps: 5, duration_seconds: null, weight_kg: 100,
            exercise: { id: 'e-1', name: 'Bench', type: 'push', difficulty: 1, volume_weight: 1 },
            set_logs: [],
          },
        ]),
        setLogsData: Array.from({ length: 1001 }, (_, i) => ({
          id: `l-${pad(i)}`, exercise_slot_id: 'sl-1', done: true, target_reps: 5, target_weight_kg: 100,
        })),
      },
      ['st-9', 'active'],
    );

    const requests = db.requestsTo('set_logs');
    expect(requests).toHaveLength(2);
    const scope = 'exercise_slots.sessions.weeks.programs';
    for (const request of requests) {
      // The pending, failed and skipped rows are never downloaded: no figure
      // of this hook is derived from them.
      expect(request.filters).toContainEqual(['eq', 'done', true]);
      expect(request.filters).toContainEqual(['eq', `${scope}.student_id`, 'st-9']);
      expect(request.filters).toContainEqual(['is', `${scope}.deleted_at`, null]);
      expect(request.filters).toContainEqual(['eq', `${scope}.is_active`, true]);
    }
  });

  it('follows every swap of an athlete with more than 1000 of them', async () => {
    const SLOTS = 1001;
    const { data, db } = await run({
      programsData: oneSessionProgram(
        Array.from({ length: SLOTS }, (_, i) => ({
          id: `sl-${pad(i)}`, sets: 1, reps: 5, duration_seconds: null, weight_kg: 100,
          // Prescribed PUSH…
          exercise: { id: 'e-1', name: 'Bench', type: 'push', difficulty: 1, volume_weight: 1 },
          set_logs: [{ set_number: 1, target_reps: 5, target_weight_kg: 100 }],
        })),
      ),
      setLogsData: Array.from({ length: SLOTS }, (_, i) => ({
        id: `l-${pad(i)}`, exercise_slot_id: `sl-${pad(i)}`, set_number: 1, done: true,
        target_reps: 5, target_weight_kg: 100, actual_reps: 5, actual_weight_kg: 60,
      })),
      // …every slot swapped to a PULL movement.
      deviationsData: Array.from({ length: SLOTS }, (_, i) => ({
        id: `d-${pad(i)}`, exercise_slot_id: `sl-${pad(i)}`, kind: 'swap',
        substitute: { id: 'e-2', name: 'Machine Row', type: 'pull', difficulty: 1, volume_weight: 1 },
      })),
    });

    // A swap lost to the cut would leave its set on the prescribed exercise.
    expect(data.weeklyVolume[0].pull).toBe(SLOTS * 5);
    expect(data.weeklyVolume[0].push).toBe(0);
    expect(data.exerciseProgress.byExercise['e-2'][0].tonnage).toBe(SLOTS * 5 * 60);
    expect(data.exerciseProgress.byExercise['e-1'][0].tonnage).toBe(0);

    const requests = db.requestsTo('slot_deviations');
    expect(requests).toHaveLength(2);
    expect(requests[0].select).toMatch(/^id, /);
    expect(requests[1].filters).toContainEqual(['eq', 'kind', 'swap']);
    expect(requests[1].filters).toContainEqual(['gt', 'id', 'd-0999']);
  });

  it('counts every confirmed session past 1000, and still lists the newest five first', async () => {
    const SESSIONS = 1003;
    const day = (i) => new Date(Date.UTC(2020, 0, 1 + i, 12)).toISOString();
    const sessions = Array.from({ length: SESSIONS }, (_, i) => ({
      id: `s-${pad(i)}`, title: `S${i}`, day_number: 1, sort_order: i,
      // Rows from before performed_at existed: the confirmation is their date.
      scheduled_date: null, archived_at: null, performed_at: null, exercise_slots: [],
    }));
    const { data, db } = await run({
      programsData: [
        { id: 'p-1', name: 'A', sort_order: 0, is_active: true, weeks: [{ id: 'w-1', week_number: 1, label: null, sessions }] },
      ],
      // Ids run AGAINST the dates, so id order (how the rows are read) is the
      // reverse of what "recent" means.
      confirmationsData: sessions.map((s, i) => ({
        id: `c-${pad(SESSIONS - 1 - i)}`, session_id: s.id, confirmed_at: day(i), performed_on: null, notes: null,
      })),
    });

    expect(data.totalSessionsConfirmed).toBe(SESSIONS);
    expect(data.backlogSessions).toBe(0);
    expect(data.recentConfirmations.map((c) => c.session_id)).toEqual([
      's-1002', 's-1001', 's-1000', 's-0999', 's-0998',
    ]);

    const requests = db.requestsTo('session_confirmations');
    expect(requests).toHaveLength(2);
    expect(requests[0].order).toEqual({ column: 'id', ascending: true });
    expect(requests[1].filters).toContainEqual(['gt', 'id', 'c-0999']);
    expect(requests[1].filters).toContainEqual(['eq', 'sessions.weeks.programs.student_id', 'st-1']);
  });

  it('reads a short history with one request per list', async () => {
    const { db } = await run({
      programsData: oneSessionProgram([
        {
          id: 'sl-1', sets: 1, reps: 5, duration_seconds: null, weight_kg: 100,
          exercise: { id: 'e-1', name: 'Bench', type: 'push', difficulty: 1, volume_weight: 1 },
          set_logs: [],
        },
      ]),
      setLogsData: [{ id: 'l-1', exercise_slot_id: 'sl-1', done: true, target_reps: 5, target_weight_kg: 100 }],
    });
    expect(db.requestsTo('session_confirmations')).toHaveLength(1);
    expect(db.requestsTo('set_logs')).toHaveLength(1);
    expect(db.requestsTo('slot_deviations')).toHaveLength(1);
  });
});
