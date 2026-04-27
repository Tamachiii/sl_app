import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../lib/supabase', () => ({ supabase: { from: vi.fn() } }));

import { useDuplicateWeek, useDuplicateSession } from './useDuplicate';
import { supabase } from '../lib/supabase';

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
});

/**
 * Tiny supabase chain factory: returns an object whose terminal call (single,
 * order, insert, etc.) resolves with the given value, and remembers the
 * arguments passed at each step.
 */
function chain(spec) {
  const c = {};
  const calls = [];
  for (const k of ['select', 'eq', 'in', 'order', 'limit']) {
    c[k] = vi.fn(function (...args) {
      calls.push({ method: k, args });
      return this;
    });
  }
  c.insert = vi.fn(function (rows) {
    calls.push({ method: 'insert', args: [rows] });
    return spec.insertChain || this;
  });
  c.single = vi.fn().mockResolvedValue(spec.single);
  if (spec.terminal) {
    // .order / .limit / .insert().select() may resolve.
    Object.assign(c, spec.terminal);
  }
  c._calls = calls;
  return c;
}

describe('useDuplicateWeek', () => {
  it('copies a week with sessions, slots, and set_log targets', async () => {
    // Phase 1: fetch source week
    const srcWeek = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: { id: 'w-src', program_id: 'p-1', label: 'Hyp' },
        error: null,
      }),
    };
    // Phase 2: pick max(week_number) in destination program
    const maxWeek = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({
        data: [{ week_number: 4 }],
        error: null,
      }),
    };
    // Phase 3: insert new week
    const newWeek = {
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: { id: 'w-new', week_number: 5 },
        error: null,
      }),
    };
    // Phase 4: fetch source sessions with slots
    const srcSessions = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({
        data: [
          {
            id: 'ss-1',
            day_number: 1,
            title: 'Push',
            sort_order: 0,
            exercise_slots: [
              {
                id: 'sl-1',
                exercise_id: 'e-1',
                sets: 3,
                reps: 8,
                weight_kg: 100,
                sort_order: 0,
                notes: 'top set',
                duration_seconds: null,
                superset_group: null,
                rest_seconds: 90,
              },
            ],
          },
        ],
        error: null,
      }),
    };
    // Phase 5: insert new sessions
    const newSessions = {
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue({
        data: [{ id: 'ss-1-new', sort_order: 0 }],
        error: null,
      }),
    };
    // Phase 6: insert new slots
    const newSlots = {
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue({
        data: [{ id: 'sl-1-new', sort_order: 0 }],
        error: null,
      }),
    };
    // Phase 7: copySetLogTargets — fetch source set_logs
    const srcLogs = {
      select: vi.fn().mockReturnThis(),
      in: vi.fn().mockResolvedValue({
        data: [
          {
            exercise_slot_id: 'sl-1',
            set_number: 1,
            target_reps: 8,
            target_duration_seconds: null,
            target_weight_kg: 100,
            target_rest_seconds: 90,
          },
        ],
        error: null,
      }),
    };
    // Phase 8: insert new set_logs
    const newLogs = {
      insert: vi.fn().mockResolvedValue({ error: null }),
    };

    const sequence = [srcWeek, maxWeek, newWeek, srcSessions, newSessions, newSlots, srcLogs, newLogs];
    let i = 0;
    supabase.from.mockImplementation(() => sequence[i++]);

    const qc = makeClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useDuplicateWeek(), { wrapper: withClient(qc) });

    result.current.mutate({ weekId: 'w-src' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // New week labelled "Hyp (copy)" inserted into source program at week 5.
    expect(newWeek.insert).toHaveBeenCalledWith({
      program_id: 'p-1',
      week_number: 5,
      label: 'Hyp (copy)',
    });
    // Sessions copied with the same day_number/title/sort_order.
    expect(newSessions.insert.mock.calls[0][0]).toEqual([
      { week_id: 'w-new', day_number: 1, title: 'Push', sort_order: 0 },
    ]);
    // Slots copied with their notes/superset/etc preserved.
    expect(newSlots.insert.mock.calls[0][0][0]).toMatchObject({
      session_id: 'ss-1-new',
      exercise_id: 'e-1',
      sets: 3,
      reps: 8,
      weight_kg: 100,
      notes: 'top set',
      rest_seconds: 90,
    });
    // copySetLogTargets sets done=false and only target_* fields.
    const insertedLogs = newLogs.insert.mock.calls[0][0];
    expect(insertedLogs[0].exercise_slot_id).toBe('sl-1-new');
    expect(insertedLogs[0].done).toBe(false);
    expect(insertedLogs[0].target_reps).toBe(8);
    expect(insertedLogs[0]).not.toHaveProperty('rpe');

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['program'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['set-logs'] });
  });

  it('uses the explicit programId + newWeekNumber when both are provided', async () => {
    const srcWeek = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: { id: 'w-src', program_id: 'p-1', label: null },
        error: null,
      }),
    };
    const newWeek = {
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: { id: 'w-new', week_number: 7 },
        error: null,
      }),
    };
    const emptySessions = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    const sequence = [srcWeek, newWeek, emptySessions];
    let i = 0;
    supabase.from.mockImplementation(() => sequence[i++]);

    const qc = makeClient();
    const { result } = renderHook(() => useDuplicateWeek(), { wrapper: withClient(qc) });
    result.current.mutate({ weekId: 'w-src', programId: 'p-2', newWeekNumber: 7 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // Did not query max(week_number) because newWeekNumber was supplied.
    expect(newWeek.insert).toHaveBeenCalledWith({
      program_id: 'p-2',
      week_number: 7,
      label: null, // null label stays null (no "(copy)" suffix when null)
    });
  });

  it('returns early when source week has zero sessions', async () => {
    const srcWeek = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: { id: 'w-src', program_id: 'p-1', label: 'Empty' },
        error: null,
      }),
    };
    const maxWeek = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    const newWeek = {
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: { id: 'w-new', week_number: 1 },
        error: null,
      }),
    };
    const noSessions = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    const sequence = [srcWeek, maxWeek, newWeek, noSessions];
    let i = 0;
    supabase.from.mockImplementation(() => sequence[i++]);

    const qc = makeClient();
    const { result } = renderHook(() => useDuplicateWeek(), { wrapper: withClient(qc) });
    result.current.mutate({ weekId: 'w-src' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // Only 4 chains used → no inserts past the new week itself.
    expect(i).toBe(4);
  });
});

describe('useDuplicateSession', () => {
  it('copies a session and its slots with "(copy)" title', async () => {
    const srcSession = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: {
          id: 'ss-1',
          week_id: 'w-1',
          day_number: 2,
          title: 'Pull',
          sort_order: 1,
          exercise_slots: [
            {
              id: 'sl-1',
              exercise_id: 'e-1',
              sets: 4,
              reps: 5,
              weight_kg: 60,
              sort_order: 0,
              notes: null,
              duration_seconds: null,
              superset_group: 'A',
              rest_seconds: 120,
            },
          ],
        },
        error: null,
      }),
    };
    const newSession = {
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: { id: 'ss-new' },
        error: null,
      }),
    };
    const newSlots = {
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue({
        data: [{ id: 'sl-new', sort_order: 0 }],
        error: null,
      }),
    };
    const srcLogs = {
      select: vi.fn().mockReturnThis(),
      in: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    const sequence = [srcSession, newSession, newSlots, srcLogs];
    let i = 0;
    supabase.from.mockImplementation(() => sequence[i++]);

    const qc = makeClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useDuplicateSession(), { wrapper: withClient(qc) });
    result.current.mutate({ sessionId: 'ss-1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(newSession.insert).toHaveBeenCalledWith({
      week_id: 'w-1',
      day_number: 2,
      title: 'Pull (copy)',
      sort_order: 2,
    });
    expect(newSlots.insert.mock.calls[0][0][0]).toMatchObject({
      session_id: 'ss-new',
      exercise_id: 'e-1',
      superset_group: 'A',
      rest_seconds: 120,
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['session'] });
  });

  it('falls back to "Session (copy)" when title is null', async () => {
    const srcSession = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: {
          id: 'ss-1',
          week_id: 'w-1',
          day_number: 1,
          title: null,
          sort_order: 0,
          exercise_slots: [],
        },
        error: null,
      }),
    };
    const newSession = {
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: { id: 'ss-new' },
        error: null,
      }),
    };
    const sequence = [srcSession, newSession];
    let i = 0;
    supabase.from.mockImplementation(() => sequence[i++]);

    const qc = makeClient();
    const { result } = renderHook(() => useDuplicateSession(), { wrapper: withClient(qc) });
    result.current.mutate({ sessionId: 'ss-1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(newSession.insert).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Session (copy)' }),
    );
  });
});
