import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../lib/supabase', () => ({ supabase: { from: vi.fn() } }));
vi.mock('./useAuth', () => ({ useAuth: vi.fn() }));

import { useStudentHistoricalSessions } from './useStudentHistoricalSessions';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';
import { fakePostgrest } from '../test/fakePostgrest';
import { inTimeZone, ZONES } from '../test/inTimeZone';

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

// The three tables the hook reads, served by name; every response is cut at
// 1000 rows, as PostgREST cuts it.
function wire({ programs = [], confirmations = [] }) {
  const db = fakePostgrest({
    students: [{ id: 'st-1' }],
    programs,
    session_confirmations: confirmations,
  });
  supabase.from.mockImplementation(db.from);
  return db;
}

async function historical() {
  const { result } = renderHook(() => useStudentHistoricalSessions(), {
    wrapper: withClient(makeClient()),
  });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  return result.current.data;
}

describe('useStudentHistoricalSessions', () => {
  it('queries non-active programs and tags sessions historical:true', async () => {
    const db = wire({
      programs: [
        {
          id: 'p-old',
          weeks: [
            {
              sessions: [
                { id: 's-1', title: 'Squat day', scheduled_date: '2026-03-12', archived_at: null },
                { id: 's-2', title: 'Skipped', scheduled_date: null, archived_at: null },
              ],
            },
          ],
        },
      ],
      confirmations: [{ session_id: 's-1' }],
    });

    // Only s-1 has scheduled_date.
    expect(await historical()).toEqual([
      {
        session_id: 's-1',
        title: 'Squat day',
        date: '2026-03-12',
        completed: true,
        historical: true,
      },
    ]);
    // Verifies is_active=false was the filter.
    expect(db.requestsTo('programs')[0].filters).toContainEqual(['eq', 'is_active', false]);
    // Confirmations are filtered through the program join (student_id +
    // is_active=false + not-trashed), not an .in(sessionIds) list.
    expect(db.requestsTo('session_confirmations')[0].filters).toEqual([
      ['eq', 'sessions.weeks.programs.student_id', 'st-1'],
      ['eq', 'sessions.weeks.programs.is_active', false],
      ['is', 'sessions.weeks.programs.deleted_at', null],
    ]);
  });

  it('marks every finished session of the past blocks, beyond the first 1000', async () => {
    // 251 past weeks of four sessions, all of them trained.
    const SESSIONS = 1004;
    const pad = (i) => String(i).padStart(5, '0');
    const db = wire({
      programs: [
        {
          id: 'p-old',
          weeks: Array.from({ length: SESSIONS / 4 }, (_, w) => ({
            sessions: [0, 1, 2, 3].map((d) => ({
              id: `s-${pad(w * 4 + d)}`, title: `W${w} D${d}`, scheduled_date: '2024-05-06', archived_at: null,
            })),
          })),
        },
      ],
      confirmations: Array.from({ length: SESSIONS }, (_, i) => ({ session_id: `s-${pad(i)}` })),
    });

    const data = await historical();
    expect(data).toHaveLength(SESSIONS);
    expect(data.filter((s) => s.completed)).toHaveLength(SESSIONS);

    const requests = db.requestsTo('session_confirmations');
    expect(requests).toHaveLength(2);
    expect(requests[0].order).toEqual({ column: 'session_id', ascending: true });
    expect(requests[0].limit).toBe(1000);
    expect(requests[1].filters).toContainEqual(['gt', 'session_id', 's-00999']);
    expect(requests[1].filters).toContainEqual(['eq', 'sessions.weeks.programs.is_active', false]);
  });

  // The athlete's `students.id` is one cache entry for the whole Stats page
  // (`myStudentIdQueryOptions`), not a request of each query that needs it.
  it('reads the athlete row once, and leaves the id in the shared cache entry', async () => {
    const db = wire({});
    const qc = makeClient();
    const { result } = renderHook(() => useStudentHistoricalSessions(), { wrapper: withClient(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(db.requestsTo('students')).toHaveLength(1);
    expect(db.requestsTo('students')[0].filters).toEqual([['eq', 'profile_id', 'u-1']]);
    expect(qc.getQueryData(['my-student-id', 'u-1'])).toBe('st-1');
  });

  // The overlay is drawn in one scope of the Stats page only; in the others
  // the page holds the read back.
  it('sends nothing while it is held back, and reads once it is asked for', async () => {
    const db = wire({});
    const { result, rerender } = renderHook(
      ({ enabled }) => useStudentHistoricalSessions({ enabled }),
      { wrapper: withClient(makeClient()), initialProps: { enabled: false } },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current.fetchStatus).toBe('idle');
    expect(db.requests).toHaveLength(0);

    rerender({ enabled: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(db.requests.map((r) => r.table)).toEqual(['students', 'programs']);
  });

  it('stays off without a user, whatever the caller passes', async () => {
    useAuth.mockReturnValue({ user: null });
    const db = wire({});
    const { result } = renderHook(() => useStudentHistoricalSessions({ enabled: true }), {
      wrapper: withClient(makeClient()),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current.fetchStatus).toBe('idle');
    expect(db.requests).toHaveLength(0);
  });

  it('sends no students request when the id is already in the cache', async () => {
    const db = wire({});
    const qc = makeClient();
    qc.setQueryData(['my-student-id', 'u-1'], 'st-cached');
    const { result } = renderHook(() => useStudentHistoricalSessions(), { wrapper: withClient(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(db.requestsTo('students')).toHaveLength(0);
    expect(db.requestsTo('programs')[0].filters).toContainEqual(['eq', 'student_id', 'st-cached']);
  });
});

// `performed_at` is the confirmation's `performed_on` stored as midnight UTC.
// Read as an instant it is the evening before west of Greenwich, and a past
// block's Monday session sat on Sunday of the calendar.
describe('useStudentHistoricalSessions — the day trained, in every time zone', () => {
  it.each(ZONES)('%s: dates a session by the day performed_at holds, before its plan date', (zone) =>
    inTimeZone(zone, async () => {
      wire({
        programs: [
          {
            id: 'p-old',
            weeks: [
              {
                sessions: [
                  // Planned for Thursday, trained on Monday.
                  {
                    id: 's-1', title: 'Moved', scheduled_date: '2026-09-24', archived_at: null,
                    performed_at: '2026-09-28T00:00:00+00:00',
                  },
                  // No plan date at all.
                  { id: 's-2', title: 'Undated', scheduled_date: null, archived_at: null, performed_at: '2026-09-29T00:00:00+00:00' },
                  { id: 's-3', title: 'Open', scheduled_date: '2026-09-30', archived_at: null, performed_at: null },
                ],
              },
            ],
          },
        ],
        confirmations: [{ session_id: 's-1' }, { session_id: 's-2' }],
      });

      expect((await historical()).map((s) => [s.session_id, s.date, s.completed])).toEqual([
        ['s-1', '2026-09-28', true],
        ['s-2', '2026-09-29', true],
        ['s-3', '2026-09-30', false],
      ]);
    }));
});
