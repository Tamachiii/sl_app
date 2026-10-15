import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../lib/supabase', () => ({ supabase: { from: vi.fn() } }));

import {
  sessionQueryOptions,
  useSession,
  useAddSlot,
  useUpdateSlot,
  useUpdateSetTarget,
  useRemoveSet,
  useResetSlotToUniform,
  useDeleteSlot,
  useMarkSessionReviewed,
  useProgramLoggedSessionIds,
} from './useSession';
import { supabase } from '../lib/supabase';
import { mutationErrorKey } from '../lib/mutationErrors';

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

// Hand supabase.from() its chains in call order.
function sequence(...chains) {
  let i = 0;
  supabase.from.mockImplementation(() => chains[i++]);
}

// The "every set_logs row of this slot" read the delete paths start with.
function logsRead(rows) {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockResolvedValue({ data: rows, error: null }),
  };
}

function slotUpdateChain() {
  return {
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: { id: 'sl-1' }, error: null }),
  };
}

// An UPDATE on set_logs narrowed to pending rows: .eq()/.is() all chain, and
// awaiting the (non-thenable) chain resolves to it, `error` undefined.
function pendingUpdateChain() {
  return {
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
  };
}

// The six filters that keep a write off a set the athlete has logged.
function expectPendingOnly(chain) {
  expect(chain.eq).toHaveBeenCalledWith('done', false);
  expect(chain.eq).toHaveBeenCalledWith('failed', false);
  expect(chain.eq).toHaveBeenCalledWith('skipped', false);
  expect(chain.is).toHaveBeenCalledWith('rpe', null);
  expect(chain.is).toHaveBeenCalledWith('actual_reps', null);
  expect(chain.is).toHaveBeenCalledWith('actual_weight_kg', null);
}

const pending = (id, n, extra = {}) => ({
  id,
  set_number: n,
  is_student_added: false,
  done: false,
  failed: false,
  skipped: false,
  rpe: null,
  actual_reps: null,
  actual_weight_kg: null,
  set_log_videos: null,
  ...extra,
});

describe('useSession', () => {
  it('fetches session, surfaces program_is_active, and sorts slots + logs', async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          id: 's-1',
          weeks: { program_id: 'p-9', programs: { is_active: false } },
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
    // The block the session is in: the editor goes back to it.
    expect(data.program_id).toBe('p-9');
    expect(chain.select.mock.calls[0][0]).toMatch(/weeks!inner\(program_id, programs!inner\(is_active/);
    expect(data.weeks).toBeUndefined();
    expect(data.exercise_slots.map((s) => s.id)).toEqual(['sl-1', 'sl-2']);
    expect(data.exercise_slots[1].set_logs.map((l) => l.id)).toEqual(['l-2a', 'l-2b']);
  });

  // A session that was deleted, or that this account may not read, is an
  // answer: the pages say "not found" for it. `single` made it an error
  // (PGRST116) they could only offer to retry.
  it('answers null for a session that is not there', async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
    supabase.from.mockReturnValue(chain);

    const qc = makeClient();
    const { result } = renderHook(() => useSession('gone'), { wrapper: withClient(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
    expect(chain.eq).toHaveBeenCalledWith('id', 'gone');
  });

  it('still fails on an error', async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { message: 'boom' } }),
    };
    supabase.from.mockReturnValue(chain);

    const qc = makeClient();
    const { result } = renderHook(() => useSession('s-1'), { wrapper: withClient(qc) });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  // The editor locks a set from these flags, so a column missing here is a
  // logged set rendered as editable. `weight_kg` is the dead pre-target column:
  // nothing reads it from this projection.
  it('selects the logged flags of every set, and not the dead weight_kg column', async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { id: 's-1', weeks: { programs: { is_active: true } }, exercise_slots: [] },
        error: null,
      }),
    };
    supabase.from.mockReturnValue(chain);

    const qc = makeClient();
    const { result } = renderHook(() => useSession('s-1'), { wrapper: withClient(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const embed = chain.select.mock.calls[0][0].match(/set_logs\(([^)]*)\)/)[1];
    const columns = embed.split(',').map((c) => c.trim());
    for (const col of ['done', 'failed', 'skipped', 'rpe', 'actual_reps', 'actual_weight_kg']) {
      expect(columns).toContain(col);
    }
    expect(columns).not.toContain('weight_kg');
  });
});

// The athlete's training list reads the next session ahead through these very
// options (`queryClient.fetchQuery`), so that the session page finds it in the
// cache. That only works while the hook and the options are one read.
describe('sessionQueryOptions', () => {
  const sessionRead = () => ({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({
      data: {
        id: 's-1',
        weeks: { programs: { is_active: true } },
        exercise_slots: [
          { id: 'sl-2', sort_order: 2, set_logs: [] },
          { id: 'sl-1', sort_order: 1, set_logs: [] },
        ],
      },
      error: null,
    }),
  });

  it('is the read useSession mounts: what was fetched through it, the hook shows without asking', async () => {
    supabase.from.mockReturnValue(sessionRead());
    // Trusted for a while, as on the app's client.
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: 60_000 } },
    });

    const ahead = await qc.fetchQuery(sessionQueryOptions('s-1'));
    expect(ahead.program_is_active).toBe(true);
    expect(ahead.exercise_slots.map((sl) => sl.id)).toEqual(['sl-1', 'sl-2']);
    expect(supabase.from).toHaveBeenCalledTimes(1);

    const { result } = renderHook(() => useSession('s-1'), { wrapper: withClient(qc) });
    expect(result.current.data).toBe(ahead);
    expect(result.current.isLoading).toBe(false);
    expect(supabase.from).toHaveBeenCalledTimes(1);
  });

  // How long a session is trusted and kept is decided per root on the client
  // (lib/queryClient.js). An option given here would replace that decision —
  // for the hook and for whoever reads ahead.
  it('says what to read and nothing about how long to trust or keep it', () => {
    const options = sessionQueryOptions('s-1');
    expect(options.queryKey).toEqual(['session', 's-1']);
    expect(Object.keys(options).sort()).toEqual(['enabled', 'queryFn', 'queryKey']);
    expect(options.enabled).toBe(true);
    expect(sessionQueryOptions(undefined).enabled).toBe(false);
  });
});

describe('useProgramLoggedSessionIds', () => {
  function chainReturning(rows) {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      or: vi.fn().mockResolvedValue({ data: rows, error: null }),
    };
    supabase.from.mockReturnValue(chain);
    return chain;
  }

  it('returns, as a Set, each session of the program that holds a logged set — once', async () => {
    chainReturning([
      { exercise_slots: { session_id: 'sess-2' } },
      { exercise_slots: { session_id: 'sess-2' } },
      { exercise_slots: { session_id: 'sess-5' } },
    ]);

    const qc = makeClient();
    const { result } = renderHook(() => useProgramLoggedSessionIds('prog-1'), { wrapper: withClient(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toBeInstanceOf(Set);
    expect([...result.current.data]).toEqual(['sess-2', 'sess-5']);
    // What is CACHED is a plain array: a Set dehydrates to {}.
    expect(qc.getQueryData(['program-logged-session-ids', 'prog-1'])).toEqual(['sess-2', 'sess-5']);
  });

  it('filters through the joins: this program, logged rows, unconfirmed and unarchived sessions', async () => {
    const chain = chainReturning([]);

    const qc = makeClient();
    const { result } = renderHook(() => useProgramLoggedSessionIds('prog-1'), { wrapper: withClient(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(supabase.from).toHaveBeenCalledWith('set_logs');
    expect(chain.eq).toHaveBeenCalledWith('exercise_slots.sessions.weeks.program_id', 'prog-1');
    // Confirmed sessions hold nearly every logged set of a block and the sheet
    // already knows them: leaving them out is what keeps this read small.
    expect(chain.is).toHaveBeenCalledWith('exercise_slots.sessions.performed_at', null);
    expect(chain.is).toHaveBeenCalledWith('exercise_slots.sessions.archived_at', null);
    const or = chain.or.mock.calls[0][0];
    for (const col of ['done', 'failed', 'skipped', 'rpe', 'actual_reps', 'actual_weight_kg']) {
      expect(or).toContain(`${col}.`);
    }
    // Every embed on the path is an inner join, or the filters above would
    // only blank the embedded object instead of dropping the row.
    expect(chain.select.mock.calls[0][0].match(/!inner/g)).toHaveLength(3);
  });

  it('does not run without a program id', () => {
    const qc = makeClient();
    const { result } = renderHook(() => useProgramLoggedSessionIds(undefined), { wrapper: withClient(qc) });
    expect(result.current.fetchStatus).toBe('idle');
    expect(supabase.from).not.toHaveBeenCalled();
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
    const updateChain = slotUpdateChain();
    supabase.from.mockReturnValue(updateChain);

    const qc = makeClient();
    const { result } = renderHook(() => useUpdateSlot(), { wrapper: withClient(qc) });
    result.current.mutate({ id: 'sl-1', sessionId: 's-1', notes: 'paused' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(updateChain.update).toHaveBeenCalledTimes(1);
    expect(updateChain.update).toHaveBeenCalledWith({ notes: 'paused' });
  });

  it('fans a target update (reps) to exercise_slots AND to the PENDING set_logs only', async () => {
    const slotUpdate = slotUpdateChain();
    const logsUpdate = pendingUpdateChain();
    sequence(slotUpdate, logsUpdate);

    const qc = makeClient();
    const { result } = renderHook(() => useUpdateSlot(), { wrapper: withClient(qc) });
    result.current.mutate({ id: 'sl-1', sessionId: 's-1', reps: 12 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(slotUpdate.update).toHaveBeenCalledWith({ reps: 12 });
    expect(logsUpdate.update).toHaveBeenCalledWith({ target_reps: 12 });
    expect(logsUpdate.eq).toHaveBeenCalledWith('exercise_slot_id', 'sl-1');
    expect(logsUpdate.eq).toHaveBeenCalledWith('is_student_added', false);
    // A logged set's target is what the athlete was asked to do when they did
    // it — and what every stat falls back to. It is never part of the fan-out.
    expectPendingOnly(logsUpdate);
  });

  it('reconciles set_log count when sets is reduced', async () => {
    const rows = [pending('l-1', 1), pending('l-2', 2), pending('l-3', 3)];
    const precheck = logsRead(rows);
    const slotUpdate = slotUpdateChain();
    const existingLogs = logsRead(rows);
    const deleteLogs = {
      delete: vi.fn().mockReturnThis(),
      in: vi.fn().mockResolvedValue({ error: null }),
    };
    sequence(precheck, slotUpdate, existingLogs, deleteLogs);

    const qc = makeClient();
    const { result } = renderHook(() => useUpdateSlot(), { wrapper: withClient(qc) });
    result.current.mutate({ id: 'sl-1', sessionId: 's-1', sets: 2 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(deleteLogs.in).toHaveBeenCalledWith('id', ['l-3']);
  });

  // The whole point of the pre-read: `sets` is written BEFORE the rows are
  // deleted, so a refusal that came after it would leave "3 sets" over 5 rows.
  it('refuses to lower sets over a logged set — before writing anything', async () => {
    const precheck = logsRead([
      pending('l-1', 1, { done: true }),
      pending('l-2', 2, { done: true }),
      pending('l-3', 3),
      pending('l-4', 4, { done: true, rpe: 8 }),
      pending('l-5', 5),
    ]);
    sequence(precheck);

    const qc = makeClient();
    const { result } = renderHook(() => useUpdateSlot(), { wrapper: withClient(qc) });
    result.current.mutate({ id: 'sl-1', sessionId: 's-1', sets: 3 });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(mutationErrorKey(result.current.error)).toBe('errors.hasLoggedTraining');
    // One call, and it was the read: no slot update, no delete.
    expect(supabase.from).toHaveBeenCalledTimes(1);
    expect(supabase.from).toHaveBeenCalledWith('set_logs');
    expect(precheck.select.mock.calls[0][0]).toContain('actual_weight_kg');
  });

  it.each([
    ['failed', { failed: true }],
    ['skipped', { skipped: true }],
    ['rated but not ticked', { rpe: 7 }],
    ['logged off-plan reps', { actual_reps: 4 }],
    ['logged off-plan weight', { actual_weight_kg: 60 }],
    ['filmed but not ticked', { set_log_videos: { id: 'v-1' } }],
  ])('refuses to lower sets over a set that is %s', async (_label, patch) => {
    sequence(logsRead([pending('l-1', 1), pending('l-2', 2, patch)]));

    const qc = makeClient();
    const { result } = renderHook(() => useUpdateSlot(), { wrapper: withClient(qc) });
    result.current.mutate({ id: 'sl-1', sessionId: 's-1', sets: 1 });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mutationErrorKey(result.current.error)).toBe('errors.hasLoggedTraining');
    expect(supabase.from).toHaveBeenCalledTimes(1);
  });

  // Logged sets BELOW the new count are not touched by the decrease, so they
  // must not block it: 2 done + 2 pending, down to 2, is ordinary tidying.
  it('still lowers sets when every logged set survives the new count', async () => {
    const rows = [
      pending('l-1', 1, { done: true, rpe: 8 }),
      pending('l-2', 2, { done: true }),
      pending('l-3', 3),
      pending('l-4', 4),
    ];
    const deleteLogs = {
      delete: vi.fn().mockReturnThis(),
      in: vi.fn().mockResolvedValue({ error: null }),
    };
    sequence(logsRead(rows), slotUpdateChain(), logsRead(rows), deleteLogs);

    const qc = makeClient();
    const { result } = renderHook(() => useUpdateSlot(), { wrapper: withClient(qc) });
    result.current.mutate({ id: 'sl-1', sessionId: 's-1', sets: 2 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(deleteLogs.in).toHaveBeenCalledWith('id', ['l-3', 'l-4']);
  });

  // The athlete can tick a set between the pre-read and the delete. The rows
  // are read again right before the delete, and that read wins.
  it('re-checks on the fresh rows and never deletes a set logged in between', async () => {
    const deleteLogs = {
      delete: vi.fn().mockReturnThis(),
      in: vi.fn().mockResolvedValue({ error: null }),
    };
    sequence(
      logsRead([pending('l-1', 1), pending('l-2', 2)]),
      slotUpdateChain(),
      logsRead([pending('l-1', 1), pending('l-2', 2, { done: true })]),
      deleteLogs,
    );

    const qc = makeClient();
    const { result } = renderHook(() => useUpdateSlot(), { wrapper: withClient(qc) });
    result.current.mutate({ id: 'sl-1', sessionId: 's-1', sets: 1 });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mutationErrorKey(result.current.error)).toBe('errors.hasLoggedTraining');
    expect(deleteLogs.delete).not.toHaveBeenCalled();
  });

  it('reconciles set_log count when sets is increased — duplicates the last log targets', async () => {
    const rows = [
      pending('l-1', 1, { target_reps: 5, target_duration_seconds: null, target_weight_kg: 100, target_rest_seconds: 60 }),
      pending('l-2', 2, { target_reps: 5, target_duration_seconds: null, target_weight_kg: 100, target_rest_seconds: 60 }),
    ];
    const insertLogs = {
      insert: vi.fn().mockResolvedValue({ error: null }),
    };
    sequence(logsRead(rows), slotUpdateChain(), logsRead(rows), insertLogs);

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

  // Adding a set to an exercise the athlete has already started is the
  // everyday case the lock must not get in the way of.
  it('adds a set after logged ones without touching them', async () => {
    const rows = [
      pending('l-1', 1, { done: true, target_reps: 5, target_weight_kg: 100 }),
      pending('l-2', 2, { done: true, target_reps: 5, target_weight_kg: 100 }),
    ];
    const insertLogs = { insert: vi.fn().mockResolvedValue({ error: null }) };
    sequence(logsRead(rows), slotUpdateChain(), logsRead(rows), insertLogs);

    const qc = makeClient();
    const { result } = renderHook(() => useUpdateSlot(), { wrapper: withClient(qc) });
    result.current.mutate({ id: 'sl-1', sessionId: 's-1', sets: 3 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const inserted = insertLogs.insert.mock.calls[0][0];
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ set_number: 3, done: false, target_reps: 5, target_weight_kg: 100 });
  });

  it('reduce never deletes student-added extra sets (they are not prescription)', async () => {
    const rows = [
      pending('l-1', 1),
      pending('l-2', 2),
      pending('l-3', 3),
      // The student's logged extra set sits at the top of the shared
      // set_number space — it must survive a coach sets-decrease, and being
      // logged it must not block one either: it is not among the rows dropped.
      pending('l-extra', 4, { is_student_added: true, done: true }),
    ];
    const deleteLogs = {
      delete: vi.fn().mockReturnThis(),
      in: vi.fn().mockResolvedValue({ error: null }),
    };
    // After the delete, the surviving extra is re-homed to close the gap
    // (park then place) so it doesn't render as "Set 4" on a 2-set slot.
    const parkChain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: null }),
    };
    const placeChain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: null }),
    };
    sequence(logsRead(rows), slotUpdateChain(), logsRead(rows), deleteLogs, parkChain, placeChain);

    const qc = makeClient();
    const { result } = renderHook(() => useUpdateSlot(), { wrapper: withClient(qc) });
    result.current.mutate({ id: 'sl-1', sessionId: 's-1', sets: 2 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(deleteLogs.in).toHaveBeenCalledWith('id', ['l-3']);
    expect(parkChain.update).toHaveBeenCalledWith({ set_number: 100004 });
    expect(placeChain.update).toHaveBeenCalledWith({ set_number: 3 });
    expect(placeChain.eq).toHaveBeenCalledWith('id', 'l-extra');
  });

  it('increase parks student-added sets, inserts from the last PRESCRIBED template, and re-homes the extras', async () => {
    const rows = [
      pending('l-1', 1, { target_reps: 5, target_duration_seconds: null, target_weight_kg: 100, target_rest_seconds: 60 }),
      pending('l-2', 2, { target_reps: 5, target_duration_seconds: null, target_weight_kg: 100, target_rest_seconds: 60 }),
      // NULL-target student extra at set 3 — before the fix, an increase
      // to 3 no-oped (count matched) or templated NULL targets from it.
      pending('l-extra', 3, { is_student_added: true, target_reps: null, target_duration_seconds: null, target_weight_kg: null, target_rest_seconds: null }),
    ];
    const parkChain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: null }),
    };
    const insertLogs = {
      insert: vi.fn().mockResolvedValue({ error: null }),
    };
    const placeChain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: null }),
    };
    sequence(logsRead(rows), slotUpdateChain(), logsRead(rows), parkChain, insertLogs, placeChain);

    const qc = makeClient();
    const { result } = renderHook(() => useUpdateSlot(), { wrapper: withClient(qc) });
    result.current.mutate({ id: 'sl-1', sessionId: 's-1', sets: 3 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // Extra parked out of the way…
    expect(parkChain.update).toHaveBeenCalledWith({ set_number: 100003 });
    expect(parkChain.eq).toHaveBeenCalledWith('id', 'l-extra');
    // …the new prescribed row templates from the last PRESCRIBED log…
    const inserted = insertLogs.insert.mock.calls[0][0];
    expect(inserted.map((r) => r.set_number)).toEqual([3]);
    expect(inserted[0]).toMatchObject({ target_reps: 5, target_weight_kg: 100 });
    // …and the extra lands contiguously after the new prescription.
    expect(placeChain.update).toHaveBeenCalledWith({ set_number: 4 });
    expect(placeChain.eq).toHaveBeenCalledWith('id', 'l-extra');
  });
});

describe('useUpdateSetTarget', () => {
  it('writes only the target_* columns to a single set_log row — and only while it is pending', async () => {
    const chain = pendingUpdateChain();
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
    // The editor shows a logged set read-only; this is what holds when the
    // athlete logs it after the editor loaded.
    expectPendingOnly(chain);
  });
});

describe('useRemoveSet', () => {
  const slotRead = (slot) => ({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: slot, error: null }),
  });

  it('refuses to remove the last remaining set', async () => {
    supabase.from.mockReturnValue(slotRead({ sets: 1, record_video_set_numbers: [] }));

    const qc = makeClient();
    const { result } = renderHook(() => useRemoveSet(), { wrapper: withClient(qc) });
    result.current.mutate({ slotId: 'sl-1', setNumber: 1, sessionId: 's-1' });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error.message).toMatch(/last set/i);
  });

  it.each([
    ['done', { done: true }],
    ['failed', { failed: true }],
    ['skipped', { skipped: true }],
    ['filmed', { set_log_videos: [{ id: 'v-1' }] }],
  ])('refuses to remove a %s set, and deletes nothing', async (_label, patch) => {
    const delLog = { delete: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
    sequence(
      slotRead({ sets: 3, record_video_set_numbers: [] }),
      logsRead([pending('l-1', 1), pending('l-2', 2, patch), pending('l-3', 3)]),
      delLog,
    );

    const qc = makeClient();
    const { result } = renderHook(() => useRemoveSet(), { wrapper: withClient(qc) });
    result.current.mutate({ slotId: 'sl-1', setNumber: 2, sessionId: 's-1' });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(mutationErrorKey(result.current.error)).toBe('errors.hasLoggedTraining');
    expect(delLog.delete).not.toHaveBeenCalled();
    expect(supabase.from).toHaveBeenCalledTimes(2);
  });

  it('renumbers logs above the removed one and prunes record_video_set_numbers', async () => {
    // 1: fetch slot
    const slotFetch = slotRead({ sets: 4, record_video_set_numbers: [1, 3, 4] });
    // 2: every row of the slot — the logged check AND the list to renumber.
    // Set 1 is done: removing the pending set 2 beside it is still allowed.
    const allLogs = logsRead([
      pending('l-1', 1, { done: true }),
      pending('l-2', 2),
      pending('l-3', 3),
      pending('l-4', 4),
    ]);
    // 3: delete log set_number=2
    const delLog = {
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn(function (col) {
        // Only the second .eq() resolves the chain.
        if (col === 'set_number') {
          return Promise.resolve({ error: null });
        }
        return this;
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
    // 6: final exercise_slots update
    const finalUpdate = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: null }),
    };

    let call = 0;
    supabase.from.mockImplementation(() => {
      const idx = call++;
      if (idx === 0) return slotFetch;
      if (idx === 1) return allLogs;
      if (idx === 2) return delLog;
      // The park and the place each fan out over the 2 logs above (4 chains).
      if (idx >= 3 && idx <= 6) return makeUpdateChain();
      return finalUpdate;
    });

    const qc = makeClient();
    const { result } = renderHook(() => useRemoveSet(), { wrapper: withClient(qc) });
    result.current.mutate({ slotId: 'sl-1', setNumber: 2, sessionId: 's-1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(delLog.eq).toHaveBeenCalledWith('exercise_slot_id', 'sl-1');
    expect(delLog.eq).toHaveBeenCalledWith('set_number', 2);
    // 2 park + 2 place, one .eq() each — and only for the rows ABOVE set 2.
    expect(parkUpdates.length).toBe(4);
    expect(parkUpdates.map((u) => u.where.id).sort()).toEqual(['l-3', 'l-3', 'l-4', 'l-4']);
    // Pass 1 parks at set_number + 100000…
    const pass1 = parkUpdates.slice(0, 2).map((c) => c.payload.set_number);
    expect(pass1).toContain(100003);
    expect(pass1).toContain(100004);
    // …pass 2 places each one position down, from the ORIGINAL numbers.
    const pass2 = parkUpdates.slice(2).map((c) => c.payload.set_number);
    expect(pass2.sort()).toEqual([2, 3]);
    // Final exercise_slots update: sets decremented and video numbers pruned.
    const finalPayload = finalUpdate.update.mock.calls[0][0];
    expect(finalPayload.sets).toBe(3);
    expect(finalPayload.record_video_set_numbers).toEqual([1, 2, 3]);
  });
});

describe('useResetSlotToUniform', () => {
  it('copies log-1 targets to every other PENDING log AND mirrors to the slot', async () => {
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
    const updateLogs = pendingUpdateChain();
    const updateSlot = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: null }),
    };
    sequence(fetchLogs, updateLogs, updateSlot);

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
    expect(updateLogs.eq).toHaveBeenCalledWith('exercise_slot_id', 'sl-1');
    expect(updateLogs.eq).toHaveBeenCalledWith('is_student_added', false);
    // "Uniform" is about the sets still to do; one already trained keeps the
    // targets it was trained against.
    expectPendingOnly(updateLogs);
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
    sequence(logsRead([pending('l-1', 1), pending('l-2', 2)]), chain);

    const qc = makeClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useDeleteSlot(), { wrapper: withClient(qc) });
    result.current.mutate({ id: 'sl-1', sessionId: 's-1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(chain.eq).toHaveBeenCalledWith('id', 'sl-1');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['session', 's-1'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['week'] });
  });

  // The delete cascades to set_logs, and through them to the athlete's video
  // rows, comments and deviations. One logged set is enough to refuse.
  it.each([
    ['a done set', { done: true }],
    ['a skipped set', { skipped: true }],
    ['a filmed set', { set_log_videos: { id: 'v-1' } }],
    ['a logged extra set', { is_student_added: true, done: true }],
  ])('refuses to remove an exercise that has %s, and deletes nothing', async (_label, patch) => {
    const chain = {
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: null }),
    };
    const read = logsRead([pending('l-1', 1), pending('l-2', 2, patch)]);
    sequence(read, chain);

    const qc = makeClient();
    const { result } = renderHook(() => useDeleteSlot(), { wrapper: withClient(qc) });
    result.current.mutate({ id: 'sl-1', sessionId: 's-1' });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(mutationErrorKey(result.current.error)).toBe('errors.hasLoggedTraining');
    expect(read.eq).toHaveBeenCalledWith('exercise_slot_id', 'sl-1');
    expect(chain.delete).not.toHaveBeenCalled();
  });
});

describe('useMarkSessionReviewed', () => {
  it('UPDATEs sessions WHERE reviewed_at IS NULL and invalidates session + feed caches', async () => {
    const chain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { id: 's-1', reviewed_at: '2026-05-01T10:00:00Z' },
        error: null,
      }),
    };
    supabase.from.mockReturnValue(chain);

    const qc = makeClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useMarkSessionReviewed(), { wrapper: withClient(qc) });
    result.current.mutate({ sessionId: 's-1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(supabase.from).toHaveBeenCalledWith('sessions');
    expect(chain.update).toHaveBeenCalledWith(
      expect.objectContaining({ reviewed_at: expect.any(String) }),
    );
    expect(chain.eq).toHaveBeenCalledWith('id', 's-1');
    // Idempotency guard — the UPDATE is scoped to rows that aren't already
    // reviewed, so re-firing the mutation can't rewind the timestamp.
    expect(chain.is).toHaveBeenCalledWith('reviewed_at', null);

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['session', 's-1'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['all-confirmations'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['week'] });
  });
});
