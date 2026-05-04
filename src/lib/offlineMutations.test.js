import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, onlineManager } from '@tanstack/react-query';

vi.mock('./supabase', () => ({ supabase: { from: vi.fn() } }));

import { supabase } from './supabase';
import {
  MUTATION_KEYS,
  patchForDone,
  patchForFailed,
  registerOfflineMutationDefaults,
} from './offlineMutations';

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
});
