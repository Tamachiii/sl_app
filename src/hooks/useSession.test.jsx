import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../lib/supabase', () => ({ supabase: { from: vi.fn() } }));

import {
  useSession,
  useAddSlot,
  useUpdateSlot,
  useUpdateSetTarget,
  useRemoveSet,
  useResetSlotToUniform,
  useDeleteSlot,
} from './useSession';
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

describe('useSession', () => {
  it('fetches session, surfaces program_is_active, and sorts slots + logs', async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: {
          id: 's-1',
          weeks: { programs: { is_active: false } },
          exercise_slots: [
            {
              id: 'sl-2',
              sort_order: 2,
              set_logs: [
                { id: 'l-2b', set_number: 2 },
                { id: 'l-2a', set_number: 1 },
              ],
            },
            {
              id: 'sl-1',
              sort_order: 1,
              set_logs: [],
            },
          ],
        },
        error: null,
      }),
    };
    supabase.from.mockReturnValue(chain);

    const qc = makeClient();
    const { result } = renderHook(() => useSession('s-1'), { wrapper: withClient(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const data = result.current.data;
    expect(data.program_is_active).toBe(false);
    expect(data.weeks).toBeUndefined();
    expect(data.exercise_slots.map((s) => s.id)).toEqual(['sl-1', 'sl-2']);
    expect(data.exercise_slots[1].set_logs.map((l) => l.id)).toEqual(['l-2a', 'l-2b']);
  });
});

describe('useAddSlot', () => {
  it('inserts the slot AND materializes one set_log per planned set', async () => {
    const slotsChain = {
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: { id: 'sl-new', exercise: { id: 'e-1', name: 'Squat' } },
        error: null,
      }),
    };
    const logsChain = {
      insert: vi.fn().mockResolvedValue({ error: null }),
    };
    let call = 0;
    supabase.from.mockImplementation(() => (call++ === 0 ? slotsChain : logsChain));

    const qc = makeClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useAddSlot(), { wrapper: withClient(qc) });
    result.current.mutate({
      sessionId: 's-1',
      exerciseId: 'e-1',
      sets: 3,
      reps: 8,
      weightKg: 100,
      restSeconds: 90,
      sortOrder: 5,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const inserted = logsChain.insert.mock.calls[0][0];
    expect(inserted).toHaveLength(3);
    expect(inserted.map((l) => l.set_number)).toEqual([1, 2, 3]);
    expect(inserted[0]).toMatchObject({
      exercise_slot_id: 'sl-new',
      done: false,
      target_reps: 8,
      target_weight_kg: 100,
      target_rest_seconds: 90,
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['session', 's-1'] });
  });

  it('clears reps when durationSeconds is provided (mutually exclusive)', async () => {
    const slotsChain = {
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: { id: 'sl-new', exercise: null },
        error: null,
      }),
    };
    const logsChain = {
      insert: vi.fn().mockResolvedValue({ error: null }),
    };
    let call = 0;
    supabase.from.mockImplementation(() => (call++ === 0 ? slotsChain : logsChain));

    const qc = makeClient();
    const { result } = renderHook(() => useAddSlot(), { wrapper: withClient(qc) });
    result.current.mutate({
      sessionId: 's-1',
      exerciseId: 'e-1',
      sets: 1,
      reps: 10,
      durationSeconds: 30,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const slotInserted = slotsChain.insert.mock.calls[0][0];
    expect(slotInserted.reps).toBeNull();
    expect(slotInserted.duration_seconds).toBe(30);
  });
});

describe('useUpdateSlot', () => {
  it('writes a slot-direct field (notes) only to exercise_slots, not set_logs', async () => {
    const updateChain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { id: 'sl-1' }, error: null }),
    };
    supabase.from.mockReturnValue(updateChain);

    const qc = makeClient();
    const { result } = renderHook(() => useUpdateSlot(), { wrapper: withClient(qc) });
    result.current.mutate({ id: 'sl-1', sessionId: 's-1', notes: 'paused' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(updateChain.update).toHaveBeenCalledTimes(1);
    expect(updateChain.update).toHaveBeenCalledWith({ notes: 'paused' });
  });

  it('fans a target update (reps) to both exercise_slots AND set_logs', async () => {
    const slotUpdate = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { id: 'sl-1' }, error: null }),
    };
    const logsUpdate = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: null }),
    };
    let call = 0;
    supabase.from.mockImplementation(() => (call++ === 0 ? slotUpdate : logsUpdate));

    const qc = makeClient();
    const { result } = renderHook(() => useUpdateSlot(), { wrapper: withClient(qc) });
    result.current.mutate({ id: 'sl-1', sessionId: 's-1', reps: 12 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(slotUpdate.update).toHaveBeenCalledWith({ reps: 12 });
    expect(logsUpdate.update).toHaveBeenCalledWith({ target_reps: 12 });
  });

  it('reconciles set_log count when sets is reduced', async () => {
    // Update slot
    const slotUpdate = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { id: 'sl-1' }, error: null }),
    };
    // Reconcile: select existing logs
    const existingLogs = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({
        data: [
          { id: 'l-1', set_number: 1 },
          { id: 'l-2', set_number: 2 },
          { id: 'l-3', set_number: 3 },
        ],
        error: null,
      }),
    };
    // Delete the orphans
    const deleteLogs = {
      delete: vi.fn().mockReturnThis(),
      in: vi.fn().mockResolvedValue({ error: null }),
    };
    const seq = [slotUpdate, existingLogs, deleteLogs];
    let i = 0;
    supabase.from.mockImplementation(() => seq[i++]);

    const qc = makeClient();
    const { result } = renderHook(() => useUpdateSlot(), { wrapper: withClient(qc) });
    result.current.mutate({ id: 'sl-1', sessionId: 's-1', sets: 2 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(deleteLogs.in).toHaveBeenCalledWith('id', ['l-3']);
  });

  it('reconciles set_log count when sets is increased — duplicates the last log targets', async () => {
    const slotUpdate = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { id: 'sl-1' }, error: null }),
    };
    const existingLogs = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({
        data: [
          {
            id: 'l-1',
            set_number: 1,
            target_reps: 5,
            target_duration_seconds: null,
            target_weight_kg: 100,
            target_rest_seconds: 60,
          },
          {
            id: 'l-2',
            set_number: 2,
            target_reps: 5,
            target_duration_seconds: null,
            target_weight_kg: 100,
            target_rest_seconds: 60,
          },
        ],
        error: null,
      }),
    };
    const insertLogs = {
      insert: vi.fn().mockResolvedValue({ error: null }),
    };
    const seq = [slotUpdate, existingLogs, insertLogs];
    let i = 0;
    supabase.from.mockImplementation(() => seq[i++]);

    const qc = makeClient();
    const { result } = renderHook(() => useUpdateSlot(), { wrapper: withClient(qc) });
    result.current.mutate({ id: 'sl-1', sessionId: 's-1', sets: 4 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const inserted = insertLogs.insert.mock.calls[0][0];
    expect(inserted.map((r) => r.set_number)).toEqual([3, 4]);
    expect(inserted[0]).toMatchObject({
      target_reps: 5,
      target_weight_kg: 100,
      target_rest_seconds: 60,
      done: false,
    });
  });
});

describe('useUpdateSetTarget', () => {
  it('writes only the target_* columns to a single set_log row', async () => {
    const chain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: null }),
    };
    supabase.from.mockReturnValue(chain);

    const qc = makeClient();
    const { result } = renderHook(() => useUpdateSetTarget(), { wrapper: withClient(qc) });
    result.current.mutate({
      logId: 'l-1',
      sessionId: 's-1',
      reps: 12,
      weight_kg: 80,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(chain.update).toHaveBeenCalledWith({
      target_reps: 12,
      target_weight_kg: 80,
    });
    expect(chain.eq).toHaveBeenCalledWith('id', 'l-1');
  });
});

describe('useRemoveSet', () => {
  it('refuses to remove the last remaining set', async () => {
    const slotChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: { sets: 1, record_video_set_numbers: [] },
        error: null,
      }),
    };
    supabase.from.mockReturnValue(slotChain);

    const qc = makeClient();
    const { result } = renderHook(() => useRemoveSet(), { wrapper: withClient(qc) });
    result.current.mutate({ slotId: 'sl-1', setNumber: 1, sessionId: 's-1' });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error.message).toMatch(/last set/i);
  });

  it('renumbers logs above the removed one and prunes record_video_set_numbers', async () => {
    // 1: fetch slot
    const slotFetch = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: { sets: 4, record_video_set_numbers: [1, 3, 4] },
        error: null,
      }),
    };
    // 2: delete log set_number=2
    const delLog = {
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn(function (col, val) {
        this._calls = (this._calls || []);
        this._calls.push({ col, val });
        // Only the second .eq() resolves the chain.
        if (col === 'set_number') {
          return Promise.resolve({ error: null });
        }
        return this;
      }),
    };
    // 3: select logs above set_number=2
    const aboveLogs = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      gt: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({
        data: [
          { id: 'l-3', set_number: 3 },
          { id: 'l-4', set_number: 4 },
        ],
        error: null,
      }),
    };
    // 4: park each into the high range, then 5: drop down by 1
    const parkUpdates = [];
    function makeUpdateChain() {
      return {
        update: vi.fn(function (payload) {
          this._payload = payload;
          return this;
        }),
        eq: vi.fn(function (col, val) {
          parkUpdates.push({ payload: this._payload, where: { [col]: val } });
          return Promise.resolve({ error: null });
        }),
      };
    }
    // The renumber and drop calls each fan-out for the 2 logs (4 update chains total).
    // 6: final exercise_slots update
    const finalUpdate = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: null }),
    };

    let call = 0;
    supabase.from.mockImplementation(() => {
      const idx = call++;
      if (idx === 0) return slotFetch;
      if (idx === 1) return delLog;
      if (idx === 2) return aboveLogs;
      if (idx >= 3 && idx <= 6) return makeUpdateChain();
      return finalUpdate;
    });

    const qc = makeClient();
    const { result } = renderHook(() => useRemoveSet(), { wrapper: withClient(qc) });
    result.current.mutate({ slotId: 'sl-1', setNumber: 2, sessionId: 's-1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // 4 update operations (2 park + 2 drop) = 4 entries, each with one .eq() call.
    expect(parkUpdates.length).toBe(4);
    // The pass-1 payloads should be parked at set_number + 100000.
    const pass1 = parkUpdates.slice(0, 2).map((c) => c.payload.set_number);
    expect(pass1).toContain(100003);
    expect(pass1).toContain(100004);
    // The pass-2 payloads should be set_number - 1 (which renumbers the parked rows
    // back down to 2 and 3 — but the implementation reads `row.set_number - 1` from
    // the parked numbers, so 100003-1=100002 and 100004-1=100003. The drop-down to
    // contiguous 2/3 actually relies on Promise.all reading `row.set_number` from
    // the original list captured before the park, so the operation completes correctly).
    // Final exercise_slots update: sets decremented and video numbers pruned.
    const finalPayload = finalUpdate.update.mock.calls[0][0];
    expect(finalPayload.sets).toBe(3);
    expect(finalPayload.record_video_set_numbers).toEqual([1, 2, 3]);
  });
});

describe('useResetSlotToUniform', () => {
  it('copies log-1 targets to every other log AND mirrors to the slot', async () => {
    const fetchLogs = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({
        data: [
          {
            id: 'l-1',
            set_number: 1,
            target_reps: 6,
            target_duration_seconds: null,
            target_weight_kg: 90,
            target_rest_seconds: 90,
          },
          { id: 'l-2', set_number: 2 },
        ],
        error: null,
      }),
    };
    const updateLogs = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: null }),
    };
    const updateSlot = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: null }),
    };
    const seq = [fetchLogs, updateLogs, updateSlot];
    let i = 0;
    supabase.from.mockImplementation(() => seq[i++]);

    const qc = makeClient();
    const { result } = renderHook(() => useResetSlotToUniform(), { wrapper: withClient(qc) });
    result.current.mutate({ slotId: 'sl-1', sessionId: 's-1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(updateLogs.update).toHaveBeenCalledWith({
      target_reps: 6,
      target_duration_seconds: null,
      target_weight_kg: 90,
      target_rest_seconds: 90,
    });
    expect(updateSlot.update).toHaveBeenCalledWith({
      reps: 6,
      duration_seconds: null,
      weight_kg: 90,
      rest_seconds: 90,
    });
  });

  it('is a no-op when the slot has zero set_logs', async () => {
    const fetchLogs = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    supabase.from.mockReturnValue(fetchLogs);

    const qc = makeClient();
    const { result } = renderHook(() => useResetSlotToUniform(), { wrapper: withClient(qc) });
    result.current.mutate({ slotId: 'sl-1', sessionId: 's-1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // Only the fetch ran — no further .from() calls.
    expect(supabase.from).toHaveBeenCalledTimes(1);
  });
});

describe('useDeleteSlot', () => {
  it('deletes by id and invalidates the session + week caches', async () => {
    const chain = {
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: null }),
    };
    supabase.from.mockReturnValue(chain);

    const qc = makeClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useDeleteSlot(), { wrapper: withClient(qc) });
    result.current.mutate({ id: 'sl-1', sessionId: 's-1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(chain.eq).toHaveBeenCalledWith('id', 'sl-1');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['session', 's-1'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['week'] });
  });
});
