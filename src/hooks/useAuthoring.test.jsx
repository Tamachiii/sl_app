import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../lib/supabase', () => ({
  supabase: { rpc: vi.fn(() => Promise.resolve({ data: {}, error: null })), from: vi.fn() },
}));
vi.mock('./useAuth', () => ({ useAuth: () => ({ user: { id: 'u-1' } }) }));

import { buildSnapshot, useCreateDraft, useDraftActions } from './useAuthoring';
import { supabase } from '../lib/supabase';

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}
function withClient(qc) {
  return ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => vi.clearAllMocks());

describe('buildSnapshot', () => {
  it('flattens the nested tree into program/weeks/sessions/slots', () => {
    const tree = {
      id: 'p-1', name: 'A', submitted_at: null,
      weeks: [{ id: 'w-1', week_number: 1, label: null, sessions: [
        { id: 's-1', title: 'D1', day_number: 1, sort_order: 0, exercise_slots: [
          { id: 'sl-1', exercise_id: 'e-1', sets: 3, reps: 5, weight_kg: 20, duration_seconds: null, rest_seconds: null, sort_order: 0 },
        ] },
      ] }],
    };
    const snap = buildSnapshot(tree);
    expect(snap.program).toEqual({ id: 'p-1', name: 'A', submitted_at: null });
    expect(snap.weeks).toEqual([{ id: 'w-1', program_id: 'p-1', week_number: 1, label: null }]);
    expect(snap.sessions).toEqual([{ id: 's-1', week_id: 'w-1', title: 'D1', day_number: 1, sort_order: 0 }]);
    expect(snap.slots[0]).toMatchObject({ id: 'sl-1', session_id: 's-1', exercise_id: 'e-1', sets: 3, reps: 5, weight_kg: 20 });
  });

  it('XOR guard: a reps-null slot with no duration syncs reps=1 (never both-null)', () => {
    const tree = {
      id: 'p-1', name: 'A', submitted_at: null,
      weeks: [{ id: 'w-1', week_number: 1, sessions: [
        { id: 's-1', title: 'D1', day_number: 1, sort_order: 0, exercise_slots: [
          { id: 'sl-1', exercise_id: 'e-1', sets: 3, reps: null, weight_kg: null, duration_seconds: null, sort_order: 0 },
        ] },
      ] }],
    };
    const snap = buildSnapshot(tree);
    expect(snap.slots[0].reps).toBe(1);
    expect(snap.slots[0].duration_seconds).toBeNull();
  });
});

describe('useCreateDraft (offline)', () => {
  it('mints a program, seeds both caches, and enqueues a save snapshot', async () => {
    const qc = makeClient();
    const { result } = renderHook(() => useCreateDraft(), { wrapper: withClient(qc) });
    let id;
    act(() => { id = result.current.mutate({ name: 'Block' }); });

    const draft = qc.getQueryData(['my-draft', 'u-1']);
    expect(draft).toMatchObject({ id, name: 'Block', status: 'draft', submitted_at: null });
    const tree = qc.getQueryData(['draft-tree', id]);
    expect(tree).toMatchObject({ id, name: 'Block', weeks: [] });

    await waitFor(() => expect(supabase.rpc).toHaveBeenCalledWith('save_draft_tree', expect.anything()));
    expect(supabase.rpc.mock.calls[0][1].p_tree.program.id).toBe(id);
  });
});

describe('useDraftActions (offline optimistic edits)', () => {
  it('addWeek appends a week to the cache and dispatches a snapshot containing it', async () => {
    const qc = makeClient();
    qc.setQueryData(['draft-tree', 'p-1'], { id: 'p-1', name: 'A', submitted_at: null, weeks: [] });
    const { result } = renderHook(() => useDraftActions('p-1'), { wrapper: withClient(qc) });

    act(() => result.current.addWeek());
    const tree = qc.getQueryData(['draft-tree', 'p-1']);
    expect(tree.weeks).toHaveLength(1);
    expect(tree.weeks[0].week_number).toBe(1);

    await waitFor(() => expect(supabase.rpc).toHaveBeenCalled());
    const snap = supabase.rpc.mock.calls.at(-1)[1].p_tree;
    expect(snap.weeks).toHaveLength(1);
    expect(snap.weeks[0].program_id).toBe('p-1');
  });

  it('addSlot embeds the picked exercise meta so its name renders offline', () => {
    const qc = makeClient();
    qc.setQueryData(['draft-tree', 'p-1'], {
      id: 'p-1', name: 'A', submitted_at: null,
      weeks: [{ id: 'w-1', week_number: 1, sessions: [{ id: 's-1', title: 'D1', day_number: 1, sort_order: 0, exercise_slots: [] }] }],
    });
    const { result } = renderHook(() => useDraftActions('p-1'), { wrapper: withClient(qc) });
    act(() => result.current.addSlot('s-1', { id: 'e-9', name: 'Muscle-up', type: 'pull' }));
    const slot = qc.getQueryData(['draft-tree', 'p-1']).weeks[0].sessions[0].exercise_slots[0];
    expect(slot.exercise_id).toBe('e-9');
    expect(slot.exercise).toEqual({ id: 'e-9', name: 'Muscle-up', type: 'pull' });
  });

  it('submit stamps submitted_at on both caches', async () => {
    const qc = makeClient();
    qc.setQueryData(['my-draft', 'u-1'], { id: 'p-1', name: 'A', status: 'draft', submitted_at: null });
    qc.setQueryData(['draft-tree', 'p-1'], { id: 'p-1', name: 'A', submitted_at: null, weeks: [] });
    const { result } = renderHook(() => useDraftActions('p-1'), { wrapper: withClient(qc) });
    act(() => result.current.submit());
    expect(qc.getQueryData(['my-draft', 'u-1']).submitted_at).toBeTruthy();
    expect(qc.getQueryData(['draft-tree', 'p-1']).submitted_at).toBeTruthy();
    await waitFor(() => expect(supabase.rpc).toHaveBeenCalled());
    expect(supabase.rpc.mock.calls.at(-1)[1].p_tree.program.submitted_at).toBeTruthy();
  });
});
