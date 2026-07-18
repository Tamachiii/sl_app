import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, onlineManager } from '@tanstack/react-query';

vi.mock('./supabase', () => ({ supabase: { from: vi.fn() } }));
vi.mock('./toast', () => ({ pushToast: vi.fn() }));

import { supabase } from './supabase';
import {
  MUTATION_KEYS,
  patchForDone,
  patchForFailed,
  patchForSkipped,
  registerOfflineMutationDefaults,
  hasUnsyncedDraftSave,
} from './offlineMutations';

const fakeQc = (mutations) => ({ getMutationCache: () => ({ getAll: () => mutations }) });
const draftSave = (state) => ({ options: { mutationKey: ['draft-tree', 'save'] }, state });

const onlineDescriptor = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(navigator),
  'onLine'
);

function setOnline(value) {
  Object.defineProperty(navigator, 'onLine', {
    configurable: true,
    get: () => value,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  setOnline(true);
  onlineManager.setOnline(true);
});

afterEach(() => {
  if (onlineDescriptor) {
    Object.defineProperty(Object.getPrototypeOf(navigator), 'onLine', onlineDescriptor);
  }
  onlineManager.setOnline(true);
});

describe('patch helpers', () => {
  it('patchForDone(true) clears any prior failed flag and stamps logged_at', () => {
    const p = patchForDone(true);
    expect(p.done).toBe(true);
    expect(p.failed).toBe(false);
    expect(p.failed_at).toBeNull();
    expect(typeof p.logged_at).toBe('string');
  });

  it('patchForFailed(true) clears done + nulls rpe so the DB CHECKs hold', () => {
    const p = patchForFailed(true);
    expect(p.failed).toBe(true);
    expect(p.done).toBe(false);
    expect(p.logged_at).toBeNull();
    expect(p.rpe).toBeNull();
  });

  it('patchForSkipped(true) clears done/failed/rpe/actuals so skipped is a clean state', () => {
    const p = patchForSkipped(true);
    expect(p.skipped).toBe(true);
    expect(p.done).toBe(false);
    expect(p.failed).toBe(false);
    expect(p.rpe).toBeNull();
    expect(p.actual_reps).toBeNull();
    expect(p.actual_weight_kg).toBeNull();
  });

  it('patchForSkipped(false) only drops the flag', () => {
    const p = patchForSkipped(false);
    expect(p.skipped).toBe(false);
    expect('done' in p).toBe(false);
  });
});

describe('registerOfflineMutationDefaults', () => {
  it('wires every persisted-mutation key to a default mutationFn', () => {
    const qc = new QueryClient();
    registerOfflineMutationDefaults(qc);
    for (const key of Object.values(MUTATION_KEYS)) {
      const defaults = qc.getMutationDefaults(key);
      expect(defaults).toBeDefined();
      expect(typeof defaults.mutationFn).toBe('function');
      expect(defaults.networkMode).toBe('online');
    }
  });

  it('replays a queued toggle-done mutation against supabase once online', async () => {
    // React Query's onlineManager is the authoritative gate for networkMode;
    // navigator.onLine alone won't trigger the pause behavior in jsdom.
    onlineManager.setOnline(false);
    setOnline(false);
    const updateChain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { id: 'l-1', done: true }, error: null }),
    };
    supabase.from.mockReturnValue(updateChain);

    const qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity },
        mutations: { retry: false, networkMode: 'online' },
      },
    });
    registerOfflineMutationDefaults(qc);

    // Fire the mutation while offline — it should pause without ever calling
    // supabase.from.
    qc.getMutationCache()
      .build(qc, {
        mutationKey: MUTATION_KEYS.toggleDone,
        ...qc.getMutationDefaults(MUTATION_KEYS.toggleDone),
      })
      .execute({ logId: 'l-1', done: true });

    await new Promise((r) => setTimeout(r, 0));
    expect(supabase.from).not.toHaveBeenCalled();
    const paused = qc.getMutationCache().getAll().filter((m) => m.state.isPaused);
    expect(paused).toHaveLength(1);

    // Come back online and resume — the queued mutation now hits supabase.
    setOnline(true);
    onlineManager.setOnline(true);
    await qc.resumePausedMutations();
    expect(supabase.from).toHaveBeenCalledWith('set_logs');
    const payload = updateChain.update.mock.calls[0][0];
    expect(payload.done).toBe(true);
    expect(payload.failed).toBe(false);
  });

  it('registers a FIFO scope on every default — authoring gets its own lane', () => {
    const qc = new QueryClient();
    registerOfflineMutationDefaults(qc);
    for (const [name, key] of Object.entries(MUTATION_KEYS)) {
      const expected = name === 'saveDraftTree' || name === 'discardDraft' ? 'draft-tree' : 'offline-writes';
      expect(qc.getMutationDefaults(key).scope).toEqual({ id: expected });
    }
  });

  it('the draft-save default carries onError/onSuccess/skipErrorToast (so a hydrated resume is not silent)', () => {
    const qc = new QueryClient();
    registerOfflineMutationDefaults(qc);
    const d = qc.getMutationDefaults(MUTATION_KEYS.saveDraftTree);
    expect(typeof d.onError).toBe('function');
    expect(typeof d.onSuccess).toBe('function');
    expect(d.meta).toEqual({ skipErrorToast: true });
  });

  describe('hasUnsyncedDraftSave (guards the resume-time reconcile)', () => {
    it('is false with no draft saves', () => {
      expect(hasUnsyncedDraftSave(fakeQc([]))).toBe(false);
      expect(hasUnsyncedDraftSave(fakeQc([
        { options: { mutationKey: ['set-log', 'toggle-done'] }, state: { status: 'error', isPaused: false } },
      ]))).toBe(false);
    });
    it('is true while a draft save is errored, pending, or paused', () => {
      expect(hasUnsyncedDraftSave(fakeQc([draftSave({ status: 'error', isPaused: false })]))).toBe(true);
      expect(hasUnsyncedDraftSave(fakeQc([draftSave({ status: 'pending', isPaused: false })]))).toBe(true);
      expect(hasUnsyncedDraftSave(fakeQc([draftSave({ status: 'idle', isPaused: true })]))).toBe(true);
    });
    it('is false once every draft save succeeded (safe to reconcile)', () => {
      expect(hasUnsyncedDraftSave(fakeQc([draftSave({ status: 'success', isPaused: false })]))).toBe(false);
    });
  });

  it('replays queued writes serially in FIFO order (shared scope)', async () => {
    // Two OPPOSITE writes to the same row queued offline: done → un-done.
    // Without the shared scope, resumePausedMutations() is Promise.all and
    // the slower first request can land last, flipping the final state back
    // to done. The scope must force strict FIFO: the second write may only
    // start after the first has finished.
    onlineManager.setOnline(false);
    setOnline(false);

    const finished = [];
    let call = 0;
    const chain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockImplementation(() => {
        const n = ++call;
        // The FIRST replay resolves much slower than the second — parallel
        // replay would finish [2, 1]; serial replay must finish [1, 2].
        const delay = n === 1 ? 30 : 0;
        return new Promise((resolve) =>
          setTimeout(() => {
            finished.push(n);
            resolve({ data: { id: 'l-1' }, error: null });
          }, delay)
        );
      }),
    };
    supabase.from.mockReturnValue(chain);

    const qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity },
        mutations: { retry: false, networkMode: 'online' },
      },
    });
    registerOfflineMutationDefaults(qc);
    const defaults = qc.getMutationDefaults(MUTATION_KEYS.toggleDone);

    qc.getMutationCache()
      .build(qc, { mutationKey: MUTATION_KEYS.toggleDone, ...defaults })
      .execute({ logId: 'l-1', done: true });
    qc.getMutationCache()
      .build(qc, { mutationKey: MUTATION_KEYS.toggleDone, ...defaults })
      .execute({ logId: 'l-1', done: false });

    await new Promise((r) => setTimeout(r, 0));
    expect(supabase.from).not.toHaveBeenCalled();

    setOnline(true);
    onlineManager.setOnline(true);
    await qc.resumePausedMutations();

    expect(finished).toEqual([1, 2]);
    // Last-writer-wins now matches user intent: the un-done write landed last.
    expect(chain.update.mock.calls[0][0].done).toBe(true);
    expect(chain.update.mock.calls[1][0].done).toBe(false);
  });
});
