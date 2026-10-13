import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../lib/supabase', () => ({
  supabase: {
    rpc: vi.fn(() => Promise.resolve({ data: {}, error: null })),
    from: vi.fn(),
    // Read by the queue of lib/offlineMutations.js before it sends a write.
    auth: { getSession: vi.fn(() => Promise.resolve({ data: { session: { user: { id: 'u-1' } } }, error: null })) },
  },
}));
vi.mock('../lib/toast', () => ({ pushToast: vi.fn() }));
vi.mock('./useAuth', () => ({ useAuth: () => ({ user: { id: 'u-1' } }) }));

import { buildSnapshot, useCreateDraft, useDraftActions, useDraftTree, useMyDraft } from './useAuthoring';
import { supabase } from '../lib/supabase';
import { pushToast } from '../lib/toast';
import { MUTATION_KEYS, registerOfflineMutationDefaults } from '../lib/offlineMutations';
import { isUnsyncedDraft, markUnsynced, unsyncedRev } from '../lib/draftTree';

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}
// The app's client as far as a draft goes: what settles a save — the marker of
// the tree, the toast, the reconcile — is in the defaults of its key.
function makeAppClient() {
  const qc = makeClient();
  registerOfflineMutationDefaults(qc);
  return qc;
}
function withClient(qc) {
  return ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

// What the server answers to a read of `programs` (the pointer, or the tree).
function serverAnswers(row) {
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    is: vi.fn(() => chain),
    maybeSingle: vi.fn(() => Promise.resolve(typeof row === 'function' ? row() : { data: row, error: null })),
  };
  supabase.from.mockReturnValue(chain);
  return chain;
}

function deferred() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const draftSaves = (qc) => qc.getMutationCache().findAll({ mutationKey: MUTATION_KEYS.saveDraftTree });

beforeEach(() => {
  vi.clearAllMocks();
  supabase.rpc.mockReset();
  supabase.from.mockReset();
});

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

// P54. The cache is the only copy of an edit until the database has accepted
// it. The tree says so with a marker, and nothing that reads the server may
// replace a marked tree.
describe('an edit marks the tree as ahead of the server', () => {
  const KEY = ['draft-tree', 'p-1'];
  const seed = (qc) => qc.setQueryData(KEY, { id: 'p-1', name: 'A', submitted_at: null, weeks: [] });

  it('a new draft is marked from its first moment, and its save carries the rev of that marker', async () => {
    const qc = makeClient();
    const { result } = renderHook(() => useCreateDraft(), { wrapper: withClient(qc) });
    let id;
    act(() => { id = result.current.mutate({ name: 'Block' }); });

    const tree = qc.getQueryData(['draft-tree', id]);
    expect(isUnsyncedDraft(tree)).toBe(true);
    expect(draftSaves(qc)[0].state.variables.rev).toBe(unsyncedRev(tree));

    // The marker is the cache's own business: the database is not sent it.
    await waitFor(() => expect(supabase.rpc).toHaveBeenCalled());
    expect(JSON.stringify(supabase.rpc.mock.calls[0][1])).not.toContain('unsynced');
  });

  it('every edit gives the tree a new rev, and the save of that edit carries it', () => {
    const qc = makeClient();
    seed(qc);
    const { result } = renderHook(() => useDraftActions('p-1'), { wrapper: withClient(qc) });

    act(() => result.current.addWeek());
    const first = unsyncedRev(qc.getQueryData(KEY));
    act(() => result.current.addWeek());
    const second = unsyncedRev(qc.getQueryData(KEY));

    expect(first).not.toBeNull();
    expect(second).toBeGreaterThan(first);
    expect(draftSaves(qc).map((save) => save.state.variables.rev)).toContain(second);
    expect(qc.getQueryData(KEY).weeks).toHaveLength(2);
  });

  it('submitting marks it too: a submission is an edit the server does not have yet', () => {
    const qc = makeClient();
    qc.setQueryData(['my-draft', 'u-1'], { id: 'p-1', name: 'A', status: 'draft', submitted_at: null });
    seed(qc);
    const { result } = renderHook(() => useDraftActions('p-1'), { wrapper: withClient(qc) });

    act(() => result.current.submit());

    expect(isUnsyncedDraft(qc.getQueryData(KEY))).toBe(true);
  });

  it('the marker goes when the database has accepted that tree', async () => {
    const qc = makeAppClient();
    seed(qc);
    const { result } = renderHook(() => useDraftActions('p-1'), { wrapper: withClient(qc) });

    act(() => result.current.addWeek());
    expect(isUnsyncedDraft(qc.getQueryData(KEY))).toBe(true);

    await waitFor(() => expect(isUnsyncedDraft(qc.getQueryData(KEY))).toBe(false));
    expect(qc.getQueryData(KEY).weeks).toHaveLength(1);
    expect(supabase.rpc.mock.calls[0][1].p_tree.weeks).toHaveLength(1);
  });

  it('and stays when the database turned that tree down', async () => {
    supabase.rpc.mockResolvedValue({
      data: null,
      error: { code: 'P0001', details: 'e-9', hint: null, message: 'exercise_unavailable' },
    });
    const qc = makeAppClient();
    seed(qc);
    const { result } = renderHook(() => useDraftActions('p-1'), { wrapper: withClient(qc) });

    act(() => result.current.addWeek());

    await waitFor(() => expect(pushToast).toHaveBeenCalledTimes(1));
    expect(isUnsyncedDraft(qc.getQueryData(KEY))).toBe(true);
    expect(qc.getQueryData(KEY).weeks).toHaveLength(1);
  });
});

describe('useDraftTree: a read of the server never replaces a tree that is ahead of it', () => {
  const KEY = ['draft-tree', 'p-1'];
  const onTheServer = () => ({ id: 'p-1', name: 'As saved last week', status: 'draft', submitted_at: null, weeks: [] });
  const onThisDevice = () =>
    markUnsynced(
      {
        id: 'p-1',
        name: 'Rewritten in the basement',
        status: 'draft',
        submitted_at: null,
        weeks: [{ id: 'w-1', week_number: 1, label: null, sessions: [] }],
      },
      7,
    );

  it('a marked tree is its own answer: no request, whatever asks for a refetch', async () => {
    serverAnswers(onTheServer());
    const qc = makeClient();
    qc.setQueryData(KEY, onThisDevice());

    // Mounting the builder on a stale cache is the first refetch.
    const { result } = renderHook(() => useDraftTree('p-1'), { wrapper: withClient(qc) });
    await waitFor(() => expect(result.current.isFetching).toBe(false));
    // An invalidation and an explicit refetch are two more.
    await act(async () => { await qc.invalidateQueries({ queryKey: ['draft-tree'] }); });
    await act(async () => { await result.current.refetch(); });

    expect(supabase.from).not.toHaveBeenCalled();
    expect(result.current.data).toEqual(onThisDevice());
  });

  it('a tree in sync is read again, and the server\'s answer is what the builder shows', async () => {
    const sentBack = { ...onTheServer(), name: 'Sent back by the coach' };
    serverAnswers(sentBack);
    const qc = makeClient();
    qc.setQueryData(KEY, { ...onTheServer(), submitted_at: '2026-10-12T08:00:00.000Z' });

    const { result } = renderHook(() => useDraftTree('p-1'), { wrapper: withClient(qc) });

    await waitFor(() => expect(result.current.data.name).toBe('Sent back by the coach'));
    expect(result.current.data.submitted_at).toBeNull();
    expect(supabase.from).toHaveBeenCalledWith('programs');
  });

  it('an edit made while a read is out wins over the answer to that read', async () => {
    const out = deferred();
    serverAnswers(() => out.promise);
    const qc = makeClient();
    qc.setQueryData(KEY, onTheServer());
    const { result } = renderHook(() => useDraftTree('p-1'), { wrapper: withClient(qc) });
    await waitFor(() => expect(supabase.from).toHaveBeenCalledTimes(1));

    // Written straight into the cache, so that nothing cancels the read: the
    // answer itself has to lose.
    act(() => { qc.setQueryData(KEY, onThisDevice()); });
    await act(async () => { out.release({ data: onTheServer(), error: null }); });
    await waitFor(() => expect(result.current.isFetching).toBe(false));

    expect(result.current.data).toEqual(onThisDevice());
  });

  it('an edit made through the builder while a read is out wins too', async () => {
    const out = deferred();
    serverAnswers(() => out.promise);
    const qc = makeClient();
    qc.setQueryData(KEY, onTheServer());
    const { result } = renderHook(
      () => ({ tree: useDraftTree('p-1'), actions: useDraftActions('p-1') }),
      { wrapper: withClient(qc) },
    );
    await waitFor(() => expect(supabase.from).toHaveBeenCalledTimes(1));

    act(() => result.current.actions.addWeek());
    await act(async () => { out.release({ data: onTheServer(), error: null }); });
    await waitFor(() => expect(result.current.tree.isFetching).toBe(false));

    expect(result.current.tree.data.weeks).toHaveLength(1);
    expect(isUnsyncedDraft(result.current.tree.data)).toBe(true);
  });
});

describe('useMyDraft: the pointer of a draft that is ahead of the server is kept', () => {
  const POINTER = ['my-draft', 'u-1'];
  const mine = { id: 'p-1', name: 'My program', status: 'draft', submitted_at: null };
  const tree = { id: 'p-1', name: 'My program', status: 'draft', submitted_at: null, weeks: [] };

  it('a draft created without a network is not answered "no draft": the server has no row for it yet', async () => {
    serverAnswers(null);
    const qc = makeClient();
    qc.setQueryData(POINTER, mine);
    qc.setQueryData(['draft-tree', 'p-1'], markUnsynced(tree, 7));

    const { result } = renderHook(() => useMyDraft(), { wrapper: withClient(qc) });
    await waitFor(() => expect(result.current.isFetching).toBe(false));
    await act(async () => { await qc.invalidateQueries({ queryKey: ['my-draft'] }); });

    expect(supabase.from).not.toHaveBeenCalled();
    expect(result.current.data).toEqual(mine);
  });

  it('with the tree in sync the server is asked, and its answer stands: approved, the draft is gone', async () => {
    serverAnswers(null);
    const qc = makeClient();
    qc.setQueryData(POINTER, mine);
    qc.setQueryData(['draft-tree', 'p-1'], tree);

    const { result } = renderHook(() => useMyDraft(), { wrapper: withClient(qc) });

    await waitFor(() => expect(result.current.data).toBeNull());
    expect(supabase.from).toHaveBeenCalledWith('programs');
  });

  it('a draft created while the read was out is not taken off the screen by its answer', async () => {
    const out = deferred();
    serverAnswers(() => out.promise);
    const qc = makeClient();
    const { result } = renderHook(
      () => ({ draft: useMyDraft(), create: useCreateDraft() }),
      { wrapper: withClient(qc) },
    );
    await waitFor(() => expect(supabase.from).toHaveBeenCalledTimes(1));

    let id;
    act(() => { id = result.current.create.mutate({ name: 'Block' }); });
    await act(async () => { out.release({ data: null, error: null }); });
    await waitFor(() => expect(result.current.draft.isFetching).toBe(false));

    expect(result.current.draft.data).toMatchObject({ id, name: 'Block' });
  });
});
