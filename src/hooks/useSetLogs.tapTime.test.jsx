// P23 — a set is dated at the tap. `logged_at` and `failed_at` used to be read
// from the clock when the request was built, which for a set ticked without
// signal is the moment the phone finds a network again: the evening, or two
// days later. The training day, "N days ago", the recent records and the
// bodyweight a ×BW ratio is read against all followed that timestamp.
//
// This file holds the hooks' half of the contract with lib/offlineMutations.js:
// the moment of the gesture is in the variables of the write (`at`), where the
// persister stores it and the mutation function reads it, and the optimistic
// patch is built from the same value.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider, dehydrate, onlineManager } from '@tanstack/react-query';

vi.mock('../lib/supabase', () => ({ supabase: { from: vi.fn() } }));

// The real module; the two helpers that date a set are watched, so the tests
// can say what the hooks hand them.
vi.mock('../lib/offlineMutations', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    patchForDone: vi.fn(actual.patchForDone),
    patchForFailed: vi.fn(actual.patchForFailed),
  };
});

import {
  useToggleSetDone,
  useSetFailed,
  useSetRpe,
  useLogActual,
  useSetSkipped,
} from './useSetLogs';
import { supabase } from '../lib/supabase';
import { patchForDone, patchForFailed } from '../lib/offlineMutations';

const TAP = '2026-10-09T18:02:11.000Z';
const TWO_DAYS = 2 * 24 * 60 * 60 * 1000;
const KEY = ['set-logs', 'sess-1', ['slot-1']];

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
}

function withClient(qc) {
  return ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

// An update of set_logs that answers with the row it was asked to write.
function answerUpdates() {
  const sent = [];
  supabase.from.mockImplementation(() => {
    const request = {};
    const chain = {
      update: (patch) => {
        request.patch = patch;
        return chain;
      },
      eq: (_column, id) => {
        request.logId = id;
        return chain;
      },
      select: () => chain,
      single: async () => {
        sent.push(request);
        return { data: { id: request.logId, ...request.patch }, error: null };
      },
    };
    return chain;
  });
  return sent;
}

function seed(qc) {
  qc.setQueryData(KEY, [
    { id: 'l-1', done: false, failed: false, logged_at: null, failed_at: null, rpe: null },
  ]);
}

const theWrite = (qc) => qc.getMutationCache().getAll().at(-1);
const row = (qc) => qc.getQueryData(KEY).find((l) => l.id === 'l-1');

beforeEach(() => {
  vi.clearAllMocks();
  // Only the clock: `waitFor` and React Query keep their real timers.
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(TAP) });
});

afterEach(() => {
  vi.useRealTimers();
  onlineManager.setOnline(true);
});

describe('a set-log write carries the moment of its gesture', () => {
  it.each([
    ['useToggleSetDone', useToggleSetDone, { logId: 'l-1', done: true }],
    ['useSetFailed', useSetFailed, { logId: 'l-1', failed: true }],
    ['useSetRpe', useSetRpe, { logId: 'l-1', rpe: 8 }],
    ['useSetRpe, marking the set done', useSetRpe, { logId: 'l-1', rpe: 8, done: true }],
    ['useLogActual', useLogActual, { logId: 'l-1', actualReps: 6, actualWeightKg: 90 }],
    [
      'useLogActual, marking the set done',
      useLogActual,
      { logId: 'l-1', actualReps: 6, actualWeightKg: 90, done: true },
    ],
    ['useSetSkipped', useSetSkipped, { logId: 'l-1', skipped: true }],
  ])('%s puts `at` into the variables of the mutation', async (_name, useHook, variables) => {
    answerUpdates();
    const qc = makeClient();
    const { result } = renderHook(() => useHook('l-1'), { wrapper: withClient(qc) });

    act(() => result.current.mutate(variables));

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(theWrite(qc).state.variables).toEqual({ ...variables, at: TAP });
    // What the page reads back from the hook is the same object.
    expect(result.current.variables).toEqual({ ...variables, at: TAP });
  });

  it('mutateAsync stamps it as well', async () => {
    answerUpdates();
    const qc = makeClient();
    const { result } = renderHook(() => useToggleSetDone('l-1'), { wrapper: withClient(qc) });

    await act(() => result.current.mutateAsync({ logId: 'l-1', done: true }));

    expect(theWrite(qc).state.variables).toEqual({ logId: 'l-1', done: true, at: TAP });
  });

  it('a caller that names the moment itself is believed', async () => {
    answerUpdates();
    const qc = makeClient();
    const { result } = renderHook(() => useToggleSetDone('l-1'), { wrapper: withClient(qc) });
    const earlier = '2026-10-09T17:40:00.000Z';

    act(() => result.current.mutate({ logId: 'l-1', done: true, at: earlier }));

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(theWrite(qc).state.variables.at).toBe(earlier);
    expect(patchForDone).toHaveBeenCalledWith(true, earlier);
  });

  it('the object the caller passed is left as it was', async () => {
    answerUpdates();
    const qc = makeClient();
    const { result } = renderHook(() => useToggleSetDone('l-1'), { wrapper: withClient(qc) });
    const variables = Object.freeze({ logId: 'l-1', done: true });

    act(() => result.current.mutate(variables));

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(variables).toEqual({ logId: 'l-1', done: true });
  });

  it('two gestures, two moments', async () => {
    answerUpdates();
    const qc = makeClient();
    const { result } = renderHook(
      () => ({ tick: useToggleSetDone('l-1'), fail: useSetFailed('l-1') }),
      { wrapper: withClient(qc) },
    );

    act(() => result.current.tick.mutate({ logId: 'l-1', done: true }));
    await waitFor(() => expect(result.current.tick.isSuccess).toBe(true));
    vi.setSystemTime(new Date('2026-10-09T18:02:40.000Z'));
    act(() => result.current.fail.mutate({ logId: 'l-1', failed: true }));
    await waitFor(() => expect(result.current.fail.isSuccess).toBe(true));

    expect(qc.getMutationCache().getAll().map((m) => m.state.variables.at)).toEqual([
      TAP,
      '2026-10-09T18:02:40.000Z',
    ]);
  });
});

describe('the moment is the tap, not the one at which the request leaves', () => {
  it('a set ticked without a network, sent two days later, still says when it was done', async () => {
    const sent = answerUpdates();
    const qc = makeClient();
    seed(qc);
    onlineManager.setOnline(false);
    const { result } = renderHook(() => useToggleSetDone('l-1'), { wrapper: withClient(qc) });

    act(() => result.current.mutate({ logId: 'l-1', done: true }));
    await waitFor(() => expect(result.current.isPaused).toBe(true));
    expect(sent).toHaveLength(0);

    // The evening, the next day, the day after.
    vi.setSystemTime(new Date(new Date(TAP).getTime() + TWO_DAYS));
    onlineManager.setOnline(true);
    await act(() => qc.resumePausedMutations());

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(sent).toHaveLength(1);
    expect(theWrite(qc).state.variables).toEqual({ logId: 'l-1', done: true, at: TAP });
  });

  it('what the device stores for a queued set holds the moment, so a relaunch keeps it', async () => {
    answerUpdates();
    const qc = makeClient();
    seed(qc);
    onlineManager.setOnline(false);
    const { result } = renderHook(
      () => ({ tick: useToggleSetDone('l-1'), fail: useSetFailed('l-2') }),
      { wrapper: withClient(qc) },
    );

    act(() => result.current.tick.mutate({ logId: 'l-1', done: true }));
    act(() => result.current.fail.mutate({ logId: 'l-2', failed: true }));
    await waitFor(() => expect(result.current.fail.isPaused).toBe(true));
    vi.setSystemTime(new Date(new Date(TAP).getTime() + TWO_DAYS));

    // The queue as the persister writes it: through JSON.
    const stored = JSON.parse(JSON.stringify(dehydrate(qc, { shouldDehydrateMutation: () => true })));

    expect(stored.mutations.map((m) => m.state.variables)).toEqual([
      { logId: 'l-1', done: true, at: TAP },
      { logId: 'l-2', failed: true, at: TAP },
    ]);
  });
});

describe('the row on screen is dated by the same moment', () => {
  it('a tick hands the moment of the gesture to patchForDone, and shows it at once', async () => {
    answerUpdates();
    const qc = makeClient();
    seed(qc);
    onlineManager.setOnline(false);
    const { result } = renderHook(() => useToggleSetDone('l-1'), { wrapper: withClient(qc) });

    act(() => result.current.mutate({ logId: 'l-1', done: true }));

    await waitFor(() => expect(row(qc).done).toBe(true));
    expect(patchForDone).toHaveBeenCalledWith(true, TAP);
    expect(row(qc).logged_at).toBe(TAP);
  });

  it('a failed set hands it to patchForFailed', async () => {
    answerUpdates();
    const qc = makeClient();
    seed(qc);
    onlineManager.setOnline(false);
    const { result } = renderHook(() => useSetFailed('l-1'), { wrapper: withClient(qc) });

    act(() => result.current.mutate({ logId: 'l-1', failed: true }));

    await waitFor(() => expect(row(qc).failed).toBe(true));
    expect(patchForFailed).toHaveBeenCalledWith(true, TAP);
    expect(row(qc).failed_at).toBe(TAP);
  });

  // P27 — an RPE or an Actual given on a pending set marks it done in the same
  // write: dated by the same moment as a tick, on screen and in the request.
  it.each([
    ['an RPE', useSetRpe, { logId: 'l-1', rpe: 8, done: true }, { rpe: 8 }],
    [
      'an Actual',
      useLogActual,
      { logId: 'l-1', actualReps: 6, actualWeightKg: 90, done: true },
      { actual_reps: 6, actual_weight_kg: 90 },
    ],
  ])('%s that marks a pending set done dates it at the tap, at once and two days later', async (_what, useHook, variables, value) => {
    const sent = answerUpdates();
    const qc = makeClient();
    seed(qc);
    onlineManager.setOnline(false);
    const { result } = renderHook(() => useHook('l-1'), { wrapper: withClient(qc) });

    act(() => result.current.mutate(variables));

    await waitFor(() => expect(row(qc).done).toBe(true));
    expect(row(qc)).toMatchObject({ ...value, done: true, failed: false, logged_at: TAP, failed_at: null });

    vi.setSystemTime(new Date(new Date(TAP).getTime() + TWO_DAYS));
    onlineManager.setOnline(true);
    await act(() => qc.resumePausedMutations());

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(sent).toHaveLength(1);
    expect(sent[0].patch).toEqual({ ...value, done: true, failed: false, logged_at: TAP, failed_at: null });
  });

  it('an RPE without the mark dates nothing', async () => {
    const sent = answerUpdates();
    const qc = makeClient();
    seed(qc);
    const { result } = renderHook(() => useSetRpe('l-1'), { wrapper: withClient(qc) });

    act(() => result.current.mutate({ logId: 'l-1', rpe: 8 }));

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(sent[0].patch).toEqual({ rpe: 8 });
    expect(row(qc)).toMatchObject({ done: false, logged_at: null, rpe: 8 });
  });

  it('taking a mark back needs no moment, and still carries the one of its own gesture', async () => {
    answerUpdates();
    const qc = makeClient();
    seed(qc);
    const { result } = renderHook(() => useSetFailed('l-1'), { wrapper: withClient(qc) });

    act(() => result.current.mutate({ logId: 'l-1', failed: false }));

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(patchForFailed).toHaveBeenCalledWith(false, TAP);
    expect(row(qc).failed_at).toBeNull();
  });
});
