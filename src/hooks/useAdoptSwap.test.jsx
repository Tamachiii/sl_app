import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../lib/supabase', () => ({ supabase: { rpc: vi.fn() } }));

import {
  useAdoptSwap,
  useAdoptSwapPreview,
  useAdoptSkip,
  useAdoptSkipPreview,
  useDeclinePromote,
} from './useAdoptSwap';
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
  return ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
  supabase.rpc.mockResolvedValue({ data: { applied: 3 }, error: null });
});

// These two RPCs rewrite and DELETE slots in upcoming sessions. p_dry_run is
// the only thing separating a preview from a write, and nothing else in the
// suite would notice if one were flipped — hence the explicit pinning below.
describe('adopt mutations write for real', () => {
  it('useAdoptSwap calls adopt_swap with p_dry_run false', async () => {
    const { result } = renderHook(() => useAdoptSwap(), { wrapper: withClient(makeClient()) });
    result.current.mutate({ slotId: 'sl-1', substituteId: 'ex-2', sessionId: 's-1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(supabase.rpc).toHaveBeenCalledWith('adopt_swap', {
      p_slot_id: 'sl-1',
      p_substitute_id: 'ex-2',
      p_dry_run: false,
    });
  });

  it('useAdoptSkip calls adopt_skip with p_dry_run false', async () => {
    const { result } = renderHook(() => useAdoptSkip(), { wrapper: withClient(makeClient()) });
    result.current.mutate({ slotId: 'sl-1', sessionId: 's-1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(supabase.rpc).toHaveBeenCalledWith('adopt_skip', {
      p_slot_id: 'sl-1',
      p_dry_run: false,
    });
  });

  it('drops the session, week, program and stats caches the rewrite invalidates', async () => {
    const qc = makeClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useAdoptSwap(), { wrapper: withClient(qc) });
    result.current.mutate({ slotId: 'sl-1', substituteId: 'ex-2', sessionId: 's-1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // The rewritten slots live in OTHER ['session', X] caches, so the whole
    // subtree has to go — not just the reviewed session.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['session'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['slot-deviations', 's-1'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['week'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['program'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['student-program-details'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['student-progress-stats'] });
  });

  it('skips the deviations key when no sessionId was supplied', async () => {
    const qc = makeClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useAdoptSkip(), { wrapper: withClient(qc) });
    result.current.mutate({ slotId: 'sl-1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['slot-deviations', undefined] });
  });

  it('rejects when the RPC returns an error', async () => {
    supabase.rpc.mockResolvedValue({ data: null, error: new Error('not your student') });
    const { result } = renderHook(() => useAdoptSwap(), { wrapper: withClient(makeClient()) });
    result.current.mutate({ slotId: 'sl-1', substituteId: 'ex-2', sessionId: 's-1' });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe('adopt previews never write', () => {
  it('useAdoptSwapPreview asks for a dry run and returns the applied count', async () => {
    const { result } = renderHook(() => useAdoptSwapPreview('sl-1', 'ex-2', true), {
      wrapper: withClient(makeClient()),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(supabase.rpc).toHaveBeenCalledWith('adopt_swap', {
      p_slot_id: 'sl-1',
      p_substitute_id: 'ex-2',
      p_dry_run: true,
    });
    expect(result.current.data).toBe(3);
  });

  it('useAdoptSkipPreview asks for a dry run', async () => {
    const { result } = renderHook(() => useAdoptSkipPreview('sl-1', true), {
      wrapper: withClient(makeClient()),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(supabase.rpc).toHaveBeenCalledWith('adopt_skip', {
      p_slot_id: 'sl-1',
      p_dry_run: true,
    });
  });

  it('stays idle — and calls nothing — while the dialog is closed', async () => {
    const { result } = renderHook(() => useAdoptSwapPreview('sl-1', 'ex-2', false), {
      wrapper: withClient(makeClient()),
    });
    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('stays idle when the substitute has not been picked yet', async () => {
    const { result } = renderHook(() => useAdoptSwapPreview('sl-1', null, true), {
      wrapper: withClient(makeClient()),
    });
    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
});

describe('useDeclinePromote', () => {
  it('clears the request via the coach-only RPC and refreshes only that session', async () => {
    const qc = makeClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useDeclinePromote(), { wrapper: withClient(qc) });
    result.current.mutate({ slotId: 'sl-1', sessionId: 's-1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(supabase.rpc).toHaveBeenCalledWith('decline_promote_request', { p_slot_id: 'sl-1' });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['slot-deviations', 's-1'] });
    // Declining changes no prescription, so the program caches stay put.
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['program'] });
  });
});
